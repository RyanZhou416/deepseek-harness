/**
 * Cancellation against a lifecycle that is already unwinding. A Cordis fiber
 * unload disposes its top-level disposables concurrently, so the inbox
 * projection registration the loop owns can leave the registry while a live
 * agent is still being cancelled by its parent or the host watchdog. The
 * cancellation must still stop the driver, while every live read keeps failing
 * loud on the missing registration.
 * @module dsh-agent-loop/tests/cancel-teardown
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ReactLoopAgent } from '../src/agent.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const REGISTRATION_INACTIVE = /projection registration is not active/

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  try {
    // Reverse registration order: the agent and its scope release before the
    // context that owns them, whatever the assertion above did.
    for (const cleanup of cleanups.reverse()) await cleanup()
  } finally {
    cleanups.length = 0
  }
})

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Wait until `count` model requests are in flight, instead of racing a fixed delay. */
function waitForRequests(adapter: MockAdapter, count: number): Promise<void> {
  return vi.waitFor(() => { expect(adapter.requests).toHaveLength(count) })
}

/** Durable cancellations recorded in the log (claims remove without this outcome). */
function canceledSplices(agent: Agent): number {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')
    .length
}

describe('Agent.cancel() against an unwinding lifecycle', () => {
  it('a cancel arriving after the owning fiber unloaded its projections stops without a durable splice', async () => {
    const adapter = new MockAdapter(['hang', textResponse('after')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('unwound-cancel'), { provider: 'mock', model: 'mock' })

    send(agent, 'active')
    await waitForRequests(adapter, 1)
    send(agent, 'queued')

    // The whole fiber unloads: its disposables — the loop's ownership disposal
    // and its projection registrations — run concurrently, so a parent or host
    // cancellation can land after the inbox registration is already gone.
    await ctx.fiber.dispose()
    expect((agent as ReactLoopAgent).inbox.isRegistered).toBe(false)
    const canceledAtUnload = canceledSplices(agent)

    expect(() => { agent.cancel({ kind: 'parent' }) }).not.toThrow()
    await agent.whenIdle()
    expect(agent.status).toBe('idle')
    expect(canceledSplices(agent)).toBe(canceledAtUnload)
  })

  it('still reports a missing registration from every live inbox read', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('unwound-read'), { provider: 'mock', model: 'mock' })

    await ctx.fiber.dispose()

    // Only cancellation tolerates the unwound registration; the read and
    // mutation surfaces keep the mandatory invariant failure.
    expect(() => (agent as ReactLoopAgent).inbox.hasPending).toThrow(REGISTRATION_INACTIVE)
    expect(() => agent.inbox.nextTurn).toThrow(REGISTRATION_INACTIVE)
    expect(() => { (agent as ReactLoopAgent).inbox.clear() }).toThrow(REGISTRATION_INACTIVE)
  })

  it('a live lifecycle with a missing projection still fails loud and still aborts the activity', async () => {
    // No AgentLoop is mounted, so the registry never holds the inbox unit while
    // the loop context itself stays active: the invariant failure must survive,
    // and the abort must land regardless because the clear threw.
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    const id = SessionId('live-missing-projection')
    const session = Session.create(id)
    ctx.effect(() => ctx.sessions.enter(session))
    let agent!: ReactLoopAgent
    await ctx.plugin(class {
      static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']
      constructor(public ctx: Context) {
        agent = new ReactLoopAgent(ctx, id, { provider: 'mock', model: 'mock' }, session)
      }
    })
    cleanups.push(() => agent.scope.dispose())
    expect(agent.inbox.isRegistered).toBe(false)

    const activity = agent.runMaintenance(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      const reason: unknown = signal.reason
      return reason
    })

    expect(() => { agent.cancel({ kind: 'parent' }) }).toThrow(REGISTRATION_INACTIVE)
    await expect(activity).resolves.toEqual({ kind: 'parent' })
    await agent.whenIdle()
  })

  it('a disposed-cause cancel still durably cancels pending work while the lifecycle is live', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('live-disposed-clear'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    cleanups.push(() => handle.dispose())

    send(handle.agent, 'active')
    await waitForRequests(adapter, 1)
    send(handle.agent, 'queued')

    handle.agent.cancel({ kind: 'disposed' })
    await handle.agent.whenIdle()

    expect(canceledSplices(handle.agent)).toBe(1)
    expect(handle.agent.inbox.nextTurn).toHaveLength(0)
    expect(handle.agent.inbox.nextStep).toHaveLength(0)
  })

  it('keepInbox leaves pending work parked while the lifecycle is live', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('live-keep-inbox'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    cleanups.push(() => handle.dispose())

    send(handle.agent, 'active')
    await waitForRequests(adapter, 1)
    send(handle.agent, 'preserved')

    handle.agent.cancel({ kind: 'parent' }, { keepInbox: true })
    await handle.agent.whenIdle()

    expect(canceledSplices(handle.agent)).toBe(0)
    expect(handle.agent.inbox.nextTurn).toHaveLength(1)
  })
})
