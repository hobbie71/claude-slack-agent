#!/bin/bash
# Invoked by launchd for each scheduled run. Instead of invoking
# run-scheduled.sh directly (which makes claude its own TCC-responsible
# process and loses grants on every auto-update), this wrapper hands off
# to iTerm. iTerm is the stable TCC-responsible parent, so grants persist
# across claude updates.
#
# Args: $1 = skill name, $2 = max budget usd (default 5)
# Env:  SLACK_COMPLETION_WEBHOOK must be set (injected by the plist)

set -uo pipefail

SKILL="${1:?skill name required}"
BUDGET="${2:-5}"
SCRIPT="/Users/javiertamayo/.claude/slack/bin/run-scheduled.sh"
WEBHOOK="${SLACK_COMPLETION_WEBHOOK:-}"

if [[ -z "$WEBHOOK" ]]; then
  echo "SLACK_COMPLETION_WEBHOOK not set" >&2
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
