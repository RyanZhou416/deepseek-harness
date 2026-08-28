# Agent Note: Long sessions bound repeated allocation and live residency

Status: implemented

English | [中文](2026-08-23-long-session-hot-paths.zh.md)

## Problem

Several independent hot paths made work grow with the complete Session log. An active token meter reread the public whole-log snapshot after each event; persistence cloned already detached and recursively frozen events before batching; live full-text search cloned, serialized, and reprojected the complete Session; JSONL listing repeatedly decoded stable headers; and adjacent search pages displaced each other from a one-page cache.

High-concurrency workloads also admitted model phases and retained idle Web-created Agents without process-wide bounds. Tool or subagent waits could retain capacity after the model response had already finished, and a durable idle Session remained attached even when no browser followed it.

The lossless [packed Session history transport](../architecture/2026-08-15-packed-session-history-transport.md) bounds reopen and reconnect costs, but a browser tab that remains open still receives scalar live events. One exceptionally long completed answer can therefore leave tens of thousands of scalar chunks in the Client window. Collapsed Tool rows also performed JSON parsing, result flattening, and card-model construction before the reader opened them.

The Gateway sent WebSocket Ping frames but accepted an open socket indefinitely without observing a Pong. A half-open carrier could therefore wait for TCP or an intermediary to detect failure before the existing reconnect and journal-repair path ran.

## Decision

The token meter folds the exact frozen event supplied by `session/event` whenever its cursor matches that append. Cold or unexpectedly lagging state captures one immutable `session.events` snapshot and replays it once.

Persistence exposes a trusted `enqueueFrozen()` path for the deep-frozen value published by `Session.append()`. The standalone borrowed-input path still clones. A write transfers the pending backing array in O(1), and a failed write prepends that same batch before later events.

The SQLite session-query provider identifies each live Session object weakly and fingerprints its event count plus canonical surface replacement generation. A proven append-only suffix adds only its new search documents; replacement or lifecycle changes retain the complete deterministic fold. Exact-generation Session and event result pages use an item-weighted LRU bounded by the existing `maxLimit`, and returned pages are detached from cached copies.

JSONL persistence caches each validated header against the exact stat-derived artifact revision. Concurrent list and snapshot-list requests share one metadata scan, while cancellation abandons only the caller's wait. A changed artifact revision forces validation and successful discovery prunes absent entries.

The base bundle mounts one process-wide FIFO memory-admission guard. At most eight model phases are admitted by default; V8 heap pressure closes admission at 0.82 of the heap limit and reopens it at 0.72. A reservation releases at the matching final `assistant/message`, before Tool execution or a child Agent wait, with `step/end`, idle, cancellation, and disposal as cleanup paths. The guard changes scheduling only and writes no Session event.

Session Controller owns every Agent handle it creates or resumes. A durable idle Agent remains resident while a history follower, pending inbox item, owned child, active job, or running state needs it. After the configured five-minute retention, the controller flushes the Session, verifies a persistence snapshot, and disposes only its owned handle; the list row and log remain available for normal cold resume.

Client Session state counts scalar events received after each opening snapshot. Once the count reaches 20,000, the next final `assistant/message` restarts its `RemoteJournalStream` once. The official follow opening then replaces the scalar tail with the lossless packed window and resets the count. An unfinished model phase remains exact, and the implementation adds no settled projection, sparse sequence range, or alternate history API.

Collapsed Tool rows derive only their lightweight title, summary, state, and presence flags. The expanded body owns cached getters for formatted arguments, flattened results, recovery text, and specialized card models, so hidden detail cost is paid at most once and only after expansion.

Gateway Ping/Pong retains the strict WebSocket control-frame protocol. Each Ping uses the next heartbeat interval as its Pong deadline; a socket that remains open without acknowledging it is terminated, and the existing carrier-loss path reconnects and rebuilds domain streams from their baselines.

## Verification

Focused token-meter, write-behind, SQLite query, JSONL persistence, memory-admission, Session Controller, Tool-row, and Gateway suites pin each incremental or bounded path. The memory-admission composition test uses the real Agent loop and proves release before Tool and subagent work. Session Controller uses a small injected threshold to prove that scalar traffic alone does not restart, while the first final message past the threshold causes one replacement generation. Gateway coverage proves Ping/Pong carries no application message and terminates a peer that misses the next Pong deadline.

The incident-scale history contained 256,008 logical events in one message-aligned page, including 256,004 Assistant chunks. The packed transport keeps every logical event but represents consecutive same-block chunks as a small number of records; live rebasing applies that same representation after the answer becomes final instead of inventing a lossy projection.

## Alternatives considered

**Delete or rewrite stored chunks.** Rejected because chunks remain durable replay and diagnostic evidence, and their sequence, timestamp, provenance, fork, and crash-recovery semantics are observable.

**Retain the fork's settled sparse history projection.** Rejected after the upstream packed transport shipped. The sparse projection removed source sequence references and selected only a presentation subset, while the official packed record is lossless and already participates in reconnect, gap repair, and pagination.

**Clip a raw page or live stream at an event count.** Rejected because a silent gap breaks Tool pairing, replacement provenance, compaction records, and journal repair. Replacing the complete generation after a finalized answer preserves an explicit cursor and lets the official stream validate continuity.

**Start with Chat DOM virtualization.** Rejected as the first repair because oversized history parsing, validation, Conversation folding, and retained model construction precede React rendering. Virtualization can still reduce mounted DOM after scroll, selection, find-in-page, accessibility, and variable-height anchor behavior are specified.

**Send application JSON heartbeats.** Rejected because one physical Gateway mux now owns all domain streams and WebSocket Ping/Pong can enforce carrier liveness without expanding the strict Remote message union. JavaScript main-thread performance remains a separate browser diagnostic.

**Move full-text search to a Worker.** Deferred because it moves database ownership, persistence observation, cancellation, and shutdown across a process boundary. Incremental reconciliation and bounded exact-generation caching remove repeated work, but the first broad query remains synchronous.

## Consequences

Long streams avoid repeated whole-log allocation in token accounting, persistence batching, JSONL discovery, and live search indexing. Model concurrency and idle Host residency are bounded without changing model input, event ordering, or durable identity. Reopened, reconnected, and finalized oversized live windows use the official lossless packed representation, while collapsed Tool rows avoid work proportional to hidden content. Half-open mux sockets enter the existing reconnect path within two configured heartbeat intervals.

The live Host Session log remains fully resident while its Agent is active, an unfinished response may exceed the Client threshold until its final message arrives, the first varied broad SQLite query can still block one Host thread, and Chat still mounts every loaded presentation row. No Session event type, `SESSION_FORMAT_VERSION`, JSONL storage path, or migration is introduced by these fork-specific bounds.
