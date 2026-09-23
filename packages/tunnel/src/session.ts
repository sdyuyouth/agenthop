import { isCardPath, rewriteAgentCard } from "./card.js";
import {
  assertSafePath,
  concat,
  decodeFrame,
  encodeFrame,
  filterRequestHeaders,
  splitChunks,
  type HeaderPair,
} from "./frame.js";
import { MAX_BODY, MAX_ROOM_BYTES, RESPONSE_START_TIMEOUT_MS } from "./limits.js";

export type ControlMessage =
  /** `token` proves a later socket is the same host. Older hosts send none. */
  | { v: 1; type: "open"; code: string; token?: string }
  | { v: 1; type: "ready"; publicBase: string }
  | { v: 1; type: "error"; code: "room_taken" | "invalid_code" | "unauthorized" | "rate_limited" };

export function encodeControl(message: ControlMessage): string {
  return JSON.stringify(message);
}

/** The hash a relay stores so a later socket can prove it is the same host. */
export async function tokenDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function decodeControl(text: string): ControlMessage {
  const value = JSON.parse(text) as ControlMessage;
  if (!value || value.v !== 1 || typeof value.type !== "string") throw new Error("bad_control");
  return value;
}

export class TunnelError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type ForwardRequest = {
  method: string;
  path: string;
  headers: Iterable<[string, string]>;
  body: ReadableStream<Uint8Array> | null;
};

export type ForwardResponse = {
  status: number;
  headers: HeaderPair[];
  body: ReadableStream<Uint8Array>;
};

type Pending = {
  start: Deferred<{ status: number; headers: HeaderPair[] }>;
  stream: ChunkStream;
  card: boolean;
  cardChunks: Uint8Array[];
  ended: Deferred<void>;
};

/**
 * Relay-side multiplexer. The host WebSocket is already open; this object
 * turns HTTP requests into frames and frames back into responses.
 */
export class RelaySession {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private failed = false;
  private spent = 0;

  constructor(
    private readonly send: (data: Uint8Array | string) => void,
    readonly publicBase: string,
    private readonly responseTimeoutMs = RESPONSE_START_TIMEOUT_MS,
    private readonly roomBytes = MAX_ROOM_BYTES,
  ) {}

  /** What this room has carried so far, both directions. */
  get bytes(): number {
    return this.spent;
  }

  forward(request: ForwardRequest): Promise<ForwardResponse> {
    assertSafePath(request.path);
    if (this.spent >= this.roomBytes) return Promise.reject(new TunnelError("room_quota"));
    const requestId = this.nextId++;
    const pending: Pending = {
      start: deferred(),
      stream: new ChunkStream(),
      card: isCardPath(request.path),
      cardChunks: [],
      ended: deferred(),
    };
    pending.ended.promise.catch(() => undefined);
    pending.start.promise.catch(() => undefined);
    this.pending.set(requestId, pending);
    return this.pump(requestId, request, pending);
  }

  onBinary(data: Uint8Array): void {
    const frame = decodeFrame(data);
    const pending = this.pending.get(frame.requestId);
    if (!pending) return;
    switch (frame.type) {
      case "response-start":
        pending.start.resolve({ status: frame.status, headers: frame.headers });
        break;
      case "response-body":
        this.spent += frame.body.byteLength;
        if (pending.card) pending.cardChunks.push(frame.body);
        else pending.stream.push(frame.body);
        break;
      case "response-end":
        pending.ended.resolve();
        if (!pending.card) {
          pending.stream.end();
          this.pending.delete(frame.requestId);
        }
        break;
      case "abort":
        pending.start.reject(new TunnelError("aborted"));
        pending.ended.reject(new TunnelError("aborted"));
        pending.stream.fail(new TunnelError("aborted"));
        this.pending.delete(frame.requestId);
        break;
      default:
        break;
    }
  }

  close(): void {
    this.failed = true;
    for (const pending of this.pending.values()) {
      pending.start.reject(new TunnelError("host_gone"));
      pending.ended.reject(new TunnelError("host_gone"));
      pending.stream.fail(new TunnelError("host_gone"));
    }
    this.pending.clear();
  }

  private async pump(requestId: number, request: ForwardRequest, pending: Pending): Promise<ForwardResponse> {
    try {
      this.send(
        encodeFrame({
          type: "request-start",
          requestId,
          method: request.method,
          path: request.path,
          headers: filterRequestHeaders(request.headers),
        }),
      );
      let total = 0;
      if (request.body) {
        const reader = request.body.getReader();
        while (true) {
          const step = await reader.read();
          if (step.done) break;
          total += step.value.byteLength;
          this.spent += step.value.byteLength;
          if (total > MAX_BODY) throw new TunnelError("body_too_large");
          if (this.spent > this.roomBytes) throw new TunnelError("room_quota");
          for (const chunk of splitChunks(step.value)) {
            this.send(encodeFrame({ type: "request-body", requestId, body: chunk }));
          }
        }
      }
      this.send(encodeFrame({ type: "request-end", requestId }));
      const started = await withTimeout(pending.start.promise, this.responseTimeoutMs);
      if (pending.card) {
        await withTimeout(pending.ended.promise, this.responseTimeoutMs);
        this.pending.delete(requestId);
        return finishCard(started, pending.cardChunks, this.publicBase);
      }
      return { status: started.status, headers: started.headers, body: pending.stream.stream() };
    } catch (error) {
      this.pending.delete(requestId);
      if (!this.failed) {
        try {
          this.send(encodeFrame({ type: "abort", requestId, reason: error instanceof Error ? error.message : "failed" }));
        } catch {
          // The socket may already be gone.
        }
      }
      throw error;
    }
  }
}

function finishCard(
  started: { status: number; headers: HeaderPair[] },
  chunks: Uint8Array[],
  publicBase: string,
): ForwardResponse {
  const stream = new ChunkStream();
  try {
    const rewritten = rewriteAgentCard(new TextDecoder().decode(concat(chunks)), publicBase);
    stream.push(new TextEncoder().encode(rewritten));
    stream.end();
    return {
      status: started.status,
      headers: [["content-type", "application/json"]],
      body: stream.stream(),
    };
  } catch {
    stream.push(new TextEncoder().encode("card rewrite failed"));
    stream.end();
    return {
      status: 502,
      headers: [["content-type", "text/plain; charset=utf-8"]],
      body: stream.stream(),
    };
  }
}

class ChunkStream {
  private readonly queue: Uint8Array[] = [];
  private waiting: ((chunk: Uint8Array | null) => void) | null = null;
  private closed = false;
  private error: Error | null = null;

  push(chunk: Uint8Array): void {
    if (this.closed) return;
    if (this.waiting) {
      const resume = this.waiting;
      this.waiting = null;
      resume(chunk);
    } else {
      this.queue.push(chunk);
    }
  }

  end(): void {
    this.closed = true;
    this.waiting?.(null);
    this.waiting = null;
  }

  fail(error: Error): void {
    this.error = error;
    this.end();
  }

  stream(): ReadableStream<Uint8Array> {
    return new ReadableStream({
      pull: (controller) =>
        this.take().then((chunk) => {
          if (this.error) controller.error(this.error);
          else if (chunk === null) controller.close();
          else controller.enqueue(chunk);
        }),
    });
  }

  private take(): Promise<Uint8Array | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TunnelError("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: Error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
