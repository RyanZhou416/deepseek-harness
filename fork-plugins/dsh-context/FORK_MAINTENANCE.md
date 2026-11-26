# dsh-context fork maintenance

This subtree carries the DeepSeek Harness fork build of `dsh-context`. It retains the upstream Apache-2.0 `LICENSE` and keeps every fork-modified source and test file marked with a `DeepSeek Harness fork modification` notice.

## Provenance

- Upstream repository: `https://github.com/bowenliang123/dsh-context.git`
- Upstream tag: `v0.87.2`
- Fork package version: `0.87.2-dsh023a2.1`
- Subtree path: `fork-plugins/dsh-context`
- Distribution artifact: none — the real Web profile links this directory and runs the rebuilt `lib/`; the previous-generation tarball lives under `fork-plugins/releases/archive/` and must not be advertised as this source

## Fork behavior

The fork preserves the package name, Cordis ids, `contextTimeline`, `contextHeaders`, and `contextActivity` projection keys, and the upstream `0.2.3` host baseline in addition to the four upstream ones. It adopts the upstream V0/V2/V3/V4 Session-log fold, File Activity ledger, command-execution log, Fleet cockpit, right-Sidebar views, Context Insights dashboard, DeepSeek balance capsule, and the rewritten client data plane: the host owns the price book and cost USD, projects a head-only `contextTimeline` state, pages every detail collection through the facts/history/delta routes, and keeps a byte-budgeted cold fold cache. The authenticated on-demand backfill route arms at most one corpus pass per Host when Context Insights opens, rather than scanning every Session during startup.

Upstream v0.87.2 is a large rewrite on top of the previous fork baseline (`v0.78.2`): `contextTimeline` folds with `headOnly` bounds and declares `wire.summary: false`, the detail collections move to `facts`/`history`/`delta` routes, `detailShadow` keeps a per-session live fold, the price book and USD resolution move host-side into `shared/pricing.ts`, the account wallet becomes `packages/account/deepseek-account` on the `0.2.3` line, and `TIMELINE_STATE_VERSION` is 47. The fork keeps its notices as the only comments in upstream files, and its own files carry the notice as their first line.

Four fork behaviors remain on top of that baseline (two earlier ones retired; see below):

- **Per-generation wire reuse.** The `contextTimeline` wire view returns the previous value when the new state's generation-visible inputs are all reference-equal, so the registry's `Object.is` check suppresses schema validation and `session/projection` publication for host-only churn — a pending tool-call name, the open step slot, a buffered Code-Mode operation, a consumed shadow list, a pending command record the head never renders. The head and inline generations keep separate key sets (`HEAD_WIRE_KEYS`, `INLINE_WIRE_KEYS` in `host/timeline.ts`). Add a field there when a new visible input joins the wire. Two calls on the same state still build distinct values, which keeps the pure-view contract.
- **Stored-session detail reads.** `host/detail.ts` serves a stored Session's head from one `sessionQuery.observeSessionMetadata` stat: the durable header plus the cached `contextTimeline` head and the `contextPressure`/`contextBreakdown`/`tokenUsage` views, with no log read. An ordinary detail read folds only a bounded tail window (`sessionQuery.readWindow`, 400 events) and marks the payload `partial: { fromSeq }` when the window is not the whole log; `full: true` is the only remaining whole-log read. A host without the metadata face keeps the legacy whole-log fold with its revision-keyed payload cache. Upstream's head-only projection state cannot reconstruct a detail, so the previous fork rung that built the detail from the `session_projcache` state checkpoint is retired (see below). The client's cold read is upstream's facts/history paging, so the `partial` marker is a route-level guarantee for head and detail callers rather than a banner in the current UI.
- **Summary-excluded pressure reads and agent heads.** Registration is awaited and its ready handle retained by upstream's `createDetailGate` (the fork's separate `projectionHandle.ts` reader is retired into the gate). The harness excludes `contextPressure`/`contextBreakdown` from Session summaries and the Session control stream carries only summary keys `intersect` live keys, so an unopened Session's detail views never arrive through the stream. `host/headViews.ts` reads the three `HEAD_VIEW_KEYS` on demand: a live Session through `sessionProjections.snapshot(session, HEAD_VIEW_KEYS)`, a stored one through the same metadata stat (no log I/O). Both the detail `head: true` read and the batch `api/dsh-context/heads` route carry `pressure`/`breakdown`/`usage`; `client/agentHeads.ts` decodes them into `AgentHead` and caches per row activity time (`headOf(id, updatedAt)`), and `client/agentTree.ts` merges the views into the row values (row values win). Do not fold child headlines from catalog-row pressure keys again.
- **Reference prices and context tiers.** Verified standard-speed API reference prices cover the five routes in [model pricing](docs/model-pricing.md), independently of models.dev availability. `shared/providers.ts` resolves the `codex`, `claude`, `grok`, and `cursor` route aliases to their model vendors; `shared/modelPricing.ts` owns the dated reference table, the per-model long-context thresholds, and `COST_PERIODS`; `shared/pricing.ts` checks a reference route before the models.dev book and prices a long-context request only on a tier that advertises one; `host/cost.ts` resolves reference faces even while the catalogue is cold (`ready: false` with a known `usd`); `host/foldMetering.ts` books a request whose complete prompt crosses the threshold into the `long` cost bucket; the wire, the projection state schema, host aggregation (`host/overviewAggregate.ts`), and the Context card tooltip all carry that bucket, its tag, and the dated reference disclosure. Token volume is never inferred from a price or subscription quota.

Three behaviors are retired because upstream's structure replaced them:

- **View-time bounds clamp.** Upstream v0.87.2 folds `contextTimeline` with `headOnly` bounds, so the projection state is bounded at fold time, and every wire value is windowed at serve time (`surfaceWindowOf`, `requestRowsOf`/`eventsOf` tails); a restored checkpoint cannot exceed the deployment bounds. The configured low-overhead bounds (`maxRequestSteps: 300`, `maxKeptTurns: 60`, `maxEvents: 100`, `maxNodes: 400`, `maxArchiveNodes: 100`, `maxFileOps: 100`; `maxCommands`/`maxCommandChars` keep their upstream defaults) remain ordinary Cordis configuration and never change stored Session artifacts.
- **State-checkpoint detail rung.** Upstream's `contextTimeline` state is head-only (`apply` uses `headBounds`; `wire.summary: false`), so the persisted `session_projcache` row can no longer reconstruct a detail. The bounded `readWindow` rung above replaces it; keep `observeSession` out of an ordinary stored detail read.
- **Projection-handle reader module.** Upstream's `createDetailGate` retains the awaited registration handle and falls back to the registry-level keyed `stateOf` only for disposer registrations, which is exactly the fork's ladder. `host/projectionHandle.ts` is gone; `host/headViews.ts` keeps only the head-view reads.

Two earlier fork behaviors from the `v0.78.2` baseline stay retired: lazy `/context` modal mounting (upstream reads those hooks unconditionally before the closed early return to keep hook order stable) and `system/message` epoch pricing (upstream's header contract folds a supported epoch header metadata-only and reads `systemTokens` only from cached v1 rows).

The fork pins `zod` to the exact version the installed harness registry uses (`4.6.6` in this checkout; the host's `packages/session/session-projection` declares `4.6.6`). Its `_zod.version` participates in type identity, so a different copy can make `ctx.sessionProjections.register()` reject every unit at type-check time. The plugin's development dependencies stay on the lowest supported Harness floor (`0.2.0-rc.2`) as `tests/compat/bundle.spec.ts` requires; the runtime works on all five declared releases and degrades to the legacy detail fold where the newer read faces are absent.

## Host compatibility

`docs/compatibility.md` is the compatibility source of truth. The fork adds the `0.2.3-alpha.2` baseline to `package.json` (`engines.dsh`, the `@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-client-ui-primitives` peers, and `dsh.compatibility.dshReleases`), `tests/baselines.ts`, and both CI workflows' tag fetch lists, so `tests/compat/bundle.spec.ts` keeps the five in lockstep and the seam matrix runs against the tag's real sources. `0.2.3-alpha.2` moved the account wallet to `packages/account/deepseek-account` (same service, `getBalance` face, and bundle entry) and narrowed the Session control stream to summary keys; the baseline descriptor records both. `engines.dsh` decides admission on the `0.2.2`/`0.2.3` lines (peers only gate `0.2.0` and pre-alpha.4 `0.2.1`), and the engine floor stays `0.2.0-rc.2`.

## Verification and packaging

### Tool attribution lifetime

The lifetime repair this fork carried — unwrap `cordis.original` before identifying or patching a tool service, keep only the reader's plugin name, restore the original method on unload, and fall back to the call stack when the reader slot is unusable — is upstream's implementation, with its own regression coverage. Do not re-port it on top of the upstream file; re-port only if a merge shows the upstream behavior lost. The isolation experiments that motivated the repair remain this fork's evidence:

The 2026-09-27 Host snapshot contained 257 disposed and 12 live Agents. An offline reference-graph experiment, including conditional WeakMap reachability, disconnected 248 disposed Agent/Session pairs and 10,265.24 MiB after removing the attribution restore-array and reader-context references. This accounts for about 86% of reachable shallow object bytes; it estimates ownership in that snapshot, not post-fix production RSS. Raw snapshots and their numeric indexes remain private diagnostics outside Git.

The following diagnostic run lasted approximately 3 hours 40 minutes: sampled JS heap peaked at 2.50 GiB and ended at 1.49 GiB, while the disposed-Agent count peaked at 15 and ended at 4. The growth snapshot contained one attribution restore entry, compared with 82,602 in the earlier incident. This is observed workload evidence, not a fixed-input benchmark or a guarantee that every retention issue is resolved. The fork-wide [memory record](../../FORK_MAINTENANCE.md#memory-ownership-verification) owns the diagnostic policy and explicitly defers findings.

### Commands

Run commands from this directory.

```powershell
corepack pnpm@11.9.0 install --ignore-scripts
corepack pnpm@11.9.0 typecheck
corepack pnpm@11.9.0 exec vitest run tests/host/detail.spec.ts tests/host/detail-cold.spec.ts tests/host/headsRoute.spec.ts tests/host/cost.spec.ts tests/host/model-pricing.spec.ts tests/client/agentHeads.spec.ts tests/client/agentTree.spec.ts tests/client/fleetModel.spec.ts tests/client/cost.spec.ts tests/client/components/statsContext.spec.ts --coverage.enabled=false
corepack pnpm@11.9.0 run lint && corepack pnpm@11.9.0 run test && corepack pnpm@11.9.0 run build
corepack pnpm@11.9.0 pack --pack-destination ..\releases
```

`tests/host/detail-cold.spec.ts` pins the stored-session detail rungs: a head read costs one metadata stat and no log read, a missing cached head or malformed header serves null, the bounded window is marked `partial` and a complete window is not, `full: true` folds the whole log once and replays it by revision, and cancellation answers the aborted envelope. `tests/host/headViews.spec.ts` pins the live-snapshot and degraded head-view reads. `tests/host/model-pricing.spec.ts` and `tests/shared/modelPricing.spec.ts` pin the `long` bucket and the reference table, `tests/host/cost.spec.ts` pins reference pricing with a cold catalogue and the long price tag, and `tests/client/components/statsContext.spec.ts` pins the dated disclosure and long-context tag. `tests/client/agentHeads.spec.ts` pins the head views and the activity-keyed cache. The compat matrix runs when `DSH_REPO` names a DeepSeek Harness checkout carrying the `dsh-v0.2.0-rc.2`, `dsh-v0.2.1-rc.2`, `dsh-v0.2.2-rc.1`, `dsh-v0.2.2-rc.3`, and `dsh-v0.2.3-alpha.2` tags; per baseline it stages that tag's real sources (synthesizing the `FiberState` object the published cordis erases from its `const enum`), boots the BUILT plugin into the tag's registry, and probes the host and client seams. Its first run per baseline installs that tag's cordis and session packages into `.tmp/compat`, so pre-install them if a cold run exceeds the hook timeout. Store the packed artifact's uppercase SHA-256 beside it and inspect the tarball manifest and its embedded `package.json` version before installation.

## Updating upstream

Confirm the repository worktree contains no unrelated changes, then import a reviewed upstream tag through the existing subtree:

```powershell
git subtree pull --prefix=fork-plugins/dsh-context https://github.com/bowenliang123/dsh-context.git <tag> --squash
```

Reapply or retire each behavior in this document, preserve the file-level fork notices, advance the private version, run focused compatibility and behavior tests, build, pack, and record the new artifact hash. Never update a real profile with an unreviewed npm `@latest` package.

## Rollback

Rollback uses a retained, verified artifact and never edits Session data. A package whose projection `stateVersion` differs causes the registry to rebuild that plugin's derived checkpoint from the Session log; rollback validation must therefore cover V0, V2, V3, and V4 histories rather than restoring projection-cache files manually. A future change to projection keys, Session events, or wire compatibility requires its own migration and rollback decision before packaging.
