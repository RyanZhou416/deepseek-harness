# Agent Note: Steer-responsive Agent Team work

Status: implemented

English | [中文](2026-08-30-steer-responsive-agent-team-work.zh.md)

## Problem

Continuable children accept FIFO follow-ups and next-step steering, but Agent Teams sent every parent-to-child message through the durable peer mailbox's requested quiet or wakeup mode. A Lead directive could therefore wait behind ordinary child turns instead of reaching the nearest model boundary.

Background commands did not by themselves make a teammate responsive. A model could keep its current step open with `job_output(wait: true)` until the job settled or the configured timeout elapsed, so next-step input remained pending even though the command already had an independent job owner.

Arbitrary tool calls cannot be abandoned safely. A tool may own external side effects or an unsettled result with no background owner, and starting another model request before the tool result exists would leave an unmatched tool call in session history.

## Decision

RC.1 exposes `SubagentRuntime.sendMessage(sender, target, content, options)` as the public adjacent-Agent operation. It owns live-lineage authorization, per-child serialization, cold resume, Activation ownership, and inbox-acceptance cancellation, and steers a running child at its nearest step boundary. The fork does not restore its former public `steer()` or `followup()` methods; it adds a symbol-keyed Host-only adapter that preserves protocol provenance while using the same continuation delivery machinery.

Agent Teams routes every Lead-to-teammate mailbox delivery through the Host-only Subagent steering adapter regardless of the model-requested quiet or wakeup mode. The adapter keeps the durable Team message source rather than impersonating an Agent sender. Teammate-originated peer messages retain the durable quiet and next-turn modes from the [Agent Teams decision](2026-08-05-agent-teams.md). The Team service derives this policy from exact membership and sender identity; prompts and tool arguments do not enforce it.

The global model-facing `send_message` control uses RC.1's public `sendMessage()`, so ordinary coordinator-to-child instructions use the same nearest-step behavior outside Agent Teams. Host-user and browser prompt routes retain FIFO delivery; the Host-only Team adapter does not reclassify human input.

The browser Queue Dock exposes edit, remove, and steering actions for queued messages in a live continuable-child conversation. The Client routes them through a dedicated `subagents/updateQueuedByParent` Remote, which authorizes the durable direct-parent address and mutates only the selected pending next-turn occurrence. Editing preserves identity and source, removal durably cancels the occurrence, and steering additionally requires a running child before moving it to next-step input. The Remote reports stale occurrences as `subagent/queue-item-not-found`, unavailable edit or removal as `subagent/delivery-unavailable`, and unavailable steering as `subagent/steer-unavailable`.

The Bash and PowerShell tool consumers accept `forceRunInBackground`, default `false`. An enabled consumer hides `run_in_background`, waits for `ctx.jobs` before registering, and starts every command as an owner-scoped job before returning its id. The process remains under the job runtime until completion, cancellation, owner disposal, or service disposal.

`dsh-tool-jobs` accepts `yieldWaitOnNextStep`, default `false`. When enabled, a blocking `job_output` call observes its owner's durable next-step inbox. Existing or newly inserted next-step input aborts only the registry wait, after which `job_output` reads and returns the current output and job status. The job remains live, and ordinary next-turn FIFO input does not end the wait.

The private Agent Teams profile enables forced Bash and PowerShell jobs plus steer-responsive job waits. Other profiles retain their existing schemas and waiting behavior unless they opt in.

## Alternatives considered

**Cancel every running child turn.** Rejected because steering already provides the requested safe-boundary insertion, while cancellation can abandon claimed work and partially completed external side effects.

**Make every tool Promise race steering.** Rejected because only a passive wait over independently owned work can be released without orphaning the underlying operation. Tool producers must opt into any future generalized yielding operation.

**Rely on instructions to select background mode or non-blocking reads.** Rejected because model compliance cannot guarantee responsiveness. The profile and service own the scheduling decisions.

**Enable the new behavior in every profile.** Rejected because forced-background schemas and early wait returns are observable compatibility changes. The generic options retain false defaults, and the experimental Team profile owns the opt-in.

## Testing

Subagent tests distinguish next-step steering from FIFO follow-up for a running Activation and retain the existing authorization, cold-resume, disposal, and one-shot behaviors. Queue Dock and Client tests cover continuable-child editing, removal, steering, one-shot read-only state, durable address routing, and stale-occurrence convergence. Team mailbox tests cover Lead steering, teammate quiet/FIFO delivery, target-local serialization, persistence recovery, interruption, and pending limits. Job tests prove next-step yielding leaves the job running, next-turn messages do not yield, and the default remains unchanged. Bash, PowerShell, and profile tests prove forced jobs remove the model argument, return real job ids, present background results, and wait safely for the jobs capability during concurrent loader activation.

## Consequences

A Lead directive still waits for the child's current model request or tool call to finish; steering does not cancel a step. Forced background execution prevents shell work from owning that step, while steer-responsive `job_output` prevents a later passive job wait from extending it after next-step input arrives.

Several Lead directives accepted during one step remain ordered next-step messages and enter the next request together. This design removes later-turn head-of-line blocking without silently replacing durable directives.

The generic background and wait options add no behavior or schema change at their false defaults. RC.1 owns the global `send_message` tool's nearest-step behavior; this fork adds no competing generic messaging API. The private Team profile changes shell calls to return job ids and lets `job_output(wait: true)` return `[status: running]` before its timeout when next-step input is pending.
