import { describe, expect, it } from 'vitest'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { projectSettledHistoryPage } from '../src/settled-history.ts'

/** Build one finalized model stream through the real Session append path. */
function finalizedStream(): {
  events: readonly SessionEvent[]
  chunks: readonly SessionEvent[]
  message: SessionEvent
} {
  const session = Session.create(SessionId('settled-history'))
  const chunks = [
    session.append('assistant/chunk', {
      turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'hel' },
    }),
    session.append('assistant/chunk', {
      turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'lo' },
    }),
    session.append('assistant/chunk', {
      turn: 1, step: 2, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    }),
  ]
  const message = session.append('assistant/message', {
    turn: 1,
    step: 2,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: chunks.map(event => event.seq) })
  return { events: session.events, chunks, message }
}

describe('settled history projection', () => {
  it('retains the first token timing event and removes the remaining chunks and provenance', () => {
    const { events, chunks, message } = finalizedStream()

    const projected = projectSettledHistoryPage(events, events)

    expect(projected).toHaveLength(3)
    expect(projected[0]).toBe(chunks[0])
    expect(projected[0]).toMatchObject({
      type: 'assistant/chunk', seq: chunks[0]?.seq, time: chunks[0]?.time,
    })
    expect(projected[1]).toBe(chunks[2])
    expect(projected[1]).toMatchObject({ type: 'assistant/chunk', data: { chunk: { type: 'usage' } } })
    expect(projected[2]).toMatchObject({ type: 'assistant/message', seq: message.seq })
    expect(projected[2]).not.toHaveProperty('sourceEventSeqs')
    if (message.type !== 'assistant/message') throw new Error('expected finalized assistant message')
    expect(message.sourceEventSeqs).toEqual(chunks.map(event => event.seq))
    expect(projected[2]).not.toBe(message)
  })

  it('retains one timing event on an older page even when its final message is outside that page', () => {
    const { events, chunks } = finalizedStream()

    expect(projectSettledHistoryPage(events, chunks)).toEqual([chunks[0], chunks[2]])
  })

  it('removes all settled chunks when a page has no token delta', () => {
    const { events, message } = finalizedStream()
    const metadata = {
      type: 'assistant/chunk', seq: 0, time: 5, data: {
        turn: 1, step: 2, chunk: { type: 'block-start', index: 0, blockType: 'text' },
      },
    } as SessionEvent

    expect(projectSettledHistoryPage(events, [metadata, message])).toEqual([
      expect.objectContaining({ type: 'assistant/message', seq: message.seq }),
    ])
  })

  it('keeps in-flight chunks and messages without nonempty provenance by reference', () => {
    const session = Session.create(SessionId('in-flight-history'))
    const chunk = session.append('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'live' },
    })
    const noSources = session.append('assistant/message', {
      turn: 2,
      step: 1,
      message: createMessage({
        role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' })
    const emptySources = session.append('assistant/message', {
      turn: 3,
      step: 1,
      message: createMessage({
        role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [] })

    const projected = projectSettledHistoryPage(session.events, [chunk, noSources, emptySources])

    expect(projected).toEqual([chunk, noSources, emptySources])
    expect(projected[0]).toBe(chunk)
    expect(projected[1]).toBe(noSources)
    expect(projected[2]).toBe(emptySources)
    expect(projectSettledHistoryPage(session.events, [])).toEqual([])
  })

  it('preserves provenance unless every cited seq is a chunk from the same step', () => {
    const { events, message } = finalizedStream()
    const base = { ...message, sourceEventSeqs: [0] } as SessionEvent
    const missing = { ...message, sourceEventSeqs: [99] } as SessionEvent
    const wrongSeq = { ...message, sourceEventSeqs: [0] } as SessionEvent
    const wrongStep = { ...message, sourceEventSeqs: [1] } as SessionEvent
    const nonChunk = { ...message, seq: 0, sourceEventSeqs: [message.seq] } as SessionEvent
    const wrongSeqLog = [
      { ...events[0], seq: 7 },
      events[1],
      events[2],
    ] as SessionEvent[]
    const wrongStepLog = [
      events[0],
      { ...events[1], data: { ...events[1]?.data, step: 9 } },
      events[2],
    ] as SessionEvent[]

    expect(projectSettledHistoryPage(events, [missing])).toEqual([missing])
    expect(projectSettledHistoryPage(wrongSeqLog, [wrongSeq])).toEqual([wrongSeq])
    expect(projectSettledHistoryPage(wrongStepLog, [wrongStep])).toEqual([wrongStep])
    expect(projectSettledHistoryPage(events, [nonChunk])).toEqual([nonChunk])
    expect(projectSettledHistoryPage(events, [base])[0]).not.toHaveProperty('sourceEventSeqs')
  })
})
