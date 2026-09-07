/**
 * Moderation and roles.
 *
 * Every tool here writes an audit-log entry. `reason` is required rather than
 * optional on the member-facing actions: a kick with no recorded reason is a
 * mystery to whoever reads the audit log next week.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardError, registerTool, type Ctx } from "../guards.js";
import { formatMember, formatMessage, snowflakeDate } from "../format.js";
import { collectHistory, readableTextChannels } from "../history.js";

export function registerModerationTools(server: McpServer, ctx: Ctx): void {
  registerTool(server, ctx, {
    name: "discord_timeout_member",
    title: "Time out member",
    summary:
      "Mute the member at user_id for minutes, up to 28 days, recording reason in the audit log. " +
      "Passing 0 minutes lifts an active timeout.",
    whenToCall:
      "someone needs to stop posting but not to leave. This is the reversible moderation action, " +
      "so reach for it first \u2014 discord_kick_member and discord_ban_member are not undoable in " +
      "the same way and should follow, not lead.",
    returns:
      "a confirmation with the expiry timestamp, or confirmation that a timeout was lifted.",
    tier: "admin",
    seeAlso: ["discord_kick_member", "discord_ban_member"],
    inputSchema: {
      guild_id: z.string().optional(),
      user_id: z.string(),
      minutes: z
        .number()
        .int()
        .min(0)
        .max(40320)
        .describe("Timeout length in minutes, max 40320 (28 days). 0 lifts an existing timeout."),
      reason: z.string().min(1).describe("Audit-log reason. Required."),
    },
    handler: async (args, c) => {
      const guildId = c.requireGuild(args.guild_id);
      const until =
        args.minutes === 0
          ? null
          : new Date(Date.now() + args.minutes * 60_000).toISOString();
      await c.client.editMember(
        guildId,
        args.user_id,
        { communication_disabled_until: until },
        args.reason,
      );
      return until
        ? `Timed out ${args.user_id} until ${until} (${args.minutes} min). Reason: ${args.reason}`
        : `Lifted timeout on ${args.user_id}. Reason: ${args.reason}`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_set_nickname",
    title: "Set member nickname",
    summary:
      "Set the guild nickname of the member at user_id, or clear it by passing null. This changes " +
      "their display name in this guild only, never their Discord account name.",
    whenToCall:
      "a display name breaks server naming convention or impersonates someone, and renaming is a " +
      "lighter fix than removing the person.",
    returns:
      "a confirmation of the new nickname, or that it was cleared.",
    tier: "admin",
    inputSchema: {
      guild_id: z.string().optional(),
      user_id: z.string(),
      nickname: z.string().max(32).nullable().describe("New nickname, or null to clear it."),
      reason: z.string().optional(),
    },
    handler: async (args, c) => {
      const guildId = c.requireGuild(args.guild_id);
      await c.client.editMember(guildId, args.user_id, { nick: args.nickname }, args.reason);
      return args.nickname
        ? `Set nickname of ${args.user_id} to "${args.nickname}".`
        : `Cleared nickname of ${args.user_id}.`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_manage_member_role",
    title: "Add or remove a member role",
    summary:
      "Grant or revoke the single role at role_id on the member at user_id, according to action, " +
      "recording reason in the audit log.",
    whenToCall:
      "promoting a member, granting access gated behind a role, or withdrawing either. Check " +
      "discord_list_roles first: the bot's own highest role must sit above the role being " +
      "assigned or Discord refuses with Missing Permissions.",
    returns:
      "a confirmation of the role change and the reason recorded.",
    tier: "admin",
    seeAlso: ["discord_list_roles"],
    inputSchema: {
      guild_id: z.string().optional(),
      user_id: z.string(),
      role_id: z.string(),
      action: z.enum(["add", "remove"]),
      reason: z.string().min(1).describe("Audit-log reason. Required."),
    },
    handler: async (args, c) => {
      const guildId = c.requireGuild(args.guild_id);
      if (args.action === "add") {
        await c.client.addMemberRole(guildId, args.user_id, args.role_id, args.reason);
        return `Added role ${args.role_id} to ${args.user_id}. Reason: ${args.reason}`;
      }
      await c.client.removeMemberRole(guildId, args.user_id, args.role_id, args.reason);
      return `Removed role ${args.role_id} from ${args.user_id}. Reason: ${args.reason}`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_create_role",
    title: "Create role",
    summary:
      "Create a role called name with the given permission bitfield, color and display options. " +
      "New roles land at the bottom of the role list regardless of what they are allowed to do.",
    whenToCall:
      "a group of members needs to be addressed or gated together. Leave permissions at \"0\" and " +
      "grant access per-channel through discord_set_channel_permissions unless the role genuinely " +
      "needs guild-wide power \u2014 a broad bitfield here applies everywhere at once.",
    returns:
      "the new role's name, id and position.",
    tier: "admin",
    seeAlso: ["discord_set_channel_permissions", "discord_edit_role", "discord_delete_role"],
    inputSchema: {
      guild_id: z.string().optional(),
      name: z.string().min(1).max(100),
      permissions: z.string().default("0").describe("Permission bitfield as a decimal string."),
      color: z.number().int().min(0).max(0xffffff).optional().describe("RGB integer, e.g. 3447003."),
      hoist: z.boolean().default(false).describe("Display members with this role separately."),
      mentionable: z.boolean().default(false),
      reason: z.string().optional(),
    },
    handler: async (args, c) => {
      const guildId = c.requireGuild(args.guild_id);
      const role = await c.client.createRole(
        guildId,
        {
          name: args.name,
          permissions: args.permissions,
          color: args.color ?? 0,
          hoist: args.hoist,
          mentionable: args.mentionable,
        },
        args.reason,
      );
      return `Created role "${role.name}" · id ${role.id} · position ${role.position}.`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_edit_role",
    title: "Edit role",
    summary:
      "Change the name, permission bitfield, color, hoist or mentionable flags of the role at " +
      "role_id. Only the fields you pass are touched. Position is not editable here.",
    whenToCall:
      "adjusting an existing role rather than making a new one. Widening a permission bitfield " +
      "affects every member holding the role immediately and everywhere in the guild.",
    returns:
      "a confirmation listing which fields changed. A call that provides no editable field is " +
      "refused rather than reported as a successful no-op.",
    tier: "admin",
    seeAlso: ["discord_create_role", "discord_delete_role"],
    inputSchema: {
      guild_id: z.string().optional(),
      role_id: z.string(),
      name: z.string().min(1).max(100).optional(),
      permissions: z.string().optional(),
      color: z.number().int().min(0).max(0xffffff).optional(),
      hoist: z.boolean().optional(),
      mentionable: z.boolean().optional(),
      reason: z.string().optional(),
    },
    handler: async (args, c) => {
      const guildId = c.requireGuild(args.guild_id);
      const body: Record<string, unknown> = {};
      for (const key of ["name", "permissions", "color", "hoist", "mentionable"] as const) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      if (Object.keys(body).length === 0) {
        // A no-op reported as success reads to an agent as "the edit landed".
        throw new GuardError(
          "No editable field was provided, so nothing was changed. Pass at least one of " +
            "name, permissions, color, hoist or mentionable.",
        );
      }
      const role = await c.client.editRole(guildId, args.role_id, body, args.reason);
      return `Updated role "${role.name}" (${role.id}): ${Object.keys(body).join(", ")}.`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_list_bans",
    title: "List bans",
    summary:
      "List every user currently banned from the guild, with the reason recorded at ban time.",
    whenToCall:
      "checking whether someone was already banned before acting, or reviewing past moderation " +
      "decisions. An empty result means nobody is banned.",
    returns:
      "one line per ban with username, id and reason. \"(none recorded)\" means the ban was made " +
      "without a reason, not that the reason is hidden.",
    tier: "admin",
    seeAlso: ["discord_unban_member"],
    inputSchema: {
      guild_id: z.string().optional(),
      limit: z.number().int().min(1).max(1000).default(100),
    },
    handler: async (args, c) => {
      const guildId = c.requireGuild(args.guild_id);
      const bans = await c.client.guildBans(guildId, args.limit);
      if (bans.length === 0) return "No active bans.";
      return [
        `${bans.length} ban(s)`,
        ...bans.map(
          (b) =>
            `- @${b.user.username} · id ${b.user.id} · reason: ${b.reason ?? "(none recorded)"}`,
        ),
      ].join("\n");
    },
  });

  registerTool(server, ctx, {
    name: "discord_unban_member",
    title: "Unban member",
    summary:
      "Lift the ban on the user at user_id, recording reason in the audit log. They can then " +
      "rejoin, but only with a fresh invite \u2014 unbanning does not bring anyone back by itself.",
    whenToCall:
      "reversing a ban, whether on appeal or because it was applied in error. This is the " +
      "counterpart to discord_ban_member; use discord_list_bans first if you need the user id.",
    returns:
      "a confirmation naming the unbanned user and the reason recorded.",
    tier: "admin",
    seeAlso: ["discord_ban_member", "discord_list_bans"],
    inputSchema: {
      guild_id: z.string().optional(),
      user_id: z.string(),
      reason: z.string().min(1).describe("Audit-log reason. Required."),
    },
    handler: async (args, c) => {
      const guildId = c.requireGuild(args.guild_id);
      await c.client.unbanMember(guildId, args.user_id, args.reason);
      return `Unbanned ${args.user_id}. Reason: ${args.reason}`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_kick_member",
    title: "Kick member",
    summary:
      "Remove the member at user_id from the guild, recording reason in the audit log. They can " +
      "rejoin immediately with any valid invite, so this is a reset and not a block.",
    whenToCall:
      "you want someone gone now but not permanently barred. If they must stay out, " +
      "discord_ban_member is the tool; if they should simply stop talking, " +
      "discord_timeout_member is reversible and less severe. Audit with discord_member_audit first.",
    returns:
      "a confirmation naming the kicked member and the reason recorded.",
    tier: "admin",
    seeAlso: ["discord_ban_member", "discord_timeout_member", "discord_member_audit"],
    destructive: true,
    inputSchema: {
      guild_id: z.string().optional(),
      user_id: z.string(),
      reason: z.string().min(1).describe("Audit-log reason. Required."),
    },
    handler: async (args, c) => {
      const guildId = c.requireGuild(args.guild_id);
      const member = await c.client.guildMember(guildId, args.user_id);
      await c.client.kickMember(guildId, args.user_id, args.reason);
      return `Kicked @${member.user?.username ?? args.user_id} (${args.user_id}). Reason: ${args.reason}`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_ban_member",
    title: "Ban member",
    summary:
      "Ban the user at user_id from the guild, recording reason in the audit log and optionally " +
      "deleting up to 7 days of their messages. Bans persist until explicitly lifted and work " +
      "even on users who are not currently members.",
    whenToCall:
      "someone must be kept out permanently \u2014 raids, spam networks, repeat abuse. Run " +
      "discord_member_audit first so the decision rests on their record and not one report. " +
      "Reverse it with discord_unban_member; prefer discord_timeout_member for anything short of removal.",
    returns:
      "a confirmation naming the banned user, any message purge applied, and the reason recorded.",
    tier: "admin",
    seeAlso: ["discord_unban_member", "discord_timeout_member", "discord_member_audit"],
    destructive: true,
    inputSchema: {
      guild_id: z.string().optional(),
      user_id: z.string(),
      delete_message_days: z
        .number()
        .int()
        .min(0)
        .max(7)
        .default(0)
        .describe("Also delete this many days of the user's messages. 0 keeps their history."),
      reason: z.string().min(1).describe("Audit-log reason. Required."),
    },
    handler: async (args, c) => {
      const guildId = c.requireGuild(args.guild_id);
      await c.client.banMember(
        guildId,
        args.user_id,
        { delete_message_seconds: args.delete_message_days * 86_400 },
        args.reason,
      );
      const scrub =
        args.delete_message_days > 0
          ? ` and deleted ${args.delete_message_days} day(s) of their messages`
          : "";
      return `Banned ${args.user_id}${scrub}. Reason: ${args.reason}`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_delete_role",
    title: "Delete role",
    summary:
      "Delete the role at role_id. Every member holding it loses it at once, along with any " +
      "channel permission overwrites keyed to that role.",
    whenToCall:
      "a role is genuinely obsolete. If the goal is to change what it grants rather than remove " +
      "it, discord_edit_role keeps the membership intact and this does not.",
    returns:
      "a confirmation naming the deleted role id. With dry_run:true, the role's name, position " +
      "and permissions plus how many members would lose it.",
    tier: "admin",
    seeAlso: ["discord_edit_role", "discord_create_role"],
    destructive: true,
    dryRunnable: true,
    inputSchema: {
      guild_id: z.string().optional(),
      role_id: z.string(),
      reason: z.string().optional(),
    },
    handler: async (args, c) => {
      const guildId = c.requireGuild(args.guild_id);

      if (args.dry_run) {
        const roles = await c.client.guildRoles(guildId);
        const role = roles.find((r) => r.id === args.role_id);
        if (!role) return `DRY RUN — no role ${args.role_id} exists in this guild.`;

        // Holder count needs the members intent; say so rather than imply zero.
        let holders: string;
        try {
          const members = await c.client.guildMembers(guildId, 1000);
          const held = members.filter((m) => m.roles.includes(args.role_id));
          holders = `${held.length} member(s) would lose it${
            held.length ? `: ${held.slice(0, 10).map((m) => `@${m.user?.username}`).join(", ")}` : ""
          }${held.length > 10 ? ` and ${held.length - 10} more` : ""}`;
        } catch {
          holders =
            "holder count unavailable — enable the SERVER MEMBERS intent to see who would lose it";
        }

        return [
          "DRY RUN — nothing was changed.",
          "",
          `would delete role: "${role.name}" (id ${role.id}, position ${role.position})`,
          `permissions: ${role.permissions}`,
          holders,
          "channel overwrites keyed to this role are removed with it",
          role.managed
            ? "NOTE: this role is managed by an integration and Discord will refuse to delete it"
            : "",
          "",
          "Re-run with dry_run:false and confirm:true to carry this out.",
        ]
          .filter(Boolean)
          .join("\n");
      }

      await c.client.deleteRole(guildId, args.role_id, args.reason);
      return `Deleted role ${args.role_id}.`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_member_audit",
    title: "Audit a member",
    summary:
      "Assemble the record on the member at user_id: account age, join date, roles, timeout " +
      "state, and their actual recent messages gathered across every readable text channel.",
    whenToCall:
      "before any kick or ban, and whenever a single reported message is the only evidence you " +
      "have. This is the inspect step that discord_kick_member and discord_ban_member should " +
      "follow \u2014 it is read-only and changes nothing.",
    returns:
      "a member block, an account-age note flagging accounts under a week old, per-channel " +
      "activity counts, and the most recent messages. No messages found means they have not " +
      "posted within scan_limit messages per channel, not that they never posted.",
    tier: "admin",
    seeAlso: ["discord_kick_member", "discord_ban_member", "discord_get_member"],
    inputSchema: {
      guild_id: z.string().optional(),
      user_id: z.string(),
      scan_limit: z
        .number()
        .int()
        .min(50)
        .max(1000)
        .default(200)
        .describe("Messages to scan per channel when gathering their recent activity."),
      max_messages: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe("Most recent messages by this member to report."),
    },
    handler: async (args, c) => {
      const guildId = c.requireGuild(args.guild_id);
      const [member, roles] = await Promise.all([
        c.client.guildMember(guildId, args.user_id),
        c.client.guildRoles(guildId),
      ]);
      const roleNames = new Map(roles.map((r) => [r.id, r.name]));

      const accountCreated = snowflakeDate(args.user_id);
      const ageDays = Math.floor((Date.now() - accountCreated.getTime()) / 86_400_000);
      const joinedDays = member.joined_at
        ? Math.floor((Date.now() - new Date(member.joined_at).getTime()) / 86_400_000)
        : null;

      const channels = await readableTextChannels(c.client, guildId);
      const found: { msg: import("discord-api-types/v10").APIMessage; channel: string }[] = [];
      const unreadable: string[] = [];

      for (const ch of channels) {
        try {
          const history = await collectHistory(c.client, ch.id, args.scan_limit);
          for (const m of history) {
            if (m.author?.id === args.user_id) found.push({ msg: m, channel: ch.name });
          }
        } catch {
          unreadable.push(ch.name);
        }
      }

      found.sort(
        (a, b) => new Date(b.msg.timestamp).getTime() - new Date(a.msg.timestamp).getTime(),
      );
      const recent = found.slice(0, args.max_messages);

      const activity =
        recent.length === 0
          ? `No messages by this member in the last ${args.scan_limit} messages of ` +
            `${channels.length} channel(s).`
          : recent
              .map((f) => formatMessage(f.msg, { channelName: f.channel }))
              .join("\n\n");

      const perChannel = new Map<string, number>();
      for (const f of found) perChannel.set(f.channel, (perChannel.get(f.channel) ?? 0) + 1);

      return [
        "## Member",
        formatMember(member, roleNames),
        `  account created: ${accountCreated.toISOString().slice(0, 10)} (${ageDays} days old)`,
        joinedDays !== null ? `  in guild for: ${joinedDays} days` : "",
        ageDays < 7 ? "  NOTE: account is less than a week old." : "",
        "",
        "## Activity",
        `${found.length} message(s) found across ${perChannel.size} channel(s)` +
          (perChannel.size
            ? `: ${[...perChannel].map(([n, k]) => `#${n} ${k}`).join(", ")}`
            : "."),
        unreadable.length ? `Could not read: ${unreadable.join(", ")}.` : "",
        "",
        `## Most recent ${recent.length} message(s)`,
        activity,
      ]
        .filter((line) => line !== "")
        .join("\n");
    },
  });
}
