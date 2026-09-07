/** Channel administration: create, edit, delete, permission overwrites. */

import { z } from "zod";
import { ChannelType } from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardError, registerTool, type Ctx } from "../guards.js";
import { channelName, channelTypeName } from "../format.js";

/** Permission bits present in `before` but absent from `after`. */
function diffBits(before: string, after: string): string[] {
  const lost = BigInt(before || "0") & ~BigInt(after || "0");
  if (lost === 0n) return [];
  const bits: string[] = [];
  for (let i = 0n; i < 64n; i++) {
    const bit = 1n << i;
    if (lost & bit) bits.push(bit.toString());
  }
  return bits;
}

const CHANNEL_KINDS = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  stage: ChannelType.GuildStageVoice,
} as const;

export function registerChannelTools(server: McpServer, ctx: Ctx): void {
  registerTool(server, ctx, {
    name: "discord_create_channel",
    title: "Create channel",
    summary:
      "Create a channel called name in the guild, of the given kind. Nest it under a category by " +
      "passing that category's parent_id, which discord_list_channels reports.",
    whenToCall:
      "a topic needs a permanent home of its own. For something temporary or conversational, " +
      "discord_create_thread is lighter and does not clutter the channel list.",
    returns:
      "the new channel's type, name and id.",
    tier: "admin",
    seeAlso: ["discord_create_thread", "discord_list_channels", "discord_delete_channel"],
    inputSchema: {
      guild_id: z.string().optional(),
      name: z.string().min(1).max(100).describe("Channel name (Discord lowercases text channels)."),
      kind: z
        .enum(["text", "voice", "category", "announcement", "forum", "stage"])
        .default("text"),
      parent_id: z.string().optional().describe("Category id to nest under."),
      topic: z.string().max(1024).optional(),
      nsfw: z.boolean().optional(),
      rate_limit_per_user: z
        .number()
        .int()
        .min(0)
        .max(21600)
        .optional()
        .describe("Slowmode in seconds."),
      position: z.number().int().min(0).optional(),
      reason: z.string().optional().describe("Audit-log reason."),
    },
    handler: async (args, c) => {
      const guildId = c.requireGuild(args.guild_id);
      const body: Record<string, unknown> = { name: args.name, type: CHANNEL_KINDS[args.kind] };
      if (args.parent_id) body.parent_id = args.parent_id;
      if (args.topic !== undefined) body.topic = args.topic;
      if (args.nsfw !== undefined) body.nsfw = args.nsfw;
      if (args.rate_limit_per_user !== undefined) body.rate_limit_per_user = args.rate_limit_per_user;
      if (args.position !== undefined) body.position = args.position;
      const ch = await c.client.createChannel(guildId, body, args.reason);
      return `Created ${channelTypeName(ch.type)} channel "${args.name}" · id ${ch.id}.`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_edit_channel",
    title: "Edit channel",
    summary:
      "Change the channel at channel_id: its name, topic, slowmode, category, position or NSFW " +
      "flag. Only the fields you pass are touched; everything omitted is left alone.",
    whenToCall:
      "adjusting an existing channel rather than replacing it. To change who can see or post in " +
      "it, use discord_set_channel_permissions instead \u2014 that is a different mechanism.",
    returns:
      "a confirmation listing which fields changed. A call that provides no editable field is " +
      "refused rather than reported as a successful no-op.",
    tier: "admin",
    seeAlso: ["discord_set_channel_permissions"],
    inputSchema: {
      channel_id: z.string(),
      name: z.string().min(1).max(100).optional(),
      topic: z.string().max(1024).optional(),
      parent_id: z.string().nullable().optional().describe("Category id, or null to un-nest."),
      position: z.number().int().min(0).optional(),
      nsfw: z.boolean().optional(),
      rate_limit_per_user: z.number().int().min(0).max(21600).optional(),
      reason: z.string().optional(),
    },
    handler: async (args, c) => {
      await c.requireChannel(args.channel_id);
      const body: Record<string, unknown> = {};
      for (const key of [
        "name",
        "topic",
        "parent_id",
        "position",
        "nsfw",
        "rate_limit_per_user",
      ] as const) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      if (Object.keys(body).length === 0) {
        // A no-op reported as success reads to an agent as "the edit landed".
        throw new GuardError(
          "No editable field was provided, so nothing was changed. Pass at least one of " +
            "name, topic, parent_id, position, nsfw or rate_limit_per_user.",
        );
      }
      const ch = await c.client.editChannel(args.channel_id, body, args.reason);
      return `Updated channel ${ch.id}: ${Object.keys(body).join(", ")}.`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_set_channel_permissions",
    title: "Set channel permission overwrite",
    summary:
      "Set the allow and deny permission overwrite on channel_id for the single role or member " +
      "named by target_id and target_type. Permissions are Discord bitfield strings, for example " +
      "\"1024\" for VIEW_CHANNEL and \"2048\" for SEND_MESSAGES.",
    whenToCall:
      "one role or person needs different access to one channel. This REPLACES that target's " +
      "whole overwrite rather than merging into it, so read the channel's current overwrites " +
      "first or you will silently drop permissions the target already had.",
    returns:
      "a confirmation of the overwrite that was written. With dry_run:true, the target's current " +
      "overwrite beside the proposed one, naming any permission bits the replacement would revoke.",
    tier: "admin",
    destructive: true,
    dryRunnable: true,
    seeAlso: ["discord_edit_channel"],
    inputSchema: {
      channel_id: z.string(),
      target_id: z.string().describe("Role id or user id the overwrite applies to."),
      target_type: z.enum(["role", "member"]),
      allow: z.string().default("0").describe("Permission bitfield to allow, as a decimal string."),
      deny: z.string().default("0").describe("Permission bitfield to deny, as a decimal string."),
      reason: z.string().optional(),
    },
    handler: async (args, c) => {
      await c.requireChannel(args.channel_id);

      if (args.dry_run) {
        // This endpoint replaces rather than merges, so the only way to see what
        // a call costs is to read the overwrite it is about to overwrite.
        const ch = await c.client.channel(args.channel_id);
        const overwrites =
          (ch as { permission_overwrites?: { id: string; allow: string; deny: string }[] })
            .permission_overwrites ?? [];
        const current = overwrites.find((o) => o.id === args.target_id);
        const lostAllow = current ? diffBits(current.allow, args.allow) : [];
        const lostDeny = current ? diffBits(current.deny, args.deny) : [];
        return [
          "DRY RUN — nothing was changed.",
          "",
          `channel: "${channelName(ch)}" (${args.channel_id})`,
          `target:  ${args.target_type} ${args.target_id}`,
          current
            ? `current: allow ${current.allow}, deny ${current.deny}`
            : "current: no overwrite for this target (one would be created)",
          `after:   allow ${args.allow}, deny ${args.deny}`,
          lostAllow.length
            ? `WOULD REVOKE allow bits: ${lostAllow.join(", ")} — this call replaces the ` +
              "overwrite rather than merging into it"
            : "",
          lostDeny.length ? `would drop deny bits: ${lostDeny.join(", ")}` : "",
          "",
          "Re-run with dry_run:false and confirm:true to carry this out.",
        ]
          .filter(Boolean)
          .join("\n");
      }

      await c.client.setChannelOverwrite(
        args.channel_id,
        args.target_id,
        { type: args.target_type === "role" ? 0 : 1, allow: args.allow, deny: args.deny },
        args.reason,
      );
      return (
        `Set overwrite on channel ${args.channel_id} for ${args.target_type} ${args.target_id} ` +
        `(allow ${args.allow}, deny ${args.deny}).`
      );
    },
  });

  registerTool(server, ctx, {
    name: "discord_delete_channel",
    title: "Delete channel",
    summary:
      "Delete the channel at channel_id together with every message in it. Deleting a category " +
      "orphans its children rather than removing them.",
    whenToCall:
      "a channel is genuinely finished and the human has agreed to lose its history. If the " +
      "goal is only to hide it, an overwrite via discord_set_channel_permissions is reversible " +
      "and this is not.",
    returns:
      "a confirmation naming the deleted channel. With dry_run:true, a preview naming the " +
      "channel, how much history would be lost, and any child channels that would be orphaned.",
    tier: "admin",
    seeAlso: [
      "discord_set_channel_permissions",
      "discord_create_channel",
      "discord_list_channels",
    ],
    destructive: true,
    dryRunnable: true,
    inputSchema: {
      channel_id: z.string(),
      reason: z.string().optional(),
    },
    handler: async (args, c) => {
      const guildId = await c.requireChannel(args.channel_id);
      const ch = await c.client.channel(args.channel_id);
      const name = channelName(ch);

      if (args.dry_run) {
        // Discord exposes no message count, so sample the tail: enough to say
        // whether this channel is empty or carries real history.
        let sampled = 0;
        let oldest: string | undefined;
        try {
          const recent = await c.client.messages(args.channel_id, { limit: 100 });
          sampled = recent.length;
          oldest = recent[recent.length - 1]?.timestamp;
        } catch {
          // Unreadable channel; the rest of the preview still stands.
        }
        const children = (await c.client.guildChannels(guildId)).filter(
          (other) => (other as { parent_id?: string | null }).parent_id === args.channel_id,
        );
        return [
          "DRY RUN — nothing was changed.",
          "",
          `would delete: "${name}" (${channelTypeName(ch.type)}, id ${args.channel_id})`,
          sampled === 0
            ? "message history: none readable, or the channel is empty"
            : `message history: at least ${sampled} message(s)${
                sampled === 100 ? " (sampled 100, likely more)" : ""
              }${oldest ? `, oldest sampled ${oldest.slice(0, 10)}` : ""} — all unrecoverable`,
          children.length
            ? `orphans ${children.length} child channel(s): ${children
                .map(channelName)
                .join(", ")} (they are not deleted)`
            : "no child channels",
          "",
          "Re-run with dry_run:false and confirm:true to carry this out.",
        ].join("\n");
      }

      await c.client.deleteChannel(args.channel_id, args.reason);
      return `Deleted channel "${name}" (${args.channel_id}) and its message history.`;
    },
  });
}
