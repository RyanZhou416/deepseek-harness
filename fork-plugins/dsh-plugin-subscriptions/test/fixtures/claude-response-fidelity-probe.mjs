/**
 * Prove the Claude response-fidelity fixes through the real translator and the
 * real harness assembly.
 *
 * `claude_response_fidelity_probe` drives `streamAnthropic` over synthetic
 * in-memory SSE bodies and the push-model `AnthropicStreamTranslator` directly,
 * then folds the emitted chunks with the harness `BlockAssembler`. Every body is
 * a closed `ReadableStream` built from string frames, so there is no socket,
 * timer, credential, or provider call, and the tool returns one deterministic
 * JSON observation for the session log.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import { AnthropicStreamTranslator, streamAnthropic } from '../../src/translate/anthropic.ts'

export const name = 'claude-response-fidelity-probe'
export const inject = ['tools']

/**
 * One wire frame for a parsed event object, as the endpoint sends it.
 * @param event - the SSE event object.
 * @returns the framed bytes as text.
 */
function frame(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * A closed in-memory response body carrying exactly the given events.
 * @param events - the SSE events in arrival order.
 * @returns the body `streamAnthropic` consumes.
 */
function sseBody(events) {
  const encoder = new TextEncoder()
  const frames = events.map(frame)
  return new ReadableStream({
    start(controller) {
      for (const text of frames) controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

/**
 * Translate one synthetic body through the real SSE consumer.
 * @param events - the SSE events in arrival order.
 * @returns every emitted chunk, in stream order.
 */
async function translate(events) {
  const chunks = []
  for await (const chunk of streamAnthropic(sseBody(events))) chunks.push(chunk)
  return chunks
}

/**
 * Fold translated chunks the way the agent loop does.
 * @param chunks - the translated stream.
 * @returns the assembler holding the final blocks, usage, and finish reason.
 */
function assemble(chunks) {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return assembler
}

/**
 * The one usage chunk a stream reported, checked to arrive ahead of the finish.
 * @param chunks - the translated stream.
 * @returns the usage the stream reported.
 */
function reportedUsage(chunks) {
  const usages = chunks.filter(chunk => chunk.type === 'usage')
  if (usages.length !== 1) throw new Error(`expected one usage chunk, received ${usages.length}`)
  if (chunks.at(-1)?.type !== 'finish') throw new Error('the finish is not the last chunk')
  if (chunks.indexOf(usages[0]) >= chunks.length - 1) throw new Error('usage did not precede the finish')
  return usages[0].usage
}

/**
 * The block kinds the raw stream opened, before assembly drops any of them.
 * @param chunks - the translated stream.
 * @returns one block kind per `block-start`, in stream order.
 */
function streamedBlockTypes(chunks) {
  return chunks.flatMap(chunk => chunk.type === 'block-start' ? [chunk.blockType] : [])
}

/** A response the provider cut off at its context ceiling, mid tool call. */
const CONTEXT_LIMIT = [
  { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial answ' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_limit', name: 'bash' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls ' } },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'model_context_window_exceeded' },
    usage: { input_tokens: 999, cache_read_input_tokens: 777, cache_creation_input_tokens: 33, output_tokens: 7 },
  },
  { type: 'message_stop' },
]

/** A response whose closing usage restates every count as an explicit zero. */
const EXPLICIT_ZERO = [
  { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 3 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
  },
  { type: 'message_stop' },
]

/** An ordinary completed response that omits the input count on its closing usage. */
const END_TURN = [
  { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_control', name: 'bash' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
]

/** A request the provider rejects as too long, which is not a generation limit. */
const PROMPT_TOO_LONG = [
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 300000 tokens > 200000 maximum' } },
]

/**
 * Report whether the rejected request kept its canonical context error.
 * @returns the observed error class and code, or `none` when nothing threw.
 */
async function promptTooLong() {
  try {
    await translate(PROMPT_TOO_LONG)
    return { error: 'none' }
  } catch (error) {
    return {
      error: error instanceof LlmError ? 'LlmError' : 'other',
      code: error instanceof LlmError ? error.code : undefined,
    }
  }
}

/** Run every fidelity proof over the real translator and the real assembly. */
async function proveResponseFidelity() {
  const limitChunks = await translate(CONTEXT_LIMIT)
  const limit = assemble(limitChunks)
  const limitUsage = reportedUsage(limitChunks)

  const zeroTranslator = new AnthropicStreamTranslator()
  const zeroChunks = EXPLICIT_ZERO.flatMap(event => zeroTranslator.push(event))

  const endTurnChunks = await translate(END_TURN)
  const endTurn = assemble(endTurnChunks)

  return {
    scenario: 'claude-response-fidelity',
    generationLimit: {
      finish: limit.finish.kind,
      streamedBlockTypes: streamedBlockTypes(limitChunks),
      assembledBlocks: limit.blocks(),
      usage: limitUsage,
    },
    explicitZeroUsage: {
      finish: assemble(zeroChunks).finish.kind,
      usage: reportedUsage(zeroChunks),
    },
    endTurnControl: {
      finish: endTurn.finish.kind,
      streamedBlockTypes: streamedBlockTypes(endTurnChunks),
      assembledBlocks: endTurn.blocks(),
      usage: reportedUsage(endTurnChunks),
    },
    promptTooLong: await promptTooLong(),
  }
}

/** Register the deterministic response-fidelity probe with recorded output. */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'claude_response_fidelity_probe',
    description: 'Prove a context-window stop ends as the generation limit that keeps partial text and drops an unfinished tool call, that later usage restates token counts field by field, and that an ordinary end_turn stop and a too-long-prompt error are unchanged.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return JSON.stringify(await proveResponseFidelity())
    },
    presentCall: args => ({ card: 'generic', title: 'Inspect Claude response fidelity', kind: 'other', rawInput: args }),
  })))
}
