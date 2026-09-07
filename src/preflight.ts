#!/usr/bin/env node
/**
 * Preflight: verify the bot can actually do what the configured mode claims,
 * before an agent discovers it cannot mid-task.
 *
 * Run with `npm run preflight`. Read-only — it never writes to the guild.
 */

import { PermissionFlagsBits } from "discord-api-types/v10";
import { loadConfig } from "./config.js";
import { DiscordClient } from "./discord.js";
import { channelName, channelTypeName } from "./format.js";

/** Permissions each mode needs, checked against the bot's roles in the guild. */
const NEEDED: Record<string, [string, bigint][]> = {
  read: [
    ["View Channels", PermissionFlagsBits.ViewChannel],
    ["Read Message History", PermissionFlagsBits.ReadMessageHistory],
  ],
  write: [
    ["Send Messages", PermissionFlagsBits.SendMessages],
    ["Create Public Threads", PermissionFlagsBits.CreatePublicThreads],
    ["Add Reactions", PermissionFlagsBits.AddReactions],
    ["Manage Messages", PermissionFlagsBits.ManageMessages],
  ],
  admin: [
    ["Manage Channels", PermissionFlagsBits.ManageChannels],
    ["Manage Roles", PermissionFlagsBits.ManageRoles],
    ["Kick Members", PermissionFlagsBits.KickMembers],
    ["Ban Members", PermissionFlagsBits.BanMembers],
    ["Moderate Members (timeout)", PermissionFlagsBits.ModerateMembers],
  ],
};

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new DiscordClient(config);
  const out = (s: string) => process.stdout.write(`${s}\n`);

  const me = await client.currentUser();
  out(`bot            @${me.username} (${me.id})`);
  out(`mode           ${config.mode}`);
  out(`destructive    ${config.allowDestructive ? "ENABLED" : "disabled"}`);
  out("");

  let failures = 0;

  for (const guildId of config.guildIds) {
    out(`── guild ${guildId} ──`);
    try {
      const guild = await client.guild(guildId);
      out(`name           ${guild.name}`);

      const member = await client.guildMember(guildId, me.id);
      const roles = await client.guildRoles(guildId);
      const byId = new Map(roles.map((r) => [r.id, r]));
      const everyone = byId.get(guildId);

      // Guild-level permissions are the union of @everyone and the bot's roles.
      let perms = BigInt(everyone?.permissions ?? "0");
      let highest = everyone?.position ?? 0;
      for (const rid of member.roles) {
        const role = byId.get(rid);
        if (!role) continue;
        perms |= BigInt(role.permissions);
        highest = Math.max(highest, role.position);
      }

      const isAdmin = (perms & PermissionFlagsBits.Administrator) !== 0n;
      out(`bot roles      ${member.roles.map((r) => byId.get(r)?.name ?? r).join(", ") || "(none)"}`);
      out(`highest pos    ${highest}${isAdmin ? " · has Administrator" : ""}`);

      const tiers = config.mode === "admin" ? ["read", "write", "admin"]
        : config.mode === "write" ? ["read", "write"]
        : ["read"];

      for (const tier of tiers) {
        for (const [label, bit] of NEEDED[tier]!) {
          const ok = isAdmin || (perms & bit) !== 0n;
          if (!ok) failures++;
          out(`  ${ok ? "OK  " : "MISS"} ${tier.padEnd(5)} ${label}`);
        }
      }

      const channels = await client.guildChannels(guildId);
      out(`channels       ${channels.length}`);
      for (const ch of channels.slice(0, 25)) {
        out(`  ${channelName(ch).padEnd(24)} ${channelTypeName(ch.type).padEnd(14)} ${ch.id}`);
      }
      if (channels.length > 25) out(`  … ${channels.length - 25} more`);

      // Privileged intent check: member listing fails without SERVER MEMBERS.
      try {
        await client.guildMembers(guildId, 1);
        out("  OK   intent SERVER MEMBERS (member listing works)");
      } catch {
        failures++;
        out(
          "  MISS intent SERVER MEMBERS — enable it under Bot → Privileged Gateway Intents, " +
            "or discord_list_members will fail",
        );
      }
    } catch (err) {
      failures++;
      out(`  ERROR ${err instanceof Error ? err.message : String(err)}`);
      out("  Is the bot actually invited to this guild?");
    }
    out("");
  }

  if (failures > 0) {
    out(`${failures} check(s) failed — the bot cannot do everything mode "${config.mode}" advertises.`);
    process.exit(1);
  }
  out("All checks passed.");
}

main().catch((err: unknown) => {
  process.stderr.write(`preflight failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
