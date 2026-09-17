import { describe, expect, it } from 'vitest'
import { createToolResultMessage, createUserMessage, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveSessionMessageStatus } from '../src/status.ts'

let nextSeq = 0

function sessionEvent(type: SessionEvent['type'], data: unknown): SessionEvent {
  const seq = SessionSeq(nextSeq++)
  return { type, seq, time: seq, data } as SessionEvent
}

function fixture() {
  nextSeq = 0
  const message = {
    ...createUserMessage({
      content: [{ type: 'text', text: 'tracked' }],
      source: { kind: 'user' },
    }),
    id: MessageId('tracked-message'),
  }
  const insert = sessionEvent('agent/inbox/spliced', {
    target: 'next-turn', start: 0, inserted: [message],
  })
  const start = sessionEvent('turn/start', { turn: 1 })
  const claim = sessionEvent('agent/inbox/spliced', {
    target: 'next-turn', start: 0, removedCount: 1, inserted: [],
  })
  return { message, insert, start, claim }
}

describe('deriveSessionMessageStatus', () => {
  it('reports a queued message behind a foreground terminal call', () => {
    const { message, insert } = fixture()
    const events = [
      sessionEvent('turn/start', { turn: 8 }),
      sessionEvent('tool/call', {
        turn: 8, step: 1, callId: ToolCallId('root-code'), name: 'run_code', arguments: '{}',
      }),
      sessionEvent('tool/ptc-dispatch-start', {
        rootCallId: ToolCallId('root-code'),
        parentCallId: ToolCallId('root-code'),
        subCallId: ToolCallId('terminal-call'),
        name: 'terminal_send',
        arguments: { sessionId: 'terminal-1', text: 'run' },
      }),
      insert,
    ]

    expect(deriveSessionMessageStatus(events, message.id, true)).toEqual({
      state: 'queued',
      blocking: 'terminal',
      activeTools: ['run_code', 'terminal_send'],
    })
  })

  it('distinguishes claim, model context, and a non-terminal foreground tool', () => {
    const { message, insert, start, claim } = fixture()
    expect(deriveSessionMessageStatus([insert, start, claim], message.id, true)).toEqual({
      state: 'claimed', blocking: 'model', activeTools: [], turn: 1,
    })

    const admitted = sessionEvent('user/message', message)
    expect(deriveSessionMessageStatus([insert, start, claim, admitted], message.id, true)).toEqual({
      state: 'model-context', blocking: 'model', activeTools: [], turn: 1,
    })

    const toolCall = sessionEvent('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('bash-call'), name: 'bash', arguments: '{}',
    })
    expect(deriveSessionMessageStatus([insert, start, claim, admitted, toolCall], message.id, true)).toEqual({
      state: 'processing-tool', blocking: 'tool', activeTools: ['bash'], turn: 1,
    })
  })

  it('reports completed admission after its tool settles and turn closes', () => {
    const { message, insert, start, claim } = fixture()
    const callId = ToolCallId('completed-call')
    const events = [
      insert,
      start,
      claim,
      sessionEvent('user/message', message),
      sessionEvent('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' }),
      sessionEvent('tool/ptc-dispatch-start', {
        rootCallId: callId,
        parentCallId: callId,
        subCallId: ToolCallId('completed-subcall'),
        name: 'read',
        arguments: { path: 'README.md' },
      }),
      sessionEvent('tool/ptc-dispatch', {
        rootCallId: callId,
        parentCallId: callId,
        subCallId: ToolCallId('completed-subcall'),
        name: 'read',
        arguments: { path: 'README.md' },
        content: [{ type: 'text', text: 'read' }],
        isError: false,
      }),
      sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'done' }], isError: false }),
      }),
      sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]

    expect(deriveSessionMessageStatus(events, message.id, false)).toEqual({
      state: 'completed',
      blocking: 'none',
      activeTools: [],
      turn: 1,
      turnEndReason: 'completed',
    })
  })

  it('distinguishes rejected and durably discarded input', () => {
    const rejected = fixture()
    expect(deriveSessionMessageStatus([
      rejected.insert,
      rejected.start,
      rejected.claim,
      sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], rejected.message.id, false)).toEqual({
      state: 'rejected', blocking: 'none', activeTools: [], turn: 1, turnEndReason: 'completed',
    })

    const discarded = fixture()
    expect(deriveSessionMessageStatus([
      discarded.insert,
      discarded.start,
      sessionEvent('agent/inbox/spliced', {
        target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
      }),
      sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], discarded.message.id, false)).toEqual({
      state: 'discarded', blocking: 'none', activeTools: [], turn: 1, turnEndReason: 'completed',
    })
  })

  it('handles replacement, unrelated activity, and an unknown pair', () => {
    const { message, insert } = fixture()
    const replacement = { ...message, content: [{ type: 'text' as const, text: 'edited' }] }
    const unrelatedMessage = createUserMessage({
      content: [{ type: 'text', text: 'other' }],
      source: { kind: 'user' },
    })
    const events = [
      sessionEvent('request/context', { provider: 'p', model: 'm', contextWindow: 1 }),
      sessionEvent('user/message', unrelatedMessage),
      sessionEvent('tool/ptc-dispatch-start', {
        rootCallId: ToolCallId('orphan-root'),
        parentCallId: ToolCallId('orphan-root'),
        subCallId: ToolCallId('orphan-subcall'),
        name: 'terminal_send',
        arguments: {},
      }),
      insert,
      sessionEvent('agent/inbox/spliced', {
        target: 'next-turn', start: 0, removedCount: 1, inserted: [replacement], outcome: 'canceled',
      }),
      sessionEvent('tool/call', {
        turn: 99, step: 1, callId: ToolCallId('unrelated'), name: 'bash', arguments: '{}',
      }),
      sessionEvent('turn/end', { turn: 99, reason: { kind: 'completed' } }),
    ]
    expect(deriveSessionMessageStatus(events, message.id, false)).toEqual({
      state: 'queued', blocking: 'none', activeTools: [],
    })
    expect(deriveSessionMessageStatus(events, MessageId('unknown-message'), false)).toEqual({
      state: 'unknown', blocking: 'none', activeTools: [],
    })
  })
})
