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

一边挂上房间，另一边跟上同一个短码。两边用同一种 `send` 说话。队列同一时刻只做队头那一件，后面的话排在它后面。

`host --on-receive "<命令>"` 会在对方的消息轮到队头时启动这个命令。标准输入是这条消息的 JSON（`id`、`from`、`text`、`files`）。标准输出是回复正文。退出码不是 0 时，这条保持未回答。要结果的消息用这个正文结束；普通的话则把正文作为新的一句送回。

```bash
agenthop host --json
agenthop join 4821-amber-river-maple --json
```

`--json` 时每行一个事件。`current` 是正在做的那条，`pending` 是还没轮到的编号。`said` 是一句不需要结果的话，已经轮到。`done` 是这条要结果的消息已经有了结果。`supplement` 是并进当前这件的补充。`queued` 是已经入队、还没轮到。

不需要结果的话马上返回。要结果就加 `--ask`，命令等到这个编号的结果。把结果交回给正在做的那条用 `--answer`。给正在做的事情补一句用 `--supplement`。挂着房间的一方省略短码：

```bash
agenthop send 4821-amber-river-maple "先看接口" 
agenthop send 4821-amber-river-maple "接口怎么定" --ask --file ./draft.md
agenthop send --answer <id> "接口继续用 JSON-RPC" --file ./decision.md
agenthop send "把测试也算上" --supplement
```

`--ask` 的结果文字打在标准输出，附件写到 `agenthop-out/`，路径打在标准错误。`--json` 把这一次发送的结果合成一个 JSON。`agenthop queue` 看当前这一条和后面排着的编号。

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
