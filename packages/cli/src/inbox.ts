import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { contactByKey, inboxAddress, inboxToken, type Contact, type Identity } from "./identity.js";
import { InviteError, openInvitation, sealInvitation, type Invitation, type OpenedInvitation } from "./invite.js";
import { startHost, type RunningHost } from "./host.js";
import { sendMessage } from "./send.js";
import { oneLine, stamp } from "./session.js";

/**
 * The room invitations are delivered to. It is held open for as long as the MCP server runs, at
 * an address worked out from this machine's public key, so a contact can find it without being
 * told where it is. Nothing is ever said in it: an invitation carries a pairing code, and the
 * conversation happens in the room that code opens.
 */

/** An invitation older than this is refused: the room it names has most likely gone. */
export const INVITE_TTL_MS = 10 * 60_000;
/**
 * The relay closes a room after ten minutes without traffic, and an inbox can go much longer
 * than that without an invitation. A read of its own Agent Card through the relay counts.
 */
const KEEPALIVE_MS = 4 * 60_000;
const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 120_000;

export type Received = OpenedInvitation & { name: string };

export type InboxOptions = {
  home: string;
  identity: Identity;
  relay?: string;
  pass?: string;
  onInvitation: (invitation: Received) => void;
};

export type Inbox = {
  address: string;
  /** In words, for `status`: online, or why not. */
  state(): string;
  close(): Promise<void>;
};

export function startInbox(options: InboxOptions): Inbox {
  const { home, identity } = options;
  const address = inboxAddress(identity.publicKey);
  const log = path.join(home, "sessions", "inbox.log");
  const seen = new Set<string>();
  let host: RunningHost | undefined;
  let keepalive: NodeJS.Timeout | undefined;
  let closed = false;
  let state = "正在挂上";

  const note = (side: "local" | "peer", word: string, text = "") => {
    try {
      mkdirSync(path.dirname(log), { recursive: true });
      appendFileSync(log, `${stamp()} ${side} ${word}${text ? ` ${oneLine(text)}` : ""}\n`);
    } catch {
      // The log is for the person; failing to write it must not cost them an invitation.
    }
  };

  /** Everything that can be checked before the invitation is kept. The sender reads the reason. */
  const accept = (text: string): true | string => {
    let invitation: OpenedInvitation;
    try {
      invitation = openInvitation(identity, text);
    } catch (error) {
      return error instanceof InviteError ? error.message : "邀请解不开";
    }
    if (!contactByKey(home, invitation.from)) return "对方的联系人里没有你，邀请没有收下";
    if (Math.abs(Date.now() - invitation.at) > INVITE_TTL_MS) return "邀请已经过期了（超过十分钟，或者两边的时钟差得太多）";
    // Marked here rather than once it is kept: two copies in flight would both pass otherwise.
    if (seen.has(invitation.id)) return "这封邀请已经收过了";
    seen.add(invitation.id);
    return true;
  };

  async function open(): Promise<void> {
    let wait = FIRST_RETRY_MS;
    while (!closed) {
      try {
        const opened = await startHost({
          code: address,
          token: inboxToken(identity),
          serveQueue: false,
          relay: options.relay,
          pass: options.pass,
          home,
          // Only invitations come here, each one small, and the room lives as long as the server.
          limits: { messages: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER, textBytes: 16 * 1024 },
          recoverMs: Number.POSITIVE_INFINITY,
          accept,
          onRefused: (reason) => note("peer", "refused", reason),
          onEvent: (event) => {
            if (event.from !== "peer") return;
            let invitation: OpenedInvitation;
            try {
              invitation = openInvitation(identity, event.text);
            } catch {
              return;
            }
            const contact = contactByKey(home, invitation.from);
            if (!contact) return;
            note("peer", "invite", `${contact.name}：${invitation.background}`);
            options.onInvitation({ ...invitation, name: contact.name });
          },
          onReconnecting: (reason) => {
            state = `断开了（${reason}），正在接回来`;
          },
          onReconnected: () => {
            state = "在线";
          },
        });
        if (closed) {
          await opened.close();
          return;
        }
        host = opened;
        state = "在线";
        note("local", "online", address);
        keepalive = setInterval(() => void ping(opened), KEEPALIVE_MS);
        keepalive.unref();
        return;
      } catch (error) {
        state = `没挂上（${error instanceof Error ? error.message : String(error)}），${Math.round(wait / 1000)} 秒后再试`;
        await delay(wait);
        wait = Math.min(wait * 2, MAX_RETRY_MS);
      }
    }
  }

  async function ping(running: RunningHost): Promise<void> {
    try {
      await fetch(`${running.url}${AGENT_CARD_PATH}`, { headers: options.pass ? { authorization: `Bearer ${options.pass}` } : {} });
    } catch {
      // A missed keepalive is caught up by the host reopening the room.
    }
  }

  void open();

  return {
    address,
    state: () => state,
    async close() {
      if (closed) return;
      closed = true;
      if (keepalive) clearInterval(keepalive);
      await host?.close();
      host = undefined;
    },
  };
}

/**
 * Deliver an invitation to a contact's inbox. An inbox that is not there means the contact's
 * agent is not running agenthop right now; nothing is queued for later.
 */
export async function deliverInvitation(options: { sender: Identity; to: Contact; invitation: Invitation; relay?: string; pass?: string }): Promise<void> {
  const text = sealInvitation(options.sender, options.to.publicKey, options.invitation);
  try {
    await sendMessage({ code: inboxAddress(options.to.publicKey), text, relay: options.relay, pass: options.pass });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/\b404\b|not found/i.test(detail)) throw new Error(`${options.to.name} 现在不在线：它那边没有开着带 agenthop 的 agent。`);
    throw new Error(`邀请没有送到 ${options.to.name}：${detail}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
