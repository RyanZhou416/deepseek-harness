/**
 * Bun-side transport child.
 *
 * Runs under Bun and issues each framed request with the global `fetch`, so the
 * request leaves the machine through the same runtime the target client uses:
 * the same TLS stack, header serialization, connection handling and runtime
 * self-report. It never listens on a socket.
 *
 * Only Node-compatible APIs are used for stdio; the masquerade comes from the
 * runtime that performs the fetch, not from Bun-specific calls.
 *
 *   client → child   { streamId, index, type: "request", url, method, headers, body }
 *                    then, when `body` is true, body frames, then { streamId, type: "body-end" }
 *                    or { streamId, type: "cancel" } to abandon the request
 *   child  → client  { streamId, type: "response", status, headers }
 *                    then body frames, then { streamId, type: "end" }
 *                    or { streamId, type: "error", message } at any point
 */

import { once } from 'node:events'
import type { Readable } from 'node:stream'
import { FrameDecoder, encodeBody, encodeControl, type Frame } from './frames.js'

/**
 * Header the child owns.
 *
 * Its value must come from the runtime that performs the fetch: the genuine client
 * reports the version of the runtime issuing the request, so a value computed by
 * the caller on a different runtime would name the wrong runtime on the wire.
 * The spelling is the SDK's, which is what reaches the peer.
 */
const RUNTIME_VERSION_HEADER = 'X-Stainless-Runtime-Version'

interface StreamState {
  readonly streamId: string
  readonly chunks: Uint8Array[]
  readonly request: Record<string, unknown>
  readonly abort: AbortController
  cancelled: boolean
}

const decoder = new FrameDecoder()
const streams = new Map<string, StreamState>()
const indexToStream = new Map<number, string>()
const streamToIndex = new Map<string, number>()

async function send(bytes: Uint8Array): Promise<void> {
  // Respecting the pipe's backpressure keeps a slow reader from buffering whole
  // responses inside the child.
  if (!process.stdout.write(bytes)) {
    await once(process.stdout, 'drain')
  }
}

async function sendControl(message: Record<string, unknown>): Promise<void> {
  await send(encodeControl(message))
}

async function sendBody(streamId: string, bytes: Uint8Array): Promise<void> {
  const index = streamToIndex.get(streamId)
  if (index === undefined) return
  await send(encodeBody(index, bytes))
}

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Reports whether an incoming field name is the one header this child owns.
 *
 * HTTP field names are case-insensitive, and the plan arrives with the client's
 * own mixed casing, so a literal comparison would let a differently-spelled copy
 * of the runtime-version field through beside the one the child sets.
 *
 * @param name - The incoming field name.
 * @returns Whether the child replaces this field with its own value.
 */
function ownHeader(name: string): boolean {
  return name.toLowerCase() === RUNTIME_VERSION_HEADER.toLowerCase()
}

/** Reports a failure for one stream. */
async function fail(state: StreamState, detail: string): Promise<void> {
  await sendControl({ streamId: state.streamId, type: 'error', message: detail })
}

async function issue(state: StreamState): Promise<void> {
  const { streamId } = state
  const request = state.request
  const url = request['url']
  const method = request['method']
  if (typeof url !== 'string' || typeof method !== 'string') {
    await fail(state, 'request needs a url and a method')
    return
  }

  const init: RequestInit = { method, signal: state.abort.signal }
  const headers = request['headers']
  if (Array.isArray(headers)) {
    const list: [string, string][] = []
    for (const pair of headers) {
      if (
        Array.isArray(pair) &&
        typeof pair[0] === 'string' &&
        typeof pair[1] === 'string' &&
        !ownHeader(pair[0])
      ) {
        list.push([pair[0], pair[1]])
      }
    }
    // The runtime issuing the request reports its own version.
    const runtimePair: [string, string] = [RUNTIME_VERSION_HEADER, process.version]
    init.headers = [...list, runtimePair]
  }
  if (request['body'] === true) {
    const body = joinChunks(state.chunks)
    // The genuine client's compression path is gated by remote flags whose default
    // is off, and by transport conditions this process cannot observe, so an
    // identity body is the faithful default. No opt-in is offered: a body whose
    // gates cannot be checked would be worse than no compression at all.
    init.body = new Blob([new Uint8Array(body).buffer])
  }
  state.chunks.length = 0

  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (state.cancelled) return
    await fail(state, describe(error))
    return
  }

  const outHeaders: string[][] = []
  response.headers.forEach((value, key) => {
    outHeaders.push([key, value])
  })
  await sendControl({
    streamId,
    type: 'response',
    status: response.status,
    headers: outHeaders,
  })

  try {
    if (response.body !== null) {
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value !== undefined) await sendBody(streamId, value)
        }
      } finally {
        reader.releaseLock()
      }
    }
  } catch (error) {
    if (!state.cancelled) await fail(state, describe(error))
    return
  }
  await sendControl({ streamId, type: 'end' })
}

async function handleFrame(frame: Frame): Promise<void> {
  if (frame.tag === 2) {
    const streamId = indexToStream.get(frame.streamIndex)
    const state = streamId === undefined ? undefined : streams.get(streamId)
    if (state === undefined) {
      process.stderr.write('bridge child: body frame for an unknown stream index\n')
      return
    }
    state.chunks.push(frame.bytes)
    return
  }

  const { message } = frame
  const streamId = message['streamId']
  if (typeof streamId !== 'string') return
  const type = message['type']

  if (type === 'request') {
    const state: StreamState = {
      streamId,
      chunks: [],
      request: message,
      abort: new AbortController(),
      cancelled: false,
    }
    const index = message['index']
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index > 0xffffffff
    ) {
      // Without a usable index this stream could not be answered coherently.
      await sendControl({ streamId, type: 'error', message: 'request needs a uint32 stream index' })
      return
    }
    streams.set(streamId, state)
    streamToIndex.set(streamId, index)
    indexToStream.set(index, streamId)
    if (message['body'] !== true) await finish(state)
    return
  }
  if (type === 'body-end') {
    const state = streams.get(streamId)
    if (state !== undefined) await finish(state)
    return
  }
  if (type === 'cancel') {
    const state = streams.get(streamId)
    if (state !== undefined) {
      state.cancelled = true
      state.abort.abort()
      forget(streamId)
    }
  }
}

async function finish(state: StreamState): Promise<void> {
  try {
    await issue(state)
  } catch (error) {
    // `issue` reports its own failures; this is the last line of defence so a
    // rejection can never take the child down with it.
    process.stderr.write(`bridge child: ${describe(error)}\n`)
  } finally {
    forget(state.streamId)
  }
}

/** Drops everything a finished stream held. */
function forget(streamId: string): void {
  const state = streams.get(streamId)
  if (state !== undefined) state.chunks.length = 0
  streams.delete(streamId)
  const index = streamToIndex.get(streamId)
  streamToIndex.delete(streamId)
  if (index !== undefined) indexToStream.delete(index)
}

/** Runs the frame loop until stdin closes. */
export async function run(input: Readable = process.stdin): Promise<void> {
  for await (const chunk of input) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer)
    const frames = decoder.push(bytes)
    const failure = decoder.error
    if (failure !== undefined) {
      // The stream is out of step; every later boundary would be guesswork, so the
      // child stops and the client fails everything in flight.
      process.stderr.write(`bridge child: frame stream desynchronized (${failure.reason})\n`)
      process.exitCode = 1
      return
    }
    for (const frame of frames) await handleFrame(frame)
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  await run()
}
