/** Shared history paging, used by search and by member audits. */

import { ChannelType } from "discord-api-types/v10";
import type { APIMessage } from "discord-api-types/v10";
import type { DiscordClient } from "./discord.js";
import { channelName } from "./format.js";

export async function collectHistory(
  client: DiscordClient,
  channelId: string,
  maxMessages: number,
): Promise<APIMessage[]> {
  const collected: APIMessage[] = [];
  let before: string | undefined;
  while (collected.length < maxMessages) {
    const page = await client.messages(channelId, {
      limit: Math.min(100, maxMessages - collected.length),
      before,
    });
    if (page.length === 0) break;
    collected.push(...page);
    before = page[page.length - 1]!.id;
    if (page.length < 100) break;
  }
  return collected;
}

export async function readableTextChannels(
  client: DiscordClient,
  guildId: string,
): Promise<{ id: string; name: string }[]> {
  const channels = await client.guildChannels(guildId);
  return channels
    .filter((ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
    .map((ch) => ({ id: ch.id, name: channelName(ch) }));
}
