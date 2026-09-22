import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Room } from "./room.js";
import type { SessionEvent } from "./talk.js";

/** Run the operator's command for a peer message that has reached the head of the queue. */
export async function autoReply(room: Room, command: string, event: SessionEvent): Promise<void> {
  const text = commandOutput(command, event);
  if (text === undefined) return;
  try {
    if (event.event === "current") {
      await room.local({ id: randomUUID(), text, files: [], kind: "result", answerId: event.id });
      return;
    }
    await room.local({ id: randomUUID(), text, files: [], kind: "say" });
  } catch (error) {
    console.error(`on-receive could not reply to ${event.id}: ${error instanceof Error ? error.message : error}`);
  }
}

function commandOutput(command: string, event: SessionEvent): string | undefined {
  const payload = JSON.stringify({
    id: event.id,
    from: event.from,
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
