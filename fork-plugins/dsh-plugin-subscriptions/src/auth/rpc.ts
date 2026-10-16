/**
 * The `subscriptions-auth` host RPC endpoints the web Settings page drives.
 * They are mounted as exact POST Fetch routes on the shared `/api` channel
 * (`/api/subscriptions-auth.<endpoint>`) and registered only when a host
 * `connection` service exists (the web profile); headless compositions load
 * the plugin without it. All business outcomes are returned as RpcResult
 * values; handlers never throw.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { RpcResult } from '../compat.js'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { PROVIDER_IDS, type ProviderId } from './store.js'
import { CLAUDE_CREDENTIAL_MODES, isClaudeCredentialMode } from './claude-credential-ownership.js'
import type { ClaudeCredentialMode } from './claude-credential-ownership.js'
import type { SpeedTier } from '../model-defaults.js'
import type { ProviderUsage, ResetCreditConsumeResult, ResetCreditList } from '../providers/common.js'
import type { ProxyConfigView, ProxyDraft, ProxyInput, ProxyTestResult } from '../http.js'
import type { ControlRequirements } from '../claude-core/control-requirements.js'

/**
 * Endpoint-name prefix under the shared `/api` channel: endpoint `status`
 * is served at `/api/subscriptions-auth.status`. The browser half calls
 * `rpc.call('/api', 'subscriptions-auth.status', payload)`.
 */
export const SUBSCRIPTIONS_AUTH_PREFIX = 'subscriptions-auth.'

/**
 * Every endpoint {@link dispatch} answers; each gets one exact Fetch route.
 * Kept in one place so the route table and the switch cannot drift apart.
 */
const SUBSCRIPTIONS_AUTH_ENDPOINTS = [
  'providerSettings', 'setProviderSettings',
  'status', 'login', 'manual', 'cancel', 'logout', 'setDefault', 'setCredentialOwnership', 'usage',
  'resetCredits', 'consumeResetCredit',
  'image', 'video',
  'speed', 'setSpeed',
  'proxyGet', 'proxySet', 'proxyTest',
  'setModelDefault',
] as const

/** Media types the attachment store accepts (ImageMediaType). */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** Decoded image bytes returned by the `image` endpoint. */
export interface ImageBytesResult {
  mediaType: string
  dataBase64: string
}

/** Decoded video bytes returned by the `video` endpoint. */
export interface VideoBytesResult {
  mediaType: string
  dataBase64: string
}

/** Bare MP4 file names the `video` endpoint accepts (no path separators). */
const VIDEO_NAME_PATTERN = /^[\w.-]+\.mp4$/

/** One model's speed choice: standard routing or the fast (priority) tier. */
export type { SpeedTier }

/** `speed` endpoint value: one model's stored tier plus the visibility list. */
export interface SpeedState {
  /** The stored tier for the requested model (default `standard`). */
  tier: SpeedTier
  /** Fast-capable ids for the requested provider; Codex includes its independent account rows. */
  fastModels: string[]
}

/** Speed state the RPC handler delegates to (the durable per-model store). */
export interface SpeedController {
  /** Current speed state for one provider's model: its stored tier and the fast-capable models. */
  speed(provider: ProviderId, model: string): Promise<SpeedState>
  /** Store one provider's model tier; `standard` clears the stored entry. */
  setSpeed(provider: ProviderId, model: string, tier: SpeedTier): Promise<void>
}

/**
 * Fixed reason codes a credential dimension may carry. A closed set, so no
 * provider or transport text can reach the client through this field.
 */
export type CredentialCode = 'REAUTH_REQUIRED'

/**
 * Credential dimension of one account: whether the stored authorization can
 * serve a request at all. Independent of quota and protocol state. The states
 * mirror the account-maintenance owner's own closed set, so the projection
 * reports exactly what that owner decided.
 */
export interface CredentialStatus {
  state:
    /** A stored credential exists and nothing is wrong with it. */
    | 'ready'
    /** A refresh cycle is running for this account. */
    | 'refreshing'
    /** The provider permanently refused the credential; a user login is required. */
    | 'reauth_required'
    /** No credential is stored. */
    | 'missing'
    /** Expiry is unknown, so no deadline can be scheduled. */
    | 'unknown-expiry'
    /** The credential's source is externally owned, so this plugin does not renew it on a timer. */
    | 'maintenance-unsupported'
    /**
     * The credential's source is externally owned and this plugin may still refresh it and
     * write the rotation back through the pre-existing path; coordination with that external
     * holder is not proven, so the same grant may be spent twice.
     */
    | 'external-coordination-unproven'
  /** Fixed reason code; absent for a usable credential. */
  code?: CredentialCode
  /** Epoch ms the parking record expires, when the source stated one; absent means unknown. */
  until?: number
  /** Epoch ms the owner may next run its credential check. */
  nextCheckAt?: number
}

/** Fixed reason codes an availability dimension may carry. */
export type AvailabilityCode =
  | 'QUOTA_EXHAUSTED'
  | 'RATE_LIMITED'
  | 'ENFORCEMENT_REFUSAL'
  | 'PROVIDER_UNAVAILABLE'
  | 'REQUEST_TIMEOUT'
  | 'MODEL_UNAVAILABLE'
  | 'PROVIDER_ERROR'

/**
 * Availability dimension of one account: a quota window, a transient provider
 * failure, or a refusal the provider aimed at this identity. Never merged with
 * the credential dimension, so "sign-in expired" cannot render as a cooldown.
 */
export interface AvailabilityStatus {
  /** `refused` is a stated refusal, which is not a waitable cooldown. */
  state: 'available' | 'cooling' | 'transient' | 'refused'
  /** Fixed reason code; absent for `available`. */
  code?: AvailabilityCode
  /** Epoch ms the parking record expires; absent means the recovery time is unknown. */
  until?: number
}

/** Fixed reason codes a protocol dimension may carry. */
export type ProtocolCode = 'CLIENT_VERSION_UNSUPPORTED' | 'UNSUPPORTED_RESPONSE'

/**
 * Protocol-compatibility dimension of the account's frozen wire profile. A
 * version refusal is not cleared by a re-login or a quota reset.
 */
export interface ProtocolStatus {
  state: 'current' | 'upgrade_required' | 'unsupported_response'
  /** Fixed reason code; absent for `current`. */
  code?: ProtocolCode
  /** Protocol-configuration id/fingerprint the state belongs to. */
  profileId?: string
  /** Epoch ms the state was first observed. */
  since?: number
}

/**
 * Account-profile freshness dimension. `stale`/`unavailable` describe the
 * cached profile only and never claim the credential became invalid.
 */
export interface ProfileStatus {
  state: 'fresh' | 'stale' | 'missing' | 'unavailable'
  /** Epoch ms the retained profile was captured. */
  capturedAt?: number
  /** Whether the retained profile carries every field the current protocol requires. */
  complete?: boolean
}

/** Fixed reason codes a managed-policy dimension may carry, from its own blockers. */
export type PolicyCode = 'POLICY_UNSUPPORTED' | 'POLICY_INVALID_VALUE' | 'POLICY_CONSENT_REQUIRED'

/** The operation scope a managed-policy restriction or blocker reaches. */
export type PolicyScope = 'tool' | 'model' | 'mcp' | 'execution' | 'network' | 'unknown'

/**
 * Managed-policy dimension of one account. `blocked` is the state an
 * unsupported or unapplied restriction leaves: the operations it affects stay
 * suspended rather than silently continuing.
 */
export interface PolicyStatus {
  state: 'ineligible' | 'loading' | 'current' | 'stale' | 'unavailable' | 'consent-required' | 'blocked'
  /** Fixed code of the first blocker; absent while no restriction blocks an operation. */
  code?: PolicyCode
  /** The operations or models the state applies to; absent means the whole account. */
  scope?: PolicyScope
  /** Epoch ms the retained policy snapshot was fetched. */
  fetchedAt?: number
}

/** Fixed reason codes a Claude policy-limits dimension may carry. */
export type PolicyLimitsCode =
  /** The read could not use the stored credential. Whether that credential is still valid is the credential dimension's fact, not this one. */
  | 'CREDENTIAL_UNAVAILABLE'
  /** The provider refused the credential for this read. */
  | 'AUTH_REJECTED'
  /** The read failed at the transport or status level. */
  | 'REQUEST_FAILED'
  /** The response did not satisfy the pinned `policy_limits` envelope. */
  | 'PARSE_FAILED'
  /** This plugin's own response-size bound stopped the read; the provider stated no restriction. */
  | 'RESPONSE_OVER_LIMIT'

/**
 * Fixed blocker codes a policy-limits dimension may carry, the owner's own
 * closed set. While any is in force every verdict is refused, so a restriction
 * this build could not re-state never leaves an operation silently allowed.
 */
export type PolicyLimitsBlocker =
  /** The durable store exists but cannot be trusted; a restriction may have been lost. */
  | 'policy_limits_state_unavailable'
  /** The stored document stated restriction keys this build cannot re-state. */
  | 'policy_limits_unknown_keys'
  /** The stored document named core skills, whose names are not retained. */
  | 'policy_limits_core_skills_unstored'
  /** The stored document's taints did not all normalize, so its taint set is incomplete. */
  | 'policy_limits_lossy_taints'

/** The monitoring notice the owner holds, already normalized and bounded by the core's parse. */
export interface PolicyLimitsOwnerNotice {
  readonly text: string
  /** The url the server stated, or `null` for none. */
  readonly url: string | null
}

/**
 * The monitoring notice the client renders. Its text is displayed as text, and
 * its url is a destination the user opens deliberately: the client links it and
 * never fetches it.
 */
export interface PolicyLimitsNotice {
  /** The notice text, normalized and bounded by the core's parse. */
  text: string
  /** The notice's https url, when the server stated a usable one. */
  url?: string
}

/**
 * Claude `policy_limits` dimension of one account: whether this build holds a
 * limits document and what that document refuses. Independent of the
 * managed-settings {@link PolicyStatus} — separate documents, separate owners,
 * neither replacing the other.
 *
 * Only fixed codes, counts, booleans and the normalized notice cross to the
 * client: the adopted document, its `defaults`, its core-skill names and its
 * taint values stay on the host, counts replace the key lists, the control
 * obligations arrive as this build's own fixed tri-state, and the notice arrives
 * as its own text rather than as a document member.
 */
export interface PolicyLimitsStatus {
  /**
   * `ineligible` is an eligibility refusal, never a document that came back
   * empty; `blocked` is a restriction in force, never a quota state.
   */
  state: 'ineligible' | 'loading' | 'current' | 'stale' | 'unavailable' | 'blocked'
  /** Fixed reason code; absent when the state alone states the outcome. */
  code?: PolicyLimitsCode
  /** Fixed blockers in force; absent while the document is enforced as stated. */
  blockers?: readonly PolicyLimitsBlocker[]
  /** Epoch ms the retained document was fetched; absent when none was ever adopted. */
  fetchedAt?: number
  /** How many registered keys this build cannot enforce exactly; absent when there are none. */
  unknownCount?: number
  /** How many keys the retained document refuses; the key names themselves are not sent. */
  deniedCount?: number
  /** How many compliance taints are in force; the taint values themselves are not sent. */
  taintCount?: number
  /** How many configured capabilities this build does not provide; absent when there are none. */
  unsupportedScopeCount?: number
  /**
   * The control obligations the document in force states, when it states any. The owner's own
   * tri-state answers whether each is in force, and `unsupportedActiveControls` names the ones
   * in force that this build provides no capability for. Nothing here refuses an operation.
   */
  controlRequirements?: ControlRequirements
  /**
   * Whether a monitoring notice is in force. A notice restricts no key, so this
   * is a display fact: {@link PolicyLimitsStatus.noticeContent} carries its text
   * once this process has read it.
   */
  notice?: boolean
  /**
   * The notice's text and url, when this process read them. Absent while only
   * the notice's existence is retained, which the client states as text it has
   * not read rather than as no notice.
   */
  noticeContent?: PolicyLimitsNotice
  /**
   * What the verdicts are answered from: a document this process confirmed
   * (`live`), one kept through a failed read or restored from the durable store
   * (`stale`), or nothing at all (`none`, where the no-live-policy order
   * answers).
   */
  fallback: 'live' | 'stale' | 'none'
}

/**
 * The policy-limits owner's own status, as {@link projectPolicyLimits} reads
 * it. Only these members are consulted, so no adopted document, default value,
 * core-skill name, taint value or notice text can reach the client through this
 * path.
 */
export interface PolicyLimitsOwnerStatus {
  readonly state: PolicyLimitsStatus['state']
  /** The owner's own reason text; it never reaches the client verbatim. */
  readonly reason: string
  readonly fallback: PolicyLimitsStatus['fallback']
  readonly fetchedAt?: number
  /** Keys the live document refused; the client receives their count only. */
  readonly deniedKeys?: readonly string[]
  /** The fixed failure the last read produced, when it failed. Only its fixed sub-reason is read. */
  readonly failure?: { readonly reason?: string }
  /** The owner's blockers in force, as its own fixed codes. */
  readonly blockers?: readonly string[]
  /** Whether a monitoring notice is in force; its text arrives through the notice argument. */
  readonly notice?: boolean
  /** The compliance taints in force; the client receives their count only. */
  readonly taints?: readonly string[]
  /** Capabilities the document configures that this build does not provide; only their count is read. */
  readonly unsupportedScopes?: readonly { readonly scope: string; readonly reason: string }[]
  /** The control obligations the document in force states, when it states any. */
  readonly controlRequirements?: ControlRequirements
}

/**
 * The owner's reason vocabulary, mapped onto the codes the client localizes. A
 * reason outside this map contributes no code rather than its own text.
 */
const POLICY_LIMITS_REASON_CODES: Readonly<Record<string, PolicyLimitsCode>> = Object.freeze({
  credential_unavailable: 'CREDENTIAL_UNAVAILABLE',
  auth_failed: 'AUTH_REJECTED',
  request_failed: 'REQUEST_FAILED',
  read_failed: 'REQUEST_FAILED',
  parse_failed: 'PARSE_FAILED',
  body_over_limit: 'RESPONSE_OVER_LIMIT',
})

/** Every blocker code that may cross, in the order the owner's own union declares them. */
const POLICY_LIMITS_BLOCKERS: readonly PolicyLimitsBlocker[] = Object.freeze([
  'policy_limits_state_unavailable',
  'policy_limits_unknown_keys',
  'policy_limits_core_skills_unstored',
  'policy_limits_lossy_taints',
])

/** Map one owner reason onto its fixed code; an unmapped reason carries none. */
function policyLimitsCode(reason: string | undefined): PolicyLimitsCode | undefined {
  if (reason === undefined || !Object.hasOwn(POLICY_LIMITS_REASON_CODES, reason)) return undefined
  return POLICY_LIMITS_REASON_CODES[reason]
}

/**
 * Filter the owner's blockers down to the codes this contract carries, dropping
 * anything else rather than forwarding it as text.
 * @param reported - the blocker codes the owner reported, when it reported any.
 * @returns the carried blocker codes, empty when the owner reported none.
 */
function policyLimitsBlockers(reported: readonly string[] | undefined): readonly PolicyLimitsBlocker[] {
  return (reported ?? []).filter(
    (code): code is PolicyLimitsBlocker => (POLICY_LIMITS_BLOCKERS as readonly string[]).includes(code),
  )
}

/**
 * Project the owner's notice onto the client's copy of it.
 * @param notice - the owner's notice, when this process read one.
 * @returns the notice with an https url, or undefined when there is none to show.
 */
function policyLimitsNotice(notice: PolicyLimitsOwnerNotice | undefined): PolicyLimitsNotice | undefined {
  if (notice === undefined) return undefined
  const url = notice.url !== null && notice.url.startsWith('https://') ? notice.url : undefined
  return { text: notice.text, ...url === undefined ? {} : { url } }
}

/**
 * Project the policy-limits owner's status onto the client's dimension.
 *
 * The owner's reason is free-form text, its denied keys and taints carry remote
 * values, and a notice carries remote prose and a destination, so each is
 * mapped: a reason reaches the client only as a fixed code, a key list and a
 * taint list only as counts, and a notice only through {@link policyLimitsNotice}.
 * The control obligations cross as their own closed triple of this build's own
 * fixed values, never as the server's key names.
 * @param status - the owner's status for one account, or undefined when it holds none.
 * @param unsupported - the owner's unmapped-key gaps for that account, when it reports any.
 * @param notice - the owner's notice for that account, when its text was read.
 * @returns the projected dimension, or undefined so the client omits it instead
 *   of reporting it healthy.
 */
export function projectPolicyLimits(
  status: PolicyLimitsOwnerStatus | undefined,
  unsupported: readonly { readonly key: string; readonly reason: string }[] = [],
  notice: PolicyLimitsOwnerNotice | undefined = undefined,
): PolicyLimitsStatus | undefined {
  if (status === undefined) return undefined
  const code = policyLimitsCode(status.failure?.reason) ?? policyLimitsCode(status.reason)
  const blockers = policyLimitsBlockers(status.blockers)
  const deniedCount = status.deniedKeys?.length ?? 0
  const taintCount = status.taints?.length ?? 0
  const scopeCount = status.unsupportedScopes?.length ?? 0
  const controls = status.controlRequirements
  const controlRequirements = controls === undefined ? undefined : {
    trustedDevices: controls.trustedDevices,
    webSearchMcpIsolation: controls.webSearchMcpIsolation,
    unsupportedActiveControls: controls.unsupportedActiveControls,
  }
  const content = policyLimitsNotice(notice)
  return {
    state: status.state,
    fallback: status.fallback,
    ...code === undefined ? {} : { code },
    ...blockers.length === 0 ? {} : { blockers },
    ...status.fetchedAt === undefined ? {} : { fetchedAt: status.fetchedAt },
    ...unsupported.length === 0 ? {} : { unknownCount: unsupported.length },
    ...deniedCount === 0 ? {} : { deniedCount },
    ...taintCount === 0 ? {} : { taintCount },
    ...scopeCount === 0 ? {} : { unsupportedScopeCount: scopeCount },
    ...controlRequirements === undefined ? {} : { controlRequirements },
    ...status.notice === true ? { notice: true } : {},
    ...content === undefined ? {} : { noticeContent: content },
  }
}

/**
 * How one Claude account's credential is owned, as the Settings surface reports it.
 *
 * This is provenance and write authority only: `firstPartyOAuth` is a separate fact, and the
 * mode never decides whether an organization policy applies.
 */
export interface CredentialOwnershipStatus {
  /** The stored or inferred ownership mode. */
  mode: 'legacy-writeback' | 'read-only-import' | 'independent-oauth'
  /** Whether a store outside this plugin holds the credential. */
  external: boolean
  /**
   * Present only for `legacy-writeback`: this plugin may spend the same refresh grant the
   * external holder spends, and coordination with that holder is not proven.
   */
  coordinationUnproven?: true
}

/**
 * Every independent state one account is reported in. Each dimension is
 * computed by its own owner; a dimension whose owner has nothing to report is
 * omitted rather than defaulted to a healthy value.
 */
export interface AccountStatus {
  /** Stable account key (store identity). */
  key: string
  /** Display identity (email / login), when known. */
  account?: string
  /** Epoch milliseconds at which the stored access token expires. */
  expiresAt?: number
  /** Plan name the session carries (codex planType / claude subscriptionType), when known. */
  plan?: string
  /** Whether direct (non-pool) routes serve this account. */
  isDefault: boolean
  /** Credential dimension. Always reported: it is what the account roster itself proves. */
  credential: CredentialStatus
  /**
   * Credential ownership, reported for routes that have the concept (Claude only). Absent
   * everywhere else, where there is no mode to state.
   */
  credentialOwnership?: CredentialOwnershipStatus
  /** Quota / temporary availability; absent while nothing has parked this account. */
  availability?: AvailabilityStatus
  /** Protocol compatibility of the frozen profile; absent for routes without one. */
  protocol?: ProtocolStatus
  /** Account-profile freshness; absent for routes without profile maintenance. */
  profile?: ProfileStatus
  /** Managed policy; absent until eligibility for this account was evaluated. */
  policy?: PolicyStatus
  /** Claude policy limits; absent while no owner reports this account. */
  policyLimits?: PolicyLimitsStatus
}

/** The provider operation a recorded failure belongs to. */
export type ProviderOperation = 'login' | 'import' | 'logout' | 'status'

/**
 * Fixed code describing one recorded provider-operation failure. Closed set:
 * the client renders its own localized copy per code, so no server text is
 * stored or shown.
 */
export type ProviderFailureCode =
  | 'CANCELLED'
  | 'CREDENTIALS_UNAVAILABLE'
  | 'CREDENTIALS_REJECTED'
  | 'PROVIDER_REJECTED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN'

/** One recorded provider-operation failure, in allowlisted fields only. */
export interface ProviderOperationFailure {
  /** Fixed failure code. */
  code: ProviderFailureCode
  /** Operation the failure belongs to. */
  operation: ProviderOperation
  /** Epoch ms the failure was recorded. */
  at: number
  /** HTTP status the provider answered with, when it sent one. */
  status?: number
  /** The provider's own error code (e.g. OAuth `invalid_grant`), never a message. */
  providerCode?: string
  /** Earliest instant a retry is accepted, when the provider stated one. */
  retryAt?: number
}

/** Fixed code naming why this plugin refused to register one provider route. */
export type ProviderUnavailableCode =
  /** The Host build does not declare the failure-recovery contract the route requires. */
  | 'CLAUDE_HOST_INCOMPATIBLE'

/** Login state of one provider, as rendered by the Settings page. */
export interface ProviderStatus {
  /** Whether a login attempt is currently waiting for its code. */
  busy: boolean
  /** Logged-in accounts, default first. */
  accounts: AccountStatus[]
  /**
   * The last failed operation, shown until the next success on that provider.
   * Replaces a free-text detail line: the client localizes it from {@link ProviderFailureCode}.
   */
  lastError?: ProviderOperationFailure
  /**
   * Present when this plugin refused to register the route for this Host, so
   * the card can state why instead of showing an unexplained logged-out route.
   */
  unavailable?: ProviderUnavailableCode
}

/** How a Claude login should acquire credentials (other providers ignore it). */
export type LoginMethod = 'oauth' | 'keychain' | 'manual'

/** Proxy config operations behind the `proxyGet/proxySet/proxyTest` endpoints. */
interface ProxyConfigController {
  /** Current proxy configuration (secrets omitted). */
  get(): Promise<ProxyConfigView>
  /** Validate, persist, and apply one config. */
  set(input: ProxyInput): Promise<ProxyConfigView>
  /** Probe one destination through the draft (unsaved) or stored proxy. */
  test(payload: { url?: string; proxy?: ProxyDraft }): Promise<ProxyTestResult>
}

/** Provider and account preference operations behind providerSettings/setProviderSettings. */
interface ProviderSettingsController {
  get(provider: ProviderId, force: boolean, refresh?: boolean): Promise<unknown>
  set(provider: ProviderId, settings: unknown): Promise<void>
}

export interface ModelDefaultsController {
  /** Set one model's configured default effort; undefined clears the override. */
  set(provider: ProviderId, model: string, effort: string | undefined): Promise<void>
}

/** Provider-agnostic auth operations the RPC handler delegates to. */
export interface AuthController {
  /** Current status of one provider. */
  status(provider: ProviderId): Promise<ProviderStatus>
  /**
   * Start a background login attempt.
   * @param provider - the provider route.
   * @param method - Claude only: force the OAuth browser flow or the Claude
   *   Code credential import; omitted keeps the auto behavior (import when
   *   available, else OAuth).
   * @returns the authorize URL for the user's browser; device-flow providers
   *   (copilot) also return the `userCode` the user types at that URL.
   * @throws when an attempt is already running for this provider.
   */
  login(provider: ProviderId, method?: LoginMethod): Promise<{ authorizeUrl: string; userCode?: string }>
  /**
   * Feed a pasted callback URL or bare code into the pending attempt.
   * @throws when no attempt is pending or the input is unusable.
   */
  manual(provider: ProviderId, input: string): Promise<void>
  /** Abort the pending attempt; a no-op when none is pending. */
  cancel(provider: ProviderId): Promise<void>
  /** Delete one account's stored session. */
  logout(provider: ProviderId, account: string): Promise<void>
  /** Pin the account direct (non-pool) routes serve. */
  setDefault(provider: ProviderId, account: string): Promise<void>
  /**
   * Persist one Claude account's credential-ownership mode.
   *
   * The mode decides who may rotate the credential: only `legacy-writeback` may spend the
   * shared refresh grant and write back, and only `independent-oauth` runs this plugin's own
   * renewal timer. Moving between the two external modes is a setting this call may persist;
   * `independent-oauth` is not, because it means this plugin holds its own authorization, which
   * only the browser sign-in flow can produce.
   * @param riskAcknowledged - the caller's explicit statement that it showed the
   *   legacy-writeback risk and the user accepted it. Enforced by this server rather than
   *   trusted from a client, so no caller of the channel can move an account onto the
   *   grant-spending mode without stating it.
   * @throws BadRequest when the account is unknown, the requested conversion is refused, or a
   *   real conversion onto legacy-writeback arrives without the risk acknowledgement.
   */
  setCredentialOwnership(
    provider: ProviderId,
    account: string,
    mode: ClaudeCredentialMode,
    riskAcknowledged: boolean,
  ): Promise<void>
  /**
   * Local subscription usage snapshot for one account. Plain reads never query
   * the provider; missing data is reported through cache metadata, not as zero usage.
   * @param signal - caller cancellation from the RPC transport.
   * @param force - explicitly refresh even a fresh success; failure cooldown still applies.
   * @param refresh - allow a scoped refresh only if the cached data needs one.
   * @returns the retained usage and freshness metadata, or `{ supported: false }`.
   * @throws on caller cancellation or a credential failure during an explicit refresh.
   */
  usage(provider: ProviderId, account: string, signal: AbortSignal, force?: boolean, refresh?: boolean): Promise<ProviderUsage>
  /**
   * Banked ChatGPT reset credits for one account. Other providers answer
   * `{ supported: false }` and make no network call.
   * @param force - bypass a fresh cached list. A live failure cooldown still applies.
   */
  listResetCredits(provider: ProviderId, account: string, signal: AbortSignal, force?: boolean): Promise<ResetCreditList>
  /**
   * Spend one ChatGPT reset credit. The request id is the caller's idempotency
   * key and is forwarded unchanged.
   */
  consumeResetCredit(
    provider: ProviderId,
    account: string,
    creditId: string,
    redeemRequestId: string,
    signal: AbortSignal,
  ): Promise<ResetCreditConsumeResult>
  /**
   * Read one image attachment's bytes for inline display.
   * @param ref - the full durable reference (`readImage` verifies against it).
   * @param signal - caller cancellation from the RPC transport.
   * @returns the media type and base64-encoded bytes.
   * @throws when no attachment service is mounted or the read fails.
   */
  readImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<ImageBytesResult>
  /**
   * Read one generated video's bytes for inline playback.
   * @param name - bare MP4 file name inside the plugin's videos directory
   *   (validated against {@link VIDEO_NAME_PATTERN}; never a path).
   * @param signal - caller cancellation from the RPC transport.
   * @returns the media type and base64-encoded bytes.
   * @throws when the file does not exist or cannot be read.
   */
  readVideo(name: string, signal: AbortSignal): Promise<VideoBytesResult>
}

/** Payload carried no usable provider id — an RPC client bug, not a server failure. */
export class BadRequest extends Error {}

/**
 * Structural face of `connection.fetch.register` shared by both dsh lines.
 * The 0.1.2-alpha typings list only `GET`/`HEAD` methods and no
 * `requestBody`, while the 0.1.5 line adds `POST` plus the body mode; the
 * runtime on both lines dispatches any declared method to the exact route,
 * so the route is typed here rather than against either line's declaration.
 */
interface FetchRouteCompat {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  /** Buffered: the bridge aggregates the JSON body before `fetch` runs (0.1.5+; ignored earlier). */
  readonly requestBody: 'buffered'
  readonly fetch: (request: Request) => Promise<Response>
}

type FetchRegisterCompat = (route: FetchRouteCompat) => () => Promise<void>
type FetchRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>

/** Connection `client-request` envelope, as the browser rpc caller sends it. */
interface ClientRequestEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

function readEnvelope(body: unknown): ClientRequestEnvelope | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  if (record.type !== 'client-request' || typeof record.rpcId !== 'string' || typeof record.method !== 'string') return undefined
  return { type: 'client-request', rpcId: record.rpcId, method: record.method, payload: record.payload }
}

function serverResponse(rpcId: string, result: RpcResult<unknown>): Response {
  return Response.json({ type: 'server-response', rpcId, result })
}

/**
 * Wrap one endpoint's RPC handler as an exact Fetch route: decode the
 * `client-request` envelope the browser rpc caller posts, run the handler,
 * and answer with the matching `server-response` envelope — the same wire
 * contract the dedicated-channel bridge used to apply, reproduced here so
 * `rpc.call('/api', 'subscriptions-auth.<endpoint>', payload)` keeps working
 * unchanged on the browser side.
 */
function fetchRouteFor(endpoint: string, handler: FetchRpcHandler): FetchRouteCompat {
  const method = `${SUBSCRIPTIONS_AUTH_PREFIX}${endpoint}`
  return {
    path: `/api/${method}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const envelope = readEnvelope(body)
      if (envelope === undefined) {
        const rawId = (body as Record<string, unknown> | null)?.rpcId
        return serverResponse(typeof rawId === 'string' ? rawId : 'invalid-request', {
          ok: false,
          error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } },
        })
      }
      if (envelope.method !== method) {
        return serverResponse(envelope.rpcId, {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(method)}`,
            details: { issues: [] },
          },
        })
      }
      return serverResponse(envelope.rpcId, await handler(endpoint, envelope.payload, request.signal))
    },
  }
}

function ok(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

function failure(error: unknown): RpcResult<unknown> {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof BadRequest) {
    // The issues array is zod-shaped upstream; this channel validates by hand.
    return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
  }
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

function readProvider(payload: unknown): ProviderId {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const provider = (payload as Record<string, unknown>).provider
  if (typeof provider !== 'string' || !(PROVIDER_IDS as readonly string[]).includes(provider)) {
    throw new BadRequest(`payload.provider must be one of ${PROVIDER_IDS.join(', ')}`)
  }
  return provider as ProviderId
}

function readString(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest(`payload.${field} must be a non-empty string`)
  }
  return value
}

/** Validate the `setModelDefault` endpoint's payload. */
function readModelDefaultInput(payload: unknown): { provider: ProviderId; model: string; effort?: string } {
  const provider = readProvider(payload)
  const model = readString(payload, 'model')
  const record = payload as Record<string, unknown>
  let effort: string | undefined
  if (record.effort !== undefined) {
    if (typeof record.effort !== 'string' || record.effort.length === 0) {
      throw new BadRequest('payload.effort must be a non-empty string when present')
    }
    effort = record.effort
  }
  return {
    provider,
    model,
    ...(effort === undefined ? {} : { effort }),
  }
}

/** Validate the optional Claude login method. */
function readLoginMethod(payload: unknown, provider: ProviderId): LoginMethod | undefined {
  const method = (payload as Record<string, unknown>).method
  if (method === undefined) return undefined
  if (provider !== 'claude') throw new BadRequest('payload.method is only valid for claude')
  if (method !== 'oauth' && method !== 'keychain' && method !== 'manual') {
    throw new BadRequest('payload.method must be "oauth", "keychain", or "manual"')
  }
  return method
}

/**
 * Validate the `setCredentialOwnership` endpoint's target mode.
 *
 * An unrecognized value is refused here rather than stored: the mode decides who may spend a
 * shared refresh grant, so it is never inferred from a string this build does not implement.
 * @param payload - the endpoint payload.
 * @returns the target mode.
 */
function readCredentialOwnershipMode(payload: unknown): ClaudeCredentialMode {
  const mode = (payload as Record<string, unknown>).mode
  if (!isClaudeCredentialMode(mode)) {
    throw new BadRequest(`payload.mode must be one of ${CLAUDE_CREDENTIAL_MODES.join(', ')}`)
  }
  return mode
}

/**
 * Validate the `setCredentialOwnership` endpoint's risk acknowledgement.
 *
 * Absent reads as "not acknowledged": the server's own rule refuses a conversion onto
 * legacy-writeback without it, so a caller that omits the field can never rely on a client's
 * dialog having been shown.
 * @param payload - the endpoint payload.
 * @returns the caller's acknowledgement.
 */
function readCredentialOwnershipRiskAcknowledged(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const value = (payload as Record<string, unknown>).riskAcknowledged
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new BadRequest('payload.riskAcknowledged must be a boolean when present')
  return value
}

/** Validate the `setSpeed` endpoint's tier. */
function readSpeedTier(payload: unknown): SpeedTier {
  const tier = (payload as Record<string, unknown>).tier
  if (tier !== 'standard' && tier !== 'fast') {
    throw new BadRequest('payload.tier must be "standard" or "fast"')
  }
  return tier
}

/**
 * Validate the model both speed endpoints address. The caller resolves the
 * session's current model, so the payload names the provider route and the
 * wire model id the stored tier belongs to.
 */
function readSpeedTarget(payload: unknown): { provider: ProviderId; model: string } {
  return { provider: readProvider(payload), model: readString(payload, 'model') }
}

/** Validate the `image` endpoint's payload into a full attachment reference. */
function readImageRef(payload: unknown): ImageAttachmentRef {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const record = payload as Record<string, unknown>
  const attachmentId = record.attachmentId
  if (typeof attachmentId !== 'string' || attachmentId.length === 0) {
    throw new BadRequest('payload.attachmentId must be a non-empty string')
  }
  const mediaType = record.mediaType
  if (typeof mediaType !== 'string' || !(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw new BadRequest(`payload.mediaType must be one of ${IMAGE_MEDIA_TYPES.join(', ')}`)
  }
  for (const field of ['bytes', 'width', 'height'] as const) {
    const value = record[field]
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new BadRequest(`payload.${field} must be a positive integer`)
    }
  }
  const name = record.name
  if (name !== undefined && typeof name !== 'string') {
    throw new BadRequest('payload.name must be a string when present')
  }
  return {
    attachmentId: AttachmentId(attachmentId),
    mediaType: mediaType as ImageAttachmentRef['mediaType'],
    bytes: record.bytes as number,
    width: record.width as number,
    height: record.height as number,
    ...name === undefined ? {} : { name: name as string },
  }
}

/**
 * Validate the `video` endpoint's payload into a bare file name. Rejecting
 * anything with a path separator (the pattern allows none) pins every read
 * inside the plugin's videos directory.
 */
function readVideoName(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const name = (payload as Record<string, unknown>).name
  if (typeof name !== 'string' || !VIDEO_NAME_PATTERN.test(name)) {
    throw new BadRequest('payload.name must be a bare .mp4 file name')
  }
  return name
}

/** Same shape as {@link isCodexResetCreditId}. Checked before the provider is contacted. */
const RESET_CREDIT_ID = /^[\x21-\x7E]{1,256}$/
/** Same shape as {@link isCodexRedeemRequestId}. */
const REDEEM_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Validate a consume call. A bad id fails here, before any credit is spent. */
function readConsumeResetCredit(payload: unknown): {
  provider: ProviderId
  account: string
  creditId: string
  redeemRequestId: string
} {
  const provider = readProvider(payload)
  const account = readString(payload, 'account')
  const creditId = readString(payload, 'creditId')
  const redeemRequestId = readString(payload, 'redeemRequestId')
  if (!RESET_CREDIT_ID.test(creditId)) throw new BadRequest('payload.creditId is not a reset credit id')
  if (!REDEEM_REQUEST_ID.test(redeemRequestId)) throw new BadRequest('payload.redeemRequestId must be a UUID')
  return { provider, account, creditId, redeemRequestId }
}

/** Validate the usage/model catalog endpoints' optional force flag. */
function readForce(payload: unknown): boolean {
  return readRefreshFlag(payload, 'force')
}

/** Refresh flags are validated at the RPC boundary, never inferred from truthiness. */
function readRefreshFlag(payload: unknown, key: 'force' | 'refresh'): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const value = (payload as Record<string, unknown>)[key]
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new BadRequest(`payload.${key} must be a boolean when present`)
  return value
}

/** Validate a `proxySet` payload into a shape `ProxyInput` accepts. */
function readProxyInput(payload: unknown): ProxyInput {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const record = payload as Record<string, unknown>
  if (typeof record.enabled !== 'boolean') throw new BadRequest('payload.enabled must be a boolean')
  if (typeof record.url !== 'string') throw new BadRequest('payload.url must be a string')
  let username: string | undefined
  if (record.username !== undefined) {
    if (typeof record.username !== 'string') throw new BadRequest('payload.username must be a string when present')
    username = record.username
  }
  let password: string | null | undefined
  if (record.password !== undefined) {
    if (record.password !== null && typeof record.password !== 'string') {
      throw new BadRequest('payload.password must be a string or null when present')
    }
    password = record.password
  }
  let bypass: string[] | undefined
  if (record.bypass !== undefined) {
    if (!Array.isArray(record.bypass) || record.bypass.some(entry => typeof entry !== 'string')) {
      throw new BadRequest('payload.bypass must be an array of strings when present')
    }
    bypass = record.bypass
  }
  return {
    enabled: record.enabled,
    url: record.url,
    ...username === undefined ? {} : { username },
    ...password === undefined ? {} : { password },
    ...bypass === undefined ? {} : { bypass },
  }
}

/** Validate a `proxyTest` payload (the destination URL and an optional draft). */
function readProxyTestPayload(payload: unknown): { url?: string; proxy?: ProxyDraft } {
  if (typeof payload !== 'object' || payload === null) return {}
  const record = payload as Record<string, unknown>
  const url = record.url
  if (url === undefined && record.proxy === undefined) return {}
  if (url !== undefined && (typeof url !== 'string' || url.length === 0)) {
    throw new BadRequest('payload.url must be a non-empty string when present')
  }
  let proxy: ProxyDraft | undefined
  if (record.proxy !== undefined) {
    if (typeof record.proxy !== 'object' || record.proxy === null) {
      throw new BadRequest('payload.proxy must be an object when present')
    }
    const draftRecord = record.proxy as Record<string, unknown>
    if (typeof draftRecord.url !== 'string' || draftRecord.url.length === 0) {
      throw new BadRequest('payload.proxy.url must be a non-empty string')
    }
    let username: string | undefined
    if (draftRecord.username !== undefined) {
      if (typeof draftRecord.username !== 'string') {
        throw new BadRequest('payload.proxy.username must be a string when present')
      }
      username = draftRecord.username
    }
    let password: string | undefined
    if (draftRecord.password !== undefined) {
      if (typeof draftRecord.password !== 'string') {
        throw new BadRequest('payload.proxy.password must be a string when present')
      }
      password = draftRecord.password
    }
    proxy = {
      url: draftRecord.url,
      ...username === undefined ? {} : { username },
      ...password === undefined ? {} : { password },
    }
  }
  return {
    ...url === undefined ? {} : { url },
    ...proxy === undefined ? {} : { proxy },
  }
}

async function dispatch(
  controller: AuthController,
  speed: SpeedController,
  proxy: ProxyConfigController | undefined,
  modelDefaults: ModelDefaultsController | undefined,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  providerSettings?: ProviderSettingsController,
): Promise<RpcResult<unknown>> {
  switch (endpoint) {
    case 'providerSettings':
      if (!providerSettings) throw new BadRequest('provider settings are unavailable')
      return ok(await providerSettings.get(readProvider(payload), readForce(payload), readRefreshFlag(payload, 'refresh')))
    case 'setProviderSettings': {
      if (!providerSettings) throw new BadRequest('provider settings are unavailable')
      const provider = readProvider(payload)
      await providerSettings.set(provider, (payload as Record<string, unknown>).settings)
      return ok({ ok: true })
    }
    case 'status': {
      // One provider's failure (a corrupt store entry, a broken flow) must not
      // blind the whole page: it degrades to a fixed failure code on that
      // provider while the others still report their real status. The thrown
      // text stays on the server: a status read is not an operation the user
      // asked for, and its message may quote a store path or provider body.
      const entries = await Promise.all(PROVIDER_IDS.map(
        async provider => [provider, await controller.status(provider).catch(() => ({
          busy: false,
          accounts: [],
          lastError: { code: 'UNKNOWN', operation: 'status', at: Date.now() },
        }) satisfies ProviderStatus)] as const,
      ))
      return ok({ providers: Object.fromEntries(entries) })
    }
    case 'login': {
      const provider = readProvider(payload)
      return ok(await controller.login(provider, readLoginMethod(payload, provider)))
    }
    case 'manual': {
      const provider = readProvider(payload)
      await controller.manual(provider, readString(payload, 'input'))
      return ok({ ok: true })
    }
    case 'cancel':
      await controller.cancel(readProvider(payload))
      return ok({ ok: true })
    case 'logout': {
      const provider = readProvider(payload)
      await controller.logout(provider, readString(payload, 'account'))
      return ok({ ok: true })
    }
    case 'setDefault': {
      const provider = readProvider(payload)
      await controller.setDefault(provider, readString(payload, 'account'))
      return ok({ ok: true })
    }
    case 'setCredentialOwnership': {
      const provider = readProvider(payload)
      await controller.setCredentialOwnership(
        provider,
        readString(payload, 'account'),
        readCredentialOwnershipMode(payload),
        readCredentialOwnershipRiskAcknowledged(payload),
      )
      return ok({ ok: true })
    }
    case 'usage': {
      const provider = readProvider(payload)
      return ok(await controller.usage(provider, readString(payload, 'account'), signal, readForce(payload), readRefreshFlag(payload, 'refresh')))
    }
    case 'resetCredits': {
      const provider = readProvider(payload)
      return ok(await controller.listResetCredits(provider, readString(payload, 'account'), signal, readForce(payload)))
    }
    case 'consumeResetCredit': {
      const input = readConsumeResetCredit(payload)
      return ok(await controller.consumeResetCredit(
        input.provider,
        input.account,
        input.creditId,
        input.redeemRequestId,
        signal,
      ))
    }
    case 'image':
      return ok(await controller.readImage(readImageRef(payload), signal))
    case 'video':
      return ok(await controller.readVideo(readVideoName(payload), signal))
    case 'speed': {
      const target = readSpeedTarget(payload)
      return ok(await speed.speed(target.provider, target.model))
    }
    case 'setSpeed': {
      const target = readSpeedTarget(payload)
      await speed.setSpeed(target.provider, target.model, readSpeedTier(payload))
      return ok({ ok: true })
    }
    case 'proxyGet':
      if (proxy === undefined) throw new BadRequest('proxy configuration is unavailable')
      return ok(await proxy.get())
    case 'proxySet':
      if (proxy === undefined) throw new BadRequest('proxy configuration is unavailable')
      return ok(await proxy.set(readProxyInput(payload)))
    case 'proxyTest':
      if (proxy === undefined) throw new BadRequest('proxy configuration is unavailable')
      return ok(await proxy.test(readProxyTestPayload(payload)))
    case 'setModelDefault':
      if (modelDefaults === undefined) throw new BadRequest('model defaults are unavailable')
      {
        const input = readModelDefaultInput(payload)
        await modelDefaults.set(input.provider, input.model, input.effort)
      }
      return ok({ ok: true })
    default:
      throw new BadRequest(`unknown /subscriptions-auth endpoint "${endpoint}"`)
  }
}

/**
 * Register the `/subscriptions-auth` RPC channel when a host connection exists.
 * @param ctx - the plugin context (headless profiles have no `connection`).
 * @param controller - the auth operations backing the endpoints.
 * @param speed - the durable per-model speed-tier state backing the Speed toggle.
 * @param proxy - optional proxy-config controller backing `proxyGet`/`proxySet`/`proxyTest`.
 * @param modelDefaults - optional per-model effort writer; catalogue reads belong to `providerSettings`.
 */
export function registerAuthRpc(
  ctx: Context,
  controller: AuthController,
  speed: SpeedController,
  proxy: ProxyConfigController | undefined = undefined,
  modelDefaults: ModelDefaultsController | undefined = undefined,
  providerSettings: ProviderSettingsController | undefined = undefined,
): void {
  // `connection` is not in this plugin's inject list (headless compositions
  // lack it), so its startup order is unconstrained: defer registration until
  // the service exists instead of probing once at apply time.
  //
  // Exact Fetch routes under `/api` rather than a dedicated `rpc.handle`
  // channel: since dsh 0.1.5 the connection plugin no longer injects
  // `webServer` itself, and `rpc.handle` resolves `webServer` through the
  // connection plugin's own fiber, so every dedicated channel registration
  // throws `cannot get property "webServer" without inject`. The `/api`
  // route is mounted by the connection plugin (with its own webServer scope)
  // and applies the same trust fence and browser authentication, so exact
  // routes below it work on both dsh lines.
  ctx.inject(['connection'], (ctx) => {
    const connection = ctx.get('connection') as HostConnectionHandle
    const handler: FetchRpcHandler = async (endpoint, payload, signal) => {
      try {
        return await dispatch(controller, speed, proxy, modelDefaults, endpoint, payload, signal, providerSettings)
      } catch (error) {
        return failure(error)
      }
    }
    const register = connection.fetch.register as unknown as FetchRegisterCompat
    for (const endpoint of SUBSCRIPTIONS_AUTH_ENDPOINTS) {
      ctx.effect(
        () => register(fetchRouteFor(endpoint, handler)),
        `dsh-plugin-subscriptions: /api/${SUBSCRIPTIONS_AUTH_PREFIX}${endpoint} route`,
      )
    }
  })
}
