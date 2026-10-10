/**
 * ChatGPT/Codex subscription provider: OAuth against auth.openai.com with the
 * Codex CLI client id, and streaming against the ChatGPT backend Responses
 * endpoint.
 */

import { createHash, randomUUID } from 'node:crypto'
import { attributionHeaders, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { decodeJwtPayload } from '../auth/jwt.js'
import type { FlowSpec } from '../auth/oauth-flow.js'
import type { CodexSession } from '../auth/store.js'
import type { ProviderId } from '../auth/store.js'
import type { PoolAdapter } from './pool.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { resolveImages } from '../translate/resolved.js'
import { streamResponses, toResponsesInput, toResponsesTools } from '../translate/responses.js'
import type { ResponsesRequestInput } from '../translate/responses.js'
import { reconcileResponsesToolCalls } from '../translate/tool-pairing.js'
import { ReasoningCapture, ReasoningReplayStore, reasoningReplayScope } from './reasoning-replay.js'
import {
  deterministicSessionId,
  effortDisplayName,
  httpLlmError,
  idleWatchdog,
  isEnforcementRefusal,
  mapFetchFailure,
  mergeReasoning,
  discoverAcrossAccounts,
  oauthEndpointError,
  OAuthEndpointError,
} from './common.js'
import { AccountTokenManager } from './accounts.js'
import type {
  CatalogPersistence,
  DiscoveredModel,
  FetchFn,
  ModelEntry,
  ProviderUsage,
  ResetCredit,
  ResetCreditConsumeResult,
  ResetCreditList,
  UsageWindow,
} from './common.js'
import { ProviderCatalog, catalogRow, withPoolTiers } from './provider-catalog.js'
import { proxiedFetch } from '../http.js'
import {
  DEFAULT_RATE_LIMIT_WAIT,
  DEFAULT_RETRY,
  jsonBody,
  resetFromFields,
  retryAfterInstant,
  subscriptionRetryPolicy,
} from './rate-limit.js'
import type { RateLimitResetReader, RateLimitWait } from './rate-limit.js'

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses'
const CODEX_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'
const CODEX_CALLBACK_PATH = '/auth/callback'
const CODEX_CONTEXT_WINDOW = 400_000
const CODEX_DEFAULT_MAX_TOKENS = 128_000
/** Refresh when the access token has less than this much life left. */
export const CODEX_PREEMPT_MS = 5 * 60_000

/**
 * Body fields the backend uses to name a reset. A window-exhaustion rejection
 * carries `usage_limit_reached` with the seconds left on the window — the case
 * that used to classify as a terminal quota and never be retried at all.
 */
const CODEX_RESET_FIELDS = ['resets_in_seconds', 'reset_after_seconds', 'resets_at', 'reset_at'] as const

/**
 * Reads the reset instant of the Codex window that rejected a request.
 *
 * Body only. The `x-codex-{primary,secondary}-reset-after-seconds` headers are
 * rollover snapshots the backend attaches to every response, one per window,
 * so they say nothing about which window refused: a burst 429 that would clear
 * in seconds still carries a primary rollover hours out, and reading it would
 * park the turn for those hours. They reach the operator through
 * `rateLimitDiagnostics` instead.
 */
export const codexRateLimitReset: RateLimitResetReader = (_response, body, now) =>
  resetFromFields(jsonBody(body), CODEX_RESET_FIELDS, now)

/**
 * Whether a failed response states a refusal the provider will not accept a
 * retry for, read from the same signals {@link httpLlmError} classifies with.
 *
 * The body is read from a copy: the error built from this response reads the
 * response itself, and a body consumed here would leave that error without the
 * provider's own message.
 * @param response - the failed response.
 * @returns true when the response's own signals state a final refusal.
 */
async function statesFinalRefusal(response: Response): Promise<boolean> {
  const body = await response.clone().text().catch(() => '')
  const now = Date.now()
  const reset = codexRateLimitReset(response, body, now) ?? retryAfterInstant(response, now)
  return isEnforcementRefusal(response, body, reset, now)
}

/** Default instruction when the request carries no system prompt. */
const DEFAULT_CODEX_INSTRUCTIONS = 'You are Codex, a coding agent based on GPT-5. '
  + 'Help the user with their software engineering tasks.'

/** Refresh-grant rejections that mean the login is gone for good. */
const PERMANENT_REFRESH_CODES = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
  'invalid_grant',
])

const CODEX_EFFORTS = [
  { id: ReasoningEffortId('minimal'), name: 'Minimal' },
  { id: ReasoningEffortId('low'), name: 'Low' },
  { id: ReasoningEffortId('medium'), name: 'Medium' },
  { id: ReasoningEffortId('high'), name: 'High' },
  { id: ReasoningEffortId('xhigh'), name: 'Extra High' },
] as const
const CODEX_DEFAULT_EFFORT = ReasoningEffortId('high')
/** Every gpt-5.x codex model accepts image input. */
const CODEX_MODALITIES: readonly ('text' | 'image')[] = ['text', 'image']

/**
 * Fast tier (the codex CLI's "fast mode"): the Responses `service_tier` wire
 * value for priority processing, mirroring codex-rs
 * `ServiceTier::Fast.request_value()`. The legacy catalog spelling is the
 * `additional_speed_tiers` entry "fast".
 */
export const CODEX_FAST_SERVICE_TIER = 'priority'
const CODEX_FAST_SPEED_TIER = 'fast'

/** One session's speed choice: standard routing or the fast (priority) tier. */
export type CodexSpeedTier = 'standard' | 'fast'

/** Static codex flow facts for the OAuth flow engine. */
export const codexFlow: FlowSpec = {
  callbackPath: CODEX_CALLBACK_PATH,
  listen: { host: 'localhost', ports: [1455, 1457] },
  buildAuthorizeUrl({ redirectUri, state, pkce }) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CODEX_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: CODEX_SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    })
    return `${CODEX_AUTHORIZE_URL}?${params.toString()}`
  },
}

/** Token endpoint response shape (subset). */
interface CodexTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
}

/** Pull `chatgpt_account_id` out of an id token payload. */
function accountIdOf(idToken: string | undefined): string {
  const payload = idToken === undefined ? undefined : decodeJwtPayload(idToken)
  const auth = payload?.['https://api.openai.com/auth']
  const accountId = typeof auth === 'object' && auth !== null
    ? (auth as Record<string, unknown>).chatgpt_account_id
    : undefined
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new Error('codex login did not return a chatgpt account id; cannot use the subscription')
  }
  return accountId
}

/** User identity claims decoded from a codex id token. */
export interface CodexProfileClaims {
  emailAddress?: string
  planType?: string
}

/**
 * Decode the user-identity claims of a codex id token (pure, cheap — no
 * verification, same trust posture as {@link accountIdOf}). Claim paths
 * mirror codex-rs `login/src/token_data.rs`: the email is the top-level
 * `email` claim, falling back to `https://api.openai.com/profile`.email; the
 * plan is `https://api.openai.com/auth`.chatgpt_plan_type.
 * @param idToken - a stored or freshly issued id token, when present.
 * @returns whichever claims the token carried; empty when undecodable.
 */
export function codexProfileClaims(idToken: string | undefined): CodexProfileClaims {
  const payload = idToken === undefined ? undefined : decodeJwtPayload(idToken)
  if (payload === undefined) return {}
  const profile = payload['https://api.openai.com/profile']
  const profileEmail = typeof profile === 'object' && profile !== null
    ? (profile as Record<string, unknown>).email
    : undefined
  const email = payload.email ?? profileEmail
  const auth = payload['https://api.openai.com/auth']
  const plan = typeof auth === 'object' && auth !== null
    ? (auth as Record<string, unknown>).chatgpt_plan_type
    : undefined
  return {
    ...typeof email === 'string' && email.length > 0 ? { emailAddress: email } : {},
    ...typeof plan === 'string' && plan.length > 0 ? { planType: plan } : {},
  }
}

/** Build a session from a token response; expires_in wins, JWT exp is the fallback. */
function codexSession(tokens: CodexTokenResponse, fallback?: CodexSession): CodexSession {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new Error('codex token endpoint returned no access token')
  }
  const refreshToken = tokens.refresh_token ?? fallback?.refreshToken
  if (refreshToken === undefined) throw new Error('codex token endpoint returned no refresh token')
  let expiresAt: number | undefined
  if (typeof tokens.expires_in === 'number' && tokens.expires_in > 0) {
    expiresAt = Date.now() + tokens.expires_in * 1000
  } else {
    const exp = decodeJwtPayload(tokens.access_token)?.exp
    if (typeof exp === 'number' && exp > 0) expiresAt = exp * 1000
  }
  if (expiresAt === undefined) throw new Error('codex token endpoint returned no usable expiry')
  // Identity claims come from the freshest id token; a refresh that omits
  // one keeps the claims the stored session already had.
  const idToken = tokens.id_token ?? fallback?.idToken
  const claims = {
    ...fallback?.emailAddress === undefined ? {} : { emailAddress: fallback.emailAddress },
    ...fallback?.planType === undefined ? {} : { planType: fallback.planType },
    ...codexProfileClaims(tokens.id_token),
  }
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt,
    accountId: tokens.id_token === undefined && fallback !== undefined
      ? fallback.accountId
      : accountIdOf(tokens.id_token),
    ...idToken === undefined ? {} : { idToken },
    ...claims,
  }
}

/**
 * Exchange an authorization code for a codex session (form-encoded grant).
 * @param code - the authorization code from the callback.
 * @param verifier - the PKCE verifier minted for the attempt.
 * @param redirectUri - the attempt's redirect URI.
 * @returns the session to store.
 */
export async function exchangeCodexCode(code: string, verifier: string, redirectUri: string): Promise<CodexSession> {
  const response = await proxiedFetch(CODEX_TOKEN_URL, {
    // A redirect would replay the authorization code to another origin.
    redirect: 'error',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CODEX_CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'codex')
  return codexSession(await response.json() as CodexTokenResponse)
}

/**
 * Refresh a codex session (JSON grant — unlike the code exchange).
 * @param session - the stored session.
 * @returns the fresh session to store.
 */
export async function refreshCodex(session: CodexSession): Promise<CodexSession> {
  const response = await proxiedFetch(CODEX_TOKEN_URL, {
    // A redirect would replay the refresh token to another origin.
    redirect: 'error',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    }),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'codex')
  return codexSession(await response.json() as CodexTokenResponse, session)
}

/**
 * Whether a codex refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix.
 */
export function isCodexPermanentRefreshError(error: unknown): boolean {
  return error instanceof OAuthEndpointError
    && error.oauthCode !== undefined
    && PERMANENT_REFRESH_CODES.has(error.oauthCode)
}

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
export const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
export const CODEX_RESET_CREDITS_CONSUME_URL = `${CODEX_RESET_CREDITS_URL}/consume`

/** Auth headers shared by the ChatGPT backend JSON reads (usage and reset credits). */
function codexJsonHeaders(session: CodexSession): Record<string, string> {
  return {
    'authorization': `Bearer ${session.accessToken}`,
    'chatgpt-account-id': session.accountId,
    'originator': 'codex_cli_rs',
    'accept': 'application/json',
    ...attributionHeaders(),
  }
}

/**
 * Non-negative integer `available_count` on a usage or credits object.
 * @returns undefined when the field is absent or not a usable count, so callers
 *   can omit the row instead of showing a fabricated zero.
 */
export function codexResetCreditCount(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const count = (value as { available_count?: unknown }).available_count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return undefined
  return count
}

const RESET_CREDIT_STATUSES = new Set(['available', 'redeemed', 'expired'])

function resetCreditStatus(value: unknown): ResetCredit['status'] {
  return typeof value === 'string' && RESET_CREDIT_STATUSES.has(value)
    ? value as ResetCredit['status']
    : 'other'
}

function optionalCreditText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Map one credits-list payload. Rows without an id are dropped. */
export function mapCodexResetCreditList(payload: unknown): ResetCreditList {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('codex reset credits returned no object')
  }
  const body = payload as { credits?: unknown }
  const credits: ResetCredit[] = []
  if (Array.isArray(body.credits)) {
    for (const entry of body.credits) {
      if (typeof entry !== 'object' || entry === null) continue
      const row = entry as Record<string, unknown>
      const id = optionalCreditText(row.id)
      if (id === undefined) continue
      const title = optionalCreditText(row.title)
      const description = optionalCreditText(row.description)
      const grantedAt = optionalCreditText(row.granted_at)
      const expiresAt = optionalCreditText(row.expires_at)
      const resetType = optionalCreditText(row.reset_type)
      credits.push({
        id,
        status: resetCreditStatus(row.status),
        ...title === undefined ? {} : { title },
        ...description === undefined ? {} : { description },
        ...grantedAt === undefined ? {} : { grantedAt },
        ...expiresAt === undefined ? {} : { expiresAt },
        ...resetType === undefined ? {} : { resetType },
      })
    }
  }
  const availableCount = codexResetCreditCount(payload)
    ?? credits.filter(credit => credit.status === 'available').length
  return { supported: true, availableCount, credits }
}

/** Printable credit ids only. Rejecting here happens before any consume request. */
export function isCodexResetCreditId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[\x21-\x7E]+$/.test(value)
}

/** Caller-generated idempotency key. The consume call never mints a replacement. */
export function isCodexRedeemRequestId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/** One `rate_limit.*_window` object of the wham/usage payload (subset). */
interface CodexUsageWindow {
  used_percent?: number
  /** Window duration in seconds (18000 = 5 hours, 604800 = 7 days). */
  limit_window_seconds?: number
  /** Unix seconds at which the window resets. */
  reset_at?: number
  /** Seconds until the window resets (fallback when `reset_at` is absent). */
  reset_after_seconds?: number
}

/** Seconds of the canonical 5-hour session and 7-day weekly windows. */
const SESSION_WINDOW_SECONDS = 5 * 60 * 60
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60

/** Whether a reported duration approximately matches the expected window length. */
function matchesWindow(seconds: number, expected: number): boolean {
  return seconds >= expected * 0.95 && seconds <= expected * 1.05
}

/**
 * Classify a wham/usage window by its reported duration. The backend has been
 * observed to place the weekly lane in `primary_window` with no secondary
 * window, so slot position alone is unreliable; the caller's positional
 * fallback applies only when the duration is absent.
 */
function codexWindowKind(window: CodexUsageWindow, fallback: UsageWindow['kind']): UsageWindow['kind'] {
  const seconds = window.limit_window_seconds
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return fallback
  if (matchesWindow(seconds, SESSION_WINDOW_SECONDS)) return 'session'
  if (matchesWindow(seconds, WEEKLY_WINDOW_SECONDS)) return 'weekly'
  return 'other'
}

/** Map one wham/usage window into a {@link UsageWindow}; undefined when unusable. */
function codexUsageWindow(value: unknown, fallbackKind: UsageWindow['kind']): UsageWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const window = value as CodexUsageWindow
  if (typeof window.used_percent !== 'number' || !Number.isFinite(window.used_percent)) return undefined
  let resetsAt: number | undefined
  if (typeof window.reset_at === 'number' && window.reset_at > 0) {
    resetsAt = window.reset_at * 1000
  } else if (typeof window.reset_after_seconds === 'number' && window.reset_after_seconds > 0) {
    resetsAt = Date.now() + window.reset_after_seconds * 1000
  }
  return {
    kind: codexWindowKind(window, fallbackKind),
    usedPercent: window.used_percent,
    ...resetsAt === undefined ? {} : { resetsAt },
  }
}

/**
 * Fetch the codex subscription usage from the ChatGPT backend wham/usage
 * endpoint (the source of the codex CLI `/status` rate-limit lines). The
 * windows are classified by their reported duration (`limit_window_seconds`)
 * rather than by slot, since the backend has been observed to report the
 * weekly lane as `primary_window` without a secondary window; slot order is
 * kept only as a fallback when the duration is absent. The lookup itself
 * consumes no rate-limit budget and does not spend a reset credit. A disclosed
 * `rate_limit_reset_credits.available_count` is copied through; a missing or
 * unusable count is omitted rather than reported as zero.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @returns the mapped usage snapshot.
 */
export async function fetchCodexUsage(
  session: CodexSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const response = await fetchFn(CODEX_USAGE_URL, {
    headers: codexJsonHeaders(session),
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'codex usage')
  const payload = await response.json() as {
    plan_type?: string
    rate_limit?: { primary_window?: unknown; secondary_window?: unknown }
    rate_limit_reset_credits?: unknown
  }
  const windows: UsageWindow[] = []
  const primary = codexUsageWindow(payload.rate_limit?.primary_window, 'session')
  const secondary = codexUsageWindow(payload.rate_limit?.secondary_window, 'weekly')
  if (primary !== undefined) windows.push(primary)
  if (secondary !== undefined) windows.push(secondary)
  const availableCount = codexResetCreditCount(payload.rate_limit_reset_credits)
  return {
    supported: true,
    windows,
    ...typeof payload.plan_type === 'string' && payload.plan_type.length > 0
      ? { plan: payload.plan_type }
      : {},
    ...availableCount === undefined ? {} : { resetCredits: { availableCount } },
  }
}

/**
 * List banked rate-limit reset credits. This is a read. Tests must pass
 * `fetchFn`; the default transport is only for a real account lookup.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @returns the mapped credit list.
 */
export async function fetchCodexResetCredits(
  session: CodexSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<ResetCreditList> {
  const response = await fetchFn(CODEX_RESET_CREDITS_URL, {
    headers: codexJsonHeaders(session),
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'codex reset credits')
  return mapCodexResetCreditList(await response.json())
}

/**
 * Spend one banked reset credit. HTTP 200 spends it even when the body is
 * partial, so this function returns as soon as the response is OK and never
 * replaces the caller's idempotency key. A non-OK response throws before
 * returning. Tests must inject `fetchFn` and must not point it at a live account.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param creditId - the credit to spend.
 * @param redeemRequestId - caller-generated UUID, reused on retry of this spend.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @returns the provider's consume outcome.
 */
export async function consumeCodexResetCredit(
  session: CodexSession,
  creditId: string,
  redeemRequestId: string,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<ResetCreditConsumeResult> {
  if (!isCodexResetCreditId(creditId)) throw new Error('codex reset credit id is not usable')
  if (!isCodexRedeemRequestId(redeemRequestId)) throw new Error('codex redeem request id must be a UUID')
  const response = await fetchFn(CODEX_RESET_CREDITS_CONSUME_URL, {
    method: 'POST',
    headers: {
      ...codexJsonHeaders(session),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ credit_id: creditId, redeem_request_id: redeemRequestId }),
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'codex reset credit')
  let payload: unknown = {}
  try {
    payload = await response.json()
  } catch {
    payload = {}
  }
  if (typeof payload !== 'object' || payload === null) return {}
  const body = payload as { code?: unknown; windows_reset?: unknown }
  const code = typeof body.code === 'string' && body.code.length > 0 ? body.code : undefined
  const windowsReset = typeof body.windows_reset === 'number' && Number.isInteger(body.windows_reset)
    ? body.windows_reset
    : undefined
  return {
    ...code === undefined ? {} : { code },
    ...windowsReset === undefined ? {} : { windowsReset },
  }
}

/**
 * Usage snapshot for pool selection. When the usage payload reports at least
 * one reset credit, also read the credit list and keep the earliest available
 * expiry. A list failure leaves the usage snapshot unchanged. This does not
 * spend a credit.
 */
export async function fetchCodexPoolUsage(
  session: CodexSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const usage = await fetchCodexUsage(session, fetchFn, signal)
  const availableCount = usage.resetCredits?.availableCount
  if (availableCount === undefined || availableCount <= 0) return usage
  let list: ResetCreditList
  try {
    list = await fetchCodexResetCredits(session, fetchFn, signal)
  } catch {
    return usage
  }
  const soonestExpiresAt = soonestAvailableCreditExpiry(list)
  if (soonestExpiresAt === undefined) return usage
  return {
    ...usage,
    resetCredits: { availableCount, soonestExpiresAt },
  }
}

/** Earliest future expiry among available credits, epoch ms. */
function soonestAvailableCreditExpiry(list: ResetCreditList, now = Date.now()): number | undefined {
  let soonest: number | undefined
  for (const credit of list.credits ?? []) {
    if (credit.status !== 'available' || credit.expiresAt === undefined) continue
    const expiresAt = Date.parse(credit.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= now) continue
    if (soonest === undefined || expiresAt < soonest) soonest = expiresAt
  }
  return soonest
}

export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'

/**
 * Client version sent on the /models catalog request. The backend gates the
 * visible model list by client version. Verified 2026-09-05: the same account
 * omitted GPT-6 Astra at 0.147.0 and listed it at stable CLI 0.153.4. This is
 * not an entitlement guarantee; the server remains authoritative.
 */
export const CODEX_CLIENT_VERSION = '0.153.4'

/** Validate an explicit catalog compatibility version before using it on the wire. */
export function codexClientVersion(value = CODEX_CLIENT_VERSION): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value)) {
    throw new Error('codexClientVersion must be a version such as 0.153.4')
  }
  return value
}

/** The codex `/models` entry shape this plugin reads (subset of codex-rs `ModelInfo`). */
interface CodexWireModel {
  slug?: string
  display_name?: string
  description?: string | null
  context_window?: number | null
  max_context_window?: number | null
  supported_reasoning_levels?: { effort?: string; description?: string }[]
  default_reasoning_level?: string | null
  service_tiers?: { id?: string; name?: string; description?: string }[]
  additional_speed_tiers?: string[]
  visibility?: string
  priority?: number
}

/**
 * Whether a catalog entry advertises the fast tier. Mirrors codex-rs
 * `ModelPreset::supports_fast_mode`: a `service_tiers` id matching the fast
 * wire value, or the legacy `additional_speed_tiers` "fast" entry.
 */
function supportsFastTier(entry: CodexWireModel): boolean {
  return (entry.service_tiers ?? []).some(tier => tier.id === CODEX_FAST_SERVICE_TIER)
    || (entry.additional_speed_tiers ?? []).includes(CODEX_FAST_SPEED_TIER)
}

/**
 * Fetch the live codex model catalog with the session's auth headers.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation (pool-assembly timeout).
 * @param clientVersion - catalog compatibility version, not the plugin version.
 * @returns discovered models: hidden entries dropped, sorted by priority.
 */
export async function fetchCodexModels(
  session: CodexSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
  clientVersion = CODEX_CLIENT_VERSION,
): Promise<DiscoveredModel[]> {
  const version = codexClientVersion(clientVersion)
  const url = `${CODEX_MODELS_URL}?client_version=${encodeURIComponent(version)}`
  const response = await fetchFn(url, {
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      'chatgpt-account-id': session.accountId,
      'originator': 'codex_cli_rs',
      'accept': 'application/json',
      ...attributionHeaders(),
    },
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'codex models')
  const payload = await response.json() as { models?: CodexWireModel[] }
  if (!Array.isArray(payload.models)) throw new Error('codex models endpoint returned no models array')
  const discovered: DiscoveredModel[] = []
  for (const entry of payload.models) {
    if (typeof entry.slug !== 'string' || entry.slug.length === 0) continue
    // codex-rs ModelVisibility: only "list" is picker-visible; hide/none are
    // dropped, and an absent or unknown value is included (in doubt, include).
    if (entry.visibility === 'hide' || entry.visibility === 'none') continue
    const efforts = (entry.supported_reasoning_levels ?? [])
      .filter(level => typeof level.effort === 'string' && level.effort.length > 0)
      .map(level => ({
        id: ReasoningEffortId(level.effort as string),
        name: effortDisplayName(level.effort as string),
        ...level.description === undefined ? {} : { description: level.description },
      }))
    const defaultEffort = typeof entry.default_reasoning_level === 'string'
        && entry.default_reasoning_level.length > 0
        && efforts.some(effort => effort.id === ReasoningEffortId(entry.default_reasoning_level as string))
      ? ReasoningEffortId(entry.default_reasoning_level)
      : undefined
    const model: DiscoveredModel = {
      id: entry.slug,
      name: typeof entry.display_name === 'string' && entry.display_name.length > 0
        ? entry.display_name
        : entry.slug,
      ...typeof entry.description === 'string' && entry.description.length > 0
        ? { description: entry.description }
        : {},
      ...typeof entry.context_window === 'number' && entry.context_window > 0
        ? { contextWindow: entry.context_window }
        : {},
      ...Number.isSafeInteger(entry.max_context_window) && entry.max_context_window! > 0
        ? { maxContextWindow: entry.max_context_window! }
        : {},
      ...typeof entry.priority === 'number' ? { priority: entry.priority } : {},
      ...efforts.length > 0
        ? { reasoning: { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } } }
        : {},
      ...supportsFastTier(entry) ? { fastTier: true } : {},
    }
    discovered.push(model)
  }
  discovered.sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
  // An empty catalog from a 200 response means the backend gated us out (e.g.
  // client_version too old): surface it as a discovery failure so the adapter
  // falls back to the static catalog instead of vanishing from the picker.
  if (discovered.length === 0) {
    throw new Error(`codex models endpoint returned an empty catalog (client_version ${version})`)
  }
  return discovered
}

/** Constructor dependencies for {@link CodexAdapter}. */
export interface CodexAdapterOptions {
  /** Catalog compatibility version; defaults to the verified stable CLI version. */
  clientVersion?: string
  /** Automatic lookup used only when no explicit compatibility version is set. */
  resolveClientVersion?: () => Promise<string>
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<CodexSession>
  /** Optional, user-enabled recovery before output; returns whether to retry once. */
  recoverQuota?: (account: string, signal: AbortSignal) => Promise<boolean>
  /** Late-bound pool facade (wired after adapter construction); pools list under their first member's provider. */
  pool?: () => PoolAdapter | undefined
  /** Whether to fetch the live catalog when logged in (false when config `models` overrides). */
  discovery: boolean
  /** Warning sink for discovery failures that fall back to the static catalog. */
  onWarn?: (message: string) => void
  /** Fetch implementation for discovery and streaming requests; defaults to the configured proxy route. */
  fetchFn?: FetchFn
  /** Resolve the attachment service per request; absent means image requests fail loudly. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Durable catalog store seeding capability metadata across restarts. */
  catalogStore?: CatalogPersistence
  /** Per-account catalog bound for the picker union (defaults to the shared discovery timeout). */
  discoveryTimeoutMs?: number
  /** How long this route may hold a turn open waiting for a rate-limit window; defaults to waiting on, six-hour ceiling. */
  rateLimit?: RateLimitWait
  /**
   * Per-model default reasoning effort override (the Settings page's picker).
   * Returns the user-configured default for one model, or undefined to follow
   * the provider's own default.
   */
  defaultEffortOf?: (model: string) => string | undefined
  contextWindowOf?: (model: string) => number | undefined
  /**
   * Per-request speed lookup (the composer Speed toggle's host half). Returns
   * whether this session's current choice sends the model on the fast tier;
   * absent means every request stays on standard routing.
   */
  speedFor?: (sessionId: string | undefined, model: string) => Promise<boolean> | boolean
}

const CODEX_CALL_ID_MAX_LENGTH = 64
const CODEX_CALL_ID_PREFIX = 'call_'

/**
 * Bound tool-call ids at the Codex wire boundary without changing the shared
 * Responses translation used by Grok. Short ids stay verbatim. Oversized ids
 * become deterministic hashes, and every id already present in this request
 * is reserved first so a generated id cannot collide with a legitimate short
 * one (or another oversized id).
 */
function normalizeCodexCallIds(input: ResponsesRequestInput['input']): ResponsesRequestInput['input'] {
  const mapping = new Map<string, string>()
  const used = new Set<string>()
  const callId = (item: Record<string, unknown>): string | undefined =>
    (item.type === 'function_call' || item.type === 'function_call_output') && typeof item.call_id === 'string'
      ? item.call_id
      : undefined

  for (const item of input) {
    const id = callId(item)
    if (id !== undefined && id.length <= CODEX_CALL_ID_MAX_LENGTH) {
      mapping.set(id, id)
      used.add(id)
    }
  }

  for (const item of input) {
    const id = callId(item)
    if (id === undefined || mapping.has(id)) continue
    let attempt = 0
    let normalized: string
    do {
      const hash = createHash('sha256')
      if (attempt > 0) hash.update(String(attempt)).update('\0')
      const digest = hash.update(id).digest('hex')
      normalized = `${CODEX_CALL_ID_PREFIX}${digest.slice(0, CODEX_CALL_ID_MAX_LENGTH - CODEX_CALL_ID_PREFIX.length)}`
      attempt += 1
    } while (used.has(normalized))
    mapping.set(id, normalized)
    used.add(normalized)
  }

  return input.map((item) => {
    const id = callId(item)
    if (id === undefined) return item
    const normalized = mapping.get(id) ?? id
    return normalized === id ? item : { ...item, call_id: normalized }
  })
}

/**
 * The Responses request body for one generation. A fast-tier request (the
 * composer Speed toggle, the codex CLI's fast mode) carries
 * `service_tier: priority`; the tier field is omitted entirely otherwise,
 * matching the CLI (it never sends an explicit standard tier).
 */
export function codexRequestBody(
  options: GenerateOptions,
  resolved: ResponsesRequestInput,
  fast: boolean,
): Record<string, unknown> {
  return {
    model: options.model,
    instructions: resolved.instructions ?? DEFAULT_CODEX_INSTRUCTIONS,
    input: reconcileResponsesToolCalls(normalizeCodexCallIds(resolved.input)),
    // Omit tool controls for tool-less requests, matching the other adapters.
    // This is request-shape consistency, not a claim that Codex rejects the
    // controls when no tools are supplied.
    ...options.tools !== undefined && options.tools.length > 0
      ? { tools: toResponsesTools(options.tools, { strict: false }), tool_choice: 'auto', parallel_tool_calls: true }
      : {},
    ...options.reasoningEffort !== undefined
      ? { reasoning: { effort: String(options.reasoningEffort), summary: 'auto' } }
      : {},
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    ...options.sessionId !== undefined ? { prompt_cache_key: String(options.sessionId) } : {},
    ...fast ? { service_tier: CODEX_FAST_SERVICE_TIER } : {},
  }
}

/** Codex wire adapter: one instance serves the `codex` provider route. */
export class CodexAdapter extends LlmAdapter {
  private readonly catalogs: ProviderCatalog
  /**
   * Completed reasoning captured off the response stream, replayed on the next
   * request of the same conversation: the codex backend returns an encrypted
   * reasoning item only because the request asked for it, and a reasoning
   * model continuing a tool chain must get that item back or it restarts from
   * scratch every tool round trip. The store is namespaced per
   * ACCOUNT × CONVERSATION × MODEL, idles entries out via a sliding TTL, and
   * is dropped on auth transitions.
   */
  private readonly replay = new ReasoningReplayStore()

  constructor(private readonly options: CodexAdapterOptions) {
    super()
    codexClientVersion(options.clientVersion)
    this.catalogs = new ProviderCatalog(options, 'codex', {
      staticRows: provider => this.staticModels(provider),
      fetchCatalog: (account, signal) => this.fetchCatalog(account, signal),
      row: (provider, model) => this.listed(provider, model),
      ...options.discoveryTimeoutMs === undefined ? {} : { timeoutMs: options.discoveryTimeoutMs },
    })
  }

  /** Discovery fetcher: resolves the session through the refresh-aware path. */
  private async fetchCatalog(account?: string, signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const version = this.options.clientVersion ?? await this.options.resolveClientVersion?.()
    signal?.throwIfAborted()
    return fetchCodexModels(await this.options.tokens.session(account), this.options.fetchFn, signal, version)
  }

  /** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
  clearAccountCatalog(account?: string): void {
    this.catalogs.invalidate(account)
  }

  /**
   * Drop every captured replay entry. Lookup correctness never depends on the
   * call — the scope already carries the account identity — but the host
   * wiring invokes this on every codex auth transition (login, logout,
   * credential death) so a switched account's memory never holds the previous
   * account's encrypted reasoning at all; conversation teardown is bounded by
   * the TTL and the caps.
   */
  clearReplayState(): void {
    this.replay.clear()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'ChatGPT (Codex)' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(
      DEFAULT_RETRY,
      this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT,
      `codex: provider "${provider}" retryPolicy`,
    )
  }

  private staticModels(provider: string): LlmModelInfo[] {
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: model.inputModalities ?? CODEX_MODALITIES,
    }))
  }

  /** One discovered entry as a picker row, carrying its advertised priority and description. */
  private listed(provider: string, model: DiscoveredModel): LlmModelInfo {
    return catalogRow(provider, model, CODEX_MODALITIES, {
      ...model.description === undefined ? {} : { description: model.description },
      ...model.priority === undefined ? {} : { priority: model.priority },
    })
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return withPoolTiers(await this.listOwnModels(provider), this.options.pool?.(), provider)
  }

  /** The provider's own catalog: union of every account, or one account when named. */
  async listOwnModels(provider: string, account?: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    return this.catalogs.list(provider, account, signal)
  }

  /**
   * The discovered entry for one model. Resolved through the cache's
   * stale-while-revalidate path so capability metadata stays stable across a
   * long conversation: a discovered-only effort (one missing from the static
   * CODEX_EFFORTS list) selected by the user must not vanish — and fail the
   * call — just because the TTL lapsed mid-turn.
   */
  private async discovered(model: string, account?: string): Promise<DiscoveredModel | undefined> {
    if (!this.options.discovery) return undefined
    const accounts = account === undefined
      ? (await this.options.tokens.list()).map(entry => entry.key)
      : [account]
    return discoverAcrossAccounts(accounts, async account => {
      const catalog = await this.catalogs.cache(account)
      const models = await catalog.resolve(() => this.fetchCatalog(account))
      return models?.find(entry => entry.id === model)
    })
  }

  /** Whether the discovered catalog advertises a fast tier for this model. */
  async supportsFastTier(model: string, account?: string): Promise<boolean> {
    return (await this.discovered(model, account))?.fastTier === true
  }

  /** Ids of every discovered model with a fast tier (the Speed toggle's visibility list). */
  async fastCapableModels(): Promise<string[]> {
    if (!this.options.discovery) return []
    // Not logged in → no fast models, so the Speed toggle hides after logout
    // (mirrors the listModels guard above). Union every account: a fast-capable
    // model only the non-default lists (e.g. gpt-5.6-sol) must still show Speed.
    const accounts = (await this.options.tokens.list()).map(entry => entry.key)
    if (accounts.length === 0) return []
    const seen = new Set<string>()
    const ids: string[] = []
    for (const account of accounts) {
      try {
        const catalog = await this.catalogs.cache(account)
        const models = await catalog.resolve(() => this.fetchCatalog(account))
        for (const model of models ?? []) {
          if (model.fastTier !== true || seen.has(model.id)) continue
          seen.add(model.id)
          ids.push(model.id)
        }
      } catch {
        // sit out
      }
    }
    return ids
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const pool = this.options.pool?.()
    if (pool !== undefined && await pool.owns(provider as ProviderId, model)) {
      return pool.resolveModel(provider, model)
    }
    return this.resolveOwnModel(provider, model)
  }

  /** Capability resolution of the provider's own models (the pool resolves members here). */
  async resolveOwnModel(provider: string, model: string, account?: string): Promise<LlmResolvedModelInfo> {
    // Discovered metadata (when discovery is on) wins over the static entry;
    // the static entry wins over the built-in defaults. A configured default
    // effort merges over both.
    const discovered = await this.discovered(model, account)
    const configured = this.options.models.find(entry => entry.id === model)
    // `extendable` only while falling back to the built-in list: that one is
    // known to trail the backend, so a configured level it omits still has to
    // be selectable. A discovered catalog is the truth about what the model
    // accepts, and a stale override must not be forced onto every request.
    const reasoning = mergeReasoning(
      this.options.defaultEffortOf?.(model),
      discovered?.reasoning ?? { efforts: CODEX_EFFORTS, defaultEffort: CODEX_DEFAULT_EFFORT },
      { extendable: discovered?.reasoning === undefined },
    )
    return {
      provider,
      id: model,
      name: discovered?.name ?? configured?.name ?? model,
      ...discovered?.description === undefined ? {} : { description: discovered.description },
      inputModalities: configured?.inputModalities ?? CODEX_MODALITIES,
      context: { contextWindow: await this.contextWindowFor(model, account) },
      defaultMaxTokens: configured?.maxTokens ?? CODEX_DEFAULT_MAX_TOKENS,
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  }

  /** Account-specific bounds; absent maximum conservatively keeps the advertised default. */
  async contextLimits(model: string, account?: string): Promise<{ default: number; max: number }> {
    const discovered = await this.discovered(model, account)
    const configured = this.options.models.find(entry => entry.id === model)
    const fallback = discovered?.contextWindow ?? configured?.contextWindow ?? CODEX_CONTEXT_WINDOW
    return { default: fallback, max: discovered?.maxContextWindow ?? fallback }
  }

  private async contextWindowFor(model: string, account?: string): Promise<number> {
    const limits = await this.contextLimits(model, account)
    return Math.min(this.options.contextWindowOf?.(model) ?? limits.default, limits.max)
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const pool = this.options.pool?.()
    if (pool !== undefined && await pool.owns(options.provider as ProviderId, options.model)) {
      yield* pool.stream(options)
      return
    }
    yield* this.streamCore(options)
  }

  /** Pool seam: stream through one specific account instead of the default. */
  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    return this.streamCore(options, account)
  }

  private async *streamCore(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      const key = account ?? await this.options.tokens.defaultAccount()
      let session = await this.options.tokens.session(key)
      // Replay scope: account identity × conversation × model. The ChatGPT
      // account id is the session's long-lived identity, so an access-token
      // refresh (and the 401 retry below) reuses the same scope.
      const scope = reasoningReplayScope(session.accountId, options)
      let response = await this.request(options, session, watchdog.signal, scope)
      if (response.status === 401) {
        // One forced refresh + retry on an unexpired-but-rejected token.
        session = await this.options.tokens.session(key, true)
        response = await this.request(options, session, watchdog.signal, scope)
      }
      // Recovery spends a banked reset credit and resends the request, so it is
      // only for a window the provider says reopens. A 429 that states a refusal
      // the provider is final about has no window to reopen, and asking for one
      // spends a credit on an account the provider just declined to serve.
      if (response.status === 429
        && this.options.recoverQuota !== undefined
        && !await statesFinalRefusal(response)) {
        if (key !== undefined && await this.options.recoverQuota(key, watchdog.signal)) {
          await response.body?.cancel()
          session = await this.options.tokens.session(key)
          response = await this.request(options, session, watchdog.signal, scope)
        }
      }
      if (!response.ok) {
        throw await httpLlmError(response, 'codex API', {
          rateLimitReset: codexRateLimitReset,
          ...this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn },
        })
      }
      if (response.body === null) {
        throw new LlmError('codex API returned no response body', EMPTY_RESPONSE_CODE)
      }
      // The transform captures each completed reasoning item behind the call
      // ids of the response that produced it (see ReasoningCapture).
      const capture = new ReasoningCapture((callIds, items) => { this.replay.capture(scope, callIds, items) })
      yield* streamResponses(response.body, () => { watchdog.pulse() }, (event) => {
        capture.push(event)
        return event
      })
    } catch (error: unknown) {
      throw mapFetchFailure('codex API', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  private async request(
    options: GenerateOptions,
    session: CodexSession,
    signal: AbortSignal,
    replayScopeKey: string,
  ): Promise<Response> {
    const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal)
    const fast = this.options.speedFor !== undefined
      && await this.options.speedFor(options.sessionId, options.model)
    const body = codexRequestBody(options, toResponsesInput(
      messages,
      options.system,
      // Captured completed reasoning replays ahead of its tool call.
      callId => this.replay.replayFor(replayScopeKey, callId),
    ), fast)
    return (this.options.fetchFn ?? proxiedFetch)(CODEX_API_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${session.accessToken}`,
        'chatgpt-account-id': session.accountId,
        'originator': 'codex_cli_rs',
        'session-id': deterministicSessionId(options.sessionId),
        'accept': 'text/event-stream',
        'content-type': 'application/json',
        ...attributionHeaders(),
      },
      body: JSON.stringify(body),
      signal,
    })
  }
}
