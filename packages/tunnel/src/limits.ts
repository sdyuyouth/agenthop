/** One binary WebSocket message is one frame. Chunks stay under this size. */
export const MAX_CHUNK = 64 * 1024;

/** Non-streaming request bodies larger than this are rejected. */
export const MAX_BODY = 1024 * 1024;

/** Room closes after this long with no frames and no HTTP. */
export const IDLE_MS = 10 * 60 * 1000;

export const MAX_CREATES_PER_MIN = 10;
/** Posts into one room per minute. Reading is not counted: the joining side polls once a second. */
export const MAX_POSTS_PER_MIN = 60;
export const MAX_MISSES_PER_MIN = 60;
export const RATE_WINDOW_MS = 60_000;

/** How long the relay waits for the host to start a response. */
export const RESPONSE_START_TIMEOUT_MS = 30_000;

export const REQUEST_HEADER_ALLOW = ["content-type", "accept", "a2a-version"] as const;
export const RESPONSE_HEADER_ALLOW = ["content-type"] as const;

export const CARD_PATH = "/.well-known/agent-card.json";
