# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这个项目是什么

agenthop 让两台**没有公网入口**的机器上的两个 agent 通过一个配对码对话。中继只转发字节，不解析消息。
消息本身是 [A2A](https://a2a-protocol.org/latest/specification/) JSON-RPC；隧道帧格式与房间/限流规则写在 [SPEC.md](SPEC.md)，改协议时先改 SPEC.md。

终端用户下载 Release 里的 Bun 单文件二进制，不克隆仓库、不需要 Node.js。仓库本身是 pnpm workspace，开发需要 Node.js ≥ 20。

## 常用命令

```bash
node scripts/setup.mjs                  # 开发环境：pnpm install + 把 dev launcher 链到 PATH
pnpm test                               # 全部包（包含 relay-cf 的 wrangler dev 实测，慢且要联网）
pnpm typecheck                          # 全部包 tsc --noEmit
pnpm --filter @agenthop/cli test        # 单个包
pnpm --filter @agenthop/cli exec vitest run test/session.test.ts       # 单个文件
pnpm --filter @agenthop/cli exec vitest run -t "says goodbye"          # 单个用例
node packages/cli/bin/agenthop.mjs <args>                              # 不安装直接跑 CLI（tsx）
node scripts/build-release.mjs          # 生成 skill-text.ts 并 bun --compile 出 5 个平台二进制到 dist/
pnpm --filter @agenthop/relay-cf exec wrangler deploy                  # 部署生产中继
```

`pnpm test` 按包串行（`--workspace-concurrency=1`）。这些测试起真的 server、真的中继、真的子进程，几个包一起跑会互相抢 CPU，症状是某一行等二十秒都不出现。别为了快把并发加回来。

`@agenthop/relay-cf` 的 `test` 会跑两套配置：`vitest.config.ts`（workers pool，快）和 `vitest.live.config.ts`（真的 `wrangler dev`，30s 超时）。只想要快的那套时直接 `vitest run --config vitest.config.ts`。live 那套在 CI 上默认跳过（要跑设 `AGENTHOP_LIVE=1`），因为它要现拉 workerd。

会话测试的工具在 `test/harness.ts`：`start()` 把提前失败的原因记进 `failures`，`waitForText` 会把原因抛出来——不这样的话一个早退的会话只会表现成"某一行没等到"；`pair()` 把两端带到 `ready`。`session.test.ts` 和 `edges.test.ts` 都在 `afterEach` 里断言 `failures` 为空：**一个以抛异常结束的会话，不管日志后面写了什么，手里的东西已经丢了**。这条守卫第一次加上就抓到了自动回 bye 被限流时直接抛出的 bug——那个用例在没有守卫时是"通过"的。`relay.test.ts` 的 `step()` 同理，给每个 await 一个标签。**这两处不要去掉**：长期被当成"机器慢"的那个偶发，正是靠它们才暴露出真实原因（relay-node 在 accept 之后才挂监听器的竞态，见下）。

## 包与依赖方向

```
tunnel ─┬─ relay-node（自建中继，ws + node:http）
        ├─ relay-cf（Cloudflare Worker，Durable Object 每房间一个）
        └─ cli ── agent（A2A Part ↔ HopMessage 编解码、附件上限 512 KiB）
```

**接受连接之前把异步的事做完。** `relay-node` 曾经先 `handleUpgrade` 再 `await roomIdFromCode`，然后才挂 `ws.once("message")`——host 在这个窗口里发出的 `open` 帧没人接，于是永远等不到 `ready`。快机器上几乎碰不到，CI 上很常见。现在房间 id 在 accept 之前算好，accept 与挂监听之间没有任何 await。`relay-cf` 没有这个问题（DO 的 `webSocketMessage` 是常驻方法，房间 id 在 Worker 里就算好了）。

`@agenthop/tunnel` 是唯一被两个中继共享的实现：`session.ts` 的 `RelaySession` 就是房间逻辑本体（转发、Agent Card 改写、空闲关闭），两个中继各自只写自己的传输层。**修 bug 优先改 tunnel，不要在两个中继里各写一遍。**

## 一次对话是怎么跑起来的

面向用户的命令只有 `agenthop <任务背景>`（创建）和 `agenthop <配对码>`（加入），加上 mcp / install / update / relay / help / --version。`bin.ts` 只做分发，参数解析和输入分类在 `args.ts`（可单测，`bin.ts` 一导入就会执行，不要在测试里 import 它）。

**分类出错不会报错，而是开错房间**——把配对码当成任务背景，就是新开一个房间、把码当 hello 发出去，agent 还以为自己加入了。所以 `codeAttempt` 对码的**外包装**放得宽（反引号、引号、括号、句末标点、整行 `local waiting …`、带时间戳的日志行、全角、被终端折成两段的密钥、码后面跟一句中文指令），对**什么算码**收得紧：全是码字符的输入按码严格校验，打错就报错；以年份开头、接着是中文的是任务背景。改这里先跑 `args.test.ts`。

**MCP 模式是推荐用法**（`mcp.ts`，`agenthop mcp`，v0.5.0）。命令行用法要求 agent 往一个正在运行的进程的标准输入里写字，而大多数 agent harness 没有这个能力——实测中 Claude Code 每次都得临时搭 `tail -f 文件 | agenthop` 的管道。MCP server 由 harness 启动并保活，对话就活在它里面，"一个进程从头跑到尾"这条规矩反而更牢。它是**同一个会话引擎的另一个前端**，不是重写：工具往 `lineQueue()` 里推行，日志的实时副本经 `SessionOptions.emit` 送回来给 `wait`。几条要守住的：

- **stdout 是协议**。`write()` 按日志路径查 `sinks`（`routed()` 在会话开始时登记、结束时撤掉），登记过的会话不写 fd 1。漏一行日志进 stdout 就会把 harness 的 JSON-RPC 流打坏——`mcp-stdio.test.ts` 起真进程逐行校验，设 `AGENTHOP_BIN` 可以对编译出的二进制跑同一个测试。
- **工具参数是字，不是命令**：`agenthop_say("/bye")` 会被拒并指向 `agenthop_bye`，不会意外结束对话。
- `wait` 只在轮到你时返回（`TURN`：hello / confirm / say / files / bye），其余动静（对方的 working、这边的 throttled 等）随结果一起给出；自己刚做的事（say、working、files）不回显，工具调用本身已经报过了。
- 参数分类（反引号、年份开头那些）在 MCP 模式下整类不存在：创建和加入是两个工具。`agenthop_join` 仍然过一遍 `classifyInput`，因为 agent 照样会包反引号。
- **装着旧技能的 agent 会绕过 MCP**。实测 grok 同时有 MCP 工具和 v0.4 的 SKILL.md 时，照技能走了命令行 + `tail | grep`。所以 SKILL.md 开头第一节就是"先看有没有 agenthop 工具"，改技能时别把它挪下去。
- **联系人和邀请**（`identity.ts`、`invite.ts`、`inbox.ts`）。身份是每个家目录一对 X25519 密钥；加入方的 `connect` 正文带自己的公钥，创建方**只对带了公钥的加入方**在 hello 之前回一句 `[[agenthop:identity]]`——旧版本两边都一个字不多收。收件地址是由公钥派生的普通房间地址，中继不用改；它的 host 令牌由私钥派生（`startHost` 的 `token`），否则 MCP server 一重启，旧令牌的哈希还挂在中继上，要等房间过期才拿得回来；它不对外提供队列（`serveQueue: false`）。邀请是 Noise IK 的第一条消息的形状，发件人的公钥也封在里面。`accept` 解开并核对（联系人、十分钟、见过的 id），`onEvent` 再解一次把它交给 MCP——`open` 是纯函数，解两次没关系。邀请对话里 `expectPeer` 让两边再核对一次对方是不是邀请里的那个人。MCP 只在有联系人时挂收件地址。
- **每个 WebSocket 都要一直挂着 `error` 监听**。编译出的 Bun 程序在中继突然消失时会在 socket 上多抛一次错误；没人听，进程就退出了——v0.5.0 发布的二进制就是这样，Node 下的测试一次都没碰到过。重连靠的是随后的 `close`。`mcp-stdio.test.ts` 里"让中继消失几秒"那个用例要带 `AGENTHOP_BIN` 跑一次才算数。
- **告别之后房间要留到对方读到为止**（`host.handedOver()`），不是固定几秒：经过真实中继，加入方光发出 bye 就要一秒多。
- `install` 默认只**打印**各 agent 的注册命令（`agents.ts`）；写进别的工具的配置是持久改动，只在 `--mcp <agent>` 点名时才做，而且不是纯 JSON 的配置文件不碰。

创建方（`session.ts: createSession`）：

1. `startHost()` 生成配对码，起两个本地 HTTP server：一个跑 A2A（express + `@a2a-js/sdk`），一个是只有本机能访问的 control server（`room.ts: listenControl`，`GET /queue`、`POST /message`）。
2. 一条 WebSocket 连到中继 `/host/<code>`，`HostBridge`（`bridge.ts`）把隧道帧翻译成对本地 A2A server 的 fetch。对方发到 `/r/<code>/...` 的 HTTP 就这样落到本地。
3. 之后轮询自己的 control server（200ms），按状态机推进。

加入方没有 host，直接用 `sendMessage()` 打中继的 `/r/<code>/`，并轮询 `agenthop/queue` 读事件（1s；这个轮询同时也是房间的保活）。

**断线不等于结束**：创建方的 WS 掉了就按退避重开房间（`host.ts: recover`，同一个配对码，`RECOVER_MS` 45 秒），加入方读不到房间时也重试同样长。两边都会写 `reconnecting` / `reconnected`。房间是按配对码寻址的，所以重开之后对话接得上——`Talk` 日志在本地进程里，没丢。

状态机靠**正文里的 wire 前缀**区分，不是靠协议字段：`[[agenthop:connect:<id>]] <公钥>`、`[[agenthop:identity]] <公钥>`、`[[agenthop:hello]] …`、`[[agenthop:confirm:<id>]] …`、`[[agenthop:say:<id>]] …`、`[[agenthop:working:<id>]] …`、`[[agenthop:bye:<id>]]`，全部再封进 `[[agenthop:sealed]] <密文>`（`session.ts: parseWire`）。顺序固定为 `connect → (identity) → hello → confirm → ready → say → bye`；`working` 是一张收条，ready 之后随时可以出现，加入方确认之前写的也会照样发出去而不被当成确认语。认不出来的形式记成 `peer other`，别让它抛。加入方在 `wait-confirm` 之前写的行会被暂存（`early`），确认之后才放行——改这段时别把暂存丢了。

`<id>` 是加入方自己生成的，创建方只认第一个 connect 带来的那个。`accept` 返回拒绝**理由**而不只是布尔值（`REFUSE_NO_KEY` / `REFUSE_SEAT_TAKEN` / `REFUSE_NOT_PEER`），这串文字会原样回到发送方——第二个加入者拿着正确的码，被告知"配对码可能打错了"只会让人去找一个不存在的错字。**这个 id 在密封层里面**——能造出一句合法密文就证明握有配对码里的密钥，所以 `accept` 现在是密码学的，不是约定俗成的。v0.4 之前有一条"没有 id 的行按旧版本接受"的兼容，已经删掉：旧版本的对端根本造不出密文，那条分支谁也保护不了，只是把 `accept` 开了个口子。房间本身仍然不认人：拿到地址的人都能 POST，过滤发生在会话层。

**stdin 的语义**：一行正文就是一句话；`/bye`（`session.ts: BYE`）结束对话；`/working <在做什么>`（`session.ts: WORKING`）发一张收条。收条走自己的状态词，是因为 agent 判断“轮到我了”靠的就是 `peer say`，收条要是也走 `say`，每收一句就要多烧对方一轮去读一句“收到”。**收条必须由 agent 写**：进程只知道自己把行打了出来，不知道模型有没有看，自动发等于谎报已读。EOF **不等于** bye——只写一行 `local input-closed` 然后继续收听，因为很多 agent harness 启动子进程时 stdin 本来就是关的，EOF 触发退出会让房间刚开就关。

**告别是双向的**：收到 `[[agenthop:bye]]` 的一方自动把 bye 回过去再退出，先说的一方等这个回复，等不到就写 `peer gone`。`saidBye` 挡住无限对回。创建方作为回话方时要等对方把回过去的 bye 读走（`handOver`，最多 10 秒）再关房间，因为对方是隔着中继轮询读的——固定两秒在真实中继上不够。

**送不出去的话要留痕**：`outbox.flush` 把发送失败的行写成 `local undelivered <正文>`，终止前 `reportUnsent()` 把还没送出的行也倒出来。静默丢话会让 agent 以为自己回复过——这是最不能退的一条。以下每一条都是按这个标准补上的洞，改这段时逐条对：`/bye` 后面同一口气写的行、等对方回 bye 时写的行、加入方在 hello 之前抢先写的行（`early`）、限流时排着的行（`backlog`），离场时都要写成 `undelivered`；自动回 bye 发不出去写 `local undelivered /bye`，不许抛。

**限流不是失败**：中继每分钟对一个房间只收 60 条 POST（`PostCounter`，被拒的不计数），超出时 `sendMessage` 抛 `Throttled`，outbox 把剩下的行按原顺序留在 `backlog` 里，每 5 秒重试，只写一行 `local throttled`。只认 `rate_limited`——`room_quota` 也是 429，但那是永久的，重试会永远挂着。让 agent 自己重发，它不知道要等多久，重发的句子还会排到新句子后面。

**一个事件就是一行**：`write()` 经过 `oneLine()`，换行（含 `\r`、`U+2028/2029`、`U+0085`）变成可见的 `↵`，控制字符和双向覆盖字符去掉。对方拿着密钥也不能在你的日志里写一行看起来是 `local say` 的东西——没有这一步，一个带换行的 `say` 就能做到。

日志与 stdout 同一份内容：`<时间> <local|peer> <状态> <正文>`，时间是**本机时间带偏移**（`session.ts: stamp`，不是 UTC，日志是给人读的），写到 `<家目录>/.agenthop/sessions/<配对码>.<create|join>.log`（`session.ts: sessionPath`）。**日志的键是（房间, 哪一端）而不是房间**——同机跑两个 agent 时两端共用家目录，只按配对码命名会让两份记录交织进同一个文件（v0.3.2 实测过）。第一行 `local log <绝对路径>` 把路径直接打出来，agent 不用自己拼，改名字也不会让文档失真。**stdout 的格式就是 agent 的接口**，改格式等于改 SKILL.md 的契约。`local` 恒指自己，`peer` 恒指对方——不要再让一个状态词在两边表示不同的事。

## 队列语义（Talk / Room）

`talk.ts` 的 `Talk` 是一条**只增不改的有序日志**：两边说的每一句按 seq 排好，`since(seq)` 给出新的部分，加入方靠它拉增量。没有提问/回答/补充的区分——v0.1.6 之前那套 ask/answer/supplement 队列已经随旧命令一起删掉了，不要再引入。

`room.ts` 的 `Room` 把 A2A 请求和本地 control 请求都收敛到 `admit()`，并用 `run()` 串行化。事件回调发生在锁释放之后（`takeNew()` + watermark），**动 `Room` 时保持这个顺序**，否则监听者在回调里说话会重入死锁。

**拒绝必须发生在落盘之前**。`execute` 先调 `refuse()`（`accept` 回调 + 配额），通过了才 `storeFiles`。v0.3.0 的顺序是反的：陌生人的消息在会话层被记成 `peer refused`，字节却已经写进 `~/.agenthop/inbox` 了。`accept` 由 session 提供（它知道 wire 和 peer id），执行点在 Room——别把 wire 格式挪进 Room，也别把检查挪回 session。

配额在 `DEFAULT_LIMITS`（8 MiB / 2000 条 / 单条正文 64 KiB），超了走 `onRefused`，不进 `Talk`。附件默认**不落盘**（`keepFiles`，`--accept-files` 打开），只把名字放进事件，session 写一行 `peer files`。

`talk.test.ts` 覆盖日志顺序，`e2e.test.ts` 起真中继 + 真 host 覆盖传输层（含附件落到 `inbox/`），`session.test.ts` 用 `lineQueue` 跑完整的握手、bye、gone、input-closed。

## 发版

1. 改 `packages/cli/src/version.ts`，提交推送。
2. 在 GitHub 上建 tag 为 `vX.Y.Z` 的 Release 并自己写说明。
3. `.github/workflows/release.yml` 在 Release 发布时触发：校验 tag 与 `version.ts` 一致 → `node scripts/build-release.mjs` → 把五个程序和 `SHA256SUMS` 传上去。**不要再手工 `gh release upload`**，本地上传慢且中断过。
4. 只有改了 `packages/relay-cf` 才需要 `wrangler deploy`。

`.github/workflows/ci.yml` 在 push 和 PR 上跑 `pnpm typecheck` + `pnpm test`（Node 20 和 24）。

## 需要记住的约定

- **SKILL.md 是生成源**：`skill/SKILL.md` 由 `scripts/build-release.mjs` 转成 `packages/cli/src/skill-text.ts`（被 `agenthop install` 写盘）。改技能文案后要跑一次 build，否则二进制里还是旧文本。README、`bin.ts` 的 `printHelp`、`skill/SKILL.md` 三处说法必须一致，**以 SKILL.md 为准**。`README.en.md` 是 `README.md` 的英文版，**逐节对应**：改一个就改另一个，状态表两边的行必须一样多。
- **文案写正面规则，不要堆禁令**。真正的要求只有两条：一个进程从头跑到尾，整个过程用户看得见。不要再去点名某个具体错法（某某命令、某某文件名）——那是在描述一次事故，不是在描述规则。老的 flag 和命令在 `args.ts` 的 `RETIRED_FLAGS` / `RETIRED_COMMANDS` 里给迁移提示，这是唯一该出现旧名字的地方。
- **版本号在 `packages/cli/src/version.ts`**，`agenthop update` 拿它和中继 `/latest` 比较。发版要改它。
- **两个上限不要再对不上**：`packages/agent` 的 `MAX_ATTACHMENT_BYTES` 是 512 KiB，但 express 的 JSON body 默认只有 100 KiB，于是 96 KiB 的附件就会撞上一个 HTML 413。`host.ts` 现在先挂 `express.json({ limit: "2mb" })`（body-parser 见到 `req._body` 就不会再解析一次），512 KiB 才真的能过。改任一处都要把另一处一起看。
- **中继对同一个房间的写入限速**在 `tunnel` 的 `PostCounter`（60/分钟），两个中继共用；**读取不计**，因为加入方每秒轮询一次。
- **更新要校验**：`scripts/build-release.mjs` 生成 `dist/SHA256SUMS`，它是 release 的第六个资产，也在 Worker 的 `RELEASE_FILES` 白名单里（漏了白名单，取不到校验和的用户就更新不了）。`update` 先拿校验和再下程序（流式写盘、边写边算 sha256，不把 90 MiB 读进内存），对不上就丢掉不替换。**校验和优先从 GitHub 取、程序从中继取**，这样单独一方换不掉你的程序；GitHub 取不到才退回中继那份并说明。`AGENTHOP_RELEASES_BASE` 可以改校验和来源（测试在用）。
- **技能跟着程序一起更新**：`install --skill-dir` 把目录记到 `~/.agenthop/install.json`，`update` 换完程序后再跑一次**新程序**的 `install --skill-only` 把新 SKILL.md 写回去——技能文本编译在二进制里，旧进程手里只有旧文本。写不成时打印手动命令，不要静默留一个过期的技能文件。
- **不要把程序复制到它自己身上**。`install` 从已安装位置运行时 source 和 dest 是同一个文件，copyFileSync 会把它删掉；路径字符串比较不够，家目录经过符号链接时同一个文件有两种写法。用 `isSameFile`（inode+dev），复制走 `placeCommand`（先写 `.new` 再改名）。这个 bug 在 v0.2.0/v0.2.1 上真的删过用户的命令。
- **默认中继 `https://agenthop.imatrix.tech` 写在 `host.ts: DEFAULT_RELAY`**；换中继是运行时的事（`--relay` / `AGENTHOP_RELAY`），不要为了改默认地址发版。
- Worker 在鉴权之前还兼职发布分发：`/latest`（读 GitHub releases/latest 的重定向 Location 取 tag，因为 Worker 里调 GitHub API 失败过）和 `/download/<asset>`，白名单在 `RELEASE_FILES`。
- **房间归第一个开它的 host**：`open` 帧带一个随机 `token`，中继只存 `SHA-256`（relay-cf 放 `meta` 表，relay-node 放房间记录里，socket 断了**不要删房间记录**，否则等于把房间让给下一个来的人）。没带 token 的旧 host 照旧放行，别把这个兼容去掉。
- **中继不留访问者地址**：`RateLimit` 的键是加盐摘要，盐按天轮换，每次 `allow()` 顺手删掉早于当前分钟的行。`RateCounters`（自建中继）同样按窗口清理——那里原本只增不删，既留地址又涨内存。
- **中继自己也有总量上限**：`MAX_ROOM_BYTES`（64 MiB，两个方向都算）在 `RelaySession` 里，超了抛 `room_quota`，两个中继都映射成 429。CLI 的 8 MiB 配额是 host 自律，拦不住不配合的客户端。
- **加密层在 `HopMessage.text` 之内，中继不参与**（`packages/cli/src/seal.ts`）。这个层是挑出来的：再往下一层，中继就改不了 Agent Card（`card.ts` 要 JSON.parse 那个响应，失败就是硬 502），路由也没法做。所以 seal 挂在 `session.ts` 的 `say`/`send` 两个传输闭包里，八个 wire 构造点一个都不碰；解封在 `accept` 和两个轮询点。**`write()` 拿到的永远是明文**，stdout 的格式契约不变。
- **配对码分两半，密钥那半绝不进中继**：`addressOf` 在 `host.ts:52` 剥一次，`relayEndpoints` 再剥一次，中继还会拒五段码——三道独立关卡。日志文件名只用地址；`local waiting` 那一行是唯一该出现完整码的地方（它就是交给对方的东西）。**中继只认四段地址，所以 v0.4 之前的中继原样就能服务 v0.4 的客户端**，改中继时这个 diff 应该只有 `isRoomAddress` 这个名字。
- **`open()` 是纯函数，防重放的 `fresh()` 是另一个对象**。创建方对每条进来的消息解密两次（`accept` 一次、轮询循环一次），把重放检查塞进 `open()` 会让每一条正常消息在第二次查看时被拒。拒绝时**必须写出 `peer refused`**——静默丢话那条规矩在这里同样不能退。
- **词表里每个词都得是一段纯小写字母**（`tunnel.test.ts` 有不变量测试）。`wordlist.ts` 曾经混进一个 `yo-yo`，抽中就生成五段码，中继直接拒绝，0.23% 的会话一开就废。`generateCode` 现在也校验自己的输出。
- 房间 10 分钟没有转发就消失（`IDLE_MS`）。TLS 在 Cloudflare 终结，但中继拿到的是密文——**没有前向保密**，别在文档里暗示有。
- **文件跟一句加密的 `file` 消息一起走**（v0.5.0）：头部（名字、类型、大小、SHA-256）在那一句里，字节用同一把方向密钥另外封一层（`seal.ts: sealBytes`，和消息用不同的 AAD 标签，一个不能冒充另一个）。加入方→创建方随 POST 的 raw part 走，在 `Room` 里经 `unsealFiles` 解封、核对哈希之后才落盘；创建方→加入方以前**根本没有路**（队列只返回文件元数据），现在封好的字节挂在 `Talk` 事件的 `data` 上、经队列取走。512 KiB 上限在 `packages/agent`。
- **中继能读的队列不许带出解封后的东西**：`host.ts: overTheRelay` 只让"创建方发出的文件"以 `sealed` 的名字和封好的字节出现在 `/agenthop/queue` 里。加入方发来的文件，其真实名字和创建方本机的收件路径是解封**之后**才写进房间日志的，原样吐出去等于把名字和路径交给任何拿到房间地址的人。本机的 control server 不受影响，它要完整信息。
- **一句说要发文件、却没带文件的 `file` 消息，要写 `peer refused`**。没有文件就不走 `noteFiles`，而分发里又没有 `file` 分支——它曾经就这样一声不响地消失过。
- **`outbox.flush` 的 `send` 直接传，不要包成 `(wire) => send(wire)`**。第二个参数是文件字节，包一层就丢了——加入方发的文件真的因此从来没到过，而日志写着 `local files` 以为送到了。
- 注释和 commit message 用英文，README / SKILL.md / CLI 帮助文本用中文（`README.en.md` 除外）。
