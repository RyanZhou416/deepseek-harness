/**
 * Backwards history paging through the real JSONL generation index.
 *
 * These cases mount the actual persistence backend and query engine, so the
 * window a page is served from is the durable sidecar window rather than a
 * test double: every assertion compares that window against the complete read
 * of the same generation.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { windowIndexPath } from '@deepseek-ai/dsh-session-persistence-jsonl/src/window-index.ts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionHistoryController } from '../src/history.ts'
import type { SessionFollowFrame, SessionFollowRequest, SessionPage, SessionPageRequest } from '../src/types.ts'
import { installSessionReadTestServices } from './test-remote.ts'

const STORED = SessionId('history-paging-stored')
const LIVE = SessionId('history-paging-live')

function header(id: SessionId): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: '/workspace' }
}

/** Append Turns of append-origin messages to a live Session. */
function appendConversation(session: Session, turns = 3): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push(session.append('turn/start', { turn }))
    events.push(session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `question ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }))
    events.push(session.append('step/start', { turn, step: 1 }))
    events.push(session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `answer ${turn}` }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
      stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: [`answer ${turn}`] }],
    }, { surfaceOp: 'append' }))
    events.push(session.append('step/end', { turn, step: 1 }))
    events.push(session.append('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  return events
}

interface RealBackend {
  readonly ctx: Context
  readonly history: SessionHistoryController
  /** Complete durable log as stored, in seq order. */
  readonly events: readonly SessionEvent[]
  /** Current-generation path of the stored Session. */
  readonly generationPath: string
}

interface BackendOptions {
  readonly compression?: 'none' | 'zstd'
  /** Append batch size; small batches give a compressed log several physical frames. */
  readonly batchSize?: number
  /** Stored conversation length in Turns (six events each). */
  readonly turns?: number
  /** Store a fork-inherited generation, which the backend refuses to window. */
  readonly seeded?: boolean
  /** Leave the real few-KB artifact size so the small-source bypass applies. */
  readonly realSize?: boolean
}

/**
 * Size the fixture reports above the history controller's small-source
 * threshold. These generations are only a few KB on disk, which would send
 * every windowed case to the complete read instead of the durable index.
 */
const LARGE_STORED_SOURCE_BYTES = 3 * 1024 * 1024

/** Report the stored artifact large enough that the window path stays engaged. */
function reportLargeStoredSource(backend: RealBackend): void {
  const stat = backend.ctx.sessionPersistence.stat.bind(backend.ctx.sessionPersistence)
  vi.spyOn(backend.ctx.sessionPersistence, 'stat').mockImplementation(async (id, options) => {
    const snapshot = await stat(id, options)
    return snapshot === undefined ? undefined : { ...snapshot, sizeBytes: LARGE_STORED_SOURCE_BYTES }
  })
}

async function realBackend(options: BackendOptions = {}): Promise<RealBackend> {
  const compression = options.compression ?? 'zstd'
  const root = await mkdtemp(join(tmpdir(), 'dsh-history-paging-'))
  const logs = join(root, 'logs')
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: logs, compression })
  // A live Session supplies valid durable rows; the stored generation below is
  // a distinct Session so history must take the window path for it.
  const source = ctx.sessions.create(LIVE, { meta: { cwd: '/workspace' } })
  const sourceEvents = appendConversation(source, options.turns)
  // Prepare, not create: the seeded fork must not be live when history reads it.
  const fork = options.seeded === true
    ? ctx.sessions.prepare(STORED, {
      seed: source.snapshotEvents(),
      meta: { cwd: '/workspace', isSeeded: true },
      inheritedEventCount: source.seq,
    })
    : undefined
  const events = fork?.snapshotEvents() ?? sourceEvents
  const handle = await ctx.sessionPersistence.create(fork?.header ?? header(STORED), fork === undefined
    ? {}
    : { inheritedEventCount: source.seq })
  try {
    const batch = options.batchSize ?? 4
    for (let index = 0; index < events.length; index += batch) {
      await handle.append(events.slice(index, index + batch))
    }
  } finally {
    await handle.close()
  }
  const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
  const backend: RealBackend = {
    ctx,
    history,
    events,
    generationPath: logPath(logs, '/workspace', STORED, compression),
  }
  if (options.realSize !== true) reportLargeStoredSource(backend)
  return backend
}

async function loadPage(
  history: SessionHistoryController,
  request: Omit<SessionPageRequest, 'address'>,
  sessionId: SessionId = STORED,
): Promise<SessionPage> {
  return history.page(
    { address: { kind: 'session', sessionId }, ...request },
    new AbortController().signal,
  )
}

async function openSnapshot(
  history: SessionHistoryController,
  request: Pick<SessionFollowRequest, 'maxMessages' | 'turnWindow'> = {},
  sessionId: SessionId = STORED,
): Promise<Extract<SessionFollowFrame, { readonly type: 'snapshot' }>> {
  const abort = new AbortController()
  const iterator = history.follow(
    { address: { kind: 'session', sessionId }, ...request },
    abort.signal,
  )[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    if (first.done || first.value.type !== 'snapshot') throw new Error('expected one opening snapshot')
    return first.value
  } finally {
    abort.abort()
    await iterator.return?.()
  }
}

function pageSeqs(page: SessionPage): number[] {
  return page.records.map(record => record.event.seq)
}

interface PageRequest {
  readonly throughSeq: number
  readonly beforeSeq: number
  readonly maxMessages: number
}

/**
 * Walk backwards from an opened window exactly as the client's loadOlder does:
 * the inclusive `throughSeq` stays at the opening cursor while `beforeSeq`
 * moves down to the window's first event.
 */
async function loadOlderWalk(
  history: SessionHistoryController,
  opening: Pick<SessionPage, 'records' | 'hasMore'> & { readonly cursor: number },
  maxMessages: number,
): Promise<{ readonly requests: readonly PageRequest[]; readonly pages: readonly SessionPage[] }> {
  const requests: PageRequest[] = []
  const pages: SessionPage[] = [{ records: opening.records, hasMore: opening.hasMore }]
  let beforeSeq = opening.records[0]?.event.seq
  while (pages[0]?.hasMore === true) {
    if (beforeSeq === undefined) throw new Error('a window reporting more history returned no records')
    const request = { throughSeq: opening.cursor, beforeSeq, maxMessages }
    const page = await loadPage(history, request)
    requests.push(request)
    pages.unshift(page)
    beforeSeq = page.records[0]?.event.seq
  }
  return { requests, pages }
}

describe('Session history paging through the real JSONL generation index', () => {
  it.each([
    { name: 'compressed multi-frame', compression: 'zstd' as const },
    { name: 'plaintext', compression: 'none' as const },
  ])('walks loadOlder over a $name generation equal to the complete source', async ({ compression }) => {
    const backend = await realBackend({ compression })
    const readWindow = vi.spyOn(backend.ctx.sessionQuery, 'readWindow')
    const open = vi.spyOn(backend.ctx.sessionPersistence, 'open')

    // Without a projection checkpoint the opening falls back to the complete
    // observation, so clear the full-read spy before the page walk.
    const opening = await openSnapshot(backend.history, { maxMessages: 2 })
    expect(pageSeqs(opening)).toEqual([13, 14, 15, 16, 17])
    expect(opening.hasMore).toBe(true)
    open.mockClear()

    const walk = await loadOlderWalk(backend.history, opening, 2)

    // Every older page was served by a backwards window read ending at that
    // page's own cut, so one page decodes one page; no handle-based full read
    // ran for any of them.
    expect(readWindow.mock.calls.slice(1).map(([, request]) => request?.beforeSeq))
      .toEqual(walk.requests.map(request => request.beforeSeq))
    expect(readWindow.mock.calls.slice(1).every(([, request]) => request?.maxEvents === 2_000)).toBe(true)
    expect(walk.requests.map(request => request.throughSeq)).toEqual(walk.requests.map(() => opening.cursor))
    expect(open).not.toHaveBeenCalled()
    // The walk is contiguous and covers the durable log exactly once. It stops
    // on the oldest page, which starts at zero and reports no more history.
    expect(walk.pages.flatMap(pageSeqs)).toEqual(backend.events.map(event => event.seq))
    expect(walk.pages[0]?.records[0]?.event.seq).toBe(0)
    expect(walk.pages[0]?.hasMore).toBe(false)
    expect(walk.pages.slice(1).every(page => page.hasMore)).toBe(true)

    // The first backwards read persisted the durable index beside the generation.
    const sidecar = JSON.parse(await readFile(windowIndexPath(backend.generationPath), 'utf8')) as {
      version: number
      source: { sizeBytes: number }
    }
    expect(sidecar.version).toBe(1)
    expect(sidecar.source.sizeBytes).toBe((await stat(backend.generationPath)).size)

    // The same cuts answered by the complete read produce identical pages.
    readWindow.mockResolvedValue(undefined)
    const complete: SessionPage[] = []
    for (const request of walk.requests) complete.unshift(await loadPage(backend.history, request))
    expect(complete).toEqual(walk.pages.slice(0, -1))
  })

  it('serves partial windows from inside a large compressed generation like the complete source', async () => {
    const backend = await realBackend({ turns: 350, batchSize: 300 })
    expect(backend.events.length).toBe(2_100)
    const readWindow = vi.spyOn(backend.ctx.sessionQuery, 'readWindow')
    const open = vi.spyOn(backend.ctx.sessionPersistence, 'open')
    const opening = await openSnapshot(backend.history, { maxMessages: 2 })
    open.mockClear()
    const tail = backend.events.length - 1
    // Cuts above the trailing 2,000-event bound start their index window inside
    // the generation instead of at its first row.
    const requests = [
      { throughSeq: tail, beforeSeq: tail + 1, maxMessages: 2 },
      { throughSeq: tail, beforeSeq: 2_080, maxMessages: 2 },
      { throughSeq: tail, beforeSeq: 2_005, maxMessages: 2 },
      { throughSeq: tail, beforeSeq: 2_001, maxMessages: 2 },
    ]

    const windowed: SessionPage[] = []
    for (const request of requests) {
      const page = await loadPage(backend.history, request)
      expect(page.records.length).toBeGreaterThan(0)
      expect(page.hasMore).toBe(true)
      windowed.push(page)
    }

    expect(open).not.toHaveBeenCalled()
    expect(readWindow.mock.calls.slice(1).map(([, request]) => request?.beforeSeq))
      .toEqual(requests.map(request => request.beforeSeq))
    // The window ends at each requested cut, never at the opening cursor, so a
    // cut deep inside the generation reads only its own lookback.
    expect(readWindow.mock.calls.slice(1).every(([, request]) => request?.maxEvents === 2_000)).toBe(true)
    expect(pageSeqs(windowed[0] as SessionPage)).toEqual([2_095, 2_096, 2_097, 2_098, 2_099])

    readWindow.mockResolvedValue(undefined)
    const complete: SessionPage[] = []
    for (const request of requests) complete.push(await loadPage(backend.history, request))
    expect(complete).toEqual(windowed)
    expect(pageSeqs(opening)).toEqual([2_095, 2_096, 2_097, 2_098, 2_099])
  })

  it('honors the Turn alignment of a client loadOlder request against the index', async () => {
    const backend = await realBackend()
    const readWindow = vi.spyOn(backend.ctx.sessionQuery, 'readWindow')
    const request = {
      throughSeq: backend.events.length - 1,
      beforeSeq: backend.events.length,
      maxMessages: 50,
      turnWindow: { minMessages: 2, minTurns: 2 },
    }

    const page = await loadPage(backend.history, request)

    // The page aligns at the start of the second Turn below the cut.
    expect(pageSeqs(page)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(page.hasMore).toBe(true)
    expect(readWindow).toHaveBeenCalledOnce()

    readWindow.mockResolvedValue(undefined)
    expect(await loadPage(backend.history, request)).toEqual(page)
  })

  it('serves the oldest page with hasMore false and the complete source agrees', async () => {
    const backend = await realBackend()
    const readWindow = vi.spyOn(backend.ctx.sessionQuery, 'readWindow')
    const request = { throughSeq: 3, beforeSeq: 4, maxMessages: 10 }

    const oldest = await loadPage(backend.history, request)

    expect(pageSeqs(oldest)).toEqual([0, 1, 2, 3])
    expect(oldest.hasMore).toBe(false)
    expect(readWindow).toHaveBeenCalledExactlyOnceWith(STORED, expect.objectContaining({ beforeSeq: 4 }))

    readWindow.mockResolvedValue(undefined)
    expect(await loadPage(backend.history, request)).toEqual(oldest)
  })

  it('rejects a cut past the stored cursor as the complete source does', async () => {
    const backend = await realBackend()
    const readWindow = vi.spyOn(backend.ctx.sessionQuery, 'readWindow')
    const past = backend.events.length + 10
    const request = { throughSeq: past, beforeSeq: past + 1 }

    await expect(loadPage(backend.history, request)).rejects.toThrow(/past cursor/)

    readWindow.mockResolvedValue(undefined)
    await expect(loadPage(backend.history, request)).rejects.toThrow(/past cursor/)
  })

  it('keeps the exact gap-repair source path when the request carries no cut', async () => {
    const backend = await realBackend()
    const readWindow = vi.spyOn(backend.ctx.sessionQuery, 'readWindow')
    const observe = vi.spyOn(backend.ctx.sessionQuery, 'observeSession')
    const throughSeq = backend.events.length - 1

    const repaired = await loadPage(backend.history, { throughSeq, maxMessages: 3 })

    expect(readWindow).not.toHaveBeenCalled()
    expect(observe).toHaveBeenCalledOnce()
    expect(pageSeqs(repaired)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(repaired.hasMore).toBe(true)

    // The equivalent backwards window covers the same cut; only that request reads the index.
    const windowed = await loadPage(backend.history, { throughSeq, beforeSeq: throughSeq + 1, maxMessages: 3 })
    expect(windowed).toEqual(repaired)
    expect(readWindow).toHaveBeenCalledOnce()
    expect(observe).toHaveBeenCalledOnce()
  })

  it('keeps the live-session source path even when a window capability is mounted', async () => {
    const backend = await realBackend()
    const readWindow = vi.spyOn(backend.ctx.sessionQuery, 'readWindow')
    const throughSeq = backend.events.length - 1
    const request = { throughSeq, beforeSeq: throughSeq + 1, maxMessages: 2 }

    const live = await loadPage(backend.history, request, LIVE)

    expect(readWindow).not.toHaveBeenCalled()
    expect(pageSeqs(live)).toEqual([13, 14, 15, 16, 17])
    expect(live.hasMore).toBe(true)

    // The stored generation's identical rows answer the same cut identically.
    expect(await loadPage(backend.history, request)).toEqual(live)
    expect(readWindow).toHaveBeenCalledOnce()
  })

  it('skips the stored window for a small artifact and reads the complete source', async () => {
    const backend = await realBackend({ realSize: true })
    const stored = await backend.ctx.sessionPersistence.stat(STORED)
    // The real artifact is far below the documented 2 MiB bypass threshold.
    expect(stored?.sizeBytes).toBeLessThan(2 * 1024 * 1024)
    const readWindow = vi.spyOn(backend.ctx.sessionQuery, 'readWindow')
    const open = vi.spyOn(backend.ctx.sessionPersistence, 'open')
    const tail = backend.events.length - 1
    const request = { throughSeq: tail, beforeSeq: tail + 1, maxMessages: 2 }

    const page = await loadPage(backend.history, request)
    const frame = await openSnapshot(backend.history, { maxMessages: 2 })

    expect(pageSeqs(page)).toEqual([13, 14, 15, 16, 17])
    expect(page.hasMore).toBe(true)
    expect(frame.cursor).toBe(tail)
    expect(readWindow).not.toHaveBeenCalled()
    // The complete read runs through the handle-based observation path.
    expect(open).toHaveBeenCalled()
  })

  it('falls back to the exact observation when the real window carries no projection baseline', async () => {    const backend = await realBackend()
    const readWindow = vi.spyOn(backend.ctx.sessionQuery, 'readWindow')
    const observe = vi.spyOn(backend.ctx.sessionQuery, 'observeSession')

    const frame = await openSnapshot(backend.history)

    // The tail window itself succeeded; without a complete checkpoint baseline
    // the opener takes the complete observation instead of inventing values.
    expect(readWindow).toHaveBeenCalledOnce()
    expect(readWindow.mock.calls[0]?.[1]).not.toHaveProperty('beforeSeq')
    expect(observe).toHaveBeenCalledOnce()
    expect(frame.records.map(record => record.event.seq)).toEqual(backend.events.map(event => event.seq))
    expect(frame.cursor).toBe(backend.events.length - 1)
    expect(frame.hasMore).toBe(false)
    expect(frame.projections.asOfSeq).toBe(frame.cursor)

    // Pages carry no projection block, so the index still serves them.
    const page = await loadPage(backend.history, {
      throughSeq: backend.events.length - 1,
      beforeSeq: backend.events.length,
      maxMessages: 2,
    })
    expect(pageSeqs(page)).toEqual([13, 14, 15, 16, 17])
    expect(observe).toHaveBeenCalledOnce()
  })
})

/** A seeded generation cannot be windowed; history must keep the complete read. */
describe('Session history paging fallbacks for a generation the index cannot serve', () => {
  it('falls back to the complete source for a seeded generation', async () => {
    const backend = await realBackend({ seeded: true })
    // Fixture sanity: the injected inherited prefix ends in its marker row.
    expect(backend.events.at(-1)?.type).toBe('session/end-seed')
    expect(backend.events.at(-1)?.seq).toBe(backend.events.length - 1)
    const readWindow = vi.spyOn(backend.ctx.sessionQuery, 'readWindow')
    const observe = vi.spyOn(backend.ctx.sessionQuery, 'observeSession')

    const page = await loadPage(backend.history, {
      throughSeq: backend.events.length - 1,
      beforeSeq: backend.events.length,
      maxMessages: 2,
    })

    expect(readWindow).toHaveBeenCalledOnce()
    expect(observe).toHaveBeenCalledOnce()
    expect(pageSeqs(page)).toEqual([13, 14, 15, 16, 17, 18])
    expect(page.hasMore).toBe(true)
  })
})
