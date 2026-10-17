/** Stored-history window fast path and complete-source fallback. */

import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionWindow, SessionWindowRequest } from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'
import { SessionHistoryController } from '../src/history.ts'
import type {
  SessionFollowFrame,
  SessionFollowRequest,
  SessionPage,
  SessionPageRequest,
} from '../src/types.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const SESSION = SessionId('window-session')

function header(id: SessionId = SESSION): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: '/workspace' }
}

/** Three Turns of append-origin messages padded with non-message journal events. */
function conversation(): SessionEvent[] {
  const events: SessionEvent[] = []
  const append = (type: string, data: unknown, surfaceOp?: 'append'): void => {
    events.push({
      type,
      seq: SessionSeq(events.length),
      time: events.length + 1,
      data,
      ...surfaceOp === undefined ? {} : { surfaceOp },
    } as SessionEvent)
  }
  for (const turn of [1, 2, 3]) {
    append('turn/start', { turn })
    append('user/message', createUserMessage({
      content: [{ type: 'text', text: `question ${turn}` }], source: { kind: 'user' },
    }), 'append')
    append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `answer ${turn}` }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
      stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: [`answer ${turn}`] }],
    }, 'append')
    append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return events
}

interface WindowReaderOptions {
  /** Whether the test backend can serve a `beforeSeq` window. */
  readonly beforeSeq?: boolean
  /** Largest slice this backend returns regardless of the requested bound. */
  readonly maxQueryEvents?: number
}

/** Emulate a generation-index read: tail window, optional backwards window. */
function storedWindowReader(
  meta: SessionHeader,
  events: readonly SessionEvent[],
  options: WindowReaderOptions = {},
): (id: SessionId, request?: SessionWindowRequest) => Promise<SessionWindow | undefined> {
  return async (_id, request) => {
    const beforeSeq = request?.beforeSeq
    if (beforeSeq !== undefined && options.beforeSeq !== true) return undefined
    const below = beforeSeq === undefined ? events : events.filter(event => event.seq < beforeSeq)
    const limit = Math.min(request?.maxEvents ?? 2_000, options.maxQueryEvents ?? Number.MAX_SAFE_INTEGER)
    const slice = below.slice(Math.max(0, below.length - limit))
    return {
      header: structuredClone(meta),
      inheritedEventCount: SessionLogOffset(0),
      events: [...slice],
      cursor: slice.at(-1)?.seq ?? -1,
      hasMore: slice.length < below.length,
    }
  }
}

interface Fixture {
  readonly ctx: Context
  readonly history: SessionHistoryController
}

interface FixtureOptions {
  readonly readWindow?: (id: SessionId, request?: SessionWindowRequest) => Promise<SessionWindow | undefined>
  readonly checkpoint?: ProjectionSnapshot
}

/** One stored Session with an optional window capability and checkpoint cache. */
async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  const meta = header()
  const events = conversation()
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([meta]),
    inspect: () => Promise.resolve({ meta, inheritedEventCount: SessionLogOffset(0), events }),
    ...options.readWindow === undefined ? {} : { readWindow: options.readWindow },
  }) as never)
  if (options.checkpoint !== undefined) {
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => options.checkpoint } as never)
  }
  return { ctx, history: new SessionHistoryController(ctx, observation => { observation[Symbol.dispose]() }) }
}

/** Read exactly one opening frame and release the follower. */
async function openSnapshot(
  fixture: Fixture,
  request: Pick<SessionFollowRequest, 'maxMessages' | 'turnWindow' | 'assistantStream'> = {},
): Promise<Extract<SessionFollowFrame, { readonly type: 'snapshot' }>> {
  const abort = new AbortController()
  const iterator = fixture.history.follow(
    { address: { kind: 'session', sessionId: SESSION }, ...request },
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

async function page(
  fixture: Fixture,
  request: Omit<SessionPageRequest, 'address'>,
): Promise<SessionPage> {
  return fixture.history.page(
    { address: { kind: 'session', sessionId: SESSION }, ...request },
    new AbortController().signal,
  )
}

function seqs(page: SessionPage): number[] {
  return page.records.map(record => record.event.seq)
}

describe('Session history stored window path', () => {
  it('opens follow from a bounded tail window and sends the checkpoint unchanged', async () => {
    const events = conversation()
    const checkpoint: ProjectionSnapshot = { asOfSeq: SessionSeq(2), values: { title: 'checkpointed' } }
    const readWindow = vi.fn(storedWindowReader(header(), events))
    const windowed = await fixture({ readWindow, checkpoint })
    const full = await fixture()
    const observe = vi.spyOn(windowed.ctx.sessionQuery, 'observeSession')
    try {
      const frame = await openSnapshot(windowed)
      const complete = await openSnapshot(full)

      expect(frame.cursor).toBe(events.length - 1)
      expect(frame.records.map(record => record.event.seq)).toEqual(events.map(event => event.seq))
      expect(frame.hasMore).toBe(false)
      expect(frame.records.map(record => record.event.seq))
        .toEqual(complete.records.map(record => record.event.seq))
      expect(frame.hasMore).toBe(complete.hasMore)
      // The stored watermark is passed through, never rewritten to the window cursor.
      expect(frame.projections).toEqual({ asOfSeq: 2, values: { title: 'checkpointed' } })
      expect(observe).not.toHaveBeenCalled()
      expect(readWindow).toHaveBeenCalledOnce()
      expect(readWindow.mock.calls[0]?.[1]).not.toHaveProperty('beforeSeq')
    } finally {
      await windowed.ctx.fiber.dispose()
      await full.ctx.fiber.dispose()
    }
  })

  it('serves an older page from a window that covers the dense anchor', async () => {
    const events = conversation()
    const readWindow = vi.fn(storedWindowReader(header(), events, { beforeSeq: true }))
    const windowed = await fixture({ readWindow })
    const full = await fixture()
    const request = { throughSeq: events.length - 1, beforeSeq: 6, maxMessages: 2 }
    try {
      const fromWindow = await page(windowed, request)
      const complete = await page(full, request)

      expect(seqs(fromWindow)).toEqual(seqs(complete))
      expect(fromWindow.hasMore).toBe(complete.hasMore)
      expect(readWindow).toHaveBeenCalledOnce()
      expect(readWindow.mock.calls[0]?.[1]).toMatchObject({ beforeSeq: events.length })
    } finally {
      await windowed.ctx.fiber.dispose()
      await full.ctx.fiber.dispose()
    }
  })

  it('falls back to the complete source when a backwards window is unavailable', async () => {
    const events = conversation()
    const readWindow = vi.fn(storedWindowReader(header(), events))
    const windowed = await fixture({ readWindow })
    const full = await fixture()
    const observe = vi.spyOn(windowed.ctx.sessionQuery, 'observeSession')
    const request = { throughSeq: events.length - 1, beforeSeq: 6, maxMessages: 2 }
    try {
      const fallback = await page(windowed, request)
      const complete = await page(full, request)

      expect(seqs(fallback)).toEqual(seqs(complete))
      expect(fallback.hasMore).toBe(complete.hasMore)
      expect(readWindow).toHaveBeenCalledOnce()
      expect(readWindow.mock.calls[0]?.[1]).toMatchObject({ beforeSeq: events.length })
      expect(observe).toHaveBeenCalledOnce()
    } finally {
      await windowed.ctx.fiber.dispose()
      await full.ctx.fiber.dispose()
    }
  })

  it('serves an empty tail cut from a tail window without scanning the log', async () => {
    const events = conversation()
    const readWindow = vi.fn(storedWindowReader(header(), events))
    const windowed = await fixture({ readWindow })
    const observe = vi.spyOn(windowed.ctx.sessionQuery, 'observeSession')
    try {
      const empty = await page(windowed, { throughSeq: -1 })

      expect(empty).toEqual({ records: [], hasMore: false })
      expect(readWindow).toHaveBeenCalledOnce()
      expect(readWindow.mock.calls[0]?.[1]).not.toHaveProperty('beforeSeq')
      expect(observe).not.toHaveBeenCalled()
    } finally {
      await windowed.ctx.fiber.dispose()
    }
  })

  it('falls back to the complete source when no window capability is mounted', async () => {
    const missing = await fixture()
    const full = await fixture()
    const readWindow = vi.spyOn(missing.ctx.sessionQuery, 'readWindow')
    const observe = vi.spyOn(missing.ctx.sessionQuery, 'observeSession')
    try {
      const frame = await openSnapshot(missing)
      const complete = await openSnapshot(full)

      expect(frame.records.map(record => record.event.seq))
        .toEqual(complete.records.map(record => record.event.seq))
      expect(frame.cursor).toBe(complete.cursor)
      expect(frame.hasMore).toBe(complete.hasMore)
      expect(frame.projections).toEqual(complete.projections)
      expect(readWindow).toHaveBeenCalledOnce()
      expect(observe).toHaveBeenCalledOnce()
    } finally {
      await missing.ctx.fiber.dispose()
      await full.ctx.fiber.dispose()
    }
  })

  it('falls back to the complete source when the window carries no projection checkpoint', async () => {
    const events = conversation()
    const readWindow = vi.fn(storedWindowReader(header(), events))
    const windowed = await fixture({ readWindow })
    const observe = vi.spyOn(windowed.ctx.sessionQuery, 'observeSession')
    try {
      const frame = await openSnapshot(windowed)

      expect(readWindow).toHaveBeenCalledOnce()
      expect(observe).toHaveBeenCalledOnce()
      // The exact observation reports its own watermark at the opening cursor.
      expect(frame.projections.asOfSeq).toBe(frame.cursor)
      expect(frame.records.map(record => record.event.seq))
        .toEqual(events.map(event => event.seq))
    } finally {
      await windowed.ctx.fiber.dispose()
    }
  })

  it('falls back when the window starts above the requested page cut', async () => {
    const events = conversation()
    const readWindow = vi.fn(storedWindowReader(header(), events, { maxQueryEvents: 4 }))
    const windowed = await fixture({ readWindow })
    const full = await fixture()
    const observe = vi.spyOn(windowed.ctx.sessionQuery, 'observeSession')
    try {
      const fallback = await page(windowed, { throughSeq: events.length - 1, beforeSeq: 6, maxMessages: 2 })
      const complete = await page(full, { throughSeq: events.length - 1, beforeSeq: 6, maxMessages: 2 })

      expect(seqs(fallback)).toEqual(seqs(complete))
      expect(fallback.hasMore).toBe(complete.hasMore)
      expect(observe).toHaveBeenCalledOnce()
    } finally {
      await windowed.ctx.fiber.dispose()
      await full.ctx.fiber.dispose()
    }
  })
})
