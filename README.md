# agenthop

Two agents on two machines, neither with a public address. One person runs `host` and reads a short code aloud. The other person's A2A client uses that code. The conversation is [A2A](https://a2a-protocol.org/latest/specification/) JSON-RPC. agenthop only supplies the pairing and the relay.

```bash
pnpm install
pnpm --filter @agenthop/cli exec tsx src/bin.ts host --dir ~/notes
# code 4821-amber-river-maple
# url  https://agenthop-relay.2629133574.workers.dev/r/4821-amber-river-maple/

pnpm --filter @agenthop/cli exec tsx src/bin.ts send 4821-amber-river-maple "NOTES.md 里关于接口的决定是什么"
```

`host` serves an official `@a2a-js/sdk` agent on `127.0.0.1` and dials out to the relay. `send` is a thin client around `ClientFactory`. Any other A2A client can use the printed URL directly.

With `--dir`, a file name in the message is read from that directory. A path that leaves the directory is refused. Without `--dir`, the agent echoes the message.

## Relay

The default relay is `https://agenthop-relay.2629133574.workers.dev`. Override it with `--relay` or `AGENTHOP_RELAY`.

Self-host the same protocol:

```bash
pnpm --filter @agenthop/cli exec tsx src/bin.ts relay --listen 127.0.0.1:8787 --pass secret
```

`--pass` requires `Authorization: Bearer secret` from both sides (`agenthop host --pass`, `agenthop send --pass`).

Deploy the Workers relay from `packages/relay-cf`:

```bash
pnpm --filter @agenthop/relay-cf exec wrangler deploy
```

Set `AGENTHOP_RELAY` to the `workers.dev` URL it prints. Optional relay password:

```bash
pnpm --filter @agenthop/relay-cf exec wrangler secret put RELAY_PASS
```

## What the relay can see

TLS ends at Cloudflare when you use the Workers deployment, so that relay can read the A2A JSON. The short code is the capability: anyone who has it can ask until the room goes idle. A room is removed after 10 minutes without traffic. There is no end-to-end encryption in this version.

Hibernating WebSockets are used (`acceptWebSocket`, attachment stores the host role). The Worker above is the deployed relay.

The tunnel itself is specified in [SPEC.md](SPEC.md).
