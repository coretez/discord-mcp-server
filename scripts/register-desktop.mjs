#!/usr/bin/env node
/**
 * Register this server with the Claude Desktop app, beside fluency-mssp and
 * webmaster-agent.
 *
 *   DISCORD_BOT_TOKEN='...' npm run register
 *
 * The token is read from the environment, never from argv — arguments are
 * visible to anyone who can run `ps`. It is written into the desktop config,
 * which is then chmod 600; it never touches this repository.
 *
 * Idempotent: re-running updates the existing entry rather than duplicating it.
 * The previous config is backed up next to itself first.
 */

import { readFile, writeFile, copyFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(
  process.env.HOME ?? "",
  "Library/Application Support/Claude/claude_desktop_config.json",
);
const KEY = "fluency-discord";

// The stable Homebrew symlink, not the versioned Cellar path, which moves on
// every node upgrade. Claude Desktop does not inherit the shell PATH, so this
// has to be absolute either way.
const NODE = "/opt/homebrew/bin/node";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const token = process.env.DISCORD_BOT_TOKEN?.trim();
if (!token) {
  fail(
    "DISCORD_BOT_TOKEN is not set.\n\n" +
      "  1. https://discord.com/developers/applications → your app → Bot → Reset Token\n" +
      "  2. DISCORD_BOT_TOKEN='<token>' npm run register\n\n" +
      "Put it in the environment, not in argv — arguments are visible to `ps`.",
  );
}
if (token.length < 50) {
  fail(`DISCORD_BOT_TOKEN looks too short (${token.length} chars). Bot tokens are ~70+.`);
}
if (!existsSync(CONFIG)) fail(`Claude Desktop config not found at ${CONFIG}`);
if (!existsSync(NODE)) fail(`node not found at ${NODE}. Edit NODE in this script.`);

const entrypoint = join(ROOT, "dist", "index.js");
if (!existsSync(entrypoint)) fail(`${entrypoint} not built. Run: npm run build`);

const config = JSON.parse(await readFile(CONFIG, "utf8"));
config.mcpServers ??= {};
const existed = KEY in config.mcpServers;

config.mcpServers[KEY] = {
  command: NODE,
  args: [entrypoint],
  env: {
    DISCORD_BOT_TOKEN: token,
    DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID ?? "1542903941933826118",
    // Usable by default: a server that can only read is a worse Discord client
    // than Discord. Lower it with DISCORD_MODE=read|write if you want less.
    // DISCORD_ALLOW_DESTRUCTIVE stays off and is set separately, on purpose.
    DISCORD_MODE: process.env.DISCORD_MODE ?? "admin",
    DISCORD_ALLOW_DESTRUCTIVE: process.env.DISCORD_ALLOW_DESTRUCTIVE ?? "false",
  },
};

const backup = `${CONFIG}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
await copyFile(CONFIG, backup);

const serialized = `${JSON.stringify(config, null, 2)}\n`;
JSON.parse(serialized); // refuse to write anything that will not parse back
await writeFile(CONFIG, serialized, "utf8");
await chmod(CONFIG, 0o600);

const shown = { ...config.mcpServers[KEY], env: { ...config.mcpServers[KEY].env, DISCORD_BOT_TOKEN: "<redacted>" } };
console.log(`${existed ? "Updated" : "Added"} "${KEY}" in Claude Desktop config.`);
console.log(`  backup   ${backup}`);
console.log(`  mode     ${shown.env.DISCORD_MODE}`);
console.log(`  guild    ${shown.env.DISCORD_GUILD_ID}`);
console.log(`  servers  ${Object.keys(config.mcpServers).join(", ")}`);
console.log("\nRestart Claude Desktop — it reads this file only at launch.");
