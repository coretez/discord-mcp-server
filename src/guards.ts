/**
 * Tool registration with guardrails and a composed description contract.
 *
 * Two jobs live here so they cannot be forgotten per-tool:
 *
 * 1. Guardrails — every tool declares the tier it needs and whether it is
 *    destructive; the checks then live in one place instead of being
 *    re-implemented (and eventually forgotten) in each handler.
 * 2. Description contract — a spec supplies `summary`, `whenToCall` and
 *    `returns` as separate required fields, and this module assembles them into
 *    the routing text an agent reads. Required argument names and cross
 *    references are appended mechanically from the schema, so a new tool cannot
 *    ship with a description that omits them.
 */

import { z } from "zod";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ShapeOutput } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { type Config, type Mode, modeSatisfies } from "./config.js";
import { DiscordClient, DiscordError } from "./discord.js";

export class GuardError extends Error {}

export interface Ctx {
  client: DiscordClient;
  config: Config;
  /** Validate an explicit guild id, or fall back to the configured default. */
  requireGuild(guildId?: string): string;
  /** Validate that a channel belongs to a fenced guild; returns that guild id. */
  requireChannel(channelId: string): Promise<string>;
  /** Validate that a channel is writable under DISCORD_CHANNEL_ALLOWLIST. */
  requireWritableChannel(channelId: string): Promise<string>;
}

export function makeCtx(client: DiscordClient, config: Config): Ctx {
  const ctx: Ctx = {
    client,
    config,

    requireGuild(guildId?: string): string {
      const id = guildId ?? config.defaultGuildId;
      if (!config.guildIds.includes(id)) {
        throw new GuardError(
          `Guild ${id} is outside this server's fence. Permitted: ${config.guildIds.join(", ")}. ` +
            "Add it to DISCORD_GUILD_ID if that is intended.",
        );
      }
      return id;
    },

    async requireChannel(channelId: string): Promise<string> {
      const guildId = await client.guildIdForChannel(channelId);
      if (guildId === null) {
        throw new GuardError(
          `Channel ${channelId} is not in a guild (DM or group DM). This server only operates on guild channels.`,
        );
      }
      return ctx.requireGuild(guildId);
    },

    async requireWritableChannel(channelId: string): Promise<string> {
      // Allowlist first: it is a local string check, so a disallowed channel
      // costs no API round-trip and is refused even if Discord is unreachable.
      if (config.channelAllowlist.length > 0 && !config.channelAllowlist.includes(channelId)) {
        throw new GuardError(
          `Channel ${channelId} is not in DISCORD_CHANNEL_ALLOWLIST, so writes to it are refused. ` +
            `Writable channels: ${config.channelAllowlist.join(", ")}.`,
        );
      }
      return ctx.requireChannel(channelId);
    },
  };
  return ctx;
}

const CONFIRM_SHAPE = {
  confirm: z
    .literal(true)
    .describe(
      "Must be exactly true. Required because this action is destructive and hard to undo. " +
        "Set it only after the human has agreed to this specific action.",
    ),
};

/**
 * Destructive tools that can preview themselves take a looser confirm, enforced
 * at runtime instead of in the schema. A preview must stay reachable while
 * DISCORD_ALLOW_DESTRUCTIVE is off — that is exactly when someone is deciding
 * whether to turn it on — and requiring `confirm: true` to look at something
 * would teach the habit of setting it reflexively.
 */
const DRY_RUN_CONFIRM_SHAPE = {
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "Must be true to actually perform this destructive action. Ignored when dry_run is true. " +
        "Set it only after the human has agreed to this specific action.",
    ),
  dry_run: z
    .boolean()
    .default(false)
    .describe(
      "Report what this would change and make no modification. Allowed even when the server's " +
        "destructive switch is off, so a change can be inspected before it is enabled.",
    ),
};

/** Fields the registrar injects into destructive tools' schemas, not declared per-tool. */
export interface InjectedArgs {
  confirm?: boolean;
  dry_run?: boolean;
}

/** A tool may return plain text, or text plus structured content for its outputSchema. */
export type ToolOutput = string | { text: string; structured: Record<string, unknown> };

export interface ToolSpec<S extends z.ZodRawShape> {
  name: string;
  title: string;
  /** What the tool does. One or two sentences, no "use when" phrasing. */
  summary: string;
  /** Completes the sentence "Use when ...". This is the routing signal. */
  whenToCall: string;
  /** Completes the sentence "Returns ...". Describes the result shape. */
  returns: string;
  /** Lowest DISCORD_MODE that may run this tool. */
  tier: Mode;
  /** Destructive tools also need DISCORD_ALLOW_DESTRUCTIVE and confirm:true. */
  destructive?: boolean;
  /** Offers a dry_run preview. Confirmation moves from the schema to runtime. */
  dryRunnable?: boolean;
  /** Overrides the readOnlyHint annotation, which otherwise follows the tier. */
  readOnly?: boolean;
  /** Sibling tools an agent might confuse this one with. Emitted as "See also". */
  seeAlso?: string[];
  /** MCP Apps UI resource (ui://…) rendering this tool's result. */
  uiResourceUri?: string;
  inputSchema: S;
  outputSchema?: z.ZodRawShape;
  handler: (args: ShapeOutput<S> & InjectedArgs, ctx: Ctx) => Promise<ToolOutput>;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

/**
 * Argument names that will appear in the JSON Schema `required` array.
 *
 * Derived by asking each field whether it accepts `undefined`, which is the
 * same question the schema converter asks — so this list cannot drift from the
 * published schema the way a hand-written one would.
 */
function requiredArgs(shape: z.ZodRawShape): string[] {
  return Object.entries(shape)
    .filter(([, field]) => !(field as z.ZodType).safeParse(undefined).success)
    .map(([key]) => key);
}

function composeDescription<S extends z.ZodRawShape>(
  spec: ToolSpec<S>,
  shape: z.ZodRawShape,
): string {
  const parts = [spec.summary, `Use when ${spec.whenToCall}`, `Returns ${spec.returns}`];

  const required = requiredArgs(shape);
  if (required.length > 0) parts.push(`Requires: ${required.join(", ")}.`);
  if (spec.seeAlso?.length) parts.push(`See also: ${spec.seeAlso.join(", ")}.`);
  if (spec.destructive) {
    parts.push(
      "DESTRUCTIVE: this cannot be undone. Requires confirm:true and the server's " +
        "DISCORD_ALLOW_DESTRUCTIVE switch. Confirm with the human before calling it." +
        (spec.dryRunnable
          ? " Pass dry_run:true first to preview exactly what would be lost; the preview needs " +
            "neither confirmation nor the destructive switch."
          : ""),
    );
  }
  return parts.join("\n\n");
}

export function registerTool<S extends z.ZodRawShape>(
  server: McpServer,
  ctx: Ctx,
  spec: ToolSpec<S>,
): void {
  const { config } = ctx;

  // Tools the current mode can never run are not advertised at all. A client
  // cannot be tempted by a capability that is not on the menu.
  if (!modeSatisfies(config.mode, spec.tier)) return;

  const schema = spec.destructive
    ? ({
        ...spec.inputSchema,
        ...(spec.dryRunnable ? DRY_RUN_CONFIRM_SHAPE : CONFIRM_SHAPE),
      } as S & typeof CONFIRM_SHAPE)
    : spec.inputSchema;

  const callback = async (args: ShapeOutput<S>): Promise<CallToolResult> => {
    try {
      const dryRun = spec.dryRunnable === true && (args as { dry_run?: boolean }).dry_run === true;
      if (spec.destructive && !dryRun) {
        if (!config.allowDestructive) {
          throw new GuardError(
            `${spec.name} is destructive and DISCORD_ALLOW_DESTRUCTIVE is not enabled. ` +
              "Set DISCORD_ALLOW_DESTRUCTIVE=true in the server's env to permit it" +
              (spec.dryRunnable ? ", or pass dry_run:true to preview it without changing anything." : "."),
          );
        }
        // Schema-level for ordinary destructive tools; runtime here for the
        // dry-runnable ones, whose confirm has to stay optional for previews.
        if (spec.dryRunnable && (args as { confirm?: boolean }).confirm !== true) {
          throw new GuardError(
            `${spec.name} is destructive and was called without confirm:true. ` +
              "Pass dry_run:true to see what it would change, or confirm:true once the human " +
              "has agreed to this specific action.",
          );
        }
      }
      const out = await spec.handler(args as ShapeOutput<S> & InjectedArgs, ctx);
      if (typeof out === "string") return textResult(out);
      return { content: [{ type: "text", text: out.text }], structuredContent: out.structured };
    } catch (err) {
      if (err instanceof GuardError) return textResult(`Refused: ${err.message}`, true);
      if (err instanceof DiscordError) {
        return textResult(`Discord rejected this: ${err.message}`, true);
      }
      return textResult(`Failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  };

  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: composeDescription(spec, schema),
      inputSchema: schema,
      ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
      annotations: {
        readOnlyHint: spec.readOnly ?? spec.tier === "read",
        destructiveHint: spec.destructive === true,
      },
      ...(spec.uiResourceUri ? { _meta: { ui: { resourceUri: spec.uiResourceUri } } } : {}),
    },
    // The SDK types the callback argument as a conditional over the schema
    // shape, which TypeScript cannot resolve while S is still generic. The cast
    // is confined to this one registration boundary; `callback` and every
    // handler above it stay fully typed.
    callback as unknown as ToolCallback<typeof schema>,
  );
}
