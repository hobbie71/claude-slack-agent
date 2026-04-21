import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
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

export interface DownloadResult {
  files: DownloadedFile[];
  /** Temp directory to rm -rf after the Claude run finishes. `undefined` if no files. */
  tempDir?: string;
}

/**
 * Downloads Slack-attached files to a per-message temp directory. Returns
 * local paths and the temp dir so the caller can clean up after use.
 */
export async function downloadFiles(
  files: SlackFile[] | undefined,
  botToken: string,
): Promise<DownloadResult> {
  if (!files || files.length === 0) return { files: [] };
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
    const safeName = basename(f.name) || `file-${randomUUID()}`;
    const path = join(dir, safeName);
    await writeFile(path, buf);
    out.push({ path, name: safeName, mimetype: f.mimetype ?? "" });
  }
  return { files: out, tempDir: dir };
}

export async function cleanupTempDir(dir: string | undefined): Promise<void> {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true }).catch((err) => {
    console.error(`[attachments] cleanup of ${dir} failed:`, err);
  });
}
