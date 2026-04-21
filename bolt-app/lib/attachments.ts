import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  url_private_download?: string;
  url_private?: string;
}

export interface DownloadedFile {
  path: string;
  name: string;
  mimetype: string;
}

/**
 * Downloads Slack-attached files to a per-message temp directory, returns
 * local paths we can feed to `claude` via the prompt.
 */
export async function downloadFiles(
  files: SlackFile[] | undefined,
  botToken: string,
): Promise<DownloadedFile[]> {
  if (!files || files.length === 0) return [];
  const dir = join(tmpdir(), `claude-slack-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const out: DownloadedFile[] = [];
  for (const f of files) {
    const url = f.url_private_download ?? f.url_private;
    if (!url || !f.name) continue;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!res.ok) {
      console.error(`[attachments] failed to fetch ${f.name}: ${res.status}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const path = join(dir, f.name);
    await writeFile(path, buf);
    out.push({ path, name: f.name, mimetype: f.mimetype ?? "" });
  }
  return out;
}
