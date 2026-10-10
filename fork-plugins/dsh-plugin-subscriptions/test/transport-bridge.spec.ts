import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BunBridge, BridgeError, type BridgeDuplex } from '../src/transport/bridge.js'
import { FrameDecoder, encodeBody, encodeControl, type Frame } from '../src/transport/frames.js'

/** A duplex that answers in-process, so the framing and failure paths need no child. */
function memoryDuplex(reply?: (frames: readonly Frame[], send: (bytes: Uint8Array) => void) => void): {
  duplex: BridgeDuplex
  sent: Uint8Array[]
  exit: (reason: string) => void
  killed: () => boolean
} {
  const sent: Uint8Array[] = []
  const decoder = new FrameDecoder()
  let dataHandler: ((bytes: Uint8Array) => void) | undefined
  let exitHandler: ((reason: string) => void) | undefined
  let killed = false
  const send = (bytes: Uint8Array): void => {
    dataHandler?.(bytes)
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
