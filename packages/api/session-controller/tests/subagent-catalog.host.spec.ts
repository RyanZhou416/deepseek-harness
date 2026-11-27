import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { SUBAGENT_CATALOG_HINT_LIMIT } from '@deepseek-ai/dsh-subagent/src/catalog.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionTestController,
  installSessionReadTestServices,
  testSessionPersistence,
} from './test-remote.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import SessionController from '../src/index.ts'

const defaults = {
  defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

const PARENT = brandString<SessionId>('catalog-parent')
const CHILD = brandString<SessionId>('catalog-child')
const header: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: PARENT,
  createdAt: 1,
  isSeeded: false,
  cwd: '/workspace',
}
const events: SessionEvent[] = [{
  type: 'subagent/catalog',
  seq: SessionSeq(0),
  time: 1,
  data: {
    version: 0,
    childId: CHILD,
    childCreatedAt: 2,
    mode: 'continuable',
    label: 'worker',
  },
}]

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function bench() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([header]),
    inspect: (sessionId: SessionId) => Promise.resolve(
      sessionId === PARENT ? { meta: header, events } : undefined,
    ),
  }) as never)
  await installSessionReadTestServices(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  const controller = await createSessionTestController(ctx, defaults)
  return { ctx, controller }
}

describe('SessionController subagent catalog', () => {
  it('bounds every Client payload to the newest entries and serves older ones by page', async () => {
    const { ctx, controller } = await bench()
    const parent = ctx.sessions.create(PARENT, { meta: { createdAt: header.createdAt, cwd: '/workspace' } })
    const total = SUBAGENT_CATALOG_HINT_LIMIT + 8
    for (let index = 0; index < total; index++) {
      parent.append('subagent/catalog', {
        version: 3,
        childId: brandString<SessionId>(`child-${String(index)}`),
        childCreatedAt: index + 1,
        mode: 'continuable',
        label: `worker ${String(index)}`,
        name: `worker-${String(index)}`,
      })
    }
    const newest = Array.from({ length: SUBAGENT_CATALOG_HINT_LIMIT }, (_, offset) => ({
      id: `child-${String(total - SUBAGENT_CATALOG_HINT_LIMIT + offset)}`,
      createdAt: total - SUBAGENT_CATALOG_HINT_LIMIT + offset + 1,
      mode: 'continuable' as const,
      label: `worker ${String(total - SUBAGENT_CATALOG_HINT_LIMIT + offset)}`,
      name: `worker-${String(total - SUBAGENT_CATALOG_HINT_LIMIT + offset)}`,
    }))

    // A pushed Session summary carries the bounded catalog.
    const listed = await controller.list({}, new AbortController().signal)
    expect(listed.items.find(item => item.sessionId === PARENT)?.projections?.values.subagentCatalog).toEqual(newest)

    // The control baseline and each live update carry the same bounded value.
    const signal = new AbortController()
    const stream = controller.control(signal.signal)[Symbol.asyncIterator]()
    try {
      const baseline = await stream.next()
      expect(baseline.done).toBe(false)
      if (baseline.done || baseline.value.type !== 'baseline') throw new Error('control did not open with a baseline')
      expect(baseline.value.value.projections[PARENT]?.values.subagentCatalog).toEqual(newest)

      parent.append('subagent/catalog', {
        version: 3,
        childId: brandString<SessionId>('child-newest'),
        childCreatedAt: total + 1,
        mode: 'continuable',
        label: 'newest worker',
        name: 'newest-worker',
      })
      let frame = await stream.next()
      let catalog = frame.done || frame.value.type !== 'projection'
        ? undefined : frame.value.changes.find(change => change.key === 'subagentCatalog')?.val
      while (!frame.done && !(Array.isArray(catalog) && (catalog as { readonly id: string }[]).at(-1)?.id === 'child-newest')) {
        frame = await stream.next()
        catalog = frame.done || frame.value.type !== 'projection'
          ? undefined : frame.value.changes.find(change => change.key === 'subagentCatalog')?.val
      }
      // A live update carries the same bounded window.
      expect(catalog).toHaveLength(SUBAGENT_CATALOG_HINT_LIMIT)
      expect((catalog as { readonly id: string }[]).at(-1)?.id).toBe('child-newest')
    } finally {
      signal.abort()
      await stream.return?.()
    }

    // The follow opening block is bounded too, and an explicit read is complete.
    const openingAbort = new AbortController()
    const follow = controller.follow({
      address: { kind: 'session', sessionId: PARENT },
      projectionChanges: true,
    }, openingAbort.signal)[Symbol.asyncIterator]()
    try {
      const opening = await follow.next()
      if (opening.done || opening.value.type !== 'snapshot') throw new Error('follow did not open with a snapshot')
      expect(opening.value.projections?.values.subagentCatalog).toEqual([
        ...newest.slice(1),
        {
          id: brandString<SessionId>('child-newest'),
          createdAt: total + 1,
          mode: 'continuable',
          label: 'newest worker',
          name: 'newest-worker',
        },
      ])
    } finally {
      openingAbort.abort()
      await follow.return?.()
    }
    const explicit = await controller.projections({ sessionId: PARENT }, new AbortController().signal)
    expect(explicit).toMatchObject({ kind: 'sequenced' })
    expect((explicit as { values: { subagentCatalog?: readonly unknown[] } }).values.subagentCatalog)
      .toHaveLength(SUBAGENT_CATALOG_HINT_LIMIT)

    // Older entries come by page, ending where the caller asks.
    const read = (request: { end?: number; limit: number }) => controller.projectionPage(
      { sessionId: PARENT, key: 'subagentCatalog', ...request }, new AbortController().signal)
    const first = await read({ limit: 10 })
    expect(first).toMatchObject({ start: total + 1 - 10, total: total + 1 })
    expect(first?.items.map(item => (item as { id: string }).id).at(-1)).toBe('child-newest')
    const oldest = await read({ end: 5, limit: 10 })
    expect(oldest).toMatchObject({ start: 0, total: total + 1 })
    expect(oldest?.items.map(item => (item as { id: string }).id)).toEqual(['child-0', 'child-1', 'child-2', 'child-3', 'child-4'])
    const absent = brandString<SessionId>('absent')
    expect(await controller.projectionPage({ sessionId: absent, key: 'subagentCatalog', limit: 1 }, new AbortController().signal)).toBeNull()
    for (const bad of [
      { sessionId: PARENT, key: 'title', limit: 1 },
      { sessionId: PARENT, key: 'subagentCatalog', limit: 0 },
      { sessionId: PARENT, key: 'subagentCatalog', limit: 501 },
      { sessionId: PARENT, key: 'subagentCatalog', limit: 1, end: -1 },
      { sessionId: brandString<SessionId>(''), key: 'subagentCatalog', limit: 1 },
    ]) {
      await expect(controller.projectionPage(bad, new AbortController().signal)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    }
  })

  it('pushes complete catalog values through the shared control stream', async () => {
    const { ctx, controller } = await bench()
    const signal = new AbortController()
    const stream = controller.control(signal.signal)[Symbol.asyncIterator]()
    try {
      await stream.next()
      const parent = ctx.sessions.create(PARENT, { meta: { createdAt: 7, cwd: '/workspace' } })
      parent.append('subagent/catalog', {
        version: 0, childId: CHILD, childCreatedAt: 8, mode: 'continuable', label: 'worker',
      })
      let frame = await stream.next()
      let catalog = frame.done || frame.value.type !== 'projection'
        ? undefined : frame.value.changes.find(change => change.key === 'subagentCatalog')?.val
      while (!frame.done && !(Array.isArray(catalog) && catalog.length === 1)) {
        frame = await stream.next()
        catalog = frame.done || frame.value.type !== 'projection'
          ? undefined : frame.value.changes.find(change => change.key === 'subagentCatalog')?.val
      }
      expect(frame.value).toMatchObject({ type: 'projection', sessionId: PARENT })
      expect(catalog).toMatchObject([{ id: CHILD, createdAt: 8, mode: 'continuable', label: 'worker' }])
    } finally {
      signal.abort()
      await stream.return?.()
    }
  })

  it.each([false, true])('reads an uncached parent catalog without loading an Agent (explicit current format: %s)', async (withFormat) => {
    const { ctx, controller } = await bench()
    const stored = await ctx.sessionPersistence.stat(PARENT)
    if (stored === undefined) throw new Error('parent fixture is missing')
    const stat = vi.spyOn(ctx.sessionPersistence, 'stat').mockResolvedValueOnce(withFormat
      ? { ...stored, formatStatus: 'current' }
      : stored)
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    const open = vi.spyOn(ctx.sessionPersistence, 'open')
    const resume = vi.spyOn(ctx.agents, 'resume').mockRejectedValue(new Error('unexpected Agent resume'))
    const signal = new AbortController().signal

    await expect(controller.projections({ sessionId: PARENT }, signal)).resolves.toMatchObject({
      kind: 'sequenced', values: { subagentCatalog: [{ id: CHILD, mode: 'continuable', label: 'worker' }] },
    })
    expect(stat).toHaveBeenCalledWith(PARENT, { signal })
    expect(observe).toHaveBeenCalledWith(PARENT, { signal, projectionMode: 'all' })
    expect(open).toHaveBeenCalledWith(PARENT, 'read', { signal })
    expect(resume).not.toHaveBeenCalled()
    // A stored parent's older catalog page comes from the same non-activating read.
    await expect(controller.projectionPage({ sessionId: PARENT, key: 'subagentCatalog', limit: 5 }, signal))
      .resolves.toMatchObject({ start: 0, total: 1, items: [{ id: CHILD }] })
    expect(ctx.sessions.get(PARENT)).toBeUndefined()
    expect(ctx.agents.get(PARENT)).toBeUndefined()
  })

  it('pages a stored parent from its checkpoint without folding its log', async () => {
    const { ctx, controller } = await bench()
    const entries = Array.from({ length: 6 }, (_, index) => ({ id: `cached-${String(index)}`, mode: 'one-shot', createdAt: index }))
    const cachedSnapshot = vi.fn(() => ({ asOfSeq: 1, values: { subagentCatalog: entries } }))
    ctx.provide('sessionProjectionCache', { cachedSnapshot } as never)
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    await expect(controller.projectionPage({ sessionId: PARENT, key: 'subagentCatalog', end: 4, limit: 2 }, new AbortController().signal))
      .resolves.toEqual({ items: entries.slice(2, 4), start: 2, total: 6 })
    expect(cachedSnapshot).toHaveBeenCalledWith(expect.objectContaining({ id: PARENT }), ['subagentCatalog'])
    expect(observe).not.toHaveBeenCalled()
  })
  it('folds only the paged key of a stored Session without its checkpoint row, after running openings end', async () => {
    const { ctx, controller } = await bench()
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    const stat = vi.spyOn(ctx.sessionPersistence, 'stat')
    const history = Reflect.get(controller, 'historyController') as { beginOpening(): () => void }
    const endOpening = history.beginOpening()
    const reading = controller.projectionPage({ sessionId: PARENT, key: 'subagentCatalog', limit: 5 }, new AbortController().signal)
    for (let index = 0; index < 5; index++) await Promise.resolve()
    // A Session opening is in progress: the page read has not touched persistence.
    expect(stat).not.toHaveBeenCalled()
    endOpening()
    await expect(reading).resolves.toMatchObject({ start: 0, total: 1 })
    expect(observe).toHaveBeenCalledWith(PARENT, expect.objectContaining({ projectionMode: 'all', projectionKeys: ['subagentCatalog'] }))
  })

  it('resolves and validates the projection page fold concurrency', () => {
    expect(SessionController.Config({}).projectionPageFoldConcurrency).toBe(1)
    expect(SessionController.Config({ projectionPageFoldConcurrency: 3 }).projectionPageFoldConcurrency).toBe(3)
    for (const projectionPageFoldConcurrency of [0, -1, 1.5]) {
      expect(() => SessionController.Config({ projectionPageFoldConcurrency })).toThrow()
    }
  })
  it('uses disk migration status instead of the normalized header version to defer a cold catalog read', async () => {
    const { ctx, controller } = await bench()
    const stored = await ctx.sessionPersistence.stat(PARENT)
    if (stored === undefined) throw new Error('parent fixture is missing')
    vi.spyOn(ctx.sessionPersistence, 'stat').mockResolvedValueOnce({
      ...stored,
      formatStatus: 'migration-required',
    })
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    const open = vi.spyOn(ctx.sessionPersistence, 'open')

    expect(stored.header.version).toBe(SESSION_FORMAT_VERSION)
    await expect(controller.projections({ sessionId: PARENT }, new AbortController().signal))
      .resolves.toEqual({ kind: 'migration-required', values: {} })
    vi.spyOn(ctx.sessionPersistence, 'stat').mockResolvedValueOnce({ ...stored, formatStatus: 'migration-required' })
    await expect(controller.projectionPage({ sessionId: PARENT, key: 'subagentCatalog', limit: 5 }, new AbortController().signal))
      .resolves.toEqual({ items: [], start: 0, total: 0 })

    expect(observe).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(ctx.sessions.get(PARENT)).toBeUndefined()
    expect(ctx.agents.get(PARENT)).toBeUndefined()
  })

  it('serves a live parent from its maintained registry state without folding its log', async () => {
    const { ctx, controller } = await bench()
    const parent = ctx.sessions.create(PARENT, { meta: { createdAt: 7, cwd: '/workspace' } })
    parent.append('turn/start', { turn: 1 })
    parent.append('subagent/catalog', {
      version: 0,
      childId: CHILD,
      childCreatedAt: 8,
      mode: 'one-shot',
      label: 'live worker',
    })
    const snapshot = vi.spyOn(ctx.sessionProjections, 'snapshot')
    const hydrate = vi.spyOn(ctx.sessionProjections, 'hydrate')

    const result = await controller.projections({ sessionId: PARENT }, new AbortController().signal)
    expect(result).toMatchObject({ kind: 'sequenced', values: { subagentCatalog: [{
      id: CHILD,
      mode: 'one-shot',
      label: 'live worker',
    }] } })
    expect(snapshot).toHaveBeenCalledWith(parent)
    expect(hydrate).not.toHaveBeenCalled()
  })

  it('reports Agent availability through Session summaries independently of projections', async () => {
    const { ctx, controller } = await bench()
    const parent = ctx.sessions.create(PARENT, { meta: { createdAt: 1, cwd: '/workspace' } })
    parent.append('subagent/catalog', {
      version: 0, childId: CHILD, childCreatedAt: 8, mode: 'one-shot',
    })
    const summaries: boolean[] = []
    ctx.on('api-session/added', (summary) => { summaries.push(summary.agentAvailable) })
    const dispose = ctx.agents.register({ id: PARENT, session: parent, status: 'idle', ctx } as Agent)
    await dispose
    expect(summaries).toEqual([true])
    const available = await controller.list({}, new AbortController().signal)
    expect(available.items.find(item => item.sessionId === PARENT)?.agentAvailable).toBe(true)
    await dispose()
    expect(summaries).toEqual([true, false])
    const unavailable = await controller.list({}, new AbortController().signal)
    expect(unavailable.items.find(item => item.sessionId === PARENT)?.agentAvailable).toBe(false)
    const result = await controller.projections({ sessionId: PARENT }, new AbortController().signal)
    expect(result).toMatchObject({ kind: 'sequenced', asOfSeq: 0, values: { subagentCatalog: [{ id: CHILD, createdAt: 8, mode: 'one-shot' }] } })
  })

  it('does not republish a Session when its Agent outlives the Session registration', async () => {
    const { ctx } = await bench()
    const session = ctx.sessions.prepare(brandString<SessionId>('detached'), { meta: { cwd: '/workspace' } })
    const detach = ctx.sessions.enter(session)
    const disposeAgent = ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    await disposeAgent
    const added = vi.fn()
    ctx.on('api-session/added', added)
    detach()
    await disposeAgent()
    expect(added).not.toHaveBeenCalled()
  })

  it('reads registered projections without a subagent provider or catalog key', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await installSessionReadTestServices(ctx)
    const controller = await createSessionTestController(ctx, defaults)
    const session = ctx.sessions.create(PARENT, { meta: { cwd: '/workspace' } })
    const expected = ctx.sessionProjections.snapshot(session)
    expect(expected.values.subagentCatalog).toBeUndefined()
    await expect(controller.projections({ sessionId: PARENT }, new AbortController().signal))
      .resolves.toEqual({ kind: 'sequenced', ...expected })
    expect(ctx.agents.get(PARENT)).toBeUndefined()
  })

  it('validates the parent id and keeps not-found distinct from cancellation', async () => {
    const { controller } = await bench()
    const signal = new AbortController().signal
    await expect(controller.projections({ sessionId: brandString<SessionId>('') }, signal)).rejects.toMatchObject({
      code: 'gateway/bad-request',
    })
    await expect(controller.projections({ sessionId: brandString<SessionId>('missing') }, signal)).resolves.toEqual(null)
    const aborted = new AbortController()
    aborted.abort()
    await expect(controller.projections({ sessionId: PARENT }, aborted.signal)).rejects.toMatchObject({
      code: 'gateway/cancelled',
    })
  })

  it('reports a live snapshot failure without falling back to stored metadata', async () => {
    const { ctx, controller } = await bench()
    const parent = ctx.sessions.create(PARENT, { meta: { cwd: '/workspace' } })
    const failure = new Error('projection snapshot failed')
    const snapshot = vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementationOnce(() => {
      throw failure
    })
    const stat = vi.spyOn(ctx.sessionPersistence, 'stat')
    await expect(controller.projections({ sessionId: PARENT }, new AbortController().signal)).rejects.toMatchObject({
      code: 'gateway/internal',
      cause: failure,
    })
    expect(snapshot).toHaveBeenCalledWith(parent)
    expect(stat).not.toHaveBeenCalled()
  })
})
