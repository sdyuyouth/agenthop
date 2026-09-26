import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRoomAddress, WORDLIST } from "@agenthop/tunnel";

/**
 * Who this machine is, and who it knows. A conversation by pairing code proves that both sides
 * held the code; it says nothing about who they are. An identity is a long-lived X25519 key
 * pair, exchanged inside every conversation, so the second conversation with the same person
 * can say "this is alice" — and so alice can be asked for one by name, with no code handed over.
 *
 * Contacts are trusted on first use: the key saved is the key that turned up in the conversation
 * the name was given in. The fingerprint is there for anyone who wants to check it another way.
 */

export type Identity = {
  /** Raw 32-byte X25519 public key, base64url. This is what the other side learns. */
  publicKey: string;
  /** Raw 32-byte private scalar, base64url. Never leaves this file and this process. */
  privateKey: string;
};

export type Contact = { name: string; publicKey: string; added: string };

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A public key as it travels: 32 bytes of base64url, nothing else. */
export function isPublicKey(text: string): boolean {
  return KEY_RE.test(text) && Buffer.from(text, "base64url").byteLength === 32;
}

export function identityPath(home: string): string {
  return path.join(home, "identity.json");
}

/** This home's identity, made the first time it is asked for. */
export function loadIdentity(home: string): Identity {
  const file = identityPath(home);
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, "utf8")) as Partial<Identity>;
    if (typeof stored.publicKey === "string" && typeof stored.privateKey === "string" && isPublicKey(stored.publicKey)) {
      return { publicKey: stored.publicKey, privateKey: stored.privateKey };
    }
    throw new Error(`${file} 不是一个有效的身份文件。挪走它，下次会生成一个新的（原来的联系人要重新互存）。`);
  }
  const pair = generateKeyPairSync("x25519");
  const jwk = pair.privateKey.export({ format: "jwk" });
  const identity: Identity = { publicKey: jwk.x!, privateKey: jwk.d! };
  writePrivate(file, `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}

/** SHA-256 of the public key, first 10 bytes, base32 in groups of four: short enough to read aloud. */
export function fingerprint(publicKey: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest();
  return base32(digest.subarray(0, 10)).match(/.{4}/g)!.join("-");
}

/** X25519 between one of our keys and one of theirs. Throws on a key that makes no secret. */
export function agree(own: Identity | KeyObject, publicKey: string): Buffer {
  return diffieHellman({ privateKey: "privateKey" in own ? privateKeyObject(own) : own, publicKey: publicKeyObject(publicKey) });
}

function privateKeyObject(identity: Identity): KeyObject {
  return createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: identity.privateKey, x: identity.publicKey }, format: "jwk" });
}

function publicKeyObject(publicKey: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: publicKey }, format: "jwk" });
}

/**
 * Where invitations for this key are delivered: an ordinary room address, worked out from the
 * public key alone. The relay needs no change — to it this is one more room — and anyone who
 * can reach it already knows the key, which only people this machine has talked to do.
 */
export function inboxAddress(publicKey: string): string {
  for (let round = 0; ; round++) {
    const bytes = Buffer.from(hkdfSync("sha256", Buffer.from(publicKey, "base64url"), Buffer.alloc(0), `agenthop inbox v1 ${round}`, 8));
    const digits = String(bytes.readUInt16BE(0) % 10000).padStart(4, "0");
    const words = [2, 4, 6].map((at) => WORDLIST[bytes.readUInt16BE(at) % WORDLIST.length]!);
    const address = `${digits}-${words.join("-")}`;
    if (isRoomAddress(address)) return address;
  }
}

/**
 * The token that holds the inbox room at the relay. It comes from the private key rather than
 * from chance, so a restarted process can take its room straight back instead of being told it
 * is taken until the old claim runs out.
 */
export function inboxToken(identity: Identity): string {
  return Buffer.from(hkdfSync("sha256", Buffer.from(identity.privateKey, "base64url"), Buffer.alloc(0), "agenthop inbox token v1", 32)).toString("base64url");
}

export function contactsPath(home: string): string {
  return path.join(home, "contacts.json");
}

export function loadContacts(home: string): Contact[] {
  const file = contactsPath(home);
  if (!existsSync(file)) return [];
  const stored = JSON.parse(readFileSync(file, "utf8")) as { contacts?: unknown };
  if (!Array.isArray(stored.contacts)) return [];
  return stored.contacts.filter(
    (contact): contact is Contact =>
      typeof contact === "object" && contact !== null && typeof contact.name === "string" && typeof contact.publicKey === "string" && isPublicKey(contact.publicKey),
  );
}

function storeContacts(home: string, contacts: Contact[]): void {
  writePrivate(contactsPath(home), `${JSON.stringify({ contacts }, null, 2)}\n`);
}

/** A name as it is kept and looked up: trimmed, one line, not too long to read. */
export function contactName(name: string): string | undefined {
  const cleaned = name.normalize("NFKC").trim();
  if (!cleaned || cleaned.length > 40 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(cleaned)) return undefined;
  return cleaned;
}

export function findContact(home: string, name: string): Contact | undefined {
  const wanted = contactName(name);
  return wanted ? loadContacts(home).find((contact) => contact.name === wanted) : undefined;
}

export function contactByKey(home: string, publicKey: string): Contact | undefined {
  return loadContacts(home).find((contact) => contact.publicKey === publicKey);
}

/** Keep `publicKey` under `name`. A name already given to someone else is not taken from them. */
export function saveContact(home: string, name: string, publicKey: string): { saved: Contact; renamedFrom?: string } | string {
  const cleaned = contactName(name);
  if (!cleaned) return "名字不能为空、不能换行，最长 40 个字。";
  if (!isPublicKey(publicKey)) return "对方的身份不是一个有效的公钥。";
  const contacts = loadContacts(home);
  const holder = contacts.find((contact) => contact.name === cleaned);
  if (holder && holder.publicKey !== publicKey) {
    return `"${cleaned}" 已经是另一个人了（指纹 ${fingerprint(holder.publicKey)}）。换一个名字，或者先 forget 掉原来那个。`;
  }
  if (holder) return { saved: holder };
  const previous = contacts.find((contact) => contact.publicKey === publicKey);
  const saved: Contact = { name: cleaned, publicKey, added: previous?.added ?? new Date().toISOString() };
  storeContacts(home, [...contacts.filter((contact) => contact.publicKey !== publicKey), saved]);
  return { saved, renamedFrom: previous?.name };
}

export function forgetContact(home: string, name: string): Contact | undefined {
  const contacts = loadContacts(home);
  const gone = contacts.find((contact) => contact.name === contactName(name));
  if (gone) storeContacts(home, contacts.filter((contact) => contact !== gone));
  return gone;
}

/** Only this user may read it; written whole, so a crash leaves the old file rather than half a new one. */
function writePrivate(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const next = `${file}.new`;
  writeFileSync(next, text, { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, file);
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
