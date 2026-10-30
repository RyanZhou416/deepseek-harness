/**
 * Failure classification for pi-ai routes that front a shared-account pool.
 *
 * pi-ai reports a rejected request as a terminal stream event whose message is
 * the provider SDK's `<status> <body>` text. A pool that fronts several
 * accounts puts its own stable `cc_pool_*` code, origin, retry decision, and
 * user-facing detail in that body; the HTTP status alone cannot distinguish
 * those failures from the Claude errors the same endpoint returns. This module
 * reads the envelope for pool-origin failures and for the pool's readiness
 * refusal, which carries a body request id, a retry decision, and its lease
 * detail instead; every other failure keeps the existing text classifier in
 * `stream.ts`, so a Claude-native rejection keeps its original code and wording.
 * The pool echoes `pool_request_id` on every error body, including native
 * provider failures, so that id cannot identify the readiness refusal; its
 * unverified-egress/`capability_not_ready` detail does. The id does carry one
 * decision only for a native 5xx: a pool-authored body that states
 * `retryable: false` forbids that retry, while a 400/413 context-overflow body
 * stays with the text classifier so the agent loop can compact.
 *
 * The pool owns account selection, cooldown, and session binding. This module
 * only decides what the client may do with the refusal: retry after the
 * disclosed wait, wait for the turn that holds the session, or stop. A closed
 * client request id is recoverable because this adapter stamps a new id on every
 * deliberate attempt, so the catalog asks for a retry of the request rather than
 * forbidding one: the pool's `terminal` marker refuses a replay of the same id,
 * not the fresh ledger entry that attempt creates. It also displays the pool's
 * own message after sanitizing it; the generated catalog contributes machine
 * semantics only, never display text.
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

/** Longest provider-authored pool message retained for display. */
export const POOL_ERROR_MESSAGE_MAX_LENGTH = 1_024

/** Generic display fallback when the pool supplies no safe message. */
export const POOL_ERROR_FALLBACK_MESSAGE = 'The provider pool rejected this request'

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
 * @param identity - the envelope's `code ?? type ?? kind`.
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
  /** Stable error code, preferred over {@link type} and {@link kind} when present. */
  readonly code?: string
  /** Anthropic-style error type, sometimes the only code a response carries. */
  readonly type?: string
  /** Coarser machine category, used only when neither {@link code} nor {@link type} names one. */
  readonly kind?: string
  /** Error origin: `claude` for native Anthropic errors, `pool` for pool failures. */
  readonly origin?: string
  /** Failure scope: request, session, account, model, or pool. */
  readonly scope?: string
  /** Pool-side retry decision; a known pool code has its own client semantics. */
  readonly retryable?: boolean
  /** Pool-side finality marker; true forbids a replay of the same request id. */
  readonly terminal?: boolean
  /** Requested client action: stop, retry_same, retry_after, or refresh. */
  readonly clientAction?: string
  /** Pool-declared HTTP status, used only when no response or status prefix supplies one. */
  readonly status?: number
  /** Provider-authored human-readable detail. */
  readonly message?: string
}

/** Response facts retained from one failed provider HTTP request. */
export interface ProviderErrorResponse {
  /** HTTP status of the failed response. */
  readonly status: number
  /** Provider-requested delay from `Retry-After`, when valid. */
  readonly providerRetryAfterMs?: number
  /**
   * Whether the pool marked this response as its `cc_wire_parity_unavailable`
   * refusal. The marker alone forbids a resend: the refusal is about the
   * wire-parity request, so retrying its body on the default wire would exceed
   * what the pool's capability answer allows.
   */
  readonly wireParityUnavailable?: boolean
}

/** Response facts retained for request diagnostics, independent of failure classification. */
export interface ProviderResponseFacts {
  /** HTTP status of the response. */
  readonly status: number
  /** Pool-issued request id echoed by the response, when the pool issued one. */
  readonly poolRequestId?: string
  /**
   * Whether the pool's own `cc_wire_parity_unavailable` refusal marked this
   * response. Present only when the pool stated it, so an unrelated `503` leaves
   * the capability answer unchanged.
   */
  readonly wireParityUnavailable?: boolean
}

/** The member pool's per-request id, echoed on a response when the pool issues one. */
const POOL_REQUEST_ID_HEADER = 'x-cc-pool-request-id'

/**
 * The pool's stable marker for its `cc_wire_parity_unavailable` refusal, whose only
 * value is `1`. The status alone is not that fact: an unmarked `503` is some
 * other failure.
 */
const WIRE_PARITY_UNAVAILABLE_HEADER = 'x-cc-wire-parity-unavailable'

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
  const kind = text(fields, 'kind')
  const origin = text(fields, 'origin')
  const scope = text(fields, 'scope')
  const clientAction = text(fields, 'client_action')
  const detail = text(fields, 'message')
  const retryable = fields['retryable']
  const terminal = fields['terminal']
  const declaredStatus = fields['status']
  return {
    ...poolRequestId === undefined ? {} : { poolRequestId },
    ...code === undefined ? {} : { code },
    ...type === undefined ? {} : { type },
    ...kind === undefined ? {} : { kind },
    ...origin === undefined ? {} : { origin },
    ...scope === undefined ? {} : { scope },
    ...typeof retryable === 'boolean' ? { retryable } : {},
    ...typeof terminal === 'boolean' ? { terminal } : {},
    ...clientAction === undefined ? {} : { clientAction },
    ...typeof declaredStatus === 'number' && Number.isInteger(declaredStatus)
      && declaredStatus >= 100 && declaredStatus <= 599
      ? { status: declaredStatus } : {},
    ...detail === undefined ? {} : { message: detail },
  }
}

/**
 * The envelope's machine identity, most specific field first.
 * @param envelope - parsed pool or provider error envelope.
 * @returns the `code`, `type`, or `kind` value when one is present.
 */
function identityOf(envelope: ProviderErrorEnvelope): string | undefined {
  return envelope.code ?? envelope.type ?? envelope.kind
}

/** Markup, entities, and executable URL schemes that never belong in a plain-text error row. */
const UNSAFE_MARKUP = /<\/?[a-z][^>]*>|<!--|&(?:#[0-9]+|#x[0-9a-f]+|[a-z]+);/iu

/**
 * The pool's own redaction placeholder. The gateway rewrites a credential it
 * removed from an upstream message as `[redacted]`, so a message that only
 * names the removed slot must stay displayable.
 */
const REDACTED_PLACEHOLDER = String.raw`\[redacted\]`

/** Credential material a provider might echo inside a failure message. */
const CREDENTIAL_MATERIAL: readonly RegExp[] = [
  /\bBearer\s+[a-z0-9._~+/=-]{8,}/iu,
  /\bsk-[a-z0-9_-]{8,}/iu,
  // An assignment still counts when the pool replaced the value with its own
  // placeholder; only the removed slot is named, and blocking that would hide an
  // otherwise safe message behind the generic fallback.
  new RegExp(String.raw`\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*(?!${REDACTED_PLACEHOLDER})\S+`, 'iu'),
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  new RegExp(String.raw`[?&](?:key|token|api[_-]?key|access[_-]?token)=(?!${REDACTED_PLACEHOLDER})`, 'iu'),
  /\b(?:javascript|data):/iu,
]

/**
 * Reduce the provider's user-facing detail to one bounded, plain-text line.
 *
 * Control characters become spaces, runs of whitespace collapse, and the
 * result is trimmed. A message that is empty, oversized, contains markup or
 * entities, or carries credential-like material is rejected so the caller can
 * show the generic pool refusal instead.
 * @param message - the envelope's `error.message`, when present.
 * @returns the display-safe one-line message, or undefined when none is safe.
 */
function sanitizeProviderMessage(message: string | undefined): string | undefined {
  if (message === undefined) return undefined
  const singleLine = message.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (singleLine === '' || singleLine.length > POOL_ERROR_MESSAGE_MAX_LENGTH) return undefined
  if (UNSAFE_MARKUP.test(singleLine)) return undefined
  if (CREDENTIAL_MATERIAL.some(pattern => pattern.test(singleLine))) return undefined
  return singleLine
}

/**
 * The provider-facing text for a pool failure whose own message cannot be shown.
 * @param code - canonical failure code selected for this refusal.
 * @returns one generic sentence naming the refusal class.
 */
function fallbackMessage(code: string): string {
  return `${POOL_ERROR_FALLBACK_MESSAGE} (${code}).`
}

/**
 * Classify a pi-ai failure that belongs to a shared-account pool.
 *
 * Known pool codes take their canonical failure code and resend decision from
 * the generated catalog's machine fields: capacity, rate limiting, and
 * no-account wait out the provider's delay, while a catalog `stop` action
 * (session-busy) forbids every automatic resend. A closed client request id
 * keeps its `retry_same` action even when the pool marks the envelope
 * `terminal`, because that marker refuses a replay of the same id and the retry
 * sends a fresh one; a `retryable: false` answer still forbids it. Unrecognized
 * pool codes follow an explicit `terminal` marker, then `client_action`,
 * `retryable`, and finally the HTTP status; `error.status` supplies the status
 * when neither the captured response nor the message prefix does. The failure
 * message is the pool's sanitized `message`, or a generic refusal when that
 * detail is missing or unsafe. A body without a pool code or `origin: pool`
 * keeps the text classification unless the pool itself decided otherwise: an
 * explicit `retryable: false` together with a pool marker — its body
 * `pool_request_id` or `origin: pool` — becomes a non-retryable `POOL_ERROR`
 * only for a 5xx, because the text classifier would retry that failure. A
 * 400/413 context-overflow body keeps the text classifier so compaction runs. The readiness
 * refusal reaches the same outcome through its unverified-egress or
 * `capability_not_ready` detail even though it carries neither a pool code nor
 * `origin`. An unparseable message, or a body with neither a pool code nor a
 * pool marker, returns undefined so the caller keeps the pre-existing
 * classification. The captured response's `wireParityUnavailable` marker
 * outranks the body entirely: a marker-only `503` becomes a non-retryable
 * `POOL_ERROR` instead of reaching the text classifier as a retryable `SERVER`
 * failure.
 * @param message - pi-ai's terminal error text.
 * @param response - status, retry delay, and wire-parity refusal marker captured
 *   from the failed HTTP response.
 * @returns a pool-semantic failure, or undefined when this is not a pool failure.
 */
export function classifyPoolFailure(
  message: string,
  response?: ProviderErrorResponse,
): LlmFailure | undefined {
  const envelope = parseProviderErrorEnvelope(message)
  const status = response?.status ?? statusOf(message) ?? envelope?.status
  const retryAfterMs = response?.providerRetryAfterMs
  const detail = sanitizeProviderMessage(envelope?.message)
  const failure = (code: string): LlmFailure => ({
    message: detail ?? fallbackMessage(code),
    code,
    ...status === undefined ? {} : { status },
    ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
  })
  // The marker is the pool's own statement about a wire-parity request, so it
  // outranks every body field: without it a marker-only body would reach the
  // text classifier, whose 503 classification would retry the same request on
  // the default wire the pool just refused.
  if (response?.wireParityUnavailable === true) {
    return { ...failure(POOL_ERROR_CODE), retryDisposition: 'forbid' }
  }
  if (envelope === undefined) return undefined
  const identity = identityOf(envelope)
  const poolByOrigin = envelope.origin === 'pool'
  // An explicit claude origin outranks a pool-looking code: the pool is not
  // allowed to relabel a native Claude error, and neither is this adapter.
  const poolByCode = envelope.origin !== 'claude'
    && identity !== undefined
    && identity.startsWith(POOL_CODE_PREFIX)

  if (!poolByOrigin && !poolByCode) {
    // The pool's readiness refusal omits the `cc_pool_*` code and `origin` its
    // other failures carry. Its lease detail is the only marker a native
    // provider 5xx does not share now that `pool_request_id` rides every error
    // body, so the detail decides. A pool-authored body that explicitly
    // withdraws the retry also decides: the text classifier would call its 5xx
    // retryable, which is exactly what the pool refused.
    if (!isPoolReadinessFailure(envelope) && !withdrawsRetry(envelope, status)) return undefined
    return {
      ...failure(POOL_ERROR_CODE),
      retryDisposition: 'forbid',
    }
  }

  // Known pool codes take their client semantics from the generated catalog's
  // machine fields, so the canonical code and stop decision have one source.
  const entry = identity === undefined ? undefined : catalogEntryFor(identity)
  if (entry !== undefined) {
    const known = failure(entry.code)
    // A catalog `stop` action forbids every automatic resend: session-busy takes
    // this path even though the online pool marks it retryable for its own recovery.
    if (entry.clientAction === 'stop') return { ...known, retryDisposition: 'forbid' }
    // The closed-request code is `terminal` too, but that marker refuses a replay
    // of the same id: the catalog's `retry_same` action asks for a fresh attempt
    // id, which is exactly what a deliberate retry sends. Only the pool's own
    // withdrawal, not `terminal`, forbids that retry.
    if (entry.clientAction === 'retry_same') {
      return envelope.retryable === false ? { ...known, retryDisposition: 'forbid' } : known
    }
    return envelope.terminal === true ? { ...known, retryDisposition: 'forbid' } : known
  }

  const retry = retryDecision(envelope, status)
  if (retry) return failure(POOL_TRANSIENT_CODE)
  return {
    ...failure(POOL_ERROR_CODE),
    retryDisposition: 'forbid',
  }
}

/**
 * Whether an envelope is the pool's readiness refusal rather than a provider failure.
 *
 * The pool withholds its `cc_pool_*` code and `origin` from this refusal. It
 * authors a body `pool_request_id`, states `retryable: false`, and names the
 * lease's unverified egress path (or its `capability_not_ready` maintenance
 * detail). It also echoes `pool_request_id` on every error body, including a
 * native provider failure, so that id does not identify the refusal; the lease
 * detail does. The refusal is terminal because a resend repeats the same ledger
 * id that the pool has already recorded. An envelope without that detail is not
 * this refusal, though {@link withdrawsRetry} still honours the pool's own
 * withdrawal.
 * @param envelope - the recognized error envelope.
 * @returns whether the envelope is the pool's readiness refusal.
 */
function isPoolReadinessFailure(envelope: ProviderErrorEnvelope): boolean {
  // The refusal is the pool's own answer, so a native Claude origin (which the
  // pool is not allowed to relabel) excludes it.
  if (envelope.origin === 'claude') return false
  if (envelope.poolRequestId === undefined || envelope.retryable !== false) return false
  return POOL_READINESS_DETAIL.test(envelope.message ?? '')
}

/**
 * Whether a pool-authored body explicitly withdraws the retry of a failure the
 * text classifier would otherwise retry.
 *
 * The pool echoes `pool_request_id` on native provider failures too, so a body
 * carrying that id (or `origin: pool`) and stating `retryable: false` is the
 * pool's answer about this failure rather than the provider's. The withdrawal
 * applies only to a 5xx: a native 400/413 context-overflow response also carries
 * the pool's id and its non-retryable flag, but it must reach the text
 * classifier so the agent loop can compact instead of ending the turn.
 * @param envelope - the recognized error envelope.
 * @param status - the resolved HTTP status, when one is known.
 * @returns whether the pool withdrew the retry.
 */
function withdrawsRetry(envelope: ProviderErrorEnvelope, status: number | undefined): boolean {
  if (envelope.retryable !== false) return false
  if (status === undefined || status < 500 || status > 599) return false
  return envelope.origin === 'pool' || envelope.poolRequestId !== undefined
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
        ...wireParityUnavailableFacts(response.headers),
      })
      if (!response.ok && this.response === undefined) {
        this.response = Object.freeze({
          status: response.status,
          ...retryAfterFacts(response.headers),
          ...wireParityUnavailableFacts(response.headers),
        })
      }
      return response
    }
  }

  /**
   * The failed response observed during this call.
   * @returns status, retry delay, and the pool's wire-parity refusal marker, or
   *   undefined when no request failed.
   */
  read(): ProviderErrorResponse | undefined {
    return this.response
  }

  /**
   * The response observed during this call, successful or failed.
   * @returns status, the pool's request id, and the pool's wire-parity-unavailable
   *   marker, or undefined when no response arrived.
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
 * `retry_same` asks for another attempt under a fresh id, so the `terminal`
 * marker — which refuses a replay of the same id — does not veto it, while an
 * explicit `retryable: false` withdraws it. Every other action follows
 * `terminal` first, then the pool's `client_action`, then `retryable` for
 * responses that predate it. Absent all of them an unknown pool failure stops,
 * because repeating it is only safe when the producer said so; that is how a
 * latent code outside the catalog, such as `cc_pool_request_in_flight`, keeps
 * the answer its own envelope states.
 * @param envelope - the recognized error envelope.
 * @param status - the resolved HTTP status, when one is known.
 * @returns whether the caller may retry the request.
 */
function retryDecision(envelope: ProviderErrorEnvelope, status: number | undefined): boolean {
  if (envelope.clientAction === 'retry_same' && envelope.retryable !== false) return true
  if (envelope.terminal === true) return false
  switch (envelope.clientAction) {
    case 'retry_same':
      return false
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

function retryAfterFacts(headers: Headers): Pick<ProviderErrorResponse, 'providerRetryAfterMs'> | Record<string, never> {
  const raw = headers.get('retry-after')
  if (raw === null) return {}
  const seconds = Number(raw)
  const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : Date.parse(raw) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {}
}

/**
 * Whether the response carries the pool's wire-parity-unavailable marker.
 *
 * The pool writes `1` on its `cc_wire_parity_unavailable` refusal only, so the
 * marker separates that refusal from any other `503`. Any other value is not
 * that refusal, and an absent header retains no fact at all.
 * @param headers - the settled response's headers.
 * @returns the retained marker fact, or an empty record when it is absent.
 */
function wireParityUnavailableFacts(
  headers: Headers,
): Pick<ProviderResponseFacts, 'wireParityUnavailable'> | Record<string, never> {
  return headers.get(WIRE_PARITY_UNAVAILABLE_HEADER) === '1' ? { wireParityUnavailable: true } : {}
}
