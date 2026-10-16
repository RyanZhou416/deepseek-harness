/**
 * Claude Pro/Max subscription provider: OAuth against claude.ai /
 * platform.claude.com with the Claude Code client id, and streaming against
 * the Anthropic Messages API through the pinned Claude Code 2.1.288 wire
 * contract built by `@tormentalabs/claude-code-wire-compat`.
 */

import { createHash } from 'node:crypto'
import { EMPTY_RESPONSE_CODE, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { CLAUDE_CODE_2_1_288_PROFILE, isClaude3Model } from '@tormentalabs/claude-code-wire-compat'
import type { BuiltClaudeCodeRequest } from '@tormentalabs/claude-code-wire-compat'
import type { FlowSpec } from '../auth/oauth-flow.js'
import type { ClaudeSession } from '../auth/store.js'
import { claudeCredentialModeOf, withClaudeCredentialReference } from '../auth/claude-credential-ownership.js'
import type { PoolAdapter } from './pool.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { resolveImages } from '../translate/resolved.js'
import { assertClaudeRequestBytes, claudeImagePolicy } from './claude-images.js'
import { desktopClientHeaders } from './claude-desktop.js'
import { deriveAccountDeviceId, readLocalDeviceFingerprint } from './claude-device.js'
import type { ResolvedImagePart, TranslatableBlock, TranslatableMessage } from '../translate/resolved.js'
import {
  streamAnthropic,
} from '../translate/anthropic.js'
import type { AnthropicRefusalProbe } from '../translate/anthropic.js'
import {
  CLAUDE_PLAIN_USER_AGENT,
  CLAUDE_USER_AGENT,
  assertPolicyRequestShape,
  boundedTwoLevelMap,
  buildClaudeWireRequest,
  mapClaudeWireError,
} from './claude-wire.js'
import type { ClaudeWireContinuation } from './claude-wire.js'
import {
  CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED,
  CLAUDE_WIRE_RECORD_LIBRARY,
  ClaudeRequestRecordPort,
  REQUEST_RECORD_UNAVAILABLE,
  extractClaudeSystemBlocks,
} from './claude-wire-record.js'
import type { ClaudeEnginePolicy } from '../claude-engine/request-policy.js'
import { readClaudeContinuation, selectClaudeContinuation } from '../claude-engine/continuation.js'
import type { ContinuationMessage } from '../claude-engine/continuation.js'
import { sameClaudeAccountRef } from '../claude-core/account-ref.js'
import type { ClaudeAccountRef } from '../claude-core/account-ref.js'
import { LOCAL_CONTINUATION_STATE_UNAVAILABLE, continuationBudget, continuationUnavailable } from './claude-continuation-io.js'
import type { ContinuationDeadline, ContinuationUnavailable } from './claude-continuation-io.js'
import type {
  ClaudeContinuationPrepared,
  ClaudeContinuationState,
} from './claude-continuation-state.js'
import type { ClaudeCaptureTicket, ClaudeSpanPin } from './claude-span-store.js'
import { STALE_TOOL_RESULT_IDLE_MS, planContextManagement } from './context-management.js'
import type { ClaudeWireThinking } from './claude-wire.js'
import { claudeCatalogueListing } from './claude-catalogue.js'
import type { ClaudeCatalogueOption } from './claude-catalogue.js'
import { claudeCatalogueEntry, claudeModelLimits } from './claude-model-limits.js'
import {
  effortDisplayName,
  idleWatchdog,
  isEnforcementRefusal,
  mapFetchFailure,
  mergeReasoning,
  oauthEndpointError,
  OAuthEndpointError,
} from './common.js'
import { AccountTokenManager } from './accounts.js'
import type {
  CatalogStoreFactory,
  DiscoveredModel,
  FetchFn,
  ModelEntry,
  ProviderUsage,
  UsageWindow,
} from './common.js'
import { ProviderCatalog, catalogRow } from './provider-catalog.js'
import { PoolBackedAdapter } from './pool-delegation.js'
import {
  CLIENT_VERSION_UNSUPPORTED_CODE,
  STREAM_INCOMPLETE_CODE,
  claudeAmbiguousSend,
  claudeBlockedRequest,
  claudeFailureDecisionOf,
  claudeFailureError,
  claudeFinishDecision,
  claudeHttpLlmError,
  claudeProtocolBlockDecision,
  claudeRecoveryExhausted,
  claudeStreamFailure,
  readClaudeErrorBody,
} from './claude-failure.js'
import type { ClaudeFailureDecision } from './claude-failure.js'
import { CLAUDE_PROTOCOL_PROFILE, claudeRoleHeaders } from './claude-protocol.js'
import type { ClaudeProtocolProfile } from './claude-protocol.js'
import { ClaudeProtocolBlockStore } from './claude-protocol-state.js'
// The maintenance module owns these two input contracts: this route implements them rather than
// declaring a second copy that could drift from the consumer it serves.
import type { ClaudeProfileReadRequest, ClaudeProfileReadResult, ClaudeProfileReader } from './claude-profile.js'
import type { ClaudePolicyFetchFn, ClaudePolicyFetchRequest } from './claude-managed-settings.js'
import type { ClaudeProfileFields } from './claude-account-state.js'
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
import type { UnifiedRateLimitState } from './unified-rate-limit.js'
import { parseUsageJson } from '../claude-core/quota-observation.js'

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

/**
 * The model-options endpoint the client uses on the first-party path.
 *
 * `/v1/models` is not part of that path at all — the client reaches it only under the
 * gateway's own discovery switch — so calling it here would be a request the genuine client
 * never sends. This one supplements a catalogue the client already carries, and a response
 * that fails its shape is discarded rather than treated as a failure. Its path comes from
 * the compatibility profile, so one role cannot quietly reach another role's target.
 */

/**
 * The durable capture a bootstrap catalogue read claims before it asks.
 *
 * The read is the only thing that discloses this account's ATIS candidate, so it claims a right
 * that survives a restart and commits what it read under that same right; a read with no wired
 * state claims nothing, and the spans then freeze empty rather than inheriting a token nobody
 * could attribute to an identity.
 */
export interface ClaudeCatalogueCapture {
  /**
   * Claim the right to record what this read discloses.
   * @param account - the canonical account key the read belongs to.
   * @returns the durable ticket, or the fixed refusal.
   */
  beginCapture(account: string): Promise<{ readonly kind: 'ticket'; readonly ticket: ClaudeCaptureTicket } | ContinuationUnavailable>
  /**
   * Record what a successful read disclosed, when its ticket still owns the account.
   * @param ticket - the ticket {@link beginCapture} returned.
   * @param disclosed - the raw value the read disclosed.
   */
  commitCapture(ticket: ClaudeCaptureTicket, disclosed: unknown): Promise<unknown>
}

/** The continuation one attempt was prepared under, as the request path carries it. */
interface ClaudeRequestContinuation {
  /** The canonical account key this attempt is served for. */
  readonly account: string
  /** The identity facts this attempt owns. */
  readonly prepared: ClaudeContinuationPrepared
  /** The pin in force, frozen before anything is uploaded or built. */
  readonly pin: ClaudeSpanPin
}

/**
 * The refusal one unavailable continuation state reports.
 *
 * The code is the fixed one every continuation store reports and the disposition forbids a retry:
 * a request whose wire identity could not be committed must not be re-sent under a fresh random
 * one, which is exactly what an automatic retry would do.
 * @param unavailable - the refusal the state reported.
 * @returns the harness error naming it.
 */
function claudeContinuationRefusal(unavailable: ContinuationUnavailable): LlmError {
  return new LlmError(
    `claude request refused: the continuation state is unavailable (${unavailable.reason})`,
    LOCAL_CONTINUATION_STATE_UNAVAILABLE,
    { retryDisposition: 'forbid' },
  )
}

/** The plugin's startup hydration result, read once it settled rather than sampled as a flag. */
export type ClaudeContinuationReadiness =
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly reason: string }

/**
 * Wait for one already-running promise under a deadline and the caller's cancellation.
 *
 * The work is not cancelled by either outcome: the hydration this waits on belongs to the plugin's
 * disposal, which awaits it itself, and this only stops this request from waiting for it. The timer
 * and the abort listener are removed on every outcome.
 * @param work - the running work, which reports its own result to whoever owns it.
 * @param budget - the absolute budget the state phase shares.
 * @param signal - the caller's own cancellation.
 * @returns what ended the wait.
 */
async function waitBounded(
  work: Promise<unknown>,
  budget: ContinuationDeadline,
  signal: AbortSignal | undefined,
): Promise<'settled' | 'timed-out' | 'aborted'> {
  if (signal?.aborted === true) return 'aborted'
  const remaining = budget.expiresAt - Date.now()
  if (remaining <= 0) return 'timed-out'
  return await new Promise<'settled' | 'timed-out' | 'aborted'>(resolve => {
    let finished = false
    const finish = (outcome: 'settled' | 'timed-out' | 'aborted'): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = (): void => { finish('aborted') }
    const timer = setTimeout(() => { finish('timed-out') }, Math.max(1, remaining))
    signal?.addEventListener('abort', onAbort, { once: true })
    void work.then(() => { finish('settled') }, () => { finish('settled') })
  })
}

/**
 * Whether one retained row's replay envelope accounts for the blocks the row actually holds.
 *
 * The envelope is opaque here — it came back out of a log — so its block list is validated before
 * anything inside it is trusted: a row whose envelope describes a different number of blocks is not
 * evidence about any span.
 * @param replayState - the row's recorded replay state.
 * @param content - the row's own content blocks.
 * @returns true when the envelope's block list lines up with the row's content.
 */
function envelopeBlocksAlign(replayState: unknown, content: readonly unknown[] | undefined): boolean {
  if (typeof replayState !== 'object' || replayState === null) return false
  const blocks = (replayState as { blocks?: unknown }).blocks
  return Array.isArray(blocks) && Array.isArray(content) && blocks.length === content.length
}

/**
 * The wire identity a retained row's own continuation states for the same span.
 *
 * This is the caller's verified log fact and nothing more: the row must be a real assistant answer
 * this route produced, its envelope must account for the blocks it holds, and its continuation must
 * state this account's reference, this identity generation and this harness session for its wire
 * session id to be adopted. Adopting it is stronger than adopting a chain, so a foreign row, a user
 * row or a misaligned one starts a fresh span instead of lending its identity to this request. A
 * trusted row that recorded no request id is still usable, which is why this gate is not the chain
 * selector.
 * @param messages - the retained history the request was built from.
 * @param identity - the reference and epoch resolved for this request.
 * @param harnessSessionId - the harness session the request belongs to.
 * @returns the recorded wire session id, or undefined when no row states one for this span.
 */
function restoredWireSessionId(
  messages: readonly ContinuationMessage[],
  identity: { readonly accountRef: ClaudeAccountRef; readonly spanEpoch: number },
  harnessSessionId: string,
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const source = message.source
    if (source?.kind !== 'model' || source.provider !== 'claude') continue
    const continuation = readClaudeContinuation(source.replayState)
    if (continuation === undefined) continue
    if (!envelopeBlocksAlign(source.replayState, message.content)) continue
    if (continuation.spanEpoch !== identity.spanEpoch) continue
    if (continuation.harnessSessionId !== harnessSessionId) continue
    if (!sameClaudeAccountRef(continuation.accountRef, identity.accountRef)) continue
    return continuation.wireSessionId
  }
  return undefined
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
/**
 * Read the client's millisecond-first retry header, bounded to its timer range.
 * @param response - the failed Claude response.
 * @param now - current epoch milliseconds.
 * @returns the disclosed retry instant, or undefined for absent/invalid delays.
 */
export function claudeRetryHeaderReset(response: Response, now: number): number | undefined {
  let delay: number | undefined
  const milliseconds = response.headers.get('retry-after-ms')
  if (milliseconds) {
    const parsed = Number.parseFloat(milliseconds)
    if (!Number.isNaN(parsed)) delay = parsed
  }
  const seconds = response.headers.get('retry-after')
  if (seconds && !delay) {
    const parsed = Number.parseFloat(seconds)
    delay = Number.isNaN(parsed) ? Date.parse(seconds) - now : parsed * 1000
  }
  return delay !== undefined && delay > 0 && delay <= 2_147_483_647 ? now + delay : undefined
}

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

/**
 * Upload one image. The response `id` is the Messages `file_id`.
 * @param accessToken - the account's current access token.
 * @param part - the oversized image to upload.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation.
 * @param onDecision - sink for the ordered classification, so a refusal of this profile is
 *   recorded here exactly as it is on Messages: the Files endpoint shares the origin, so the
 *   same client-version refusal must not be bypassable by uploading first.
 * @returns the uploaded file id.
 */
async function uploadClaudeFile(
  accessToken: string,
  part: ResolvedImagePart,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
  onDecision?: (decision: ClaudeFailureDecision) => void,
): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([Buffer.from(part.dataBase64, 'base64')], { type: part.mediaType }), imageFilename(part.mediaType))
  const response = await fetchFn(CLAUDE_PROTOCOL_PROFILE.endpoints.files, {
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
  if (!response.ok) {
    throw await claudeHttpLlmError(response, {
      label: 'claude files API',
      profile: CLAUDE_PROTOCOL_PROFILE,
      ...onDecision === undefined ? {} : { onDecision },
    })
  }
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
  onDecision?: (decision: ClaudeFailureDecision) => void,
): Promise<string | undefined> {
  if (part.fileId !== undefined || part.dataBase64.length <= CLAUDE_MAX_BASE64_IMAGE_CHARS) return part.fileId
  const contentHash = createHash('sha256').update(part.dataBase64).digest('hex')
  const cached = uploadedClaudeFileId(account, contentHash)
  if (cached !== undefined) return cached
  const id = await uploadClaudeFile(accessToken, part, fetchFn, signal, onDecision)
  rememberClaudeFileId(account, contentHash, id)
  return id
}

async function withFileIds(
  blocks: readonly TranslatableBlock[],
  account: string,
  accessToken: string,
  fetchFn: FetchFn,
  signal?: AbortSignal,
  onDecision?: (decision: ClaudeFailureDecision) => void,
): Promise<readonly TranslatableBlock[]> {
  let changed = false
  const next: TranslatableBlock[] = []
  for (const block of blocks) {
    if (block.type === 'image' && 'dataBase64' in block) {
      const fileId = await fileIdForImage(block, account, accessToken, fetchFn, signal, onDecision)
      if (fileId !== undefined && fileId !== block.fileId) {
        changed = true
        next.push({ ...block, fileId })
        continue
      }
    }
    if (block.type === 'tool-result') {
      const content = await withFileIds(block.content, account, accessToken, fetchFn, signal, onDecision)
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
 * @param onDecision - sink for an upload's ordered classification.
 * @returns the messages, with uploaded images bound to a file id.
 */
export async function bindClaudeFileIds(
  messages: readonly TranslatableMessage[],
  account: string,
  accessToken: string,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
  onDecision?: (decision: ClaudeFailureDecision) => void,
): Promise<readonly TranslatableMessage[]> {
  let changed = false
  const next: TranslatableMessage[] = []
  for (const message of messages) {
    const content = await withFileIds(message.content, account, accessToken, fetchFn, signal, onDecision)
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

/** Release a rejected response without replacing the refresh/replay outcome with a cleanup failure. */
async function discardClaudeResponse(response: Response): Promise<void> {
  if (response.body === null) return
  try {
    await response.body.cancel()
  } catch (cancelError: unknown) {
    // A failed/locked body may reject cancellation; the original HTTP outcome still owns classification.
    void cancelError
  }
}

/**
 * One profile read's inputs.
 *
 * The disclosed fields are the maintenance module's own record type, and the result is its
 * reader result type: this route implements that contract instead of declaring a second
 * version of it.
 */
export interface ClaudeProfileRequest {
  /** The access token the read carries. */
  readonly accessToken: string
  /** Fetch implementation; injectable so no test reaches the network. */
  readonly fetchFn?: FetchFn
  /** Caller cancellation. */
  readonly signal?: AbortSignal
  /** Refresh-and-replay hook: one replay after a rejection, as the client performs. */
  readonly reauthorize?: ClaudeReauthorize
  /** The frozen compatibility profile this read belongs to; absent uses the pinned one. */
  readonly profile?: ClaudeProtocolProfile
  /** Identity the caller already holds; a conflicting disclosure reports `invalid`. */
  readonly expectedAccountUuid?: string
  /** Receives the ordered classification, so a refusal here blocks the profile too. */
  readonly onDecision?: (decision: ClaudeFailureDecision) => void
  /**
   * Accept the pre-wire flat document the login and identity backfill callers tolerate.
   *
   * Off by default: the maintenance reader validates the wire shape, where `account` and
   * `organization` are two objects with their own uuids. This option exists only for those two
   * legacy callers, which treat the read as decoration and check the fields they receive.
   */
  readonly legacyFlatPayload?: boolean
}

/**
 * What one profile read disclosed, or why it disclosed nothing.
 *
 * The shape is the maintenance reader's own result extended with the two things this route
 * keeps for itself: the transport cause of an unreachable read, and the classified error a
 * refusal already produced — so a caller that must stop never rebuilds one from the record.
 */
export type ClaudeProfileResult =
  | ClaudeProfileReadResult
  | { readonly outcome: 'unreachable'; readonly cause?: unknown }
  | {
    readonly outcome: 'ok'
    readonly fields: ClaudeProfileFields
    /** The client's own completeness verdict for this document. */
    readonly complete: boolean
  }
  | {
    readonly outcome: 'unauthorized' | 'refused'
    readonly failure: ClaudeFailureDecision
    readonly error: LlmError
  }

/**
 * Read one value out of an untyped record.
 * @param value - the value crossing the wire boundary.
 * @returns the record when the value is a JSON object, otherwise undefined.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** One field's presence and value, so an explicit null is distinguishable from absence. */
interface OwnField {
  /** Whether the record owns the key at all. */
  readonly present: boolean
  /** The value the record owns; null is a stated value. */
  readonly value: unknown
}

/**
 * Read one field's own value from a record.
 * @param record - the record, when one exists.
 * @param key - the field name.
 * @returns whether the record owns the field and what it holds.
 */
function ownField(record: Record<string, unknown> | undefined, key: string): OwnField {
  if (record === undefined || !Object.hasOwn(record, key)) return { present: false, value: undefined }
  return { present: true, value: record[key] }
}

/** The first non-empty string among the candidates, in priority order. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * The profile fields a wire payload disclosed, or undefined when it disclosed none.
 *
 * The payload is the untyped response document, so every level is validated before it is read
 * and no field is guessed: an absent field stays absent, and a field the payload states as
 * null stays null rather than being collapsed into the next candidate. The organisation
 * identifier is the one the wire actually nests (`organization.uuid`); a flat string is
 * accepted where a deployment states one, and an object under that name is not. The
 * subscription type is deliberately not required — an account whose plan cannot be read is
 * still a readable account, and an absent type is left absent rather than invented as null.
 * @param payload - the parsed response document.
 * @returns the validator's view of the disclosed fields, or undefined when there are none.
 */
function readClaudeProfileFields(payload: unknown): ClaudeProfileFields | undefined {
  const root = asRecord(payload)
  if (root === undefined) return undefined
  const account = asRecord(root['account'])
  const organization = asRecord(root['organization'])
  const email = firstString(
    root['emailAddress'], root['email'], account?.['email_address'], account?.['email'],
  )
  // Subscription type is read by own-field presence: the wire spells it three ways, and an
  // explicit null in the first is that account's stated value, not a reason to read the next.
  const subscription = [
    ownField(root, 'subscriptionType'),
    ownField(root, 'subscription_type'),
    ownField(account, 'subscription_type'),
  ].find(candidate => candidate.present)
  const accountUuid = firstString(ownField(account, 'uuid').value, root['accountUuid'])
  const organizationId = firstString(
    organization?.['uuid'],
    ownField(root, 'organization').value,
    account?.['organization_uuid'],
    account?.['organization'],
  )
  const subscriptionValue = subscription?.value
  const fields: ClaudeProfileFields = {
    ...email === undefined ? {} : { emailAddress: email },
    ...typeof subscriptionValue === 'string' && subscriptionValue.length > 0
      ? { subscriptionType: subscriptionValue }
      : subscriptionValue === null ? { subscriptionType: null } : {},
    ...accountUuid === undefined ? {} : { accountUuid },
    ...organizationId === undefined ? {} : { organization: organizationId },
  }
  return Object.keys(fields).length === 0 ? undefined : fields
}

/**
 * Whether a wire document carries the identity the profile read must adopt.
 *
 * The endpoint's own schema types `account` as an object carrying both a `uuid` and an `email`,
 * and `organization` as an object carrying its `uuid`. All three are read as the wire spells
 * them: a root-level address, an `email_address` key, or a missing object is not the required
 * field, and a document without them is not a profile this route adopts — reading it would
 * attach half an identity to an account.
 * @param payload - the parsed response document.
 * @returns true when both objects and all three required fields are present.
 */
function hasClaudeProfileIdentity(payload: Record<string, unknown>): boolean {
  const account = asRecord(payload['account'])
  const organization = asRecord(payload['organization'])
  return firstString(account?.['uuid']) !== undefined
    && firstString(account?.['email']) !== undefined
    && firstString(organization?.['uuid']) !== undefined
}

/**
 * Whether a wire document is complete for this maintenance.
 *
 * Completeness is the client's own criteria, not "the two fields this plugin happens to key
 * on": the organization's stated billing type, the account's creation time, and the
 * organization's subscription creation time. The billing type belongs to the organization —
 * that is where the client reads it — so a root-level `billing_type` is not that field and
 * cannot complete a document whose organization left it unstated. `cc_onboarding_flags` is
 * normalised to `{}` when absent, so it never makes a document incomplete. The subscription
 * type is deliberately outside this test: an unknown plan is a complete answer, and requiring
 * it would re-read the profile forever.
 * @param payload - the parsed response document.
 * @returns true when every criterion is satisfied.
 */
function isCompleteClaudeProfile(payload: Record<string, unknown>): boolean {
  const account = asRecord(payload['account'])
  const organization = asRecord(payload['organization'])
  const billing = ownField(organization, 'billing_type')
  const created = ownField(account, 'created_at')
  const subscriptionCreated = ownField(organization, 'subscription_created_at')
  return billing.present && billing.value !== null && billing.value !== undefined
    && created.present && created.value !== undefined
    && subscriptionCreated.present && subscriptionCreated.value !== null
}

/**
 * Classify a failed profile response into this read's outcome.
 * @param error - the classified failure the profile endpoint produced.
 * @returns the outcome that preserves the decision.
 */
function profileFailureOutcome(error: LlmError): ClaudeProfileResult {
  const decision = claudeFailureDecisionOf(error)
  if (decision === undefined) return { outcome: 'unreachable', cause: error }
  if (decision.reason === 'AUTH') return { outcome: 'unauthorized', failure: decision, error }
  if (decision.reason === 'SERVER' || decision.reason === 'TIMEOUT' || decision.reason === 'TRANSPORT') {
    return { outcome: 'unreachable', cause: error }
  }
  return { outcome: 'refused', failure: decision, error }
}

/**
 * Read one account's profile, preserving why it disclosed nothing.
 *
 * The read is replayable exactly as the client performs it: one rejection is answered by a
 * refresh and a second request, and a second rejection is reported as it stands. Failures
 * keep their ordered classification, so a client-version refusal found here is not lost to
 * a generic "no profile" result.
 * @param request - the token, cancellation and optional refresh hook.
 * @returns the structured outcome of this read.
 */
export async function fetchClaudeProfile(request: ClaudeProfileRequest): Promise<ClaudeProfileResult> {
  const fetchFn = request.fetchFn ?? proxiedFetch
  const profile = request.profile ?? CLAUDE_PROTOCOL_PROFILE
  const signal = request.signal
  const send = (token: string): Promise<Response> =>
    fetchFn(profile.endpoints.profile, {
      headers: {
        authorization: `Bearer ${token}`,
        // The client's own profile request: a bodyless JSON GET carrying the plain user agent,
        // under the ten-second bound the client gives it.
        ...claudeRoleHeaders('profile'),
      },
      signal: signal === undefined
        ? AbortSignal.timeout(PROFILE_TIMEOUT_MS)
        : AbortSignal.any([signal, AbortSignal.timeout(PROFILE_TIMEOUT_MS)]),
    })
  let response: Response
  try {
    response = await send(request.accessToken)
  } catch (error: unknown) {
    if (signal?.aborted === true) return { outcome: 'cancelled' }
    // An auxiliary GET is not the Messages POST: a read that never received a response is the
    // existing transient case, and its caller retries on its own schedule.
    return { outcome: 'unreachable', cause: error }
  }
  if (response.status === 401) {
    // The same order the Messages route uses, because the refusal is the same refusal: the body
    // is read under the byte cap and classified before any authentication recovery, so a version
    // refusal never refreshes a credential whatever status carried it.
    const rejected = await claudeHttpLlmError(response, {
      label: 'claude profile',
      profile,
      body: await readClaudeErrorBody(response),
      ...request.onDecision === undefined ? {} : { onDecision: request.onDecision },
    })
    if (rejected.code !== 'AUTH') return profileFailureOutcome(rejected)
    if (request.reauthorize === undefined) {
      // No reauthorizer was wired: this read reports the rejection as it stands rather than
      // repeating the request with the same credential.
      return profileFailureOutcome(rejected)
    }
    try {
      await discardClaudeResponse(response)
      response = await send(await request.reauthorize())
    } catch (error: unknown) {
      if (signal?.aborted === true) return { outcome: 'cancelled' }
      return { outcome: 'unreachable', cause: error }
    }
    if (response.status === 401) {
      // The one replay this read is allowed has been spent: the rejection stands, and it may not
      // start the refresh cycle again from a caller above.
      const exhausted = await claudeHttpLlmError(response, {
        label: 'claude profile',
        profile,
        ...request.onDecision === undefined ? {} : { onDecision: request.onDecision },
      })
      return profileFailureOutcome(claudeRecoveryExhausted(exhausted))
    }
  }
  if (!response.ok) {
    const failure = await claudeHttpLlmError(response, {
      label: 'claude profile',
      profile,
      ...request.onDecision === undefined ? {} : { onDecision: request.onDecision },
    })
    return profileFailureOutcome(failure)
  }
  // A successful body is read under the same byte cap the refusal path uses: a profile document
  // is a fixed small shape, so a response larger than the cap is one this route does not accept,
  // and reading it whole would let one response decide how much memory the read costs. The text
  // is parsed here and dropped; the raw document is never retained or attached to an error.
  const document = await readClaudeErrorBody(response)
  if (document.overflowed) return { outcome: 'invalid' }
  let payload: unknown
  try {
    payload = JSON.parse(document.text)
  } catch {
    // A successful status whose body is not JSON is a document this route cannot validate.
    return { outcome: 'invalid' }
  }
  if (request.legacyFlatPayload !== true) {
    // The maintenance reader is strict about the wire shape: the endpoint serves `account` and
    // `organization` as two objects, and a document missing either is not adopted — reading it
    // would attach half an identity, and its completeness verdict would describe a document the
    // service never sent.
    const root = asRecord(payload)
    if (root === undefined || !hasClaudeProfileIdentity(root)) return { outcome: 'invalid' }
  }
  const fields = readClaudeProfileFields(payload)
  if (fields === undefined) return { outcome: 'missing' }
  if (request.expectedAccountUuid !== undefined && fields.accountUuid !== undefined
    && fields.accountUuid !== request.expectedAccountUuid) {
    return { outcome: 'invalid' }
  }
  const root = asRecord(payload)
  return {
    outcome: 'ok',
    fields,
    // The verdict describes the document itself, so a legacy payload that carries no such fields
    // is simply not complete rather than being credited with fields it never stated.
    complete: root !== undefined && isCompleteClaudeProfile(root),
  }
}

/**
 * Best-effort identity fields for callers whose request must not fail on a profile read.
 *
 * These are the two legacy callers — the login exchange and the identity backfill — so they keep
 * the tolerant flat-document shape; the maintenance reader does not.
 * @param request - the token and cancellation for the read.
 * @returns the disclosed identity fields, or an empty object.
 */
async function bestEffortClaudeProfile(
  request: ClaudeProfileRequest,
): Promise<Pick<ClaudeSession, 'emailAddress' | 'subscriptionType' | 'accountUuid'>> {
  const result = await fetchClaudeProfile({ ...request, legacyFlatPayload: true })
  if ((result.outcome === 'refused' || result.outcome === 'unauthorized')
    && 'error' in result && result.failure.retryDisposition === 'forbid') {
    // An explicit refusal is not missing data: reporting it as an unavailable identity would
    // hide the stop the service stated, so the classified error this read already built is
    // what the caller sees.
    throw result.error
  }
  if (result.outcome !== 'ok') return {}
  const { emailAddress, subscriptionType, accountUuid } = result.fields
  return {
    ...emailAddress === undefined ? {} : { emailAddress },
    ...subscriptionType === undefined || subscriptionType === null ? {} : { subscriptionType },
    ...accountUuid === undefined ? {} : { accountUuid },
  }
}

/** Dependencies one {@link claudeProfileReader} carries. */
export interface ClaudeProfileReaderOptions {
  /** Fetch implementation; injectable so no test reaches the network. */
  readonly fetchFn?: FetchFn
  /** The frozen compatibility profile this reader belongs to. */
  readonly profile?: ClaudeProtocolProfile
  /** Receives the ordered classification of a refused read. */
  readonly onDecision?: (decision: ClaudeFailureDecision) => void
}

/**
 * Build the profile reader the account maintenance module consumes.
 *
 * The account key travels with the call so a consumer can key its cache by identity; the
 * read itself is authorized by the token alone.
 * @param options - fetch injection and the compatibility profile.
 * @returns a reader that never throws for a provider outcome, only for a programming error.
 */
export function claudeProfileReader(options: ClaudeProfileReaderOptions = {}): ClaudeProfileReader {
  return async (request: ClaudeProfileReadRequest) => fetchClaudeProfile({
    accessToken: request.accessToken,
    // The controller owns the cancellation it passes; this factory only forwards it.
    signal: request.signal,
    ...options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn },
    ...options.profile === undefined ? {} : { profile: options.profile },
    ...options.onDecision === undefined ? {} : { onDecision: options.onDecision },
  })
}

/** Dependencies one {@link claudeSettingsFetch} carries. */
export interface ClaudeSettingsFetchOptions {
  /** Fetch implementation; injectable so no test reaches the network. */
  readonly fetchFn?: FetchFn
  /** Bound on one settings read; defaults to the profile read's own bound. */
  readonly timeoutMs?: number
  /** The frozen compatibility profile this read belongs to. */
  readonly profile?: ClaudeProtocolProfile
}

/**
 * Build the managed-settings fetch the account maintenance module consumes.
 *
 * The settings role owns its headers: it sends the settings user agent and OAuth beta and
 * does not borrow the Messages plan. Only the transfer is performed here; interpreting the
 * status, the checksum and the cached snapshot belongs to the caller.
 * @param options - fetch injection, bound and compatibility profile.
 * @returns a fetch that returns the provider's own response.
 */
export function claudeSettingsFetch(options: ClaudeSettingsFetchOptions = {}): ClaudePolicyFetchFn {
  const fetchFn = options.fetchFn ?? proxiedFetch
  const profile = options.profile ?? CLAUDE_PROTOCOL_PROFILE
  const timeoutMs = options.timeoutMs ?? PROFILE_TIMEOUT_MS
  return async (request: ClaudePolicyFetchRequest) => await fetchFn(profile.endpoints.settings, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${request.accessToken}`,
      ...claudeRoleHeaders('settings'),
      ...request.ifNoneMatch === undefined ? {} : { 'if-none-match': request.ifNoneMatch },
    },
    // The settings contract makes cancellation optional; when the caller owns none, the read
    // is bounded by its own timeout alone rather than by a fabricated abort signal.
    signal: request.signal === undefined
      ? AbortSignal.timeout(timeoutMs)
      : AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
  })
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
  // Profile lookup is decorative for login; only the token exchange owns login success.
  const profile = withProfile ? await bestEffortClaudeProfile({ accessToken: tokens.access_token }) : {}
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scopes: tokens.scope ?? CLAUDE_SCOPE,
    // Device binding is resolved before Messages, not while consuming an OAuth code.
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
 * Derive the device id for one account on one OS installation.
 *
 * The device input is a hash of a stable OS machine identifier, independent of DSH caches.
 * Messages use `uuid:<accountUuid>` as the account key. This DSH policy differs from CC's
 * random config-root id; no raw machine identifier is stored or sent.
 * @param accountKey - Stable account key, not a token, display name or cache path.
 * @param fingerprint - Hashed device input; omitted uses this host's stable OS identity.
 * @returns A 64-character lowercase hex id.
 * @throws LlmError when no supported stable local device identity is available.
 */
export function deriveClaudeDeviceId(accountKey: string, fingerprint?: string): string {
  return deriveAccountDeviceId(accountKey, fingerprint ?? readLocalDeviceFingerprint())
}

/**
 * Carry stored identity fields across re-authorization.
 *
 * Credential rotation does not itself rewrite device binding. Before the next Messages
 * request, the adapter recomputes the expected id for the account UUID and local device,
 * and conditionally migrates a legacy value or a cache copied from another machine.
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

/**
 * Whether a stored session is provably the same Claude account as one whose profile was
 * read.
 *
 * The backfill addresses one account key, so a credential another writer stored under it
 * is still that account's; this is the second check, for the case where a re-login landed
 * on the same key. The account uuid decides when both sessions carry one, the login email
 * when both carry one, and otherwise the credential lineage must be unchanged — an
 * unidentified session with a rotated refresh token could be a different person, and must
 * not receive the identity read for the earlier one.
 *
 * @param stored - the session the store holds after the lost write.
 * @param read - the session the profile read was made for.
 * @returns true when the stored session may be completed with the read identity.
 */
function sameClaudeAccount(stored: ClaudeSession, read: ClaudeSession): boolean {
  if (stored.accountUuid !== undefined && read.accountUuid !== undefined) {
    return stored.accountUuid === read.accountUuid
  }
  if (stored.emailAddress !== undefined && read.emailAddress !== undefined) {
    return stored.emailAddress === read.emailAddress
  }
  return stored.refreshToken === read.refreshToken
}

/**
 * Failure code for an identity backfill whose account changed while it was being read.
 *
 * Deliberately not `AUTH`: the credential itself is sound and the account is not at fault, so
 * the pool must not park it for the auth cooldown and no route may spend a retry on it.
 * `classifyPoolFailure` throws on an unrecognised code and no retryable-code list carries it.
 */
const CLAUDE_IDENTITY_CHANGED_CODE = 'CLAUDE_IDENTITY_CHANGED'

/**
 * The failure for an identity backfill whose account changed underneath it.
 *
 * The credential is never written over in this case and no request is sent under a mixed
 * identity, so the caller's honest outcome is to send the turn again against whatever the
 * account now holds.
 *
 * @param because - what the race was observed as.
 * @returns the error to throw.
 */
function claudeIdentityRacedError(because: string): LlmError {
  return new LlmError(
    `claude account identity could not be attached because ${because} while it was read; `
    + 'the account was not modified, send the turn again',
    CLAUDE_IDENTITY_CHANGED_CODE,
  )
}

/**
 * Failure code for an identity backfill the credential backend cannot make conditional.
 *
 * Deliberately its own code rather than the race above: nothing raced, and nothing about the
 * account or its credential is wrong. The backend simply reports no credential revision, so the
 * write that would bind an identity to an externally owned credential cannot be expressed as a
 * conditional one — and this route refuses it rather than downgrading to a comparison an
 * ownership change would not move.
 */
const CLAUDE_IDENTITY_UNVERIFIABLE_CODE = 'CLAUDE_IDENTITY_UNVERIFIABLE'

/**
 * The failure for a request whose account changed credential ownership while it was in flight.
 *
 * One fixed answer, and a hard stop: the credential this request was served with belongs to a
 * mode the account no longer states, so nothing about the turn — the identity write, the POST,
 * or a resend under the mode the user has left — may proceed. The next request prepares from
 * whatever the account now holds.
 *
 * @returns the error to throw.
 */
function claudeOwnershipChangedError(): LlmError {
  return new LlmError(
    'claude account credential ownership changed while this request was being prepared; '
    + 'the account was not modified and this request was not sent',
    CLAUDE_IDENTITY_CHANGED_CODE,
    { retryDisposition: 'forbid' },
  )
}

/**
 * The failure for an identity backfill whose condition the backend cannot express.
 *
 * Nothing was written and no request was sent, so the caller's honest outcome is to stop rather
 * than to persist an identity under a condition the store cannot enforce.
 *
 * @returns the error to throw.
 */
function claudeIdentityUnverifiableError(): LlmError {
  return new LlmError(
    'this claude credential backend reports no revision for the account, so binding an identity '
    + 'to its externally owned credential cannot be made conditional; nothing was written and the '
    + 'request was not sent',
    CLAUDE_IDENTITY_UNVERIFIABLE_CODE,
    { retryDisposition: 'forbid' },
  )
}

/**
 * The bound the client puts on one token-endpoint POST.
 *
 * The transport this plugin fetches through applies no deadline of its own, and a grant that
 * never answers would otherwise hold the refresh — and the credential it is rotating — open
 * indefinitely.
 */
const CLAUDE_TOKEN_TIMEOUT_MS = 30_000

/** Options one token-endpoint POST accepts; both default to the client's own behavior. */
export interface ClaudeTokenRequestOptions {
  /** Fetch implementation; injectable so a synthetic test never reaches the network. */
  readonly fetchFn?: FetchFn
  /** Bound on this POST in milliseconds; defaults to {@link CLAUDE_TOKEN_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/**
 * POST one grant to the token endpoint under a deadline, and finish the exchange inside it.
 *
 * The grant body and headers are the caller's; this helper owns the bound for the whole
 * exchange, not just for the response headers. The caller's `consume` runs while the deadline is
 * still armed, so reading and parsing the answer — a success document or an error body — is
 * bounded too: a body that never finishes would otherwise hang the refresh after this helper had
 * already returned. A POST that runs past the bound is aborted and reported as a timeout, and it
 * is never replayed here: the service may already have spent the grant, so a second POST with
 * the same refresh token is the caller's decision, not this helper's.
 * @param body - the grant object to send verbatim.
 * @param options - the fetch implementation and the bound.
 * @param consume - reads the response, all of it inside the deadline.
 * @returns whatever the consumer returned.
 * @throws LlmError with code `TIMEOUT` when the bound expires.
 * @throws Error when the injected bound is not a positive finite number of milliseconds.
 */
async function claudeTokenRequest<T>(
  body: Record<string, unknown>,
  options: ClaudeTokenRequestOptions,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const fetchFn = options.fetchFn ?? proxiedFetch
  const timeoutMs = options.timeoutMs ?? CLAUDE_TOKEN_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    // A bound that cannot expire would silently disable the deadline this helper exists for.
    throw new Error('claude token request timeoutMs must be a positive finite number of milliseconds')
  }
  const controller = new AbortController()
  let expired = false
  const expiry = new Error(`claude token request timed out after ${String(timeoutMs)}ms`)
  const timer = setTimeout(() => {
    expired = true
    controller.abort(expiry)
  }, timeoutMs)
  timer.unref?.()
  try {
    const response = await fetchFn(CLAUDE_TOKEN_URL, {
      // A redirect would replay the code or refresh token to another host.
      redirect: 'error',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    return await consume(response)
  } catch (error: unknown) {
    // The token response may carry credentials, so the failure is reported by its own shape and
    // never by anything the endpoint wrote back. A timeout states our own reason, not the
    // rejection that followed it.
    if (expired) {
      throw new LlmError('claude token endpoint did not answer within its deadline', 'TIMEOUT', {
        cause: expiry,
      })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Consume one completed token exchange: report a failed status, then parse the document.
 * @param response - the provider's response.
 * @param label - diagnostic prefix naming the endpoint.
 * @returns the parsed token document.
 */
async function consumeClaudeToken(response: Response, label: string): Promise<ClaudeTokenResponse> {
  if (!response.ok) throw await oauthEndpointError(response, label)
  return await response.json() as ClaudeTokenResponse
}

export async function exchangeClaudeCode(
  code: string,
  verifier: string,
  redirectUri: string,
  state: string,
  options: ClaudeTokenRequestOptions = {},
): Promise<ClaudeSession> {
  const tokens = await claudeTokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CLAUDE_CLIENT_ID,
    code_verifier: verifier,
    state,
  }, options, async response => await consumeClaudeToken(response, 'claude'))
  return claudeSession(tokens, undefined, true)
}

/**
 * Refresh a claude session (JSON grant echoing the issued scope).
 * @param session - the stored session.
 * @param options - the fetch implementation and the bound; both default to the client's own.
 * @returns the fresh session to store.
 */
export async function refreshClaude(
  session: ClaudeSession,
  options: ClaudeTokenRequestOptions = {},
): Promise<ClaudeSession> {
  const tokens = await claudeTokenRequest({
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
    client_id: CLAUDE_CLIENT_ID,
    // The client never asks for `org:create_api_key` when refreshing; that scope belongs to
    // the authorize request. Everything else the account was granted is echoed back, so a
    // project scope stays intact.
    scope: refreshScopes(session.scopes),
  }, options, async response => await consumeClaudeToken(response, 'claude'))
  const next = await claudeSession(tokens, session.refreshToken, false)
  return {
    // The token response states a credential, not this account's ownership or its local
    // binding, so the stored record's reference fields ride along unchanged.
    ...withClaudeCredentialReference(session, next),
    ...session.emailAddress === undefined ? {} : { emailAddress: session.emailAddress },
    ...session.subscriptionType === undefined ? {} : { subscriptionType: session.subscriptionType },
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


/**
 * Map the usage document to this provider's windows.
 *
 * The whole reading — which top-level keys exist, what each window's fields mean, and which
 * encoding its reset uses — belongs to the shared pure core, so the plugin has one raw
 * usage parse rather than one per consumer. The nested `limits` array wins whenever it
 * carries any entry, and the flat buckets are read only when it does not.
 * @param payload - the parsed usage document.
 * @param now - the current epoch milliseconds, for each window's observation time.
 * @returns the usage windows to report.
 */
function claudeUsageWindows(payload: Record<string, unknown>, now: number): UsageWindow[] {
  return parseUsageJson(payload, now).windows
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
    fetchFn(CLAUDE_PROTOCOL_PROFILE.endpoints.usage, {
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
        let response = await request(accessToken, controller.signal)
        if (response.status === 401) {
          // The refusal is classified before any authentication recovery, exactly as it is on
          // Messages: the body is read under the byte cap, and only an ordinary credential
          // rejection reaches the one allowed replay. A version refusal never refreshes.
          const rejected = await claudeHttpLlmError(response, {
            label: 'claude usage',
            profile: CLAUDE_PROTOCOL_PROFILE,
            body: await readClaudeErrorBody(response),
          })
          if (rejected.code !== 'AUTH') throw rejected
          if (reauthorize === undefined) throw rejected
          await discardClaudeResponse(response)
          response = await request(await reauthorize(), controller.signal)
          if (response.status === 401) {
            // The one replay is spent: this read reports the rejection and stops.
            throw claudeRecoveryExhausted(await claudeHttpLlmError(response, {
              label: 'claude usage',
              profile: CLAUDE_PROTOCOL_PROFILE,
            }))
          }
        }
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
  // Every window of this body comes from one core parse: the nested `limits` array wins
  // whenever it carries an entry, and the flat buckets are read only when it does not.
  return { supported: true, windows: claudeUsageWindows(payload, Date.now()) }
}

/**
 * The thinking shape the pinned catalogue gives one model.
 *
 * `adaptive` is the shape of every catalogued id carrying `adaptive_thinking`, and the manual
 * budget covers the rest. Thinking itself has no catalogue string in any client version, so the
 * shape is denied by the profile's own `claude-3-` predicate — the one the pinned package's
 * thinking capabilities are derived from — and the Claude 3 entries are the ids it excludes.
 * Opus 5.5 is not special-cased here: it advertises `adaptive_thinking`, and
 * {@link claudeThinkingBody} carries the models that reject a manual budget regardless.
 * @param model - the requested model id.
 * @returns the shape to send, or undefined for a model the pin gives no thinking.
 */
function claudeThinkingType(model: string): 'enabled' | 'adaptive' | undefined {
  if (claudeCatalogueEntry(model)?.capabilities.includes('adaptive_thinking') === true) return 'adaptive'
  return isClaude3Model(model) ? undefined : 'enabled'
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
 * @param thinkingType - the shape the pinned catalogue gives the model, when it gives one.
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

/** Effort levels in display order; a model exposes only the ones its catalogue marks. */
const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * The reasoning block the pinned catalogue gives one model.
 *
 * The catalogue's three effort flags are the model's own limit: `effort` carries the
 * low/medium/high levels, `xhigh_effort` adds `xhigh` and `max_effort` adds `max`. A level the
 * flags do not carry is therefore never advertised, so the harness refuses it before provider
 * I/O and a stored override naming one is dropped by {@link mergeReasoning} — no request carries
 * a level the pinned builder would refuse with `INVALID_EFFORT`. The catalogue's own
 * `default_effort` stands as the block's default, which is the level the picker preselects and
 * the one a request carries when no override is configured.
 *
 * @param model - the requested model id.
 * @returns the advertised levels and the catalogue's default, or undefined for a model that
 *   takes no effort.
 */
function claudeReasoning(model: string): DiscoveredModel['reasoning'] {
  const entry = claudeCatalogueEntry(model)
  if (entry === undefined || !entry.capabilities.includes('effort')) return undefined
  const advertised = (level: (typeof CLAUDE_EFFORT_LEVELS)[number]): boolean => {
    if (level === 'xhigh') return entry.capabilities.includes('xhigh_effort')
    if (level === 'max') return entry.capabilities.includes('max_effort')
    return true
  }
  const efforts = CLAUDE_EFFORT_LEVELS.filter(advertised).map(level => ({
    id: ReasoningEffortId(level),
    name: effortDisplayName(level),
  }))
  const preferred = entry.defaultEffort
  return {
    efforts,
    // The runtime requires `defaultEffort ∈ efforts`; a profile bump that marked a default the
    // model's own flags do not carry leaves the block without one rather than failing every call.
    ...preferred === undefined || !efforts.some(effort => effort.id === preferred)
      ? {}
      : { defaultEffort: ReasoningEffortId(preferred) },
  }
}

/**
 * The effort one request carries, when the model's own catalogue carries that level.
 *
 * The advertised set is the limit. A level outside it is dropped, so the request goes out with
 * the model's own default instead of a value the pinned builder refuses with `INVALID_EFFORT`;
 * the harness already refuses such a level before dispatch, and this keeps a caller that reaches
 * the adapter directly from turning a stale override into a failed request.
 * @param model - the requested model id.
 * @param effort - the harness-resolved effort, when the caller stated one.
 * @returns the wire effort id, or undefined when the model does not accept it.
 */
function claudeRequestedEffort(model: string, effort: GenerateOptions['reasoningEffort']): string | undefined {
  if (effort === undefined) return undefined
  const offered = claudeReasoning(model)?.efforts ?? []
  return offered.some(entry => entry.id === effort) ? String(effort) : undefined
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
 * @param capture - the durable capture owner, when the plugin wired one; the read claims its
 *   candidate under that owner's ticket.
 * @returns the catalogue rows for this account.
 */
export async function fetchClaudeCatalogue(
  session: ClaudeSession,
  extraHeaders: readonly (readonly [string, string])[] = [],
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
  account?: string,
  model?: string,
  capture?: ClaudeCatalogueCapture,
): Promise<DiscoveredModel[]> {
  const timeout = AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS)
  // The client always names the entrypoint and the model on this endpoint, so a request
  // without them is a shape it never produces.
  const url = new URL(CLAUDE_PROTOCOL_PROFILE.endpoints.bootstrap)
  url.searchParams.set('entrypoint', CLAUDE_DESKTOP_ENTRYPOINT)
  url.searchParams.set('model', model ?? newestCatalogueModel())
  // Claimed before the request is issued: the ticket is durable and carries the account version,
  // so a clear or an identity change that lands while this read is in flight stops it from writing
  // afterwards. A read with no wired state claims no candidate, so the spans then freeze empty
  // rather than inheriting a token from a read nobody could attribute.
  const ticket = account === undefined || capture === undefined
    ? undefined
    : await capture.beginCapture(account)
  const claimed = ticket?.kind === 'ticket' ? ticket.ticket : undefined
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
  // An endpoint that refuses the read is not an error: the built-in catalogue stands on its own,
  // and the account keeps whatever token its newest successful read disclosed.
  if (!response.ok) {
    await discardClaudeResponse(response)
    return claudeCatalogueListing()
  }
  const payload = await response.json() as ClaudeBootstrapDocument
  // The same document that supplements the catalogue carries the client data the request
  // header is drawn from, so one read serves both. A read that discloses nothing usable
  // clears the candidate: only a span that has not frozen yet can be affected, and it must
  // not inherit a token from an earlier read.
  if (claimed !== undefined && capture !== undefined) {
    await capture.commitCapture(claimed, (payload.client_data as { atis?: unknown } | null | undefined)?.atis)
  }
  const options = payload.additional_model_options
  if (!Array.isArray(options)) return claudeCatalogueListing()
  return claudeCatalogueListing(options)
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

/**
 * One account attempt the maintenance seam observes.
 *
 * The signal is the caller's own cancellation, never this adapter's idle watchdog: a
 * consumer binding a live session to a user stop must not be handed a synthetic abort that
 * means something else.
 */
export interface ClaudeAccountAttempt {
  /** Canonical account key this attempt routes to. */
  readonly account: string
  /**
   * The harness session id this attempt belongs to, when the caller supplied one.
   *
   * Absent means the request carries no session identity at all, so a consumer must not
   * create a permanent binding for it: there is no session a stop could later release.
   */
  readonly sessionId?: string
  /** The credentials in force when the attempt starts. */
  readonly session: ClaudeSession
  /**
   * The caller's own cancellation, or absent when the caller supplied none.
   *
   * Absent is a statement, not a missing value: no user stop can be observed for this attempt,
   * so a consumer must not infer one from anything this adapter does.
   */
  readonly signal?: AbortSignal
}

/** How one account attempt ended, for the maintenance seam's diagnostics. */
export interface ClaudeAccountOutcome extends ClaudeAccountAttempt {
  /** Terminal shape of the attempt: a finished stream, a failure, or the caller's cancel. */
  readonly status: 'completed' | 'failed' | 'cancelled'
  /** Whether any chunk for this logical request reached the Host. */
  readonly delivered: boolean
  /** The failure the attempt ended on, when it failed. */
  readonly error?: LlmError
  /** The ordered decision behind {@link error}, when this adapter classified it. */
  readonly failure?: ClaudeFailureDecision
}

/**
 * The per-account maintenance seam.
 *
 * The maintenance module owns the schedule and the account state; this adapter only reports
 * the points it already passes through. Attempt end is not session release: a stream that
 * finishes normally still leaves its session able to send the next prompt, so nothing here
 * tells the consumer to release a binding. The session owner does that on session stop,
 * account unbind, logout and plugin disposal.
 */
export interface ClaudeMaintenanceHooks {
  /**
   * Runs before the account's first wire request and again before the replayed request that
   * follows an authentication refresh.
   *
   * It is the note-that-this-session-is-live point and the place a policy block is enforced:
   * throwing refuses the request before it is sent and carries the hard stop.
   * @param attempt - the account, its session identity and the credentials in force.
   * @returns replacement credentials for this attempt, or nothing to keep them.
   */
  beforeAccountRequest?(attempt: ClaudeAccountAttempt): ClaudeSession | void | Promise<ClaudeSession | void>
  /** Runs once when the attempt reaches its terminal shape, before the terminal signal. */
  onAttemptResult?(outcome: ClaudeAccountOutcome): void | Promise<void>
  /** Runs once after the attempt's resources are released. */
  onAttemptEnd?(outcome: ClaudeAccountOutcome): void | Promise<void>
}

/** Constructor dependencies for {@link ClaudeAdapter}. */
interface ClaudeAdapterOptions {
  /**
   * Trusted policy for one account and session, projected by the host.
   *
   * Synchronous on purpose: the request path reads it while assembling, so it must answer from
   * state the host already holds. It is the only policy seam — nothing in a request body, message
   * metadata or transport option can withhold a beta.
   * @param input - the canonical account the stream owns, and the session the request belongs to.
   * @returns the policy to apply to this request.
   */
  requestPolicy?: (input: { account: string; sessionId?: string }) => ClaudeEnginePolicy
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
  /** Stable hashed OS identity supplier; defaults to this host, never a request/model input. */
  deviceFingerprint?: () => string
  onWarn?: (message: string) => void
  /** How long this route may hold a turn open waiting for a rate-limit window; defaults to waiting on, six-hour ceiling. */
  rateLimit?: RateLimitWait
  /** Resolve the attachment service per request; absent means image requests fail loudly. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Durable per-account catalogue store seeding capability metadata across restarts. */
  catalogStore?: CatalogStoreFactory
  /** How long a stored catalogue is trusted before an explicit refresh may replace it; defaults to 24 h. */
  catalogMaxAgeMs?: number
  /** Failure cooldown for a catalogue request that sent no retry-after; defaults to 60 s. */
  cacheRetryDelayMs?: number
  /** Called once after a refresh stored a catalogue different from the previous one. */
  onCatalogChanged?: (provider: string) => void
  /**
   * Resolves the sink for the unified rate-limit state an account's own answered
   * response carried, once per stream and before the request is sent, so the sink
   * captures the auth epoch that request starts under. The pool observes pass
   * savings here instead of polling a usage endpoint; absent means nothing is
   * reported.
   */
  usageObserverFor?: (account: string) => (state: UnifiedRateLimitState) => void
  /**
   * Per-model default reasoning effort override (the Settings page's picker).
   * Returns the user-configured default for one model, or undefined to follow
   * the provider's own default.
   */
  defaultEffortOf?: (model: string) => string | undefined
  /**
   * Per-model speed lookup (the composer Speed toggle's host half). Returns
   * whether this model's stored configuration selects the fast tier; absent
   * means every request stays on standard routing. This adapter applies the
   * tier only where the pinned catalogue advertises `fast_mode`, so a stored
   * `fast` on a model without it keeps standard routing.
   */
  speedFor?: (model: string) => boolean | Promise<boolean>
  /** Live-session maintenance seam; absent leaves the adapter's behavior unchanged. */
  maintenance?: ClaudeMaintenanceHooks
  /**
   * Durable record of a refused compatibility profile; absent uses this plugin's own home
   * directory. Injectable so a test never touches the real one.
   */
  protocolBlocks?: ClaudeProtocolBlockStore
  /** The compatibility profile this route runs; absent uses the pinned one. */
  protocolProfile?: ClaudeProtocolProfile
  /**
   * Recording port for prepared Messages requests. Absent refuses every POST with
   * `REQUEST_RECORD_UNAVAILABLE`: a route that cannot publish the request it is about to issue
   * must not issue it. The plugin composition always supplies one.
   */
  requestRecord?: ClaudeRequestRecordPort
  /**
   * The durable continuation owner: the wire identity, the ATIS pin and the identity generation
   * every request is prepared under. Absent refuses every request with
   * `LOCAL_CONTINUATION_STATE_UNAVAILABLE`: a route that cannot commit the wire identity a
   * conversation declares must not invent one, and the plugin composition always supplies this.
   */
  continuation?: ClaudeContinuationState
  /**
   * The plugin's startup hydration, read inside each request's state budget after it settled. A
   * registration may run before that hydration finishes, and the first legitimate request must not
   * succeed merely by winning that race; the request also must not wait for it unboundedly.
   */
  continuationReady?: Promise<ClaudeContinuationReadiness>
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

/**
 * The port a route without a Host recorder holds.
 *
 * An unbound port refuses every request rather than sending unrecorded — the same disposition as
 * an unflushed record — so an adapter constructed outside a recording composition cannot reach
 * the wire. It is the port's own value, not a substitute object: the port owns the binding state
 * that decides those refusals.
 */
const UNBOUND_REQUEST_RECORD = new ClaudeRequestRecordPort()

/** Claude wire adapter: one instance serves the `claude` provider route. */
/** Sessions whose request clock is kept; the client bounds its own table the same way. */
const REQUEST_CLOCK_LIMIT = 64

export class ClaudeAdapter extends PoolBackedAdapter {
  protected readonly catalogs: ProviderCatalog
  /** The frozen compatibility profile this route builds every request from. */
  private readonly protocolProfile: ClaudeProtocolProfile
  /** Durable record of a refused compatibility profile. */
  private readonly protocolBlocks: ClaudeProtocolBlockStore

  constructor(private readonly options: ClaudeAdapterOptions) {
    super(options)
    this.protocolProfile = options.protocolProfile ?? CLAUDE_PROTOCOL_PROFILE
    this.protocolBlocks = options.protocolBlocks ?? new ClaudeProtocolBlockStore(
      options.onWarn === undefined ? {} : { onWarn: options.onWarn },
    )
    this.catalogs = new ProviderCatalog(options, 'claude', 'claude', {
      staticRows: provider => this.staticModels(provider),
      fetchCatalog: (account, signal) => this.fetchCatalog(account, signal),
      row: (provider, model) => this.listed(provider, model),
    })
  }

  private async fetchCatalog(account?: string, signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const session = await this.options.tokens.session(account)
    return fetchClaudeCatalogue(
      session,
      Object.entries(desktopClientHeaders()),
      this.options.fetchFn,
      signal,
      account,
      undefined,
      // The same read discloses this account's ATIS candidate, so it claims and commits that
      // candidate under the durable owner rather than in a process-local map.
      this.options.continuation,
    )
  }

  /**
   * Drop this account's cached catalogue, memory and disk, after login/logout or
   * an identity change — and the account's uploaded Files API ids with them:
   * those ids belong to the token that uploaded them, which a login change replaces.
   *
   * The pins and spans are deliberately not dropped here: the identity transition owns them and
   * drops this account's spans inside the same change that commits the new credential, so clearing
   * them from a post-change notification would be a second owner racing the first.
   * @param account - the account whose cached state is dropped, or every account when omitted.
   */
  clearAccountCatalog(account?: string): void {
    this.catalogs.clearAccountCatalog(account)
    clearClaudeFileIds(account)
  }

  /** The known entry for one model, from the account caches only (never a request). */
  private async discovered(model: string): Promise<DiscoveredModel | undefined> {
    if (!this.options.discovery) return undefined
    return await this.catalogs.findModel(model)
  }

  /**
   * The rows a read falls back to while no account catalogue is known.
   *
   * With discovery on, that fallback is the client's own baked-in catalogue —
   * the same table a refused options read already degrades to — so a cold menu
   * offers every pinned model, its 1M variants included, instead of only the
   * configured shortlist. An explicit configuration (discovery off) is the
   * operator's decision and is listed as given.
   */
  private staticModels(provider: string): LlmModelInfo[] {
    if (this.options.discovery) {
      return claudeCatalogueListing().map(model => this.listed(provider, model))
    }
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

  /**
   * Whether the pinned catalogue marks this model fast-capable.
   *
   * `fast_mode` is the capability the client's own fast-mode gate reads, so a model without it
   * never receives the tier however the session's toggle is set.
   * @param model - the requested model id.
   * @returns true when the model's catalogue entry carries `fast_mode`.
   */
  supportsFastTier(model: string): boolean {
    return claudeCatalogueEntry(model)?.capabilities.includes('fast_mode') === true
  }

  /**
   * Ids of every catalogued model carrying `fast_mode` (the Speed toggle's visibility list).
   *
   * The capability belongs to the pinned catalogue rather than to an account, so the list is the
   * same for every account and needs no discovery read. Logged out, no session can select one of
   * these models and the list is empty, which is how the control hides with the models.
   * @returns the fast-capable model ids.
   */
  async fastCapableModels(): Promise<string[]> {
    if ((await this.options.tokens.list()).length === 0) return []
    return claudeCatalogueListing()
      .filter(model => model.fastTier === true)
      .map(model => model.id)
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
    // The effort levels come from the pinned catalogue rather than from discovery: the profile
    // is compiled in, so the picker offers what the model accepts even while a catalog read is
    // unavailable, and a configured default merges over the same set the request path gates on.
    const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), claudeReasoning(model))
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

  /**
   * Refuse a request whose compatibility profile is already blocked.
   *
   * The check precedes request assembly: a profile the service refused must not send one
   * request per retry click, and the failure names the protocol rather than the account.
   * @param profile - the frozen profile this request would use.
   * @throws LlmError carrying the protocol block's hard stop.
   */
  private async assertProfileUsable(profile: ClaudeProtocolProfile): Promise<void> {
    const blocked = await this.protocolBlocks.isBlocked({
      provider: 'claude',
      origin: profile.origin,
      fingerprint: profile.fingerprint,
    })
    if (!blocked) return
    throw claudeFailureError(
      claudeProtocolBlockDecision(profile),
      `claude compatibility profile ${profile.id} is refused by ${profile.origin};`
      + ' update the plugin instead of retrying',
    )
  }

  /**
   * Run the maintenance seam's pre-request hook.
   *
   * A failure to check a precondition stops the request: the hook is where a policy block
   * is enforced, so swallowing its failure as a warning would let an unchecked request onto
   * the wire. The resulting failure always carries the hard stop.
   * @param attempt - the account, session identity and credentials.
   * @returns the credentials the hook wants used, or undefined to keep them.
   */
  private async runBeforeAccountRequest(attempt: ClaudeAccountAttempt): Promise<ClaudeSession | undefined> {
    const hook = this.options.maintenance?.beforeAccountRequest
    if (hook === undefined) return undefined
    try {
      return await hook(attempt) ?? undefined
    } catch (error: unknown) {
      throw claudeBlockedRequest(error, `claude maintenance refused the request for ${attempt.account}`)
    }
  }

  /**
   * Run one attempt-level maintenance hook, reporting a failure without replacing the
   * attempt's own terminal outcome.
   * @param hook - the hook to run.
   * @param outcome - the attempt's terminal shape.
   * @param label - the hook's name, for the diagnostic.
   */
  private async runAttemptHook(
    hook: ((outcome: ClaudeAccountOutcome) => void | Promise<void>) | undefined,
    outcome: ClaudeAccountOutcome,
    label: string,
  ): Promise<void> {
    if (hook === undefined) return
    try {
      await hook(outcome)
    } catch (error: unknown) {
      this.options.onWarn?.(
        `claude maintenance ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  protected async *streamOwn(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    // The profile is frozen for this logical request, so an in-flight retry keeps the profile
    // it was decided under even if configuration changes underneath.
    const profile = this.protocolProfile
    let delivered = false
    let attempt: ClaudeAccountAttempt | undefined
    let ended: LlmError | undefined
    let cancelled = false
    // True while a POST is in flight with no response yet, and read by the failure projection
    // below: a failure in that window is an ambiguous send, a failure before it is request
    // assembly with its own rule, and once a response has arrived the stream rules decide.
    let sendOutstanding = false
    // The profile blocks this attempt must record. Recall is idempotent per identity — the store
    // keys a record by provider, origin and fingerprint — and this keeps one logical request from
    // writing the same block twice when both the response sink and the terminal path see it.
    const blockedIdentities = new Set<string>()
    let durability: Promise<void> = Promise.resolve()
    const recordBlock = (decision: ClaudeFailureDecision): void => {
      if (decision.scope !== 'provider-profile') return
      const identity = `${decision.origin}\n${decision.protocolFingerprint}`
      if (blockedIdentities.has(identity)) return
      blockedIdentities.add(identity)
      durability = this.recordProtocolBlock(decision)
    }
    try {
      // The record of a prepared request identifies its session through the log that receives
      // it, so a request with no session has nowhere to be recorded. Refusing here — before the
      // account chain, the profile check, any credential read and any Files upload — keeps that
      // failure at zero side effects rather than merely at zero bytes.
      if (options.sessionId === undefined) {
        throw new LlmError(
          'claude request refused: GenerateOptions.sessionId is required because every prepared Messages request is recorded in its session log',
          CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED,
          { retryDisposition: 'forbid' },
        )
      }
      // Credential selection, identity backfill and request chaining share one account
      // throughout the request, including its 401 replay. A changing default cannot
      // move only one of them onto another account.
      const harnessSessionId = String(options.sessionId)
      const chainAccount = await this.chainAccount(account)
      if (chainAccount === '') throw new LlmError('No Claude account is signed in', 'MISSING_CREDENTIAL')
      // Capture the auth epoch before fetching so a response outliving logout cannot
      // report into a replacement account's usage state.
      const observeUsage = this.options.usageObserverFor?.(chainAccount)
      // The durable identity is prepared before anything that could reach the network — the
      // credential read, the maintenance read and every upload come after it — and the whole chain
      // shares one absolute budget, so no later step starts a fresh clock. A route with no owner
      // refuses here rather than minting an identity of its own.
      const state = this.options.continuation
      if (state === undefined) {
        throw new LlmError(
          'claude request refused: the continuation state owner is not wired, so this route cannot commit the wire identity a conversation declares',
          LOCAL_CONTINUATION_STATE_UNAVAILABLE,
          { retryDisposition: 'forbid' },
        )
      }
      // This request's cumulative budget for waiting on local durable state and on the auth
      // transition. Only the state phases are charged to it — the startup hydration, the identity
      // resolve, the span preparation, the post-maintenance check and the pin freeze — while the
      // network stages between them keep their existing budgets (the profile check, the credential
      // read, maintenance and the upload). The spent amount is measured per state phase, so a slow
      // network step cannot consume this budget and turn into a false refusal.
      let stateSpentMs = 0
      const stateBudget = (): ContinuationDeadline =>
        continuationBudget(Math.max(0, state.deadlineMs - stateSpentMs), options.signal)
      const chargeState = async <T>(phase: () => Promise<T>): Promise<T> => {
        const startedAt = Date.now()
        try {
          return await phase()
        } finally {
          stateSpentMs += Date.now() - startedAt
        }
      }
      const firstState = stateBudget()
      const initial = await chargeState(async () => {
        if (this.options.continuationReady !== undefined) {
          const readiness = await waitBounded(this.options.continuationReady, firstState, options.signal)
          if (readiness !== 'settled') {
            throw claudeContinuationRefusal(continuationUnavailable(
              readiness === 'aborted'
                ? 'the caller stopped waiting for the continuation state'
                : 'the continuation state did not settle within the deadline',
            ))
          }
          // The settled result is read, never a flag sampled while the work was still running: a
          // hydration that failed afterwards must refuse this request rather than hand it an owner.
          const settled = await this.options.continuationReady
          if (settled.kind === 'failed') throw claudeContinuationRefusal(continuationUnavailable(settled.reason))
        }
        const resolved = await state.resolveIdentity(chainAccount, firstState)
        if (!('accountRef' in resolved)) return resolved
        const restored = restoredWireSessionId(options.messages, resolved, harnessSessionId)
        return await state.prepareRequest({
          account: chainAccount,
          harnessSessionId,
          origin: state.originFor(state.requestHeaderReason(harnessSessionId)),
          ...restored === undefined ? {} : { restored: { wireSessionId: restored } },
          identity: resolved,
          deadline: firstState,
        })
      })
      if (initial.kind !== 'ready') throw claudeContinuationRefusal(initial)
      const prepared = initial
      // The compatibility profile is checked before anything that could reach the network for
      // this request: a profile the service already refused must not even refresh a credential,
      // resolve an asset or wake maintenance on its way to the wire.
      await this.assertProfileUsable(profile)
      let session = await this.options.tokens.session(chainAccount)
      const bound: ClaudeAccountAttempt = {
        account: chainAccount,
        // Absent when the caller supplied none: a consumer must not create a permanent
        // binding for a request no session stop could ever release.
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        session,
        // The caller's own signal, and nothing when there is none: a consumer binding a live
        // session to a user stop must not read this adapter's watchdog abort as one.
        ...options.signal === undefined ? {} : { signal: options.signal },
      }
      attempt = bound
      session = await this.runBeforeAccountRequest(bound) ?? session
      if (session !== bound.session) attempt = { ...bound, session }
      // The maintenance read that discloses this span's candidate has settled, so the pin is
      // decided now — before any upload or assembly — out of what remains of this request's state
      // budget, which the epoch check and the freeze share instead of each resetting a fresh clock.
      const postState = stateBudget()
      if (postState.expiresAt <= Date.now()) {
        throw claudeContinuationRefusal(continuationUnavailable('this request\'s continuation-state budget is spent'))
      }
      const frozen = await chargeState(async () => {
        const stale = await state.assertPreparedCurrent(prepared.prepared, postState)
        if (stale !== undefined) throw claudeContinuationRefusal(stale)
        return await state.freezeRequest(prepared.prepared, postState)
      })
      if (frozen.kind !== 'frozen') throw claudeContinuationRefusal(frozen)
      const continuation: ClaudeRequestContinuation = {
        account: chainAccount,
        prepared: prepared.prepared,
        pin: frozen.pin,
      }
      // Set the moment a POST is issued: a failure after that is an ambiguous send, while a
      // failure before it is request assembly and keeps its own rule.
      const onSend = (): void => { sendOutstanding = true }
      let response = await this.request(options, chainAccount, session, continuation, watchdog, onSend)
      // A response arrived, so the send is no longer outstanding: everything from here is decided
      // by the response and the stream, not by the ambiguity of an unanswered POST.
      sendOutstanding = false
      let replayed = false
      // A structured refusal outranks any authentication recovery, whatever status carried it,
      // so a 401's body is read under the byte cap before the refresh decision. It is consumed
      // exactly once here and the response released immediately: the replay below never
      // re-reads it, and an oversized body is never drained.
      if (response.status === 401) {
        const rejected = await claudeHttpLlmError(response, {
          label: 'claude API',
          profile,
          rateLimitReset: claudeRateLimitReset,
          retryHeaderReset: claudeRetryHeaderReset,
          ...this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn },
          body: await readClaudeErrorBody(response),
          onDecision: recordBlock,
        })
        if (rejected.code !== 'AUTH') throw rejected
        await discardClaudeResponse(response)
        replayed = true
        session = await this.options.tokens.session(chainAccount, true)
        // The rotation this replay has just performed is the maintenance owner's business too.
        // The pre-request hook runs again for the replayed wire request, so a timer or a
        // credential revision is never left computed from the credential this request replaced.
        session = await this.runBeforeAccountRequest({ ...bound, session }) ?? session
        attempt = { ...bound, session }
        // The replay sends a second Messages request, so this attempt's identity is checked once more
        // against what remains of this request's state budget, before that request is built and
        // recorded. A credential rotation keeps the epoch and the pinned token; an identity change
        // that landed meanwhile, or a spent budget, refuses the replay instead of sending a second
        // request under a retired span.
        const replayState = stateBudget()
        if (replayState.expiresAt <= Date.now()) {
          throw claudeContinuationRefusal(continuationUnavailable('this request\'s continuation-state budget is spent'))
        }
        const rechecked = await chargeState(async () => {
          const stale = await state.assertPreparedCurrent(continuation.prepared, replayState)
          if (stale !== undefined) throw claudeContinuationRefusal(stale)
          return await state.freezeRequest(continuation.prepared, replayState)
        })
        if (rechecked.kind !== 'frozen') throw claudeContinuationRefusal(rechecked)
        response = await this.request(options, chainAccount, session, continuation, watchdog, onSend)
        sendOutstanding = false
      }
      // The unified rate-limit headers ride every answered Messages response, the
      // 429 included, and are the provider's own statement of this account's
      // standing. They are read before the status check so the Settings cards can
      // report a rejected or warning account without a second request.
      const rateLimit = parseUnifiedRateLimit(response.headers, Date.now())
      if (rateLimit !== undefined && chainAccount !== '') {
        rememberUnifiedRateLimit('claude', chainAccount, rateLimit)
        // The answered response is the only place this account's own standing is
        // observed, and the pool's tracker reads it from here rather than polling.
        observeUsage?.(rateLimit)
      }
      if (!response.ok) {
        const failure = await claudeHttpLlmError(response, {
          label: 'claude API',
          profile,
          rateLimitReset: claudeRateLimitReset,
          retryHeaderReset: claudeRetryHeaderReset,
          ...this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn },
          onDecision: recordBlock,
        })
        // The one authentication replay this logical request is allowed has been spent: a
        // second rejection ends the request here instead of handing the refresh cycle back to
        // the Host's unconditional retry mode.
        throw replayed && failure.code === 'AUTH' ? claudeRecoveryExhausted(failure) : failure
      }
      // The response's own request id is both the value a later request chains and the value the
      // assistant message records, so it is read once and handed to the translator with the body it
      // belongs to. The chain itself is not remembered here: the next request selects it from the
      // durable continuation the accepted response records, which is the one authority for it.
      const requestId = response.headers.get('request-id')
      if (response.body === null) {
        // An accepted response without a body has no terminal state to reach: it is the same
        // incomplete outcome as a stream that ends early, and the request has certainly been
        // sent, so it is not reported as the retryable empty-completion case.
        throw new LlmError(
          'claude API accepted the request but returned no response body',
          STREAM_INCOMPLETE_CODE,
          { retryDisposition: 'forbid' },
        )
      }
      for await (const chunk of streamAnthropic(
        response.body,
        () => { watchdog.pulse() },
        requestId ?? undefined,
        claudeStreamRefusalProbe(response),
        profile,
        {
          accountRef: continuation.prepared.accountRef,
          spanEpoch: continuation.prepared.spanEpoch,
          harnessSessionId: continuation.prepared.harnessSessionId,
          wireSessionId: continuation.prepared.wireSessionId,
        },
      )) {
        if (chunk.type === 'finish') {
          // A failed turn can arrive as a terminal value rather than a throw. It is still the
          // outcome of this attempt, so the maintenance seam must not be told the attempt
          // completed: the failure record the finish carried becomes the attempt's error, and a
          // refusal it names is recorded exactly as a thrown one is.
          if (chunk.reason.kind === 'error') {
            const failed = chunk.reason.failure
            const decision = claudeFinishDecision(failed, profile, delivered)
            recordBlock(decision)
            ended = claudeFailureError(decision, failed.message, {
              ...failed.status === undefined ? {} : { status: failed.status },
            })
          }
        } else {
          delivered = true
        }
        yield chunk
      }
    } catch (error: unknown) {
      // The classified decision travels with the error that carries it, so a refusal this
      // attempt already produced is recorded here for every path that throws — an in-band SSE
      // refusal and a terminal error finish included, not only the HTTP responses whose own sink
      // saw it.
      if (error instanceof LlmError) {
        const decision = claudeFailureDecisionOf(error)
        if (decision !== undefined) recordBlock(decision)
      }
      const mapped = mapFetchFailure('claude API', error, watchdog, options.signal)
      cancelled = mapped.code === 'ABORTED'
      // A failure after the POST left this process stays ambiguous even when a transport
      // classifier re-wraps it, because the disposition belongs to the send and not to the
      // wrapper: the server may have accepted and acted on a request this process can no longer
      // see. The caller's own cancel is not an ambiguity claim, and a failure raised before the
      // POST was issued keeps whatever specific rule it already carried.
      const projected = sendOutstanding && mapped.code !== 'ABORTED' ? claudeAmbiguousSend(mapped) : mapped
      // The first chunk the Host received commits this attempt; a failure after it may not be
      // replayed, which is why the delivery boundary travels with the failure.
      ended = claudeStreamFailure(projected, { profile, outputDelivered: delivered })
      throw ended
    } finally {
      watchdog.stop()
      // A recorded block is awaited before this attempt's outcome is observable, so a caller that
      // retries immediately meets the durable record rather than a write still in flight. A write
      // that failed has already left its block in memory, which still stops this process.
      await durability
      if (attempt !== undefined) {
        const decision = ended === undefined ? undefined : claudeFailureDecisionOf(ended)
        const outcome: ClaudeAccountOutcome = {
          ...attempt,
          status: cancelled ? 'cancelled' : ended === undefined ? 'completed' : 'failed',
          delivered,
          ...ended === undefined ? {} : { error: ended },
          ...decision === undefined ? {} : { failure: decision },
        }
        const hooks = this.options.maintenance
        await this.runAttemptHook(hooks?.onAttemptResult, outcome, 'onAttemptResult')
        await this.runAttemptHook(hooks?.onAttemptEnd, outcome, 'onAttemptEnd')
      }
    }
  }

  /**
   * Record a refusal that is evidence about the compatibility profile rather than the
   * account, so every later request on this host stops before the wire.
   *
   * The block is published in memory before the write is attempted, so a failed write still
   * stops this process; the returned promise settles once durability is known, so a caller can
   * wait for it before exposing an outcome a retry would race.
   * @param decision - the ordered decision the failed response produced.
   * @returns completion of the record, whether or not it reached disk.
   */
  private async recordProtocolBlock(decision: ClaudeFailureDecision): Promise<void> {
    if (decision.scope !== 'provider-profile') return
    try {
      const write = await this.protocolBlocks.block({
        provider: 'claude',
        origin: decision.origin,
        fingerprint: decision.protocolFingerprint,
        reason: decision.reason,
        ...decision.serverCode === undefined ? {} : { serverCode: decision.serverCode },
      })
      // A block that did not reach durable storage still holds for this process, and saying so
      // is not the same as reporting a successful write: a restart would lose it.
      if (!write.persisted) {
        this.options.onWarn?.('claude protocol block holds for this process only; it could not be persisted')
      }
    } catch (error: unknown) {
      // The store reports its own write failures; this catch is for a programming error in the
      // record itself, which must not replace the failure the caller is about to see.
      this.options.onWarn?.(
        `claude protocol block could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private thinkingParam(model: string, thinkingType: 'enabled' | 'adaptive' | undefined, maxTokens: number): ClaudeWireThinking | undefined {
    return claudeThinkingBody(model, thinkingType, maxTokens)
  }

  /**
   * Resolve the account UUID and bind its device id to this OS installation.
   * Missing UUIDs use the OAuth profile. Legacy or copied device ids are replaced
   * by the deterministic account/device value with a conditional store write;
   * credentials remain unchanged. An unavailable identity fails before Messages.
   *
   * The profile read is itself replayed after a rejection, and that replay rotates the
   * credential: the refreshed session is both the one the request continues from and the
   * one the backfill is derived from. The write names it as its expected prior, so a
   * concurrent refresh, re-login or logout wins the race instead of having its rotation
   * rolled back. That winner is re-read and served; a winner that cannot be shown to be
   * the account this profile was read for fails the request rather than receiving another
   * account's identity.
   *
   * A read-only account's served credential comes from Claude Code's own store, so it is not
   * what the record holds and cannot be the conditional write's prior. That account's backfill is
   * conditional on the record instead, while every mode passes the revision read before the
   * profile read whenever the backend reports one: an ownership change, a logout or a
   * same-token re-login leaves the credential fields identical, so only the revision refuses the
   * write. A backend that reports none keeps the legacy and independent compatibility path, which
   * the read-only mode refuses to take rather than downgrade the condition.
   *
   * An ownership mode that moves at any point — before the profile read, after it, or over the
   * write itself — stops this request with a fixed identity-changed refusal: no identity is bound
   * under the new mode and no POST is sent under the mode the request started from.
   */
  private async identitySession(
    session: ClaudeSession,
    account: string | undefined,
    fetchFn: FetchFn,
    signal: AbortSignal,
  ): Promise<ClaudeSession> {
    const fingerprint = (this.options.deviceFingerprint ?? readLocalDeviceFingerprint)()
    const deviceFor = (uuid: string): string => deriveClaudeDeviceId(`uuid:${uuid}`, fingerprint)
    if (session.accountUuid !== undefined && session.deviceId === deviceFor(session.accountUuid)) return session
    // Pinned for the whole backfill: the write and the read-back address the account this
    // request was served for even when the default account moves underneath.
    const requested = account ?? await this.options.tokens.defaultAccount()
    const key = requested === undefined ? undefined : await this.options.tokens.resolveAccount(requested)
    if (key === undefined) throw claudeIdentityRacedError('the account signed out')
    // The record this write is conditional on, read BEFORE the profile read and its 401 replay.
    // Reading it afterwards would let a mode change, a logout or a same-token re-login that
    // landed in between pass for the record this request was served from: none of those writes
    // changes the token pair, so a write conditional on the credential fields alone would accept
    // them and roll the account back to the mode it had when this request started.
    const baseline = await this.options.tokens.snapshot(key)
    const baselineSession = baseline?.session ?? await this.options.tokens.peek(key)
    if (baselineSession === undefined) throw claudeIdentityRacedError('the account signed out')
    const baselineMode = claudeCredentialModeOf(baselineSession)
    if (baselineMode === 'read-only-import' && baseline === undefined) {
      // The condition below is the record's revision. A backend that cannot report one cannot
      // express it, and downgrading to the credential comparison would accept exactly the writes
      // this refuses, so the read-only identity write is refused instead.
      throw claudeIdentityUnverifiableError()
    }
    // Every mode states its ownership, and this request was served under one of them: a record
    // that already moved on must not receive this request's identity or its POST.
    if (claudeCredentialModeOf(session) !== baselineMode) throw claudeOwnershipChangedError()
    let current = session
    let profile: Pick<ClaudeSession, 'emailAddress' | 'subscriptionType' | 'accountUuid'> = {}
    if (current.accountUuid === undefined) {
      const reauthorized: { latest?: ClaudeSession } = {}
      profile = await bestEffortClaudeProfile({
        accessToken: current.accessToken,
        fetchFn,
        signal,
        // A refusal of this compatibility profile is recorded here too: the profile endpoint
        // shares the origin, so a version refusal found on it must stop Messages as well. The
        // record is awaited before the refusal propagates, so this request's failure and the
        // durable block become observable together.
        onDecision: decision => { void this.recordProtocolBlock(decision) },
        reauthorize: async () => {
          // A replay rotates the credential this request carries; it does not change which record
          // the identity write below is conditional on, which stays the baseline above.
          const latest = await this.options.tokens.session(key, true)
          reauthorized.latest = latest
          return latest.accessToken
        },
      })
      const replayed = reauthorized.latest
      if (replayed !== undefined) current = replayed
    }
    const accountUuid = current.accountUuid ?? profile.accountUuid
    if (accountUuid === undefined) {
      throw new LlmError(
        'claude account identity is unavailable (profile lookup failed); log in again via Settings → Subscriptions',
        'INVALID_REQUEST',
      )
    }
    // The credential this request was served with belongs to a store outside this plugin for a
    // read-only account, so the record is a reference rather than that credential. Either way the
    // mode must still be the one this request was served under, including after a replay.
    if (claudeCredentialModeOf(current) !== baselineMode) throw claudeOwnershipChangedError()
    // Recompute before sending: legacy account-only ids and a cache copied from another
    // machine are migrated conditionally without changing the credential or account UUID.
    const deviceId = deviceFor(accountUuid)
    const next: ClaudeSession = { ...current, accountUuid, deviceId }
    if (deviceId === current.deviceId && accountUuid === current.accountUuid) return next
    // A read-only account's served credential is the external source's current winner, so naming
    // it as the prior would refuse this account's own backfill exactly when the external holder
    // rotated; that write names the record instead. Every mode passes the revision it read before
    // the profile read whenever the backend reports one, so a write that leaves the credential
    // fields identical — an ownership change, a logout or a same-token re-login — is refused by
    // the store's own condition. A backend that reports none keeps the compatibility path, which
    // only the read-only mode refuses to take.
    await this.options.tokens.persist(
      key,
      next,
      baselineMode === 'read-only-import' ? baselineSession : current,
      baseline?.revision,
    )
    const written = await this.options.tokens.snapshot(key)
    const winner = written?.session ?? await this.options.tokens.peek(key)
    if (winner === undefined) throw claudeIdentityRacedError('the account signed out')
    if (claudeCredentialModeOf(winner) !== baselineMode) {
      // The account's ownership moved while its identity was being read. This request was served
      // under another mode, so it stops instead of binding an identity under the new one or
      // sending a POST under the mode the user has left; the next request prepares from whatever
      // the account now states.
      throw claudeOwnershipChangedError()
    }
    if (winner.accountUuid === accountUuid && winner.deviceId === deviceId
      && (baseline === undefined || written?.revision !== baseline.revision)) {
      // This write landed: the store holds the identity it carried.
      return winner
    }
    // The write did not land, or something else wrote first. Use the winner only for the same
    // account; device binding on this request still belongs to the local OS installation. A
    // read-only account whose backfill could not land keeps the external winner it was served
    // with — the record is a reference, not a credential that mode may fall back to.
    if (!sameClaudeAccount(winner, next)) throw claudeIdentityRacedError('the account was replaced')
    if (baselineMode === 'read-only-import') {
      const servedUuid = winner.accountUuid ?? accountUuid
      return { ...current, accountUuid: servedUuid, deviceId: deviceFor(servedUuid) }
    }
    const winnerUuid = winner.accountUuid ?? accountUuid
    return { ...winner, accountUuid: winnerUuid, deviceId: deviceFor(winnerUuid) }
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

  /**
   * Build and issue one Messages request.
   * @param options - the request being served.
   * @param account - the account the identity read addresses.
   * @param session - the credentials this request carries.
   * @param sessionId - the wire session identity.
   * @param chainAccount - the canonical account key owning the request chain.
   * @param watchdog - the attempt's idle watchdog; its signal bounds the send.
   * @param onSend - called once, immediately before the POST is issued.
   * @returns the provider's response.
   */
  /**
   * The earlier turn's request id the retained history states for this span.
   *
   * The selector is the only authority: it walks the final retained messages this request was built
   * from, gates each row on this prepared span and on the row's own envelope, and returns the id the
   * client would have chained. A row whose id is unusable ends the walk without backtracking, a row
   * from another account, generation or wire session is skipped, and the model a row was served for
   * does not filter the chain.
   * @param messages - the retained history the request was built from.
   * @param prepared - the identity facts this attempt was prepared under.
   * @returns the request id to chain, or undefined when the history states none.
   */
  private previousRequestId(
    messages: readonly ContinuationMessage[],
    prepared: ClaudeContinuationPrepared,
  ): string | undefined {
    const selection = selectClaudeContinuation(messages, {
      accountRef: prepared.accountRef,
      spanEpoch: prepared.spanEpoch,
      harnessSessionId: prepared.harnessSessionId,
      wireSessionId: prepared.wireSessionId,
    })
    return selection.kind === 'selected' ? selection.requestId : undefined
  }

  private async request(
    options: GenerateOptions,
    account: string | undefined,
    session: ClaudeSession,
    continuation: ClaudeRequestContinuation,
    watchdog: ReturnType<typeof idleWatchdog>,
    onSend: () => void,
  ): Promise<Response> {
    const signal = watchdog.signal
    const sessionId = continuation.prepared.wireSessionId
    const chainAccount = continuation.account
    // The Messages request is the one this transport reproduces; token and usage
    // calls keep the existing client.
    const fetchFn = this.options.fetchFn ?? claudeApiFetch
    const disc = await this.discovered(options.model)
    const contextWindow = disc?.contextWindow
      ?? this.options.models.find(entry => entry.id === options.model)?.contextWindow
      ?? claudeModelLimits(options.model).contextWindow
    const resolved = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal, claudeImagePolicy(contextWindow))
    // The identity read replays a rejected profile request and that replay rotates the
    // credential, so it runs before the upload: an oversized image must be uploaded under
    // the token this request will actually carry, not the one it started from.
    const identitySession = await this.identitySession(session, account, fetchFn, signal)
    const messages = await bindClaudeFileIds(
      resolved, chainAccount, identitySession.accessToken, fetchFn, signal,
      decision => { this.recordProtocolBlock(decision) },
    )
    const maxTokens = options.maxTokens
      ?? claudeMaxTokens(this.options.models.find(entry => entry.id === options.model), disc, options.model)
    // Both request controls come from the pinned catalogue, so the shape and the level a
    // request carries are the model's own facts rather than whatever discovery last saw.
    const thinking = this.thinkingParam(options.model, claudeThinkingType(options.model), maxTokens)
    const effort = claudeRequestedEffort(options.model, options.reasoningEffort)
    // A stored fast tier reaches the wire only for a model whose catalogue
    // entry carries `fast_mode`; otherwise the field and its beta stay absent
    // and the request keeps standard routing.
    const fast = await this.options.speedFor?.(options.model) === true
      && this.supportsFastTier(options.model)
    // The policy is read while assembling, from the canonical chain account the stream owns —
    // never from a caller-supplied account string.
    const requestPolicy = this.options.requestPolicy?.({ account: chainAccount, sessionId })
    // A mid-conversation system message cannot be expressed while the mid-conversation betas are
    // withheld, and degrading it into a top-level prompt would send a request the caller did not
    // ask for. The shape is refused here, before anything is uploaded or POSTed.
    if (requestPolicy?.suppressMidConversationSystem === true) {
      assertPolicyRequestShape(messages, options.model)
    }
    let built: BuiltClaudeCodeRequest
    try {
      const contextManagement = planContextManagement({
        hasThinking: thinking !== undefined,
        idleBeforeRequestMs: this.idleBeforeRequest(sessionId),
        messages,
      })
      // Every continuation fact is explicit: the wire session this span committed, the pin it
      // froze, and the id the retained history's selector chose. The builder decides none of them.
      const wire: ClaudeWireContinuation = {
        sessionId,
        atisPin: continuation.pin.kind === 'token' ? continuation.pin.token : undefined,
        previousRequestId: this.previousRequestId(options.messages, continuation.prepared),
      }
      built = await buildClaudeWireRequest(
        options, identitySession, messages, maxTokens, thinking, effort, wire, chainAccount,
        this.options.identityLine, contextManagement, fast, requestPolicy,
      )
    } catch (error: unknown) {
      const mapped = mapClaudeWireError(error, messages)
      if (mapped !== undefined) throw mapped
      throw error
    }
    assertClaudeRequestBytes(built.body, messages)
    // The prepared record enters this session's log before anything is sent, and only a
    // durability-checked record may be sent. The system list comes from the ONE parse of the
    // exact serialized body this attempt is about to POST, so the record states what the wire
    // carries rather than what an earlier assembly intended.
    const outcome = await (this.options.requestRecord ?? UNBOUND_REQUEST_RECORD).record(
      options.sessionId,
      {
        provider: 'claude',
        model: options.model,
        purpose: options.purpose ?? 'conversation',
        systemBlocks: extractClaudeSystemBlocks(built.body),
        wireLibrary: CLAUDE_WIRE_RECORD_LIBRARY,
        profile: built.evidence.profileId,
      },
    )
    if (!outcome.ok) {
      throw new LlmError(
        `claude request refused: the prepared request was not recorded (${outcome.code})`,
        outcome.code,
        { retryDisposition: 'forbid' },
      )
    }
    // Everything above is local assembly and keeps its own specific rule. From here the request
    // body is on its way out, so the caller records that the POST was issued: a failure after
    // this point is an ambiguous send rather than a proven-safe repeat.
    onSend()
    return await fetchFn(built.url, {
      method: built.method,
      headers: Object.fromEntries(built.headers),
      body: built.body,
      signal,
    })
  }
}
