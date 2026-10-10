/**
 * Pure-function tests for the Responses wire translator (Copilot's responses
 * wire): the SSE state machine's terminal contract. No network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { streamResponses } from '../src/translate/responses.js'
import type { ResponsesStreamEvent } from '../src/translate/responses.js'

/** A response body that carries exactly the given events and then ends. */
function responsesBody(events: ResponsesStreamEvent[]): ReadableStream<Uint8Array> {
  const frames = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames))
      controller.close()
    },
  })
}

test('streamResponses: a body that ends before response.completed fails as a retryable transport truncation', async () => {
  const chunks: StreamChunk[] = []
  let failure: unknown
  try {
    for await (const chunk of streamResponses(responsesBody([
      { type: 'response.output_item.added', item: { type: 'message', id: 'a' } },
      { type: 'response.output_text.delta', item_id: 'a', delta: 'hi' },
    ]))) chunks.push(chunk)
  } catch (error) {
    failure = error
  }
  // What the stream already delivered stays delivered; the missing terminal event is the
  // failure, and the client retries it as a dropped connection.
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta'])
  assert.ok(failure instanceof LlmError, 'a truncated body throws')
  assert.equal(failure.code, 'TRANSPORT', 'the retry policy repeats TRANSPORT')
})

test('streamResponses: a body with response.completed completes without throwing', async () => {
  const chunks: StreamChunk[] = []
  for await (const chunk of streamResponses(responsesBody([
    { type: 'response.output_text.delta', item_id: 'a', delta: 'hi' },
    { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]))) chunks.push(chunk)
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'hi'))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('streamResponses: a payload that cannot be parsed throws MALFORMED_RESPONSE', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {not json\n\n'))
      controller.close()
    },
  })
  await assert.rejects(async () => {
    for await (const chunk of streamResponses(body)) void chunk
  }, (error: unknown) => error instanceof LlmError && error.code === 'MALFORMED_RESPONSE')
})
