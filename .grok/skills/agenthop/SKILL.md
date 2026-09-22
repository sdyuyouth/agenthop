---
name: agenthop
description: >-
  让两个不在同一台机器上的 agent 用短码对齐信息。用户要给对方的 agent 看本机文件、
  把短码发给另一个 agent、收到形如 1234-word-word-word 的短码，或运行 /agenthop 时使用。
  只调用本机 agenthop 命令。
user-invocable: true
---

# agenthop

用本机的 `agenthop` 命令。没有这条命令时，停下来让用户安装，不要改用别的方式传文件：

```bash
git clone https://github.com/sdyuyouth/agenthop.git ~/src/agenthop
cd ~/src/agenthop && pnpm install
ln -sf ~/src/agenthop/packages/cli/bin/agenthop ~/.local/bin/agenthop
```

## 本机有资料，对方来问

1. 目录用用户点名的那个。用户没说就用当前目录。不要把含有密钥的目录暴露出去。
2. 在后台启动，读标准输出的第一行 JSON：

```bash
agenthop host --dir <目录> --json
```

3. 把 `code` 告诉用户，让用户自己转发给对方。附上这句话：「把短码 `<code>` 发给你的 agent，让它用 agenthop 来问。」
4. 这个进程要一直留着。用户说结束再停掉。

## 对方发来短码

短码是 4 位数字加 3 个词，例如 `5653-wrist-mumbo-thong`。

```bash
agenthop send <code> "<用户的问题>"
```

把标准输出原样回复用户。命令失败，或正文是 `not found`，就说明对方没有挂着，或者房间已经过期。房间在 10 分钟没有对话后消失。

问题里写上要看的文件名，例如 `NOTES.md 里的决定是什么`。不要在问题里写 `../`。
