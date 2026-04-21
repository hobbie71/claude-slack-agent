// Slack can redeliver an event if our ack takes too long (>3s) or if there
// is a transient delivery issue. Track recent event IDs in a TTL cache so
// we process each one exactly once.

const TTL_MS = 10 * 60 * 1000; // 10 minutes — well past any reasonable retry window
const MAX_ENTRIES = 5000; // safety bound in case TTL cleanup falls behind

interface Entry {
  expires: number;
}

const seen = new Map<string, Entry>();

/**
 * Returns true if this eventId has been seen in the last TTL window.
 * Records it (refreshing TTL) in either case. Callers that get `true`
 * should return early without processing.
 */
export function isDuplicate(eventId: string | undefined): boolean {
  if (!eventId) return false;
  sweep();
  const now = Date.now();
  const hit = seen.get(eventId);
  if (hit && hit.expires > now) return true;
  // Only record on first sight — don't refresh the TTL on retries, otherwise
  // a persistent retrier extends the entry forever.
  seen.set(eventId, { expires: now + TTL_MS });
  return false;
}

function sweep(): void {
  if (seen.size < MAX_ENTRIES) {
    // Lazy cleanup: only scan when full.
    return;
  }
  const now = Date.now();
  for (const [k, v] of seen) {
    if (v.expires <= now) seen.delete(k);
  }
  // If still over the limit after expiry sweep, drop the oldest entries.
  if (seen.size >= MAX_ENTRIES) {
    const overflow = seen.size - Math.floor(MAX_ENTRIES * 0.8);
    let i = 0;
    for (const k of seen.keys()) {
      if (i++ >= overflow) break;
      seen.delete(k);
    }
  }
}
