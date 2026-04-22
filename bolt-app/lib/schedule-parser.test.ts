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
