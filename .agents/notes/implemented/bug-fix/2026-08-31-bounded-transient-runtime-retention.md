# Agent Note: Bounded transient runtime retention

Status: implemented

English | [中文](2026-08-31-bounded-transient-runtime-retention.zh.md)

## Problem

Each Client Session that had ever been selected kept a history follow open after navigation moved elsewhere. Every Host follow retained the corresponding Session and prevented idle Agent eviction, so one browser tab accumulated Host residency across unrelated conversations. The process-local job registry also retained every terminal record, its output, producer closures, and owner until owner teardown.

These transient owners made the live heap grow with navigation history and completed background work even though durable Session history already existed on disk.

## Decision

Only the staged Client Session keeps its history follow open. Selecting another Session or explicitly clearing the selection synchronously detaches the previous stream while preserving its Session scope, binding, current window, projections, queue, and feature state. Reselecting it opens a fresh stream from durable history. A masked list gap retains the stage because it is transport state rather than user navigation.

`dsh-jobs-local` accepts optional `terminalJobRetentionMs` and `maxRetainedTerminalJobsPerOwner` policies. TTL expiry removes any terminal record; count pruning removes the oldest reported terminal records within each exact-owner bucket and the shared unowned bucket. Running and stopping jobs are never retention candidates. The base composition enables a one-hour TTL and a target of 100 terminal records per owner.

Continuable subagents keep their existing lifecycle: the continuation manager disposes a settled Activation immediately and cold-resumes it on later delivery. No external idle timer or Agent concurrency limit is added.

## Alternatives considered

**Limit Agent concurrency.** Rejected because it changes scheduling capacity and does not address retention caused by completed records or browser navigation.

**Drop the entire off-stage Client Session scope.** Rejected because scope disposal would also discard drafts, feature-local state, and stable bindings. Suspending only the history transport releases the Host follower without changing those owners.

**Prune every terminal job immediately at the count target.** Rejected because a newly completed but unreported result could disappear before its owner collects it. Count pruning therefore selects reported records; TTL is the explicit deadline for unreported results.

**Rely on watchdog restarts.** Rejected as the steady-state mechanism because restart releases the whole heap only after interrupting service. The watchdog may stop an unsafe backend, but no supervisor restarts it automatically.

## Consequences

Session persistence, event vocabulary, AgentTeams state, and concurrency semantics are unchanged. Off-stage detailed history stops updating until reselection, while the separate control stream continues projecting running state, queues, jobs, and completion markers. A retained terminal job id becomes unknown after its configured TTL or reported-record count eviction; durable job-result lookup requires a persistent backend.

Focused Session Controller tests cover stage switching, explicit clear, masked gaps, in-flight opens, binding retention, and teardown quiescence. Jobs-local tests cover legacy omission, exact-owner count pruning, unreported-result protection, all terminal statuses, active-job preservation, timer disposal, and real Loader configuration.
