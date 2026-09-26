import { createCipheriv, createDecipheriv, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { agree, type Identity } from "./identity.js";

/**
 * An invitation: a fresh pairing code, sealed so that only the contact it is addressed to can
 * open it, and so that opening it proves who sent it.
 *
 * The shape is the first message of Noise IK. The sender makes a throwaway key pair `e`. Its own
 * public key goes under a key from DH(e, recipient), so the relay — which sees every invitation
 * go by — cannot tell who is inviting whom. The body goes under a key from DH(e, recipient) and
 * DH(sender, recipient) together; only the real sender can work out the second, so a body that
 * opens is one that sender wrote.
 */

export type Invitation = {
  /** The pairing code of a room opened for this invitation alone. */
  code: string;
  background: string;
  /** Milliseconds since the epoch, as the sender's clock had it. */
  at: number;
  id: string;
};

export type OpenedInvitation = Invitation & { from: string };

/** Why an invitation was not taken. The sender reads it. */
export class InviteError extends Error {}

export const INVITE_PREFIX = "[[agenthop:invite]] ";
const AAD = Buffer.from("agenthop-invite-v1");
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SENDER_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES;

export function sealInvitation(sender: Identity, recipient: string, invitation: Invitation): string {
  const ephemeral = generateKeyPairSync("x25519");
  const e = Buffer.from(ephemeral.publicKey.export({ format: "jwk" }).x!, "base64url");
  const r = Buffer.from(recipient, "base64url");
  const s = Buffer.from(sender.publicKey, "base64url");
  const es = agree(ephemeral.privateKey, recipient);
  const ss = agree(sender, recipient);
  const sealedSender = seal(derive(es, Buffer.concat([e, r]), "agenthop invite sender v1"), s);
  const body = seal(derive(Buffer.concat([es, ss]), Buffer.concat([e, r, s]), "agenthop invite body v1"), Buffer.from(JSON.stringify(invitation)));
  return INVITE_PREFIX + Buffer.concat([e, sealedSender, body]).toString("base64url");
}

export function openInvitation(recipient: Identity, text: string): OpenedInvitation {
  if (!text.startsWith(INVITE_PREFIX)) throw new InviteError("这不是一封邀请");
  const raw = Buffer.from(text.slice(INVITE_PREFIX.length), "base64url");
  if (raw.byteLength < KEY_BYTES + SENDER_BYTES + NONCE_BYTES + TAG_BYTES) throw new InviteError("邀请不完整");
  const e = raw.subarray(0, KEY_BYTES);
  const r = Buffer.from(recipient.publicKey, "base64url");
  let es: Buffer;
  try {
    es = agree(recipient, e.toString("base64url"));
  } catch {
    throw new InviteError("邀请解不开");
  }
  const s = open(derive(es, Buffer.concat([e, r]), "agenthop invite sender v1"), raw.subarray(KEY_BYTES, KEY_BYTES + SENDER_BYTES));
  const from = s.toString("base64url");
  let ss: Buffer;
  try {
    ss = agree(recipient, from);
  } catch {
    throw new InviteError("邀请解不开");
  }
  const body = open(derive(Buffer.concat([es, ss]), Buffer.concat([e, r, s]), "agenthop invite body v1"), raw.subarray(KEY_BYTES + SENDER_BYTES));
  let invitation: Partial<Invitation>;
  try {
    invitation = JSON.parse(body.toString("utf8")) as Partial<Invitation>;
  } catch {
    throw new InviteError("邀请的内容不对");
  }
  if (typeof invitation.code !== "string" || typeof invitation.background !== "string" || typeof invitation.at !== "number" || typeof invitation.id !== "string") {
    throw new InviteError("邀请的内容不对");
  }
  return { code: invitation.code, background: invitation.background, at: invitation.at, id: invitation.id, from };
}

function derive(secret: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, salt, info, 32));
}

function seal(key: Buffer, plain: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function open(key: Buffer, raw: Buffer): Buffer {
  if (raw.byteLength < NONCE_BYTES + TAG_BYTES) throw new InviteError("邀请不完整");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, NONCE_BYTES));
  decipher.setAAD(AAD);
  decipher.setAuthTag(raw.subarray(raw.byteLength - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES, raw.byteLength - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new InviteError("邀请解不开");
  }
}
