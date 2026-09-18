# Agent Note: Bounded transient runtime retention

Status: implemented

English | [中文](2026-08-31-bounded-transient-runtime-retention.zh.md)

## Problem

Each Client Session that had ever been selected kept a history follow open after navigation moved elsewhere. Every Host follow retained the corresponding Session and prevented idle Agent eviction, so one browser tab accumulated Host residency across unrelated conversations. The process-local job registry also retained every terminal record, its output, producer closures, and owner until owner teardown.

These transient owners made the live heap grow with navigation history and completed background work even though durable Session history already existed on disk.

## Decision

Client Session generations exist only while source-labelled references retain them. The workspace's `mainView` reference owns the selected Session; releasing the final reference synchronously withdraws its binding and Agent-scoped Context before asynchronous Session and history-stream disposal. Catalog metadata and per-Session projection values remain manager-owned across instance replacement. Reselecting materializes a fresh generation and opens it from durable history, while late cleanup from the previous generation cannot withdraw or mutate the replacement.

`dsh-jobs-local` accepts optional `terminalJobRetentionMs` and `maxRetainedTerminalJobsPerOwner` policies. TTL expiry removes any terminal record; count pruning removes the oldest reported terminal records within each exact-owner bucket and the shared unowned bucket. Running and stopping jobs are never retention candidates. The base composition enables a one-hour TTL and a target of 100 terminal records per owner.

Continuable subagents keep their existing lifecycle: the continuation manager disposes a settled Activation immediately and cold-resumes it on later delivery. Owned-child disposal and Job state changes re-evaluate a blocked parent retention timer. Once Agent eviction starts, a concurrent resolver waits for its teardown to settle before it may return a live Agent or cold-resume the Session; no caller can accept work on the disposing instance. This retention mechanism adds no external idle timer or second capacity policy; the official `maxActiveSubagents` limit applies independently.

## Alternatives considered

**Use the Agent activation limit as the retention fix.** Rejected because activation capacity does not remove completed records or browser references. Alpha.2's official `maxActiveSubagents` setting remains an independent scheduling policy.

**Keep each off-stage scoped Session and suspend only its history transport.** Rejected because Alpha.2 gives every consumer an explicit reference owner and keeps durable projection values outside the instance. Retaining an unreferenced scope would preserve browser and Host residency without a live consumer.

**Prune every terminal job immediately at the count target.** Rejected because a newly completed but unreported result could disappear before its owner collects it. Count pruning therefore selects reported records; TTL is the explicit deadline for unreported results.

**Rely on watchdog restarts.** Rejected as the steady-state mechanism because restart releases the whole heap only after interrupting service. The watchdog may stop an unsafe backend, but no supervisor restarts it automatically.

## Consequences

Session persistence, event vocabulary, AgentTeams state, and activation-capacity semantics are unchanged by this retention mechanism. An unreferenced Client generation and its detailed history stop existing until another consumer retains the Session; the separate catalog and control stream continues projecting running state, queues, jobs, completion markers, and projection values. A retained terminal job id becomes unknown after its configured TTL or reported-record count eviction; durable job-result lookup requires a persistent backend.

Focused Session Controller tests cover independent reference sources, final-release withdrawal, same-id generation replacement, late teardown, opening cancellation, binding ownership, and disposal quiescence. Jobs-local tests cover legacy omission, exact-owner count pruning, unreported-result protection, all terminal statuses, active-job preservation, timer disposal, and real Loader configuration.
