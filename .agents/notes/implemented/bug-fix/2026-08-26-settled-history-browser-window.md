# Agent Note: Settled history projection and bounded browser windows

Status: implemented

English | [中文](2026-08-26-settled-history-browser-window.zh.md)

## Problem

Message-count pagination did not bound a browser history response. One finalized Assistant message could cite hundreds of thousands of durable `assistant/chunk` events through `sourceEventSeqs`, so the Host transported every chunk plus the complete final message. JSON parsing, wire validation, Conversation matching, and retained Context matches happened before DOM virtualization could help. A page could therefore consume a browser renderer even though refreshing or restarting the Host left the durable Session intact.

The same growth continued while a page stayed open. A resident Client Session retained every live event, view, and Conversation match after its initial tail page. Collapsed Tool rows also derived complete formatted arguments, flattened results, and copied card arrays before the reader expanded them.

## Decision

The history APIs preserve raw delivery by default and accept the additive `projection: 'settled'` request used by the Web Runtime. Pagination still selects a message-aligned raw interval first. The settled projection then replaces each finalized Assistant step's chunk stream with its usage records, first token delta, and final `assistant/message`. Usage records preserve retry-inclusive accounting, the first delta preserves first-token and first-visible timing, and the final message supplies complete content. A final message whose provenance names only chunks from that same step is copied without `sourceEventSeqs`. The original event and durable log remain unchanged.

Every history response carries `range`, the raw `{startSeq, endSeq}` interval selected before projection. Client Session state uses that interval for older-page adjacency, live deduplication, reconnect baseline comparison, and gap repair, while the projected `events` array may be sparse. The optional field lets an older contiguous fixture or carrier derive its range from the first and last returned event.

The Web Runtime requests settled history for both ordinary Sessions and addressed subagents. `liveWindowRebaseEventThreshold` is a validated Runtime plugin setting with a default of 20,000 raw resident events. Once an `assistant/message` finalizes a model phase and the window reaches that threshold, one tail request replaces the oversized live suffix with the settled projection. Events arriving during the request enter the existing sequence buffer and stitch after the returned raw range. A failed request restores every buffered event, defers retry until later activity, and never enters an immediate retry loop. A successful rebase retains already loaded projected older pages whose raw ranges precede and overlap the new tail.

An unfinalized model phase remains exact: its chunks are neither truncated nor projected away. This is the required exception to the residency bound because no final message yet carries equivalent complete content.

Collapsed reasoning already mounts only its one-line summary through `DisclosureRow`; a regression test pins that the full reasoning body is absent until expansion. Tool rows add an explicit heavy-body component. Their collapsed model computes only the title, summary, state, and lightweight presence flags; formatted arguments, complete result flattening, recovery text, and large card-array copies are cached getters first read by the expanded body or details view.

## Verification

Host tests cover raw-default compatibility, ordinary and subagent settled reads, empty and older pages, raw range reporting, compaction-aligned pagination, first-token retention, chunk-only provenance removal, and input immutability. Runtime sequence tests cover sparse initial pages, older-page adjacency, reconnect and gap repair, finalized threshold rebasing, retained older projections, buffered live events, failed rebase recovery, delayed retry, and ordinary/subagent request parity. UI component tests prove collapsed reasoning omits the full body and collapsed Tool rows do not execute heavy getters, while expansion executes and caches each derivation.

The incident-scale read contained 256,008 events in one message-aligned tail page: 256,004 chunks occupied about 39 MiB and the final message carried about 2.4 MiB including provenance. The stored Session remains the source of truth.

## Alternatives considered

**Delete or rewrite stored chunks.** Rejected because chunks are durable replay and diagnostic evidence. Projection belongs at the read boundary and cannot mutate Session, JSONL, fork, resume, or export data.

**Lower the message count.** Rejected because the measured one-message page still contained the complete 256,004-chunk stream. Message count and raw event count are different bounds.

**Clip a raw page without reporting its covered sequence interval.** Rejected because the Client would interpret omitted seqs as transport loss, repeatedly repair the gap, and break older-page adjacency. `range` keeps sequence coverage explicit.

**Poll or reload every running Session.** Rejected because healthy sessions would repeatedly parse history and cost would grow with resident Session count. A threshold-triggered single-flight rebase runs only after equivalent finalized content exists.

**Start with DOM list virtualization.** Rejected as the first repair because the oversized JSON response, validation, Conversation fold, and retained matches precede React rendering. DOM virtualization remains useful after the data and computation bounds, but it cannot replace them.

## Consequences

Opening a finalized long Session transports and retains its final presentation instead of every token delta, while raw API callers and exact session-log export retain full fidelity. Long-running pages release finalized chunk streams after crossing a configurable bound, and reader-loaded older projections remain available. Collapsed Tool rows avoid work proportional to hidden detail size.

The additive history request and response fields expand the Web wire contract but do not change any Session event, on-disk version, compression artifact, or storage path. A single still-running model phase can exceed the configured threshold until its final message arrives. Full variable-height DOM virtualization and scroll-anchor preservation across arbitrary row eviction remain separate presentation work.
