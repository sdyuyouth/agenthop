import { describe, expect, it } from "vitest";
import {
  assertSafePath,
  decodeFrame,
  encodeFrame,
  addressOf,
  generateCode,
  isPairingCode,
  isRoomAddress,
  MAX_CHUNK,
  normalizeCode,
  relayEndpoints,
  rewriteAgentCard,
  roomIdFromCode,
  RelaySession,
  secretOf,
  splitCode,
  TunnelError,
  WORDLIST,
  encodeControl,
  decodeControl,
} from "../src/index.js";

const CODE = "4821-amber-river-maple-k7f3q2mbxz4a6tu5wnhjy2pc3d";

describe("codes", () => {
  it("normalizes case and separators", () => {
    expect(normalizeCode("  4821 Amber River Maple ")).toBe("4821-amber-river-maple");
    expect(normalizeCode("  4821 Amber_River Maple K7F3Q2MBXZ4A6TU5WNHJY2PC3D ")).toBe(CODE);
    expect(isRoomAddress(normalizeCode("4821-amber-river-maple"))).toBe(true);
    expect(isPairingCode(CODE)).toBe(true);
    expect(isPairingCode("4821-amber-river-maple")).toBe(false);
    expect(isRoomAddress(CODE)).toBe(false);
  });

  it("splits a code into the half the relay sees and the half it must not", () => {
    expect(splitCode(CODE)).toEqual({ address: "4821-amber-river-maple", secret: "k7f3q2mbxz4a6tu5wnhjy2pc3d" });
    expect(addressOf(CODE)).toBe("4821-amber-river-maple");
    expect(addressOf("4821-amber-river-maple")).toBe("4821-amber-river-maple");
    expect(secretOf(CODE)).toHaveLength(26);
    expect(() => splitCode("4821-amber-river-maple")).toThrow("invalid_code");
  });

  it("every word in the list is one lowercase run", () => {
    // A single hyphenated entry once produced five-segment codes the relay refused outright,
    // and one session in four hundred died before it started.
    expect(WORDLIST).toHaveLength(1296);
    for (const word of WORDLIST) expect(word).toMatch(/^[a-z]{2,}$/);
    expect([...WORDLIST].sort()).toEqual([...WORDLIST]);
    expect(new Set(WORDLIST).size).toBe(WORDLIST.length);
  });

  it("only ever generates a code the relay will take", () => {
    for (let i = 0; i < 2000; i++) {
      const code = generateCode();
      expect(isPairingCode(code)).toBe(true);
      expect(isRoomAddress(addressOf(code))).toBe(true);
    }
  });

  it("keeps the secret out of everything that reaches the relay", async () => {
    const secret = secretOf(CODE);
    const whole = relayEndpoints("https://relay.example", CODE);
    expect(whole).toEqual(relayEndpoints("https://relay.example", addressOf(CODE)));
    expect(whole.publicBase + whole.hostUrl).not.toContain(secret);
    // The room id is still the address's, so a relay from before this release routes v0.4
    // clients without knowing anything changed.
    expect(await roomIdFromCode(addressOf(CODE))).toBe(await roomIdFromCode("4821-AMBER-RIVER-MAPLE"));
    await expect(roomIdFromCode(CODE)).rejects.toThrow("invalid_code");
  });

  it("generates a stable room id", async () => {
    const address = addressOf(generateCode());
    expect(await roomIdFromCode(address)).toBe(await roomIdFromCode(address.toUpperCase()));
    expect(await roomIdFromCode(address)).toMatch(/^[a-z2-7]+$/);
    await expect(roomIdFromCode("nope")).rejects.toThrow("invalid_code");
  });
});

describe("frames", () => {
  it("round-trips a request, a chunked body, and a response", () => {
    const start = encodeFrame({
      type: "request-start",
      requestId: 7,
      method: "POST",
      path: "/.well-known/agent-card.json",
      headers: [["content-type", "application/json"], ["accept", "application/json"]],
    });
    expect(decodeFrame(start)).toEqual({
      type: "request-start",
      requestId: 7,
      method: "POST",
      path: "/.well-known/agent-card.json",
      headers: [
        ["content-type", "application/json"],
        ["accept", "application/json"],
      ],
    });

    const body = new Uint8Array([1, 2, 3, 4]);
    expect(decodeFrame(encodeFrame({ type: "request-body", requestId: 7, body }))).toEqual({
      type: "request-body",
      requestId: 7,
      body,
    });
    expect(decodeFrame(encodeFrame({ type: "request-end", requestId: 7 })).type).toBe("request-end");

    const response = encodeFrame({
      type: "response-start",
      requestId: 7,
      status: 200,
      headers: [["content-type", "text/event-stream"]],
    });
    expect(decodeFrame(response)).toMatchObject({ type: "response-start", status: 200 });
    const one = encodeFrame({ type: "response-body", requestId: 7, body: new TextEncoder().encode("one") });
    const two = encodeFrame({ type: "response-body", requestId: 7, body: new TextEncoder().encode("two") });
    expect(new TextDecoder().decode((decodeFrame(one) as { body: Uint8Array }).body)).toBe("one");
    expect(new TextDecoder().decode((decodeFrame(two) as { body: Uint8Array }).body)).toBe("two");
    expect(decodeFrame(encodeFrame({ type: "response-end", requestId: 7 })).type).toBe("response-end");
  });

  it("rejects an oversized chunk and an unsafe path", () => {
    expect(() => encodeFrame({ type: "request-body", requestId: 1, body: new Uint8Array(MAX_CHUNK + 1) })).toThrow(
      "chunk_too_large",
    );
    expect(() => assertSafePath("/../secret")).toThrow("bad_path");
    expect(() => assertSafePath("//evil")).toThrow("bad_path");
    expect(() => assertSafePath("/ok")).not.toThrow();
  });
});

describe("agent card", () => {
  it("rewrites JSON-RPC interfaces and drops other bindings", () => {
    const raw = JSON.stringify({
      name: "local",
      url: "http://127.0.0.1:9/",
      supportedInterfaces: [
        { url: "http://127.0.0.1:9/", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        { url: "http://127.0.0.1:9/grpc", protocolBinding: "GRPC", protocolVersion: "1.0" },
      ],
    });
    const card = JSON.parse(rewriteAgentCard(raw, "https://relay.example/r/1111-acid-acorn-acre"));
    expect(card.url).toBe("https://relay.example/r/1111-acid-acorn-acre");
    expect(card.supportedInterfaces).toEqual([
      {
        url: "https://relay.example/r/1111-acid-acorn-acre",
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ]);
    expect(JSON.stringify(card)).not.toContain("127.0.0.1");
  });
});

describe("relay session", () => {
  it("echoes a body and rewrites a card", async () => {
    const toHost: Uint8Array[] = [];
    const session = new RelaySession((data) => {
      if (typeof data !== "string") toHost.push(data);
    }, "https://relay.example/r/1111-acid-acorn-acre/");

    const host = startFakeHost(toHost, (frame) => session.onBinary(frame));

    const echoed = session.forward({
      method: "POST",
      path: "/",
      headers: [["content-type", "application/json"], ["cookie", "nope"]],
      body: streamFrom(new TextEncoder().encode('{"jsonrpc":"2.0","method":"SendMessage"}')),
    });
    const echoResponse = await readAll(await echoed);
    expect(echoResponse.status).toBe(200);
    expect(new TextDecoder().decode(echoResponse.body)).toBe('{"jsonrpc":"2.0","method":"SendMessage"}');

    const card = session.forward({
      method: "GET",
      path: "/.well-known/agent-card.json",
      headers: [],
      body: null,
    });
    const cardResponse = await readAll(await card);
    expect(cardResponse.status).toBe(200);
    const parsed = JSON.parse(new TextDecoder().decode(cardResponse.body));
    expect(parsed.supportedInterfaces[0].url).toBe("https://relay.example/r/1111-acid-acorn-acre/");
    expect(new TextDecoder().decode(cardResponse.body)).not.toContain("127.0.0.1");

    const streamed = session.forward({
      method: "POST",
      path: "/",
      headers: [],
      body: streamFrom(new TextEncoder().encode("stream-please")),
    });
    const sse = await readAll(await streamed);
    expect(new TextDecoder().decode(sse.body)).toBe("onetwo");
    host.stop();
  });

  it("rejects a body over 1 MiB", async () => {
    const session = new RelaySession(() => undefined, "https://relay.example/r/x");
    const big = new Uint8Array(1024 * 1024 + 1);
    await expect(
      session.forward({
        method: "POST",
        path: "/",
        headers: [],
        body: streamFrom(big),
      }),
    ).rejects.toBeInstanceOf(TunnelError);
  });
});

function streamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readAll(response: { status: number; body: ReadableStream<Uint8Array> }): Promise<{ status: number; body: Uint8Array }> {
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    parts.push(step.value);
  }
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return { status: response.status, body };
}

function startFakeHost(incoming: Uint8Array[], reply: (frame: Uint8Array) => void): { stop: () => void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  const seen = new Set<number>();
  const requests = new Map<number, { path: string; body: Uint8Array[] }>();
  timer = setInterval(() => {
    for (let i = 0; i < incoming.length; i++) {
      if (seen.has(i)) continue;
      seen.add(i);
      const frame = decodeFrame(incoming[i]!);
      if (frame.type === "request-start") requests.set(frame.requestId, { path: frame.path, body: [] });
      if (frame.type === "request-body") requests.get(frame.requestId)?.body.push(frame.body);
      if (frame.type === "request-end") {
        const req = requests.get(frame.requestId)!;
        const payload = new TextDecoder().decode(concatBytes(req.body));
        if (req.path === "/.well-known/agent-card.json") {
          const card = JSON.stringify({
            name: "local",
            url: "http://127.0.0.1:9/",
            supportedInterfaces: [{ url: "http://127.0.0.1:9/", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
          });
          reply(encodeFrame({ type: "response-start", requestId: frame.requestId, status: 200, headers: [["content-type", "application/json"]] }));
          reply(encodeFrame({ type: "response-body", requestId: frame.requestId, body: new TextEncoder().encode(card) }));
          reply(encodeFrame({ type: "response-end", requestId: frame.requestId }));
        } else if (payload === "stream-please") {
          reply(encodeFrame({ type: "response-start", requestId: frame.requestId, status: 200, headers: [["content-type", "text/event-stream"]] }));
          reply(encodeFrame({ type: "response-body", requestId: frame.requestId, body: new TextEncoder().encode("one") }));
          reply(encodeFrame({ type: "response-body", requestId: frame.requestId, body: new TextEncoder().encode("two") }));
          reply(encodeFrame({ type: "response-end", requestId: frame.requestId }));
        } else {
          reply(encodeFrame({ type: "response-start", requestId: frame.requestId, status: 200, headers: [["content-type", "application/json"]] }));
          reply(encodeFrame({ type: "response-body", requestId: frame.requestId, body: new TextEncoder().encode(payload) }));
          reply(encodeFrame({ type: "response-end", requestId: frame.requestId }));
        }
      }
    }
  }, 5);
  return {
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

void encodeControl;
void decodeControl;
