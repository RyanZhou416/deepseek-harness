# Agent Note: Steer-responsive Agent Team work

Status: implemented

English | [中文](2026-08-30-steer-responsive-agent-team-work.zh.md)

## Problem

Continuable children accept FIFO follow-ups and next-step steering, but Agent Teams sent every parent-to-child message through the durable peer mailbox's requested quiet or wakeup mode. A Lead directive could therefore wait behind ordinary child turns instead of reaching the nearest model boundary.

Background commands did not by themselves make a teammate responsive. A model could keep its current step open with `job_output(wait: true)` until the job settled or the configured timeout elapsed, so next-step input remained pending even though the command already had an independent job owner.

Arbitrary tool calls cannot be abandoned safely. A tool may own external side effects or an unsettled result with no background owner, and starting another model request before the tool result exists would leave an unmatched tool call in session history.

## Decision

Alpha.2 exposes `SubagentRuntime.sendMessage(sender, target, content, options)` as the public adjacent-Agent operation. It owns live-lineage authorization, per-child serialization, cold resume, Activation ownership, and inbox-acceptance cancellation, and steers a running child at its nearest step boundary. The fork does not restore its former public `steer()` or `followup()` methods; Team delivery uses the official symbol-keyed Host queue and Steer adapters so protocol provenance reaches the same continuation machinery.

Agent Teams routes a Lead directive to a live teammate through Host Steer and wakes an inactive teammate through Host Queue. Both adapters keep the durable Team message source rather than impersonating an Agent sender. Teammate-originated peer messages retain the durable quiet and next-turn modes from the [Agent Teams decision](2026-08-05-agent-teams.md); a later wakeup admits earlier quiet mail before itself. The Team service derives this policy from exact membership and sender identity; prompts and tool arguments do not enforce it.

The vendored `@nanmicoder/dsh-agent-teams` build owns a `harness-compat` adapter that recognizes lifecycle setup, FIFO Queue, unified Queue/Steer, and public adjacent-Agent messaging operations from the exact Harness contracts covered by its tests. Its distributed compatibility policy accepts only `dsh-v0.1.3-alpha.2`; legacy adapters remain regression fixtures rather than a package compatibility claim. The retired-member guard wraps every operation present on the running host and restores native property descriptors when its Cordis scope ends.

The global model-facing `send_message` control uses alpha.2's public `sendMessage()`, so ordinary coordinator-to-child instructions use the same nearest-step behavior outside Agent Teams. Host-user and browser prompt routes retain FIFO delivery; the Host-only Team adapters do not reclassify human input.

Alpha.2 routes Queue Dock edit, remove, and Steer actions through the Session-addressed `session.updateQueue` Remote. It mutates one pending occurrence, preserves identity and source for edits, records removal durably, and reports stale or unavailable Steer with Session-domain failures. Continuable children use the same operation as ordinary Sessions; the fork carries no separate subagent Queue Remote or error vocabulary.

The Bash and PowerShell tool consumers accept `forceRunInBackground`, default `false`. An enabled consumer hides `run_in_background`, waits for `ctx.jobs` before registering, and starts every command as an owner-scoped job before returning its id. The process remains under the job runtime until completion, cancellation, owner disposal, or service disposal.

`dsh-tool-jobs` accepts `yieldWaitOnNextStep`, default `false`. When enabled, a blocking `job_output` call observes its owner's durable next-step inbox. Existing or newly inserted next-step input aborts only the registry wait, after which `job_output` reads and returns the current output and job status. The job remains live, and ordinary next-turn FIFO input does not end the wait.

The private Agent Teams profile enables forced Bash and PowerShell jobs plus steer-responsive job waits. Other profiles retain their existing schemas and waiting behavior unless they opt in.

## Alternatives considered

**Cancel every running child turn.** Rejected because steering already provides the requested safe-boundary insertion, while cancellation can abandon claimed work and partially completed external side effects.

**Make every tool Promise race steering.** Rejected because only a passive wait over independently owned work can be released without orphaning the underlying operation. Tool producers must opt into any future generalized yielding operation.

**Rely on instructions to select background mode or non-blocking reads.** Rejected because model compliance cannot guarantee responsiveness. The profile and service own the scheduling decisions.

**Enable the new behavior in every profile.** Rejected because forced-background schemas and early wait returns are observable compatibility changes. The generic options retain false defaults, and the experimental Team profile owns the opt-in.

## Testing

Subagent and Session Controller tests distinguish next-step steering from FIFO follow-up and cover Queue editing, removal, stale-occurrence convergence, authorization, cold resume, disposal, and one-shot behavior. The vendored plugin tests exercise lifecycle setup across its adapter variants, exact Alpha.2 live-Steer and inactive-Queue routing, retired-member rejection on Host and public paths, cold Captain mailbox redelivery, and dependency-cohort inspection. Team mailbox tests cover live Lead steering, inactive-child wakeup, teammate quiet/FIFO delivery, target-local serialization, persistence recovery, interruption, and pending limits. Job tests prove next-step yielding leaves the job running, next-turn messages do not yield, and the default remains unchanged. Bash, PowerShell, and profile tests prove forced jobs remove the model argument, return real job ids, present background results, and wait safely for the jobs capability during concurrent loader activation.

## Consequences

A Lead directive still waits for the child's current model request or tool call to finish; steering does not cancel a step. Forced background execution prevents shell work from owning that step, while steer-responsive `job_output` prevents a later passive job wait from extending it after next-step input arrives.

Several Lead directives accepted during one step remain ordered next-step messages and enter the next request together. This design removes later-turn head-of-line blocking without silently replacing durable directives.

The generic background and wait options add no behavior or schema change at their false defaults. Alpha.2 owns the global `send_message` tool and `session.updateQueue`; this fork adds no competing generic messaging API. The private Team profile changes shell calls to return job ids and lets `job_output(wait: true)` return `[status: running]` before its timeout when next-step input is pending.
