import { MAX_CREATES_PER_MIN, MAX_MISSES_PER_MIN, MAX_POSTS_PER_MIN, RATE_WINDOW_MS } from "./limits.js";

/** In-memory per-minute counters. Durable Object storage is the Workers copy. */
export class RateCounters {
  private readonly windows = new Map<string, { window: number; n: number }>();

  allow(ip: string, kind: "create" | "miss", now: number): boolean {
    const limit = kind === "create" ? MAX_CREATES_PER_MIN : MAX_MISSES_PER_MIN;
    const window = Math.floor(now / RATE_WINDOW_MS);
    // Counting is done a minute at a time, so nothing older is worth keeping — and keeping it
    // would mean holding every address that ever arrived for as long as the process runs.
    for (const [key, seen] of this.windows) {
      if (seen.window < window) this.windows.delete(key);
    }
    const key = `${ip}:${kind}`;
    const current = this.windows.get(key);
    if (!current || current.window !== window) {
      this.windows.set(key, { window, n: 1 });
      return true;
    }
    if (current.n >= limit) return false;
    current.n += 1;
    return true;
  }
}

/** One room's posts per minute. Anyone holding the code can post, so the room counts them. */
export class PostCounter {
  private window = -1;
  private n = 0;

  allow(now: number, limit = MAX_POSTS_PER_MIN): boolean {
    const window = Math.floor(now / RATE_WINDOW_MS);
    if (window !== this.window) {
      this.window = window;
      this.n = 1;
      return true;
    }
    if (this.n >= limit) return false;
    this.n += 1;
    return true;
  }
}
