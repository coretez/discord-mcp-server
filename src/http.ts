/**
 * Streamable HTTP transport.
 *
 * One process, many clients. Each client gets its own session id, its own
 * transport, and — importantly — its own McpServer, built fresh from the config
 * at initialize time. Today every session is built from the same process-wide
 * config; once Discord OAuth lands, the caller's guild roles pick the mode and
 * that per-session construction is what keeps a read-tier user's tool list
 * genuinely short instead of merely guarded.
 *
 * TLS and the public hostname belong to nginx in front. This binds loopback.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { createMcpServer } from "./server.js";
import { SERVER_VERSION } from "./tools/meta.js";

/** Bodies are JSON-RPC, not uploads. Anything larger is not a real client. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

interface Session {
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** JSON-RPC shaped error, so a client surfaces it rather than showing a bare 4xx. */
function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

export async function startHttpServer(config: Config): Promise<void> {
  const sessions = new Map<string, Session>();

  const http = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`http handler error: ${message}\n`);
      if (!res.headersSent) rpcError(res, 400, -32700, message);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Liveness for systemd and nginx. Deliberately says nothing about the guild
    // or the bot: it is reachable without an MCP session.
    if (url.pathname === "/healthz") {
      return sendJson(res, 200, {
        ok: true,
        version: SERVER_VERSION,
        mode: config.mode,
        sessions: sessions.size,
      });
    }

    if (url.pathname !== "/mcp") {
      return rpcError(res, 404, -32601, "No such endpoint. MCP is served at /mcp.");
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    if (existing) {
      return existing.transport.handleRequest(req, res, await readBody(req));
    }

    if (typeof sessionId === "string") {
      return rpcError(res, 404, -32001, "Unknown or expired session. Re-initialize.");
    }

    // No session id: only an initialize request may open one. POST carries it;
    // a bare GET or DELETE here is a client that lost its session.
    if (req.method !== "POST") {
      return rpcError(res, 400, -32000, "Expected an initialize request to open a session.");
    }

    const body = await readBody(req);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: config.allowedHosts.length > 0,
      allowedHosts: config.allowedHosts,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, close: () => transport.close() });
        process.stderr.write(`session opened ${id} (${sessions.size} live)\n`);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        process.stderr.write(`session closed ${id} (${sessions.size} live)\n`);
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.delete(id)) {
        process.stderr.write(`transport closed ${id} (${sessions.size} live)\n`);
      }
    };

    const server = createMcpServer(config);
    await server.connect(transport);
    return transport.handleRequest(req, res, body);
  }

  await new Promise<void>((resolve) => {
    http.listen(config.httpPort, config.httpHost, resolve);
  });

  process.stderr.write(
    `fluency-discord-mcp ${SERVER_VERSION} listening on http://${config.httpHost}:${config.httpPort}/mcp` +
      ` · mode=${config.mode} · guilds=${config.guildIds.join(",")}` +
      ` · hosts=${config.allowedHosts.length ? config.allowedHosts.join(",") : "(rebinding protection OFF)"}` +
      `${config.allowDestructive ? " · DESTRUCTIVE ENABLED" : ""}\n`,
  );

  // systemd sends SIGTERM on restart. Close sessions before the socket so
  // clients see a clean shutdown rather than a dropped connection.
  const shutdown = (signal: string) => {
    process.stderr.write(`${signal} received, closing ${sessions.size} session(s)\n`);
    void Promise.allSettled([...sessions.values()].map((s) => s.close())).then(() => {
      http.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
