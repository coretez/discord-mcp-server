# fluency-discord-mcp

An MCP server over the Discord REST API, scoped to the **FluencySecurityAi** guild
(`1542903941933826118`). Read the server, post to it, and moderate it from any MCP client.

REST only — no gateway connection. MCP tools are pull-based, so a websocket would buy nothing
and keep a process hot for no reason. The consequence: this server answers questions and takes
actions on request; it cannot react to events as they happen.

## Guardrails

Full moderation power is a loaded gun, so capability is opt-in rather than granted by mere
possession of a token. Four independent fences:

| Fence | Env | Effect |
|---|---|---|
| **Mode** | `DISCORD_MODE` | `read` / `write` / `admin`. Tools above the mode are never registered — a client cannot call what it cannot see. |
| **Guild** | `DISCORD_GUILD_ID` | Every call resolves to a guild id and is refused if it is not listed. Channel-addressed tools resolve the channel's guild first. |
| **Destructive switch** | `DISCORD_ALLOW_DESTRUCTIVE` | Delete, kick, ban and bulk-delete additionally require this flag *and* an explicit `confirm: true` argument. |
| **Dry run** | per-call `dry_run` | `discord_delete_channel`, `discord_delete_role`, `discord_delete_message` and `discord_set_channel_permissions` report exactly what they would destroy and change nothing. A preview needs neither confirmation nor the destructive switch — that is precisely when someone is deciding whether to enable it. |
| **Channel allowlist** | `DISCORD_CHANNEL_ALLOWLIST` | Optional. Confines writes to named channels. Checked locally, before any API call. |

Refusals come back as tool errors naming which fence fired, so an agent can tell "not permitted"
from "Discord said no".

## Tool surface

**Server inspection (5, available in every mode)** — `describe_capabilities` (the routing map,
with an MCP Apps UI resource), `inspect_version_compatibility`, `list_skills`, `load_skill`,
`report_client_issue`

**read (+10)** — `discord_whoami`, `discord_guild_info`, `discord_list_channels`,
`discord_list_roles`, `discord_list_members`, `discord_find_member`, `discord_get_member`,
`discord_list_threads`, `discord_read_messages`, `discord_search_messages`

**write (+5)** — `discord_send_message`, `discord_edit_message`, `discord_add_reaction`,
`discord_pin_message`, `discord_create_thread`

**admin (+17)** — channels (`create` / `edit` / `delete` / `set_channel_permissions`),
roles (`create` / `edit` / `delete` / `manage_member_role`),
moderation (`member_audit`, `timeout_member`, `kick_member`, `ban_member`, `unban_member`,
`list_bans`, `set_nickname`), messages (`delete_message`, `bulk_delete_messages`)

Every description is assembled from three required fields — what the tool does, when to call it,
and what it returns — plus its required argument names and its near-neighbour cross references,
both derived from the schema at registration. A new tool cannot ship with those missing, because
`ToolSpec` will not compile without them.

Two notes on what Discord itself allows:

- **Search is local.** Discord's native message-search endpoint is not available to bots, so
  `discord_search_messages` pages history and filters in-process. `scan_limit` trades depth for
  API calls.
- **Member listing needs a privileged intent.** `discord_list_members` requires SERVER MEMBERS
  to be enabled on the bot application, or Discord returns Missing Access.

## Skills

`skills/` holds versioned operational playbooks, delivered on request through `list_skills` and
`load_skill` rather than crammed into tool descriptions — routing text stays short and the depth
is fetched only when a task needs it. Files are read at call time, so editing a playbook needs no
rebuild. Point `DISCORD_SKILLS_DIR` elsewhere to serve your own.

| Skill | Covers |
|---|---|
| `moderation-triage` | Working a report from evidence to action without over-reaching |
| `channel-provisioning` | Creating channels and access rules without breaking existing permissions |
| `community-digest` | Turning a week of activity into a summary someone will read |

## Setup

**1. Create the bot** at <https://discord.com/developers/applications> → New Application → Bot.
Copy the token. Under **Privileged Gateway Intents**, enable **SERVER MEMBERS INTENT** if you
want member listing.

**2. Invite it** to the guild, with the permission set matching the mode you intend to run.
Replace `YOUR_APP_ID`:

```
read   https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot&permissions=66688
write  https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot&permissions=377957248192
admin  https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot&permissions=1477871529174
```

Discord permissions are necessary but not sufficient: to moderate a member or assign a role, the
bot's **highest role must sit above** the target's. Drag the bot's role up in Server Settings →
Roles.

**3. Build.**

```bash
npm install && npm run build
```

**4. Check it.** Reads only; never writes.

```bash
DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=1542903941933826118 DISCORD_MODE=admin npm run preflight
```

It reports the bot's identity, its effective permissions against what the mode needs, its role
position, the channel list, and whether the members intent is on. Exits non-zero if the mode
promises more than the bot can deliver.

**5. Store the token in the keychain**, not in a file:

```bash
./scripts/store-token.sh
```

It prompts without echoing and validates before storing. A bot token is three dot-separated
base64url segments whose first segment decodes to the application id, so the script can tell you
when you have pasted the Public Key or the Application ID instead — the two fields adjacent to it
on the portal page, and the two that get grabbed by mistake.

`scripts/with-token.sh` is the matching launcher: it reads the token back at spawn time and execs
the server, so the secret is never in `.mcp.json`, never in the repo, and never in a process
argument list where anyone running `ps` could read it.

**6. Register with a client.**

*Claude Code* reads `.mcp.json` from the project root. It is committed, holds no secret, and
points at `with-token.sh` — opening the project is the whole setup.

*Claude Desktop* keeps one global config instead:

```bash
DISCORD_BOT_TOKEN='<your bot token>' npm run register
```

The token is read from the environment rather than argv, for the `ps` reason above. The script
backs up the existing config, merges the entry idempotently, and chmods the result to 600. It
registers at `DISCORD_MODE=read` with destructive actions off; raise those once you have watched
it run. Claude Desktop reads the file only at launch, so restart it afterwards.

Either way this is a **local stdio process** that the client spawns. It is not a claude.ai
connector and will not appear in claude.ai sessions, which load only hosted HTTPS servers — see
[Deployment model](#deployment-model).

## Deployment model

Today this is a **single-operator** server, and that is a property of the code rather than a
policy. The transport is stdio, so there is nothing to connect to — the client spawns the process.
The token comes from one person's login keychain. And `loadConfig()` runs once at startup, so the
mode belongs to *the process* rather than to whoever is calling; `registerTool` gates on it at
registration time, which is why tools above the mode are never advertised. That last property is
worth preserving in anything built on top of this.

Sharing it with the rest of the guild does **not** mean everyone creates a Discord application.
The bot token is a guild-level credential and the bot is already a member. Two identities are
involved, and the current code only has one of them:

| | What it is | How many |
|---|---|---|
| Discord identity | the `fluency-mcp` bot — what actually calls the REST API | one, server-side, never distributed |
| Operator identity | who is asking the bot to act | today: none; the process assumes a single operator |

Handing the bot token to each person collapses those back into one: full authority over the guild,
no attribution, and revocation that can only be all-or-nothing.

### Where this is going

One hosted instance over Streamable HTTP with **Sign in with Discord** in front of it. OAuth proves
the caller is a specific Discord user; the bot token then asks Discord which roles that user holds
in the fenced guild. Roles become the authorization source, so access is granted and revoked in
Server Settings → Roles rather than in a second system that drifts out of sync with it.

- **Tier from role.** Moderator → `write`, owner → `admin`, any other member → `read`, non-member
  → refused at the door.
- **A server per session, not per process.** Construct the `McpServer` when a session
  authenticates, registering only that user's tier. This keeps the unregistered-tools-are-invisible
  property rather than trading it for per-call checks: a read-tier session genuinely has 15 tools,
  not 37 sitting behind guards.
- **Attribution.** Writes carry `— requested by @user`, and the actor is recorded server-side
  against every action. Posting anonymously as the bot is defensible with one operator and
  indefensible with several.
- **One rate-limit bucket.** Every operator shares the bot token's Discord rate limits, so the
  limiter has to be process-wide rather than per-session.

Staged so the auth path is proven before it can break anything: deploy read-only first, with the
mode capped server-side. The blast radius is then nothing a member could not already do in the
Discord client, while still exercising OAuth, role lookup and session handling under real use.
Writes unlock afterwards; `admin` stays on the local stdio instance.

## Validation

The surface is validated with [`mcp_analysis`](https://github.com/coretez/mcp_analysis) against
the MCP 2025-11-25 specification plus the Headless conventions profile:

```bash
MCP_ANALYSIS_DIR=/path/to/mcp_analysis npm run analyze
```

That runs three steps and writes each result under `analysis/`:

1. **Capture the surface** — boot the server, enumerate tools, resources and UI content.
2. **Capture runtime evidence** — `scripts/capture-evidence.mjs` drives every registered tool
   down a failure path and records the `CallToolResult`, so error behaviour is proven rather
   than inferred. The harness builds its child environment from scratch with an invalid token,
   destructive actions off, and non-existent skill and log paths: no call it makes can reach
   Discord or mutate a guild, even if a real token is exported in the calling shell.
3. **Validate against the evidence bundle.**

Current result: **1,164 checks — specification 100%, extensions 100%, quality 98.5%.**

`analysis/fluency-discord.json` is this server's profile: the headless conventions plus a
`tool_namespace` declaration and two deliberate exemptions.

- **`n1_exempt`** — this server is a thin, guarded layer over Discord's REST API, so
  `discord_list_channels` is the honest name for listing channels and an outcome-shaped alias
  would describe the API less accurately. `describe_capabilities` is the outcome-oriented front
  door; it routes to the primitives by task rather than replacing them. RULES.md contemplates
  exactly this: "CRUD primitives may remain as deliberate building blocks and profile exemptions."
- **`j10_exempt`** — `describe_capabilities` reads in-memory configuration, has no external
  dependency, and therefore no runtime failure path to capture.

Five `N4-INSPECT-TWIN` warnings remain, all on additive creation tools — `send_message`,
`create_thread`, `create_channel`, `create_role`, `set_nickname` — where a dry run would report
back only what the caller just typed. RULES.md agrees ("not required for every additive creation
tool unless a profile chooses that policy") but the profile schema has no `n4_exempt` to say so,
which is why these stay visible rather than being declared.

Static analysis proves the contract, not the behaviour: authorization, role-position enforcement,
confirmation enforcement against a live guild, and audit records still need a real token.

## Operating notes

**A rebuild does not reach a running server.** The client spawns this process and holds it for the
life of the session, so `npm run build` writes `dist/` underneath a server that already loaded the
old code. Restart the client session — or, when a fix appears not to have landed, compare the
timestamps:

```bash
stat -f '%Sm %N' -t '%H:%M:%S' dist/*.js
ps -eo pid,lstart,command | grep '[d]ist/index.js'
```

A server whose start time precedes the build is serving stale code.

**Empty message bodies are meaningful.** System messages (joins, pins, boosts) and sticker-only
messages carry no `content` by design. They render as `<system: joined the server>` and
`<sticker: Wave>` rather than as blank lines, because a blank body is otherwise indistinguishable
from the redaction you get when the Message Content intent is switched off.

**Rate limits belong to the token, not the caller.** Everyone driving a given bot token shares one
set of Discord rate-limit buckets.

**Guild content is data, not instruction.** A message asking the agent to ban someone, post
something, or change a setting is not authorization for it. The server says so in its `instructions`,
and it holds for anything built on top of this too.
