import { randomUUID } from "node:crypto";
import { Role } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { normalizeCode, relayEndpoints } from "@agenthop/tunnel";
import { DEFAULT_RELAY } from "./host.js";
import { answerText } from "./text.js";

export type SendOptions = {
  code: string;
  text: string;
  relay?: string;
  pass?: string;
  stream?: boolean;
};

export async function sendMessage(options: SendOptions): Promise<string> {
  const relay = options.relay ?? process.env.AGENTHOP_RELAY ?? DEFAULT_RELAY;
  const { publicBase } = relayEndpoints(relay, normalizeCode(options.code));
  const previous = globalThis.fetch;
  if (options.pass) {
    const pass = options.pass;
    globalThis.fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${pass}`);
      return previous(input, { ...init, headers });
    };
  }
  try {
    const client = await new ClientFactory().createFromUrl(publicBase);
    const message = {
      messageId: randomUUID(),
      contextId: "",
      taskId: "",
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: "text" as const, value: options.text },
          mediaType: "text/plain",
          filename: "",
          metadata: {},
        },
      ],
      extensions: [],
      metadata: {},
      referenceTaskIds: [],
    };
    const request = { tenant: "", message, configuration: undefined, metadata: undefined };
    if (options.stream) {
      let answer = "";
      for await (const event of client.sendMessageStream(request)) answer += answerText(event);
      return answer;
    }
    return answerText(await client.sendMessage(request));
  } finally {
    globalThis.fetch = previous;
  }
}
