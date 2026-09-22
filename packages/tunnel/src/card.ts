/** Rewrite a v1 Agent Card so every JSON-RPC interface points at the relay. */
export function rewriteAgentCard(json: string, publicBase: string): string {
  const card = JSON.parse(json) as Record<string, unknown>;
  const interfaces = card.supportedInterfaces;
  if (!Array.isArray(interfaces)) throw new Error("card_missing_interfaces");
  const jsonrpc = interfaces.filter((item) => {
    return !!item && typeof item === "object" && (item as { protocolBinding?: string }).protocolBinding === "JSONRPC";
  });
  if (jsonrpc.length === 0) throw new Error("card_missing_jsonrpc");
  for (const item of jsonrpc) {
    (item as { url: string }).url = publicBase;
  }
  card.supportedInterfaces = jsonrpc;
  if (typeof card.url === "string") card.url = publicBase;
  return JSON.stringify(card);
}

export function isCardPath(path: string): boolean {
  const pathname = path.split("?")[0] ?? path;
  return pathname === "/.well-known/agent-card.json";
}
