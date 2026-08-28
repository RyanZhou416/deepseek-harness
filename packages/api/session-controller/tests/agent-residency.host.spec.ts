import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent, type AgentHandle, type AgentStatus } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import SessionController from '../src/index.ts'

const roots: Context[] = []
const sessionId = SessionId('resident-session')
const header: SessionHeader = { version: 0, id: sessionId, createdAt: 1, cwd: '/project' }

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

function fakeAgent(ctx: Context, session: Session): Agent {
  const scope = ctx.plugin(() => {})
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: AgentStatus = 'idle'
  return {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: scope.ctx,
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function harness(retentionMs: number): Promise<{
  ctx: Context
  controller: ApiSessionAgentController
  agent: Agent
  disposeHandle: ReturnType<typeof vi.fn<AgentHandle['dispose']>>
}> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.provide('sessionPersistence', {
    listSnapshots: () => Promise.resolve([{ header, revision: SessionPersistenceRevision('resident:1') }]),
  } as never)
  ctx.on('session/flush', () => Promise.resolve())
  const session = ctx.sessions.prepare(sessionId, { meta: header })
  const detachSession = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  const agent = fakeAgent(ctx, session)
  const detachAgent = ctx.agents.enter(agent, undefined)
  ctx.agents.announce(agent)
  const disposeHandle = vi.fn<AgentHandle['dispose']>(async () => {
    detachAgent()
    detachSession()
  })
  const controller = new ApiSessionAgentController(ctx, retentionMs)
  controller.adoptHandle({ agent, dispose: disposeHandle })
  return { ctx, controller, agent, disposeHandle }
}

describe('Session Controller idle Agent residency', () => {
  it('defaults to five minutes and accepts zero as the disable value', () => {
    expect(SessionController.Config({})).toMatchObject({ idleSessionRetentionMs: 300_000 })
    expect(SessionController.Config({ idleSessionRetentionMs: 0 })).toMatchObject({ idleSessionRetentionMs: 0 })
    for (const value of [-1, 1.5]) {
      expect(() => SessionController.Config({ idleSessionRetentionMs: value })).toThrow()
    }
  })

  it('flushes and unloads a durable owned Agent after its idle interval', async () => {
    vi.useFakeTimers()
    const { ctx, controller, agent, disposeHandle } = await harness(100)

    await vi.advanceTimersByTimeAsync(100)

    expect(disposeHandle).toHaveBeenCalledOnce()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    expect(controller.isResidencyEviction(agent.session)).toBe(true)
  })

  it('retains an idle Agent while followed and schedules eviction after release', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const controller = new ApiSessionAgentController(ctx, 100)
    const release = controller.retainForFollower(sessionId)
    ctx.provide('sessionPersistence', {
      listSnapshots: () => Promise.resolve([{ header, revision: SessionPersistenceRevision('resident:1') }]),
    } as never)
    ctx.on('session/flush', () => Promise.resolve())
    const session = ctx.sessions.prepare(sessionId, { meta: header })
    const detachSession = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    const agent = fakeAgent(ctx, session)
    const detachAgent = ctx.agents.enter(agent, undefined)
    ctx.agents.announce(agent)
    const dispose = vi.fn(async () => {
      detachAgent()
      detachSession()
    })
    controller.adoptHandle({ agent, dispose })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(dispose).not.toHaveBeenCalled()

    release()
    await vi.advanceTimersByTimeAsync(100)
    expect(dispose).toHaveBeenCalledOnce()
  })
})
