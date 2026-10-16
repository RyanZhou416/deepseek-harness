---
description: "The prepared-request recording seam: how a model route publishes the request it is about to send into its session log and why only a durability-checked record may be sent."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-request-record

English | [中文](README.zh.md)

## Summary

`dsh-llm-request-record` owns the `ctx.llmRequestRecord` service and the `llm/request-record` event. A model route calls `recordPreparedRequest` after building its bytes and before sending them; the service appends one record to the owning session's log, waits for that log to reach durable storage, and answers with the record's own sequence number or a fixed refusal that forbids the send. The record states what was emitted: ordered system text, model, purpose, wire library and profile. It never states an outcome: a false, rejected or timed-out durability result still leaves the prepared record in the log.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package in a Host composition and configure the durability bound. The service registers as `ctx.llmRequestRecord`.

```yaml
- name: '@deepseek-ai/dsh-llm-request-record'
  config:
    flushTimeoutMs: 5000
```

| Field | Default | Meaning |
|---|---|---|
| `flushTimeoutMs` | none (required) | Milliseconds one prepared record may wait for `SessionStore.flush` before its producer is told the record is not durable; accepted from `1` through `MAX_TIMER_DELAY_MS` (2147483647) |

There is no default for `flushTimeoutMs`. The bound is what keeps a stalled durability listener from holding a model request open indefinitely, so a deployment states it rather than inheriting a compiled-in number. A value below `1` or above `MAX_TIMER_DELAY_MS` (2147483647 milliseconds, the largest delay a timer accepts) is a load error.

### Recording one prepared request

`recordPreparedRequest(context, payload): Promise<LlmRequestRecordOutcome>` accepts the live session that owns the request and the producer's observation of it, and answers with one of exactly two shapes:

| Result | Meaning |
|---|---|
| `{ ok: true, preparedId }` | The record is in the session log at `preparedId` and a durability listener settled successfully |
| `{ ok: false, code: 'REQUEST_RECORD_UNAVAILABLE' }` | No durable record carries this request: no live session, no valid payload, no participating durability listener, a listener failure, or the deadline |
| `{ ok: false, code: 'CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED' }` | The request named no session, so no log can carry its record |

Both failure codes are send-forbidding. The outcome is total: every refusal a producer acts on arrives as `ok: false`, not as a rejection. `CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED` is reported by a producer that reaches the seam with no session, before there is a service call to make; this service answers `REQUEST_RECORD_UNAVAILABLE`.

The caller supplies `provider`, `model`, `purpose`, `systemBlocks`, `wireLibrary` and `profile`. The service supplies `v`, `phase` and `systemDigest`, so a producer cannot state a schema or a digest its own text does not satisfy.

### Reading one recorded request

`reconstructRequestSystem(events, preparedId?)` projects the recorded ordered system text out of a session's events — live or read back from durable storage, because it reads the array it is handed and no Session history accessor.

Pass the `preparedId` a successful call returned to read that attempt. One record exists per attempt, so a consumer reconstructing a specific send of several retries must pass the id it recorded; the omitted form reads the latest record and is a default for a caller that holds no id.

### The recorded event

`llm/request-record` holds one `LlmRequestRecordData`: `v: 1`, `phase: 'prepared'`, the `provider` discriminant (`'claude'` today), `model`, `purpose` (`'conversation'`, `'compaction'` or `'session-title'`), `systemBlocks` (the emitted system text, one entry per block, in wire order), `systemDigest` (`sha256` of `JSON.stringify(systemBlocks)`), `wireLibrary` and `profile`.

The record's own log `seq` is its identity; there is no separate id and no ordinal inside a step. One record exists per attempt that reached the recorder, so a retried request produces more records than answered requests; the two are not paired one-to-one.

`systemBlocks` carries per-block text only. A `cache_control` marker and any serialization whitespace between blocks are not recoverable from this event, and nothing claims otherwise.

The event sets no `ignorable` marker, so it is required on read: a build that does not know the type refuses the whole log instead of skipping the record. A writer therefore ships only after a build that declares the type is running, and the deployment order is not optional.

### Confidentiality

The recorded text is the caller's own system prompt, which may contain a secret the deployment configured into it. This event therefore carries the confidentiality level of `system/message`: read it exactly as a session log is read. The package neither strips nor claims to strip anything, and no field is described as free of secrets. User prompt bodies, access tokens, account identifiers and email addresses are not part of the vocabulary at all.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition (`LlmRequestRecordService`), the session-log provider (`SessionRequestRecordProvider`, the default export), the required `Config`, and the bounded durability wait |
| [`src/types.ts`](src/types.ts) | The event payload, the producer payload, the context, the failure-code union, and the `SessionEventMap` merge |
| [`src/record-data.ts`](src/record-data.ts) | Pure functions: complete one payload into a record, digest the recorded text, project one recorded request's system text by `preparedId` or by latest |
| [`tests/record.spec.ts`](tests/record.spec.ts) | Provider behavior over a real `SessionStore`: append identity, per-attempt records, a durability result that is false, rejected or late, unbounded-listener drain, admission closed at disposal |
| [`tests/recorded-composition.spec.ts`](tests/recorded-composition.spec.ts) | A private persistence listener writes the accepted events to JSONL; the reader then selects one attempt from the bytes on disk |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | The Loader mounts the package from a test-only `cordis.yml` — module resolution comes from the importer this test installs — and applies its required bound |
| — | No runtime invariant companion is published; the package exposes no independent event sequence or mutable relation beyond the append-and-flush contract its own service enforces. |

### Why one package holds both roles

The Definition and its provider are owned by one capability and change together: the producer contract is exactly the append-and-flush sequence the provider performs, and a second package would only hold a copy of that vocabulary. A consumer depends on the abstract service, so a second provider (another transport, another durability rule) replaces this one without touching the caller.

### Durability semantics

`recordPreparedRequest` appends through the live `SessionStore` and then awaits `SessionStore.flush(session)` for that session. The append is committed in memory first, so a failed or late flush still leaves the record in the log at its `seq`; only the outcome changes. The wait is bounded by `flushTimeoutMs`, and the deadline bounds the wait alone — the provider never cancels the listener's write, so a slow or stalled durability listener keeps its own disk write and the producer learns only that the record is not yet durable.

Every flush the provider starts stays owned by it until it settles. Disposal stops admission first, then waits for the outstanding flushes up to one more configured deadline, so an unload cannot hang on a stalled filesystem and cannot return while a flush it started is still being waited for.

### Consumer contract

A consumer reaches the service through a scoped dependency (`ctx.inject(['llmRequestRecord'], …)`) or `ctx.get`, and never appends a record itself. Registering a route that sends model requests without a recorder is a composition error: a route that cannot publish what it sends must not send it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session subsystem](../../../docs/subsystems/session.md) — the event log, its readers, and the durability checkpoint this service uses.
- [Persistence catalog](../../../docs/persistence-catalog.md) — the generated reference for every session event, `llm/request-record` included.
- [`@deepseek-ai/dsh-session`](../../core/session/README.md) — `SessionStore`, `flush`, and the live-session requirement.
- [`dsh-plugin-subscriptions`](../../../fork-plugins/dsh-plugin-subscriptions/README.md) — the Claude Messages route that consumes this seam.

-----

<a id="model-experience"></a>
## Model Experience

None, as these records are log-only: they are never projected into a model request and change no prompt, tool schema or result the model reads.

#### KV Cache effect

No direct invalidation; a record is appended to the session log and never enters a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints: they bound what a consumer may rely on today.

- **One producer discriminant** — `provider` is a closed literal union whose only member today is `'claude'`. A second producer adds a member and its own version-named payload; it cannot reuse this one's fields for a different wire shape.
- **The reader is a projection, not a surface** — `reconstructRequestSystem` selects one attempt's system text from an event array by `preparedId`, or the latest record when no id is given. Rendering these records in the Session browser, the CLI or an export is owned by those consumers and does not exist yet, so a record is otherwise visible only through the raw log.
- **A record cannot be skipped by an older build** — the event sets no `ignorable`, so a build that does not know `llm/request-record` refuses the whole log rather than dropping the record. The write path must ship after a build that declares the type, with the restart that installs it; see the persistence acknowledgement for this event.
- **`systemBlocks` is not the wire body** — a consumer needing exact request bytes must record them separately; this event deliberately excludes `cache_control` markers and inter-block whitespace.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions. It is explicitly non-authoritative.

#### Future: per-session flush coalescing

Two records for one session within the same request currently await `flush` twice. If a deployment shows that cost, the provider can coalesce records appended in one synchronous stretch onto a single flush while keeping one record per attempt.

</details>
