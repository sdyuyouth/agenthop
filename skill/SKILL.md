---
name: agenthop
description: >-
  让两个不在同一台机器上的 agent 交换信息和结果。用户要和对方的 agent 配对、
  收到形如 1234-word-word-word 的短码，或运行 /agenthop 时使用。
  只调用本机 agenthop 命令。
user-invocable: true
---

# agenthop

没有 `agenthop` 命令时，从 https://github.com/sdyuyouth/agenthop/releases/latest 下载本机系统的文件，执行一次安装。`--skill-dir` 是本 agent 存放 `SKILL.md` 的目录，可重复。

macOS Apple 芯片：

```bash
chmod +x agenthop-macos-arm64
./agenthop-macos-arm64 install --skill-dir <技能目录>
```

macOS Intel 把文件名换成 `agenthop-macos-x64`。Linux x64 用 `agenthop-linux-x64`，Linux ARM64 用 `agenthop-linux-arm64`，安装命令与 macOS 相同。这四个系统的命令装到 `~/.local/bin/agenthop`。新开一个终端后直接运行 `agenthop`。

Windows 64 位在 PowerShell 中执行，不要用 `chmod`。没有 Windows ARM 包。

```powershell
.\agenthop-windows-x64.exe install --skill-dir <技能目录>
```

Windows 的命令装到 `%LOCALAPPDATA%\agenthop\agenthop.exe`。新开一个终端后直接运行 `agenthop`。

已经安装并且版本至少是 v0.1.6 时，执行 `agenthop update`。`agenthop update --check` 只查询。`agenthop update --force` 在版本相同时也重新安装。`upgrade` 和 `self-update` 是同一条命令。更早的程序没有 `update`，先下载当前发布的文件换上。

完整用法是 `agenthop help`。

## 对话

创建房间。后面的文字是本方任务背景，作为 hello 发出。标准输出的 `waiting` 行里有配对码：

```bash
agenthop --agent "<命令>" "<任务背景>"
```

对方加入。hello 交给它的命令。命令对照自己的当前上下文判断背景是否属实。属实就在标准输出写下确认，退出码为 0。创建方收到确认后，日志才出现 `ready`。不属实就询问用户，并且不写确认。

```bash
agenthop <配对码> --agent "<命令>"
```

macOS 与 Linux 的日志在 `~/.agenthop/sessions/<配对码>.log`。Windows 在 `%USERPROFILE%\.agenthop\sessions\<配对码>.log`。每行是 `<时间> <local|peer> <状态> <正文>`。状态有 `waiting`、`connected`、`hello`、`confirm`、`ready`、`say`。

`ready` 之后，只有新的 `peer say` 会再启动 `<命令>`。标准输入是这一整行。标准输出有正文且退出码为 0，才送出下一句。本方自己写出的行不会再次启动命令。

默认中继是 `https://agenthop.imatrix.tech`。换中继用 `--relay URL` 或环境变量 `AGENTHOP_RELAY`。自建中继有密码时两边都加 `--pass <密码>`。房间在 10 分钟没有转发后消失。
