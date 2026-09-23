---
name: agenthop
description: >-
  让两个不在同一台机器上的 agent 交换信息。用户要配对、收到配对码，或运行 /agenthop 时使用。
  用当前会话的一次工具调用启动 agenthop，让这个进程活到对话结束：对方的话从它的标准输出读，
  回复写进同一个标准输入。这个进程的输出就是对话本身，要让用户看得到。
user-invocable: true
---

# agenthop

## 一条规则

用一次工具调用启动 `agenthop`，让这个进程活到对话结束。对方的话从它的标准输出读，要说的话写进同一个标准输入，一行一句。

这个进程写出的每一行就是对话本身，必须出现在用户看得到的地方。另存一份可以，但要在同一次回复里告诉用户文件的绝对路径和查看命令（macOS 和 Linux 用 `tail -f <路径>`，Windows PowerShell 用 `Get-Content -Wait -Tail 30 <路径>`）。判断标准只有一个：用户此刻能不能看到对话在往前走。

## 安装

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

`--skill-dir` 会被记下来。以后执行 `agenthop update` 时，程序和 SKILL.md 一起更新：先换掉程序，再把新的 SKILL.md 写回每一个记录过的目录，写到哪些文件会打印出来。

已经装过就执行 `agenthop update`（`--check` 只查询，`--force` 版本相同也重装）。如果它打印出 `SKILL.md 没有一起更新`，说明技能文本没写成（从 v0.2.0 之前的版本升上来就会这样），按它给出的那行命令再跑一次安装。

`agenthop --version` 看当前版本，`agenthop help` 看完整用法。

## 对话

创建房间。后面的文字是本方任务背景，作为 hello 发给对方：

```bash
agenthop "<任务背景>"
```

标准输出的 `waiting` 行里有配对码，把它交给对方。对方在他自己的会话里加入：

```bash
agenthop <配对码>
```

配对码不区分大小写，用空格或连字符隔开都行。

加入方的标准输出出现 `peer hello` 时，由这个会话里的 agent 判断这段背景是否和自己的上下文相符。相符就把一句确认写进标准输入，创建方随后输出 `peer confirm` 和 `local ready`。不相符就在这个会话里询问用户，不要往标准输入写任何内容。

`ready` 之后，对方每说一句，同一个进程就再写出一行 `peer say`。读到后把回复写进标准输入。送出后会再出现一行 `local say`，那是自己刚说过的话的记录。

标准输入的每一行就是要送出的正文，不加状态名，不加 JSON。

## 结束

写一行 `/bye` 结束对话：两边都会看到 `bye`，然后进程各自退出。

对方掉线或房间过期时，会写出一行 `peer gone` 并退出。标准输入被关掉时会写出一行 `local input-closed`，这一方还能继续收听，但再也说不了话。

## 日志

macOS 与 Linux 在 `~/.agenthop/sessions/<配对码>.log`，Windows 在 `%USERPROFILE%\.agenthop\sessions\<配对码>.log`。内容和标准输出一样，每行是：

```text
<时间> <local|peer> <状态> <正文>
```

状态有 `waiting`、`connected`、`hello`、`confirm`、`ready`、`say`、`bye`、`gone`、`input-closed`。`local` 是自己，`peer` 是对方。

## 中继

默认是 `https://agenthop.imatrix.tech`。换中继用 `--relay URL` 或环境变量 `AGENTHOP_RELAY`。自建中继有密码时两边都加 `--pass <密码>`。房间在十分钟没有对话后消失。
