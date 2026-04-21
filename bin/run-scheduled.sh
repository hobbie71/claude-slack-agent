#!/bin/bash
# Wrapper that launchd invokes for each scheduled run.
# Args: $1 = skill name, $2 = max budget usd (optional, default 5)
# Env:  SLACK_COMPLETION_WEBHOOK is required (injected by the plist)

set -u

SKILL="${1:?skill name required}"
BUDGET="${2:-5}"

if [[ -z "${SLACK_COMPLETION_WEBHOOK:-}" ]]; then
  echo "SLACK_COMPLETION_WEBHOOK not set" >&2
  exit 2
fi

CLAUDE_BIN="$(command -v claude || true)"
if [[ -z "$CLAUDE_BIN" ]]; then
  for p in /opt/homebrew/bin/claude /usr/local/bin/claude; do
    [[ -x "$p" ]] && CLAUDE_BIN="$p" && break
  done
fi
if [[ -z "$CLAUDE_BIN" ]]; then
  curl -s -X POST "$SLACK_COMPLETION_WEBHOOK" \
    -H 'content-type: application/json' \
    --data "{\"text\":\"❌ *$SKILL* failed: \`claude\` binary not found on PATH\"}" >/dev/null || true
  exit 127
fi

STARTED=$(date +%s)
TMP_OUT=$(mktemp)
TMP_ERR=$(mktemp)

export CLAUDE_SLACK=0

"$CLAUDE_BIN" --bare -p "/$SKILL" \
  --permission-mode bypassPermissions \
  --output-format json \
  --max-budget-usd "$BUDGET" \
  --no-session-persistence \
  >"$TMP_OUT" 2>"$TMP_ERR"
EXIT=$?
ELAPSED=$(( $(date +%s) - STARTED ))

if [[ $EXIT -eq 0 ]]; then
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

# Build the JSON payload safely with jq so quotes/newlines survive.
PAYLOAD=$(jq -n --arg text "$HEADER"$'\n```\n'"$SUMMARY"$'\n```' '{text:$text}')

curl -s -X POST "$SLACK_COMPLETION_WEBHOOK" \
  -H 'content-type: application/json' \
  --data "$PAYLOAD" >/dev/null || true

rm -f "$TMP_OUT" "$TMP_ERR"
exit $EXIT
