/**
 * Plumbing shared by the subscription adapters: HTTP error mapping, a
 * stream idle watchdog, fetch failure classification, OAuth endpoint errors,
 * and the per-provider {@link TokenManager} that owns session freshness.
 * Concurrent refreshes for one provider coalesce behind a single in-flight
 * promise (`inflight`), so a rotating refresh token is never spent twice.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  errorChain,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { rateLimitDiagnostics, retryAfterInstant, waitFromReset } from './rate-limit.js'
import type { RateLimitResetReader } from './rate-limit.js'
import { parseUnifiedRateLimit } from './unified-rate-limit.js'
import type { UnifiedRateLimitState } from './unified-rate-limit.js'

/** One configured model catalog entry. */
export interface ModelEntry {
  /** Wire model id; must be non-empty. */
  id: string
  /** Selector label; defaults to the id. */
  name?: string
  /** Known combined request/response context capacity. */
  contextWindow?: number
  /** Per-request output cap for this model. */
  maxTokens?: number
  /** Accepted request modalities; when set, wins over the provider default. */
  inputModalities?: ('text' | 'image')[] | undefined
  /**
   * Force this model's upstream protocol. Only the copilot adapter consumes
   * the semantics; the union is inlined here to avoid a circular import of
   * the copilot module's `CopilotWire`.
   */
  wire?: 'chat-completions' | 'responses'
}

/**
 * Validate a configured model catalog (mirrors llm-deepseek's resolveModels).
 * @param models - raw configured entries.
 * @param label - diagnostic prefix naming the provider.
 * @returns the validated entries.
 */
export function validateModels(models: readonly ModelEntry[], label: string): ModelEntry[] {
  const seen = new Set<string>()
  return models.map((model) => {
    if (model.id.length === 0) throw new Error(`${label}: catalog model ids must be non-empty`)
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`${label}: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`${label}: catalog model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`${label}: catalog model "${model.id}" maxTokens must be a positive integer`)
    }
    if (model.inputModalities !== undefined
      && (model.inputModalities.length === 0
        || model.inputModalities.some(modality => modality !== 'text' && modality !== 'image'))) {
      throw new Error(`${label}: catalog model "${model.id}" inputModalities must be a non-empty list of "text"/"image"`)
    }
    if (model.wire !== undefined && model.wire !== 'chat-completions' && model.wire !== 'responses') {
      throw new Error(`${label}: catalog model "${model.id}" wire must be "chat-completions" or "responses"`)
    }
    if (seen.has(model.id)) throw new Error(`${label}: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] },
      ...model.wire === undefined ? {} : { wire: model.wire },
    }
  })
}

/**
 * Failure code for a refusal the provider stated it will not accept a retry
 * for. No subscription route lists it among its retryable codes, so the turn
 * ends on it, and the pool parks the refusing account rather than asking
 * another one the same question.
 */
export const ENFORCEMENT_CODE = 'ENFORCEMENT'

/**
 * Failure code for a request the provider refused because the account may not
 * use that model.
 *
 * Model-scoped: the same account may serve another model, so the pool never
 * parks the account or asks a sibling for this one.
 */
export const MODEL_DENIED_CODE = 'MODEL_DENIED'

/**
 * Failure code for a request the provider could not settle because the target
 * changed underneath it (HTTP 409). Transient and request-scoped: the same
 * account may retry it after a backoff.
 */
export const CONFLICT_CODE = 'CONFLICT'

/** The server's own instruction to stop retrying: `x-should-retry: false`. */
const STOP_RETRY_HEADER = 'x-should-retry'

/**
 * `anthropic-ratelimit-unified-overage-disabled-reason` values that state the
 * account cannot serve at all: an organisation, seat, or member turned off, a
 * spend cap reached, or no credit left. `fetch_error` is deliberately absent —
 * it says the gateway could not read its own counter, which is a fail-closed
 * guess rather than a stated block, and a gateway sending it also sends
 * `x-should-retry: false`.
 */
const DISABLED_REASONS: ReadonlySet<string> = new Set([
  'org_spend_cap_reached',
  'org_level_disabled',
  'org_level_disabled_until',
  'org_service_level_disabled',
  'member_level_disabled',
  'member_rows_disabled',
  'seat_tier_level_disabled',
  'out_of_credits',
])

/** A disabled reason named in the error body rather than in the unified headers. */
const DISABLED_REASON_FIELD = /"?overage[_-]?disabled[_-]?reason"?\s*:\s*"([a-z_]+)"/i

/**
 * Provider wording and structured codes that name a denial aimed at one model
 * rather than at the account: the model does not exist for this account, is not
 * enabled, or is not one the account may call.
 *
 * Read only on a 403 or 404, where such a refusal is the only interpretation the
 * status supports; a 5xx that happens to mention a model stays transient.
 */
const MODEL_DENIED_WORDS = new RegExp(
  String.raw`model[_-]?(?:not[_-]?(?:found|available|enabled)|access[_-]?denied|denied|unsupported)`
  + String.raw`|\bmodel\b.{0,80}\b(?:not found|does not exist|no access|do not have access|`
  + String.raw`not available|not permitted|not allowed|not supported|is disabled)\b`
  + String.raw`|\b(?:no access|do not have access|not authorized)\b.{0,80}\bmodel\b`,
  'i',
)

/**
 * Provider wording that names a credential or account that was revoked rather
 * than a permission the request itself lacked.
 */
const REVOKED_CREDENTIAL_WORDS = new RegExp(
  String.raw`\b(?:credential|token|account|session|oauth|grant)\b.{0,60}\b(?:revoked|invalidated|deactivated|terminated|expired)\b`
  + String.raw`|\b(?:revoked|invalidated|deactivated)\b.{0,60}\b(?:credential|token|account|session|oauth|grant)\b`,
  'i',
)

/**
 * Whether bounded error text names a model-scoped denial.
 * @param text - the bounded error body or message.
 * @returns true when the text names the model, not the account, as the subject.
 */
export function namesModelDenial(text: string): boolean {
  return text.length > 0 && MODEL_DENIED_WORDS.test(text)
}

/**
 * Whether bounded error text names a revoked credential or account.
 * @param text - the bounded error body or message.
 * @returns true when a refresh is the applicable response before parking the account.
 */
export function namesRevokedCredential(text: string): boolean {
  return text.length > 0 && REVOKED_CREDENTIAL_WORDS.test(text)
}

/** Wording that names a billing or credit refusal in the provider's error fields. */
const BILLING_WORDS = /billing_error|credits?_required|out_of_credits|insufficient[\s_-]+credits?|credit[\s_-]+balance|extra[\s_-]+usage[\s_-]+is[\s_-]+required|usage[\s_-]+credits[\s_-]+are[\s_-]+required/i

/**
 * Whether provider error text names a billing or credit refusal.
 *
 * The same wording decides a response's classification here and an in-band
 * error event's classification in the stream translators, so a refusal is read
 * by one rule whichever half of the exchange carries it.
 * @param text - the provider's error type and message, as the provider wrote them.
 * @returns true when the text names a billing or credit refusal.
 */
export function namesBillingRefusal(text: string): boolean {
  return BILLING_WORDS.test(text)
}

/**
 * The disabled reason this response disclosed, from the unified header or the
 * error body.
 * @param body - the complete response body.
 * @param state - the parsed unified report, when the response carried one.
 * @returns the reason token, or undefined when the response named none.
 */
function disabledReason(body: string, state: UnifiedRateLimitState | undefined): string | undefined {
  return state?.overageDisabledReason ?? DISABLED_REASON_FIELD.exec(body)?.[1]
}

/**
 * Whether a failed response is a refusal the provider stated is final, as
 * opposed to a rate limit whose window simply reopens.
 *
 * The signals are the provider's own, and the genuine client stops retrying on
 * every one of them: `x-should-retry: false`, a unified status of `rejected`,
 * a disabled organisation/seat/member reason, billing or credit wording, and a
 * 429 that disclosed no reset at all — a refusal with no window to wait out
 * can only be retried blind, straight back into the block.
 * @param response - the failed response, for its headers.
 * @param body - the complete response body.
 * @param reset - the reset instant the caller resolved, when one was disclosed.
 * @param now - the current epoch milliseconds.
 * @returns true when the refusal must not be retried or answered from another account.
 */
export function isEnforcementRefusal(
  response: Response,
  body: string,
  reset: number | undefined,
  now: number,
): boolean {
  if (response.headers.get(STOP_RETRY_HEADER)?.trim().toLowerCase() === 'false') return true
  const unified = parseUnifiedRateLimit(response.headers, now)
  if (unified !== undefined && (unified.status === 'rejected' || unified.overageStatus === 'rejected')) return true
  const disabled = disabledReason(body, unified)
  if (disabled !== undefined && DISABLED_REASONS.has(disabled)) return true
  if (namesBillingRefusal(body)) return true
  return response.status === 429 && reset === undefined
}

/** Optional per-call hooks {@link httpLlmError} uses to read a rate-limit window. */
interface HttpLlmErrorOptions {
  /**
   * The calling provider's reader for the instant its rate-limit window
   * reopens. Consulted on a 429 only, and there ahead of the generic
   * `retry-after` header, because a provider's own field names the window while
   * `retry-after` often names a short backoff.
   */
  rateLimitReset?: RateLimitResetReader
  /** Provider-specific retry headers; absent preserves the shared retry-after reader. */
  retryHeaderReset?: (response: Response, now: number) => number | undefined
  /** Diagnostic sink for a 429 that disclosed no reset instant this code recognizes. */
  onWarn?: (message: string) => void
}

/**
 * The provider's own error fields, for a message a human can act on.
 *
 * Reads the JSON error object providers return (`error.type` / `error.message`, or
 * `error` / `error_description` on OAuth endpoints). It never falls back to raw body
 * text: the body rides the error's cause, because an upstream echo of a request
 * header must not become durable session text.
 *
 * @param body - the response body as text.
 * @returns a short `type: message` summary, or an empty string when absent.
 */
function structuredErrorDetail(body: string): string {
  if (body.length === 0) return ''
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    // A gateway that does not return JSON leaves the status as the only fact worth keeping.
    return ''
  }
  if (typeof raw !== 'object' || raw === null) return ''
  const record = raw as Record<string, unknown>
  const nested = typeof record['error'] === 'object' && record['error'] !== null
    ? record['error'] as Record<string, unknown>
    : undefined
  const type = firstString(nested?.['type'], record['error'], nested?.['code'], record['code'])
  const text = firstString(nested?.['message'], record['error_description'], record['message'])
  return [type, text]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(': ')
    .slice(0, 300)
}

/**
 * The first argument that is a non-empty string.
 *
 * @param values - candidates in priority order.
 * @returns the first non-empty string, or undefined.
 */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Inputs the shared, provider-neutral HTTP failure classification reads. */
export interface SharedHttpFailureInput {
  /** The failed response, for its status and headers. */
  readonly response: Response
  /** The complete response body. */
  readonly body: string
  /** The reset instant the caller resolved, when one was disclosed. */
  readonly reset: number | undefined
  /** Current epoch milliseconds. */
  readonly now: number
  /** Whether the status was 429. */
  readonly rateLimited: boolean
}

/**
 * The ordered status and refusal classification every subscription route shares.
 *
 * A route with its own ordering composes around this rather than restating it: it decides
 * the cases its provider adds first, then delegates here, so a shared rule changes in one
 * place. Returns undefined for a status this table does not name, which the caller reports
 * as its own `HTTP_<status>` code.
 * @param input - the failed response and the instant facts the table reads.
 * @returns the stable failure code, or undefined for an unnamed status.
 */
export function sharedHttpFailureCode(input: SharedHttpFailureInput): string | undefined {
  const { response, body, reset, now, rateLimited } = input
  const shown = body.slice(0, 500)
  // A 403 or 404 that names one model is evidence about that model, not about
  // the credential: the account may still serve another model.
  if ((response.status === 403 || response.status === 404) && namesModelDenial(body)) return MODEL_DENIED_CODE
  // A refusal the provider stated is final is account-shaped here: billing, credit or a
  // disabled account is not an expired login, and a 429 no window closes.
  if (isEnforcementRefusal(response, body, reset, now)) return ENFORCEMENT_CODE
  if (response.status === 401 || response.status === 403) return 'AUTH'
  if (rateLimited) return 'RATE_LIMIT'
  if (isQuotaExceededError(shown)) return QUOTA_EXCEEDED_CODE
  if (response.status === 400 && isContextWindowExceededError(shown)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (response.status === 409) return CONFLICT_CODE
  if (response.status === 408 || response.status === 504) return 'TIMEOUT'
  if (response.status >= 500) return 'SERVER'
  return undefined
}

/**
 * The message one failed response reports: the diagnostic label, the status, and the
 * provider's own structured error fields — never the raw body.
 * @param label - diagnostic prefix naming the provider API.
 * @param response - the failed response.
 * @param body - the complete response body.
 * @returns the message to report.
 */
export function httpFailureMessage(label: string, response: Response, body: string): string {
  const detail = structuredErrorDetail(body)
  return `${label} error (HTTP ${String(response.status)})${detail.length > 0 ? `: ${detail}` : ''}`
}

/**
 * Build an LlmError from a non-2xx provider response, mapping the status to a
 * stable code and, for a rate-limited request, the disclosed reset instant to
 * the `providerRetryAfterMs` the retry plugin waits out.
 *
 * A 429 classifies as `RATE_LIMIT` on the strength of the status alone, ahead
 * of the quota-wording check. On these routes there is no terminal quota to
 * distinguish: a subscription has no balance to top up, only a window that
 * reopens, and providers announce an exhausted window with wording
 * (`usage_limit_reached`) the shared classifier reads as permanent.
 *
 * {@link isEnforcementRefusal} takes precedence over that: a refusal the
 * provider stated is final — its own stop-retry header, a `rejected` unified
 * status, a disabled account reason, billing or credit wording, or a 429 that
 * disclosed no window — classifies as {@link ENFORCEMENT_CODE}, which no route
 * retries and no pool answers from another account.
 * @param response - the failed response.
 * @param label - diagnostic prefix naming the provider API.
 * @param options - the calling provider's rate-limit reader and warning sink.
 * @returns the classified error.
 */
export async function httpLlmError(
  response: Response,
  label: string,
  options: HttpLlmErrorOptions = {},
): Promise<LlmError> {
  let body = ''
  try {
    body = await response.text()
  } catch {
    // Only swallow error-body reading: the HTTP status still identifies the failure.
  }
  // The readers below need the whole body to classify it; the message carries only the
  // provider's own structured fields, and the raw body rides the error's cause so an
  // arbitrary upstream echo never becomes durable session text.
  const now = Date.now()
  // The provider's reader runs on a 429 and nowhere else. Providers attach
  // their rate-limit headers to every response, so reading them on a transient
  // 500 would report the current window's rollover — hours out — as the delay
  // before retrying a failure that has nothing to do with the window, and the
  // retry plugin honours `providerRetryAfterMs` for every retryable code.
  // `retry-after` stays readable on any status: there it is a real backoff the
  // provider asked for (a 503 shedding load), not a window snapshot.
  //
  // On a 429 the provider's own field wins outright rather than being raced
  // against `retry-after`: a rejected window often carries both, and the
  // generic header then names a short backoff that would burn the retry budget
  // re-hitting the same closed window.
  const rateLimited = response.status === 429
  const retryHeaderReset = options.retryHeaderReset ?? retryAfterInstant
  const reset = rateLimited
    ? options.rateLimitReset?.(response, body, now) ?? retryHeaderReset(response, now)
    : retryHeaderReset(response, now)
  // The shared table names every status these routes classify; a status it does not name keeps
  // its own HTTP code, which no route retries.
  const code = sharedHttpFailureCode({ response, body, reset, now, rateLimited })
    ?? `HTTP_${String(response.status)}`
  if (reset === undefined && rateLimited) {
    options.onWarn?.(`${label}: ${rateLimitDiagnostics(response, body)}`)
  }
  return new LlmError(httpFailureMessage(label, response, body), code, {
    ...body.length === 0 ? {} : { cause: new Error(body) },
    status: response.status,
    ...reset === undefined ? {} : { providerRetryAfterMs: waitFromReset(reset, now) },
  })
}

/**
 * Parse a response's `retry-after` header (seconds) into milliseconds.
 * @param response - the failed response.
 * @returns the delay in ms, or undefined when absent/unusable.
 */
function parseRetryAfterMs(response: Response): number | undefined {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter === null) return undefined
  const seconds = Number(retryAfter)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

/** An idle watchdog: aborts its signal when no SSE activity arrives within the timeout. */
interface IdleWatchdog {
  /** Signal to pass to fetch and body reads; aborts on caller cancel or idle expiry. */
  readonly signal: AbortSignal
  /** Reset the idle timer (call on every received SSE event). */
  pulse(): void
  /** Stop the timer and detach from the caller signal. */
  stop(): void
  /** Whether the last abort came from idle expiry rather than caller cancellation. */
  timedOut(): boolean
}

/**
 * Create an idle watchdog chained to the caller's signal.
 * @param caller - the request's own abort signal, when present.
 * @param timeoutMs - maximum idle interval while a stream read is outstanding.
 * @returns the watchdog; always {@link IdleWatchdog.stop} it when the stream ends.
 */
export function idleWatchdog(caller: AbortSignal | undefined, timeoutMs: number): IdleWatchdog {
  const controller = new AbortController()
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      expired = true
      controller.abort(new Error(`stream idle timeout after ${String(timeoutMs)}ms`))
    }, timeoutMs)
    timer.unref()
  }
  const onCallerAbort = (): void => controller.abort(caller?.reason)
  if (caller?.aborted === true) controller.abort(caller.reason)
  else caller?.addEventListener('abort', onCallerAbort, { once: true })
  arm()
  return {
    signal: controller.signal,
    pulse: arm,
    stop() {
      if (timer !== undefined) clearTimeout(timer)
      caller?.removeEventListener('abort', onCallerAbort)
    },
    timedOut: () => expired,
  }
}

/**
 * Classify a thrown fetch failure. Caller cancellation maps to ABORTED, idle
 * expiry to TIMEOUT, and everything else (DNS, TLS, refused connection) to
 * TRANSPORT with the cause chained.
 * @param label - diagnostic prefix naming the provider API.
 * @param error - the thrown value.
 * @param watchdog - the request's idle watchdog.
 * @param caller - the request's own abort signal, when present.
 * @returns the classified error.
 */
export function mapFetchFailure(
  label: string,
  error: unknown,
  watchdog: IdleWatchdog,
  caller: AbortSignal | undefined,
): LlmError {
  if (watchdog.timedOut()) return new LlmError(`${label} stream idle timeout`, 'TIMEOUT', { cause: error })
  if (caller?.aborted === true) return new LlmError(`${label} request aborted by caller`, 'ABORTED', { cause: error })
  if (error instanceof LlmError) return error
  return new LlmError(`${label} request failed`, 'TRANSPORT', { cause: error })
}

/** OAuth token-endpoint failure carrying the provider's `error` code when it sent one. */
export class OAuthEndpointError extends Error {
  /** HTTP status of the token endpoint response. */
  readonly status: number
  /** The provider's OAuth `error` code (e.g. `invalid_grant`), when present. */
  readonly oauthCode: string | undefined
  /**
   * The endpoint's `retry-after`, in ms, when it sent one. Usage/models
   * endpoints reuse this error type and can rate-limit progressively (each
   * hit within the window extends the next one), so a caller retrying on a
   * fixed schedule instead of honoring this can keep an account locked out
   * indefinitely.
   */
  readonly retryAfterMs: number | undefined

  constructor(message: string, status: number, oauthCode?: string, retryAfterMs?: number) {
    super(message)
    this.name = 'OAuthEndpointError'
    this.status = status
    this.oauthCode = oauthCode
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Read an OAuth JSON error body into an {@link OAuthEndpointError}.
 * @param response - the failed token-endpoint response.
 * @param label - diagnostic prefix naming the provider.
 * @returns the error to throw.
 */
export async function oauthEndpointError(response: Response, label: string): Promise<OAuthEndpointError> {
  let oauthCode: string | undefined
  let detail = ''
  try {
    const parsed = await response.json() as { error?: string; error_description?: string }
    oauthCode = typeof parsed.error === 'string' ? parsed.error : undefined
    detail = typeof parsed.error_description === 'string' ? parsed.error_description : (oauthCode ?? '')
  } catch {
    // Only swallow error-body parsing: the HTTP status still identifies the failure.
  }
  // `detail` and `oauthCode` are the parsed fields, never raw body text: the message
  // keeps a human-readable cause while the body itself is not carried into the session.
  const fallback = oauthCode !== undefined && detail.length > 0
    ? `${oauthCode}: ${detail}`
    : detail
  const message = `${label} token endpoint error (HTTP ${String(response.status)})`
    + (fallback.length > 0 ? `: ${fallback}` : '')
  return new OAuthEndpointError(message, response.status, oauthCode, parseRetryAfterMs(response))
}

/**
 * Describe a refresh failure without exposing credentials or response text.
 *
 * OAuth failures carry the HTTP status and the provider's fixed error code;
 * transport failures may carry a stable platform code. The provider message
 * and body are deliberately omitted because a token endpoint response can
 * contain credentials.
 * @param error - the failure that ended the refresh attempt.
 * @returns a bounded, credential-free diagnostic suffix.
 */
function refreshFailureFacts(error: unknown): string {
  if (error instanceof OAuthEndpointError) {
    const code = error.oauthCode === undefined ? '' : ` ${error.oauthCode}`
    const retry = error.retryAfterMs === undefined
      ? ''
      : `, retry-after ${String(Math.max(0, Math.ceil(error.retryAfterMs / 1000)))}s`
    return `HTTP ${String(error.status)}${code}${retry}`
  }
  if (error instanceof Error) {
    const platformCode = (error as { code?: unknown }).code
    if (typeof platformCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(platformCode)) {
      return `${error.name} (${platformCode})`
    }
    return error.name.length === 0 ? 'unknown failure' : error.name
  }
  return 'unknown failure'
}

/** A session fresh enough to serve a request without a refresh. */
interface TimedSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/** Provider hooks the token manager needs. */
export interface TokenManagerOptions<S extends TimedSession> {
  /** Human-readable provider name for error messages. */
  displayName: string
  /** Refresh this long before `expiresAt`. */
  preemptMs: number
  load(): Promise<S | undefined>
  /**
   * Read the stored session together with the revision it is stored under, in ONE read.
   *
   * This is the read a refresh spends its grant from, and it is deliberately not two calls:
   * reading the session and then the revision separately lets a logout and a same-token
   * re-login land between them, pairing the old session with the new revision so the
   * conditional write succeeds and overwrites the login. Absent falls back to
   * {@link load}, with the token comparison as the whole guard.
   * @returns the stored session and its revision; `session` is `undefined` when logged out.
   */
  loadCredential?(): Promise<{ session: S | undefined; revision: number | undefined }>
  /**
   * Persist a refresh result under the manager's own scope key. The store is
   * the authority, and the manager re-reads after every save, so an
   * implementation need not report a conditional write it refused.
   * @param session - the refreshed session to store.
   * @param expectedPrior - the session the refresh spent.
   * @param expectedRevision - the revision that session was read under.
   */
  save(session: S, expectedPrior?: S, expectedRevision?: number): Promise<void>
  /**
   * Delete the stored session. With `expectedPrior`, the store deletes it only
   * while it is still that session, so a removal cannot destroy a login or a
   * rotation that landed after the caller read it.
   * @param expectedPrior - the session this refresh spent, when one was attempted.
   * @param expectedRevision - the revision that session was read under.
   * @returns true when the session was removed, false when the removal was
   *   refused because the store held something else. An implementation may
   *   return nothing, which reads as removed.
   */
  remove(expectedPrior?: S, expectedRevision?: number): Promise<void | boolean>
  /** Perform the provider's refresh-token grant. */
  refresh(session: S): Promise<S>
  /** Whether a refresh failure is permanent (re-login required). */
  isPermanent(error: unknown): boolean
  /** Called when a permanent refresh failure actually deleted the stored session. */
  onRemoved?(): void
  /**
   * Run one account's whole refresh cycle — re-read the store, spend the grant, save —
   * under cross-process ownership, so two cooperating processes sharing one credential
   * store cannot both spend the same refresh grant. Absent keeps the in-process
   * single-flight and the store's conditional write alone.
   *
   * Ownership is a precondition, not a hint: a cycle that cannot own the scope must not
   * run, because rotating without it is exactly the double-spend this prevents. The
   * manager answers a refusal with {@link REFRESH_BUSY_CODE} so a caller with a still-valid
   * credential keeps it instead of sending an expired one.
   * @param cycle - the read-refresh-save sequence to run while owned.
   * @returns the cycle's outcome, or `{ acquired: false }` when another owner held it.
   */
  withRefreshOwnership?<T>(cycle: () => Promise<T>): Promise<RefreshOwnershipOutcome<T>>
}

/**
 * Whether a refresh failure means this scope's session is gone from the store
 * rather than temporarily unusable. Such a failure never takes the transient
 * fallback (the credential the caller holds was logged out) and never takes the
 * permanent branch (there is nothing left to remove or report).
 * @param error - the thrown refresh failure.
 * @returns true when the caller must see the logged-out result.
 */
function isMissingCredential(error: unknown): boolean {
  return error instanceof LlmError && error.code === 'MISSING_CREDENTIAL'
}

/**
 * The failure a refresh reports when another owner holds cross-process refresh ownership
 * for the account and the wait was exhausted.
 *
 * Deliberately neither `AUTH` nor `INVALID_CREDENTIAL`: no grant was spent and nothing was
 * refused by the provider, so the credential is untouched and the caller may retry. It is
 * not retryable by the pool either — the pool's classifier fails the turn on an unknown
 * code without parking the account.
 */
export const REFRESH_BUSY_CODE = 'REFRESH_BUSY'

/**
 * What a {@link TokenManagerOptions.withRefreshOwnership} implementation reports.
 * @typeParam T - the value the owned cycle produces.
 */
export type RefreshOwnershipOutcome<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false }

/**
 * Per-provider session freshness: loads the stored session, refreshes
 * proactively inside the preempt window or on demand after a 401, and
 * coalesces concurrent refreshes behind one in-flight promise. Permanent
 * refresh failures delete the stored session and surface INVALID_CREDENTIAL
 * with a re-login hint; transient failures fall back to a still-valid token.
 *
 * The stored session is the authority. A refresh answers with what the store
 * holds after the write, so a save the store refused — a logout, a re-login or
 * a concurrent rotation that won the compare-and-set — is never returned, and a
 * scope whose session disappeared while the refresh ran fails
 * MISSING_CREDENTIAL instead of reviving the credential the caller still holds.
 * A permanent failure likewise deletes the session it spent only while the
 * store still holds it, serves a login that landed in the meantime, and reports
 * the removal once.
 */
export class TokenManager<S extends TimedSession> {
  private inflight: Promise<S> | undefined
  /** The session whose refresh token the in-flight refresh is spending. */
  private attempted: S | undefined
  /** The revision that session was read under, when the backend keeps one. */
  private attemptedRevision: number | undefined

  constructor(private readonly options: TokenManagerOptions<S>) {
    this.options = options
  }

  /**
   * Read the stored session without any refresh side effect. Catalog queries
   * (`listModels`) use this to decide whether the provider is logged in.
   * @returns the stored session, or `undefined` when logged out.
   */
  peek(): Promise<S | undefined> {
    return this.options.load()
  }

  /**
   * Whether a session is currently stored (cheap; never refreshes).
   * @returns true when logged in.
   */
  async hasSession(): Promise<boolean> {
    return (await this.options.load()) !== undefined
  }

  /**
   * Resolve a usable session, refreshing proactively or on demand.
   * @param forceRefresh - refresh regardless of expiry (used after a 401).
   * @returns the persisted session to send.
   * @throws LlmError MISSING_CREDENTIAL when logged out — including a scope
   *   whose session was removed while its refresh was in flight, which is never
   *   revived and never answered with the pre-logout credential;
   *   INVALID_CREDENTIAL when the refresh grant is permanently rejected.
   */
  async session(forceRefresh = false): Promise<S> {
    const session = await this.options.load()
    if (session === undefined) throw this.missingCredential()
    if (!forceRefresh && session.expiresAt - Date.now() > this.options.preemptMs) {
      return session
    }
    this.inflight ??= this.doRefresh(session).finally(() => {
      this.inflight = undefined
    })
    try {
      return await this.inflight
    } catch (error) {
      // Nothing is stored for this scope any more: the account was removed while
      // the refresh ran. The transient fallback would send the pre-logout
      // credential, and the permanent branch would report a removal and delete an
      // account that is already gone, so the logged-out result is the whole answer.
      if (isMissingCredential(error)) throw error
      if (this.options.isPermanent(error)) {
        // Remove only the session this refresh was spending. The store performs
        // the comparison inside its own lock, so a re-login or a concurrent
        // rotation that stored a different session between the read and this
        // call wins and the removal is refused.
        const attempted = this.attempted
        const attemptedRevision = this.attemptedRevision
        const removed = attempted === undefined
          ? await this.options.remove(undefined, attemptedRevision)
          : await this.options.remove(attempted, attemptedRevision)
        // Read the winner: a login that landed while this refresh was failing is
        // served instead of being reported as a dead credential.
        const stored = await this.options.load()
        if (stored !== undefined) return stored
        // Only the caller whose removal deleted the entry reports it, so
        // concurrent waiters that lost the removal stay silent.
        if (removed !== false) this.options.onRemoved?.()
        throw new LlmError(
          `${this.options.displayName} login expired or was revoked (${refreshFailureFacts(error)}); log in again via Settings → Subscriptions`,
          'INVALID_CREDENTIAL',
          { cause: error },
        )
      }
      if (!forceRefresh && session.expiresAt > Date.now()) {
        // Transient refresh failure with a still-valid token: use it.
        return session
      }
      throw error instanceof LlmError
        ? error
        : new LlmError(
          `${this.options.displayName} token refresh failed (${refreshFailureFacts(error)})`,
          'AUTH',
          { cause: error },
        )
    }
  }

  /** The logged-out result for this manager's own scope. */
  private missingCredential(): LlmError {
    return new LlmError(
      `dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; `
      + 'log in via Settings → Subscriptions in the dsh web app',
      'MISSING_CREDENTIAL',
    )
  }

  private async doRefresh(session: S): Promise<S> {
    const ownership = this.options.withRefreshOwnership
    if (ownership === undefined) return this.refreshCycle(session)
    const outcome = await ownership(() => this.refreshCycle(session))
    if (outcome.acquired) return outcome.value
    // Another owner is rotating this credential. The store is re-read before giving up:
    // that owner may already have stored its result, and a credential that outlives the one
    // this caller holds is the one to send — never the credential the winner just replaced.
    const stored = await this.options.load()
    if (stored === undefined) throw this.missingCredential()
    if (stored.accessToken !== session.accessToken && stored.expiresAt > session.expiresAt) return stored
    throw new LlmError(
      `${this.options.displayName} credential refresh is owned by another process; retry shortly`,
      REFRESH_BUSY_CODE,
    )
  }

  private async refreshCycle(session: S): Promise<S> {
    // The session a grant is spent from and its revision come from one read, so no writer
    // can land between them and pair this session with a revision it was never stored under.
    const combined = this.options.loadCredential
    const read = combined === undefined
      ? { session: await this.options.load(), revision: undefined }
      : await combined()
    const current = read.session
    if (current !== undefined
      && current.accessToken !== session.accessToken
      && current.expiresAt - Date.now() > this.options.preemptMs) {
      return current
    }
    // This scope's session is gone: the account was removed after the caller
    // read it. Refreshing the caller's copy would spend a grant and hand back a
    // credential the store no longer holds, so the removal is the whole answer.
    if (current === undefined) throw this.missingCredential()
    const attempted = current
    this.attempted = attempted
    const attemptedRevision = read.revision
    this.attemptedRevision = attemptedRevision
    const next = await this.options.refresh(attempted)
    await this.options.save(next, attempted, attemptedRevision)
    // The stored session is the authority, not the grant just minted: the save
    // may have been refused (a logout, a re-login or a concurrent rotation won
    // the compare-and-set) and the save hook need not report that. Re-read and
    // answer with what the store holds now — never a session it refused. The
    // manager knows only its own scope key, so it cannot judge whether a winner
    // is the same user; any identity decision belongs to the caller that owns
    // the account key.
    const stored = await this.options.load()
    if (stored === undefined) throw this.missingCredential()
    return stored
  }

  /**
   * Persist a caller-updated session without touching refresh state. Identity
   * backfill (minted device id, discovered account uuid) uses this; the next
   * {@link session} read loads the updated copy from the store.
   * @param session - the updated session to store.
   * @param expectedPrior - the stored session this update was derived from. The
   *   store refuses the write once another writer has replaced it, so a backfill
   *   cannot roll a rotation back.
   * @param expectedRevision - the revision that stored session was read under. A
   *   caller that read the session and its revision together passes it so a
   *   write derived from that read is refused once the record has moved on —
   *   including by a write that left the credential fields identical, such as an
   *   ownership-mode change, a logout or a same-token re-login. Absent keeps the
   *   session comparison as the whole guard.
   */
  async replace(session: S, expectedPrior?: S, expectedRevision?: number): Promise<void> {
    await this.options.save(session, expectedPrior, expectedRevision)
  }
}

/** Fetch signature adapters accept for discovery calls (injectable for tests). */
export type FetchFn = typeof fetch

/** Bound on one account catalog fetch or usage poll — a hang must not block the picker. */
export const DISCOVERY_TIMEOUT_MS = 10_000

/**
 * Run `work` with an aborting signal. Resolves undefined when the timeout
 * fires (the fetch is aborted); other failures propagate.
 */
export function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  const signal = AbortSignal.timeout(timeoutMs)
  const aborted = new Promise<undefined>(resolve => {
    if (signal.aborted) resolve(undefined)
    else signal.addEventListener('abort', () => resolve(undefined), { once: true })
  })
  return Promise.race([
    work(signal).then(
      value => (signal.aborted ? undefined : value),
      (error: unknown) => {
        if (signal.aborted) return undefined
        throw error
      },
    ),
    aborted,
  ])
}

/** One rate-limit window reported by a provider's usage endpoint. */
export interface UsageWindow {
  /** Window kind: `session` for the short rolling window, `weekly` for the 7-day one. */
  kind: 'session' | 'weekly' | 'other'
  /** Model scope for model-specific windows (e.g. `Opus`), when the provider names one. */
  scope?: string
  /** Percent of the window already consumed (0–100). */
  usedPercent: number
  /** Epoch milliseconds at which the window resets, when the provider discloses it. */
  resetsAt?: number
}

/** One banked ChatGPT rate-limit reset credit, as listed by the credits endpoint. */
export interface ResetCredit {
  /** Provider credit id. Sent back unchanged on consume. */
  id: string
  /** `available` credits can be spent; anything else is display-only. */
  status: 'available' | 'redeemed' | 'expired' | 'other'
  title?: string
  description?: string
  /** ISO timestamp from the provider, when present. */
  grantedAt?: string
  /** ISO timestamp from the provider, when present. */
  expiresAt?: string
  /** Provider reset type, such as `codex_rate_limits`. */
  resetType?: string
}

/** `resetCredits` endpoint value. `supported: false` when the provider has no credits. */
export interface ResetCreditList {
  supported: boolean
  /** Credits that can still be spent, when the provider disclosed a count. */
  availableCount?: number
  credits?: ResetCredit[]
}

/**
 * `consumeResetCredit` endpoint value. A resolved result means the provider
 * accepted the spend (HTTP 200); callers refetch usage for the new windows.
 */
export interface ResetCreditConsumeResult {
  code?: string
  windowsReset?: number
}

/**
 * How fresh a usage payload is, from the reader's point of view. A payload read
 * from cache without an upstream round trip is `missing`, `stale` or `error`
 * rather than absent, so a display surface can say what it knows instead of
 * presenting a never-observed account as an empty one.
 */
export type UsageCacheState = 'fresh' | 'stale' | 'missing' | 'error' | 'refreshing'

/**
 * Safe classification of a failed usage read. It carries no provider message,
 * token or response body, so it is safe to persist and to show.
 */
export type UsageFailureReason = 'rate_limited' | 'unauthorized' | 'unreachable' | 'invalid_response' | 'unknown'

/** Freshness of one usage payload, alongside the windows it describes. */
export interface UsageCacheMeta {
  /** Freshness of the payload this metadata accompanies. */
  state: UsageCacheState
  /** Epoch milliseconds of the newest observation behind the payload, when one exists. */
  observedAt?: number
  /** Epoch milliseconds a recorded failure stops suppressing upstream reads. */
  retryAt?: number
  /** Why the last upstream read failed, when one did. */
  error?: UsageFailureReason
}

/** Subscription usage of one provider, as served by the `usage` RPC endpoint. */
export interface ProviderUsage {
  /** False when the provider has no usage endpoint (grok); windows are absent then. */
  supported: boolean
  /** Usage windows in display order. */
  windows?: UsageWindow[]
  /** Plan name the usage endpoint reported, when present. */
  plan?: string
  /**
   * Banked rate-limit reset credits, when this usage payload disclosed a count.
   * Absent means the provider did not report the field — not "zero credits".
   */
  resetCredits?: {
    availableCount: number
    /** Earliest expiry among available credits, epoch ms. Pool selection only. */
    soonestExpiresAt?: number
  }
  /**
   * The unified rate-limit report of this account's last answered request, when
   * one was captured. It states the account's standing more precisely than the
   * usage windows do — a `rejected` status is the provider refusing requests —
   * and is absent for accounts that have not issued a request since startup.
   */
  rateLimit?: UnifiedRateLimitState
  /**
   * The account pool's view of this account, present only while the pool is
   * enabled. It is what separates a pool condition (another account is serving
   * instead) from a fact about this account alone.
   */
  pool?: UsagePoolState
  /**
   * Freshness of this payload. Present for reads served from the plugin's own
   * usage cache — which is every read that did not just perform an upstream
   * round trip — and absent when the payload came straight from a provider
   * fetcher with no cache in front of it.
   */
  cache?: UsageCacheMeta
}

/** The account pool's view of one account, as the `usage` endpoint reports it. */
export interface UsagePoolState {
  /**
   * Why the pool parked this account: `auth` when the stored login stopped
   * working (only a re-login clears it), `quota` for a spent allowance or a
   * rate limit. Read only together with `coolingUntil`.
   */
  coolingReason?: 'auth' | 'quota'
  /** Epoch ms the pool parks this account until; absent when it is not parked. */
  coolingUntil?: number
  /**
   * Whether another account that may serve this provider's pool is clear right
   * now. False when the pool is disabled, the account is the only member, or
   * every other member is parked or past a usage floor the pool reserves.
   */
  peerAvailable: boolean
}

/** One model discovered from a provider's live model-list endpoint. */
export interface DiscoveredModel {
  /** Account-specific server-advertised ceiling for local context overrides. */
  maxContextWindow?: number
  /** Wire model id. */
  id: string
  /** Human-readable display name. */
  name: string
  description?: string
  /**
   * The reason the provider's catalogue marks this entry unavailable to the account,
   * or absent when it is selectable. The row stays listed so the picker can show a
   * model the account cannot use instead of dropping it silently.
   */
  disabledReason?: string
  /** Advertised combined context capacity in tokens. */
  contextWindow?: number
  /** Server-advertised per-request output token ceiling, when disclosed. */
  maxOutputTokens?: number
  /** Provider sort hint; lower sorts earlier. */
  priority?: number
  /** Advertised reasoning efforts, when the provider discloses them. */
  reasoning?: {
    efforts: { id: ReasoningEffortId; name: string; description?: string }[]
    defaultEffort?: ReasoningEffortId
  }
  /** Accepted request modalities the endpoint advertised (e.g. Copilot's vision support flag). */
  inputModalities?: ('text' | 'image')[]
  /** The catalog advertises a fast tier (Codex priority service, Cursor's `fast` parameter, or Claude's `fast_mode` capability). */
  fastTier?: boolean
  /**
   * Cursor `models.list` parameters. Sent back as `model.params`.
   * Other providers leave this unset.
   */
  cursorParameters?: {
    id: string
    values: { value: string; name?: string }[]
  }[]
  /** Cursor default variant parameter values. */
  cursorDefaults?: { id: string; value: string }[]
  /** Copilot-specific: which upstream protocol the model's endpoints speak. */
  copilotWire?: 'chat-completions' | 'responses'
  /**
   * Copilot-specific: the catalog also lists `/responses` for this model
   * (dual-protocol entries, e.g. gpt-5.4), so a chat-wire request may reroute
   * there when it combines function tools with a reasoning effort.
   */
  copilotResponses?: boolean
}

/** Display name for a wire reasoning-effort identifier. */
export function effortDisplayName(effort: string): string {
  return effort === 'xhigh' ? 'Extra High' : effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** The reasoning-block shape every caller passes to {@link mergeReasoning}. */
interface ReasoningBlock {
  efforts: readonly { id: ReasoningEffortId; name: string; description?: string }[]
  defaultEffort?: ReasoningEffortId
}

/**
 * Fold a configured per-model default effort into a reasoning block, keeping
 * the DSH runtime invariant `defaultEffort ∈ efforts` (the runtime rejects an
 * unknown default with `INVALID_MODEL_REASONING`).
 *
 * A configured level the base set does not advertise is *dropped*, not
 * appended: for claude/grok/copilot the base is the provider's live catalog,
 * i.e. the truth about what the model accepts, so honouring a stale override
 * would put an unsupported effort on every single request instead of letting
 * the harness reject it before provider I/O. The override then simply falls
 * back to the provider's own default until the user picks a level the catalog
 * still lists.
 *
 * `extendable` opts into the opposite rule for a base that is a *built-in
 * fallback* rather than discovered truth (codex, whose static effort list is
 * known to trail the backend): there, appending the configured level is how a
 * newly shipped tier becomes selectable at all.
 * @param configuredDefault - the user-configured default effort id, or undefined.
 * @param base - the discovered/built-in reasoning block, or undefined.
 * @param options - `extendable` marks the base as a fallback that may be extended.
 * @returns the merged block, or undefined when neither side contributes one.
 */
export function mergeReasoning(
  configuredDefault: string | undefined,
  base: ReasoningBlock | undefined,
  options?: { extendable?: boolean },
): DiscoveredModel['reasoning'] | undefined {
  const detached = base === undefined
    ? undefined
    : {
      efforts: [...base.efforts],
      ...(base.defaultEffort === undefined ? {} : { defaultEffort: base.defaultEffort }),
    }
  if (configuredDefault === undefined) return detached
  const effort = ReasoningEffortId(configuredDefault)
  if (base === undefined) {
    // No capability information at all (catalog unavailable, or a model the
    // catalog does not cover). Inventing a reasoning block here would claim a
    // capability nobody advertised; only a fallback-based provider may.
    return options?.extendable === true
      ? { efforts: [{ id: effort, name: effortDisplayName(effort) }], defaultEffort: effort }
      : undefined
  }
  if (base.efforts.some(entry => entry.id === effort)) {
    return { efforts: [...base.efforts], defaultEffort: effort }
  }
  if (options?.extendable !== true) return detached
  return {
    efforts: [...base.efforts, { id: effort, name: effortDisplayName(effort) }],
    defaultEffort: effort,
  }
}

/**
 * First account catalog that lists `model` (callers pass default-first).
 *
 * One failing lookup sits that account out so a sibling's metadata still
 * resolves — the same isolation as the picker catalog union.
 *
 * Deliberately unfiltered by the pool health registry. This answers "what does
 * this model support", not "who serves the next turn": the account list is every
 * logged-in account, a catalogue read carries no completion request, and the
 * route that actually serves is chosen by the pool's own selection, which applies
 * health and the usage floors. Filtering parked accounts here would instead drop
 * the capability metadata an in-flight session depends on for exactly as long as
 * its account is cooling. A parked account whose credential no longer resolves
 * still sits out through the lookup's own failure.
 * @param accounts - the accounts to ask, default first.
 * @param lookup - one account's catalog reader.
 * @returns the first entry found, or undefined when no account lists the model.
 */
export async function discoverAcrossAccounts(
  accounts: readonly string[],
  lookup: (account: string) => Promise<DiscoveredModel | undefined>,
): Promise<DiscoveredModel | undefined> {
  for (const account of accounts) {
    let found: DiscoveredModel | undefined
    try {
      found = await lookup(account)
    } catch (_lookupFailure) {
      // This account's catalog could not be read (an unrefreshable credential, an
      // unreachable or refused endpoint); the next account may still answer.
      continue
    }
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * How long a discovered catalogue is trusted before an explicit event may
 * refresh it. Freshness is only ever read at those events: no timer and no read
 * path consults it. A route overrides it with `catalogMaxAgeMs`.
 */
export const DEFAULT_CATALOG_MAX_AGE_MS = 24 * 60 * 60_000

/**
 * Failure cooldown applied when a catalogue request failed without disclosing a
 * `retry-after`, so one outage is not re-queried at every explicit event. A route
 * overrides it with `cacheRetryDelayMs`.
 */
export const DEFAULT_CACHE_RETRY_DELAY_MS = 60_000

/** A durable snapshot of one provider account's discovered catalogue. */
export interface CatalogSnapshot {
  /** Epoch milliseconds of the successful fetch that produced it. */
  at: number
  /**
   * The models the provider advertised. An empty array is an authoritative
   * "this account lists nothing", distinct from having no snapshot at all.
   */
  models: DiscoveredModel[]
}

/**
 * One failed catalogue request's cooldown, persisted beside the last good
 * snapshot so a RESTART still honours a `retry-after` the provider disclosed.
 * It carries no models and no fetch time: it is a hint about when the next
 * request may run, never a catalogue, and never a fabricated `at`.
 */
export interface CatalogFailure {
  /** Epoch milliseconds before which no catalogue request may run again. */
  notBefore: number
}

/**
 * The durable state of one provider account's catalogue: the last good snapshot
 * and the last failure's cooldown, either of which may be absent on its own. A
 * cold account that failed holds a failure alone — nothing is invented to make
 * it look like a catalogue that was ever fetched.
 */
export interface CatalogRecord {
  /** The last successfully stored catalogue, when one exists. */
  snapshot?: CatalogSnapshot
  /** The last failed request's cooldown, while it is still meaningful. */
  failure?: CatalogFailure
}

/** The durable half of a {@link ModelCatalogCache} for ONE provider account. */
export interface CatalogPersistence {
  /** The persisted record, or undefined when the account has none. */
  load(): Promise<CatalogRecord | undefined>
  /**
   * Persist a fresh snapshot (write-through after every successful fetch). A
   * stored failure is dropped: its cooldown belongs to the request that failed,
   * and this one answered.
   */
  save(snapshot: CatalogSnapshot): Promise<void>
  /**
   * Persist a failure's cooldown, keeping the last good snapshot if there is
   * one. Optional on a double that keeps no durable state.
   */
  saveFailure?(failure: CatalogFailure): Promise<void>
  /** Drop the persisted record (the login or the catalogue identity changed). */
  clear(): Promise<void>
}

/**
 * Durable store factory a route supplies so EVERY logged-in account keeps its
 * own catalogue, not only the default one. The key is the account key.
 *
 * The two provider-wide operations exist for a logout that must drop records no
 * in-memory cache holds: an account removed before its cache was ever built.
 * Both are optional so a test double may implement only the per-account half.
 */
export interface CatalogStoreFactory {
  /** The persistence hooks for one account key (usable without building a cache). */
  (account: string): CatalogPersistence
  /** Account keys this provider has a persisted entry for, without loading any. */
  accounts?(): Promise<readonly string[]>
  /** Drop every persisted entry of this provider, cache or no cache. */
  clearAll?(): Promise<void>
}

/** One account's explicit catalogue-refresh outcome. */
export type CatalogRefreshOutcome =
  | { status: 'fetched'; models: readonly DiscoveredModel[] }
  /** Nothing was requested: the entry is fresh, or a failure is still cooling down. */
  | { status: 'skipped'; reason: 'fresh' | 'cooldown' }
  /** The caller stopped waiting; the shared request continues for other waiters. */
  | { status: 'cancelled' }

/** What one provider-wide explicit refresh requested, skipped, cancelled or failed. */
export interface CatalogRefreshReport {
  /** Accounts whose catalogue this call requested from the provider. */
  fetched: readonly string[]
  /** Accounts answered from cache: nothing was missing/stale, or a failure is cooling down. */
  skipped: readonly string[]
  /** Accounts whose request ran and failed; each keeps its last-known catalogue. */
  failed: readonly string[]
  /** Accounts whose caller stopped waiting before the shared request settled. */
  cancelled: readonly string[]
}

/** Durability, freshness bounds and warning sink of one {@link ModelCatalogCache}. */
export interface ModelCatalogCacheOptions {
  /** Durable half for this account; absent keeps the cache in memory only. */
  persistence?: CatalogPersistence
  /** Freshness window; stale makes the entry eligible for an explicit refresh. */
  maxAgeMs?: number
  /** Failure cooldown when the failure disclosed no `retry-after`. */
  retryDelayMs?: number
  /** Warning sink for an unreadable cache file or a failed save. */
  onWarn?: (message: string) => void
  /** Provider name in warnings, e.g. `codex`. */
  label?: string
  /**
   * Called once when a refresh STORES a catalogue that differs from what was
   * stored before. It belongs to the accepted result rather than to any waiting
   * caller: several callers share one request, a caller that detached still
   * leaves that request running, and one stored catalogue is one notification.
   */
  onStored?: () => void
}

/**
 * The cooldown one failed request earns: the provider's own `retry-after` when
 * it disclosed one — through either the classified `LlmError` or the raw
 * `OAuthEndpointError` a route's own endpoint reader throws — otherwise the
 * route's configured default.
 */
function catalogCooldownMs(error: unknown, fallbackMs: number): number {
  const disclosed = error instanceof LlmError
    ? error.failure.providerRetryAfterMs
    : error instanceof OAuthEndpointError ? error.retryAfterMs : undefined
  return typeof disclosed === 'number' && Number.isFinite(disclosed) && disclosed > 0 ? disclosed : fallbackMs
}

/**
 * Whether a newly stored catalogue differs from the one it replaces. Compared
 * as persisted, which is exactly what a re-reading picker would see.
 */
function sameCatalog(previous: readonly DiscoveredModel[] | undefined, next: readonly DiscoveredModel[]): boolean {
  return JSON.stringify(previous ?? null) === JSON.stringify(next)
}

/**
 * Await `work`, or stop waiting when the caller aborts. The work itself keeps
 * running: several callers share one request, and one caller's cancellation
 * must not abort what the others still await.
 * @param work - the shared operation.
 * @param signal - the calling waiter's cancellation, when any.
 * @returns the result, or `undefined` when this waiter detached.
 */
async function waitUnlessAborted<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<{ value: T } | undefined> {
  if (signal === undefined) return { value: await work }
  if (signal.aborted) return undefined
  let detach!: () => void
  const aborted = new Promise<undefined>((resolve) => { detach = () => { resolve(undefined) } })
  const onAbort = (): void => { detach() }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([work.then(value => ({ value })), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * ONE provider account's discovered-model catalogue.
 *
 * Reads ({@link read}, {@link lastKnown}) are pure: they may load the local
 * cache file, they never start a provider request, and a stale entry is served
 * as-is. Capability metadata (reasoning efforts) must stay stable for a session
 * that selected an effort, so losing it to a lapsed window would fail
 * mid-conversation calls with UNSUPPORTED_REASONING_EFFORT before provider I/O.
 *
 * {@link refresh} is the only path that starts a request, and it runs only when
 * an explicit event asks for it. It coalesces concurrent callers into one
 * request, keeps the last good snapshot when the request fails, and records a
 * failure cooldown so repeated events do not re-query a failing provider.
 * {@link invalidate} drops memory and disk and bumps the generation, so an
 * in-flight request that lost that race cannot write its result back.
 */
export class ModelCatalogCache {
  private entry: CatalogSnapshot | undefined
  private inflight: Promise<readonly DiscoveredModel[]> | undefined
  /** Settles once the persisted snapshot (when any) has been considered. */
  private seeded: Promise<void> | undefined
  /** Set by {@link invalidate} so an in-flight disk read cannot resurrect dropped state. */
  private seedDisabled = false
  /** Bumped by {@link invalidate} so a loser in-flight request cannot write back. */
  private generation = 0
  /** Epoch ms before which a refresh is skipped after a failure. */
  private retryNotBefore: number | undefined
  /** Every request and cache clear still running, so a route can drain them. */
  private readonly work = new Set<Promise<unknown>>()
  private readonly maxAgeMs: number
  private readonly retryDelayMs: number

  constructor(private readonly options: ModelCatalogCacheOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_CATALOG_MAX_AGE_MS
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_CACHE_RETRY_DELAY_MS
  }

  /**
   * The last-known catalogue for this account, from memory or the local cache
   * file. Pure: it starts no provider request, however cold or stale it is.
   * @returns the models, or `undefined` when nothing is known. `[]` is a known
   *   catalogue that lists nothing, not an absent one.
   */
  async read(): Promise<readonly DiscoveredModel[] | undefined> {
    await this.ensureSeeded()
    return this.entry?.models
  }

  /**
   * The last-known catalogue already in memory, ignoring freshness.
   * @returns the models, or `undefined` before anything has been seeded or fetched.
   */
  lastKnown(): readonly DiscoveredModel[] | undefined {
    return this.entry?.models
  }

  /** Whether the entry is missing or older than the freshness window. */
  stale(): boolean {
    return this.entry === undefined || Date.now() - this.entry.at >= this.maxAgeMs
  }

  /**
   * Load the persisted record once; a request or invalidate that landed first
   * wins. Both halves are seeded: the last good catalogue and, when it has not
   * lapsed, the cooldown a failed request left behind — so a restart does not
   * re-ask a provider that named its own retry instant.
   */
  private ensureSeeded(): Promise<void> {
    const persistence = this.options.persistence
    if (persistence === undefined) return Promise.resolve()
    this.seeded ??= persistence.load().then(
      (record) => {
        if (record === undefined || this.seedDisabled) return
        if (record.snapshot !== undefined && this.entry === undefined) this.entry = record.snapshot
        const notBefore = record.failure?.notBefore
        if (notBefore !== undefined && notBefore > Date.now() && this.retryNotBefore === undefined) {
          this.retryNotBefore = notBefore
        }
      },
      (error: unknown) => {
        // An unreadable cache file is not a catalogue: say so rather than letting
        // the caller believe the empty read is the provider's own answer.
        this.options.onWarn?.(
          `${this.label()} catalogue cache could not be read (${errorChain(error)}); serving it as absent`,
        )
      },
    )
    return this.seeded
  }

  /** Track work a route must be able to drain before it is dropped. */
  private track<T>(work: Promise<T>): Promise<T> {
    this.work.add(work)
    const done = (): void => { this.work.delete(work) }
    void work.then(done, done)
    return work
  }

  /** Write the snapshot through, reporting a save failure without losing memory state. */
  private async persist(snapshot: CatalogSnapshot): Promise<void> {
    const persistence = this.options.persistence
    if (persistence === undefined) return
    try {
      await persistence.save(snapshot)
    } catch (error: unknown) {
      this.options.onWarn?.(
        `${this.label()} catalogue could not be saved (${errorChain(error)}); it stays in memory only`,
      )
    }
  }

  /**
   * Persist a failure's cooldown, so the wait the provider disclosed survives a
   * restart. Reported rather than thrown: failing to remember it costs one
   * extra request, which is what the memory-only behaviour cost anyway.
   */
  private async persistFailure(failure: CatalogFailure): Promise<void> {
    const persistence = this.options.persistence
    if (persistence?.saveFailure === undefined) return
    try {
      await persistence.saveFailure(failure)
    } catch (error: unknown) {
      this.options.onWarn?.(
        `${this.label()} catalogue failure cooldown could not be saved (${errorChain(error)})`,
      )
    }
  }

  /** Run (or join) the single in-flight request, updating memory and disk on success. */
  private run(fetcher: () => Promise<readonly DiscoveredModel[]>): Promise<readonly DiscoveredModel[]> {
    if (this.inflight !== undefined) return this.inflight
    const gen = this.generation
    const pending = fetcher()
      .then(async (models) => {
        if (this.generation !== gen) return models
        const snapshot: CatalogSnapshot = { at: Date.now(), models: [...models] }
        const moved = !sameCatalog(this.entry?.models, snapshot.models)
        this.entry = snapshot
        this.retryNotBefore = undefined
        await this.persist(snapshot)
        // The accepted result reports itself: one stored catalogue is one
        // notification, whether one caller waited or several, and whether or not
        // any of them was still attached when it settled.
        if (moved) this.options.onStored?.()
        return snapshot.models
      })
      .catch(async (error: unknown) => {
        if (this.generation === gen) {
          const cooldownMs = catalogCooldownMs(error, this.retryDelayMs)
          if (cooldownMs > 0) {
            this.retryNotBefore = Date.now() + cooldownMs
            await this.persistFailure({ notBefore: this.retryNotBefore })
          }
        }
        throw error
      })
      .finally(() => {
        if (this.generation === gen) this.inflight = undefined
      })
    this.inflight = this.track(pending)
    // A waiter that detached on its own signal must not leave an unhandled rejection.
    void pending.catch(() => undefined)
    return pending
  }

  /**
   * Request this account's catalogue from the provider: the only path that
   * starts a provider request. Concurrent callers share one request, and a
   * failure keeps the last good snapshot in place.
   * @param fetcher - performs the provider's model-list request.
   * @param options - `force` re-requests a fresh SUCCESS snapshot (an explicit
   *   user refresh); it never bypasses a live failure cooldown, which is the
   *   retry storm that cooldown exists to prevent. `signal` detaches THIS waiter
   *   alone; the shared request continues for the others.
   * @returns what this call did. A failed request rejects. A request that was
   *   invalidated mid-flight (a logout dropped the account) still reports
   *   `fetched`, because it ran, but its result is not stored.
   */
  async refresh(
    fetcher: () => Promise<readonly DiscoveredModel[]>,
    options: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<CatalogRefreshOutcome> {
    await this.ensureSeeded()
    // A caller that already cancelled must not start a request nothing is waiting for.
    if (options.signal?.aborted === true) return { status: 'cancelled' }
    if (options.force !== true && !this.stale()) return { status: 'skipped', reason: 'fresh' }
    if (this.retryNotBefore !== undefined && Date.now() < this.retryNotBefore) {
      return { status: 'skipped', reason: 'cooldown' }
    }
    const settled = await waitUnlessAborted(this.run(fetcher), options.signal)
    if (settled === undefined) return { status: 'cancelled' }
    return { status: 'fetched', models: settled.value }
  }

  /**
   * Drop the cached catalogue: memory, the persisted entry, and the generation
   * an in-flight request would need to write back. The next refresh re-reads it.
   */
  invalidate(): void {
    this.generation += 1
    this.entry = undefined
    this.inflight = undefined
    this.seedDisabled = true
    this.retryNotBefore = undefined
    const persistence = this.options.persistence
    if (persistence !== undefined) void this.track(persistence.clear().catch(() => undefined))
  }

  /**
   * Forget a failure cooldown so ONE immediate retry may run, for a caller that
   * has just renewed the credential the failed attempt used. The cooldown is
   * meant for a provider that keeps refusing, not for the same request retried
   * with a fresh token; a retry that also fails re-arms it, and one that answers
   * clears the persisted hint with the snapshot it stores.
   */
  clearFailureCooldown(): void {
    this.retryNotBefore = undefined
  }

  /**
   * Await every request and cache clear still running, without starting new
   * work, so a route being dropped leaves no write behind.
   */
  async drain(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work])
  }

  /** The provider name warnings are prefixed with. */
  private label(): string {
    return this.options.label ?? 'provider'
  }
}

/** Whether discovery failed because the stored login is gone. */
export function isMissingOrInvalidCredential(error: unknown): boolean {
  return error instanceof LlmError
    && (error.code === 'MISSING_CREDENTIAL' || error.code === 'INVALID_CREDENTIAL')
}

/** Whether discovery stopped because the caller cancelled or the timeout fired. */
export function isDiscoveryAborted(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  // Only treat abort-shaped errors as cancellation when this call had a signal;
  // a refresh TimeoutError must not fail the whole picker union.
  return signal !== undefined
    && error instanceof Error
    && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/** Whether discovery failed because the access token was rejected. */
function isDiscoveryAuthFailure(error: unknown): boolean {
  return (error instanceof OAuthEndpointError && error.status === 401)
    || (error instanceof LlmError && error.code === 'AUTH')
}

/**
 * Run a catalog fetch, retrying once after a forced token refresh when the
 * first attempt is a 401/AUTH. The retry clears the failure cooldown the first
 * attempt armed — the credential it needed has just been renewed, so this one
 * retry is warranted — and only {@link ModelCatalogCache.invalidate}s when the
 * retry is also an auth failure, so a refresh race cannot erase last-known
 * capability metadata.
 */
export async function discoverOrRetryAuth<T>(
  session: (forceRefresh?: boolean) => Promise<unknown>,
  catalog: ModelCatalogCache,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (error: unknown) {
    if (isMissingOrInvalidCredential(error) || !isDiscoveryAuthFailure(error)) throw error
    try {
      await session(true)
      catalog.clearFailureCooldown()
      return await run()
    } catch (retryError: unknown) {
      if (!isMissingOrInvalidCredential(retryError) && isDiscoveryAuthFailure(retryError)) {
        catalog.invalidate()
      }
      throw retryError
    }
  }
}

/**
 * Keep Codex's session header stable for a supplied, non-empty session ID.
 * Existing UUIDs are preserved; other IDs use a SHA-256-derived UUIDv8 (a
 * custom deterministic layout). UUID formatting is a client convention,
 * not a claim about gateway validation or guaranteed prompt-cache hits.
 * Missing and empty IDs have no session identity and receive a fresh UUIDv4.
 */
export function deterministicSessionId(sessionId?: string): string {
  if (sessionId === undefined || sessionId.length === 0) return randomUUID()
  const str = String(sessionId)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str)) {
    return str
  }
  const bytes = createHash('sha256').update(str).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
