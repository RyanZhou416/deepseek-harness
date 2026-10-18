/**
 * Edges of the stored-history window path: a tail ending inside an interrupted
 * Turn, an opening cursor above the stored window, incomplete projection
 * checkpoints that omit the block, and seeded/historical fallbacks that must
 * not be windowed.
 */

import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  interruptedTurnClosers,
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionWindow, SessionWindowRequest } from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionHistoryController } from '../src/history.ts'
import type { SessionFollowFrame, SessionFollowRequest, SessionPage, SessionPageRequest } from '../src/types.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const SESSION = SessionId('history-window-edge')

function header(meta: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SESSION,
    createdAt: 1,
    isSeeded: false,
    cwd: '/workspace',
    ...meta,
  }
}

/**
 * One completed Turn followed by a Turn whose writer stopped mid-step: the
 * last stored event answers a tool call that never recorded a result.
 */
function interruptedTurn(): SessionEvent[] {
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
  append('turn/start', { turn: 1 })
  append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'question 1' }], source: { kind: 'user' },
  }), 'append')
  append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer 1' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    }),
    stream: [],
  }, 'append')
  append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  append('turn/start', { turn: 2 })
  append('step/start', { turn: 2, step: 1 })
  append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'question 2' }], source: { kind: 'user' },
  }), 'append')
  append('assistant/message', {
    turn: 2,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId('interrupted-call'), name: 'bash', arguments: '{}' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    }),
    stream: [],
  }, 'append')
  append('tool/call', {
    turn: 2, step: 1, callId: ToolCallId('interrupted-call'), name: 'bash', arguments: '{}',
  })
  return events
}

/** The persisted log plus the authoritative crash-recovery closers. */
function balanced(events: readonly SessionEvent[]): SessionEvent[] {
  return [...events, ...interruptedTurnClosers(events)]
}

function lastSeq(events: readonly SessionEvent[]): number {
  return events.at(-1)?.seq ?? -1
}

type WindowRead = (id: SessionId, request?: SessionWindowRequest) => Promise<SessionWindow | undefined>

interface WindowBackendOptions {
  /** Whether this backend can end a window at a caller-supplied `beforeSeq`. */
  readonly beforeSeq?: boolean
  /** Stored header the backend reports, which may differ from the fixture header. */
  readonly meta?: SessionHeader
  /** Answer `undefined` like a backend that declines the window (seeded history). */
  readonly decline?: boolean
}

/** One stored-generation double serving tails and, when enabled, backwards windows. */
function windowBackend(
  events: readonly SessionEvent[],
  options: WindowBackendOptions = {},
): WindowRead {
  return async (_id, request) => {
    if (options.decline === true) return undefined
    const before = request?.beforeSeq
    if (before !== undefined && options.beforeSeq !== true) return undefined
    const below = before === undefined ? events : events.filter(event => event.seq < before)
    return {
      header: structuredClone(options.meta ?? header()),
      inheritedEventCount: SessionLogOffset(0),
      events: [...below],
      cursor: SessionSeq(lastSeq(below)),
      hasMore: false,
    }
  }
}

/** An exact prepared observation over one balanced stored log. */
function observationOf(
  events: readonly SessionEvent[],
  projections?: ProjectionSnapshot,
  meta: SessionHeader = header(),
  inheritedEventCount = SessionLogOffset(0),
): SessionObservation {
  const observation: SessionObservation = {
    source: 'prepared',
    header: structuredClone(meta),
    inheritedEventCount,
    events: [...events],
    cursor: SessionSeq(lastSeq(events)),
    ...projections === undefined ? {} : { projections },
    retain: () => observation,
    [Symbol.dispose]: () => {},
  }
  return observation
}

interface FixtureOptions {
  /** Stored window capability; omitted mounts a persistence double without one. */
  readonly readWindow?: WindowRead
  /** Stored header the point-read adapter lists. */
  readonly meta?: SessionHeader
  /** Checkpoint the projection cache reports for the stored header. */
  readonly checkpoint?: ProjectionSnapshot
  /** Exact observation the complete source path serves. */
  readonly observation?: SessionObservation
  /** Register the title projection so a checkpoint omitting `title` is incomplete. */
  readonly wireTitle?: boolean
}

/** One cold Session address with an optional window capability and checkpoint cache. */
async function fixture(options: FixtureOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  if (options.wireTitle === true) ctx.sessionProjections.register(titleProjectionDefinition)
  const meta = options.meta ?? header()
  const events = interruptedTurn()
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([meta]),
    inspect: () => Promise.resolve({ meta, inheritedEventCount: SessionLogOffset(0), events }),
    ...options.readWindow === undefined ? {} : { readWindow: options.readWindow },
  }) as never)
  if (options.checkpoint !== undefined) {
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => options.checkpoint } as never)
  }
  const observeSession = vi.spyOn(ctx.sessionQuery, 'observeSession')
  if (options.observation !== undefined) observeSession.mockResolvedValue(options.observation)
  const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
  onTestFinished(() => ctx.fiber.dispose())
  return { ctx, history, observeSession, events, meta }
}

/** Read exactly one opening frame and release the follower. */
async function openSnapshot(
  history: SessionHistoryController,
  request: Omit<SessionFollowRequest, 'address'> = {},
): Promise<Extract<SessionFollowFrame, { readonly type: 'snapshot' }>> {
  const abort = new AbortController()
  const iterator = history.follow({ address: { kind: 'session', sessionId: SESSION }, ...request }, abort.signal)
    [Symbol.asyncIterator]()
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
): Promise<SessionPage> {
  return history.page(
    { address: { kind: 'session', sessionId: SESSION }, ...request },
    new AbortController().signal,
  )
}

function frameSeqs(frame: Extract<SessionFollowFrame, { readonly type: 'snapshot' }>): number[] {
  return frame.records.map(record => record.event.seq)
}

function pageSeqs(page: SessionPage): number[] {
  return page.records.map(record => record.event.seq)
}

describe('Session history window tail ending mid-turn', () => {
  it('balances the opened window with interrupted closers and reports the closer cursor', async () => {
    const events = interruptedTurn()
    const balancedEvents = balanced(events)
    const checkpoint: ProjectionSnapshot = { asOfSeq: SessionSeq(6), values: { title: 'checkpointed' } }
    const readWindow = vi.fn(windowBackend(events))
    const windowed = await fixture({ readWindow, checkpoint })
    const complete = await fixture({
      observation: observationOf(balancedEvents, { asOfSeq: SessionSeq(lastSeq(balancedEvents)), values: {} }),
    })

    const frame = await openSnapshot(windowed.history)
    const fromComplete = await openSnapshot(complete.history)

    // The stored window ends at the unanswered tool call; the opening frame
    // continues with the synthetic result, step end, and interrupted turn end.
    expect(lastSeq(events)).toBe(8)
    expect(frame.cursor).toBe(lastSeq(balancedEvents))
    expect(frame.cursor).toBeGreaterThan(lastSeq(events))
    expect(frameSeqs(frame)).toEqual(balancedEvents.map(event => event.seq))
    expect(frame.records.slice(events.length).map(record => record.event.type))
      .toEqual(['tool/result', 'step/end', 'turn/end'])
    expect(frame.records.at(-1)?.event).toMatchObject({
      type: 'turn/end',
      data: { turn: 2, reason: { kind: 'interrupted' } },
    })
    expect(frame.records.at(-2)?.event).toMatchObject({ type: 'step/end', data: { turn: 2, step: 1 } })
    expect(frame.records.at(-3)?.event).toMatchObject({
      type: 'tool/result',
      data: { turn: 2, error: { name: 'ToolOutcomeUnknownError' } },
    })
    // The complete observation balances the same Turn, so the frames agree
    // except for the checkpoint watermark the window path reports unchanged.
    expect(frameSeqs(frame)).toEqual(frameSeqs(fromComplete))
    expect(frame.cursor).toBe(fromComplete.cursor)
    expect(frame.hasMore).toBe(fromComplete.hasMore)
    expect(frame.projections).toEqual(checkpoint)
    expect(frame.projections?.asOfSeq).toBe(6)
    expect(frame.projections?.asOfSeq).not.toBe(frame.cursor)
    expect(windowed.observeSession).not.toHaveBeenCalled()
    expect(readWindow).toHaveBeenCalledOnce()
    expect(readWindow.mock.calls[0]?.[1]).not.toHaveProperty('beforeSeq')
  })

  // The client pages older history with throughSeq = snapshot.cursor (the
  // closer cursor, 11) and beforeSeq = 12, which sits above the stored window
  // cursor (8). The window page read must defer that cut to the complete
  // source instead of rejecting it as past the window cursor.
  it('serves the older page whose cut is the balanced opening cursor', async () => {
    const events = interruptedTurn()
    const balancedEvents = balanced(events)
    const readWindow = vi.fn(windowBackend(events, { beforeSeq: true }))
    const windowed = await fixture({
      readWindow,
      checkpoint: { asOfSeq: SessionSeq(6), values: {} },
      observation: observationOf(balancedEvents, { asOfSeq: SessionSeq(lastSeq(balancedEvents)), values: {} }),
    })
    const complete = await fixture({
      observation: observationOf(balancedEvents, { asOfSeq: SessionSeq(lastSeq(balancedEvents)), values: {} }),
    })
    const frame = await openSnapshot(windowed.history)
    const request = { throughSeq: frame.cursor, beforeSeq: frame.cursor + 1, maxMessages: 2 }

    const fromWindow = await loadPage(windowed.history, request)
    const fromComplete = await loadPage(complete.history, request)

    expect(pageSeqs(fromWindow)).toEqual(pageSeqs(fromComplete))
    expect(fromWindow.hasMore).toBe(fromComplete.hasMore)
    // The opening tail read, then the older-page read; the latter falls back
    // because its cut is above the stored window cursor.
    expect(readWindow.mock.calls.map(([, read]) => read?.beforeSeq)).toEqual([undefined, frame.cursor + 1])
    expect(windowed.observeSession).toHaveBeenCalledOnce()
  })

  it('serves an older page cut at the stored window cursor without closers', async () => {
    const events = interruptedTurn()
    const balancedEvents = balanced(events)
    const readWindow = vi.fn(windowBackend(events, { beforeSeq: true }))
    const windowed = await fixture({
      readWindow,
      checkpoint: { asOfSeq: SessionSeq(6), values: {} },
      observation: observationOf(balancedEvents, { asOfSeq: SessionSeq(lastSeq(balancedEvents)), values: {} }),
    })
    const complete = await fixture({
      observation: observationOf(balancedEvents, { asOfSeq: SessionSeq(lastSeq(balancedEvents)), values: {} }),
    })
    // The stored cut keeps the page inside the validated window events.
    const request = { throughSeq: lastSeq(events), beforeSeq: lastSeq(events) + 1, maxMessages: 2 }

    const fromWindow = await loadPage(windowed.history, request)
    const fromComplete = await loadPage(complete.history, request)

    expect(pageSeqs(fromWindow)).toEqual([6, 7, 8])
    expect(pageSeqs(fromWindow)).toEqual(pageSeqs(fromComplete))
    expect(fromWindow.hasMore).toBe(fromComplete.hasMore)
    expect(windowed.observeSession).not.toHaveBeenCalled()
    expect(complete.observeSession).toHaveBeenCalledOnce()
  })
})

describe('Session history window projection checkpoint completeness', () => {
  it('opens from the window when the checkpoint omits a registered client-visible key and omits the block', async () => {
    const events = interruptedTurn()
    const balancedEvents = balanced(events)
    const readWindow = vi.fn(windowBackend(events))
    const exact: ProjectionSnapshot = { asOfSeq: SessionSeq(lastSeq(balancedEvents)), values: { title: 'exact' } }
    const windowed = await fixture({
      readWindow,
      wireTitle: true,
      checkpoint: { asOfSeq: SessionSeq(6), values: {} },
      observation: observationOf(balancedEvents, exact),
    })

    const frame = await openSnapshot(windowed.history)

    // readWindow returns the window without a complete baseline; the opening
    // keeps the window and omits the block instead of seeding partial values.
    expect(readWindow).toHaveBeenCalledOnce()
    expect(windowed.observeSession).not.toHaveBeenCalled()
    expect(frameSeqs(frame)).toEqual(balancedEvents.map(event => event.seq))
    expect(frame.cursor).toBe(lastSeq(balancedEvents))
    expect(frame.projections).toBeUndefined()
  })

  it('opens from the window when the checkpoint watermark leads the window cursor and omits the block', async () => {
    const events = interruptedTurn()
    const balancedEvents = balanced(events)
    const readWindow = vi.fn(windowBackend(events))
    const exact: ProjectionSnapshot = { asOfSeq: SessionSeq(lastSeq(balancedEvents)), values: { title: 'exact' } }
    const windowed = await fixture({
      readWindow,
      checkpoint: { asOfSeq: SessionSeq(lastSeq(events) + 1), values: { title: 'ahead' } },
      observation: observationOf(balancedEvents, exact),
    })

    const frame = await openSnapshot(windowed.history)

    // A checkpoint ahead of the window cannot describe it; the window still
    // opens and the frame carries no projection block.
    expect(readWindow).toHaveBeenCalledOnce()
    expect(windowed.observeSession).not.toHaveBeenCalled()
    expect(frame.projections).toBeUndefined()
    expect(frameSeqs(frame)).toEqual(balancedEvents.map(event => event.seq))
    expect(frame.cursor).toBe(lastSeq(balancedEvents))
  })

  it('keeps serving pages from a window whose checkpoint is incomplete', async () => {
    const events = interruptedTurn()
    const readWindow = vi.fn(windowBackend(events, { beforeSeq: true }))
    const windowed = await fixture({
      readWindow,
      wireTitle: true,
      checkpoint: { asOfSeq: SessionSeq(6), values: {} },
      observation: observationOf(balanced(events), { asOfSeq: SessionSeq(lastSeq(events)), values: {} }),
    })

    // Pages carry no projection block, so checkpoint completeness never
    // forces the complete source for them.
    const page = await loadPage(windowed.history, { throughSeq: 5, beforeSeq: 6, maxMessages: 10 })

    expect(pageSeqs(page)).toEqual([0, 1, 2, 3, 4, 5])
    expect(page.hasMore).toBe(false)
    expect(readWindow).toHaveBeenCalledOnce()
    expect(windowed.observeSession).not.toHaveBeenCalled()
  })
})

describe('Session history seeded and historical fallbacks', () => {
  it('uses the complete source for a seeded generation and never windows an anchored page', async () => {
    const seeded = header({ isSeeded: true, parentSession: SessionId('ancestor') })
    const balancedEvents = balanced(interruptedTurn())
    const exact: ProjectionSnapshot = { asOfSeq: SessionSeq(lastSeq(balancedEvents)), values: { title: 'seeded' } }
    // The production backend declines a window whose inherited cut lives in the
    // omitted prefix; this double reports that same decision.
    const readWindow = vi.fn(windowBackend(interruptedTurn(), { decline: true }))
    const windowed = await fixture({
      meta: seeded,
      readWindow,
      checkpoint: { asOfSeq: SessionSeq(6), values: { title: 'checkpointed' } },
      observation: observationOf(balancedEvents, exact, seeded, SessionLogOffset(3)),
    })

    const frame = await openSnapshot(windowed.history)
    expect(readWindow).toHaveBeenCalledOnce()
    expect(windowed.observeSession).toHaveBeenCalledOnce()
    expect(frame.header).toMatchObject({ id: SESSION, isSeeded: true, parentSession: 'ancestor' })
    expect(frame.cursor).toBe(lastSeq(balancedEvents))
    expect(frameSeqs(frame)).toEqual(balancedEvents.map(event => event.seq))
    expect(frame.projections).toEqual(exact)

    // A historical anchored page without a `beforeSeq` cut keeps the exact
    // source path, so the seeded fallback costs exactly one window attempt.
    const page = await loadPage(windowed.history, { throughSeq: frame.cursor, maxMessages: 2 })
    expect(pageSeqs(page)).not.toHaveLength(0)
    expect(readWindow).toHaveBeenCalledOnce()
    expect(windowed.observeSession).toHaveBeenCalledTimes(2)
  })
})
