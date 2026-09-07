/** Read-only tools: guild shape, channels, roles, members, threads. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, type Ctx } from "../guards.js";
import {
  channelTypeName,
  formatChannels,
  formatGuild,
  formatMember,
  formatRoles,
  snowflakeDate,
} from "../format.js";

const guildArg = {
  guild_id: z
    .string()
    .optional()
    .describe("Guild id. Defaults to the server's configured guild."),
};

export function registerReadTools(server: McpServer, ctx: Ctx): void {
  registerTool(server, ctx, {
    name: "discord_guild_info",
    title: "Guild overview",
    summary:
      "Summarize a guild: name, owner, creation date, member and presence counts, role count, " +
      "verification level and enabled features.",
    whenToCall:
      "you need orientation before acting on a guild you have not inspected this session, or " +
      "the human asks how big or how active the server is.",
    returns:
      "a short text block of guild attributes. It reports totals only — call " +
      "discord_list_channels or discord_list_members for the things themselves.",
    tier: "read",
    inputSchema: guildArg,
    handler: async (args, c) => {
      const id = c.requireGuild(args.guild_id);
      return formatGuild(await c.client.guild(id));
    },
  });

  registerTool(server, ctx, {
    name: "discord_list_channels",
    title: "List channels",
    summary:
      "List every channel the bot can see, grouped by category, with type, id and topic.",
    whenToCall:
      "you have a channel name but need its id, which every channel-addressed tool requires, " +
      "or you need to see how the server is organized before creating or editing channels.",
    returns:
      "channels grouped under their category headings, each line carrying name, type and id. " +
      "An empty list means the bot is in the guild but its role cannot view any channel.",
    tier: "read",
    seeAlso: ["discord_create_channel", "discord_delete_channel"],
    inputSchema: guildArg,
    handler: async (args, c) => {
      const id = c.requireGuild(args.guild_id);
      return formatChannels(await c.client.guildChannels(id));
    },
  });

  registerTool(server, ctx, {
    name: "discord_list_roles",
    title: "List roles",
    summary:
      "List roles highest-position first with ids, positions and permission bitfields.",
    whenToCall:
      "before any role assignment or moderation action, because Discord decides who may " +
      "moderate whom by role position and not by permission bits alone.",
    returns:
      "one line per role with name, id, position and permission bitfield. Compare the bot's own " +
      "highest position against the target's before expecting a moderation call to succeed. " +
      "Every guild has at least the @everyone role, so an empty result means the bot cannot read " +
      "roles at all, not that none exist.",
    tier: "read",
    inputSchema: guildArg,
    handler: async (args, c) => {
      const id = c.requireGuild(args.guild_id);
      return formatRoles(await c.client.guildRoles(id));
    },
  });

  registerTool(server, ctx, {
    name: "discord_list_members",
    title: "List members",
    summary:
      "Page through guild members in join order. Requires the SERVER MEMBERS privileged intent " +
      "on the bot application; without it Discord returns Missing Access.",
    whenToCall:
      "you need the whole roster — an audit, a headcount, or finding everyone with a role. " +
      "To look up one person by name use discord_find_member instead, which is one request.",
    returns:
      "member blocks with display name, id, join date, roles and timeout state, plus the cursor " +
      "to continue paging. No members returned means the roster is exhausted, not that it is empty.",
    tier: "read",
    seeAlso: ["discord_find_member", "discord_get_member"],
    inputSchema: {
      ...guildArg,
      limit: z.number().int().min(1).max(1000).default(100).describe("Members per page (max 1000)."),
      after: z.string().optional().describe("Member id to page after, for pagination."),
    },
    handler: async (args, c) => {
      const id = c.requireGuild(args.guild_id);
      const roles = await c.client.guildRoles(id);
      const roleNames = new Map(roles.map((r) => [r.id, r.name]));
      const members = await c.client.guildMembers(id, args.limit, args.after);
      if (members.length === 0) return "No members returned — the roster is exhausted.";
      const last = members[members.length - 1]?.user?.id;
      return (
        `${members.length} members\n\n` +
        members.map((m) => formatMember(m, roleNames)).join("\n\n") +
        (members.length === args.limit ? `\n\nMore may exist — page with after: "${last}".` : "")
      );
    },
  });

  registerTool(server, ctx, {
    name: "discord_find_member",
    title: "Find member",
    summary:
      "Search guild members by username or nickname prefix. Pass the search text as query.",
    whenToCall:
      "the human names a person and you need the user id that every moderation, role and audit " +
      "tool takes. This is the normal way in; discord_list_members is for whole-roster work.",
    returns:
      "matching member blocks with id, join date and roles. No matches means nobody in the guild " +
      "has that prefix — it is a prefix match, not a fuzzy one, so try a shorter query.",
    tier: "read",
    seeAlso: ["discord_list_members"],
    inputSchema: {
      ...guildArg,
      query: z.string().min(1).describe("Username or nickname prefix to match."),
      limit: z.number().int().min(1).max(100).default(10),
    },
    handler: async (args, c) => {
      const id = c.requireGuild(args.guild_id);
      const roles = await c.client.guildRoles(id);
      const roleNames = new Map(roles.map((r) => [r.id, r.name]));
      const found = await c.client.searchGuildMembers(id, args.query, args.limit);
      if (found.length === 0) {
        return `No members matching "${args.query}". This is a prefix match — try fewer characters.`;
      }
      return found.map((m) => formatMember(m, roleNames)).join("\n\n");
    },
  });

  registerTool(server, ctx, {
    name: "discord_get_member",
    title: "Get member",
    summary:
      "Fetch one member by user_id: nickname, roles, join date and current timeout state.",
    whenToCall:
      "you already hold a user id and need their current standing — for example to check whether " +
      "a timeout is still active before deciding to escalate.",
    returns:
      "one member block. For account age and recent message history alongside this, call " +
      "discord_member_audit instead.",
    tier: "read",
    seeAlso: ["discord_member_audit", "discord_list_members"],
    inputSchema: { ...guildArg, user_id: z.string().describe("Discord user id (snowflake).") },
    handler: async (args, c) => {
      const id = c.requireGuild(args.guild_id);
      const roles = await c.client.guildRoles(id);
      const roleNames = new Map(roles.map((r) => [r.id, r.name]));
      return formatMember(await c.client.guildMember(id, args.user_id), roleNames);
    },
  });

  registerTool(server, ctx, {
    name: "discord_list_threads",
    title: "List active threads",
    summary:
      "List every active, non-archived thread in the guild with its parent channel, message " +
      "count and start date.",
    whenToCall:
      "you are looking for live discussion that discord_list_channels will not show, since " +
      "threads are not returned in the channel list.",
    returns:
      "one line per thread with name, id, parent channel id and message count. An empty result " +
      "means no thread is currently active; archived threads are not included.",
    tier: "read",
    seeAlso: ["discord_list_channels", "discord_create_thread"],
    inputSchema: guildArg,
    handler: async (args, c) => {
      const id = c.requireGuild(args.guild_id);
      const { threads } = await c.client.activeThreads(id);
      if (threads.length === 0) return "No active threads. Archived threads are not listed here.";
      return [
        `${threads.length} active threads`,
        ...threads.map((t) => {
          const meta = t as typeof t & { message_count?: number; parent_id?: string | null };
          return (
            `- ${t.name} · id ${t.id} · ${channelTypeName(t.type)}` +
            ` · parent ${meta.parent_id ?? "?"} · ${meta.message_count ?? "?"} messages` +
            ` · started ${snowflakeDate(t.id).toISOString().slice(0, 10)}`
          );
        }),
      ].join("\n");
    },
  });
}
