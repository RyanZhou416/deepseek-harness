/**
 * Lifecycle tests for the Bun-side transport child.
 *
 * Every test drives the real `run` loop in this process: the frame input is a
 * pipe the test writes, and the runtime edges (`fetch`, `write`, `report`) are
 * doubles. No child process is spawned, nothing reaches the network, and the
 * barriers are deferred promises and counters — never sleeps.
 *
 * A regression that awaits dispatched work inside the frame loop leaves every
 * wait below unsatisfied, which the case budget turns into a failure instead of a
 * hang.
 */

import assert from 'node:assert/strict'
import { PassThrough, type Readable } from 'node:stream'
import { test, type TestContext } from 'node:test'
import {
  run,
  type TransportChildOptions,
  type TransportDiagnostic,
  type TransportFetch,
} from '../src/transport/bun-child.js'
import { FrameDecoder, encodeBody, encodeControl, type Frame } from '../src/transport/frames.js'

/**
 * Longest a barrier waits before failing.
 *
 * The child's own work is promise continuations and in-memory pipes, so a wait
 * that needs real time is a defect; this only stops a regression from hanging.
 */
const WAIT_BOUND_MS = 10_000

/** Case budget: above the barrier bound so a barrier reports the precise wait that stalled. */
const CASE_BOUND_MS = 15_000

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Counts arrivals and lets a test await a specific one. */
class Barrier {
  #count = 0
  readonly #waiters: { readonly target: number; readonly settle: () => void }[] = []

  /** Records one arrival and wakes every waiter it satisfies. */
  arrive(): void {
    this.#count += 1
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#waiters[index]
      if (waiter.target <= this.#count) {
        this.#waiters.splice(index, 1)
        waiter.settle()
      }
    }
  }

  /**
   * Resolves once `target` arrivals are recorded, or fails when that never happens.
   *
   * @param target - Arrival count to wait for.
   * @param label - What is being awaited, named in the failure.
   */
  async waitFor(target: number, label: string): Promise<void> {
    if (this.#count >= target) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`waited ${WAIT_BOUND_MS}ms for ${label}; ${this.#count} of ${target} arrived`))
      }, WAIT_BOUND_MS)
      this.#waiters.push({
        target,
        settle: () => {
          clearTimeout(timer)
          resolve()
        },
      })
    })
  }
}

/**
 * Yields until promise continuations already queued have run.
 *
 * A superseded stream's cleanup is queued by the frame that replaced it, so this
 * drains it before the test observes the replacement. No wall-clock wait is
 * involved: two scheduler turns cover the rejection travelling through the fetch
 * double and the stream cleanup that follows it.
 */
async function drainContinuations(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

/** A promise the test settles explicitly. */
interface Deferred<T> {
  readonly promise: Promise<T>
  readonly settled: () => boolean
  resolve(value: T): void
  reject(error: Error): void
}

function createDeferred<T>(): Deferred<T> {
  let settleResolve!: (value: T) => void
  let settleReject!: (error: Error) => void
  let done = false
  const promise = new Promise<T>((resolve, reject) => {
    settleResolve = (value) => {
      done = true
      resolve(value)
    }
    settleReject = (error) => {
      done = true
      reject(error)
    }
  })
  return {
    promise,
    settled: () => done,
    resolve: (value) => {
      settleResolve(value)
    },
    reject: (error) => {
      settleReject(error)
    },
  }
}

/** Client-to-child frame input a test writes to. */
interface Channel {
  readonly input: Readable
  send(bytes: Uint8Array): void
  close(): void
  fail(error: Error): void
}

function createChannel(): Channel {
  const input = new PassThrough()
  return {
    input,
    send(bytes) {
      input.write(bytes)
    },
    close() {
      if (!input.destroyed && !input.writableEnded) input.end()
    },
    fail(error) {
      input.destroy(error)
    },
  }
}

/** Decoded child-to-client frames, with a barrier on their count. */
interface Sink {
  readonly frames: Frame[]
  readonly write: (bytes: Uint8Array) => Promise<void>
  waitFor(count: number, label: string): Promise<void>
}

function createSink(): Sink {
  const decoder = new FrameDecoder()
  const frames: Frame[] = []
  const written = new Barrier()
  return {
    frames,
    async write(bytes) {
      // A microtask turn keeps this writer asynchronous, as stdout is, while each
      // call still carries exactly one whole frame.
      await Promise.resolve()
      frames.push(...decoder.push(bytes))
      written.arrive()
    },
    waitFor: (count, label) => written.waitFor(count, label),
  }
}

/** A response body the test feeds, tied to the abort signal the child passed. */
interface ControlledBody {
  readonly response: Response
  /** Whether the abort interrupted this body, as the real `fetch` body would be. */
  readonly interrupted: boolean
  push(bytes: Uint8Array): void
  close(): void
  fail(error: Error): void
}

function createControlledResponse(status: number, signal: AbortSignal): ControlledBody {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let interrupted = false
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController
    },
  })
  const interrupt = (): void => {
    interrupted = true
    controller.error(new Error('the request was aborted'))
  }
  if (signal.aborted) {
    // The request was already abandoned, so the child never reads this body; the
    // test still has to be able to fill and close it.
    interrupted = true
  } else {
    signal.addEventListener('abort', interrupt, { once: true })
  }
  return {
    response: new Response(body, { status }),
    get interrupted() {
      return interrupted
    },
    push(bytes) {
      controller.enqueue(bytes)
    },
    close() {
      controller.close()
    },
    fail(error) {
      controller.error(error)
    },
  }
}

/** One request the child issued. */
interface ScriptedCall {
  readonly url: string
  readonly init: RequestInit
  /** Whether the abort signal the child passed to `fetch` has fired. */
  aborted(): boolean
  /** Answers with a head whose body the test feeds. */
  stream(status: number): ControlledBody
  /** Answers with a complete response. */
  respond(status: number, bytes?: Uint8Array): void
  /** Fails the request the way a transport error would. */
  fail(error: Error): void
}

/** A `fetch` double that records calls and lets the test answer each one. */
interface ScriptedFetch {
  readonly fetch: TransportFetch
  readonly calls: ScriptedCall[]
  waitFor(count: number, label: string): Promise<void>
  waitForAborts(count: number, label: string): Promise<void>
}

/**
 * Builds the `fetch` double.
 *
 * @param options - `abortInterrupts: false` keeps an aborted request pending, so a
 *   test can hand its answer over late and prove the child suppresses it.
 */
function createScriptedFetch(options: { readonly abortInterrupts?: boolean } = {}): ScriptedFetch {
  const calls: ScriptedCall[] = []
  const issued = new Barrier()
  const aborts = new Barrier()
  const abortInterrupts = options.abortInterrupts ?? true
  const scriptedFetch: TransportFetch = (url, init) => {
    const signal = init.signal
    if (!(signal instanceof AbortSignal)) {
      throw new Error('the child must pass an abort signal to fetch')
    }
    const deferred = createDeferred<Response>()
    let interrupted = false
    const interrupt = (): void => {
      interrupted = true
      aborts.arrive()
      if (abortInterrupts && !deferred.settled()) {
        deferred.reject(new Error('AbortError: the request was aborted'))
      }
    }
    if (signal.aborted) interrupt()
    else signal.addEventListener('abort', interrupt, { once: true })
    calls.push({
      url,
      init,
      aborted: () => interrupted,
      stream(status) {
        const body = createControlledResponse(status, signal)
        deferred.resolve(body.response)
        return body
      },
      respond(status, bytes) {
        const body = createControlledResponse(status, signal)
        if (bytes !== undefined) body.push(bytes)
        body.close()
        deferred.resolve(body.response)
      },
      fail(error) {
        deferred.reject(error)
      },
    })
    issued.arrive()
    return deferred.promise
  }
  return {
    fetch: scriptedFetch,
    calls,
    waitFor: (count, label) => issued.waitFor(count, label),
    waitForAborts: (count, label) => aborts.waitFor(count, label),
  }
}

/** A running child loop with its injectable edges and a cleanup that always runs. */
interface ChildHarness {
  readonly channel: Channel
  readonly sink: Sink
  readonly scripted: ScriptedFetch
  readonly diagnostics: TransportDiagnostic[]
  readonly running: Promise<void>
}

function startChild(
  context: TestContext,
  options: {
    readonly abortInterrupts?: boolean
    readonly report?: (diagnostic: TransportDiagnostic) => void
  } = {},
): ChildHarness {
  const channel = createChannel()
  const sink = createSink()
  const scripted = createScriptedFetch(options)
  const diagnostics: TransportDiagnostic[] = []
  const edges: TransportChildOptions = {
    fetch: scripted.fetch,
    write: sink.write,
    report:
      options.report ??
      ((diagnostic) => {
        diagnostics.push(diagnostic)
      }),
  }
  const running = run(channel.input, edges)
  context.after(async () => {
    channel.close()
    await running
  })
  return { channel, sink, scripted, diagnostics, running }
}

/** A client request frame with the fields a test cares about. */
function requestFrame(
  streamId: string,
  index: number,
  fields: {
    readonly url?: string
    readonly method?: string
    readonly headers?: string[][]
    readonly body?: boolean
  } = {},
): Uint8Array {
  return encodeControl({
    streamId,
    index,
    type: 'request',
    url: fields.url ?? 'https://api.anthropic.com/v1/messages',
    method: fields.method ?? 'POST',
    headers: fields.headers ?? [],
    body: fields.body ?? false,
  })
}

function control(frame: Frame): Record<string, unknown> | undefined {
  return frame.tag === 1 ? frame.message : undefined
}

/** The name of the event a control frame carries. */
function kind(frame: Frame): string | undefined {
  const type = control(frame)?.['type']
  return typeof type === 'string' ? type : undefined
}

function frameStreamId(frame: Frame): string | undefined {
  const streamId = control(frame)?.['streamId']
  return typeof streamId === 'string' ? streamId : undefined
}

/** The stream index a body frame carries. */
function bodyIndex(frame: Frame): number | undefined {
  return frame.tag === 2 ? frame.streamIndex : undefined
}

/** The raw bytes a body frame carries. */
function bodyBytes(frame: Frame): Uint8Array {
  return frame.tag === 2 ? frame.bytes : new Uint8Array()
}

function ended(frames: readonly Frame[], streamId: string): boolean {
  return frames.some((frame) => frameStreamId(frame) === streamId && kind(frame) === 'end')
}

/** The message of the first `error` frame naming a stream. */
function errorFor(frames: readonly Frame[], streamId: string): string | undefined {
  for (const frame of frames) {
    if (frameStreamId(frame) !== streamId || kind(frame) !== 'error') continue
    const message = control(frame)?.['message']
    return typeof message === 'string' ? message : ''
  }
  return undefined
}

test('a response still streaming does not hold back another request', { timeout: CASE_BOUND_MS }, async (t) => {
  const child = startChild(t)
  child.channel.send(requestFrame('a', 0))
  await child.scripted.waitFor(1, "stream a's request")
  const bodyA = child.scripted.calls[0].stream(200)
  await child.sink.waitFor(1, "stream a's response head")

  child.channel.send(requestFrame('b', 1))
  await child.scripted.waitFor(2, "stream b's request")
  child.scripted.calls[1].respond(200, encode('b-body'))

  // a-head, b-head, b-body, b-end: b completes while a's body is still open.
  await child.sink.waitFor(4, "stream b's completion")
  assert.equal(frameStreamId(child.sink.frames[3]), 'b')
  assert.equal(kind(child.sink.frames[3]), 'end')
  assert.equal(ended(child.sink.frames, 'a'), false, 'stream a is still open')
  assert.equal(bodyIndex(child.sink.frames[2]), 1)
  assert.equal(new TextDecoder().decode(bodyBytes(child.sink.frames[2])), 'b-body')

  bodyA.push(encode('a-body'))
  bodyA.close()
  await child.sink.waitFor(6, "stream a's completion")
  assert.equal(bodyIndex(child.sink.frames[4]), 0)
  assert.equal(ended(child.sink.frames, 'a'), true)
  assert.deepEqual(child.diagnostics, [])
})

test('a cancel while the request is in flight aborts it and publishes nothing', { timeout: CASE_BOUND_MS }, async (t) => {
  const child = startChild(t)
  child.channel.send(requestFrame('a', 0))
  await child.scripted.waitFor(1, "stream a's request")
  const call = child.scripted.calls[0]

  child.channel.send(encodeControl({ streamId: 'a', type: 'cancel' }))
  await child.scripted.waitForAborts(1, 'the cancel reaching the pending fetch')
  assert.equal(call.aborted(), true)

  child.channel.close()
  await child.running
  assert.deepEqual(child.sink.frames, [], 'a cancelled request publishes no frames')
  assert.deepEqual(child.diagnostics, [], 'a cancelled request is not reported as a failure')
})

test('a cancel while the response body is read stops that stream only', { timeout: CASE_BOUND_MS }, async (t) => {
  const child = startChild(t)
  child.channel.send(requestFrame('a', 0))
  await child.scripted.waitFor(1, "stream a's request")
  const bodyA = child.scripted.calls[0].stream(200)
  await child.sink.waitFor(1, "stream a's response head")

  child.channel.send(encodeControl({ streamId: 'a', type: 'cancel' }))
  await child.scripted.waitForAborts(1, 'the cancel reaching the pending body read')

  child.channel.send(requestFrame('b', 1))
  await child.scripted.waitFor(2, "stream b's request")
  child.scripted.calls[1].respond(200, encode('b-body'))
  await child.sink.waitFor(4, "stream b's completion")

  assert.equal(bodyA.interrupted, true, 'the pending body read saw the abort')
  assert.equal(child.sink.frames.length, 4, 'the cancelled stream published no later frame')
  assert.equal(ended(child.sink.frames, 'a'), false)
  assert.equal(frameStreamId(child.sink.frames[0]), 'a', "the cancelled stream's head was already sent")
  assert.deepEqual(child.diagnostics, [])
})

test('a repeated body-end does not issue a second request', { timeout: CASE_BOUND_MS }, async (t) => {
  const child = startChild(t)
  child.channel.send(
    requestFrame('a', 0, {
      headers: [
        ['content-type', 'application/json'],
        ['x-stainless-runtime-version', 'caller'],
      ],
      body: true,
    }),
  )
  child.channel.send(encodeBody(0, encode('{"model":"x"}')))
  child.channel.send(encodeControl({ streamId: 'a', type: 'body-end' }))

  await child.scripted.waitFor(1, "stream a's request")
  const call = child.scripted.calls[0]

  // The second body-end is ordered before this request frame, so waiting for that
  // frame proves the repeat was ingested while the stream was still live.
  child.channel.send(encodeControl({ streamId: 'a', type: 'body-end' }))
  child.channel.send(requestFrame('b', 1, { url: 'https://api.anthropic.com/v1/other' }))
  await child.scripted.waitFor(2, "stream b's request")
  const uploads = child.scripted.calls.filter(
    (entry) => entry.url === 'https://api.anthropic.com/v1/messages',
  )
  assert.equal(uploads.length, 1, 'a repeated body-end re-issued the request')

  call.respond(200)
  child.scripted.calls[1].respond(200)
  await child.sink.waitFor(4, 'both streams completing')
  assert.equal(ended(child.sink.frames, 'a'), true)
  assert.equal(ended(child.sink.frames, 'b'), true)

  assert.deepEqual(call.init.headers, [
    ['content-type', 'application/json'],
    ['X-Stainless-Runtime-Version', process.version],
  ])
  const sentBody = call.init.body
  assert.ok(sentBody instanceof Blob, 'the uploaded body reaches fetch as one blob')
  assert.equal(await sentBody.text(), '{"model":"x"}')
})

test('a failing stream reports its error and does not stop the loop', { timeout: CASE_BOUND_MS }, async (t) => {
  const child = startChild(t)
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    child.channel.send(requestFrame('a', 0))
    await child.scripted.waitFor(1, "stream a's request")
    child.scripted.calls[0].fail(new Error('ENOTFOUND: getaddrinfo'))

    child.channel.send(requestFrame('b', 1))
    await child.scripted.waitFor(2, "stream b's request")
    child.scripted.calls[1].respond(200, encode('b-body'))
    await child.sink.waitFor(4, 'the failing and healthy streams settling')

    assert.match(errorFor(child.sink.frames, 'a') ?? '', /ENOTFOUND/)
    assert.equal(ended(child.sink.frames, 'b'), true, 'the other stream still completed')

    child.channel.close()
    await child.running
    await drainContinuations()
    assert.deepEqual(unhandled, [], 'a per-stream failure leaves no unhandled rejection')
    assert.deepEqual(child.diagnostics, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('a response body that fails mid-stream reports an error after its head', { timeout: CASE_BOUND_MS }, async (t) => {
  const child = startChild(t)
  child.channel.send(requestFrame('a', 0))
  await child.scripted.waitFor(1, "stream a's request")
  const body = child.scripted.calls[0].stream(200)
  await child.sink.waitFor(1, "stream a's response head")

  body.push(encode('part'))
  await child.sink.waitFor(2, "stream a's first chunk")
  assert.equal(new TextDecoder().decode(bodyBytes(child.sink.frames[1])), 'part')

  body.fail(new Error('stream reset'))
  await child.sink.waitFor(3, 'the body failure')
  assert.match(errorFor(child.sink.frames, 'a') ?? '', /stream reset/)
  assert.equal(ended(child.sink.frames, 'a'), false, 'a failed body is not ended')
  assert.deepEqual(child.diagnostics, [])
})

test('stdin EOF aborts live streams and waits for their work to stop', { timeout: CASE_BOUND_MS }, async (t) => {
  const child = startChild(t)
  child.channel.send(requestFrame('a', 0))
  await child.scripted.waitFor(1, "stream a's request")
  const body = child.scripted.calls[0].stream(200)
  await child.sink.waitFor(1, "stream a's response head")

  child.channel.close()
  // Resolving proves the shutdown awaited the pending task instead of leaving it.
  await child.running

  assert.equal(child.scripted.calls[0].aborted(), true, 'EOF aborted the request still in flight')
  assert.equal(body.interrupted, true, 'EOF interrupted the pending body read')
  assert.equal(child.sink.frames.length, 1, 'no frame follows EOF')
  assert.deepEqual(child.diagnostics, [])
})

test('a stdin read failure aborts live streams and reports itself', { timeout: CASE_BOUND_MS }, async (t) => {
  const child = startChild(t)
  child.channel.send(requestFrame('a', 0))
  await child.scripted.waitFor(1, "stream a's request")
  const body = child.scripted.calls[0].stream(200)
  await child.sink.waitFor(1, "stream a's response head")

  child.channel.fail(new Error('stdin exploded'))
  await child.running

  assert.equal(child.scripted.calls[0].aborted(), true)
  assert.equal(body.interrupted, true)
  assert.equal(child.sink.frames.length, 1, 'no frame follows the read failure')
  assert.deepEqual(
    child.diagnostics.map((diagnostic) => diagnostic.fatal),
    [true],
  )
  assert.match(child.diagnostics[0].detail, /stdin exploded/)
})

test('a desynchronized frame stream discards its read and stops the child', { timeout: CASE_BOUND_MS }, async (t) => {
  const child = startChild(t)
  child.channel.send(requestFrame('a', 0))
  await child.scripted.waitFor(1, "stream a's request")
  const body = child.scripted.calls[0].stream(200)
  await child.sink.waitFor(1, "stream a's response head")

  // One read holds a valid request beside an unknown tag: the read fails as a
  // whole, so the valid frame in it is never acted on.
  const valid = requestFrame('b', 1)
  const corrupt = new Uint8Array([0, 0, 0, 2, 0x09, 0x00])
  const read = new Uint8Array(valid.byteLength + corrupt.byteLength)
  read.set(valid, 0)
  read.set(corrupt, valid.byteLength)
  child.channel.send(read)
  await child.running

  assert.equal(child.scripted.calls.length, 1, 'the frame beside the corrupt one is not acted on')
  assert.equal(child.scripted.calls[0].aborted(), true)
  assert.equal(body.interrupted, true)
  assert.equal(child.sink.frames.length, 1, 'no frame follows the desync')
  assert.deepEqual(
    child.diagnostics.map((diagnostic) => diagnostic.fatal),
    [true],
  )
  assert.match(child.diagnostics[0].detail, /desynchronized/)
})

test('two runs in one process keep their own streams and framing state', { timeout: CASE_BOUND_MS }, async (t) => {
  const first = startChild(t)
  const second = startChild(t)

  // A frame split across writes on one input, with a whole frame written to the
  // other input in between: a shared decoder would splice the two together.
  const split = requestFrame('a', 0)
  first.channel.send(split.subarray(0, 3))
  second.channel.send(requestFrame('z', 7))
  first.channel.send(split.subarray(3))

  await first.scripted.waitFor(1, "the first run's request")
  await second.scripted.waitFor(1, "the second run's request")
  first.scripted.calls[0].respond(200, encode('first'))
  second.scripted.calls[0].respond(200, encode('second'))
  await first.sink.waitFor(3, "the first run's completion")
  await second.sink.waitFor(3, "the second run's completion")

  assert.equal(frameStreamId(first.sink.frames[0]), 'a')
  assert.equal(bodyIndex(first.sink.frames[1]), 0)
  assert.equal(new TextDecoder().decode(bodyBytes(first.sink.frames[1])), 'first')
  assert.equal(frameStreamId(second.sink.frames[0]), 'z')
  assert.equal(bodyIndex(second.sink.frames[1]), 7)
  assert.equal(new TextDecoder().decode(bodyBytes(second.sink.frames[1])), 'second')

  // Ending one run leaves the other working.
  first.channel.close()
  await first.running
  second.channel.send(requestFrame('y', 8))
  await second.scripted.waitFor(2, "the second run's later request")
  second.scripted.calls[1].respond(200, encode('later'))
  await second.sink.waitFor(6, "the second run's later completion")
  assert.equal(ended(second.sink.frames, 'y'), true)

  assert.deepEqual(first.diagnostics, [])
  assert.deepEqual(second.diagnostics, [])
})

test('a superseded stream id cannot publish under its replacement index', { timeout: CASE_BOUND_MS }, async (t) => {
  const child = startChild(t, { abortInterrupts: false })
  child.channel.send(requestFrame('s', 1))
  await child.scripted.waitFor(1, "the first request for the stream id")
  const superseded = child.scripted.calls[0]

  child.channel.send(requestFrame('s', 2))
  await child.scripted.waitFor(2, 'the replacement request')
  assert.equal(superseded.aborted(), true, 'the replacement aborts the request it supersedes')

  // The index the superseded request registered is no longer addressable.
  child.channel.send(encodeBody(1, encode('stale')))
  const replacement = child.scripted.calls[1].stream(200)
  await child.sink.waitFor(1, "the replacement's response head")

  // The superseded request answers late; its cleanup has run before the drain
  // returns, and nothing of it may reach the client.
  superseded.respond(200, encode('late'))
  await drainContinuations()
  assert.equal(child.sink.frames.length, 1, 'a superseded stream publishes no frame')

  replacement.push(encode('fresh'))
  replacement.close()
  await child.sink.waitFor(3, "the replacement's completion")
  assert.equal(bodyIndex(child.sink.frames[1]), 2)
  assert.equal(new TextDecoder().decode(bodyBytes(child.sink.frames[1])), 'fresh')
  assert.equal(ended(child.sink.frames, 's'), true)
  assert.deepEqual(
    child.diagnostics.map((diagnostic) => diagnostic.detail),
    ['bridge child: body frame for an unknown stream index'],
  )
})

test('an unfinished upload issues no request when the input ends', { timeout: CASE_BOUND_MS }, async (t) => {
  const child = startChild(t)
  child.channel.send(requestFrame('a', 0, { body: true }))
  child.channel.send(encodeBody(0, encode('partial')))
  child.channel.close()
  await child.running

  assert.equal(child.scripted.calls.length, 0, 'an upload that never ended issues no request')
  assert.deepEqual(child.sink.frames, [])
  assert.deepEqual(child.diagnostics, [])
})

test('a cancel of an unfinished upload issues no request', { timeout: CASE_BOUND_MS }, async (t) => {
  const child = startChild(t)
  child.channel.send(requestFrame('a', 0, { body: true }))
  child.channel.send(encodeBody(0, encode('partial')))
  child.channel.send(encodeControl({ streamId: 'a', type: 'cancel' }))

  // The cancelled upload precedes this request frame, so its cancel was ingested
  // once that frame's request is issued.
  child.channel.send(requestFrame('b', 1))
  await child.scripted.waitFor(1, "stream b's request")
  child.scripted.calls[0].respond(200)
  await child.sink.waitFor(2, "stream b's completion")

  assert.equal(child.scripted.calls.length, 1, 'the cancelled upload never issued a request')
  assert.equal(frameStreamId(child.sink.frames[0]), 'b')
  assert.deepEqual(child.diagnostics, [])
})

test('an unusable stream index is framed before the input ends, even behind a held write', { timeout: CASE_BOUND_MS }, async (t) => {
  const frames: Frame[] = []
  const decoder = new FrameDecoder()
  const writeStarted = new Barrier()
  const released = createDeferred<void>()
  const channel = createChannel()
  const edges: TransportChildOptions = {
    fetch: () => Promise.reject(new Error('no request is expected')),
    async write(bytes) {
      writeStarted.arrive()
      await released.promise
      frames.push(...decoder.push(bytes))
      throw new Error('stdout is gone')
    },
    report: () => {
      throw new Error('the diagnostic sink refused the report')
    },
  }
  const running = run(channel.input, edges)
  t.after(async () => {
    channel.close()
    released.resolve()
    await running
  })

  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    let settled = false
    void running.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    channel.send(requestFrame('a', -1))
    channel.close()
    await writeStarted.waitFor(1, 'the unusable-index frame reaching the writer')
    await drainContinuations()
    assert.equal(settled, false, 'run waits for the frame it started writing')

    released.resolve()
    await running
    assert.equal(frames.length, 1, 'the error frame is written once the writer releases it')
    assert.match(errorFor(frames, 'a') ?? '', /uint32 stream index/)
    await drainContinuations()
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('a diagnostic sink that throws cannot break a desynchronized shutdown', { timeout: CASE_BOUND_MS }, async (t) => {
  const child = startChild(t, {
    report: () => {
      throw new Error('the diagnostic sink refused the report')
    },
  })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    child.channel.send(requestFrame('a', 0))
    await child.scripted.waitFor(1, "stream a's request")
    const body = child.scripted.calls[0].stream(200)
    await child.sink.waitFor(1, "stream a's response head")

    child.channel.send(new Uint8Array([0, 0, 0, 2, 0x09, 0x00]))
    await child.running

    assert.equal(child.scripted.calls[0].aborted(), true, 'shutdown still aborted the live stream')
    assert.equal(body.interrupted, true)
    assert.equal(child.sink.frames.length, 1)
    assert.deepEqual(child.diagnostics, [], 'the throwing sink recorded nothing')
    await drainContinuations()
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('a diagnostic sink that throws cannot replace a stream failure', { timeout: CASE_BOUND_MS }, async (t) => {
  const frames: Frame[] = []
  const decoder = new FrameDecoder()
  const channel = createChannel()
  const edges: TransportChildOptions = {
    fetch: async () => {
      throw new Error('ENOTFOUND: getaddrinfo')
    },
    async write(bytes) {
      frames.push(...decoder.push(bytes))
      throw new Error('stdout is gone')
    },
    report: () => {
      throw new Error('the diagnostic sink refused the report')
    },
  }
  const running = run(channel.input, edges)
  t.after(async () => {
    channel.close()
    await running
  })

  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    channel.send(requestFrame('a', 0))
    channel.close()
    await running

    assert.equal(frames.length, 1, 'the failure was framed before the writer failed')
    assert.match(errorFor(frames, 'a') ?? '', /ENOTFOUND/)
    await drainContinuations()
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('an unusable index supersedes a live stream id and leaves nothing behind', { timeout: CASE_BOUND_MS }, async (t) => {
  const child = startChild(t, { abortInterrupts: false })
  child.channel.send(requestFrame('s', 1))
  await child.scripted.waitFor(1, "the first request for the stream id")
  const superseded = child.scripted.calls[0]

  child.channel.send(requestFrame('s', -1))
  await child.sink.waitFor(1, 'the unusable-index error frame')
  assert.equal(superseded.aborted(), true, 'the unusable frame supersedes the live stream')
  assert.match(errorFor(child.sink.frames, 's') ?? '', /uint32 stream index/)

  // Nothing is left registered for the id: its body-end starts no request, and its
  // former index addresses no stream.
  child.channel.send(encodeControl({ streamId: 's', type: 'body-end' }))
  child.channel.send(encodeBody(1, encode('orphan')))
  child.channel.send(requestFrame('t', 2))
  await child.scripted.waitFor(2, "stream t's request")
  child.scripted.calls[1].respond(200)
  await child.sink.waitFor(3, "stream t's completion")

  assert.equal(child.scripted.calls.length, 2, 'the superseded stream was never dispatched')
  assert.equal(ended(child.sink.frames, 't'), true)
  assert.deepEqual(
    child.diagnostics.map((diagnostic) => diagnostic.detail),
    ['bridge child: body frame for an unknown stream index'],
  )

  // The superseded request was still pending; its answer is suppressed.
  superseded.fail(new Error('AbortError: the request was aborted'))
})
