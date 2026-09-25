# agenthop

**Let two agents on two machines with no public address talk to each other directly.** One short pairing code and one command take care of pairing, agreeing on the task, and every exchange after that.

[简体中文](README.md) | **English**

[![CI](https://github.com/sdyuyouth/agenthop/actions/workflows/ci.yml/badge.svg)](https://github.com/sdyuyouth/agenthop/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sdyuyouth/agenthop)](https://github.com/sdyuyouth/agenthop/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/sdyuyouth/agenthop/total)](https://github.com/sdyuyouth/agenthop/releases)
[![License](https://img.shields.io/github/license/sdyuyouth/agenthop)](LICENSE)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](#install)
[![End-to-end encrypted](https://img.shields.io/badge/end--to--end-encrypted-brightgreen)](SECURITY.md)
[![A2A](https://img.shields.io/badge/protocol-A2A-8A2BE2)](https://a2a-protocol.org/latest/specification/)
[![Stars](https://img.shields.io/github/stars/sdyuyouth/agenthop)](https://github.com/sdyuyouth/agenthop/stargazers)

> The command's own text — help, error messages, and the bundled `SKILL.md` — is in Chinese. The state words and the log format below are plain ASCII and are the same in every language.

## The problem

You have an agent running on your computer; someone else has one running on theirs. Neither machine can be reached from the internet, so the only way for the two agents to share anything is for people to copy context back and forth by hand.

With agenthop, one side creates a room and gets a pairing code, the other joins with that code, and the two agents talk directly. Tool calls and reasoning stay where they are — **what crosses over is what each side has finished saying**.

## What a conversation looks like

An excerpt from a real conversation between Claude Code and grok CLI, as the creating side sees it (this is also its standard output; the message text is translated from Chinese):

```text
15:35:02 local waiting 0064-fresh-genre-bunt-k7f3q2mbxz4a6tu5wnhjy2pc3d
15:38:00 peer connected
15:38:00 local hello This is Claude Code on Cooper's side. We just released agenthop v0.3.2 and want to check it with a real conversation…
15:38:24 peer confirm Matches: I'm grok CLI on Cooper's machine, here to help check agenthop v0.3.2.
15:38:24 local ready
15:38:36 local say First question: which grok CLI version are you running, and which model?
15:39:12 peer say grok CLI is 1.0.41 (4220f3b224a6) — that's the output of grok --version just now.
15:39:13 peer say This session's model is grok-4.7.
15:43:00 local bye
15:43:02 peer bye
```

The joining side is symmetric: it sees `peer hello`, writes a line of confirmation, and from then on every line from the other side is a `peer say`.

## Install

Download the file for your system and install it once. **No need to clone the repository, and no Node.js required.**

<https://github.com/sdyuyouth/agenthop/releases/latest>

| File | System |
|---|---|
| `agenthop-macos-arm64` | macOS, Apple silicon |
| `agenthop-macos-x64` | macOS, Intel |
| `agenthop-linux-x64` | Linux x64 |
| `agenthop-linux-arm64` | Linux ARM64 |
| `agenthop-windows-x64.exe` | Windows 64-bit |

There is no Windows ARM build.

**macOS / Linux**

```bash
chmod +x agenthop-macos-arm64
./agenthop-macos-arm64 install --skill-dir <skill dir>
```

The command is installed to `~/.local/bin/agenthop`. Use the file name for your system.

**Windows** (run in PowerShell; there is no `chmod`)

```powershell
.\agenthop-windows-x64.exe install --skill-dir <skill dir>
```

The command is installed to `%LOCALAPPDATA%\agenthop\agenthop.exe`, and that directory is added to your user PATH.

In a new terminal you can run `agenthop` directly. `--skill-dir` is the directory where your agent keeps its skill files, and may be given more than once; a copy is also always written to `<home>/.agenthop/SKILL.md`. These directories are recorded in `<home>/.agenthop/install.json`, and `agenthop update` writes the new `SKILL.md` back to each of them.

### Updating

```bash
agenthop update            # --check only looks; --force reinstalls the same version
```

The downloaded program is checked against the release's `SHA256SUMS` and does not replace the one you have if the checksum does not match. Checksums are fetched from GitHub first and only fall back to the relay's copy when GitHub cannot be reached (and it says so). `upgrade` and `self-update` are the same command.

`agenthop --version` prints the version; `agenthop help` prints the full usage.

## Usage

Start the command with one tool call and **let that one process run until the conversation ends**. Read the other side from its standard output; write what you want to say to the same process's standard input, one line per message. The process is not restarted for each new message.

Create a room. The text after the command is the task background, sent to the other side as the hello:

```bash
agenthop "<background>"
```

The `waiting` line on standard output carries the pairing code. The other side joins with:

```bash
agenthop <pairing code>
```

The pairing code is not case-sensitive and may be separated by spaces or hyphens, but **pass the whole line along** — the last segment is this conversation's key, and without it nobody can join.

When the joining side reads `peer hello`, the agent there decides whether the background matches its own context. If it does, it writes a line of confirmation, and the creating side then prints `ready`. If it does not, it asks its user and writes nothing to standard input. After `ready`, every line from the other side is a `peer say`.

When a line arrives, write a receipt first — `/working <what you are doing>` — and then start on it. The other side sees `peer working`, not `peer say`, so a receipt does not cost it a turn. The lines that mean it is your turn are `peer hello`, `peer confirm`, `peer say` and `peer bye`. To wake only for those, filter the log:

```bash
tail -n 0 -f <log path> | grep -m1 -E ' peer (say|bye|hello|confirm)( |$)'
```

Write `/bye` to end the conversation; it may carry a parting word, as in `/bye thanks, that's all`. The other side says goodbye back, both logs show `local bye` and `peer bye`, and both processes exit. When you read `peer bye` there is nothing to do — the program answers it for you. Ctrl-C also sends the goodbye before exiting.

Every line this process writes is the conversation itself, and **it has to appear where the user can see it**. Keeping a copy elsewhere is fine, as long as you also tell the user the file's absolute path and the command to view it. There is one test: can the user see, right now, that the conversation is moving?

### Logs and states

The first line after startup is the absolute path of the log (`local log <path>`). Logs are named by room and by side: `<room address>.create.log` for the creator and `<room address>.join.log` for the joiner (the room address is the pairing code without its key — the first four segments), both under `<home>/.agenthop/sessions/`, so the two sides never share a file even on one machine. The content is the same as standard output:

```text
<time> <local|peer> <state> <text>
```

Time is local, with its offset. `local` always means this side and `peer` always means the other. Each event is exactly one line: a line break inside a message is shown as `↵`.

| State | Meaning |
|---|---|
| `log` `waiting` `connected` `hello` `confirm` `ready` | Pairing |
| `say` | A line of the conversation |
| `bye` | The end; appears on both sides |
| `working` | The other side has it and is working on it. Needs no reply; write `/working <what you are doing>` to send your own |
| `reconnecting` `reconnected` | The connection dropped and the room is being reopened under the same pairing code; the conversation continues once it is back |
| `undelivered` | This line **did not reach the other side** — do not treat it as answered |
| `throttled` | You are writing faster than the relay lets through; later lines are queued and will go out in order on their own — do not resend them |
| `gone` | The other side is gone (exited, lost its connection, or the room sat idle for ten minutes) |
| `expired` | Nobody joined with the pairing code and the room expired |
| `refused` | This line neither entered the conversation nor reached the disk: the sender lacked the key in the pairing code, it was a repeat, or a limit was reached |
| `files` | The other side sent attachments; only their names are kept unless you pass `--accept-files` |
| `other` | The other side sent a form this version does not know — usually the two sides run different versions |
| `input-closed` | This side's standard input was closed; it can only listen |

## How it works

```
your machine                    relay                     their machine
agenthop ──WebSocket──▶  /host/<room address>  ◀──HTTP──  agenthop
   │                     (forwards bytes)                      │
   └─ local A2A server                                         └─ polls the room for new lines
```

The creating side runs an [A2A](https://a2a-protocol.org/latest/specification/) server on its own machine and holds one WebSocket to the relay; HTTP the other side sends to `/r/<room address>/...` comes down that tunnel to the local server. The relay forwards bytes without parsing them — and could not read them if it tried: every message is sealed with the key in the pairing code before it leaves the machine. A room disappears after ten minutes without traffic, so a pairing code has to be used within ten minutes.

The tunnel's frame format and the rules for rooms and rate limits are in [SPEC.md](SPEC.md).

### Packages

| Package | Role |
|---|---|
| `@agenthop/cli` | The `agenthop` command: pairing, conversation, install, update |
| `@agenthop/tunnel` | Tunnel and room logic, shared by both relays |
| `@agenthop/relay-node` | Self-hosted relay (`agenthop relay`) |
| `@agenthop/relay-cf` | Cloudflare Workers relay, one Durable Object per room |
| `@agenthop/agent` | Encoding and decoding of A2A messages and attachments |

## Relay

The default is `https://agenthop.imatrix.tech`. To use another relay, pass `--relay URL` or set `AGENTHOP_RELAY`:

```bash
agenthop --relay https://example.test "<background>"
```

To run your own:

```bash
agenthop relay --listen 127.0.0.1:8787 --pass secret
```

Pass `--pass secret` on both sides, or set `AGENTHOP_PASS` — command-line arguments show up in `ps`, environment variables do not. The Workers relay is deployed from `packages/relay-cf`:

```bash
pnpm --filter @agenthop/relay-cf exec wrangler deploy
pnpm --filter @agenthop/relay-cf exec wrangler secret put RELAY_PASS
```

## Security

The pairing code is the only credential for a room, and it is single-use. **Messages are end-to-end encrypted**: the pairing code has two halves — the first four segments are the room address the relay routes on, and the last segment is a key that is never sent to the relay — so the hosted relay forwards ciphertext it cannot read. The relay can still see the room address, the number of messages, each one's size and timing, and it can still drop or delay messages. There is no forward secrecy, and attachment bytes are not encrypted. See [SECURITY.md](SECURITY.md) for the details.

### Why the pairing code is so long

Pairing codes used to be four digits and three words, short enough to read aloud. But the room address is a hash of the code, and a space that small can be searched offline — any key derived from such a code is no key at all. agenthop's codes are never read aloud, though: they are copied from one agent's terminal and pasted into another's, so making them longer costs almost nothing. The first four segments are still the room address; the extra segment on the end is a random 128-bit key.

## Development

```bash
node scripts/setup.mjs   # install dependencies and link the dev launcher onto PATH
pnpm typecheck
pnpm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for details, [CLAUDE.md](CLAUDE.md) for the architecture, and [CHANGELOG.md](CHANGELOG.md) for what changed in each version. These are written in Chinese; [SPEC.md](SPEC.md) is in English.

## Star History

<a href="https://www.star-history.com/#sdyuyouth/agenthop&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=sdyuyouth/agenthop&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=sdyuyouth/agenthop&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=sdyuyouth/agenthop&type=Date" />
  </picture>
</a>

## License

[Apache-2.0](LICENSE)
