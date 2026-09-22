/** Prefer task artifacts. Status updates and history repeat the same text. */
export function answerText(value: unknown): string {
  const artifacts = artifactParts(value);
  if (artifacts.length > 0) return collectText(artifacts).join("");
  return "";
}

function artifactParts(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(artifactParts);
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.artifacts)) {
    return record.artifacts.flatMap((artifact) => {
      const parts = (artifact as { parts?: unknown }).parts;
      return Array.isArray(parts) ? parts : [];
    });
  }
  if (record.artifact && typeof record.artifact === "object") {
    const parts = (record.artifact as { parts?: unknown }).parts;
    return Array.isArray(parts) ? parts : [];
  }
  return Object.values(record).flatMap(artifactParts);
}

/** Pull text parts out of an A2A message, task, or stream event. */
export function collectText(value: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = node as Record<string, unknown>;
    const content = record.content as { $case?: string; value?: unknown } | undefined;
    if (content?.$case === "text" && typeof content.value === "string") out.push(content.value);
    for (const child of Object.values(record)) {
      if (child !== content) walk(child);
    }
  };
  walk(value);
  return out;
}
