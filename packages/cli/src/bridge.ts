import {
  decodeFrame,
  encodeFrame,
  filterResponseHeaders,
  type Frame,
} from "@agenthop/tunnel";

type Inflight = { method: string; path: string; headers: [string, string][]; body: Uint8Array[] };

/** Speaks the tunnel from the host side and calls the local A2A server. */
export class HostBridge {
  private readonly inflight = new Map<number, Inflight>();

  constructor(
    private readonly localBase: string,
    private readonly send: (frame: Uint8Array) => void,
  ) {}

  onFrame(bytes: Uint8Array): void {
    const frame = decodeFrame(bytes);
    if (frame.type === "request-start") {
      this.inflight.set(frame.requestId, { method: frame.method, path: frame.path, headers: frame.headers, body: [] });
      return;
    }
    const current = this.inflight.get(frame.requestId);
    if (!current) return;
    if (frame.type === "request-body") {
      current.body.push(frame.body);
      return;
    }
    if (frame.type === "abort") {
      this.inflight.delete(frame.requestId);
      return;
    }
    if (frame.type === "request-end") {
      this.inflight.delete(frame.requestId);
      void this.respond(frame.requestId, current);
    }
  }

  private async respond(requestId: number, request: Inflight): Promise<void> {
    try {
      const body = concat(request.body);
      const response = await fetch(`${this.localBase}${request.path}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" || body.byteLength === 0 ? undefined : Buffer.from(body),
      });
      this.send(
        encodeFrame({
          type: "response-start",
          requestId,
          status: response.status,
          headers: filterResponseHeaders(response.headers),
        }),
      );
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const step = await reader.read();
          if (step.done) break;
          for (const chunk of split(step.value)) {
            this.send(encodeFrame({ type: "response-body", requestId, body: chunk }));
          }
        }
      }
      this.send(encodeFrame({ type: "response-end", requestId }));
    } catch (error) {
      this.send(
        encodeFrame({
          type: "abort",
          requestId,
          reason: error instanceof Error ? error.message : "failed",
        }),
      );
    }
  }
}

function split(bytes: Uint8Array): Uint8Array[] {
  const size = 64 * 1024;
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    out.push(bytes.subarray(offset, offset + size));
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export type { Frame };
