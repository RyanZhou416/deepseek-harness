/**
 * Claude replay and terminal-stop boundaries: what the translator captures from
 * one response, what the loop's assembly keeps of it, where a captured
 * server-tool pair is re-emitted in the next request, and which wire stop states
 * end the turn instead of passing as a completed answer.
 *
 * Every stream here is an in-memory event list fed through the shipped
 * translator and {@link BlockAssembler}; no server, socket, credential, or SDK
 * call is involved. The captured pair is a synthetic response shape — this
 * adapter's request builder declares no server tool, and whether a deferred
 * tool-loading beta can make the server return one is untested — so these cases
 * pin the adapter's own contract, not a live occurrence.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BlockAssembler, EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ReplayEnvelope, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '../src/compat.js'
import {
  AnthropicStreamTranslator,
  toAnthropicMessages,
  UNSUPPORTED_RESPONSE_CODE,
} from '../src/translate/anthropic.js'
import type { AnthropicStreamEvent } from '../src/translate/anthropic.js'
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, subscriptionRetryPolicy } from '../src/providers/rate-limit.js'
import type { TranslatableBlock, TranslatableMessage } from '../src/translate/resolved.js'

/** The model that produced every replayed message. */
const MODEL = 'claude-opus-4-5'

/** The two server blocks a response streamed, as the next request carries them back. */
const SERVER_PAIR: readonly Record<string, unknown>[] = [
  {
    type: 'server_tool_use',
    id: 'server1',
    name: 'tool_search_tool_regex',
    input: { query: 'find' },
  },
  {
    type: 'tool_search_tool_result',
    tool_use_id: 'server1',
    content: { type: 'tool_search_tool_search_result', tool_references: [] },
  },
]

/** Feed every event through one translator and flatten the chunks it emitted. */
function drain(events: readonly AnthropicStreamEvent[]): StreamChunk[] {
  const translator = new AnthropicStreamTranslator()
  return events.flatMap(event => translator.push(event))
}

/** One wire message's content blocks; a string-carrying system message has none. */
function blocksOf(message: { content: unknown }): readonly Record<string, unknown>[] {
  return Array.isArray(message.content) ? message.content as Record<string, unknown>[] : []
}

/** The wire content types of one message, in order. */
function typesOf(message: { content: unknown }): unknown[] {
  return blocksOf(message).map(block => block.type)
}

/** One stored assistant message with adapter replay metadata. */
function assistantMessage(
  content: readonly TranslatableBlock[],
  replayState?: ReplayEnvelope,
): TranslatableMessage {
  return {
    role: 'assistant',
    content,
    source: {
      kind: 'model',
      provider: 'claude',
      model: MODEL,
      ...replayState === undefined ? {} : { replayState },
    },
  }
}

/** The user message answering a local tool call. */
function toolResultMessage(callId: string): TranslatableMessage {
  return {
    role: 'user',
    content: [{
      type: 'tool-result',
      toolCallId: ToolCallId(callId),
      content: [{ type: 'text', text: 'ok' }],
    }],
  }
}

/** What one streamed response leaves for the next request. */
interface Replayed {
  /** The blocks assembly kept. */
  kept: readonly ContentBlock[]
  /** The envelope assembly stored on the message, if any. */
  envelope: ReplayEnvelope | undefined
  /** The request built from the stored assistant message. */
  wire: ReturnType<typeof toAnthropicMessages>
}

/**
 * Run one response through the shipped path — translator, then the loop's
 * assembler — and replay the stored assistant message into a request.
 * @param events - the response's events, in stream order.
 * @param following - messages sent after the assistant message.
 * @returns the kept blocks, the stored envelope, and the built request.
 */
function replay(
  events: readonly AnthropicStreamEvent[],
  following: readonly TranslatableMessage[] = [],
): Replayed {
  const assembler = new BlockAssembler()
  for (const chunk of drain(events)) assembler.push(chunk)
  const envelope = assembler.replayState
  const kept = assembler.blocks()
  return {
    kept,
    envelope,
    wire: toAnthropicMessages([assistantMessage(kept, envelope), ...following], MODEL),
  }
}

/** A truncated local call, a captured server pair, then text: the observed response shape. */
function localThenServerThenText(stopReason: string): AnthropicStreamEvent[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'local1', name: 'local_tool' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'server_tool_use', id: 'server1', name: 'tool_search_tool_regex', input: { query: 'find' } },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: {
        type: 'tool_search_tool_result',
        tool_use_id: 'server1',
        content: { type: 'tool_search_tool_search_result', tool_references: [] },
      },
    },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'after server result' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
}

test('a generation-limit prune keeps the captured server pair ahead of the text it preceded', () => {
  for (const reason of ['max_tokens', 'model_context_window_exceeded']) {
    const { kept, envelope, wire } = replay(localThenServerThenText(reason))
    assert.deepEqual(kept, [{ type: 'text', text: 'after server result' }], `${reason}: the truncated call is dropped`)
    assert.deepEqual(
      typesOf(wire[0]),
      ['server_tool_use', 'tool_search_tool_result', 'text'],
      `${reason}: the pair leads the text it arrived before`,
    )
    const [call, result, text] = blocksOf(wire[0])
    assert.deepEqual(call, SERVER_PAIR[0])
    assert.deepEqual(result, SERVER_PAIR[1])
    assert.equal(call.id, result.tool_use_id, 'the pair keeps its ids')
    assert.deepEqual(text, { type: 'text', text: 'after server result' })
    assert.ok(
      !blocksOf(wire[0]).some(block => block.type === 'tool_use'),
      `${reason}: the limit does not re-emit the dropped local call`,
    )
    // The stored positions name the message's own blocks, so a reload replays this order.
    assert.deepEqual(
      (envelope?.response as { serverBlocks?: unknown }).serverBlocks,
      [
        { index: 0, block: SERVER_PAIR[0] },
        { index: 0, block: SERVER_PAIR[1] },
      ],
      reason,
    )
  }
})

test('a pruned response replays signed thinking, kept text, and the pair in response order', () => {
  const { kept, envelope, wire } = replay([
    { type: 'message_start', message: { usage: { input_tokens: 2 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'before' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'local1', name: 'local_tool' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'content_block_start',
      index: 3,
      content_block: { type: 'server_tool_use', id: 'server1', name: 'tool_search_tool_regex', input: { query: 'find' } },
    },
    { type: 'content_block_stop', index: 3 },
    {
      type: 'content_block_start',
      index: 4,
      content_block: {
        type: 'tool_search_tool_result',
        tool_use_id: 'server1',
        content: { type: 'tool_search_tool_search_result', tool_references: [] },
      },
    },
    { type: 'content_block_stop', index: 4 },
    { type: 'content_block_start', index: 5, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 5, delta: { type: 'text_delta', text: 'after' } },
    { type: 'content_block_stop', index: 5 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ])

  assert.deepEqual(kept.map(block => block.type), ['reasoning', 'text', 'text'])
  // One entry per kept block: the dropped call takes its own entry with it and the
  // signature stays aligned with the block it belongs to.
  assert.deepEqual(envelope?.blocks, [{ signature: 'sig-1' }, {}, {}])
  assert.deepEqual(typesOf(wire[0]), ['thinking', 'text', 'server_tool_use', 'tool_search_tool_result', 'text'])
  const blocks = blocksOf(wire[0])
  assert.deepEqual(blocks[0], { type: 'thinking', thinking: 'plan', signature: 'sig-1' })
  assert.deepEqual(blocks[1], { type: 'text', text: 'before' })
  assert.deepEqual(blocks[2], SERVER_PAIR[0])
  assert.deepEqual(blocks[3], SERVER_PAIR[1])
  assert.deepEqual(blocks[4], { type: 'text', text: 'after' })
})

test('an unpruned response keeps prefix text, the local call, the pair, and suffix text in order', () => {
  const { kept, wire } = replay([
    { type: 'message_start', message: { usage: { input_tokens: 2 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'before' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'local1', name: 'local_tool' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'server_tool_use', id: 'server1', name: 'tool_search_tool_regex', input: { query: 'find' } },
    },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'content_block_start',
      index: 3,
      content_block: {
        type: 'tool_search_tool_result',
        tool_use_id: 'server1',
        content: { type: 'tool_search_tool_search_result', tool_references: [] },
      },
    },
    { type: 'content_block_stop', index: 3 },
    { type: 'content_block_start', index: 4, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 4, delta: { type: 'text_delta', text: 'after' } },
    { type: 'content_block_stop', index: 4 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ], [toolResultMessage('local1')])

  assert.deepEqual(kept.map(block => block.type), ['text', 'tool-call', 'text'])
  assert.deepEqual(typesOf(wire[0]), ['text', 'tool_use', 'server_tool_use', 'tool_search_tool_result', 'text'])
  const blocks = blocksOf(wire[0])
  assert.deepEqual(blocks[0], { type: 'text', text: 'before' })
  assert.deepEqual(blocks[1], { type: 'tool_use', id: 'local1', name: 'local_tool', input: { x: 1 } })
  assert.deepEqual(blocks[2], SERVER_PAIR[0])
  assert.deepEqual(blocks[3], SERVER_PAIR[1])
  assert.deepEqual(blocks[4], { type: 'text', text: 'after' })
  assert.deepEqual(typesOf(wire[1]), ['tool_result'])
})

test('a generation limit with no captured pair keeps its prune and envelope alignment', () => {
  const { kept, envelope, wire } = replay([
    { type: 'message_start', message: { usage: { input_tokens: 2 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'partial' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'local1', name: 'local_tool' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ])

  assert.deepEqual(kept.map(block => block.type), ['reasoning', 'text'])
  assert.deepEqual(envelope?.blocks, [{ signature: 'sig-1' }, {}])
  assert.deepEqual(typesOf(wire[0]), ['thinking', 'text'])
  assert.ok(!blocksOf(wire[0]).some(block => block.type === 'tool_use'))
})

test('a capture before every block and one after the last block keep their ends', () => {
  const leading = replay([
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'server_tool_use', id: 'server1', name: 'tool_search_tool_regex', input: { query: 'find' } },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_search_tool_result',
        tool_use_id: 'server1',
        content: { type: 'tool_search_tool_search_result', tool_references: [] },
      },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'found it' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ])
  assert.deepEqual(typesOf(leading.wire[0]), ['server_tool_use', 'tool_search_tool_result', 'text'])

  const trailing = replay([
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'local1', name: 'local_tool' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'server_tool_use', id: 'server1', name: 'tool_search_tool_regex', input: { query: 'find' } },
    },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'content_block_start',
      index: 3,
      content_block: {
        type: 'tool_search_tool_result',
        tool_use_id: 'server1',
        content: { type: 'tool_search_tool_search_result', tool_references: [] },
      },
    },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ])
  assert.deepEqual(trailing.kept.map(block => block.type), ['text'])
  assert.deepEqual(typesOf(trailing.wire[0]), ['text', 'server_tool_use', 'tool_search_tool_result'])
})

test('an envelope recorded before positions were rebased still replays every capture', () => {
  const legacy = (index: number, entries: number): ReplayEnvelope => ({
    response: {
      kind: 'claude',
      version: 1,
      serverBlocks: [
        { index, block: SERVER_PAIR[0] },
        { index, block: SERVER_PAIR[1] },
      ],
    },
    blocks: Array.from({ length: entries }, () => ({})),
  })

  // A response that kept every block: the recorded position is already a message position.
  const unpruned = toAnthropicMessages([
    assistantMessage([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], legacy(1, 2)),
  ], MODEL)
  assert.deepEqual(typesOf(unpruned[0]), ['text', 'server_tool_use', 'tool_search_tool_result', 'text'])

  // A response already stored as pruned keeps the place the older envelope named; no
  // capture is dropped, and reading it must not throw or invent a different pair.
  const pruned = toAnthropicMessages([
    assistantMessage([{ type: 'text', text: 'a' }], legacy(1, 1)),
  ], MODEL)
  assert.deepEqual(typesOf(pruned[0]), ['text', 'server_tool_use', 'tool_search_tool_result'])
})

/** A response that streamed one text block and then the given `message_delta`. */
function textThenDelta(delta: NonNullable<AnthropicStreamEvent['delta']>): AnthropicStreamEvent[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]
}

/** The server-tool pair as a response streamed it, with a wire index each. */
function serverOnlyStream(): AnthropicStreamEvent[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'server_tool_use', id: 'server1', name: 'tool_search_tool_regex', input: { query: 'find' } },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_search_tool_result',
        tool_use_id: 'server1',
        content: { type: 'tool_search_tool_search_result', tool_references: [] },
      },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
}

test('a paused or compacting turn fails closed instead of passing as a completed one', () => {
  for (const reason of ['pause_turn', 'compaction']) {
    const chunks = drain(textThenDelta({ stop_reason: reason }))
    assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'answer'), reason)
    assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1, reason)
    const usage = chunks.filter(chunk => chunk.type === 'usage')
    assert.equal(usage.length, 1, `${reason}: usage is reported exactly once`)
    assert.ok(chunks.indexOf(usage[0]) < chunks.length - 1, `${reason}: usage precedes the finish`)
    const finish = chunks.at(-1)
    assert.ok(finish?.type === 'finish', reason)
    assert.deepEqual(finish.reason, {
      kind: 'error',
      failure: {
        message: `Anthropic ended the turn with unsupported stop reason "${reason}"`,
        code: UNSUPPORTED_RESPONSE_CODE,
        // Output already reached the Host, so the failed turn may not be replayed.
        retryDisposition: 'forbid',
      },
    })
    assert.equal(finish.replayState, undefined, `${reason}: an error finish carries no replay envelope`)
    assert.deepEqual(
      chunks.slice(chunks.indexOf(finish) + 1),
      [],
      `${reason}: nothing follows the terminal finish`,
    )
  }
})

test('an unmodeled non-empty stop reason fails closed rather than ending as an ordinary stop', () => {
  const chunks = drain(textThenDelta({ stop_reason: 'some_future_reason' }))
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish')
  assert.deepEqual(finish.reason, {
    kind: 'error',
    failure: {
      message: 'Anthropic ended the turn with unsupported stop reason "some_future_reason"',
      code: UNSUPPORTED_RESPONSE_CODE,
      // Text was streamed before this terminal state, so the step is not replayed.
      retryDisposition: 'forbid',
    },
  })
})

test('a delta that states no stop reason still ends as an ordinary stop', () => {
  for (const delta of [{}, { stop_reason: '' }]) {
    assert.deepEqual(
      drain(textThenDelta(delta)).at(-1),
      { type: 'finish', reason: { kind: 'stop' } },
      JSON.stringify(delta),
    )
  }
})

test('a server-tool-only turn fails closed while a genuinely empty completion stays empty', () => {
  const serverOnly = drain(serverOnlyStream())
  const finish = serverOnly.at(-1)
  assert.ok(finish?.type === 'finish')
  assert.deepEqual(finish.reason, {
    kind: 'error',
    failure: {
      message: 'Anthropic returned server-tool content with no harness-visible block',
      code: UNSUPPORTED_RESPONSE_CODE,
    },
  })
  assert.notEqual(
    finish.reason.kind === 'error' ? finish.reason.failure.code : undefined,
    EMPTY_RESPONSE_CODE,
    'a response that carried server-tool content is not retried as an empty one',
  )
  assert.equal(finish.replayState, undefined, 'no success envelope is fabricated for a failed turn')

  // The same stream with the pair removed is the provider's degenerate completion, and
  // keeps the empty-response code whose retry remains appropriate for it.
  const noContent = drain([
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
    { type: 'message_stop' },
  ])
  const empty = noContent.at(-1)
  assert.ok(empty?.type === 'finish')
  assert.deepEqual(empty.reason, {
    kind: 'error',
    failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
  })
})

test('subscription routes do not retry the unsupported-response failure', () => {
  const policy = subscriptionRetryPolicy(DEFAULT_RETRY, DEFAULT_RATE_LIMIT_WAIT, 'test: replay boundary policy')
  assert.ok(policy.mode === 'normal')
  assert.equal(policy.retryableCodes.includes(UNSUPPORTED_RESPONSE_CODE), false)
  // The empty-response code keeps retrying only the degenerate completion it still classifies;
  // a server-tool-only response no longer reaches it.
  assert.equal(policy.retryableCodes.includes(EMPTY_RESPONSE_CODE), true)
})

/** The durable identity one attempt was prepared under, as the route hands it to the translator. */
const PREPARED = {
  accountRef: { kind: 'salt-sha256', version: 1, ref: 'a'.repeat(64) } as const,
  spanEpoch: 3,
  harnessSessionId: 'session-1',
  wireSessionId: '11111111-1111-4111-8111-111111111111',
}

/** One completed response, as the wire delivers it. */
const COMPLETED: readonly AnthropicStreamEvent[] = [
  { type: 'message_start', message: { usage: { input_tokens: 4 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]

test('a completed turn records the continuation, the request id and its assembled blocks', () => {
  const translator = new AnthropicStreamTranslator('req_0123456789abcdef', undefined, undefined, PREPARED)
  const chunks = COMPLETED.flatMap(event => translator.push(event))
  // The loop's own assembly: the envelope the turn publishes is the one this assembler exposes.
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  assert.deepEqual(assembler.finish, { kind: 'stop' })
  assert.deepEqual(assembler.blocks(), [{ type: 'text', text: 'hi' }])
  const response = assembler.replayState?.response as {
    kind?: unknown
    continuation?: Record<string, unknown>
    requestId?: unknown
  }
  assert.equal(response.kind, 'claude')
  assert.equal(response.requestId, 'req_0123456789abcdef', 'the response header id is recorded')
  assert.deepEqual(response.continuation, {
    v: 1,
    accountRef: PREPARED.accountRef,
    spanEpoch: PREPARED.spanEpoch,
    harnessSessionId: PREPARED.harnessSessionId,
    wireSessionId: PREPARED.wireSessionId,
    requestId: 'req_0123456789abcdef',
  }, 'the span identity the attempt was prepared under is recorded with the response')
  assert.ok(
    Array.isArray(assembler.replayState?.blocks),
    'a completed turn records a block list beside its continuation',
  )
  assert.equal(assembler.replayState.blocks.length, 1, 'the recorded blocks line up with the assembled ones')
})

test('a turn that never completed records no continuation at all', () => {
  const translator = new AnthropicStreamTranslator('req_0123456789abcdef', undefined, undefined, PREPARED)
  // The stream stops after its text with no terminal delta and no message_stop: the attempt failed,
  // so the route must not hand a later request a chain identity this turn never committed.
  const unterminated: readonly AnthropicStreamEvent[] = [
    { type: 'message_start', message: { usage: { input_tokens: 4 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
  ]
  const chunks = unterminated.flatMap(event => translator.push(event))
  assert.equal(chunks.some(chunk => chunk.type === 'finish'), false, 'the stream produced no terminal chunk')
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  assert.deepEqual(assembler.blocks(), [{ type: 'text', text: 'hi' }], 'what did stream is still assembled')
  assert.equal(assembler.replayState, undefined, 'a failed attempt fabricates no success envelope')
})
