/**
 * Claude Pro/Max subscription provider: OAuth against claude.ai /
 * platform.claude.com with the Claude Code client id, and streaming against
 * the Anthropic Messages API through the pinned Claude Code 2.1.280 wire
 * contract built by `@tormentalabs/claude-code-wire-compat`.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { EMPTY_RESPONSE_CODE, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { CLAUDE_CODE_2_1_288_PROFILE } from '@tormentalabs/claude-code-wire-compat'
import type { BuiltClaudeCodeRequest } from '@tormentalabs/claude-code-wire-compat'
import type { FlowSpec } from '../auth/oauth-flow.js'
import type { ClaudeSession } from '../auth/store.js'
import type { PoolAdapter } from './pool.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { resolveImages } from '../translate/resolved.js'
import { assertClaudeRequestBytes, claudeImagePolicy } from './claude-images.js'
import { desktopClientHeaders, desktopMachineProfile } from './claude-desktop.js'
import type { ResolvedImagePart, TranslatableBlock, TranslatableMessage } from '../translate/resolved.js'
import {
  streamAnthropic,
} from '../translate/anthropic.js'
import type { AnthropicRefusalProbe } from '../translate/anthropic.js'
import {
  CLAUDE_PLAIN_USER_AGENT,
  CLAUDE_USER_AGENT,
  boundedTwoLevelMap,
  buildClaudeWireRequest,
  claudeWireSessionId,
  mapClaudeWireError,
  rememberClaudeRequestId,
} from './claude-wire.js'
import { STALE_TOOL_RESULT_IDLE_MS, planContextManagement } from './context-management.js'
import type { ClaudeWireThinking } from './claude-wire.js'
import { claudeBuiltInCatalogue, mergeClaudeCatalogue } from './claude-catalogue.js'
import type { ClaudeCatalogueOption } from './claude-catalogue.js'
import { claudeModelLimits } from './claude-model-limits.js'
import {
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
import type { CatalogPersistence, DiscoveredModel, FetchFn, ModelEntry, ProviderUsage, UsageWindow } from './common.js'
import { ProviderCatalog, catalogRow } from './provider-catalog.js'
import { PoolBackedAdapter } from './pool-delegation.js'
import { proxiedFetch } from '../http.js'
import { claudeApiFetch } from '../transport/claude-fetch.js'
import {
  DEFAULT_RATE_LIMIT_WAIT,
  DEFAULT_RETRY,
  type RetryDefaults,
  earliestReset,
  jsonBody,
  resetFromFields,
  resetInstantFromHeader,
  subscriptionRetryPolicy,
} from './rate-limit.js'
import type { RateLimitResetReader, RateLimitWait } from './rate-limit.js'
import { parseUnifiedRateLimit, rememberUnifiedRateLimit } from './unified-rate-limit.js'

export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
/**
 * The OAuth endpoints CLAUDE_CODE_CUSTOM_OAUTH_URL may name, as the client pins them.
 *
 * The client strips one trailing slash from the value and accepts only these three
 * origins; any other value aborts startup with "is not an approved endpoint". The
 * token endpoint receives this account's tokens, so no arriving `.env` file may
 * choose it.
 */
const CLAUDE_APPROVED_OAUTH_ORIGINS: readonly string[] = [
  'https://beacon.claude-ai.staging.ant.dev',
  'https://claude.fedstart.com',
  'https://claude-staging.fedstart.com',
]
/**
 * OAuth hosts, as the client pins them.
 *
 * The authorize page for a claude.ai account lives on claude.com; the console variant
 * lives on platform.claude.com, which is also the token host; this plugin takes the
 * claude.ai path only. Setting CLAUDE_CODE_CUSTOM_OAUTH_URL moves both to that origin,
 * which must be one of {@link CLAUDE_APPROVED_OAUTH_ORIGINS}.
 */
const CLAUDE_OAUTH_ORIGIN = ((): string | undefined => {
  const raw = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  if (raw === undefined || raw.trim() === '') return undefined
  const trimmed = raw.trim().replace(/\/$/, '')
  if (!CLAUDE_APPROVED_OAUTH_ORIGINS.includes(trimmed)) {
    throw new Error(
      'CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint: set it to '
      + `${CLAUDE_APPROVED_OAUTH_ORIGINS.join(', ')}, because the token endpoint receives this account's tokens`,
    )
  }
  return trimmed
})()

export const CLAUDE_AUTHORIZE_URL = CLAUDE_OAUTH_ORIGIN === undefined
  ? 'https://claude.com/cai/oauth/authorize'
  : `${CLAUDE_OAUTH_ORIGIN}/oauth/authorize`
export const CLAUDE_TOKEN_URL = CLAUDE_OAUTH_ORIGIN === undefined
  ? 'https://platform.claude.com/v1/oauth/token'
  : `${CLAUDE_OAUTH_ORIGIN}/v1/oauth/token`
/**
 * Usage reads that are already in flight, keyed by the access token they carry.
 *
 * The genuine client answers a second caller from the request already running rather than
 * starting another, and its own request carries a five-second bound with its own abort
 * controller rather than the caller's. Sharing the read is what keeps several sessions
 * polling one account from multiplying the load on an endpoint that rate-limits
 * unrecognised clients aggressively.
 */
const usageInFlight = new Map<string, Promise<Record<string, unknown>>>()

/** The bound the client puts on one usage read. */
const USAGE_TIMEOUT_MS = 5_000

/**
 * Supplies a fresh access token after the service rejects the current one.
 *
 * The genuine client issues its usage request with refresh-and-replay enabled, so a
 * token that expired between the last refresh and the request costs one retry rather
 * than the whole poll.
 */
type ClaudeReauthorize = () => Promise<string>

const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
/**
 * The model-options endpoint the client uses on the first-party path.
 *
 * `/v1/models` is not part of that path at all — the client reaches it only under the
 * gateway's own discovery switch — so calling it here would be a request the genuine client
 * never sends. This one supplements a catalogue the client already carries, and a response
 * that fails its shape is discarded rather than treated as a failure.
 */
const CLAUDE_BOOTSTRAP_URL = 'https://api.anthropic.com/api/claude_cli/bootstrap'

/**
 * The ATIS token each account's bootstrap read carried, keyed by account.
 *
 * The client attaches it to the requests it sends through the first-party client, taking it
 * from the conversation's latch or, before one is set, from the bootstrapped client data.
 * A read that discloses none leaves the account without one, and no header is sent.
 */
const clientAtis = new Map<string, string>()

/**
 * The ATIS token recorded for an account.
 *
 * @param account - the account the request belongs to.
 * @returns the token, or undefined when no read has disclosed one.
 */
export function clientAtisFor(account: string): string | undefined {
  return clientAtis.get(account)
}

/** The entrypoint value the desktop's client reports on this endpoint. */
const CLAUDE_DESKTOP_ENTRYPOINT = 'claude-desktop'

/**
 * The model a listing stands in with.
 *
 * The client asks this endpoint while a session is running and always has a current model to
 * name. A listing has none, and the request must still carry the parameter, so the pinned
 * profile's own first catalogue entry is used.
 *
 * @returns a catalogue model id.
 */
function newestCatalogueModel(): string {
  // The release this profile pins adds exactly one model, and that is the one a desktop
  // running it is most likely to be asking about.
  const models = CLAUDE_CODE_2_1_288_PROFILE.supportedModels
  if (Object.hasOwn(models, 'claude-sonnet-5-5')) return 'claude-sonnet-5-5'
  const ids = Object.keys(models)
  return ids[ids.length - 1] ?? 'claude-opus-5'
}

/**
 * The scope string a refresh grant carries.
 *
 * @param scopes - the scopes the session was granted.
 * @returns the same set without the authorize-only scope.
 */
function refreshScopes(scopes: string): string {
  return scopes.split(/\s+/).filter(scope => scope.length > 0 && scope !== 'org:create_api_key').join(' ')
}

/**
 * The client's local retry shape.
 *
 * A base of 500 ms doubling to a 32 s ceiling, with proportional jitter, which is what the
 * carve's backoff helper carries. The ceiling the policy resolves also covers a disclosed
 * wait, which is why it is paired with the one below.
 */
const CLAUDE_RETRY: RetryDefaults = Object.freeze({
  ...DEFAULT_RETRY,
  initialDelayMs: 500,
  maxDelayMs: 32_000,
  jitterRatio: 0.25,
})

/** The bound the client puts on a profile read. */
const PROFILE_TIMEOUT_MS = 10_000

/** The bound the client puts on a bootstrap read. */
const BOOTSTRAP_TIMEOUT_MS = 5_000
export const CLAUDE_SCOPE = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins'
// `user:plugins` is appended last by the client's own scope assembly when the plugin
// scope is registered, which it is in production.
export const CLAUDE_CALLBACK_PATH = '/callback'
/** Refresh when the access token has less than this much life left. */
export const CLAUDE_PREEMPT_MS = 5 * 60_000

/**
 * Body fields Anthropic uses to name a reset instant, read when the unified
 * headers are absent.
 */
const CLAUDE_RESET_FIELDS = ['resets_at', 'resetsAt', 'reset_at', 'retry_after'] as const

/**
 * Reads the reset instant of the Anthropic window that rejected a request.
 *
 * `anthropic-ratelimit-unified-*` is the subscription-plan family — the one
 * Claude Code renders as "resets 3pm" — and is the only header that names the
 * window which actually rejected this request. The per-bucket
 * `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-reset`
 * headers are deliberately not read: they are rollover snapshots attached to
 * every response, so on a 429 they cannot say which bucket refused, and the
 * earliest of them is typically the bucket that still had room — a wait that
 * lands straight back in the closed window. They reach the operator through
 * `rateLimitDiagnostics` instead.
 */
export const claudeRateLimitReset: RateLimitResetReader = (response, body, now) => {
  // Only `-reset` exists on the wire: the client's own reader takes its reset from that header
  // and from the body's fields, and no `-fallback-reset` header is ever sent.
  const unified = earliestReset(
    resetInstantFromHeader(response, 'anthropic-ratelimit-unified-reset', now),
  )
  if (unified !== undefined) return unified
  return resetFromFields(jsonBody(body), CLAUDE_RESET_FIELDS, now)
}

/**
 * The subscription endpoint only serves requests presenting as Claude Code,
 * so the usage and models endpoints reuse the pinned wire profile's CLI
 * user-agent; the harness attribution user-agent cannot be sent here.
 */

/**
 * Models the prompt-caching guide allows to take a later `{"role":"system"}`
 * message: Fable 5, Fable 5.1, Mythos 5, Mythos 5.1, Opus 4.8, and Opus 5.
 * Sonnet 5 and Opus 5.5 are not in that list.
 */
export function supportsMidConversationSystem(model: string): boolean {
  if (model.startsWith('claude-fable-5') || model.startsWith('claude-mythos-5') || model.startsWith('claude-opus-4-8')) {
    return true
  }
  return model === 'claude-opus-5' || (model.startsWith('claude-opus-5-') && !model.startsWith('claude-opus-5-5'))
}

/** Files API upload. Official path from the Files HTTP reference. */
const CLAUDE_FILES_URL = 'https://api.anthropic.com/v1/files'
/**
 * Vision: images on the Claude API may be at most 10 MB once base64-encoded.
 * Larger images go through the Files API as `{ type: "file", file_id }`.
 */
export const CLAUDE_MAX_BASE64_IMAGE_CHARS = 10_000_000

/** Uploaded Files API entries kept before the oldest is evicted. */
export const CLAUDE_FILE_ID_LIMIT = 256

/** Canonical account key → image content hash → Files API file id. */
const uploadedFileIds = boundedTwoLevelMap<string>(CLAUDE_FILE_ID_LIMIT)

/**
 * The Files API id one account already uploaded for an image content hash.
 * @param account - the canonical account key that would own the upload.
 * @param contentHash - sha256 of the image's base64 payload.
 * @returns the uploaded id, or undefined when this account has not uploaded it.
 */
export function uploadedClaudeFileId(account: string, contentHash: string): string | undefined {
  return uploadedFileIds.get(account, contentHash)
}

/**
 * Remember one account's uploaded Files API id for an image content hash.
 *
 * A file id is served only under the token that uploaded it, and the Claude
 * routes are pooled, so the account key joins the content hash in the key: a
 * failover uploads its own copy instead of handing another account's request a
 * file id Anthropic would reject.
 * @param account - the canonical account key that uploaded the file.
 * @param contentHash - sha256 of the image's base64 payload.
 * @param fileId - the Files API id the upload returned.
 */
export function rememberClaudeFileId(account: string, contentHash: string, fileId: string): void {
  uploadedFileIds.set(account, contentHash, fileId)
}

/**
 * Drop the Files API ids uploaded under one account, or every account when none
 * is named. A login replaces the token those ids were minted with, so the
 * adapter drops them with the account's other cached state.
 * @param account - the canonical account key whose uploads are dropped.
 */
export function clearClaudeFileIds(account?: string): void {
  if (account === undefined) {
    uploadedFileIds.clear()
    return
  }
  uploadedFileIds.deleteOuter(account)
}

function imageFilename(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg': return 'image.jpg'
    case 'image/png': return 'image.png'
    case 'image/gif': return 'image.gif'
    case 'image/webp': return 'image.webp'
    default: return 'image.bin'
  }
}

/** Upload one image. The response `id` is the Messages `file_id`. */
async function uploadClaudeFile(
  accessToken: string,
  part: ResolvedImagePart,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([Buffer.from(part.dataBase64, 'base64')], { type: part.mediaType }), imageFilename(part.mediaType))
  const response = await fetchFn(CLAUDE_FILES_URL, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${accessToken}`,
      'anthropic-version': '2023-06-01',
      // The client composes this request's beta list from both registry entries.
      'anthropic-beta': 'files-api-2025-04-14,oauth-2025-04-20',
      'user-agent': CLAUDE_PLAIN_USER_AGENT,
    },
    body: form,
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await httpLlmError(response, 'claude files API')
  const payload = await response.json() as { id?: unknown; type?: unknown }
  if (typeof payload.id !== 'string' || payload.id.length === 0 || (payload.type !== undefined && payload.type !== 'file')) {
    throw new LlmError('claude files API returned no file id', 'SERVER')
  }
  return payload.id
}

async function fileIdForImage(
  part: ResolvedImagePart,
  account: string,
  accessToken: string,
  fetchFn: FetchFn,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (part.fileId !== undefined || part.dataBase64.length <= CLAUDE_MAX_BASE64_IMAGE_CHARS) return part.fileId
  const contentHash = createHash('sha256').update(part.dataBase64).digest('hex')
  const cached = uploadedClaudeFileId(account, contentHash)
  if (cached !== undefined) return cached
  const id = await uploadClaudeFile(accessToken, part, fetchFn, signal)
  rememberClaudeFileId(account, contentHash, id)
  return id
}

async function withFileIds(
  blocks: readonly TranslatableBlock[],
  account: string,
  accessToken: string,
  fetchFn: FetchFn,
  signal?: AbortSignal,
): Promise<readonly TranslatableBlock[]> {
  let changed = false
  const next: TranslatableBlock[] = []
  for (const block of blocks) {
    if (block.type === 'image' && 'dataBase64' in block) {
      const fileId = await fileIdForImage(block, account, accessToken, fetchFn, signal)
      if (fileId !== undefined && fileId !== block.fileId) {
        changed = true
        next.push({ ...block, fileId })
        continue
      }
    }
    if (block.type === 'tool-result') {
      const content = await withFileIds(block.content, account, accessToken, fetchFn, signal)
      if (content !== block.content) {
        changed = true
        next.push({ ...block, content })
        continue
      }
    }
    next.push(block)
  }
  return changed ? next : blocks
}

/**
 * Replace oversized inline images with a Files API `file_id`; smaller images
 * stay base64. The upload is made with the request's own account token, and the
 * resulting id is cached under that account.
 * @param messages - resolved request messages.
 * @param account - the canonical account key serving this request.
 * @param accessToken - that account's current access token.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation.
 * @returns the messages, with uploaded images bound to a file id.
 */
export async function bindClaudeFileIds(
  messages: readonly TranslatableMessage[],
  account: string,
  accessToken: string,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<readonly TranslatableMessage[]> {
  let changed = false
  const next: TranslatableMessage[] = []
  for (const message of messages) {
    const content = await withFileIds(message.content, account, accessToken, fetchFn, signal)
    if (content !== message.content) {
      changed = true
      next.push({ ...message, content })
    } else {
      next.push(message)
    }
  }
  return changed ? next : messages
}

/**
 * Where claude.com sends a browser that cannot reach this machine.
 *
 * The page displays the authorization code for the user to copy back, which is what makes a
 * login started on one device finish on another.
 */
export const CLAUDE_MANUAL_REDIRECT_URL = 'https://platform.claude.com/oauth/code/callback'

/** Static claude flow facts for the OAuth flow engine. */
export const claudeFlow: FlowSpec = {
  callbackPath: CLAUDE_CALLBACK_PATH,
  manualRedirectUri: CLAUDE_MANUAL_REDIRECT_URL,
  // The redirect URI embeds the port, so it must be an ephemeral one.
  listen: { host: 'localhost', ports: [0] },
  buildAuthorizeUrl({ redirectUri, state, pkce }) {
    const params = new URLSearchParams({
      code: 'true',
      client_id: CLAUDE_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: CLAUDE_SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
    })
    return `${CLAUDE_AUTHORIZE_URL}?${params.toString()}`
  },
}

/** Token endpoint response shape (subset). */
interface ClaudeTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

/**
 * Best-effort account profile; login must not fail when this does. The
 * account UUID is the one field the wire identity needs, so callers that
 * require it check the result instead of the failure.
 * @param accessToken - the session's current access token.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation.
 * @returns the fields the profile disclosed (possibly empty).
 */
async function fetchClaudeProfile(
  accessToken: string,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
  reauthorize?: ClaudeReauthorize,
): Promise<Pick<ClaudeSession, 'emailAddress' | 'subscriptionType' | 'accountUuid'>> {
  try {
    const request = (token: string): Promise<Response> =>
      fetchFn(CLAUDE_PROFILE_URL, {
        headers: {
          authorization: `Bearer ${token}`,
          // Matches the client's own profile request: a bodyless JSON GET carrying the
          // plain user agent, under the ten-second bound the client gives it.
          'user-agent': CLAUDE_PLAIN_USER_AGENT,
          'content-type': 'application/json',
          'cache-control': 'no-cache',
        },
        signal: signal === undefined
          ? AbortSignal.timeout(PROFILE_TIMEOUT_MS)
          : AbortSignal.any([signal, AbortSignal.timeout(PROFILE_TIMEOUT_MS)]),
      })
    // Replayed once after a rejection, then reported as it stands: the client retries
    // this request after refreshing rather than giving up on the first 401.
    let response = await request(accessToken)
    if (response.status === 401 && reauthorize !== undefined) {
      response = await request(await reauthorize())
    }
    if (!response.ok) return {}
    const profile = await response.json() as Record<string, unknown>
    const account = typeof profile.account === 'object' && profile.account !== null
      ? profile.account as Record<string, unknown>
      : {}
    const email = profile.emailAddress ?? profile.email ?? account.email_address ?? account.email
    const subscription = profile.subscriptionType ?? profile.subscription_type ?? account.subscription_type
    const accountUuid = account.uuid ?? profile.accountUuid
    return {
      ...typeof email === 'string' && email.length > 0 ? { emailAddress: email } : {},
      ...typeof subscription === 'string' && subscription.length > 0 ? { subscriptionType: subscription } : {},
      ...typeof accountUuid === 'string' && accountUuid.length > 0 ? { accountUuid } : {},
    }
  } catch {
    // Profile lookup is decorative for login; only the token exchange owns
    // login success. Wire-identity backfill checks the returned fields.
    return {}
  }
}

/** Build a session from a token response. */
async function claudeSession(
  tokens: ClaudeTokenResponse,
  fallbackRefreshToken: string | undefined,
  withProfile: boolean,
): Promise<ClaudeSession> {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new Error('claude token endpoint returned no access token')
  }
  const refreshToken = tokens.refresh_token ?? fallbackRefreshToken
  if (refreshToken === undefined) throw new Error('claude token endpoint returned no refresh token')
  if (typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0) {
    throw new Error('claude token endpoint returned no usable expiry')
  }
  const profile = withProfile ? await fetchClaudeProfile(tokens.access_token) : {}
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scopes: tokens.scope ?? CLAUDE_SCOPE,
    // The wire correlation triple's device id, in the client's 64-hex format. Derived
    // from the account rather than minted per credential, so signing out and in again
    // presents the same device.
    deviceId: claudeDeviceIdFor({
      ...profile.emailAddress === undefined ? {} : { emailAddress: profile.emailAddress },
      ...profile.accountUuid === undefined ? {} : { accountUuid: profile.accountUuid },
    }),
    ...profile,
  }
}

/**
 * Exchange an authorization code for a claude session (JSON grant).
 * @param code - the authorization code from the callback.
 * @param verifier - the PKCE verifier minted for the attempt.
 * @param redirectUri - the attempt's redirect URI.
 * @param state - the attempt's state (echoed to the token endpoint).
 * @returns the session to store.
 */
/**
 * Settle with `pending`, or reject as soon as the caller stops waiting.
 *
 * The shared read is deliberately not cancelled: another caller may be waiting on it, and
 * the client's own request carries its own abort controller for the same reason.
 *
 * @param pending - the shared request.
 * @param signal - the caller's own cancellation.
 * @returns the shared request's outcome, once it arrives.
 */
function raceWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => { reject(abortError(signal)) }
    signal.addEventListener('abort', stop, { once: true })
    pending.then(
      (value) => { signal.removeEventListener('abort', stop); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', stop); reject(error) },
    )
  })
}

/**
 * The reason a caller's cancellation carries.
 *
 * @param signal - the aborted signal.
 * @returns the abort reason, or a fresh abort error.
 */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  return new Error('claude usage request aborted')
}

/**
 * The device id one account presents.
 *
 * Derived from the account's own key instead of being minted at random, so it survives
 * every path that recreates the stored session: signing out and in again, a re-import from
 * Claude Code's own credential store, or a fresh authorization. The genuine client keeps
 * its id outside its credentials and therefore survives all of these; an id that died with
 * the credential would silently present a different device to the service.
 *
 * @param accountKey - The account's key, which is the address it signed in with.
 * @returns A 64-character lowercase hex id, the format the client uses.
 */
export function deriveClaudeDeviceId(accountKey: string): string {
  return createHash('sha256').update(`claude-device-id:${accountKey}`).digest('hex')
}

/**
 * The device id for a session, from whichever account field the profile disclosed.
 *
 * @param session - The session or profile that carries the account's identity.
 * @returns The derived id, or a random one when no account field is known yet.
 */
function claudeDeviceIdFor(session: {
  emailAddress?: string
  accountUuid?: string
}): string {
  const key = session.emailAddress ?? session.accountUuid
  return key === undefined ? randomBytes(32).toString('hex') : deriveClaudeDeviceId(key)
}

/**
 * Carry an account's frozen device identity onto a freshly authorized session.
 *
 * The device id is minted once per account and must survive re-authorization: every
 * machine value a request declares is derived from it, so a new id would silently change
 * the device the service sees. The genuine client behaves the same way, keeping one id for
 * the life of its installation rather than issuing one per sign-in.
 *
 * @param next - The session the authorization just produced.
 * @param previous - The stored session for the same account, when there is one.
 * @returns The session to store, with the earlier identity preserved.
 */
export function carryClaudeIdentity(
  next: ClaudeSession,
  previous: ClaudeSession | undefined,
): ClaudeSession {
  if (previous?.deviceId === undefined) return next
  return {
    ...next,
    deviceId: previous.deviceId,
    // The profile lookup is best-effort, so a re-authorization that could not read it
    // keeps the value the account already had rather than dropping the correlation.
    ...next.accountUuid === undefined && previous.accountUuid !== undefined
      ? { accountUuid: previous.accountUuid }
      : {},
  }
}

export async function exchangeClaudeCode(
  code: string,
  verifier: string,
  redirectUri: string,
  state: string,
): Promise<ClaudeSession> {
  const response = await proxiedFetch(CLAUDE_TOKEN_URL, {
      // A redirect would replay the code or refresh token to another host.
      redirect: 'error',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLAUDE_CLIENT_ID,
      code_verifier: verifier,
      state,
    }),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'claude')
  return claudeSession(await response.json() as ClaudeTokenResponse, undefined, true)
}

/**
 * Refresh a claude session (JSON grant echoing the issued scope).
 * @param session - the stored session.
 * @returns the fresh session to store.
 */
export async function refreshClaude(session: ClaudeSession): Promise<ClaudeSession> {
  const response = await proxiedFetch(CLAUDE_TOKEN_URL, {
      // A redirect would replay the code or refresh token to another host.
      redirect: 'error',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
      // The client never asks for `org:create_api_key` when refreshing; that scope belongs to
      // the authorize request. Everything else the account was granted is echoed back, so a
      // project scope stays intact.
      scope: refreshScopes(session.scopes),
    }),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'claude')
  const next = await claudeSession(await response.json() as ClaudeTokenResponse, session.refreshToken, false)
  return {
    ...next,
    ...session.emailAddress === undefined ? {} : { emailAddress: session.emailAddress },
    ...session.subscriptionType === undefined ? {} : { subscriptionType: session.subscriptionType },
    // Wire identity survives refreshes; it is minted once per account.
    ...session.accountUuid === undefined ? {} : { accountUuid: session.accountUuid },
    ...session.deviceId === undefined ? {} : { deviceId: session.deviceId },
  }
}

/**
 * Whether a claude refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix.
 */
export function isClaudePermanentRefreshError(error: unknown): boolean {
  return error instanceof OAuthEndpointError
    && (error.oauthCode === 'invalid_grant' || error.oauthCode === 'invalid_token')
}

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** RFC3339 `resets_at` value → epoch ms, or undefined when absent/unparsable. */
function claudeResetsAt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Map one legacy `{utilization, resets_at}` bucket; undefined when null or unusable. */
function claudeLegacyWindow(value: unknown, kind: UsageWindow['kind'], scope?: string): UsageWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const bucket = value as { utilization?: number; resets_at?: string }
  if (typeof bucket.utilization !== 'number' || !Number.isFinite(bucket.utilization)) return undefined
  const resetsAt = claudeResetsAt(bucket.resets_at)
  return {
    kind,
    ...scope === undefined ? {} : { scope },
    usedPercent: bucket.utilization,
    ...resetsAt === undefined ? {} : { resetsAt },
  }
}

/** One entry of the modern `limits` array (subset). */
interface ClaudeLimitEntry {
  kind?: string
  percent?: number
  resets_at?: string
  scope?: { model?: { display_name?: string } }
}

/** Map the modern `limits` array; empty when absent or carrying nothing usable. */
function claudeLimitsWindows(value: unknown): UsageWindow[] {
  if (!Array.isArray(value)) return []
  const windows: UsageWindow[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as ClaudeLimitEntry
    if (typeof entry.percent !== 'number' || !Number.isFinite(entry.percent)) continue
    const kind: UsageWindow['kind'] = entry.kind === 'session'
      ? 'session'
      : entry.kind === 'weekly_all' || entry.kind === 'weekly_scoped' ? 'weekly' : 'other'
    const scope = entry.scope?.model?.display_name
    const resetsAt = claudeResetsAt(entry.resets_at)
    windows.push({
      kind,
      ...typeof scope === 'string' && scope.length > 0 ? { scope } : {},
      usedPercent: entry.percent,
      ...resetsAt === undefined ? {} : { resetsAt },
    })
  }
  return windows
}

/**
 * Fetch the claude subscription usage from the OAuth usage endpoint (the
 * source of Claude Code's `/usage` screen). Newer responses carry a
 * structured `limits` array; older ones the flat `five_hour`/`seven_day*`
 * buckets — both shapes are read, the array winning when it has entries.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @returns the mapped usage snapshot.
 */
export async function fetchClaudeUsage(
  session: ClaudeSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
  reauthorize?: ClaudeReauthorize,
  timeoutMs: number = USAGE_TIMEOUT_MS,
): Promise<ProviderUsage> {
  const request = (accessToken: string, requestSignal: AbortSignal): Promise<Response> =>
    fetchFn(CLAUDE_USAGE_URL, {
      headers: {
        'authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        // Unrecognized clients are aggressively rate-limited on this endpoint,
        // so it presents as the CLI like every other subscription request.
        'user-agent': CLAUDE_USER_AGENT,
        'accept': 'application/json',
        // The client sends a JSON content type on this request even though it has no body.
        'content-type': 'application/json',
      },
      signal: requestSignal,
    })

  // The client issues this request with refresh-and-replay enabled, so an access token
  // that expired since the last refresh costs one retry instead of the poll. The whole
  // read is shared: a second caller waits on the request already running.
  const read = (accessToken: string): Promise<Record<string, unknown>> => {
    const existing = usageInFlight.get(accessToken)
    if (existing !== undefined) return existing
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)
    timer.unref?.()
    const pending = (async (): Promise<Record<string, unknown>> => {
      try {
        const first = await request(accessToken, controller.signal)
        const response = first.status === 401 && reauthorize !== undefined
          ? await request(await reauthorize(), controller.signal)
          : first
        if (!response.ok) throw await oauthEndpointError(response, 'claude usage')
        // The parsed body is what is shared: two callers awaiting one Response would each
        // read the same body, and the second read fails.
        return await response.json() as Record<string, unknown>
      } finally {
        clearTimeout(timer)
        usageInFlight.delete(accessToken)
      }
    })()
    usageInFlight.set(accessToken, pending)
    return pending
  }

  let payload: Record<string, unknown>
  try {
    payload = await (signal === undefined
      ? read(session.accessToken)
      : raceWithSignal(read(session.accessToken), signal))
  } catch (error) {
    if (signal !== undefined && signal.aborted) throw abortError(signal)
    throw error
  }
  const modern = claudeLimitsWindows(payload.limits)
  if (modern.length > 0) return { supported: true, windows: modern }
  const windows: UsageWindow[] = []
  const legacy = [
    claudeLegacyWindow(payload.five_hour, 'session'),
    claudeLegacyWindow(payload.seven_day, 'weekly'),
    claudeLegacyWindow(payload.seven_day_opus, 'weekly', 'Opus'),
    claudeLegacyWindow(payload.seven_day_sonnet, 'weekly', 'Sonnet'),
  ]
  for (const window of legacy) {
    if (window !== undefined) windows.push(window)
  }
  return { supported: true, windows }
}

interface ClaudeModelCapabilities {
  thinking?: {
    types?: {
      enabled?: { supported?: boolean }
      adaptive?: { supported?: boolean }
    }
  }
  effort?: {
    supported?: boolean
    low?: { supported?: boolean }
    medium?: { supported?: boolean }
    high?: { supported?: boolean }
    xhigh?: { supported?: boolean }
    max?: { supported?: boolean }
  }
}

function claudeThinkingType(capabilities: ClaudeModelCapabilities | undefined): 'enabled' | 'adaptive' | undefined {
  const types = capabilities?.thinking?.types
  // Adaptive wins when a model advertises both. Opus 5.5 rejects
  // `thinking.type: enabled` and `budget_tokens` with HTTP 400.
  if (types?.adaptive?.supported === true) return 'adaptive'
  if (types?.enabled?.supported === true) return 'enabled'
  return undefined
}

/**
 * Opus 5.5 accepts only omitted thinking or `type: adaptive`. A manual budget
 * is a 400 even when an older catalog snapshot still marks `enabled`.
 */
function rejectsBudgetThinking(model: string): boolean {
  return model === 'claude-opus-5-5' || model.startsWith('claude-opus-5-5-')
}

/**
 * The `thinking` object for one request.
 *
 * `display: 'summarized'` is fixed by the wire module on both shapes: adaptive
 * models default to `display: 'omitted'`, which returns thinking blocks with
 * an empty `thinking` field. Without this override the Think panel stays empty.
 * @param model - the requested model id.
 * @param thinkingType - the type discovery advertised, when it advertised one.
 * @param maxTokens - the resolved output cap; the manual budget is derived from it.
 * @returns the wire `thinking` request, or undefined when the model takes none.
 */
export function claudeThinkingBody(
  model: string,
  thinkingType: 'enabled' | 'adaptive' | undefined,
  maxTokens: number,
): ClaudeWireThinking | undefined {
  const mode = thinkingType === 'adaptive' || rejectsBudgetThinking(model) ? 'adaptive' : thinkingType
  if (mode === 'adaptive') return { type: 'adaptive' }
  if (mode === 'enabled') {
    const budget = Math.min(Math.max(1_024, Math.floor(maxTokens * 0.5)), maxTokens - 100)
    if (budget < 1_024) return undefined
    return { type: 'enabled', budgetTokens: budget }
  }
  return undefined
}

/** Effort levels in display order; a model exposes only the ones it advertises as supported. */
const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function claudeReasoning(capabilities: ClaudeModelCapabilities | undefined): DiscoveredModel['reasoning'] {
  const effort = capabilities?.effort
  if (effort?.supported !== true) return undefined
  const efforts = CLAUDE_EFFORT_LEVELS
    .filter(level => effort[level]?.supported === true)
    .map(level => ({ id: ReasoningEffortId(level), name: level[0].toUpperCase() + level.slice(1) }))
  return efforts.length > 0 ? { efforts } : undefined
}

/**
 * The bootstrap document's shape; anything else is discarded.
 */
interface ClaudeBootstrapDocument {
  client_data?: unknown
  additional_model_options?: ClaudeCatalogueOption[]
}

/**
 * Read the account's Claude catalogue: the client's own built-in table with the model
 * options this account adds to it.
 *
 * The endpoint carries additions, not a catalogue — its own field is named
 * `additional_model_options` beside `additional_model_costs` — so the built-in table is
 * what the rows are built from and the response is merged onto it. A response that does
 * not match the document's shape, or one the endpoint refuses, leaves the built-in table
 * standing, which is what the client does with one: the catalogue it already carries
 * stays authoritative, and this call only adds to it. An option the service marks
 * disabled is listed as a disabled row rather than dropped, so the account sees that the
 * model exists and cannot use it.
 *
 * @param session - the account whose token authenticates the read.
 * @param extraHeaders - the desktop client headers, which this request carries like every
 *   other subscription request.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation.
 * @param model - the model the client would be asking about. The genuine caller always has
 *   one, because it asks while a session is running; a listing has none, so the profile's own
 *   first catalogue entry stands in for it rather than sending a request the client's shape
 *   has no counterpart for.
 * @returns the catalogue rows for this account.
 */
export async function fetchClaudeCatalogue(
  session: ClaudeSession,
  extraHeaders: readonly (readonly [string, string])[] = [],
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
  account?: string,
  model?: string,
): Promise<DiscoveredModel[]> {
  const timeout = AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS)
  // The client always names the entrypoint and the model on this endpoint, so a request
  // without them is a shape it never produces.
  const url = new URL(CLAUDE_BOOTSTRAP_URL)
  url.searchParams.set('entrypoint', CLAUDE_DESKTOP_ENTRYPOINT)
  url.searchParams.set('model', model ?? newestCatalogueModel())
  const response = await fetchFn(url.toString(), {
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'content-type': 'application/json',
      // The client uses its plain `claude-code/<version>` agent on this endpoint, not the
      // transport one.
      'user-agent': CLAUDE_PLAIN_USER_AGENT,
      'accept': 'application/json',
      ...Object.fromEntries(extraHeaders),
    },
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  })
  // An endpoint that refuses the read is not an error: the built-in catalogue stands on its own.
  if (!response.ok) return claudeBuiltInCatalogue()
  const payload = await response.json() as ClaudeBootstrapDocument
  // The same document that supplements the catalogue carries the client data the request
  // header is drawn from, so one read serves both.
  if (account !== undefined) {
    const atis = (payload.client_data as { atis?: unknown } | null | undefined)?.atis
    if (typeof atis === 'string' && atis.length > 0) clientAtis.set(account, atis)
  }
  const options = payload.additional_model_options
  if (!Array.isArray(options)) return claudeBuiltInCatalogue()
  return mergeClaudeCatalogue(claudeBuiltInCatalogue(), options)
}

/**
 * The output cap for one model: configuration may lower the default, but never
 * exceeds a server-advertised ceiling; without one the model's documented, then
 * catalogued, capacity answers.
 */
function claudeMaxTokens(
  configured: ModelEntry | undefined,
  disc: DiscoveredModel | undefined,
  model: string,
): number {
  const outputLimit = disc?.maxOutputTokens
  const preferred = configured?.maxTokens ?? outputLimit ?? claudeModelLimits(model).maxOutputTokens
  return outputLimit === undefined ? preferred : Math.min(preferred, outputLimit)
}

/** Constructor dependencies for {@link ClaudeAdapter}. */
interface ClaudeAdapterOptions {
  /** Identity line a Claude request carries in place of the harness identity section. */
  identityLine?: string
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<ClaudeSession>
  /** Late-bound pool facade (wired after adapter construction); pools list under their first member's provider. */
  pool?: () => PoolAdapter | undefined
  /** Whether to fetch the live catalog when logged in (false when config `models` overrides). */
  discovery: boolean
  fetchFn?: FetchFn
  onWarn?: (message: string) => void
  /** How long this route may hold a turn open waiting for a rate-limit window; defaults to waiting on, six-hour ceiling. */
  rateLimit?: RateLimitWait
  /** Resolve the attachment service per request; absent means image requests fail loudly. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Durable catalog store seeding capability metadata across restarts. */
  catalogStore?: CatalogPersistence
  /**
   * Per-model default reasoning effort override (the Settings page's picker).
   * Returns the user-configured default for one model, or undefined to follow
   * the provider's own default.
   */
  defaultEffortOf?: (model: string) => string | undefined
}

/** The Claude 4.5 family accepts image input. */
const CLAUDE_MODALITIES: readonly ('text' | 'image')[] = ['text', 'image']

/**
 * Classify an in-band `error` event against the response it arrived on.
 *
 * A terminal refusal reaches the harness two ways: as a failed status, which
 * {@link httpLlmError} already classifies, and inside a 200 as an `error` event.
 * The second form carries no status or headers of its own, so the response's own
 * signals are applied here and the event's structured fields stand in for the
 * body the classifier reads — a refusal that names a billing or credit reason in
 * its message is one either way.
 * @param response - the response whose body carried the event.
 * @returns the probe the stream translator classifies each event with.
 */
function claudeStreamRefusalProbe(response: Response): AnthropicRefusalProbe {
  return (error) => {
    const body = error === undefined ? '' : JSON.stringify(error)
    return isEnforcementRefusal(response, body, undefined, Date.now())
  }
}

/** Claude wire adapter: one instance serves the `claude` provider route. */
/** Sessions whose request clock is kept; the client bounds its own table the same way. */
const REQUEST_CLOCK_LIMIT = 64

export class ClaudeAdapter extends PoolBackedAdapter {
  protected readonly catalogs: ProviderCatalog

  constructor(private readonly options: ClaudeAdapterOptions) {
    super(options)
    this.catalogs = new ProviderCatalog(options, 'claude', {
      staticRows: provider => this.staticModels(provider),
      fetchCatalog: (account, signal) => this.fetchCatalog(account, signal),
      row: (provider, model) => this.listed(provider, model),
    })
  }

  private async fetchCatalog(account?: string, signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const session = await this.options.tokens.session(account)
    // The machine values come from the account, not this host, exactly as they do on every
    // other request this adapter sends. A session reaching the wire always carries a device
    // id; the account fields are the fallback for a listing taken before it is backfilled.
    const seed = session.deviceId ?? account ?? session.accountUuid ?? 'claude'
    return fetchClaudeCatalogue(
      session,
      Object.entries(desktopClientHeaders()),
      this.options.fetchFn,
      signal,
      account,
    )
  }

  /**
   * Drop cached catalogs after login/logout so the next list does not reuse a stale plan,
   * and the account's uploaded Files API ids with them: those ids belong to the token that
   * uploaded them, which a login change replaces.
   * @param account - the account whose cached state is dropped, or every account when omitted.
   */
  clearAccountCatalog(account?: string): void {
    this.catalogs.invalidate(account)
    clearClaudeFileIds(account)
  }

  private async discovered(model: string): Promise<DiscoveredModel | undefined> {
    if (!this.options.discovery) return undefined
    const accounts = (await this.options.tokens.list()).map(entry => entry.key)
    return discoverAcrossAccounts(accounts, async account => {
      const catalog = await this.catalogs.cache(account)
      const models = await catalog.resolve(() => this.fetchCatalog(account))
      return models?.find(entry => entry.id === model)
    })
  }

  private staticModels(provider: string): LlmModelInfo[] {
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: model.inputModalities ?? CLAUDE_MODALITIES,
    }))
  }

  /** One discovered entry as a picker row, keeping the display text the account's options added. */
  private listed(provider: string, model: DiscoveredModel): LlmModelInfo {
    return catalogRow(provider, model, CLAUDE_MODALITIES, {
      ...model.description === undefined ? {} : { description: model.description },
      ...model.disabledReason === undefined ? {} : { disabledReason: model.disabledReason },
    })
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Claude (Subscription)' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(
      // The client's own retry shape: a 500 ms base, a 32 s ceiling and proportional jitter.
      CLAUDE_RETRY,
      // The route's own backoff keeps the client's 32 s ceiling, and the configured wait bounds
      // only a provider-disclosed reset: the client sits out a rate-limit window for hours,
      // backs off seconds apart, and its own delay never reaches the abandon branch.
      this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT,
      `claude: provider "${provider}" retryPolicy`,
    )
  }

  /** Capability resolution of the provider's own models (the pool resolves members here). */
  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const disc = await this.discovered(model)
    const configured = this.options.models.find(entry => entry.id === model)
    const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), disc?.reasoning)
    return {
      provider,
      id: model,
      name: disc?.name ?? configured?.name ?? model,
      inputModalities: configured?.inputModalities ?? CLAUDE_MODALITIES,
      context: {
        contextWindow: disc?.contextWindow ?? configured?.contextWindow ?? claudeModelLimits(model).contextWindow,
      },
      defaultMaxTokens: claudeMaxTokens(configured, disc, model),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(supportsMidConversationSystem(model) ? { systemPromptUpdate: 'in-history' as const } : {}),
    }
  }

  /** The canonical account key that owns this session's conversation chain. */
  private async chainAccount(account: string | undefined): Promise<string> {
    const requested = account ?? await this.options.tokens.defaultAccount()
    if (requested === undefined) return ''
    return this.options.tokens.resolveAccount(requested)
  }

  protected async *streamOwn(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    // The billing block chains responses through the request-id header, so the
    // chain key must be stable across the 401-retry pair, and per-account so a
    // pool failover never chains another account's request id. The wire
    // session id additionally rolls when a second account serves the same
    // harness session, so no conversation spans two account identities.
    const harnessSessionId = options.sessionId !== undefined ? String(options.sessionId) : randomUUID()
    const chainAccount = await this.chainAccount(account)
    const sessionId = claudeWireSessionId(chainAccount, harnessSessionId)
    try {
      let session = await this.options.tokens.session(account)
      let response = await this.request(options, account, session, sessionId, chainAccount, watchdog.signal)
      if (response.status === 401) {
        session = await this.options.tokens.session(account, true)
        response = await this.request(options, account, session, sessionId, chainAccount, watchdog.signal)
      }
      // The unified rate-limit headers ride every answered Messages response, the
      // 429 included, and are the provider's own statement of this account's
      // standing. They are read before the status check so the Settings cards can
      // report a rejected or warning account without a second request.
      const rateLimit = parseUnifiedRateLimit(response.headers, Date.now())
      if (rateLimit !== undefined && chainAccount !== '') {
        rememberUnifiedRateLimit('claude', chainAccount, rateLimit)
      }
      if (!response.ok) {
        throw await httpLlmError(response, 'claude API', {
          rateLimitReset: claudeRateLimitReset,
          ...this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn },
        })
      }
      // The response's own request id is both the value the next request chains and the
      // value the assistant message records, so it is read once and passed to the
      // translator with the body it belongs to.
      const requestId = response.headers.get('request-id')
      rememberClaudeRequestId(chainAccount, sessionId, requestId)
      if (response.body === null) {
        throw new LlmError('claude API returned no response body', EMPTY_RESPONSE_CODE)
      }
      yield* streamAnthropic(response.body, () => { watchdog.pulse() }, requestId ?? undefined, claudeStreamRefusalProbe(response))
    } catch (error: unknown) {
      throw mapFetchFailure('claude API', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  private thinkingParam(model: string, thinkingType: 'enabled' | 'adaptive' | undefined, maxTokens: number): ClaudeWireThinking | undefined {
    return claudeThinkingBody(model, thinkingType, maxTokens)
  }

  /**
   * Backfill the wire-identity fields a pre-upgrade stored session lacks:
   * the device id is minted once, the account uuid comes from the OAuth
   * profile. The updated session is persisted so the next request skips the
   * lookup. A missing account uuid after the lookup fails the request loudly
   * instead of sending a bogus correlation triple.
   */
  private async identitySession(
    session: ClaudeSession,
    account: string | undefined,
    fetchFn: FetchFn,
    signal: AbortSignal,
  ): Promise<ClaudeSession> {
    if (session.deviceId !== undefined && session.accountUuid !== undefined) return session
    const profile = session.accountUuid === undefined
      ? await fetchClaudeProfile(session.accessToken, fetchFn, signal,
          async () => (await this.options.tokens.session(account, true)).accessToken)
      : {}
    const next: ClaudeSession = {
      ...session,
      ...session.deviceId === undefined ? { deviceId: claudeDeviceIdFor(session) } : {},
      ...session.accountUuid === undefined && profile.accountUuid !== undefined
        ? { accountUuid: profile.accountUuid }
        : {},
    }
    if (next.accountUuid === undefined) {
      throw new LlmError(
        'claude account identity is unavailable (profile lookup failed); log in again via Settings → Subscriptions',
        'INVALID_REQUEST',
      )
    }
    if (next.deviceId !== session.deviceId || next.accountUuid !== session.accountUuid) {
      await this.options.tokens.persist(account, next)
    }
    return next
  }

  /**
   * When each session last issued a request, and whether its latest break was acted on.
   *
   * Silence cannot be observed from the request itself: the history carries no timestamps. It
   * does not need to be, because no request is issued during silence — the gap between a
   * session's consecutive requests is the gap between its consecutive transcript messages. A
   * decision is remembered so the same break keeps being acted on, which is what the client
   * does, and the table is bounded the way the client bounds its own.
   */
  private readonly requestClock = new Map<string, { lastRequestAt: number; clearedForIdle: boolean }>()

  /**
   * Measures the silence before this request, remembering a break that was already acted on.
   *
   * @param sessionId - the session issuing the request.
   * @returns the silence in milliseconds, or the threshold when this break was already acted on.
   */
  private idleBeforeRequest(sessionId: string): number | undefined {
    const now = Date.now()
    const prior = this.requestClock.get(sessionId)
    const idle = prior === undefined ? undefined : now - prior.lastRequestAt
    const clearedForIdle = (idle !== undefined && idle >= STALE_TOOL_RESULT_IDLE_MS) || prior?.clearedForIdle === true
    if (this.requestClock.size >= REQUEST_CLOCK_LIMIT && prior === undefined) {
      const oldest = this.requestClock.keys().next().value
      if (oldest !== undefined) this.requestClock.delete(oldest)
    }
    this.requestClock.set(sessionId, { lastRequestAt: now, clearedForIdle })
    return clearedForIdle ? STALE_TOOL_RESULT_IDLE_MS : idle
  }

  private async request(
    options: GenerateOptions,
    account: string | undefined,
    session: ClaudeSession,
    sessionId: string,
    chainAccount: string,
    signal: AbortSignal,
  ): Promise<Response> {
// The Messages request is the one this transport reproduces; token and usage
    // calls keep the existing client.
    const fetchFn = this.options.fetchFn ?? claudeApiFetch
    const disc = await this.discovered(options.model)
    const contextWindow = disc?.contextWindow
      ?? this.options.models.find(entry => entry.id === options.model)?.contextWindow
      ?? claudeModelLimits(options.model).contextWindow
    const resolved = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal, claudeImagePolicy(contextWindow))
    const messages = await bindClaudeFileIds(resolved, chainAccount, session.accessToken, fetchFn, signal)
    const maxTokens = options.maxTokens
      ?? claudeMaxTokens(this.options.models.find(entry => entry.id === options.model), disc, options.model)
    const thinking = this.thinkingParam(options.model, disc?.thinkingType, maxTokens)
    const effort = options.reasoningEffort !== undefined && disc?.reasoning !== undefined
      ? String(options.reasoningEffort)
      : undefined
    const identitySession = await this.identitySession(session, account, fetchFn, signal)
    let built: BuiltClaudeCodeRequest
    try {
      const contextManagement = planContextManagement({
        hasThinking: thinking !== undefined,
        idleBeforeRequestMs: this.idleBeforeRequest(sessionId),
        messages,
      })
      built = await buildClaudeWireRequest(
        options, identitySession, messages, maxTokens, thinking, effort, sessionId, chainAccount,
        this.options.identityLine, contextManagement,
      )
    } catch (error: unknown) {
      const mapped = mapClaudeWireError(error, messages)
      if (mapped !== undefined) throw mapped
      throw error
    }
    assertClaudeRequestBytes(built.body, messages)
    return fetchFn(built.url, {
      method: built.method,
      headers: Object.fromEntries(built.headers),
      body: built.body,
      signal,
    })
  }
}
