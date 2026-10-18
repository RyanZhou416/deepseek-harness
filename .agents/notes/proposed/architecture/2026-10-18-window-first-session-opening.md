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

For a stored parent Session, serve the existing bounded tail window even when `read.projections` is absent or incomplete. The opening frame omits the projection block rather than sending an empty one: the current client store treats an empty block as an exact cut and clears cached title, list metadata, subagent, token, and stats rows. An optional block leaves those cached hints intact and makes "projections unavailable" distinct from "empty projection cut". The subagent address path keeps requiring the complete observation because the `subagent` projection is part of address validation.

This removes the complete `observeSession` from the first opening. The expected first frame moves from roughly 3.8 s to the measured 0.6–0.8 s window range, independent of cache state. Cache-warm window openings already skip cold-open promotion; a no-cache window opening matches that existing behavior. Resume/promotion becomes an explicit later step, and the prompt path must still be verified to promote on demand instead of silently losing the ability to continue the Session.

### 2. Load exact whole-log projections after the first frame

Whole-session values cannot be exact without either a full-log fold or a durable summary. The proposal therefore separates product latency from exact-stat latency:

- an absent opening block is an explicit "not yet projected" state, not a claim that the window counts are whole-session values;
- a single exact `session/projections` read is scheduled only by an explicit user interaction that opens the statistics dialog or the Context surface; mounting either surface, first paint, or an idle task must not trigger it;
- the exact read replaces the absent state; the result is merged into the same projection store with its watermark, and a later navigation cancels the pending read;
- the statistics UI must retain a visible loading/unavailable state instead of presenting window counts as exact. Only `sessionStats` has a window fallback; `tokenUsage`, `contextPressure`, and `contextBreakdown` currently have none and need explicit unavailable/loading presentation rather than fabricated values.

The default path performs no full read. A user who never opens statistics never pays for it.

### 3. Keep older-page work independent

First opening and older-page loading are separate costs. The existing index build still decodes and validates every row only to record offsets; an offset/newline build is measured at 425 ms versus 1,864 ms for the same walk, with the served page still strictly validated by the seeded decoder. A bounded parsed-index memo removes the repeated 30–37 ms sidecar parse per warm page. These changes can land after the opening path and must retain the complete-read fallback.

## Isolation and integration

Development runs in a clean clone at `tmp/window-first` (ignored by the repository, with its own `.git` and `node_modules`), on the `feat/window-first-opening` branch. The running Host keeps its current files and `node_modules`; no checkout, install, build, or test runs in the main worktree. All commands use the clone's own root, a private temporary `DSH_HOME`, and no listener on port 3080. The clone is created with `--no-hardlinks`; `vendor` and `node_modules` remain unshared.

AgentTeams orchestration itself runs in the current Host. The only permitted writes outside the clone are the orchestration artifacts of this team: newly created member Session records under the running Host's `DSH_HOME` and team state under the main checkout's ignored `.agent-teams`. No pre-existing user Session, profile, settings, credentials, source, vendor, or `node_modules` may be modified. Members are instructed to use absolute clone paths or `pnpm --dir <clone>`, to keep every source/doc edit under `tmp/window-first`, and to serialize build/test commands so eight workers do not collide in one clone's outputs. The clone is pushed as a feature branch. Integration into `master` waits for a deliberate Host-stop window; the running Host is never switched to the feature branch. The clone is removed only after the branch is merged and all paths are verified to be independent.

## Stage plan

The critical path is contract → three client/server implementation tracks → benchmark measurement → integration → review. Independent index, benchmark-scaffold, integration-prep, and review-prep work starts in the first wave, and the implementation tracks run concurrently after the shared contract.

1. **Contract**: add the optional opening projection block, the projection-readiness type, and the benchmark/observation seam. This is the only shared-type edit; all other tracks import it.
2. **Parallel implementation wave**:
   - **Server window-first**: relax the complete-checkpoint gate for parent Sessions, omit the projection block, preserve subagent and small-Session fallbacks, and add window/opening tests.
   - **Client absence/readiness**: do not clear cached list/subagent/token/stats rows on an absent block; add explicit unavailable/loading presentation for token and context projections.
   - **On-demand lifecycle**: Manager-owned trigger, single-flight exact reads, per-generation readiness, navigation cancellation, watermark merge, and permission fallback.
3. **Independent parallel tracks**: offset/newline index build, bounded parsed-index memo, follow-level benchmark scaffold and negative control, integration preparation, and pre-review of the contract/risks. These do not share write scopes with the implementation wave.
4. **Benchmark measurement**: run the follow-level cold opening and exact-projection follow-up after the server/client tracks and the benchmark scaffold; keep the no-complete-observation negative control.
5. **Integration**: integrate the implementation tracks and measurement in the clone, resolve the single wiring point between the index build and memo, run focused suites/typecheck/docs/benchmarks, and hand off one feature-branch diff.
6. **Independent review**: review the integrated diff and evidence after integration prep and integration; verdict pass only with no open blockers.

## Alternatives considered

**Make the projection fold faster.** The fold is 343 ms of a roughly 3.8 s cold opening; optimizing it cannot address the 3.4 s complete materialization.

**Keep the cache and warm all Sessions at startup.** This preserves exact statistics but moves the full reads earlier, increases memory/CPU pressure, and is the cache dependency the change is meant to remove.

**Store projection summaries in the Session generation.** This would make the first read fast but changes the durable format and recreates a derived cache in the log; it is outside the current format and ownership rules.

**Always load exact projections on first opening.** This keeps the current correctness but leaves the user-visible latency unchanged.

## Acceptance criteria

- A cold parent-Session opening without a projection cache produces its first snapshot from the bounded window and does not call the complete observation path.
- The opening frame omits the projection block rather than claiming an empty exact cut; cached list/subagent/token/stats values are not cleared, and unavailable projections are explicitly marked by the readiness state.
- The client presents `sessionStats` from the window fallback while token and context projections show a loading/unavailable state until exact values arrive.
- An on-demand exact projection read is single-flight, per-generation, cancellable on navigation, watermark-checked, permission-aware, and eventually replaces the unavailable state.
- Deferred promotion is settled and verified: opening a stored Session without a cache either still permits continuation through the prompt path or explicitly reports that the Session is read-only until promoted.
- Subagent openings still require and validate their projection identity; small stored Sessions keep their complete-observation path.
- Reopening with a complete cache remains as fast as or faster than the current behavior.
- The cold first-frame benchmark shows a material improvement against the recorded baseline, and a follow-level negative control on the old code fails the same assertion.
- Existing history window, paging, subagent, projection-store, and statistics tests remain green; the full-history fallback still works when the stored window is unavailable or malformed.
- All implementation edits, builds, and tests stay inside the clone; no source, `node_modules`, `vendor`, profile, or Session data in the running Host is modified.

## Risks

- Whole-session counts, token totals, context values, and a subset of status UI are temporarily unavailable on a cold opening; product copy and loading states must make that honest.
- A background exact read can compete with scrolling and further navigation; the on-demand trigger and cancellation policy need browser evidence, not only Node timings.
- An omitted block must not be confused with a real empty projection cut by the client store; watermark and readiness semantics need explicit tests.
- The older-page index-build change loses the build-time row-count gate; the served decoder must retain strict validation and the complete-read fallback, with a negative control for a malformed sidecar.
- The clone-based isolation adds disk use and must never share `vendor` or `node_modules` links with the running checkout. AgentTeams member Sessions and team state still land in the running Host's storage even though source work stays in the clone; parallel workers also contend for machine CPU and must serialize build/test commands.
- Deferred promotion changes when a cold Session becomes live; the prompt/resume path must be proven, not assumed.
