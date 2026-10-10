import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  encodeBody,
  encodeControl,
  FrameDecoder,
  FrameError,
  FRAME_LENGTH_BYTES,
  MAX_FRAME_BYTES,
  TAG_BODY,
  TAG_CONTROL,
} from '../src/transport/frames.js'

test('a control frame round-trips through the decoder', () => {
  const decoder = new FrameDecoder()
  const frames = decoder.push(encodeControl({ streamId: 's-1', type: 'request', method: 'POST' }))
  assert.equal(frames.length, 1)
  const frame = frames[0]
  assert.equal(frame.tag, TAG_CONTROL)
  assert.deepEqual(frame.tag === TAG_CONTROL ? frame.message : null, {
    streamId: 's-1',
    type: 'request',
    method: 'POST',
  })
  assert.equal(decoder.pending, 0)
})

test('a body frame carries raw bytes without newline or base64 treatment', () => {
  // 0x0a would be split by a line protocol and 0x00/0xff by a text encoding;
  // all three must survive byte-exact.
  const bytes = new Uint8Array([0x7b, 0x0a, 0x00, 0xff, 0x22, 0x5c, 0x0d, 0x0a, 0x7d])
  const decoder = new FrameDecoder()
  const frames = decoder.push(encodeBody(7, bytes))
  assert.equal(frames.length, 1)
  const frame = frames[0]
  assert.equal(frame.tag, TAG_BODY)
  assert.equal(frame.tag === TAG_BODY ? frame.streamIndex : -1, 7)
  assert.deepEqual(
    frame.tag === TAG_BODY ? Array.from(frame.bytes) : [],
    Array.from(bytes),
  )
})

test('frames split across reads reassemble, byte by byte', () => {
  const encoder = new TextEncoder()
  const stream = new Uint8Array([
    ...encodeControl({ streamId: 's-2', type: 'request' }),
    ...encodeBody(0, encoder.encode('hello')),
    ...encodeControl({ streamId: 's-2', type: 'end' }),
  ])
  const decoder = new FrameDecoder()
  const collected: string[] = []
  for (const byte of stream) {
    for (const frame of decoder.push(new Uint8Array([byte]))) {
      collected.push(frame.tag === TAG_CONTROL ? String(frame.message['type']) : 'body')
    }
  }
  assert.deepEqual(collected, ['request', 'body', 'end'])
  assert.equal(decoder.pending, 0)
})

test('several frames in one read are all returned', () => {
  const decoder = new FrameDecoder()
  const frames = decoder.push(
    new Uint8Array([
      ...encodeBody(1, new Uint8Array([1, 2])),
      ...encodeBody(2, new Uint8Array([3])),
      ...encodeControl({ streamId: 's-3', type: 'request' }),
    ]),
  )
  assert.deepEqual(
    frames.map((frame) => (frame.tag === TAG_BODY ? frame.streamIndex : 'control')),
    [1, 2, 'control'],
  )
})

test('interleaved streams keep their own indices', () => {
  const decoder = new FrameDecoder()
  const frames = decoder.push(
    new Uint8Array([
      ...encodeControl({ streamId: 'a', type: 'request' }),
      ...encodeControl({ streamId: 'b', type: 'request' }),
      ...encodeBody(0, new Uint8Array([9])),
      ...encodeBody(1, new Uint8Array([8])),
    ]),
  )
  const bodies = frames.filter((frame) => frame.tag === TAG_BODY)
  assert.deepEqual(
    bodies.map((frame) => (frame.tag === TAG_BODY ? frame.streamIndex : -1)),
    [0, 1],
  )
})

test('a control frame without a stream id is refused', () => {
  assert.throws(
    () => encodeControl({ type: 'request' }),
    (error: unknown) => error instanceof FrameError && error.reason === 'missing-stream-id',
  )
})

test('an over-long length prefix is refused instead of allocated', () => {
  const prefix = new Uint8Array(FRAME_LENGTH_BYTES)
  new DataView(prefix.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false)
  const decoder = new FrameDecoder()
  // Decoding never throws: a throw here would escape a pipe data handler and become
  // an uncaught exception in the host process.
  assert.deepEqual(decoder.push(prefix), [])
  assert.equal(decoder.error?.reason, 'length-limit')
  assert.deepEqual(decoder.push(encodeControl({ streamId: 's', type: 'request' })), [], 'a desynchronized decoder stays stopped')
})

test('an unknown tag, invalid JSON and a short body header are each refused', () => {
  const framed = (tag: number, payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(FRAME_LENGTH_BYTES + 1 + payload.byteLength)
    new DataView(out.buffer).setUint32(0, 1 + payload.byteLength, false)
    out[FRAME_LENGTH_BYTES] = tag
    out.set(payload, FRAME_LENGTH_BYTES + 1)
    return out
  }
  const cases: readonly (readonly [Uint8Array, FrameError['reason']])[] = [
    [framed(0x09, new Uint8Array([1])), 'unknown-tag'],
    [framed(TAG_CONTROL, new TextEncoder().encode('{not json')), 'invalid-json'],
    [framed(TAG_CONTROL, new TextEncoder().encode('[]')), 'invalid-json'],
    [framed(TAG_BODY, new Uint8Array([0, 0])), 'truncated'],
  ]
  for (const [bytes, reason] of cases) {
    const decoder = new FrameDecoder()
    assert.deepEqual(decoder.push(bytes), [], `expected no frames for ${reason}`)
    assert.equal(decoder.error?.reason, reason, `expected ${reason}`)
  }
})

test('a partial frame is held, not decoded', () => {
  const full = encodeControl({ streamId: 's-4', type: 'request' })
  const decoder = new FrameDecoder()
  assert.deepEqual(decoder.push(full.subarray(0, full.byteLength - 1)), [])
  assert.equal(decoder.pending, full.byteLength - 1)
  assert.equal(decoder.push(full.subarray(full.byteLength - 1)).length, 1)
  assert.equal(decoder.pending, 0)
})

test('a malformed frame does not discard the frames already decoded beside it', () => {
  const framed = (tag: number, payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(FRAME_LENGTH_BYTES + 1 + payload.byteLength)
    new DataView(out.buffer).setUint32(0, 1 + payload.byteLength, false)
    out[FRAME_LENGTH_BYTES] = tag
    out.set(payload, FRAME_LENGTH_BYTES + 1)
    return out
  }
  const decoder = new FrameDecoder()
  const frames = decoder.push(
    new Uint8Array([
      ...encodeBody(3, new TextEncoder().encode('kept')),
      ...framed(0x7f, new Uint8Array([1])),
    ]),
  )
  assert.equal(frames.length, 1, 'the good frame survives its malformed neighbour')
  assert.equal(frames[0]?.tag, TAG_BODY)
  assert.equal(decoder.error?.reason, 'unknown-tag')
})
