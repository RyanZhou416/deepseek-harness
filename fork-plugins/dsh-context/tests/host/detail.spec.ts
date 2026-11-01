import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DETAIL_ROUTE, watchDetailChannel } from '../../src/host/detail'
import { resolveBounds } from '../../src/host/config'
import type { TimelineState } from '../../src/host/fold'
import { buildTimelineDetail, buildTimelineHead } from '../../src/host/foldWire'
import { TIMELINE_STATE_VERSION } from '../../src/host/timeline'
import type { TimelineEvent } from '../../src/host/foldState'
import { assistantMessage, header, userMessage } from './helpers/events'
import { driveTimeline } from './helpers/projection'

const BOUNDS = resolveBounds({})

type RouteFetch = (request: Request) => Promise<Response>

interface CtxSpec {
  connection?: unknown
  sessions?: unknown
  sessionQuery?: unknown
  sessionPersistence?: unknown
  storageDomain?: unknown
  stateOf?: (session: unknown, key: string) => unknown
}

function ctxOf(spec: CtxSpec): { ctx: Context; captured: { path?: string; fetch?: RouteFetch }; disposers: (() => void)[] } {
  const captured: { path?: string; fetch?: RouteFetch } = {}
  const disposers: (() => void)[] = []
  const services = new Map<string, unknown>()
  if ('connection' in spec) services.set('connection', spec.connection)
  if ('sessions' in spec) services.set('sessions', spec.sessions)
  if ('sessionQuery' in spec) services.set('sessionQuery', spec.sessionQuery)
  if ('sessionPersistence' in spec) services.set('sessionPersistence', spec.sessionPersistence)
  if ('storageDomain' in spec) services.set('storageDomain', spec.storageDomain)
  const ctx = {
    get: (name: string) => services.get(name),
    sessionProjections: { stateOf: spec.stateOf ?? (() => undefined) },
    effect(fn: () => unknown, _label?: string) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
      return () => {}
    },
    inject(deps: string[], cb: (c: unknown) => unknown) {
      if (!deps.every(d => services.has(d))) return
      const d = cb(ctx)
      if (typeof d === 'function') disposers.push(d as () => void)
    },
  }
  if (spec.connection !== undefined && spec.connection !== null) {
    const conn = spec.connection as { fetch?: { register?: unknown } }
    if (typeof conn.fetch?.register === 'function') {
      conn.fetch.register = (route: { path: string; fetch: RouteFetch }) => {
        captured.path = route.path
        captured.fetch = route.fetch
        return () => {}
      }
    }
  }
  return { ctx: ctx as unknown as Context, captured, disposers }
}

async function call(captured: { fetch?: RouteFetch }, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const request = new Request(`http://dsh.test${DETAIL_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  })
  const response = await captured.fetch!(request)
  return await response.json() as Record<string, unknown>
}

async function callRaw(captured: { fetch?: RouteFetch }, body: string): Promise<Record<string, unknown>> {
  const request = new Request(`http://dsh.test${DETAIL_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  return await captured.fetch!(request).then(r => r.json()) as Record<string, unknown>
}

function sessionsWith(session: unknown): { get(id: string): unknown } {
  return { get: (id: string) => (id === 's1' ? session : undefined) }
}

function okSession(): object {
  return { id: 's1' }
}

const HEADER = { id: 's1', version: 4, createdAt: 1_000, cwd: '/w', isSeeded: false, title: 'stored' }

function metadataOf(head: unknown, headerFields: Record<string, unknown> = HEADER): unknown {
  return {
    header: headerFields,
    ...(head === undefined ? {} : { projections: { asOfSeq: 9, values: { contextTimeline: head } } }),
  }
}

function recordOf(state: TimelineState, overrides: {
  identity?: Record<string, unknown>
  row?: Record<string, unknown>
  rows?: Record<string, unknown>
} = {}): unknown {
  return {
    identity: {
      formatVersion: 4,
      createdAt: 1_000,
      cwd: '/w',
      isSeeded: false,
      inheritedEventCount: 0,
      ...overrides.identity,
    },
    rows: overrides.rows ?? {
      contextTimeline: {
        ver: TIMELINE_STATE_VERSION,
        seq: 9,
        val: JSON.parse(JSON.stringify(state)) as unknown,
        ...overrides.row,
      },
    },
  }
}

function storageOf(record: unknown, mode: 'ok' | 'get-throws' | 'table-throws' | 'row-throws' | 'wrong-domain' | 'wrong-table' = 'ok'): unknown {
  return {
    get(name: string) {
      if (mode === 'get-throws') throw new Error('hostile domain')
      if (mode === 'wrong-domain' || name !== 'session_projcache') return undefined
      return {
        table(table: string) {
          if (mode === 'table-throws') throw new Error('hostile table')
          if (mode === 'wrong-table' || table !== 'sessions') return undefined
          return {
            get(key: string) {
              if (mode === 'row-throws') throw new Error('hostile record')
              return key === 's1' ? record : undefined
            },
          }
        },
      }
    },
  }
}

const EVENTS: TimelineEvent[] = [
  header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' }),
  userMessage(2, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
  assistantMessage(3, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5 } }),
]

interface ColdSpec {
  observe?: (id: string, options: unknown) => Promise<unknown>
  observeMetadata?: (id: string, options: unknown) => Promise<unknown>
  readWindow?: (id: string, options: unknown) => Promise<unknown>
  storageDomain?: unknown
  persistence?: unknown
}

function coldCtx(spec: ColdSpec): { ctx: Context; captured: { fetch?: RouteFetch }; counts: { observe: number; metadata: number; window: number } } {
  const counts = { observe: 0, metadata: 0, window: 0 }
  const query: Record<string, unknown> = {}
  if (spec.observe !== undefined) {
    query.observeSession = (id: string, options: unknown) => {
      counts.observe++
      return spec.observe!(id, options)
    }
  }
  if (spec.observeMetadata !== undefined) {
    query.observeSessionMetadata = (id: string, options: unknown) => {
      counts.metadata++
      return spec.observeMetadata!(id, options)
    }
  }
  if (spec.readWindow !== undefined) {
    query.readWindow = (id: string, options: unknown) => {
      counts.window++
      return spec.readWindow!(id, options)
    }
  }
  const made = ctxOf({
    connection: { fetch: { register: () => () => {} } },
    sessions: { get: () => undefined },
    stateOf: () => undefined,
    sessionQuery: query,
    sessionPersistence: spec.persistence ?? { backend: 'default' },
    ...(spec.storageDomain === undefined ? {} : { storageDomain: spec.storageDomain }),
  })
  return { ...made, counts }
}

describe('watchDetailChannel gating', () => {
  test('the gate stays closed without the connection or sessions service, and a rejecting registry keeps it closed', () => {
    assert.equal(watchDetailChannel(ctxOf({}).ctx, BOUNDS).live, false)
    assert.equal(watchDetailChannel(ctxOf({ sessions: sessionsWith(okSession()) }).ctx, BOUNDS).live, false)
    const connOnly = ctxOf({ connection: { fetch: { register: () => () => {} } } })
    assert.equal(watchDetailChannel(connOnly.ctx, BOUNDS).live, false)
    assert.equal(watchDetailChannel(ctxOf({ connection: { fetch: {} }, sessions: sessionsWith(okSession()) }).ctx, BOUNDS).live, false)
    assert.equal(watchDetailChannel(ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: { get: 42 },
    }).ctx, BOUNDS).live, false)
    const rejecting = {
      get: (name: string) =>
        name === 'connection'
          ? { fetch: { register: () => { throw new Error('registration rejected') } } }
          : name === 'sessions'
            ? sessionsWith(okSession())
            : undefined,
      sessionProjections: { stateOf: () => undefined },
      effect(fn: () => unknown) {
        fn()
        return () => {}
      },
      inject(deps: string[], cb: (c: unknown) => unknown) {
        if (deps.every(d => (d === 'connection' || d === 'sessions'))) cb(rejecting)
      },
    }
    assert.equal(watchDetailChannel(rejecting as unknown as Context, BOUNDS).live, false, 'a rejecting registry keeps the gate closed')
  })

  test('the gate opens on registration and closes on unload', () => {
    const { ctx, captured, disposers } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
    })
    const gate = watchDetailChannel(ctx, BOUNDS)
    assert.equal(gate.live, true)
    assert.equal(captured.path, '/api/dsh-context/detail')
    for (const d of disposers) d()
    assert.equal(gate.live, false)
  })
})

describe('the detail route', () => {
  function liveCtx(state: TimelineState | undefined): { ctx: Context; captured: { fetch?: RouteFetch } } {
    return ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => state,
    })
  }

  test('bad payloads fail with typed envelopes', async () => {
    const { ctx, captured } = liveCtx(undefined)
    watchDetailChannel(ctx, BOUNDS)
    for (const body of [null, 42, {}, { sessionId: 42 }, { sessionId: '' }]) {
      const result = await call(captured, body) as { ok: boolean; error?: { code: string } }
      assert.equal(result.ok, false, `payload ${JSON.stringify(body)} rejected`)
      assert.equal(result.error?.code, 'dsh-context/bad-request')
    }
    const raw = await callRaw(captured, 'not json') as { ok: boolean; error?: { code: string } }
    assert.equal(raw.ok, false)
    assert.equal(raw.error?.code, 'dsh-context/bad-request')
  })

  test('a session outside the live set and an absent unit state both resolve to the typed null', async () => {
    const { state } = driveTimeline([userMessage(1, [{ type: 'text', text: 'hi' }], { kind: 'user' })])
    const { ctx, captured } = liveCtx(state)
    watchDetailChannel(ctx, BOUNDS)
    assert.deepEqual(await call(captured, { sessionId: 'gone' }), { ok: true, value: null })
    const absent = liveCtx(undefined)
    watchDetailChannel(absent.ctx, BOUNDS)
    assert.deepEqual(await call(absent.captured, { sessionId: 's1' }), { ok: true, value: null })
  })

  test('a cold detail is served from the persisted projection checkpoint without reading the log', async () => {
    const { state } = driveTimeline(EVENTS)
    const { ctx, captured, counts } = coldCtx({
      observeMetadata: () => Promise.resolve(metadataOf(buildTimelineHead(state))),
      observe: () => Promise.reject(new Error('the log must not be observed')),
      readWindow: () => Promise.reject(new Error('no window read either')),
      storageDomain: storageOf(recordOf(state)),
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 's1' }) as { ok: boolean; value: unknown }
    assert.equal(result.ok, true)
    assert.deepStrictEqual(result.value, buildTimelineDetail(state, BOUNDS), 'the payload equals a full fold of the same state')
    assert.deepEqual(counts, { observe: 0, metadata: 1, window: 0 }, 'one metadata stat, zero log reads')
  })

  test('a checkpoint that fails its lifecycle, version, or schema gate is ignored', async () => {
    const { state } = driveTimeline(EVENTS)
    const bad: unknown[] = [
      recordOf(state, { identity: { formatVersion: 5 } }),
      recordOf(state, { identity: { createdAt: 2_000 } }),
      recordOf(state, { identity: { cwd: '/other' } }),
      recordOf(state, { identity: { isSeeded: true } }),
      recordOf(state, { identity: { inheritedEventCount: 2 } }),
      recordOf(state, { rows: {} }),
      recordOf(state, { row: { ver: TIMELINE_STATE_VERSION + 1 } }),
      recordOf(state, { rows: { contextTimeline: { ver: TIMELINE_STATE_VERSION, seq: 9, val: { requests: null } } } }),
      {},
    ]
    for (const record of bad) {
      const { ctx, captured } = coldCtx({
        observeMetadata: () => Promise.resolve(metadataOf(buildTimelineHead(state))),
        storageDomain: storageOf(record),
      })
      watchDetailChannel(ctx, BOUNDS)
      assert.deepEqual(await call(captured, { sessionId: 's1' }), { ok: true, value: null }, JSON.stringify(record).slice(0, 80))
    }
  })

  test('a malformed metadata header never reaches the checkpoint', async () => {
    const { state } = driveTimeline(EVENTS)
    for (const meta of [null, {}, { header: null }, { header: { version: '4', createdAt: 1 } }]) {
      const { ctx, captured, counts } = coldCtx({
        observeMetadata: () => Promise.resolve(meta),
        storageDomain: storageOf(recordOf(state)),
      })
      watchDetailChannel(ctx, BOUNDS)
      assert.deepEqual(await call(captured, { sessionId: 's1' }), { ok: true, value: null })
      assert.equal(counts.metadata, 1)
    }
  })

  test('a hostile or unbound storage domain degrades to the bounded window', async () => {
    const { state } = driveTimeline(EVENTS)
    for (const mode of ['get-throws', 'table-throws', 'row-throws', 'wrong-domain', 'wrong-table'] as const) {
      const { ctx, captured, counts } = coldCtx({
        observeMetadata: () => Promise.resolve(metadataOf(buildTimelineHead(state))),
        readWindow: () => Promise.resolve({ window: { events: EVENTS, hasMore: false } }),
        storageDomain: storageOf(recordOf(state), mode),
      })
      watchDetailChannel(ctx, BOUNDS)
      const result = await call(captured, { sessionId: 's1' }) as { ok: boolean; value: { requests: unknown[] } | null }
      assert.equal(result.ok, true)
      assert.equal(result.value?.requests.length, 1, `${mode}: the window folded`)
      assert.equal(counts.window, 1)
    }
  })

  test('a missing checkpoint falls back to a bounded tail window and marks the loaded cut', async () => {
    const { state } = driveTimeline(EVENTS)
    const tail = [userMessage(2, [{ type: 'text', text: 'hi' }], { kind: 'user' }), assistantMessage(3, { turn: 1, step: 0 })]
    let seen: unknown
    const { ctx, captured, counts } = coldCtx({
      observeMetadata: () => Promise.resolve(metadataOf(buildTimelineHead(state))),
      readWindow: (_id, options) => {
        seen = options
        return Promise.resolve({ window: { events: tail, hasMore: true, cursor: 3 } })
      },
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 's1' }) as {
      ok: boolean
      value: { requests: unknown[]; head: unknown; partial?: { fromSeq: number } } | null
    }
    assert.equal(result.ok, true)
    assert.ok(result.value !== null)
    assert.equal(result.value.requests.length, 1, 'the bounded window folded')
    assert.deepStrictEqual(result.value.head, buildTimelineHead(state), 'the cached head rides the window fold')
    assert.deepEqual(result.value.partial, { fromSeq: 2 }, 'history below the window is marked unloaded')
    assert.ok(seen !== null && typeof seen === 'object')
    const seenOptions = seen as { signal: AbortSignal; maxEvents: number }
    assert.ok(seenOptions.signal instanceof AbortSignal && !seenOptions.signal.aborted, 'the read carries the request signal')
    assert.equal(seenOptions.maxEvents, 400, 'the window is bounded')
    assert.deepEqual(counts, { observe: 0, metadata: 1, window: 1 }, 'no full-log observation')
  })

  test('a complete window and an unknown first seq are not marked partial', async () => {
    const windowCtx = coldCtx({
      observeMetadata: () => Promise.resolve({}),
      readWindow: () => Promise.resolve({ window: { events: EVENTS, hasMore: false } }),
    })
    watchDetailChannel(windowCtx.ctx, BOUNDS)
    const complete = await call(windowCtx.captured, { sessionId: 's1' }) as { value: { partial?: unknown; head?: unknown } | null }
    assert.equal(complete.value?.partial, undefined)
    assert.deepStrictEqual(complete.value?.head, buildTimelineHead(driveTimeline(EVENTS).state), 'the window fold supplies its own head')

    const unsequenced = coldCtx({
      observeMetadata: () => Promise.resolve({}),
      readWindow: () => Promise.resolve({ window: { events: [{ type: 'unknown' }], hasMore: true } }),
    })
    watchDetailChannel(unsequenced.ctx, BOUNDS)
    const anonymous = await call(unsequenced.captured, { sessionId: 's1' }) as { value: { partial?: unknown } | null }
    assert.equal(anonymous.value?.partial, undefined, 'no seq means no floor to publish')
  })

  test('an unusable or rejecting window read answers the typed null', async () => {
    const forms: (() => Promise<unknown>)[] = [
      () => Promise.resolve(undefined),
      () => Promise.resolve({}),
      () => Promise.resolve({ window: null }),
      () => Promise.resolve({ window: { events: 'nope' } }),
      () => Promise.reject(new Error('persistence down')),
    ]
    for (const readWindow of forms) {
      const { ctx, captured } = coldCtx({ observeMetadata: () => Promise.resolve({}), readWindow })
      watchDetailChannel(ctx, BOUNDS)
      assert.deepEqual(await call(captured, { sessionId: 's1' }), { ok: true, value: null })
    }
    const without = coldCtx({ observeMetadata: () => Promise.resolve({}) })
    watchDetailChannel(without.ctx, BOUNDS)
    assert.deepEqual(await call(without.captured, { sessionId: 's1' }), { ok: true, value: null })

    const legacy = coldCtx({ observe: () => Promise.resolve({ events: EVENTS }) })
    watchDetailChannel(legacy.ctx, BOUNDS)
    const old = await call(legacy.captured, { sessionId: 's1' }) as { ok: boolean; value: { requests: unknown[] } | null }
    assert.equal(old.ok, true)
    assert.equal(old.value?.requests.length, 1, 'a host without the log-free rungs keeps the legacy fold')
    assert.deepEqual(legacy.counts, { observe: 1, metadata: 0, window: 0 })
  })

  test('a head read serves the cached envelope with no log read', async () => {
    const { state } = driveTimeline(EVENTS)
    const { ctx, captured, counts } = coldCtx({
      observeMetadata: () => Promise.resolve(metadataOf(buildTimelineHead(state))),
      observe: () => Promise.reject(new Error('never')),
      readWindow: () => Promise.reject(new Error('never')),
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 's1', head: true }) as { ok: boolean; value: { rev: number; head: unknown } | null }
    assert.equal(result.ok, true)
    assert.equal(result.value?.rev, 2)
    assert.deepStrictEqual(result.value?.head, buildTimelineHead(state))
    assert.deepEqual(counts, { observe: 0, metadata: 1, window: 0 })

    const absent = coldCtx({ observeMetadata: () => Promise.resolve(metadataOf(undefined)) })
    watchDetailChannel(absent.ctx, BOUNDS)
    assert.deepEqual(await call(absent.captured, { sessionId: 's1', head: true }), { ok: true, value: null })
  })

  test('a metadata read without a header never reaches the checkpoint', async () => {
    const { state } = driveTimeline(EVENTS)
    const { ctx, captured } = coldCtx({
      observeMetadata: () => Promise.resolve({ header: { version: 4 } }),
      storageDomain: storageOf(recordOf(state)),
    })
    watchDetailChannel(ctx, BOUNDS)
    assert.deepEqual(await call(captured, { sessionId: 's1' }), { ok: true, value: null })
  })

  test('an absent session (metadata rejects) answers the typed null', async () => {
    const { ctx, captured } = coldCtx({
      observeMetadata: () => Promise.reject(new Error('SESSION_QUERY_SESSION_NOT_FOUND')),
    })
    watchDetailChannel(ctx, BOUNDS)
    assert.deepEqual(await call(captured, { sessionId: 'gone' }), { ok: true, value: null })
  })

  test('an aborted request answers the abort envelope before and during the read', async () => {
    const pre = coldCtx({ observeMetadata: () => Promise.resolve({}) })
    watchDetailChannel(pre.ctx, BOUNDS)
    const controller = new AbortController()
    controller.abort()
    const early = await call(pre.captured, { sessionId: 's1' }, controller.signal) as { ok: boolean; error: { code: string } }
    assert.equal(early.ok, false)
    assert.equal(early.error.code, 'dsh-context/aborted')

    const mid = new AbortController()
    const during = coldCtx({
      observeMetadata: () => Promise.resolve({}),
      readWindow: () => {
        mid.abort()
        return Promise.resolve({ window: { events: EVENTS, hasMore: false } })
      },
    })
    watchDetailChannel(during.ctx, BOUNDS)
    const aborted = await call(during.captured, { sessionId: 's1' }, mid.signal) as { ok: boolean; error: { code: string } }
    assert.equal(aborted.ok, false)
    assert.equal(aborted.error.code, 'dsh-context/aborted')

    const folded = new AbortController()
    const hostile = {
      *[Symbol.iterator](): Iterator<TimelineEvent> {
        folded.abort()
        yield EVENTS[0]
      },
    }
    const inFold = coldCtx({
      observeMetadata: () => Promise.resolve({}),
      readWindow: () => Promise.resolve({
        window: {
          events: new Proxy(EVENTS, {
            get(target, prop, receiver) {
              if (prop === Symbol.iterator) return hostile[Symbol.iterator].bind(hostile)
              return Reflect.get(target, prop, receiver) as unknown
            },
          }),
          hasMore: false,
        },
      }),
    })
    watchDetailChannel(inFold.ctx, BOUNDS)
    const duringFold = await call(inFold.captured, { sessionId: 's1' }, folded.signal) as { ok: boolean; error: { code: string } }
    assert.equal(duringFold.ok, false)
    assert.equal(duringFold.error.code, 'dsh-context/aborted')
  })

  test('a metadata read that rejects later still falls through to the window', async () => {
    const { ctx, captured } = coldCtx({
      observeMetadata: () => Promise.reject(new Error('stat failed')),
      readWindow: () => Promise.resolve({ window: { events: EVENTS, hasMore: false } }),
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 's1' }) as { ok: boolean; value: { requests: unknown[] } | null }
    assert.equal(result.ok, true)
    assert.equal(result.value?.requests.length, 1)
  })

  test('a full request folds the complete observed log once and caches it by revision', async () => {
    let disposed = 0
    let observedOptions: unknown
    let reads = 0
    const { ctx, captured, counts } = coldCtx({
      observe: (_id, options) => {
        observedOptions = options
        return Promise.resolve({
          revision: 'dev:ino:100:42:42',
          get events() {
            reads++
            return EVENTS
          },
          [Symbol.dispose]: () => { disposed++ },
        })
      },
    })
    watchDetailChannel(ctx, BOUNDS)
    const first = await call(captured, { sessionId: 's1', full: true }) as { ok: boolean; value: { requests: unknown[]; nodes: unknown[] } | null }
    assert.equal(first.ok, true)
    assert.equal(first.value?.requests.length, 1, 'the observed log folded')
    assert.equal(first.value?.nodes.length, 2)
    const options = observedOptions as { projectionMode: string; signal: AbortSignal }
    assert.equal(options.projectionMode, 'none', 'the observation skips projection work')
    assert.ok(options.signal instanceof AbortSignal, 'the observation carries cancellation')
    assert.equal(disposed, 1, 'the observation lease disposed after the fold')
    const second = await call(captured, { sessionId: 's1', full: true }) as { ok: boolean; value: unknown }
    assert.deepEqual(second, first, 'the unchanged revision re-serves the payload')
    assert.equal(reads, 1, 'the second read never touched the log')
    assert.equal(counts.observe, 2, 'both requests observed (the second hit the revision cache)')

    const bare = coldCtx({
      observe: () => Promise.resolve({ events: [EVENTS[1]] }),
    })
    watchDetailChannel(bare.ctx, BOUNDS)
    const bareResult = await call(bare.captured, { sessionId: 's1', full: true }) as { ok: boolean; value: { nodes: unknown[] } | null }
    assert.equal(bareResult.ok, true)
    assert.equal(bareResult.value?.nodes.length, 1, 'an observation without a dispose face still serves')
  })

  test('a full request without the observe face, or with a hostile read, degrades cleanly', async () => {
    const noFace = coldCtx({ observeMetadata: () => Promise.resolve({}) })
    watchDetailChannel(noFace.ctx, BOUNDS)
    assert.deepEqual(await call(noFace.captured, { sessionId: 's1', full: true }), { ok: true, value: null })

    const noEvents = coldCtx({ observe: () => Promise.resolve({}) })
    watchDetailChannel(noEvents.ctx, BOUNDS)
    assert.deepEqual(await call(noEvents.captured, { sessionId: 's1', full: true }), { ok: true, value: null })

    const rejecting = coldCtx({ observe: () => Promise.reject(new Error('persistence down')) })
    watchDetailChannel(rejecting.ctx, BOUNDS)
    const result = await call(rejecting.captured, { sessionId: 's1', full: true }) as { ok: boolean; error: { code: string; message: string } }
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'gateway/internal')
    assert.equal(result.error.message, 'persistence down')

    const unkeyed = coldCtx({ observe: () => Promise.resolve({ revision: '', events: EVENTS, [Symbol.dispose]: () => {} }) })
    watchDetailChannel(unkeyed.ctx, BOUNDS)
    const once = await call(unkeyed.captured, { sessionId: 's1', full: true }) as { ok: boolean; value: unknown }
    const twice = await call(unkeyed.captured, { sessionId: 's1', full: true }) as { ok: boolean; value: unknown }
    assert.deepEqual(once, twice, 'an empty revision never keys a stale cache')
  })

  test('the cold-read gate applies to the full fold only', async () => {
    let admitted = 0
    const gated = coldCtx({ observe: () => Promise.resolve({ events: EVENTS }) })
    watchDetailChannel(gated.ctx, BOUNDS, {
      admit: <T>(_read: () => Promise<T>): Promise<T | undefined> => {
        admitted++
        return Promise.resolve(undefined)
      },
    })
    assert.deepEqual(await call(gated.captured, { sessionId: 's1', full: true }), { ok: true, value: null })
    assert.equal(admitted, 1, 'the full read went through the gate')

    const windowed = coldCtx({
      observeMetadata: () => Promise.resolve({}),
      readWindow: () => Promise.resolve({ window: { events: EVENTS, hasMore: false } }),
    })
    let skipped = 0
    watchDetailChannel(windowed.ctx, BOUNDS, {
      admit: () => { skipped++; return Promise.reject(new Error('the gate must not see a bounded read')) },
    })
    const result = await call(windowed.captured, { sessionId: 's1' }) as { ok: boolean; value: unknown }
    assert.equal(result.ok, true)
    assert.ok(result.value !== null)
    assert.equal(skipped, 0, 'the bounded window needs no heap governor')
  })

  test('serves the fold state\'s detail payload with its revision', async () => {
    const { state } = driveTimeline(EVENTS)
    const { ctx, captured } = liveCtx(state)
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 's1' }) as { ok: true; value: { rev: number; requests: unknown[]; nodes: unknown[]; head: { current: { total: number } } } }
    assert.equal(result.ok, true)
    assert.equal(result.value.rev, 2, 'two detail-mutating folds')
    assert.equal(result.value.requests.length, 1)
    assert.equal(result.value.nodes.length, 2)
    assert.ok(result.value.head.current.total > 0, 'the slim head rides the live read too')
  })

  test('a head read serves the envelope only, live and cold', async () => {
    const { state } = driveTimeline(EVENTS)
    const live = liveCtx(state)
    watchDetailChannel(live.ctx, BOUNDS)
    const liveHead = await call(live.captured, { sessionId: 's1', head: true }) as { ok: true; value: { rev: number; head: { current: { total: number } }; requests?: unknown } }
    assert.equal(liveHead.ok, true)
    assert.equal(liveHead.value.rev, 2)
    assert.ok(liveHead.value.head.current.total > 0)
    assert.equal(liveHead.value.requests, undefined, 'the collections never ride a head read')

    const fresh = liveCtx(driveTimeline([header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' })]).state)
    watchDetailChannel(fresh.ctx, BOUNDS)
    const freshHead = await call(fresh.captured, { sessionId: 's1', head: true }) as { ok: true; value: { rev: number; head: { model?: unknown } } }
    assert.equal(freshHead.value.rev, 0)
    assert.equal(freshHead.value.head.model, 'deepseek-v4-flash')
  })

  test('hostile reads degrade to the failure envelope, never a throw', async () => {
    const throwingGet = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: {
        get: () => {
          throw new Error('hostile sessions')
        },
      },
    })
    watchDetailChannel(throwingGet.ctx, BOUNDS)
    const r1 = await call(throwingGet.captured, { sessionId: 's1' }) as { ok: boolean; error: { code: string; message: string } }
    assert.equal(r1.ok, false)
    assert.equal(r1.error.code, 'gateway/internal')
    assert.equal(r1.error.message, 'hostile sessions')
    const throwingState = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => {
        throw new Error('hostile registry')
      },
    })
    watchDetailChannel(throwingState.ctx, BOUNDS)
    const r2 = await call(throwingState.captured, { sessionId: 's1' }) as { ok: boolean; error: { message: string } }
    assert.equal(r2.ok, false)
    assert.equal(r2.error.message, 'hostile registry')

    const junkState = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => ({ requests: null }),
    })
    watchDetailChannel(junkState.ctx, BOUNDS)
    const r3 = await call(junkState.captured, { sessionId: 's1' }) as { ok: boolean }
    assert.equal(r3.ok, false)

    const stringThrow = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: {
        get: () => {
          throw 'string boom'
        },
      },
    })
    watchDetailChannel(stringThrow.ctx, BOUNDS)
    const r4 = await call(stringThrow.captured, { sessionId: 's1' }) as { ok: boolean; error: { message: string } }
    assert.equal(r4.ok, false)
    assert.equal(r4.error.message, 'string boom')
  })
})

describe('the full fold (issue #145)', () => {
  function manyEvents(count: number): TimelineEvent[] {
    const events: TimelineEvent[] = [header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' })]
    for (let seq = 2; seq <= count; seq++) {
      events.push(seq % 2 === 0
        ? userMessage(seq, [{ type: 'text', text: `question ${seq}` }], { kind: 'user' })
        : assistantMessage(seq, { turn: seq, step: seq, usage: { inputTokens: 10, outputTokens: 5 } }))
    }
    return events
  }

  test('a monster log folds to the byte-identical detail, yielding to the event loop per chunk', async () => {
    const events = manyEvents(2_001)
    const { ctx, captured } = coldCtx({ observe: () => Promise.resolve({ events, [Symbol.dispose]: () => {} }) })
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      watchDetailChannel(ctx, BOUNDS)
      const result = await call(captured, { sessionId: 's1', full: true }) as { ok: boolean; value: unknown }
      assert.equal(result.ok, true)
      const reference = buildTimelineDetail(driveTimeline(events).state, BOUNDS)
      assert.deepStrictEqual(result.value, reference, 'the yielding fold produces the identical payload')
      const yields = timerSpy.mock.calls.filter(args => args[1] === 0).length
      assert.equal(yields, 2, 'two macrotask yields across 2,001 events')
    } finally {
      timerSpy.mockRestore()
    }
  })

  test('a changed revision refolds; a swapped persistence instance never aliases a stale payload', async () => {
    const events = manyEvents(5)
    let eventReads = 0
    let revision: string | undefined = 'r1'
    const observe = (): Promise<unknown> => Promise.resolve({
      get revision() { return revision },
      get events() {
        eventReads++
        return events
      },
      [Symbol.dispose]: () => {},
    })
    const first = coldCtx({ observe: () => observe() })
    watchDetailChannel(first.ctx, BOUNDS)
    await call(first.captured, { sessionId: 's1', full: true })
    revision = 'r2'
    await call(first.captured, { sessionId: 's1', full: true })
    assert.equal(eventReads, 2, 'the changed log refolded instead of serving stale data')

    const swapped = coldCtx({ observe: () => observe(), persistence: { backend: 'two' } })
    watchDetailChannel(swapped.ctx, BOUNDS)
    await call(swapped.captured, { sessionId: 's1', full: true })
    assert.equal(eventReads, 3, 'a replaced persistence invalidates every cached payload (the dsh trust tuple)')
  })

  test('the cache holds four sessions; the evicted oldest refolds, the kept newest re-serves', async () => {
    const reads = new Map<string, number>()
    const { ctx, captured } = coldCtx({
      observe: (id) => Promise.resolve({
        revision: `r-${id}`,
        get events() {
          reads.set(id, (reads.get(id) ?? 0) + 1)
          return manyEvents(5)
        },
        [Symbol.dispose]: () => {},
      }),
    })
    watchDetailChannel(ctx, BOUNDS)
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) await call(captured, { sessionId: id, full: true })
    assert.deepEqual([...reads.values()], [1, 1, 1, 1, 1], 'every first read folded')
    await call(captured, { sessionId: 'c5', full: true })
    assert.equal(reads.get('c5'), 1, 'the newest entry survived eviction')
    await call(captured, { sessionId: 'c1', full: true })
    assert.equal(reads.get('c1'), 2, 'the evicted oldest refolded on its next read')
  })

  test('a remount never aliases the previous route\'s cache', async () => {
    const events = manyEvents(5)
    let remountReads = 0
    const { ctx, captured } = coldCtx({
      observe: () => Promise.resolve({
        revision: 'r1',
        get events() {
          remountReads++
          return events
        },
        [Symbol.dispose]: () => {},
      }),
    })
    watchDetailChannel(ctx, BOUNDS)
    await call(captured, { sessionId: 's1', full: true })
    watchDetailChannel(ctx, BOUNDS)
    await call(captured, { sessionId: 's1', full: true })
    assert.equal(remountReads, 2, 'the remounted route folds against its own cache')
  })
})

describe('the detail route cancellation and absent services', () => {
  test('a host without the sessionQuery service answers the typed null', async () => {
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: { get: () => undefined },
    })
    watchDetailChannel(ctx, BOUNDS)
    assert.deepEqual(await call(captured, { sessionId: 's1' }), { ok: true, value: null })
  })

  test('a window read that rejects after the client left answers the abort envelope', async () => {
    const controller = new AbortController()
    const { ctx, captured } = coldCtx({
      observeMetadata: () => Promise.resolve({}),
      readWindow: () => {
        controller.abort()
        return Promise.reject(new Error('cancelled'))
      },
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 's1' }, controller.signal) as { ok: boolean; error: { code: string } }
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'dsh-context/aborted')
  })

  test('a cancelled full fold answers the abort envelope', async () => {
    const controller = new AbortController()
    const hostile = {
      *[Symbol.iterator](): Iterator<TimelineEvent> {
        controller.abort()
        yield EVENTS[0]
      },
    }
    const { ctx, captured } = coldCtx({
      observe: () => Promise.resolve({
        events: new Proxy(EVENTS, {
          get(target, prop, receiver) {
            if (prop === Symbol.iterator) return hostile[Symbol.iterator].bind(hostile)
            return Reflect.get(target, prop, receiver) as unknown
          },
        }),
        [Symbol.dispose]: () => {},
      }),
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 's1', full: true }, controller.signal) as { ok: boolean; error: { code: string } }
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'dsh-context/aborted')
  })

  test('a throwing live read after the client left answers the abort envelope', async () => {
    const controller = new AbortController()
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: {
        get: () => {
          controller.abort()
          throw new Error('hostile sessions')
        },
      },
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 's1' }, controller.signal) as { ok: boolean; error: { code: string } }
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'dsh-context/aborted')
  })
})

describe('the detail route edge inputs', () => {
  test('a cached head without a revision serves revision zero', async () => {
    const { ctx, captured } = coldCtx({
      observeMetadata: () => Promise.resolve(metadataOf({ ok: true, model: 'm' })),
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 's1', head: true }) as { ok: boolean; value: { rev: number; head: { model?: unknown } } | null }
    assert.equal(result.value?.rev, 0)
    assert.equal(result.value?.head.model, 'm')
  })

  test('a metadata block without a usable timeline value serves the typed null', async () => {
    const states: unknown[] = [
      { header: HEADER, projections: { asOfSeq: 1, values: {} } },
      { header: HEADER, projections: { asOfSeq: 1, values: { contextTimeline: 42 } } },
      { header: HEADER, projections: null },
    ]
    for (const metadata of states) {
      const { ctx, captured } = coldCtx({ observeMetadata: () => Promise.resolve(metadata) })
      watchDetailChannel(ctx, BOUNDS)
      assert.deepEqual(await call(captured, { sessionId: 's1', head: true }), { ok: true, value: null })
    }
  })

  test('absent lineage fields read as the unseeded lineage', async () => {
    const { state } = driveTimeline(EVENTS)
    const record = recordOf(state, { identity: { isSeeded: undefined, inheritedEventCount: undefined } })
    const header = { id: 's1', version: 4, createdAt: 1_000, cwd: '/w' }
    const { ctx, captured } = coldCtx({
      observeMetadata: () => Promise.resolve(metadataOf(buildTimelineHead(state), header)),
      storageDomain: storageOf(record),
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 's1' }) as { ok: boolean; value: unknown }
    assert.deepStrictEqual(result.value, buildTimelineDetail(state, BOUNDS), 'the unseeded record still seeds the detail')
  })

  test('a metadata read that rejects while the client left answers the abort envelope', async () => {
    const controller = new AbortController()
    const { ctx, captured } = coldCtx({
      observeMetadata: () => {
        controller.abort()
        return Promise.reject(new Error('cancelled'))
      },
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 's1' }, controller.signal) as { ok: boolean; error: { code: string } }
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'dsh-context/aborted')
  })
})

describe('the stored-session detail cost', () => {
  test('a large non-live session serves its detail from the projection checkpoint with zero log reads', { timeout: 60_000 }, async () => {
    const events: TimelineEvent[] = [header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' })]
    for (let seq = 2; seq <= 5_000; seq++) {
      events.push(seq % 2 === 0
        ? userMessage(seq, [{ type: 'text', text: `question ${seq}` }], { kind: 'user' })
        : assistantMessage(seq, { turn: seq, step: seq, usage: { inputTokens: 10, outputTokens: 5 } }))
    }
    const { state } = driveTimeline(events)
    const { ctx, captured, counts } = coldCtx({
      observeMetadata: () => Promise.resolve(metadataOf(buildTimelineHead(state))),
      observe: () => Promise.reject(new Error('the durable log must stay unread')),
      readWindow: () => Promise.reject(new Error('no window read either')),
      storageDomain: storageOf(recordOf(state)),
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 's1' }) as { ok: boolean; value: unknown }
    assert.equal(result.ok, true)
    assert.deepStrictEqual(result.value, buildTimelineDetail(state, BOUNDS), 'same payload a whole-log fold produces')
    assert.deepEqual(counts, { observe: 0, metadata: 1, window: 0 }, 'one persistence stat and one in-memory record read')
  })
})
