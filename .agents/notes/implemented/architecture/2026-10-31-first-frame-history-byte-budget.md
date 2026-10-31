# Agent Note: Bounded first-frame Session history transport

Status: implemented

English | [中文](2026-10-31-first-frame-history-byte-budget.zh.md)

## Problem

Opening a Session delivers its history as one unfragmented WebSocket text message. The Host serializes the complete snapshot frame once in [`stream-server.ts`](../../../../packages/api/gateway/src/stream-server.ts), and the browser `JSON.parse`s that whole string before any transcript can render. Measured on loopback, 12.8 MB, 76 MB, and 44 MB first frames reached the Client in 1.6 s, 16.9 s, and 11.2 s, while the Host's read, decode, and send together stayed under 2 s: most of the wait is whole-frame decode, parse, and GC in the browser, and it grows faster than the byte count.

No limit bounds that frame. The opening window is paginated only by message count: the Client asks for at most 500 counted messages with a two-Turn, 50-message window ([`session.ts`](../../../../packages/api/session-controller/src/client/sessions/session.ts)), the Host cuts at message boundaries ([`history.ts`](../../../../packages/api/session-controller/src/history.ts)), and the bounded stored-window read caps rows (`windowEventBound`, at least 2,000 and at most 10,000 events). A single message or a Turn carrying a large tool result can therefore make a frame tens of megabytes. The wire protocol has no byte-shaped page request, only `page(beforeSeq)`, and the opening requires the page tail to equal the cursor.

The WebSocket also never negotiated `permessage-deflate`, so remote Clients over limited bandwidth transfer every byte of that frame. The goal is to bound the per-frame Client decode and parse cost and to let remote deployments trade CPU for bandwidth, without changing the paging protocol or the Client's page assumptions.

## Decision

### 1. A serialized-byte budget for one history page

`SessionController.Config.historyPageMaxBytes` (default `0`, uncapped) caps the serialized UTF-8 bytes of records one page may carry. The Host first selects the existing message/Turn-aligned page, then `trimToByteBudget` moves its start forward to the newest counted-message group start that keeps the serialized records within the budget. A page whose whole content fits the budget keeps its original start, so the trim never removes a non-message event that the unconstrained page carried. The newest message group is always kept even when it alone exceeds the budget, so a page always advances and the Client cannot spin. A candidate start is unusable when a message at or above it cites an earlier source event, because the page would carry a surface event without its source.

`hasMore`, the page tail, and the follow cursor keep their existing meanings: `hasMore` is still `start seq > 0`, the tail is still the caller's cut, and the opening page still ends at the cursor. The budget counts the page records as the wire serializes them (`{"type":"event","event":…}`), not the small frame envelope. It applies to live Sessions, backwards `page(beforeSeq)` requests, and follow openings, on both the complete-source and the stored-window paths.

The budget overrides the caller's message and Turn minima. That does not break the Client: its documented contract already stops early at the 500-message cap or history exhaustion, `loadOlder()` only prepends whatever page arrives, and `loadThrough(seq)` loops until the window covers its target and stops on a page that makes no progress.

The bounded stored-window read keeps its row bound, but no longer requests all of it first when the budget is configured. A budgeted window read requests 256 events, multiplies by four up to the existing alignment bound, and stops at the first read whose page is decided: the message/Turn alignment resolved, the history start reached, or the page's trailing records already exceeding the budget. The last case is final because `trimToByteBudget` keeps the newest message group that fits and older events can only add bytes, so that trimmed start equals the one a complete read chooses. Follow openings also grow until the window contains the log's final `turn/start`/`turn/end`, so `interruptedTurnClosers` sees the same state as the complete observation. Every request stays within the row bound the alignment needs, so a window that never decides its page still falls back to the complete read; with the default `0` the alignment bound is requested once, unchanged. Recording and pagination remain message- and row-bounded; only the wire frame is byte-bounded.

### 2. Optional `permessage-deflate` on the mux socket

`TypertGatewayService.Config.streamCompression` selects the extension. It is disabled by default, preserving ws's plain text frames and the upstream wire behavior. When enabled, the server compresses downlink messages at or above `threshold` bytes with the configured zlib `level`; `concurrencyLimit` bounds simultaneous zlib operations before ws sends a frame uncompressed, and `serverNoContextTakeover` releases the per-message zlib context instead of retaining it per connection. A Client that does not offer the extension still receives plain frames, and negotiation lets the browser compress its own small uplink frames.

Compression does not reduce the Client's `JSON.parse` work: it inflates to a string and parses the same text. Its benefit is bandwidth on remote links. The cost is deflate CPU and zlib memory on the Host plus inflate CPU on the Client, and per-connection zlib state is the fragmentation risk the concurrency limit and context-takeover setting bound. A source-address check for loopback was rejected because a reverse proxy makes a remote peer look like loopback.

The recommended fork configuration is `enabled: true, threshold: 1048576, level: 1, concurrencyLimit: 4, serverNoContextTakeover: true` for deployments that are used remotely, and leaving compression off for a loopback-only deployment where the byte budget already bounds frames and compression only moves work from the network to the CPU. The default remains off because the upstream contract is plain frames.

### 3. No wire or Client change

The request types, the follow/page response shape, and every `SessionEventMap` member are unchanged. The Client keeps asking for the same message/Turn windows and reacts to a shorter page exactly as it already reacts to a 500-message cap or an exhausted history. Recording and replay are untouched.

## Alternatives considered

**Compress the HTTP history transport instead.** The archived [packed history transport](../../archived/architecture/2026-08-15-packed-session-history-transport.md) decision already rejected HTTP content-encoding as a fix for local parse cost: the expensive step is the browser's whole-frame JSON parse, and history reaches the Client over the WebSocket, not an HTTP body. Byte-bounding the frame and optionally deflating it addresses the cost the decision identified.

**Strip embedded Assistant streams in the Controller.** The [v2 embedded Assistant streams](2026-09-01-v2-embedded-assistant-streams.md) decision rejected detaching stream data from the Session event transport; the Client needs the embedded stream to render and replay the transcript. This change does not revisit it.

**Parse JSON incrementally on the Client.** A streaming parser would change how the unary frame is consumed and owned, and it does not reduce the bytes transferred over a remote link. The byte budget gets most of the parse benefit without a new wire or Client parsing path.

**Lower the 500-message default.** That changes the Client's documented paging contract and still leaves a frame unbounded when one message or Turn is huge; the quantity that drives parse time is bytes, not message count.

**Always enable compression.** Loopback use pays deflate and inflate CPU for no parse benefit, and retains zlib memory per connection. The deployment that benefits can opt in.

**Detect loopback to choose compression automatically.** A reverse proxy terminates the connection, so the Host sees a loopback source for remote Clients; the check would be wrong where compression matters most.

**Stop the stored-window decode at a hard byte bound.** The index works in row-aligned frames, so under-requesting rows breaks message/Turn alignment and forces the complete-log fallback described above. Progressive growth avoids that trade: it keeps the alignment's row bound and stops only once the page is decided.

## Consequences

- Pages can be shorter than the Client's 50-message and two-Turn minima. `loadOlder()` may need more clicks on a Session with large messages, and `loadThrough()` pages more times; neither depends on a full page.
- The trim serializes the pre-trim page once to measure it. That pass is bounded by the existing message cap and is the same order as the frame serialization the Gateway performs anyway.
- A budgeted window read can fetch its lookback in up to three requests (256, 1,024, and the alignment bound). A budget-trimmed page decodes only the small first window; an alignment-limited page decodes about 1.6 times its bound across those requests. The 256-event first bound is an implementation constant because it changes read granularity, never the served page.
- A single Turn that carries an oversized tool result or an oversized message group can still produce a frame above the cap. The budget is best effort around message atomicity, not a hard frame-size guarantee.
- Compression adds zlib CPU and memory on both ends and makes `bufferedAmount` unreliable as an immediate downlink-progress signal because ws compresses after `send()` returns. Pong activity remains the authoritative liveness signal; a congested link is still detected at two missed heartbeats.
- The uncapped default keeps the existing wire composition, so recorded-session snapshots and the TypeScript and Python SDK expectations do not change.
- The budget counts page records only: the opening header, the optional projection block, and the compact assistant-stream baseline ride outside it.
- A deployment that patches a plugin row replaces its whole `config`, so the fork overlay must restate `historyPageMaxBytes` and `streamCompression` wherever it already restates that row's other fields.

## Testing

- `packages/api/session-controller/tests/session-history-paging.host.spec.ts` pins the exact-fit cut, one byte less dropping one message group, the oversized newest message, the stored-window page path, live and stored follow openings, and the unchanged page when a finite budget fits it or no budget is configured. It also pins one first-bound window read when a 64 KiB budget over 4 KiB messages is exhausted, the 256 → 1,024 → 2,000 growth for a sparse generation, the single bounded read when the budget is disabled, a window that reaches the history start, and an open tail whose final Turn boundary forces one growth step so synthetic closers match the complete opening.
- `packages/api/session-controller/tests/controller.host.spec.ts` pins the Config default and integer validation.
- `packages/api/gateway/tests/stream-server.host.spec.ts` pins no negotiation by default, negotiation when enabled with a large payload round trip, a Client that offers no extension, and the compressed bit at the configured threshold.
- `packages/api/gateway/tests/gateway-stream.host.spec.ts` pins the compression Config defaults and bounds.
