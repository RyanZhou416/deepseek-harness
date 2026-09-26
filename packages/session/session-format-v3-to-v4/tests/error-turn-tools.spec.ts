import { describe, expect, it } from 'vitest'
import {
  isSessionFormatJsonObject, SessionFormatEventCollector,
  type SessionFormatEvent, type SessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import { createSessionFormatCatalogWithChildren } from '@deepseek-ai/dsh-session-format-catalog'
import { TOOL_OUTCOME_UNKNOWN_TEXT } from '@deepseek-ai/dsh-session'
import { createSessionFormatV3ToV4, sessionFormatV3ToV4 } from '../src/index.ts'

const header: SessionFormatHeader = {
  version: 3, id: 'failed-v3-tool-session', createdAt: 1, isSeeded: false, delegationDepth: 0,
}

function source(reason: 'error' | 'completed'): SessionFormatEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message', seq: 2, time: 3, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: {
          id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
          content: [{ type: 'tool-call', id: 'call-1', name: 'pwsh', arguments: '{}' }],
        },
        stream: [],
      },
    },
    { type: 'tool/call', seq: 3, time: 4, data: { turn: 1, step: 1, callId: 'call-1', name: 'pwsh', arguments: '{}' } },
    { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
    {
      type: 'turn/end', seq: 5, time: 6,
      data: { turn: 1, reason: reason === 'error'
        ? { kind: 'error', error: { message: 'tool failed before result', code: 'UNKNOWN' } }
        : { kind: 'completed' } },
    },
  ]
}

function restore(rows: readonly SessionFormatEvent[]) {
  const reader = createSessionFormatCatalogWithChildren([]).createRestore(
    { type: 'session', ...header }, { recovery: 'strict', validation: 'current' },
  )
  for (const row of rows) reader.decodeRow(row)
  return reader.finish()
}

function resequence(rows: readonly SessionFormatEvent[]): SessionFormatEvent[] {
  return rows.map((row, seq) => ({ ...row, seq, time: seq + 1 }))
}

function migrateStage(rows: readonly SessionFormatEvent[]): SessionFormatEvent[] {
  const stage = createSessionFormatV3ToV4([]).createStage({
    sourceHeader: header, targetHeader: sessionFormatV3ToV4.migrateHeader(header),
    sourceInheritedEventCount: 0, sourceKind: 'decoded',
  })
  const collector = new SessionFormatEventCollector()
  for (const row of rows) stage.transformEvent(row, collector)
  stage.finish(collector)
  return collector.values
}

describe('released V3 failed tool steps', () => {
  it('records an unknown outcome before closing an error step without changing V3 input', () => {
    const rows = source('error')
    const original = structuredClone(rows)

    const migrated = restore(rows)

    expect(rows).toEqual(original)
    expect(migrated.events.map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'turn/end',
    ])
    expect(migrated.events[4]).toMatchObject({
      seq: 4, time: 5, surfaceOp: 'append', sourceEventSeqs: [3],
      data: {
        turn: 1, step: 1,
        error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
        message: {
          role: 'tool', toolCallId: 'call-1', isError: true,
          source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'text', text: TOOL_OUTCOME_UNKNOWN_TEXT }],
        },
      },
    })
    expect(migrated.events[5]?.seq).toBe(5)
    expect(migrated.events[6]?.seq).toBe(6)
  })

  it('refuses a completed V3 turn instead of publishing a repair', () => {
    expect(() => restore(source('completed'))).toThrow(/requires an error turn\/end/)
  })

  it('keeps a recorded V3 tool result without adding another one', () => {
    const rows = source('error')
    rows.splice(4, 0, {
      type: 'tool/result', seq: 4, time: 5, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: {
          id: 'result-1', role: 'user', source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'done' }] }],
        },
      },
    })

    const migrated = restore(resequence(rows))

    expect(migrated.events).toHaveLength(rows.length)
    expect(migrated.events[4]).toMatchObject({ data: { message: { role: 'tool', content: [{ type: 'text', text: 'done' }] } } })
  })

  it('records multiple missing started results in advertised order', () => {
    const rows = source('error')
    rows[2] = {
      type: 'assistant/message', seq: 2, time: 3, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: {
          id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
          content: [
            { type: 'tool-call', id: 'call-1', name: 'pwsh', arguments: '{}' },
            { type: 'tool-call', id: 'call-2', name: 'pwsh', arguments: '{}' },
          ],
        },
        stream: [],
      },
    }
    rows.splice(4, 0, {
      type: 'tool/call', seq: 4, time: 5,
      data: { turn: 1, step: 1, callId: 'call-2', name: 'pwsh', arguments: '{}' },
    })

    const migrated = restore(resequence(rows))
    const results = migrated.events.filter(event => event.type === 'tool/result')
    const callIds = results.map((event) => {
      if (!isSessionFormatJsonObject(event.data) || !isSessionFormatJsonObject(event.data['message'])) {
        throw new Error('repaired tool result is not a message')
      }
      return event.data['message']['toolCallId']
    })

    expect(callIds).toEqual(['call-1', 'call-2'])
    expect(results.map(event => event.sourceEventSeqs)).toEqual([[3], [4]])
    expect(results.map(event => event.seq)).toEqual([5, 6])
  })

  it('refuses a missing call start, a later step, and a tail without the error ending', () => {
    expect(() => restore(resequence(source('error').filter(row => row.type !== 'tool/call'))))
      .toThrow(/unresolved tool call/)
    expect(() => restore(source('error').slice(0, -1))).toThrow(/requires a recorded error turn\/end/)
    const rows = source('error')
    rows.splice(5, 0, { type: 'step/start', seq: 5, time: 6, data: { turn: 1, step: 2 } })
    expect(() => restore(resequence(rows))).toThrow(/before another step or turn/)
    rows[5] = { type: 'turn/start', seq: 5, time: 6, data: { turn: 2 } }
    expect(() => migrateStage(resequence(rows))).toThrow(/before another step or turn/)
  })

  it('refuses malformed direct-stage boundaries and leaves invalid tool sources for target rejection', () => {
    const badStep = source('error')
    badStep[4] = { ...badStep[4]!, data: null }
    expect(() => migrateStage(badStep)).toThrow(/step\/end data must be an object/)

    const badEnd = source('error')
    badEnd[5] = { ...badEnd[5]!, data: null }
    expect(() => migrateStage(badEnd)).toThrow(/requires an error turn\/end/)

    for (const invalidSource of [null, { kind: 'tool', callId: 5 }]) {
      const rows = source('error')
      rows.splice(4, 0, {
        type: 'tool/result', seq: 4, time: 5, surfaceOp: 'append',
        data: {
          turn: 1, step: 1,
          message: { id: 'invalid-result', role: 'tool', toolCallId: 'call-1', source: invalidSource, content: [] },
        },
      })
      expect(migrateStage(resequence(rows)).filter(row => row.type === 'tool/result')).toHaveLength(2)
    }
  })

  it('allows an unrelated recorded event between the repaired step and its error ending', () => {
    const rows = source('error')
    rows.splice(5, 0, { type: 'feedback/record', seq: 5, time: 6, data: { text: 'retained' } })

    const migrated = restore(resequence(rows))

    expect(migrated.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(migrated.events[6]).toMatchObject({ type: 'feedback/record', seq: 6 })
  })
})
