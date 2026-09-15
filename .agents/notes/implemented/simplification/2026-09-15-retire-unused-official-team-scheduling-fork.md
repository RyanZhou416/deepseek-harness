# Agent Note: Retire unused official Team scheduling fork

Status: implemented

English | [中文](2026-09-15-retire-unused-official-team-scheduling-fork.zh.md)

## Problem

The fork added `forceRunInBackground` to Bash and PowerShell, `yieldWaitOnNextStep` to `tool-jobs`, and custom mailbox delivery to DSH experimental Agent Teams. Their only production Consumer was the experimental Team profile, while the deployed Web profile uses external `@nanmicoder/dsh-agent-teams`. Carrying public configuration, tests, documentation, and generated catalogs for an unmounted profile increased every upstream merge without changing the deployed product.

## Decision

DSH experimental Agent Teams, its profile, Bash, PowerShell, and `tool-jobs` retain the exact `dsh-v0.1.6-alpha.1` implementations. The fork does not expose `forceRunInBackground` or `yieldWaitOnNextStep` and does not modify the official Team mailbox.

External AgentTeams v0.1.18 owns member next-step delivery, inactive Queue delivery, retirement cleanup, and task-attempt scheduling. The private plugin layer retains only DSH 0.1.6 awaited-creation compatibility, cold Captain mailbox recovery, bounded unread-mailbox projection, and the Windows directory-rename budget. Generic background-job completion wakeups and Windows subprocess console isolation remain independent fork behavior because the deployed profile consumes them.

## Alternatives considered

**Keep the options disabled by default.** Rejected because a false default does not remove their public API, generated catalog, tests, or merge conflicts, and no deployed composition can exercise them.

**Enable the official Team profile beside the external plugin.** Rejected because the implementations use different tools, state directories, UI, and lifecycle policy; mounting both would duplicate coordination rather than replace the external plugin.

**Remove all Team-related fork behavior.** Rejected because cold Captain recovery and bounded unread mailbox reads remain production Consumers in the external plugin and are not provided by v0.1.18.

## Consequences

The official experimental Team profile behaves exactly like upstream DSH and no longer forces shell calls into jobs or ends a blocking job read on next-step input. The deployed external AgentTeams behavior is unchanged where it matters: member coordination remains next-step responsive, durable Captain mail can cold-resume, and mailbox polling remains bounded. Future DSH merges no longer touch the official Team, Bash, PowerShell, or job-wait surfaces for this abandoned profile.
