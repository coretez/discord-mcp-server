---
skill_id: channel-provisioning
skill_version: 1.1.0
title: Channel provisioning
description: Creating channels and their access rules without breaking the permissions people already have.
---

# Channel provisioning

## Decide the shape before creating anything

- **Thread** (`discord_create_thread`) — a conversation with a natural end. Costs nothing, archives
  itself, does not clutter the sidebar. This is usually the right answer.
- **Channel** (`discord_create_channel`) — a topic that will still matter next month.
- **Category** — only once you have four or five related channels. A category holding two channels
  is organizational overhead with no payoff.

## Creating a channel

1. `discord_list_channels` for the category ids and to see the existing naming convention. Match
   it; a server where one channel is `dev-help` and the next is `Development Help` reads as neglect.
2. `discord_create_channel` with `parent_id` set. Nesting later means a second call and a moment
   where the channel is visible in the wrong place.
3. Set a `topic`. It is the only thing a newcomer reads before posting in the wrong place.

Two things Discord does silently:

- **Text channel names are lowercased.** `mcpBot` becomes `mcpbot`. Camel case does not survive,
  so pick a name that reads correctly in lower case — `mcp-bot` over `mcpBot` — rather than
  discovering the rename after you have announced it.
- **A channel created without `parent_id` is uncategorized**, and lands at the bottom of the
  sidebar under no heading, below the voice channels. It is not where anyone expects to find it.

## Manage Channels is required

`discord_create_channel`, `discord_edit_channel` and `discord_delete_channel` all need the
**Manage Channels** permission on the bot's role. Without it Discord returns `403 / 50013 Missing
Permissions` — and note that this tool being *visible* to you says nothing about whether it will
work: the mode decides which tools get registered, the guild decides which ones succeed. If a
creation call fails this way, the fix is in Server Settings → Roles, not in the arguments; do not
retry the call unchanged.

## Permissions

Access is decided by overwrites on the channel, not by guild-wide role permissions. Keep roles at
permissions `"0"` and grant access per-channel: a broad bitfield on a role applies everywhere at
once, including channels created after you set it.

`discord_set_channel_permissions` **replaces** the whole overwrite for one target. It does not
merge. Read the channel's current overwrites first, or you will silently drop access the target
already had.

Common bitfields, as decimal strings:

| Permission | Value |
|---|---|
| VIEW_CHANNEL | `1024` |
| SEND_MESSAGES | `2048` |
| READ_MESSAGE_HISTORY | `65536` |
| MANAGE_MESSAGES | `8192` |

A private channel is `@everyone` denied `1024`, plus the intended role allowed `1024`. The
`@everyone` role id equals the guild id.

## Before deleting

`discord_delete_channel` takes the message history with it and there is no trash. If the goal is
only to hide a channel, deny `VIEW_CHANNEL` to `@everyone` instead — that is reversible and this
is not.
