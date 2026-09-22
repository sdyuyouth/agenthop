import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Room } from "./room.js";
import type { SessionEvent } from "./talk.js";

/** A message from the other side. Queued lines stay in the log until they reach the head. */
export function isInbound(event: SessionEvent, seat: "host" | "join"): boolean {
  if (event.event === "queued") return false;
  return event.from === (seat === "host" ? "peer" : "host");
}

/** Run the command. Empty stdout or a non-zero exit sends nothing, so the other side is not answered by accident. */
export async function autoReply(
  command: string,
  event: SessionEvent,
  respond: (text: string) => Promise<void>,
): Promise<void> {
  const text = commandOutput(command, event);
  if (!text) return;
  try {
    await respond(text);
  } catch (error) {
    console.error(`on-receive could not reply to ${event.id}: ${error instanceof Error ? error.message : error}`);
  }
}

export async function replyOnHost(room: Room, event: SessionEvent, text: string): Promise<void> {
  const id = randomUUID();
  if (event.event === "current") {
    await room.local({ id, text, files: [], kind: "result", answerId: event.id });
    return;
  }
  await room.local({ id, text, files: [], kind: "say" });
}

/** Start the agent with one session-log line. Empty output or a non-zero exit means it chose not to reply. */
export function runAgent(command: string, line: string): string | undefined {
  const result = spawnSync(command, {
    input: line.endsWith("\n") ? line : `${line}\n`,
    encoding: "utf8",
    shell: true,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "").trim();
    console.error(`agent exited ${result.status ?? "signal"}${detail ? `: ${detail}` : ""}`);
    return undefined;
  }
  const output = result.stdout ?? "";
  return output.endsWith("\r\n") ? output.slice(0, -2) : output.endsWith("\n") ? output.slice(0, -1) : output;
}

function commandOutput(command: string, event: SessionEvent): string | undefined {
  const payload = JSON.stringify({
    at: event.at,
    id: event.id,
    from: event.from,
    event: event.event,
    text: event.text,
    files: event.files.map((file) => file.path),
  });
  const result = spawnSync(command, {
    input: payload,
    encoding: "utf8",
    shell: true,
    env: { ...process.env, AGENTHOP_MSG_ID: event.id },
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "").trim();
    console.error(`on-receive exited ${result.status ?? "signal"}${detail ? `: ${detail}` : ""}`);
    return undefined;
  }
  const output = result.stdout ?? "";
  return output.endsWith("\r\n") ? output.slice(0, -2) : output.endsWith("\n") ? output.slice(0, -1) : output;
}
