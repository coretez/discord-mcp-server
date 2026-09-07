/** Message tools: reading and searching (read tier), posting and editing (write tier). */

import { z } from "zod";
import { ChannelType } from "discord-api-types/v10";
import type { APIMessage } from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, type Ctx } from "../guards.js";
import { channelName, formatMessage, formatMessages } from "../format.js";
import { collectHistory, readableTextChannels } from "../history.js";

export function registerMessageTools(server: McpServer, ctx: Ctx): void {
  registerTool(server, ctx, {
    name: "discord_read_messages",
    title: "Read channel messages",
    summary:
      "Read recent messages from a channel or thread given its channel_id, oldest-first, with " +
      "author, timestamp, message id, attachments, embeds and reactions.",
    whenToCall:
      "you know which channel holds the conversation and want it in order. To find a channel " +
      "when you do not know which one, use discord_search_messages instead.",
    returns:
      "messages oldest-first as timestamped blocks, plus the cursor to page further back. " +
      "An empty result means the channel has no messages in the requested range.",
    tier: "read",
    seeAlso: ["discord_search_messages", "discord_delete_message"],
    inputSchema: {
      channel_id: z.string().describe("Channel or thread id."),
      limit: z.number().int().min(1).max(100).default(50),
      before: z.string().optional().describe("Return messages older than this message id."),
      after: z.string().optional().describe("Return messages newer than this message id."),
      around: z.string().optional().describe("Return messages centered on this message id."),
    },
    handler: async (args, c) => {
      await c.requireChannel(args.channel_id);
      const msgs = await c.client.messages(args.channel_id, {
        limit: args.limit,
        before: args.before,
        after: args.after,
        around: args.around,
      });
      const oldest = msgs[msgs.length - 1]?.id;
      return (
        formatMessages(msgs) +
        (msgs.length === args.limit && oldest
          ? `\n\n(page further back with before: "${oldest}")`
          : "")
      );
    },
  });

  registerTool(server, ctx, {
    name: "discord_search_messages",
    title: "Search messages",
    summary:
      "Case-insensitive substring search for query across recent history, spanning every text " +
      "channel the bot can read unless channel_id narrows it. Discord's native search endpoint " +
      "is not available to bots, so this pages history and filters locally.",
    whenToCall:
      "you are looking for something across the server and do not know where it was said. " +
      "If you already know the channel, discord_read_messages is cheaper.",
    returns:
      "matching messages with their channel name, plus a note of any channel it could not read. " +
      "No matches means nothing matched within scan_limit messages per channel — raise " +
      "scan_limit to search deeper, at the cost of more API calls.",
    tier: "read",
    seeAlso: ["discord_read_messages", "discord_delete_message"],
    inputSchema: {
      guild_id: z.string().optional(),
      query: z.string().min(1).describe("Substring to match in message content."),
      channel_id: z.string().optional().describe("Restrict to one channel."),
      author_id: z.string().optional().describe("Restrict to one author's messages."),
      scan_limit: z
        .number()
        .int()
        .min(50)
        .max(2000)
        .default(300)
        .describe("Messages to scan per channel before giving up."),
      max_results: z.number().int().min(1).max(100).default(25),
    },
    handler: async (args, c) => {
      const guildId = c.requireGuild(args.guild_id);
      let targets: { id: string; name: string }[];

      if (args.channel_id) {
        await c.requireChannel(args.channel_id);
        const ch = await c.client.channel(args.channel_id);
        targets = [{ id: ch.id, name: channelName(ch) }];
      } else {
        targets = await readableTextChannels(c.client, guildId);
      }

      const needle = args.query.toLowerCase();
      const hits: string[] = [];
      const unreadable: string[] = [];

      for (const t of targets) {
        if (hits.length >= args.max_results) break;
        let history: APIMessage[];
        try {
          history = await collectHistory(c.client, t.id, args.scan_limit);
        } catch {
          unreadable.push(t.name);
          continue;
        }
        for (const m of history) {
          if (hits.length >= args.max_results) break;
          if (args.author_id && m.author?.id !== args.author_id) continue;
          if (!m.content?.toLowerCase().includes(needle)) continue;
          hits.push(formatMessage(m, { channelName: t.name }));
        }
      }

      if (hits.length === 0) {
        return (
          `No messages matching "${args.query}" in the last ${args.scan_limit} messages of ` +
          `${targets.length} channel(s).` +
          (unreadable.length ? ` Could not read: ${unreadable.join(", ")}.` : "")
        );
      }
      return (
        `${hits.length} match(es) for "${args.query}"\n\n` +
        hits.join("\n\n") +
        (unreadable.length ? `\n\nCould not read: ${unreadable.join(", ")}.` : "")
      );
    },
  });

  registerTool(server, ctx, {
    name: "discord_send_message",
    title: "Send message",
    summary:
      "Post content to the channel or thread named by channel_id, as the bot. Optionally replies " +
      "to an existing message. Mentions are suppressed unless allow_mentions is set, so a draft " +
      "quoting @everyone will not ping the server.",
    whenToCall:
      "the human has asked you to say something in the guild. Posting is visible to everyone " +
      "who can read the channel, so confirm the wording before calling this.",
    returns:
      "the new message id and a rendering of what was posted.",
    tier: "write",
    inputSchema: {
      channel_id: z.string().describe("Channel or thread id to post in."),
      content: z.string().min(1).max(2000).describe("Message text (Discord markdown, max 2000 chars)."),
      reply_to_message_id: z.string().optional().describe("Message id to reply to."),
      allow_mentions: z
        .boolean()
        .default(false)
        .describe("When false (default) @everyone, role and user pings are neutered."),
    },
    handler: async (args, c) => {
      await c.requireWritableChannel(args.channel_id);
      const body: Record<string, unknown> = {
        content: args.content,
        allowed_mentions: args.allow_mentions
          ? { parse: ["users", "roles"] }
          : { parse: [] },
      };
      if (args.reply_to_message_id) {
        body.message_reference = { message_id: args.reply_to_message_id, fail_if_not_exists: false };
      }
      const msg = await c.client.createMessage(args.channel_id, body);
      return `Sent message ${msg.id} to channel ${args.channel_id}.\n\n${formatMessage(msg)}`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_edit_message",
    title: "Edit message",
    summary:
      "Replace the content of the message at message_id in channel_id. Discord only permits a " +
      "bot to edit its own messages, so this fails on anything a person wrote.",
    whenToCall:
      "you posted something that needs correcting. To remove it entirely rather than fix it, " +
      "use discord_delete_message.",
    returns:
      "the edited message as it now stands.",
    tier: "write",
    seeAlso: ["discord_delete_message"],
    inputSchema: {
      channel_id: z.string(),
      message_id: z.string(),
      content: z.string().min(1).max(2000),
    },
    handler: async (args, c) => {
      await c.requireWritableChannel(args.channel_id);
      const msg = await c.client.editMessage(args.channel_id, args.message_id, {
        content: args.content,
      });
      return `Edited message ${msg.id}.\n\n${formatMessage(msg)}`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_add_reaction",
    title: "React to message",
    summary:
      "Add one reaction as the bot to the message at message_id in channel_id. Accepts a literal " +
      "unicode emoji or a custom guild emoji written as name:id.",
    whenToCall:
      "acknowledging a message is enough and a reply would add noise \u2014 marking a request seen, " +
      "or signalling a poll vote.",
    returns:
      "a confirmation naming the emoji and message. Custom emoji from other guilds will fail.",
    tier: "write",
    inputSchema: {
      channel_id: z.string(),
      message_id: z.string(),
      emoji: z.string().describe('Unicode emoji, or "name:id" for a custom guild emoji.'),
    },
    handler: async (args, c) => {
      await c.requireWritableChannel(args.channel_id);
      await c.client.addReaction(args.channel_id, args.message_id, args.emoji);
      return `Reacted ${args.emoji} to message ${args.message_id}.`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_pin_message",
    title: "Pin or unpin message",
    summary:
      "Pin or unpin the message at message_id in channel_id, according to the pinned flag. " +
      "A channel holds at most 50 pins, and Discord rejects the 51st.",
    whenToCall:
      "a message should stay findable at the top of a channel \u2014 rules, a current announcement, " +
      "a link people keep asking for.",
    returns:
      "a confirmation of the pin or unpin.",
    tier: "write",
    inputSchema: {
      channel_id: z.string(),
      message_id: z.string(),
      pinned: z.boolean().default(true).describe("true pins, false unpins."),
      reason: z.string().optional().describe("Audit-log reason."),
    },
    handler: async (args, c) => {
      await c.requireWritableChannel(args.channel_id);
      if (args.pinned) {
        await c.client.pinMessage(args.channel_id, args.message_id, args.reason);
        return `Pinned message ${args.message_id}.`;
      }
      await c.client.unpinMessage(args.channel_id, args.message_id, args.reason);
      return `Unpinned message ${args.message_id}.`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_create_thread",
    title: "Create thread",
    summary:
      "Start a thread called name under the text channel at channel_id, either anchored to an " +
      "existing message or standalone.",
    whenToCall:
      "a side conversation is taking over a channel, or a topic deserves its own space without " +
      "the weight of a new channel. Prefer this over discord_create_channel for anything temporary.",
    returns:
      "the new thread name and id. Post into it by passing that id to discord_send_message.",
    tier: "write",
    seeAlso: ["discord_create_channel", "discord_list_threads"],
    inputSchema: {
      channel_id: z.string().describe("Parent text channel id."),
      name: z.string().min(1).max(100).describe("Thread name."),
      from_message_id: z
        .string()
        .optional()
        .describe("Anchor the thread to this message. Omit for a standalone thread."),
      auto_archive_minutes: z
        .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
        .default(1440)
        .describe("Inactivity before auto-archive: 60, 1440, 4320 or 10080 minutes."),
      private: z
        .boolean()
        .default(false)
        .describe("Standalone threads only: create a private thread."),
    },
    handler: async (args, c) => {
      await c.requireWritableChannel(args.channel_id);
      const body: Record<string, unknown> = {
        name: args.name,
        auto_archive_duration: args.auto_archive_minutes,
      };
      const thread = args.from_message_id
        ? await c.client.createThreadFromMessage(args.channel_id, args.from_message_id, body)
        : await c.client.createThread(args.channel_id, {
            ...body,
            type: args.private ? ChannelType.PrivateThread : ChannelType.PublicThread,
          });
      return `Created thread "${args.name}" · id ${thread.id}.`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_delete_message",
    title: "Delete message",
    summary:
      "Permanently delete the single message at message_id in channel_id. Discord has no trash " +
      "and no undo, and the author is not notified.",
    whenToCall:
      "one specific message must go and you have the human's agreement to remove it. For several " +
      "at once use discord_bulk_delete_messages; to correct rather than remove, discord_edit_message.",
    returns:
      "a confirmation naming the deleted message id. With dry_run:true, the full message that " +
      "would be destroyed, so the right one can be verified before it is gone.",
    tier: "admin",
    dryRunnable: true,
    seeAlso: [
      "discord_bulk_delete_messages",
      "discord_edit_message",
      "discord_read_messages",
      "discord_search_messages",
    ],
    destructive: true,
    inputSchema: {
      channel_id: z.string(),
      message_id: z.string(),
      reason: z.string().optional().describe("Audit-log reason."),
    },
    handler: async (args, c) => {
      await c.requireChannel(args.channel_id);

      if (args.dry_run) {
        const msg = await c.client.message(args.channel_id, args.message_id);
        return [
          "DRY RUN — nothing was changed.",
          "",
          "would permanently delete:",
          "",
          formatMessage(msg),
          "",
          "Re-run with dry_run:false and confirm:true to carry this out.",
        ].join("\n");
      }

      await c.client.deleteMessage(args.channel_id, args.message_id, args.reason);
      return `Deleted message ${args.message_id} from channel ${args.channel_id}.`;
    },
  });

  registerTool(server, ctx, {
    name: "discord_bulk_delete_messages",
    title: "Bulk delete messages",
    summary:
      "Delete the 2 to 100 messages named in message_ids from channel_id in one call. Discord " +
      "refuses messages older than 14 days, and DISCORD_BULK_DELETE_MAX caps the batch further.",
    whenToCall:
      "clearing a spam or raid burst, where deleting one at a time would be slow and would leave " +
      "the channel visibly broken in between. For a single message use discord_delete_message.",
    returns:
      "a count of what was deleted. A partial batch is not reported per-message \u2014 Discord " +
      "either accepts the whole set or rejects it.",
    tier: "admin",
    seeAlso: ["discord_delete_message"],
    destructive: true,
    inputSchema: {
      channel_id: z.string(),
      message_ids: z.array(z.string()).min(2).max(100).describe("Message ids to delete."),
      reason: z.string().optional(),
    },
    handler: async (args, c) => {
      await c.requireChannel(args.channel_id);
      if (args.message_ids.length > c.config.bulkDeleteMax) {
        return (
          `Refused: ${args.message_ids.length} messages exceeds DISCORD_BULK_DELETE_MAX ` +
          `(${c.config.bulkDeleteMax}). Split the batch or raise the limit deliberately.`
        );
      }
      await c.client.bulkDelete(args.channel_id, args.message_ids, args.reason);
      return `Deleted ${args.message_ids.length} messages from channel ${args.channel_id}.`;
    },
  });
}
