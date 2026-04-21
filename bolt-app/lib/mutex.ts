const locks = new Map<string, Promise<unknown>>();

export async function withThreadLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  locks.set(key, next);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (locks.get(key) === next) locks.delete(key);
  }
}
