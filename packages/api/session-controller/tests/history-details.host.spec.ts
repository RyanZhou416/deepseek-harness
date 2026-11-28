/** History reads with `elideDetails`: emptied detail fields, an unchanged page cut, and complete live events. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { assertSessionWireEvent } from '../src/client/session-wire-event.ts'
import { elideRecordDetails } from '../src/history/details.ts'
import { HistoryController } from '../src/history/controller.ts'
import { WebController } from '../src/web/controller.ts'
import type { SessionHistoryRecord, SessionWireEvent } from '../src/types.ts'
import { installSessionReadTestServices } from './test-remote.ts'

const roots: Context[] = []
const aborters: AbortController[] = []
afterEach(async () => {
  for (const abort of aborters.splice(0)) abort.abort()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

function record(type: string, data: SessionWireEvent['data'], seq = 0): SessionHistoryRecord {
  return { type: 'event', event: { type, seq, time: 1, data } }
}

describe('elideRecordDetails', () => {
  it('empties an Assistant stream and removes its replay state, keeping every other field', () => {
    const data = {
      turn: 1,
      stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [0], texts: ['hi'] }],
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', replayState: { blob: 'x' } } },
    }
    expect(elideRecordDetails([record('assistant/message', data)])).toEqual([{
      type: 'event',
      event: { type: 'assistant/message', seq: 0, time: 1, data: {
        turn: 1, stream: [], message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model' } },
      } },
      elided: true,
    }])
  })

  it('elides each Assistant detail field on its own and keeps an Assistant event without either', () => {
    const replayOnly = record('assistant/message', { stream: [], message: { source: { kind: 'model', replayState: 1 } } })
    const streamOnly = record('assistant/message', { stream: [1], message: { source: { kind: 'model' } } })
    const streamWithoutMessage = record('assistant/message', { stream: [1] })
    const neither = record('assistant/message', { stream: [], message: { source: { kind: 'model' } } })
    const [replay, stream, bare, kept] = elideRecordDetails([replayOnly, streamOnly, streamWithoutMessage, neither])
    expect(replay).toMatchObject({ elided: true, event: { data: { stream: [], message: { source: { kind: 'model' } } } } })
    expect(replay?.event.data).not.toHaveProperty('message.source.replayState')
    expect(stream).toMatchObject({ elided: true, event: { data: { stream: [] } } })
    expect(bare).toMatchObject({ elided: true, event: { data: { stream: [] } } })
    expect(kept).toBe(neither)
  })

  it('empties request tool catalogs and request-record system blocks only when present', () => {
    const header = record('request/header', { reason: 'initial', header: { config: { model: 'm' }, tools: [{ name: 'read' }] } })
    const emptyHeader = record('request/header', { header: { tools: [] } })
    const noHeader = record('request/header', { reason: 'initial' })
    const requestRecord = record('llm/request-record', { model: 'm', systemBlocks: ['system text'] })
    const emptyRecord = record('llm/request-record', { systemBlocks: [] })
    const other = record('tool/result', { content: 'kept' })
    const scalar = record('custom/scalar', 3)
    const result = elideRecordDetails([header, emptyHeader, noHeader, requestRecord, emptyRecord, other, scalar])
    expect(result[0]).toEqual({
      type: 'event', elided: true, event: { type: 'request/header', seq: 0, time: 1, data: { reason: 'initial', header: { config: { model: 'm' } } } },
    })
    expect(result[3]).toMatchObject({ elided: true, event: { data: { model: 'm', systemBlocks: [] } } })
    // The Client rejects a request header that carries an empty tool catalog.
    expect(() => { assertSessionWireEvent(result[0]?.event) }).not.toThrow()
    expect([result[1], result[2], result[4], result[5], result[6]]).toEqual([emptyHeader, noHeader, emptyRecord, other, scalar])
  })
})

async function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await installSessionReadTestServices(ctx)
  const history = new HistoryController(ctx)
  const web = new WebController(ctx, history, (observation) => { observation[Symbol.dispose]() })
  const session = ctx.sessions.create(brandString<SessionId>('details-target'), { meta: { cwd: '/details-test' } })
  const abort = new AbortController()
  aborters.push(abort)
  const address = { kind: 'session' as const, sessionId: session.id }
  session.append('turn/start', { turn: 1 })
  const assistant = (text: string) => session.append('assistant/message', {
    turn: 1, step: 1,
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } }),
    stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [0], texts: [text] }],
  }, { surfaceOp: 'append' })
  return { history, web, abort, address, assistant }
}

describe('history reads with elideDetails', () => {
  it('pages the same events as a complete read with their detail fields emptied', async () => {
    const f = await fixture()
    f.assistant('first')
    f.assistant('second')
    const complete = await f.history.events({ address: f.address, maxMessages: 1 }, f.abort.signal)
    const elided = await f.history.events({ address: f.address, maxMessages: 1, elideDetails: true }, f.abort.signal)
    expect(complete.records.some(entry => entry.elided === true)).toBe(false)
    expect(elided).toEqual({ ...complete, records: elideRecordDetails(complete.records) })
    expect(elided.records.filter(entry => entry.elided === true)).toHaveLength(1)
  })

  it('elides the follow opening and keeps later live events complete', async () => {
    const f = await fixture()
    f.assistant('opening')
    const frames = f.web.follow({ address: f.address, elideDetails: true }, f.abort.signal)[Symbol.asyncIterator]()
    const opening = await frames.next()
    expect(opening.value).toMatchObject({ type: 'snapshot' })
    const records: readonly SessionHistoryRecord[] = opening.value?.type === 'snapshot' ? opening.value.records : []
    expect(records.find(entry => entry.event.type === 'assistant/message')).toMatchObject({
      elided: true, event: { data: { stream: [] } },
    })
    f.assistant('live')
    const live = await frames.next()
    expect(live.value).toMatchObject({ type: 'event', event: { type: 'assistant/message', data: { stream: [{ texts: ['live'] }] } } })
    expect(live.value).not.toHaveProperty('elided')
  })
})
