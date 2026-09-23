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

`@agenthop/relay-cf` 的 `test` 会跑两套配置：`vitest.config.ts`（workers pool，快）和 `vitest.live.config.ts`（真的 `wrangler dev`，30s 超时）。只想要快的那套时直接 `vitest run --config vitest.config.ts`。

## 包与依赖方向

```
tunnel ─┬─ relay-node（自建中继，ws + node:http）
        ├─ relay-cf（Cloudflare Worker，Durable Object 每房间一个）
        └─ cli ── agent（A2A Part ↔ HopMessage 编解码、附件上限 512 KiB）
```

`@agenthop/tunnel` 是唯一被两个中继共享的实现：`session.ts` 的 `RelaySession` 就是房间逻辑本体（转发、Agent Card 改写、空闲关闭），两个中继各自只写自己的传输层。**修 bug 优先改 tunnel，不要在两个中继里各写一遍。**

## 一次对话是怎么跑起来的

面向用户的命令只有 `agenthop <任务背景>`（创建）和 `agenthop <配对码>`（加入），加上 install / update / relay / help / --version。`bin.ts` 只做分发，参数解析和输入分类在 `args.ts`（可单测，`bin.ts` 一导入就会执行，不要在测试里 import 它）。

创建方（`session.ts: createSession`）：

1. `startHost()` 生成配对码，起两个本地 HTTP server：一个跑 A2A（express + `@a2a-js/sdk`），一个是只有本机能访问的 control server（`room.ts: listenControl`，`GET /queue`、`POST /message`）。
2. 一条 WebSocket 连到中继 `/host/<code>`，`HostBridge`（`bridge.ts`）把隧道帧翻译成对本地 A2A server 的 fetch。对方发到 `/r/<code>/...` 的 HTTP 就这样落到本地。
3. 之后轮询自己的 control server（200ms），按状态机推进。

加入方没有 host，直接用 `sendMessage()` 打中继的 `/r/<code>/`，并轮询 `agenthop/queue` 读事件（1s；这个轮询同时也是房间的保活）。

状态机靠**正文里的 wire 前缀**区分，不是靠协议字段：`[[agenthop:connect]]`、`[[agenthop:hello]] …`、`[[agenthop:confirm]] …`、`[[agenthop:say]] …`、`[[agenthop:bye]]`（`session.ts: parseWire`）。顺序固定为 `connect → hello → confirm → ready → say → bye`。加入方在 `wait-confirm` 之前写的行会被暂存（`early`），确认之后才放行——改这段时别把暂存丢了。

**stdin 的语义**：一行正文就是一句话；`/bye`（`session.ts: BYE`）结束对话；EOF **不等于** bye——只写一行 `local input-closed` 然后继续收听，因为很多 agent harness 启动子进程时 stdin 本来就是关的，EOF 触发退出会让房间刚开就关。创建方发出 bye 后会 linger 两秒再关房间，好让对方读到那一行。

日志与 stdout 同一份内容：`<时间> <local|peer> <状态> <正文>`，写到 `<家目录>/.agenthop/sessions/<配对码>.log`（`session.ts: write`）。**stdout 的格式就是 agent 的接口**，改格式等于改 SKILL.md 的契约。`local` 恒指自己，`peer` 恒指对方——不要再让一个状态词在两边表示不同的事。

## 队列语义（Talk / Room）

`talk.ts` 的 `Talk` 是一条**只增不改的有序日志**：两边说的每一句按 seq 排好，`since(seq)` 给出新的部分，加入方靠它拉增量。没有提问/回答/补充的区分——v0.1.6 之前那套 ask/answer/supplement 队列已经随旧命令一起删掉了，不要再引入。

`room.ts` 的 `Room` 把 A2A 请求和本地 control 请求都收敛到 `admit()`，并用 `run()` 串行化。事件回调发生在锁释放之后（`takeNew()` + watermark），**动 `Room` 时保持这个顺序**，否则监听者在回调里说话会重入死锁。

`talk.test.ts` 覆盖日志顺序，`e2e.test.ts` 起真中继 + 真 host 覆盖传输层（含附件落到 `inbox/`），`session.test.ts` 用 `lineQueue` 跑完整的握手、bye、gone、input-closed。

## 需要记住的约定

- **SKILL.md 是生成源**：`skill/SKILL.md` 由 `scripts/build-release.mjs` 转成 `packages/cli/src/skill-text.ts`（被 `agenthop install` 写盘）。改技能文案后要跑一次 build，否则二进制里还是旧文本。README、`bin.ts` 的 `printHelp`、`skill/SKILL.md` 三处说法必须一致，**以 SKILL.md 为准**。
- **文案写正面规则，不要堆禁令**。真正的要求只有两条：一个进程从头跑到尾，整个过程用户看得见。不要再去点名某个具体错法（某某命令、某某文件名）——那是在描述一次事故，不是在描述规则。老的 flag 和命令在 `args.ts` 的 `RETIRED_FLAGS` / `RETIRED_COMMANDS` 里给迁移提示，这是唯一该出现旧名字的地方。
- **版本号在 `packages/cli/src/version.ts`**，`agenthop update` 拿它和中继 `/latest` 比较。发版要改它。
- **技能跟着程序一起更新**：`install --skill-dir` 把目录记到 `~/.agenthop/install.json`，`update` 换完程序后再跑一次**新程序**的 `install --skill-only` 把新 SKILL.md 写回去——技能文本编译在二进制里，旧进程手里只有旧文本。写不成时打印手动命令，不要静默留一个过期的技能文件。
- **不要把程序复制到它自己身上**。`install` 从已安装位置运行时 source 和 dest 是同一个文件，copyFileSync 会把它删掉；路径字符串比较不够，家目录经过符号链接时同一个文件有两种写法。用 `isSameFile`（inode+dev），复制走 `placeCommand`（先写 `.new` 再改名）。这个 bug 在 v0.2.0/v0.2.1 上真的删过用户的命令。
- **默认中继 `https://agenthop.imatrix.tech` 写在 `host.ts: DEFAULT_RELAY`**；换中继是运行时的事（`--relay` / `AGENTHOP_RELAY`），不要为了改默认地址发版。
- Worker 在鉴权之前还兼职发布分发：`/latest`（读 GitHub releases/latest 的重定向 Location 取 tag，因为 Worker 里调 GitHub API 失败过）和 `/download/<asset>`，白名单在 `RELEASE_FILES`。
- 房间 10 分钟没有转发就消失（`IDLE_MS`），配对码就是唯一凭证。TLS 在 Cloudflare 终结，托管中继能读到正文，这一版没有端到端加密——别在文档里暗示有。
- 附件（`packages/agent`，512 KiB 上限）在协议和 `Room` 里还在，但会话流程没有入口。`SPEC.md` 仍然描述它，不要顺手删。
- 注释和 commit message 用英文，README / SKILL.md / CLI 帮助文本用中文。
