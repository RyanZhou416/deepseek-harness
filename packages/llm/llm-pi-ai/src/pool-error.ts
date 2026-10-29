/**
 * Failure classification for pi-ai routes that front a shared-account pool.
 *
 * pi-ai reports a rejected request as a terminal stream event whose message is
 * the provider SDK's `<status> <body>` text. A pool that fronts several
 * accounts puts its own stable `cc_pool_*` code, origin, and retry decision in
 * that body; the HTTP status alone cannot distinguish those failures from the
 * Claude errors the same endpoint returns. This module reads the envelope for
 * pool-origin failures and for the pool's readiness refusal, which carries a
 * body request id and retry decision instead; every other failure keeps the
 * existing text classifier in `stream.ts`, so a Claude-native rejection keeps
 * its original code and wording. A 5xx refusal carrying both readiness markers
 * is terminal without reading the pool's detail text, so a reworded refusal
 * cannot drift back into the retryable text classification.
 *
 * The pool owns account selection, cooldown, and session binding. This module
 * only decides what the client may do with the refusal: retry after the
 * disclosed wait, wait for the turn that holds the session, or stop. A closed
 * client request id is recoverable because this adapter stamps a new id on every
 * deliberate attempt, so the catalog asks for a retry of the request rather than
 * forbidding one: the next attempt is a fresh ledger entry, not a replay.
 *
 * @module dsh-llm-pi-ai/pool-error
 */

import {
  POOL_CAPACITY_CODE,
  POOL_ERROR_CODE,
  POOL_NO_ACCOUNT_CODE,
  POOL_RATE_LIMITED_CODE,
  POOL_REQUEST_CLOSED_CODE,
  POOL_TRANSIENT_CODE,
} from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { FetchFunction } from '@earendil-works/pi-ai'
import {
  POOL_ERROR_CATALOG,
  type PoolErrorCatalogEntry,
  type PoolErrorCatalogType,
} from './pool-error-catalog.generated.ts'

/** The pool's stable code prefix; every pool error carries one. */
const POOL_CODE_PREFIX = 'cc_pool_'

/** Retryable pool codes this adapter's classifier can emit for a normal policy. */
export const POOL_RETRYABLE_CODES: readonly string[] = Object.freeze([
  POOL_CAPACITY_CODE,
  POOL_RATE_LIMITED_CODE,
  POOL_NO_ACCOUNT_CODE,
  POOL_REQUEST_CLOSED_CODE,
  POOL_TRANSIENT_CODE,
])

/**
 * The generated catalog entry for a wire code.
 *
 * `Object.hasOwn` keeps inherited object keys (`constructor`, `toString`) out of
 * the lookup, so only catalog-defined wire codes take the known path.
 * @param identity - the envelope's `code ?? type`.
 * @returns the matching catalog entry, or undefined for a code outside the catalog.
 */
function catalogEntryFor(identity: string): PoolErrorCatalogEntry | undefined {
  if (!Object.hasOwn(POOL_ERROR_CATALOG, identity)) return undefined
  return POOL_ERROR_CATALOG[identity as PoolErrorCatalogType]
}

/** Envelope fields a pool response may carry; every one is optional because the online shape predates the full catalog. */
export interface ProviderErrorEnvelope {
  /** Pool-issued request id, echoed at the body's top level when the pool authored this refusal. */
  readonly poolRequestId?: string
  /** Stable error code, preferred over {@link type} when both are present. */
  readonly code?: string
  /** Anthropic-style error type, sometimes the only code a response carries. */
  readonly type?: string
  /** Error origin: `claude` for native Anthropic errors, `pool` for pool failures. */
  readonly origin?: string
  /** Failure scope: request, session, account, model, or pool. */
  readonly scope?: string
  /** Pool-side retry decision; a known pool code has its own client semantics. */
  readonly retryable?: boolean
  /** Requested client action: stop, retry_same, retry_after, or refresh. */
  readonly clientAction?: string
  /** Provider-authored human-readable detail. */
  readonly message?: string
}

/** Response facts retained from one failed provider HTTP request. */
export interface ProviderErrorResponse {
  /** HTTP status of the failed response. */
  readonly status: number
  /** Provider-requested delay from `Retry-After`, when valid. */
  readonly providerRetryAfterMs?: number
}

/** Response facts retained for request diagnostics, independent of failure classification. */
export interface ProviderResponseFacts {
  /** HTTP status of the response. */
  readonly status: number
  /** Pool-issued request id echoed by the response, when the pool issued one. */
  readonly poolRequestId?: string
}

/** The member pool's per-request id, echoed on a response when the pool issues one. */
const POOL_REQUEST_ID_HEADER = 'x-cc-pool-request-id'

/**
 * The readiness refusal's body field naming the pool-issued request id. The
 * pool writes it as a sibling of `error`; other pool failures carry their
 * identity inside `error` as a `cc_pool_*` code.
 */
const POOL_REQUEST_ID_FIELD = 'pool_request_id'

/**
 * The readiness refusal's detail text: the lease's egress path has not been
 * verified, which the pool reports as `capability_not_ready` lease maintenance.
 */
const POOL_READINESS_DETAIL = /the egress path is not verified for this lease|capability_not_ready/i

/**
 * Parse the JSON error envelope carried by a pi-ai failure message.
 *
 * pi-ai flattens the SDK error to `<status> <body>`, so the body is located by
 * its first `{` rather than by a status-dependent prefix.
 * @param message - pi-ai's terminal error text.
 * @returns the recognized `error` fields, or undefined when no JSON object is present.
 */
export function parseProviderErrorEnvelope(message: string): ProviderErrorEnvelope | undefined {
  const start = message.indexOf('{')
  const end = message.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(message.slice(start, end + 1))
  } catch {
    // Only a non-JSON body: no envelope to read, so the caller keeps its text classification.
    return undefined
  }
  const body = parsed as Record<string, unknown>
  const error = body['error']
  if (typeof error !== 'object' || error === null) return undefined
  const fields = error as Record<string, unknown>
  const text = (record: Record<string, unknown>, name: string): string | undefined => {
    const value = record[name]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const poolRequestId = text(body, POOL_REQUEST_ID_FIELD)
  const code = text(fields, 'code')
  const type = text(fields, 'type')
  const origin = text(fields, 'origin')
  const scope = text(fields, 'scope')
  const clientAction = text(fields, 'client_action')
  const detail = text(fields, 'message')
  const retryable = fields['retryable']
  return {
    ...poolRequestId === undefined ? {} : { poolRequestId },
    ...code === undefined ? {} : { code },
    ...type === undefined ? {} : { type },
    ...origin === undefined ? {} : { origin },
    ...scope === undefined ? {} : { scope },
    ...typeof retryable === 'boolean' ? { retryable } : {},
    ...clientAction === undefined ? {} : { clientAction },
    ...detail === undefined ? {} : { message: detail },
  }
}

/**
 * Classify a pi-ai failure that belongs to a shared-account pool.
 *
 * Known pool codes take their failure code, retry guidance, and resend decision
 * from the generated catalog: capacity, rate limiting, and no-account wait out
 * the provider's delay, a closed client request id asks for another attempt
 * (which the adapter sends under a fresh id), while a catalog `stop` action
 * (session-busy) forbids every automatic resend. Unrecognized pool codes follow
 * the envelope's `client_action`, `retryable`, and finally the HTTP status. A pool-authored
 * readiness refusal — identified by its body `pool_request_id` and
 * `retryable: false`, together with a 5xx status or its unverified-egress
 * detail — becomes a non-retryable `POOL_ERROR` even though it carries neither
 * a pool code nor `origin`. A `claude` origin, a non-pool code, or an
 * unparseable message returns undefined so the caller keeps the pre-existing
 * classification.
 * @param message - pi-ai's terminal error text.
 * @param response - status and retry delay captured from the failed HTTP response.
 * @returns a pool-semantic failure, or undefined when this is not a pool failure.
 */
export function classifyPoolFailure(
  message: string,
  response?: ProviderErrorResponse,
): LlmFailure | undefined {
  const envelope = parseProviderErrorEnvelope(message)
  if (envelope === undefined) return undefined
  const identity = envelope.code ?? envelope.type
  const poolByOrigin = envelope.origin === 'pool'
  // An explicit claude origin outranks a pool-looking code: the pool is not
  // allowed to relabel a native Claude error, and neither is this adapter.
  const poolByCode = envelope.origin !== 'claude'
    && identity !== undefined
    && identity.startsWith(POOL_CODE_PREFIX)

  const status = response?.status ?? statusOf(message)
  const retryAfterMs = response?.providerRetryAfterMs
  const detail = envelope.message ?? message
  const failure = (code: string, guidance: string): LlmFailure => ({
    message: `${detail} (${code}: ${guidance}${retrySuffix(retryAfterMs)})`,
    code,
    ...status === undefined ? {} : { status },
    ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
  })

  if (!poolByOrigin && !poolByCode) {
    // The pool's readiness refusal omits the `cc_pool_*` code and `origin` its
    // other failures carry, so its own body markers identify it. A repeated
    // clientRequestId cannot make the lease ready, and the pool's ledger answers
    // that repeat with a 409 instead of the original request's outcome.
    if (!isPoolReadinessFailure(envelope, status)) return undefined
    return {
      ...failure(POOL_ERROR_CODE, 'the pool has not verified the egress path for this lease'),
      retryDisposition: 'forbid',
    }
  }

  // Known pool codes take their client semantics from the generated catalog, so
  // the wire code, failure code, and retry guidance have one source.
  const entry = identity === undefined ? undefined : catalogEntryFor(identity)
  if (entry !== undefined) {
    const known = failure(entry.code, entry.clientGuidance)
    // A catalog `stop` action forbids every automatic resend: session-busy takes
    // this path even though the online pool marks it retryable for its own recovery.
    return entry.clientAction === 'stop' ? { ...known, retryDisposition: 'forbid' } : known
  }

  const retry = retryDecision(envelope, status)
  if (retry) return failure(POOL_TRANSIENT_CODE, 'the pool reports a transient failure')
  return {
    ...failure(POOL_ERROR_CODE, envelope.clientAction === 'refresh'
      ? 're-authenticate this provider route before retrying'
      : 'the pool reports a non-retryable failure'),
    retryDisposition: 'forbid',
  }
}

/**
 * Whether an envelope is the pool's readiness refusal rather than a provider failure.
 *
 * The pool withholds its `cc_pool_*` code and `origin` from this refusal. It
 * authors a body `pool_request_id`, states `retryable: false`, and names the
 * lease's unverified egress path (or its `capability_not_ready` maintenance
 * detail). The refusal is terminal because a resend repeats the same ledger id
 * that the pool has already recorded. A 5xx carrying both pool markers is
 * terminal on those markers alone: the detail is documentation of why, and a
 * pool that rewords it must not drift the refusal back into a retryable
 * provider failure. Below 5xx the detail still identifies the refusal, so an
 * ordinary provider rejection stays with the text classifier.
 * @param envelope - the recognized error envelope.
 * @param status - the failed HTTP status, when known.
 * @returns whether the envelope is the pool's readiness refusal.
 */
function isPoolReadinessFailure(envelope: ProviderErrorEnvelope, status: number | undefined): boolean {
  // An explicit claude origin outranks the pool markers: the pool is not
  // allowed to relabel a native Claude error, and neither is this adapter.
  if (envelope.origin === 'claude') return false
  if (envelope.poolRequestId === undefined || envelope.retryable !== false) return false
  // HTTP statuses stop at 599, so the server-error range needs no upper bound.
  if (status !== undefined && status >= 500) return true
  return POOL_READINESS_DETAIL.test(envelope.message ?? '')
}

/**
 * Retain the response facts a later terminal error event and the request
 * diagnostic need.
 *
 * pi-ai flattens the SDK error to its message, discarding headers, so the one
 * request in a call (SDK retries are disabled) records its response here. The
 * body is left untouched: the SDK still reads it.
 */
export class ProviderErrorCapture {
  private response: ProviderErrorResponse | undefined
  private observed: ProviderResponseFacts | undefined
  private transportError: unknown

  /** Fetch replacement for one stream call; delegates every request to {@link base}. */
  readonly fetch: FetchFunction

  /**
   * @param base - the fetch implementation to delegate to (defaults to the host's).
   */
  constructor(base: FetchFunction = globalThis.fetch) {
    this.fetch = async (input, init) => {
      let response: Response
      try {
        response = await base(input, init)
      } catch (error: unknown) {
        // pi-ai reduces a transport failure to its message text; this keeps the
        // original Error so the request diagnostic can report its cause chain.
        this.transportError = error
        throw error
      }
      const poolRequestId = response.headers.get(POOL_REQUEST_ID_HEADER) ?? undefined
      this.observed = Object.freeze({
        status: response.status,
        ...poolRequestId === undefined ? {} : { poolRequestId },
      })
      if (!response.ok && this.response === undefined) {
        this.response = Object.freeze({
          status: response.status,
          ...retryAfterFacts(response.headers),
        })
      }
      return response
    }
  }

  /**
   * The failed response observed during this call.
   * @returns status and retry delay, or undefined when no request failed.
   */
  read(): ProviderErrorResponse | undefined {
    return this.response
  }

  /**
   * The response observed during this call, successful or failed.
   * @returns status and the pool's request id, or undefined when no response arrived.
   */
  readResponse(): ProviderResponseFacts | undefined {
    return this.observed
  }

  /**
   * The transport Error that rejected this call's fetch, if one did.
   * @returns the first transport failure, or undefined when every request got a response.
   */
  readTransportError(): unknown {
    return this.transportError
  }
}

/** The failure envelope's own leading HTTP status, when pi-ai preserved it. */
function statusOf(message: string): number | undefined {
  const match = /^(\d{3})\s/u.exec(message)
  if (match === null) return undefined
  const status = Number(match[1])
  return status >= 100 && status <= 599 ? status : undefined
}

/**
 * Whether an unrecognized pool failure may be retried.
 *
 * `client_action` is the pool's direct answer; `retryable` covers responses
 * that predate it. Absent both, an unknown pool failure stops: repeating it is
 * only safe when the producer said so.
 */
function retryDecision(envelope: ProviderErrorEnvelope, status: number | undefined): boolean {
  switch (envelope.clientAction) {
    case 'retry_same':
    case 'retry_after':
      return true
    case 'stop':
    case 'refresh':
      return false
    default:
      break
  }
  if (envelope.retryable !== undefined) return envelope.retryable
  return status === 429 || (status !== undefined && status >= 500)
}

function retrySuffix(retryAfterMs: number | undefined): string {
  return retryAfterMs === undefined ? '' : `; retry after ${Math.ceil(retryAfterMs / 1_000)}s`
}

function retryAfterFacts(headers: Headers): Pick<ProviderErrorResponse, 'providerRetryAfterMs'> | Record<string, never> {
  const raw = headers.get('retry-after')
  if (raw === null) return {}
  const seconds = Number(raw)
  const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : Date.parse(raw) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {}
}
