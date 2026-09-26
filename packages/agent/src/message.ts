import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Part } from "@a2a-js/sdk";

/** One turn in either direction: the agent's text, plus any files it attaches. */
export type HopFile = {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
};

export type HopMessage = {
  text: string;
  files: HopFile[];
};

/** Stay under the relay's 1 MiB frame after base64 expansion. */
export const MAX_ATTACHMENT_BYTES = 512 * 1024;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".html": "text/html",
};

export function mediaTypeFor(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

export async function filesFromPaths(paths: string[]): Promise<HopFile[]> {
  const files: HopFile[] = [];
  let total = 0;
  for (const filePath of paths) {
    const bytes = new Uint8Array(await readFile(filePath));
    total += bytes.byteLength;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachments exceed ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    files.push({
      name: path.basename(filePath),
      mediaType: mediaTypeFor(filePath),
      bytes,
    });
  }
  return files;
}

export function partsFromMessage(message: HopMessage): Part[] {
  const parts: Part[] = [];
  if (message.text) {
    parts.push({
      content: { $case: "text", value: message.text },
      mediaType: "text/plain",
      filename: "",
      metadata: {},
    });
  }
  for (const file of message.files) {
    parts.push({
      content: { $case: "raw", value: Buffer.from(file.bytes) },
      mediaType: file.mediaType,
      filename: safeName(file.name),
      metadata: {},
    });
  }
  if (parts.length === 0) {
    parts.push({
      content: { $case: "text", value: "" },
      mediaType: "text/plain",
      filename: "",
      metadata: {},
    });
  }
  return parts;
}

export function messageFromParts(parts: readonly Part[] | undefined): HopMessage {
  let text = "";
  const files: HopFile[] = [];
  for (const part of parts ?? []) {
    const content = part.content as { $case?: string; value?: unknown } | undefined;
    if (content?.$case === "text" && typeof content.value === "string") {
      text += content.value;
      continue;
    }
    if (content?.$case === "raw") {
      files.push({
        name: safeName(part.filename || `file-${files.length + 1}`),
        mediaType: part.mediaType || "application/octet-stream",
        bytes: asBytes(content.value),
      });
    }
  }
  return { text, files };
}

/**
 * A name the other side chose, made safe to write under the inbox. It stays as written — a
 * `报告（终稿）.txt` arrives as that, not as underscores — and loses only what cannot be in a file
 * name, what would climb out of the folder, and what would drive a terminal or reverse the text
 * on screen when the path is shown.
 */
export function safeName(name: string): string {
  const base = path.posix
    .basename(name.replace(/\\/g, "/"))
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/, "");
  if (!base || /^\.+$/.test(base)) return "file";
  // Windows will not open a file called CON or NUL, whatever follows the dot.
  const named = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base) ? `_${base}` : base;
  // Most file systems stop at 255 bytes; leave room for a suffix.
  const chars = Array.from(named);
  while (Buffer.byteLength(chars.join("")) > 200) chars.pop();
  return chars.join("");
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === "string") return new Uint8Array(Buffer.from(value, "base64"));
  return new Uint8Array();
}
