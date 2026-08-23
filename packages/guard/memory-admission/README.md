# @deepseek-ai/dsh-memory-admission

English | [中文](README.zh.md)

This guard bounds process-wide agent model-phase admission without changing session logs or model input. It acquires a FIFO reservation at `agent/pre-step`, before model-history assembly, and releases that reservation at the matching durable `assistant/message`, before tool execution can wait on a child Agent; `step/end`, idle, and disposal release a stranded reservation. Active model phases finish naturally. New model phases wait while either `maxConcurrentSteps` is occupied or V8 heap usage reaches `heapHighWatermarkRatio`, and heap admission reopens only at `heapLowWatermarkRatio`.

After installing every listener, the plugin provides `ctx.memoryAdmission`; the base bundle makes agent-loop inject that readiness service, so configuration-created Agents cannot start before admission is active.

## Config

```yaml
- id: memory-admission
  name: '@deepseek-ai/dsh-memory-admission'
  config:
    maxConcurrentSteps: 8
    heapHighWatermarkRatio: 0.82
    heapLowWatermarkRatio: 0.72
    sampleIntervalMs: 100
```

`heapLowWatermarkRatio` must be lower than `heapHighWatermarkRatio`; invalid ordering fails plugin load. A waiting step retains its claimed input under the agent's cancellation signal and contributes no session event until downstream pre-step admission accepts it. Cancelling that activity removes only its FIFO waiter. Tool execution and subagent waits do not retain model-phase capacity. Plugin disposal rejects queued admissions and releases active reservations.

The guard changes scheduling only. It adds no model-visible content, session event, storage file, migration, or wire field.

## Model Experience

### Delayed request admission

#### What the model sees

No added `system` text or tool schema. A request may start later under process pressure.

#### Token effect

Zero direct tokens.

#### KV Cache effect

The policy preserves the original message sequence of every accepted request and does not replace an existing reusable prefix.

## Known Limitations and Deferred Work

- Heap admission observes V8 `heapUsed`; native buffers and browser memory are outside that measure.
- An already admitted model phase may cross the high watermark and is never cancelled by this policy.
- Persistent pressure can leave new steps waiting until memory falls or their activity is cancelled.
