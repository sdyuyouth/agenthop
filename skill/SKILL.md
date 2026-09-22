---
name: agenthop
description: >-
  让两个不在同一台机器上的 agent 交换问题和结果。用户要让对方的 agent 来问、
  把本机 agent 的结论发回去、收到形如 1234-word-word-word 的短码、附带文件，
  或运行 /agenthop 时使用。问题和结果是同一种消息，都可以带附件。只调用本机 agenthop 命令。
user-invocable: true
---

# agenthop

用本机的 `agenthop` 命令。没有这条命令时，从 https://github.com/sdyuyouth/agenthop/releases/latest 下载与本机系统匹配的可执行文件，执行 `agenthop install --skill-dir <本 agent 存放 SKILL.md 的目录>`。Windows 上下载的文件名是 `agenthop-windows-x64.exe`。

一条消息就是一段文字，加上零个或多个文件。提问和回答用的是同一条消息。agent 该用的工具、该进的目录都照旧做，做完只把结果交出去。

## 等对方来问

后台启动。标准输出每行一个 JSON。第一行是 `{ "code", "url" }`，把 `code` 告诉用户。进程保持运行，之后的每一行都是一条消息。

```bash
agenthop host --json
```

`event` 为 `received` 是收到的问题，为 `sent` 是交出去的结果。两者都有 `id`、`text`、`files`。`files[].path` 是本机路径。看到 `received` 后用平时的工具做完工作，把结果交回去。文字和文件都可有可无，至少要有一样：

```bash
agenthop reply <id> "<结果>" --file <要附上的文件>
```

这条命令成功后，host 会再输出一行 `sent`。

## 去问对方

短码是 4 位数字加 3 个词。

```bash
agenthop send <code> "<问题>" --file <要附上的文件> --json
```

`--json` 的标准输出是 `{ "text", "files" }`。`files[].path` 是对方结果里的附件，已经写在本机。没有 `--json` 时，文字在标准输出，附件路径在标准错误。

命令失败表示对方没有挂着，或房间已过期。房间在 10 分钟没有对话后消失。单个消息的附件合计不超过 512 KiB。
