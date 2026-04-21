import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const runBin = promisify(execFile);

const MAX_BODY_BYTES = 64 * 1024;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const SCHEDULES_DIR = join(homedir(), ".claude", "slack", "schedules");
const LOGS_DIR = join(homedir(), ".claude", "slack", "logs");
const LAUNCH_AGENTS_DIR = join(
  homedir(),
  "Library",
  "LaunchAgents",
);
const RUN_SCRIPT = join(homedir(), ".claude", "slack", "bin", "run-scheduled.sh");
const UID = userInfo().uid;

export interface ScheduleRequest {
  name: string;
  calendar: CalendarInterval | CalendarInterval[];
  cwd?: string;
  maxBudgetUsd?: number;
}

export interface CalendarInterval {
  Minute?: number;
  Hour?: number;
  Day?: number;
  Weekday?: number; // 0=Sun, 1=Mon, ... 7=Sun
  Month?: number;
}

function label(name: string): string {
  return `com.claude.sched.${name.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

function plistPath(name: string): string {
  return join(SCHEDULES_DIR, `${label(name)}.plist`);
}

function agentPath(name: string): string {
  return join(LAUNCH_AGENTS_DIR, `${label(name)}.plist`);
}

function plistXmlForCalendarDict(cal: CalendarInterval): string {
  const allowedKeys = new Set(["Minute", "Hour", "Day", "Weekday", "Month"]);
  const entries: string[] = [];
  for (const [k, v] of Object.entries(cal)) {
    if (v === undefined) continue;
    if (!allowedKeys.has(k)) continue;
    const num = Number(v);
    if (!Number.isInteger(num) || num < 0 || num > 366) continue;
    entries.push(`    <key>${escapeXml(k)}</key><integer>${num}</integer>`);
  }
  return `  <dict>\n${entries.join("\n")}\n  </dict>`;
}

function buildPlist(req: ScheduleRequest, webhook: string): string {
  const intervals = Array.isArray(req.calendar) ? req.calendar : [req.calendar];
  const calXml =
    intervals.length === 1
      ? plistXmlForCalendarDict(intervals[0])
      : `  <array>\n${intervals.map(plistXmlForCalendarDict).join("\n")}\n  </array>`;
  const logPath = join(LOGS_DIR, `${label(req.name)}.log`);
  const errPath = join(LOGS_DIR, `${label(req.name)}.err.log`);
  const cwd = req.cwd ?? homedir();

  const e = escapeXml; // alias for readability
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${e(label(req.name))}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${e(RUN_SCRIPT)}</string>
    <string>${e(req.name)}</string>
    <string>${e(String(req.maxBudgetUsd ?? 5))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${e(cwd)}</string>
  <key>StandardOutPath</key>
  <string>${e(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${e(errPath)}</string>
  <key>RunAtLoad</key>
  <false/>
  <key>StartCalendarInterval</key>
${calXml}
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${e(homedir())}</string>
    <key>PATH</key><string>${e(`${homedir()}/.local/bin:${homedir()}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string>
    <key>SLACK_COMPLETION_WEBHOOK</key><string>${e(webhook)}</string>
  </dict>
</dict>
</plist>
`;
}

export async function createSchedule(req: ScheduleRequest): Promise<void> {
  const webhook = process.env.SLACK_COMPLETION_WEBHOOK ?? "";
  if (!webhook) {
    throw new Error("SLACK_COMPLETION_WEBHOOK not set in env");
  }
  const xml = buildPlist(req, webhook);
  await writeFile(plistPath(req.name), xml, "utf8");
  await writeFile(agentPath(req.name), xml, "utf8");
  await runBin("launchctl", [
    "bootstrap",
    `gui/${UID}`,
    agentPath(req.name),
  ]).catch(async (e: unknown) => {
    const msg = (e as { stderr?: string }).stderr ?? String(e);
    if (/already/.test(msg) || /exists/.test(msg)) {
      await runBin("launchctl", [
        "bootout",
        `gui/${UID}`,
        agentPath(req.name),
      ]).catch(() => {});
      await runBin("launchctl", [
        "bootstrap",
        `gui/${UID}`,
        agentPath(req.name),
      ]);
    } else {
      throw e;
    }
  });
}

export async function removeSchedule(name: string): Promise<void> {
  await runBin("launchctl", [
    "bootout",
    `gui/${UID}`,
    agentPath(name),
  ]).catch(() => {});
  await unlink(agentPath(name)).catch(() => {});
  await unlink(plistPath(name)).catch(() => {});
}

export async function listSchedules(): Promise<
  Array<{ name: string; plistPath: string; plist: string }>
> {
  const entries = await readdir(SCHEDULES_DIR).catch(() => [] as string[]);
  const out: Array<{ name: string; plistPath: string; plist: string }> = [];
  for (const f of entries) {
    if (!f.endsWith(".plist")) continue;
    const p = join(SCHEDULES_DIR, f);
    const body = await readFile(p, "utf8");
    const name = f.replace(/^com\.claude\.sched\./, "").replace(/\.plist$/, "");
    out.push({ name, plistPath: p, plist: body });
  }
  return out;
}

export async function killAll(): Promise<number> {
  const all = await listSchedules();
  for (const s of all) await removeSchedule(s.name);
  return all.length;
}

/**
 * Localhost-only HTTP endpoint the schedule-manager skill POSTs to.
 * Bound to 127.0.0.1 — only the logged-in user can reach it.
 */
export async function startSchedulerServer(opts: {
  port: number;
}): Promise<void> {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end("Method Not Allowed");
      return;
    }
    let body = "";
    let bytes = 0;
    req.setEncoding("utf8");
    req.on("data", (c) => {
      bytes += Buffer.byteLength(c as string);
      if (bytes > MAX_BODY_BYTES) {
        res.writeHead(413).end("Request too large");
        req.destroy();
        return;
      }
      body += c;
    });
    req.on("end", async () => {
      if (bytes > MAX_BODY_BYTES) return;
      try {
        const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const url = req.url ?? "";
        if (url === "/schedule") {
          await createSchedule(data as unknown as ScheduleRequest);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else if (url === "/unschedule") {
          await removeSchedule((data.name as string) ?? "");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else if (url === "/list") {
          const all = await listSchedules();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, schedules: all }));
        } else if (url === "/kill-all") {
          const n = await killAll();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, removed: n }));
        } else {
          res.writeHead(404).end("Not Found");
        }
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: (err as Error).message }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(opts.port, "127.0.0.1", () => {
      console.log(
        `[scheduler] listening on http://127.0.0.1:${opts.port} (loopback only)`,
      );
      resolve();
    });
  });
}
