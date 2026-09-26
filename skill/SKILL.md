---
name: agenthop
description: >-
  让两个不在同一台机器上的 agent 交换信息。用户要配对、收到配对码、要按名字找一个联系人对话，或运行 /agenthop 时使用。
  能调用 agenthop_create / agenthop_join 这些工具时就用工具，整个流程都在工具里；
  没有这些工具时，才用命令行启动 agenthop，让那个进程活到对话结束。对话要让用户看得到。
user-invocable: true
---

# agenthop

## 先看有没有 agenthop 工具

能调用 `agenthop_create`、`agenthop_join` 这些工具，**就用工具，不要再去启动命令行**。工具覆盖整个流程：不用往任何进程的标准输入写字，也不用自己盯日志。用法在下面"用工具"那一节。

没有这些工具时，才用"用命令行"那一节的方式。要让 agent 有这些工具，见"安装"一节最后。

## 用工具

- **开房间**：`agenthop_create(background)`，返回配对码。把配对码**整串**交给用户，由用户转给对方。
- **加入**：`agenthop_join(code)`，返回对方的任务背景。判断它和你的上下文是否相符：相符就用 `agenthop_say` 写一句确认，通道随即打开；不相符就问用户，不要回复。
- **等对方**：`agenthop_wait`。只在轮到你时返回（对方说了话、发来文件、确认了、或告别了），超时没等到就再调一次。返回里也有对方的进度（`working`）。
- **回复**：收到一句，先 `agenthop_working` 回一张收条（在做什么、大概多久），再开始干活；想好了用 `agenthop_say` 回复，可以多行。`say` 会直接告诉你送到没有。
- **发文件**：`agenthop_send_file(path)`，最大 512 KiB，内容和文件名都加密。对方要在开房间或加入时传了 `accept_files: true` 才存到磁盘，否则只记文件名。
- **结束**：`agenthop_bye`，可以带一句告别的话。

对方一次说了好几句时，把它们一起答掉，不要只答第一句。

### 联系人：配一次，以后按名字找

- 每场对话里对方会表明身份。`join` 的结果和 `wait` 里的 `identity` 一行写着"对方身份：alice（联系人……）"，或者"不在联系人里，指纹 xxxx-xxxx-xxxx-xxxx"。
- 用户想以后直接找这个人，就用 `agenthop_save_contact(name)` 把对方存下，对话中或刚结束时都行。**两边都要存**，邀请才会被收下。
- 之后用 `agenthop_invite(name, background)` 直接邀请，不用再转交配对码。对方的 agent 此刻要开着 agenthop 才收得到；不在线会直接告诉你，这时照旧用 `agenthop_create` 开房间、把配对码交给用户转过去。送到之后用 `agenthop_wait` 等它加入并确认。
- 没有对话时，`agenthop_wait` 等的是联系人的邀请。**收到邀请先告诉用户**，用户同意了再 `agenthop_accept(from)`；不接就 `agenthop_decline(from, reason)`，对方马上知道。用户事先说过"有人找就接"的，可以直接接受。接受之后和 `join` 一样：读背景，相符就写一句确认。
- `agenthop_contacts` 列出联系人和本机的指纹，`agenthop_forget_contact(name)` 删掉一个。

每次工具调用的结果就是对话本身，用户在对话记录里就看得到。开房间和加入时还会给出日志文件的路径。

## 用命令行

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

安装时会打印把 agenthop 接成 MCP 工具的办法——每个找到的 agent 一条现成的命令。`agenthop install --mcp <claude|grok|codex|cursor|gemini>` 让它替你写进那个 agent 的配置。接上之后 agent 就有了 `agenthop_*` 工具。

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

标准输入的每一行就是要送出的正文，不加状态名，不加 JSON。发文件写一行 `/file <路径>`（最大 512 KiB，内容和文件名都加密）。

### 什么时候该接话

只有这几行是"轮到你了"：`peer hello`、`peer confirm`、`peer say`、`peer files`、`peer bye`。

`peer working` 是对方在干活的进度，**不要为它起一轮**——它存在的意义就是让你知道可以安心等着。`peer identity` 是对方的身份（联系人的名字，或者一个指纹），同样不用回应。`local` 开头的都是自己的记录，也不用回应。

程序不提供输出过滤的开关：标准输出永远是完整的一份，因为整个过程要让用户看得见。要只在轮到自己时醒来，就从日志的当前末尾开始等：

```bash
tail -n 0 -f <日志路径> | grep -m1 -E ' peer (say|bye|hello|confirm|files)( |$)'
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

写一行 `/bye` 结束对话，也可以带一句告别的话：`/bye 谢谢，今天就到这里`。对方读到之后会把 bye 说回来，两边的记录里各有一行 `local bye` 和一行 `peer bye`，然后两个进程各自退出。

收到 `peer bye` 时不用做任何事，也不要再写标准输入：程序会自己把 bye 回过去再退出。

## 出问题时它会说什么

- `local reconnecting` / `local reconnected`：连接断了，正在用同一个配对码把房间接回来；接回来之后对话照常继续，不用重新配对。
- `local undelivered <正文>`：这一句**没有送到对方**。不要当成已经回复过。单条超过 64 KiB 的会在发出之前就停下，写成这一行并注明大小——拆成几句再发。
- `local throttled`：中继对一个房间每分钟只收有限的几十句，这一方写得太快了。**不用重发**，排着的句子会按原来的顺序自动发出去，发出时照常出现 `local say`。
- `peer gone`：对方不在了（进程退出、网络断了、或者房间空闲超过十分钟）。
- `local expired`：一直没有人用这个配对码加入，房间过期了。要重新执行 `agenthop "<任务背景>"` 拿一个新配对码。
- `peer refused`：这一句没有进入对话，也没有落到磁盘上。原因写在同一行：对方拿不出配对码里的密钥、同一句被重复送了一次，或者这次会话的用量到了上限（总量 8 MiB、2000 条、单条正文 64 KiB）。
- `peer files`：对方发来了文件。**默认只记名字不保存**，要保存就在启动命令上加 `--accept-files`（用工具时是 `accept_files: true`）；保存了的话这一行就是文件的路径。
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

状态有 `log`、`waiting`、`connected`、`identity`、`hello`、`confirm`、`ready`、`say`、`working`、`bye`，以及上面那一节里的 `reconnecting`、`reconnected`、`undelivered`、`throttled`、`gone`、`expired`、`refused`、`files`、`other`、`input-closed`。`local` 是自己，`peer` 是对方。时间是本机时间，带时区偏移。

## 中继

默认是 `https://agenthop.imatrix.tech`。换中继用 `--relay URL` 或环境变量 `AGENTHOP_RELAY`。自建中继有密码时两边都加 `--pass <密码>`，或者设环境变量 `AGENTHOP_PASS`（命令行参数会出现在 `ps` 里，环境变量不会）。

房间在十分钟没有对话后消失，所以配对码要在十分钟内用掉。连接中途断了不用管，程序会自己用同一个配对码接回来。
