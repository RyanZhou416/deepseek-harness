// The projection warm-up (src/host/backfill.ts) over the REAL cordis
// context: the trigger route's gating (no connection, no registry — no
// pass), the one-pass-per-process arm (either half landing first, later
// route hits no-op), the deferred inject's service gating, the per-session
// skip ladder (malformed, invisible, live, already fully served), the
// cold-read → coldSnapshot fold path, per-session failure isolation with
// the migration-refusal accounting (debug detail, one summary info), and
// abort-on-dispose.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { BACKFILL_ROUTE, watchActivityBackfill } from '../../src/host/backfill'

/** Poll until the async run reaches a condition. */
async function until<T>(read: () => T | undefined, message: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.fail(message)
}

/** One captured route registration (the trigger half's observable). */
interface RouteBox {
  path?: string
  fetch?: (request: Request) => Promise<Response>
}

/** Fire the captured trigger route (the client's dashboard-open POST). */
async function trigger(route: RouteBox): Promise<Response> {
  // The route half registers on cordis's deferred inject — settle first.
  for (let i = 0; i < 300 && route.fetch === undefined; i++) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.ok(route.fetch !== undefined, 'the backfill route registered')
  return route.fetch(new Request(`http://dsh.test${BACKFILL_ROUTE}`, { method: 'POST' }))
}

/** One log line the tests capture off the ctx logger. */
interface LogLine {
  level: string
  text: string
}

/** Capture the pass's log lines through the logger service's exporter sink. */
function captureLogs(ctx: Context): LogLine[] {
  const lines: LogLine[] = []
  // Lift every source's threshold to debug: the default exporter drops
  // warn/debug records before they reach the sink.
  ctx.logger.exporter({
    levels: { root: 3, 'dsh-context': 3 },
    export(message) {
      lines.push({ level: message.type, text: message.args.map(a => String(a)).join(' ') })
    },
  })
  return lines
}

/** The migration-refusal error dsh raises for a legacy log it cannot migrate. */
function unsupportedMigrationError(): Error {
  const error = new Error('subagent/descriptor 0 uses unsupported descriptor version 2; source v0 artifact remains unchanged')
  error.name = 'SessionFormatUnsupportedMigrationError'
  return error
}

/** A connection face whose route registration lands in `route`. */
function connectionOf(route: RouteBox): unknown {
  return {
    fetch: {
      register: (r: { path: string; fetch: RouteBox['fetch'] }) => {
        route.path = r.path
        route.fetch = r.fetch
        return () => {}
      },
    },
  }
}

interface FakeState {
  listed: unknown
  served: Set<string>
  live: Set<string>
  coldReads: string[]
  coldSnapshots: string[]
  failReads: Map<string, unknown>
}

function arm(ctx: Context, state: FakeState): RouteBox {
  const route: RouteBox = {}
  ctx.provide('connection', connectionOf(route))
  ctx.provide('sessionQuery', {
    listSessions: async () => state.listed,
  })
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: (header: { id: string }) =>
      state.served.has(header.id)
        ? { asOfSeq: 0, values: { contextActivity: { days: {} }, contextTimeline: { ok: true } } }
        : undefined,
    coldSnapshot: (header: { id: string }) => {
      state.coldSnapshots.push(header.id)
      return { asOfSeq: 0, values: {} }
    },
  })
  ctx.provide('sessionPersistence', {
    open: async (id: string) => {
      state.coldReads.push(id)
      if (state.failReads.has(id)) throw state.failReads.get(id)
      const events: SessionEvent[] = []
      return {
        header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
        inheritedEventCount: 0,
        read: async () => ({ events }),
        close: async () => {},
      }
    },
  })
  ctx.provide('sessions', { get: (id: string) => (state.live.has(id) ? { id } : undefined) })
  return route
}

function fakeState(listed: unknown): FakeState {
  return {
    listed,
    served: new Set(),
    live: new Set(),
    coldReads: [],
    coldSnapshots: [],
    failReads: new Map(),
  }
}

describe('watchActivityBackfill', () => {
  test('a deployment without any service never fires either half', async () => {
    const ctx = new Context()
    const dispose = watchActivityBackfill(ctx)
    dispose()
    await new Promise(resolve => setTimeout(resolve, 5))
    // Nothing to assert beyond: no throw, no pending work.
  })

  test('cold-path faces without a connection arm nothing — the pass waits for its reader', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    ctx.provide('sessionQuery', { listSessions: async () => state.listed })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined, coldSnapshot: () => ({}) })
    ctx.provide('sessionPersistence', {
      open: async (id: string) => {
        state.coldReads.push(id)
        return {
          header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
          inheritedEventCount: 0,
          read: async () => ({ events: [] }),
          close: async () => {},
        }
      },
    })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await new Promise(resolve => setTimeout(resolve, 30))
    dispose()
    assert.deepEqual(state.coldReads, [], 'no trigger route — no cold read')
  })

  test('a connection without the exact-route registry never arms the pass', async () => {
    const ctx = new Context()
    ctx.provide('connection', { notFetch: true })
    ctx.provide('sessionQuery', { listSessions: async () => [] })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined, coldSnapshot: () => ({}) })
    ctx.provide('sessionPersistence', { open: async () => ({}) })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await new Promise(resolve => setTimeout(resolve, 20))
    dispose()
  })

  test('a throwing route registry never arms the pass', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    ctx.provide('connection', {
      fetch: {
        register: () => { throw new Error('registry hostile') },
      },
    })
    ctx.provide('sessionQuery', { listSessions: async () => state.listed })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined, coldSnapshot: () => ({}) })
    ctx.provide('sessionPersistence', {
      open: async (id: string) => {
        state.coldReads.push(id)
        return {
          header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
          inheritedEventCount: 0,
          read: async () => ({ events: [] }),
          close: async () => {},
        }
      },
    })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await new Promise(resolve => setTimeout(resolve, 30))
    dispose()
    assert.deepEqual(state.coldReads, [], 'a throwing registry leaves the route absent')
  })

  test('incomplete faces are re-proved away — an armed request waits, then never launches', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    ctx.provide('sessionQuery', { notListSessions: true })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined })
    ctx.provide('sessionPersistence', { open: async () => ({}) })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(state.coldReads, [], 'the armed request holds until the faces complete')

    // Re-arm the same face-shaped hole twice more: the request may land
    // before or after the broken face — the re-proof answers either way.
    for (const broken of [
      { sessionProjectionCache: { coldSnapshot: () => ({}) } },
      { sessionPersistence: { notOpen: true } },
    ]) {
      const ctxN = new Context()
      const routeN: RouteBox = {}
      ctxN.provide('connection', connectionOf(routeN))
      ctxN.provide('sessionQuery', { listSessions: async () => state.listed })
      ctxN.provide('sessionProjectionCache', broken.sessionProjectionCache
        ?? { cachedSnapshot: () => undefined, coldSnapshot: () => ({}) })
      ctxN.provide('sessionPersistence', broken.sessionPersistence ?? { open: async () => ({}) })
      ctxN.provide('sessions', { get: () => undefined })
      const disposeN = watchActivityBackfill(ctxN)
      await trigger(routeN)
      await new Promise(resolve => setTimeout(resolve, 20))
      disposeN()
      assert.deepEqual(state.coldReads, [], 'the broken face keeps the pass unarmed')
    }
    dispose()
  })

  test('a fully-served corpus completes silently (no fold, no info line)', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    state.served.add('a')
    let listed = 0
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    ctx.provide('sessionQuery', {
      listSessions: async () => {
        listed++
        return state.listed
      },
    })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: (header: { id: string }) =>
        state.served.has(header.id)
          ? { asOfSeq: 0, values: { contextActivity: { days: {} }, contextTimeline: { ok: true } } }
          : undefined,
      coldSnapshot: () => {
        state.coldSnapshots.push('x')
        return {}
      },
    })
    ctx.provide('sessionPersistence', { open: async () => ({}) })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (listed > 0 ? true : undefined), 'the corpus was queried')
    await new Promise(resolve => setTimeout(resolve, 40))
    dispose()
    assert.deepEqual(state.coldReads, [], 'nothing to fold')
    assert.deepEqual(state.coldSnapshots, [])
  })

  test('a rejection landing AFTER abort skips the warn (the unload owns the silence)', async () => {
    const ctx = new Context()
    let started = false
    let rejectListed: (error: Error) => void = () => {}
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    ctx.provide('sessionQuery', {
      listSessions: async () => new Promise((_resolve, reject) => {
        started = true
        rejectListed = reject
      }),
    })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined, coldSnapshot: () => ({}) })
    ctx.provide('sessionPersistence', { open: async () => ({}) })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (started ? true : undefined), 'the run listed the corpus')
    dispose()
    rejectListed(new Error('corpus down'))
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  test('sessions missing their row get one cold read each; served, live, and malformed ones skip', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'e' } },                    // invisible (no cwd)
      { header: { id: '' } },                     // malformed id
      { header: 7 },                              // malformed header
      null,                                       // malformed record
      { header: { id: 'b', cwd: '/repo/b' } },    // already served
      { header: { id: 'd', cwd: '/repo/d' } },    // live
      { header: { id: 'a', cwd: '/repo/a' } },
      { header: { id: 'c', cwd: '/repo/c' } },
    ])
    state.served.add('b')
    state.live.add('d')
    const route = arm(ctx, state)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    // The skip-guard records come first, so every guard branch runs before
    // the two folds complete the observable signal; the run then finishes.
    await until(() => (state.coldSnapshots.length >= 2 ? true : undefined), 'two cold folds')
    await new Promise(resolve => setTimeout(resolve, 60))
    dispose()
    assert.deepEqual(state.coldReads.sort(), ['a', 'c'])
    assert.deepEqual(state.coldSnapshots.sort(), ['a', 'c'])
  })

  test('a session serving only the activity row (timeline version-stale) gets a cold refold', async () => {
    // The lastUser bump's whole point: a cached timeline row that predates
    // the field fails the version gate and reads as absent — the session is
    // NOT "already served" and its rows are rebuilt on the pass.
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    ctx.provide('sessionQuery', { listSessions: async () => state.listed })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => ({ asOfSeq: 0, values: { contextActivity: { days: {} } } }),
      coldSnapshot: (header: { id: string }) => {
        state.coldSnapshots.push(header.id)
        return { asOfSeq: 0, values: {} }
      },
    })
    ctx.provide('sessionPersistence', {
      open: async (id: string) => ({
        header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
        inheritedEventCount: 0,
        read: async () => ({ events: [] }),
        close: async () => {},
      }),
    })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the stale session folded')
    dispose()
    assert.deepEqual(state.coldSnapshots, ['a'])
  })

  test('a non-array listing ends the run without work', async () => {
    const ctx = new Context()
    const state = fakeState({ not: 'an array' })
    let listed = 0
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    ctx.provide('sessionQuery', {
      listSessions: async () => {
        listed++
        return state.listed
      },
    })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined, coldSnapshot: () => ({}) })
    ctx.provide('sessionPersistence', { open: async () => ({}) })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (listed > 0 ? true : undefined), 'the corpus was queried')
    await new Promise(resolve => setTimeout(resolve, 30))
    dispose()
    assert.deepEqual(state.coldReads, [])
  })

  test('a throwing probe (cachedSnapshot) reads as not-served and backfills', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    ctx.provide('sessionQuery', { listSessions: async () => state.listed })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => { throw new Error('identity mismatch') },
      coldSnapshot: (header: { id: string }) => {
        state.coldSnapshots.push(header.id)
        return {}
      },
    })
    ctx.provide('sessionPersistence', {
      open: async (id: string) => ({
        header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
        inheritedEventCount: 0,
        read: async () => ({ events: 'garbage' }),
        close: async () => {},
      }),
    })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the fold ran')
    dispose()
    assert.deepEqual(state.coldSnapshots, ['a'])
  })

  test('one unreadable log warns and the run continues with the next session', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'bad', cwd: '/repo/bad' } },
      { header: { id: 'good', cwd: '/repo/good' } },
    ])
    state.failReads.set('bad', new Error('no such session bad'))
    const route = arm(ctx, state)
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the good session folded')
    dispose()
    assert.deepEqual(state.coldReads.sort(), ['bad', 'good'])
    assert.deepEqual(state.coldSnapshots, ['good'])
    const warns = lines.filter(l => l.level === 'warn')
    assert.equal(warns.length, 1, 'the unexpected failure keeps its own warn')
    assert.match(warns[0].text, /"bad"/)
  })

  test('migration-refused logs drop to debug and end in ONE summary info, no warn, and the run continues', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'legacy-1', cwd: '/repo/legacy-1' } },
      { header: { id: 'legacy-2', cwd: '/repo/legacy-2' } },
      { header: { id: 'good', cwd: '/repo/good' } },
    ])
    state.failReads.set('legacy-1', unsupportedMigrationError())
    state.failReads.set('legacy-2', unsupportedMigrationError())
    const route = arm(ctx, state)
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the good session folded')
    // The summary lines land after the loop's final pacing yield — settle first.
    await new Promise(resolve => setTimeout(resolve, 350))
    dispose()
    assert.deepEqual(state.coldReads.sort(), ['good', 'legacy-1', 'legacy-2'])
    assert.deepEqual(state.coldSnapshots, ['good'])
    assert.deepEqual(lines.filter(l => l.level === 'warn'), [], 'a migration refusal never warns')
    const infos = lines.filter(l => l.level === 'info')
    assert.equal(infos.length, 2, 'the folded count and ONE skip summary for the whole pass')
    assert.match(infos[0].text, /backfilled for 1 session\(s\)/)
    assert.match(infos[1].text, /skipped 2 session\(s\)/)
    assert.match(infos[1].text, /sources left unchanged/)
    const debugs = lines.filter(l => l.level === 'debug')
    assert.equal(debugs.length, 2, 'each refused session keeps a debug detail')
  })

  test('a hostile error object (throwing name, throwing toString) warns unprintable and the run continues', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'hostile', cwd: '/repo/hostile' } }])
    state.failReads.set('hostile', {
      get name(): string { throw new Error('no name for you') },
      toString(): string { throw new Error('no string for you') },
    })
    const route = arm(ctx, state)
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await new Promise(resolve => setTimeout(resolve, 30))
    dispose()
    assert.deepEqual(state.coldSnapshots, [])
    const warns = lines.filter(l => l.level === 'warn')
    assert.equal(warns.length, 1)
    assert.match(warns[0].text, /unprintable error/)
  })

  test('a mid-read failure closes the handle (a close failure adds nothing) and the run continues', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'torn', cwd: '/repo/torn' } },
      { header: { id: 'good', cwd: '/repo/good' } },
    ])
    let closes = 0
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    ctx.provide('sessionQuery', { listSessions: async () => state.listed })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => undefined,
      coldSnapshot: (header: { id: string }) => {
        state.coldSnapshots.push(header.id)
        return {}
      },
    })
    ctx.provide('sessionPersistence', {
      open: async (id: string) => ({
        header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
        inheritedEventCount: 0,
        read: id === 'torn'
          ? async () => { throw new Error('torn tail') }
          : async () => ({ events: [] }),
        close: async () => {
          closes++
          if (id === 'torn') throw new Error('close failed too')
        },
      }),
    })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the good session folded')
    dispose()
    assert.equal(closes, 2, 'both handles closed — the torn one before the error propagated')
    assert.deepEqual(state.coldSnapshots, ['good'])
  })

  test('the route answers ok and every hit after the first is a no-op (one pass per process)', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    let listed = 0
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    ctx.provide('sessionQuery', {
      listSessions: async () => {
        listed++
        return state.listed
      },
    })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => undefined,
      coldSnapshot: (header: { id: string }) => {
        state.coldSnapshots.push(header.id)
        return {}
      },
    })
    ctx.provide('sessionPersistence', {
      open: async (id: string) => {
        state.coldReads.push(id)
        return {
          header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
          inheritedEventCount: 0,
          read: async () => ({ events: [] }),
          close: async () => {},
        }
      },
    })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    const first = await trigger(route)
    assert.equal(route.path, BACKFILL_ROUTE)
    assert.deepEqual(await first.json(), { ok: true })
    await until(() => (listed === 1 ? true : undefined), 'the first pass listed the corpus')
    const second = await trigger(route)
    assert.deepEqual(await second.json(), { ok: true })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(listed, 1, 'the second POST is a no-op')
    assert.deepEqual(state.coldReads, ['a'])
    dispose()
  })

  test('a route hit BEFORE the cold-path faces compose still launches the pass (either half first)', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    // The request landed while only the route half existed; the faces land
    // now and the pass must still run.
    ctx.provide('sessionQuery', { listSessions: async () => state.listed })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => undefined,
      coldSnapshot: (header: { id: string }) => {
        state.coldSnapshots.push(header.id)
        return {}
      },
    })
    ctx.provide('sessionPersistence', {
      open: async (id: string) => {
        state.coldReads.push(id)
        return {
          header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
          inheritedEventCount: 0,
          read: async () => ({ events: [] }),
          close: async () => {},
        }
      },
    })
    ctx.provide('sessions', { get: () => undefined })
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the delayed pass ran')
    dispose()
    assert.deepEqual(state.coldReads, ['a'])
  })

  test('dispose aborts the pass mid-loop', async () => {
    const ctx = new Context()
    const many = Array.from({ length: 50 }, (_, i) => ({ header: { id: `s${i}`, cwd: '/repo' } }))
    const state = fakeState(many)
    const route = arm(ctx, state)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldReads.length >= 1 ? true : undefined), 'the run started')
    dispose()
    const seen = state.coldReads.length
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.ok(state.coldReads.length <= seen + 1, 'no further sessions read after abort')
  })

  test('a sessions service present-but-undefined folds without a live probe', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    ctx.provide('sessionQuery', { listSessions: async () => state.listed })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => undefined,
      coldSnapshot: (header: { id: string }) => {
        state.coldSnapshots.push(header.id)
        return {}
      },
    })
    ctx.provide('sessionPersistence', {
      open: async (id: string) => ({
        header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
        inheritedEventCount: 0,
        read: async () => ({ events: [] }),
        close: async () => {},
      }),
    })
    ctx.provide('sessions', undefined)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the fold ran')
    dispose()
    assert.deepEqual(state.coldSnapshots, ['a'])
  })

  test('a throwing live-probe conservatively skips the session (no cold write over a possibly-live one)', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    ctx.provide('sessionQuery', { listSessions: async () => state.listed })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => undefined,
      coldSnapshot: () => ({}),
    })
    ctx.provide('sessionPersistence', {
      open: async (id: string) => {
        state.coldReads.push(id)
        return {
          header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
          inheritedEventCount: 0,
          read: async () => ({ events: [] }),
          close: async () => {},
        }
      },
    })
    ctx.provide('sessions', { get: () => { throw new Error('registry broken') } })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await new Promise(resolve => setTimeout(resolve, 80))
    dispose()
    assert.deepEqual(state.coldReads, [], 'no cold read for a session whose liveness cannot be proven')
  })

  test('a failing listSessions rejection is contained (no unhandled rejection)', async () => {
    const ctx = new Context()
    let listed = 0
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    ctx.provide('sessionQuery', {
      listSessions: async () => {
        listed++
        throw new Error('corpus down')
      },
    })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined, coldSnapshot: () => ({}) })
    ctx.provide('sessionPersistence', { open: async () => ({}) })
    ctx.provide('sessions', { get: () => undefined })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (listed > 0 ? true : undefined), 'the corpus was queried')
    // The rejection lands and is logged while NOT aborted (the dispose follows).
    await new Promise(resolve => setTimeout(resolve, 30))
    dispose()
  })
})
