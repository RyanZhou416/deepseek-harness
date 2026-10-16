/**
 * Client side of the Bun stdio transport.
 *
 * Owns one long-lived Bun child, multiplexes requests over it by `streamId`, and
 * presents each response as a web `Response` whose body streams from the frames.
 *
 * The child holds an upstream request open until the bridge tells it otherwise, so a
 * body its caller stops reading is released with one cancel frame per stream, exactly
 * as an abort is.
 *
 * The duplex is injectable so the framing and failure paths are testable without
 * spawning a process; the default duplex spawns the built child under the Bun
 * runtime.
 *
 * Failure policy is fail-closed: a dead child rejects every in-flight request and
 * every later one with a diagnosable error. It never falls back to the Node
 * transport, because the Node path is the configuration this transport exists to
 * replace.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { FrameDecoder, encodeBody, encodeControl, type Frame } from './frames.js'

/** Bytes-level duplex to the child. */
export interface BridgeDuplex {
  /** Sends bytes to the child. */
  write(bytes: Uint8Array): void
  /** Registers the data handler; called once. */
  onData(handler: (bytes: Uint8Array) => void): void
  /** Registers the exit handler; called once. */
  onExit(handler: (reason: string) => void): void
  /** Terminates the child. */
  kill(): void
}

/** Failure raised when the transport cannot carry a request. */
export class BridgeError extends Error {
  /** Machine-readable reason. */
  readonly reason:
    | 'child-exited'
    | 'child-error'
    | 'remote-error'
    | 'cancelled'
    | 'unsupported-body'
    | 'invalid-status'
    | 'backpressure'

  /**
   * @param reason - Why the request could not complete.
   * @param detail - Extra context for logs.
   */
  constructor(reason: BridgeError['reason'], detail = '') {
    super(detail === '' ? reason : `${reason}: ${detail}`)
    this.name = 'BridgeError'
    this.reason = reason
  }
}

/**
 * Largest body frame sent to the child.
 *
 * A whole request body in one frame would have to stay under the codec's ceiling
 * and would be rejected after the pending entry was registered, so bodies are
 * chunked and the entry is registered only once the head has been written.
 */
const MAX_BODY_FRAME_BYTES = 1024 * 1024

/**
 * Default cap on one response body's unread bytes.
 *
 * A consumer that stops reading would otherwise grow that body's queue for the life of
 * a long-lived child, so the cap converts it into a diagnosable per-stream failure. It
 * measures the queue itself, so bytes a pending read already claimed and bytes the
 * consumer took are not backlog. Deployments override it through
 * {@link BridgeOptions.maxQueuedBytes}.
 */
export const DEFAULT_MAX_QUEUED_BYTES = 32 * 1024 * 1024

/** Deployment-varying limits for one bridge. */
export interface BridgeOptions {
  /**
   * Largest unread backlog, in bytes, one response body may accumulate before that
   * stream fails with `backpressure`. Must be a positive safe integer; defaults to
   * {@link DEFAULT_MAX_QUEUED_BYTES}.
   */
  readonly maxQueuedBytes?: number
}

/** Statuses that must be delivered without a body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

interface Pending {
  readonly streamId: string
  readonly index: number
  readonly stream: ReadableStream<Uint8Array>
  readonly controller: ReadableStreamDefaultController<Uint8Array>
  readonly resolve: (response: Response) => void
  readonly reject: (error: Error) => void
  readonly signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
  headersSent: boolean
}

/** A started bridge. */
export class BunBridge {
  readonly #duplex: BridgeDuplex
  readonly #decoder = new FrameDecoder()
  readonly #pending = new Map<number, Pending>()
  readonly #byId = new Map<string, Pending>()
  readonly #maxQueuedBytes: number
  #nextIndex = 0
  #dead: BridgeError | undefined

  /**
   * @param duplex - Bytes-level channel to the child.
   * @param options - Deployment limits; an unset member keeps its default.
   * @throws RangeError when `options.maxQueuedBytes` is not a positive safe integer.
   */
  constructor(duplex: BridgeDuplex, options: BridgeOptions = {}) {
    const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES
    if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes <= 0) {
      throw new RangeError(
        `maxQueuedBytes must be a positive safe integer, received ${String(maxQueuedBytes)}`,
      )
    }
    this.#duplex = duplex
    this.#maxQueuedBytes = maxQueuedBytes
    duplex.onData((bytes) => {
      const frames = this.#decoder.push(bytes)
      const failure = this.#decoder.error
      if (failure !== undefined) {
        // The stream is out of step: every later boundary would be guesswork, so the
        // bridge stops rather than handing corrupted bodies to callers.
        this.#failAll(new BridgeError('child-error', `frame stream desynchronized (${failure.reason})`))
        return
      }
      this.#onFrames(frames)
    })
    duplex.onExit((reason) => {
      this.#failAll(new BridgeError('child-exited', reason))
    })
  }

  /** True once the child is gone. */
  get dead(): boolean {
    return this.#dead !== undefined
  }

  /** The failure that ended the bridge, when it has ended. */
  get failure(): BridgeError | undefined {
    return this.#dead
  }

  /**
   * Issues one request through the child.
   *
   * @param url - Absolute request URL.
   * @param init - Method, headers, body and optional abort signal.
   * @returns The one outcome of the request: the response, whose body streams from the
   *   child, or the rejection below. A write failure is reported through this same
   *   promise, after any frame the child already delivered for the request.
   * @throws BridgeError for a dead child, a signal that is already aborted, an
   *   unsupported body form, or a write that failed before the child answered; the
   *   caller decides whether to retry.
   */
  async request(url: string, init: RequestInit): Promise<Response> {
    if (this.#dead !== undefined) throw this.#dead
    const signal = init.signal ?? undefined
    // A caller that already aborted has no request to make: sending it would ask the
    // child to open an upstream request whose only purpose is to be cancelled.
    if (signal !== undefined && signal.aborted) throw new BridgeError('cancelled')

    const streamId = randomUUID()
    const index = this.#nextIndex
    this.#nextIndex += 1

    const body = bodyBytes(init.body)

    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          controller = c
        },
        // The consumer abandoning the body — a translator returning at its terminal event,
        // for one — is the only notice the child gets to stop the request upstream.
        cancel: () => {
          this.#release(pending)
        },
      },
      // The queue is counted in bytes, so `controller.desiredSize` reports what this
      // body still holds unread rather than how many frames have arrived.
      { highWaterMark: this.#maxQueuedBytes, size: (chunk) => chunk.byteLength },
    )

    let pending!: Pending
    const response = new Promise<Response>((resolve, reject) => {
      pending = {
        streamId,
        index,
        stream,
        controller,
        resolve,
        reject,
        signal,
        onAbort: undefined,
        headersSent: false,
      }
    })

    const headers = headerPairs(init.headers)

    // Registered before the first write because a duplex may answer synchronously
    // inside `write` and settle this entry: a listener attached after that point would
    // outlive the request on the caller's signal. A failed write settles the entry too,
    // which removes this listener.
    this.#pending.set(index, pending)
    this.#byId.set(streamId, pending)
    if (signal !== undefined) {
      pending.onAbort = () => {
        this.#cancel(pending)
      }
      signal.addEventListener('abort', pending.onAbort, { once: true })
    }

    try {
      this.#duplex.write(
        encodeControl({
          streamId,
          index,
          type: 'request',
          url,
          method: init.method ?? 'GET',
          headers,
          body: body !== undefined,
        }),
      )
      if (body !== undefined) {
        for (let offset = 0; offset < body.byteLength; offset += MAX_BODY_FRAME_BYTES) {
          this.#duplex.write(encodeBody(index, body.subarray(offset, offset + MAX_BODY_FRAME_BYTES)))
        }
        this.#duplex.write(encodeControl({ streamId, type: 'body-end' }))
      }
    } catch (error) {
      const failure = new BridgeError(
        'child-error',
        `writing to the transport child failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      // A synchronously replying duplex may already have settled this entry — and its
      // promise — from inside the write that failed. Only an entry still owned here is
      // failed and released; either way the caller adopts the same `response` promise
      // every other path returns, so no second rejected promise is left unhandled and
      // no request is left without an outcome.
      if (this.#pending.has(pending.index)) {
        if (pending.headersSent) pending.controller.error(failure)
        else pending.reject(failure)
        this.#settle(pending)
      }
      return response
    }

    return response
  }

  /** Terminates the child and rejects everything in flight. */
  dispose(): void {
    this.#failAll(new BridgeError('cancelled'))
    this.#duplex.kill()
  }

  /**
   * Tells the child to abandon one stream and stops tracking it, at most once.
   *
   * The response body's cancellation and the caller's abort both arrive here, so the
   * entry's presence is what makes a release idempotent: whichever runs first sends the
   * single cancel frame the child expects, and the other is a no-op.
   *
   * Ownership is revoked before that frame is written. A duplex may deliver the child's
   * own end or error for this stream from inside the write, and a still-owned entry
   * would hand those frames to a controller whose body the consumer already abandoned —
   * closing an aborted body as if it had completed.
   *
   * @param pending - The stream to release.
   * @returns Whether this call was the one that released the stream.
   */
  #release(pending: Pending): boolean {
    if (!this.#pending.has(pending.index)) return false
    this.#settle(pending)
    try {
      this.#duplex.write(encodeControl({ streamId: pending.streamId, type: 'cancel' }))
    } catch (_writeFailure) {
      // A failed write only means the child never learned it was released; the stream
      // is no longer tracked either way.
    }
    return true
  }

  /**
   * Stops one request because its caller aborted: releases it upstream and fails the
   * caller locally.
   *
   * @param pending - The stream to cancel.
   */
  #cancel(pending: Pending): void {
    if (!this.#release(pending)) return
    const error = new BridgeError('cancelled')
    if (pending.headersSent) pending.controller.error(error)
    else pending.reject(error)
  }

  #onFrames(frames: readonly Frame[]): void {
    for (const frame of frames) {
      if (frame.tag === 2) {
        const pending = this.#pending.get(frame.streamIndex)
        if (pending === undefined) continue
        try {
          pending.controller.enqueue(frame.bytes)
        } catch {
          // The consumer cancelled or the stream already closed: stop tracking it.
          this.#settle(pending)
          continue
        }
        // The queue's remaining byte capacity: an enqueue subtracts the chunk and a
        // consumer read returns what it took, so a negative value is exactly this
        // stream's unread backlog exceeding its cap. A chunk a pending read was already
        // waiting for is handed over without entering the queue, so it leaves this
        // unchanged and cannot trip the cap; the frame codec bounds that chunk instead.
        const remaining = pending.controller.desiredSize
        if (remaining !== null && remaining < 0) {
          const error = new BridgeError(
            'backpressure',
            `${String(this.#maxQueuedBytes - remaining)} bytes unread`,
          )
          // Ownership is revoked and the child is told to abandon the request before
          // the body is failed, exactly as a caller abort does it.
          this.#release(pending)
          if (pending.headersSent) pending.controller.error(error)
          else pending.reject(error)
        }
        continue
      }
      const { message } = frame
      const streamId = message['streamId']
      if (typeof streamId !== 'string') continue
      const pending = this.#byId.get(streamId)
      if (pending === undefined) continue

      const type = message['type']
      if (type === 'response') {
        const status = typeof message['status'] === 'number' ? message['status'] : 502
        if (status < 200 || status > 599) {
          pending.reject(new BridgeError('invalid-status', String(status)))
          this.#settle(pending)
          continue
        }
        const headers = new Headers()
        const list = message['headers']
        if (Array.isArray(list)) {
          for (const pair of list) {
            if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
              headers.append(pair[0], pair[1])
            }
          }
        }
        pending.headersSent = true
        // A status that forbids a body cannot be constructed with one.
        pending.resolve(
          NULL_BODY_STATUSES.has(status)
            ? new Response(null, { status, headers })
            : new Response(pending.stream, { status, headers }),
        )
        if (NULL_BODY_STATUSES.has(status)) this.#settle(pending)
        continue
      }
      if (type === 'end') {
        if (!pending.headersSent) {
          pending.reject(new BridgeError('child-error', 'stream ended before its response head'))
        } else {
          pending.controller.close()
        }
        this.#settle(pending)
        continue
      }
      if (type === 'error') {
        const detail = typeof message['message'] === 'string' ? message['message'] : 'unknown'
        const error = new BridgeError('remote-error', detail)
        if (pending.headersSent) pending.controller.error(error)
        else pending.reject(error)
        this.#settle(pending)
      }
    }
  }

  #settle(pending: Pending): void {
    this.#pending.delete(pending.index)
    this.#byId.delete(pending.streamId)
    if (pending.onAbort !== undefined) {
      pending.signal?.removeEventListener('abort', pending.onAbort)
    }
  }

  #failAll(error: BridgeError): void {
    this.#dead ??= error
    for (const pending of this.#pending.values()) {
      if (pending.headersSent) pending.controller.error(error)
      else pending.reject(error)
    }
    for (const pending of this.#pending.values()) {
      if (pending.onAbort !== undefined) {
        pending.signal?.removeEventListener('abort', pending.onAbort)
      }
    }
    this.#pending.clear()
    this.#byId.clear()
  }
}

/**
 * Converts a caller's headers to the ordered pairs the frame protocol carries.
 *
 * Field names go out exactly as the caller spelled them, in the caller's order:
 * the genuine Claude Code request is identified partly by its mixed casing, and
 * a standard `Headers` folds every name and may combine or reorder fields.
 *
 * @param init - The caller's header init.
 * @returns Field name and value pairs in the caller's order.
 */
function headerPairs(init: HeadersInit | undefined): string[][] {
  if (init === undefined) return []
  if (init instanceof Headers) {
    // The caller already folded these through a `Headers`; there is no casing
    // left here to preserve.
    const folded: string[][] = []
    init.forEach((value, key) => {
      folded.push([key, value])
    })
    return folded
  }
  if (Array.isArray(init)) {
    return init.map(([name, value]) => [String(name), String(value)])
  }
  return Object.entries(init).map(([name, value]) => [name, String(value)])
}

/**
 * Converts a caller body to the bytes the frame protocol carries.
 *
 * @param body - The caller's body, if any.
 * @returns The bytes, or undefined when there is no body.
 * @throws BridgeError when the body is a form this protocol cannot carry, because
 *   sending the request without it would be worse than refusing it.
 */
function bodyBytes(body: RequestInit['body']): Uint8Array | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  throw new BridgeError(
    'unsupported-body',
    `this transport carries string and byte bodies, not ${body.constructor?.name ?? typeof body}`,
  )
}

/**
 * Spawns the built child under the Bun runtime and returns a duplex to it.
 *
 * @param options - Command and arguments for the child.
 * @returns A duplex whose exit handler fires on `exit` or `error`.
 */
/**
 * The environment the transport child runs with.
 *
 * The child issues the Messages request itself, so it needs the path, the proxy and the
 * trust-anchor variables the host was launched with — and nothing else. Inheriting the
 * whole environment would hand a pinned foreign runtime every unrelated secret the host
 * happens to hold.
 *
 * @param env - the host environment.
 * @returns the variables to pass, omitting the ones that are unset.
 */
export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {}
  for (const name of CHILD_ENV_NAMES) {
    const value = env[name]
    if (value !== undefined) kept[name] = value
  }
  return kept
}

/** Variables the child may see: process basics, proxies, and TLS trust anchors. */
const CHILD_ENV_NAMES: readonly string[] = [
  'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]

export function spawnBunChild(options: {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
}): BridgeDuplex {
  const child = spawn(options.command, [...options.args], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: childEnvironment(process.env),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  })
  let exited = false
  const report = (reason: string): void => {
    if (exited) return
    exited = true
    exitHandler?.(reason)
  }
  let exitHandler: ((reason: string) => void) | undefined
  // A write racing the child's death surfaces here rather than as an unhandled
  // stream error inside the host.
  child.stdin.on('error', (error: Error) => {
    report(`${error.name}: ${error.message}`)
  })
  return {
    write(bytes) {
      child.stdin.write(bytes)
    },
    onData(handler) {
      child.stdout.on('data', (chunk: Buffer) => {
        handler(new Uint8Array(chunk))
      })
    },
    onExit(handler) {
      exitHandler = handler
      child.on('error', (error) => {
        report(`${error.name}: ${error.message}`)
      })
      child.on('exit', (code, signal) => {
        report(`exit ${String(code)} signal ${String(signal)}`)
      })
      if (exited) handler('child already gone')
    },
    kill() {
      child.kill()
    },
  }
}
