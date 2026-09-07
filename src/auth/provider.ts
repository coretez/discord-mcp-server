/**
 * OAuth 2.1 authorization server, with Discord as the login step.
 *
 * Why we are the authorization server rather than pointing clients at Discord:
 * Discord has no Dynamic Client Registration, and MCP clients register
 * themselves. So this server issues its own tokens, and Discord's role is to
 * prove who the human is at /authorize time.
 *
 * Storage is in-memory. Restarting the service invalidates every token, which
 * is a real cost — everyone re-authenticates — and a real benefit: a role
 * change cannot outlive a restart. Persisting it is a deliberate later step,
 * not an oversight.
 */

import { randomUUID, randomBytes } from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Config, Mode } from "../config.js";
import { authorizeUrl, identify, type DiscordIdentity } from "./discord.js";

const TOKEN_TTL_SECONDS = 8 * 60 * 60;
/** A login must be completed promptly; an abandoned one should not linger. */
const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;

/** What we remember between /authorize and Discord's callback. */
interface Pending {
  clientId: string;
  redirectUri: string;
  clientState?: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  createdAt: number;
}

interface IssuedCode {
  clientId: string;
  codeChallenge: string;
  identity: DiscordIdentity;
  resource?: string;
  createdAt: number;
}

export interface SessionIdentity {
  userId: string;
  username: string;
  displayName: string;
  tier: Mode;
  isOwner: boolean;
}

class MemoryClientStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(full.client_id, full);
    return full;
  }
}

export class DiscordOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new MemoryClientStore();
  private pending = new Map<string, Pending>();
  private codes = new Map<string, IssuedCode>();
  private tokens = new Map<string, { info: AuthInfo; identity: SessionIdentity }>();

  constructor(private readonly config: Config) {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  private get auth() {
    if (!this.config.auth) throw new Error("OAuth is not configured.");
    return this.config.auth;
  }

  get callbackPath(): string {
    return "/auth/discord/callback";
  }

  private get redirectUri(): string {
    return `${this.auth.publicUrl}${this.callbackPath}`;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.createdAt > PENDING_TTL_MS) this.pending.delete(k);
    for (const [k, v] of this.codes) if (now - v.createdAt > CODE_TTL_MS) this.codes.delete(k);
    for (const [k, v] of this.tokens) {
      if (v.info.expiresAt && v.info.expiresAt * 1000 < now) this.tokens.delete(k);
    }
  }

  /** Step 1: park the client's request and send the human to Discord. */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const state = randomBytes(24).toString("base64url");
    this.pending.set(state, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      clientState: params.state,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      resource: params.resource?.toString(),
      createdAt: Date.now(),
    });
    res.redirect(authorizeUrl(this.auth, state, this.redirectUri));
  }

  /**
   * Step 2: Discord sends the human back. Identify them, resolve their tier
   * from guild roles, and hand the client an authorization code.
   * Returns the URL to redirect the browser to.
   */
  async handleDiscordCallback(code: string, state: string): Promise<string> {
    const pending = this.pending.get(state);
    if (!pending) {
      throw new Error("Unknown or expired login. Start again from your MCP client.");
    }
    this.pending.delete(state);

    const identity = await identify(this.config, code, this.redirectUri);

    const authCode = randomBytes(32).toString("base64url");
    this.codes.set(authCode, {
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      identity,
      resource: pending.resource,
      createdAt: Date.now(),
    });

    const back = new URL(pending.redirectUri);
    back.searchParams.set("code", authCode);
    if (pending.clientState) back.searchParams.set("state", pending.clientState);
    return back.toString();
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.codes.get(authorizationCode);
    if (!entry) throw new Error("Invalid or expired authorization code.");
    return entry.codeChallenge;
  }

  /** Step 3: the client trades the code for a token carrying the resolved tier. */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const entry = this.codes.get(authorizationCode);
    if (!entry) throw new Error("Invalid or expired authorization code.");
    if (entry.clientId !== client.client_id) {
      throw new Error("Authorization code was issued to a different client.");
    }
    this.codes.delete(authorizationCode); // single use

    const token = randomBytes(32).toString("base64url");
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    const id = entry.identity;

    this.tokens.set(token, {
      info: {
        token,
        clientId: client.client_id,
        scopes: ["mcp"],
        expiresAt,
        resource: entry.resource ? new URL(entry.resource) : undefined,
        // Carried through to the MCP layer, which builds the session's server
        // from this tier. See http.ts.
        extra: {
          discordUserId: id.userId,
          discordUsername: id.username,
          discordDisplayName: id.displayName,
          tier: id.tier,
          isOwner: id.isOwner,
        },
      },
      identity: {
        userId: id.userId,
        username: id.username,
        displayName: id.displayName,
        tier: id.tier,
        isOwner: id.isOwner,
      },
    });

    process.stderr.write(
      `auth: @${id.username} (${id.userId}) -> ${id.tier}` +
        `${id.isOwner ? " [owner]" : ""} roles=[${id.roleIds.join(",") || "none"}]\n`,
    );

    return { access_token: token, token_type: "Bearer", expires_in: TOKEN_TTL_SECONDS, scope: "mcp" };
  }

  /**
   * No refresh tokens. A token lasts 8 hours and then the human logs in again,
   * which is also when a role change takes effect. Silent indefinite renewal
   * would let a revoked role keep working.
   */
  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new Error("Refresh tokens are not issued; re-authorize instead.");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.tokens.get(token);
    if (!entry) throw new Error("Invalid or expired token.");
    if (entry.info.expiresAt && entry.info.expiresAt * 1000 < Date.now()) {
      this.tokens.delete(token);
      throw new Error("Token has expired; re-authorize.");
    }
    return entry.info;
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    this.tokens.delete(request.token);
  }

  identityFor(token: string): SessionIdentity | undefined {
    return this.tokens.get(token)?.identity;
  }

  stats(): { pending: number; codes: number; tokens: number } {
    return { pending: this.pending.size, codes: this.codes.size, tokens: this.tokens.size };
  }
}
