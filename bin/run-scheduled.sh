#!/bin/bash
# Wrapper that launchd invokes for each scheduled run.
# Args: $1 = skill name, $2 = max budget usd (optional, default 5)
# Env:  SLACK_COMPLETION_WEBHOOK is required (injected by the plist)

set -uo pipefail

SKILL="${1:?skill name required}"
BUDGET="${2:-5}"
TIMEOUT_SECS=1800  # 30 min — scheduled runs that take longer are almost certainly stuck

post_to_slack() {
  local text="$1"
  if [[ -z "${SLACK_COMPLETION_WEBHOOK:-}" ]]; then return 0; fi
  local payload
  payload=$(jq -n --arg text "$text" '{text:$text}' 2>/dev/null) || payload="{\"text\":\"$text\"}"
  curl -s -X POST "$SLACK_COMPLETION_WEBHOOK" \
    -H 'content-type: application/json' \
    --data "$payload" >/dev/null 2>&1 || true
}

if [[ -z "${SLACK_COMPLETION_WEBHOOK:-}" ]]; then
  echo "SLACK_COMPLETION_WEBHOOK not set" >&2
  exit 2
fi

CLAUDE_BIN="$(command -v claude || true)"
if [[ -z "$CLAUDE_BIN" ]]; then
  for p in "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
    [[ -x "$p" ]] && CLAUDE_BIN="$p" && break
  done
fi
if [[ -z "$CLAUDE_BIN" ]]; then
  post_to_slack "❌ *$SKILL* failed: \`claude\` binary not found on PATH"
  exit 127
fi

STARTED=$(date +%s)
TMP_OUT=$(mktemp) || { post_to_slack "❌ *$SKILL* failed: mktemp failed"; exit 1; }
TMP_ERR=$(mktemp) || { rm -f "$TMP_OUT"; post_to_slack "❌ *$SKILL* failed: mktemp failed"; exit 1; }
TIMEOUT_SENTINEL=$(mktemp) || { rm -f "$TMP_OUT" "$TMP_ERR"; post_to_slack "❌ *$SKILL* failed: mktemp failed"; exit 1; }
# The sentinel exists but is empty — watchdog writes to it on kill.
: > "$TIMEOUT_SENTINEL"

export CLAUDE_SLACK=0

# Run claude in the background with a hard timeout. macOS has no built-in
# `timeout` command, so we implement it with a watchdog subshell.
"$CLAUDE_BIN" -p "Use the Skill tool to invoke the $SKILL skill." \
  --permission-mode bypassPermissions \
  --output-format json \
  --max-budget-usd "$BUDGET" \
  --no-session-persistence \
  >"$TMP_OUT" 2>"$TMP_ERR" &
CLAUDE_PID=$!

# Watchdog: sleep then SIGTERM + SIGKILL if still running. Writes to the
# sentinel file BEFORE killing so we can distinguish watchdog-triggered
# termination from other causes (e.g. external SIGTERM).
(
  sleep "$TIMEOUT_SECS"
  if kill -0 "$CLAUDE_PID" 2>/dev/null; then
    echo "timeout" > "$TIMEOUT_SENTINEL"
    echo "timeout ${TIMEOUT_SECS}s exceeded, killing pid $CLAUDE_PID" >&2
    kill -TERM "$CLAUDE_PID" 2>/dev/null
    sleep 5
    kill -KILL "$CLAUDE_PID" 2>/dev/null
  fi
) &
WATCHDOG_PID=$!

wait "$CLAUDE_PID"
EXIT=$?

# Stop watchdog if claude finished first.
kill "$WATCHDOG_PID" 2>/dev/null
wait "$WATCHDOG_PID" 2>/dev/null

ELAPSED=$(( $(date +%s) - STARTED ))

# Reliable timeout detection: watchdog wrote to the sentinel before killing.
TIMED_OUT=0
if [[ -s "$TIMEOUT_SENTINEL" ]]; then
  TIMED_OUT=1
fi

if [[ $TIMED_OUT -eq 1 ]]; then
  EMOJI="⏱"
  HEADER="$EMOJI *$SKILL* timed out after ${ELAPSED}s (cap ${TIMEOUT_SECS}s)"
  SUMMARY="$(head -c 2500 "$TMP_ERR")"
elif [[ $EXIT -eq 0 ]]; then
  EMOJI="✅"
  SUMMARY=$(jq -r '.result // .text // empty' "$TMP_OUT" 2>/dev/null | head -c 2500)
  if [[ -z "$SUMMARY" ]]; then
    SUMMARY=$(head -c 2500 "$TMP_OUT")
  fi
  COST=$(jq -r '(.cost_usd // .total_cost_usd // 0) | tostring' "$TMP_OUT" 2>/dev/null || echo "?")
  HEADER="$EMOJI *$SKILL* finished in ${ELAPSED}s (\$${COST})"
else
  EMOJI="❌"
  SUMMARY=$(head -c 2500 "$TMP_ERR")
  [[ -z "$SUMMARY" ]] && SUMMARY=$(head -c 2500 "$TMP_OUT")
  HEADER="$EMOJI *$SKILL* failed (exit $EXIT, ${ELAPSED}s)"
fi

# Convert Markdown → Slack mrkdwn:
#   "### Header" / "## Header" / "# Header"  →  "*Header*"
#   "**bold**"                                →  "*bold*"
#   "[text](url)"                             →  "<url|text>"
SUMMARY=$(printf '%s' "$SUMMARY" | sed -E \
  -e 's/^#{1,6}[[:space:]]+(.*)$/*\1*/' \
  -e 's/\*\*([^*]+)\*\*/*\1*/g' \
  -e 's/\[([^][]+)\]\(([^)]+)\)/<\2|\1>/g')

# Build the JSON payload safely with jq so quotes/newlines survive.
PAYLOAD=$(jq -n --arg text "$HEADER"$'\n\n'"$SUMMARY" '{text:$text}')

curl -s -X POST "$SLACK_COMPLETION_WEBHOOK" \
  -H 'content-type: application/json' \
  --data "$PAYLOAD" >/dev/null || true

rm -f "$TMP_OUT" "$TMP_ERR" "$TIMEOUT_SENTINEL"
exit $EXIT
