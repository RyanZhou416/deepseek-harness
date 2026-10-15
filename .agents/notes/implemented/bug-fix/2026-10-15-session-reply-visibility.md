# Agent Note: Preserve replies across settlement, rendering failure, and process folding

Status: implemented

English | [中文](2026-10-15-session-reply-visibility.zh.md)

## Problem

A durable Assistant reply can be absent from Chat when its delayed commitment appends behind already published entries, when one render failure retires the shared Assistant registration, or when the last available reply is classified as foldable process content. Preventing those failures must preserve preparing tool identities, custom renderer failover, reasoning disclosure, and footer action eligibility.

## Decision

### Commitment and retirement have separate owners

[The client event source](../../../../packages/api/session-controller/src/client/contract/events.ts) routes `commitAssistant` against a published high-water mark that includes transient entries. A later sequence uses ordinary append; an earlier commitment uses `insert-assistant` and ordered Context replay. Existing snapshots remain immutable, repeated commitment of the same event is a no-op, and conflicting occupants are rejected. Ordinary append retains its increasing-sequence requirement.

[The attempt fold](../../../../packages/api/session-controller/src/client/sessions/assistant-stream.ts) retains successful transient rows until the first owning Step or Turn end. If that boundary already arrived, commitment and retirement are atomic. This preserves [three-phase tool preparation](../architecture/2026-09-22-tool-call-three-phases.md): a durable Assistant message is not a replacement source for undispatched tool rows. Failed, interrupted, and abandoned attempts retain their immediate retirement rules.

[Chat](../../../../packages/client/ui-chat/src/client/conversation-nodes/assistant.ts) and [Trajectory](../../../../packages/client/ui-trajectory/src/client/trajectory-assistant-definition.ts) keep finalized message state authoritative over later transient chunks in both initialized and partial-window folds. Retries and boundaries still update their own state; Tool Definitions retain the raw matches until retirement. No Session schema, persistence generation, SDK protocol, or Host execution policy changes.

### The registrant opts into occurrence isolation

Keyed registrations can set `failureScope: 'occurrence'`; the owner supplies `occurrenceRecovery: { fallback, resetKey }`. Only the shipped Assistant registration opts in. The renderer reports a contained error without retiring that registration, so other occurrences remain usable. An unopted override retains its existing abdication and lower-priority promotion behavior. Missing recovery data and `SlotAssemblyError` remain wiring failures, not recoverable message errors.

[Chat's fallback](../../../../packages/client/ui-chat/src/client/chat/AssistantRecovery.tsx) displays current text literally and reports unavailable non-text content. It does not invoke Markdown, file resolvers, image rendering, or raw-payload display. Reasoning occurrences show only a notice. Tagged message generations and the Session incarnation reset a failed occurrence; ordinary streaming updates only refresh its plain text. Healthy instances do not remount when the recovery key changes. A failed fallback reaches parent supervision rather than recursively invoking itself.

### A closed Turn protects its last available reply

[The Turn-process Definition](../../../../packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts) selects the newest loaded finalized reply with visible content in a closed Turn, including text alongside tool calls or before tool-only Steps. Open Turns retain the latest-Step rule. The selection cache invalidates on settlement, retry, boundaries, replay, and a Step's first reply-bearing live frame. Cached synthetic interruptions refresh from their selected Step without a Turn-wide scan.

The response occurrence is protected by Turn/Step identity and content part, not by a transient ordering anchor. Reasoning and process content on either side share a usable outer disclosure. Superseded nodes stay hidden. Footer text actions, navigation previews, file-mention ownership, and usage remain separate policies; displaying an earlier reply does not enable a fork action against a non-tail message.

## Alternatives considered

**Compare only durable cursors or retire every delayed success.** A transient can already be above a held settlement while the durable cursor is unchanged. A later tool call is not a closing boundary; early retirement drops other preparing rows.

**Sort every append, rebuild the entire window, or ignore the ordering assertion.** These conceal the producer mistake and add streaming cost. Ordered insertion is explicit and replays affected Contexts only.

**Disable abdication globally or let the owner alone choose it.** Either changes custom renderer failover. The registrant selects occurrence isolation and the owner supplies the recovery content.

**Protect every intermediate reply or unify folding with footer/navigation selection.** These broaden display behavior or change action eligibility. Only the last available reply receives whole-Turn protection; the other selectors retain their own contracts.

## Consequences

The client retains the existing stream/end join, so a permanently missing end frame still requires existing follow recovery or reopening. Occurrence isolation deliberately forgoes lower-priority promotion for opted registrations, and plain text cannot reproduce rich media. Same-Step retries remain readable in fallback until a new settlement generation retries rich rendering.

The [embedded-stream decision](../architecture/2026-09-01-v2-embedded-assistant-streams.md), [Node/Group assembly](../architecture/2026-09-21-conversation-build-groups.md), [slot ownership](../architecture/2026-07-22-slot-type-chain-implementation.md), and [Chat/Trajectory separation](2026-09-14-chat-presentation-defaults.md) retain their independent rationale. This decision refines client publication and display behavior without replacing those mechanisms.

## Verification

Source regressions cover late boundaries and chunks, immutable window insertion, duplicate/no-op handling, tool preparation, finalized Chat/Trajectory state, multiple renderer occurrences, override promotion, Session-generation recovery, literal fallback text, and closed-Turn selection/disclosure. Work-count assertions cover live and late-frame selection, and restored legacy implementations fail the corresponding regression controls.

[The recorded Web scenario](../../../../apps/web/tests/turn-tail-actions.e2e.ts) verifies that a textless final Step leaves the earlier reply visible, its tools reachable, its branch action unavailable, and reload consistent. Its tool-row locator accepts both dispatched tools and the platform's unavailable-tool result. Separate isolated Chromium probes verified native PowerShell success, injected message-render failure, and delayed end-frame delivery against the built frontend; they did not modify real Session data or deployed bundles.
