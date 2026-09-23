# 安全说明

## 这一版保护什么，不保护什么

**配对码就是凭证。** 拿到配对码的人就能进入那个房间。配对码是四位数字加三个词，房间在十分钟没有对话后消失——它是一次性的，不要当成长期密钥，也不要贴在公开的地方。

**中继能读到消息正文。** 托管中继跑在 Cloudflare Workers 上，TLS 在 Cloudflare 终结。**这一版没有端到端加密**，中继的运营者在技术上可以读到对话内容。不想让第三方看到的内容，不要走托管中继——自建一个（`agenthop relay`）或者不用这个工具传。

**房间对拿到码的人做了限制。** 会话层只认第一个接入的对端，别人拿着同一个配对码说话会被拒绝，既不进对话也不落盘。一次会话最多 8 MiB、2000 条消息、单条正文 64 KiB；中继对同一个房间的写入限到每分钟 60 条。附件默认不写磁盘，要写得显式加 `--accept-files`。

**更新会校验。** `agenthop update` 下载后比对 release 里的 `SHA256SUMS`，对不上就丢弃，不替换现在能用的程序。校验和优先从 GitHub 取、程序从中继取，这样单独换掉其中一方骗不过去；GitHub 取不到时会退回中继那一份，并在输出里说明这一点。

**密码不要写在命令行上。** 自建中继的 `--pass` 会出现在 `ps` 里，用环境变量 `AGENTHOP_PASS` 代替。

## 报告问题

发现安全问题请开一个 [GitHub Issue](https://github.com/sdyuyouth/agenthop/issues)；涉及尚未公开的漏洞细节时，请用 GitHub 的 [Security Advisory](https://github.com/sdyuyouth/agenthop/security/advisories/new) 私下提交。

## 支持的版本

只有最新发布的版本会收到修复。v0.2.1 及更早的版本有一个会删掉自己的 `install` 缺陷，请先 `agenthop update` 升级。
