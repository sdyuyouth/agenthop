import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { addressOf } from "@agenthop/tunnel";
import { lineQueue, runSession, sessionPath, type SessionOptions } from "../src/session.js";

/**
 * A session that dies early leaves nothing in the log, and waiting for a line it will never
 * write reports a timeout instead of the reason. Keep the reason.
 */
export const failures: unknown[] = [];

export function resetFailures(): void {
  failures.length = 0;
}

export function start(options: SessionOptions): Promise<void> {
  return runSession(options).catch((error) => {
    failures.push(error);
  });
}

/**
 * Wait for a line containing `text` in any log under `home`. Returns the whole pairing code,
 * read off the line the creator prints it on — the file is named after the room address alone.
 */
export async function waitForText(home: string, text: string, ms = 20_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (failures.length > 0) throw new Error(`session stopped: ${failures[0] instanceof Error ? failures[0].stack : failures[0]}`);
    let files: string[] = [];
    try {
      files = await readdir(path.join(home, "sessions"));
    } catch {
      files = [];
    }
    for (const file of files) {
      const body = await readFile(path.join(home, "sessions", file), "utf8");
      const line = body.split("\n").find((candidate) => candidate.includes(text));
      if (line) return body.match(/ local waiting (\S+)/)?.[1] ?? "";
    }
    await delay(50);
  }
  throw new Error(`${text} did not arrive in ${home}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type Pair = {
  code: string;
  creator: Promise<void>;
  joiner: Promise<void>;
  creatorLines: ReturnType<typeof lineQueue>;
  joinerLines: ReturnType<typeof lineQueue>;
  creatorHome: string;
  joinerHome: string;
  /** One side's whole log, as it stands. */
  log(side: "creator" | "joiner"): Promise<string>;
};

/** Both sides through the handshake, as far as `ready`. */
export async function pair(
  relay: string,
  dir: string,
  extra: { hello?: string; creator?: Partial<SessionOptions>; joiner?: Partial<SessionOptions> } = {},
): Promise<Pair> {
  const creatorHome = path.join(dir, "creator");
  const joinerHome = path.join(dir, "joiner");
  const creatorLines = lineQueue();
  const joinerLines = lineQueue();
  const creator = start({ hello: extra.hello ?? "背景", lines: creatorLines, relay, home: creatorHome, ...extra.creator });
  const code = await waitForText(creatorHome, "waiting");
  const joiner = start({ code, lines: joinerLines, relay, home: joinerHome, ...extra.joiner });
  await waitForText(joinerHome, "peer hello");
  joinerLines.push("确认");
  await waitForText(creatorHome, "local ready");
  return {
    code,
    creator,
    joiner,
    creatorLines,
    joinerLines,
    creatorHome,
    joinerHome,
    log: (side) =>
      readFile(
        sessionPath(side === "creator" ? creatorHome : joinerHome, addressOf(code), side === "creator" ? "create" : "join"),
        "utf8",
      ),
  };
}
