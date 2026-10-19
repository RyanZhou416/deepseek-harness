---
kind: upgrade-guide
description: "AetherShell query timeouts now hand the same running execution to a background job instead of terminating it when job ownership is available."
---

# AetherShell foreground waits hand off to the original job

English | [中文](guide.zh.md)

## Change

The optional AetherShell adapter changes `timeoutMs` on `aether_call`, `aether_pipeline` and `aether_eval` from an execution-kill deadline to a foreground wait budget when `promoteOnTimeout` is enabled and the call has a live Agent and available job registry. Each accepted operation is registered before it starts. Expiry returns `kind: "promoted"` with the original `jobId`; it neither terminates nor repeats the operation. A call finishing before expiry still returns its usual result.

`executionTimeoutMs` is the independent hard execution deadline. When omitted, `maxBackgroundRuntimeMs` supplies the deployment cap; zero means no outer runtime cap. Inner native limits, including `proc_run`'s `timeout_ms`, still apply. Explicit cancellation stops and awaits owned execution. Discovery, persistent sessions and the raw-stream `aether_job_start` keep their existing deadlines and result formats. Without job ownership, with promotion disabled, or after pre-start admission refusal, the query retains a foreground kill deadline.

## Migration

1. Upgrade the optional adapter package with a matching Host build, then restart DSH to load the new JavaScript module generation. Installing a replacement package does not activate it in the already running Host.
2. Callers requiring the previous kill deadline must pass `executionTimeoutMs`, or set `promoteOnTimeout: false` in the profile's `aether-shell` configuration. Keep `timeoutMs` for how long to wait in the foreground.
3. Handle `kind: "promoted"` by collecting the returned `jobId` with `job_output`. Its settled result contains the canonical AetherShell outcome as JSON. Use `job_kill` to stop it. Never submit the original command again merely because the foreground wait ended.
4. Confirm that a slow operation returns a job id, that `job_output` reports its final outcome, and that any external effect occurred only once. A large final value may instead name an `aether_result_page` retrieval id. Jobs and retained results do not survive Host restart or owner disposal.
