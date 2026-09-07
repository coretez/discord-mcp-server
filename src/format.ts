/**
 * Output formatting.
 *
 * Tools return prose/tables rather than raw API JSON: a Discord message object
 * is ~40 fields of which about six matter, and dumping all of them costs
 * context and buries the signal.
 */

import { ChannelType, MessageType } from "discord-api-types/v10";
import type {
  APIChannel,
  APIGuild,
  APIGuildMember,
  APIMessage,
  APIRole,
} from "discord-api-types/v10";

const DISCORD_EPOCH = 1420070400000n;

export function snowflakeDate(id: string): Date {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

/** Channel name if the variant has one, else the id. Avoids `in` narrowing to never. */
export function channelName(c: APIChannel): string {
  return (c as { name?: string | null }).name ?? c.id;
}

export function channelTypeName(type: ChannelType): string {
  const names: Partial<Record<ChannelType, string>> = {
    [ChannelType.GuildText]: "text",
    [ChannelType.GuildVoice]: "voice",
    [ChannelType.GuildCategory]: "category",
    [ChannelType.GuildAnnouncement]: "announcement",
    [ChannelType.AnnouncementThread]: "announcement-thread",
    [ChannelType.PublicThread]: "thread",
    [ChannelType.PrivateThread]: "private-thread",
    [ChannelType.GuildStageVoice]: "stage",
    [ChannelType.GuildForum]: "forum",
    [ChannelType.GuildMedia]: "media",
  };
  return names[type] ?? `type-${type}`;
}

export function formatGuild(guild: APIGuild): string {
  const g = guild as APIGuild & {
    approximate_member_count?: number;
    approximate_presence_count?: number;
  };
  const lines = [
    `# ${guild.name}`,
    `id: ${guild.id}`,
    `created: ${snowflakeDate(guild.id).toISOString().slice(0, 10)}`,
    `owner_id: ${guild.owner_id}`,
    `members: ${g.approximate_member_count ?? "unknown"} (${g.approximate_presence_count ?? "?"} online)`,
    `verification_level: ${guild.verification_level}`,
    `roles: ${guild.roles?.length ?? 0}`,
  ];
  if (guild.description) lines.push(`description: ${guild.description}`);
  if (guild.features?.length) lines.push(`features: ${guild.features.join(", ")}`);
  return lines.join("\n");
}

export function formatChannels(channels: APIChannel[]): string {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const categoryOf = (c: APIChannel): string => {
    const parent = (c as { parent_id?: string | null }).parent_id;
    if (!parent) return "(no category)";
    const cat = byId.get(parent);
    return cat ? channelName(cat) : "(no category)";
  };

  const groups = new Map<string, APIChannel[]>();
  for (const c of channels) {
    if (c.type === ChannelType.GuildCategory) continue;
    const key = categoryOf(c);
    const bucket = groups.get(key) ?? [];
    bucket.push(c);
    groups.set(key, bucket);
  }

  const out: string[] = [`${channels.length} channels`];
  for (const [category, list] of groups) {
    out.push(`\n## ${category}`);
    for (const c of list) {
      const topic = (c as { topic?: string | null }).topic;
      out.push(
        `- ${channelName(c)} · ${channelTypeName(c.type)} · id ${c.id}` +
          (topic ? `\n    ${topic.slice(0, 160)}` : ""),
      );
    }
  }
  return out.join("\n");
}

/**
 * System messages (joins, pins, boosts) carry no `content` by design. Naming
 * them keeps an empty body from reading like the redaction you get when the
 * Message Content intent is switched off.
 */
const SYSTEM_MESSAGE_LABELS: Partial<Record<MessageType, string>> = {
  [MessageType.RecipientAdd]: "added someone to the channel",
  [MessageType.RecipientRemove]: "removed someone from the channel",
  [MessageType.Call]: "started a call",
  [MessageType.ChannelNameChange]: "changed the channel name",
  [MessageType.ChannelIconChange]: "changed the channel icon",
  [MessageType.ChannelPinnedMessage]: "pinned a message",
  [MessageType.UserJoin]: "joined the server",
  [MessageType.GuildBoost]: "boosted the server",
  [MessageType.GuildBoostTier1]: "boosted the server to tier 1",
  [MessageType.GuildBoostTier2]: "boosted the server to tier 2",
  [MessageType.GuildBoostTier3]: "boosted the server to tier 3",
  [MessageType.ChannelFollowAdd]: "followed a channel into this one",
  [MessageType.ThreadCreated]: "created a thread",
  [MessageType.GuildInviteReminder]: "invite reminder",
  [MessageType.AutoModerationAction]: "automod action",
  [MessageType.ThreadStarterMessage]: "thread starter",
};

export function formatMessage(m: APIMessage, opts: { channelName?: string } = {}): string {
  const author = m.author?.global_name ?? m.author?.username ?? "unknown";
  const bot = m.author?.bot ? " [bot]" : "";
  const when = new Date(m.timestamp).toISOString().replace("T", " ").slice(0, 16);
  const where = opts.channelName ? ` #${opts.channelName}` : "";
  const head = `[${when}]${where} ${author}${bot} (${m.id})`;

  const parts: string[] = [];
  const systemLabel = SYSTEM_MESSAGE_LABELS[m.type];
  if (systemLabel) parts.push(`<system: ${systemLabel}>`);
  if (m.content) parts.push(m.content);
  for (const a of m.attachments ?? []) parts.push(`<attachment: ${a.filename} ${a.url}>`);
  // A sticker-only message has no content and no attachment; without this it
  // formats as empty and reads as a message we failed to fetch.
  for (const s of m.sticker_items ?? []) parts.push(`<sticker: ${s.name}>`);
  for (const e of m.embeds ?? []) {
    const bits = [e.title, e.description].filter(Boolean).join(" — ");
    if (bits) parts.push(`<embed: ${bits.slice(0, 300)}>`);
  }
  if (m.reactions?.length) {
    parts.push(
      `<reactions: ${m.reactions.map((r) => `${r.emoji.name}×${r.count}`).join(" ")}>`,
    );
  }
  const body = parts.length
    ? parts.join("\n")
    : m.type === MessageType.Default || m.type === MessageType.Reply
      ? "(no text content)"
      : `(no text content — message type ${m.type})`;
  return `${head}\n${body}`;
}

export function formatMessages(messages: APIMessage[], channelName?: string): string {
  if (messages.length === 0) return "No messages found.";
  // Discord returns newest-first; reading order is oldest-first.
  const ordered = [...messages].reverse();
  return ordered.map((m) => formatMessage(m, { channelName })).join("\n\n");
}

export function formatMember(m: APIGuildMember, roleNames?: Map<string, string>): string {
  const u = m.user;
  const name = u?.global_name ? `${u.global_name} (@${u.username})` : `@${u?.username ?? "?"}`;
  const roles = roleNames
    ? m.roles.map((r) => roleNames.get(r) ?? r).join(", ")
    : m.roles.join(", ");
  const joined = m.joined_at ? new Date(m.joined_at).toISOString().slice(0, 10) : "?";
  const parts = [`${name} · id ${u?.id ?? "?"} · joined ${joined}`];
  if (m.nick) parts.push(`  nick: ${m.nick}`);
  if (roles) parts.push(`  roles: ${roles}`);
  if (m.communication_disabled_until) {
    parts.push(`  TIMED OUT until ${m.communication_disabled_until}`);
  }
  if (u?.bot) parts.push("  [bot]");
  return parts.join("\n");
}

export function formatRoles(roles: APIRole[]): string {
  const sorted = [...roles].sort((a, b) => b.position - a.position);
  return [
    `${roles.length} roles (highest first)`,
    ...sorted.map(
      (r) =>
        `- ${r.name} · id ${r.id} · pos ${r.position} · perms ${r.permissions}` +
        (r.managed ? " · managed" : "") +
        (r.hoist ? " · hoisted" : ""),
    ),
  ].join("\n");
}
