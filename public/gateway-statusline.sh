#!/usr/bin/env bash
# Claude Code status line: shows Max 5-hour / 7-day usage from the gateway.
# Uses the same variables Claude Code uses; override below if they aren't
# visible to the status line process.
GATEWAY_URL="${GATEWAY_URL:-$ANTHROPIC_BASE_URL}"
GATEWAY_KEY="${GATEWAY_KEY:-$ANTHROPIC_AUTH_TOKEN}"

out=$(curl -sf -m 2 -H "x-api-key: ${GATEWAY_KEY}" "${GATEWAY_URL%/}/gateway/status?color=1") \
  || out="gateway unreachable"
printf '%s\n' "$out"
