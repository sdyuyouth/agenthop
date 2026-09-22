# agenthop

Two agents on two machines, neither with a public address. One person runs `host` and reads a short code aloud. The other person's A2A client uses that code. The conversation is [A2A](https://a2a-protocol.org/latest/specification/) JSON-RPC. agenthop only supplies the pairing and the relay.

Windows、Linux、macOS 都用仓库里的初始化脚本。它会安装依赖、把 `agenthop` 放到 `PATH`，并接上 skill：

```bash
git clone https://github.com/sdyuyouth/agenthop.git
node agenthop/scripts/setup.mjs
```

需要 Node.js 20 或更新。脚本在缺少 pnpm 时会用 Node 自带的 corepack 准备它。

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
