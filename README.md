# agenthop

**让两台没有公网地址的机器上的两个 agent 直接对话。** 一个短短的配对码，一条命令，完成配对、确认背景和后续往返。

[![CI](https://github.com/sdyuyouth/agenthop/actions/workflows/ci.yml/badge.svg)](https://github.com/sdyuyouth/agenthop/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sdyuyouth/agenthop)](https://github.com/sdyuyouth/agenthop/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## 解决什么问题

你在自己电脑上开着一个 agent，对方在他的电脑上开着另一个。两边都没有公网入口，想让它们交换点东西，只能靠人把上下文复制来复制去。

agenthop 把这件事变成：一方创建房间拿到配对码，另一方用这个码加入，然后两个 agent 直接说话。工具调用和思考过程不过去，**过去的是一方说完的话**。

## 一次真实对话长什么样

下面是 Claude Code 和 grok CLI 之间一次真实对话的节选，创建方看到的内容（也是它的标准输出）：

```text
15:35:02 local waiting 0064-fresh-genre-bunt-k7f3q2mbxz4a6tu5wnhjy2pc3d
15:38:00 peer connected
15:38:00 local hello 我是 Cooper 这边的 Claude Code。刚发布了 agenthop v0.3.2，想用一次真实对话验证…
15:38:24 peer confirm 相符：我是 Cooper 本机上的 grok CLI，来配合验证 agenthop v0.3.2。
15:38:24 local ready
15:38:36 local say 第一个问题：你现在跑的 grok CLI 是哪个版本，用的哪个模型？
15:39:12 peer say grok CLI 版本是 1.0.41（4220f3b224a6），这是刚才跑 grok --version 的输出。
15:39:13 peer say 当前这次会话的模型是 grok-4.7。
15:43:00 local bye
15:43:02 peer bye
```

加入方那边是对称的：它看到 `peer hello`，写一句确认，之后每一句都是 `peer say`。

## 安装

下载对应系统的文件，安装一次。**不需要克隆仓库，也不需要 Node.js。**

<https://github.com/sdyuyouth/agenthop/releases/latest>

| 文件 | 系统 |
|---|---|
| `agenthop-macos-arm64` | macOS Apple 芯片 |
| `agenthop-macos-x64` | macOS Intel |
| `agenthop-linux-x64` | Linux x64 |
| `agenthop-linux-arm64` | Linux ARM64 |
| `agenthop-windows-x64.exe` | Windows 64 位 |

没有 Windows ARM 包。

**macOS / Linux**

```bash
chmod +x agenthop-macos-arm64
./agenthop-macos-arm64 install --skill-dir <技能目录>
```

命令装到 `~/.local/bin/agenthop`。换成对应系统的文件名即可。

**Windows**（在 PowerShell 里执行，不要用 `chmod`）

```powershell
.\agenthop-windows-x64.exe install --skill-dir <技能目录>
```

命令装到 `%LOCALAPPDATA%\agenthop\agenthop.exe`，并把这个目录写入用户 PATH。

新开一个终端后可以直接运行 `agenthop`。`--skill-dir` 是你这个 agent 存放技能文件的目录，可以重复指定；无论是否指定，都会再写一份到 `<家目录>/.agenthop/SKILL.md`。这些目录会记在 `<家目录>/.agenthop/install.json` 里，以后 `agenthop update` 会把新的 `SKILL.md` 写回每一个。

### 更新

```bash
agenthop update            # --check 只查询，--force 版本相同也重装
```

下载回来的程序会和 release 里的 `SHA256SUMS` 对校验和，对不上就不替换现在的程序。校验和优先从 GitHub 取，取不到才退回中继那一份（并且会说明）。`upgrade` 和 `self-update` 是同一条命令。

`agenthop --version` 打印版本，`agenthop help` 打印完整用法。

## 用法

用一次工具调用启动命令，**让这个进程活到对话结束**。对方的话从它的标准输出读，要说的话写进同一个标准输入，一行一句。进程不会因为新消息而重新启动。

创建房间，后面的文字是任务背景，会作为 hello 发给对方：

```bash
agenthop "<任务背景>"
```

标准输出里的 `waiting` 行带有配对码。对方加入：

```bash
agenthop <配对码>
```

配对码不区分大小写，用空格或连字符隔开都行，但要**整行发过去**——最后那一段是这次对话的密钥，少了它加入不了。

加入方读到 `peer hello` 后，由那边的 agent 判断这段背景是否和自己的上下文相符：相符就写一句确认，创建方随后输出 `ready`；不相符就去问用户，不要往标准输入写东西。`ready` 之后，对方的每一句都是 `peer say`。

写一行 `/bye` 结束对话。对方会把 bye 说回来，两边各有 `local bye` 和 `peer bye`，然后各自退出。读到 `peer bye` 不用管，程序自己会回。按 Ctrl-C 也会先送出 bye 再退出。

这个进程写出的每一行就是对话本身，**要出现在用户看得到的地方**。另存一份可以，但要同时告诉用户文件的绝对路径和查看命令。判断标准只有一个：用户此刻能不能看到对话在往前走。

### 日志与状态

启动后的第一行是日志的绝对路径（`local log <路径>`）。日志按房间和哪一端命名：创建方 `<房间地址>.create.log`，加入方 `<房间地址>.join.log`（房间地址是配对码去掉密钥的前四段），都在 `<家目录>/.agenthop/sessions/`，两端在同一台机器上也不会写进同一个文件。内容和标准输出一样：

```text
<时间> <local|peer> <状态> <正文>
```

时间是本机时间，带时区偏移。`local` 恒指自己，`peer` 恒指对方。

| 状态 | 意思 |
|---|---|
| `log` `waiting` `connected` `hello` `confirm` `ready` | 配对过程 |
| `say` | 对话正文 |
| `bye` | 结束，两边都会出现 |
| `working` | 对方收到了，正在处理。这一行不需要回应，写一行 `/working <在做什么>` 就能发出自己的 |
| `reconnecting` `reconnected` | 连接断了，正在用同一个配对码把房间接回来；接回来后对话继续 |
| `undelivered` | 这一句**没有送到对方**，不要当成已经回复过 |
| `gone` | 对方不在了（退出、断网，或房间空闲超过十分钟） |
| `expired` | 一直没有人用这个配对码加入，房间过期了 |
| `refused` | 这一句既没进对话也没落盘：对方拿不出配对码里的密钥、重复的一句，或者用量到了上限 |
| `files` | 对方带了附件，默认只记名字不保存，要保存加 `--accept-files` |
| `other` | 对方说了一句这个版本不认识的形式，多半是两边版本不一样 |
| `input-closed` | 自己的标准输入被关掉了，只能收听 |

## 工作原理

```
你的机器                        中继                        对方的机器
agenthop ──WebSocket──▶  /host/<房间地址>  ◀──HTTP──  agenthop
   │                     （只转发字节）                        │
   └─ 本地 A2A server                                          └─ 轮询房间读增量
```

创建方在本机起一个 [A2A](https://a2a-protocol.org/latest/specification/) server，并用一条 WebSocket 连到中继；对方发往 `/r/<房间地址>/...` 的 HTTP 经这条隧道落到本机。中继只转发字节，不解析消息，也读不懂：正文在离开本机之前就用配对码里的密钥封好了。房间在十分钟没有转发后消失，所以配对码要在十分钟内用掉。

隧道的帧格式、房间与限流规则写在 [SPEC.md](SPEC.md)。

### 包

| 包 | 作用 |
|---|---|
| `@agenthop/cli` | `agenthop` 命令本身：配对、对话、安装、更新 |
| `@agenthop/tunnel` | 隧道与房间逻辑，两个中继共用 |
| `@agenthop/relay-node` | 自建中继（`agenthop relay`） |
| `@agenthop/relay-cf` | Cloudflare Workers 中继，每个房间一个 Durable Object |
| `@agenthop/agent` | A2A 消息与附件的编解码 |

## 中继

默认是 `https://agenthop.imatrix.tech`。换中继用 `--relay URL` 或环境变量 `AGENTHOP_RELAY`：

```bash
agenthop --relay https://example.test "<任务背景>"
```

自建一个：

```bash
agenthop relay --listen 127.0.0.1:8787 --pass secret
```

两边都加 `--pass secret`，或者设环境变量 `AGENTHOP_PASS`——命令行参数会出现在 `ps` 里，环境变量不会。Workers 中继的部署在 `packages/relay-cf`：

```bash
pnpm --filter @agenthop/relay-cf exec wrangler deploy
pnpm --filter @agenthop/relay-cf exec wrangler secret put RELAY_PASS
```

## 安全

配对码就是进入房间的唯一凭证，它是一次性的。**正文是端到端加密的**：配对码分成两半，前四段是房间地址、中继按它路由，最后一段是密钥、从不发给中继，所以托管中继转发的是它读不懂的密文。中继仍然看得到房间地址、消息条数、每条的大小和时间，也仍然可以丢弃或延迟消息。没有前向保密，附件的字节也不加密。详见 [SECURITY.md](SECURITY.md)。

### 为什么配对码这么长

早先的配对码只有四位数字加三个词，短到可以念出来。但房间地址就是这个码的哈希，而它的取值空间小到能离线反推——只要密钥是从这个码派生的，就等于没有密钥。而 agenthop 的码从来不是念出来的，它是从一个 agent 的终端复制、粘贴到另一个 agent 的窗口里的，所以加长它几乎没有代价。现在码的前四段仍然是房间地址，后面多出来的那一段是 128 位的随机密钥。

## 开发

```bash
node scripts/setup.mjs   # 装依赖并把 dev launcher 链到 PATH
pnpm typecheck
pnpm test
```

细节见 [CONTRIBUTING.md](CONTRIBUTING.md)，架构说明见 [CLAUDE.md](CLAUDE.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[Apache-2.0](LICENSE)

---

**In English:** agenthop lets two agents on machines without public addresses talk to each other. One side runs `agenthop "<background>"` and gets a short pairing code; the other runs `agenthop <code>`. A relay forwards bytes between them — the messages themselves are [A2A](https://a2a-protocol.org/latest/specification/) JSON-RPC and the relay does not parse them. The tunnel format, room lifetime and rate limits are specified in [SPEC.md](SPEC.md), which is in English. Message bodies are encrypted end to end: the pairing code is an address the relay routes on plus a secret that never leaves the two machines, so the relay forwards ciphertext it cannot read. It still sees the room address, message sizes and timing. There is no forward secrecy.
