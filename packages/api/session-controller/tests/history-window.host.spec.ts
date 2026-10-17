/** Independent coverage of the stored-history window fast path and its exact fallbacks. */

import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionWindow, SessionWindowRequest } from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionHistoryController } from '../src/history.ts'
import type {
  SessionFollowFrame,
  SessionFollowRequest,
  SessionPage,
  SessionPageRequest,
} from '../src/types.ts'
import { installSessionReadTestServices } from './test-remote.ts'

const SESSION = SessionId('history-window-integration')

function header(id: SessionId = SESSION): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
    cwd: '/workspace',
  }
}

/** Three Turns of append-origin messages separated by non-message journal rows. */
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
      content: [{ type: 'text', text: `question ${turn}` }],
      source: { kind: 'user' },
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

/** Append the same conversation to a live Session and return the durable events. */
function appendConversation(session: Session): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const turn of [1, 2, 3]) {
    events.push(session.append('turn/start', { turn }))
    events.push(session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `question ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }))
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
    events.push(session.append('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  return events
}

/** An exact prepared observation over one complete stored log. */
function observationOf(
  events: readonly SessionEvent[],
  projections?: ProjectionSnapshot,
  meta: SessionHeader = header(),
): SessionObservation {
  const observation: SessionObservation = {
    source: 'prepared',
    header: structuredClone(meta),
    inheritedEventCount: SessionLogOffset(0),
    events: [...events],
    cursor: SessionSeq(events.at(-1)?.seq ?? -1),
    ...projections === undefined ? {} : { projections },
    retain: () => observation,
    [Symbol.dispose]: () => {},
  }
  return observation
}

type WindowRead = (id: SessionId, request?: SessionWindowRequest) => Promise<SessionWindow | undefined>

interface WindowBackendOptions {
  /** Whether this backend can end a window at a caller-supplied `beforeSeq`. */
  readonly beforeSeq?: boolean
  /** Largest event count this backend returns regardless of the requested bound. */
  readonly maxEvents?: number
}

/** One stored-generation double: tail windows, plus backwards windows when enabled. */
function windowBackend(
  meta: SessionHeader,
  events: readonly SessionEvent[],
  options: WindowBackendOptions = {},
): WindowRead {
  return async (id, request) => {
    if (id !== meta.id) return undefined
    const before = request?.beforeSeq
    if (before !== undefined && options.beforeSeq !== true) return undefined
    const below = before === undefined ? events : events.filter(event => event.seq < before)
    const limit = Math.min(request?.maxEvents ?? 2_000, options.maxEvents ?? Number.POSITIVE_INFINITY)
    const selected = below.slice(Math.max(0, below.length - limit))
    return {
      header: structuredClone(meta),
      inheritedEventCount: SessionLogOffset(0),
      events: [...selected],
      cursor: SessionSeq(selected.at(-1)?.seq ?? -1),
      hasMore: selected.length < below.length,
    }
  }
}

interface FixtureOptions {
  /** Stored window capability; omitted mounts a service that has none. */
  readonly readWindow?: WindowRead
  /** Mount a persistence service at all; a capability-less one answers nothing. */
  readonly mountPersistence?: boolean
  /** Checkpoint the projection cache reports for the stored header. */
  readonly checkpoint?: ProjectionSnapshot
  /** Exact observation the complete source path serves. */
  readonly observation?: SessionObservation
}

/** One cold Session address whose complete source is an explicit observation. */
async function fixture(options: FixtureOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  if (options.mountPersistence !== false) {
    ctx.provide('sessionPersistence', {
      ...options.readWindow === undefined ? {} : { readWindow: options.readWindow },
    } as never)
  }
  if (options.checkpoint !== undefined) {
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => options.checkpoint } as never)
  }
  const observeSession = vi.spyOn(ctx.sessionQuery, 'observeSession')
  if (options.observation !== undefined) observeSession.mockResolvedValue(options.observation)
  const history = new SessionHistoryController(ctx, observation => { observation[Symbol.dispose]() })
  onTestFinished(() => ctx.fiber.dispose())
  return { ctx, history, observeSession }
}

/** Read exactly one opening frame and release its follower. */
async function openSnapshot(
  history: SessionHistoryController,
  request: Omit<SessionFollowRequest, 'address'> = {},
  sessionId: SessionId = SESSION,
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

async function loadPage(
  history: SessionHistoryController,
  request: Omit<SessionPageRequest, 'address'>,
  sessionId: SessionId = SESSION,
): Promise<SessionPage> {
  return history.page(
    { address: { kind: 'session', sessionId }, ...request },
    new AbortController().signal,
  )
}

function pageSeqs(page: SessionPage): number[] {
  return page.records.map(record => record.event.seq)
}

function frameSeqs(frame: Extract<SessionFollowFrame, { readonly type: 'snapshot' }>): number[] {
  return frame.records.map(record => record.event.seq)
}

describe('Session history follow from a stored window', () => {
  it.each([
    { name: 'default limits', request: {} },
    { name: 'one message', request: { maxMessages: 1 } },
    { name: 'three messages', request: { maxMessages: 3 } },
    { name: 'two aligned Turns', request: { maxMessages: 50, turnWindow: { minMessages: 2, minTurns: 2 } } },
  ])('opens the same $name frame as the complete observation', async ({ request }) => {
    const events = conversation()
    const checkpoint: ProjectionSnapshot = { asOfSeq: SessionSeq(1), values: { title: 'checkpointed' } }
    const readWindow = vi.fn(windowBackend(header(), events))
    const windowed = await fixture({ readWindow, checkpoint })
    const complete = await fixture({
      observation: observationOf(events, { asOfSeq: SessionSeq(events.length - 1), values: {} }),
    })

    const fromWindow = await openSnapshot(windowed.history, request)
    const fromObservation = await openSnapshot(complete.history, request)

    expect(frameSeqs(fromWindow)).toEqual(frameSeqs(fromObservation))
    expect(fromWindow.cursor).toBe(fromObservation.cursor)
    expect(fromWindow.hasMore).toBe(fromObservation.hasMore)
    expect(fromWindow.header.id).toBe(SESSION)
    // The checkpoint keeps its stored watermark instead of the opening cursor.
    expect(fromWindow.projections).toEqual(checkpoint)
    expect(fromWindow.projections.asOfSeq).toBe(1)
    expect(fromWindow.projections.asOfSeq).not.toBe(fromWindow.cursor)
    expect(windowed.observeSession).not.toHaveBeenCalled()
    expect(complete.observeSession).toHaveBeenCalledOnce()
    expect(readWindow).toHaveBeenCalledExactlyOnceWith(SESSION, expect.objectContaining({
      maxEvents: expect.any(Number) as number,
    }))
    expect(readWindow.mock.calls[0]?.[1]).not.toHaveProperty('beforeSeq')
    expect(readWindow.mock.calls[0]?.[1]?.maxEvents).toBeGreaterThanOrEqual(2_000)
  })

  it('falls back to the exact observation when the stored tail cannot cover the page', async () => {
    const events = conversation()
    const readWindow = vi.fn(windowBackend(header(), events, { maxEvents: 4 }))
    const exact: ProjectionSnapshot = { asOfSeq: SessionSeq(events.length - 1), values: { title: 'exact' } }
    const windowed = await fixture({ readWindow, observation: observationOf(events, exact) })

    const frame = await openSnapshot(windowed.history)

    // The truncated tail starts above seq 0 and cannot resolve the message
    // budget, so the complete observation answers instead of a partial frame.
    expect(windowed.observeSession).toHaveBeenCalledOnce()
    expect(frameSeqs(frame)).toEqual(events.map(event => event.seq))
    expect(frame.hasMore).toBe(false)
    expect(frame.projections).toEqual(exact)
    expect(frame.projections.asOfSeq).toBe(frame.cursor)
  })
})

describe('Session history page from a stored window', () => {
  it('serves a loadOlder walk from backwards windows exactly like the complete source', async () => {
    const events = conversation()
    const readWindow = vi.fn(windowBackend(header(), events, { beforeSeq: true }))
    const windowed = await fixture({ readWindow })
    const complete = await fixture({ observation: observationOf(events) })
    const requests = [
      { throughSeq: events.length - 1, beforeSeq: events.length, maxMessages: 3 },
      { throughSeq: 5, beforeSeq: 6, maxMessages: 3 },
      { throughSeq: 2, beforeSeq: 3, maxMessages: 3 },
      { throughSeq: 11, beforeSeq: 12, maxMessages: 50, turnWindow: { minMessages: 2, minTurns: 2 } },
    ]

    for (const request of requests) {
      const fromWindow = await loadPage(windowed.history, request)
      const fromComplete = await loadPage(complete.history, request)
      expect(pageSeqs(fromWindow)).toEqual(pageSeqs(fromComplete))
      expect(fromWindow.hasMore).toBe(fromComplete.hasMore)
    }

    expect(windowed.observeSession).not.toHaveBeenCalled()
    expect(readWindow).toHaveBeenCalledTimes(requests.length)
    expect(readWindow.mock.calls.map(([, request]) => request?.beforeSeq))
      .toEqual(requests.map(request => request.beforeSeq))
  })

  it('serves the empty tail cut from a tail-only backend without scanning the complete log', async () => {
    const events = conversation()
    const readWindow = vi.fn(windowBackend(header(), events))
    const windowed = await fixture({ readWindow })

    const empty = await loadPage(windowed.history, { throughSeq: -1 })

    expect(empty).toEqual({ records: [], hasMore: false })
    expect(windowed.observeSession).not.toHaveBeenCalled()
    expect(readWindow.mock.calls[0]?.[1]).toMatchObject({ maxEvents: 1 })
    expect(readWindow.mock.calls[0]?.[1]).not.toHaveProperty('beforeSeq')
  })

  it('falls back to the complete source for older pages when the backend serves only tails', async () => {
    const events = conversation()
    const readWindow = vi.fn(windowBackend(header(), events))
    const windowed = await fixture({ readWindow, observation: observationOf(events) })
    const complete = await fixture({ observation: observationOf(events) })
    const request = { throughSeq: 5, beforeSeq: 6 }

    const fallback = await loadPage(windowed.history, request)
    const expected = await loadPage(complete.history, request)

    expect(pageSeqs(fallback)).toEqual(pageSeqs(expected))
    expect(pageSeqs(fallback)).toEqual([0, 1, 2, 3, 4, 5])
    expect(fallback.hasMore).toBe(false)
    expect(readWindow).toHaveBeenCalledOnce()
    expect(readWindow.mock.calls[0]?.[1]).toMatchObject({ beforeSeq: 6 })
    expect(windowed.observeSession).toHaveBeenCalledOnce()
  })

  it('serves the oldest page from a backwards window exactly like the complete source', async () => {
    const events = conversation()
    const readWindow = vi.fn(windowBackend(header(), events, { beforeSeq: true }))
    const windowed = await fixture({ readWindow })
    const complete = await fixture({ observation: observationOf(events) })
    const request = { throughSeq: 5, beforeSeq: 6 }

    const oldest = await loadPage(windowed.history, request)
    const completeOldest = await loadPage(complete.history, request)
    expect(pageSeqs(oldest)).toEqual([0, 1, 2, 3, 4, 5])
    expect(pageSeqs(oldest)).toEqual(pageSeqs(completeOldest))
    expect(oldest.hasMore).toBe(false)
    expect(completeOldest.hasMore).toBe(false)
    expect(windowed.observeSession).not.toHaveBeenCalled()
    expect(readWindow.mock.calls[0]?.[1]).toMatchObject({ beforeSeq: 6 })
  })

  it.each([
    { name: 'when no persistence service is mounted', mountPersistence: false },
    { name: 'when the persistence service declares no window capability', mountPersistence: true },
  ])('falls back to the complete source $name', async ({ mountPersistence }) => {
    const events = conversation()
    const windowed = await fixture({
      mountPersistence,
      observation: observationOf(events),
    })
    const sessionQuery = vi.spyOn(windowed.ctx.sessionQuery, 'readWindow')

    const frame = await openSnapshot(windowed.history)
    const page = await loadPage(windowed.history, { throughSeq: 5, beforeSeq: 6 })

    expect(sessionQuery).toHaveBeenCalledTimes(2)
    expect(windowed.observeSession).toHaveBeenCalledTimes(2)
    expect(frameSeqs(frame)).toEqual(events.map(event => event.seq))
    expect(frame.hasMore).toBe(false)
    expect(pageSeqs(page)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('falls back for follow when the window has no projection checkpoint, while pages stay windowed', async () => {
    const events = conversation()
    const readWindow = vi.fn(windowBackend(header(), events, { beforeSeq: true }))
    const exact: ProjectionSnapshot = { asOfSeq: SessionSeq(11), values: { title: 'exact' } }
    const windowed = await fixture({ readWindow, observation: observationOf(events, exact) })

    const frame = await openSnapshot(windowed.history)
    expect(windowed.observeSession).toHaveBeenCalledOnce()
    expect(frame.projections).toEqual(exact)

    // A page carries no projection block, so the same stored window still
    // answers it without another complete observation.
    const page = await loadPage(windowed.history, { throughSeq: 5, beforeSeq: 6 })
    expect(pageSeqs(page)).toEqual([0, 1, 2, 3, 4, 5])
    expect(windowed.observeSession).toHaveBeenCalledOnce()
    expect(readWindow).toHaveBeenCalledTimes(2)
  })

  it('keeps the exact source path for gap-repair pages without a cut', async () => {
    const events = conversation()
    const readWindow = vi.fn(windowBackend(header(), events, { beforeSeq: true }))
    const windowed = await fixture({ readWindow, observation: observationOf(events) })

    const page = await loadPage(windowed.history, { throughSeq: events.length - 1, maxMessages: 3 })

    expect(readWindow).not.toHaveBeenCalled()
    expect(windowed.observeSession).toHaveBeenCalledOnce()
    expect(pageSeqs(page)).toEqual([6, 7, 8, 9, 10, 11])
    expect(page.hasMore).toBe(true)
  })
})

describe('Session history live Sessions', () => {
  it('keeps the exact live source path and never reads a stored window', async () => {
    const readWindow = vi.fn<WindowRead>().mockRejectedValue(
      new Error('a live Session must not read a stored window'),
    )
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    ctx.provide('sessionPersistence', { readWindow } as never)
    const history = new SessionHistoryController(ctx, observation => { observation[Symbol.dispose]() })
    onTestFinished(() => ctx.fiber.dispose())
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const events = appendConversation(session)
    const cold = await fixture({ observation: observationOf(events, undefined, session.header) })
    const pageRequest = { throughSeq: events.length - 1, beforeSeq: events.length, maxMessages: 3 }

    const livePage = await loadPage(history, pageRequest, session.id)
    const coldPage = await loadPage(cold.history, pageRequest, session.id)
    expect(pageSeqs(livePage)).toEqual(pageSeqs(coldPage))
    expect(livePage.hasMore).toBe(coldPage.hasMore)

    const liveFrame = await openSnapshot(history, {}, session.id)
    const coldFrame = await openSnapshot(cold.history, {}, session.id)
    expect(frameSeqs(liveFrame)).toEqual(frameSeqs(coldFrame))
    expect(liveFrame.cursor).toBe(events.length - 1)
    expect(liveFrame.hasMore).toBe(false)
    expect(readWindow).not.toHaveBeenCalled()
  })
})
