# agenthop

两台没有公网地址的机器，各有一个 agent。一条命令完成配对、确认背景和后续对话。默认中继是 `https://agenthop.imatrix.tech`。

成品在 GitHub Release。下载对应系统的文件后安装一次，不需要克隆仓库，也不需要 Node.js。

https://github.com/sdyuyouth/agenthop/releases/latest

| 文件 | 系统 |
|---|---|
| `agenthop-macos-arm64` | macOS Apple 芯片 |
| `agenthop-macos-x64` | macOS Intel |
| `agenthop-linux-x64` | Linux x64 |
| `agenthop-linux-arm64` | Linux ARM64 |
| `agenthop-windows-x64.exe` | Windows 64 位 |

没有 Windows ARM 包。

## macOS

Apple 芯片用 `agenthop-macos-arm64`，Intel 用 `agenthop-macos-x64`。

```bash
chmod +x agenthop-macos-arm64
./agenthop-macos-arm64 install --skill-dir <技能目录>
```

Intel 把文件名换成 `agenthop-macos-x64`。命令装到 `~/.local/bin/agenthop`。新开一个终端后可以直接运行 `agenthop`。

会话日志在 `~/.agenthop/sessions/<配对码>.log`。技能副本在 `~/.agenthop/SKILL.md`。

## Linux

x64 用 `agenthop-linux-x64`，ARM64 用 `agenthop-linux-arm64`。

```bash
chmod +x agenthop-linux-x64
./agenthop-linux-x64 install --skill-dir <技能目录>
```

ARM64 把文件名换成 `agenthop-linux-arm64`。命令装到 `~/.local/bin/agenthop`。新开一个终端后可以直接运行 `agenthop`。

会话日志在 `~/.agenthop/sessions/<配对码>.log`。技能副本在 `~/.agenthop/SKILL.md`。

## Windows

在 PowerShell 里执行。不要用 `chmod`。

```powershell
.\agenthop-windows-x64.exe install --skill-dir <技能目录>
```

命令装到 `%LOCALAPPDATA%\agenthop\agenthop.exe`，并把这个目录写入用户 PATH。新开一个终端后可以直接运行 `agenthop`。

会话日志在 `%USERPROFILE%\.agenthop\sessions\<配对码>.log`。技能副本在 `%USERPROFILE%\.agenthop\SKILL.md`。

## 安装选项

`--skill-dir` 可重复。每个目录写入一份 `SKILL.md`。无论是否指定，都会再写一份到家目录下的 `.agenthop/SKILL.md`。

这些目录会记在 `<家目录>/.agenthop/install.json` 里。`agenthop update` 换完程序后，会用新程序把新的 `SKILL.md` 写回每一个记录过的目录——技能文本在程序里面，所以只有新程序能写出新的技能。万一写不成（从 v0.2.0 之前的版本升上来就会这样），update 会打印出需要手动执行的那行安装命令。

已经安装过时：

```bash
agenthop update
agenthop update --check
agenthop update --force
```

下载回来的程序会和 release 里的 `SHA256SUMS` 对校验和，对不上就不替换现在的程序。校验和优先从 GitHub 取，取不到才退回中继那一份（并且会说明）。

`--check` 只查询，不安装。`--force` 在版本相同的时候也重新安装。`upgrade` 和 `self-update` 与 `update` 相同。v0.1.5 及更早的程序没有 `update`，先下载当前发布的文件换上。

`agenthop --version` 打印版本。不带参数，或执行 `agenthop help`，会打印完整用法。

## 对话

用一次工具调用启动命令，让这个进程活到对话结束。对方的话从它的标准输出读，要说的话写进同一个标准输入，一行一句。进程不会因为新消息而重新启动。

创建房间。后面的文字是任务背景，会作为 hello 发出：

```bash
agenthop "<任务背景>"
```

标准输出里的 `waiting` 行带有配对码。对方加入：

```bash
agenthop <配对码>
```

配对码不区分大小写，用空格或连字符隔开都行。

标准输出出现 `peer hello` 后，由当前 agent 判断背景是否属实。属实就把确认写进标准输入，创建方随后输出 `ready`。不属实就询问用户，并且不写标准输入。

`ready` 之后，对方的新一句是 `peer say`。当前 agent 把回复写进标准输入。

写一行 `/bye` 结束对话。对方会把 bye 说回来，两边各有 `local bye` 和 `peer bye` 两行，然后各自退出。读到 `peer bye` 不用管，程序会自己回复。按 Ctrl-C 也会先送出 bye 再退出。

连接断了会写 `local reconnecting`，用同一个配对码接回来之后写 `local reconnected`，对话继续。送不出去的话会写成 `local undelivered <正文>`，不会悄悄消失。对方不在了是 `peer gone`；一直没人加入、房间过期是 `local expired`；第三个人拿着同一个配对码说话是 `peer refused`。

标准输出就是对话过程，要出现在用户看得到的地方。另存一份可以，但要同时告诉用户文件的绝对路径和查看命令：macOS 与 Linux 用 `tail -f ~/.agenthop/sessions/<配对码>.log`，Windows PowerShell 用 `Get-Content -Wait -Tail 30 $env:USERPROFILE\.agenthop\sessions\<配对码>.log`。判断标准只有一个：用户此刻能不能看到对话在往前走。

日志每行的格式是：

```text
<时间> <local|peer> <状态> <正文>
```

状态依次是 `waiting`、`connected`、`hello`、`confirm`、`ready`、`say`，结束时是 `bye`、`gone` 或 `expired`；中途还可能出现 `reconnecting`、`reconnected`、`undelivered`、`refused`、`input-closed`。时间是本机时间，带时区偏移。

换中继：

```bash
agenthop --relay https://example.test "<任务背景>"
```

也可以设置环境变量 `AGENTHOP_RELAY`。自建中继并且设置了密码时，两边都加上 `--pass <密码>`。

## 自建中继

```bash
agenthop relay --listen 127.0.0.1:8787 --pass secret
```

两边使用：

```bash
agenthop --relay http://127.0.0.1:8787 --pass secret "<任务背景>"
```

Workers 中继的部署在 `packages/relay-cf`：

```bash
pnpm --filter @agenthop/relay-cf exec wrangler deploy
pnpm --filter @agenthop/relay-cf exec wrangler secret put RELAY_PASS
```

房间在 10 分钟没有转发后消失，所以配对码要在十分钟内用掉。连接中途断开时，创建方会用同一个配对码把房间接回来。短码就是进入这个房间的凭证。使用 Cloudflare 上的中继时，TLS 在 Cloudflare 终结，中继可以读到消息正文。这一版没有端到端加密。

隧道格式见 [SPEC.md](SPEC.md)。
