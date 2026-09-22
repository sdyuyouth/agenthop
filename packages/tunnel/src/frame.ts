import { MAX_CHUNK, REQUEST_HEADER_ALLOW, RESPONSE_HEADER_ALLOW } from "./limits.js";

export type HeaderPair = [string, string];

export type Frame =
  | { type: "request-start"; requestId: number; method: string; path: string; headers: HeaderPair[] }
  | { type: "request-body"; requestId: number; body: Uint8Array }
  | { type: "request-end"; requestId: number }
  | { type: "response-start"; requestId: number; status: number; headers: HeaderPair[] }
  | { type: "response-body"; requestId: number; body: Uint8Array }
  | { type: "response-end"; requestId: number }
  | { type: "abort"; requestId: number; reason: string };

const TYPE_TO_ID = {
  "request-start": 1,
  "request-body": 2,
  "request-end": 3,
  "response-start": 4,
  "response-body": 5,
  "response-end": 6,
  abort: 7,
} as const;

export function encodeFrame(frame: Frame): Uint8Array {
  const parts: Uint8Array[] = [u8(TYPE_TO_ID[frame.type]), u32(frame.requestId)];
  switch (frame.type) {
    case "request-start":
      parts.push(bytes8(frame.method), bytes16(frame.path), headers(frame.headers));
      break;
    case "response-start":
      parts.push(u16(frame.status), headers(frame.headers));
      break;
    case "request-body":
    case "response-body":
      if (frame.body.byteLength > MAX_CHUNK) throw new Error("chunk_too_large");
      parts.push(u32(frame.body.byteLength), frame.body);
      break;
    case "request-end":
    case "response-end":
      break;
    case "abort":
      parts.push(bytes16(frame.reason));
      break;
  }
  return concat(parts);
}

export function decodeFrame(input: Uint8Array): Frame {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let offset = 0;
  const take = (n: number): Uint8Array => {
    if (offset + n > input.byteLength) throw new Error("truncated_frame");
    const slice = input.subarray(offset, offset + n);
    offset += n;
    return slice;
  };
  const typeId = take(1)[0]!;
  const requestId = view.getUint32(offset);
  offset += 4;
  switch (typeId) {
    case 1: {
      const method = text8(input, () => offset, (n) => (offset = n));
      const path = text16(input, () => offset, (n) => (offset = n));
      const headerList = readHeaders(input, view, () => offset, (n) => (offset = n));
      return { type: "request-start", requestId, method, path, headers: headerList };
    }
    case 4: {
      const status = view.getUint16(offset);
      offset += 2;
      const headerList = readHeaders(input, view, () => offset, (n) => (offset = n));
      return { type: "response-start", requestId, status, headers: headerList };
    }
    case 2:
    case 5: {
      const length = view.getUint32(offset);
      offset += 4;
      if (length > MAX_CHUNK) throw new Error("chunk_too_large");
      const body = take(length);
      return {
        type: typeId === 2 ? "request-body" : "response-body",
        requestId,
        body: copy(body),
      };
    }
    case 3:
      return { type: "request-end", requestId };
    case 6:
      return { type: "response-end", requestId };
    case 7: {
      const reason = text16(input, () => offset, (n) => (offset = n));
      return { type: "abort", requestId, reason };
    }
    default:
      throw new Error("unknown_frame");
  }
}

export function filterHeaders(headers: Iterable<[string, string]>, allow: readonly string[]): HeaderPair[] {
  const allowed = new Set(allow);
  const out: HeaderPair[] = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (allowed.has(lower)) out.push([lower, value]);
  }
  return out;
}

export function filterRequestHeaders(headers: Iterable<[string, string]>): HeaderPair[] {
  return filterHeaders(headers, REQUEST_HEADER_ALLOW);
}

export function filterResponseHeaders(headers: Iterable<[string, string]>): HeaderPair[] {
  return filterHeaders(headers, RESPONSE_HEADER_ALLOW);
}

export function assertSafePath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("bad_path");
  const pathname = path.split("?")[0] ?? path;
  if (pathname.split("/").includes("..")) throw new Error("bad_path");
}

export function splitChunks(bytes: Uint8Array, size = MAX_CHUNK): Uint8Array[] {
  if (bytes.byteLength === 0) return [];
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    out.push(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
  }
  return out;
}

function text8(input: Uint8Array, get: () => number, set: (n: number) => void): string {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let offset = get();
  const length = view.getUint8(offset);
  offset += 1;
  const bytes = input.subarray(offset, offset + length);
  if (bytes.byteLength !== length) throw new Error("truncated_frame");
  set(offset + length);
  return new TextDecoder().decode(bytes);
}

function text16(input: Uint8Array, get: () => number, set: (n: number) => void): string {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let offset = get();
  const length = view.getUint16(offset);
  offset += 2;
  const bytes = input.subarray(offset, offset + length);
  if (bytes.byteLength !== length) throw new Error("truncated_frame");
  set(offset + length);
  return new TextDecoder().decode(bytes);
}

function readHeaders(
  input: Uint8Array,
  view: DataView,
  get: () => number,
  set: (n: number) => void,
): HeaderPair[] {
  let offset = get();
  const count = view.getUint16(offset);
  offset += 2;
  set(offset);
  const headers: HeaderPair[] = [];
  for (let i = 0; i < count; i++) {
    const name = text16(input, get, set);
    const value = text16(input, get, set);
    headers.push([name, value]);
  }
  return headers;
}

function headers(list: HeaderPair[]): Uint8Array {
  const parts = [u16(list.length)];
  for (const [name, value] of list) parts.push(bytes16(name), bytes16(value));
  return concat(parts);
}

function bytes8(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (body.byteLength > 255) throw new Error("field_too_long");
  return concat([u8(body.byteLength), body]);
}

function bytes16(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (body.byteLength > 65535) throw new Error("field_too_long");
  return concat([u16(body.byteLength), body]);
}

function u8(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff);
}

function u16(n: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n);
  return out;
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

function copy(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
