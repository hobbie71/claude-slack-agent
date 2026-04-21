import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CHANNELS_PATH = join(homedir(), ".claude", "slack", "channels.json");

export type ChannelType =
  | "interactive"
  | "notifications"
  | "logs"
  | "project";

export interface ChannelEntry {
  id: string;
  name: string;
  type: ChannelType;
  description: string;
  registered: string;
  cwd?: string;
  skillAllowlist?: string[];
}

interface Registry {
  channels: ChannelEntry[];
}

async function load(): Promise<Registry> {
  try {
    const raw = await readFile(CHANNELS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Registry;
    return { channels: parsed.channels ?? [] };
  } catch {
    return { channels: [] };
  }
}

async function save(reg: Registry): Promise<void> {
  await writeFile(CHANNELS_PATH, JSON.stringify(reg, null, 2) + "\n", "utf8");
}

export async function getChannel(
  id: string,
): Promise<ChannelEntry | undefined> {
  const reg = await load();
  return reg.channels.find((c) => c.id === id);
}

export async function upsertChannel(entry: ChannelEntry): Promise<void> {
  const reg = await load();
  const i = reg.channels.findIndex((c) => c.id === entry.id);
  if (i >= 0) reg.channels[i] = entry;
  else reg.channels.push(entry);
  await save(reg);
}

export async function findByType(
  type: ChannelType,
): Promise<ChannelEntry | undefined> {
  const reg = await load();
  return reg.channels.find((c) => c.type === type);
}

export async function listChannels(): Promise<ChannelEntry[]> {
  return (await load()).channels;
}

export function welcomeMessage(): string {
  return [
    "👋 Hey! I don't have this channel registered yet. Let me introduce myself.",
    "",
    "I'm your Claude Code agent — I run locally on your Mac and you control me through Slack. I only respond to the user(s) in my allowlist.",
    "",
    "Here's what I can do:",
    "• 📁 *Files* — browse, move, organize, search",
    "• 🔧 *Commands* — run scripts, check status, manage git repos",
    "• 🧠 *Skills* — all your Claude Code skills (say `what skills do I have?`)",
    "• 📅 *Schedules* — run skills on a schedule (launchd, not cron)",
    "• 💬 *Memory* — full thread context; start a new thread for a new topic",
    "",
    "To register this channel, reply with one of:",
    "• `this is a project channel for <path>`",
    "• `this is a notifications channel`",
    "• `this is a logs channel`",
    "• `this is just for general chat`",
    "",
    "Once registered, I'll know how to behave here.",
  ].join("\n");
}
