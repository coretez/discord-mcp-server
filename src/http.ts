/**
 * Streamable HTTP transport, optionally behind Discord OAuth.
 *
 * The payoff for building server construction per-session is here: an
 * authenticated caller's guild roles pick their mode, and the server for that
 * session is built from a config carrying it. A read-tier caller's session has
 * 15 tools registered, not 37 sitting behind guards — the same property stdio
 * has always had, now varying per person instead of per process.
 *
 * TLS and the public hostname belong to nginx in front. This binds loopback.
 */

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Config, Mode } from "./config.js";
import { createMcpServer } from "./server.js";
import { DiscordOAuthProvider } from "./auth/provider.js";
import { SERVER_VERSION } from "./tools/meta.js";

const MAX_BODY_BYTES = "4mb";

interface Session {
  transport: StreamableHTTPServerTransport;
  who: string;
}

/** The tier the token carries, falling back to the process mode when unauthenticated. */
function sessionMode(config: Config, auth: AuthInfo | undefined): Mode {
  const tier = auth?.extra?.tier;
  if (tier === "read" || tier === "write" || tier === "admin") {
    return tier;
  }
  return config.mode;
}

function describeCaller(auth: AuthInfo | undefined): string {
  const name = auth?.extra?.discordUsername;
  return typeof name === "string" ? `@${name}` : "anonymous";
}

export async function startHttpServer(config: Config): Promise<void> {
  const sessions = new Map<string, Session>();
  const app = express();
  app.disable("x-powered-by");

  const provider = config.auth ? new DiscordOAuthProvider(config) : undefined;

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      version: SERVER_VERSION,
      mode: config.mode,
      auth: provider ? "discord-oauth" : "none",
      sessions: sessions.size,
      ...(provider ? { oauth: provider.stats() } : {}),
    });
  });

  if (provider && config.auth) {
    const issuer = new URL(config.auth.publicUrl);

    // /authorize, /token, /register, and the .well-known metadata clients use
    // to discover them. Body parsing is scoped to these routes: the MCP
    // endpoint below needs the raw stream for SSE.
    app.use(express.urlencoded({ extended: false }));
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: issuer,
        baseUrl: issuer,
        resourceServerUrl: new URL(`${config.auth.publicUrl}/mcp`),
        resourceName: "Fluency Discord MCP",
        scopesSupported: ["mcp"],
      }),
    );

    // Where Discord returns the human. Not part of the MCP OAuth surface —
    // it is the back half of our own login.
    app.get(provider.callbackPath, (req: Request, res: Response) => {
      const { code, state, error, error_description: desc } = req.query;
      if (typeof error === "string") {
        res.status(400).send(`Discord refused the login: ${desc ?? error}`);
        return;
      }
      if (typeof code !== "string" || typeof state !== "string") {
        res.status(400).send("Discord callback is missing code or state.");
        return;
      }
      provider
        .handleDiscordCallback(code, state)
        .then((redirectTo) => res.redirect(redirectTo))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`auth callback rejected: ${message}\n`);
          res.status(403).send(message);
        });
    });
  }

  const mcpRouter = express.Router();
  mcpRouter.use(express.json({ limit: MAX_BODY_BYTES }));

  if (provider) {
    mcpRouter.use(
      requireBearerAuth({
        verifier: provider,
        requiredScopes: ["mcp"],
        // RFC 9728 suffixes the resource path onto the metadata URL, so this is
        // .../oauth-protected-resource/mcp rather than the bare path. Derived
        // from the SDK so the 401's WWW-Authenticate header cannot drift out of
        // step with where the router actually mounts it.
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(
          new URL(`${config.auth!.publicUrl}/mcp`),
        ),
      }),
    );
  }

  mcpRouter.all("/", async (req: Request, res: Response) => {
    const auth = (req as Request & { auth?: AuthInfo }).auth;
    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    if (existing) {
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }
    if (typeof sessionId === "string") {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unknown or expired session. Re-initialize." },
        id: null,
      });
      return;
    }
    if (req.method !== "POST") {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Expected an initialize request to open a session." },
        id: null,
      });
      return;
    }

    const mode = sessionMode(config, auth);
    const who = describeCaller(auth);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: config.allowedHosts.length > 0,
      allowedHosts: config.allowedHosts,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, who });
        process.stderr.write(`session ${id} opened for ${who} at ${mode} (${sessions.size} live)\n`);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.delete(id)) {
        process.stderr.write(`session ${id} closed (${sessions.size} live)\n`);
      }
    };

    // The tier decides which tools exist for this session, not merely which
    // ones are permitted.
    const server = createMcpServer({ ...config, mode });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.use("/mcp", mcpRouter);

  const http = app.listen(config.httpPort, config.httpHost);
  await new Promise<void>((resolve) => http.once("listening", resolve));

  process.stderr.write(
    `fluency-discord-mcp ${SERVER_VERSION} listening on http://${config.httpHost}:${config.httpPort}/mcp` +
      ` · auth=${provider ? "discord-oauth" : "NONE (open)"}` +
      ` · fallback-mode=${config.mode} · guilds=${config.guildIds.join(",")}` +
      ` · hosts=${config.allowedHosts.length ? config.allowedHosts.join(",") : "(rebinding protection OFF)"}` +
      `${config.allowDestructive ? " · DESTRUCTIVE ENABLED" : ""}\n`,
  );

  const shutdown = (signal: string) => {
    process.stderr.write(`${signal} received, closing ${sessions.size} session(s)\n`);
    void Promise.allSettled([...sessions.values()].map((s) => s.transport.close())).then(() => {
      http.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
