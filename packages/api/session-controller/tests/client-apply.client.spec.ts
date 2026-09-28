/**
 * Session Controller Client apply inside the assembled client: Remote events
 * arriving as emit frames on the `$events` stream, the control stream over
 * the real Connection, and Agent Context identity through the Typert registry.
 */
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { isTypertOwnedValue, RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, vi, type MockInstance } from 'vitest'
import { ClientSessions } from '../src/client/sessions/service.ts'
import type { SessionListValue } from '../src/types.ts'

const SELF = '@deepseek-ai/dsh-api-session-controller'
const ROSTER = webApp.closure([SELF])
const it = createClientTest({ roster: ROSTER })
const EVENTS = '$events'
const CONTROL = 'session/control'
const BASELINE = { type: 'baseline', value: { projections: {} } }
/** The first client boot pays the cold module transform of the cone. */
const COLD_BOOT_TIMEOUT_MS = 60_000

const sid = (value: string): SessionId => value as SessionId

afterEach(() => {
  vi.restoreAllMocks()
})

async function bench(start: () => Promise<TestClient>) {
  const client = await start()
  return { client, sessions: client.ctx.sessions as ClientSessions }
}

/** Deliver one Remote event the way the Host forwards it: an emit frame on the `$events` stream, consumed by the client. */
async function emit(mock: RemoteMock, event: string, ...args: unknown[]): Promise<void> {
  mock.streams.push(EVENTS, { type: 'emit', event, args })
  await mock.streams.drained(EVENTS)
}

function baselines(accept: MockInstance): number {
  return accept.mock.calls.filter(([frame]) => (frame as { type: string }).type === 'baseline').length
}

describe('Session Controller Client apply', () => {
  it('keeps one pending carrier-recovery opening when the next Host generation becomes ready', async ({ mock, start }) => {
    const nextHost = Promise.withResolvers<undefined>()
    const nextBaseline = Promise.withResolvers<undefined>()
    const sessionId = sid('pending-control-recovery')
    let hosts = 0
    let controls = 0
    mock.remote.session.list.mockResolvedValue(ok({ items: [{
      sessionId, updatedAt: 1, running: false, blank: false, agentAvailable: true,
    }] }))
    mock.stream(EVENTS, (_args, stream) => {
      const ready = { type: 'ready', clientId: `synthetic-host-${String(++hosts)}`, host: { home: '/home/mock' } }
      if (hosts === 1) stream.push(ready)
      else void nextHost.promise.then(() => { stream.push(ready) })
    })
    mock.stream(CONTROL, (_args, stream) => {
      const first = ++controls === 1
      const baseline = { type: 'baseline', value: { projections: {
        [sessionId]: { asOfSeq: first ? 20 : 1, values: { title: first ? 'old Host' : 'new Host' } },
      } } }
      if (first) stream.push(baseline)
      else void nextBaseline.promise.then(() => { stream.push(baseline) })
    })
    const { client, sessions } = await bench(start)
    try {
      await vi.waitFor(() => { expect(sessions.list.getSnapshot().byId[sessionId]?.title).toBe('old Host') })
      mock.streams.fail(CONTROL, new RemoteStreamCarrierError('synthetic carrier replacement'))
      await mock.streams.opened(CONTROL, 2)
      client.connection.reconnect()
      await mock.streams.opened(EVENTS, 2)
      expect(client.connection.generation.getSnapshot()).toBeUndefined()
      nextHost.resolve(undefined)
      await vi.waitFor(() => { expect(client.connection.generation.getSnapshot()?.id).toBe(2) })
      await client.flush()
      expect(mock.log.streams(CONTROL)).toHaveLength(2)
      nextBaseline.resolve(undefined)
      await vi.waitFor(() => { expect(sessions.list.getSnapshot().byId[sessionId]?.title).toBe('new Host') })
      expect(mock.log.streams(CONTROL)).toHaveLength(2)
    } finally {
      nextHost.resolve(undefined)
      nextBaseline.resolve(undefined)
    }
  })

  it('restarts an already-accepted recovery baseline after the Host generation changes', async ({ mock, start }) => {
    const sessionId = sid('accepted-control-recovery')
    let controls = 0
    mock.remote.session.list.mockResolvedValue(ok({ items: [{
      sessionId, updatedAt: 1, running: false, blank: false, agentAvailable: true,
    }] }))
    mock.stream(CONTROL, (_args, stream) => {
      controls++
      const title = controls === 1 ? 'initial' : controls === 2 ? 'before ready' : 'after ready'
      stream.push({ type: 'baseline', value: { projections: {
        [sessionId]: { asOfSeq: controls < 3 ? 20 + controls : 1, values: { title } },
      } } })
    })
    const { client, sessions } = await bench(start)
    await vi.waitFor(() => { expect(sessions.list.getSnapshot().byId[sessionId]?.title).toBe('initial') })
    mock.streams.fail(CONTROL, new RemoteStreamCarrierError('synthetic early recovery'))
    await vi.waitFor(() => { expect(sessions.list.getSnapshot().byId[sessionId]?.title).toBe('before ready') })
    expect(mock.log.streams(CONTROL)).toHaveLength(2)
    client.connection.reconnect()
    await vi.waitFor(() => { expect(sessions.list.getSnapshot().byId[sessionId]?.title).toBe('after ready') })
    expect(mock.log.streams(CONTROL)).toHaveLength(3)
  })

  it('opens a fresh control reader after a terminal failure and a later Host generation', async ({ mock, start }) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sessionId = sid('terminal-control-recovery')
    mock.remote.session.list.mockResolvedValue(ok({ items: [{
      sessionId, updatedAt: 1, running: false, blank: false, agentAvailable: true,
    }] }))
    let controls = 0
    mock.stream(CONTROL, (_args, stream) => {
      if (++controls === 1) stream.push(BASELINE)
      if (controls === 3) stream.push({ type: 'baseline', value: { projections: {
        [sessionId]: { asOfSeq: 1, values: { title: 'Restored after terminal failure' } },
      } } })
    })
    const client = await start()
    await mock.streams.opened(CONTROL, 1)
    mock.streams.fail(CONTROL, new RemoteStreamCarrierError('synthetic recovery'))
    await mock.streams.opened(CONTROL, 2)
    mock.streams.fail(CONTROL, new RemoteError('gateway/internal', 'synthetic terminal failure', {}))
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith('[session-controller] control stream failed:',
        expect.objectContaining({ message: 'synthetic terminal failure' }))
    })
    await client.flush()
    expect(mock.log.streams(CONTROL)).toHaveLength(2)
    client.connection.reconnect()
    await vi.waitFor(() => { expect(client.connection.generation.getSnapshot()?.id).toBe(2) })
    await vi.waitFor(() => { expect(mock.log.streams(CONTROL)).toHaveLength(3) })
    await vi.waitFor(() => {
      expect(client.ctx.sessions.list.getSnapshot().byId[sessionId]?.title).toBe('Restored after terminal failure')
    })
    mock.streams.push(CONTROL, { type: 'projection', sessionId, key: 'title', value: 'Live again', seq: 2 })
    await vi.waitFor(() => { expect(client.ctx.sessions.list.getSnapshot().byId[sessionId]?.title).toBe('Live again') })
    await client.unload(SELF)
    expect(mock.log.streams(CONTROL).at(-1)?.state).toBe('cancelled')
    client.connection.reconnect()
    await vi.waitFor(() => { expect(client.connection.generation.getSnapshot()?.id).toBe(3) })
    expect(mock.log.streams(CONTROL)).toHaveLength(3)
  })

  it('opens control exactly once after the first Host generation becomes ready', async ({ mock }) => {
    const ready = Promise.withResolvers<undefined>()
    mock.stream(EVENTS, (_args, stream) => {
      void ready.promise.then(() => {
        stream.push({ type: 'ready', clientId: 'synthetic-first-generation', host: { home: '/home/mock' } })
      })
    })
    const client = await TestClient.start({ roster: ROSTER }, mock, { awaitConnected: false })
    try {
      await mock.streams.opened(EVENTS, 1)
      await client.flush()
      expect(client.connection.generation.getSnapshot()).toBeUndefined()
      expect(mock.log.streams(CONTROL)).toHaveLength(0)
      ready.resolve(undefined)
      await mock.streams.opened(CONTROL, 1)
      await client.flush()
      expect(mock.log.streams(CONTROL)).toHaveLength(1)
      expect(client.connection.generation.getSnapshot()).toMatchObject({ id: 1 })
    } finally {
      ready.resolve(undefined)
      await client.dispose()
    }
  })

  it('routes Remote events from the $events stream into the object layer and runs handleConnected once per generation', async ({ mock, start }) => {
    const connected = vi.spyOn(ClientSessions.prototype, 'handleConnected')
    const error = vi.spyOn(ClientSessions.prototype, 'handleSessionError')
    const { client, sessions } = await bench(start)
    // The first generation's `connection/reset` already ran it; apply itself saw no Host yet.
    await vi.waitFor(() => { expect(connected).toHaveBeenCalledOnce() })

    await emit(mock, 'api-session/added', { agentAvailable: true, sessionId: sid('session-1'), updatedAt: 1, running: false, blank: true })
    await vi.waitFor(() => {
      expect(sessions.list.getSnapshot().byId[sid('session-1')]).toMatchObject({ running: false, updatedAt: 1 })
    })

    await emit(mock, 'api-session/status', sid('session-1'), true)
    await emit(mock, 'api-session/activity', sid('session-1'), 9)
    await emit(mock, 'api-session/error', sid('session-1'), 'agent failed')
    await vi.waitFor(() => {
      expect(sessions.list.getSnapshot().byId[sid('session-1')]).toMatchObject({ running: true, updatedAt: 9 })
    })
    expect(error).toHaveBeenCalledWith(sid('session-1'), 'agent failed')

    await emit(mock, 'api-session/removed', sid('session-1'))
    await vi.waitFor(() => { expect(sessions.list.getSnapshot().byId[sid('session-1')]).toBeUndefined() })

    client.connection.reconnect()
    await mock.streams.opened(EVENTS, 2)
    await vi.waitFor(() => { expect(connected).toHaveBeenCalledTimes(2) })
  }, COLD_BOOT_TIMEOUT_MS)

  it('runs handleConnected at apply when the Host is already connected, as a reload of the row does', async ({ start }) => {
    const connected = vi.spyOn(ClientSessions.prototype, 'handleConnected')
    const { client } = await bench(start)
    await vi.waitFor(() => { expect(connected).toHaveBeenCalledOnce() })
    await client.reload(SELF)
    expect(connected).toHaveBeenCalledTimes(2)
  })

  it('keeps immediate control projections when the ready notification follows their baseline', async ({ mock, start }) => {
    const connected = vi.spyOn(ClientSessions.prototype, 'handleConnected')
    const sessionId = sid('immediate-baseline')
    mock.remote.session.list.mockResolvedValue(ok({ items: [{
      sessionId, updatedAt: 1, running: false, blank: false, agentAvailable: true,
    }] }))
    let projection = { asOfSeq: 20, values: { title: 'Before restart' } }
    mock.stream(CONTROL, (_args, stream) => {
      stream.push({ type: 'baseline', value: { projections: { [sessionId]: projection } } })
    })
    const { client, sessions } = await bench(start)
    await vi.waitFor(() => {
      expect(sessions.list.getSnapshot().byId[sessionId]?.title).toBe('Before restart')
    })
    client.ctx.emit('connection/reset')
    await client.flush()
    expect(sessions.list.getSnapshot().byId[sessionId]?.title).toBe('Before restart')

    projection = { asOfSeq: 1, values: { title: 'After restart' } }
    client.connection.reconnect()
    await vi.waitFor(() => {
      expect(sessions.list.getSnapshot().byId[sessionId]?.title).toBe('After restart')
    })

    await client.unload(SELF)
    client.connection.reconnect()
    await mock.streams.opened(EVENTS, 3)
    await vi.waitFor(() => { expect(client.connection.generation.getSnapshot()?.id).toBe(3) })
    expect(connected).toHaveBeenCalledTimes(2)
  })

  it('accepts the control baseline, retries a carrier loss once, and reports a second opening snapshot as a protocol failure', async ({ mock, start }) => {
    const accept = vi.spyOn(ClientSessions.prototype, 'handleControlFrame')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await start()
    await vi.waitFor(() => { expect(baselines(accept)).toBe(1) })
    expect(accept).toHaveBeenCalledWith(BASELINE)

    // One immediate retry while the Host is available reopens the stream, whose script pushes the baseline again.
    mock.streams.fail(CONTROL, new RemoteStreamCarrierError('generation lost'))
    await vi.waitFor(() => { expect(baselines(accept)).toBe(2) })
    expect(mock.log.streams(CONTROL)).toHaveLength(2)

    mock.streams.push(CONTROL, BASELINE)
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(
        '[session-controller] control stream failed:',
        expect.objectContaining({ message: 'session control stream emitted more than one opening snapshot' }),
      )
    })
  })

  it('materializes Host-addressed Agent scopes before the Session list arrives', async ({ mock, start }) => {
    const list = Promise.withResolvers<RemoteResult<SessionListValue>>()
    mock.remote.session.list.mockReturnValueOnce(list.promise)
    const { client, sessions } = await bench(start)
    const adapter = client.ctx.typert.contexts.getClient('agent')
    const first = adapter?.resolve(sid('agent-early'))
    const second = adapter?.resolve(sid('agent-early'))
    if (!isTypertOwnedValue(first) || !isTypertOwnedValue(second)) throw new Error('expected owned Contexts')
    using firstOwner = first
    using secondOwner = second
    expect(sessions.scopeOf(firstOwner.value)).toBe(sid('agent-early'))
    expect(secondOwner.value).toBe(firstOwner.value)
    expect(sessions.retainInfo(sid('agent-early')).getSnapshot()).toEqual({ referenceCount: 2, retainedBy: { gateway: 2 } })
    expect(mock.log.requests('session/follow')).toHaveLength(0)
    list.resolve(ok({ items: [] }))
    await vi.waitFor(() => { expect(sessions.list.getSnapshot().phase).toBe('ready') })
    expect(sessions.scope(sid('agent-early'))).toBe(firstOwner.value)
  })

  it('projects Agent Context identity in both directions and withdraws the adapter when the row unloads', async ({ mock, start }) => {
    const { client, sessions } = await bench(start)
    await vi.waitFor(() => { expect(sessions.list.getSnapshot().phase).toBe('ready') })

    await emit(mock, 'api-session/added', { agentAvailable: true, sessionId: sid('agent-1'), updatedAt: 1, running: false, blank: true })
    expect(sessions.scope(sid('agent-1'))).toBeUndefined()
    using reference = sessions.retainAgentScope(sid('agent-1'))
    const scoped = reference.binding.ctx
    const adapter = client.ctx.typert.contexts.getClient('agent')
    expect(adapter?.identity(client.ctx)).toBeUndefined()
    expect(adapter?.identity(scoped)).toBe(sid('agent-1'))
    const resolved = adapter?.resolve(sid('agent-1'))
    if (!isTypertOwnedValue(resolved)) throw new Error('expected invocation ownership')
    using invocation = resolved
    expect(invocation.value).toBe(scoped)

    await client.unload(SELF)
    expect(client.ctx.typert.contexts.getClient('agent')).toBeUndefined()
  })

  it('waits for a Host generation before retrying the control stream', async ({ mock, start }) => {
    const accept = vi.spyOn(ClientSessions.prototype, 'handleControlFrame')
    const hostBack = Promise.withResolvers<undefined>()
    let opens = 0
    // The second $events generation stays unready until the test lets the Host answer.
    mock.stream(EVENTS, (_args, stream) => {
      opens += 1
      const ready = { type: 'ready', clientId: `mock-client-${String(opens)}`, host: { home: '/home/mock' } }
      if (opens === 1) stream.push(ready)
      else void hostBack.promise.then(() => { stream.push(ready) })
    })
    const client = await start()
    await vi.waitFor(() => { expect(baselines(accept)).toBe(1) })

    client.connection.reconnect()
    await mock.streams.opened(EVENTS, 2)
    expect(client.connection.generation.getSnapshot()).toBeUndefined()

    mock.streams.fail(CONTROL, new RemoteStreamCarrierError('offline'))
    await client.flush()
    expect(baselines(accept)).toBe(1)
    expect(mock.log.streams(CONTROL)).toHaveLength(1)

    hostBack.resolve(undefined)
    await vi.waitFor(() => { expect(baselines(accept)).toBe(2) })
    expect(client.connection.generation.getSnapshot()).toMatchObject({ id: 2 })
  })
})
