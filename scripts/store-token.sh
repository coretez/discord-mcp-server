#!/usr/bin/env bash
# Prompt for the Discord bot token, check it actually looks like one, and store it
# in the login keychain. Input is hidden and never echoed.
set -euo pipefail

APP_ID="1546476154775535616"
SERVICE="fluency-discord-mcp"

printf 'Paste the bot token and press Return (nothing will appear as you paste):\n> ' >&2
read -rs token
printf '\n' >&2

# Strip anything whitespace-ish that rode along with the paste.
token="$(printf '%s' "$token" | tr -d '[:space:]')"

if [[ -z "$token" ]]; then
  echo "Nothing entered. Not stored." >&2
  exit 1
fi

# A bot token is three base64url segments separated by dots. Anything else is the
# wrong field off the portal — usually the Public Key or the Application ID.
if [[ "$(awk -F. '{print NF}' <<<"$token")" != "3" ]]; then
  echo "That is not a bot token: expected three dot-separated parts, got $(awk -F. '{print NF}' <<<"$token")." >&2
  echo "It is the value behind Reset Token on the Bot page — not the Public Key, not the Application ID." >&2
  exit 1
fi

# The first segment is the application id in base64url. If it does not match,
# the token belongs to a different app than the one invited to the guild.
first="${token%%.*}"
pad=$(( (4 - ${#first} % 4) % 4 ))
decoded="$(printf '%s%s' "$first" "$(printf '=%.0s' $(seq 0 $((pad-1)) 2>/dev/null))" | tr '_-' '/+' | base64 -d 2>/dev/null || true)"
if [[ "$decoded" != "$APP_ID" ]]; then
  echo "Warning: this token's app id (${decoded:-unreadable}) is not $APP_ID (fluency-mcp)." >&2
  printf 'Store it anyway? [y/N] ' >&2
  read -r yn </dev/tty
  [[ "$yn" == [yY]* ]] || { echo "Not stored." >&2; exit 1; }
fi

security add-generic-password -U -a "$USER" -s "$SERVICE" -w "$token"
echo "Stored. Now run: ./scripts/with-token.sh preflight.js" >&2
