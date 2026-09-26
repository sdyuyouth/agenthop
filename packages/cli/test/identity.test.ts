import { statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isRoomAddress } from "@agenthop/tunnel";
import {
  fingerprint,
  forgetContact,
  identityPath,
  inboxAddress,
  inboxToken,
  loadContacts,
  loadIdentity,
  saveContact,
} from "../src/identity.js";
import { INVITE_PREFIX, InviteError, openInvitation, sealInvitation, type Invitation } from "../src/invite.js";

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agenthop-identity-"));
}

const invitation: Invitation = { code: "1234-amber-river-maple-k7f3q2mbxz4a6tu5wnhjy2pc3d", background: "看一下分页", at: 1_700_000_000_000, id: "abc" };

describe("identity", () => {
  it("is made once, kept private, and read back the same", async () => {
    const dir = await home();
    const first = loadIdentity(dir);
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== "win32") expect(statSync(identityPath(dir)).mode & 0o777).toBe(0o600);
    expect(loadIdentity(dir)).toEqual(first);
    expect(loadIdentity(await home()).publicKey).not.toBe(first.publicKey);
  });

  it("has a fingerprint short enough to read aloud", async () => {
    const { publicKey } = loadIdentity(await home());
    expect(fingerprint(publicKey)).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
    expect(fingerprint(publicKey)).toBe(fingerprint(publicKey));
  });

  it("has an inbox the relay takes for an ordinary room, the same every time", async () => {
    for (let i = 0; i < 50; i++) {
      const identity = loadIdentity(await home());
      const address = inboxAddress(identity.publicKey);
      expect(isRoomAddress(address), address).toBe(true);
      expect(inboxAddress(identity.publicKey)).toBe(address);
      expect(inboxToken(identity)).toBe(inboxToken(identity));
    }
  });
});

describe("contacts", () => {
  it("keeps a name for a key, and will not hand a name to someone else", async () => {
    const dir = await home();
    const alice = loadIdentity(await home()).publicKey;
    const mallory = loadIdentity(await home()).publicKey;
    const saved = saveContact(dir, " alice ", alice);
    expect(typeof saved === "object" && saved.saved.name).toBe("alice");
    if (process.platform !== "win32") expect(statSync(path.join(dir, "contacts.json")).mode & 0o777).toBe(0o600);
    expect(saveContact(dir, "alice", mallory)).toMatch(/已经是另一个人了/);
    expect(loadContacts(dir).map((contact) => contact.publicKey)).toEqual([alice]);

    // The same person under a new name is a rename, not a second contact.
    const renamed = saveContact(dir, "Alice 的电脑", alice);
    expect(typeof renamed === "object" && renamed.renamedFrom).toBe("alice");
    expect(loadContacts(dir).map((contact) => contact.name)).toEqual(["Alice 的电脑"]);

    expect(saveContact(dir, "两行\n名字", mallory)).toMatch(/不能换行/);
    expect(forgetContact(dir, "Alice 的电脑")?.publicKey).toBe(alice);
    expect(loadContacts(dir)).toEqual([]);
  });
});

describe("invitations", () => {
  it("open for the contact they were sealed to, and say who sent them", async () => {
    const sender = loadIdentity(await home());
    const recipient = loadIdentity(await home());
    const opened = openInvitation(recipient, sealInvitation(sender, recipient.publicKey, invitation));
    expect(opened).toEqual({ ...invitation, from: sender.publicKey });
  });

  it("do not show the relay who is inviting", async () => {
    const sender = loadIdentity(await home());
    const recipient = loadIdentity(await home());
    const sealed = sealInvitation(sender, recipient.publicKey, invitation);
    const bytes = Buffer.from(sealed.slice(INVITE_PREFIX.length), "base64url");
    expect(bytes.includes(Buffer.from(sender.publicKey, "base64url"))).toBe(false);
    expect(sealed).not.toContain(sender.publicKey);
    expect(sealed).not.toContain(invitation.code);
  });

  it("do not open for anyone else, or once a byte has changed", async () => {
    const sender = loadIdentity(await home());
    const recipient = loadIdentity(await home());
    const other = loadIdentity(await home());
    const sealed = sealInvitation(sender, recipient.publicKey, invitation);
    expect(() => openInvitation(other, sealed)).toThrow(InviteError);
    const bytes = Buffer.from(sealed.slice(INVITE_PREFIX.length), "base64url");
    for (const at of [0, 40, 100, bytes.byteLength - 1]) {
      const bent = Buffer.from(bytes);
      bent[at] = bent[at]! ^ 1;
      expect(() => openInvitation(recipient, INVITE_PREFIX + bent.toString("base64url")), `byte ${at}`).toThrow(InviteError);
    }
    expect(() => openInvitation(recipient, "[[agenthop:say]] hi")).toThrow(InviteError);
  });

  it("cannot be forged by someone who knows both public keys", async () => {
    const sender = loadIdentity(await home());
    const recipient = loadIdentity(await home());
    const forger = loadIdentity(await home());
    // The forger can seal its own name, but not under the key only the real sender can make.
    const forged = sealInvitation({ publicKey: sender.publicKey, privateKey: forger.privateKey }, recipient.publicKey, invitation);
    expect(() => openInvitation(recipient, forged)).toThrow(InviteError);
  });
});
