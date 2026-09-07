/**
 * Discord as the identity provider.
 *
 * Two calls after login decide everything: who the caller is, and what roles
 * they hold in the fenced guild. Membership is the authorization — someone who
 * has left the guild fails the second call and gets nothing, with no separate
 * user list to keep in sync.
 */

import type { AuthConfig, Config, Mode } from "../config.js";

const DISCORD_API = "https://discord.com/api/v10";

export interface DiscordIdentity {
  userId: string;
  username: string;
  displayName: string;
  guildId: string;
  roleIds: string[];
  isOwner: boolean;
  tier: Mode;
}

export function authorizeUrl(auth: AuthConfig, state: string, redirectUri: string): string {
  const u = new URL("https://discord.com/oauth2/authorize");
  u.searchParams.set("client_id", auth.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  // identify: who they are. guilds.members.read: their roles in our guild.
  // Nothing else — this login cannot read their messages or join servers.
  u.searchParams.set("scope", "identify guilds.members.read");
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "none");
  return u.toString();
}

async function discordJson<T>(url: string, init: RequestInit, what: string): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord ${what} failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Exchange the login code for a short-lived user token. Not stored. */
async function exchangeCode(
  auth: AuthConfig,
  code: string,
  redirectUri: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const tok = await discordJson<{ access_token: string }>(
    `${DISCORD_API}/oauth2/token`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
    "token exchange",
  );
  return tok.access_token;
}

/**
 * Roles decide the tier, highest wins. The guild owner is handled separately
 * because ownership is not expressible as a role — Discord grants it implicitly.
 */
export function resolveTier(
  auth: AuthConfig,
  roleIds: string[],
  isOwner: boolean,
): Mode {
  if (isOwner) return auth.ownerTier;
  const rank: Record<Mode, number> = { read: 0, write: 1, admin: 2 };
  let best: Mode = auth.memberTier;
  for (const id of roleIds) {
    const tier = auth.roleTiers.get(id);
    if (tier && rank[tier] > rank[best]) best = tier;
  }
  return best;
}

/**
 * Turn a login code into an identity and a tier, or throw. Throwing is the
 * refusal for a non-member: /users/@me/guilds/{id}/member 404s for anyone who
 * is not in the guild, so we never have to ask "should this person be allowed".
 */
export async function identify(config: Config, code: string, redirectUri: string): Promise<DiscordIdentity> {
  const auth = config.auth;
  if (!auth) throw new Error("OAuth is not configured on this server.");

  const accessToken = await exchangeCode(auth, code, redirectUri);
  const bearer = { authorization: `Bearer ${accessToken}` };
  const guildId = config.defaultGuildId;

  const me = await discordJson<{ id: string; username: string; global_name?: string | null }>(
    `${DISCORD_API}/users/@me`,
    { headers: bearer },
    "identify",
  );

  let member: { roles?: string[] };
  try {
    member = await discordJson<{ roles?: string[] }>(
      `${DISCORD_API}/users/@me/guilds/${guildId}/member`,
      { headers: bearer },
      "guild member lookup",
    );
  } catch (err) {
    throw new Error(
      `@${me.username} is not a member of the guild this server serves, so there is no access ` +
        `to grant. (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // Ownership comes from the guild, read with the bot token: a user token
  // cannot be asked "are you the owner" without the guilds scope.
  const guild = await discordJson<{ owner_id: string }>(
    `${DISCORD_API}/guilds/${guildId}`,
    { headers: { authorization: `Bot ${config.token}` } },
    "guild lookup",
  );

  const roleIds = member.roles ?? [];
  const isOwner = guild.owner_id === me.id;

  return {
    userId: me.id,
    username: me.username,
    displayName: me.global_name || me.username,
    guildId,
    roleIds,
    isOwner,
    tier: resolveTier(auth, roleIds, isOwner),
  };
}
