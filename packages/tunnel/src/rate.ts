import { MAX_CREATES_PER_MIN, MAX_MISSES_PER_MIN, RATE_WINDOW_MS } from "./limits.js";

/** In-memory per-minute counters. Durable Object storage is the Workers copy. */
export class RateCounters {
  private readonly windows = new Map<string, { window: number; n: number }>();

  allow(ip: string, kind: "create" | "miss", now: number): boolean {
    const limit = kind === "create" ? MAX_CREATES_PER_MIN : MAX_MISSES_PER_MIN;
    const window = Math.floor(now / RATE_WINDOW_MS);
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
