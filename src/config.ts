/**
 * Configuration and guardrails.
 *
 * This server can delete channels and ban people, so capability is opt-in by
 * tier rather than granted wholesale by possession of a token. A token that can
 * do everything on Discord's side still only does what the mode allows here.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type Mode = "read" | "write" | "admin";

const MODE_RANK: Record<Mode, number> = { read: 0, write: 1, admin: 2 };

export interface Config {
  token: string;
  /** Guilds this server is permitted to touch. Anything else is refused. */
  guildIds: string[];
  /** Default guild used when a tool call omits guild_id. */
  defaultGuildId: string;
  mode: Mode;
  /** Destructive tools (delete, ban, prune, bulk delete) additionally need this. */
  allowDestructive: boolean;
  /** When non-empty, writes are confined to these channel ids. */
  channelAllowlist: string[];
  bulkDeleteMax: number;
  /** Where report_client_issue appends its receipts. */
  issueLogPath: string;
}

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/** Default issue log sits beside the package, not inside dist/. */
function defaultIssueLog(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "issues.jsonl");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.DISCORD_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "DISCORD_BOT_TOKEN is not set. Create a bot at https://discord.com/developers/applications, " +
        "copy its token, and put it in the MCP server's env (never in source or chat).",
    );
  }

  const guildIds = list(env.DISCORD_GUILD_ID);
  if (guildIds.length === 0) {
    throw new Error(
      "DISCORD_GUILD_ID is not set. Set it to the guild id(s) this server may operate on, " +
        "comma-separated. This is the blast-radius fence and has no default.",
    );
  }

  const rawMode = (env.DISCORD_MODE ?? "read").toLowerCase();
  if (!(rawMode in MODE_RANK)) {
    throw new Error(`DISCORD_MODE must be one of read|write|admin, got "${rawMode}".`);
  }

  const bulkDeleteMax = Number.parseInt(env.DISCORD_BULK_DELETE_MAX ?? "50", 10);
  if (!Number.isFinite(bulkDeleteMax) || bulkDeleteMax < 1 || bulkDeleteMax > 100) {
    throw new Error("DISCORD_BULK_DELETE_MAX must be an integer between 1 and 100.");
  }

  return {
    token,
    guildIds,
    defaultGuildId: guildIds[0]!,
    mode: rawMode as Mode,
    allowDestructive: bool(env.DISCORD_ALLOW_DESTRUCTIVE, false),
    channelAllowlist: list(env.DISCORD_CHANNEL_ALLOWLIST),
    bulkDeleteMax,
    issueLogPath: env.DISCORD_ISSUE_LOG?.trim() || defaultIssueLog(),
  };
}

export function modeSatisfies(current: Mode, required: Mode): boolean {
  return MODE_RANK[current] >= MODE_RANK[required];
}
