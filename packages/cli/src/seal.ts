import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { splitCode } from "@agenthop/tunnel";

/**
 * The conversation is sealed inside the message body, above everything the relay reads. The
 * relay still routes on the path, still rewrites the Agent Card, still counts bytes — it just
 * cannot read a word of what it is carrying.
 *
 * The key comes from the secret half of the pairing code, which never reaches the relay. Each
 * direction gets its own key, so a message cannot be reflected back at the side that sent it.
 */

export type Seat = "create" | "join";

/** A line that did not come from someone holding the secret, or did not survive the trip. */
export class SealError extends Error {}

const PREFIX = "[[agenthop:sealed]] ";
const AAD = Buffer.from("agenthop-sealed-v1");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const COUNTER_BYTES = 4;

export type Opened = { counter: number; wire: string };

export type Channel = {
  /** Wrap one wire line. Each call spends the next counter. */
  seal(wire: string): string;
  /** Unwrap one line. Pure: the same ciphertext opens the same way every time. */
  open(text: string): Opened;
  /** Whether this counter is newer than every one seen before. Stateful, unlike `open`. */
  fresh(counter: number): boolean;
};

export function deriveKeys(code: string, seat: Seat): { tx: Buffer; rx: Buffer } {
  const { address, secret } = splitCode(code);
  const toJoin = derive(secret, address, "agenthop v1 create->join");
  const toCreate = derive(secret, address, "agenthop v1 join->create");
  return seat === "create" ? { tx: toJoin, rx: toCreate } : { tx: toCreate, rx: toJoin };
}

export function channel(code: string, seat: Seat): Channel {
  const { tx, rx } = deriveKeys(code, seat);
  let sent = 0;
  let seen = 0;
  return {
    seal(wire: string): string {
      sent += 1;
      const counter = Buffer.alloc(COUNTER_BYTES);
      counter.writeUInt32BE(sent);
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", tx, nonce);
      cipher.setAAD(AAD);
      const body = Buffer.concat([cipher.update(Buffer.concat([counter, Buffer.from(wire, "utf8")])), cipher.final()]);
      return PREFIX + Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64url");
    },
    open(text: string): Opened {
      if (!text.startsWith(PREFIX)) throw new SealError("not_sealed");
      const raw = Buffer.from(text.slice(PREFIX.length), "base64url");
      if (raw.byteLength < NONCE_BYTES + TAG_BYTES + COUNTER_BYTES) throw new SealError("too_short");
      const decipher = createDecipheriv("aes-256-gcm", rx, raw.subarray(0, NONCE_BYTES));
      decipher.setAAD(AAD);
      decipher.setAuthTag(raw.subarray(raw.byteLength - TAG_BYTES));
      let plain: Buffer;
      try {
        plain = Buffer.concat([
          decipher.update(raw.subarray(NONCE_BYTES, raw.byteLength - TAG_BYTES)),
          decipher.final(),
        ]);
      } catch {
        throw new SealError("bad_seal");
      }
      return { counter: plain.readUInt32BE(0), wire: plain.subarray(COUNTER_BYTES).toString("utf8") };
    },
    fresh(counter: number): boolean {
      // Strictly increasing, not consecutive: a send that fails spends a counter and is written
      // down as undelivered, so gaps are ordinary and only a repeat is a replay.
      if (counter <= seen) return false;
      seen = counter;
      return true;
    },
  };
}

/**
 * HKDF over the secret as it is written, rather than the bytes behind it. There is no base32
 * decoder to get wrong, and an odd spelling of the secret derives a different key and fails to
 * open — which is a clear error — instead of colliding with the real one.
 *
 * The salt is the room address rather than the room id, because the room id needs an async
 * digest and the address determines it anyway. Staying synchronous is what lets `accept` decide
 * about a line before anything is stored.
 */
function derive(secret: string, address: string, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, address, info, 32));
}
