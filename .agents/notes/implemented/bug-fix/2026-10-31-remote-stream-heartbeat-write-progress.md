# Agent Note: Keep congested Remote stream sockets alive by carrier write progress

Status: implemented

English | [中文](2026-10-31-remote-stream-heartbeat-write-progress.zh.md)

## Problem

A `session.follow` first frame of 12.8 MB, and 44 MB in another session, needs tens of seconds on a 10 Mbps / 120 ms link. The two-second heartbeat writes a Ping control frame behind that data frame, the browser cannot answer Pong until it has reassembled the whole frame, and two missed ticks terminated the socket four to six seconds in. The browser reported close code 1006, reconnected, requested the same first frame, and the cycle repeated. Raising `websocketHeartbeatIntervalMs` to 120000 delivered both frames with no disconnect, but it delays detection of a genuinely dead peer by the same amount.

## Decision

Each heartbeat tick samples the upgrade socket's cumulative `bytesWritten` and its `writableLength`, plus ws's `bufferedAmount`. A connection that reported queued downlink bytes at the previous tick and whose carrier has since accepted more than the two-byte empty Ping frame itself is alive, and its miss count clears. The carrier is the `Duplex` the HTTP server transferred to `handleUpgrade`, so the server never reads ws's private `_socket`; only `net.Socket` (including `TLSSocket`) reports `bytesWritten`, and a carrier without it keeps the Pong and inbound-frame rules. Queued data at the previous tick is required, so a drained socket still needs a Pong or an inbound frame, and a stalled frame or a peer that stopped reading leaves `bytesWritten` unchanged and still terminates after two missed ticks. Compression does not weaken the signal: ws compresses before it writes to the carrier, while `bufferedAmount` can read zero during asynchronous zlib work and is therefore only an additional queued-bytes hint.

## Alternatives considered

**Raise the heartbeat interval.** It hides the defect instead of fixing it: detection of a dropped connection and of a stalled frame scales with the interval, and a bounded large frame still needs an interval longer than its transfer time. The measured 120000 ms workaround is evidence, not the fix.

**Count any `bytesWritten` growth.** The server's own Ping frame grows it by two bytes every interval, so an unresponsive peer would look alive forever. Requiring queued data at the previous tick and growth beyond the Ping frame keeps the Ping unable to vouch for itself.

**Rely on `bufferedAmount` or on the `send()` completion the existing activity check uses.** Completion arrives only after every byte is queued for the kernel, which on a congested link is the delay being waited out, and asynchronous compression leaves `bufferedAmount` at zero while zlib runs. Carrier counters advance during that wait.

**Read ws's private `_socket`.** It is not a contract, and the upgrade socket is already available at `handleUpgrade`.

## Consequences

A congested connection survives while its carrier keeps accepting downlink bytes, at the cost of two counter reads per connection per tick. A dead peer, a peer that stopped reading, and a frame whose bytes no longer drain are still terminated after two intervals; the fix adds no tunable and leaves the configured interval unchanged. The rule assumes the upgrade carrier is a `net.Socket`, which every HTTP and HTTPS server produces; a carrier that reports no `bytesWritten` keeps the previous behavior.

## Verification

`packages/api/gateway/tests/stream-server.host.spec.ts` covers continuous carrier progress, stalled progress, Ping-only growth, a Pong that clears the miss count, and the same progress with `permessage-deflate` negotiated.
