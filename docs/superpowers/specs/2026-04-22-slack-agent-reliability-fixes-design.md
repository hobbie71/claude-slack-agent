# Slack Agent Reliability Fixes — Design

Date: 2026-04-22
Author: Javier Tamayo (w/ Claude)
Status: Draft, awaiting review

## Problem

After 24 hours of daily use, the Slack agent has three live reliability bugs:

1. **Missed schedules during sleep.** The Mac enters system sleep overnight, schedules fire late (or not at all until wake). No current mechanism keeps the Mac awake.
2. **Flaky schedule listing.** "What do I have scheduled" returns the correct list ~1/3 of the time. The other ~2/3, Claude says "nothing scheduled" even though plists exist in `~/.claude/slack/schedules/`.
3. **Permissions reset on every Claude Code auto-update.** Each version of Claude Code installs at `~/.local/share/claude/versions/X.Y.Z`. macOS TCC identifies binaries by path for ad-hoc-signed user-scope binaries, so each update is a brand-new TCC subject with zero grants. Scheduled runs (under launchd) are then silently denied Documents/Desktop/etc. access.

## Root causes (verified)

1. **No caffeinate:** `grep -r caffeinate /Users/javiertamayo/.claude/slack/` returns nothing. Feature never existed.
2. **Soft instruction:** `SLACK_INSTRUCTIONS.md` tells the model to read the schedules directory by convention, but the model skips the read ~2/3 of the time. No deterministic API.
3. **TCC + launchd:** Confirmed empirically on 2026-04-22 (see `~/.claude/projects/-Users-javiertamayo--claude-slack/memory/project_tcc_finding.md`). When claude runs under iTerm, TCC's `responsible` process is iTerm; grants against iTerm's stable binary path apply. When claude runs under launchd, the responsible process is the command's own binary (bash, or claude itself) — whose path changes per Claude update, wiping grants.

## Design

Three independent changes, each landable on its own.

### Fix 1 — Caffeinate (stay awake 24/7)

Add a launchd agent that runs `/usr/bin/caffeinate -i` and restarts itself if it dies. Ships in the repo as `com.claude.caffeinate.plist`, installed to `~/Library/LaunchAgents/`.

```xml
<key>ProgramArguments</key>
<array>
  <string>/usr/bin/caffeinate</string>
  <string>-i</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
```

`-i` prevents system idle sleep but allows display sleep (the display still goes dark after the user's configured interval). No battery-drain concern — the user runs this Mac plugged in.

**Files changed:**
- New: `~/.claude/slack/com.claude.caffeinate.plist` (committed to repo)
- Updated: `SETUP.md` — add install step (`launchctl bootstrap gui/$UID ...`)

### Fix 2 — Deterministic `GET /schedules` endpoint

Add an endpoint on the existing bolt-app (port 7823) that returns the list of installed plists, parsed into a simple structure. Replace the model's soft instruction with a call to this endpoint.

**Endpoint contract:**
```
GET http://127.0.0.1:7823/schedules
→ 200 OK, application/json
[
  {
    "label": "com.claude.sched.linkedin-job-apply",
    "skill": "linkedin-job-apply",
    "budget_usd": 25,
    "schedule_human": "Weekdays at 8:00 AM",
    "schedule_raw": [{"Hour": 8, "Minute": 0, "Weekday": 1}, ...],
    "next_run": "2026-04-23T08:00:00-04:00",
    "last_run_log": "/Users/.../logs/...log"
  },
  ...
]
```

Implementation in `bolt-app/lib/schedules.ts`:
- Read all `*.plist` files from `~/.claude/slack/schedules/` (skip `example.plist`)
- Parse with a lightweight plist parser (`@expo/plist` or similar; avoid adding heavy deps)
- Derive `schedule_human` from `StartCalendarInterval` entries (weekday/hour/minute → natural language)
- `next_run`: compute from `StartCalendarInterval` + system time

**Update `SLACK_INSTRUCTIONS.md`:** replace the "list plist files + parsed schedules" soft instruction with "call `GET http://127.0.0.1:7823/schedules` and render the response."

**Files changed:**
- New: `bolt-app/lib/schedules.ts`
- Updated: `bolt-app/index.ts` — register the route
- Updated: `SLACK_INSTRUCTIONS.md`

### Fix 3 — Route scheduled runs through iTerm

Change every `com.claude.sched.*.plist` to invoke `osascript` → iTerm instead of running the wrapper script directly. iTerm claims TCC responsibility for its children; its grants are stable across Claude Code auto-updates.

**New wrapper: `bin/launch-via-iterm.sh`**

```bash
#!/bin/bash
# Args: skill name, budget (USD)
# Tells iTerm to create a new hidden window that runs run-scheduled.sh.
set -uo pipefail
SKILL="${1:?skill required}"
BUDGET="${2:-5}"
SCRIPT="/Users/javiertamayo/.claude/slack/bin/run-scheduled.sh"
WEBHOOK="${SLACK_COMPLETION_WEBHOOK:-}"

# Escape single quotes for embedding in AppleScript
esc() { printf '%s' "$1" | sed "s/'/'\\\\''/g"; }

osascript <<EOF
tell application "iTerm"
  set newWindow to (create hidden window with default profile)
  tell current session of newWindow
    write text "export SLACK_COMPLETION_WEBHOOK='$(esc "$WEBHOOK")'; '$(esc "$SCRIPT")' '$(esc "$SKILL")' '$(esc "$BUDGET")'; exit"
  end tell
end tell
EOF
```

**Why a hidden window:** iTerm's AppleScript supports `create hidden window` (verified in iTerm2 3.6.x). The window does not take focus, does not appear in the window stack, and closes when the command exits (profile setting: "When command exits: Close window" — either default or forced via a dedicated "Scheduled Agent" profile).

**Plist change template** (for every `com.claude.sched.*.plist`):
```xml
<key>ProgramArguments</key>
<array>
  <string>/bin/bash</string>
  <string>/Users/javiertamayo/.claude/slack/bin/launch-via-iterm.sh</string>
  <string>linkedin-job-apply</string>
  <string>25</string>
</array>
```
(The `SLACK_COMPLETION_WEBHOOK` env var stays in the plist; the wrapper passes it through.)

**`run-scheduled.sh` stays almost identical.** It still runs claude, captures stdout/stderr, times out via watchdog, posts to Slack webhook. The only change: it now runs *inside* an iTerm session, so claude inherits iTerm's TCC.

**iTerm profile setup (one-time manual step, documented in SETUP.md):**
- Create a profile named "Scheduled Agent"
- Set "When command exits" → "Close window"
- Optionally set it to open minimized / not take focus

If `with default profile` causes windows to stick around, we switch to `with profile "Scheduled Agent"` in the AppleScript.

**Files changed:**
- New: `bin/launch-via-iterm.sh`
- Updated: every `com.claude.sched.*.plist` (linkedin-job-apply, claude-sync, example)
- Updated: the `/schedule` endpoint in `bolt-app/index.ts` (writes new plists in the new format)
- Updated: `SETUP.md` — iTerm profile step + launchctl reload note

## Risks & trade-offs

- **Hidden-window UX:** if `create hidden window` in iTerm 3.6.9 doesn't fully suppress focus/appearance, schedules will briefly flash windows. We evaluate after a week. Upgrade path if needed: long-lived hidden session + command dispatch via iTerm's Python API (this spec's option B).
- **Caffeinate + thermals:** `caffeinate -i` on a plugged-in desktop is negligible. On battery this would be different; out of scope for this Mac.
- **Bolt-app complexity creep:** adding `/schedules` is small; future endpoints (`/status`, `/run-now`) are tempting but not scoped here.
- **Schedule listing correctness:** parsing `StartCalendarInterval` into natural language is easy when entries share all fields except `Weekday` (e.g. "weekdays at 8:00 AM") or when there's a single entry. For anything else (mixed hours, irregular days), we render the raw array verbatim instead of fabricating English. Acceptable because all current schedules follow the simple pattern.

## Out of scope (for this spec)

- Moving schedule execution into the bolt-app process (design option C from the brainstorming convo). Separate future decision.
- Claude Code auto-update pinning / disabling. Not needed if fix #3 works.
- Changes to the interactive (non-scheduled) flow. Already works.

## Success criteria

1. Mac stays awake 24/7 once caffeinate plist is loaded (verified via `pmset -g assertions` showing `PreventUserIdleSystemSleep`).
2. Asking Slack "what do I have scheduled" returns the correct list 10/10 times.
3. After a Claude Code auto-update, the next scheduled run fires and successfully accesses Documents/Desktop without any manual TCC approval. (Test by waiting for natural update, or by force-reinstalling Claude Code.)

## Order of implementation

1. Fix 1 (caffeinate) — trivial, unblocks night schedules immediately.
2. Fix 2 (`/schedules` endpoint) — small, independent, immediate quality-of-life win.
3. Fix 3 (iTerm wrapper) — biggest, needs testing post-update. Land last so #1 and #2 are already providing value.
