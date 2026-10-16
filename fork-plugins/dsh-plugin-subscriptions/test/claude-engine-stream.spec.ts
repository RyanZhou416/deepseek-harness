/**
 * The Claude engine's one-turn lifecycle: raw bytes preserved, the three lifecycle facts kept
 * apart, typed terminals, the caller's own refusal hook, one bounded credential recovery, and
 * cancellation that abandons a held read. No network, no harness: every transport is synthetic.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSseFramer, SSE_FRAME_LIMIT_BYTES } from '../src/claude-engine/sse.js'
import { runClaudeEngineTurn } from '../src/claude-engine/stream.js'
import type {
  ClaudeEngineEvent,
  ClaudeEngineRequest,
  ClaudeEngineTransport,
  ClaudeEngineUsage,
} from '../src/claude-engine/types.js'

/** A request shaped like one the builder produces, without building one here. */
const REQUEST: ClaudeEngineRequest = {
  url: 'https://api.anthropic.com/v1/messages?beta=true',
  method: 'POST',
  headers: [['authorization', 'Bearer at-synthetic'], ['content-type', 'application/json']],
  body: '{"model":"claude-opus-4-5"}',
  evidence: {
    profileId: 'claude-code-2.1.288-sdk-0.128.0',
    url: 'https://api.anthropic.com/v1/messages?beta=true',
    modelFamily: 'opus',
    betaFeatures: [],
    headerNames: ['authorization', 'content-type'],
    bodySha256: '0'.repeat(64),
    bodyByteLength: 31,
  },
}

/**
 * Frame one event the way the service does.
 * @param event - the event object.
 * @returns the framed bytes.
 */
function frame(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
}

/** A complete text answer, as raw bytes. */
const COMPLETE_BYTES = new Uint8Array(Buffer.concat([
  frame({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }),
  frame({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
  frame({ type: 'content_block_stop', index: 0 }),
  frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  frame({ type: 'message_stop' }),
].map(chunk => Buffer.from(chunk))))

/**
 * A transport that answers with the given bytes.
 * @param chunks - the raw body chunks to emit, in order.
 * @param status - the response status.
 * @param headers - response headers.
 * @returns the transport and a counter of the requests it saw.
 */
function transport(
  chunks: readonly Uint8Array[],
  status = 200,
  headers: Record<string, string> = { 'request-id': 'req-1' },
): { send: ClaudeEngineTransport; seen: ClaudeEngineRequest[] } {
  const seen: ClaudeEngineRequest[] = []
  const send: ClaudeEngineTransport = async (request) => {
    seen.push(request)
    return {
      kind: 'response',
      head: { status, headers },
      body: (async function* () { for (const chunk of chunks) yield chunk })(),
      ...headers['request-id'] === undefined ? {} : { requestId: headers['request-id'] },
    }
  }
  return { send, seen }
}

/**
 * Drain one turn.
 * @param input - the turn inputs, minus the request which is shared.
 * @returns every event the turn produced.
 */
async function drain(input: Omit<Parameters<typeof runClaudeEngineTurn>[0], 'request'>): Promise<ClaudeEngineEvent[]> {
  const events: ClaudeEngineEvent[] = []
  for await (const event of runClaudeEngineTurn({ request: REQUEST, ...input })) events.push(event)
  return events
}

/** The terminal event, which every turn ends with exactly once. */
function terminalOf(events: readonly ClaudeEngineEvent[]): Extract<ClaudeEngineEvent, { type: 'terminal' }> {
  const terminals = events.filter((event): event is Extract<ClaudeEngineEvent, { type: 'terminal' }> => event.type === 'terminal')
  assert.equal(terminals.length, 1, 'exactly one terminal event')
  return terminals[0]!
}

test('raw response bytes reach the caller unchanged, and message_stop ends the turn', async () => {
  // Split mid-frame and mid-UTF-8: the caller must still receive exactly what arrived.
  const first = COMPLETE_BYTES.subarray(0, 17)
  const second = COMPLETE_BYTES.subarray(17)
  const { send, seen } = transport([first, second])
  const usage: ClaudeEngineUsage[] = []
  const events = await drain({ transport: send, hooks: { beforeRequest: () => ({ ok: true }), onUsage: record => { usage.push(record) } } })

  const bytes = events.filter((event): event is Extract<ClaudeEngineEvent, { type: 'bytes' }> => event.type === 'bytes')
  assert.equal(bytes.length, 2, 'one event per received chunk')
  assert.deepEqual(bytes[0]?.bytes, first, 'the first chunk arrives byte-identical')
  assert.deepEqual(bytes[1]?.bytes, second, 'the second chunk arrives byte-identical')
  assert.equal(seen.length, 1, 'one POST')

  const terminal = terminalOf(events)
  assert.equal(terminal.outcome, 'complete')
  assert.deepEqual(terminal.state, { issued: true, responseReceived: true, terminalKnown: true })
  assert.equal(terminal.failure, undefined)
  assert.equal(usage.length, 1, 'usage is reported once')
  assert.equal(usage[0]?.inputTokens, 3)
  assert.equal(usage[0]?.outputTokens, 2)
  assert.equal(usage[0]?.requestId, 'req-1', 'the head request id is correlated, bounded and not a secret')
})

test('a body that ends without message_stop is incomplete and may not be replayed', async () => {
  const truncated = COMPLETE_BYTES.subarray(0, COMPLETE_BYTES.byteLength - 20)
  const { send } = transport([truncated])
  const events = await drain({ transport: send, hooks: { beforeRequest: () => ({ ok: true }) } })
  const terminal = terminalOf(events)
  assert.equal(terminal.outcome, 'incomplete')
  assert.equal(terminal.state.terminalKnown, false, 'a head is not a business terminal')
  assert.equal(terminal.failure?.kind, 'stream')
  assert.equal(terminal.failure?.kind === 'stream' ? terminal.failure.retryDisposition : undefined, 'forbid')
  assert.equal(terminal.state.issued, true, 'the request was issued, so its outcome is unknown')
})

test('an in-band refusal is typed, and a version refusal outranks everything else', async () => {
  const version = new Uint8Array(Buffer.concat([
    frame({ type: 'message_start', message: {} }),
    frame({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'update required',
        details: { error_code: 'claude_code_version_too_old' },
      },
    }),
  ].map(chunk => Buffer.from(chunk))))
  const { send } = transport([version])
  const events = await drain({ transport: send, hooks: { beforeRequest: () => ({ ok: true }) } })
  const terminal = terminalOf(events)
  assert.equal(terminal.outcome, 'failed')
  assert.equal(terminal.failure?.kind, 'stream')
  assert.equal(terminal.failure?.kind === 'stream' ? terminal.failure.reason : undefined, 'CLIENT_VERSION_UNSUPPORTED')
  assert.equal(terminal.failure?.kind === 'stream' ? terminal.failure.retryDisposition : undefined, 'forbid')
  assert.equal(terminal.failure?.kind === 'stream' ? terminal.failure.scope : undefined, 'provider-profile')
})

test('a refusal status never reaches the wire twice, and no secret reaches the terminal', async () => {
  const body = new TextEncoder().encode('{"error":{"type":"permission_error","message":"denied"}}')
  const { send, seen } = transport([body], 403, { 'request-id': 'req-2' })
  const events = await drain({ transport: send, hooks: { beforeRequest: () => ({ ok: true }) } })
  const terminal = terminalOf(events)
  assert.equal(terminal.outcome, 'failed')
  assert.equal(terminal.failure?.kind, 'http')
  assert.equal(terminal.failure?.kind === 'http' ? terminal.failure.reason : undefined, 'PERMISSION_DENIED')
  assert.equal(terminal.failure?.kind === 'http' ? terminal.failure.retryDisposition : undefined, 'forbid')
  assert.equal(seen.length, 1)
  const rendered = JSON.stringify(events)
  for (const secret of ['at-synthetic', 'denied', 'authorization']) {
    assert.ok(!rendered.includes(secret), `"${secret}" must not appear in the turn's events`)
  }
})

test('the caller may refuse a request before it is issued', async () => {
  const sent: ClaudeEngineRequest[] = []
  const send: ClaudeEngineTransport = async (request) => {
    sent.push(request)
    return { kind: 'failed', detail: 'unreachable', issued: false }
  }
  const events = await drain({
    transport: send,
    hooks: { beforeRequest: () => ({ ok: false, reason: 'policy: this session may not send' }) },
  })
  const terminal = terminalOf(events)
  assert.equal(terminal.outcome, 'failed')
  assert.equal(terminal.failure?.kind, 'refused-before-send')
  assert.deepEqual(sent, [], 'a refused request is never issued')
  assert.deepEqual(terminal.state, { issued: false, responseReceived: false, terminalKnown: false })
})

test('a 401 gets at most one caller-provided recovery, then the turn stops', async () => {
  const unauthorized = new TextEncoder().encode('{"error":"expired"}')
  const seen: ClaudeEngineRequest[] = []
  let attempts = 0
  const send: ClaudeEngineTransport = async (request) => {
    seen.push(request)
    attempts += 1
    return {
      kind: 'response',
      head: { status: 401, headers: {} },
      body: (async function* () { yield unauthorized })(),
    }
  }
  const events = await drain({
    transport: send,
    hooks: {
      beforeRequest: () => ({ ok: true }),
      recoverUnauthorized: () => ({ retry: 'once', accessToken: 'at-rotated' }),
    },
  })
  const terminal = terminalOf(events)
  assert.equal(attempts, 2, 'one original attempt and one recovered attempt')
  assert.equal(terminal.outcome, 'failed')
  assert.equal(terminal.failure?.kind, 'http')
  assert.equal(terminal.failure?.kind === 'http' ? terminal.failure.reason : undefined, 'AUTH')
  assert.equal(
    terminal.failure?.kind === 'http' ? terminal.failure.retryDisposition : undefined,
    'forbid',
    'the recovery budget is spent, so the rejection is final',
  )
  assert.match(seen[1]?.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? '', /^Bearer at-rotated$/)
})

test('a caller abort ends a held read without replaying the request', async () => {
  const controller = new AbortController()
  let reads = 0
  let released = 0
  let noteStarted: () => void = () => {}
  const sendStarted = new Promise<void>((resolve) => { noteStarted = resolve })
  const send: ClaudeEngineTransport = async (_request, signal) => {
    noteStarted()
    return {
      kind: 'response',
      head: { status: 200, headers: {} },
      // The transport owns the release of what it opened; the engine must call it on every path
      // that abandons a response, including a consumer that walks away.
      release: async () => { released += 1 },
      body: (async function* () {
        // The body never produces a frame; only the caller's abort ends this read.
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        reads += 1
        throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
      })(),
    }
  }
  const events: ClaudeEngineEvent[] = []
  const pending = (async () => {
    for await (const event of runClaudeEngineTurn({
      request: REQUEST,
      transport: send,
      hooks: { beforeRequest: () => ({ ok: true }) },
      signal: controller.signal,
    })) events.push(event)
  })()
  // The request must be on the wire before the caller stops, which is the case this covers.
  await sendStarted
  controller.abort(new Error('caller stopped'))
  await pending
  // The held read is released asynchronously; one turn of the event loop settles it.
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  const terminal = terminalOf(events)
  assert.equal(terminal.outcome, 'cancelled', 'the caller stopping the read is its own outcome')
  assert.equal(terminal.failure?.kind, 'cancelled')
  assert.equal(terminal.state.terminalKnown, false)
  assert.equal(released, 1, 'the response the turn abandoned was released')
  assert.equal(reads, 1, 'the held read was released by the caller cancellation')
})

test('a caller abort while the pre-request hook is pending sends nothing', async () => {
  const controller = new AbortController()
  let sent = 0
  const events: ClaudeEngineEvent[] = []
  const pending = (async () => {
    for await (const event of runClaudeEngineTurn({
      request: REQUEST,
      transport: async () => {
        sent += 1
        return { kind: 'failed', detail: 'never reached', issued: true }
      },
      hooks: {
        beforeRequest: async () => {
          // The caller stops while the gate is still deciding.
          controller.abort(new Error('caller stopped'))
          return { ok: true }
        },
      },
      signal: controller.signal,
    })) events.push(event)
  })()
  await pending
  const terminal = terminalOf(events)
  assert.equal(terminal.outcome, 'cancelled')
  assert.equal(sent, 0, 'a request aborted during the pre-request gate is never issued')
  assert.deepEqual(terminal.state, { issued: false, responseReceived: false, terminalKnown: false })
})

test('exactly one head reaches the caller, and a rejected attempt contributes none', async () => {
  const accepted = transport([COMPLETE_BYTES])
  const okEvents = await drain({ transport: accepted.send, hooks: { beforeRequest: () => ({ ok: true }) } })
  assert.equal(okEvents.filter(event => event.type === 'head').length, 1, 'one head for the response that was read')

  // A 401 the caller recovers from must not surface its own head: the caller sees only the final
  // exchange, and the rejected response is released instead.
  const unauthorizedBody = new TextEncoder().encode('{"error":"expired"}')
  let released = 0
  let attempts = 0
  const recovering: ClaudeEngineTransport = async () => {
    attempts += 1
    return {
      kind: 'response',
      head: { status: 401, headers: {} },
      release: async () => { released += 1 },
      body: (async function* () { yield unauthorizedBody })(),
    }
  }
  const rejected = await drain({
    transport: recovering,
    hooks: { beforeRequest: () => ({ ok: true }), recoverUnauthorized: () => ({ retry: 'once', accessToken: 'at-2' }) },
  })
  assert.equal(rejected.filter(event => event.type === 'head').length, 0, 'a rejected attempt contributes no head')
  assert.equal(attempts, 2, 'the recovery ran once')
  assert.equal(released, 2, 'every response this turn held was released')
})

test('a 401 that names the version refusal gets no recovery at all', async () => {
  const versionBody = new TextEncoder().encode(JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'update required',
      details: { error_code: 'claude_code_version_too_old' },
    },
  }))
  let recoveries = 0
  const { send, seen } = transport([versionBody], 401, {})
  const events = await drain({
    transport: send,
    hooks: {
      beforeRequest: () => ({ ok: true }),
      recoverUnauthorized: () => {
        recoveries += 1
        return { retry: 'once', accessToken: 'at-2' }
      },
    },
  })
  const terminal = terminalOf(events)
  assert.equal(recoveries, 0, 'a structured refusal outranks the authentication replay')
  assert.equal(seen.length, 1, 'no second POST')
  assert.equal(terminal.failure?.kind, 'http')
  assert.equal(terminal.failure?.kind === 'http' ? terminal.failure.reason : undefined, 'CLIENT_VERSION_UNSUPPORTED')
  assert.equal(terminal.failure?.kind === 'http' ? terminal.failure.retryDisposition : undefined, 'forbid')
})

test('a consumer that stops reading early releases the response it abandoned', async () => {
  const { send, seen } = transport([COMPLETE_BYTES, COMPLETE_BYTES])
  let released = 0
  const tracking: ClaudeEngineTransport = async (request, signal) => {
    const result = await send(request, signal)
    return result.kind === 'response' ? { ...result, release: async () => { released += 1 } } : result
  }
  for await (const event of runClaudeEngineTurn({
    request: REQUEST,
    transport: tracking,
    hooks: { beforeRequest: () => ({ ok: true }) },
  })) {
    // Walk away as soon as the first bytes arrive.
    if (event.type === 'bytes') break
  }
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  assert.equal(seen.length, 1, 'one POST, and no replay for a consumer that stopped')
  assert.equal(released, 1, 'the abandoned response was released')
})

test('a chunk carrying a rejected terminal is withheld, so no caller sees a false success', async () => {
  // A legal prefix, then one chunk that states a terminal this engine rejects: the stop reason is
  // one it cannot present, and a block is still open.
  const prefix = frame({ type: 'message_start', message: { usage: { input_tokens: 1 } } })
  const badChunk = new Uint8Array(Buffer.concat([
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    frame({ type: 'content_block_stop', index: 0 }),
    frame({ type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 1 } }),
    frame({ type: 'message_stop' }),
  ].map(chunk => Buffer.from(chunk))))
  const { send } = transport([prefix, badChunk])
  const events = await drain({ transport: send, hooks: { beforeRequest: () => ({ ok: true }) } })

  const delivered = Buffer.concat(
    events.filter((event): event is Extract<ClaudeEngineEvent, { type: 'bytes' }> => event.type === 'bytes')
      .map(event => Buffer.from(event.bytes)),
  ).toString('utf8')
  assert.ok(delivered.includes('message_start'), 'the legal prefix was already delivered')
  assert.ok(!delivered.includes('message_stop'), 'the rejected terminal never reached the caller')
  assert.ok(!delivered.includes('pause_turn'), 'the rejected chunk was withheld whole')
  const terminal = terminalOf(events)
  assert.equal(terminal.outcome, 'failed')
  assert.equal(terminal.state.terminalKnown, true, 'the service stated an outcome, even a rejected one')
  assert.equal(terminal.failure?.kind === 'stream' ? terminal.failure.reason : undefined, 'UNSUPPORTED_RESPONSE')
  assert.equal(terminal.failure?.kind === 'stream' ? terminal.failure.retryDisposition : undefined, 'forbid')
})

test('a valid terminal chunk is delivered byte-identical, and a split frame is withheld until complete', async () => {
  // The last frame is split across two chunks: nothing may be delivered until the frame the caller
  // would act on is complete and accepted.
  const splitAt = COMPLETE_BYTES.byteLength - 12
  const { send } = transport([COMPLETE_BYTES.subarray(0, splitAt), COMPLETE_BYTES.subarray(splitAt)])
  const events = await drain({ transport: send, hooks: { beforeRequest: () => ({ ok: true }) } })
  const bytes = events.filter((event): event is Extract<ClaudeEngineEvent, { type: 'bytes' }> => event.type === 'bytes')
  assert.equal(bytes.length, 2)
  assert.deepEqual(bytes[0]?.bytes, COMPLETE_BYTES.subarray(0, splitAt), 'the first chunk is byte-identical')
  assert.deepEqual(bytes[1]?.bytes, COMPLETE_BYTES.subarray(splitAt), 'the completing chunk is byte-identical')
  assert.equal(
    Buffer.concat(bytes.map(event => Buffer.from(event.bytes))).toString('utf8'),
    Buffer.from(COMPLETE_BYTES).toString('utf8'),
    'a valid turn is delivered exactly as it arrived',
  )
  assert.equal(terminalOf(events).outcome, 'complete')
})

test('an oversized frame is withheld and reported with a fixed safe reason', async () => {
  const oversized = new TextEncoder().encode('data: ' + 'x'.repeat(SSE_FRAME_LIMIT_BYTES + 1) + '\n\n')
  const { send } = transport([oversized])
  const events = await drain({ transport: send, hooks: { beforeRequest: () => ({ ok: true }) } })
  const bytes = events.filter(event => event.type === 'bytes')
  assert.equal(bytes.length, 0, 'no part of an oversized frame reaches the caller')
  const terminal = terminalOf(events)
  assert.equal(terminal.outcome, 'failed')
  assert.equal(terminal.failure?.kind === 'stream' ? terminal.failure.reason : undefined, 'MALFORMED_RESPONSE')
  assert.equal(terminal.failure?.kind === 'stream' ? terminal.failure.retryDisposition : undefined, 'forbid')
  // The diagnostic names the condition, never a fragment of the oversized payload.
  assert.ok(!JSON.stringify(events).includes('xxxxx'), 'the fixed reason carries no payload')
})

test('the framer refuses an unbounded frame instead of buffering it', () => {
  const framer = createSseFramer()
  // A data line past the frame cap is reported as overflow, and the framer stops dispatching.
  const oversized = 'data: ' + 'x'.repeat(SSE_FRAME_LIMIT_BYTES + 1) + '\n\n'
  const result = framer.push(oversized)
  assert.equal(result.overflowed, true)
  assert.deepEqual(result.events, [])
  // And a framer that overflowed stays closed rather than resuming on the next chunk.
  assert.equal(framer.push('data: {"type":"message_stop"}\n\n').overflowed, true)
})

test('a bounded refusal read to its end is a known failure, and the barrel exposes the engine', async () => {
  const body = new TextEncoder().encode('{"error":{"type":"permission_error","message":"denied"}}')
  const { send } = transport([body], 403, {})
  const events = await drain({ transport: send, hooks: { beforeRequest: () => ({ ok: true }) } })
  const terminal = terminalOf(events)
  // The refusal is read to its end, so its outcome is decided: known, still failed, still not a
  // candidate for automatic replay. A caller's ledger must not record an open unknown here.
  assert.equal(terminal.outcome, 'failed')
  assert.equal(terminal.state.responseReceived, true)
  assert.equal(terminal.state.terminalKnown, true)
  assert.equal(terminal.failure?.kind === 'http' ? terminal.failure.retryDisposition : undefined, 'forbid')

  // The same refusal whose body never finishes is not a known outcome.
  const stalled = new AbortController()
  const stalledSend: ClaudeEngineTransport = async () => ({
    kind: 'response',
    head: { status: 400, headers: {} },
    body: (async function* () {
      yield new TextEncoder().encode('{"error":')
      throw new Error('connection reset')
    })(),
  })
  const unknown = await drain({ transport: stalledSend, hooks: { beforeRequest: () => ({ ok: true }) }, signal: stalled.signal })
  const unknownTerminal = terminalOf(unknown)
  assert.equal(unknownTerminal.outcome, 'failed')
  assert.equal(unknownTerminal.state.terminalKnown, false, 'a partly read refusal stays unknown')
})

test('the barrel is importable on its own and re-exports the engine unchanged', async () => {
  const barrel = await import('../src/claude-engine/index.js')
  assert.equal(typeof barrel.buildClaudeEngineRequest, 'function')
  assert.equal(typeof barrel.validateAnthropicBody, 'function')
  assert.equal(typeof barrel.runClaudeEngineTurn, 'function')
  assert.equal(typeof barrel.createSseFramer, 'function')
  assert.equal(typeof barrel.matchesClaudeVersionRejection, 'function')

  // The barrel's turn function is the implementation itself, not a copy.
  const barrelEvents: ClaudeEngineEvent[] = []
  const { send } = transport([COMPLETE_BYTES])
  for await (const event of barrel.runClaudeEngineTurn({
    request: REQUEST,
    transport: send,
    hooks: { beforeRequest: () => ({ ok: true }) },
  })) barrelEvents.push(event)
  assert.equal(terminalOf(barrelEvents).outcome, 'complete')
  assert.equal(barrel.runClaudeEngineTurn, runClaudeEngineTurn)
})

test('a send that never left the process is a transport failure, not an unknown outcome', async () => {
  const send: ClaudeEngineTransport = async () => ({ kind: 'failed', detail: 'connection refused', issued: false })
  const events = await drain({ transport: send, hooks: { beforeRequest: () => ({ ok: true }) } })
  const terminal = terminalOf(events)
  assert.equal(terminal.failure?.kind, 'transport')
  assert.equal(terminal.failure?.kind === 'transport' ? terminal.failure.retryDisposition : undefined, 'allow')
  assert.deepEqual(terminal.state, { issued: false, responseReceived: false, terminalKnown: false })
})

test('a send that may have left the process is ambiguous and forbids a replay', async () => {
  const send: ClaudeEngineTransport = async () => ({ kind: 'failed', detail: 'socket closed', issued: true })
  const events = await drain({ transport: send, hooks: { beforeRequest: () => ({ ok: true }) } })
  const terminal = terminalOf(events)
  assert.equal(terminal.failure?.kind, 'ambiguous-send')
  assert.equal(terminal.state.issued, true)
  assert.equal(terminal.state.responseReceived, false)
  assert.equal(terminal.state.terminalKnown, false)
})
