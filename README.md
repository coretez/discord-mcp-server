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

**5. Register with Claude Desktop.** This server is a local stdio process, registered beside
`fluency-mssp` and `webmaster-agent` in `claude_desktop_config.json`. It is not a claude.ai
connector, so it will not appear in claude.ai sessions — those only load hosted HTTPS servers.

```bash
DISCORD_BOT_TOKEN='<your bot token>' npm run register
```

The token is read from the environment rather than argv, because arguments are visible to anyone
who can run `ps`. The script backs up the existing config, merges the entry idempotently, and
chmods the result to 600. It registers at `DISCORD_MODE=read` with destructive actions off; raise
those in the config once you have watched it run. Claude Desktop reads the file only at launch, so
restart it afterwards.

Override the defaults through the environment of that same command — `DISCORD_MODE=write`,
`DISCORD_GUILD_ID=…` — or edit the entry it writes.

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