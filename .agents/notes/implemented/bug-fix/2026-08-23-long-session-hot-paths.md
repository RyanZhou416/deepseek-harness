# Agent Note: Long sessions bound repeated allocation and live residency

Status: implemented

English | [中文](2026-08-23-long-session-hot-paths.zh.md)

## Problem

Several independent hot paths made work grow with the complete Session log. An active token meter reread the public whole-log snapshot after each event; persistence cloned already detached and recursively frozen events before batching; live full-text search cloned, serialized, and reprojected the complete Session; JSONL listing repeatedly decoded stable headers; and adjacent search pages displaced each other from a one-page cache.

High-concurrency workloads also retained idle Web-created Agents without a residency bound. A durable idle Session remained attached even when no browser followed it.

Alpha.2 keeps in-flight Assistant frames outside the durable history window and settles them into compact `assistant/message` or `assistant/attempt` records. Collapsed Tool rows still performed result flattening and large card-array copies before the reader opened them.

The Gateway sent WebSocket Ping frames but accepted an open socket indefinitely without observing a Pong. A half-open carrier could therefore wait for TCP or an intermediary to detect failure before the existing reconnect and journal-repair path ran.

## Decision

The alpha.2 token meter keeps an exact consumed offset and reads only unseen records through indexed Session access. The fork's former direct-append fast path and whole-log fallback remain absent because the official path does not materialize the complete log.

The JSONL handle's routed live-event path retains the deep-frozen value published by `Session.append()`. Public `SessionHandle.append()` still clones borrowed input before asynchronous work. A routed write transfers the pending backing array in O(1), and a failed write prepends that same batch before later events.

The SQLite session-query provider identifies each live Session object weakly and fingerprints its event count plus canonical surface replacement generation. A proven append-only suffix adds only its new search documents; replacement or lifecycle changes retain the complete deterministic fold. Exact-generation Session and event result pages use an item-weighted LRU bounded by the existing `maxLimit`, and returned pages are detached from cached copies.

JSONL persistence caches each validated header against the exact stat-derived selected-generation revision. Concurrent `list()` requests share one metadata scan, while cancellation abandons only the caller's wait. A changed artifact revision forces validation and successful discovery prunes absent entries.

Session Controller owns every Agent handle it creates or resumes. A durable idle Agent remains resident while a history follower, pending inbox item, owned child, active job, or running state needs it. After the configured five-minute retention, the controller flushes the Session, verifies a persistence snapshot, and disposes only its owned handle; the list row and log remain available for normal cold resume.

Collapsed Tool rows derive only their lightweight title, summary, state, and presence flags. The expanded body owns cached getters for formatted arguments, flattened results, recovery text, and specialized card models, so hidden detail cost is paid at most once and only after expansion.

Gateway Ping/Pong retains the strict WebSocket control-frame protocol. Each Ping uses the next heartbeat interval as its Pong deadline; a socket that remains open without acknowledging it is terminated, and the existing carrier-loss path reconnects and rebuilds domain streams from their baselines.

## Verification

Focused SQLite query, JSONL persistence, Session Controller, Tool-row, and Gateway suites pin each incremental or bounded path. Gateway coverage proves Ping/Pong carries no application message and terminates a peer that misses the next Pong deadline.

The incident-scale history contained 256,008 logical events in one message-aligned page, including 256,004 Assistant chunks. Alpha.2 migrates historical generations and projects durable Assistant attempts without retaining token-sized Client rows after settlement.

## Alternatives considered

**Delete or rewrite stored chunks.** Rejected because chunks remain durable replay and diagnostic evidence, and their sequence, timestamp, provenance, fork, and crash-recovery semantics are observable.

**Start with Chat DOM virtualization.** Rejected as the first repair because oversized history parsing, validation, Conversation folding, and retained model construction precede React rendering. Virtualization can still reduce mounted DOM after scroll, selection, find-in-page, accessibility, and variable-height anchor behavior are specified.

**Send application JSON heartbeats.** Rejected because one physical Gateway mux now owns all domain streams and WebSocket Ping/Pong can enforce carrier liveness without expanding the strict Remote message union. JavaScript main-thread performance remains a separate browser diagnostic.

**Move full-text search to a Worker.** Deferred because it moves database ownership, persistence observation, cancellation, and shutdown across a process boundary. Incremental reconciliation and bounded exact-generation caching remove repeated work, but the first broad query remains synchronous.

## Consequences

Long streams avoid repeated whole-log allocation in token accounting, persistence batching, JSONL discovery, and live search indexing. Idle Host residency is bounded without changing model input, event ordering, or durable identity. Alpha.2 owns in-flight Assistant settlement, while collapsed Tool rows avoid work proportional to hidden content. Half-open mux sockets enter the existing reconnect path within two configured heartbeat intervals.

The live Host Session log remains fully resident while its Agent is active, the first varied broad SQLite query can still block one Host thread, and Chat still mounts every loaded presentation row. No Session event type, `SESSION_FORMAT_VERSION`, JSONL storage path, or migration is introduced by these fork-specific bounds.
