/**
 * Per-session ordering for mac-pool streams.
 *
 * The pool binds one conversation to the `X-Claude-Code-Session-Id` header and
 * admits one in-flight direct request per bound session; a concurrent second
 * request for that session is refused with `cc_pool_session_busy` instead of
 * waiting. The harness can issue concurrent requests for one session (for
 * example a main turn and its automatic title call), so this gate queues
 * streams by `options.sessionId`: the second request opens the upstream only
 * after the first stream settled, while different sessions keep running
 * concurrently and still consume pool slots independently. It adds no global
 * or per-IP queue: the pool's own slot limiter stays the only admission
 * control between sessions.
 *
 * The pool releases the previous stream's lease slightly after its last chunk
 * reaches the client, so the next request for that session can still be refused
 * once — whether it queued behind the release or arrived after the stream
 * settled locally. Every same-session request that has not forwarded content yet
 * gets the same bounded, cancellable retry for that one code. Every other
 * refusal, including the global-slot `cc_pool_rate_limited` 429 and its
 * `Retry-After`, is delivered unchanged: `dsh-llm-retry` owns those.
 *
 * @module @deepseek-ai/dsh-llm-cc-pool/session-gate
 */
import { LlmError, POOL_SESSION_BUSY_CODE } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/**
 * Delay before each session-busy retry, in order. The lease usually releases
 * within the first pause; the full list bounds the wait at 1.8 s so a leaked
 * pool lease surfaces as the original refusal instead of hanging the turn.
 */
const SESSION_BUSY_DELAYS_MS: readonly number[] = Object.freeze([
  100, 200, 250, 250, 250, 250, 250, 250,
])

/** Releases one held session; calling it again has no effect. */
export type SessionRelease = () => void

/** How a request left its wait for a session. */
export type SessionTurnOutcome =
  /** The request owns the session until it calls the release. */
  | { readonly kind: 'granted'; readonly release: SessionRelease }
  /** The caller aborted the request while it waited. */
  | { readonly kind: 'aborted'; readonly error: LlmError }
  /** The stream was abandoned before its turn arrived. */
  | { readonly kind: 'closed' }

/** One request's slot in its session's queue. */
export interface SessionTurn {
  /** Settles once the request owns the session or has left the queue. */
  readonly ready: Promise<SessionTurnOutcome>
  /** Leave the queue, or release the session when the turn was already granted. */
  skip(): void
}

/** One stream to run under its session's queue. */
export interface SessionStreamRequest {
  /** Request session identity; every request carrying it is ordered with its peers. */
  readonly sessionId: string
  /** Caller cancellation; aborts a queued wait and the busy retry delay. */
  readonly signal: AbortSignal | undefined
  /** Opens the upstream stream once this request owns the session. */
  readonly open: () => AsyncIterable<StreamChunk>
}

/** One queued request awaiting its turn. */
interface Waiter {
  /** Hand the session over; false when this waiter already settled. */
  grant(): boolean
  /** Settle as aborted; ignored once granted or skipped. */
  abort(error: LlmError): void
}

/** One session's queue; the map entry exists only while that session is busy. */
interface Lane {
  readonly waiters: Waiter[]
}

/** The terminal stream result shared by every normal completion path. */
function finished(): IteratorResult<StreamChunk> {
  return { done: true, value: undefined }
}

/**
 * The cancellation a queued request reports when its caller aborts. `ABORTED`
 * is the harness code for caller cancellation, so `LlmRuntime.stream()` settles
 * the call as an aborted finish.
 * @param sessionId - session whose queue held the request.
 * @param signal - the aborted caller signal.
 * @returns the failure the waiting stream throws.
 */
function abortError(sessionId: string, signal: AbortSignal): LlmError {
  return new LlmError(
    `llm-cc-pool: request for session "${sessionId}" was aborted while waiting for that session`,
    'ABORTED',
    { cause: signal.reason },
  )
}

/**
 * Wait one retry delay.
 * @param delayMs - how long to wait.
 * @param signal - caller cancellation; undefined waits the full delay.
 * @returns true when the delay elapsed, false when the signal aborted first.
 */
function pause(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * FIFO admission per session over the pool's one-in-flight request rule.
 *
 * A lane exists only while its session has a started stream or waiters, so idle
 * sessions leave no entry behind and merely creating a stream takes no lane: a
 * stream whose consumer never reads it cannot wedge the session. The lane is
 * acquired on the stream's first read. Aborting a waiting request removes it
 * from the queue immediately; skipping an unopened stream does the same, and a
 * skipped or aborted holder hands its lane to the next waiter.
 */
export class SessionSerialGate {
  private readonly lanes = new Map<string, Lane>()

  /** Sessions currently holding or waiting for a turn; zero when the route is idle. */
  get activeSessions(): number {
    return this.lanes.size
  }

  /**
   * Wrap one stream in its session's queue.
   * @param request - session identity, caller cancellation, and the stream opener.
   * @returns a stream whose upstream opens only after the session's earlier streams settled.
   */
  serialize(request: SessionStreamRequest): AsyncIterable<StreamChunk> {
    return new SerializedStream(request, () => this.acquire(request.sessionId, request.signal))
  }

  /**
   * Abort every queued request and drop all lanes. A holder is left alone: its
   * own stream settles when the fiber tears its consumer down, and rejecting
   * queued requests is what prevents a shutdown from waiting on a queue that
   * can never drain.
   */
  dispose(): void {
    const lanes = [...this.lanes.values()]
    this.lanes.clear()
    const error = new LlmError(
      'llm-cc-pool: the route was disposed while this request waited for its session',
      'ABORTED',
    )
    for (const lane of lanes) {
      for (const waiter of lane.waiters.splice(0)) waiter.abort(error)
    }
  }

  /**
   * Take the next slot for one session: an idle session is granted at once,
   * otherwise the request is queued in call order.
   * @param sessionId - session identity to serialize on.
   * @param signal - caller cancellation for a queued wait.
   * @returns the request's place in the queue.
   */
  private acquire(sessionId: string, signal: AbortSignal | undefined): SessionTurn {
    const lane = this.lanes.get(sessionId)
    if (lane !== undefined) return this.enqueue(sessionId, lane, signal)

    const created: Lane = { waiters: [] }
    this.lanes.set(sessionId, created)
    let held = true
    const release: SessionRelease = () => {
      if (!held) return
      held = false
      this.handOver(sessionId, created)
    }
    return {
      ready: Promise.resolve({ kind: 'granted', release }),
      skip: release,
    }
  }

  /**
   * Queue one request behind the current holder.
   * @param sessionId - session identity to serialize on.
   * @param lane - the busy session's lane.
   * @param signal - caller cancellation for this wait.
   * @returns the queued request's turn.
   */
  private enqueue(sessionId: string, lane: Lane, signal: AbortSignal | undefined): SessionTurn {
    if (signal?.aborted === true) {
      return {
        ready: Promise.resolve({ kind: 'aborted', error: abortError(sessionId, signal) }),
        skip: () => {},
      }
    }

    /* v8 ignore next -- definite-assignment placeholder; the promise executor replaces it synchronously. */
    let settle: (outcome: SessionTurnOutcome) => void = () => {}
    const ready = new Promise<SessionTurnOutcome>((resolve) => { settle = resolve })

    let state: 'waiting' | 'granted' | 'settled' = 'waiting'
    let release: SessionRelease | undefined
    let detach = (): void => {}

    const waiter: Waiter = {
      grant: () => {
        /* v8 ignore if -- handOver shifts only a waiter still in the queue; abort and skip splice themselves out. */
        if (state !== 'waiting') return false
        state = 'granted'
        detach()
        let handed = false
        release = () => {
          if (handed) return
          handed = true
          this.handOver(sessionId, lane)
        }
        settle({ kind: 'granted', release })
        return true
      },
      abort: (error) => {
        /* v8 ignore if -- grant and skip detach this listener before they settle the turn. */
        if (state !== 'waiting') return
        state = 'settled'
        detach()
        const index = lane.waiters.indexOf(waiter)
        if (index >= 0) lane.waiters.splice(index, 1)
        settle({ kind: 'aborted', error })
      },
    }
    const skip = (): void => {
      if (state === 'waiting') {
        state = 'settled'
        detach()
        const index = lane.waiters.indexOf(waiter)
        /* v8 ignore if -- a waiting waiter is removed from the queue only by this skip or an abort, which settles it first. */
        if (index >= 0) lane.waiters.splice(index, 1)
        settle({ kind: 'closed' })
        return
      }
      release?.()
    }
    if (signal !== undefined) {
      const abortSignal = signal
      const onAbort = (): void => { waiter.abort(abortError(sessionId, abortSignal)) }
      abortSignal.addEventListener('abort', onAbort, { once: true })
      detach = () => { abortSignal.removeEventListener('abort', onAbort) }
    }
    lane.waiters.push(waiter)
    return { ready, skip }
  }

  /**
   * Pass a settled session to its next live waiter, or drop the lane when no
   * request is left.
   * @param sessionId - session being released.
   * @param lane - the lane being released.
   */
  private handOver(sessionId: string, lane: Lane): void {
    while (true) {
      const waiter = lane.waiters.shift()
      if (waiter === undefined) {
        if (this.lanes.get(sessionId) === lane) this.lanes.delete(sessionId)
        return
      }
      /* v8 ignore else -- a settled waiter leaves the queue, so grant always takes its turn. */
      if (waiter.grant()) return
    }
  }
}

/**
 * One queued stream. It takes its queue slot on the first read, waits for its
 * turn, opens the upstream through the supplied opener, and replaces a
 * session-busy refusal with a bounded retry until the stream has forwarded model
 * content. An absorbed attempt contributes nothing to the consumer: model
 * content already forwarded is never repeated, and the refusal's in-band usage
 * sample is dropped with it.
 */
class SerializedStream implements AsyncIterableIterator<StreamChunk> {
  private closed = false
  private acquired = false
  private turn: SessionTurn | undefined
  private inner: AsyncIterator<StreamChunk> | undefined
  /** A chunk read ahead while a usage sample is held for the refusal check. */
  private held: StreamChunk | undefined
  private emitted = false
  private busyRetries = 0

  /**
   * @param request - session identity, caller cancellation, and the stream opener.
   * @param acquire - takes this request's queue slot once the stream is read.
   */
  constructor(
    private readonly request: SessionStreamRequest,
    private readonly acquire: () => SessionTurn,
  ) {}

  /** This stream is its own iterator; the queue owns one consumer. */
  [Symbol.asyncIterator](): AsyncIterableIterator<StreamChunk> {
    return this
  }

  /**
   * Produce the next upstream chunk, waiting for the session and retrying a
   * session-busy refusal while the stream has forwarded nothing yet. A stream
   * that is never read never takes a queue slot, so dropping the iterable leaves
   * the session free. A failure to open or read the upstream releases the held
   * session instead of leaving the lane behind.
   * @returns the next chunk, or a done result once the upstream settled.
   */
  async next(): Promise<IteratorResult<StreamChunk>> {
    try {
      while (!this.closed) {
        if (!this.acquired) {
          if (!await this.takeTurn()) return finished()
          continue
        }
        if (this.inner === undefined) {
          this.inner = this.request.open()[Symbol.asyncIterator]()
        }
        const chunk = await this.readChunk(this.inner)
        if (chunk === undefined) {
          this.close()
          return finished()
        }
        if (this.absorbsBusy(chunk)) {
          await this.retry()
          continue
        }
        if (chunk.type !== 'finish') this.emitted = true
        return { done: false, value: chunk }
      }
      return finished()
    } catch (error: unknown) {
      this.close()
      throw error
    }
  }

  /**
   * Read the next chunk to forward. A usage sample is held until the following
   * event proves the attempt is not an absorbed refusal, so a refused attempt
   * contributes no token sample either.
   * @param inner - the current upstream attempt.
   * @returns the next chunk, or undefined when the upstream settled.
   */
  private async readChunk(inner: AsyncIterator<StreamChunk>): Promise<StreamChunk | undefined> {
    const held = this.held
    if (held !== undefined) {
      this.held = undefined
      return held
    }
    const result = await inner.next()
    if (result.done === true) return undefined
    if (result.value.type !== 'usage') return result.value
    const follow = await inner.next()
    // An upstream that ends after its usage sample without a terminal chunk is
    // malformed; forwarding the sample leaves the next read to report the end.
    if (follow.done === true) return result.value
    if (this.absorbsBusy(follow.value)) return follow.value
    this.held = follow.value
    return result.value
  }

  /**
   * Stop the stream and release the session, closing the upstream first so the
   * next same-session request does not open against a lease the pool has not
   * released yet.
   * @returns a done result, as the iterator protocol requires.
   */
  async return(): Promise<IteratorResult<StreamChunk>> {
    const inner = this.inner
    try {
      if (inner !== undefined && inner.return !== undefined) await inner.return(undefined)
    } finally {
      this.close()
    }
    return finished()
  }

  /**
   * Take this stream's queue slot if it has not taken it yet, then wait for it
   * and apply the caller cancellation that arrived while the request was queued.
   * @returns true when the stream may open its upstream.
   */
  private async takeTurn(): Promise<boolean> {
    const turn = this.turn ??= this.acquire()
    const outcome = await turn.ready
    if (this.closed) {
      if (outcome.kind === 'granted') outcome.release()
      return false
    }
    switch (outcome.kind) {
      case 'granted': {
        this.acquired = true
        const signal = this.request.signal
        if (signal?.aborted === true) {
          this.close()
          throw abortError(this.request.sessionId, signal)
        }
        return true
      }
      case 'aborted':
        this.closed = true
        throw outcome.error
      /* v8 ignore next -- close() marks the stream closed before skip() settles its turn as closed. */
      case 'closed':
        this.closed = true
        return false
    }
  }

  /**
   * Whether a chunk is the pool's lease-release refusal on a stream that has
   * not forwarded model content yet.
   * @param chunk - the chunk just read from the upstream.
   * @returns true when this chunk is replaced by one bounded retry.
   */
  private absorbsBusy(chunk: StreamChunk): boolean {
    return !this.emitted
      && this.busyRetries < SESSION_BUSY_DELAYS_MS.length
      && chunk.type === 'finish'
      && chunk.reason.kind === 'error'
      && chunk.reason.failure.code === POOL_SESSION_BUSY_CODE
  }

  /**
   * Close the refused attempt, wait the next bounded delay, and leave the
   * stream ready to open one more attempt while still holding the session.
   */
  private async retry(): Promise<void> {
    /* v8 ignore next -- the frozen delay list is never empty; the fallback only discharges noUncheckedIndexedAccess. */
    const lastDelay = SESSION_BUSY_DELAYS_MS[SESSION_BUSY_DELAYS_MS.length - 1] ?? 250
    /* v8 ignore next -- retry() runs only while busyRetries is below the delay list's length. */
    const delay = SESSION_BUSY_DELAYS_MS[this.busyRetries] ?? lastDelay
    this.busyRetries += 1
    const inner = this.inner
    this.inner = undefined
    try {
      if (inner !== undefined && inner.return !== undefined) await inner.return(undefined)
    } catch {
      // A refused attempt's terminal chunk already settled it; a cleanup
      // failure must not replace the retry that chunk asks for.
    }
    const signal = this.request.signal
    if (!await pause(delay, signal)) {
      this.close()
      throw new LlmError(
        `llm-cc-pool: request for session "${this.request.sessionId}" was aborted while retrying a busy session`,
        'ABORTED',
        /* v8 ignore next -- pause() reports false only after the caller signal aborted. */
        signal === undefined ? undefined : { cause: signal.reason },
      )
    }
  }

  /** Mark the stream finished and release whatever queue state it still holds. */
  private close(): void {
    if (this.closed) return
    this.closed = true
    this.turn?.skip()
  }
}
