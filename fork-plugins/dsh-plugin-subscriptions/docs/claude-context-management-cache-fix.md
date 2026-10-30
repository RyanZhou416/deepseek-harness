# Claude context management and cache

Status: decided, applied to the source tree, and full-plugin-test verified. The Claude route
sends no server-side context edit and performs no provider-local pruning. Keeping the
conversation under the model window is DSH's compaction task. `pnpm test` runs the test
compile (`tsc -p tsconfig.test.json`) and the full 142-file plugin suite; it ran 1919 tests
with 0 failures and 0 skips. That is a test build, not the package `lib` build: the live
profile links the staged `.build/fork-plugins/subscriptions` build, so the running Host still
executes the previous build until the Host is stopped, `build.cmd` is run, and the Host is
restarted. No provider request or Host restart was performed.

## Evidence

Claude-only window `2026-10-30T03:57:52Z` to `2026-10-30T16:52:56Z`, 646 assistant messages
in sessions `e86f68e4-8cf8-4261-bdc8-9a384ca0cafa` and
`15064207-9b52-40d1-b06a-df4b2dfc343a`:

- 96 cold requests: 92 in `e86f68e4`, 4 in `15064207`. A cold request reads at most
  `26,677` tokens, the fixed tools and system prefix.
- 86 of the 96 colds carried an applied `clear_tool_uses_20250919`; 129 requests carried a
  server-reported clear while every inter-request gap was under 12 minutes. The
  per-session latch is visible on the wire.
- 84 same-shape pairs: an increased `cleared_tool_uses` is followed by a cold read in 84 of
  84; a warm request with an applied edit showed no increase.
- `15064207` applied no context edits; its 4 colds are TTL.
- One `07:52:14` cold is a pure append with five matched warm controls: no edit, no
  compaction, no retry, no account or wire change. It is not attributable to context
  editing.

Public context editing is not cache-neutral: clearing invalidates from the first cleared
result and bills a cache write. The client's internal `cache_edits`/`cache_reference` path
is a first-party beta, absent from the anchored 2.1.288 carve, and is not used here.

## Decision

The Claude route applies no server-side context editing:

- The request body states no `context_management` field, including no
  `clear_tool_uses_20250919` and no `clear_thinking_20251015`, from any condition.
- The adapter keeps no idle clock, no `clearedForIdle` latch and no
  `STALE_TOOL_RESULT_IDLE_MS` threshold.
- No assertion couples the field to the `context-management-2025-06-27` beta. The pinned
  builder still composes that beta from the model's capability, and the mid-conversation
  system beta behavior is unchanged.
- No provider-local pruning, placeholder replacement, marker batch or request log replaces
  the removed edits. The history reaches the wire as the loop supplied it.

Keeping the conversation under the model window belongs to DSH's compaction path, which
owns the durable session and its summary. This route removes no messages and rewrites no
history, so the model-visible request remains the session's own history.

## Rejected: provider-local pruning

A provider-local batch prune was designed and rejected:

- It pays the same cache write as the server edit: the first pruned request invalidates from
  the first cleared result, and only later requests reuse the new prefix.
- It needs its own state, its own durability and a version-named `llm/request-record`
  successor for the model-visible-equals-logged rule. A restart or an evicted entry loses
  the cleared-id set, and the next request writes a full batch.
- It duplicates a decision DSH compaction already owns. A low local watermark can race the
  compaction pruner and produce two writes where one was intended.
- The request history carries no transcript timestamps, so any local idle estimate measures
  prior requests, not the conversation.

## Response side

The translator still records an applied edit verbatim on the response envelope when a server
reports one. That is a statement about the request that was sent, not a policy this route
composes; with no edit requested, it normally records nothing.
`test/context-management.spec.ts` owns that case.

## Rejected alternatives

- Restoring the genuine client's default-off `tengu_zany_pike` gate: the clear still fires
  wherever the gate is enabled, and it still invalidates the cache there.
- `exclude_tools`: the harness registers no tool whose results must survive clearing, so an
  empty or invented list changes nothing the API does.
- `cache_edits`/`cache_reference`: a first-party beta, not a public parameter, and absent
  from the anchored carve.
- A config toggle for the latch: it would leave the cache loss reachable and state a
  deployment-varying tunable this route does not need.

## Consequences and limits

- A session that outgrows the model window is compacted by DSH, not by this route.
- Request bytes for a given history no longer vary with prior request timing, which removes
  the latch's cache invalidation.
- The route adds no context-edit fallback for an oversize prompt. A request the provider
  rejects follows the existing error path, and DSH compaction is the only context
  reduction.
- Rollback restores the removed planner and latch, which reintroduces the reported bug.

## Source changes

- `src/providers/context-management.ts` deleted: the planner and its thresholds.
- `src/providers/claude.ts`: the planner call, `requestClock`, `idleBeforeRequest`,
  `clearedForIdle`, `STALE_TOOL_RESULT_IDLE_MS` and `REQUEST_CLOCK_LIMIT` removed.
- `src/providers/claude-wire.ts`: the `contextManagement` parameter and its body emission,
  `assertContextManagementBeta`, and the `supportsContextManagement` import removed.
- `test/claude-wire.spec.ts`: no model states the field, including a thinking request and a
  history of 30 clearable tool results — the conditions the planner reacted to.
- `test/context-management.spec.ts`: the planner cases removed with the planner; the two
  response-envelope cases stay, because a server-reported edit is still recorded.
- `src/claude-engine/request.ts` keeps its `context_management` refusal: that engine validates
  a caller's Messages body and reports fields it does not model, so the entry states a live
  boundary rather than a request policy. `test/claude-engine-request.spec.ts` pins it.
