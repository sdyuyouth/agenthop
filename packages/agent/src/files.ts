import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_FILE = 256 * 1024;

export class FileDenied extends Error {
  constructor() {
    super("denied");
  }
}

/** Read one UTF-8 text file inside root. `..` and links that escape are denied. */
export async function readHostedFile(root: string, relativePath: string): Promise<string> {
  if (!relativePath || relativePath.includes("\0") || relativePath.split(/[\\/]/).includes("..")) {
    throw new FileDenied();
  }
  const rootReal = await realpath(root);
  const target = path.resolve(rootReal, relativePath);
  let targetReal: string;
  try {
    targetReal = await realpath(target);
  } catch {
    throw new FileDenied();
  }
  const relative = path.relative(rootReal, targetReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new FileDenied();
  const info = await stat(targetReal);
  if (!info.isFile() || info.size > MAX_FILE) throw new FileDenied();
  return readFile(targetReal, "utf8");
}

/** Reply text for a user message. File names in the message are read; `..` is refused. */
export async function collectAnswer(root: string | undefined, userText: string): Promise<string> {
  const tokens = userText.split(/\s+/).filter(Boolean);
  if (tokens.some((token) => token.split(/[\\/]/).includes(".."))) return "denied";
  if (!root) return userText;
  const pieces: string[] = [];
  for (const token of tokens) {
    if (!token.includes(".") && !token.includes("/")) continue;
    try {
      pieces.push(await readHostedFile(root, token));
    } catch (error) {
      if (error instanceof FileDenied && token.includes("/")) return "denied";
    }
  }
  return pieces.length > 0 ? pieces.join("\n") : userText;
}
