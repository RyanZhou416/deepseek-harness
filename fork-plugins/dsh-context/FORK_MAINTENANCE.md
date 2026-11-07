# dsh-context fork maintenance

This subtree carries the DeepSeek Harness fork build of `dsh-context`. It retains the upstream Apache-2.0 `LICENSE` and keeps every fork-modified source and test file marked with a `DeepSeek Harness fork modification` notice.

## Provenance

- Upstream repository: `https://github.com/bowenliang123/dsh-context.git`
- Upstream tag: `v0.78.2`
- Fork package version: `0.78.2-dsh022rc1.1`
- Subtree path: `fork-plugins/dsh-context`
- Distribution artifact: none — the real Web profile links this directory and runs the rebuilt `lib/`; the previous-generation tarball lives under `fork-plugins/releases/archive/` and must not be advertised as this source

## Fork behavior

The fork preserves the package name, Cordis ids, `contextTimeline`, `contextHeaders`, and `contextActivity` projection keys. It adopts the upstream V0/V2/V3/V4 Session-log fold, File Activity ledger, command-execution log, Fleet cockpit, right-Sidebar views, Context Insights dashboard, DeepSeek balance capsule, last-user-message cards, and split `contextTimeline` delivery: a slim head rides projection traffic while an open Context view fetches heavy detail on demand. The authenticated on-demand backfill route arms at most one corpus pass per Host when Context Insights opens, rather than scanning every Session during startup.

Upstream v0.78.2 split the fold into `host/foldState.ts` (state shape and retention trim), `host/foldMetering.ts` (usage, cost, and timing totals), and `host/foldWire.ts` (head, detail, and inline views), made the projection contract the registry's generic `ProjectionDefinition`, folded the `developer/message` event, added the command log with paged history, and stripped comments from source and tests (its `AGENTS.md` now requires comment-free source; fork notices stay as the only exception). Field-level copy-on-write is upstream's `ensure([...])` clone list, and the dirty-field retention trim is upstream's `trimState`. The persisted timeline keeps upstream `stateVersion: 36`; the fork adds only the optional `long` cost bucket to its state schema, so existing rows stay readable and a fork build that changes any other persisted field must advance that number so cached rows refold from the durable log.

Five fork behaviors remain on top of that baseline:
- **View-time bounds clamp.** A checkpoint restored from an older bounds configuration is clamped when the first wire value is built, without rewriting the checkpoint: requests by whole turn runs and then by the hard step cap, plus the event tail, removed-node archive, file-operation log, command log, and timing spans. The configured bounds are the low-overhead deployment values `maxRequestSteps: 300`, `maxKeptTurns: 60`, `maxEvents: 100`, `maxNodes: 400`, `maxArchiveNodes: 100`, and `maxFileOps: 100`; `maxCommands` and `maxCommandChars` keep their upstream defaults (`400`, `4096`). They are ordinary Cordis plugin configuration and never change stored Session artifacts.
- **Per-generation wire reuse.** Each wire generation (slim head, inline value) retains its previous value together with the state it came from. A NEW state whose generation-visible inputs are all reference-equal — host-only churn such as a pending tool-call name, the open step slot, a buffered Code-Mode operation, a consumed shadow list, or a pending command record the slim head never renders — reuses that value, so the registry's `Object.is` check suppresses schema validation and `session/projection` publication. The head and inline generations carry separate key sets: the inline view renders the command log and file operations, so opening a command replaces its value there. Two calls on the same state still build distinct values, which keeps the pure-view contract. Visible inputs for the head are `surface`, `sums`, the assistant splits, `systemTokens`, `systems`, `toolsTokens`, `model`, `provider`, `reasoningEffort`, `contextWindow`, `maxOutputTokens`, `requests`, `events`, `cost`, the generated splits, `humanInputs`, `answers`, `lastUser`, `archiveFloor`, `detailRev`, and `timing`; the inline generation adds `archived`, `spans`, `fileOps`, `fileOpsFloor`, `commands`, `commandsFloor`, and `commandStats`. Add a field there when a new visible input joins the wire.
- **Stored-session detail reads.** `host/detail.ts` never observes a non-live Session's durable log for an ordinary detail read. It takes one `sessionQuery.observeSessionMetadata` stat (header plus the cached `contextTimeline` head and the two pressure keys) and serves the exact detail from the host's persisted projection checkpoint — the `contextTimeline` state row of the `session_projcache` domain, read through `ctx.storageDomain.get('session_projcache')` and accepted only after the same lifecycle gate and `stateVersion` check the projection cache itself applies. When the checkpoint is missing, pruned, version-mismatched, or the domain is unavailable, it folds a bounded tail window (`sessionQuery.readWindow`, 400 events) and marks the payload `partial: { fromSeq }`; the Context view labels the unloaded history and offers an explicit whole-log reload (`full: true`), the only remaining full read. The request's `AbortSignal` rides every read and is checked between fold chunks, the browser aborts the in-flight read when the view unmounts or the store is reset, and a host that predates `observeSessionMetadata`/`readWindow` (the `0.2.0` line) keeps the legacy whole-log fold.
- **Projection handle and summary-excluded pressure reads.** Registration is awaited and its ready handle retained: `host/projectionHandle.ts` reads the live `contextTimeline` state through `handle.stateOf(session)` and falls back to the registry-level `stateOf(session, key)` only on hosts that return a disposer instead of a handle (the `0.2.0`/`0.2.1` lines; that read is deprecated on `0.2.2` and never runs there). Hosts from `0.2.2` exclude `contextPressure` and `contextBreakdown` from every Session summary, so the agent graph's child headlines no longer receive them from catalog rows. The plugin's own on-demand `head: true` read now carries both: a live session reads the key subset through `sessionProjections.snapshot(session, ['contextPressure','contextBreakdown'])`, a stored session asks the same metadata stat for those keys (no log I/O), and the payload gains `pressure`/`breakdown`. `client/agentTree.ts` merges that head into the row values (row values win), so an unopened child keeps the projected-token occupancy anchor and the breakdown composition; a child whose head cannot be read still renders the ring the row's `contextTimeline` derives, and one with neither stays on the pressure-only ring. Do not fold child headlines from catalog-row pressure keys again.
- **Reference prices and context tiers.** Verified standard-speed API reference prices cover the five routes in [model pricing](docs/model-pricing.md), independently of models.dev availability. `shared/providers.ts` resolves the `codex`, `claude`, and `grok` route aliases to their model vendors; `shared/modelPricing.ts` owns the dated reference table, the per-model long-context thresholds, and `COST_PERIODS`; `client/cost.ts` checks a reference route before the models.dev book and prices a long-context request only on a tier that advertises one; `host/foldMetering.ts` books a request whose complete prompt crosses the threshold into the `long` cost bucket; the client sanitizers (`client/services.ts`), the overview roll-ups (`client/overview.ts`), and the Context card tooltip all carry that bucket, its tag, and the dated pricing disclosure. Token volume is never inferred from a price or subscription quota.

Two earlier fork behaviors are retired because upstream now owns them:

- **Lazy `/context` modal mounting.** The fork mounted the modal body (projection, detail, history, and conversation hooks) only while open. Upstream reads those hooks unconditionally before the closed early return to keep hook order stable; keep that shape.
- **`system/message` epoch pricing.** The fork tracked V3/V4 `system/message` nodes into a bounded list and stamped each following `request/header` epoch with the derived system-token figure. Upstream's header contract is explicit that a supported epoch header folds metadata-only and `systemTokens` is read only from cached v1 rows, so the second source would price one epoch twice. `contextHeaders` keeps exact upstream semantics.

The fork pins `zod` to the exact version the registry's typings were built against (`4.4.3` at the time of writing). Its `_zod.version` participates in type identity, so a newer minor makes `ctx.sessionProjections.register()` reject every unit at type-check time. The plugin's development dependencies stay on the lowest supported Harness floor (`0.2.0-rc.2`) as `tests/compat/manifest.spec.ts` requires; the runtime works on all three declared releases and degrades to the legacy detail fold where the newer read faces are absent.

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
corepack pnpm@11.9.0 exec vitest run tests/host/fold-performance.spec.ts tests/host/model-pricing.spec.ts tests/host/detail.spec.ts tests/client/timelineSource.spec.ts --coverage.enabled=false
corepack pnpm@11.9.0 run lint && corepack pnpm@11.9.0 run test && corepack pnpm@11.9.0 run build
corepack pnpm@11.9.0 pack --pack-destination ..\releases
```

`tests/host/fold-performance.spec.ts` pins the view-time clamp (a restored state trims into the view without being rewritten, and the normalization that follows does not inherit the clamped value's identity) and the per-generation wire reuse. `tests/host/detail.spec.ts` pins the stored-session detail rungs: a large non-live Session's detail comes from the persisted projection checkpoint with zero `observeSession`/`readWindow` calls, a missing checkpoint folds a bounded window and marks the cut, `head: true` reads no log, a cancelled request stops at the abort envelope, and only `full: true` folds the whole log. `tests/host/projectionHandle.spec.ts` pins the read ladder (the awaited handle first, the registry-level face only for a disposer registration) and the pressure key-subset read. `tests/shared/modelPricing.spec.ts` pins the reference routes, the long-context thresholds, and that a threshold-crossing request without a long tier stays unpriced. The compat matrix runs when `DSH_REPO` names a DeepSeek Harness checkout with the `dsh-v0.2.0-rc.2`, `dsh-v0.2.1-rc.2`, and `dsh-v0.2.2-rc.1` tags; per baseline it stages that tag's real sources (synthesizing the `FiberState` object the published cordis erases from its `const enum`), boots the BUILT plugin into the tag's registry, and probes the host and client seams. Store the packed artifact's uppercase SHA-256 beside it and inspect the tarball manifest and its embedded `package.json` version before installation.

## Updating upstream

Confirm the repository worktree contains no unrelated changes, then import a reviewed upstream tag through the existing subtree:

```powershell
git subtree pull --prefix=fork-plugins/dsh-context https://github.com/bowenliang123/dsh-context.git <tag> --squash
```

Reapply or retire each behavior in this document, preserve the file-level fork notices, advance the private version, run focused compatibility and behavior tests, build, pack, and record the new artifact hash. Never update a real profile with an unreviewed npm `@latest` package.

## Rollback

Rollback uses a retained, verified artifact and never edits Session data. A package whose projection `stateVersion` differs causes the registry to rebuild that plugin's derived checkpoint from the Session log; rollback validation must therefore cover V0, V2, V3, and V4 histories rather than restoring projection-cache files manually. A future change to projection keys, Session events, or wire compatibility requires its own migration and rollback decision before packaging.
