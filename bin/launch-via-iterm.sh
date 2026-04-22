#!/bin/bash
# Invoked by launchd for each scheduled run. Instead of invoking
# run-scheduled.sh directly (which makes claude its own TCC-responsible
# process and loses grants on every auto-update), this wrapper hands off
# to iTerm. iTerm is the stable TCC-responsible parent, so grants persist
# across claude updates.
#
# Args: $1 = skill name, $2 = max budget usd (default 5)
# Env:  SLACK_COMPLETION_WEBHOOK must be set (injected by the plist)
#
# Two deliberate trade-offs:
#  1. osascript returns as soon as the "write text" command is queued to
#     iTerm, so this wrapper exits 0 regardless of whether run-scheduled.sh
#     later succeeds or fails. launchd's exit-code-based alerting is thus
#     severed. Failure reporting to Slack is still intact because
#     run-scheduled.sh itself posts to SLACK_COMPLETION_WEBHOOK on every
#     outcome (success, failure, timeout).
#  2. iTerm 3.6.9 doesn't support "create hidden window" — the only
#     "hidden" AppleScript form available is create-then-set-invisible.
#     Verified on this Mac that `set visible to false` produces a window
#     that never renders on screen.

set -uo pipefail

SKILL="${1:?skill name required}"
BUDGET="${2:-5}"
SCRIPT="/Users/javiertamayo/.claude/slack/bin/run-scheduled.sh"
WEBHOOK="${SLACK_COMPLETION_WEBHOOK:-}"

if [[ -z "$WEBHOOK" ]]; then
  echo "SLACK_COMPLETION_WEBHOOK not set" >&2
  exit 2
fi

# Defensive validation — BUDGET must be a positive number, SKILL must
# match a conservative allowlist. Not a security boundary (write access
# to the plist already implies local user access), but a cheap guard
# against typos and injection via an unexpectedly-shaped plist.
if [[ ! "$BUDGET" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  echo "BUDGET must be a positive number, got: $BUDGET" >&2
  exit 2
fi
if [[ ! "$SKILL" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "SKILL must be alphanumeric/dash/underscore, got: $SKILL" >&2
  exit 2
fi

# Escape backslashes and double-quotes so the value can safely sit inside
# the AppleScript double-quoted "write text" argument.
esc_as() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

AS_SCRIPT=$(cat <<APPLESCRIPT
tell application "iTerm2"
  set newWindow to (create window with default profile)
  tell newWindow
    set visible to false
  end tell
  tell current session of newWindow
    write text "export SLACK_COMPLETION_WEBHOOK=\"$(esc_as "$WEBHOOK")\"; \"$(esc_as "$SCRIPT")\" \"$(esc_as "$SKILL")\" \"$(esc_as "$BUDGET")\"; exit"
  end tell
end tell
APPLESCRIPT
)

/usr/bin/osascript -e "$AS_SCRIPT"
