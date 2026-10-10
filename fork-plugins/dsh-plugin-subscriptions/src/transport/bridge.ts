/**
 * Client side of the Bun stdio transport.
 *
 * Owns one long-lived Bun child, multiplexes requests over it by `streamId`, and
 * presents each response as a web `Response` whose body streams from the frames.
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
 * Queued response bytes a stream may fall behind by before the bridge gives up.
 *
 * A consumer that stops reading would otherwise grow the queue for the life of a
 * long-lived child. The cap converts that into a diagnosable failure.
 */
const MAX_QUEUED_BYTES = 32 * 1024 * 1024

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
  queued: number
}

/** A started bridge. */
export class BunBridge {
  readonly #duplex: BridgeDuplex
  readonly #decoder = new FrameDecoder()
  readonly #pending = new Map<number, Pending>()
  readonly #byId = new Map<string, Pending>()
  #nextIndex = 0
  #dead: BridgeError | undefined

  /**
   * @param duplex - Bytes-level channel to the child.
   */
  constructor(duplex: BridgeDuplex) {
    this.#duplex = duplex
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
   * @returns The response, with a body that streams from the child.
   * @throws BridgeError for a dead child, an unsupported body form, or a write
   *   failure; the caller decides whether to retry.
   */
  async request(url: string, init: RequestInit): Promise<Response> {
    if (this.#dead !== undefined) throw this.#dead
    const streamId = randomUUID()
    const index = this.#nextIndex
    this.#nextIndex += 1

    const body = bodyBytes(init.body)

    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c
      },
    })

    let pending!: Pending
    const response = new Promise<Response>((resolve, reject) => {
      pending = {
        streamId,
        index,
        stream,
        controller,
        resolve,
        reject,
        signal: init.signal ?? undefined,
        onAbort: undefined,
        headersSent: false,
        queued: 0,
      }
    })

    const headers: string[][] = []
    new Headers(init.headers).forEach((value, key) => {
      headers.push([key, value])
    })

    // Registered before the first write: a duplex may answer synchronously, and a
    // response arriving before the entry existed would be dropped and the request
    // would never settle. A failed write settles the entry instead of leaking it.
    this.#pending.set(index, pending)
    this.#byId.set(streamId, pending)

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
      this.#settle(pending)
      throw new BridgeError(
        'child-error',
        `writing to the transport child failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const signal = init.signal
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) {
        this.#cancel(pending)
      } else {
        pending.onAbort = () => {
          this.#cancel(pending)
        }
        signal.addEventListener('abort', pending.onAbort, { once: true })
      }
    }

    return response
  }

  /** Terminates the child and rejects everything in flight. */
  dispose(): void {
    this.#failAll(new BridgeError('cancelled'))
    this.#duplex.kill()
  }

  /**
   * Stops one request: tells the child to abandon it and fails the caller locally.
   *
   * @param pending - The stream to cancel.
   */
  #cancel(pending: Pending): void {
    if (!this.#pending.has(pending.index)) return
    try {
      this.#duplex.write(encodeControl({ streamId: pending.streamId, type: 'cancel' }))
    } catch {
      // The child is already gone; the exit path settles this entry.
    }
    const error = new BridgeError('cancelled')
    if (pending.headersSent) pending.controller.error(error)
    else pending.reject(error)
    this.#settle(pending)
  }

  #onFrames(frames: readonly Frame[]): void {
    for (const frame of frames) {
      if (frame.tag === 2) {
        const pending = this.#pending.get(frame.streamIndex)
        if (pending === undefined) continue
        pending.queued += frame.bytes.byteLength
        if (pending.queued > MAX_QUEUED_BYTES) {
          const error = new BridgeError('backpressure', `${pending.queued} bytes unread`)
          if (pending.headersSent) pending.controller.error(error)
          else pending.reject(error)
          this.#settle(pending)
          continue
        }
        try {
          pending.controller.enqueue(frame.bytes)
        } catch {
          // The consumer cancelled or the stream already closed: stop tracking it.
          this.#settle(pending)
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
