/**
 * Anthropic response fidelity: the finish reason a generation limit produces, the
 * token totals successive usage events accumulate, and how both survive assembly
 * into harness blocks.
 *
 * Every stream here is a fake in-memory body; no server, socket, credential, or
 * network call is involved.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { AnthropicStreamTranslator, streamAnthropic } from '../src/translate/anthropic.js'
import type { AnthropicStreamEvent } from '../src/translate/anthropic.js'

/** Feed every event through one translator and flatten the chunks it emitted. */
function drain(
  translator: AnthropicStreamTranslator,
  events: readonly AnthropicStreamEvent[],
): StreamChunk[] {
  return events.flatMap(event => translator.push(event))
}

/** Assemble a translated stream the way the agent loop does. */
function assemble(chunks: readonly StreamChunk[]): BlockAssembler {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return assembler
}

/**
 * The one usage chunk a completed stream reports, checked to arrive ahead of the
 * terminal finish.
 * @param chunks - the translated stream.
 * @returns the usage the stream reported.
 */
function reportedUsage(chunks: readonly StreamChunk[]): TokenUsage {
  const usage = chunks.filter(chunk => chunk.type === 'usage')
  assert.equal(usage.length, 1, 'usage is reported exactly once')
  const only = usage[0]
  assert.ok(only.type === 'usage')
  assert.equal(chunks.at(-1)?.type, 'finish', 'the finish is the last chunk')
  assert.ok(chunks.indexOf(only) < chunks.length - 1, 'usage precedes the finish')
  return only.usage
}

/** One SSE frame for an event object, as the wire sends it. */
function frame(event: AnthropicStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/** A closed in-memory body carrying exactly the given frames. */
function body(frames: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const encoded of frames) controller.enqueue(encoder.encode(encoded))
      controller.close()
    },
  })
}

/** Drain `streamAnthropic` over an in-memory body. */
async function translate(frames: readonly string[]): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of streamAnthropic(body(frames))) chunks.push(chunk)
  return chunks
}

/** A text response that ends for the given wire stop reason. */
function textStream(stopReason: string, text = 'partial answer'): AnthropicStreamEvent[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]
}

test('a context-window stop ends as the generation-limit finish, not an ordinary stop', () => {
  const chunks = drain(new AnthropicStreamTranslator(), textStream('model_context_window_exceeded'))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  const assembler = assemble(chunks)
  assert.deepEqual(assembler.blocks(), [{ type: 'text', text: 'partial answer' }])
  assert.deepEqual(assembler.finish, { kind: 'max-tokens' })
})

test('a context-window stop that streamed no content is a limit, not an empty response', () => {
  const chunks = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded' }, usage: { output_tokens: 0 } },
    { type: 'message_stop' },
  ])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  assert.ok(
    !chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error'),
    'a generation limit is not reported as the empty-response failure',
  )
})

test('a context-window stop drops streamed tool calls and prunes replay metadata in step', () => {
  const chunks = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'partial' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu-1', name: 'bash' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ])
  // The raw stream still carries the truncated call; assembly is where it is dropped.
  assert.ok(chunks.some(chunk => chunk.type === 'tool-call-delta' && chunk.index === 2))
  const assembler = assemble(chunks)
  assert.deepEqual(assembler.finish, { kind: 'max-tokens' })
  assert.deepEqual(assembler.blocks().map(block => block.type), ['reasoning', 'text'])
  // The thinking signature survives, and the dropped call takes its own entry with it.
  assert.deepEqual(assembler.replayState?.blocks, [{ signature: 'sig-1' }, {}])
})

test('the ordinary terminal reasons keep their own finish kinds', () => {
  const mapped: readonly (readonly [string, string])[] = [
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'max-tokens'],
    ['refusal', 'refusal'],
  ]
  for (const [wire, kind] of mapped) {
    const chunks = drain(new AnthropicStreamTranslator(), textStream(wire))
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind } }, `${wire} maps to ${kind}`)
  }

  const toolUse = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu-1', name: 'bash' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ])
  assert.deepEqual(toolUse.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  assert.deepEqual(assemble(toolUse).blocks(), [
    { type: 'tool-call', id: 'toolu-1', name: 'bash', arguments: '{"cmd":"ls"}' },
  ])
})

test('nothing is emitted after the terminal finish', () => {
  const translator = new AnthropicStreamTranslator()
  const chunks = drain(translator, textStream('model_context_window_exceeded'))
  assert.equal(chunks.findIndex(chunk => chunk.type === 'finish'), chunks.length - 1)
  assert.deepEqual(
    translator.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 99 } }),
    [],
  )
  assert.deepEqual(translator.push({ type: 'message_stop' }), [])
})

test('a prompt the provider rejects as too long still raises the canonical context error', async () => {
  const frames = [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 300000 tokens > 200000 maximum' } },
  ] satisfies AnthropicStreamEvent[]
  await assert.rejects(
    translate(frames.map(frame)),
    (error: unknown) => error instanceof LlmError && error.code === 'CONTEXT_WINDOW_EXCEEDED',
  )
})

test('streamAnthropic: an in-memory context-window stream keeps its partial text and ends max-tokens', async () => {
  const chunks = await translate(textStream('model_context_window_exceeded').map(frame))
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'partial answer'))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('a later usage event replaces every count it reports', () => {
  const chunks = drain(new AnthropicStreamTranslator(), [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 1 } },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 999, cache_read_input_tokens: 777, cache_creation_input_tokens: 33, output_tokens: 2 },
    },
    { type: 'message_stop' },
  ])
  assert.deepEqual(reportedUsage(chunks), {
    inputTokens: 999,
    outputTokens: 2,
    cacheReadTokens: 777,
    cacheWriteTokens: 33,
  })
})

test('a usage event that omits or nulls a count preserves the count already reported', () => {
  const usage = reportedUsage(drain(new AnthropicStreamTranslator(), [
    {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 5,
          output_tokens: 1,
          output_tokens_details: { thinking_tokens: 4 },
        },
      },
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null },
    },
    { type: 'message_stop' },
  ]))
  assert.deepEqual(usage, {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 100,
    cacheWriteTokens: 5,
    reasoningTokens: 4,
  })
})

test('a usage event with no message_start still reports the input default', () => {
  const usage = reportedUsage(drain(new AnthropicStreamTranslator(), [
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
    { type: 'message_stop' },
  ]))
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 6 })
})

test('a later zero count replaces the count already reported', () => {
  const usage = reportedUsage(drain(new AnthropicStreamTranslator(), [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 3 } },
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
    },
    { type: 'message_stop' },
  ]))
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
})

test('repeated output counts replace each other instead of accumulating', () => {
  const usage = reportedUsage(drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 4 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: {}, usage: { output_tokens: 6 } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ]))
  assert.deepEqual(usage, { inputTokens: 10, outputTokens: 9 })
})

test('reasoning counts are preserved and replaced like the other counts', () => {
  const preserved = reportedUsage(drain(new AnthropicStreamTranslator(), [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 10, output_tokens: 1, output_tokens_details: { thinking_tokens: 4 } } },
    },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]))
  assert.equal(preserved.reasoningTokens, 4)

  const updated = reportedUsage(drain(new AnthropicStreamTranslator(), [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 10, output_tokens: 1, output_tokens_details: { thinking_tokens: 4 } } },
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2, output_tokens_details: { thinking_tokens: 7 } },
    },
    { type: 'message_stop' },
  ]))
  assert.equal(updated.reasoningTokens, 7)

  const nonFinite = reportedUsage(drain(new AnthropicStreamTranslator(), [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 10, output_tokens: 1, output_tokens_details: { thinking_tokens: Number.POSITIVE_INFINITY } } },
    },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]))
  assert.equal(nonFinite.reasoningTokens, undefined)
})

test('usage is reported once, ahead of the finish', () => {
  const chunks = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ])
  assert.equal(chunks.filter(chunk => chunk.type === 'usage').length, 1)
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
  assert.ok(
    chunks.findIndex(chunk => chunk.type === 'usage') < chunks.findIndex(chunk => chunk.type === 'finish'),
    'usage precedes the finish',
  )
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})
