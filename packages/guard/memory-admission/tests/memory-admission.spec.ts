import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as MemoryAdmission from '@deepseek-ai/dsh-memory-admission'
import { StepAdmissionGate } from '../src/gate.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

afterEach(() => { vi.useRealTimers() })

describe('StepAdmissionGate', () => {
  it('admits in FIFO order under the configured concurrency limit', async () => {
    const gate = new StepAdmissionGate({
      maxConcurrentSteps: 1,
      heapHighWatermarkRatio: 0.8,
      heapLowWatermarkRatio: 0.6,
      sampleIntervalMs: 10,
    }, () => 0.1)
    const first = await gate.acquire(new AbortController().signal)
    let secondAdmitted = false
    const secondPromise = gate.acquire(new AbortController().signal).then((release) => {
      secondAdmitted = true
      return release
    })

    await Promise.resolve()
    expect(secondAdmitted).toBe(false)
    first()
    const second = await secondPromise
    expect(secondAdmitted).toBe(true)
    second()
    second()
  })

  it('uses heap hysteresis and periodic resampling', async () => {
    vi.useFakeTimers()
    let ratio = 0.9
    const gate = new StepAdmissionGate({
      maxConcurrentSteps: 2,
      heapHighWatermarkRatio: 0.8,
      heapLowWatermarkRatio: 0.6,
      sampleIntervalMs: 10,
    }, () => ratio)
    let admitted = false
    const pending = gate.acquire(new AbortController().signal).then((release) => {
      admitted = true
      return release
    })
    const another = gate.acquire(new AbortController().signal)

    await vi.advanceTimersByTimeAsync(10)
    expect(admitted).toBe(false)
    ratio = 0.7
    await vi.advanceTimersByTimeAsync(10)
    expect(admitted).toBe(false)
    ratio = 0.6
    await vi.advanceTimersByTimeAsync(10)
    const release = await pending
    const releaseAnother = await another
    expect(admitted).toBe(true)
    release()
    releaseAnother()
  })

  it('removes a cancelled waiter and rejects queued work on close', async () => {
    const gate = new StepAdmissionGate({
      maxConcurrentSteps: 1,
      heapHighWatermarkRatio: 0.8,
      heapLowWatermarkRatio: 0.6,
      sampleIntervalMs: 10,
    }, () => 0.9)
    const controller = new AbortController()
    const cancelled = gate.acquire(controller.signal)
    const cancelReason = new Error('cancelled admission')
    controller.abort(cancelReason)
    await expect(cancelled).rejects.toBe(cancelReason)

    const nonErrorController = new AbortController()
    const nonError = gate.acquire(nonErrorController.signal)
    nonErrorController.abort('raw abort reason')
    await expect(nonError).rejects.toMatchObject({
      message: 'memory-admission: admission aborted',
      cause: 'raw abort reason',
    })

    const queued = gate.acquire(new AbortController().signal)
    const closeReason = new Error('gate closed')
    gate.close(closeReason)
    gate.close(new Error('ignored repeat close'))
    await expect(queued).rejects.toBe(closeReason)
    await expect(gate.acquire(new AbortController().signal)).rejects.toBe(closeReason)

    const activeGate = new StepAdmissionGate({
      maxConcurrentSteps: 1,
      heapHighWatermarkRatio: 0.8,
      heapLowWatermarkRatio: 0.6,
      sampleIntervalMs: 10,
    }, () => 0.1)
    const release = await activeGate.acquire(new AbortController().signal)
    activeGate.close(new Error('closed with active reservation'))
    release()
  })
})

class BlockingAdapter extends MockAdapter {
  readonly starts = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()] as const
  readonly releases = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()] as const
  active = 0
  maxActive = 0
  calls = 0

  constructor() { super([]) }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.calls++
    this.requests.push(options)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    this.starts[index]?.resolve(undefined)
    try {
      await this.releases[index]?.promise
      for (const chunk of textResponse(`done-${index}`)) yield chunk
    } finally {
      this.active -= 1
    }
  }
}

async function waitIdle(agents: readonly Agent[]): Promise<void> {
  await Promise.all(agents.map(agent => agent.whenIdle()))
}

describe('memory admission plugin', () => {
  it('holds one reservation through the complete real agent step', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(MemoryAdmission, {
      maxConcurrentSteps: 1,
      heapHighWatermarkRatio: 0.99,
      heapLowWatermarkRatio: 0.98,
      sampleIntervalMs: 10,
    })
    const adapter = new BlockingAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const first = ctx.agentLoop.create(SessionId('memory-first'), { provider: 'mock', model: 'mock' })
    const second = ctx.agentLoop.create(SessionId('memory-second'), { provider: 'mock', model: 'mock' })

    first.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    second.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await adapter.starts[0].promise
    await Promise.resolve()
    expect(adapter.calls).toBe(1)

    adapter.releases[0].resolve(undefined)
    await adapter.starts[1].promise
    expect(adapter.calls).toBe(2)
    adapter.releases[1].resolve(undefined)
    await waitIdle([first, second])

    expect(adapter.maxActive).toBe(1)
    expect(first.session.events.some(event => event.type === 'step/end')).toBe(true)
    expect(second.session.events.some(event => event.type === 'step/end')).toBe(true)
  })

  it('fails load when heap hysteresis ordering is invalid', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(MemoryAdmission, {
      heapHighWatermarkRatio: 0.7,
      heapLowWatermarkRatio: 0.8,
    })).rejects.toThrow(/heapLowWatermarkRatio must be less/)
  })

  it('releases rejected and plugin-disposed direct pre-step reservations', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const plugin = await ctx.plugin(MemoryAdmission, {
      maxConcurrentSteps: 2,
      heapHighWatermarkRatio: 0.99,
      heapLowWatermarkRatio: 0.98,
      sampleIntervalMs: 10,
    })
    const agent = ctx.agentLoop.create(SessionId('memory-direct'), { provider: 'mock', model: 'mock' })
    const signal = new AbortController().signal
    const payload = { messages: [], turn: 1, step: 1, signal }

    await expect(agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      payload,
      () => Promise.resolve({ kind: 'reject' as const }),
    )).resolves.toEqual({ kind: 'reject' })
    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      payload,
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )).resolves.toEqual({ kind: 'enter', messages: [] })

    await plugin.dispose()
  })
})
