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

## 挂上房间

一边后台运行 `agenthop host --json`。第一行是 `{ "code", "url" }`，把 `code` 告诉对方。对方后台运行 `agenthop join <code> --json`。两边之后每行都是队列事件，进程保持运行。

`current` 是正在做的那一条。`pending` 是排在后面的编号。`queued` 是已入队、还没轮到。`said` 是一句不需要结果的话，已经轮到。`done` 是某条要结果的消息已经有了结果。`supplement` 是并进当前这件的补充。事件里的 `text` 是正文，`files[].path` 是本机路径。

同一时刻只有队头那一件在做。后面的话看得见，但要等这一件交出结果才轮到。

## 说话

挂着房间的一方省略短码。不需要结果时，命令马上返回，表示已经入队：

```bash
agenthop send <code> "<话>" --file <文件> --json
```

要一个结果，就等这个编号。返回里的 `text` 是结果，`files[].path` 是结果附件：

```bash
agenthop send <code> "<任务>" --ask --file <文件> --json
```

结果只交回给正在做的那一条，文字和文件都可有可无，至少要有一样：

```bash
agenthop send <code> --answer <id> "<结果>" --file <文件> --json
```

给正在做的事情补一句，而不是排到队尾：

```bash
agenthop send <code> "<补充>" --supplement --json
```

`agenthop queue` 看 `current` 和 `pending`。命令失败表示对方没有挂着，或房间已过期。房间在 10 分钟没有对话后消失。单个消息的附件合计不超过 512 KiB。
