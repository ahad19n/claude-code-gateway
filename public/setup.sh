#!/usr/bin/env bash
# Claude Code setup for the Claude Code gateway (Mac/Linux): settings + status line
# Usage: curl -fsSL https://claude.semafore.co/setup.sh | bash
#    or: bash setup.sh
# Safe to re-run (e.g. after `gw rotate`).
set -euo pipefail

# ---- Settings ----
GATEWAY_URL="https://claude.semafore.co"
# ------------------

SETTINGS_DIR="$HOME/.claude"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"
STATUS_SCRIPT="$SETTINGS_DIR/gateway-statusline.sh"
export PATH="$HOME/.local/bin:$PATH"   # where the Claude Code installer puts `claude`

WARNINGS=0
warn() { echo "  ! $1"; WARNINGS=$((WARNINGS + 1)); }

echo "== Claude Code gateway setup =="

# 1. Install Claude Code if it isn't already
if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code not found, installing..."
  curl -fsSL https://claude.ai/install.sh | bash
  hash -r
fi

# 2. Ask for the key (reads from the terminal, so it also works with curl | bash)
printf "Paste this workstation's gateway key (input hidden): "
read -rs KEY < /dev/tty
echo
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
if [ -z "$KEY" ]; then
  echo "No key entered, aborting."
  exit 1
fi

# 3. Check the key before saving it (/gateway/status isn't forwarded or recorded)
echo "Checking key..."
RESP=$(curl -s -m 15 -w '\n%{http_code}' -H "x-api-key: $KEY" \
  "$GATEWAY_URL/gateway/status?format=json" || true)
CODE="${RESP##*$'\n'}"
BODY="${RESP%$'\n'*}"
case "$CODE" in
  200)
    WS=$(printf '%s' "$BODY" | sed -n 's/.*"workstation":"\([^"]*\)".*/\1/p')
    echo "Key OK (workstation: ${WS:-?})."
    case "$BODY" in
      *'"enabled":false'*) warn "This workstation is disabled on the gateway; requests will be refused until it's enabled." ;;
    esac
    ;;
  000|"") echo "Can't reach $GATEWAY_URL. Check your network and try again."; exit 1 ;;
  *) echo "Key rejected (HTTP $CODE). Check you pasted it correctly."; exit 1 ;;
esac

# 4. Status line script (shows Max 5h / 7d usage, since /usage doesn't work here)
mkdir -p "$SETTINGS_DIR"
STATUS_CMD=""
if curl -fsSL -m 15 "$GATEWAY_URL/gateway-statusline.sh" -o "$STATUS_SCRIPT"; then
  chmod 755 "$STATUS_SCRIPT"
  STATUS_CMD="bash ~/.claude/gateway-statusline.sh"
else
  warn "Couldn't download the status line script; skipping it."
fi

# 5. Save settings, keeping anything already in the file
if [ -f "$SETTINGS_FILE" ]; then
  cp "$SETTINGS_FILE" "$SETTINGS_FILE.bak.$(date +%s)"
fi

if command -v python3 >/dev/null 2>&1 && python3 -c '' >/dev/null 2>&1; then
  python3 - "$SETTINGS_FILE" "$GATEWAY_URL" "$KEY" "$STATUS_CMD" <<'PY'
import json, sys
path, url, key, status_cmd = sys.argv[1:]
try:
    with open(path) as f:
        data = json.load(f)
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}
env = data.get("env")
if not isinstance(env, dict):
    env = data["env"] = {}
env["ANTHROPIC_BASE_URL"] = url
env["ANTHROPIC_AUTH_TOKEN"] = key
env["ENABLE_CLAUDEAI_MCP_SERVERS"] = "false"   # claude.ai connectors can't work through the gateway
# The first two would be used instead of the gateway key; a pinned model
# (e.g. from an older setup) would override Claude Code's default and /model
for name in ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_MODEL"):
    env.pop(name, None)
if status_cmd:
    data["statusLine"] = {"type": "command", "command": status_cmd}
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
else
  if [ -f "$SETTINGS_FILE" ]; then
    warn "python3 not found, so $SETTINGS_FILE was replaced (the old one is saved next to it as .bak)."
  fi
  {
    echo '{'
    echo '  "env": {'
    echo "    \"ANTHROPIC_BASE_URL\": \"$GATEWAY_URL\","
    echo "    \"ANTHROPIC_AUTH_TOKEN\": \"$KEY\","
    echo '    "ENABLE_CLAUDEAI_MCP_SERVERS": "false"'
    if [ -n "$STATUS_CMD" ]; then
      echo '  },'
      echo "  \"statusLine\": { \"type\": \"command\", \"command\": \"$STATUS_CMD\" }"
    else
      echo '  }'
    fi
    echo '}'
  } > "$SETTINGS_FILE"
fi
chmod 600 "$SETTINGS_FILE"
echo "Settings saved to $SETTINGS_FILE."

# 6. Environment variables that would override the gateway key
for name in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN; do
  if [ -n "${!name:-}" ]; then
    warn "$name is set in your shell. Remove it (check ~/.bashrc, ~/.zshrc, ~/.profile), or Claude Code won't use the gateway."
  fi
done

if ! command -v claude >/dev/null 2>&1; then
  warn "Can't find the 'claude' command yet; open a new terminal before running it."
fi

echo
if [ "$WARNINGS" -eq 0 ]; then
  echo "All set! Open a new terminal and run: claude"
else
  echo "Done with $WARNINGS warning(s) above. Open a new terminal and run: claude"
fi
echo "If this machine was logged in to a Claude account, type /logout inside Claude Code once."
echo "Don't run 'claude login' here; the gateway provides the subscription."
