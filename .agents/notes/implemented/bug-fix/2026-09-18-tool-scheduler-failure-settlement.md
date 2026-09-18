# Agent Note: Tool scheduler failures retain provider-valid history

Status: implemented

English | [中文](2026-09-18-tool-scheduler-failure-settlement.zh.md)

## Problem

An assistant message can contain several tool calls. The loop records each started `tool/call` before ordered policy and dispatch, but an unexpected scheduler failure could end the step before the matching `tool/result` was durable. The failed turn then remained structurally readable while providers that require immediate tool results rejected every later request. A source launch that loaded the ToolRuntime provider from `lib/` and the AgentLoop consumer from `src/` exposed this path because their module-local scheduler symbols did not share identity.

Cancellation already closes undispatched calls, and crash recovery closes calls in an open tail turn. Neither mechanism covers a normally sealed error turn, so restarting cannot repair that history by appending after its completed boundary.

## Decision

The [source-launch decision](../architecture/2026-07-29-dsh-source-launch-tsx-esm.md) keeps configured workspace providers and consumers on the source plane. AgentLoop also treats scheduler failure as a terminal turn error whose tool group must settle first. It stops replenishment, waits for every in-flight dispatch, and appends one result for every assistant call in model order before rethrowing the original failure.

A call whose body may have entered dispatch receives `TOOL_OUTCOME_UNKNOWN` and the existing retry-safety text. A call rejected before dispatch, including a call after an exclusive barrier, receives `TOOL_NOT_STARTED`. These results state execution certainty rather than reclassifying the scheduler defect as an ordinary tool failure. The turn retains the original scheduler error after the balanced step closes.

DeepSeek Messages accepts sealed historical logs produced before this rule by projecting an empty `is_error` tool result for each missing id at the wire boundary. The projection precedes ordinary user content, system updates, another assistant turn, or request end as required by the protocol. It does not modify the Session log or invent result prose. Duplicate call ids, duplicate results, and results with no matching call remain invalid.

## Verification

The exact `node --import tsx/esm apps/cli/src/bin.ts` entry boots a temporary shipped headless profile and completes a real shell-tool round trip. Agent-loop tests force concurrent dispatch rejection, hold another body until drain, and verify ordered `TOOL_OUTCOME_UNKNOWN` and `TOOL_NOT_STARTED` results before the original turn error. DeepSeek Messages tests cover partial results, missing results before user text, missing results at request end, system-update placement, immutable durable input, duplicate ids, and unmatched results.

## Alternatives considered

**Keep scheduler failures terminal without results.** This preserves uncertainty but leaves a provider-invalid transcript. Explicit unknown/not-started results preserve the same uncertainty while keeping the Session usable.

**Report every failure as not started.** A rejected dispatch may have invoked a side-effecting body. Claiming it did not run would encourage an unsafe retry; `TOOL_OUTCOME_UNKNOWN` keeps that ambiguity visible.

**Rewrite affected Session files.** Released generations are immutable, and an in-place edit would erase incident evidence. A deterministic provider projection restores compatibility without changing stored history or the Session format.

**Accept any malformed tool history.** Synthesizing only absent results is unambiguous. Unknown or duplicate real results still indicate conflicting identities and remain hard failures.

## Consequences

- A scheduler defect still fails the turn, but it cannot poison subsequent provider requests.
- In-flight calls reach quiescence before recovery results are committed; an unknown result never claims that side effects did or did not occur.
- DeepSeek Messages can resume a sealed historical turn with missing results, while the durable log remains exact incident evidence.
- Historical recovery adds one empty error block per missing result to the provider request and no text tokens beyond the protocol representation.
- The parallel scheduler retains its ordering, capacity, cancellation, and reclassification rules; this decision supersedes only its former failure-settlement policy.

This decision partially supersedes the scheduler-failure sections of [Parallel tool call execution](../feature/2026-07-10-parallel-tool-call-execution.md).
