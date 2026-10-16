/**
 * Unread-backlog accounting for a bridged response body.
 *
 * The cap exists to fail a stream whose consumer stopped reading, so it must measure
 * what is actually unread: bytes the consumer took, and bytes a pending read already
 * claimed, are not backlog. Every case drives the real `BunBridge` over an in-process
 * duplex and a real `ReadableStream`, with 1 MiB chunks so a case that must exceed the
 * 32 MiB default stays inside a bounded footprint.
 */

import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import { BunBridge, BridgeError, DEFAULT_MAX_QUEUED_BYTES, type BridgeDuplex } from '../src/transport/bridge.js'
import { FrameDecoder, encodeBody, encodeControl } from '../src/transport/frames.js'

/** The request the bridge exists to carry. */
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages?beta=true'

const MIB = 1024 * 1024

/** One stream's fallback cap, matching the default in the bridge. */
const CAP_BYTES = 32 * MIB

/**
 * One 1 MiB payload shared by every frame these fixtures send.
 *
 * Its bytes are a position pattern, so a case can check that a delivered chunk is the
 * shared payload rather than leftover state.
 */
const CHUNK = ((): Uint8Array => {
  const bytes = new Uint8Array(MIB)
  for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = index & 0xff
  return bytes
})()

/** One request the duplex answered, in the order it arrived. */
interface OpenedRequest {
  readonly streamId: string
  readonly index: number
}

/** The duplex, plus the child-side moves a backlog case needs. */
interface BacklogHarness {
  readonly duplex: BridgeDuplex
  /** Requests the bridge wrote, in order. */
  readonly requests: OpenedRequest[]
  /** Throws that escaped the data handler; empty means the pipe stayed safe. */
  readonly handlerFailures: unknown[]
  /** Opens one request and resolves once the duplex answered its head. */
  open(bridge: BunBridge, init?: RequestInit): Promise<Response>
  /** Delivers one already-framed payload the way the child's stdout would. */
  send(bytes: Uint8Array): void
  /** Delivers one body frame for a stream, defaulting to the shared 1 MiB chunk. */
  sendChunk(index: number, bytes?: Uint8Array): void
  /** Delivers the end frame that closes a stream. */
  sendEnd(streamId: string): void
  /** How many cancel frames the bridge wrote. */
  cancels(): number
}

/** How a backlog case wants the duplex to behave beyond answering a request. */
interface HarnessOptions {
  /** Answers each cancel frame from inside the same `write`, as a child may. */
  readonly answerCancel?: boolean
}

/**
 * A duplex that answers every request with a body-bearing response head and lets the
 * test deliver everything after it, so backlog is observed at exact frame boundaries.
 *
 * @param options - Deviations a case needs from that base behavior.
 * @returns The duplex and the child-side moves.
 */
function backlogHarness(options: HarnessOptions = {}): BacklogHarness {
  const decoder = new FrameDecoder()
  const requests: OpenedRequest[] = []
  const handlerFailures: unknown[] = []
  // Encoded frames for the shared chunk are built once per stream and reused: the
  // decoder copies each body out of its frame, so a reused buffer never aliases bytes
  // the bridge still holds, and the fixture stays at one chunk however many frames a
  // case sends.
  const encodedChunks = new Map<number, Uint8Array>()
  let dataHandler: ((bytes: Uint8Array) => void) | undefined
  let cancelCount = 0

  const send = (bytes: Uint8Array): void => {
    try {
      dataHandler?.(bytes)
    } catch (error) {
      // In production this callback is the child's stdout pipe, where a throw becomes
      // an uncaught exception; the double records it so a case can assert none escaped.
      handlerFailures.push(error)
    }
  }

  const sendChunk = (index: number, bytes: Uint8Array = CHUNK): void => {
    if (bytes === CHUNK) {
      let framed = encodedChunks.get(index)
      if (framed === undefined) {
        framed = encodeBody(index, CHUNK)
        encodedChunks.set(index, framed)
      }
      send(framed)
      return
    }
    send(encodeBody(index, bytes))
  }

  const duplex: BridgeDuplex = {
    write(bytes) {
      for (const frame of decoder.push(bytes)) {
        if (frame.tag !== 1) continue
        if (frame.message['type'] === 'cancel') {
          cancelCount += 1
          if (options.answerCancel === true) {
            const released = requests.find((known) => known.streamId === String(frame.message['streamId']))
            if (released !== undefined) {
              send(encodeControl({ streamId: released.streamId, type: 'end' }))
              send(encodeControl({ streamId: released.streamId, type: 'error', message: 'already released' }))
              sendChunk(released.index)
            }
          }
          continue
        }
        if (frame.message['type'] !== 'request') continue
        const streamId = String(frame.message['streamId'])
        const index = typeof frame.message['index'] === 'number' ? frame.message['index'] : requests.length
        requests.push({ streamId, index })
        send(encodeControl({ streamId, type: 'response', status: 200, headers: [['content-type', 'text/event-stream']] }))
      }
    },
    onData(handler) {
      dataHandler = handler
    },
    onExit() {},
    kill() {},
  }

  return {
    duplex,
    requests,
    handlerFailures,
    async open(bridge, init) {
      return await bridge.request(MESSAGES_URL, { method: 'POST', ...init })
    },
    send,
    sendChunk,
    sendEnd(streamId) {
      send(encodeControl({ streamId, type: 'end' }))
    },
    cancels: () => cancelCount,
  }
}

/**
 * Takes the reader a case drives the bridged body with.
 *
 * @param response - The bridged response.
 * @returns A reader over its body.
 */
function readerOf(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  const body = response.body
  assert.ok(body !== null, 'the bridged response carries a body')
  return body.getReader()
}

/** The backpressure failure one stream is expected to end with. */
function isBackpressure(error: unknown): boolean {
  return error instanceof BridgeError && error.reason === 'backpressure'
}

test('a response larger than the cap streams while its reader drains', async () => {
  const harness = backlogHarness()
  const bridge = new BunBridge(harness.duplex)
  const response = await harness.open(bridge)
  const reader = readerOf(response)
  const request = harness.requests[0]

  let total = 0
  for (let sent = 0; sent < 33; sent += 1) {
    harness.sendChunk(request.index)
    const next = await reader.read()
    assert.equal(next.done, false)
    assert.ok(next.value instanceof Uint8Array)
    assert.equal(next.value.byteLength, MIB)
    assert.equal(next.value[0], 0)
    assert.equal(next.value[MIB - 1], (MIB - 1) & 0xff)
    total += next.value.byteLength
  }
  harness.sendEnd(request.streamId)
  assert.equal((await reader.read()).done, true)

  assert.equal(total, 33 * MIB, 'a drained response carries every byte the child sent')
  assert.equal(harness.cancels(), 0, 'a response that reached its end frame is not cancelled')
  assert.equal(bridge.dead, false)
  assert.deepEqual(harness.handlerFailures, [])
})

test('unread backlog at the cap is allowed and the bytes past it fail that stream once', async () => {
  const harness = backlogHarness()
  const bridge = new BunBridge(harness.duplex)
  const reader = readerOf(await harness.open(bridge))
  const request = harness.requests[0]

  // Exactly one cap of unread frames: the consumer has taken nothing yet.
  for (let sent = 0; sent < CAP_BYTES / MIB; sent += 1) harness.sendChunk(request.index)
  assert.equal(bridge.dead, false, 'a stream at its cap is still served')

  harness.sendChunk(request.index)
  await assert.rejects(reader.read(), isBackpressure)

  assert.equal(harness.cancels(), 1, 'the over-cap stream is released with one cancel frame')
  assert.equal(bridge.dead, false, 'one stream past its cap does not end the bridge')
})

test('a reading consumer returns the backlog to zero so later frames never accumulate', async () => {
  const harness = backlogHarness()
  const bridge = new BunBridge(harness.duplex)
  const reader = readerOf(await harness.open(bridge))
  const request = harness.requests[0]

  // Two rounds of 24 MiB: 48 MiB crosses the bridge, but never more than 24 MiB is
  // unread, so the cap is never reached.
  let total = 0
  for (let round = 0; round < 2; round += 1) {
    for (let sent = 0; sent < 24; sent += 1) harness.sendChunk(request.index)
    for (let read = 0; read < 24; read += 1) {
      const next = await reader.read()
      assert.equal(next.done, false)
      assert.ok(next.value instanceof Uint8Array)
      total += next.value.byteLength
    }
  }
  harness.sendEnd(request.streamId)
  assert.equal((await reader.read()).done, true)

  assert.equal(total, 48 * MIB)
  assert.equal(harness.cancels(), 0, 'a consumer that kept up never abandons the stream')
  assert.equal(bridge.dead, false)
})

test('bytes handed straight to a pending read are not backlog', async () => {
  const harness = backlogHarness()
  const bridge = new BunBridge(harness.duplex)
  const reader = readerOf(await harness.open(bridge))
  const request = harness.requests[0]

  // Every read is registered before its frame arrives, so each chunk is delivered
  // directly and the queue never holds a byte — 33 MiB of delivered bytes is not
  // 33 MiB of backlog.
  let total = 0
  const deliveries: Promise<void>[] = []
  for (let sent = 0; sent < 33; sent += 1) {
    deliveries.push(
      reader.read().then((next) => {
        total += next.value?.byteLength ?? 0
      }),
    )
    harness.sendChunk(request.index)
  }
  await Promise.all(deliveries)

  assert.equal(total, 33 * MIB)
  assert.equal(harness.cancels(), 0)
  assert.equal(bridge.dead, false)
  assert.deepEqual(harness.handlerFailures, [])
})

test('an over-cap stream fails alone and its sibling keeps streaming', async () => {
  const harness = backlogHarness()
  const bridge = new BunBridge(harness.duplex)
  const firstReader = readerOf(await harness.open(bridge))
  const secondReader = readerOf(await harness.open(bridge))
  const [first, second] = harness.requests

  // 24 MiB unread on each stream: 48 MiB in total, but each stream is under its own cap.
  for (let sent = 0; sent < 24; sent += 1) harness.sendChunk(first.index)
  for (let sent = 0; sent < 24; sent += 1) harness.sendChunk(second.index)
  assert.equal(bridge.dead, false, 'the cap applies per stream, not to their sum')

  for (let sent = 0; sent < 9; sent += 1) harness.sendChunk(first.index)
  await assert.rejects(firstReader.read(), isBackpressure)

  let total = 0
  for (let read = 0; read < 24; read += 1) {
    const next = await secondReader.read()
    assert.equal(next.done, false)
    assert.ok(next.value instanceof Uint8Array)
    total += next.value.byteLength
  }
  harness.sendEnd(second.streamId)
  assert.equal((await secondReader.read()).done, true)

  assert.equal(total, 24 * MIB, 'the sibling stream still carries everything it was sent')
  assert.equal(harness.cancels(), 1, 'only the failed stream is released')
  assert.equal(bridge.dead, false)
})

test('a backlog failure releases its stream once and drops what arrives late', async () => {
  const harness = backlogHarness()
  const bridge = new BunBridge(harness.duplex)
  const controller = new AbortController()
  const reader = readerOf(await harness.open(bridge, { signal: controller.signal }))
  const request = harness.requests[0]

  for (let sent = 0; sent <= CAP_BYTES / MIB; sent += 1) harness.sendChunk(request.index)
  await assert.rejects(reader.read(), isBackpressure)
  assert.equal(harness.cancels(), 1)

  // The stream's ownership is gone, so the frames the child may still send for it must
  // neither throw out of the pipe nor release it a second time.
  harness.sendEnd(request.streamId)
  harness.send(encodeControl({ streamId: request.streamId, type: 'error', message: 'late failure' }))
  harness.sendChunk(request.index)
  assert.equal(harness.cancels(), 1, 'late frames write no second cancel')
  assert.deepEqual(harness.handlerFailures, [])

  controller.abort()
  assert.equal(harness.cancels(), 1, 'an abort after the failure writes nothing')
  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    0,
    'the released request left no abort listener on the caller signal',
  )
})

test('an overflow whose cancel frame is answered in the same turn releases once', async () => {
  const harness = backlogHarness({ answerCancel: true })
  const bridge = new BunBridge(harness.duplex)
  const reader = readerOf(await harness.open(bridge))
  const request = harness.requests[0]

  for (let sent = 0; sent <= CAP_BYTES / MIB; sent += 1) harness.sendChunk(request.index)
  await assert.rejects(reader.read(), isBackpressure)

  assert.equal(harness.cancels(), 1, 'the answer to the cancel frame writes no second cancel')
  assert.deepEqual(
    harness.handlerFailures,
    [],
    'the frames the child sent while answering the cancel never reach the failed body',
  )
  assert.equal(bridge.dead, false)
})

test('a body the child closed still streams its buffered frames and is never cancelled', async () => {
  const harness = backlogHarness()
  const bridge = new BunBridge(harness.duplex)
  const reader = readerOf(await harness.open(bridge))
  const request = harness.requests[0]

  // The end frame closes the body while three chunks are still buffered.
  for (let sent = 0; sent < 3; sent += 1) harness.sendChunk(request.index)
  harness.sendEnd(request.streamId)

  let total = 0
  for (let read = 0; read < 3; read += 1) {
    const next = await reader.read()
    assert.equal(next.done, false)
    assert.ok(next.value instanceof Uint8Array)
    total += next.value.byteLength
  }
  assert.equal((await reader.read()).done, true)
  assert.equal(total, 3 * MIB)

  harness.sendChunk(request.index)
  assert.equal(harness.cancels(), 0, 'a closed body is not an abandonment')
  assert.deepEqual(harness.handlerFailures, [])
})

test('a configured cap replaces the default and reports the backlog it measured', async () => {
  const harness = backlogHarness()
  const bridge = new BunBridge(harness.duplex, { maxQueuedBytes: 4 * MIB })
  const reader = readerOf(await harness.open(bridge))
  const request = harness.requests[0]

  // Four unread megabytes sit exactly at the configured cap, which the 32 MiB default
  // would never reach; the fifth is the first byte past it.
  for (let sent = 0; sent < 4; sent += 1) harness.sendChunk(request.index)
  assert.equal(bridge.dead, false, 'a stream at the configured cap is still served')

  harness.sendChunk(request.index)
  await assert.rejects(
    reader.read(),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.reason === 'backpressure' &&
      error.message === 'backpressure: 5242880 bytes unread',
  )
  assert.equal(harness.cancels(), 1)
})

test('a chunk larger than the cap reaches the read that is already waiting for it', async () => {
  // A pending read takes its chunk without the queue ever holding it, so this chunk is
  // never backlog however much larger than the cap it is; the frame codec bounds it.
  const harness = backlogHarness()
  const bridge = new BunBridge(harness.duplex, { maxQueuedBytes: 4 * MIB })
  const reader = readerOf(await harness.open(bridge))
  const request = harness.requests[0]
  const oversized = new Uint8Array(4 * MIB + 1)
  oversized[0] = 0x5a
  oversized[oversized.byteLength - 1] = 0xa5

  const pending = reader.read()
  harness.sendChunk(request.index, oversized)
  const next = await pending

  assert.equal(next.done, false)
  assert.ok(next.value instanceof Uint8Array)
  assert.equal(next.value.byteLength, 4 * MIB + 1)
  assert.equal(next.value[0], 0x5a)
  assert.equal(next.value[4 * MIB], 0xa5)
  assert.equal(harness.cancels(), 0, 'a chunk a pending read claimed is not backlog')
  assert.equal(bridge.dead, false)
})

test('a cap that is not a positive safe integer fails at construction', () => {
  const idle = (): BridgeDuplex => ({
    write() {},
    onData() {},
    onExit() {},
    kill() {},
  })

  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new BunBridge(idle(), { maxQueuedBytes: value }), RangeError)
  }
  assert.doesNotThrow(() => {
    new BunBridge(idle(), { maxQueuedBytes: 1 }).dispose()
  })
  assert.doesNotThrow(() => {
    new BunBridge(idle()).dispose()
  })
  assert.equal(DEFAULT_MAX_QUEUED_BYTES, CAP_BYTES)
})
