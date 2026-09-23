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

`session.test.ts` 里的会话用 `start()` 起，它把提前失败的原因记进 `failures`，`waitForText` 会把原因抛出来——不这样的话一个早退的会话只会表现成"某一行没等到"。`relay.test.ts` 的 `step()` 同理，给每个 await 一个标签。**这两处不要去掉**：长期被当成"机器慢"的那个偶发，正是靠它们才暴露出真实原因（relay-node 在 accept 之后才挂监听器的竞态，见下）。

## 包与依赖方向

```
tunnel ─┬─ relay-node（自建中继，ws + node:http）
        ├─ relay-cf（Cloudflare Worker，Durable Object 每房间一个）
        └─ cli ── agent（A2A Part ↔ HopMessage 编解码、附件上限 512 KiB）
```

**接受连接之前把异步的事做完。** `relay-node` 曾经先 `handleUpgrade` 再 `await roomIdFromCode`，然后才挂 `ws.once("message")`——host 在这个窗口里发出的 `open` 帧没人接，于是永远等不到 `ready`。快机器上几乎碰不到，CI 上很常见。现在房间 id 在 accept 之前算好，accept 与挂监听之间没有任何 await。`relay-cf` 没有这个问题（DO 的 `webSocketMessage` 是常驻方法，房间 id 在 Worker 里就算好了）。

`@agenthop/tunnel` 是唯一被两个中继共享的实现：`session.ts` 的 `RelaySession` 就是房间逻辑本体（转发、Agent Card 改写、空闲关闭），两个中继各自只写自己的传输层。**修 bug 优先改 tunnel，不要在两个中继里各写一遍。**

## 一次对话是怎么跑起来的

面向用户的命令只有 `agenthop <任务背景>`（创建）和 `agenthop <配对码>`（加入），加上 install / update / relay / help / --version。`bin.ts` 只做分发，参数解析和输入分类在 `args.ts`（可单测，`bin.ts` 一导入就会执行，不要在测试里 import 它）。

创建方（`session.ts: createSession`）：

1. `startHost()` 生成配对码，起两个本地 HTTP server：一个跑 A2A（express + `@a2a-js/sdk`），一个是只有本机能访问的 control server（`room.ts: listenControl`，`GET /queue`、`POST /message`）。
2. 一条 WebSocket 连到中继 `/host/<code>`，`HostBridge`（`bridge.ts`）把隧道帧翻译成对本地 A2A server 的 fetch。对方发到 `/r/<code>/...` 的 HTTP 就这样落到本地。
3. 之后轮询自己的 control server（200ms），按状态机推进。

加入方没有 host，直接用 `sendMessage()` 打中继的 `/r/<code>/`，并轮询 `agenthop/queue` 读事件（1s；这个轮询同时也是房间的保活）。

**断线不等于结束**：创建方的 WS 掉了就按退避重开房间（`host.ts: recover`，同一个配对码，`RECOVER_MS` 45 秒），加入方读不到房间时也重试同样长。两边都会写 `reconnecting` / `reconnected`。房间是按配对码寻址的，所以重开之后对话接得上——`Talk` 日志在本地进程里，没丢。

状态机靠**正文里的 wire 前缀**区分，不是靠协议字段：`[[agenthop:connect:<id>]]`、`[[agenthop:hello]] …`、`[[agenthop:confirm:<id>]] …`、`[[agenthop:say:<id>]] …`、`[[agenthop:bye:<id>]]`（`session.ts: parseWire`）。顺序固定为 `connect → hello → confirm → ready → say → bye`。加入方在 `wait-confirm` 之前写的行会被暂存（`early`），确认之后才放行——改这段时别把暂存丢了。

`<id>` 是加入方自己生成的，创建方只认第一个 connect 带来的那个，别人拿着同一个配对码说话会被记成 `peer refused`。**没有 id 的行按旧版本接受**（`id === ""`），别把这个兼容去掉。房间本身不认人：拿到码的人都能 POST，过滤发生在会话层。

**stdin 的语义**：一行正文就是一句话；`/bye`（`session.ts: BYE`）结束对话；EOF **不等于** bye——只写一行 `local input-closed` 然后继续收听，因为很多 agent harness 启动子进程时 stdin 本来就是关的，EOF 触发退出会让房间刚开就关。

**告别是双向的**：收到 `[[agenthop:bye]]` 的一方自动把 bye 回过去再退出，先说的一方等这个回复，等不到就写 `peer gone`。`saidBye` 挡住无限对回。创建方作为回话方时要 linger 两秒再关房间，因为对方是隔着中继轮询读的。

**送不出去的话要留痕**：`outbox.flush` 把发送失败的行写成 `local undelivered <正文>`，终止前 `reportUnsent()` 把还没送出的行也倒出来。静默丢话会让 agent 以为自己回复过——这是最不能退的一条。

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

- **SKILL.md 是生成源**：`skill/SKILL.md` 由 `scripts/build-release.mjs` 转成 `packages/cli/src/skill-text.ts`（被 `agenthop install` 写盘）。改技能文案后要跑一次 build，否则二进制里还是旧文本。README、`bin.ts` 的 `printHelp`、`skill/SKILL.md` 三处说法必须一致，**以 SKILL.md 为准**。
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
- 房间 10 分钟没有转发就消失（`IDLE_MS`），配对码就是唯一凭证。TLS 在 Cloudflare 终结，托管中继能读到正文，这一版没有端到端加密——别在文档里暗示有。
- 附件（`packages/agent`，512 KiB 上限）在协议和 `Room` 里还在，但会话流程没有入口。`SPEC.md` 仍然描述它，不要顺手删。
- 注释和 commit message 用英文，README / SKILL.md / CLI 帮助文本用中文。
