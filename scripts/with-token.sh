#!/usr/bin/env bash
# Launch the MCP server with the bot token pulled from the macOS keychain, so the
# secret never lands in a config file, a repo, or a process argument list.
#
# Store it once:
#   security add-generic-password -a "$USER" -s fluency-discord-mcp -w
# (that prompts for the token; -w with no value reads it without echoing)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
  DISCORD_BOT_TOKEN="$(security find-generic-password -s fluency-discord-mcp -w 2>/dev/null || true)"
fi

if [[ -z "${DISCORD_BOT_TOKEN}" ]]; then
  echo "No bot token. Store one with:" >&2
  echo "  security add-generic-password -a \"\$USER\" -s fluency-discord-mcp -w" >&2
  exit 1
fi

export DISCORD_BOT_TOKEN
export DISCORD_GUILD_ID="${DISCORD_GUILD_ID:-1542903941933826118}"
export DISCORD_MODE="${DISCORD_MODE:-admin}"
export DISCORD_ALLOW_DESTRUCTIVE="${DISCORD_ALLOW_DESTRUCTIVE:-false}"

exec node "$here/dist/${1:-index.js}"
