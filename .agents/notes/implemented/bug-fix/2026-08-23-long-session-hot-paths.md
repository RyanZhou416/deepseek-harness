# Agent Note: Long sessions avoid repeated whole-log and front-buffer work

Status: implemented

English | [中文](2026-08-23-long-session-hot-paths.zh.md)

## Problem

An active token-meter replayed through `session.events` after every committed
event. Because `Session.events` intentionally returns a new frozen whole-log
snapshot after an append, a long stream repeatedly copied its complete history
and approached quadratic allocation. The API proxy's asynchronous frame queue
also removed every delivered frame from the front of an array.

Persistence write-behind cloned every already detached and recursively frozen
live event into its short batching window, then drained that window with
`splice(0)`. Session search likewise cloned every live event, serialized the
complete clone to compute a fingerprint, and eagerly projected search documents
before checking whether the existing live index already described the same
immutable snapshot. Attached history reads copied the complete snapshot again
before selecting a small page.

These costs appeared in the same long-session workload, but neither justified
weakening durable-log immutability or changing the one-frame wire contract.

## Decision

The token-meter keeps its lazy first read and eager live observation. Once a
session has measurement state, the post-commit `session/event` listener folds
the exact frozen event supplied by the callback. If an earlier listener already
advanced the meter during the same dispatch, the eager listener does nothing;
any other cursor mismatch falls back to the existing replay catch-up. Cold
catch-up captures one immutable `session.events` snapshot and walks it once.

`FrameQueue` preserves one-in/one-out FIFO delivery and remains unbounded. It
uses a head cursor instead of `Array.shift()`, clears a consumed slot before
yielding, and resets the drained backing array so delivered frames are not
retained by a long-lived high-water mark.

The persistence coordinator routes the deep-frozen value published by
`Session.append()` through a trusted write-behind admission path. The public
write-behind admission still clones borrowed mutable input, preserving the
standalone ownership contract. Draining transfers the pending backing array in
O(1) instead of splicing every entry out of it.

The SQLite session-query reconciler borrows immutable live/persistence
observations, uses a connection-local weak Session identity plus snapshot length
and canonical `surface.replaceGeneration` as the live fingerprint, and defers
semantic-document projection until that fingerprint requires index work. When
the same Session only appended events and its replacement generation did not
change, reconciliation inserts documents for that proven suffix; a replacement,
lifecycle change, or legacy/unparseable fingerprint falls back to the exact
whole-log fold and replacement. It no longer clones and serializes the full live
log merely to compare generations.

Session and event search each retain one bounded exact-generation result. A
repeat of the same normalized request and cursor returns a detached copy of that
page instead of repeating synchronous FTS ranking; any relevant corpus
generation change misses the cache. API history/fork reads reuse the already
immutable `Session.events` cut instead of allocating a second whole-log array
before slicing the requested page or prefix.

## Verification

Token-meter coverage pins listener-order catch-up, service reload, malformed
event retry, and the absence of per-append whole-log reads after the first live
publication. API proxy suites continue to pin FIFO frame content and stream
cleanup. Write-behind coverage pins the mutable borrowed-input copy path and the
identity-preserving frozen-event path. SQLite search coverage proves live index
reconciliation performs no `structuredClone` of the immutable history; the
append-path regression pins suffix insertion, surface replacement pins the
full-fold fallback, and the result-cache regression pins generation invalidation
and caller mutation isolation. Existing search, cursor, surface, persistence,
and concurrency suites keep the result contract fixed.

## Alternatives considered

- **Expose the mutable Session log or make old event arrays grow** — rejected:
  the immutable snapshot is the ownership boundary that prevents consumers
  from rewriting durable history.
- **Drop, merge, or batch queued frames** — rejected: a missing session event
  creates a sequence gap, and changing WebSocket envelopes would expand the
  wire contract rather than fixing the queue operation.
- **Put a hard capacity on FrameQueue in this change** — rejected: overflow
  must fail and rebuild a complete stream generation, and not every host frame
  has yet been proven reconstructible after reconnect.
- **Move SQLite FTS to a Worker in this follow-up** — deferred: it would remove
  the remaining first-query main-thread stall, but moves database ownership,
  persistence observation, cancellation, and shutdown across a process boundary.
  Exact-generation caching removes duplicate scans without that architectural
  divergence; a first broad query remains synchronous.
- **Unmount offscreen Chat rows with a list virtualizer** — rejected for this
  change: keyed renderers may own local interaction state. A future virtualizer
  must first relocate or explicitly preserve that state and prove scroll,
  selection, find-in-page, and accessibility behavior in browser tests.
- **Apply `content-visibility: auto` while keeping rows mounted** — rejected:
  intrinsic offscreen sizes participate in the same scroll geometry that Chat
  uses for paging anchors and bottom-follow. Without a passing browser contract
  for those interactions, preserving mount identity alone is not sufficient.
- **Add another session-history lazy loader** — rejected: cold sessions and
  browser history are already lazy and tail-paged. Replacing those paths would
  duplicate established persistence and reconnect semantics.

## Consequences

Active long streams no longer rematerialize the complete public event snapshot
for each token-meter update, and queued delivery avoids repeated front removal
without changing session files, event provenance, RPC schemas, or replay.
Persistence batching no longer duplicates every live payload, and session
search/history reads avoid redundant full-log clones and eager live-index work.
Pure live appends extend the FTS index instead of replacing it, while repeated
identical searches reuse one bounded, mutation-isolated result page. Surface
rewrites preserve the canonical full-fold behavior.
The live in-memory session log is still retained, FrameQueue still has no
backpressure bound, and Chat still owns the DOM and React memory of every loaded
row. The first broad SQLite query also remains synchronous; those larger
lifecycle and execution-boundary decisions remain separate work.
