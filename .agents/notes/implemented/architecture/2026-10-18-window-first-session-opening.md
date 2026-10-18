# Agent Note: Window-first Session opening without a projection cache

Status: implemented

English | [中文](2026-10-18-window-first-session-opening.zh.md)

## Problem

Opening a stored Session for the first time is slow when no usable projection checkpoint exists. The history controller can read the newest tail window without an index, but it used to refuse that window unless the projection cache supplied a complete baseline for every registered client-visible key. Without a baseline it fell back to the complete observation, which materializes and validates the entire log before the first frame; the projection fold is then an additional cost.

Measured on a real 188,395-event, 164.6 MB generation (Node 24, warm page cache):

| Phase | Time |
|---|---:|
| `sessionPersistence.open` (complete log materialization and validation) | 3,430 ms |
| `handle.read()` after that open | 9.2 ms |
| `sessionStats` + token/context projection fold | 343 ms |
| direct tail `readWindow` (10k events) | 318–556 ms |

The cold opening therefore spent roughly 90% of its time before the projection fold. A cache hit avoided that work because `openWindow` received a checkpoint and never created the complete observation. The goal is to remove the cache from the critical path of the first opening, not to make the unavoidable complete projection derivation disappear.

## Decision

### 1. Open from the window first

For a stored parent Session, the Host serves the existing bounded tail window even when `read.projections` is absent or incomplete. The opening frame omits the projection block instead of sending an empty one: the client projection store treats an empty block as an exact cut and clears cached title, list metadata, subagent, token, and stats rows. An optional block keeps those cached hints intact and makes "projections unavailable" distinct from "empty projection cut". The subagent address path still requires the complete observation because the `subagent` projection is part of address validation.

The follow opening no longer calls the complete `observeSession`. On the follow-level synthetic fixture, the first snapshot measures about 30 ms against about 449–456 ms for the deferred complete read recorded in the same process (see the benchmark gate note). Page loading is unchanged and still serves older pages from stored windows. Cache-warm window openings already skipped cold-open promotion, and a no-cache window opening matches that behavior: it retains no prepared observation, and a later prompt or resume takes the ordinary cold Session resume path instead of making the Session read-only.

### 2. Load exact whole-log projections after the first frame

Whole-session values cannot be exact without either a full-log fold or a durable summary, so product latency and exact-stat latency are separate:

- an absent opening block is an explicit "not yet projected" state (`ProjectionAvailability`), not a claim that window counts are whole-session values;
- a single exact `session/projections` read is requested only by the explicit user action that opens the statistics dialog or the Context surface; mounting a surface, first paint, or an idle task does not trigger it;
- the read is single-flight per Session, belongs to one Host connection generation, stops when the Session leaves the view, and merges under the projection store's watermark rule so a stale cut cannot regress a newer value;
- a permission or access refusal is terminal for the generation, a migration-required read remains retryable, and readiness returns to unavailable instead of spinning;
- the statistics UI keeps a visible loading/unavailable state. Only `sessionStats` has a window-scoped fallback; `tokenUsage`, `contextPressure`, and `contextBreakdown` present loading/unavailable copy until an exact cut arrives.

### 3. Keep older-page work independent

First opening and older-page loading remain separate costs. The generation index build counts newline-delimited records per frame instead of JSON-decoding and validating every row; the served window is still validated by the seeded strict decoder, and a malformed or non-1:1 generation keeps the complete-read fallback. A bounded in-process memo retains parsed sidecar indexes keyed by exact generation path, byte size, and modification time, additionally guarded by the sidecar file's own identity; warm backwards pages reuse one parse, concurrent readers share one parse, and the backend disposes the memo at teardown. Both changes retain the complete-read fallback and the durable sidecar rebuild path.

## Isolation

Implementation and verification ran in the ignored clone `tmp/window-first` on `feat/window-first-opening`, with its own `.git`, `vendor`, and `node_modules`. The running Host kept its source files, `node_modules`, and `DSH_HOME`; no checkout, install, build, or test ran in the main worktree, and the only writes outside the clone belong to the team's own orchestration state. The clone is the handoff; integration into `master` waits for a deliberate Host-stop window.

## Alternatives considered

**Make the projection fold faster.** The fold is 343 ms of a roughly 3.8 s cold opening; optimizing it cannot address the 3.4 s complete materialization.

**Keep the cache and warm all Sessions at startup.** This preserves exact statistics but moves the full reads earlier, increases memory/CPU pressure, and is the cache dependency the change is meant to remove.

**Store projection summaries in the Session generation.** This would make the first read fast but changes the durable format and recreates a derived cache in the log; it is outside the current format and ownership rules.

**Always load exact projections on first opening.** This keeps the current correctness but leaves the user-visible latency unchanged.

## Consequences

- Whole-session counts, token totals, context values, and part of the status UI are temporarily unavailable on a cold opening until the user opens statistics or Context. Product copy and loading states make that explicit instead of presenting window counts as exact.
- The deferred read competes with scrolling and later navigation only after an explicit user action. It is cancelled when the Session leaves the view, and its watermark merge cannot regress a newer exact value or a live frame.
- An absent block stays distinct from an empty exact cut: the wire field is optional, availability is independent of rows, and tests pin an exact empty cut clearing rows while an absent opening leaves cached rows intact.
- The count-only index build gives up the build-time row-count gate. The seeded decoder still validates every served row, and malformed or non-dense generations keep the complete-read fallback, with negative controls for a blank counted record, a committed sequence gap, and an inflated sidecar.
- Window openings intentionally do not promote. A prompt resumes the cold Session through the ordinary path, trading an eager background activation for a first frame that never materializes the complete log.
- A checkpoint that predates a newly registered client-visible key is still omitted; a cold opening then shows unavailable readiness until the exact read completes.
- The follow-level benchmarks enforce the cold and cache-warm first-frame ceilings and the ≤ 0.5 first-frame share of the deferred read. The hosted Linux CI lane owns the required verdict.

## Testing

- The focused integrated suite (13 files, 298 tests) covers history windows and edges, the small-session path, the projection store, the Session manager and service, and the JSONL index, window, and memo files.
- The adjacency run (79 files, 1,906 tests: 1,892 passed, 1 skipped) reproduces only the 13 failures that also fail at the pre-change base (`session-presets.host.spec.ts` ×12, `transport.client.spec.ts` ×1); they are not caused by this change.
- `benchmarks/session-open/window-first-follow.bench.ts` records the cold first snapshot (about 30 ms against a 75 ms CI ceiling) with zero complete observations and zero full persistence opens, the deferred exact read (about 449–456 ms) with exactly one of each, and the cache-warm reopen (about 37 ms against a 95 ms ceiling) with an exact block and no deferred read. The cold first-frame share of the deferred read is 0.068 against the 0.5 gate.
- Typecheck, the doc-quick aggregate, export-JSDoc, and the Cordis catalog gates pass. The benchmark gate note owns the recorded samples, workload, memory endpoints, and calibration.
