import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { BunBridge, BridgeError, type BridgeDuplex } from '../src/transport/bridge.js'
import { FrameDecoder, encodeBody, encodeControl, type Frame } from '../src/transport/frames.js'
import { streamAnthropic } from '../src/translate/anthropic.js'

/** The request the bridge exists to carry. */
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages?beta=true'

/** A duplex that answers in-process, so the framing and failure paths need no child. */
function memoryDuplex(reply?: (frames: readonly Frame[], send: (bytes: Uint8Array) => void) => void): {
  duplex: BridgeDuplex
  sent: Uint8Array[]
  send: (bytes: Uint8Array) => void
  handlerFailures: unknown[]
  exit: (reason: string) => void
  killed: () => boolean
} {
  const sent: Uint8Array[] = []
  const decoder = new FrameDecoder()
  let dataHandler: ((bytes: Uint8Array) => void) | undefined
  let exitHandler: ((reason: string) => void) | undefined
  let killed = false
  // A frame handler that throws would be an uncaught exception in the host when this is
  // the child's stdout pipe, so the double records the throw for the test to assert on.
  const handlerFailures: unknown[] = []
  const send = (bytes: Uint8Array): void => {
    try {
      dataHandler?.(bytes)
    } catch (error) {
      handlerFailures.push(error)
    }
  }
  const duplex: BridgeDuplex = {
    write(bytes) {
      sent.push(bytes)
      if (reply !== undefined) reply(decoder.push(bytes), send)
    },
    onData(handler) {
      dataHandler = handler
    },
    onExit(handler) {
      exitHandler = handler
    },
    kill() {
      killed = true
    },
  }
  return {
    duplex,
    sent,
    send,
    handlerFailures,
    exit: (reason) => exitHandler?.(reason),
    killed: () => killed,
  }
}

/** Reassembles what the client framed, so a test can assert the request it sent. */
function decodeSent(sent: readonly Uint8Array[]): readonly Frame[] {
  const decoder = new FrameDecoder()
  const frames: Frame[] = []
  for (const chunk of sent) frames.push(...decoder.push(chunk))
  return frames
}

/** The control messages the client sent, in order. */
function sentMessages(sent: readonly Uint8Array[]): readonly Record<string, unknown>[] {
  return decodeSent(sent).flatMap((frame) => (frame.tag === 1 ? [frame.message] : []))
}

/** The cancel frames the client sent, in order. */
function cancelsSent(sent: readonly Uint8Array[]): readonly Record<string, unknown>[] {
  return sentMessages(sent).filter((message) => message['type'] === 'cancel')
}

/**
 * Answers every request frame the duplex receives.
 * @param answer - what the child does for one request.
 * @returns the reply callback a memory duplex takes.
 */
function onRequest(
  answer: (streamId: string, index: number, send: (bytes: Uint8Array) => void) => void,
): (frames: readonly Frame[], send: (bytes: Uint8Array) => void) => void {
  return (frames, send) => {
    for (const frame of frames) {
      if (frame.tag !== 1 || frame.message['type'] !== 'request') continue
      const index = typeof frame.message['index'] === 'number' ? frame.message['index'] : 0
      answer(String(frame.message['streamId']), index, send)
    }
  }
}

/** The stream identity the client assigned to its first request. */
function firstRequest(sent: readonly Uint8Array[]): { streamId: string; index: number } {
  const frame = decodeSent(sent).find(
    (candidate) => candidate.tag === 1 && candidate.message['type'] === 'request',
  )
  assert.ok(frame !== undefined && frame.tag === 1, 'the client wrote a request control frame')
  return {
    streamId: String(frame.message['streamId']),
    index: typeof frame.message['index'] === 'number' ? frame.message['index'] : 0,
  }
}

/** Sends one response head, as the child does once the upstream has answered. */
function replyHead(streamId: string, send: (bytes: Uint8Array) => void): void {
  send(encodeControl({ streamId, type: 'response', status: 200, headers: [['content-type', 'text/event-stream']] }))
}

test('a request is framed and its response streams back', async () => {
  const harness = memoryDuplex((frames, send) => {
    for (const frame of frames) {
      if (frame.tag !== 1 || frame.message['type'] !== 'request') continue
      const streamId = String(frame.message['streamId'])
      send(encodeControl({ streamId, type: 'response', status: 200, headers: [['content-type', 'text/event-stream']] }))
      send(encodeBody(0, new TextEncoder().encode('data: one\n\n')))
      send(encodeBody(0, new TextEncoder().encode('data: two\n\n')))
      send(encodeControl({ streamId, type: 'end' }))
    }
  })
  const bridge = new BunBridge(harness.duplex)
  const response = await bridge.request('https://api.anthropic.com/v1/messages?beta=true', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app': 'cli' },
    body: new TextEncoder().encode('{"model":"x"}'),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const text = await new Response(response.body).text()
  assert.equal(text, 'data: one\n\ndata: two\n\n')

  const sent = decodeSent(harness.sent)
  const request = sent.find((frame) => frame.tag === 1 && frame.message['type'] === 'request')
  assert.ok(request !== undefined && request.tag === 1)
  if (request.tag !== 1) return
  assert.equal(request.message['url'], 'https://api.anthropic.com/v1/messages?beta=true')
  assert.equal(request.message['method'], 'POST')
  assert.equal(request.message['body'], true)
  assert.deepEqual(request.message['headers'], [
    ['content-type', 'application/json'],
    ['x-app', 'cli'],
  ])
  const body = sent.find((frame) => frame.tag === 2)
  assert.ok(body !== undefined && body.tag === 2)
  assert.equal(new TextDecoder().decode(body.tag === 2 ? body.bytes : new Uint8Array()), '{"model":"x"}')
})

test("the caller's field names cross the bridge with their own casing", async () => {
  // The genuine request is identified partly by the casing of its field names,
  // so the transport carries the caller's spelling rather than a folded one.
  const harness = memoryDuplex()
  const bridge = new BunBridge(harness.duplex)
  const pending = bridge.request('https://api.anthropic.com/v1/messages?beta=true', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer token',
      'User-Agent': 'claude-cli/2.1.288 (external, claude-desktop)',
      'X-Claude-Code-Session-Id': '00000000-0000-4000-8000-000000000001',
      'X-Stainless-Lang': 'js',
      'x-app': 'cli',
    },
  })
  const request = decodeSent(harness.sent).find(
    (frame) => frame.tag === 1 && frame.message['type'] === 'request',
  )
  assert.ok(request !== undefined && request.tag === 1)
  if (request.tag !== 1) return
  assert.deepEqual(request.message['headers'], [
    ['Accept', 'application/json'],
    ['Authorization', 'Bearer token'],
    ['User-Agent', 'claude-cli/2.1.288 (external, claude-desktop)'],
    ['X-Claude-Code-Session-Id', '00000000-0000-4000-8000-000000000001'],
    ['X-Stainless-Lang', 'js'],
    ['x-app', 'cli'],
  ])
  // The duplex never answers, so the request is settled by teardown.
  bridge.dispose()
  await assert.rejects(pending, (error: unknown) => error instanceof BridgeError)
})

test('a child that dies rejects in flight work and refuses later work', async () => {
  const harness = memoryDuplex()
  const bridge = new BunBridge(harness.duplex)
  const inFlight = bridge.request('https://api.anthropic.com/v1/messages', { method: 'POST' })
  harness.exit('exit 1 signal null')
  await assert.rejects(inFlight, (error: unknown) => error instanceof BridgeError && error.reason === 'child-exited')
  assert.equal(bridge.dead, true, 'the bridge reports itself dead rather than silently reusing a broken child')
  await assert.rejects(
    bridge.request('https://api.anthropic.com/v1/messages', { method: 'POST' }),
    (error: unknown) => error instanceof BridgeError && error.reason === 'child-exited',
  )
})

test('a remote error surfaces on the request that caused it', async () => {
  const harness = memoryDuplex((frames, send) => {
    for (const frame of frames) {
      if (frame.tag !== 1 || frame.message['type'] !== 'request') continue
      send(encodeControl({ streamId: String(frame.message['streamId']), type: 'error', message: 'ENOTFOUND: getaddrinfo' }))
    }
  })
  const bridge = new BunBridge(harness.duplex)
  await assert.rejects(
    bridge.request('https://api.anthropic.com/v1/messages', { method: 'POST' }),
    (error: unknown) => error instanceof BridgeError && error.reason === 'remote-error',
  )
})

test('dispose kills the child and rejects what was in flight', async () => {
  const harness = memoryDuplex()
  const bridge = new BunBridge(harness.duplex)
  const inFlight = bridge.request('https://api.anthropic.com/v1/messages', { method: 'POST' })
  bridge.dispose()
  await assert.rejects(inFlight, (error: unknown) => error instanceof BridgeError)
  assert.equal(harness.killed(), true)
})

test('cancelling the response body releases the stream once and ignores what arrives late', async () => {
  const harness = memoryDuplex(onRequest((streamId, _index, send) => {
    replyHead(streamId, send)
  }))
  const bridge = new BunBridge(harness.duplex)
  const response = await bridge.request(MESSAGES_URL, { method: 'POST' })
  const body = response.body
  assert.ok(body !== null)
  await body.getReader().cancel()
  assert.equal(cancelsSent(harness.sent).length, 1, 'the abandoned stream is released exactly once')

  // Frames for a stream the consumer already abandoned reach the data callback after
  // its ownership is gone, so they must be dropped rather than throw out of the pipe.
  const { streamId, index } = firstRequest(harness.sent)
  harness.send(encodeControl({ streamId, type: 'end' }))
  harness.send(encodeControl({ streamId, type: 'error', message: 'late failure' }))
  harness.send(encodeBody(index, new TextEncoder().encode('late')))
  assert.equal(cancelsSent(harness.sent).length, 1, 'late frames write no second cancel')
  assert.deepEqual(harness.handlerFailures, [], 'late frames never throw out of the frame handler')
})

test('cancelling one response body leaves another in flight stream intact', async () => {
  const harness = memoryDuplex(onRequest((streamId, index, send) => {
    replyHead(streamId, send)
    send(encodeBody(index, new TextEncoder().encode(`data: ${String(index)}\n\n`)))
    if (index === 1) send(encodeControl({ streamId, type: 'end' }))
  }))
  const bridge = new BunBridge(harness.duplex)
  const first = await bridge.request(MESSAGES_URL, { method: 'POST' })
  const second = await bridge.request(MESSAGES_URL, { method: 'POST' })
  const firstBody = first.body
  const secondBody = second.body
  assert.ok(firstBody !== null && secondBody !== null)

  await firstBody.getReader().cancel()
  assert.equal(cancelsSent(harness.sent).length, 1, 'only the abandoned stream is released')
  assert.equal(await new Response(secondBody).text(), 'data: 1\n\n')
})

test('aborting before the response head fails the caller and releases the stream once', async () => {
  const harness = memoryDuplex()
  const bridge = new BunBridge(harness.duplex)
  const controller = new AbortController()
  const pending = bridge.request(MESSAGES_URL, { method: 'POST', signal: controller.signal })
  assert.equal(cancelsSent(harness.sent).length, 0, 'a live request is not cancelled')
  controller.abort()
  await assert.rejects(pending, (error: unknown) => error instanceof BridgeError && error.reason === 'cancelled')
  assert.equal(cancelsSent(harness.sent).length, 1)
})

test('aborting after the response head errors the body without a second cancel', async () => {
  const harness = memoryDuplex(onRequest((streamId, _index, send) => {
    replyHead(streamId, send)
  }))
  const bridge = new BunBridge(harness.duplex)
  const controller = new AbortController()
  const response = await bridge.request(MESSAGES_URL, { method: 'POST', signal: controller.signal })
  const body = response.body
  assert.ok(body !== null)
  const reader = body.getReader()
  controller.abort()
  await assert.rejects(
    reader.read(),
    (error: unknown) => error instanceof BridgeError && error.reason === 'cancelled',
  )
  await assert.rejects(
    reader.cancel(),
    (error: unknown) => error instanceof BridgeError && error.reason === 'cancelled',
  )
  assert.equal(cancelsSent(harness.sent).length, 1, 'the abort and the failed body cancel share one release')
})

test('a request whose signal is already aborted never reaches the child', async () => {
  const harness = memoryDuplex()
  const bridge = new BunBridge(harness.duplex)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    bridge.request(MESSAGES_URL, { method: 'POST', signal: controller.signal }),
    (error: unknown) => error instanceof BridgeError && error.reason === 'cancelled',
  )
  assert.deepEqual(harness.sent, [], 'nothing is framed for a request that was already abandoned')
})

test('a duplex that answers inside the write leaves no abort listener on the caller signal', async () => {
  const harness = memoryDuplex(onRequest((streamId, _index, send) => {
    replyHead(streamId, send)
    send(encodeControl({ streamId, type: 'end' }))
  }))
  const bridge = new BunBridge(harness.duplex)
  const controller = new AbortController()
  const response = await bridge.request(MESSAGES_URL, { method: 'POST', signal: controller.signal })
  const body = response.body
  assert.ok(body !== null)
  assert.equal(await new Response(body).text(), '')
  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    0,
    'a request settled during its own write released the abort listener',
  )
  controller.abort()
  assert.equal(cancelsSent(harness.sent).length, 0, 'a completed request is not cancelled')
})

test('a failed write settles the request and leaves no ownership behind', async () => {
  const sent: Uint8Array[] = []
  let dataHandler: ((bytes: Uint8Array) => void) | undefined
  let failed = false
  const duplex: BridgeDuplex = {
    write(bytes) {
      sent.push(bytes)
      if (!failed) {
        failed = true
        throw new Error('child stdin closed')
      }
    },
    onData(handler) {
      dataHandler = handler
    },
    onExit() {},
    kill() {},
  }
  const bridge = new BunBridge(duplex)
  const controller = new AbortController()
  await assert.rejects(
    bridge.request(MESSAGES_URL, { method: 'POST', signal: controller.signal }),
    (error: unknown) => error instanceof BridgeError && error.reason === 'child-error',
  )
  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    0,
    'the failed request released its abort listener',
  )
  assert.equal(bridge.dead, false, 'a write failure is not a dead child')
  const before = sent.length
  controller.abort()
  assert.equal(sent.length, before, 'an abort after the failure writes nothing')
  // The failed stream's ownership is gone, so its late frames are dropped.
  const { streamId } = firstRequest(sent)
  dataHandler?.(encodeControl({ streamId, type: 'end' }))
  assert.equal(sent.length, before)
})

test('a response that ends by itself is never cancelled', async () => {
  const harness = memoryDuplex(onRequest((streamId, index, send) => {
    replyHead(streamId, send)
    send(encodeBody(index, new TextEncoder().encode('data: one\n\n')))
    send(encodeControl({ streamId, type: 'end' }))
  }))
  const bridge = new BunBridge(harness.duplex)
  const response = await bridge.request(MESSAGES_URL, { method: 'POST' })
  const body = response.body
  assert.ok(body !== null)
  assert.equal(await new Response(body).text(), 'data: one\n\n')
  assert.equal(cancelsSent(harness.sent).length, 0, 'EOF is not an abandonment')
})

test('the Anthropic translator stopping at message_stop releases the bridged upstream body once', async () => {
  // message_stop is the wire's terminal event, but the child keeps the upstream
  // response open until its own end frame; the translator returning at the terminal
  // event is what abandons that still-open request.
  const body = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('')
  const harness = memoryDuplex(onRequest((streamId, index, send) => {
    replyHead(streamId, send)
    send(encodeBody(index, new TextEncoder().encode(body)))
    // No end frame: the upstream response is still open when message_stop arrives.
  }))
  const bridge = new BunBridge(harness.duplex)
  const response = await bridge.request(MESSAGES_URL, { method: 'POST' })
  const stream = response.body
  assert.ok(stream !== null)
  const chunks: StreamChunk[] = []
  for await (const chunk of streamAnthropic(stream)) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.equal(cancelsSent(harness.sent).length, 1, 'the abandoned upstream request is released exactly once')
})

test('a duplex that answers the cancel frame synchronously releases once and leaves other streams alive', async () => {
  const harness = memoryDuplex((frames, send) => {
    for (const frame of frames) {
      if (frame.tag !== 1) continue
      const streamId = String(frame.message['streamId'])
      if (frame.message['type'] === 'request') {
        const index = typeof frame.message['index'] === 'number' ? frame.message['index'] : 0
        replyHead(streamId, send)
        send(encodeBody(index, new TextEncoder().encode(`data: ${String(index)}\n\n`)))
        if (index === 1) send(encodeControl({ streamId, type: 'end' }))
        continue
      }
      if (frame.message['type'] === 'cancel') {
        // The child may answer the cancellation it was just handed, in the same turn.
        send(encodeControl({ streamId, type: 'end' }))
        send(encodeControl({ streamId, type: 'error', message: 'already released' }))
      }
    }
  })
  const bridge = new BunBridge(harness.duplex)
  const first = await bridge.request(MESSAGES_URL, { method: 'POST' })
  const second = await bridge.request(MESSAGES_URL, { method: 'POST' })
  const firstBody = first.body
  const secondBody = second.body
  assert.ok(firstBody !== null && secondBody !== null)

  await firstBody.getReader().cancel()
  assert.equal(cancelsSent(harness.sent).length, 1, 'the release is written exactly once')
  assert.deepEqual(
    harness.handlerFailures,
    [],
    'the answer to the cancel frame never reaches the released body or throws out of the frame handler',
  )
  assert.equal(await new Response(secondBody).text(), 'data: 1\n\n')

  // The released stream stays released: frames arriving after the answer are dropped.
  const { streamId } = firstRequest(harness.sent)
  harness.send(encodeControl({ streamId, type: 'end' }))
  harness.send(encodeControl({ streamId, type: 'error', message: 'late' }))
  assert.equal(cancelsSent(harness.sent).length, 1)
  assert.deepEqual(harness.handlerFailures, [])
})

test('an abort whose cancel frame is answered synchronously still reports the cancellation', async () => {
  const harness = memoryDuplex((frames, send) => {
    for (const frame of frames) {
      if (frame.tag !== 1) continue
      const streamId = String(frame.message['streamId'])
      if (frame.message['type'] === 'request') replyHead(streamId, send)
      else if (frame.message['type'] === 'cancel') send(encodeControl({ streamId, type: 'end' }))
    }
  })
  const bridge = new BunBridge(harness.duplex)
  const controller = new AbortController()
  const response = await bridge.request(MESSAGES_URL, { method: 'POST', signal: controller.signal })
  const body = response.body
  assert.ok(body !== null)
  const reader = body.getReader()
  controller.abort()
  // The answer to the cancel frame belongs to a stream the abort already released, so
  // it cannot complete the body as if the request had finished.
  await assert.rejects(
    reader.read(),
    (error: unknown) => error instanceof BridgeError && error.reason === 'cancelled',
  )
  assert.equal(cancelsSent(harness.sent).length, 1)
})

test('a write that fails after a synchronously delivered frame settles the caller once', async (t) => {
  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => {
    rejections.push(reason)
  }
  process.on('unhandledRejection', onRejection)
  t.after(() => {
    process.off('unhandledRejection', onRejection)
  })

  const decoder = new FrameDecoder()
  let dataHandler: ((bytes: Uint8Array) => void) | undefined
  let failed = false
  const duplex: BridgeDuplex = {
    write(bytes) {
      for (const frame of decoder.push(bytes)) {
        if (frame.tag !== 1 || frame.message['type'] !== 'request') continue
        dataHandler?.(
          encodeControl({
            streamId: String(frame.message['streamId']),
            type: 'error',
            message: 'ENOTFOUND: getaddrinfo',
          }),
        )
      }
      if (!failed) {
        failed = true
        throw new Error('child stdin closed')
      }
    },
    onData(handler) {
      dataHandler = handler
    },
    onExit() {},
    kill() {},
  }
  const bridge = new BunBridge(duplex)
  await assert.rejects(
    bridge.request(MESSAGES_URL, { method: 'POST' }),
    (error: unknown) => error instanceof BridgeError && error.reason === 'remote-error',
  )
  // One turn for a rejection the caller never adopted to surface.
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
  assert.deepEqual(rejections, [], 'the frame delivered inside the failing write is not left unhandled')
})

test('a write that fails after a response head was delivered errors the body it opened', async () => {
  const decoder = new FrameDecoder()
  let dataHandler: ((bytes: Uint8Array) => void) | undefined
  let writes = 0
  const send = (bytes: Uint8Array): void => {
    dataHandler?.(bytes)
  }
  const duplex: BridgeDuplex = {
    write(bytes) {
      writes += 1
      for (const frame of decoder.push(bytes)) {
        if (frame.tag !== 1 || frame.message['type'] !== 'request') continue
        replyHead(String(frame.message['streamId']), send)
      }
      if (writes === 2) throw new Error('child stdin closed')
    },
    onData(handler) {
      dataHandler = handler
    },
    onExit() {},
    kill() {},
  }
  const bridge = new BunBridge(duplex)
  const response = await bridge.request(MESSAGES_URL, { method: 'POST', body: 'hello' })
  const body = response.body
  assert.ok(body !== null)
  await assert.rejects(
    new Response(body).text(),
    (error: unknown) => error instanceof BridgeError && error.reason === 'child-error',
  )
  assert.equal(bridge.dead, false, 'a write failure is not a dead child')
})
