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
    // Budget is absent or implausible — the last arg is the skill name, not a number.
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
