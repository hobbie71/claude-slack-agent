import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { withThreadLock } from "./mutex.ts";

const SESSIONS_PATH = join(homedir(), ".claude", "slack", "sessions.json");
const LOCK_KEY = "__sessions__";

type Sessions = Record<string, string>;

async function load(): Promise<Sessions> {
  try {
    const raw = await readFile(SESSIONS_PATH, "utf8");
    return JSON.parse(raw) as Sessions;
  } catch {
    return {};
  }
}

async function save(data: Sessions): Promise<void> {
  await writeFile(SESSIONS_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function key(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

// Lock-free read. A stale miss here just causes Claude to start a fresh
// session instead of resuming — acceptable. Writers hold LOCK_KEY.
export async function getSessionId(
  channelId: string,
  threadTs: string,
): Promise<string | undefined> {
  const data = await load();
  return data[key(channelId, threadTs)];
}

export async function setSessionId(
  channelId: string,
  threadTs: string,
  sessionId: string,
): Promise<void> {
  await withThreadLock(LOCK_KEY, async () => {
    const data = await load();
    data[key(channelId, threadTs)] = sessionId;
    await save(data);
  });
}

export async function clearSessionId(
  channelId: string,
  threadTs: string,
): Promise<void> {
  await withThreadLock(LOCK_KEY, async () => {
    const data = await load();
    delete data[key(channelId, threadTs)];
    await save(data);
  });
}
