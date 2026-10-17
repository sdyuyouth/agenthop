/** A relay refusal has a different retry budget from a dropped network connection. */
export class RelayFailure extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterMs = 0) {
    super(message);
  }
}

export function retryAfter(value: string | string[] | undefined | null): number {
  if (!value) return 0;
  const raw = Array.isArray(value) ? value[0]! : value;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(ms) ? Math.min(86_400_000, Math.max(0, ms)) : 0;
}

export function retryDelay(attempt: number, error?: unknown, background = false): number {
  const code = error instanceof RelayFailure ? error.code : "";
  const floor = code === "unauthorized" || code === "relay_quota" ? 300_000
    : code === "rate_limited" || code === "room_taken" ? 60_000 : background ? 5_000 : 500;
  const ceiling = Math.max(floor, background ? 120_000 : 30_000);
  const delay = Math.min(ceiling, floor * 2 ** Math.min(attempt, 12));
  // Positive jitter never shortens the server's requested cooldown.
  return Math.max(error instanceof RelayFailure ? error.retryAfterMs : 0, Math.ceil(delay * (1 + Math.random() * 0.25)));
}

export function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
