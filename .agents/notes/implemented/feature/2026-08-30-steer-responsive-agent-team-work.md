# Agent Note: Steer-responsive Agent Team work

Status: implemented

English | [中文](2026-08-30-steer-responsive-agent-team-work.zh.md)

## Problem

Continuable children accept FIFO follow-ups and next-step steering, but Agent Teams sent every parent-to-child message through the durable peer mailbox's requested quiet or wakeup mode. A Lead directive could therefore wait behind ordinary child turns instead of reaching the nearest model boundary.

Background commands did not by themselves make a teammate responsive. A model could keep its current step open with `job_output(wait: true)` until the job settled or the configured timeout elapsed, so next-step input remained pending even though the command already had an independent job owner.

Arbitrary tool calls cannot be abandoned safely. A tool may own external side effects or an unsettled result with no background owner, and starting another model request before the tool result exists would leave an unmatched tool call in session history.

## Decision

Alpha.2 exposes `SubagentRuntime.sendMessage(sender, target, content, options)` as the public adjacent-Agent operation. It owns live-lineage authorization, per-child serialization, cold resume, Activation ownership, and inbox-acceptance cancellation, and steers a running child at its nearest step boundary. The fork does not restore its former public `steer()` or `followup()` methods; Team delivery uses the official symbol-keyed Host queue and Steer adapters so the Team message source reaches the same continuation machinery.

Agent Teams routes a Lead directive to a live teammate through Host Steer and wakes an inactive teammate through Host Queue. Both adapters keep the durable Team message source rather than impersonating an Agent sender. Teammate-originated peer messages retain the durable quiet and next-turn modes from the [Agent Teams decision](2026-08-05-agent-teams.md); a later wakeup admits earlier quiet mail before itself. The Team service derives this policy from exact membership and sender identity; prompts and tool arguments do not enforce it.

The vendored `@nanmicoder/dsh-agent-teams` build owns a `harness-compat` adapter that recognizes lifecycle setup, FIFO Queue, unified Queue/Steer, and public adjacent-Agent messaging operations from the exact Harness contracts covered by its tests. Its distributed compatibility policy accepts only `dsh-v0.1.6-alpha.2`; legacy adapters remain regression fixtures rather than a package compatibility claim. The retired-member guard wraps every operation present on the running host and restores native property descriptors when its Cordis scope ends.

The global model-facing `send_message` control uses alpha.2's public `sendMessage()`, so ordinary coordinator-to-child instructions use the same nearest-step behavior outside Agent Teams. Host-user and browser prompt routes retain FIFO delivery; the Host-only Team adapters do not reclassify human input.

Alpha.2 routes Queue Dock edit, remove, and Steer actions through the Session-addressed `session.updateQueue` Remote. It mutates one pending occurrence, preserves identity and source for edits, records removal durably, and reports stale or unavailable Steer with Session-domain failures. Continuable children use the same operation as ordinary Sessions; the fork carries no separate subagent Queue Remote or error vocabulary.

External AgentTeams v0.1.19 owns member next-step delivery through the Host Queue/Steer adapter. The official experimental Team profile and the generic shell and job tools stay identical to upstream DSH 0.1.6; the former forced-background and yielding-wait fork is superseded by [retiring unused official Team scheduling patches](../simplification/2026-09-15-retire-unused-official-team-scheduling-fork.md).

## Alternatives considered

**Cancel every running child turn.** Rejected because steering already provides the requested safe-boundary insertion, while cancellation can abandon claimed work and partially completed external side effects.

**Make every tool Promise race steering.** Rejected because only a passive wait over independently owned work can be released without orphaning the underlying operation. Tool producers must opt into any future generalized yielding operation.


## Testing

Subagent and Session Controller tests distinguish next-step steering from FIFO follow-up and cover Queue editing, removal, stale-occurrence convergence, authorization, cold resume, disposal, and one-shot behavior. The vendored plugin tests exercise awaited lifecycle setup, live Steer and inactive Queue routing, retired-member rejection, cold Captain mailbox redelivery, and dependency-cohort inspection. Team mailbox tests cover target-local serialization, persistence recovery, interruption, and pending limits.

## Consequences

A Lead directive still waits for the child's current model request or tool call to finish; steering does not cancel a step.

Several Lead directives accepted during one step remain ordered next-step messages and enter the next request together. This design removes later-turn head-of-line blocking without silently replacing durable directives.

DSH owns the global `send_message` tool and `session.updateQueue`; this fork adds no competing generic messaging API or unused official Team scheduling options.
