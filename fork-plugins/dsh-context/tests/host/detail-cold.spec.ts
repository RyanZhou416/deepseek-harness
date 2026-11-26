// DeepSeek Harness fork modification: the stored-session detail rungs. See ../../FORK_MAINTENANCE.md.
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { DETAIL_ROUTE, watchDetailChannel } from '../../src/host/detail'
import { resolveBounds } from '../../src/host/config'
import { buildTimelineDetail } from '../../src/host/foldWire'
import { createTimelineState } from '../../src/host/foldState'
import { applyTimeline } from '../../src/host/fold'
import type { TimelineState } from '../../src/host/foldState'
import { connectionOf, fakeCtx, postJson } from './helpers/ctx'
import type { FakeRoute } from './helpers/ctx'
import { assistantMessage, header, manyEvents, userMessage } from './helpers/events'

const BOUNDS = resolveBounds({})

const LOG = [
  header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' }),
  userMessage(2, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
  assistantMessage(3, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5 } }),
]

function foldedState(events: readonly unknown[]): TimelineState {
  let state = createTimelineState()
  for (const event of events) state = applyTimeline(state, event as never, BOUNDS)
  return state
}

function headViewOf(events: readonly unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  const state = foldedState(events)
  return {
    ok: true,
    model: state.model,
    provider: state.provider,
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 1 },
    detailRev: state.detailRev ?? 0,
    ...over,
  }
}

interface QuerySpec {
  metadata?: (id: string, options: unknown) => Promise<unknown>
  window?: (id: string, options: unknown) => Promise<unknown>
  observe?: (id: string, options: unknown) => Promise<unknown>
}

function coldCtx(query: QuerySpec): { captured: FakeRoute; dispose(): void } {
  const fake = fakeCtx({
    connection: connectionOf(),
    sessions: { get: () => undefined },
    sessionPersistence: { backend: 'default' },
    sessionQuery: {
      ...(query.metadata === undefined ? {} : { observeSessionMetadata: query.metadata }),
      ...(query.window === undefined ? {} : { readWindow: query.window }),
      ...(query.observe === undefined ? {} : { observeSession: query.observe }),
    },
  }, { sessionProjections: { stateOf: () => undefined } })
  watchDetailChannel(fake.ctx, BOUNDS)
  return { captured: fake.captured, dispose: () => { fake.dispose() } }
}

const call = (captured: FakeRoute, body: unknown): Promise<Record<string, unknown>> => postJson(captured, DETAIL_ROUTE, body)

function headerOfLog(): Record<string, unknown> {
  return { id: 'cold1', version: 4, createdAt: 7, cwd: '/tmp' }
}

describe('the cold detail route — projection checkpoint head', () => {
  test('a head read serves the cached projection head and its views with no log read', async () => {
    const observe = vi.fn()
    const head = headViewOf(LOG)
    const { captured, dispose } = coldCtx({
      metadata: async () => ({
        header: headerOfLog(),
        projections: { values: { contextTimeline: head, contextPressure: { pressureTokens: 5 }, contextBreakdown: { systemTokens: 1 }, tokenUsage: { outputTokens: 9 } } },
      }),
      observe,
    })
    const result = await call(captured, { sessionId: 'cold1', head: true })
    assert.equal(result.ok, true)
    const value = result.value as Record<string, unknown>
    assert.equal(value.rev, head.detailRev)
    assert.deepEqual(value.head, head)
    assert.deepEqual(value.pressure, { pressureTokens: 5 })
    assert.deepEqual(value.breakdown, { systemTokens: 1 })
    assert.deepEqual(value.usage, { outputTokens: 9 })
    assert.equal(observe.mock.calls.length, 0, 'the head never folds the log')
    dispose()
  })

  test('a missing cached head, a malformed header, and a failed metadata read all serve null', async () => {
    const noHead = coldCtx({ metadata: async () => ({ header: headerOfLog() }) })
    assert.deepEqual(await call(noHead.captured, { sessionId: 'cold1', head: true }), { ok: true, value: null })
    noHead.dispose()

    const failed = coldCtx({ metadata: async () => { throw new Error('nope') } })
    assert.deepEqual(await call(failed.captured, { sessionId: 'cold1', head: true }), { ok: true, value: null })
    failed.dispose()

    const malformed = coldCtx({ metadata: async () => ({ header: { id: 'cold1' }, projections: { values: { contextTimeline: headViewOf(LOG) } } }) })
    assert.deepEqual(await call(malformed.captured, { sessionId: 'cold1' }), { ok: true, value: null }, 'a header without a format generation cannot gate a window')
    malformed.dispose()
  })

  test('a cached head without a numeric detailRev serves rev 0', async () => {
    const head = { ...headViewOf(LOG) }
    delete head.detailRev
    const { captured, dispose } = coldCtx({ metadata: async () => ({ header: headerOfLog(), projections: { values: { contextTimeline: head } } }) })
    const result = await call(captured, { sessionId: 'cold1', head: true })
    assert.equal((result.value as { rev: number }).rev, 0)
    const value = result.value as Record<string, unknown>
    assert.equal(value.pressure, undefined, 'absent views are omitted')
    assert.equal(value.breakdown, undefined)
    assert.equal(value.usage, undefined)
    dispose()
  })
})

describe('the cold detail route — bounded tail window', () => {
  test('an ordinary read folds only the served window and marks the cut', async () => {
    const head = headViewOf(LOG)
    const { captured, dispose } = coldCtx({
      metadata: async () => ({ header: headerOfLog(), projections: { values: { contextTimeline: head } } }),
      window: async () => ({ window: { events: LOG, hasMore: true } }),
    })
    const result = await call(captured, { sessionId: 'cold1' })
    const value = result.value as Record<string, unknown>
    assert.equal(result.ok, true)
    assert.deepEqual(value.partial, { fromSeq: 1 }, 'the window starts at its first event')
    assert.deepEqual(value.head, head, 'the exact cached head rides the partial payload')
    assert.equal(value.rev, head.detailRev)
    assert.ok(Array.isArray(value.requests) && (value.requests as unknown[]).length === 1)
    dispose()
  })

  test('a complete window carries no partial marker and no cached head', async () => {
    const { captured, dispose } = coldCtx({
      metadata: async () => ({ header: headerOfLog() }),
      window: async () => ({ window: { events: LOG, hasMore: false } }),
    })
    const result = await call(captured, { sessionId: 'cold1' })
    const value = result.value as Record<string, unknown>
    assert.equal(value.partial, undefined, 'a whole-history window is not partial')
    assert.equal((value.head as { model?: string }).model, 'deepseek-v4-flash', 'the folded window supplies its head')
    assert.equal(value.rev, buildTimelineDetail(foldedState(LOG), BOUNDS).rev, 'the folded window supplies the revision')
    dispose()
  })

  test('a window without sequence numbers and an unusable window serve what the host can prove', async () => {
    const noSeq = coldCtx({
      metadata: async () => ({ header: headerOfLog() }),
      window: async () => ({ window: { events: [{ type: 'noop' }], hasMore: true } }),
    })
    const result = await call(noSeq.captured, { sessionId: 'cold1' })
    assert.equal((result.value as Record<string, unknown>).partial, undefined, 'an unnumbered window is not labelled')
    noSeq.dispose()

    const malformed = coldCtx({
      metadata: async () => ({ header: headerOfLog() }),
      window: async () => ({ window: { events: 'nope' } }),
    })
    assert.deepEqual(await call(malformed.captured, { sessionId: 'cold1' }), { ok: true, value: null })
    malformed.dispose()

    const throwing = coldCtx({
      metadata: async () => ({ header: headerOfLog() }),
      window: async () => { throw new Error('down') },
    })
    assert.deepEqual(await call(throwing.captured, { sessionId: 'cold1' }), { ok: true, value: null })
    throwing.dispose()

    const missing = coldCtx({ metadata: async () => ({ header: headerOfLog() }) })
    assert.deepEqual(await call(missing.captured, { sessionId: 'cold1' }), { ok: true, value: null }, 'a host without readWindow serves no detail')
    missing.dispose()
  })

  test('an aborted request stops before the window and after the metadata stat', async () => {
    const controller = new AbortController()
    controller.abort()
    const { captured, dispose } = coldCtx({
      metadata: async () => { throw new DOMException('aborted', 'AbortError') },
    })
    const request = new Request('http://dsh.test' + DETAIL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cold1' }),
      signal: controller.signal,
    })
    const response = await captured.fetch!(request)
    const body = await response.json() as { ok: boolean; error?: { code: string } }
    assert.equal(body.ok, false)
    assert.equal(body.error?.code, 'dsh-context/aborted')
    dispose()
  })
})

describe('the cold detail route — explicit full history', () => {
  test('full folds the whole log once and replays the cached payload by revision', async () => {
    let eventReads = 0
    let disposed = 0
    const { captured, dispose } = coldCtx({
      metadata: async () => ({ header: headerOfLog() }),
      observe: async () => ({
        revision: 'rev-1',
        get events() {
          eventReads++
          return LOG
        },
        [Symbol.dispose]: () => { disposed++ },
      }),
    })
    const first = await call(captured, { sessionId: 'cold1', full: true })
    assert.equal(first.ok, true)
    const value = first.value as { requests: unknown[] }
    assert.equal(value.requests.length, 1)
    assert.deepEqual(first.value, buildTimelineDetail(foldedState(LOG), BOUNDS), 'the full payload is the whole fold')
    const second = await call(captured, { sessionId: 'cold1', full: true })
    assert.deepEqual(second, first)
    assert.equal(eventReads, 1, 'the same revision replays instead of reading the log again')
    assert.equal(disposed, 2, 'both observation leases are released')
    dispose()
  })

  test('a full read without an observation face, without a revision, or without events serves null or an uncached fold', async () => {
    const noObserve = coldCtx({ metadata: async () => ({ header: headerOfLog() }) })
    assert.deepEqual(await call(noObserve.captured, { sessionId: 'cold1', full: true }), { ok: true, value: null })
    noObserve.dispose()

    const noRevision = coldCtx({
      metadata: async () => ({ header: headerOfLog() }),
      observe: async () => ({ events: LOG, [Symbol.dispose]: () => {} }),
    })
    const uncached = await call(noRevision.captured, { sessionId: 'cold1', full: true })
    assert.equal(uncached.ok, true)
    assert.equal(((uncached.value as { requests: unknown[] }).requests).length, 1)
    noRevision.dispose()

    const noEvents = coldCtx({
      metadata: async () => ({ header: headerOfLog() }),
      observe: async () => ({ revision: 'rev-2', [Symbol.dispose]: () => {} }),
    })
    assert.deepEqual(await call(noEvents.captured, { sessionId: 'cold1', full: true }), { ok: true, value: null })
    noEvents.dispose()
  })

  test('a rejected metadata read with an un-aborted signal stays a null cold read', async () => {
    const { captured, dispose } = coldCtx({ metadata: async () => { throw new Error('stat failed') } })
    assert.deepEqual(await call(captured, { sessionId: 'cold1' }), { ok: true, value: null })
    dispose()
  })
})
describe('the cold detail route — cancellation races', () => {
  function abortedRequest(controller: AbortController): Request {
    return new Request('http://dsh.test' + DETAIL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cold1' }),
      signal: controller.signal,
    })
  }

  test('a cancellation raised inside the metadata stat still answers the aborted envelope', async () => {
    const controller = new AbortController()
    const { captured, dispose } = coldCtx({
      metadata: async () => {
        controller.abort()
        return { header: headerOfLog() }
      },
    })
    const body = await (await captured.fetch!(abortedRequest(controller))).json() as { ok: boolean; error?: { code: string } }
    assert.equal(body.ok, false)
    assert.equal(body.error?.code, 'dsh-context/aborted')
    dispose()
  })

  test('a throwing session lookup on a cancelled request answers the aborted envelope', async () => {
    const controller = new AbortController()
    controller.abort()
    const fake = fakeCtx({
      connection: connectionOf(),
      sessions: { get: () => { throw new Error('store failed') } },
      sessionPersistence: { backend: 'default' },
      sessionQuery: { observeSessionMetadata: async () => ({ header: headerOfLog() }) },
    }, { sessionProjections: { stateOf: () => undefined } })
    watchDetailChannel(fake.ctx, BOUNDS)
    const body = await (await fake.captured.fetch!(abortedRequest(controller))).json() as { ok: boolean; error?: { code: string } }
    assert.equal(body.ok, false)
    assert.equal(body.error?.code, 'dsh-context/aborted')
    fake.dispose()
  })

  test('a window that fails or resolves after cancellation serves the null cold read', async () => {
    const throwing = new AbortController()
    const thrown = coldCtx({
      metadata: async () => ({ header: headerOfLog() }),
      window: async () => {
        throwing.abort()
        throw new Error('cancelled')
      },
    })
    const thrownBody = await (await thrown.captured.fetch!(abortedRequest(throwing))).json() as { ok: boolean; error?: { code: string } }
    assert.equal(thrownBody.ok, false)
    assert.equal(thrownBody.error?.code, 'dsh-context/aborted')
    thrown.dispose()

    const resolving = new AbortController()
    const resolved = coldCtx({
      metadata: async () => ({ header: headerOfLog() }),
      window: async () => {
        resolving.abort()
        return { window: { events: LOG, hasMore: false } }
      },
    })
    const resolvedBody = await (await resolved.captured.fetch!(abortedRequest(resolving))).json() as { ok: boolean; error?: { code: string } }
    assert.equal(resolvedBody.ok, false, 'an aborted request never serves a late window')
    assert.equal(resolvedBody.error?.code, 'dsh-context/aborted')
    resolved.dispose()
  })

  test('a projection values block without a timeline head serves no cold head', async () => {
    const { captured, dispose } = coldCtx({
      metadata: async () => ({ header: headerOfLog(), projections: { values: { contextPressure: { pressureTokens: 1 } } } }),
    })
    assert.deepEqual(await call(captured, { sessionId: 'cold1', head: true }), { ok: true, value: null })
    dispose()
  })
})
describe('the cold detail route — cost source and long folds', () => {
  const COST = {
    read: () => ({ usd: 0.5, ready: true }),
    usd: () => 0.5,
    complete: () => true,
    ready: () => true,
  }

  function costCtx(query: QuerySpec): FakeRoute {
    const fake = fakeCtx({
      connection: connectionOf(),
      sessions: { get: () => undefined },
      sessionPersistence: { backend: 'default' },
      sessionQuery: {
        ...(query.metadata === undefined ? {} : { observeSessionMetadata: query.metadata }),
        ...(query.window === undefined ? {} : { readWindow: query.window }),
        ...(query.observe === undefined ? {} : { observeSession: query.observe }),
      },
    }, { sessionProjections: { stateOf: () => undefined } })
    watchDetailChannel(fake.ctx, BOUNDS, undefined, undefined, undefined, COST)
    return fake.captured
  }

  test('a cost source rides the head, window and full cold payloads', async () => {
    const head = headViewOf(LOG)
    const headRoute = costCtx({ metadata: async () => ({ header: headerOfLog(), projections: { values: { contextTimeline: head } } }) })
    const headValue = (await call(headRoute, { sessionId: 'cold1', head: true })).value as { head: { costRead?: unknown } }
    assert.deepEqual(headValue.head.costRead, { usd: 0.5, ready: true })

    const windowRoute = costCtx({
      metadata: async () => ({ header: headerOfLog() }),
      window: async () => ({ window: { events: LOG, hasMore: false } }),
    })
    const windowValue = (await call(windowRoute, { sessionId: 'cold1' })).value as { head: { costRead?: unknown } }
    assert.deepEqual(windowValue.head.costRead, { usd: 0.5, ready: true })

    const fullRoute = costCtx({
      metadata: async () => ({ header: headerOfLog() }),
      observe: async () => ({ revision: 'rev-1', events: LOG, [Symbol.dispose]: () => {} }),
    })
    const fullValue = (await call(fullRoute, { sessionId: 'cold1', full: true })).value as { head: { costRead?: unknown } }
    assert.deepEqual(fullValue.head.costRead, { usd: 0.5, ready: true })
  })

  test('a long window and a long full log yield between fold chunks', async () => {
    const events = manyEvents(1_200)
    const windowRoute = costCtx({
      metadata: async () => ({ header: headerOfLog() }),
      window: async () => ({ window: { events, hasMore: true } }),
    })
    const windowValue = (await call(windowRoute, { sessionId: 'cold1' })).value as { requests: unknown[]; partial?: unknown }
    assert.ok(windowValue.requests.length > 0)
    assert.deepEqual(windowValue.partial, { fromSeq: 1 })

    const fullRoute = costCtx({
      metadata: async () => ({ header: headerOfLog() }),
      observe: async () => ({ revision: 'rev-long', events, [Symbol.dispose]: () => {} }),
    })
    const fullValue = (await call(fullRoute, { sessionId: 'cold1', full: true })).value as { requests: unknown[] }
    assert.ok(fullValue.requests.length > 0)
  })
})
describe('the cold detail route — the full fold stops on cancellation', () => {
  test('an abort raised while the whole log folds serves the aborted envelope', async () => {
    const controller = new AbortController()
    const events = manyEvents(1_200)
    const aborting = new Proxy(events, {
      get(target, property, receiver) {
        if (property === '1001') controller.abort()
        return Reflect.get(target, property, receiver)
      },
    })
    const fake = fakeCtx({
      connection: connectionOf(),
      sessions: { get: () => undefined },
      sessionPersistence: { backend: 'default' },
      sessionQuery: {
        observeSessionMetadata: async () => ({ header: headerOfLog() }),
        observeSession: async () => ({ revision: 'rev-abort', events: aborting, [Symbol.dispose]: () => {} }),
      },
    }, { sessionProjections: { stateOf: () => undefined } })
    watchDetailChannel(fake.ctx, BOUNDS)
    const request = new Request('http://dsh.test' + DETAIL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cold1', full: true }),
      signal: controller.signal,
    })
    const body = await (await fake.captured.fetch!(request)).json() as { ok: boolean; error?: { code: string } }
    assert.equal(body.ok, false)
    assert.equal(body.error?.code, 'dsh-context/aborted')
    fake.dispose()
  })
})
