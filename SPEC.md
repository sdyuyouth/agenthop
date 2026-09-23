# agenthop tunnel

This document is the relay tunnel. Agent messages are [A2A](https://a2a-protocol.org/latest/specification/) JSON-RPC. The tunnel does not parse them.

A Durable Object has to be chosen before a WebSocket can speak, so the host connects to `/host/<code>`. The first text frame still repeats the code. If the two disagree, the relay closes the socket with `invalid_code`.

## Control frames

Text frames, JSON, `v` is `1`.

Host to relay:

```json
{"v":1,"type":"open","code":"4821-amber-river-maple","token":"9Qw...bA"}
```

`token` is optional and opaque to the relay. The first host to open a room fixes it: the relay
keeps only its SHA-256 and requires the same token from any later host socket for that room.
A host that sends no token leaves the room as open as it was before, which is what a host from
an older version does.

Relay to host:

```json
{"v":1,"type":"ready","publicBase":"https://relay.example/r/4821-amber-river-maple"}
```

```json
{"v":1,"type":"error","code":"room_taken"}
```

`code` is one of `room_taken`, `invalid_code`, `unauthorized`, `rate_limited`.

## Binary frames

One WebSocket binary message is one frame. Integers are big-endian.

| Field | Size |
|---|---|
| type | 1 |
| requestId | 4 |
| rest | depends on type |

| type | name | rest |
|---|---|---|
| 1 | request-start | method (u8 length + ASCII), path (u16 + UTF-8), headers |
| 2 | request-body | u32 length + bytes |
| 3 | request-end | empty |
| 4 | response-start | u16 status, headers |
| 5 | response-body | u32 length + bytes |
| 6 | response-end | empty |
| 7 | abort | u16 length + UTF-8 reason |

Headers are a u16 count, then repeated name and value, each a u16 length plus UTF-8. Request headers kept: `content-type`, `accept`, `a2a-version`. Response headers kept: `content-type`. `host`, `authorization`, and `cookie` are dropped.

A body chunk is at most 64 KiB. A request body is at most 1 MiB.

Paths start with `/`. `..` and a leading `//` are rejected.

## Agent Card

When the response path is `/.well-known/agent-card.json`, the relay rewrites every `supportedInterfaces` entry whose `protocolBinding` is `JSONRPC` so its `url` is `publicBase`. Other bindings are removed. A top-level `url` string is rewritten the same way. If parsing fails, the response is `502` and the original body is not forwarded.

## Rooms and limits

The room id is the first 10 bytes of SHA-256 over the normalized code, encoded as lowercase base32. Normalization is NFKC, trim, casefold, then split on any run of characters that are not letters or digits.

One host socket per room. A second host gets `room_taken`, and so does a later host whose
`token` does not match the one that opened the room — a socket that has gone away does not make
the room available to whoever asks next.

Anyone who has the code can send HTTP to `/r/<code>/...`. The code is the only credential: this
version has no end-to-end encryption, so holding it is enough to read the conversation.

A room closes after 10 minutes with no frames and no HTTP. The next request is `404`.

One room may carry 64 MiB while it lives, counting both directions. Past that the relay answers
`429` and the room is spent. This is the relay's own ceiling: the conversation has a smaller one
that the host applies to itself, and a client that does not play along would otherwise spend the
operator's bandwidth without limit.

Each IP may open 10 host sockets per minute and may receive 60 responses for a missing code per minute. Further attempts are `429`. A self-hosted relay with `--pass` requires `Authorization: Bearer <secret>` and answers `401` without it.

The relay log records the time and an event name. It does not record the code, the card, or
message bodies. Rate counting keys on a salted digest of the address rather than the address,
the salt turns over daily, and counters older than the current minute are dropped, so a relay
holds one minute of counts and no addresses.
