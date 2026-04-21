import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { withThreadLock } from "./mutex.ts";

const BUDGET_PATH = join(homedir(), ".claude", "slack", "budget.json");
const LOCK_KEY = "__budget__";

interface Budget {
  daily_cap_usd: number;
  spent: Record<string, number>;
}

async function load(): Promise<Budget> {
  let raw: string;
  try {
    raw = await readFile(BUDGET_PATH, "utf8");
  } catch (err) {
    // ENOENT on first run — silently return defaults.
    if ((err as { code?: string }).code !== "ENOENT") {
      console.error("[budget] read failed:", err);
    }
    return { daily_cap_usd: 10, spent: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Budget>;
    return {
      daily_cap_usd: parsed.daily_cap_usd ?? 10,
      spent: parsed.spent ?? {},
    };
  } catch (err) {
    // Corruption: preserve the broken file as .bak before we overwrite it
    // so today's spent isn't silently erased.
    const backup = `${BUDGET_PATH}.corrupt-${Date.now()}.bak`;
    console.error(
      `[budget] ⚠️ budget.json is corrupt. Backing up to ${backup} and resetting. Error:`,
      err,
    );
    await rename(BUDGET_PATH, backup).catch((e) =>
      console.error("[budget] rename to .bak failed:", e),
    );
    return { daily_cap_usd: 10, spent: {} };
  }
}

async function save(b: Budget): Promise<void> {
  await writeFile(BUDGET_PATH, JSON.stringify(b, null, 2) + "\n", "utf8");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Lock-free read. A slightly stale value is fine here — the budget gate is
// advisory, not transactional. Writers (recordSpend) hold the lock.
export async function checkBudget(): Promise<{
  ok: boolean;
  spent: number;
  cap: number;
}> {
  const b = await load();
  const spent = b.spent[today()] ?? 0;
  return { ok: spent < b.daily_cap_usd, spent, cap: b.daily_cap_usd };
}

export async function recordSpend(usd: number): Promise<void> {
  if (!(usd > 0)) return;
  await withThreadLock(LOCK_KEY, async () => {
    const b = await load();
    const k = today();
    b.spent[k] = (b.spent[k] ?? 0) + usd;
    // Keep only the last 30 days.
    const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    for (const d of Object.keys(b.spent)) {
      if (d < cutoff) delete b.spent[d];
    }
    await save(b);
  });
}
