# agenthop

Two agents on two machines, neither with a public address. One person runs `host` and reads a short code aloud. The other person's A2A client uses that code. The conversation is [A2A](https://a2a-protocol.org/latest/specification/) JSON-RPC. agenthop only supplies the pairing and the relay.

成品在 GitHub Release，不需要克隆仓库，也不需要 Node.js。下载对应系统的文件后执行一次安装：

https://github.com/sdyuyouth/agenthop/releases/latest

```bash
chmod +x agenthop-macos-arm64   # Linux 同样；Windows 用 agenthop-windows-x64.exe
./agenthop-macos-arm64 install --skill-dir <技能目录>
```

`install` 把命令放到 PATH，并把 `SKILL.md` 写到 `~/.agenthop/SKILL.md`。`--skill-dir` 可重复，每次把同一份 `SKILL.md` 写进调用方自己的技能目录。已提供的文件：

| 文件 | 系统 |
|---|---|
| `agenthop-macos-arm64` | macOS Apple 芯片 |
| `agenthop-macos-x64` | macOS Intel |
| `agenthop-linux-x64` | Linux x64 |
| `agenthop-linux-arm64` | Linux ARM |
| `agenthop-windows-x64.exe` | Windows 64 位 |

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

The default relay is `https://agenthop.imatrix.tech`. Override it with `--relay` or `AGENTHOP_RELAY`.

Self-host the same protocol:

```bash
pnpm --filter @agenthop/cli exec tsx src/bin.ts relay --listen 127.0.0.1:8787 --pass secret
```

`--pass` requires `Authorization: Bearer secret` from both sides (`agenthop host --pass`, `agenthop send --pass`).

Deploy the Workers relay from `packages/relay-cf`:

```bash
pnpm --filter @agenthop/relay-cf exec wrangler deploy
```

Set `AGENTHOP_RELAY` to the deployed URL. Optional relay password:

```bash
pnpm --filter @agenthop/relay-cf exec wrangler secret put RELAY_PASS
```

## What the relay can see

TLS ends at Cloudflare when you use the Workers deployment, so that relay can read the A2A JSON. The short code is the capability: anyone who has it can ask until the room goes idle. A room is removed after 10 minutes without traffic. There is no end-to-end encryption in this version.

Hibernating WebSockets are used (`acceptWebSocket`, attachment stores the host role). The Worker above is the deployed relay.

The tunnel itself is specified in [SPEC.md](SPEC.md).
