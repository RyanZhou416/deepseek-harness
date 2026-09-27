# dsh-context fork maintenance

This subtree carries the DeepSeek Harness fork build of `dsh-context`. It retains the upstream Apache-2.0 `LICENSE` and keeps every fork-modified source and test file marked with a `DeepSeek Harness fork modification` notice.

## Provenance

- Upstream repository: `https://github.com/bowenliang123/dsh-context.git`
- Upstream tag: `v0.55.0`
- Fork package version: `0.55.0-dsh017rc1.3`
- Subtree path: `fork-plugins/dsh-context`
- Distribution artifact: `fork-plugins/releases/dsh-context-0.55.0-dsh017rc1.3.tgz`

## Fork behavior

The fork preserves the package name, Cordis ids, `contextTimeline`, `contextHeaders`, and `contextActivity` projection keys. It adopts the upstream V0/V2/V3/V4 Session-log fold, File Activity ledger, right-Sidebar views, Context Insights dashboard, DeepSeek balance capsule, last-user-message cards, and split `contextTimeline` delivery: a slim head rides projection traffic while an open Context view fetches heavy detail on demand. The authenticated on-demand backfill route arms at most one corpus pass per Host when Context Insights opens, rather than scanning every Session during startup.

The timeline projection uses fork `stateVersion: 21` to retain per-request long-context cost buckets; header and activity projections keep version `1`. A version mismatch discards the older derived checkpoint and refolds it from the immutable Session log; the plugin does not transform Session artifacts. The wire schema accepts both the inline fallback value and the slim-head generation with on-demand detail.

The timeline fold keeps the fork's `TimelineDraft` field-level copy-on-write state and dirty-field retention trim. An event clones only the arrays or records it mutates; a normalized state checks retention only for changed collections. The upstream `turnRuns` ledger makes turn-count checks incremental, and raw tool arguments are retained only for file operations and Code Mode. Restored checkpoints missing `turnRuns` recompute it on the first changed event. Restored state is clamped through the same whole-turn, hard-step, event-tail, archive-floor, and file-operation-floor rules before the first wire or detail value is built; this view-time clamp does not modify the checkpoint.

Each projection definition retains independent weak reference caches for the inline and slim wire generations. Host-only changes such as a pending tool-call name, open step timing slot, or buffered Code-Mode operation reuse the prior raw wire value, so the projection registry's `Object.is` check suppresses schema validation and `session/projection` publication. Any visible input change receives a fresh identity.

The `/context` overlay keeps only its modal-store gate mounted while closed. Projection, detail, history, and conversation hooks, the browser tree, keyboard handling, and layout observation mount with the open body and dispose when it closes. This remains fork-only in v0.55.0.

The `contextHeaders` projection tracks V3/V4 `system/message` nodes until the following `request/header`, preserving per-epoch system-token pricing after the prompt left the request envelope. The optional system-node state remains compatible with existing version-1 header checkpoints.

The low-overhead deployment bounds are `maxRequestSteps: 300`, `maxKeptTurns: 60`, `maxEvents: 100`, `maxNodes: 400`, `maxArchiveNodes: 100`, and `maxFileOps: 100`. Bounds remain ordinary Cordis plugin configuration and do not change stored or wire fields.

Verified standard-speed API reference prices cover the five routes in [model pricing](docs/model-pricing.md), independently of models.dev availability. Codex and Claude provider aliases resolve to their model vendors; Cursor's Grok 4.7 uses xAI prices. Preserve request-level long-context classification, the extra cost bucket in copies, sanitizers and family totals, and the dated pricing disclosure. Token volume is never inferred from a price or subscription quota.

## Verification and packaging

### Tool attribution lifetime

`src/host/attribution.ts` unwraps `cordis.original` before identifying or patching a tool service and keeps only the reader's plugin name. Cordis creates a fresh caller-bound proxy on service reads; retaining a restore closure for each proxy retains its Agent context and Session after disposal. The wrapper still invokes the original method with the call-site receiver, preserving effect ownership. Plugin unload restores the original method without removing a newer attribution wrapper.

Preserve raw-service identity deduplication and the scalar reader label across upstream imports. The focused `tests/host/attribution.spec.ts` regression performs 300 traced reads through three caller fibers, checks wrapper identity, attributed names, caller-owned cleanup, and hook unload. It fails on the unpatched implementation. An isolated Node GC experiment over 100 disposed scopes with 50 reads each retained all 100 scopes and 28.42 MiB before the fix, versus zero scopes and 0.65 MiB afterwards. The tested attribution source has 100% statement, branch, function, and line coverage. The `0.55.0-dsh017rc1.3` artifact contains this repair and is installed in the Windows Web profile. Its Host bundle hash matches the tested local build; the profile patch and other direct dependencies are unchanged.

The 2026-09-27 Host snapshot contained 257 disposed and 12 live Agents. An offline reference-graph experiment, including conditional WeakMap reachability, disconnected 248 disposed Agent/Session pairs and 10,265.24 MiB after removing the attribution restore-array and reader-context references. This accounts for about 86% of reachable shallow object bytes; it estimates ownership in that snapshot, not post-fix production RSS. Raw snapshots and their numeric indexes remain private diagnostics outside Git.

The following diagnostic run lasted approximately 3 hours 40 minutes: sampled JS heap peaked at 2.50 GiB and ended at 1.49 GiB, while the disposed-Agent count peaked at 15 and ended at 4. The growth snapshot contained one attribution restore entry, compared with 82,602 in the earlier incident. This is observed workload evidence, not a fixed-input benchmark or a guarantee that every retention issue is resolved. The fork-wide [memory record](../../FORK_MAINTENANCE.md#memory-ownership-verification) owns the diagnostic policy and explicitly deferred findings.

### Commands

Run commands from this directory.

```powershell
corepack pnpm@11.9.0 install --frozen-lockfile --ignore-scripts
corepack pnpm@11.9.0 typecheck
corepack pnpm@11.9.0 exec vitest run tests/host/fold-events.spec.ts tests/host/fold-ops.spec.ts tests/host/fold-retention.spec.ts tests/host/fold-split.spec.ts tests/host/fold-surface.spec.ts tests/host/fold-timing.spec.ts tests/host/fold-v3.spec.ts tests/host/fold-view.spec.ts tests/host/fold-performance.spec.ts tests/host/timeline.spec.ts tests/host/detail.spec.ts tests/client/components/contextModal.spec.ts tests/client/timelineSource.spec.ts --coverage.enabled=false
$env:DSH_REPO = (Resolve-Path ..\..).Path
corepack pnpm@11.9.0 run lint:fix && corepack pnpm@11.9.0 run test && corepack pnpm@11.9.0 run build
corepack pnpm@11.9.0 pack --pack-destination ..\releases
```

Store the artifact's uppercase SHA-256 beside it as `dsh-context-0.55.0-dsh017rc1.3.tgz.sha256`. Inspect the tarball manifest and its embedded `package.json` version before installation.

## Updating upstream

Confirm the repository worktree contains no unrelated changes, then import a reviewed upstream tag through the existing subtree:

```powershell
git subtree pull --prefix=fork-plugins/dsh-context https://github.com/bowenliang123/dsh-context.git <tag> --squash
```

Reapply or retire each behavior in this document, preserve the file-level fork notices, advance the private version, run focused compatibility and behavior tests, build, pack, and record the new artifact hash. Never update a real profile with an unreviewed npm `@latest` package.

## Rollback

Rollback uses a retained, verified artifact and never edits Session data. A package whose projection `stateVersion` differs causes the registry to rebuild that plugin's derived checkpoint from the Session log; rollback validation must therefore cover V0, V2, V3, and V4 histories rather than restoring projection-cache files manually. A future change to projection keys, Session events, or wire compatibility requires its own migration and rollback decision before packaging.
