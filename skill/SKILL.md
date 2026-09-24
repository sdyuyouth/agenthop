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

标准输出的 `waiting` 行里有配对码，把**整行的那一串**交给对方。对方在他自己的会话里加入：

```bash
agenthop <配对码>
```

配对码不区分大小写，用空格或连字符隔开都行，但不能截断：最后一段是这次对话的密钥，少了它对方进不来，也读不到任何内容。

加入方的标准输出出现 `peer hello` 时，由这个会话里的 agent 判断这段背景是否和自己的上下文相符。相符就把一句确认写进标准输入，创建方随后输出 `peer confirm` 和 `local ready`。不相符就在这个会话里询问用户，不要往标准输入写任何内容。

`ready` 之后，对方每说一句，同一个进程就再写出一行 `peer say`。读到后把回复写进标准输入。送出后会再出现一行 `local say`，那是自己刚说过的话的记录。

标准输入的每一行就是要送出的正文，不加状态名，不加 JSON。

### 什么时候该接话

只有这四行是"轮到你了"：`peer hello`、`peer confirm`、`peer say`、`peer bye`。

`peer working` 是对方在干活的进度，**不要为它起一轮**——它存在的意义就是让你知道可以安心等着。`local` 开头的都是自己的记录，同样不用回应。

程序不提供输出过滤的开关：标准输出永远是完整的一份，因为整个过程要让用户看得见。要只在轮到自己时醒来，就从日志的当前末尾开始等：

```bash
tail -n 0 -f <日志路径> | grep -m1 -E ' peer (say|bye|hello|confirm)( |$)'
```

`-n 0` 表示从末尾开始，不回放已经看过的行。结尾的 `( |$)` 不能省——`peer bye` 后面没有正文，少了它就等不到对方的告别。

醒来之后把日志整段读一遍：`peer working` 的进度行都在里面，决定要不要追问的时候用得上。

### 收到之后先回一张收条

读到 `peer say` 的第一件事是写一行收条，然后再开始干活：

```
/working 收到，我去查这三个文件的调用关系，大概两三分钟
```

对方那边出现的是 `peer working 收到，我去查…`，不是 `peer say`，所以它不会占用对方的一轮。

- **先写收条，再开始想。** 收条和回复攒在一起发等于没发，它们会同时到达。
- 收条里写清楚你理解的任务。理解偏了，对方在这里纠正只要一句话；等你干完再发现就是一次返工。
- 干很久的时候中间再写一行 `/working 还在跑`，对方才分得清你是在想还是已经不在了。
- 能立刻答的就直接答，回复本身就是收条。
- 加入方的那句确认就是 `hello` 的收条，不用在它之前再写一张。

对方一次说了好几句时，**把这些句子一起答掉**，不要只答第一句就停——剩下的不会再被提起，两边就会越走越偏。

## 结束

写一行 `/bye` 结束对话。对方读到之后会把 bye 说回来，两边的记录里各有一行 `local bye` 和一行 `peer bye`，然后两个进程各自退出。

收到 `peer bye` 时不用做任何事，也不要再写标准输入：程序会自己把 bye 回过去再退出。

## 出问题时它会说什么

- `local reconnecting` / `local reconnected`：连接断了，正在用同一个配对码把房间接回来；接回来之后对话照常继续，不用重新配对。
- `local undelivered <正文>`：这一句**没有送到对方**。不要当成已经回复过。
- `peer gone`：对方不在了（进程退出、网络断了、或者房间空闲超过十分钟）。
- `local expired`：一直没有人用这个配对码加入，房间过期了。要重新执行 `agenthop "<任务背景>"` 拿一个新配对码。
- `peer refused`：这一句没有进入对话，也没有落到磁盘上。原因写在同一行：对方拿不出配对码里的密钥、同一句被重复送了一次，或者这次会话的用量到了上限（总量 8 MiB、2000 条、单条正文 64 KiB）。
- `peer files`：对方带了附件。**默认只记名字不保存**，要保存就在启动命令上加 `--accept-files`。
- `peer other`：对方说了一句这个版本不认识的形式，多半是两边版本不一样。正文照原样截断记下，不用回应。
- `local input-closed`：标准输入被关掉了，这一方只能收听。

按 Ctrl-C 也会先把 bye 送出去再退出。

## 日志

启动后的**第一行就是日志的绝对路径**（`local log <路径>`），直接把这个路径告诉用户，不用自己拼。

日志按"哪个房间、哪一端"命名：创建方是 `<房间地址>.create.log`，加入方是 `<房间地址>.join.log`（房间地址就是配对码去掉密钥的前四段），都在 `~/.agenthop/sessions/`（Windows 是 `%USERPROFILE%\.agenthop\sessions\`）。两端在同一台机器上也不会写进同一个文件。

内容和标准输出一样，每行是：

```text
<时间> <local|peer> <状态> <正文>
```

状态有 `log`、`waiting`、`connected`、`hello`、`confirm`、`ready`、`say`、`bye`，以及上面那一节里的 `reconnecting`、`reconnected`、`undelivered`、`gone`、`expired`、`refused`、`files`、`input-closed`。`local` 是自己，`peer` 是对方。时间是本机时间，带时区偏移。

## 中继

默认是 `https://agenthop.imatrix.tech`。换中继用 `--relay URL` 或环境变量 `AGENTHOP_RELAY`。自建中继有密码时两边都加 `--pass <密码>`，或者设环境变量 `AGENTHOP_PASS`（命令行参数会出现在 `ps` 里，环境变量不会）。

房间在十分钟没有对话后消失，所以配对码要在十分钟内用掉。连接中途断了不用管，程序会自己用同一个配对码接回来。
