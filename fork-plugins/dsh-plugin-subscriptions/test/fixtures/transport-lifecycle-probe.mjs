/**
 * Prove the Claude transport lifecycle through the real bridge child in-process.
 *
 * `transport_lifecycle_probe` drives one `BunBridge` over an in-memory duplex
 * against the real `bun-child` frame loop and the real `streamAnthropic`
 * consumer. The child's fetch is injected per run, so no provider request is
 * possible, and child frames go to an in-memory sink so nothing reaches the dsh
 * process stdout. Every wait is a barrier on an observed state, never a sleep.
 */

import { PassThrough } from 'node:stream'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BunBridge } from '../../src/transport/bridge.ts'
import { run } from '../../src/transport/bun-child.ts'
import { streamAnthropic } from '../../src/translate/anthropic.ts'

export const name = 'transport-lifecycle-probe'
export const inject = ['tools']

const encoder = new TextEncoder()

/** Upper bound on one barrier wait; the awaited state, never this deadline, decides the result. */
const BARRIER_TIMEOUT_MS = 5_000

/** A promise with an external settle, so a race is placed at a deterministic point. */
function deferred() {
  let resolve
  const promise = new Promise(settle => { resolve = settle })
  return { promise, resolve }
}

/**
 * Await an observed state under a bounded deadline.
 * @param promise - settles when the awaited state is reached.
 * @returns true when the state was observed before the deadline.
 * @throws Whatever `promise` rejects with; the deadline never masks a failure.
 */
function bounded(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { resolve(false) }, BARRIER_TIMEOUT_MS)
    promise.then(
      () => { clearTimeout(timer); resolve(true) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * One in-memory duplex. The two directions are separate `PassThrough`
 * instances, so no stream is shared between the bridge and the child.
 */
function memoryDuplex() {
  const toChild = new PassThrough()
  const toParent = new PassThrough()
  const dataHandlers = []
  const exitHandlers = []
  toParent.on('data', (chunk) => {
    for (const handler of dataHandlers) handler(new Uint8Array(chunk))
  })
  return {
    duplex: {
      write: bytes => { toChild.write(Buffer.from(bytes)) },
      onData: handler => { dataHandlers.push(handler) },
      onExit: handler => { exitHandlers.push(handler) },
      kill: () => { toChild.end(); toParent.end() },
    },
    input: toChild,
    output: toParent,
  }
}

/**
 * One upstream response body the probe holds open, releases, or abandons.
 * `honour` is the injected fetch's stand-in for the platform cancelling a
 * response body when its `RequestInit.signal` aborts.
 */
function upstreamBody() {
  const observed = { cancelled: false, eof: false }
  const cancelled = deferred()
  let controller
  let started
  const ready = new Promise(resolve => { started = resolve })
  const stream = new ReadableStream({ start(c) { controller = c; started() } })
  return {
    observed,
    cancelled,
    response: () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    honour(signal) {
      const abandon = () => {
        if (observed.cancelled || observed.eof) return
        observed.cancelled = true
        cancelled.resolve()
        controller.error(new Error('upstream body abandoned'))
      }
      if (signal.aborted) abandon()
      else signal.addEventListener('abort', abandon, { once: true })
    },
    async send(text) {
      await ready
      if (observed.cancelled || observed.eof) return
      controller.enqueue(encoder.encode(text))
    },
    async close() {
      await ready
      if (observed.cancelled || observed.eof) return
      observed.eof = true
      controller.close()
    },
  }
}

const SSE_HEAD = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_probe","type":"message","role":"assistant","content":[],"model":"claude-probe","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
  + 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
const SSE_TEXT = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"probe"}}\n\n'
const SSE_STOP = 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
  + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'

/**
 * The `run(input, options)` injection seam: `fetch` is the child's only network
 * access and `write` receives whole child frames instead of the dsh process
 * stdout. `report` keeps the child from touching the process exit code.
 * @param fetchImpl - upstream replaced for this run.
 * @param output - writable receiving the child's frame bytes.
 * @returns the options object passed as `run`'s second argument.
 */
function childRunOptions(fetchImpl, output) {
  return {
    fetch: fetchImpl,
    write: async (bytes) => { output.write(Buffer.from(bytes)) },
    report: () => {},
  }
}

/**
 * Drain a response body so the bridge keeps reading its frames.
 * @param body - the response body under test.
 */
async function drain(body) {
  const reader = body.getReader()
  try {
    for (;;) {
      const { done } = await reader.read()
      if (done) return
    }
  } finally {
    reader.releaseLock()
  }
}

/** Run the four lifecycle proofs over one bridge and one in-process child. */
async function proveTransportLifecycle() {
  const bodies = { A: upstreamBody(), B: upstreamBody(), C: upstreamBody() }
  const requested = []

  const fetchImpl = async (url, init) => {
    const body = bodies[new URL(url).searchParams.get('stream')]
    requested.push(url)
    const response = body.response()
    body.honour(init.signal)
    if (body === bodies.A) {
      await body.send(SSE_HEAD)
      await body.send(SSE_TEXT)
    }
    if (body === bodies.B) {
      await body.send(SSE_HEAD)
      await body.send(SSE_TEXT)
      await body.send(SSE_STOP)
    }
    if (body === bodies.C) {
      await body.send(SSE_HEAD)
      await body.send(SSE_TEXT)
      await body.send(SSE_STOP)
    }
    return response
  }

  const channel = memoryDuplex()
  const bridge = new BunBridge(channel.duplex)
  const child = run(channel.input, childRunOptions(fetchImpl, channel.output))
  const request = stream => bridge.request(`https://bridge.invalid/v1/messages?stream=${stream}`, {
    method: 'POST',
    body: '{}',
    ...stream === 'A' ? { signal: abortA.signal } : {},
  })
  const abortA = new AbortController()
  const proof = {
    scenario: 'transport-lifecycle',
    bSettledWhileAHeld: false,
    cancelABeforeAeof: false,
    terminalSseCancelWithoutEof: false,
    childQuiescentOnInputEof: false,
  }
  let failure
  try {
    // A stays held open; B must complete its whole response while A is still held.
    const responseA = await request('A')
    const readingA = drain(responseA.body).catch(() => {
      // The bridge fails A's body when the request is cancelled; the cancel, not
      // the failure, is the observation under test.
    })
    const responseB = await request('B')
    await bodies.B.close()
    await drain(responseB.body)
    const bHeldWhileBSettled = !bodies.A.observed.eof && !bodies.A.observed.cancelled
    const requestedWhenBSettled = requested.length

    // Cancel A while its upstream body has no EOF, and observe the cancel first.
    abortA.abort()
    const cancelObserved = await bounded(bodies.A.cancelled.promise)
    proof.cancelABeforeAeof = cancelObserved && bodies.A.observed.cancelled && !bodies.A.observed.eof
    await bodies.A.close()
    await readingA

    // A terminal SSE event abandons the upstream body without waiting for EOF.
    const responseC = await request('C')
    for await (const _chunk of streamAnthropic(responseC.body)) { /* consume to message_stop */ }
    const terminalObserved = await bounded(bodies.C.cancelled.promise)
    proof.terminalSseCancelWithoutEof = terminalObserved && bodies.C.observed.cancelled && !bodies.C.observed.eof

    proof.bSettledWhileAHeld = bHeldWhileBSettled && requestedWhenBSettled === 2
  } catch (error) {
    failure = error
    throw error
  } finally {
    // Teardown runs on every path: the child's input always closes, its frame
    // loop is always awaited to quiescence, and both channel directions are
    // always disposed.
    channel.input.end()
    try {
      proof.childQuiescentOnInputEof = await bounded(child)
    } catch (error) {
      // A successful proof body reports the child's settlement failure; an
      // already-failing body keeps its own cause.
      if (failure === undefined) throw error
    } finally {
      bridge.dispose()
    }
  }
  return proof
}

/** Register the deterministic transport-lifecycle probe with recorded output. */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'transport_lifecycle_probe',
    description: 'Prove the Claude bridge child settles overlapping requests, cancels before EOF, abandons a terminal SSE upstream, and exits quiescently.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return JSON.stringify(await proveTransportLifecycle())
    },
    presentCall: args => ({ card: 'generic', title: 'Inspect Claude transport lifecycle', kind: 'other', rawInput: args }),
  })))
}
