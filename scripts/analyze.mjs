#!/usr/bin/env node
/**
 * One command for the whole mcp_analysis loop: capture the live surface, drive
 * every tool's failure path, then validate the evidence bundle.
 *
 * The validator lives outside this repo, so its location is configurable:
 *   MCP_ANALYSIS_DIR=/path/to/mcp_analysis npm run analyze
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ANALYSIS = join(ROOT, "analysis");
const VALIDATOR_DIR =
  process.env.MCP_ANALYSIS_DIR ?? join(ROOT, "..", "..", "..", "Projects", "mcp_analysis");
const VALIDATOR = join(VALIDATOR_DIR, "mcp_validate.py");
// This server's own profile: the headless conventions plus the namespace
// declaration and the two exemptions this design deliberately takes.
const LOCAL_PROFILE = join(ANALYSIS, "fluency-discord.json");
const PROFILE = existsSync(LOCAL_PROFILE)
  ? LOCAL_PROFILE
  : join(VALIDATOR_DIR, "profiles", "headless.json");

if (!existsSync(VALIDATOR)) {
  console.error(
    `mcp_validate.py not found at ${VALIDATOR}.\n` +
      "Set MCP_ANALYSIS_DIR to the mcp_analysis checkout.",
  );
  process.exit(2);
}

/**
 * Surface capture needs a bootable server, so it needs env vars. They are fake
 * on purpose: tools/list and resources/list never reach Discord.
 */
const CAPTURE_ENV = {
  ...process.env,
  DISCORD_BOT_TOKEN: "analysis.invalid.token",
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID ?? "1542903941933826118",
  DISCORD_MODE: "admin",
  DISCORD_ALLOW_DESTRUCTIVE: "true",
};

function run(label, cmd, args, opts = {}) {
  process.stderr.write(`\n── ${label} ──\n`);
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("capture surface", "python3", [
  VALIDATOR,
  "--stdio", `node ${join(ROOT, "dist", "index.js")}`,
  "--profile", PROFILE,
  "--save-surface", join(ANALYSIS, "surface-after.json"),
  "--json", join(ANALYSIS, "assessment-static.json"),
], { env: CAPTURE_ENV, cwd: VALIDATOR_DIR });

run("capture runtime evidence", "node", [join(ROOT, "scripts", "capture-evidence.mjs")]);

run("validate with evidence", "python3", [
  VALIDATOR,
  "--dump", join(ANALYSIS, "evidence.json"),
  "--profile", PROFILE,
  "--json", join(ANALYSIS, "assessment-final.json"),
], { cwd: VALIDATOR_DIR });
