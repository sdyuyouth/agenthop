import { WORDLIST } from "./wordlist.js";

/**
 * A pairing code is an address and a secret: `4821-amber-river-maple-k7f3q2mbxz4a6tu5wnhjy2pc3d`.
 * The address is what the relay routes on. The secret is the key to the conversation and must
 * never reach the relay, so the two halves are kept apart by type as well as by convention.
 */
const ADDRESS_RE = /^[0-9]{4}-[a-z]{2,}-[a-z]{2,}-[a-z]{2,}$/;
const CODE_RE = /^[0-9]{4}-[a-z]{2,}-[a-z]{2,}-[a-z]{2,}-[a-z2-7]{26}$/;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** 16 bytes of base32 is 26 characters, so the secret is exactly one more segment. */
const SECRET_BYTES = 16;

/** NFKC, trim, casefold, then treat spaces and hyphens as separators. */
export function normalizeCode(input: string): string {
  const folded = input.normalize("NFKC").trim().toLowerCase();
  return folded
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0)
    .join("-");
}

/** The half the relay is allowed to see: four segments, no secret. */
export function isRoomAddress(code: string): boolean {
  return ADDRESS_RE.test(code);
}

/** A whole pairing code, both halves. */
export function isPairingCode(code: string): boolean {
  return CODE_RE.test(code);
}

export function splitCode(code: string): { address: string; secret: string } {
  const normalized = normalizeCode(code);
  if (!isPairingCode(normalized)) throw new Error("invalid_code");
  const cut = normalized.lastIndexOf("-");
  return { address: normalized.slice(0, cut), secret: normalized.slice(cut + 1) };
}

/** The address of a whole code, or an address handed straight back. Anything else is a mistake. */
export function addressOf(code: string): string {
  const normalized = normalizeCode(code);
  if (isRoomAddress(normalized)) return normalized;
  return splitCode(normalized).address;
}

export function secretOf(code: string): string {
  return splitCode(code).secret;
}

export function generateCode(bytes: (n: number) => Uint8Array = randomBytes): string {
  for (;;) {
    const digits = (readUint(bytes(2)) % 10000).toString().padStart(4, "0");
    const words = [0, 1, 2].map(() => WORDLIST[readUint(bytes(2)) % WORDLIST.length]!);
    const code = `${digits}-${words[0]}-${words[1]}-${words[2]}-${base32(bytes(SECRET_BYTES))}`;
    // Never hand out a code the relay would turn away. A single word with a hyphen in it once
    // made one session in four hundred dead on arrival.
    if (isPairingCode(code)) return code;
  }
}

/** SHA-256 of the room address, first 10 bytes, lowercase base32. */
export async function roomIdFromCode(address: string): Promise<string> {
  const normalized = normalizeCode(address);
  // A whole code is refused rather than trimmed: reaching here with the secret still attached
  // means a caller is about to put it somewhere the relay can see.
  if (!isRoomAddress(normalized)) {
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
  // Both URLs go to the relay, so only the address may go into them. Stripping here as well as
  // at the caller means a future caller that passes a whole code still cannot leak the secret.
  const normalized = addressOf(code);
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
