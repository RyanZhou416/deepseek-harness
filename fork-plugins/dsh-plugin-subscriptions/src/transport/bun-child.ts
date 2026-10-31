/**
 * Bun-side transport child.
 *
 * Runs under Bun and issues each framed request with the global `fetch`, so the
 * request leaves the machine through the same TLS stack, header serialization and
 * connection handling the target client uses. The header plan is the caller's and
 * crosses unchanged, including the pinned runtime pair: the child reports the
 * identity the request claims, not the runtime that happens to issue it. It never
 * listens on a socket.
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
 *
 * Control ingestion never waits for a stream: each request is dispatched onto a
 * tracked task, so a cancel or a later request is answered while an earlier
 * response body is still being read. One `run` owns its own streams, codec and
 * tasks, so two instances never share state.
 */

import { once } from 'node:events'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { FrameDecoder, encodeBody, encodeControl, type Frame } from './frames.js'

/**
 * Issues one request.
 *
 * Production uses the runtime's global `fetch`; a test or an in-process harness
 * substitutes a double so the lifecycle is exercisable without network egress.
 */
export type TransportFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * Writes one whole encoded frame.
 *
 * Every call carries exactly one `encodeControl`/`encodeBody` result: a frame's
 * bytes are never split, a stream's response head is awaited before its body
 * frames, and each stream's frames reach the client in the order it awaited them.
 * Different streams may interleave between frames.
 */
export type FrameWriter = (bytes: Uint8Array) => Promise<void>

/** A condition the child cannot report through a stream. */
export interface TransportDiagnostic {
  /** Human-readable detail. */
  readonly detail: string
  /** Whether the frame stream is unusable, which fails the child once it stops. */
  readonly fatal: boolean
}

/** Runtime edges a caller may replace; production defaults use the process the child runs on. */
export interface TransportChildOptions {
  /** Issues each request. Defaults to the global `fetch`. */
  readonly fetch?: TransportFetch
  /** Writes one encoded frame. Defaults to a backpressure-aware write to stdout. */
  readonly write?: FrameWriter
  /** Receives diagnostics. Defaults to stderr, plus a failing exit code when fatal. */
  readonly report?: (diagnostic: TransportDiagnostic) => void
}

interface StreamState {
  readonly streamId: string
  readonly index: number
  readonly chunks: Uint8Array[]
  readonly request: Record<string, unknown>
  readonly abort: AbortController
  cancelled: boolean
  dispatched: boolean
}

const defaultFetch: TransportFetch = (url, init) => fetch(url, init)

async function defaultWrite(bytes: Uint8Array): Promise<void> {
  // Respecting the pipe's backpressure keeps a slow reader from buffering whole
  // responses inside the child.
  if (!process.stdout.write(bytes)) {
    await once(process.stdout, 'drain')
  }
}

function defaultReport(diagnostic: TransportDiagnostic): void {
  process.stderr.write(`${diagnostic.detail}\n`)
  if (diagnostic.fatal) process.exitCode = 1
}

/**
 * Delivers a diagnostic without letting the sink break the child.
 *
 * The sink is caller-supplied, so a throw from it would otherwise replace the
 * failure being reported, escape into the cleanup of the stream that reported it,
 * or reject the run's own shutdown path.
 *
 * @param report - The sink to deliver to.
 * @param diagnostic - The condition being reported.
 */
function reportSafely(
  report: (diagnostic: TransportDiagnostic) => void,
  diagnostic: TransportDiagnostic,
): void {
  try {
    report(diagnostic)
  } catch (error) {
    process.stderr.write(`${diagnostic.detail} (report failed: ${describe(error)})\n`)
  }
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
 * One child run: the streams it owns, the tasks those streams started, and the
 * edges it writes and fetches through.
 *
 * The state is per instance rather than per module so two runs in one process —
 * a test beside the real child, or a harness that starts the loop twice — cannot
 * address each other's streams or share a decoder's buffered bytes.
 */
class ChildSession {
  readonly #fetch: TransportFetch
  readonly #write: FrameWriter
  readonly #report: (diagnostic: TransportDiagnostic) => void
  readonly #streams = new Map<string, StreamState>()
  readonly #indexToStream = new Map<number, string>()
  readonly #active = new Set<Promise<void>>()

  /**
   * @param options - Runtime edges to replace; omitted edges keep production behavior.
   */
  constructor(options: TransportChildOptions) {
    this.#fetch = options.fetch ?? defaultFetch
    this.#write = options.write ?? defaultWrite
    this.#report = options.report ?? defaultReport
  }

  /**
   * Ingests one decoded frame.
   *
   * Returns as soon as the frame has been recorded or dispatched; the write or
   * request it starts is owned by the session's task set, never by this call.
   *
   * @param frame - The frame decoded from the client's bytes.
   */
  handle(frame: Frame): void {
    if (frame.tag === 2) {
      const streamId = this.#indexToStream.get(frame.streamIndex)
      const state = streamId === undefined ? undefined : this.#streams.get(streamId)
      if (state === undefined) {
        this.#diagnose('bridge child: body frame for an unknown stream index', false)
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
      this.#open(streamId, message)
      return
    }
    const state = this.#streams.get(streamId)
    if (state === undefined) return
    if (type === 'body-end') {
      this.#launch(state)
      return
    }
    if (type === 'cancel') {
      this.#cancel(state)
    }
  }

  /**
   * Aborts every live stream and waits until the work they started has stopped.
   *
   * Called when the frame stream is over, whatever ended it: an unfinished upload
   * releases its buffered bytes here, a response body still being read is
   * interrupted by the same abort the client's cancel uses, and a frame already
   * handed to the writer is awaited rather than abandoned.
   */
  async shutdown(): Promise<void> {
    for (const state of [...this.#streams.values()]) {
      this.#cancel(state)
    }
    while (this.#active.size > 0) {
      await Promise.allSettled([...this.#active])
    }
  }

  /**
   * Registers a request and dispatches it immediately when it carries no body.
   *
   * A `request` naming a live stream id supersedes it whatever the new frame's
   * index turns out to be, so an unusable index cannot leave the superseded
   * stream registered with nothing addressing it.
   */
  #open(streamId: string, message: Record<string, unknown>): void {
    const previous = this.#streams.get(streamId)
    if (previous !== undefined) {
      // The old work is aborted and unregistered here, so its late frames cannot
      // be published as the new stream's and its cleanup cannot unregister the
      // replacement.
      this.#cancel(previous)
    }
    const index = message['index']
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 0xffffffff) {
      // Without a usable index this stream could not be answered coherently.
      this.#sendQuietly({ streamId, type: 'error', message: 'request needs a uint32 stream index' })
      return
    }
    const state: StreamState = {
      streamId,
      index,
      chunks: [],
      request: message,
      abort: new AbortController(),
      cancelled: false,
      dispatched: false,
    }
    this.#streams.set(streamId, state)
    this.#indexToStream.set(index, streamId)
    if (message['body'] !== true) this.#launch(state)
  }

  /** Stops one stream: its pending fetch or body read sees the abort, its bytes are dropped. */
  #cancel(state: StreamState): void {
    state.cancelled = true
    state.abort.abort()
    this.#forget(state)
  }

  /** Starts one stream's request at most once, however many body-end frames name it. */
  #launch(state: StreamState): void {
    if (state.dispatched) return
    state.dispatched = true
    this.#track(this.#finish(state))
  }

  /**
   * Owns a task for the session's lifetime.
   *
   * Every frame the child starts — a request, or a control frame no caller awaits
   * — is tracked here, so `shutdown` waits for the bytes it began writing instead
   * of returning while a write is still in flight.
   *
   * @param task - The work to await at shutdown.
   */
  #track(task: Promise<void>): void {
    this.#active.add(task)
    const settled = (): void => {
      this.#active.delete(task)
    }
    void task.then(settled, settled)
  }

  async #finish(state: StreamState): Promise<void> {
    try {
      await this.#issue(state)
    } catch (error) {
      // `issue` reports its own failures; this is the last line of defence so a
      // rejection can never take the child down with it.
      this.#diagnose(`bridge child: ${describe(error)}`, false)
    } finally {
      this.#forget(state)
    }
  }

  async #issue(state: StreamState): Promise<void> {
    const request = state.request
    const url = request['url']
    const method = request['method']
    if (typeof url !== 'string' || typeof method !== 'string') {
      await this.#fail(state, 'request needs a url and a method')
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
          typeof pair[1] === 'string'
        ) {
          list.push([pair[0], pair[1]])
        }
      }
      // The plan carries the pinned desktop identity, including the runtime pair;
      // the child carries it unchanged rather than reporting the runtime it happens
      // to run on, which would name a runtime the claimed client is not.
      init.headers = list
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
      response = await this.#fetch(url, init)
    } catch (error) {
      if (state.cancelled) return
      await this.#fail(state, describe(error))
      return
    }
    if (state.cancelled) return

    const outHeaders: string[][] = []
    response.headers.forEach((value, key) => {
      outHeaders.push([key, value])
    })
    await this.#writeOwned(state, {
      streamId: state.streamId,
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
            if (state.cancelled) return
            if (value !== undefined) await this.#writeBody(state, value)
          }
        } finally {
          reader.releaseLock()
        }
      }
    } catch (error) {
      if (!state.cancelled) await this.#fail(state, describe(error))
      return
    }
    if (state.cancelled) return
    await this.#writeOwned(state, { streamId: state.streamId, type: 'end' })
  }

  async #fail(state: StreamState, detail: string): Promise<void> {
    await this.#writeOwned(state, { streamId: state.streamId, type: 'error', message: detail })
  }

  async #writeControl(message: Record<string, unknown>): Promise<void> {
    await this.#write(encodeControl(message))
  }

  /** Publishes one response chunk under the index the stream registered. */
  async #writeBody(state: StreamState, bytes: Uint8Array): Promise<void> {
    if (!this.#owns(state)) return
    await this.#write(encodeBody(state.index, bytes))
  }

  /**
   * Publishes one control frame for a stream that still owns its stream id.
   *
   * A frame the writer has already been handed is not retracted; this only stops
   * a cancelled or superseded stream from starting another one.
   */
  async #writeOwned(state: StreamState, message: Record<string, unknown>): Promise<void> {
    if (!this.#owns(state)) return
    await this.#writeControl(message)
  }

  /** Writes a control frame no caller awaits, as a tracked task. */
  #sendQuietly(message: Record<string, unknown>): void {
    this.#track(
      this.#writeControl(message).catch((error: unknown) => {
        // No stream is waiting on this frame, so its failure goes to the
        // diagnostic sink instead of rejecting an unobserved task.
        this.#diagnose(`bridge child: writing a control frame failed: ${describe(error)}`, false)
      }),
    )
  }

  /** Delivers a diagnostic through the caller's sink, contained. */
  #diagnose(detail: string, fatal: boolean): void {
    reportSafely(this.#report, { detail, fatal })
  }

  /** Whether a stream is still the registered owner of its stream id. */
  #owns(state: StreamState): boolean {
    return this.#streams.get(state.streamId) === state
  }

  /**
   * Drops everything a finished stream held.
   *
   * Idempotent, and it only unregisters the stream it was handed: a stream id
   * re-registered after this one ended keeps its own mapping.
   *
   * @param state - The stream to unregister.
   */
  #forget(state: StreamState): void {
    state.chunks.length = 0
    if (!this.#owns(state)) return
    this.#streams.delete(state.streamId)
    if (this.#indexToStream.get(state.index) === state.streamId) {
      this.#indexToStream.delete(state.index)
    }
  }
}

/**
 * Runs the frame loop until the input ends, then stops every stream it started.
 *
 * Control frames are ingested as they arrive and the work they start is tracked
 * per stream instead of awaited here, so a cancel or a later request is answered
 * while an earlier response body is still being read.
 *
 * @param input - Frame bytes from the client. Defaults to the child's stdin.
 * @param options - Runtime edges to replace. The defaults fetch with the global
 *   `fetch` and write to the child's stdout.
 * @returns A promise that settles once the input ended or failed and every
 *   stream this run started has stopped.
 */
export async function run(
  input: Readable = process.stdin,
  options: TransportChildOptions = {},
): Promise<void> {
  const session = new ChildSession(options)
  const report = options.report ?? defaultReport
  const decoder = new FrameDecoder()
  try {
    for await (const chunk of input) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      const frames = decoder.push(bytes)
      const failure = decoder.error
      if (failure !== undefined) {
        // The stream is out of step; every later boundary would be guesswork, so the
        // child stops and the client fails everything in flight.
        reportSafely(report, {
          detail: `bridge child: frame stream desynchronized (${failure.reason})`,
          fatal: true,
        })
        return
      }
      for (const frame of frames) session.handle(frame)
    }
  } catch (error) {
    // A read failure leaves the frame stream unfinished: the client is told, and
    // the streams already started are aborted by the shutdown below.
    reportSafely(report, { detail: `bridge child: ${describe(error)}`, fatal: true })
  } finally {
    await session.shutdown()
  }
}

/**
 * Reports whether a module is the file this process was started with.
 *
 * `import.meta.url` is a URL and `process.argv[1]` is the path the operating system
 * handed the runtime, so the two spellings differ wherever the install path holds a
 * byte a URL must escape: a space, `#`, `%` or a non-ASCII character stays literal in
 * argv and arrives percent-encoded in the URL. Only the converted filesystem paths are
 * comparable, and the comparison must be exact — a suffix test would also accept a
 * different file whose path merely ends with the entry path.
 *
 * Both sides are canonical: symlinks are resolved, because the loader and the parent
 * can reach one file through different links, and Windows paths are folded to one case,
 * because that filesystem is case-insensitive. A path that no longer resolves is
 * compared as spelled, so a child whose entry was removed still decides this once.
 *
 * @param moduleUrl - The candidate module's `import.meta.url`.
 * @param argvPath - The entry path the parent passed as `process.argv[1]`.
 * @returns Whether the candidate module is this process's entry point.
 */
export function isMainEntry(moduleUrl: string, argvPath: string | undefined): boolean {
  if (argvPath === undefined || argvPath === '') return false
  let modulePath: string
  try {
    modulePath = fileURLToPath(moduleUrl)
  } catch (urlError: unknown) {
    // A non-file URL has no entry path to compare.
    void urlError
    return false
  }
  return canonicalPath(modulePath) === canonicalPath(argvPath)
}

/**
 * The comparable form of one filesystem path.
 *
 * @param path - The path to make canonical.
 * @returns The absolute, symlink-free path, case-folded on Windows.
 */
function canonicalPath(path: string): string {
  let canonical = resolve(path)
  try {
    canonical = realpathSync(canonical)
  } catch (pathError: unknown) {
    // The file may already be gone; compare its absolute spelled path instead.
    void pathError
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

if (isMainEntry(import.meta.url, process.argv[1])) {
  await run()
}
