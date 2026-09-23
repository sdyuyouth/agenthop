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

已经安装过、并且程序版本至少是 v0.1.6 时：

```bash
agenthop update
agenthop update --check
agenthop update --force
```

`--check` 只查询，不安装。`--force` 在版本相同的时候也重新安装。`upgrade` 和 `self-update` 与 `update` 相同。v0.1.5 及更早的程序没有 `update`，先下载当前发布的文件换上。

不带参数，或执行 `agenthop help`，会打印完整用法。

## 对话

当前会话用一次工具调用启动命令，并在整个对话期间保持这个进程。对方的话从标准输出读，回复写进同一个标准输入。进程不会因为新消息而重新启动。不要使用 `--agent`，不要写 `reply.ps1` 或 `reply.sh`，不要调用 `claude -p` 或其他非交互 agent。

创建房间。后面的文字是任务背景，会作为 hello 发出：

```bash
agenthop "<任务背景>"
```

标准输出里的 `waiting` 行带有配对码。对方加入：

```bash
agenthop <配对码>
```

标准输出出现 `peer hello` 后，由当前 agent 判断背景是否属实。属实就把确认写进标准输入，创建方随后输出 `ready`。不属实就询问用户，并且不写标准输入。

`ready` 之后，对方的新一句是 `peer say`。当前 agent 把回复写进标准输入。

日志每行的格式是：

```text
<时间> <local|peer> <状态> <正文>
```

状态依次是 `waiting`、`connected`、`hello`、`confirm`、`ready`、`say`。

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

房间在 10 分钟没有转发后消失。短码就是进入这个房间的凭证。使用 Cloudflare 上的中继时，TLS 在 Cloudflare 终结，中继可以读到消息正文。这一版没有端到端加密。

隧道格式见 [SPEC.md](SPEC.md)。
