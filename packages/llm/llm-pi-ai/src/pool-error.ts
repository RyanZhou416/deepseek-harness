/**
 * Failure classification for pi-ai routes that front a shared-account pool.
 *
 * pi-ai reports a rejected request as a terminal stream event whose message is
 * the provider SDK's `<status> <body>` text. A pool that fronts several
 * accounts puts its own stable `cc_pool_*` code, origin, and retry decision in
 * that body; the HTTP status alone cannot distinguish those failures from the
 * Claude errors the same endpoint returns. This module reads the envelope for
 * pool-origin failures and leaves every other failure to the existing text
 * classifier in `stream.ts`, so a Claude-native rejection keeps its original
 * code and wording.
 *
 * The pool owns account selection, cooldown, and session binding. This module
 * only decides what the client may do with the refusal: retry after the
 * disclosed wait, wait for the turn that holds the session, or stop.
 *
 * @module dsh-llm-pi-ai/pool-error
 */

import {
  POOL_CAPACITY_CODE,
  POOL_ERROR_CODE,
  POOL_NO_ACCOUNT_CODE,
  POOL_RATE_LIMITED_CODE,
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
  const error = (parsed as Record<string, unknown>)['error']
  if (typeof error !== 'object' || error === null) return undefined
  const fields = error as Record<string, unknown>
  const text = (name: string): string | undefined => {
    const value = fields[name]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const code = text('code')
  const type = text('type')
  const origin = text('origin')
  const scope = text('scope')
  const clientAction = text('client_action')
  const detail = text('message')
  const retryable = fields['retryable']
  return {
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
 * the provider's delay, while a catalog `stop` action (session-busy) forbids
 * every automatic resend. Unrecognized pool codes follow the envelope's
 * `client_action`, `retryable`, and finally the HTTP status. A `claude` origin,
 * a non-pool code, or an unparseable message returns undefined so the caller
 * keeps the pre-existing classification.
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
  if (!poolByOrigin && !poolByCode) return undefined

  const status = response?.status ?? statusOf(message)
  const retryAfterMs = response?.providerRetryAfterMs
  const detail = envelope.message ?? message
  const failure = (code: string, guidance: string): LlmFailure => ({
    message: `${detail} (${code}: ${guidance}${retrySuffix(retryAfterMs)})`,
    code,
    ...status === undefined ? {} : { status },
    ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
  })

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
 * Retain the response facts a later terminal error event needs.
 *
 * pi-ai flattens the SDK error to its message, discarding headers, so the one
 * request in a call (SDK retries are disabled) records its failed response
 * here. The body is left untouched: the SDK still reads it.
 */
export class ProviderErrorCapture {
  private response: ProviderErrorResponse | undefined

  /** Fetch replacement for one stream call; delegates every request to {@link base}. */
  readonly fetch: FetchFunction

  /**
   * @param base - the fetch implementation to delegate to (defaults to the host's).
   */
  constructor(base: FetchFunction = globalThis.fetch) {
    this.fetch = async (input, init) => {
      const response = await base(input, init)
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
