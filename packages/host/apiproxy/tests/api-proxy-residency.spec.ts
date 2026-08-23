import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent, type AgentHandle, type AgentStatus } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { STREAM_HEARTBEAT_INTERVAL_MS } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId, type RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'

const sessionId = SessionId('resident-session')
const meta: SessionHeader = { version: 0, id: sessionId, createdAt: 1, cwd: '/proj' }

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(crypto.randomUUID()), payload }
}

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
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {},
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function harness(retentionMs: number): Promise<{
  ctx: Context
  api: ReturnType<typeof createApiProxy>
  disposeHandle: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([meta]),
    inspect: () => Promise.resolve({ meta, events: [] as SessionEvent[] }),
    listSnapshots: () => Promise.resolve([{
      header: meta,
      revision: SessionPersistenceRevision('resident:1'),
    }]),
    locate: () => undefined,
  } as never)
  ctx.on('session/flush', () => Promise.resolve())
  const disposeHandle = vi.fn<AgentHandle['dispose']>()
  vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
    const session = ctx.sessions.prepare(sessionId, { meta: { cwd: '/proj', createdAt: meta.createdAt } })
    const detachSession = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    const agent = fakeAgent(ctx, session)
    const detachAgent = ctx.agents.enter(agent, undefined)
    ctx.agents.announce(agent)
    let live = true
    const dispose = async (): Promise<void> => {
      if (!live) return
      live = false
      detachAgent()
      detachSession()
      await disposeHandle()
    }
    return { agent, dispose }
  })
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
    cwd: '/proj',
    idleSessionRetentionMs: retentionMs,
  })
  return { ctx, api, disposeHandle }
}

async function resumeThroughLookup(ctx: Context): Promise<Agent> {
  await vi.waitFor(() => { expect(ctx.typert.lookups.get('agent')).toBeDefined() })
  const lookup = ctx.typert.lookups.get('agent')
  if (lookup === undefined) throw new Error('agent lookup missing')
  return await lookup.resolve(sessionId) as Agent
}

describe('Host-owned idle session residency', () => {
  it('emits transient heartbeats on both event queues and stops them on abort', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, api } = await harness(1_000)
      const muxAbort = new AbortController()
      const hostAbort = new AbortController()
      const mux = api.events.mux(request({}), muxAbort.signal)[Symbol.asyncIterator]()
      const host = api.events.host(request({}), hostAbort.signal)[Symbol.asyncIterator]()
      const muxBeat = mux.next()
      const hostBeat = host.next()

      await vi.advanceTimersByTimeAsync(STREAM_HEARTBEAT_INTERVAL_MS)
      const expectedSentAt = Date.now()
      await expect(muxBeat).resolves.toMatchObject({
        value: { payload: { type: 'stream/heartbeat', sentAt: expectedSentAt } },
      })
      await expect(hostBeat).resolves.toMatchObject({
        value: { payload: { type: 'stream/heartbeat', sentAt: expectedSentAt } },
      })

      muxAbort.abort()
      hostAbort.abort()
      await expect(mux.next()).resolves.toMatchObject({ done: true })
      await expect(host.next()).resolves.toMatchObject({ done: true })
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes and unloads an unsubscribed durable idle session', async () => {
    const { ctx, disposeHandle } = await harness(10)
    const agent = await resumeThroughLookup(ctx)

    await vi.waitFor(() => {
      expect(ctx.agents.get(sessionId)).toBeUndefined()
      expect(ctx.sessions.get(sessionId)).toBeUndefined()
    })
    expect(disposeHandle).toHaveBeenCalledOnce()
    expect(agent.session.header).toEqual(meta)
    await ctx.fiber.dispose()
  })

  it('retains while a mux subscriber is connected and unloads after disconnect', async () => {
    const { ctx, api, disposeHandle } = await harness(10)
    const controller = new AbortController()
    const stream = api.events.mux(request({}), controller.signal)[Symbol.asyncIterator]()
    const baseline = stream.next()
    const agent = await resumeThroughLookup(ctx)
    await baseline

    await new Promise(resolve => setTimeout(resolve, 25))
    expect(ctx.agents.get(sessionId)).toBe(agent)
    expect(disposeHandle).not.toHaveBeenCalled()

    controller.abort()
    await stream.next()
    await vi.waitFor(() => { expect(ctx.agents.get(sessionId)).toBeUndefined() })
    expect(disposeHandle).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('keeps the persisted list row when resident eviction disposes the live Session', async () => {
    const { ctx, api } = await harness(10)
    const controller = new AbortController()
    const stream = api.events.host(request({}), controller.signal)[Symbol.asyncIterator]()
    const added = stream.next()
    await resumeThroughLookup(ctx)
    await expect(added).resolves.toMatchObject({
      value: { payload: { type: 'host/session-added', sessionId } },
    })
    await vi.waitFor(() => { expect(ctx.sessions.get(sessionId)).toBeUndefined() })

    const next = stream.next().then(() => 'frame' as const)
    const timeout = new Promise<'timeout'>(resolve => setTimeout(() => { resolve('timeout') }, 25))
    await expect(Promise.race([next, timeout])).resolves.toBe('timeout')
    controller.abort()
    await stream.next()
    await ctx.fiber.dispose()
  })
})
