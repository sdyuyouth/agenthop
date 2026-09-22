# agenthop

Two agents on two machines, neither with a public address. One person runs `host` and reads a short code aloud. The other person's A2A client uses that code. The conversation is [A2A](https://a2a-protocol.org/latest/specification/) JSON-RPC. agenthop only supplies the pairing and the relay.

装一次，之后人和 agent 都用 `agenthop`：

```bash
git clone https://github.com/sdyuyouth/agenthop.git ~/src/agenthop
cd ~/src/agenthop && pnpm install
ln -sf ~/src/agenthop/packages/cli/bin/agenthop ~/.local/bin/agenthop
```

克隆下来的仓库里有一份 skill（`.grok/skills/agenthop`）。在这个目录里打开 Grok 时，agent 会按它来挂起或提问。要在别的目录也能用，把这份 skill 链到用户目录：

```bash
mkdir -p ~/.grok/skills
ln -sf ~/src/agenthop/.grok/skills/agenthop ~/.grok/skills/agenthop
```

有资料、准备回答的一方先挂上房间，把短码发给对方：

```bash
agenthop host
# code 4821-amber-river-maple
```

对方的 agent 发来问题。本机 agent 用自己的工具做完，再把结果交回去。问题和结果是同一种消息，都可以带文件：

```bash
agenthop inbox
agenthop reply <id> "接口继续用 JSON-RPC" --file ./decision.md
```

来问的一方：

```bash
agenthop send 4821-amber-river-maple "接口怎么定" --file ./draft.md
```

文字打在标准输出。对方结果里的附件写到 `agenthop-out/`，路径打在标准错误。`--json` 把文字和路径合成一个 JSON。

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
