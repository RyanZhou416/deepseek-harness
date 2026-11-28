/**
 * Event detail fields on the Client: elided openings and pages until a consumer holds the details, re-reads of
 * elided window entries while one does, and the event source replacement those re-reads publish.
 */

import { describe, expect, vi } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { it as plainIt } from 'vitest'
import { MutableSessionEventSource, type SessionEventLikeEntry } from '../src/client/contract/events.ts'
import type { Session } from '../src/client/sessions/session.ts'
import type { SessionEventsPage, SessionFollowRequest, SessionPageRequest } from '../src/types.ts'
import { ev, historyValue, plainTurn } from './event-script.client.ts'
import { sessionBench } from './remote/bench.client.ts'
import { FOLLOW, PAGE, err, followScript, pageRule } from './remote/session.client.ts'

const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })
const SID = 'details-s1' as SessionId
const EVENTS = plainTurn(SessionSeq(10), 3, 'question', 'answer')

/** A Host page of `events` whose records at `elided` seqs carry the elision mark. */
function elidedPage(events: readonly SessionEvent[], elided: readonly number[], hasMore = false): SessionEventsPage {
  const page = historyValue(events, hasMore)
  return { ...page, records: page.records.map(entry => elided.includes(entry.event.seq) ? { ...entry, elided: true } : entry) }
}

function elidedSeqs(session: Session): number[] {
  return session.eventSource.getSnapshot().entries
    .filter(entry => entry.type === 'event' && entry.elided === true)
    .map(entry => entry.event.seq)
}

async function opened(
  mock: RemoteMock, start: () => Promise<TestClient>, elided: readonly number[], page: Parameters<typeof pageRule>[0],
): Promise<Session> {
  const session = await sessionBench(mock, start, SID)
  mock.unary(PAGE, pageRule(page))
  mock.stream(FOLLOW, followScript((request: SessionFollowRequest) =>
    ok(request.elideDetails === true ? elidedPage(EVENTS, elided, true) : historyValue(EVENTS, true))))
  await session.open()
  return session
}

describe('Session event details', () => {
  it('opens elided and re-reads the elided entries completely while a consumer holds the details', async ({ mock, start }) => {
    // A re-read pins its cut to the page end; an older page returns the single event before the window.
    const session = await opened(mock, start, [12], (request: SessionPageRequest) =>
      request.beforeSeq === (request.throughSeq ?? 0) + 1
        ? ok(historyValue(EVENTS))
        : ok(historyValue([ev.user(SessionSeq((request.beforeSeq ?? 1) - 1), 'older')], true)))
    expect(mock.log.requests(FOLLOW)[0]).toMatchObject({ elideDetails: true })
    expect(elidedSeqs(session)).toEqual([12])

    const release = session.requireEventDetails()
    const second = session.requireEventDetails()
    await vi.waitFor(() => { expect(elidedSeqs(session)).toEqual([]) })
    const read = mock.log.requests(PAGE).at(-1) as SessionPageRequest
    expect(read).toMatchObject({ throughSeq: 12, beforeSeq: 13 })
    expect(read).not.toHaveProperty('elideDetails')
    expect(session.eventSource.getSnapshot().change.kind).toBe('replace')
    expect(session.eventSource.getSnapshot().entries.map(entry => entry.event.seq)).toEqual([10, 11, 12, 13, 14, 15])

    await session.loadOlder()
    expect((mock.log.requests(PAGE).at(-1) as SessionPageRequest)).not.toHaveProperty('elideDetails')
    release()
    release()
    await session.loadOlder()
    expect((mock.log.requests(PAGE).at(-1) as SessionPageRequest)).not.toHaveProperty('elideDetails')
    second()
    await session.loadOlder()
    expect((mock.log.requests(PAGE).at(-1) as SessionPageRequest)).toMatchObject({ elideDetails: true })
  })

  it('opens complete when a consumer held the details before the opening', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript((request: SessionFollowRequest) =>
      ok(request.elideDetails === true ? elidedPage(EVENTS, [12], true) : historyValue(EVENTS, true))))
    session.requireEventDetails()
    await session.open()
    expect(mock.log.requests(FOLLOW)[0]).not.toHaveProperty('elideDetails')
    expect(elidedSeqs(session)).toEqual([])
    expect(mock.log.requests(PAGE)).toEqual([])
  })
  it('reads page by page down to the oldest elided entry, re-reading once for a request during a pass', async ({ mock, start }) => {
    const session = await opened(mock, start, [11, 14], (request: SessionPageRequest) =>
      ok(historyValue(EVENTS.filter(event => event.seq <= (request.throughSeq ?? 0) && event.seq >= (request.throughSeq ?? 0) - 1))))
    session.requireEventDetails()
    await vi.waitFor(() => { expect(elidedSeqs(session)).toEqual([]) })
    expect(mock.log.requests(PAGE).map(request => (request as SessionPageRequest).throughSeq)).toEqual([14, 11])
  })

  it('stops when the Host no longer serves the elided entry and logs only unexpected read failures', async ({ mock, start }) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const answers: RemoteResult<SessionEventsPage>[] = [
      ok(historyValue([])),
      err(new RemoteError('gateway/internal', 'down', {})),
      ok({ ...historyValue(EVENTS), records: [{ type: 'event', event: { type: 'user/message', seq: 12, time: 1, data: null, surfaceOp: 'bogus' } }] }),
    ]
    const session = await opened(mock, start, [12], () => answers.shift() ?? ok(historyValue([])))
    for (let read = 1; read <= 3; read++) {
      const release = session.requireEventDetails()
      await vi.waitFor(() => { expect(mock.log.requests(PAGE)).toHaveLength(read) })
      await vi.waitFor(() => { expect(errors).toHaveBeenCalledTimes(read === 3 ? 1 : 0) })
      release()
    }
    expect(errors.mock.calls[0]?.[0]).toBe('[session-controller] event detail read failed:')
    expect(elidedSeqs(session)).toEqual([12])
    errors.mockRestore()
  })

  it('stops a read whose last holder released before the page arrived', async ({ mock, start }) => {
    const gate = Promise.withResolvers<undefined>()
    const session = await opened(mock, start, [12], async () => {
      await gate.promise
      return ok(historyValue(EVENTS))
    })
    const release = session.requireEventDetails()
    await vi.waitFor(() => { expect(mock.log.requests(PAGE)).toHaveLength(1) })
    release()
    gate.resolve(undefined)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(elidedSeqs(session)).toEqual([12])
  })
})

describe('MutableSessionEventSource.restoreDetails', () => {
  const entry = (event: SessionEvent, elided?: true): SessionEventLikeEntry =>
    ({ type: 'event', event, ...elided === undefined ? {} : { elided } })

  plainIt('replaces elided entries by seq and event type and publishes nothing when none matched', () => {
    const source = new MutableSessionEventSource()
    const user = ev.user(SessionSeq(1), 'hi')
    const turn = ev.turnStart(SessionSeq(2), 1)
    source.replace([entry(ev.turnStart(SessionSeq(0), 1)), entry(user, true), entry(turn, true)], true)
    const revision = source.getSnapshot().revision
    source.restoreDetails([entry(ev.user(SessionSeq(2), 'other type')), entry(ev.user(SessionSeq(1), 'still elided'), true)])
    expect(source.getSnapshot().revision).toBe(revision)
    const complete = entry(ev.user(SessionSeq(1), 'hi'))
    source.restoreDetails([complete])
    expect(source.getSnapshot()).toMatchObject({ hasMore: true, change: { kind: 'replace' } })
    expect(source.getSnapshot().entries[1]).toBe(complete)
    expect(source.getSnapshot().entries[2]).toMatchObject({ elided: true })
  })
})
