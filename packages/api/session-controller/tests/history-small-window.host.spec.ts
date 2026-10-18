/** Coverage of the small stored-Session bypass on the stored-history window path. */

import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  interruptedTurnClosers,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceRevision,
  type SessionPersistenceSnapshot,
  type SessionWindow,
  type SessionWindowRequest,
} from '@deepseek-ai/dsh-session-persistence'
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

const SESSION = SessionId('history-small-window')
/** Documented small-artifact threshold: strictly below it a window is skipped. */
const SMALL_THRESHOLD_BYTES = 2 * 1024 * 1024

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

/** A stored log whose final Turn only started, balanced by the recovery closers a complete read adds. */
function interruptedConversation(): SessionEvent[] {
  const events = conversation().slice(0, 8)
  events.push({
    type: 'turn/start',
    seq: SessionSeq(events.length),
    time: events.length + 1,
    data: { turn: 3 },
  })
  events.push({
    type: 'user/message',
    seq: SessionSeq(events.length),
    time: events.length + 1,
    data: createUserMessage({
      content: [{ type: 'text', text: 'question 3' }],
      source: { kind: 'user' },
    }),
    surfaceOp: 'append',
  })
  return [...events, ...interruptedTurnClosers(events)]
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

/** One stored-generation double: tail windows, plus backwards windows when enabled. */
function windowBackend(
  meta: SessionHeader,
  events: readonly SessionEvent[],
  options: { readonly beforeSeq?: boolean } = {},
): WindowRead {
  return async (id, request) => {
    if (id !== meta.id) return undefined
    const before = request?.beforeSeq
    if (before !== undefined && options.beforeSeq !== true) return undefined
    const below = before === undefined ? events : events.filter(event => event.seq < before)
    const limit = request?.maxEvents ?? 2_000
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
  /** Size metadata the backend reports; undefined models a backend that cannot size the artifact. */
  readonly sizeBytes?: number
  /** Probe failure modes: a rejecting `stat`, or a backend that declares no `stat` at all. */
  readonly probe?: 'reject' | 'absent'
  /** Stored window capability; defaults to a backend that serves no window. */
  readonly readWindow?: WindowRead
  /** Checkpoint the projection cache reports for the stored header. */
  readonly checkpoint?: ProjectionSnapshot
  /** Exact observation the complete source path serves. */
  readonly observation?: SessionObservation
}

/** One cold Session address whose stored source reports {@link FixtureOptions}. */
async function fixture(options: FixtureOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  const readWindow = vi.fn(options.readWindow ?? (async () => undefined))
  const stat = vi.fn(async (id: SessionId): Promise<SessionPersistenceSnapshot | undefined> => {
    const meta = header(id)
    return {
      header: meta,
      revision: SessionPersistenceRevision(`test:${id}`),
      ...options.sizeBytes === undefined ? {} : { sizeBytes: options.sizeBytes },
    }
  })
  const persistence: Record<string, unknown> = { readWindow }
  if (options.probe === 'reject') {
    persistence.stat = async (): Promise<never> => { throw new Error('stored size is unavailable') }
  } else if (options.probe !== 'absent') {
    persistence.stat = stat
  }
  ctx.provide('sessionPersistence', persistence as never)
  if (options.checkpoint !== undefined) {
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => options.checkpoint } as never)
  }
  const observeSession = vi.spyOn(ctx.sessionQuery, 'observeSession')
  if (options.observation !== undefined) observeSession.mockResolvedValue(options.observation)
  const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
  onTestFinished(() => ctx.fiber.dispose())
  return { ctx, history, readWindow, stat, observeSession }
}

/** Read exactly one opening frame and release its follower. */
async function openSnapshot(
  history: SessionHistoryController,
  request: Omit<SessionFollowRequest, 'address'> = {},
): Promise<Extract<SessionFollowFrame, { readonly type: 'snapshot' }>> {
  const abort = new AbortController()
  const iterator = history.follow(
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

async function loadPage(
  history: SessionHistoryController,
  request: Omit<SessionPageRequest, 'address'>,
): Promise<SessionPage> {
  return history.page(
    { address: { kind: 'session', sessionId: SESSION }, ...request },
    new AbortController().signal,
  )
}

function pageSeqs(page: SessionPage): number[] {
  return page.records.map(record => record.event.seq)
}

function frameSeqs(frame: Extract<SessionFollowFrame, { readonly type: 'snapshot' }>): number[] {
  return frame.records.map(record => record.event.seq)
}

describe('Session history for a small stored source', () => {
  it('opens the complete observation without reading a window', async () => {
    const events = conversation()
    const exact: ProjectionSnapshot = { asOfSeq: SessionSeq(events.length - 1), values: { title: 'exact' } }
    const small = await fixture({ sizeBytes: 4_096, observation: observationOf(events, exact) })
    const complete = await fixture({ probe: 'absent', observation: observationOf(events, exact) })

    const frame = await openSnapshot(small.history)
    const reference = await openSnapshot(complete.history)

    expect(frameSeqs(frame)).toEqual(frameSeqs(reference))
    expect(frameSeqs(frame)).toEqual(events.map(event => event.seq))
    expect(frame.cursor).toBe(reference.cursor)
    expect(frame.cursor).toBe(events.length - 1)
    expect(frame.hasMore).toBe(reference.hasMore)
    expect(frame.hasMore).toBe(false)
    expect(frame.projections).toEqual(exact)
    expect(frame.projections?.asOfSeq).toBe(frame.cursor)
    expect(small.readWindow).not.toHaveBeenCalled()
    expect(small.observeSession).toHaveBeenCalledOnce()
    // The reference path is the same one every backend without a window serves.
    expect(complete.readWindow).toHaveBeenCalledOnce()
  })

  it('pages exactly like the complete source without reading a window', async () => {
    const events = conversation()
    const small = await fixture({ sizeBytes: 900_000, observation: observationOf(events) })
    const complete = await fixture({ probe: 'absent', observation: observationOf(events) })
    const requests = [
      { throughSeq: events.length - 1, beforeSeq: events.length, maxMessages: 3 },
      { throughSeq: 5, beforeSeq: 6, maxMessages: 3 },
      { throughSeq: 2, beforeSeq: 3 },
      { throughSeq: -1 },
      { throughSeq: 11, beforeSeq: 12, maxMessages: 50, turnWindow: { minMessages: 2, minTurns: 2 } },
    ]

    for (const request of requests) {
      const fromSmall = await loadPage(small.history, request)
      const fromComplete = await loadPage(complete.history, request)
      expect(pageSeqs(fromSmall)).toEqual(pageSeqs(fromComplete))
      expect(fromSmall.hasMore).toBe(fromComplete.hasMore)
    }

    expect(small.readWindow).not.toHaveBeenCalled()
    expect(small.observeSession).toHaveBeenCalledTimes(requests.length)
    expect(complete.readWindow).toHaveBeenCalledTimes(requests.length)
  })

  it('reports an interrupted tail turn exactly like the complete source', async () => {
    const events = interruptedConversation()
    const cursor = events.at(-1)?.seq ?? -1
    const exact: ProjectionSnapshot = { asOfSeq: SessionSeq(cursor), values: {} }
    const small = await fixture({ sizeBytes: 8_192, observation: observationOf(events, exact) })
    const complete = await fixture({ probe: 'absent', observation: observationOf(events, exact) })

    const frame = await openSnapshot(small.history)
    const reference = await openSnapshot(complete.history)

    expect(frameSeqs(frame)).toEqual(frameSeqs(reference))
    expect(frameSeqs(frame)).toEqual(events.map(event => event.seq))
    expect(frame.cursor).toBe(cursor)
    // The complete read, not the page cutter, balances the open Turn.
    expect(events.at(-1)?.type).toBe('turn/end')
    expect(events.at(-1)?.data).toEqual({ turn: 3, reason: { kind: 'interrupted' } })
    expect(frame.records.at(-1)?.event.type).toBe('turn/end')
    expect(frame.hasMore).toBe(false)
    expect(frame.projections).toEqual(exact)
    expect(small.readWindow).not.toHaveBeenCalled()
  })
})

describe('Session history for a large stored source', () => {
  it('keeps serving pages and openings from the stored window', async () => {
    const events = conversation()
    const checkpoint: ProjectionSnapshot = { asOfSeq: SessionSeq(1), values: { title: 'checkpointed' } }
    const readWindow = vi.fn(windowBackend(header(), events, { beforeSeq: true }))
    const large = await fixture({ sizeBytes: 8 * 1024 * 1024, readWindow, checkpoint })

    const frame = await openSnapshot(large.history)
    expect(readWindow).toHaveBeenCalledOnce()
    expect(large.stat).toHaveBeenCalledOnce()
    expect(large.observeSession).not.toHaveBeenCalled()
    expect(frame.projections).toEqual(checkpoint)
    expect(frameSeqs(frame)).toEqual(events.map(event => event.seq))

    const page = await loadPage(large.history, { throughSeq: 5, beforeSeq: 6 })
    expect(pageSeqs(page)).toEqual([0, 1, 2, 3, 4, 5])
    expect(page.hasMore).toBe(false)
    expect(readWindow).toHaveBeenCalledTimes(2)
    expect(readWindow.mock.calls[1]?.[1]).toMatchObject({ beforeSeq: 6 })
    expect(large.observeSession).not.toHaveBeenCalled()
  })

  it('pages a cut above the stored window cursor from the complete source', async () => {
    // The stored generation ends inside a Turn; the opening balances it with a
    // synthetic closer, so the reported cursor sits above the stored window.
    const balanced = interruptedConversation()
    const stored = balanced.slice(0, -1)
    expect(balanced.at(-1)?.seq).toBe(stored.length)
    const readWindow = vi.fn(windowBackend(header(), stored, { beforeSeq: true }))
    const checkpoint: ProjectionSnapshot = { asOfSeq: SessionSeq(6), values: {} }
    const windowed = await fixture({
      sizeBytes: 8 * 1024 * 1024,
      readWindow,
      checkpoint,
      observation: observationOf(balanced, { asOfSeq: SessionSeq(balanced.length - 1), values: {} }),
    })
    const complete = await fixture({
      probe: 'absent',
      observation: observationOf(balanced, { asOfSeq: SessionSeq(balanced.length - 1), values: {} }),
    })

    const frame = await openSnapshot(windowed.history)
    expect(frame.cursor).toBe(balanced.length - 1)
    expect(frame.cursor).toBeGreaterThan(stored.length - 1)
    const request = { throughSeq: frame.cursor, beforeSeq: frame.cursor + 1, maxMessages: 2 }

    const page = await loadPage(windowed.history, request)
    const reference = await loadPage(complete.history, request)

    expect(pageSeqs(page)).toEqual(pageSeqs(reference))
    expect(page.hasMore).toBe(reference.hasMore)
    // The window cannot prove the balanced cut, so the complete log answers it.
    expect(readWindow).toHaveBeenCalledTimes(2)
    expect(windowed.observeSession).toHaveBeenCalledOnce()
  })

  it.each([
    { name: 'without size metadata', options: {} },
    { name: 'when the size probe rejects', options: { probe: 'reject' as const } },
    { name: 'when the backend declares no stat', options: { probe: 'absent' as const } },
  ] satisfies readonly { readonly name: string; readonly options: FixtureOptions }[])('keeps the window $name', async ({ options }) => {
    const events = conversation()
    const readWindow = vi.fn(windowBackend(header(), events, { beforeSeq: true }))
    const unknown = await fixture({ ...options, readWindow })

    const page = await loadPage(unknown.history, { throughSeq: 5, beforeSeq: 6 })
    expect(pageSeqs(page)).toEqual([0, 1, 2, 3, 4, 5])
    expect(page.hasMore).toBe(false)
    expect(readWindow).toHaveBeenCalledOnce()
    expect(readWindow.mock.calls[0]?.[1]).toMatchObject({ beforeSeq: 6 })
    expect(unknown.observeSession).not.toHaveBeenCalled()
  })

  it('bypasses the window only strictly below the documented threshold', async () => {
    const events = conversation()
    const below = await fixture({
      sizeBytes: SMALL_THRESHOLD_BYTES - 1,
      readWindow: vi.fn(windowBackend(header(), events)),
      observation: observationOf(events),
    })
    const at = await fixture({ sizeBytes: SMALL_THRESHOLD_BYTES, readWindow: vi.fn(windowBackend(header(), events)) })

    await loadPage(below.history, { throughSeq: -1 })
    await loadPage(at.history, { throughSeq: -1 })

    expect(below.readWindow).not.toHaveBeenCalled()
    expect(below.observeSession).toHaveBeenCalledOnce()
    expect(at.readWindow).toHaveBeenCalledOnce()
    expect(at.observeSession).not.toHaveBeenCalled()
  })
})

describe('Session history size probe scope', () => {
  it('never probes a live Session', async () => {
    const live = await fixture({ sizeBytes: 4_096 })
    const session = live.ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })

    const page = await live.history.page(
      { address: { kind: 'session', sessionId: session.id }, throughSeq: -1 },
      new AbortController().signal,
    )

    expect(page).toEqual({ records: [], hasMore: false })
    expect(live.stat).not.toHaveBeenCalled()
    expect(live.readWindow).not.toHaveBeenCalled()
  })
})
