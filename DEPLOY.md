# Deploying fluency-discord-mcp

The generic story is in [README.md](README.md#deployment-model). This is the runbook for the
instance actually running: **`discord.fluencyalliance.com`**, hosted on the DigitalOcean droplet
`rockylinux-replay-ingress` (`134.209.74.14`, Rocky Linux 9, nyc1).

That droplet was chosen over the larger `do-mssp-*` boxes for blast radius rather than capacity.
It runs one other service — the `deal-reg` partner portal — where the alternatives run
customer-facing MSSP tenants. If this server misbehaves, `deal-reg` is the cheaper neighbour to
disturb.

## Layout

| | |
|---|---|
| Code | `/opt/fluency-discord-mcp`, cloned from origin, built on the box |
| Service | `fluency-discord-mcp.service` |
| Runs as | `fluencymcp` — a system user, **not** root |
| Listens | `127.0.0.1:8500` |
| Public | nginx → `/etc/nginx/conf.d/discord-mcp.conf` |
| TLS | Let's Encrypt, `certbot-renew.timer` |
| Config | `/etc/fluency-discord-mcp/env` |
| Secrets | `/etc/fluency-discord-mcp/{token,oauth}` — `640 root:fluencymcp` |

Secrets live in their own files rather than the unit, because `systemctl cat` renders a unit file
to anyone who can read it. The unit references them with `EnvironmentFile=`.

The service is hardened with `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
`NoNewPrivileges`, `RestrictAddressFamilies=AF_INET AF_INET6` and `MemoryMax=512M`. It can write
to its own directory and reach the network; nothing else.

## Redeploying

```bash
ssh root@134.209.74.14
cd /opt/fluency-discord-mcp
sudo -u fluencymcp git pull
sudo -u fluencymcp npm ci && sudo -u fluencymcp npm run build
systemctl restart fluency-discord-mcp
curl -s https://discord.fluencyalliance.com/healthz
```

`healthz` reports version, whether auth is on, live sessions and OAuth store sizes. **A restart
logs every user out** — tokens are in memory — so time it accordingly.

## Rotating secrets

Both helpers read on **stdin, never argv**, because arguments are visible to anyone who can run
`ps`. Neither should ever be pasted into a chat window or a shell history.

```bash
# Bot token, straight from the operator's keychain
security find-generic-password -s fluency-discord-mcp -w \
  | ssh root@134.209.74.14 set-discord-token

# OAuth client secret, from the Discord application's OAuth2 page
pbpaste | ssh root@134.209.74.14 set-discord-oauth
```

Each validates, writes `640 root:fluencymcp`, restarts the service and reports whether it came
back.

## Granting someone more than read

Access is managed in Discord, not here. Create a role, then map it:

```bash
# on the droplet, in /etc/fluency-discord-mcp/env
DISCORD_ROLE_TIERS=<roleId>:write
```

Then `systemctl restart fluency-discord-mcp`. Removing the role from a member revokes their access
when their token next expires (8 hours) or at the next restart, whichever comes first.

With no roles defined the defaults still work: the guild owner gets `admin`, every other member
`read`.

A tier is a ceiling on the tool surface, not a grant of Discord permission. Every call still
executes as the one bot token, so promoting someone to `admin` while the bot's own role lacks
**Manage Channels** or **Manage Roles** hands them tools that return `403 / 50013` rather than
anything useful. Before mapping the first `admin` role, confirm the bot can do the job:

```bash
DISCORD_MODE=admin npm run preflight
```

It exits non-zero when the mode promises more than the bot's guild permissions can deliver.

## Known gaps

- **Token persistence.** In-memory, so every restart forces re-authentication.
- **Attribution.** Writes appear as the bot with no record of who asked. Must land before anyone
  is granted `write`.
- **Rate limiting.** All callers share the bot token's Discord rate-limit buckets; there is no
  process-wide limiter yet.

## Host notes

- The droplet had no cloud firewall and `rpcbind` listening on `0.0.0.0:111` at the time of
  deployment; both are outstanding.
- `deal-reg` on the same box runs as root. This service deliberately does not.
- Patched to Rocky 9.8 on 2026-09-07 from a year-old 9.5. Snapshot `rocky-prepatch-20260907-0845`
  was taken beforehand.
