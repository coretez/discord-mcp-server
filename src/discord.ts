/**
 * Thin wrapper over Discord's REST API.
 *
 * @discordjs/rest is used only for its request pipeline (rate-limit queueing,
 * retries, auth header). No gateway/websocket: MCP tools are pull-based, so a
 * persistent connection would buy nothing and would keep the process hot.
 */

import { REST } from "@discordjs/rest";
import { DiscordAPIError, HTTPError } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import type {
  APIChannel,
  APIGuild,
  APIGuildMember,
  APIMessage,
  APIRole,
  APIGuildPreview,
  APIBan,
  APIThreadList,
} from "discord-api-types/v10";
import type { Config } from "./config.js";

export class DiscordError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "DiscordError";
  }
}

/** Map Discord's terse API errors onto messages that say what to actually do. */
function explain(err: unknown): never {
  if (err instanceof DiscordAPIError) {
    const code = Number(err.code);
    const hints: Record<number, string> = {
      50001: "Missing Access — the bot is not in this guild, or cannot see this channel.",
      50013:
        "Missing Permissions — the bot's role lacks the permission for this action, " +
        "or the target's role is higher than the bot's. Role order matters, not just the permission bits.",
      50035: "Invalid form body — a field failed Discord's validation.",
      10003: "Unknown channel.",
      10004: "Unknown guild.",
      10007: "Unknown member.",
      10008: "Unknown message.",
      10011: "Unknown role.",
      50034: "Bulk delete only works on messages under 14 days old.",
      20028: "Rate limited by a per-channel slowmode or thread limit.",
      160002: "Cannot moderate this member (likely the guild owner or a higher role).",
    };
    const hint = hints[code];
    throw new DiscordError(
      `Discord API ${err.status}/${code}: ${err.message}${hint ? ` — ${hint}` : ""}`,
      err.status,
      code,
    );
  }
  if (err instanceof HTTPError) {
    throw new DiscordError(`Discord HTTP ${err.status}: ${err.message}`, err.status);
  }
  throw err;
}

export class DiscordClient {
  private readonly rest: REST;
  /** channel id -> guild id, so guild fencing does not re-fetch on every call. */
  private readonly channelGuild = new Map<string, string | null>();

  constructor(config: Config) {
    this.rest = new REST({ version: "10" }).setToken(config.token);
  }

  private async get<T>(route: string, query?: URLSearchParams): Promise<T> {
    try {
      return (await this.rest.get(route as `/${string}`, { query })) as T;
    } catch (e) {
      explain(e);
    }
  }

  private async post<T>(route: string, body: unknown, reason?: string): Promise<T> {
    try {
      return (await this.rest.post(route as `/${string}`, { body, reason })) as T;
    } catch (e) {
      explain(e);
    }
  }

  private async patch<T>(route: string, body: unknown, reason?: string): Promise<T> {
    try {
      return (await this.rest.patch(route as `/${string}`, { body, reason })) as T;
    } catch (e) {
      explain(e);
    }
  }

  private async put<T>(route: string, body?: unknown, reason?: string): Promise<T> {
    try {
      return (await this.rest.put(route as `/${string}`, { body, reason })) as T;
    } catch (e) {
      explain(e);
    }
  }

  private async del<T>(route: string, reason?: string): Promise<T> {
    try {
      return (await this.rest.delete(route as `/${string}`, { reason })) as T;
    } catch (e) {
      explain(e);
    }
  }

  // ---- identity -----------------------------------------------------------

  currentUser(): Promise<{ id: string; username: string; bot?: boolean }> {
    return this.get(Routes.user("@me"));
  }

  // ---- guild --------------------------------------------------------------

  guild(guildId: string): Promise<APIGuild> {
    return this.get(Routes.guild(guildId), new URLSearchParams({ with_counts: "true" }));
  }

  guildPreview(guildId: string): Promise<APIGuildPreview> {
    return this.get(Routes.guildPreview(guildId));
  }

  guildChannels(guildId: string): Promise<APIChannel[]> {
    return this.get(Routes.guildChannels(guildId));
  }

  guildRoles(guildId: string): Promise<APIRole[]> {
    return this.get(Routes.guildRoles(guildId));
  }

  activeThreads(guildId: string): Promise<APIThreadList> {
    return this.get(Routes.guildActiveThreads(guildId));
  }

  guildMembers(guildId: string, limit: number, after?: string): Promise<APIGuildMember[]> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (after) q.set("after", after);
    return this.get(Routes.guildMembers(guildId), q);
  }

  searchGuildMembers(guildId: string, query: string, limit: number): Promise<APIGuildMember[]> {
    return this.get(
      Routes.guildMembersSearch(guildId),
      new URLSearchParams({ query, limit: String(limit) }),
    );
  }

  guildMember(guildId: string, userId: string): Promise<APIGuildMember> {
    return this.get(Routes.guildMember(guildId, userId));
  }

  guildBans(guildId: string, limit: number): Promise<APIBan[]> {
    return this.get(Routes.guildBans(guildId), new URLSearchParams({ limit: String(limit) }));
  }

  // ---- channels -----------------------------------------------------------

  channel(channelId: string): Promise<APIChannel> {
    return this.get(Routes.channel(channelId));
  }

  createChannel(guildId: string, body: unknown, reason?: string): Promise<APIChannel> {
    return this.post(Routes.guildChannels(guildId), body, reason);
  }

  editChannel(channelId: string, body: unknown, reason?: string): Promise<APIChannel> {
    return this.patch(Routes.channel(channelId), body, reason);
  }

  deleteChannel(channelId: string, reason?: string): Promise<APIChannel> {
    return this.del(Routes.channel(channelId), reason);
  }

  setChannelOverwrite(
    channelId: string,
    overwriteId: string,
    body: unknown,
    reason?: string,
  ): Promise<void> {
    return this.put(Routes.channelPermission(channelId, overwriteId), body, reason);
  }

  deleteChannelOverwrite(channelId: string, overwriteId: string, reason?: string): Promise<void> {
    return this.del(Routes.channelPermission(channelId, overwriteId), reason);
  }

  // ---- messages -----------------------------------------------------------

  messages(
    channelId: string,
    opts: { limit: number; before?: string; after?: string; around?: string },
  ): Promise<APIMessage[]> {
    const q = new URLSearchParams({ limit: String(opts.limit) });
    if (opts.before) q.set("before", opts.before);
    if (opts.after) q.set("after", opts.after);
    if (opts.around) q.set("around", opts.around);
    return this.get(Routes.channelMessages(channelId), q);
  }

  message(channelId: string, messageId: string): Promise<APIMessage> {
    return this.get(Routes.channelMessage(channelId, messageId));
  }

  createMessage(channelId: string, body: unknown): Promise<APIMessage> {
    return this.post(Routes.channelMessages(channelId), body);
  }

  editMessage(channelId: string, messageId: string, body: unknown): Promise<APIMessage> {
    return this.patch(Routes.channelMessage(channelId, messageId), body);
  }

  deleteMessage(channelId: string, messageId: string, reason?: string): Promise<void> {
    return this.del(Routes.channelMessage(channelId, messageId), reason);
  }

  bulkDelete(channelId: string, ids: string[], reason?: string): Promise<void> {
    return this.post(Routes.channelBulkDelete(channelId), { messages: ids }, reason);
  }

  addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    return this.put(
      Routes.channelMessageOwnReaction(channelId, messageId, encodeURIComponent(emoji)),
    );
  }

  pinMessage(channelId: string, messageId: string, reason?: string): Promise<void> {
    return this.put(Routes.channelPin(channelId, messageId), undefined, reason);
  }

  unpinMessage(channelId: string, messageId: string, reason?: string): Promise<void> {
    return this.del(Routes.channelPin(channelId, messageId), reason);
  }

  createThreadFromMessage(
    channelId: string,
    messageId: string,
    body: unknown,
  ): Promise<APIChannel> {
    return this.post(Routes.threads(channelId, messageId), body);
  }

  createThread(channelId: string, body: unknown): Promise<APIChannel> {
    return this.post(Routes.threads(channelId), body);
  }

  // ---- members / moderation ----------------------------------------------

  editMember(
    guildId: string,
    userId: string,
    body: unknown,
    reason?: string,
  ): Promise<APIGuildMember> {
    return this.patch(Routes.guildMember(guildId, userId), body, reason);
  }

  addMemberRole(guildId: string, userId: string, roleId: string, reason?: string): Promise<void> {
    return this.put(Routes.guildMemberRole(guildId, userId, roleId), undefined, reason);
  }

  removeMemberRole(
    guildId: string,
    userId: string,
    roleId: string,
    reason?: string,
  ): Promise<void> {
    return this.del(Routes.guildMemberRole(guildId, userId, roleId), reason);
  }

  kickMember(guildId: string, userId: string, reason?: string): Promise<void> {
    return this.del(Routes.guildMember(guildId, userId), reason);
  }

  banMember(guildId: string, userId: string, body: unknown, reason?: string): Promise<void> {
    return this.put(Routes.guildBan(guildId, userId), body, reason);
  }

  unbanMember(guildId: string, userId: string, reason?: string): Promise<void> {
    return this.del(Routes.guildBan(guildId, userId), reason);
  }

  createRole(guildId: string, body: unknown, reason?: string): Promise<APIRole> {
    return this.post(Routes.guildRoles(guildId), body, reason);
  }

  editRole(guildId: string, roleId: string, body: unknown, reason?: string): Promise<APIRole> {
    return this.patch(Routes.guildRole(guildId, roleId), body, reason);
  }

  deleteRole(guildId: string, roleId: string, reason?: string): Promise<void> {
    return this.del(Routes.guildRole(guildId, roleId), reason);
  }

  // ---- fencing ------------------------------------------------------------

  /**
   * Resolve the guild a channel lives in, so channel-addressed tools can be
   * fenced the same way guild-addressed ones are. Cached: a channel never
   * moves between guilds.
   */
  async guildIdForChannel(channelId: string): Promise<string | null> {
    const cached = this.channelGuild.get(channelId);
    if (cached !== undefined) return cached;
    const ch = (await this.channel(channelId)) as APIChannel & { guild_id?: string };
    const guildId = ch.guild_id ?? null;
    this.channelGuild.set(channelId, guildId);
    return guildId;
  }
}
