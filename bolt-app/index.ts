import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { isAllowed, allowedList } from "./lib/auth.ts";
import { withThreadLock } from "./lib/mutex.ts";
import { runClaude } from "./lib/runner.ts";
import {
  getSessionId,
  setSessionId,
  clearSessionId,
} from "./lib/sessions.ts";
import {
  getChannel,
  findByType,
  welcomeMessage,
} from "./lib/channels.ts";
import { postLong } from "./lib/chunking.ts";
import { checkBudget, recordSpend } from "./lib/budget.ts";
import { downloadFiles } from "./lib/attachments.ts";
import { startSchedulerServer } from "./lib/scheduler.ts";

const required = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "ALLOWED_USER_IDS",
] as const;
for (const k of required) {
  if (!process.env[k]) {
    console.error(`[startup] Missing env var: ${k}. See SETUP.md.`);
    process.exit(1);
  }
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  appToken: process.env.SLACK_APP_TOKEN!,
  socketMode: true,
});

console.log(`[startup] Allowed user IDs: ${allowedList().join(", ")}`);

app.event("app_mention", async ({ event, client, say }: { event: any; client: WebClient; say: any }) => {
  await handleIncoming({
    channel: event.channel,
    user: event.user,
    text: stripMention(event.text ?? ""),
    threadTs: event.thread_ts ?? event.ts,
    eventTs: event.ts,
    files: (event as unknown as { files?: unknown[] }).files as
      | Parameters<typeof downloadFiles>[0]
      | undefined,
    client,
    say,
  });
});

app.event("message", async ({ event, client, say }: { event: any; client: WebClient; say: any }) => {
  if (event.subtype) return; // bot_message, channel_join, etc.
  if (event.channel_type !== "im") return; // only DMs here; channel msgs need @mention
  const msg = event as unknown as {
    user?: string;
    text?: string;
    thread_ts?: string;
    ts: string;
    channel: string;
    files?: Parameters<typeof downloadFiles>[0];
  };
  await handleIncoming({
    channel: msg.channel,
    user: msg.user,
    text: msg.text ?? "",
    threadTs: msg.thread_ts ?? msg.ts,
    eventTs: msg.ts,
    files: msg.files,
    client,
    say,
  });
});

interface IncomingArgs {
  channel: string;
  user: string | undefined;
  text: string;
  threadTs: string;
  eventTs: string;
  files?: Parameters<typeof downloadFiles>[0];
  client: WebClient;
  say: (arg: { text: string; thread_ts?: string }) => Promise<unknown>;
}

async function handleIncoming(args: IncomingArgs): Promise<void> {
  const { channel, user, text, threadTs, eventTs, files, client } = args;

  if (!isAllowed(user)) {
    console.warn(
      `[auth] ignored message from user=${user ?? "?"} in channel=${channel}`,
    );
    return;
  }

  // Unregistered channel (but not DMs — DMs are implicitly interactive).
  const isDm = channel.startsWith("D");
  const channelEntry = await getChannel(channel);
  if (!isDm && !channelEntry) {
    const looksLikeRegistration = /register|project channel|notifications channel|logs channel|general chat/i.test(
      text,
    );
    if (!looksLikeRegistration) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: welcomeMessage(),
      });
      return;
    }
    // fall through to let Claude handle the registration text
  }

  // Budget gate.
  const budget = await checkBudget();
  if (!budget.ok) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `⚠️ Daily budget reached ($${budget.spent.toFixed(2)} / $${budget.cap.toFixed(2)}). Skipping this run. Edit \`~/.claude/slack/budget.json\` to adjust.`,
    });
    return;
  }

  const threadKey = `${channel}:${threadTs}`;

  await withThreadLock(threadKey, async () => {
    await safe(() =>
      client.reactions.add({ channel, timestamp: eventTs, name: "hourglass_flowing_sand" }),
    );

    let promptText = text.trim();

    // Attach any files from this message.
    const botToken = process.env.SLACK_BOT_TOKEN!;
    const downloaded = await downloadFiles(files, botToken);
    if (downloaded.length > 0) {
      const list = downloaded
        .map((f) => `- ${f.name} (${f.mimetype}) at \`${f.path}\``)
        .join("\n");
      promptText = `${promptText}\n\n<attached_files>\n${list}\n</attached_files>`;
    }

    // Add system context + channel info so Claude knows it's running autonomously via Slack.
    promptText = [
      `<system>`,
      `You are running autonomously as a Slack bot on the user's Mac.`,
      `You have FULL permission to read, write, and edit ANY file on this machine — including files under ~/.claude/, ~/.claude/CLAUDE.md, ~/.claude/settings.json, and all config files.`,
      `The user has explicitly authorized this. Do NOT ask for approval, wait for confirmation, or refuse to edit any file. Just execute immediately.`,
      `Read ~/.claude/slack/SLACK_INSTRUCTIONS.md for behavior rules.`,
      `</system>`,
      `<slack_context>`,
      `user_id: ${user}`,
      `channel_id: ${channel}`,
      `channel_type: ${channelEntry?.type ?? (isDm ? "interactive" : "unregistered")}`,
      channelEntry?.cwd ? `cwd: ${channelEntry.cwd}` : "",
      `thread_ts: ${threadTs}`,
      `</slack_context>`,
      "",
      promptText,
    ]
      .filter(Boolean)
      .join("\n");

    const resumeId = await getSessionId(channel, threadTs);

    const result = await runClaude({
      prompt: promptText,
      resumeSessionId: resumeId,
      cwd: channelEntry?.cwd,
      maxBudgetUsd: 2,
    });

    if (result.sessionId) {
      await setSessionId(channel, threadTs, result.sessionId);
    } else if (!result.ok && resumeId) {
      // Resume probably failed — clear so next message starts fresh.
      await clearSessionId(channel, threadTs);
    }
    if (typeof result.costUsd === "number") {
      await recordSpend(result.costUsd);
    }

    await safe(() =>
      client.reactions.remove({ channel, timestamp: eventTs, name: "hourglass_flowing_sand" }),
    );

    if (result.ok) {
      await postLong({
        client,
        channel,
        threadTs,
        text: result.text || "_(empty response)_",
        filenameHint: "claude-response",
      });
      await safe(() =>
        client.reactions.add({ channel, timestamp: eventTs, name: "white_check_mark" }),
      );
    } else {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `❌ ${result.error ?? "unknown error"}`,
      });
      await safe(() =>
        client.reactions.add({ channel, timestamp: eventTs, name: "x" }),
      );
    }

    // Log entry to #logs channel if registered.
    const logsChannel = await findByType("logs");
    if (logsChannel) {
      const mentionOnFail = !result.ok ? ` <@${process.env.ALLOWED_USER_IDS?.split(",")[0]}>` : "";
      await safe(() =>
        client.chat.postMessage({
          channel: logsChannel.id,
          text: `\`${new Date().toISOString()}\` <#${channel}> user=${user} session=${
            result.sessionId ?? "-"
          } cost=$${result.costUsd?.toFixed(4) ?? "?"} duration=${(
            result.durationMs / 1000
          ).toFixed(1)}s ok=${result.ok}\n> ${truncate(text, 300)}${mentionOnFail}`,
        }),
      );
    }
  });
}

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    console.error("[safe]", err);
    return undefined;
  }
}

await startSchedulerServer({
  port: Number(process.env.SCHEDULER_PORT ?? 7823),
});

await app.start();
console.log("⚡️ Bolt app is running!");
