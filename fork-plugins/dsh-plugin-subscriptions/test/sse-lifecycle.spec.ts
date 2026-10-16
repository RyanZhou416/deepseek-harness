/**
 * Lifecycle tests for the SSE byte-stream parser and the Anthropic translator built on
 * it: what the parser releases when a consumer stops before EOF, and what it must leave
 * to the source when the body really ends. Every source here is an in-memory stream, so
 * no case opens a socket, a child process, or a timer.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmError, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseSse } from '../src/translate/sse.js'
import { streamAnthropic } from '../src/translate/anthropic.js'

/** A byte source plus the cancellation reasons its consumer recorded. */
interface TrackedBody {
  readonly stream: ReadableStream<Uint8Array>
  readonly cancels: unknown[]
}

/**
 * A body that delivers the given chunks — one read each — and then stays open, the way
 * a live SSE response does before its terminal event.
 * @param chunks - text or bytes delivered in order.
 * @param onCancel - optional rejection, modelling a source that refuses cancellation.
 * @returns the stream and the cancellation reasons it recorded.
 */
function openBody(
  chunks: readonly (string | Uint8Array)[],
  onCancel?: () => Promise<void>,
): TrackedBody {
  const encoder = new TextEncoder()
  const cancels: unknown[] = []
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      }
    },
    cancel(reason) {
      cancels.push(reason)
      return onCancel?.()
    },
  })
  return { stream, cancels }
}

/**
 * A body that delivers the given chunks and then ends.
 * @param chunks - text or bytes delivered in order.
 * @returns the stream and the cancellation reasons it recorded.
 */
function closedBody(chunks: readonly (string | Uint8Array)[]): TrackedBody {
  const encoder = new TextEncoder()
  const cancels: unknown[] = []
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      }
      controller.close()
    },
    cancel(reason) {
      cancels.push(reason)
    },
  })
  return { stream, cancels }
}

/**
 * One Anthropic SSE frame.
 * @param event - the `event:` field.
 * @param payload - the JSON payload carried by `data:`.
 * @returns the framed event text.
 */
function anthropicFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** A complete text response: message_start through message_stop. */
const TEXT_RESPONSE: readonly string[] = [
  anthropicFrame('message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }),
  anthropicFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  anthropicFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
  anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
  anthropicFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
  anthropicFrame('message_stop', { type: 'message_stop' }),
]

test('parseSse keeps LF, CRLF and split UTF-8 framing across reused calls and drops an unterminated tail', async () => {
  const lf: { data: string; event?: string }[] = []
  for await (const event of parseSse(
    closedBody([
      ': keep-alive\n',
      'data: first\n',
      'data: second\n',
      '\n',
      'id: 7\n',
      'event: message_stop\n',
      'data: {}\n\n',
      'data: unterminated tail',
    ]).stream,
  )) {
    lf.push(event)
  }
  assert.deepEqual(lf, [
    { data: 'first\nsecond' },
    { data: '{}', event: 'message_stop' },
  ])

  // The same parser instance-per-call is reused for a second body, whose chunk
  // boundaries fall inside a four-byte UTF-8 sequence.
  const globe = new TextEncoder().encode('🌍')
  const crlf: string[] = []
  for await (const event of parseSse(
    closedBody([
      new TextEncoder().encode('data: héllo '),
      globe.subarray(0, 2),
      globe.subarray(2),
      new TextEncoder().encode('\r\ndata: done\r\n\r\n'),
    ]).stream,
  )) {
    crlf.push(event.data)
  }
  assert.deepEqual(crlf, ['héllo 🌍\ndone'])
})

test('a consumer that stops early cancels the source once and releases its lock', async () => {
  const body = openBody(['data: one\n\n', 'data: two\n\n'])
  const events = parseSse(body.stream)
  const first = await events.next()
  assert.deepEqual(first.value, { data: 'one' })
  assert.deepEqual(body.cancels, [], 'a source the parser still needs is not cancelled')

  await events.return(undefined)
  assert.equal(body.cancels.length, 1, 'the abandoned body is cancelled')
  assert.equal(body.stream.locked, false, 'the reader lock is released after the cancel')
})

test('a body that ends by itself is not cancelled', async () => {
  const body = closedBody(['data: one\n\n', 'data: two\n\n'])
  const seen: string[] = []
  for await (const event of parseSse(body.stream)) seen.push(event.data)
  assert.deepEqual(seen, ['one', 'two'])
  assert.deepEqual(body.cancels, [], 'EOF is not an abandonment')
})

test('a source that rejects its cancellation does not replace the failure that stopped the consumer', async (t) => {
  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => {
    rejections.push(reason)
  }
  process.on('unhandledRejection', onRejection)
  t.after(() => {
    process.off('unhandledRejection', onRejection)
  })

  const body = openBody(
    ['data: one\n\n', 'data: two\n\n'],
    () => Promise.reject(new Error('source refused cancellation')),
  )
  const failure = new Error('malformed payload')
  const events = parseSse(body.stream)
  await events.next()
  await assert.rejects(events.throw(failure), (error: unknown) => error === failure)
  assert.equal(body.cancels.length, 1)
  // One turn for a rejected cancel promise to surface, observing that the parser
  // handled it instead of abandoning it.
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
  assert.deepEqual(rejections, [])
})

test('an onActivity callback that throws cancels the body it was reading', async () => {
  const body = openBody(['data: one\n\n', 'data: two\n\n'])
  const events = parseSse(body.stream, () => {
    throw new Error('activity hook failed')
  })
  await assert.rejects(
    events.next(),
    (error: unknown) => error instanceof Error && error.message === 'activity hook failed',
  )
  assert.equal(body.cancels.length, 1)
})

test('the Anthropic translator cancels the body trailing message_stop', async () => {
  const body = openBody([...TEXT_RESPONSE, 'data: never read\n\n'])
  const chunks: StreamChunk[] = []
  for await (const chunk of streamAnthropic(body.stream)) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.equal(body.cancels.length, 1, 'the still-open upstream body is released once')
})

test('a payload the translator cannot parse cancels the body it was reading', async () => {
  const body = openBody(['data: {not json\n\n', 'data: {}\n\n'])
  const drained: StreamChunk[] = []
  await assert.rejects(
    (async () => {
      for await (const chunk of streamAnthropic(body.stream)) drained.push(chunk)
    })(),
    (error: unknown) => error instanceof LlmError && error.code === 'MALFORMED_RESPONSE',
  )
  assert.deepEqual(drained, [])
  assert.equal(body.cancels.length, 1)
})

test('a body that ends before message_stop is a truncation, not an abandonment', async () => {
  const body = closedBody(TEXT_RESPONSE.slice(0, -1))
  const drained: StreamChunk[] = []
  await assert.rejects(
    (async () => {
      for await (const chunk of streamAnthropic(body.stream)) drained.push(chunk)
    })(),
    (error: unknown) => {
      // The response was accepted, so the request has certainly been sent and its outcome is
      // unknown: the turn is not a success, and nothing may resend it.
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'STREAM_INCOMPLETE')
      assert.equal(error.failure.retryDisposition, 'forbid')
      return true
    },
  )
  assert.ok(drained.length > 0, 'what the stream already delivered stays delivered')
  assert.deepEqual(body.cancels, [], 'nothing is cancelled once the source has ended')
})
