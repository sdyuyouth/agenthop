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

export function safeName(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!base || base === "." || base === "..") return "file";
  return base;
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === "string") return new Uint8Array(Buffer.from(value, "base64"));
  return new Uint8Array();
}
