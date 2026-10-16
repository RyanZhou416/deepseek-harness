/**
 * The transport seam, the module-owned deadline and the owned response body.
 *
 * This module never calls `fetch` and never builds a proxy: the caller injects the transport,
 * which carries whatever egress (a per-account proxy today) that caller owns, and which must
 * honour the request's abort signal. What this module adds on top of `claude-core`'s transport
 * contract is a per-request deadline it schedules itself — with an injectable timer — and an
 * owned response body whose reader this module cancels when that deadline or the caller's
 * cancellation wins.
 *
 * Owning the reader is what makes that release real. Cancelling the stream itself throws while a
 * reader holds its lock, and waiting for the transport to notice the abort would make the release
 * depend on the transport rather than on this module. `claude-core`'s `readBoundedBody` cannot be
 * cancelled from outside once it holds the lock, so this module reads its own bodies; the byte
 * bound, the truncation verdict and the release-on-every-path semantics are the same.
 *
 * @module dsh-plugin-subscriptions/claude-account-client/wire
 */

import type { CoreHttpRequest, CoreHttpResponse } from '../claude-core/policy-limits-client.js'

/** One outbound request: the core's request shape, so an injected `CoreTransport` fits. */
export type ClaudeAccountRequest = CoreHttpRequest

/**
 * A response as this client reads it, plus the redirect evidence a transport may report.
 *
 * The two extra fields are optional so a plain `CoreTransport` (which returns only the core's
 * three fields) is accepted: a transport that cannot report a redirect simply reports none, and
 * the caller's own transport contract is what forbids following one.
 */
export interface ClaudeAccountResponse extends CoreHttpResponse {
  /** Whether the transport followed a redirect to reach this response. */
  readonly redirected?: boolean
  /** The URL the transport actually reached, when it reports one. */
  readonly url?: string
}

/**
 * The injected transport. It must not read a credential, choose an account or pick a proxy, and
 * it must honour `request.signal`: this client aborts it on its own deadline and on the caller's
 * cancellation. That obligation covers the request itself; a response body this client owns is
 * released by this client, not by the transport.
 */
export type ClaudeAccountTransport = (request: ClaudeAccountRequest) => Promise<ClaudeAccountResponse>

/**
 * The injected one-shot deadline scheduler.
 *
 * `arm` returns the cancel handle for the deadline it armed. A module that could only use the
 * ambient `setTimeout` could not be driven by a caller's own clock, so the timer is a parameter
 * rather than an ambient resource; the default is the process's own.
 */
export interface ClaudeAccountTimers {
  /** Arm one deadline, in milliseconds, and return its cancel handle. */
  arm(delayMs: number, onDeadline: () => void): () => void
}

/** The process timer this client uses when the caller injects none. */
export const CLAUDE_SYSTEM_TIMERS: ClaudeAccountTimers = Object.freeze({
  arm(delayMs: number, onDeadline: () => void): () => void {
    const handle = setTimeout(onDeadline, delayMs)
    handle.unref?.()
    return () => {
      clearTimeout(handle)
    }
  },
})

/** The abort reason this module's own deadline carries. */
const CLAUDE_DEADLINE_REASON = 'claude-account-client deadline'

/** One step's result inside a deadline scope. */
type ClaudeStep<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error?: unknown }

/** The losing side of a race; it never carries a value. */
const CLAUDE_STEP_LOST: ClaudeStep<never> = Object.freeze({ ok: false })

/** One request's deadline, its request signal and the classification of who ended it. */
interface ClaudeDeadlineScope {
  /** The signal the transport must carry; the caller's own cancellation is composed into it. */
  readonly signal: AbortSignal
  /** True once this module's deadline fired. */
  expired(): boolean
  /** True when the caller's own signal aborted. */
  cancelled(): boolean
  /** Run one step under the deadline; a deadline or a cancellation settles the race, not throws. */
  run<T>(step: () => Promise<T>): Promise<ClaudeStep<T>>
  /** Disarm the deadline and detach the caller's listener. */
  close(): void
}

/**
 * Build one request's deadline scope.
 * @param input - the bound, the injected timers and the caller's optional cancellation.
 * @returns the scope; the caller must `close()` it on every path.
 */
function claudeDeadlineScope(input: {
  readonly timeoutMs: number
  readonly timers: ClaudeAccountTimers
  readonly signal?: AbortSignal
}): ClaudeDeadlineScope {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    // A bound that cannot expire would silently disable the deadline this scope exists for.
    throw new Error('claude account client timeoutMs must be a positive finite number of milliseconds')
  }
  const caller = input.signal
  const controller = new AbortController()
  let expired = false
  let closed = false
  let cancelDeadline: () => void = () => undefined
  let settleCancelled: () => void = () => undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    cancelDeadline = input.timers.arm(input.timeoutMs, () => {
      expired = true
      controller.abort(CLAUDE_DEADLINE_REASON)
      reject(new Error(CLAUDE_DEADLINE_REASON))
    })
  })
  // The losing sides of a race never settle the caller's promise, so their settlement is observed
  // here rather than surfacing as an unhandled rejection.
  const lost: Promise<ClaudeStep<never>> = deadline.catch(() => CLAUDE_STEP_LOST)
  const cancelledStep = new Promise<ClaudeStep<never>>(resolve => {
    settleCancelled = () => resolve(CLAUDE_STEP_LOST)
  })
  const onCallerAbort = (): void => {
    // The controller abort releases whatever body this request owns; settling the step stops the
    // caller's own wait at once instead of leaving it until the deadline.
    controller.abort(caller?.reason)
    settleCancelled()
  }
  if (caller !== undefined) {
    if (caller.aborted) onCallerAbort()
    else caller.addEventListener('abort', onCallerAbort, { once: true })
  }
  return {
    signal: controller.signal,
    expired: () => expired,
    cancelled: () => caller?.aborted === true,
    async run<T>(step: () => Promise<T>): Promise<ClaudeStep<T>> {
      if (expired) return CLAUDE_STEP_LOST
      if (caller?.aborted === true) return CLAUDE_STEP_LOST
      const settled = step().then(
        (value: T): ClaudeStep<T> => ({ ok: true, value }),
        (error: unknown): ClaudeStep<T> => ({ ok: false, error }),
      )
      return await Promise.race([settled, lost, cancelledStep])
    },
    close(): void {
      if (closed) return
      closed = true
      cancelDeadline()
      caller?.removeEventListener('abort', onCallerAbort)
    },
  }
}

/** Whether a body is a `ReadableStream` rather than a plain async iterable. */
function isReadableStream(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): body is ReadableStream<Uint8Array> {
  return typeof (body as ReadableStream<Uint8Array>).getReader === 'function'
}

/**
 * The body of one response this exchange owns.
 *
 * A handler consumes it through {@link ClaudeResponseBody.read}; the exchange releases it when the
 * deadline or the caller's cancellation wins. At most one read is taken, and it is the only reader
 * this body ever gets.
 */
export interface ClaudeResponseBody {
  /**
   * Consume the body under a bound.
   *
   * The bound is inclusive: a chunk that exactly fills it is complete and only a chunk that
   * exceeds it is truncated, at which point the reader is cancelled rather than accumulated
   * further. A second call is a programming error.
   * @param limit - the byte bound.
   * @returns the consumed text and whether the bound was reached.
   */
  read(limit: number): Promise<{ text: string; truncated: boolean }>
}

/** One owned body, with the release paths the exchange drives. */
interface ClaudeOwnedBody extends ClaudeResponseBody {
  readonly response: ClaudeAccountResponse
  /** Release the body without consuming it: cancel the held reader, or the stream itself. */
  release(): Promise<void>
  /** Settle once the read in flight has released its reader. */
  settle(): Promise<void>
}

/**
 * Take ownership of one response body.
 *
 * The returned object is the only reader this body gets. `release()` is idempotent and never
 * rejects: it cancels the reader a pending read holds — the one cancel that actually settles that
 * read — or cancels the stream when no read was taken.
 * @param response - the response whose body to own.
 * @returns the owned body.
 */
function ownClaudeBody(response: ClaudeAccountResponse): ClaudeOwnedBody {
  const body = response.body
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let iterator: AsyncIterator<Uint8Array> | undefined
  let inFlight: Promise<void> | undefined
  let claimed = false
  let finished = false

  const cancelRead = (): void => {
    // Cancelling the reader is what makes a pending `read()` resolve; cancelling the stream would
    // throw while that reader holds the lock.
    if (reader !== undefined) {
      void reader.cancel().catch(() => undefined)
      return
    }
    if (iterator !== undefined) void Promise.resolve(iterator.return?.()).catch(() => undefined)
  }

  const settle = async (): Promise<void> => {
    if (inFlight === undefined) return
    try {
      await inFlight
    } catch {
      // The read's own caller classifies its outcome; this only waits for the release.
    }
  }

  const cancelStream = async (): Promise<void> => {
    if (body === null || body === undefined) return
    try {
      if (isReadableStream(body)) await body.cancel()
      else await body[Symbol.asyncIterator]().return?.()
    } catch {
      // A body already consumed, cancelled or errored cannot be released twice.
    }
  }

  const read = async (limit: number): Promise<{ text: string; truncated: boolean }> => {
    if (claimed) throw new Error('claude account client response body was read twice')
    claimed = true
    // A body released before its read started is already closed; reading it would take a second
    // reader from a stream this exchange has finished with.
    if (finished) return { text: '', truncated: false }
    const decoder = new TextDecoder()
    let text = ''
    let bytes = 0
    const push = (chunk: Uint8Array): boolean => {
      const room = limit - bytes
      if (chunk.byteLength > room) {
        text += decoder.decode(chunk.subarray(0, Math.max(room, 0)))
        return true
      }
      bytes += chunk.byteLength
      text += decoder.decode(chunk, { stream: true })
      return false
    }
    const run = async (): Promise<{ text: string; truncated: boolean }> => {
      if (body === null || body === undefined) return { text: '', truncated: false }
      if (isReadableStream(body)) {
        const held = body.getReader()
        reader = held
        try {
          for (;;) {
            const { done, value } = await held.read()
            if (done) break
            if (value === undefined) continue
            if (push(value)) {
              await held.cancel().catch(() => undefined)
              return { text: text + decoder.decode(), truncated: true }
            }
          }
          return { text: text + decoder.decode(), truncated: false }
        } finally {
          reader = undefined
          finished = true
          try {
            held.releaseLock()
          } catch {
            // A release racing a cancel is the one case the stream may refuse.
          }
        }
      }
      const held = body[Symbol.asyncIterator]()
      iterator = held
      try {
        for (;;) {
          const next = await held.next()
          if (next.done === true) break
          if (push(next.value)) {
            await held.return?.()
            return { text: text + decoder.decode(), truncated: true }
          }
        }
        return { text: text + decoder.decode(), truncated: false }
      } finally {
        iterator = undefined
        finished = true
        await held.return?.()
      }
    }
    const pending = run()
    inFlight = pending.then(() => undefined, () => undefined)
    return await pending
  }

  return {
    response,
    read,
    async release(): Promise<void> {
      if (finished) return
      if (claimed) {
        cancelRead()
        await settle()
        return
      }
      // No read was taken, so the stream itself is still free to cancel.
      finished = true
      await cancelStream()
    },
    settle,
  }
}

/**
 * Consume one response body under a hard bound.
 *
 * This is the direct form, for a caller that holds a raw response and drives no deadline of its
 * own. A body is read or released exactly once; inside {@link exchangeClaudeRequest} the handler
 * reads the owned body it is given instead, so cancellation stays with the exchange.
 * @param response - the response whose body to consume.
 * @param limit - the byte bound.
 * @returns the consumed text and whether the bound was reached.
 */
export async function readClaudeBody(
  response: ClaudeAccountResponse,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const owned = ownClaudeBody(response)
  try {
    return await owned.read(limit)
  } finally {
    await owned.release()
  }
}

/**
 * Release one response body this read will not consume.
 *
 * No read may be in flight against the same response when this is called: the only safe way to
 * release a body whose read is pending is the exchange's own cancellation.
 * @param response - the response whose body to release.
 */
export async function cancelClaudeBody(response: ClaudeAccountResponse): Promise<void> {
  await ownClaudeBody(response).release()
}

/** One outbound exchange: the request and the seams that carry it. */
export interface ClaudeExchange {
  /** The pinned endpoint for this role. */
  readonly url: string
  /** The method this role uses; both roles here are bodyless GETs or one JSON POST. */
  readonly method: 'GET' | 'POST'
  /** Every header this role decided. */
  readonly headers: Readonly<Record<string, string>>
  /** The request body, or `null` for the bodyless GET. */
  readonly body: string | null
  /** The bound on the whole exchange, this client's own deadline included. */
  readonly timeoutMs: number
  /** The injected transport that carries the account's egress. */
  readonly transport: ClaudeAccountTransport
  /** The injected deadline scheduler. */
  readonly timers: ClaudeAccountTimers
  /** Caller cancellation. */
  readonly signal?: AbortSignal
}

/** What one exchange resolved to. */
export type ClaudeExchangeOutcome<T> =
  /** The handler read the response; its value is the caller's typed outcome. */
  | { readonly kind: 'handled'; readonly value: T }
  /** This module's deadline fired; the transport was aborted and the body released. */
  | { readonly kind: 'timeout' }
  /** The caller's signal aborted. */
  | { readonly kind: 'cancelled' }
  /** No response arrived. */
  | { readonly kind: 'unreachable' }

/**
 * Send one request and read its answer entirely inside this module's deadline.
 *
 * The deadline covers the transport and the handler's own read of the body, not just the response
 * headers. Whichever side wins — the deadline, the caller's cancellation, or the answer — the body
 * this exchange owns is released before this function returns, including a response that only
 * arrives after the race was already lost. One call is exactly one request; this helper never
 * replays, because the service may already have spent the grant.
 * @param exchange - the request, the transport and the deadline.
 * @param handle - reads the owned body inside the deadline and returns the typed answer.
 * @returns what the exchange produced, with the deadline's own verdict kept separate.
 * @throws Error when the handler itself throws, which is a programming error, not an outcome.
 */
export async function exchangeClaudeRequest<T>(
  exchange: ClaudeExchange,
  handle: (response: ClaudeAccountResponse, body: ClaudeResponseBody) => Promise<T>,
): Promise<ClaudeExchangeOutcome<T>> {
  const scope = claudeDeadlineScope(exchange)
  const abandoned = new Set<ClaudeOwnedBody>()
  let current: ClaudeOwnedBody | undefined
  let closed = false

  const abandon = (owned: ClaudeOwnedBody): void => {
    if (abandoned.has(owned)) return
    abandoned.add(owned)
    void owned.release()
  }

  // The deadline and the caller's cancellation both abort this signal. Whichever wins, the body
  // this exchange currently owns stops being read and its reader is released, so the release does
  // not depend on the transport noticing the abort.
  const onAbort = (): void => {
    if (current !== undefined) abandon(current)
  }
  scope.signal.addEventListener('abort', onAbort, { once: true })

  const quiesce = async (): Promise<void> => {
    for (const owned of abandoned) await owned.settle()
  }

  try {
    const sent = await scope.run(async () => {
      const received = await exchange.transport({
        url: exchange.url,
        method: exchange.method,
        headers: exchange.headers,
        body: exchange.body,
        signal: scope.signal,
        timeoutMs: exchange.timeoutMs,
      })
      const owned = ownClaudeBody(received)
      current = owned
      // A response that arrives after the race was lost — the deadline fired or the caller
      // aborted — is cancelled here rather than handed on: this exchange has already returned, so
      // nothing else owns these bytes.
      if (closed || scope.expired() || scope.cancelled()) {
        abandon(owned)
        throw new Error('claude account client abandoned a response that arrived after its deadline')
      }
      return owned
    })
    if (!sent.ok) {
      if (current !== undefined) abandon(current)
      await quiesce()
      return claudeScopeOutcome(scope)
    }
    const owned = sent.value
    current = owned
    if (scope.cancelled()) {
      abandon(owned)
      await quiesce()
      return { kind: 'cancelled' }
    }
    const handled = await scope.run(async () => await handle(owned.response, owned))
    if (!handled.ok) {
      abandon(owned)
      await quiesce()
      if (scope.expired()) return { kind: 'timeout' }
      if (scope.cancelled()) return { kind: 'cancelled' }
      throw handled.error
    }
    if (scope.cancelled()) return { kind: 'cancelled' }
    return { kind: 'handled', value: handled.value }
  } finally {
    // Every return path above has already released and settled what it owns; this covers the
    // success path and any throw, and it is idempotent for the rest.
    closed = true
    scope.signal.removeEventListener('abort', onAbort)
    if (current !== undefined) abandon(current)
    await quiesce()
    scope.close()
  }
}

/**
 * Name who ended a step that produced no value.
 * @param scope - the deadline scope.
 * @returns the timeout, cancellation or unreachable outcome.
 */
function claudeScopeOutcome<T>(scope: ClaudeDeadlineScope): ClaudeExchangeOutcome<T> {
  if (scope.expired()) return { kind: 'timeout' }
  if (scope.cancelled()) return { kind: 'cancelled' }
  return { kind: 'unreachable' }
}
