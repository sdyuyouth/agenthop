# 参与开发

## 环境

Node.js 20 或更新，仓库是 pnpm workspace。终端用户不需要这些——他们下载 Release 里的单文件程序。

```bash
git clone https://github.com/sdyuyouth/agenthop.git
cd agenthop
node scripts/setup.mjs      # 装依赖，并把 dev launcher 链到 ~/.local/bin/agenthop
```

之后不必安装也能直接跑：

```bash
node packages/cli/bin/agenthop.mjs help
```

## 测试

```bash
pnpm typecheck
pnpm test                                                        # 全部包，按包串行
pnpm --filter @agenthop/cli test                                 # 单个包
pnpm --filter @agenthop/cli exec vitest run test/session.test.ts # 单个文件
pnpm --filter @agenthop/cli exec vitest run -t "says goodbye"    # 单个用例
```

这些测试起真的 HTTP server、真的中继、真的子进程。`pnpm test` 因此按包串行（`--workspace-concurrency=1`）——几个包一起跑会互相抢 CPU，症状是某一行等二十秒都不出现。**不要为了快把并发加回来。**

`@agenthop/relay-cf` 的测试有两套：快的那套跑在 workers pool 上，另一套真的启动 `wrangler dev`。后者在 CI 上默认跳过（要跑就设 `AGENTHOP_LIVE=1`），本地 `pnpm test` 会跑。

## 几条这个仓库特有的规矩

- **`skill/SKILL.md` 是生成源。** 它由 `scripts/build-release.mjs` 转成 `packages/cli/src/skill-text.ts` 编进程序。改了技能文案就要重新生成，否则程序里还是旧文本。
- **三处说法必须一致**：`skill/SKILL.md`、`README.md`、`packages/cli/src/bin.ts` 里的 `printHelp`。以 SKILL.md 为准。
- **中继逻辑写在 `@agenthop/tunnel`**，两个中继（Node 和 Cloudflare Workers）共用它，不要在两边各写一遍。
- **stdout 的每一行就是对外接口**，agent 靠它工作。改格式等于改契约，要连文档一起改。
- 代码注释和 commit message 用英文；README、SKILL.md、CLI 帮助文本用中文。

`CLAUDE.md` 里有更细的架构说明，写给在这个仓库里干活的人和 agent。

## 发版

1. 改 `packages/cli/src/version.ts`。
2. 提交、推送。
3. 在 GitHub 上建一个 tag 为 `vX.Y.Z` 的 Release，自己写说明。
4. Release 一发布，CI 会编出五个平台的程序和 `SHA256SUMS` 并传上去。tag 和 `version.ts` 对不上会直接失败。

`agenthop update` 会校验 `SHA256SUMS`，所以这个文件必须跟着程序一起发。
