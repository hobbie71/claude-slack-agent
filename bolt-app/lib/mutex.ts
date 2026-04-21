// Per-key FIFO mutex with a queue-depth cap. Prevents unbounded memory
// growth if a thread is spammed faster than Claude can process messages.

const MAX_PENDING_PER_KEY = 10;

interface Slot {
  tail: Promise<unknown>;
  pending: number;
}

const locks = new Map<string, Slot>();

export class MutexOverflowError extends Error {
  constructor(key: string) {
    super(`mutex queue full for key ${key} (>${MAX_PENDING_PER_KEY} pending)`);
    this.name = "MutexOverflowError";
  }
}

export async function withThreadLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const slot = locks.get(key) ?? { tail: Promise.resolve(), pending: 0 };
  if (slot.pending >= MAX_PENDING_PER_KEY) {
    throw new MutexOverflowError(key);
  }
  slot.pending++;
  const prev = slot.tail;
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  slot.tail = next;
  locks.set(key, slot);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    slot.pending--;
    // Clean up the slot only if nothing else is queued AND we're still the tail.
    if (slot.pending === 0 && locks.get(key)?.tail === next) {
      locks.delete(key);
    }
  }
}
