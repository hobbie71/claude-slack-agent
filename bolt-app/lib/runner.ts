import { spawn } from "node:child_process";
import { homedir } from "node:os";

export interface RunOptions {
  prompt: string;
  resumeSessionId?: string;
  cwd?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
}

export interface RunResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  costUsd?: number;
  durationMs: number;
  error?: string;
}

export async function runClaude(opts: RunOptions): Promise<RunResult> {
  const {
    prompt,
    resumeSessionId,
    cwd = homedir(),
    maxBudgetUsd = 2,
    timeoutMs = 10 * 60 * 1000,
  } = opts;

  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    "--max-budget-usd",
    String(maxBudgetUsd),
  ];
  if (resumeSessionId) args.push("--resume", resumeSessionId);

  const start = Date.now();
  return new Promise<RunResult>((resolve) => {
    const child = spawn("claude", args, {
      cwd,
      env: { ...process.env, CLAUDE_SLACK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killedForTimeout = false;

    const killTimer = setTimeout(() => {
      killedForTimeout = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(killTimer);
      resolve({
        ok: false,
        text: "",
        durationMs: Date.now() - start,
        error: `spawn failed: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      const durationMs = Date.now() - start;

      if (killedForTimeout) {
        resolve({
          ok: false,
          text: stdout.trim(),
          durationMs,
          error: `timed out after ${Math.round(timeoutMs / 1000)}s`,
        });
        return;
      }

      // Try to parse the JSON output from `claude --output-format json`.
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
      } catch {
        // Not valid JSON — treat raw stdout as the response text.
      }

      const sessionId =
        (parsed?.session_id as string | undefined) ?? undefined;
      const costUsd =
        typeof parsed?.cost_usd === "number"
          ? parsed.cost_usd
          : typeof parsed?.total_cost_usd === "number"
            ? (parsed.total_cost_usd as number)
            : undefined;

      // Extract the result text from the JSON, or fall back to raw stdout.
      let text = "";
      if (parsed) {
        text =
          (parsed.result as string | undefined) ??
          extractText(parsed) ??
          stdout.trim();
      } else {
        text = stdout.trim();
      }

      if (code !== 0) {
        const errDetail =
          stderr.trim() || text || "(no output)";
        resolve({
          ok: false,
          text,
          sessionId,
          costUsd,
          durationMs,
          error: `exit ${code}: ${errDetail.slice(0, 500)}`,
        });
        return;
      }

      resolve({ ok: true, text, sessionId, costUsd, durationMs });
    });
  });
}

function extractText(evt: Record<string, unknown>): string | undefined {
  const message = evt.message as
    | { content?: Array<{ type?: string; text?: string }> | string }
    | undefined;
  if (typeof message === "string") return message;
  if (Array.isArray(message?.content)) {
    return message.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  }
  if (typeof evt.text === "string") return evt.text;
  return undefined;
}
