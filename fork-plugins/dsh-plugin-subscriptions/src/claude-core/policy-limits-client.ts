/**
 * The bounded `policy_limits` request reader.
 *
 * It performs one logical request (transport, status classification, the pinned retry
 * budget, cancellation) and returns a decision for its owner to schedule. It never selects
 * an account, never refreshes a credential and never starts a timer: the caller injects the
 * transport, the clock, the sleep, the access token and the one bounded reauthorization, and
 * owns every recovery step this reader only reports.
 */

import { coreFailure, skipRetryForStatus } from './failures.js'
import type { CoreFailure } from './failures.js'
import { parsePolicyLimitsDocument, policyValidator } from './policy-limits.js'
import type { PolicyLimitsDocument, PolicySnapshot } from './policy-limits.js'

/** A response as this core needs to read it; `fetch`'s `Response` satisfies it. */
export interface CoreHttpResponse {
  readonly status: number
  readonly headers: { get(name: string): string | null }
  /**
   * The unread body. The core pulls it itself under its byte bound, so a transport must NOT
   * pre-read it into a string: a stream is cancelled and its reader released the moment the
   * bound is reached. `fetch`'s `Response.body` satisfies this.
   */
  readonly body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | null
}

/** One outbound request, with every header the caller decided for this role. */
export interface CoreHttpRequest {
  readonly url: string
  readonly method: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  /** Request body, or `null` for the bodyless POST the organization validation sends. */
  readonly body: string | null
  readonly signal: AbortSignal
  /** Bound on the transport's own wait, in milliseconds. */
  readonly timeoutMs: number
}

/** The injected transport. It must not read a credential or choose an account. */
export type CoreTransport = (request: CoreHttpRequest) => Promise<CoreHttpResponse>

/** The injected clock. */
export interface CoreClock {
  /** Current epoch milliseconds. */
  now(): number
}

/** The injected sleep; it resolves early when the signal aborts. */
export type CoreSleep = (ms: number, signal: AbortSignal) => Promise<void>

/** The pinned request bound. */
export const POLICY_LIMITS_TIMEOUT_MS = 10_000

/** The pinned retry budget: attempts after the first one. */
export const POLICY_LIMITS_RETRIES = 5

/**
 * The authentication replay budget: one extra request after a rejected credential.
 *
 * It is its own explicit budget, outside the retry loop, because a replay answers an
 * authentication result rather than a retryable failure — and it is the credential owner's
 * injected callback that decides what that replay is, not this reader.
 */
export const AUTH_REPLAY_BUDGET = 1

/** The pinned backoff base, ceiling and jitter share. */
export const POLICY_LIMITS_BACKOFF_BASE_MS = 500
export const POLICY_LIMITS_BACKOFF_CAP_MS = 32_000
export const POLICY_LIMITS_BACKOFF_JITTER = 0.25

/**
 * The cap on the response body this reader consumes, in bytes.
 *
 * This bound is this build's own product guard, not a pinned constant of the analyzed client:
 * the client reads its body through its own transport with no such fixed byte cap, so a
 * deployment that needs a different bound changes this one deliberately. A body over it is a
 * terminal `unsupported` outcome (`skipRetry`), never a parse failure to retry: re-pulling the
 * same oversized document five more times cannot make it fit.
 */
export const POLICY_LIMITS_BODY_LIMIT = 65_536

/**
 * The context a read may lean on, stated by the caller that owns it.
 *
 * It is the same three states its own status projection carries (`PolicyLimitsStatus.fallback`):
 * `live` when an accepted document is in force, `stale` when one is kept through an earlier
 * failed read, and `none` when the caller holds nothing at all. The fail-open answer is for
 * `none` only; under `live` or `stale` the read fails and the caller keeps what it has.
 */
export type PolicyPriorContext = 'live' | 'stale' | 'none'

/**
 * Consume one response body under a hard bound.
 *
 * The body must be read on every outcome, not only when a 200 is parsed: an unread body
 * keeps the connection pinned, and the deadline is only meaningful once the bytes are
 * actually covered. A body over the cap is truncated for classification purposes and
 * reported as truncated, never accumulated further.
 * @param response - the response whose body to consume.
 * @param limit - the byte bound.
 * @returns the consumed text and whether the bound was reached.
 */
export async function readBoundedBody(
  response: CoreHttpResponse,
  limit: number = POLICY_LIMITS_BODY_LIMIT,
): Promise<{ text: string; truncated: boolean }> {
  const decoder = new TextDecoder()
  const body = response.body
  if (body === null) return { text: '', truncated: false }
  let text = ''
  let bytes = 0
  const push = (chunk: Uint8Array): boolean => {
    const room = limit - bytes
    // A chunk that exactly fills the remaining bound is complete; only a chunk that exceeds
    // it is truncated, so the bound is inclusive.
    if (chunk.byteLength > room) {
      text += decoder.decode(chunk.subarray(0, Math.max(room, 0)))
      return true
    }
    bytes += chunk.byteLength
    text += decoder.decode(chunk, { stream: true })
    return false
  }
  if (isReadableStream(body)) {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        if (push(value)) {
          await reader.cancel().catch(() => undefined)
          return { text: text + decoder.decode(), truncated: true }
        }
      }
      return { text: text + decoder.decode(), truncated: false }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // A release racing a cancel is the one case the stream may refuse.
      }
    }
  }
  const iterator = body[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) break
      if (push(next.value)) {
        await iterator.return?.()
        return { text: text + decoder.decode(), truncated: true }
      }
    }
    return { text: text + decoder.decode(), truncated: false }
  } finally {
    await iterator.return?.()
  }
}

/** Whether a body is a ReadableStream rather than a plain async iterable. */
function isReadableStream(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): body is ReadableStream<Uint8Array> {
  return typeof (body as ReadableStream<Uint8Array>).getReader === 'function'
}

/** A response validator header, when the transport exposes headers case-insensitively. */
function headerValue(response: CoreHttpResponse, name: string): string | undefined {
  const value = response.headers.get(name)
  return value === null || value.length === 0 ? undefined : value
}

/**
 * The pinned backoff for one attempt, honouring a `Retry-After` the response stated.
 * @param attempt - zero-based attempt index.
 * @param retryAfterMs - the delay the response asked for, in milliseconds.
 * @param random - injected randomness, so the jitter is deterministic under test.
 * @returns the delay in milliseconds.
 */
export function policyBackoffMs(attempt: number, retryAfterMs: number | undefined, random: () => number): number {
  const base = Math.min(POLICY_LIMITS_BACKOFF_BASE_MS * 2 ** attempt, POLICY_LIMITS_BACKOFF_CAP_MS)
  const jittered = base + (random() * 2 - 1) * POLICY_LIMITS_BACKOFF_JITTER * base
  const computed = Math.max(Math.round(jittered), POLICY_LIMITS_BACKOFF_BASE_MS)
  return retryAfterMs === undefined ? computed : Math.max(retryAfterMs, computed)
}

/** Parse a `Retry-After` header, in seconds, into milliseconds. */
function retryAfterMs(response: CoreHttpResponse): number | undefined {
  const raw = headerValue(response, 'retry-after')
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

/** One `policy_limits` read operation. */
export interface PolicyLimitsReadOperation {
  /** The endpoint, built by the caller from its own base URL. */
  readonly url: string
  /** The access token for this account; the caller selected and refreshed it. */
  readonly accessToken: string
  /** The user agent for this role. */
  readonly userAgent: string
  /** The live session policy's validator (`s`), when one is loaded. */
  readonly validator?: string
  /** Whether any 2xx is accepted instead of only 200 (`acceptAny2xx`). */
  readonly acceptAny2xx?: boolean
  /** The injected transport. */
  readonly transport: CoreTransport
  /** The injected clock. */
  readonly clock: CoreClock
  /** The injected sleep. */
  readonly sleep: CoreSleep
  /** Injected randomness for the backoff jitter; defaults to `Math.random`. */
  readonly random?: () => number
  /** Caller cancellation. */
  readonly signal?: AbortSignal
  /**
   * The unified classifier for a non-success response, handed the body this reader already
   * consumed exactly once. The version and permission refusals live there, and its
   * `skipRetry` is what makes a refusal terminal for both ends; the classifier owns no side
   * effect (a shared protocol-block record stays the caller's).
   */
  readonly classifyFailure?: (input: {
    readonly status: number
    readonly headers: { get(name: string): string | null }
    readonly body: string
    readonly truncated: boolean
  }) => Promise<CoreFailure | undefined>
  /**
   * One bounded reauthorization, performed by the credential owner. The reader calls it at
   * most once and never refreshes anything itself.
   * @returns the replacement access token.
   */
  readonly reauthorize?: () => Promise<string>
  /** When true, a parse failure is terminal instead of retryable. */
  readonly parseFailureIsTerminal?: boolean
  /**
   * When true, a 404 or an unsolicited 304 that finds no prior policy in force (`none`) is
   * answered as a fail-open empty policy; the caller states this from its own
   * `rustlingOrbit` input. With a `live` or `stale` prior it changes nothing: that answer is
   * for a route this caller has never read, never for replacing a rule already in force.
   */
  readonly failOpenOnMissingRoute?: boolean
  /**
   * What the caller already holds for this account; see {@link PolicyPriorContext}.
   *
   * A caller that omits it is read as `live` when it sent a validator and `none` otherwise,
   * which is the safe inference: no prior context is ever assumed to be a usable `stale`
   * document, so a 404/304 can only fail open for a caller that holds nothing.
   */
  readonly priorContext?: PolicyPriorContext
}

/** What one logical request resolved to. */
export type PolicyLimitsOutcome =
  | {
    /** A 200 was parsed, or a 304 revalidated the session policy. */
    readonly kind: 'success'
    /** The parsed document, or `null` for a 304 revalidation. */
    readonly response: PolicyLimitsDocument | null
    /** The validator of the body, absent for a 304. */
    readonly validator?: string
    /** The `signature` header, when the response carried one. */
    readonly signature?: string
    readonly attempts: number
  }
  | {
    /**
     * The pinned fail-open answer for a missing route, produced only for a caller whose
     * `priorContext` is `none`; see the current-state note in the README.
     */
    readonly kind: 'fail_open_empty'
    readonly reason: 'route_missing_fail_open' | 'unsolicited_304_fail_open'
    readonly attempts: number
  }
  | {
    /**
     * The request failed; the caller owns every recovery decision and keeps its own adopted
     * document, which this reader neither reads nor clears.
     */
    readonly kind: 'failure'
    readonly failure: CoreFailure
    readonly attempts: number
    /** Always `caller`: this reader schedules nothing. It sends at most the injected replay. */
    readonly recoveryOwner: 'caller'
  }
  | { readonly kind: 'cancelled'; readonly attempts: number }

/**
 * Read the policy document once, with the pinned retry budget.
 *
 * The fail-open answer is produced only for a caller whose prior context is `none`; every other
 * failed read is returned as a failure, and the caller keeps the document it already holds.
 * @param operation - the endpoint, credential, injected transport and classification hooks.
 * @returns the outcome, with the attempt count and the recovery owner on failure.
 */
export async function readPolicyLimits(operation: PolicyLimitsReadOperation): Promise<PolicyLimitsOutcome> {
  const random = operation.random ?? Math.random
  const classifier = operation.classifyFailure
  // Read through a call: the abort can land between two checks, and a narrowed comparison
  // would miss it.
  const cancelled = (): boolean => operation.signal?.aborted === true
  // A caller that states no prior is inferred as `live` only when it sent the conditional
  // validator that a `live` document is the sole source of; otherwise it holds nothing.
  const prior: PolicyPriorContext = operation.priorContext
    ?? (operation.validator === undefined ? 'none' : 'live')
  let accessToken = operation.accessToken
  let replays = 0
  let attempts = 0
  let retries = 0

  for (;;) {
    if (cancelled()) return { kind: 'cancelled', attempts }
    const headers: Record<string, string> = {
      'user-agent': operation.userAgent,
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      authorization: `Bearer ${accessToken}`,
    }
    if (operation.validator !== undefined) headers['if-none-match'] = `"${operation.validator}"`
    attempts += 1
    let response: CoreHttpResponse
    try {
      response = await operation.transport({
        url: operation.url,
        method: 'GET',
        headers,
        body: null,
        signal: operation.signal ?? new AbortController().signal,
        timeoutMs: POLICY_LIMITS_TIMEOUT_MS,
      })
    } catch {
      if (cancelled()) return { kind: 'cancelled', attempts }
      const failure = coreFailure('request_failed', { reason: 'transport' })
      if (retries >= POLICY_LIMITS_RETRIES) return { kind: 'failure', failure, attempts, recoveryOwner: 'caller' }
      await operation.sleep(policyBackoffMs(retries, undefined, random), operation.signal ?? new AbortController().signal)
      retries += 1
      continue
    }
    if (cancelled()) return { kind: 'cancelled', attempts }
    const status = response.status
    const accepted = status === 200 || (operation.acceptAny2xx === true && status >= 200 && status < 300)

    if (status === 304) {
      // A 304 carries no body to parse; consuming it keeps the connection free either way.
      try {
        await readBoundedBody(response)
      } catch {
        // A body that cannot be read does not change the revalidation outcome.
      }
      // A caller that aborted while the body was being consumed is cancelled, not
      // revalidated: the cancellation outranks the answer that already arrived.
      if (cancelled()) return { kind: 'cancelled', attempts }
      // A 304 revalidates only the conditional request a `live` document produced. A caller
      // that states `none` or `stale` sent no such validator, so an answer here is
      // unsolicited: it is the same missing-route question a 404 asks, and only a caller
      // holding nothing may have it answered fail-open.
      if (prior === 'live' && operation.validator !== undefined) {
        return { kind: 'success', response: null, attempts }
      }
      if (prior === 'none' && operation.failOpenOnMissingRoute === true) {
        return { kind: 'fail_open_empty', reason: 'unsolicited_304_fail_open', attempts }
      }
      return {
        kind: 'failure',
        failure: coreFailure('request_failed', { status, skipRetry: true, reason: 'unexpected_304' }),
        attempts,
        recoveryOwner: 'caller',
      }
    }
    if (accepted) {
      let body: { text: string; truncated: boolean }
      try {
        body = await readBoundedBody(response)
      } catch {
        body = { text: '', truncated: false }
      }
      if (cancelled()) return { kind: 'cancelled', attempts }
      if (body.truncated) {
        // The product bound, not a schema failure: the document is refused outright and never
        // re-pulled. Neither the bytes nor any excerpt of them is carried in the failure.
        return {
          kind: 'failure',
          failure: coreFailure('unsupported', { status, skipRetry: true, reason: 'body_over_limit' }),
          attempts,
          recoveryOwner: 'caller',
        }
      }
      let raw: unknown
      try {
        raw = JSON.parse(body.text)
      } catch {
        const failure = coreFailure('parse_failed', { status })
        if (operation.parseFailureIsTerminal === true || retries >= POLICY_LIMITS_RETRIES) {
          return {
            kind: 'failure',
            failure: { ...failure, skipRetry: operation.parseFailureIsTerminal === true },
            attempts,
            recoveryOwner: 'caller',
          }
        }
        await operation.sleep(policyBackoffMs(retries, retryAfterMs(response), random), operation.signal ?? new AbortController().signal)
        retries += 1
        continue
      }
      const parsed = parsePolicyLimitsDocument(raw)
      if (!parsed.ok) {
        // `shimmyingStardust`: with it false (the deployment default) a schema failure is
        // retried inside the same budget; with it true the failure is terminal at once.
        if (operation.parseFailureIsTerminal === true) {
          return {
            kind: 'failure',
            failure: { ...parsed.failure, skipRetry: true },
            attempts,
            recoveryOwner: 'caller',
          }
        }
        if (retries >= POLICY_LIMITS_RETRIES) {
          return { kind: 'failure', failure: parsed.failure, attempts, recoveryOwner: 'caller' }
        }
        await operation.sleep(policyBackoffMs(retries, retryAfterMs(response), random), operation.signal ?? new AbortController().signal)
        retries += 1
        continue
      }
      return {
        kind: 'success',
        response: parsed.document,
        validator: await policyValidator(raw),
        ...headerValue(response, 'signature') === undefined ? {} : { signature: headerValue(response, 'signature')! },
        attempts,
      }
    }
    // One bounded read per failed response, handed to the classifier as data. The
    // classifier never receives the response object, so nothing is read twice and no body
    // escapes into a cause or a message.
    let consumed: { text: string; truncated: boolean } = { text: '', truncated: false }
    try {
      consumed = await readBoundedBody(response)
    } catch {
      consumed = { text: '', truncated: false }
    }
    if (cancelled()) return { kind: 'cancelled', attempts }
    const classified = classifier === undefined
      ? undefined
      : await classifier({ status, headers: response.headers, body: consumed.text, truncated: consumed.truncated })
    if (classified !== undefined && classified.skipRetry === true) {
      // A refusal outranks the authentication branch: a version or permission refusal is
      // never answered with a credential replay.
      return { kind: 'failure', failure: classified, attempts, recoveryOwner: 'caller' }
    }
    if (consumed.truncated) {
      // The product bound is terminal on this branch too: whatever the status meant, another
      // request would re-pull the same oversized body. The bytes never reach the caller.
      return {
        kind: 'failure',
        failure: coreFailure('unsupported', { status, skipRetry: true, reason: 'body_over_limit' }),
        attempts,
        recoveryOwner: 'caller',
      }
    }
    if (status === 401 && operation.reauthorize !== undefined && replays < AUTH_REPLAY_BUDGET) {
      replays += 1
      try {
        accessToken = await operation.reauthorize()
      } catch {
        return {
          kind: 'failure',
          failure: coreFailure('auth_failed', { status, skipRetry: true }),
          attempts,
          recoveryOwner: 'caller',
        }
      }
      // The replay is its own explicitly budgeted request, not a discounted retry.
      continue
    }
    if (classified !== undefined) {
      if (retries >= POLICY_LIMITS_RETRIES) {
        return { kind: 'failure', failure: classified, attempts, recoveryOwner: 'caller' }
      }
      await operation.sleep(policyBackoffMs(retries, retryAfterMs(response), random), operation.signal ?? new AbortController().signal)
      retries += 1
      continue
    }
    if (status === 401) {
      return {
        kind: 'failure',
        failure: coreFailure('auth_failed', { status, skipRetry: true }),
        attempts,
        recoveryOwner: 'caller',
      }
    }
    const skipRetry = skipRetryForStatus(status)
    // A 404 is the missing route this fail-open answer is for, and only a caller holding no
    // prior policy may take it: with a `live` or `stale` document this is a failure, and that
    // document stays exactly as the caller had it. The unsolicited 304 is answered above.
    if (status === 404 && prior === 'none' && operation.failOpenOnMissingRoute === true) {
      return { kind: 'fail_open_empty', reason: 'route_missing_fail_open', attempts }
    }
    const failure = coreFailure('request_failed', { status, skipRetry })
    if (skipRetry || retries >= POLICY_LIMITS_RETRIES) {
      return { kind: 'failure', failure, attempts, recoveryOwner: 'caller' }
    }
    await operation.sleep(policyBackoffMs(retries, retryAfterMs(response), random), operation.signal ?? new AbortController().signal)
    retries += 1
  }
  return {
    kind: 'failure',
    failure: coreFailure('request_failed', { reason: 'retry_budget_exhausted' }),
    attempts,
    recoveryOwner: 'caller',
  }
}

/** The snapshot one successful read produces, for a caller that adopts it. */
export function snapshotFromOutcome(
  outcome: PolicyLimitsOutcome,
  document: PolicyLimitsDocument,
  validator: string,
  receivedAt: number,
): PolicySnapshot {
  return {
    document,
    validator,
    receivedAt,
    ...outcome.kind === 'success' && outcome.signature !== undefined ? { signature: outcome.signature } : {},
  }
}
