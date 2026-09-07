#!/usr/bin/env node
/**
 * fluency-discord-mcp — MCP server over the Discord REST API.
 *
 * Two transports. stdio is the original: the client spawns this process, so the
 * operator is whoever owns the machine and the mode is fixed at boot. http is
 * for the hosted deployment, where many clients reach one process.
 *
 * Nothing is logged to stdout, which belongs to the protocol under stdio.
 * Diagnostics go to stderr in both modes.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import { startHttpServer } from "./http.js";
import { SERVER_VERSION } from "./tools/meta.js";

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.transport === "http") {
    return startHttpServer(config);
  }

  const server = createMcpServer(config);
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `fluency-discord-mcp ${SERVER_VERSION} ready · mode=${config.mode} · guilds=${config.guildIds.join(",")}` +
      `${config.allowDestructive ? " · DESTRUCTIVE ENABLED" : ""}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
