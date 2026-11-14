/**
 * Request limits for the handler. The default counts in memory, per process: enough for one server; behind several,
 * pass a limiter backed by a shared store (Redis, the database) with the same `hit`.
 */

export interface RateResult {
  ok: boolean;
  /** When refused: how long until the next request may go. */
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Count one request against `key`: refused once `limit` were counted within `windowMs`. */
  hit(key: string, limit: number, windowMs: number): RateResult | Promise<RateResult>;
}

/** A fixed-window counter per key, in memory. Expired windows are swept as it goes, so memory stays bounded. */
export function memoryRateLimiter(options: { clock?: () => number; maxKeys?: number } = {}): RateLimiter {
  const clock = options.clock ?? Date.now;
  const maxKeys = options.maxKeys ?? 100_000;
  const windows = new Map<string, { count: number; resetAt: number }>();
  let hits = 0;

  function sweep(now: number) {
    for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
  }

  return {
    hit(key, limit, windowMs) {
      const now = clock();
      if (++hits % 1_000 === 0 || windows.size >= maxKeys) sweep(now);
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        w = { count: 0, resetAt: now + windowMs };
        windows.set(key, w);
      }
      if (w.count >= limit) return { ok: false, retryAfterMs: w.resetAt - now };
      w.count++;
      return { ok: true, retryAfterMs: 0 };
    },
  };
}
