#!/usr/bin/env node
/**
 * Runtime evidence capture.
 *
 * Static inspection of tools/list cannot prove that a tool reports failure the
 * way the specification requires. This drives every registered tool down a
 * failure path and records the CallToolResult, producing a surface bundle that
 * mcp_analysis can validate as evidence rather than infer from descriptions.
 *
 * SAFETY: the child process environment is constructed from scratch, never
 * inherited. The token is deliberately invalid, DISCORD_ALLOW_DESTRUCTIVE is
 * off, and the skills and issue-log paths point at directories that do not
 * exist. No call in this harness can reach Discord or mutate a real guild, even
 * if a real token is exported in the calling shell.
 *
 *   node scripts/capture-evidence.mjs [surface.json] [out.json]
 */

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");
const surfacePath = resolve(process.argv[2] ?? join(ROOT, "analysis", "surface-after.json"));
const outPath = resolve(process.argv[3] ?? join(ROOT, "analysis", "evidence.json"));

/** A sealed environment. Nothing from the caller's shell reaches the child. */
const SEALED_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  DISCORD_BOT_TOKEN: "harness.invalid.token",
  DISCORD_GUILD_ID: "1542903941933826118",
  DISCORD_MODE: "admin",
  DISCORD_ALLOW_DESTRUCTIVE: "false",
  DISCORD_SKILLS_DIR: "/nonexistent-harness-skills",
  DISCORD_ISSUE_LOG: "/nonexistent-harness-dir/issues.jsonl",
};

/** Arguments chosen to fail: ids that cannot exist, and a skill that is absent. */
function failingArgs(tool) {
  const schema = tool.inputSchema ?? {};
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const args = {};

  for (const [key, prop] of Object.entries(props)) {
    if (!required.has(key)) continue;
    if (key === "confirm") { args[key] = true; continue; }
    if (key === "skill_id") { args[key] = "no-such-skill"; continue; }
    if (prop.enum) { args[key] = prop.enum[0]; continue; }
    switch (prop.type) {
      case "string": args[key] = key.endsWith("_id") ? "1" : "harness"; break;
      case "number":
      case "integer": args[key] = prop.minimum ?? 1; break;
      case "boolean": args[key] = true; break;
      case "array": args[key] = ["1", "2"]; break;
      default: args[key] = "harness";
    }
  }
  return args;
}

function startServer() {
  const child = spawn("node", [SERVER], { env: SEALED_ENV, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolveFn = pending.get(msg.id);
      if (resolveFn) { resolveFn(msg); pending.delete(msg.id); }
    }
  });
  child.stderr.on("data", () => {});

  let id = 0;
  const request = (method, params) =>
    new Promise((res, rej) => {
      const myId = ++id;
      pending.set(myId, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: myId, method, params })}\n`);
      setTimeout(() => { pending.delete(myId); rej(new Error(`timeout: ${method}`)); }, 20_000);
    });
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);

  return { child, request, notify };
}

const { child, request, notify } = startServer();

await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "evidence-harness", version: "1.0.0" },
});
notify("notifications/initialized");

const listed = await request("tools/list");
const tools = listed.result?.tools ?? [];

const toolResults = [];
let errors = 0;
let successes = 0;
const noFailurePath = [];

for (const tool of tools) {
  const response = await request("tools/call", {
    name: tool.name,
    arguments: failingArgs(tool),
  });
  if (!response.result) {
    // A protocol-level rejection is not a CallToolResult and is not evidence.
    noFailurePath.push(`${tool.name} (protocol error: ${response.error?.message?.slice(0, 60)})`);
    continue;
  }
  const isError = response.result.isError === true;
  if (isError) errors++; else { successes++; noFailurePath.push(tool.name); }
  toolResults.push({
    tool: tool.name,
    case: isError ? "execution_error" : "success",
    result: response.result,
  });
}

child.kill();

const surface = JSON.parse(await readFile(surfacePath, "utf8"));
await writeFile(outPath, `${JSON.stringify({ ...surface, toolResults }, null, 2)}\n`, "utf8");

console.log(`captured ${toolResults.length} tool results from ${tools.length} tools`);
console.log(`  error paths proven : ${errors}`);
console.log(`  no failure path    : ${successes}${successes ? ` (${noFailurePath.join(", ")})` : ""}`);
console.log(`written to ${outPath}`);
process.exit(0);
