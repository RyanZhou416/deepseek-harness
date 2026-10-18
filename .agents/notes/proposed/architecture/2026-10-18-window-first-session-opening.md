# Agent Note: Window-first Session opening without a projection cache

Status: proposed

English | [中文](2026-10-18-window-first-session-opening.zh.md)

## Problem

Opening a stored Session for the first time is slow when no usable projection checkpoint exists. The history controller can read the newest tail window without an index, but it currently refuses to use that window unless the projection cache supplies a complete baseline for every registered client-visible key. Without a baseline it falls back to the complete observation, which materializes and validates the entire log before the first frame; the projection fold is then an additional cost.

Measured on a real 188,395-event, 164.6 MB generation (Node 24, warm page cache):

| Phase | Time |
|---|---:|
| `sessionPersistence.open` (complete log materialization and validation) | 3,430 ms |
| `handle.read()` after that open | 9.2 ms |
| `sessionStats` + token/context projection fold | 343 ms |
| direct tail `readWindow` (10k events) | 318–556 ms |

The cold opening therefore spends roughly 90% of its time before the projection fold. A cache hit avoids that work because `openWindow` receives a checkpoint and never creates the complete observation. The goal is to remove the cache from the critical path of the first opening, not to make the unavoidable complete projection derivation disappear.

## Proposal

### 1. Open from the window first

For a stored parent Session, serve the existing bounded tail window even when `read.projections` is absent or incomplete. The opening frame carries an empty projection baseline at the window cursor; the client uses its existing window-scoped fallback for statistics and context values. The subagent address path keeps requiring the complete observation because the `subagent` projection is part of address validation.

This removes the complete `observeSession` from the first opening. The expected first frame moves from roughly 3.8 s to the measured 0.6–0.8 s window range, independent of cache state.

### 2. Load exact whole-log projections after the first frame

Whole-session values cannot be exact without either a full-log fold or a durable summary. The proposal therefore separates product latency from exact-stat latency:

- an empty opening baseline is an explicit "not yet projected" state, not a claim that the window counts are whole-session values;
- a single exact `session/projections` read is scheduled on demand when the statistics or Context surface is opened, or after the first frame on an idle task;
- the result is merged into the same projection store with its watermark, and a later navigation cancels the pending read;
- the statistics UI must retain a visible loading/unavailable state instead of presenting window counts as exact.

The default path performs no full read. A user who never opens statistics never pays for it.

### 3. Keep older-page work independent

First opening and older-page loading are separate costs. The existing index build still decodes and validates every row only to record offsets; an offset/newline build is measured at 425 ms versus 1,864 ms for the same walk, with the served page still strictly validated by the seeded decoder. A bounded parsed-index memo removes the repeated 30–37 ms sidecar parse per warm page. These changes can land after the opening path and must retain the complete-read fallback.

## Isolation and integration

Development runs in a clean clone at `tmp/window-first` (ignored by the repository, with its own `.git` and `node_modules`), on the `feat/window-first-opening` branch. The running Host keeps its current files and `node_modules`; no checkout, install, build, or test runs in the main worktree. All commands use the clone's own root, a private temporary `DSH_HOME`, and no listener on port 3080.

The clone is pushed as a feature branch. Integration into `master` waits for a deliberate Host-stop window; the running Host is never switched to the feature branch. The clone is removed only after the branch is merged and all paths are verified to be independent.

## Stage plan

1. **Contract and baseline**: freeze the empty-baseline semantics, define the projection readiness state, record the cold/warm measurement, and add the failing negative control that proves the current path performs the complete open.
2. **Server window-first**: relax the complete-checkpoint gate for parent Sessions, preserve subagent fallback, and add window/opening tests.
3. **Client readiness and loading**: propagate the empty baseline as an explicit loading state; keep window fallback for statistics while exact values are unavailable.
4. **Projection on-demand lifecycle**: single-flight exact projection reads, navigation cancellation, watermark checks, and merge into the existing store.
5. **Benchmark proof**: cold first opening with no cache, first frame, exact-projection follow-up, and no complete observation on the fast path.
6. **Older-page index build**: offset/newline build with strict served-window validation and complete-read fallback.
7. **Older-page index memo**: bounded identity-keyed parsed-index reuse with disposal and invalidation tests.
8. **Integration review**: cross-package behavior, negative controls, docs, and a single feature-branch handoff for the user's review.

## Alternatives considered

**Make the projection fold faster.** The fold is 343 ms of a roughly 3.8 s cold opening; optimizing it cannot address the 3.4 s complete materialization.

**Keep the cache and warm all Sessions at startup.** This preserves exact statistics but moves the full reads earlier, increases memory/CPU pressure, and is the cache dependency the change is meant to remove.

**Store projection summaries in the Session generation.** This would make the first read fast but changes the durable format and recreates a derived cache in the log; it is outside the current format and ownership rules.

**Always load exact projections on first opening.** This keeps the current correctness but leaves the user-visible latency unchanged.

## Acceptance criteria

- A cold parent-Session opening without a projection cache produces its first snapshot from the bounded window and does not call the complete observation path.
- The opening frame explicitly marks projections as unavailable at its cursor; window-scoped statistics remain the client fallback and are not labeled as exact whole-session figures.
- An on-demand exact projection read is single-flight, cancellable on navigation, watermark-checked, and eventually replaces the fallback values.
- Subagent openings still require and validate their projection identity.
- Reopening with a complete cache remains as fast as or faster than the current behavior.
- The cold first-frame benchmark shows a material improvement against the recorded baseline, and a negative control on the old code fails the same assertion.
- Existing history window, paging, subagent, projection-store, and statistics tests remain green; the full-history fallback still works when the stored window is unavailable or malformed.

## Risks

- Whole-session counts, token totals, context values, and a subset of status UI are temporarily unavailable on a cold opening; product copy and loading states must make that honest.
- A background exact read can compete with scrolling and further navigation; the on-demand trigger and cancellation policy need browser evidence, not only Node timings.
- Empty baselines must not be confused with a real empty projection cut by the client store; watermark and readiness semantics need explicit tests.
- The older-page index-build change loses the build-time row-count gate; the served decoder must retain strict validation and the complete-read fallback, with a negative control for a malformed sidecar.
- The clone-based isolation adds disk use and must never share `vendor` or `node_modules` links with the running checkout.
