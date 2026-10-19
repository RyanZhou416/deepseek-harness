/**
 * The one ordered failure classification for the Claude route.
 *
 * A rejection reaches this adapter as a failed HTTP status or as an `error` event inside a
 * 200, and the same refusal must produce the same decision either way. So both inputs are
 * classified here, in the order the reliability design fixes: a stated client-version
 * refusal first (it outranks every retry signal, including `retry-after` and
 * `x-should-retry: true`), then a refusal the provider stated is final, then credential
 * expiry, then a releasable quota window, then a request fault, then a recognized
 * transient failure, and last an unclassified error that is never reported as a
 * transient server failure.
 *
 * A decision is a value, not a side effect: callers that own an account, a profile block
 * or a response body act on it. Only the route that holds the response may decide whether
 * an event carried a stated-final refusal, so the in-band form takes the caller's probe.
 *
 * @module dsh-plugin-subscriptions/providers/claude-failure
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type { LlmErrorOptions, LlmFailure } from '@deepseek-ai/dsh-llm'
import {
  CONFLICT_CODE,
  ENFORCEMENT_CODE,
  isEnforcementRefusal,
  MODEL_DENIED_CODE,
  namesBillingRefusal,
  namesModelDenial,
  namesRevokedCredential,
  sharedHttpFailureCode,
} from './common.js'
import { retryAfterInstant, waitFromReset } from './rate-limit.js'
import type { RateLimitResetReader } from './rate-limit.js'
import {
  anthropicErrorEventRule,
  matchesClaudeVersionRejection,
} from './claude-protocol.js'
import type {
  ClaudeFailureScope,
  ClaudeProtocolProfile,
  RetryDisposition,
} from './claude-protocol.js'

/**
 * Stable code for a response the service refuses because the claiming client version is
 * below its managed floor. Nothing about the account is wrong, so no recovery path may
 * treat it as a credential or quota failure.
 */
export const CLIENT_VERSION_UNSUPPORTED_CODE = 'CLIENT_VERSION_UNSUPPORTED'

/**
 * Stable code for a failure this route cannot name. Deliberately not `SERVER`: reporting
 * an unmapped structured error as a transient server failure hands a refusal the provider
 * never described as retryable back to the retry loop.
 */
export const UNCLASSIFIED_PROVIDER_ERROR_CODE = 'UNCLASSIFIED_PROVIDER_ERROR'

/**
 * Stable code for a permission refusal the provider stated without naming a billing,
 * organisation or seat reason. It is terminal for the operation and says nothing about
 * the stored credential, so it must not clear a token or trigger an authentication
 * refresh.
 */
export const PERMISSION_DENIED_CODE = 'PERMISSION_DENIED'

/**
 * Stable code for a stream that ended before its business terminal state.
 *
 * The response was accepted, so the request has certainly been sent and its outcome is
 * unknown: replaying it could submit the same turn twice, and no delivery boundary changes
 * that. A transport failure that never produced a response is a different case and keeps its
 * own transient code.
 */
export const STREAM_INCOMPLETE_CODE = 'STREAM_INCOMPLETE'

/** Which half of the exchange produced a failure. */
export type ClaudeFailureStage =
  /** A non-2xx HTTP status. */
  | 'http'
  /** An `error` event inside an HTTP 200. */
  | 'sse'
  /** A stream that ended without its terminal state. */
  | 'stream'
  /** A thrown transport failure. */
  | 'transport'
  /** Local request assembly. */
  | 'request'

/**
 * The serializable record one Claude failure resolves to.
 *
 * Callers route on this instead of on message text: the reason is stable, the scope states
 * what the failure is evidence about, and `retryDisposition` is the hard-stop decision the
 * Host failure record carries.
 */
export interface ClaudeFailureDecision {
  /** Stable plugin reason code. */
  readonly reason: string
  /** The provider's own code or type, when it sent one. */
  readonly serverCode?: string
  /** HTTP status, when the failure arrived on a response. */
  readonly status?: number
  /** Which half of the exchange produced this failure. */
  readonly stage: ClaudeFailureStage
  /** What the failure is evidence about. */
  readonly scope: ClaudeFailureScope
  /** Whether automatic recovery may still run. */
  readonly retryDisposition: RetryDisposition
  /** Whether output for this logical request already reached the Host. */
  readonly outputDelivered: boolean
  /** The provider-disclosed delay before retrying, when it disclosed one. */
  readonly retryAfterMs?: number
  /** Normalized provider origin the request targeted. */
  readonly origin: string
  /** Protocol fingerprint the request was built from. */
  readonly protocolFingerprint: string
}

/** Cap on the error body this classifier parses; a larger body is classified unclassified. */
export const CLAUDE_ERROR_BODY_LIMIT = 64 * 1024

/** How deep the envelope walk descends; observed bodies nest two levels. */
const MAX_ENVELOPE_DEPTH = 5

/** Cap on the code-like values one envelope may contribute. */
const MAX_ENVELOPE_CODES = 32

/** Cap on non-JSON body text matched against version markers. */
const MAX_PLAIN_TEXT = 2_000

/**
 * Keys whose string values are treated as provider codes.
 *
 * `details.error_code` is the nested form the version refusal arrives in, which is why the
 * walk is by key at any depth rather than by a fixed path.
 */
const CODE_KEYS: ReadonlySet<string> = new Set(['error_code', 'code', 'type', 'reason'])

/** Keys whose string value is the provider's own message. */
const MESSAGE_KEYS: ReadonlySet<string> = new Set(['message', 'error_description'])

/** The container type every Anthropic error envelope names, not a failure classification. */
const ENVELOPE_TYPE = 'error'

/** How one Claude failure code maps to its scope and recovery permission. */
interface ClaudeCodeRule {
  readonly retryDisposition: RetryDisposition
  readonly scope: ClaudeFailureScope
}

/**
 * Recovery permission and scope per plugin reason code.
 *
 * The table is an allow-list, not a default: only a code whose recovery is explicitly
 * declared here may be replayed, and a code that is not listed — an HTTP status this route
 * never named, a failure vocabulary that grew a new member — carries the hard stop. A
 * missing entry must never read as permission.
 *
 * A context overflow is allowed even though the request is at fault: the harness has
 * declared specific recovery for it (context compaction and image offload), and forbidding
 * the resend would disable those paths rather than protect anything. Everything else that
 * is forbidden here is a stated refusal, a permission refusal, a request this route cannot
 * serve, or an error it could not classify. Output already delivered makes any code a hard
 * stop, which {@link decisionFor} applies on top.
 */
const CLAUDE_CODE_RULES: Readonly<Record<string, ClaudeCodeRule>> = Object.freeze({
  [CLIENT_VERSION_UNSUPPORTED_CODE]: { retryDisposition: 'forbid', scope: 'provider-profile' },
  [UNCLASSIFIED_PROVIDER_ERROR_CODE]: { retryDisposition: 'forbid', scope: 'unknown' },
  [PERMISSION_DENIED_CODE]: { retryDisposition: 'forbid', scope: 'operation' },
  [ENFORCEMENT_CODE]: { retryDisposition: 'forbid', scope: 'account' },
  [MODEL_DENIED_CODE]: { retryDisposition: 'forbid', scope: 'model' },
  [CONFLICT_CODE]: { retryDisposition: 'allow', scope: 'operation' },
  'INVALID_REQUEST': { retryDisposition: 'forbid', scope: 'operation' },
  [STREAM_INCOMPLETE_CODE]: { retryDisposition: 'forbid', scope: 'operation' },
  [CONTEXT_WINDOW_EXCEEDED_CODE]: { retryDisposition: 'allow', scope: 'operation' },
  'AUTH': { retryDisposition: 'allow', scope: 'account' },
  'RATE_LIMIT': { retryDisposition: 'allow', scope: 'account' },
  [QUOTA_EXCEEDED_CODE]: { retryDisposition: 'allow', scope: 'account' },
  'TIMEOUT': { retryDisposition: 'allow', scope: 'operation' },
  'SERVER': { retryDisposition: 'allow', scope: 'operation' },
  'TRANSPORT': { retryDisposition: 'allow', scope: 'operation' },
  [EMPTY_RESPONSE_CODE]: { retryDisposition: 'allow', scope: 'operation' },
  'MALFORMED_RESPONSE': { retryDisposition: 'allow', scope: 'operation' },
  'HTTP_402': { retryDisposition: 'allow', scope: 'account' },
  'HTTP_404': { retryDisposition: 'allow', scope: 'model' },
})

/**
 * The provider code a decision may carry, or nothing.
 *
 * Only a code this route already knows is kept: it comes from the provider vocabulary this
 * plugin transcribed, so it cannot carry content the provider merely echoed. Any other string
 * is dropped at the classifier, so it can reach neither a decision, a stored block record nor
 * an error message.
 * @param code - the code the envelope named, when it named one.
 * @returns the code when this route recognizes it, otherwise undefined.
 */
function safeServerCode(code: string | undefined): string | undefined {
  if (code === undefined) return undefined
  return namesKnownProviderCode(code) || matchesClaudeVersionRejection(code) ? code : undefined
}

/** A provider code this route already maps, so its envelope is not "unknown". */
function namesKnownProviderCode(code: string): boolean {
  return code === ENVELOPE_TYPE || anthropicErrorEventRule(code, undefined) !== undefined
}

/**
 * Declared Anthropic rejections whose own code beats the shared status table.
 *
 * A status-only mapping would report a 400 or 404 that names a request or model refusal as
 * an unclassified per-status code, and the Host's unconditional retry mode would resend it.
 * These are the codes the provider's own vocabulary names, so they are decided by what it
 * says.
 */
const DECLARED_HTTP_CODES: ReadonlySet<string> = new Set([
  CLIENT_VERSION_UNSUPPORTED_CODE,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  PERMISSION_DENIED_CODE,
  'INVALID_REQUEST',
])

/**
 * Build the decision one reason code produces.
 *
 * @param reason - the stable plugin reason code.
 * @param input - the shared decision context.
 * @returns the frozen decision record.
 */
function decisionFor(
  reason: string,
  input: {
    readonly stage: ClaudeFailureStage
    readonly profile: ClaudeProtocolProfile
    readonly outputDelivered: boolean
    readonly status?: number
    readonly serverCode?: string
    readonly retryAfterMs?: number
  },
): ClaudeFailureDecision {
  const rule = CLAUDE_CODE_RULES[reason] ?? { retryDisposition: 'forbid' as const, scope: 'unknown' as const }
  // Any failure that arrives after output reached the Host is a hard stop whatever its own
  // code says: replaying the step would submit already-delivered output a second time.
  const retryDisposition: RetryDisposition = input.outputDelivered ? 'forbid' : rule.retryDisposition
  // Delivery changes the disposition, not the evidence: a compatibility-profile refusal stays
  // scoped to the profile after output, so the block it requires is still recorded. Every other
  // scope narrows to this one operation once output has gone out.
  const scope: ClaudeFailureScope =
    input.outputDelivered && rule.scope !== 'provider-profile' ? 'operation' : rule.scope
  return Object.freeze({
    reason,
    stage: input.stage,
    scope,
    retryDisposition,
    outputDelivered: input.outputDelivered,
    origin: input.profile.origin,
    protocolFingerprint: input.profile.fingerprint,
    ...input.serverCode === undefined ? {} : { serverCode: input.serverCode },
    ...input.status === undefined ? {} : { status: input.status },
    ...input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs },
  })
}

/** What a bounded parse of one error body disclosed. */
interface ClaudeErrorEnvelope {
  /** Whether the body parsed as a JSON object. */
  readonly parsed: boolean
  /** Whether the body read stopped at the byte cap. */
  readonly oversized: boolean
  /** Code-like values found under {@link CODE_KEYS}, bounded. */
  readonly codes: readonly string[]
  /** The provider's own message, bounded. */
  readonly message?: string
  /** Bounded raw text, for bodies that are not JSON. */
  readonly text: string
}

/** One error body read under a byte cap. */
export interface ClaudeErrorBody {
  /** The decoded body, at most {@link CLAUDE_ERROR_BODY_LIMIT} bytes. */
  readonly text: string
  /** Whether the response carried more than the cap, so the read stopped early. */
  readonly overflowed: boolean
}

/**
 * Read an error body without letting one response decide how much memory it spends.
 *
 * The cap is applied to the bytes as they arrive and the reader is cancelled once it is
 * reached, so a body that never ends — or one crafted to exhaust memory — costs one bounded
 * read and one released connection. The cap is a byte count, not a UTF-16 code-unit count:
 * a body of multi-byte characters must not be able to exceed it.
 * @param response - the failed response.
 * @param limit - the maximum number of body bytes to decode.
 * @returns the decoded prefix and whether the body exceeded the cap.
 */
export async function readClaudeErrorBody(
  response: Response,
  limit: number = CLAUDE_ERROR_BODY_LIMIT,
): Promise<ClaudeErrorBody> {
  const body = response.body
  if (body === null) return { text: '', overflowed: false }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  let overflowed = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) break
      if (value === undefined) continue
      const room = limit - bytes
      bytes += value.byteLength
      if (bytes > limit) {
        // Decode only the part inside the cap; the tail is never decoded at all.
        text += decoder.decode(value.subarray(0, Math.max(room, 0)), { stream: true })
        overflowed = true
        break
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch {
    // Only swallow a body read failure: the HTTP status still identifies the failure.
  } finally {
    try {
      await reader.cancel()
    } catch (_releaseFailure) {
      // A body that cannot be cancelled is still released by the lock below.
    }
    reader.releaseLock()
  }
  return { text, overflowed }
}

/**
 * Walk one value into the bounded envelope facts.
 *
 * The walk is by key at any depth, which is what reaches a code nested under `details`, and
 * it is bounded in depth and in how many codes it collects, so no single response decides
 * how much work this does.
 * @param raw - the parsed value (a response body or an in-band error object).
 * @param oversized - whether the source was truncated at the byte cap.
 * @returns the bounded envelope facts.
 */
function envelopeFrom(raw: unknown, oversized: boolean): ClaudeErrorEnvelope {
  if (oversized) return { parsed: false, oversized, codes: [], text: '' }
  if (typeof raw !== 'object' || raw === null) return { parsed: false, oversized, codes: [], text: '' }
  const codes: string[] = []
  let message: string | undefined
  const walk = (value: unknown, depth: number): void => {
    if (depth <= 0 || typeof value !== 'object' || value === null) return
    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested === 'string') {
        // A bare `error` string is the provider's message, not a code: OAuth-shaped and
        // gateway-shaped bodies both put prose there.
        if (key === 'error') {
          if (message === undefined) message = nested.slice(0, 300)
        } else if (CODE_KEYS.has(key) && codes.length < MAX_ENVELOPE_CODES) codes.push(nested)
        else if (MESSAGE_KEYS.has(key) && message === undefined) message = nested.slice(0, 300)
        continue
      }
      walk(nested, depth - 1)
    }
  }
  walk(raw, MAX_ENVELOPE_DEPTH)
  return {
    parsed: true,
    oversized,
    codes,
    ...message === undefined ? {} : { message },
    text: '',
  }
}

/**
 * Parse an error body within a fixed bound.
 *
 * A body over the cap is not parsed at all: a classifier that reads an unbounded echo can
 * be steered by content the provider merely repeated, and the design requires the
 * classification to rest on a bounded envelope.
 * @param body - the bounded body text.
 * @param oversized - whether the read stopped at the byte cap.
 * @returns the bounded envelope facts.
 */
function parseErrorEnvelope(body: string, oversized: boolean): ClaudeErrorEnvelope {
  if (oversized) return { parsed: false, oversized, codes: [], text: '' }
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    // A gateway that does not return JSON leaves its bounded text as the only signal.
    return { parsed: false, oversized, codes: [], text: body.slice(0, MAX_PLAIN_TEXT) }
  }
  if (typeof raw !== 'object' || raw === null) {
    return { parsed: false, oversized, codes: [], text: body.slice(0, MAX_PLAIN_TEXT) }
  }
  return envelopeFrom(raw, oversized)
}

/**
 * Whether a bounded envelope names a client-version refusal.
 *
 * Structured codes are read first; the provider's own message and, for a non-JSON body,
 * its bounded text are the fallback, because the service has sent this refusal as wording
 * as well as a code.
 * @param envelope - the bounded parse result.
 * @returns true when a known version-refusal marker is present.
 */
function namesVersionRefusal(envelope: ClaudeErrorEnvelope): boolean {
  if (envelope.codes.some(code => matchesClaudeVersionRejection(code))) return true
  if (envelope.message !== undefined && matchesClaudeVersionRejection(envelope.message)) return true
  return !envelope.parsed && matchesClaudeVersionRejection(envelope.text)
}

/**
 * Whether a parsed envelope names a structured error type this route does not map.
 *
 * Only a body that actually parsed counts: a plain-text gateway page names no type, and
 * the shared status rules already classify it. The envelope's own container type is not a
 * classification, so it is not evidence either way.
 * @param envelope - the bounded parse result.
 * @returns true when every code the envelope named beyond its container is unrecognized.
 */
function namesUnknownStructuredCode(envelope: ClaudeErrorEnvelope): boolean {
  if (!envelope.parsed) return false
  const specific = envelope.codes.filter(code => code !== ENVELOPE_TYPE)
  if (specific.length === 0) return false
  return specific.every(code => !namesKnownProviderCode(code))
}

/** Inputs one HTTP response's ordered Claude classification reads. */
export interface ClaudeHttpFailureInput {
  /** The failed response, for its status, headers and origin. */
  readonly response: Response
  /** The bounded response body. */
  readonly body: string
  /** Whether the body read stopped at the byte cap. */
  readonly oversized?: boolean
  /** The instant the caller resolved for a retry, when one was disclosed. */
  readonly reset: number | undefined
  /** Current epoch milliseconds. */
  readonly now: number
  /** Whether the status was 429. */
  readonly rateLimited: boolean
  /** The compatibility profile the request was built from. */
  readonly profile: ClaudeProtocolProfile
  /** Whether output for this logical request already reached the Host. */
  readonly outputDelivered?: boolean
}

/**
 * Classify one failed Claude HTTP response in the design's fixed order.
 *
 * The order is the contract: a stated client-version refusal outranks `retry-after` and
 * every other recoverable signal; a permission refusal is not a credential failure; and a
 * structured type this route does not map is unclassified rather than transient.
 * @param input - the failed response and the facts the order reads.
 * @returns the ordered decision for this response.
 */
export function classifyClaudeHttpFailure(input: ClaudeHttpFailureInput): ClaudeFailureDecision {
  const { response, body, reset, now, rateLimited, profile } = input
  const outputDelivered = input.outputDelivered === true
  const envelope = parseErrorEnvelope(body, input.oversized === true)
  const status = response.status
  const serverCode = safeServerCode(envelope.codes.find(code => code !== ENVELOPE_TYPE) ?? envelope.codes[0])
  const shared = { stage: 'http' as const, profile, outputDelivered, status,
    ...serverCode === undefined ? {} : { serverCode }
  }
  if (namesVersionRefusal(envelope)) return decisionFor(CLIENT_VERSION_UNSUPPORTED_CODE, shared)
  // A refusal the provider stated is final outranks the status it arrived with: a 403 that
  // names billing or says not to retry is not an expired login.
  if (isEnforcementRefusal(response, body, reset, now)) return decisionFor(ENFORCEMENT_CODE, shared)
  // The model, not the account, is the subject of a 403/404 that names one.
  const envelopeText = `${envelope.codes.join(' ')} ${envelope.message ?? ''} ${envelope.text}`
  if ((status === 403 || status === 404) && namesModelDenial(envelopeText)) {
    return decisionFor(MODEL_DENIED_CODE, shared)
  }
  // A 403 that names a revoked credential or account is a refresh case before it is a
  // permission refusal; a plain denial below stays terminal.
  if (status === 403 && namesRevokedCredential(envelopeText)) return decisionFor('AUTH', shared)
  // 403 is a permission refusal, and this route must not read it as an expired login: a
  // plain 403 neither refreshes nor clears the stored credential.
  if (status === 403) return decisionFor(PERMISSION_DENIED_CODE, shared)
  // An unrecognized structured type, or a body past the parse cap, is not a transient
  // server failure however the status reads.
  if (envelope.oversized || namesUnknownStructuredCode(envelope)) {
    return decisionFor(UNCLASSIFIED_PROVIDER_ERROR_CODE, shared)
  }
  // The provider's own declared rules apply before the shared status table, so a rejection the
  // Anthropic error vocabulary names is classified by what it says rather than by its status:
  // an over-long prompt is the same failure here as it is inside a 200, and a 400 or 404 that
  // names a request or model refusal is a stated refusal the Host may not resend.
  const declared = anthropicErrorEventRule(
    envelope.codes.find(code => code !== ENVELOPE_TYPE),
    envelope.message,
  )
  if (declared !== undefined && DECLARED_HTTP_CODES.has(declared.code)) {
    return decisionFor(declared.code, shared)
  }
  // The shared table names every status these routes classify; a status it does not name keeps
  // its own HTTP code, which is the route's declared per-status rule.
  const code = sharedHttpFailureCode({ response, body, reset, now, rateLimited })
  return decisionFor(code ?? `HTTP_${String(status)}`, {
    ...shared,
    ...reset === undefined ? {} : { retryAfterMs: waitFromReset(reset, now) },
  })
}

/** The wire error object one in-band `error` event carries. */
export interface ClaudeSseErrorObject {
  /** The event's own error type. */
  type?: string
  /** The provider's message. */
  message?: string
  /** The provider's own code, when it states one beside the type. */
  code?: string
  /** Nested detail object; `details.error_code` is where the version refusal is named. */
  details?: unknown
  /** A flat error code, on the shapes that do not nest one. */
  error_code?: string
}

/** Inputs one in-band `error` event's ordered classification reads. */
export interface ClaudeSseFailureInput {
  /** The error object the event carried, read whole rather than projected to type and message. */
  readonly error: ClaudeSseErrorObject | undefined
  /** The compatibility profile the request was built from. */
  readonly profile: ClaudeProtocolProfile
  /** Whether output for this logical request already reached the Host. */
  readonly outputDelivered?: boolean
  /**
   * The caller's probe for a refusal the response itself states. The event alone cannot
   * say whether the response was refused, so a probe that answers true makes the
   * refusal-bearing types terminal exactly as {@link isEnforcementRefusal} does for a
   * failed status.
   */
  readonly isRefusal?: ClaudeRefusalProbe
}

/**
 * Reports whether an in-band error event is a refusal the response itself states.
 *
 * The status and headers that make a failure terminal belong to the response, and an
 * `error` event can arrive inside a 200, so only the caller holding that response can
 * answer; the event alone cannot.
 */
export type ClaudeRefusalProbe = (error: ClaudeSseErrorObject | undefined) => boolean

/**
 * Classify an in-band `error` event with the same order the HTTP form uses.
 *
 * The event carries no status and no headers, so the caller's own classification of the
 * response behind it stands in; without one the event's own fields decide. The whole error
 * object is read under the same bounded envelope walk the HTTP body uses, because a
 * refusal can arrive as `details.error_code` rather than as the event's own type.
 * @param input - the event, the profile and the caller's refusal probe.
 * @returns the ordered decision for this event.
 */
export function classifyClaudeSseFailure(input: ClaudeSseFailureInput): ClaudeFailureDecision {
  const outputDelivered = input.outputDelivered === true
  const envelope = envelopeFrom(input.error, false)
  const base = { stage: 'sse' as const, profile: input.profile, outputDelivered }
  const serverCode = safeServerCode(envelope.codes.find(code => code !== ENVELOPE_TYPE) ?? input.error?.type)
  const shared = { ...base, ...serverCode === undefined ? {} : { serverCode } }
  const message = envelope.message ?? input.error?.message
  if (namesVersionRefusal(envelope)) return decisionFor(CLIENT_VERSION_UNSUPPORTED_CODE, shared)
  // Billing wording names a refusal on its own, so it admits a type this route does not list,
  // and it is judged before the unknown-type rule for exactly that reason.
  if (namesBillingRefusal(message ?? '') && input.isRefusal?.(input.error) === true) {
    return decisionFor(ENFORCEMENT_CODE, shared)
  }
  if (namesUnknownStructuredCode(envelope)) return decisionFor(UNCLASSIFIED_PROVIDER_ERROR_CODE, shared)
  const rule = anthropicErrorEventRule(serverCode, message)
  if (rule?.code === CONTEXT_WINDOW_EXCEEDED_CODE) return decisionFor(CONTEXT_WINDOW_EXCEEDED_CODE, shared)
  if (rule?.code === 'AUTH') return decisionFor('AUTH', shared)
  // The probe answers whether the response a 200 carried was itself a refusal, consulted where
  // refusing is a live possibility: a known type that the provider also uses for retryable
  // conditions.
  if (rule !== undefined && rule.transient && input.isRefusal?.(input.error) === true) {
    return decisionFor(ENFORCEMENT_CODE, shared)
  }
  if (rule === undefined) return decisionFor(UNCLASSIFIED_PROVIDER_ERROR_CODE, shared)
  // An in-band refusal that names one model is model-scoped, exactly as its HTTP form is.
  if ((rule.code === PERMISSION_DENIED_CODE || rule.code === 'INVALID_REQUEST')
    && namesModelDenial(message ?? '')) {
    return decisionFor(MODEL_DENIED_CODE, shared)
  }
  return decisionFor(rule.code, shared)
}

/**
 * The error options one decision produces.
 * @param decision - the decision to project.
 * @param extras - response facts the decision does not carry (cause, status, retry delay).
 * @returns options accepted by {@link LlmError}.
 */
function decisionOptions(
  decision: ClaudeFailureDecision,
  extras: {
    readonly cause?: unknown
    readonly status?: number
    readonly providerRetryAfterMs?: number
  } = {},
): LlmErrorOptions {
  return {
    ...extras.cause === undefined ? {} : { cause: extras.cause },
    ...extras.status === undefined ? {} : { status: extras.status },
    ...extras.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: extras.providerRetryAfterMs },
    ...decision.retryDisposition === 'forbid' ? { retryDisposition: 'forbid' } : {},
  }
}

/**
 * The ordered decision each error this process built was classified from.
 *
 * The Host failure record carries the machine code and the hard stop, but not the scope or
 * the protocol fingerprint, and consumers such as the profile reader need the whole
 * decision to keep a refusal from collapsing into "no data". The map is keyed by the error
 * instance, so it holds nothing durable and cannot outlive the failure it describes.
 */
const failureDecisions = new WeakMap<LlmError, ClaudeFailureDecision>()

/**
 * The decision one error was built from.
 * @param error - the error to look up.
 * @returns the decision, or undefined for an error this module did not classify.
 */
export function claudeFailureDecisionOf(error: LlmError): ClaudeFailureDecision | undefined {
  return failureDecisions.get(error)
}

/**
 * Build the error one decision produces.
 * @param decision - the decision being reported.
 * @param message - the human-readable summary.
 * @param extras - response facts the decision does not carry.
 * @returns the error to throw.
 */
export function claudeFailureError(
  decision: ClaudeFailureDecision,
  message: string,
  extras: { readonly cause?: unknown; readonly status?: number; readonly providerRetryAfterMs?: number } = {},
): LlmError {
  const error = new LlmError(message, decision.reason, decisionOptions(decision, extras))
  failureDecisions.set(error, decision)
  return error
}

/** What a route must supply to classify and report one failed Claude response. */
export interface ClaudeHttpFailureOptions {
  /** Diagnostic prefix naming the API. */
  readonly label: string
  /** The compatibility profile the request was built from. */
  readonly profile: ClaudeProtocolProfile
  /** The route's own reader for a disclosed quota window. */
  readonly rateLimitReset?: RateLimitResetReader
  /** The route's own retry-header reader; absent preserves the shared `retry-after` reader. */
  readonly retryHeaderReset?: (response: Response, now: number) => number | undefined
  /** Diagnostic sink for a 429 that disclosed no recognized reset. */
  readonly onWarn?: (message: string) => void
  /** Whether output for this logical request already reached the Host. */
  readonly outputDelivered?: boolean
  /** Receives the ordered decision, so the caller can act on a profile block. */
  readonly onDecision?: (decision: ClaudeFailureDecision) => void
  /**
   * A body the caller already read under the byte cap.
   *
   * Used where the decision must be made before the response can be released — a 401 the
   * route inspects before deciding on its one refresh — so the body is consumed exactly once
   * and never re-read.
   */
  readonly body?: ClaudeErrorBody
}

/**
 * Classify a failed Claude response and build the error to throw.
 *
 * The body is read under a fixed byte cap and cancelled once that cap is reached, so one
 * response cannot decide how much memory this process spends. It is used for classification
 * and then dropped: it is never a cause, never part of the message, and never repeated into a
 * warning, so a body that echoed a prompt, a token or an address cannot become durable session
 * text, a model-visible error or a diagnostic. The message is this route's own template plus
 * the status and, when the code names one, a provider code this route already recognizes.
 * @param response - the failed response.
 * @param options - the route's readers, profile and diagnostics sink.
 * @returns the classified error, already carrying the hard-stop decision when it applies.
 */
export async function claudeHttpLlmError(
  response: Response,
  options: ClaudeHttpFailureOptions,
): Promise<LlmError> {
  const read = options.body ?? await readClaudeErrorBody(response)
  const body = read.text
  const now = Date.now()
  const rateLimited = response.status === 429
  const retryHeaderReset = options.retryHeaderReset ?? retryAfterInstant
  const reset = rateLimited
    ? options.rateLimitReset?.(response, body, now) ?? retryHeaderReset(response, now)
    : retryHeaderReset(response, now)
  const decision = classifyClaudeHttpFailure({
    response,
    body,
    oversized: read.overflowed,
    reset,
    now,
    rateLimited,
    profile: options.profile,
    ...options.outputDelivered === undefined ? {} : { outputDelivered: options.outputDelivered },
  })
  options.onDecision?.(decision)
  // A 429 the readers could not resolve is worth a diagnostic, built from fixed facts only: the
  // status and the fact that nothing was recognized. Headers and body are not repeated into a
  // warning sink, because a warning is rendered, logged and copied into diagnostics exactly like
  // a message is. This matches what the shared helper reports for every other route.
  if (reset === undefined && rateLimited) {
    options.onWarn?.(`${options.label}: HTTP 429 disclosed no reset time this route recognizes`)
  }
  return claudeFailureError(decision, claudeFailureMessage(options.label, decision), {
    status: response.status,
    ...decision.retryAfterMs === undefined ? {} : { providerRetryAfterMs: decision.retryAfterMs },
  })
}

/**
 * The message one Claude failure reports.
 *
 * Built from this route's own template plus the facts the design allows a failure to carry —
 * the status, the stable reason and, when the code names one, the provider code this route
 * already recognizes. The response body and the provider's prose never reach it: content
 * parsed for classification is held in memory and dropped, so a body that echoed a prompt, a
 * token or an address cannot become durable session text or a model-visible error.
 * @param label - diagnostic prefix naming the API.
 * @param decision - the ordered decision this failure produced.
 * @returns the message to report.
 */
export function claudeFailureMessage(label: string, decision: ClaudeFailureDecision): string {
  const detail = decision.serverCode === undefined ? '' : `: ${decision.serverCode}`
  return `${label} error (HTTP ${String(decision.status ?? 0)})${detail}`
}

/**
 * Build the decision a stored protocol block produces.
 *
 * The block is checked before a request is built, so a refused profile produces this
 * decision without a network round trip and without an account being blamed.
 * @param profile - the compatibility profile the request would have used.
 * @param outputDelivered - whether output already reached the Host for this request.
 * @returns the decision for an already-refused profile.
 */
export function claudeProtocolBlockDecision(
  profile: ClaudeProtocolProfile,
  outputDelivered = false,
): ClaudeFailureDecision {
  return decisionFor(CLIENT_VERSION_UNSUPPORTED_CODE, {
    stage: 'request',
    profile,
    outputDelivered,
  })
}

/** Inputs {@link claudeStreamFailure} reads. */
export interface ClaudeStreamFailureInput {
  /** The compatibility profile the request was built from. */
  readonly profile: ClaudeProtocolProfile
  /** Whether any chunk for this logical request already reached the Host. */
  readonly outputDelivered: boolean
}

/**
 * Project a stream failure onto the hard-stop rule.
 *
 * The first chunk the Host receives commits this attempt: after that boundary no replay,
 * account switch or whole-step retry may run, because the delivered output would be
 * submitted twice. The same rule covers a thrown failure and an `error` finish, which is
 * why both pass through here.
 * @param error - the classified failure the stream produced.
 * @param input - the profile and the delivery boundary.
 * @returns the error to surface, carrying `retryDisposition: 'forbid'` once output was delivered.
 */
export function claudeStreamFailure(error: LlmError, input: ClaudeStreamFailureInput): LlmError {
  // A cancellation is not a failure to replay, and the Host already owns its disposition.
  if (!input.outputDelivered || error.code === 'ABORTED') return error
  const classified = new LlmError(error.message, error.code, {
    cause: error.cause ?? error,
    ...error.failure.status === undefined ? {} : { status: error.failure.status },
    ...error.failure.providerRetryAfterMs === undefined
      ? {}
      : { providerRetryAfterMs: error.failure.providerRetryAfterMs },
    ...error.failure.requestId === undefined ? {} : { requestId: error.failure.requestId },
    retryDisposition: 'forbid',
  })
  const prior = failureDecisions.get(error)
  if (prior !== undefined) {
    failureDecisions.set(classified, { ...prior, retryDisposition: 'forbid', outputDelivered: true })
  }
  return classified
}

/**
 * Add the hard-stop decision to a finish failure that follows delivered output.
 *
 * A finish chunk is a value, not a throw, so it cannot pass through
 * {@link claudeStreamFailure}; the same boundary decides it.
 * @param failure - the finish failure record.
 * @param outputDelivered - whether output already reached the Host for this request.
 * @returns the failure record to emit.
 */
export function claudeFinishFailure(
  failure: LlmFailure,
  outputDelivered: boolean,
): LlmFailure {
  if (!outputDelivered) return failure
  return { ...failure, retryDisposition: 'forbid' }
}

/**
 * The ordered decision behind a terminal error finish.
 *
 * A failed turn reported as a finish value is classified by the same table a thrown failure
 * uses, so an attempt that ended this way is reported to the maintenance seam as failed with
 * its decision attached, exactly like one that threw.
 * @param failure - the failure record the finish carried.
 * @param profile - the frozen compatibility profile the request was built from.
 * @param outputDelivered - whether output already reached the Host.
 * @returns the decision for that terminal value.
 */
export function claudeFinishDecision(
  failure: LlmFailure,
  profile: ClaudeProtocolProfile,
  outputDelivered: boolean,
): ClaudeFailureDecision {
  return decisionFor(failure.code, {
    stage: 'stream',
    profile,
    outputDelivered,
    ...failure.status === undefined ? {} : { status: failure.status },
  })
}

/**
 * Whether one error already carries the hard stop.
 * @param error - the failure to read.
 * @returns true when the Host failure record forbids automatic resend.
 */
export function claudeForbidsRetry(error: LlmError): boolean {
  return error.failure.retryDisposition === 'forbid'
}

/**
 * Carry the hard stop onto a failure whose only allowed recovery this request already spent.
 *
 * The controlled authentication replay happens once per logical request. A rejection that
 * arrives after it is not recoverable inside this request, and letting it keep an
 * authentication code with an ordinary disposition would hand the whole cycle — refresh, then
 * the Host's unconditional resend, then refresh again — back to the layers above.
 * @param error - the failure that exhausted its recovery.
 * @returns the same code and message with the stop attached.
 */
export function claudeRecoveryExhausted(error: LlmError): LlmError {
  return withHardStop(error)
}

/**
 * Classify a Messages POST that failed after it was issued but before any response arrived.
 *
 * The request body has already left this process, so the server may have accepted and acted on
 * it before anything failed. The route keeps the failure retryable: the Host retry executor
 * schedules its normal bounded backoff for the transport code. That is a deliberate availability
 * trade-off for consumer subscription endpoints; a duplicate is possible, and a turn that
 * already delivered output does not reach this helper. A failure raised before the POST is
 * issued — request assembly, image resolution, wire construction — keeps its own specific rule.
 *
 * The failure's own code and safe facts are kept; only the disposition changes.
 * @param error - what the issued send threw.
 * @returns the error to surface, without a hard stop so Host retry can schedule it.
 */
export function claudeAmbiguousSend(error: unknown): LlmError {
  if (error instanceof LlmError) return withRetryAllowed(error)
  return new LlmError('claude API request failed', 'TRANSPORT', { cause: error })
}

/**
 * Rebuild one issued-send failure without the hard stop, keeping its code, message and safe facts.
 * @param error - the failure to make retryable.
 * @returns the same failure with no `retryDisposition`.
 */
function withRetryAllowed(error: LlmError): LlmError {
  const prior = failureDecisions.get(error)
  // A classification that already forbids replay outranks the ordinary transport case; keep its
  // hard stop instead of turning every issued-send failure into a resend.
  if (prior?.retryDisposition === 'forbid') return withHardStop(error)
  const retryable = new LlmError(error.message, error.code, {
    cause: error.cause ?? error,
    ...error.failure.status === undefined ? {} : { status: error.failure.status },
    ...error.failure.providerRetryAfterMs === undefined
      ? {}
      : { providerRetryAfterMs: error.failure.providerRetryAfterMs },
    ...error.failure.requestId === undefined ? {} : { requestId: error.failure.requestId },
    ...error.failure.offloadImages === undefined ? {} : { offloadImages: error.failure.offloadImages },
  })
  if (prior !== undefined) {
    failureDecisions.set(retryable, { ...prior, retryDisposition: 'allow' })
  }
  return retryable
}

/**
 * Rebuild one error with the hard stop attached, keeping its own code, message and safe facts.
 * @param error - the failure to stop.
 * @returns the same failure with `retryDisposition: 'forbid'`.
 */
function withHardStop(error: LlmError): LlmError {
  const stopped = new LlmError(error.message, error.code, {
    cause: error.cause ?? error,
    ...error.failure.status === undefined ? {} : { status: error.failure.status },
    ...error.failure.providerRetryAfterMs === undefined
      ? {}
      : { providerRetryAfterMs: error.failure.providerRetryAfterMs },
    ...error.failure.requestId === undefined ? {} : { requestId: error.failure.requestId },
    retryDisposition: 'forbid',
  })
  // The classification this failure already had travels with it: a caller that reads the
  // decision for its own outcome must see the same one, only stopped.
  const prior = failureDecisions.get(error)
  if (prior !== undefined) failureDecisions.set(stopped, { ...prior, retryDisposition: 'forbid' })
  return stopped
}

/** Stable code for a local precondition that refused a request before it was sent. */
export const MAINTENANCE_REFUSED_CODE = 'MAINTENANCE_REFUSED'

/**
 * Turn a local precondition's refusal into the error to throw.
 *
 * A precondition that could not be checked is not a warning: it is enforced before the
 * wire, so its failure stops the request and carries the hard stop rather than letting an
 * unchecked request through. An error the precondition already classified keeps its code
 * and message, and only gains the stop.
 * @param error - what the precondition threw.
 * @param message - the local summary used when the throw carried no classification.
 * @returns the error to throw.
 */
export function claudeBlockedRequest(error: unknown, message: string): LlmError {
  if (error instanceof LlmError) return claudeRecoveryExhausted(error)
  return new LlmError(message, MAINTENANCE_REFUSED_CODE, { cause: error, retryDisposition: 'forbid' })
}
