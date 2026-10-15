import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AssistantBlock, ChatLocationNodeIndex, ChatNode, ChatNodeStore, ChatSnapshot,
  ChatTurnProcessPresentation,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  ConversationNodeAssembler, type ConversationLocationDataStore, type ConversationNodeDefinition,
  type ConversationTurnDataMap, type ConversationViewDefinition, type TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { EMPTY_CHAT_SNAPSHOT } from '../src/client/contract/snapshot.ts'
import {
  isTurnProcessAnswer, isTurnProcessMember, type TurnProcessSpec,
} from '../src/client/contract/turn-process.ts'
import { assistantDefinition } from '../src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { toolDefinition } from '../src/client/conversation-nodes/tool.ts'
import { turnProcessDefinition } from '../src/client/conversation-nodes/turn-process.ts'
import { ChatTurnProcessProjector } from '../src/client/conversation-nodes/turn-process-presentation.ts'

afterEach(() => { vi.restoreAllMocks() })

const FOLD_DEFINITIONS: readonly ConversationNodeDefinition[] = [
  assistantDefinition,
  turnProcessDefinition,
  toolDefinition,
]

class FoldEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return FOLD_DEFINITIONS
  }

  fallbackEntry(): undefined {
    return undefined
  }
}

class FoldViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [chatViewDefinition]
  }
}

function live(seq: number, type: string, data: unknown, surfaceOp?: 'append'): SessionLiveEventEntry {
  const payload = type === 'assistant/message' && typeof data === 'object' && data !== null
    ? { ...(data as Record<string, unknown>), stream: (data as { stream?: unknown }).stream ?? [] }
    : data
  const event = { seq, time: 1_700_000_000_000 + seq, type, data: payload,
    ...(surfaceOp === undefined ? {} : { surfaceOp }) }
  return { type: 'event', event: event as SessionEvent }
}

function fold(entries: readonly SessionLiveEventEntry[]): ConversationNodeAssembler {
  const assembler = new ConversationNodeAssembler(new FoldEventDefinitions(), new FoldViewDefinitions())
  assembler.replaceWindow(entries, false)
  assembler.activateTarget('chat')
  return assembler
}

function chatSnapshot(assembler: ConversationNodeAssembler): ChatSnapshot {
  const snapshot = assembler.snapshot('chat') as ChatSnapshot | undefined
  if (snapshot === undefined) throw new Error('chat view was not activated')
  return snapshot
}

function specOf(assembler: ConversationNodeAssembler, turn = 1): TurnProcessSpec {
  const spec = chatSnapshot(assembler).timeline.turns.get(turn)?.data.get('turn-process')
  if (spec === undefined) throw new Error(`Turn ${String(turn)} published no process spec`)
  return spec
}

function reply(id: string, content: readonly unknown[]) {
  return {
    id,
    role: 'assistant',
    content,
    source: { kind: 'model', provider: 'fake', model: 'fake' },
  }
}

const TEXT = (text: string) => ({ type: 'text', text })
const REASONING = (text: string) => ({ type: 'reasoning', text })
const TOOL_CALL = (id: string, name: string) => ({ type: 'tool-call', id, name, arguments: '{}' })

function assistantAt(seq: number, turn: number, step: number, content: readonly unknown[]): SessionLiveEventEntry {
  return live(seq, 'assistant/message', {
    turn, step, message: reply(`message-${String(seq)}`, content),
  }, 'append')
}

function chunkAt(
  seq: number,
  turn: number,
  step: number,
  chunk: Record<string, unknown>,
): SessionLiveEventEntry {
  return live(seq, 'assistant/live-chunk', { turn, step, chunk })
}

function retryAt(seq: number, turn: number, step: number): SessionLiveEventEntry {
  return live(seq, 'llm/retry', {
    retryId: 'retry-1', turn, step, provider: 'fake', mode: 'normal', policyKey: 'fake-normal',
    retry: 1, maxRetries: 2, delayMs: 10, failure: { code: 'TRANSPORT', message: 'temporary' },
  })
}

describe('closed-Turn reply protection', () => {
  it('protects a finalized reply that shares its message with a Tool call after a later Tool-only Step', () => {
    const assembler = fold([
      live(1, 'turn/start', { turn: 1 }),
      live(2, 'step/start', { turn: 1, step: 1 }),
      // A reply whose own message also carries a Tool call: the closed Turn
      // protects it instead of treating the whole message as process content.
      assistantAt(3, 1, 1, [TEXT('shared answer'), TOOL_CALL('call-1', 'read')]),
      live(4, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' }),
      live(5, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'result-1', role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' },
          content: [TEXT('done')],
        },
      }, 'append'),
      live(6, 'step/end', { turn: 1, step: 1 }),
      live(7, 'step/start', { turn: 1, step: 2 }),
      // A later Step with Tool protocol blocks and no reply content.
      assistantAt(8, 1, 2, [TOOL_CALL('call-2', 'bash')]),
      live(9, 'step/end', { turn: 1, step: 2 }),
      live(10, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])

    expect(specOf(assembler)).toMatchObject({
      answerStep: 1,
      answerAnchorSeq: 3,
      inlineReasoning: false,
      messageCount: 0,
      toolCallCount: 1,
      subagentCount: 0,
    })
    const control = chatSnapshot(assembler).nodes.values()
      .find((node): node is ChatNode<'turn-process'> => node.kind === 'turn-process')
    expect(control?.data).toMatchObject({ answerStep: 1, answerAnchorSeq: 3 })
  })

  it('protects an earlier reply when a later closed Step carries only reasoning', () => {
    const assembler = fold([
      live(1, 'turn/start', { turn: 1 }),
      live(2, 'step/start', { turn: 1, step: 1 }),
      assistantAt(3, 1, 1, [TEXT('early reply')]),
      live(4, 'step/end', { turn: 1, step: 1 }),
      live(5, 'step/start', { turn: 1, step: 2 }),
      assistantAt(6, 1, 2, [REASONING('thinking only')]),
      live(7, 'step/end', { turn: 1, step: 2 }),
      live(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])

    // The later Step finalized reasoning only, which is process content rather
    // than a reply candidate.
    expect(specOf(assembler)).toMatchObject({
      answerStep: 1,
      answerAnchorSeq: 3,
      inlineReasoning: false,
      messageCount: 0,
    })
  })

  it('keeps the open-Turn latest-Step rule and its Tool-call veto', () => {
    const shared = fold([
      live(1, 'turn/start', { turn: 1 }),
      live(2, 'step/start', { turn: 1, step: 1 }),
      assistantAt(3, 1, 1, [TEXT('streaming answer'), TOOL_CALL('call-1', 'read')]),
    ])
    expect(specOf(shared)).toMatchObject({ answerStep: null, answerAnchorSeq: null })

    const settled = fold([
      live(1, 'turn/start', { turn: 1 }),
      live(2, 'step/start', { turn: 1, step: 1 }),
      assistantAt(3, 1, 1, [TEXT('settled answer')]),
    ])
    expect(specOf(settled)).toMatchObject({ answerStep: 1, answerAnchorSeq: 3 })

    // An open Turn still requires the newest Step: an earlier reply and a
    // newer finalized one select the newer Step only.
    const multiStep = fold([
      live(1, 'turn/start', { turn: 1 }),
      live(2, 'step/start', { turn: 1, step: 1 }),
      assistantAt(3, 1, 1, [TEXT('first answer')]),
      live(4, 'step/end', { turn: 1, step: 1 }),
      live(5, 'step/start', { turn: 1, step: 2 }),
      assistantAt(6, 1, 2, [TEXT('second answer')]),
    ])
    expect(specOf(multiStep)).toMatchObject({ answerStep: 2, answerAnchorSeq: 6, messageCount: 1 })
  })

  it('protects the newest reply of a closed partial Turn whose start is unloaded', () => {
    // No `turn/start` in the window: the Definition folds its State from the
    // loaded Matches, and the widened search must still protect the reply.
    const assembler = fold([
      live(20, 'step/start', { turn: 3, step: 1 }),
      assistantAt(21, 3, 1, [TEXT('loaded reply')]),
      live(22, 'step/end', { turn: 3, step: 1 }),
      live(23, 'step/start', { turn: 3, step: 2 }),
      assistantAt(24, 3, 2, [TOOL_CALL('call-3', 'bash')]),
      live(25, 'step/end', { turn: 3, step: 2 }),
      live(26, 'turn/end', { turn: 3, reason: { kind: 'completed' } }),
    ])
    expect(chatSnapshot(assembler).timeline.turns.get(3)?.start).toBeUndefined()

    expect(specOf(assembler, 3)).toMatchObject({
      processStartSeq: 21,
      answerStep: 1,
      answerAnchorSeq: 21,
    })
  })

  it('keeps the interrupted prefix as the reply without promoting assistant/attempt', () => {
    const assembler = fold([
      live(1, 'turn/start', { turn: 1 }),
      live(2, 'step/start', { turn: 1, step: 1 }),
      chunkAt(3, 1, 1, { type: 'text-delta', index: 0, text: 'interrupted prefix' }),
      live(4, 'step/end', { turn: 1, step: 1 }),
      live(5, 'step/start', { turn: 1, step: 2 }),
      live(6, 'assistant/attempt', { turn: 1, step: 2, stream: [] }),
      live(7, 'step/end', { turn: 1, step: 2 }),
      live(8, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
    ])

    // The synthetic interruption anchors at its closing boundary minus the
    // Assistant offset; an attempt-only Step contributes no reply candidate.
    expect(specOf(assembler)).toMatchObject({ answerStep: 1, answerAnchorSeq: 3.1 })
  })

  it('reselects when a late frame first makes a closed interrupted Step a reply', () => {
    // Both closed Steps interrupt without a durable message: step 1 carries
    // reasoning only and step 2 Tool protocol only, so no reply candidate exists.
    const assembler = fold([
      live(1, 'turn/start', { turn: 1 }),
      live(2, 'step/start', { turn: 1, step: 1 }),
      chunkAt(3, 1, 1, { type: 'reasoning-delta', index: 0, text: 'thinking only' }),
      live(4, 'step/end', { turn: 1, step: 1 }),
      live(5, 'step/start', { turn: 1, step: 2 }),
      chunkAt(6, 1, 2, { type: 'tool-call-delta', index: 0, id: 'call-2', name: 'bash', argumentsDelta: '{}' }),
      live(7, 'step/end', { turn: 1, step: 2 }),
      live(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(specOf(assembler)).toMatchObject({ answerStep: null, answerAnchorSeq: null })

    const turn = chatSnapshot(assembler).timeline.turns.get(1)
    const newest = turn?.steps.at(-1)
    if (turn === undefined || newest === undefined) throw new Error('fixture lacks Turn 1 steps')
    // Only a Turn-wide search reaches step 1 after the first late frame, and
    // nothing else reads the newest Step while the Turn stays closed.
    const scanned = vi.spyOn(newest.data, 'get')

    assembler.append(chunkAt(9, 1, 1, { type: 'text-delta', index: 1, text: 'late reply' }))
    assembler.flush()
    expect(specOf(assembler)).toMatchObject({ answerStep: 1, answerAnchorSeq: 3.1 })

    // Later tokens of the same Step change its content, not its eligibility.
    for (let frame = 0; frame < 10; frame += 1) {
      assembler.append(chunkAt(10 + frame, 1, 1, { type: 'text-delta', index: 1, text: ` +${String(frame)}` }))
      assembler.flush()
    }
    expect(scanned.mock.calls.length).toBe(1)
    expect(specOf(assembler)).toMatchObject({ answerStep: 1, answerAnchorSeq: 3.1 })
  })

  it('keeps a closed interrupted Step eligible for its first reply frame after reasoning only', () => {
    // Reasoning evidence, including a finalized reasoning block, is process
    // content: it must not consume the Step's one eligibility transition.
    const assembler = fold([
      live(1, 'turn/start', { turn: 1 }),
      live(2, 'step/start', { turn: 1, step: 1 }),
      chunkAt(3, 1, 1, { type: 'reasoning-delta', index: 0, text: 'thinking only' }),
      chunkAt(4, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking only' } }),
      live(5, 'step/end', { turn: 1, step: 1 }),
      live(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(specOf(assembler)).toMatchObject({ answerStep: null, answerAnchorSeq: null })

    assembler.append(chunkAt(7, 1, 1, { type: 'text-delta', index: 1, text: 'late reply' }))
    assembler.flush()

    // The synthetic interruption anchors at its closing boundary minus the offset.
    expect(specOf(assembler)).toMatchObject({ answerStep: 1, answerAnchorSeq: 4.1 })
  })

  it('refreshes the selected reply payload without rescanning the Turn', () => {
    const assembler = fold([
      live(1, 'turn/start', { turn: 1 }),
      live(2, 'step/start', { turn: 1, step: 1 }),
      chunkAt(3, 1, 1, { type: 'text-delta', index: 0, text: 'interrupted reply' }),
      live(4, 'step/end', { turn: 1, step: 1 }),
      live(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(specOf(assembler)).toMatchObject({ answerStep: 1, inlineReasoning: false })

    // Reasoning added to the already selected Step cannot change eligibility, but
    // it does change the protected reply's own presentation.
    assembler.append(chunkAt(6, 1, 1, { type: 'reasoning-delta', index: 1, text: 'later thinking' }))
    assembler.flush()

    expect(specOf(assembler)).toMatchObject({ answerStep: 1, answerAnchorSeq: 3.1, inlineReasoning: true })
  })

  it('reselects on a late durable commitment without rescanning per late frame', () => {
    // Step 1 closes into an interrupted prefix; step 2 carries only Tool
    // protocol content. The newest finalized reply is therefore step 1.
    const assembler = fold([
      live(1, 'turn/start', { turn: 1 }),
      live(2, 'step/start', { turn: 1, step: 1 }),
      chunkAt(3, 1, 1, { type: 'text-delta', index: 0, text: 'interrupted prefix' }),
      live(4, 'step/end', { turn: 1, step: 1 }),
      live(5, 'step/start', { turn: 1, step: 2 }),
      assistantAt(6, 1, 2, [TOOL_CALL('call-2', 'bash')]),
      live(7, 'step/end', { turn: 1, step: 2 }),
      live(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(specOf(assembler)).toMatchObject({ answerStep: 1, answerAnchorSeq: 3.1 })

    const turn = chatSnapshot(assembler).timeline.turns.get(1)
    if (turn === undefined || turn.end === undefined) throw new Error('fixture lacks a closed Turn')
    const latest = turn.steps.at(-1)
    if (latest === undefined) throw new Error('fixture lacks the newest Step')
    // Only step 2's store reveals a Turn-wide search: late frames target step 1,
    // and nothing else reads the newest Step while the Turn stays closed.
    const scanned = vi.spyOn(latest.data, 'get')

    for (let frame = 0; frame < 20; frame += 1) {
      assembler.append(chunkAt(9 + frame, 1, 1, { type: 'text-delta', index: 0, text: `late ${String(frame)}` }))
      assembler.flush()
    }
    expect(scanned.mock.calls.length).toBe(0)
    expect(specOf(assembler)).toMatchObject({ answerStep: 1, answerAnchorSeq: 3.1 })

    // A late durable commitment invalidates the cached search in the same
    // publication that makes the reply available.
    assembler.append(assistantAt(40, 1, 2, [TEXT('late committed answer')]))
    assembler.flush()
    expect(scanned.mock.calls.length).toBeGreaterThan(0)
    expect(specOf(assembler)).toMatchObject({ answerStep: 2, answerAnchorSeq: 40 })
  })

  it('re-runs the search once when a retry resets the selected Step', () => {
    const assembler = fold([
      live(1, 'turn/start', { turn: 1 }),
      live(2, 'step/start', { turn: 1, step: 1 }),
      chunkAt(3, 1, 1, { type: 'text-delta', index: 0, text: 'interrupted prefix' }),
      live(4, 'step/end', { turn: 1, step: 1 }),
      live(5, 'step/start', { turn: 1, step: 2 }),
      assistantAt(6, 1, 2, [TEXT('first attempt')]),
      live(7, 'step/end', { turn: 1, step: 2 }),
      live(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const turn = chatSnapshot(assembler).timeline.turns.get(1)
    const interrupted = turn?.steps[0]
    if (turn === undefined || interrupted === undefined) throw new Error('fixture lacks Turn 1 steps')
    // Only a Turn-wide search reaches step 1 after the retry resets step 2.
    const scanned = vi.spyOn(interrupted.data, 'get')

    assembler.append(retryAt(9, 1, 2))
    assembler.flush()

    expect(scanned.mock.calls.length).toBe(1)
    // The retry withdrew the durable reply, so the interrupted prefix is the
    // newest finalized content again.
    expect(specOf(assembler)).toMatchObject({ answerStep: 1, answerAnchorSeq: 3.1 })
  })

  it('reads only the newest Step per frame while the Turn is open', () => {
    const entries: SessionLiveEventEntry[] = [
      live(1, 'turn/start', { turn: 1 }),
      live(2, 'step/start', { turn: 1, step: 1 }),
      assistantAt(3, 1, 1, [TEXT('first answer')]),
      live(4, 'step/end', { turn: 1, step: 1 }),
      live(5, 'step/start', { turn: 1, step: 2 }),
      chunkAt(6, 1, 2, { type: 'reasoning-delta', index: 0, text: 'thinking' }),
      live(7, 'step/end', { turn: 1, step: 2 }),
      live(8, 'step/start', { turn: 1, step: 3 }),
      chunkAt(9, 1, 3, { type: 'text-delta', index: 0, text: 'streaming' }),
    ]
    const assembler = fold(entries)
    const turn = chatSnapshot(assembler).timeline.turns.get(1)
    if (turn === undefined) throw new Error('fixture lacks Turn 1')
    expect(turn.status).toBe('open')
    const older = turn.steps.slice(0, 2).map(step => vi.spyOn(step.data, 'get'))

    for (let frame = 0; frame < 5; frame += 1) {
      assembler.append(chunkAt(10 + frame, 1, 3, { type: 'text-delta', index: 0, text: ` +${String(frame)}` }))
      assembler.flush()
    }

    // The open-Turn selection reads its newest Step only; earlier Steps are
    // never touched by a streamed token.
    expect(older.reduce((sum, read) => sum + read.mock.calls.length, 0)).toBe(0)
  })
})

const TURN_DATA_STORE: ConversationLocationDataStore<ConversationTurnDataMap> = {
  get: () => undefined,
  source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
}

/** Minimal closed Turn location; the projector reads only this Turn's number. */
const TURN: TurnLocation = {
  turn: 1,
  start: undefined,
  end: undefined,
  status: 'closed',
  steps: [],
  data: TURN_DATA_STORE,
}

function controlNode(spec: TurnProcessSpec): ChatNode<'turn-process'> {
  return {
    key: 'fixture:turn-process:1',
    id: '1',
    target: 'chat',
    kind: 'turn-process',
    anchorSeq: 0,
    location: { kind: 'turn', turn: TURN },
    visibility: 'visible',
    data: spec,
  }
}

function assistantNode(
  anchorSeq: number,
  step: number,
  blocks: readonly AssistantBlock[],
): ChatNode<'assistant-step'> {
  return {
    key: `fixture:assistant:${String(step)}`,
    id: String(step),
    target: 'chat',
    kind: 'assistant-step',
    anchorSeq,
    location: { kind: 'turn', turn: TURN },
    visibility: 'visible',
    data: { status: 'settled', turn: 1, step, blocks, time: anchorSeq, finalNode: {
      kind: 'assistant',
      seq: anchorSeq,
      time: anchorSeq,
      turn: 1,
      step,
      blocks,
    } },
  }
}

function toolRow(anchorSeq: number): ChatNode<'tool-call'> {
  return {
    key: `fixture:tool:${String(anchorSeq)}`,
    id: String(anchorSeq),
    target: 'chat',
    kind: 'tool-call',
    anchorSeq,
    location: { kind: 'turn', turn: TURN },
    visibility: 'visible',
    data: { root: { phase: 'start', callId: `call-${String(anchorSeq)}`, name: 'bash', argsRaw: '{}', turn: 1, step: 1, time: anchorSeq, subCalls: [] } },
  }
}

function projection(spec: TurnProcessSpec, rows: readonly ChatNode[]): ChatTurnProcessPresentation {
  const nodes: readonly ChatNode[] = [controlNode(spec), ...rows]
  const byKey = new Map(nodes.map(node => [node.key, node]))
  const keys = nodes.map(node => node.key)
  const locations: ChatLocationNodeIndex = { getTurn: () => keys, getStep: () => [] }
  const store: ChatNodeStore = { ...EMPTY_CHAT_SNAPSHOT.nodes, get: key => byKey.get(key) }
  const projector = new ChatTurnProcessProjector()
  projector.replace(keys, locations, store)
  const presentation = projector.get(byKey.get(controlNode(spec).key))
  if (presentation === undefined) throw new Error('projector published no presentation')
  return presentation
}

const PROOF: TurnProcessSpec = {
  turn: 1,
  controlAnchorSeq: 2,
  processStartSeq: 2,
  answerAnchorSeq: 5,
  answerStep: 2,
  inlineReasoning: false,
  messageCount: 0,
  toolCallCount: 0,
  subagentCount: 0,
}

describe('whole-Turn process membership', () => {
  it('counts process rows after the protected reply so its control stays usable', () => {
    const answer = assistantNode(5, 2, [{ kind: 'text', text: 'answer' }])
    const before = toolRow(3)
    const after = toolRow(6)

    expect(projection(PROOF, [before, answer]).hasExternalProcess).toBe(true)
    // A Tool row that follows the reply is hidden by the same outer control.
    expect(projection(PROOF, [answer, after]).hasExternalProcess).toBe(true)
    // With no process content at all the control stays non-interactive.
    expect(projection(PROOF, [answer]).hasExternalProcess).toBe(false)
  })

  it('keeps the protected response and its reasoning occurrence on opposite sides', () => {
    const spec: TurnProcessSpec = { ...PROOF, inlineReasoning: true }
    const answer = assistantNode(5, 2, [
      { kind: 'reasoning', text: 'thinking' },
      { kind: 'text', text: 'answer' },
    ])
    const earlier = assistantNode(3, 1, [{ kind: 'text', text: 'earlier reply' }])
    const presentation = projection(spec, [earlier, answer])

    expect(presentation.hasExternalProcess).toBe(true)
    expect(presentation.spec.inlineReasoning).toBe(true)

    // The reply occurrence stays outside the fold while its reasoning part and
    // every other row of the Turn stay inside it.
    expect(isTurnProcessAnswer(spec, 2, 'response')).toBe(true)
    expect(isTurnProcessAnswer(spec, 2, undefined)).toBe(true)
    expect(isTurnProcessAnswer(spec, 2, 'reasoning')).toBe(false)
    expect(isTurnProcessAnswer(spec, 1, 'response')).toBe(false)
    expect(isTurnProcessMember(spec, false, { anchorSeq: 5, step: 2, groupPart: 'response' })).toBe(false)
    expect(isTurnProcessMember(spec, false, { anchorSeq: 5, step: 2, groupPart: 'reasoning' })).toBe(true)
    expect(isTurnProcessMember(spec, false, { anchorSeq: 5, step: 2, groupPart: undefined })).toBe(false)
    expect(isTurnProcessMember(spec, false, { anchorSeq: 3, step: 1, groupPart: 'response' })).toBe(true)
    expect(isTurnProcessMember(spec, false, { anchorSeq: 6, step: null, groupPart: undefined })).toBe(true)
    expect(isTurnProcessMember(spec, false, { anchorSeq: 1, step: null, groupPart: undefined })).toBe(false)
    expect(isTurnProcessMember(spec, true, { anchorSeq: 5, step: 2, groupPart: 'response' })).toBe(true)
    expect(isTurnProcessMember({ ...spec, answerAnchorSeq: null, answerStep: null }, false,
      { anchorSeq: 5, step: 2, groupPart: 'response' })).toBe(true)
  })

  it('leaves revision-hidden rows out of the process count without unhiding them', () => {
    const answer = assistantNode(5, 2, [{ kind: 'text', text: 'answer' }])
    const hidden: ChatNode<'tool-call'> = { ...toolRow(6), visibility: 'hidden' }

    const presentation = projection(PROOF, [answer, hidden])
    expect(presentation.hasExternalProcess).toBe(false)
    expect(hidden.visibility).toBe('hidden')
  })
})
