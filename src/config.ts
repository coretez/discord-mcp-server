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

/** stdio: the client spawns us. http: we listen, and many clients connect. */
export type TransportKind = "stdio" | "http";

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
  transport: TransportKind;
  /** Bind address for http. Defaults to loopback: nginx terminates TLS in front. */
  httpHost: string;
  httpPort: number;
  /**
   * Host headers this server will answer to over http. The SDK rejects anything
   * else, which is what stops a browser on someone's machine from driving a
   * loopback-bound server through DNS rebinding.
   */
  allowedHosts: string[];
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

  const rawTransport = (env.DISCORD_TRANSPORT ?? "stdio").toLowerCase();
  if (rawTransport !== "stdio" && rawTransport !== "http") {
    throw new Error(`DISCORD_TRANSPORT must be stdio or http, got "${rawTransport}".`);
  }

  const httpPort = Number.parseInt(env.DISCORD_HTTP_PORT ?? "8500", 10);
  if (!Number.isFinite(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error("DISCORD_HTTP_PORT must be a port number between 1 and 65535.");
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
    transport: rawTransport as TransportKind,
    httpHost: env.DISCORD_HTTP_HOST?.trim() || "127.0.0.1",
    httpPort,
    allowedHosts: list(env.DISCORD_ALLOWED_HOSTS),
  };
}

export function modeSatisfies(current: Mode, required: Mode): boolean {
  return MODE_RANK[current] >= MODE_RANK[required];
}
