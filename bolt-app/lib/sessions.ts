import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSIONS_PATH = join(homedir(), ".claude", "slack", "sessions.json");

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
  const data = await load();
  data[key(channelId, threadTs)] = sessionId;
  await save(data);
}

export async function clearSessionId(
  channelId: string,
  threadTs: string,
): Promise<void> {
  const data = await load();
  delete data[key(channelId, threadTs)];
  await save(data);
}
