import type { WebClient } from "@slack/web-api";

const SLACK_CHAR_LIMIT = 3500;
const MAX_CHUNKS_BEFORE_UPLOAD = 5;

export interface PostLongOpts {
  client: WebClient;
  channel: string;
  threadTs: string;
  text: string;
  filenameHint?: string;
}

/**
 * Posts `text` to a Slack thread. If it's short, one message. If it's long,
 * chunks it. If it's very long (> 5 chunks), uploads the full text as a
 * Markdown file and posts a short preview.
 */
export async function postLong(opts: PostLongOpts): Promise<void> {
  const { client, channel, threadTs, text, filenameHint = "output" } = opts;
  if (!text.trim()) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "_(empty response)_",
    });
    return;
  }

  const chunks = chunk(text, SLACK_CHAR_LIMIT);

  if (chunks.length <= MAX_CHUNKS_BEFORE_UPLOAD) {
    for (let i = 0; i < chunks.length; i++) {
      const body =
        chunks.length > 1 ? `*(${i + 1}/${chunks.length})*\n${chunks[i]}` : chunks[i];
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: body,
      });
    }
    return;
  }

  // Long output → upload as file with a short preview message.
  const preview = chunks[0].slice(0, 1500);
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `Output is ${text.length.toLocaleString()} chars — uploading full text as a file.\n\n*Preview:*\n${preview}${preview.length < chunks[0].length ? "\n…" : ""}`,
  });

  try {
    await client.files.uploadV2({
      channel_id: channel,
      thread_ts: threadTs,
      filename: `${filenameHint}.md`,
      content: text,
      title: `${filenameHint}.md`,
    });
  } catch (err) {
    console.error("[chunking] files.uploadV2 failed:", err);
    await client.chat
      .postMessage({
        channel,
        thread_ts: threadTs,
        text: `⚠️ Couldn't upload the full output as a file (${(err as Error).message}). The preview above is all that was returned.`,
      })
      .catch((e) => console.error("[chunking] fallback postMessage failed:", e));
  }
}

function chunk(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      // Prefer a newline boundary within the last ~400 chars of the chunk.
      const slack = Math.min(400, size);
      const nl = text.lastIndexOf("\n", end);
      if (nl > i + size - slack) end = nl;
    }
    out.push(text.slice(i, end));
    i = end;
    if (text[i] === "\n") i++;
  }
  return out;
}
