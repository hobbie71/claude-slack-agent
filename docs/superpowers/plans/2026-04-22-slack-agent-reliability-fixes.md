# Slack Agent Reliability Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Claude Slack agent schedule reliably 24/7: keep the Mac awake, give the agent a deterministic way to list its schedules, and prevent macOS TCC from resetting permissions on every Claude Code auto-update.

**Architecture:** Three independent fixes. (1) A launchd LaunchAgent runs `/usr/bin/caffeinate -i` to prevent system idle sleep. (2) A `GET /schedules` endpoint on the existing bolt-app (port 7823) returns parsed schedule metadata so the Slack skill calls an API instead of relying on soft instructions. (3) A new `bin/launch-via-iterm.sh` wrapper has launchd invoke `osascript` then iTerm, which claims TCC "responsible process" for children, making TCC grants survive Claude auto-updates.

**Tech Stack:** bash, AppleScript (osascript), macOS launchd plists, Bun + TypeScript (bolt-app), `bun:test` for unit tests.

**Spec:** [2026-04-22-slack-agent-reliability-fixes-design.md](../specs/2026-04-22-slack-agent-reliability-fixes-design.md)

---

## Files touched

**Created:**
- `com.claude.caffeinate.plist` (repo root)
- `bin/launch-via-iterm.sh`
- `bolt-app/lib/schedule-parser.ts`
- `bolt-app/lib/schedule-parser.test.ts`

**Modified:**
- `bolt-app/lib/scheduler.ts` — update `buildPlist()` to call the iTerm wrapper; add `describeSchedules()`; wire `GET /schedules` route
- `SLACK_INSTRUCTIONS.md` — replace soft "read the schedules folder" with "GET http://127.0.0.1:7823/schedules"
- `SETUP.md` — document caffeinate install and iTerm "Scheduled Agent" profile
- `schedules/com.claude.sched.claude-sync.plist` — regenerate via new plist format
- `schedules/com.claude.sched.linkedin-job-apply.plist` — regenerate via new plist format
- `schedules/example.plist` — regenerate via new plist format

---

## Phase 1 — Caffeinate

### Task 1: Add and install the caffeinate LaunchAgent

**Files:**
- Create: `/Users/javiertamayo/.claude/slack/com.claude.caffeinate.plist`

- [ ] **Step 1: Write the plist**

Create `/Users/javiertamayo/.claude/slack/com.claude.caffeinate.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude.caffeinate</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/Users/javiertamayo/Library/Logs/claude-caffeinate.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/javiertamayo/Library/Logs/claude-caffeinate.err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Install into LaunchAgents and bootstrap**

Run:
```bash
cp /Users/javiertamayo/.claude/slack/com.claude.caffeinate.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.caffeinate.plist
```

Expected: no output on success. If already loaded, `bootout` first then retry:
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claude.caffeinate.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.caffeinate.plist
```

- [ ] **Step 3: Verify the assertion is active**

Run:
```bash
pmset -g assertions | grep -A1 "PreventUserIdleSystemSleep"
```

Expected: at least one line attributed to `caffeinate` with `PreventUserIdleSystemSleep 1`. Also confirm `ps -ax | grep "[c]affeinate -i"` shows one process running.

- [ ] **Step 4: Commit**

```bash
cd /Users/javiertamayo/.claude/slack
git add com.claude.caffeinate.plist
git commit -m "Add caffeinate LaunchAgent to prevent system idle sleep

Keeps the Mac awake 24/7 so scheduled runs and Slack-triggered
interactions fire on time instead of waiting for the next wake."
```

---

## Phase 2 — `GET /schedules` endpoint

### Task 2: Write a plist parser with unit tests (TDD)

**Files:**
- Create: `bolt-app/lib/schedule-parser.ts`
- Create: `bolt-app/lib/schedule-parser.test.ts`

- [ ] **Step 1: Write failing tests first**

Create `/Users/javiertamayo/.claude/slack/bolt-app/lib/schedule-parser.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import {
  parseCalendarIntervals,
  humanizeCalendarIntervals,
  parseScheduleMeta,
} from "./schedule-parser.ts";

const sampleWeekdays = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claude.sched.linkedin-job-apply</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/javiertamayo/.claude/slack/bin/launch-via-iterm.sh</string>
    <string>linkedin-job-apply</string>
    <string>25</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer><key>Weekday</key><integer>1</integer></dict>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer><key>Weekday</key><integer>2</integer></dict>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer><key>Weekday</key><integer>3</integer></dict>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer><key>Weekday</key><integer>4</integer></dict>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer><key>Weekday</key><integer>5</integer></dict>
  </array>
</dict>
</plist>`;

const sampleSingle = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claude.sched.claude-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/javiertamayo/.claude/slack/bin/launch-via-iterm.sh</string>
    <string>claude-sync</string>
    <string>3</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>22</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
</dict>
</plist>`;

describe("parseCalendarIntervals", () => {
  test("parses a single <dict> interval", () => {
    const intervals = parseCalendarIntervals(sampleSingle);
    expect(intervals).toEqual([{ Hour: 22, Minute: 30 }]);
  });

  test("parses an <array> of intervals", () => {
    const intervals = parseCalendarIntervals(sampleWeekdays);
    expect(intervals).toHaveLength(5);
    expect(intervals[0]).toEqual({ Hour: 8, Minute: 0, Weekday: 1 });
    expect(intervals[4]).toEqual({ Hour: 8, Minute: 0, Weekday: 5 });
  });
});

describe("humanizeCalendarIntervals", () => {
  test("single daily time", () => {
    expect(humanizeCalendarIntervals([{ Hour: 22, Minute: 30 }]))
      .toBe("Every day at 10:30 PM");
  });

  test("monday-through-friday at the same time", () => {
    const intervals = [
      { Hour: 8, Minute: 0, Weekday: 1 },
      { Hour: 8, Minute: 0, Weekday: 2 },
      { Hour: 8, Minute: 0, Weekday: 3 },
      { Hour: 8, Minute: 0, Weekday: 4 },
      { Hour: 8, Minute: 0, Weekday: 5 },
    ];
    expect(humanizeCalendarIntervals(intervals))
      .toBe("Weekdays at 8:00 AM");
  });

  test("complex irregular pattern falls back to raw", () => {
    const intervals = [
      { Hour: 8, Minute: 0, Weekday: 1 },
      { Hour: 14, Minute: 30, Weekday: 4 },
    ];
    const out = humanizeCalendarIntervals(intervals);
    expect(out).toMatch(/^2 entries:/);
  });
});

describe("parseScheduleMeta", () => {
  test("extracts skill name and budget from ProgramArguments", () => {
    const meta = parseScheduleMeta(sampleWeekdays);
    expect(meta.skill).toBe("linkedin-job-apply");
    expect(meta.budget_usd).toBe(25);
  });

  test("tolerates missing budget (defaults to null)", () => {
    const minimal = sampleWeekdays.replace("<string>25</string>", "");
    const meta = parseScheduleMeta(minimal);
    expect(meta.skill).toBe("linkedin-job-apply");
    expect(meta.budget_usd).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `/Users/javiertamayo/.claude/slack/bolt-app`:
```bash
bun test lib/schedule-parser.test.ts
```

Expected: `error: Cannot find module './schedule-parser.ts'` or similar — tests fail to even import.

- [ ] **Step 3: Write the minimal implementation**

Create `/Users/javiertamayo/.claude/slack/bolt-app/lib/schedule-parser.ts`:

```typescript
export interface CalendarInterval {
  Minute?: number;
  Hour?: number;
  Day?: number;
  Weekday?: number; // 0=Sun, 1=Mon, ... 7=Sun (launchd treats both 0 and 7 as Sunday)
  Month?: number;
}

export interface ScheduleMeta {
  skill: string | null;
  budget_usd: number | null;
}

const INT_KEYS: Array<keyof CalendarInterval> = [
  "Minute", "Hour", "Day", "Weekday", "Month",
];

function parseDict(dictXml: string): CalendarInterval {
  const out: CalendarInterval = {};
  const re = /<key>([^<]+)<\/key>\s*<integer>(-?\d+)<\/integer>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dictXml)) !== null) {
    const k = m[1] as keyof CalendarInterval;
    if (INT_KEYS.includes(k)) {
      out[k] = Number(m[2]);
    }
  }
  return out;
}

export function parseCalendarIntervals(plistXml: string): CalendarInterval[] {
  const keyMatch = plistXml.match(
    /<key>StartCalendarInterval<\/key>\s*(<array>[\s\S]*?<\/array>|<dict>[\s\S]*?<\/dict>)/,
  );
  if (!keyMatch) return [];
  const body = keyMatch[1];
  if (body.startsWith("<array>")) {
    return Array.from(body.matchAll(/<dict>[\s\S]*?<\/dict>/g)).map((m) =>
      parseDict(m[0]),
    );
  }
  return [parseDict(body)];
}

function parseProgramArguments(plistXml: string): string[] {
  const m = plistXml.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
  );
  if (!m) return [];
  return Array.from(m[1].matchAll(/<string>([\s\S]*?)<\/string>/g)).map(
    (x) => x[1],
  );
}

export function parseScheduleMeta(plistXml: string): ScheduleMeta {
  const args = parseProgramArguments(plistXml);
  if (args.length < 3) return { skill: null, budget_usd: null };
  const skill = args[args.length - 2] || null;
  const rawBudget = args[args.length - 1];
  const n = Number(rawBudget);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) {
    return { skill: args[args.length - 1] || null, budget_usd: null };
  }
  return { skill, budget_usd: n };
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtTime(hour: number, minute: number): string {
  const h12 = ((hour + 11) % 12) + 1;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

export function humanizeCalendarIntervals(
  intervals: CalendarInterval[],
): string {
  if (intervals.length === 0) return "(no schedule)";

  if (intervals.length === 1) {
    const i = intervals[0];
    const hasOnlyTime =
      i.Day === undefined && i.Weekday === undefined && i.Month === undefined;
    if (hasOnlyTime && i.Hour !== undefined && i.Minute !== undefined) {
      return `Every day at ${fmtTime(i.Hour, i.Minute)}`;
    }
  }

  const firstH = intervals[0].Hour;
  const firstM = intervals[0].Minute;
  const allSameTimeWeekdayOnly = intervals.every(
    (i) =>
      i.Hour === firstH &&
      i.Minute === firstM &&
      i.Weekday !== undefined &&
      i.Day === undefined &&
      i.Month === undefined,
  );
  if (allSameTimeWeekdayOnly && firstH !== undefined && firstM !== undefined) {
    const days = [
      ...new Set(intervals.map((i) => (i.Weekday === 7 ? 0 : i.Weekday!))),
    ].sort();
    const timeStr = fmtTime(firstH, firstM);
    const key = days.join(",");
    if (key === "1,2,3,4,5") return `Weekdays at ${timeStr}`;
    if (key === "0,6") return `Weekends at ${timeStr}`;
    if (key === "0,1,2,3,4,5,6") return `Daily at ${timeStr}`;
    return `${days.map((d) => WEEKDAY_NAMES[d]).join(", ")} at ${timeStr}`;
  }

  return `${intervals.length} entries: ${JSON.stringify(intervals)}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/javiertamayo/.claude/slack/bolt-app
bun test lib/schedule-parser.test.ts
```

Expected: `7 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
cd /Users/javiertamayo/.claude/slack
git add bolt-app/lib/schedule-parser.ts bolt-app/lib/schedule-parser.test.ts
git commit -m "Add schedule-parser with humanization for simple patterns

Parses StartCalendarInterval from plist XML and renders common
patterns (daily, weekdays, weekends, specific days) as English.
Irregular patterns fall back to raw JSON instead of fabricating."
```

---

### Task 3: Add `GET /schedules` route to the bolt-app HTTP server

**Files:**
- Modify: `bolt-app/lib/scheduler.ts`

- [ ] **Step 1: Read current state**

Read `/Users/javiertamayo/.claude/slack/bolt-app/lib/scheduler.ts`. The HTTP server at the bottom currently rejects all non-POST requests:
```ts
if (req.method !== "POST") {
  res.writeHead(405).end("Method Not Allowed");
  return;
}
```

- [ ] **Step 2: Add GET handling and a `describeSchedules()` helper**

Edit `bolt-app/lib/scheduler.ts`. At the top, add imports for the parser:

```ts
import {
  parseCalendarIntervals,
  humanizeCalendarIntervals,
  parseScheduleMeta,
} from "./schedule-parser.ts";
```

Below the existing `listSchedules()` export, add:

```ts
export interface DescribedSchedule {
  name: string;
  label: string;
  skill: string | null;
  budget_usd: number | null;
  schedule_human: string;
  schedule_raw: ReturnType<typeof parseCalendarIntervals>;
  plist_path: string;
}

export async function describeSchedules(): Promise<DescribedSchedule[]> {
  const raw = await listSchedules();
  return raw
    .filter((s) => s.name !== "example")
    .map((s) => {
      const intervals = parseCalendarIntervals(s.plist);
      const meta = parseScheduleMeta(s.plist);
      return {
        name: s.name,
        label: `com.claude.sched.${s.name}`,
        skill: meta.skill,
        budget_usd: meta.budget_usd,
        schedule_human: humanizeCalendarIntervals(intervals),
        schedule_raw: intervals,
        plist_path: s.plistPath,
      };
    });
}
```

Replace the method check and routing inside `startSchedulerServer`. Find:

```ts
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end("Method Not Allowed");
      return;
    }
    let body = "";
    let bytes = 0;
```

Replace with:

```ts
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      const url = req.url ?? "";
      if (url === "/schedules") {
        try {
          const list = await describeSchedules();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, schedules: list }));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ ok: false, error: (err as Error).message }),
          );
        }
        return;
      }
      res.writeHead(404).end("Not Found");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end("Method Not Allowed");
      return;
    }
    let body = "";
    let bytes = 0;
```

- [ ] **Step 3: Restart the bolt-app and smoke-test**

```bash
launchctl kickstart -k gui/$(id -u)/com.claude.slack-agent
sleep 3
curl -s http://127.0.0.1:7823/schedules | jq
```

Expected: JSON containing both schedules (`linkedin-job-apply`, `claude-sync`) with `schedule_human` populated (e.g. `"Weekdays at 8:00 AM"`, `"Every day at 10:30 PM"`).

If `jq` isn't installed, `curl -s http://127.0.0.1:7823/schedules` alone shows the raw JSON — that's fine.

- [ ] **Step 4: Commit**

```bash
cd /Users/javiertamayo/.claude/slack
git add bolt-app/lib/scheduler.ts
git commit -m "Add GET /schedules endpoint returning parsed schedule metadata

The Slack skill now has a deterministic source for 'what do I have
scheduled' instead of relying on the model to remember to read the
plist directory."
```

---

### Task 4: Point `SLACK_INSTRUCTIONS.md` at the new endpoint

**Files:**
- Modify: `SLACK_INSTRUCTIONS.md`

- [ ] **Step 1: Replace the schedules section**

Read `/Users/javiertamayo/.claude/slack/SLACK_INSTRUCTIONS.md`. Find the section `## Schedules` and replace the bullet list under it.

Current bullets:
```
- "Show my schedules" → list plist files + parsed schedules
- "Schedule X every weekday at 9am" → parse to `StartCalendarInterval`, POST to `http://127.0.0.1:7823/schedule` (the Bolt app's localhost endpoint)
- "Remove the X schedule" → POST to `http://127.0.0.1:7823/unschedule`
- "Kill all schedules" → POST to `http://127.0.0.1:7823/kill-all`
```

Replace with:
```
- "Show my schedules" / "what do I have scheduled" → `GET http://127.0.0.1:7823/schedules` and render the `schedule_human` field for each entry. Do NOT read `~/.claude/slack/schedules/` yourself — the endpoint is the source of truth.
- "Schedule X every weekday at 9am" → parse to `StartCalendarInterval`, POST to `http://127.0.0.1:7823/schedule` (the Bolt app's localhost endpoint)
- "Remove the X schedule" → POST to `http://127.0.0.1:7823/unschedule`
- "Kill all schedules" → POST to `http://127.0.0.1:7823/kill-all`
```

- [ ] **Step 2: Commit**

```bash
cd /Users/javiertamayo/.claude/slack
git add SLACK_INSTRUCTIONS.md
git commit -m "Instruct Slack skill to GET /schedules instead of reading plists

The soft 'read the plist directory' instruction was producing ~66%
hallucinated empty responses. The explicit endpoint eliminates that."
```

---

## Phase 3 — iTerm wrapper (TCC fix)

### Task 5: Create `bin/launch-via-iterm.sh`

**Files:**
- Create: `bin/launch-via-iterm.sh`

- [ ] **Step 1: Write the wrapper script**

Create `/Users/javiertamayo/.claude/slack/bin/launch-via-iterm.sh`:

```bash
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
tell application "iTerm"
  set newWindow to (create hidden window with default profile)
  tell current session of newWindow
    write text "export SLACK_COMPLETION_WEBHOOK=\"$(esc_as "$WEBHOOK")\"; \"$(esc_as "$SCRIPT")\" \"$(esc_as "$SKILL")\" \"$(esc_as "$BUDGET")\"; exit"
  end tell
end tell
APPLESCRIPT
)

/usr/bin/osascript -e "$AS_SCRIPT"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x /Users/javiertamayo/.claude/slack/bin/launch-via-iterm.sh
```

- [ ] **Step 3: Verify `create hidden window` is supported by the installed iTerm**

Run:
```bash
osascript -e 'tell application "iTerm" to get version'
```

Expected: a version string like `3.6.9`. `create hidden window` is supported in iTerm 3.4+.

If iTerm's AppleScript rejects `create hidden window` (older build), replace that line in the wrapper with:
```applescript
set newWindow to (create window with default profile)
set miniaturized of newWindow to true
```

- [ ] **Step 4: Smoke-test the wrapper with a throwaway skill name**

```bash
SLACK_COMPLETION_WEBHOOK="https://hooks.slack.com/services/YOUR/WEBHOOK/HERE" \
  /Users/javiertamayo/.claude/slack/bin/launch-via-iterm.sh nonexistent-skill 1
```

Expected: a hidden iTerm window opens briefly, `run-scheduled.sh` runs, claude errors because the skill doesn't exist, and Slack receives a ❌ webhook message. Crucially: no TCC permission error — that's what we're verifying.

- [ ] **Step 5: Commit**

```bash
cd /Users/javiertamayo/.claude/slack
git add bin/launch-via-iterm.sh
git commit -m "Add iTerm-spawn wrapper for scheduled runs

Routes scheduled claude invocations through iTerm so TCC attributes
them to iTerm (stable path) instead of the claude binary (versioned
path that changes on every auto-update)."
```

---

### Task 6: Update `buildPlist()` to generate plists that call the wrapper

**Files:**
- Modify: `bolt-app/lib/scheduler.ts`

- [ ] **Step 1: Change the ProgramArguments in `buildPlist()`**

In `/Users/javiertamayo/.claude/slack/bolt-app/lib/scheduler.ts`, find the constant:

```ts
const RUN_SCRIPT = join(homedir(), ".claude", "slack", "bin", "run-scheduled.sh");
```

Replace with:

```ts
const LAUNCH_WRAPPER = join(homedir(), ".claude", "slack", "bin", "launch-via-iterm.sh");
```

Find the `buildPlist` output that references `RUN_SCRIPT`:

```
    <string>/bin/bash</string>
    <string>${e(RUN_SCRIPT)}</string>
    <string>${e(req.name)}</string>
    <string>${e(String(req.maxBudgetUsd ?? 5))}</string>
```

Replace with:

```
    <string>/bin/bash</string>
    <string>${e(LAUNCH_WRAPPER)}</string>
    <string>${e(req.name)}</string>
    <string>${e(String(req.maxBudgetUsd ?? 5))}</string>
```

- [ ] **Step 2: Restart the bolt-app**

```bash
launchctl kickstart -k gui/$(id -u)/com.claude.slack-agent
sleep 2
```

- [ ] **Step 3: Verify new schedules get the wrapper path**

Create a throwaway schedule via the existing endpoint:

```bash
curl -s -X POST http://127.0.0.1:7823/schedule \
  -H 'content-type: application/json' \
  -d '{"name":"tcc-verify","calendar":{"Hour":3,"Minute":0},"maxBudgetUsd":1}'
grep -E 'launch-via-iterm|run-scheduled' ~/.claude/slack/schedules/com.claude.sched.tcc-verify.plist
```

Expected: output includes `launch-via-iterm.sh`, NOT `run-scheduled.sh`.

Then clean up:
```bash
curl -s -X POST http://127.0.0.1:7823/unschedule \
  -H 'content-type: application/json' \
  -d '{"name":"tcc-verify"}'
```

- [ ] **Step 4: Commit**

```bash
cd /Users/javiertamayo/.claude/slack
git add bolt-app/lib/scheduler.ts
git commit -m "Point generated plists at launch-via-iterm.sh wrapper

Every new schedule created via POST /schedule now routes through
iTerm so TCC grants survive Claude Code auto-updates."
```

---

### Task 7: Regenerate the committed plists in the repo

**Files:**
- Modify: `schedules/com.claude.sched.claude-sync.plist`
- Modify: `schedules/com.claude.sched.linkedin-job-apply.plist`
- Modify: `schedules/example.plist`

- [ ] **Step 1: Replace wrapper path in each existing plist**

In each of the three plists under `/Users/javiertamayo/.claude/slack/schedules/`, find:
```xml
    <string>/Users/javiertamayo/.claude/slack/bin/run-scheduled.sh</string>
```

Replace with:
```xml
    <string>/Users/javiertamayo/.claude/slack/bin/launch-via-iterm.sh</string>
```

(The surrounding ProgramArguments lines — `/bin/bash` before, `skill-name` and `budget` after — do not change.)

- [ ] **Step 2: Copy to LaunchAgents and reload**

```bash
NAMES=(claude-sync linkedin-job-apply)
for n in "${NAMES[@]}"; do
  label="com.claude.sched.$n"
  cp "/Users/javiertamayo/.claude/slack/schedules/$label.plist" ~/Library/LaunchAgents/
  launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/$label.plist 2>/dev/null
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/$label.plist
done
```

- [ ] **Step 3: Verify launchd sees the updated paths**

```bash
launchctl print gui/$(id -u)/com.claude.sched.linkedin-job-apply | grep -E 'arguments|path' | head
```

Expected: arguments list shows `/Users/javiertamayo/.claude/slack/bin/launch-via-iterm.sh` as the second argument.

- [ ] **Step 4: Acceptance test — prove the TCC fix works**

Reproduces the empirical test from brainstorming. Create a throwaway launchd job that uses the wrapper to access Documents:

```bash
cat > /tmp/tcc-acceptance.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claude.tcc-acceptance</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/osascript</string>
    <string>-e</string>
    <string>tell application "iTerm" to create hidden window with default profile command "ls /Users/javiertamayo/Documents/ > /tmp/tcc-acceptance.out 2>&amp;1; echo DONE >> /tmp/tcc-acceptance.out; exit"</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>/tmp/tcc-acceptance.err</string>
</dict>
</plist>
PLIST
rm -f /tmp/tcc-acceptance.out /tmp/tcc-acceptance.err
launchctl bootstrap gui/$(id -u) /tmp/tcc-acceptance.plist
sleep 4
echo "=== output ==="
cat /tmp/tcc-acceptance.out
launchctl bootout gui/$(id -u) /tmp/tcc-acceptance.plist 2>/dev/null
rm -f /tmp/tcc-acceptance.plist
```

Expected: `/tmp/tcc-acceptance.out` contains a real directory listing of `~/Documents` followed by `DONE`. NOT `Operation not permitted`. If it says "Operation not permitted," iTerm itself doesn't have Documents permission — grant it once via System Settings → Privacy & Security → Files and Folders → iTerm, then re-run.

- [ ] **Step 5: Commit**

```bash
cd /Users/javiertamayo/.claude/slack
git add schedules/com.claude.sched.claude-sync.plist schedules/com.claude.sched.linkedin-job-apply.plist schedules/example.plist
git commit -m "Migrate committed schedule plists to use iTerm wrapper"
```

---

### Task 8: Document the one-time iTerm profile setup

**Files:**
- Modify: `SETUP.md`

- [ ] **Step 1: Read current SETUP.md**

Read `/Users/javiertamayo/.claude/slack/SETUP.md` to find a good insertion point — ideally after any existing "launchd" or "scheduled runs" section.

- [ ] **Step 2: Append a new section**

Append at the end of SETUP.md:

```markdown
## Scheduled runs and iTerm

Scheduled runs are routed through iTerm so macOS TCC attributes them to iTerm (whose binary path is stable) instead of the Claude Code binary (whose path changes on every auto-update). Without this, every Claude Code update would silently revoke Documents/Desktop/network access for scheduled runs.

**One-time setup:**

1. Open iTerm → Settings → Profiles. Duplicate the default profile and name it `Scheduled Agent`.
2. In the `Session` tab of that profile, set **"When command exits" → "Close the window"**. Prevents hidden windows from accumulating.
3. In System Settings → Privacy & Security → Files and Folders, confirm iTerm has access to at least Documents, Desktop, Downloads, and any other folders your scheduled skills touch (e.g. your Obsidian vault).
4. Ensure `caffeinate` is running (see the caffeinate section above) so the Mac doesn't sleep through scheduled runs.

**Verifying it works:** run the acceptance test in `docs/superpowers/plans/2026-04-22-slack-agent-reliability-fixes.md` Task 7 Step 4 after a Claude Code update to confirm scheduled runs still have filesystem access.

## Caffeinate (keep Mac awake 24/7)

Install the caffeinate LaunchAgent so scheduled runs and Slack messages are handled in real time even when the display sleeps:

```bash
cp /Users/javiertamayo/.claude/slack/com.claude.caffeinate.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.caffeinate.plist
```

Verify with `pmset -g assertions | grep PreventUserIdle`.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/javiertamayo/.claude/slack
git add SETUP.md
git commit -m "Document iTerm profile and caffeinate install steps"
```

---

## Acceptance checklist

After all tasks complete, verify end-to-end:

- [ ] `pmset -g assertions | grep PreventUserIdle` shows the caffeinate assertion active.
- [ ] `curl -s http://127.0.0.1:7823/schedules | jq '.schedules[].schedule_human'` returns all schedules with correct human-readable strings.
- [ ] Ask the Slack bot "what do I have scheduled?" five times in a row — should return the full list every time (previously ~1/3).
- [ ] Task 7 Step 4 acceptance test passes (Documents access from a launchd-triggered iTerm command works).
- [ ] Wait for the next real schedule fire (or kick one manually via `launchctl kickstart -k gui/$(id -u)/com.claude.sched.<name>`); confirm the webhook posts a ✅ result to Slack.

## Rollback

If the iTerm-wrapper path is worse than the status quo (windows pile up, TCC still fails, etc.):

1. Revert the changes to `buildPlist()` in `scheduler.ts` (point back at `RUN_SCRIPT`).
2. Regenerate each plist under `schedules/` and `~/Library/LaunchAgents/` to call `run-scheduled.sh` directly.
3. Reload with `launchctl bootout` + `launchctl bootstrap`.
4. The caffeinate agent and `/schedules` endpoint stay — they're independent wins.
