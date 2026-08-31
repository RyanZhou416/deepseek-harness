---
description: "Process-wide Agent model-phase admission for deployments that need bounded concurrency and V8 heap-pressure hysteresis during long or highly concurrent runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-admission

English | [中文](README.zh.md)

## Summary

`dsh-memory-admission` bounds model phases across every Agent in one process without changing session logs or model input. It admits proposed steps in FIFO order before model-history assembly, closes admission under V8 heap pressure, and releases capacity at the final `assistant/message` before tool execution can wait on a child Agent. Choose it for long-running or highly concurrent profiles where unrestricted model-history assembly and response streams can exhaust the Node heap; it delays new work but never cancels an admitted model phase.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin before `dsh-agent-loop`, then make the loop entry inject `memoryAdmission` so configured Agents cannot start before the admission listeners exist. The shipped base bundle already applies this ordering.

### When to choose it

Choose this guard when several Agents may assemble long histories or stream model responses concurrently in one Host process. Skip it when a deployment already owns an equivalent process-wide scheduler or when model work runs in isolated processes whose heaps cannot pressure one another.

### Minimal configuration

```yaml
- id: memory-admission
  name: '@deepseek-ai/dsh-memory-admission'
  config:
    maxConcurrentSteps: 8
    heapHighWatermarkRatio: 0.82
    heapLowWatermarkRatio: 0.72
    sampleIntervalMs: 100

- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  inject: [memoryAdmission]
  config:
    agents: []
```

| Field | Default | Meaning |
|---|---:|---|
| `maxConcurrentSteps` | `8` | Maximum admitted Agent model phases in the process |
| `heapHighWatermarkRatio` | `0.82` | V8 heap-used ratio that closes new admission |
| `heapLowWatermarkRatio` | `0.72` | Ratio that reopens admission after pressure |
| `sampleIntervalMs` | `100` | Heap resampling interval while callers wait |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-memory-admission) is the exhaustive source for every accepted field and its JSDoc.

### Scheduling and failure behavior

`heapLowWatermarkRatio` must be lower than `heapHighWatermarkRatio`; invalid ordering fails plugin load. A waiting step retains its claimed input under the Agent activity's cancellation signal and contributes no session event until downstream pre-step admission accepts it. Cancellation removes only that FIFO waiter. A reservation releases at its matching durable `assistant/message`; `step/end`, Agent idle, Agent disposal, and plugin disposal are fallback release paths. Plugin disposal also rejects every queued admission.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`StepAdmissionGate` owns one FIFO waiter queue, an active counter, and V8 heap hysteresis. The plugin acquires at `agent/pre-step`, records the exact Agent/turn/step only after downstream listeners accept the step, and matches that reservation against `session/event`. Releasing on `assistant/message` limits model-history and model-stream residency while ensuring tool execution and subagent waits do not consume a parent slot.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin configuration, lifecycle listeners, and reservation ownership |
| [`src/gate.ts`](src/gate.ts) | FIFO concurrency and heap-hysteresis gate |
| [`src/invariant.ts`](src/invariant.ts) | Package invariant ownership registration |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent lifecycle](../../../docs/agent-lifecycle.md) — turn, step, request, and tool ordering.
- [Core subsystem](../../../docs/subsystems/core.md) — Agent events and loop contracts.
- [Defensive patterns](../../../docs/defensive-patterns.md) — cancellation, disposal, and asynchronous ownership rules.

-----

<a id="model-experience"></a>
## Model Experience

### Delayed request admission

#### What the model sees

No added system text or tool schema. A request may start later while `agent/pre-step` waits for process capacity or lower heap pressure.

#### Token effect

Zero direct tokens.

#### KV Cache effect

The policy preserves the original message sequence of every accepted request and does not replace an existing reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Heap admission observes V8 `heapUsed`; native buffers, subprocesses, and browser memory are outside that measure.
- An admitted model phase may cross the high watermark and is never cancelled by this policy.
- Persistent pressure can leave new steps waiting until memory falls or their activity is cancelled.
- The concurrency limit is process-local; separate Harness processes do not coordinate reservations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
