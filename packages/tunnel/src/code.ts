import { WORDLIST } from "./wordlist.js";

const CODE_RE = /^[0-9]{4}-[a-z]{2,}-[a-z]{2,}-[a-z]{2,}$/;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** NFKC, trim, casefold, then treat spaces and hyphens as separators. */
export function normalizeCode(input: string): string {
  const folded = input.normalize("NFKC").trim().toLowerCase();
  return folded
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0)
    .join("-");
}

export function isValidCode(code: string): boolean {
  return CODE_RE.test(code);
}

export function generateCode(bytes: (n: number) => Uint8Array = randomBytes): string {
  const digits = (readUint(bytes(2)) % 10000).toString().padStart(4, "0");
  const words = [0, 1, 2].map(() => WORDLIST[readUint(bytes(2)) % WORDLIST.length]!);
  return `${digits}-${words[0]}-${words[1]}-${words[2]}`;
}

/** SHA-256 of the normalized code, first 10 bytes, lowercase base32. */
export async function roomIdFromCode(code: string): Promise<string> {
  const normalized = normalizeCode(code);
  if (!isValidCode(normalized)) {
    throw new Error("invalid_code");
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized)),
  );
  return base32(digest.subarray(0, 10));
}

export function rateShard(ip: string): string {
  let hash = 2166136261;
  for (let i = 0; i < ip.length; i++) {
    hash ^= ip.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `shard-${(hash >>> 0) % 32}`;
}

export function safeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export function relayEndpoints(relayHttp: string, code: string): { publicBase: string; hostUrl: string } {
  const normalized = normalizeCode(code);
  const url = new URL(relayHttp);
  const publicBase = `${url.origin}/r/${encodeURIComponent(normalized)}/`;
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/host/${encodeURIComponent(normalized)}`;
  url.search = "";
  url.hash = "";
  return { publicBase, hostUrl: url.toString() };
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function readUint(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = (value * 256 + byte) >>> 0;
  return value;
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let out = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}
