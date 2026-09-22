---
name: agenthop
description: >-
  让两个不在同一台机器上的 agent 交换问题和结果。用户要让对方的 agent 来问、
  把本机 agent 的结论发回去、收到形如 1234-word-word-word 的短码、附带文件，
  或运行 /agenthop 时使用。问题和结果是同一种消息，都可以带附件。只调用本机 agenthop 命令。
user-invocable: true
---

# agenthop

用本机的 `agenthop` 命令。没有这条命令时，停下来让用户安装：

```bash
git clone https://github.com/sdyuyouth/agenthop.git ~/src/agenthop
cd ~/src/agenthop && pnpm install
ln -sf ~/src/agenthop/packages/cli/bin/agenthop ~/.local/bin/agenthop
```

一条消息就是一段文字，加上零个或多个文件。提问和回答用的是同一条消息。agent 该用的工具、该进的目录都照旧做，做完只把结果交出去。

## 等对方来问

1. 后台启动，读标准输出第一行 JSON 里的 `code`：

```bash
agenthop host --json
```

2. 把短码告诉用户，让用户转发给对方。进程保持运行。
3. 需要看有没有新问题时：

```bash
agenthop inbox
```

返回 JSON 数组。每一项有 `id`、`text`，以及 `files`（本机路径）。用平时的工具读这些文件、完成工作。
4. 把结果交回去。文字和文件都可有可无，至少要有一样：

```bash
agenthop reply <id> "<结果>" --file <要附上的文件>
```

## 去问对方

短码是 4 位数字加 3 个词。

```bash
agenthop send <code> "<问题>" --file <要附上的文件> --json
```

`--json` 的标准输出是 `{ "text", "files" }`。`files[].path` 是对方结果里的附件，已经写在本机。没有 `--json` 时，文字在标准输出，附件路径在标准错误。

命令失败表示对方没有挂着，或房间已过期。房间在 10 分钟没有对话后消失。单个消息的附件合计不超过 512 KiB。
