/**
 * dsh-plugin-subscriptions: register OAuth-subscription LLM providers
 * (ChatGPT/Codex, Claude, Grok, GitHub Copilot, Google Antigravity, Cursor) on `ctx.llm`, and expose the `/subscriptions-auth`
 * RPC channel the web Settings page uses to run the logins. The token store
 * lives at `~/.dsh/plugins/subscriptions/auth.json`; the channel registers only when
 * a host `connection` service exists, so headless compositions load fine.
 * @module dsh-plugin-subscriptions
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError, QUOTA_EXCEEDED_CODE, errorChain } from '@deepseek-ai/dsh-llm'
import type {
  AdapterRegistrationHandle,
  LlmAdapter,
  LlmModelInfo,
  LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'
// Type-only: activates the `ctx.tools` Context merge for the inject block.
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
// Type-only: activates the `ctx.web` Context merge for optional registration.
import type {} from '@deepseek-ai/dsh-web'
// Type-only: activates the `ctx.llmRequestRecord` Context merge for the Claude route's injection.
import type {} from '@deepseek-ai/dsh-llm-request-record'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SubscriptionCacheSchema, resolveSubscriptionCachePolicy } from './cache-policy.js'
import type { SubscriptionCachePolicy } from './cache-policy.js'
import { ClaudeRequestRecordPort } from './providers/claude-wire-record.js'
import { createFileUsageStore } from './providers/usage-store.js'
import { configureClaudeTransport, stopBridge } from './transport/claude-fetch.js'
import { DEFAULT_MAX_QUEUED_BYTES } from './transport/bridge.js'
import { OAuthFlowManager, type OAuthAttempt } from './auth/oauth-flow.js'
import { DeviceFlowManager, type DeviceAttempt } from './auth/device-flow.js'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  readClaudeCodeCredentialSource,
  readClaudeCodeCredentials,
  claudeReadOnlyUse,
  refreshClaudeSynced,
  resolveClaudeReadOnlyRefresh,
} from './auth/claude-code-creds.js'
import type { ClaudeSourceCredential } from './auth/claude-code-creds.js'
import {
  CLAUDE_CREDENTIAL_IS_FIRST_PARTY_OAUTH,
  claudeCredentialCoordinationUnproven,
  claudeCredentialIsExternal,
  claudeCredentialModeOf,
  claudeCredentialWritesBack,
  planClaudeCredentialConversion,
  resolveClaudeCredentialMode,
} from './auth/claude-credential-ownership.js'
import type { ClaudeCredentialMode } from './auth/claude-credential-ownership.js'
import { BadRequest, projectPolicyLimits, registerAuthRpc } from './auth/rpc.js'
import type {
  AuthController,
  AccountStatus,
  AvailabilityStatus,
  CredentialOwnershipStatus,
  CredentialStatus,
  ImageBytesResult,
  LoginMethod,
  ModelDefaultsController,
  PolicyLimitsStatus,
  PolicyStatus,
  ProfileStatus,
  ProtocolStatus,
  ProviderFailureCode,
  ProviderOperation,
  ProviderOperationFailure,
  ProviderStatus,
  SpeedController,
  VideoBytesResult,
} from './auth/rpc.js'
import {
  defaultEffortOf,
  defaultSpeedOf,
  loadModelDefaults,
  modelDefaultsLoadError,
  setDefaultEffort,
  setDefaultSpeed,
} from './model-defaults.js'
import {
  accountKeyOf,
  deleteAccountSession,
  getAccountCredential,
  listAccounts,
  pendingRotationAccounts,
  recoverPendingRefreshRotations,
  resolveAccountKey,
  saveAccountSession,
  setDefaultAccount,
  PROVIDER_IDS,
} from './auth/store.js'
import type {
  ClaudeSession,
  CodexSession,
  CopilotSession,
  AntigravitySession,
  CursorSession,
  GrokSession,
  ProviderId,
  StoredSession,
} from './auth/store.js'
import { DISCOVERY_TIMEOUT_MS, ENFORCEMENT_CODE, isMissingOrInvalidCredential, OAuthEndpointError, validateModels, withTimeout } from './providers/common.js'
import type { FetchFn, ModelEntry, ProviderUsage, ResetCreditConsumeResult, ResetCreditList, UsagePoolState } from './providers/common.js'
import { AccountTokenManager, durableStoreRefreshOwnership } from './providers/accounts.js'
import { reconcileStoredCodexAliases } from './providers/cache-identities.js'
import type { AccountAwareAdapter } from './providers/accounts.js'
import { DEFAULT_RATE_LIMIT_MAX_WAIT_MS, resolveRateLimitWait } from './providers/rate-limit.js'
import type { RateLimitConfig } from './providers/rate-limit.js'
import { catalogStore } from './providers/catalog-store.js'
import { CodexClientVersionCache } from './providers/codex-client-version.js'
import { CodexAutoReset } from './providers/codex-auto-reset.js'
import { CodexWebSearchProvider } from './providers/codex-search.js'
import { PoolAdapter, usagePoolState } from './providers/pool.js'
import { PoolSchedulingSchema, resolvePoolScheduling } from './providers/pool-scheduling.js'
import type { PoolSchedulingPolicy } from './providers/pool-scheduling.js'
import { PoolGateSchema } from './providers/pool-gate.js'
import type { PoolGateConfig } from './providers/pool-gate.js'
import { AccountPreferencesAdapter, accountAllowsPool, accountModelId, parseAccountModelId } from './providers/account-preferences.js'
import { modelDisabledReason } from './providers/provider-catalog.js'
export type { AccountPreferences, ProviderPreferences } from './provider-settings.js'
import { ImageAccountPool } from './providers/image-pool.js'
import { registerWithAlias } from './tools/registration.js'
import { buildAccountPools, poolKey } from './providers/pool-family.js'
import type { PoolDefinition, PoolMemberRef } from './providers/pool-family.js'
import { PoolHealthRegistry, isAuthCooldownReason } from './providers/pool-health.js'
import { PoolUsageTracker, USAGE_TTL_MS, usageFailureFacts } from './providers/pool-usage.js'
import type { UsageFetcher } from './providers/pool-usage.js'
import { appendUsageRefreshTrace } from './providers/usage-refresh-log.js'
import type { UsageRefreshMode, UsageRefreshTrace } from './providers/usage-refresh-log.js'
import { forgetUnifiedRateLimit, renameUnifiedRateLimit, unifiedRateLimitFor } from './providers/unified-rate-limit.js'
import {
  CodexAdapter,
  codexFlow,
  CODEX_PREEMPT_MS,
  codexProfileClaims,
  exchangeCodexCode,
  consumeCodexResetCredit,
  fetchCodexResetCredits,
  fetchCodexPoolUsage,
  fetchCodexUsage,
  isCodexPermanentRefreshError,
  refreshCodex,
} from './providers/codex.js'
import {
  ClaudeAdapter,
  claudeFlow,
  CLAUDE_PREEMPT_MS,
  claudeProfileReader,
  claudeSettingsFetch,
  exchangeClaudeCode,
  fetchClaudeUsage,
  isClaudePermanentRefreshError,
  refreshClaude,
  carryClaudeIdentity,
} from './providers/claude.js'
import { ClaudeMaintenanceController } from './providers/claude-maintenance.js'
import { ClaudeContinuationState } from './providers/claude-continuation-state.js'
import { LOCAL_CONTINUATION_STATE_UNAVAILABLE } from './providers/claude-continuation-io.js'
import type { ClaudeContinuationReadiness } from './providers/claude.js'
import { ClaudeProtocolBlockStore } from './providers/claude-protocol-state.js'
import { CLAUDE_PROTOCOL_PROFILE, claudeProtocolFingerprint, claudeRoleHeaders } from './providers/claude-protocol.js'
import {
  CLAUDE_DEFAULT_POLICY_ORIGIN,
  ClaudeOrgPinChecker,
  ClaudePolicyLimitsOwner,
  policyKeyMapping,
  policyLimitsEligibilityFor,
  policyLimitsTransport,
} from './providers/claude-policy-limits.js'
import type {
  ClaudePolicyLimitsOptions,
  ClaudePolicyLimitsScheduler,
  DshPolicyOperation,
  PolicyKeyMapping,
  PolicyLimitsReadFailure,
} from './providers/claude-policy-limits.js'
import { FileClaudePolicyLimitsState } from './providers/claude-policy-limits-state.js'
import type { CoreTransport } from './claude-core/index.js'
import { claudeScopesFor } from './providers/claude-managed-settings.js'
import type { ClaudePolicyConsumer, ClaudePolicyHttpClassifier } from './providers/claude-managed-settings.js'
import { claudeHttpLlmError } from './providers/claude-failure.js'
import type { ClaudeFailureDecision } from './providers/claude-failure.js'
import { CLIENT_VERSION_UNSUPPORTED_CODE } from './providers/claude-failure.js'
import { POLICY_KEYS, HIPAA_TAINT } from './claude-core/policy-registry.js'
import { parseOrgPin } from './claude-core/org-pin.js'
import { coreFailure } from './claude-core/index.js'
import type { CoreFailure, PolicyAnswer } from './claude-core/index.js'
import type { ClaudeEnginePolicy } from './claude-engine/index.js'
import { resolveClaudeMaintenanceConfig } from './providers/claude-account-state.js'
import { FileClaudeMaintenancePersistence } from './providers/claude-maintenance-state.js'
import {
  GrokAdapter,
  grokFlow,
  GROK_PREEMPT_MS,
  exchangeGrokCode,
  fetchGrokUsage,
  isGrokPermanentRefreshError,
  refreshGrok,
} from './providers/grok.js'
import {
  CopilotAdapter,
  COPILOT_PREEMPT_MS,
  completeCopilotLogin,
  copilotDeviceFlow,
  isCopilotPermanentRefreshError,
  refreshCopilot,
} from './providers/copilot.js'
import {
  AntigravityAdapter,
  antigravityFlow,
  ANTIGRAVITY_PREEMPT_MS,
  exchangeAntigravityCode,
  fetchAntigravityUsage,
  isAntigravityPermanentRefreshError,
  refreshAntigravity,
  resolveAntigravityOAuthConfig,
} from './providers/antigravity.js'
import type { AntigravityRuntimeConfig } from './providers/antigravity.js'
import {
  CursorAdapter,
  CURSOR_PREEMPT_MS,
  beginCursorLogin,
  isCursorPermanentRefreshError,
  loadCursorAccountUsage,
  refreshCursor,
} from './providers/cursor.js'
import type { CursorLoginHandle } from './providers/cursor.js'
import { createXSearchTool } from './tools/x-search.js'
import { createImageGenerateTool } from './tools/image-generate.js'
import { createVideoGenerateTool, videosDirectory } from './tools/video-generate.js'
import { proxiedFetch, proxyGetConfig, proxySetConfig, proxyTestConnection } from './http.js'
import { ProviderSettingsStore, PROVIDER_TOOLS, validatePreferences } from './provider-settings.js'

export type { ModelEntry, ProviderUsage, UsageWindow } from './providers/common.js'
export type { RateLimitConfig, RateLimitWait } from './providers/rate-limit.js'
export type {
  AccountStatus,
  AvailabilityCode,
  AvailabilityStatus,
  CredentialCode,
  CredentialStatus,
  PolicyCode,
  PolicyScope,
  PolicyStatus,
  ProfileStatus,
  ProtocolCode,
  ProtocolStatus,
  ProviderFailureCode,
  ProviderOperation,
  ProviderOperationFailure,
  ProviderStatus,
  ProviderUnavailableCode,
} from './auth/rpc.js'
export type { AntigravitySession, ClaudeSession, CodexSession, CopilotSession, CursorSession, GrokSession, ProviderId } from './auth/store.js'

export const name = 'dsh-plugin-subscriptions'
export const inject = ['llm']

/** Default maximum provider idle time while one stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Bound on one pool quota poll — member selection must not hang on a usage endpoint. */
const POOL_USAGE_TIMEOUT_MS = DISCOVERY_TIMEOUT_MS
export { withTimeout } from './providers/common.js'

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Codex /models client_version override; does not change account entitlements. */
  codexClientVersion?: string
  /** Provider routes to register; defaults to every supported provider. */
  providers?: ProviderId[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Maximum unread bytes per Claude transport response; consumed bytes do not count (default 32 MiB). */
  claudeTransportMaxQueuedBytes?: number
  /**
   * What a Claude request tells the model about its own environment, in place of the harness
   * identity section. Clamped to this route: the harness identity stays in force everywhere
   * else. Empty omits the identity entirely.
   */
  claudeIdentityLine?: string
  /**
   * Whether a refresh of a keychain-imported Claude account is written back into Claude
   * Code's own credential store. Off by default: that store belongs to another application,
   * and a browser-authorized account never touches it. Turning it on keeps an installed
   * `claude` CLI in sync with a rotation this plugin performs.
   */
  syncClaudeCodeCredentials?: boolean
  /** Demand-driven metadata freshness; no duration starts a polling timer. */
  cache?: Partial<SubscriptionCachePolicy>
  /**
   * Claude account-maintenance bounds. Every value is validated at load: a zero
   * or negative bound is a misconfiguration, because none of them switches a
   * maintenance capability off. The credential lead defaults to the provider's
   * own `CLAUDE_PREEMPT_MS` baseline rather than a second copy of the constant.
   */
  claudeMaintenance?: {
    /** Lead time before credential expiry at which the renewal timer runs. */
    refreshLeadMs?: number
    /** How long an accepted account profile stays fresh. */
    profileMaxAgeMs?: number
    /** Period between managed-settings polls while an account is bound. */
    policyPollMs?: number
    /** Bound on one profile or settings read. */
    readTimeoutMs?: number
    /** First retry delay after a failed maintenance cycle. */
    failureBackoffMs?: number
    /** Ceiling the failure backoff doubles up to. */
    maxFailureBackoffMs?: number
    /**
     * Floor between two credential checks, so a server that keeps answering with a
     * short-lived or unchanged expiry cannot turn a successful cycle into a zero-delay loop.
     */
    minRefreshDelayMs?: number
  }
  /** Whether and how long a route waits out a closed rate-limit window. */
  rateLimit?: RateLimitConfig
  /** Advisory model catalogs overriding the built-in defaults, per provider. */
  models?: {
    codex?: ModelEntry[]
    claude?: ModelEntry[]
    grok?: ModelEntry[]
    copilot?: ModelEntry[]
    antigravity?: ModelEntry[]
    cursor?: ModelEntry[]
  }
  /** Antigravity-specific OAuth and endpoint configuration. */
  antigravity?: AntigravityRuntimeConfig & {
    /** Google OAuth client id. May instead be supplied as ANTIGRAVITY_CLIENT_ID. */
    clientId?: string
    /** Google OAuth client secret, when required by the client registration. */
    clientSecret?: string
  }
  /** Same-subscription account pools (and optional extra tier models). */
  pool?: {
    /** Enable account pooling (default true; needs ≥2 accounts of one provider). */
    enabled?: boolean
    /** Member selection: plain priority failover, or quota-aware urgency scheduling. */
    strategy?: 'priority' | 'quota_aware'
    /** Bounded reset/finishing preferences and per-account concurrency penalty. */
    scheduling?: Partial<PoolSchedulingPolicy>
    /**
     * Account concurrency, request limiter and backoff. A subscription account
     * serves at most this many sessions; each session sends one request at a
     * time, and each account's request limiter is shared by all of them.
     */
    concurrency?: PoolGateConfig
    /** Auto-pool every catalog model across a provider's logged-in accounts (default true). */
    autoAccounts?: boolean
    /** Explicit account lists for one catalog model (same provider); replaces the auto pool. */
    families?: Record<string, PoolMemberRef[]>
    /** Extra picker entries with heterogeneous fallbacks, listed under the first member's provider. */
    tiers?: Record<string, PoolMemberRef[]>
  }
  /**
   * Advisory accounting for one Claude continuation-state operation (default 5000).
   *
   * It never ends a wait and never refuses a request: every state wait runs until its operation
   * settles and ends only when the caller cancels or the plugin is disposed. The resolved value is
   * still raised to at least the lock input plus 2000 ms, so an existing configuration keeps the
   * value it resolved before; that margin changes no outcome now.
   */
  continuationStateDeadlineMs?: number
  /**
   * Backoff and lease input for one continuation-state lock (default 2000). It is not a wait bound:
   * a live holder is waited out, and only a lock path that cannot be created refuses the operation
   * instead of running it unowned.
   */
  continuationStateLockTimeoutMs?: number
}

const providerIdSchema = z.union(['codex', 'claude', 'grok', 'copilot', 'antigravity', 'cursor'])
const modelEntrySchema: z<ModelEntry> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.union([z.array(z.union(['text', 'image'])).min(1), z.const(undefined)]),
  wire: z.union(['chat-completions', 'responses']),
})

const poolMemberSchema: z<PoolMemberRef> = z.object({
  provider: providerIdSchema.required(),
  account: z.string(),
  model: z.string().required(),
})

/** The per-operation accounting input in force when the configuration states none. */
export const DEFAULT_CONTINUATION_STATE_DEADLINE_MS = 5_000

/** The lock backoff and lease input in force when the configuration states none. */
export const DEFAULT_CONTINUATION_STATE_LOCK_TIMEOUT_MS = 2_000

/** The margin the resolved accounting input keeps above the lock input for compatibility. */
const CONTINUATION_STATE_DEADLINE_MARGIN_MS = 2_000

/**
 * The validated accounting input this installation runs with.
 *
 * The schema validates and defaults this field, so a configuration that reached `apply` states a
 * number; this is the one place that reads it, rather than defaulting it again at a call site.
 * The value is raised to at least the lock input plus
 * {@link CONTINUATION_STATE_DEADLINE_MARGIN_MS}, so an existing configuration keeps the value it
 * resolved before. No wait ends or refuses because of either value, so the margin changes no
 * outcome.
 * @param config - the resolved plugin configuration.
 * @returns the accounting input in milliseconds.
 */
export function resolveContinuationStateDeadlineMs(config: Config): number {
  const stated = config.continuationStateDeadlineMs ?? DEFAULT_CONTINUATION_STATE_DEADLINE_MS
  return Math.max(stated, resolveContinuationStateLockTimeoutMs(config) + CONTINUATION_STATE_DEADLINE_MARGIN_MS)
}

/**
 * The validated lock backoff and lease input this installation runs with.
 * @param config - the resolved plugin configuration.
 * @returns the input in milliseconds.
 */
export function resolveContinuationStateLockTimeoutMs(config: Config): number {
  return config.continuationStateLockTimeoutMs ?? DEFAULT_CONTINUATION_STATE_LOCK_TIMEOUT_MS
}

export const Config: z<Config> = z.object({
  providers: z.array(providerIdSchema).default(['codex', 'claude', 'grok', 'copilot', 'antigravity', 'cursor']),
  codexClientVersion: z.string(),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  claudeTransportMaxQueuedBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_QUEUED_BYTES),
  claudeIdentityLine: z.string(),
  continuationStateDeadlineMs: z.number().step(1).min(100).max(10_000).default(DEFAULT_CONTINUATION_STATE_DEADLINE_MS),
  continuationStateLockTimeoutMs: z.number().step(1).min(100).max(10_000).default(DEFAULT_CONTINUATION_STATE_LOCK_TIMEOUT_MS),
  syncClaudeCodeCredentials: z.boolean(),
  cache: SubscriptionCacheSchema,
  claudeMaintenance: z.object({
    refreshLeadMs: z.number(),
    profileMaxAgeMs: z.number(),
    policyPollMs: z.number(),
    readTimeoutMs: z.number(),
    failureBackoffMs: z.number(),
    maxFailureBackoffMs: z.number(),
    minRefreshDelayMs: z.number(),
  }),
  rateLimit: z.object({
    wait: z.boolean().default(true),
    maxWaitMs: z.number().min(1).default(DEFAULT_RATE_LIMIT_MAX_WAIT_MS),
  }),
  models: z.object({
    codex: z.array(modelEntrySchema),
    claude: z.array(modelEntrySchema),
    grok: z.array(modelEntrySchema),
    copilot: z.array(modelEntrySchema),
    antigravity: z.array(modelEntrySchema),
    cursor: z.array(modelEntrySchema),
  }),
  antigravity: z.object({
    clientId: z.string(),
    clientSecret: z.string().role('secret'),
    baseURL: z.string(),
    userAgent: z.string(),
    onboard: z.boolean().default(true),
  }),
  pool: z.object({
    enabled: z.boolean().default(true),
    strategy: z.union(['priority', 'quota_aware']).default('quota_aware'),
    scheduling: PoolSchedulingSchema,
    concurrency: PoolGateSchema,
    autoAccounts: z.boolean().default(true),
    families: z.dict(z.array(poolMemberSchema)),
    tiers: z.dict(z.array(poolMemberSchema)),
  }),
})

/** Built-in catalogs used when the config does not override a provider's models. */
const DEFAULT_MODELS: Record<ProviderId, ModelEntry[]> = {
  codex: [
    { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5.1', name: 'GPT-5.1' },
  ],
  claude: [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-opus-5', name: 'Claude Opus 5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-fable-5', name: 'Claude Fable 5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', maxTokens: 64_000 },
  ],
  grok: [
    { id: 'grok-4', name: 'Grok 4' },
    { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast Reasoning' },
    { id: 'grok-code-fast-1', name: 'Grok Code Fast 1' },
  ],
  // Static fallback only: the live /models catalog (with per-model vision
  // flags and context windows) wins whenever discovery succeeds.
  copilot: [
    { id: 'gpt-4.1', name: 'GPT-4.1', inputModalities: ['text', 'image'] },
    { id: 'gpt-4o', name: 'GPT-4o', inputModalities: ['text', 'image'] },
    { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', inputModalities: ['text', 'image'] },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', inputModalities: ['text', 'image'] },
  ],
  // Static fallback only; the authenticated fetchAvailableModels response wins.
  antigravity: [
    { id: 'gemini-3-flash', name: 'Gemini 3 Flash', inputModalities: ['text', 'image'] },
    { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro High', inputModalities: ['text', 'image'] },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', inputModalities: ['text', 'image'] },
    { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 Thinking', inputModalities: ['text', 'image'] },
  ],
  // Static fallback only. `Cursor.models.list` replaces it after login.
  cursor: [
    { id: 'composer-2.5', name: 'Composer 2.5' },
  ],
}

/** Validate and detach the model catalog for every provider. */
function resolveCatalog(models: Config['models']): Record<ProviderId, ModelEntry[]> {  const resolve = (provider: ProviderId): ModelEntry[] => {
    // Schemastery injects `[]` for omitted array fields, so an empty list
    // cannot be told apart from an absent one: both mean the built-ins.
    const configured = models?.[provider]
    const entries = configured !== undefined && configured.length > 0 ? configured : DEFAULT_MODELS[provider]
    return validateModels(entries, `${name}: models.${provider}`)
  }
  return {
    codex: resolve('codex'),
    claude: resolve('claude'),
    grok: resolve('grok'),
    copilot: resolve('copilot'),
    antigravity: resolve('antigravity'),
    cursor: resolve('cursor'),
  }
}

/** The display account of a stored session, for the status endpoint. */
function accountOf(provider: ProviderId, session: StoredSession | undefined): string | undefined {
  if (session === undefined) return undefined
  switch (provider) {
    case 'codex': {
      const codex = session as CodexSession
      // Sessions stored before identity claims were persisted still carry the
      // id token: decode the email on the fly instead of forcing a re-login.
      return codex.emailAddress ?? codexProfileClaims(codex.idToken).emailAddress ?? codex.accountId
    }
    case 'claude': return (session as ClaudeSession).emailAddress
    case 'grok': return (session as GrokSession).account
    case 'copilot': return (session as CopilotSession).account
    case 'antigravity': return (session as AntigravitySession).account
    case 'cursor': return (session as CursorSession).email
  }
}

/** The plan name a stored session carries, when the provider told us. */
function planOf(provider: ProviderId, session: StoredSession): string | undefined {
  switch (provider) {
    case 'codex': return (session as CodexSession).planType
    case 'claude': return (session as ClaudeSession).subscriptionType
    case 'grok': return undefined
    case 'copilot': return undefined
    case 'antigravity': return undefined
    case 'cursor': return undefined
  }
}

/** Per-provider per-account usage lookup; providers without a usage endpoint are absent. */
type UsageFetchers = Partial<Record<ProviderId, (account: string, signal: AbortSignal) => Promise<ProviderUsage>>>

/** A metadata read respects both the owning cache lifecycle and its deadline. */
function usageReadSignal(lifecycle?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS)
  return lifecycle === undefined ? timeout : AbortSignal.any([lifecycle, timeout])
}

/** A stable harness error code, without carrying a provider message into a trace. */
function usageRefreshErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

/**
 * Classify one provider-operation failure into the allowlisted fields the RPC
 * reports.
 *
 * The status projection must never carry provider or transport text: a token
 * endpoint's message quotes `error_description`, and a store or transport error
 * can quote a path or body. Only a fixed code, the operation, the HTTP status
 * the provider stated, its own error code, and the retry instant it stated are
 * reported; the client renders localized copy per code.
 * @param error - the failure a login, import, or logout path threw.
 * @param operation - the operation the failure belongs to.
 * @param at - epoch ms the failure is recorded at.
 * @returns the recorded failure.
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export function providerFailure(
  error: unknown,
  operation: ProviderOperation,
  at = Date.now(),
): ProviderOperationFailure {
  const base = { operation, at }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return { ...base, code: error.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED' }
  }
  if (error instanceof OAuthEndpointError) {
    const stated = {
      ...base,
      status: error.status,
      ...error.oauthCode === undefined ? {} : { providerCode: error.oauthCode },
      ...error.retryAfterMs === undefined ? {} : { retryAt: at + error.retryAfterMs },
    }
    // A rejected grant is a dead password, not a momentary outage: the user has
    // to log in again, and the UI must not present it as a waiting window.
    return error.status === 401 || error.status === 403 || error.oauthCode === 'invalid_grant'
      ? { ...stated, code: 'CREDENTIALS_REJECTED' }
      : { ...stated, code: 'PROVIDER_REJECTED' }
  }
  if (error instanceof LlmError) {
    return { ...base, code: failureCodeOfLlmError(error.code) }
  }
  if (isMissingOrInvalidCredential(error)) return { ...base, code: 'CREDENTIALS_UNAVAILABLE' }
  return { ...base, code: 'UNKNOWN' }
}

/**
 * Map one `LlmError` code to the status projection's fixed failure code.
 * @param code - the adapter's error code.
 * @returns the reported failure code.
 */
function failureCodeOfLlmError(code: string): ProviderFailureCode {
  switch (code) {
    case 'MISSING_CREDENTIAL': return 'CREDENTIALS_UNAVAILABLE'
    case 'INVALID_CREDENTIAL':
    case 'AUTH': return 'CREDENTIALS_REJECTED'
    case 'TIMEOUT': return 'TIMEOUT'
    case 'TRANSPORT': return 'NETWORK'
    case 'SERVER':
    case 'EMPTY_RESPONSE':
    case 'ENFORCEMENT': return 'PROVIDER_REJECTED'
    default: return 'UNKNOWN'
  }
}

/**
 * The failure-recovery contract version the Claude route requires of its Host:
 * a hard non-retry disposition must survive failure normalization, the Session
 * log, and every automatic resend path before an adapter may rely on it.
 */
const REQUIRED_FAILURE_RECOVERY_VERSION = 1

/**
 * The user agent the independent policy reads carry.
 *
 * It is the pinned protocol's own settings role, so these requests present the same
 * first-party client identity the other account endpoints do; no separate agent is invented.
 */
const CLAUDE_POLICY_USER_AGENT = claudeRoleHeaders('settings')['user-agent'] ?? 'claude-code'

/** Fixed log code for a Host that does not declare the required contract. */
export const CLAUDE_HOST_INCOMPATIBLE = 'CLAUDE_HOST_INCOMPATIBLE'

/**
 * Host-registered consumers for the remote managed-settings keys this build can enforce.
 *
 * The one entry is the organization pin: `forceLoginOrgUUID` restricts which account may serve,
 * and this build enforces it exactly — every request passes the organization validation before
 * the wire — so the key is consumed here instead of being reported as an unhandled remote
 * setting, which would block every operation. This build maps no wire tool name onto a DSH
 * tool, so `permissions` keeps its fail-closed treatment: an adopted `permissions` value blocks
 * the tool scope, the status card reports `POLICY_UNSUPPORTED`, and the affected operations are
 * refused rather than run.
 * @returns the consumer for the pinned organization key.
 */
function claudeOrganizationPinConsumer(): ClaudePolicyConsumer {
  return {
    key: 'forceLoginOrgUUID',
    scope: 'unknown',
    parse(value: unknown) {
      const pin = parseOrgPin(value)
      if (pin.kind === 'invalid') {
        // A present-but-unusable pin is a refusal, never an absence: nothing is served for an
        // account whose organization this build cannot even read.
        return {
          restrictions: [],
          unsupported: [{
            key: 'forceLoginOrgUUID',
            scope: 'unknown',
            code: 'POLICY_INVALID_VALUE',
            detail: 'the pinned organization value is not usable',
          }],
        }
      }
      // A stated pin, or the absence of one, carries no per-operation restriction of its own:
      // the organization validation every request passes before the wire is what enforces it.
      return { restrictions: [], unsupported: [] }
    },
    decide: () => ({ decision: 'allow', reason: 'the organization validation enforces this pin before the wire' }),
  }
}

const CLAUDE_POLICY_CONSUMERS: readonly ClaudePolicyConsumer[] = [claudeOrganizationPinConsumer()]

/**
 * The trusted engine policy one request states, from the account's own accepted policy.
 *
 * One confirmed HIPAA taint withholds the mid-conversation betas for that account's builds; the
 * top-level system prompt the ordinary client sends is untouched, and nothing else changes. The
 * state this reads is the owner's own normalized projection: no raw document, no remote value
 * and no unnormalized taint crosses this seam, and a state whose snapshot could not be trusted
 * carries blockers and is refused before any request is built, so it never reaches this
 * decision.
 * @param status - the account's `policy_limits` status, or undefined when it holds none.
 * @returns the policy the engine builds this request under.
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export function claudeRequestPolicyFor(
  status: { readonly taints?: readonly string[] } | undefined,
): ClaudeEnginePolicy {
  return { suppressMidConversationSystem: status?.taints?.includes(HIPAA_TAINT) === true }
}

/** The identity one tool execution carries, as the execution-stage guard receives it. */
interface ToolExecutionIdentity {
  readonly name: string
  readonly agent?: { readonly session: { readonly id: unknown } }
}

/** One account's decision about one tool operation. */
interface ToolPolicyDecision {
  readonly decision: 'allow' | 'deny'
  /** Stable code naming what refused the call, when it was refused. */
  readonly code?: string
  /** The registered policy key behind a `policy_limits` refusal, for the model-facing reason. */
  readonly key?: string
  /** The answer's own fixed reason code, for the model-facing reason. */
  readonly reason?: string
}

/** The provider route every Claude protocol refusal is filed under. */
const CLAUDE_PROVIDER = 'claude'

/** The fixed code a key the live document refuses reports when it stops an operation. */
export const POLICY_LIMITS_DENIED = 'POLICY_LIMITS_DENIED'

/** The fixed code a key this build cannot map exactly reports when it stops an operation. */
export const POLICY_LIMITS_UNSUPPORTED = 'POLICY_LIMITS_UNSUPPORTED'

/** The fixed code a request refused because its `policy_limits` read failed reports. */
export const POLICY_LIMITS_UNAVAILABLE = 'POLICY_LIMITS_UNAVAILABLE'

/**
 * The placeholder an unknown policy key is reported as.
 *
 * A key the provider stated is remote text: it may echo a credential, a prompt fragment or an
 * instruction, and this refusal reaches the model, the client's error projection and the
 * session log. Only the pinned registry's own key names may travel, so an unknown key is
 * reported as this fixed placeholder and its value never crosses the boundary — the core still
 * evaluates the original key internally, and the denial it produces is unchanged.
 */
export const UNSUPPORTED_POLICY_KEY = 'unsupported_policy_key'

/**
 * The fixed code a request refused by the organization pin its accepted policy stated reports.
 *
 * The owner's own finer code (`org_pin_mismatch`, `org_verify_failed`, `invalid_input`) stays
 * inside the message: the client and the pool route read this one, which is the same for every
 * way a pin refuses an account.
 */
export const POLICY_ORG_PIN_REFUSED = 'POLICY_ORG_PIN_REFUSED'

/**
 * The name the harness's own web-fetch capability is registered under.
 *
 * `@deepseek-ai/dsh-tool-web` registers exactly this name (`src/fetch.ts`), and the harness
 * publishes no constant for it, so the literal lives here with its evidence rather than being
 * inferred from a tool name that merely looks similar.
 */
const HOST_WEB_FETCH_TOOL = 'web_fetch'

/** The pinned registry's own key names, the only key text a refusal may carry. */
const REGISTERED_POLICY_KEYS: ReadonlySet<string> = new Set(POLICY_KEYS)

/**
 * The provider, origin and protocol fingerprint one refusal is filed and matched by.
 *
 * Both values are this build's own constants — the route serves exactly one origin under one
 * pinned protocol profile — so a refusal discovered by any account's read names the whole
 * configuration, not just the account that happened to observe it.
 */
function claudeProtocolFence(): { provider: string; origin: string; fingerprint: string } {
  return {
    provider: CLAUDE_PROVIDER,
    origin: CLAUDE_DEFAULT_POLICY_ORIGIN,
    fingerprint: claudeProtocolFingerprint(CLAUDE_PROTOCOL_PROFILE),
  }
}

/**
 * The refusal a request observes once the protocol configuration it would use is blocked.
 *
 * It is the same typed refusal the maintenance preflight throws, so a configuration refused
 * through the `policy_limits` path stops the request exactly like one refused through the
 * settings path, and no caller can retry or route around it.
 * @returns the refusal.
 */
function claudeProtocolBlockedError(): LlmError {
  return new LlmError(
    'claude protocol configuration is blocked for this origin; update the client before retrying',
    CLIENT_VERSION_UNSUPPORTED_CODE,
    { retryDisposition: 'forbid', status: 400 },
  )
}

/**
 * The refusal a `policy_limits` verdict produces for one of this plugin's own operations.
 *
 * Its code is the policy decision's own, so the status card and the caller read the same
 * vocabulary a managed-settings refusal uses, and the disposition forbids a resend: the
 * verdict belongs to the account this request was going to use.
 * @param decision - the denial, with the key and reason that produced it.
 * @returns the refusal.
 */
function policyLimitsRefusalError(decision: { readonly code?: string; readonly key?: string }): LlmError {
  return new LlmError(
    'claude request refused by the accepted policy_limits document'
    + `${decision.key === undefined ? '' : `: "${decision.key}"`}`,
    decision.code ?? POLICY_LIMITS_DENIED,
    { retryDisposition: 'forbid' },
  )
}

/**
 * The refusal a failed `policy_limits` read produces for a request.
 *
 * The failure's own fixed code and sub-reason are named; no status text, header or body
 * crosses this seam. A read that settled before producing an outcome is a transient fact, so
 * it is retryable; one the pinned retry policy forbade keeps that prohibition, which is what
 * stops the Host and the pool route from spending another account on it.
 * @param failure - the core failure the read produced.
 * @returns the refusal.
 */
function policyLimitsReadError(failure: CoreFailure): LlmError {
  return new LlmError(
    `claude policy_limits could not be read for this account (${failure.code}`
    + `${failure.reason === undefined ? '' : `: ${failure.reason}`}); `
    + 'the request is refused rather than sent under an unknown policy',
    POLICY_LIMITS_UNAVAILABLE,
    failure.skipRetry === true ? { retryDisposition: 'forbid' } : {},
  )
}

/**
 * The DSH operation one Host-registered tool exercises.
 *
 * The identity comes from the registry's own definition, never from a similar name: a tool
 * called `web-fetch` or `fetch_web` is a Host tool, not the harness web-fetch capability.
 * This build declares no other per-tool capability, and it publishes no file-transfer tool,
 * so every other definition reaches `host.tools` — the conservative answer that keeps a
 * capability this build cannot place inside the refusal rather than outside it.
 * @param definition - the Host's registered definition for the call, when it has one.
 * @returns the operation the call exercises.
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export function claudeToolOperation(definition: ToolDefinition | undefined): DshPolicyOperation {
  return definition?.name === HOST_WEB_FETCH_TOOL ? 'web_fetch' : 'host.tools'
}

/**
 * Decide one operation against the accepted `policy_limits` verdicts.
 *
 * An account this owner holds nothing for is never constrained by it. The owner's own
 * fail-closed state refuses the operation outright: an incomplete or untrusted snapshot could
 * have restricted anything, and a restriction that cannot be re-stated must not be read as
 * permission.
 *
 * With nothing adopted, the no-live-policy registry defaults are the provider's own capability
 * defaults, not a statement about this caller's operation — a registry key's `onCacheMiss`
 * deny is not evidence that the provider restricted anything — so they never refuse one here.
 * Only a document in force decides, and then a key is consulted only for the operations its
 * mapping declares: a refusal that reaches the web-fetch capability never stops the plugin's
 * own egress, and one that reaches the catalogue fetch never stops model inference. A key
 * whose mapping is `inapplicable` reaches nothing here, while a key this build cannot map
 * exactly refuses the operations that mapping names, with its recorded reason — an unknown key
 * the live document states is therefore refused conservatively, and that is a deliberate
 * difference from the pinned client's own consumer set.
 * @param input - the owner's status, the keys in force, the operation and the answers.
 * @returns a denial, or an allow when nothing in force reaches the operation.
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export function policyLimitsOperationDenial(input: {
  readonly status: { readonly fallback: 'live' | 'stale' | 'none'; readonly blockers?: readonly string[] } | undefined
  readonly operation: DshPolicyOperation
  readonly keys: readonly string[]
  readonly verdict: (key: string) => PolicyAnswer
  readonly mapping: (key: string) => PolicyKeyMapping
}): ToolPolicyDecision {
  const status = input.status
  if (status === undefined) return { decision: 'allow' }
  const blocker = status.blockers?.[0]
  if (blocker !== undefined) {
    return { decision: 'deny', code: POLICY_LIMITS_UNSUPPORTED, reason: blocker }
  }
  if (status.fallback === 'none') return { decision: 'allow' }
  for (const key of input.keys) {
    const answer = input.verdict(key)
    // `allow` is the only answer that contributes nothing; an `unsupported` answer is a
    // refusal this build must not read as permission.
    if (answer.verdict === 'allow') continue
    const mapped = input.mapping(key)
    if (mapped.enforcement === 'inapplicable') continue
    if (!mapped.operations.includes(input.operation)) continue
    // Only a key from the pinned registry may travel in the refusal: it is the only key whose
    // name is this build's own fixed vocabulary, and the refusal reaches the model, the error
    // projection and the session log. An unknown key keeps its denial and loses its name.
    const registered = REGISTERED_POLICY_KEYS.has(key)
    return {
      decision: 'deny',
      code: mapped.enforcement === 'enforced' ? POLICY_LIMITS_DENIED : POLICY_LIMITS_UNSUPPORTED,
      key: registered ? key : UNSUPPORTED_POLICY_KEY,
      ...registered ? { reason: answer.reason } : {},
    }
  }
  return { decision: 'allow' }
}

/**
 * Non-serializable hooks that make an otherwise network-bound decision deterministic in
 * tests. The Loader never supplies them; every decision they replace is still enforced at
 * the same place.
 */
export interface SubscriptionInternals {
  /**
   * Replace the per-account tool-policy decision a guard asks for. Absent reads the live
   * accepted policy from the account-maintenance owner.
   */
  readonly toolPolicyDecision?: (account: string, tool: string) => ToolPolicyDecision
  /**
   * Replace the transport the independent `policy_limits` read uses. Absent performs the
   * request with this plugin's own fetch, exactly as a deployment does.
   */
  readonly policyLimitsTransport?: CoreTransport
  /**
   * Replace the transport the organization validation uses. Absent performs the request with
   * this plugin's own fetch, exactly as a deployment does.
   */
  readonly orgPinTransport?: CoreTransport
  /**
   * Replace the reader of Claude Code's own credential store. Absent reads the real store — the
   * credentials file, or the macOS Keychain on darwin. A test supplies a synthetic reader so no
   * case runs a real `security` command, reads the user's own credential file, or writes one.
   * The returned value keeps the scopes the source itself declared separate from the session
   * shape this plugin records.
   */
  readonly claudeCredentialSource?: () => ClaudeSourceCredential | undefined
  /**
   * Replace the transport one Claude Messages request is issued through. Absent uses this
   * plugin's own Bun transport, exactly as a deployment does. A test supplies a synthetic
   * transport so a successful request can be observed without a real runtime, the same way the
   * `policy_limits` and organization transports are injected.
   */
  readonly claudeMessagesFetch?: FetchFn
}

/**
 * Decide one tool call against the accepted policy of the accounts its session uses.
 *
 * Evaluated per execution rather than once when the agent is created, so a managed policy
 * adopted long afterwards still stops the call, and a restriction that is no longer present
 * stops denying.
 *
 * Every tool the calling session runs is decided — including tools another plugin
 * registered: this build has no verified per-tool capability mapping, so a restriction it
 * cannot prove inapplicable must stop the operation rather than be skipped because the
 * plugin classified the operation too narrowly. The decision reads only the accounts THIS
 * session actually routed to, so one session's restriction can never reach another, and a
 * session with no bound account is never affected.
 * @param input - the call, the session's accounts, and the policy owner.
 * @returns a denial reason, or undefined to leave the call allowed.
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export function claudeToolPolicyDenial(input: {
  readonly execution: ToolExecutionIdentity
  readonly accountsFor: (sessionId: string) => ReadonlySet<string> | undefined
  readonly decide: (account: string, tool: string) => ToolPolicyDecision
}): string | undefined {
  const { execution } = input
  const sessionId = execution.agent === undefined ? undefined : String(execution.agent.session.id)
  if (sessionId === undefined) return undefined
  const accounts = input.accountsFor(sessionId)
  if (accounts === undefined || accounts.size === 0) return undefined
  for (const account of accounts) {
    const decision = input.decide(account, execution.name)
    if (decision.decision !== 'deny') continue
    // Model-facing: names the refusal, its stable code and — for a `policy_limits` refusal —
    // the registered key and fixed reason, never the remote document or any of its values.
    const named = decision.key === undefined
      ? ''
      : `; the accepted policy_limits document refuses "${decision.key}" (${decision.reason ?? 'denied'})`
    return `Managed policy${decision.code === undefined ? '' : ` (${decision.code})`} refuses the `
      + `"${execution.name}" tool for this session's bound subscription account${named}`
  }
  return undefined
}

/** ChatGPT reset-credit reads and spends. Absent when the Codex provider is not registered. */
interface CodexResetCreditOps {
  list(account: string, signal: AbortSignal): Promise<ResetCreditList>
  consume(account: string, creditId: string, redeemRequestId: string, signal: AbortSignal): Promise<ResetCreditConsumeResult>
}

/** A cached credit list, or a failure held through its cooldown. */
interface CreditCacheHit {
  at: number
  value: ResetCreditList
  error?: undefined
  cooldownMs?: undefined
}

interface CreditCacheMiss {
  at: number
  value?: undefined
  error: unknown
  cooldownMs: number
}

type CreditCacheEntry = CreditCacheHit | CreditCacheMiss

/** Failures worth holding. A missing login or a cancelled call must stay retryable. */
function cacheableCreditError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false
  if (isMissingOrInvalidCredential(error)) return false
  return !(error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
}

/**
 * The account dimensions an owner other than the credential store reports.
 * Every member is optional: an owner with nothing to say leaves its dimension
 * absent, which the client renders as "not reported" rather than as healthy.
 * @internal Exported for the projection's tests; not part of the plugin's public surface.
 */
export interface AccountStateReport {
  /** Overrides the credential dimension (a parked re-login, a replaced source). */
  credential?: CredentialStatus
  availability?: AvailabilityStatus
  protocol?: ProtocolStatus
  profile?: ProfileStatus
  policy?: PolicyStatus
  /**
   * The independent `policy_limits` dimension, projected by its own owner. Absent while that
   * owner reports nothing for the account, so a status read never presents an unread
   * restriction state as a healthy one.
   */
  policyLimits?: PolicyLimitsStatus
}

/**
 * Read one account's locally recorded state without any provider request. The
 * plugin supplies this over its own state owners (pool health, protocol-block
 * store, account maintenance); absent means the account is reported from the
 * credential store alone.
 */
type AccountStateReader = (provider: ProviderId, account: string) => AccountStateReport | undefined | Promise<AccountStateReport | undefined>

/**
 * Fold one pool cooldown record into the account dimensions it describes.
 *
 * The pool's reason decides the dimension: a credential refusal is a re-login,
 * never a quota cooldown, and a stated enforcement refusal is neither — which is
 * exactly the distinction the Settings card has to show.
 * @param record - the account's longest-lived unexpired cooldown, when any.
 * @returns the dimensions the record states, or undefined when it states none.
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export function cooldownDimensions(record: { unavailableUntil: number; reason: string } | undefined): AccountStateReport | undefined {
  if (record === undefined) return undefined
  const until = record.unavailableUntil
  if (isAuthCooldownReason(record.reason)) {
    return { credential: { state: 'reauth_required', code: 'REAUTH_REQUIRED', until } }
  }
  if (record.reason === ENFORCEMENT_CODE) {
    return { availability: { state: 'refused', code: 'ENFORCEMENT_REFUSAL', until } }
  }
  if (record.reason === QUOTA_EXCEEDED_CODE) {
    return { availability: { state: 'cooling', code: 'QUOTA_EXHAUSTED', until } }
  }
  if (record.reason === 'RATE_LIMIT') {
    return { availability: { state: 'cooling', code: 'RATE_LIMITED', until } }
  }
  if (record.reason === 'TIMEOUT') {
    return { availability: { state: 'transient', code: 'REQUEST_TIMEOUT', until } }
  }
  if (record.reason === 'HTTP_402' || record.reason === 'HTTP_404') {
    return { availability: { state: 'transient', code: 'MODEL_UNAVAILABLE', until } }
  }
  if (record.reason === 'SERVER' || record.reason === 'EMPTY_RESPONSE') {
    return { availability: { state: 'transient', code: 'PROVIDER_UNAVAILABLE', until } }
  }
  return { availability: { state: 'transient', code: 'PROVIDER_ERROR', until } }
}
/**
 * How one stored Claude credential is owned, as the Settings surface reports it.
 *
 * A pure projection of the stored record: it reads no credential source and performs no
 * request, so a status or account-list read never touches Claude Code's store.
 * @param session - the stored session.
 * @returns the mode, whether an external store owns the credential, and whether this plugin's
 *   coordination with that holder is unproven.
 */
function credentialOwnershipStatus(session: ClaudeSession): CredentialOwnershipStatus {
  const mode = claudeCredentialModeOf(session)
  return {
    mode,
    external: claudeCredentialIsExternal(mode),
    ...claudeCredentialCoordinationUnproven(mode) ? { coordinationUnproven: true as const } : {},
  }
}

/**
 * Route one credential refresh to the path its ownership mode allows.
 *
 * The manager's refresh selector usually sees only credentials this plugin owns, but that is not
 * a guarantee: a mode change landing between the manager's own load and its refresh hands this
 * selector a record whose ownership has moved. Every mode is therefore routed explicitly, and the
 * read-only one never falls through to this plugin's own grant — it is served from its external
 * source, checked against the reference the manager already holds, or the refresh stops. The
 * plugin's store is deliberately not read again here: this runs while the manager holds its own
 * durable lock on that account, and a second read through the same lock would deadlock.
 * @param session - the credential the refresh cycle is about to spend.
 * @param deps - the sync opt-in, the one credential-source reader and a warning sink.
 * @returns the credential to store.
 */
export function refreshForClaudeOwnership(
  session: ClaudeSession,
  deps: {
    readonly syncClaudeCodeCredentials: boolean
    readonly readSource: () => ClaudeSourceCredential | undefined
    readonly onWarn?: (message: string) => void
  },
): Promise<ClaudeSession> {
  switch (resolveClaudeCredentialMode(session)) {
    case 'read-only-import':
      return Promise.resolve(resolveClaudeReadOnlyRefresh(session, deps.readSource))
    case 'legacy-writeback':
      return deps.syncClaudeCodeCredentials
        ? refreshClaudeSynced(session, refreshClaude, deps.onWarn)
        : refreshClaude(session)
    case 'independent-oauth':
      return refreshClaude(session)
  }
}

/**
 * Auth operations behind the `/subscriptions-auth` RPC channel: start/complete
 * OAuth attempts in the background, feed pasted codes, cancel, log out, and
 * answer usage lookups.
 *
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
/**
 * The identity gate the auth lifecycle runs a Claude credential mutation behind.
 *
 * The real composition supplies the durable continuation state; a composition that owns no such
 * state leaves the gate unset and keeps its previous behaviour. Nothing here mints an identity:
 * `establish` prepares the account's owner, and `changed` runs the caller's write inside that
 * owner's gate and reports whether the change really published.
 */
export interface ClaudeAuthIdentityPort {
  /**
   * Establish the account's identity owner, which every change needs first.
   * @param account - the canonical account key.
   * @throws Error when the account's generation could not be established.
   */
  establish(account: string): Promise<void>
  /**
   * Run one whole identity change, the caller's credential mutation included.
   *
   * A commit that throws keeps its own error: the change is reported fail-closed, and the caller
   * still sees the failure its own write produced.
   * @param account - the canonical account key.
   * @param change - which identity change this is.
   * @param commit - the credential mutation itself.
   * @throws Error when the change was refused or did not settle; the commit's own error otherwise.
   */
  changed(
    account: string,
    change: 'login' | 'logout' | 'removal' | 'ownership',
    commit: () => Promise<void>,
  ): Promise<void>
}

export class SubscriptionsAuthController implements AuthController {
  /** Last failed provider operation, reported as a fixed code until the next success. */
  private lastError = new Map<ProviderId, ProviderOperationFailure>()
  /**
   * Device-flow logins whose poll already settled but whose token exchange +
   * persist is still running. Between those two moments the attempt is gone
   * from the flow manager (busy=false) while no session exists yet
   * (loggedIn=false) — counting this window as busy keeps the Settings page
   * polling until the card can show the real outcome.
   */
  private finalizing = new Set<ProviderId>()

  /** In-flight OAuth completions, one per provider at most. */
  private completions = new Map<ProviderId, Promise<void>>()

  /** Cursor browser logins, keyed by the claim that started them. */
  private cursorLogins = new Map<number, CursorLoginHandle>()

  /**
   * Per-provider claim counter. Everything that takes ownership of a
   * provider's session — starting a login, importing Claude Code credentials,
   * cancelling, logging out — bumps it, and a session write carrying an older
   * number has been superseded and is dropped.
   *
   * The counter is what makes a late OAuth completion safe: an attempt leaves
   * `OAuthFlowManager`'s pending map the moment its callback delivers the
   * code, while the token exchange that follows can still run for seconds. For
   * that whole window `pending(provider)?.cancel()` is a no-op, so ownership
   * cannot be read off the flow manager.
   */
  private claims = new Map<ProviderId, number>()

  /**
   * Commit one Claude credential behind the identity gate.
   *
   * The account's owner is established first, the change closes the request gate synchronously,
   * and the caller's write is the change's own operation. A refused or failed write therefore
   * publishes nothing and leaves the account closed, rather than reporting a login that did not
   * happen.
   * @param account - the canonical account key.
   * @param change - which identity change this is.
   * @param commit - the credential mutation itself.
   * @throws Error when the account's identity could not be established or the change did not settle.
   */
  private async commitClaudeIdentity(
    account: string,
    change: 'login' | 'logout' | 'removal' | 'ownership',
    commit: () => Promise<void>,
  ): Promise<void> {
    const identity = this.claudeIdentity
    if (identity === undefined) {
      // An isolated controller composition that owns no durable continuation state keeps its
      // previous behaviour. The plugin's own composition always injects the port, and a test that
      // proves that is what keeps this branch out of production.
      await commit()
      return
    }
    await identity.establish(account)
    await identity.changed(account, change, commit)
  }

  /** Shared local usage snapshots even when account pooling is disabled. */
  private readonly usageCache: PoolUsageTracker

  /** Cached reset-credit lists, keyed `provider/account`. Not consulted by pool selection. */
  private readonly creditCache = new Map<string, CreditCacheEntry>()

  /** One in-flight list per account generation, so a spend cannot join a stale read. */
  private readonly creditInflight = new Map<string, { epoch: number; promise: Promise<ResetCreditList> }>()

  /** Bumped when a list must not be written back (logout, or a successful spend). */
  private readonly creditEpoch = new Map<string, number>()

  constructor(
    private readonly flows: OAuthFlowManager,
    /** Device-flow attempts (copilot); polled in the background like the loopback flows. */
    private readonly deviceFlows: DeviceFlowManager,
    /** Announces an auth-state change so catalog readers re-query (fires `llm/adapters-updated`). */
    private readonly onAuthChanged: (
      provider: ProviderId,
      account?: string,
      reason?: 'login' | 'logout' | 'default' | 'ownership',
    ) => void,
    /** Lazy attachment-store lookup for the `image` endpoint. */
    private readonly resolveAttachments: () => AttachmentStore | undefined,
    /** Usage lookups for providers that expose a usage endpoint. */
    private readonly usageFetchers: UsageFetchers = {},
    /**
     * Reads the Claude Code session from its own store. Constructor-injected so
     * tests can drive both login paths without a real credential store; the
     * plugin itself always uses the default.
     */
    private readonly readClaudeCreds: () => ClaudeSession | undefined = readClaudeCodeCredentials,
    /** Usage snapshots shared with routing; absent only in isolated controller compositions. */
    poolUsage: PoolUsageTracker | undefined = undefined,
    /** Antigravity OAuth/runtime configuration. */
    private readonly antigravityConfig: Config['antigravity'] = {},
    /** ChatGPT reset-credit operations. Other providers never call them. */
    private readonly resetCreditOps: CodexResetCreditOps | undefined = undefined,
    /**
     * Carries an account's frozen device identity onto a session a fresh authorization
     * produced. Injected so both login paths can be driven without a token store; the
     * plugin itself reads the stored session for that account, because re-authorizing
     * must not change the device the account presents.
     */
    private readonly preserveClaudeIdentity: (
      session: ClaudeSession,
    ) => Promise<ClaudeSession> = async session => session,
    /**
     * The account pool's view of one account, for the `usage` endpoint's
     * attribution line. Undefined while the pool is disabled, which is also
     * when nothing routes around a parked account.
     */
    private readonly poolState: (
      provider: ProviderId,
      account: string,
    ) => Promise<UsagePoolState | undefined> = () => Promise.resolve(undefined),
    /** Local identity reconciliation, shared with the registered model routes. */
    private readonly beforeRead: () => Promise<void> = () => Promise.resolve(),
    /**
     * Locally recorded per-account dimensions beyond the credential store — pool
     * cooldowns, protocol blocks, account maintenance. Read without any provider
     * request, and absent in compositions that own none of that state.
     */
    private readonly accountState: AccountStateReader | undefined = undefined,
    /**
     * Provider routes this plugin refused to register for this Host, so the
     * status projection states the reason instead of an unexplained logout.
     */
    private readonly refusedRoutes: readonly ProviderId[] = [],
    /**
     * The identity gate Claude's credential mutations run behind; absent keeps an isolated
     * composition's previous behaviour, and the real composition always supplies one.
     */
    private readonly claudeIdentity: ClaudeAuthIdentityPort | undefined = undefined,
  ) {
    this.usageCache = poolUsage ?? new PoolUsageTracker((provider, account) => {
      const fetcher = this.usageFetchers[provider]
      return fetcher === undefined ? undefined : lifecycle => fetcher(account, usageReadSignal(lifecycle))
    })
  }

  /** Append one safe refresh-diagnostic line; a failed write never changes the read. */
  private traceUsageRefresh(trace: UsageRefreshTrace): void {
    const enabledFile = dshHomePath('plugins', 'subscriptions', 'usage-refresh.enabled')
    if (!existsSync(enabledFile)) return
    void appendUsageRefreshTrace(dshHomePath('plugins', 'subscriptions', 'usage-refresh.log'), trace)
      .catch(() => { /* Diagnostics must never change a usage read. */ })
  }

  /** Record the safe cache outcome of one explicit usage refresh. */
  private traceUsageOutcome(
    mode: UsageRefreshMode,
    provider: ProviderId,
    account: string,
    startedAt: number,
    usage: ProviderUsage,
  ): void {
    this.traceUsageRefresh({
      at: startedAt,
      provider,
      account,
      mode,
      phase: 'ok',
      durationMs: Date.now() - startedAt,
      ...usage.cache?.state === undefined ? {} : { state: usage.cache.state },
      ...usage.cache?.error === undefined ? {} : { reason: usage.cache.error },
      ...usage.cache?.errorCode === undefined ? {} : { errorCode: usage.cache.errorCode },
      ...usage.cache?.cause === undefined ? {} : { cause: usage.cache.cause },
      ...usage.cache?.causeCode === undefined ? {} : { causeCode: usage.cache.causeCode },
      ...usage.cache?.status === undefined ? {} : { status: usage.cache.status },
      ...usage.cache?.code === undefined ? {} : { code: usage.cache.code },
    })
  }

  async usage(provider: ProviderId, account: string, signal: AbortSignal, force = false, refresh = false): Promise<ProviderUsage> {
    const mode: UsageRefreshMode | undefined = force ? 'force' : refresh ? 'refresh' : undefined
    const startedAt = Date.now()
    if (mode !== undefined) {
      this.traceUsageRefresh({ at: startedAt, provider, account, mode, phase: 'start' })
    }
    try {
      await this.beforeRead()
      signal.throwIfAborted()
      const usage = force || refresh
        ? await this.usageCache.refreshSnapshot(provider, account, force)
        : this.usageCache.snapshotFor(provider, account)
      signal.throwIfAborted()
      if (!usage.supported) {
        if (mode !== undefined) this.traceUsageOutcome(mode, provider, account, startedAt, usage)
        return usage
      }
      // Both additions are plugin-local state read without a round trip, so a
      // provider or composition without them answers exactly as before.
      const rateLimit = unifiedRateLimitFor(provider, account)
      const pool = await this.poolState(provider, account)
      const result = {
        ...usage,
        ...rateLimit === undefined ? {} : { rateLimit },
        ...pool === undefined ? {} : { pool },
      }
      if (mode !== undefined) this.traceUsageOutcome(mode, provider, account, startedAt, result)
      return result
    } catch (error) {
      if (mode !== undefined) {
        const errorCode = usageRefreshErrorCode(error)
        this.traceUsageRefresh({
          at: startedAt,
          provider,
          account,
          mode,
          phase: 'error',
          durationMs: Date.now() - startedAt,
          ...usageFailureFacts(error),
          ...errorCode === undefined ? {} : { errorCode },
        })
      }
      throw error
    }
  }

  listResetCredits(provider: ProviderId, account: string, signal: AbortSignal, force = false): Promise<ResetCreditList> {
    const ops = this.resetCreditOps
    if (provider !== 'codex' || ops === undefined) return Promise.resolve({ supported: false })
    const key = `${provider}/${account}`
    const cached = this.creditCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < (cached.cooldownMs ?? USAGE_TTL_MS)) {
      if (cached.value === undefined) return Promise.reject(cached.error)
      if (!force) return Promise.resolve(cached.value)
    }
    return this.fetchCreditList(ops, key, account, signal)
  }

  async consumeResetCredit(
    provider: ProviderId,
    account: string,
    creditId: string,
    redeemRequestId: string,
    signal: AbortSignal,
  ): Promise<ResetCreditConsumeResult> {
    const ops = this.resetCreditOps
    if (provider !== 'codex' || ops === undefined) throw new Error('ChatGPT reset credits are unavailable')
    const result = await ops.consume(account, creditId, redeemRequestId, signal)
    this.forgetResetCredits(provider, account)
    this.usageCache.invalidate(provider, account)
    return result
  }

  /** Drop cached credit lists for one account, or every account of a provider. */
  forgetResetCredits(provider: ProviderId, account?: string): void {
    const bump = (key: string): void => {
      this.creditEpoch.set(key, (this.creditEpoch.get(key) ?? 0) + 1)
      this.creditCache.delete(key)
    }
    if (account !== undefined) {
      bump(`${provider}/${account}`)
      return
    }
    const prefix = `${provider}/`
    const keys = new Set([...this.creditCache.keys(), ...this.creditEpoch.keys(), ...this.creditInflight.keys()])
    for (const key of keys) {
      if (key.startsWith(prefix)) bump(key)
    }
  }

  /** Join the in-flight list for this generation, or start one. Failures cool down like usage. */
  private fetchCreditList(
    ops: CodexResetCreditOps,
    key: string,
    account: string,
    signal: AbortSignal,
  ): Promise<ResetCreditList> {
    const epoch = this.creditEpoch.get(key) ?? 0
    const pending = this.creditInflight.get(key)
    if (pending !== undefined && pending.epoch === epoch) return pending.promise
    const request = ops.list(account, signal).then(
      (value) => {
        if ((this.creditEpoch.get(key) ?? 0) === epoch) {
          this.creditCache.set(key, { at: Date.now(), value })
        }
        return value
      },
      (error: unknown) => {
        if ((this.creditEpoch.get(key) ?? 0) === epoch && cacheableCreditError(error, signal)) {
          const retryAfterMs = error instanceof OAuthEndpointError ? error.retryAfterMs : undefined
          this.creditCache.set(key, {
            at: Date.now(),
            error,
            cooldownMs: retryAfterMs ?? USAGE_TTL_MS,
          })
        }
        throw error
      },
    ).finally(() => {
      if (this.creditInflight.get(key)?.promise === request) this.creditInflight.delete(key)
    })
    this.creditInflight.set(key, { epoch, promise: request })
    return request
  }

  async readImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<ImageBytesResult> {
    const attachments = this.resolveAttachments()
    if (attachments === undefined) {
      throw new Error('no attachment service is mounted; generated-image bytes are unavailable')
    }
    const stored = await attachments.readImage(ref, signal)
    return { mediaType: stored.ref.mediaType, dataBase64: Buffer.from(stored.data).toString('base64') }
  }

  async readVideo(name: string, signal: AbortSignal): Promise<VideoBytesResult> {
    // The RPC layer validated `name` down to a bare file name, so this join
    // cannot escape the videos directory.
    const data = await readFile(join(videosDirectory(), name), { signal })
    return { mediaType: 'video/mp4', dataBase64: data.toString('base64') }
  }

  async status(provider: ProviderId): Promise<ProviderStatus> {
    const entries = await listAccounts(provider)
    const pendingRotations = await pendingRotationAccounts(provider)
    const failure = this.lastError.get(provider)
    // A status read is a read: it uses the credential store and this plugin's
    // own recorded state, and never contacts the provider.
    const accounts = await Promise.all(entries.map(async ({ key, session }, index): Promise<AccountStatus> => {
      const account = accountOf(provider, session)
      const plan = planOf(provider, session)
      const reported = await this.accountState?.(provider, key)
      return {
        key,
        isDefault: index === 0,
        expiresAt: session.expiresAt,
        // The roster itself is the credential evidence: this account has a
        // stored authorization. A re-login requirement is stated by the
        // dimension's own owner instead of being guessed from a cooldown. A
        // rotation marker the journal still holds is a second source: recovery
        // could not confirm which credential is current, so the account reports
        // needing re-authentication until it is resolved.
        credential: reported?.credential
          ?? (pendingRotations.has(key) ? { state: 'reauth_required' } : { state: 'ready' }),
        ...provider !== 'claude' ? {} : { credentialOwnership: credentialOwnershipStatus(session as ClaudeSession) },
        ...account === undefined ? {} : { account },
        ...plan === undefined ? {} : { plan },
        ...reported?.availability === undefined ? {} : { availability: reported.availability },
        ...reported?.protocol === undefined ? {} : { protocol: reported.protocol },
        ...reported?.profile === undefined ? {} : { profile: reported.profile },
        ...reported?.policy === undefined ? {} : { policy: reported.policy },
        ...reported?.policyLimits === undefined ? {} : { policyLimits: reported.policyLimits },
      }
    }))
    return {
      busy: this.flows.isBusy(provider) || this.deviceFlows.isBusy(provider) || this.finalizing.has(provider),
      accounts,
      ...failure === undefined ? {} : { lastError: failure },
      ...this.refusedRoutes.includes(provider) ? { unavailable: 'CLAUDE_HOST_INCOMPATIBLE' as const } : {},
    }
  }

  async login(provider: ProviderId, method?: LoginMethod): Promise<{ authorizeUrl: string; userCode?: string }> {
    if (provider === 'claude' && method === 'manual') {
      // Cross-device: the browser authorizes elsewhere and shows the code, so this attempt
      // opens no loopback listener and the code arrives through the paste path.
      const attempt = await this.flows.start('claude', claudeFlow, { manual: true })
      this.completions.set('claude', this.complete('claude', attempt, this.claim('claude')))
      return { authorizeUrl: attempt.authorizeUrl }
    }
    if (provider === 'claude' && method !== 'oauth') {
      const imported = this.readClaudeCreds()
      if (imported !== undefined) {
        // An OAuth attempt may be in flight from an earlier click — the user
        // logged in through the CLI meanwhile. Claiming supersedes it whether
        // it is still waiting for its code or already exchanging one; the
        // cancel on top of that frees the listener, so `busy` clears and the
        // still-open browser tab cannot finish the flow.
        const claim = this.claim('claude')
        this.flows.pending('claude')?.cancel()
        // Keychain imports are bound and read-only: the credential stays Claude Code's, this
        // plugin reads it on every use, and it neither spends that account's refresh grant nor
        // writes a rotation back. `keychainBound` stays the fact a pre-existing record is
        // inferred from; the explicit mode is what this path records.
        const session: ClaudeSession = {
          ...imported,
          keychainBound: true,
          credentialOwnershipMode: 'read-only-import',
        }
        await this.commitClaudeIdentity(accountKeyOf('claude', session), 'login', async () => {
          // The claim is re-checked in the same synchronous stretch as the store call: establishing
          // the identity owner awaits, so the check that ran before it is no longer adjacent to this
          // write, and a claim that moved meanwhile must not persist a superseded import.
          if (this.claims.get('claude') !== claim) throw new Error('login cancelled')
          await this.persist('claude', session)
        })
        this.lastError.delete('claude')
        this.onAuthChanged('claude', accountKeyOf('claude', session), 'login')
        return { authorizeUrl: '' }
      }
      if (method === 'keychain') {
        throw new Error('no Claude Code credentials found; run `claude` and log in first, or choose the browser flow')
      }
      // No Claude Code CLI / credential store — fall back to interactive OAuth.
      const attempt = await this.flows.start('claude', claudeFlow)
      this.completions.set('claude', this.complete('claude', attempt, this.claim('claude')))
      return { authorizeUrl: attempt.authorizeUrl }
    }
    if (provider === 'claude') {
      // Explicit browser flow: skip the credential import entirely.
      const attempt = await this.flows.start('claude', claudeFlow)
      this.completions.set('claude', this.complete('claude', attempt, this.claim('claude')))
      return { authorizeUrl: attempt.authorizeUrl }
    }
    if (provider === 'copilot') {
      // Device flow: no redirect URI — the UI shows the user code while the
      // background task polls GitHub for the token.
      const attempt = await this.deviceFlows.start(provider, copilotDeviceFlow())
      this.finalizing.add(provider)
      void this.completeDevice(provider, attempt)
      return { authorizeUrl: attempt.verificationUrl, userCode: attempt.userCode }
    }
    if (provider === 'cursor') {
      // Browser login stays inside the SDK. The Settings page only opens the
      // URL; the key is stored when `done` resolves. `store: null` keeps the
      // key out of `~/.cursor/sdk/auth.json`.
      this.cancelCursorLogins()
      const claim = this.claim('cursor')
      const handle = beginCursorLogin()
      this.cursorLogins.set(claim, handle)
      this.finalizing.add('cursor')
      this.completions.set('cursor', this.finishCursorLogin(claim, handle.done))
      try {
        return { authorizeUrl: await handle.authorizeUrl }
      } catch (error) {
        handle.cancel()
        throw error
      }
    }
    const spec = provider === 'grok'
      ? await grokFlow()
      : provider === 'antigravity'
        ? antigravityFlow(resolveAntigravityOAuthConfig(this.antigravityConfig))
        : codexFlow
    const attempt = await this.flows.start(provider, spec)
    // Claimed only once the attempt exists: a rejected `start()` (one attempt
    // per provider) must not supersede the attempt already running.
    this.completions.set(provider, this.complete(provider, attempt, this.claim(provider)))
    return { authorizeUrl: attempt.authorizeUrl }
  }

  /**
   * Take ownership of a provider's session, superseding every older claim.
   * @param provider - the provider route.
   * @returns the claim number a later write checks itself against.
   */
  private claim(provider: ProviderId): number {
    const next = (this.claims.get(provider) ?? 0) + 1
    this.claims.set(provider, next)
    return next
  }

  /**
   * Drive one attempt to a stored session; records failures for the status
   * endpoint. The exchange runs unsupervised — the attempt is gone from the
   * flow manager as soon as its code arrives — so the result is stored only
   * while `claim` still owns the provider's session.
   */
  private async complete(provider: ProviderId, attempt: OAuthAttempt, claim: number): Promise<void> {
    try {
      const code = await attempt.waitCode()
      const exchanged = await this.exchange(provider, code, attempt)
      // Re-authorizing an account must not change the device it presents, so the earlier
      // identity is carried onto the fresh session before it is stored.
      const session = provider !== 'claude'
        ? exchanged
        : await this.preserveClaudeIdentity(exchanged as ClaudeSession) as StoredSession
      // Whoever claimed the session while the exchange ran owns it now, and
      // this result is stale. The check and the store call sit in one
      // synchronous stretch, and the store queues a write the moment it is
      // called, so a claim arriving after the check is ordered after this
      // write too.
      if (this.claims.get(provider) !== claim) return
      if (provider === 'claude') {
        await this.commitClaudeIdentity(accountKeyOf('claude', session), 'login', async () => {
          // The claim is re-checked in the same synchronous stretch as the store call: establishing
          // the identity owner awaits, so the check above is no longer adjacent to this write, and a
          // claim that moved meanwhile must not persist a superseded authorization.
          if (this.claims.get('claude') !== claim) throw new Error('login cancelled')
          await this.persist('claude', session)
        })
      } else {
        await this.persist(provider, session)
      }
      this.lastError.delete(provider)
      this.onAuthChanged(provider, accountKeyOf(provider, session), 'login')
    } catch (error) {
      // A failure is as stale as a success would have been: whoever claimed
      // the session while the exchange ran owns what the card shows, so a
      // superseded attempt must not put an error on a provider that has since
      // been imported, logged in again, or logged out.
      if (this.claims.get(provider) !== claim) return
      // A user-cancelled attempt is not a failure worth surfacing. Every
      // in-tree canceller claims first, so the guard above already covers
      // this; the check stands on its own so the invariant does not depend on
      // callers ordering the two.
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set(provider, providerFailure(error, 'login'))
      }
    }
  }

  /** Drive one device-flow attempt to a stored session (the copilot path of {@link complete}). */
  private async completeDevice(provider: ProviderId, attempt: DeviceAttempt): Promise<void> {
    try {
      const githubToken = await attempt.waitToken()
      const session = await completeCopilotLogin(githubToken)
      await this.persist(provider, session)
      this.lastError.delete(provider)
      this.onAuthChanged(provider, accountKeyOf(provider, session), 'login')
    } catch (error) {
      // A user-cancelled attempt is not a failure worth surfacing.
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set(provider, providerFailure(error, 'login'))
      }
    } finally {
      this.finalizing.delete(provider)
    }
  }

  private exchange(provider: ProviderId, code: string, attempt: OAuthAttempt): Promise<StoredSession> {
    switch (provider) {
      case 'codex':
        return exchangeCodexCode(code, attempt.pkce.verifier, attempt.redirectUri)
      case 'claude':
        return exchangeClaudeCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.state)
      case 'grok':
        return exchangeGrokCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.pkce.challenge)
      case 'copilot':
        // Device flow: exchange happens in completeDevice, never here.
        return Promise.reject(new Error('copilot uses the device flow; no authorization code to exchange'))
      case 'antigravity':
        return exchangeAntigravityCode(
          code,
          attempt.pkce.verifier,
          attempt.redirectUri,
          resolveAntigravityOAuthConfig(this.antigravityConfig),
          this.antigravityConfig,
        )
      case 'cursor':
        return Promise.reject(new Error('Cursor login finishes in the browser; there is no authorization code to exchange'))
    }
  }

  /** Store one Cursor login if this claim still owns the provider. */
  private async finishCursorLogin(claim: number, done: Promise<CursorSession>): Promise<void> {
    try {
      const session = await done
      if (this.claims.get('cursor') !== claim) return
      await this.persist('cursor', session)
      this.lastError.delete('cursor')
      this.onAuthChanged('cursor', accountKeyOf('cursor', session), 'login')
    } catch (error) {
      if (this.claims.get('cursor') !== claim) return
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set('cursor', providerFailure(error, 'login'))
      }
    } finally {
      this.finalizing.delete('cursor')
      this.cursorLogins.delete(claim)
    }
  }

  /** Abort every Cursor login this controller started. */
  private cancelCursorLogins(): void {
    for (const handle of this.cursorLogins.values()) handle.cancel()
  }

  private persist(provider: ProviderId, session: StoredSession): Promise<void> {
    // Keyed by the account's stable identity: re-logging the same account
    // updates in place, a different account appends.
    return saveAccountSession(provider, accountKeyOf(provider, session), session as never)
      .then(() => undefined)
  }

  /**
   * Settle once no OAuth completion is running for a provider.
   *
   * @internal Exported for tests only: a login's token exchange outlives the
   * `login()` call that started it, and a test asserting on what it stored
   * would otherwise have to guess at a timeout.
   */
  async settled(provider: ProviderId): Promise<void> {
    await this.completions.get(provider)
  }

  manual(provider: ProviderId, input: string): Promise<void> {
    if (provider === 'cursor') {
      return Promise.reject(new Error('Cursor login finishes in the browser; there is no code to paste'))
    }
    const attempt = this.flows.pending(provider)
    if (attempt === undefined) {
      return Promise.reject(new Error(`no ${provider} login attempt is in progress`))
    }
    attempt.manual(input)
    return Promise.resolve()
  }

  cancel(provider: ProviderId): Promise<void> {
    // Claiming covers the attempt whose code already arrived: it is no longer
    // pending, but its token exchange may still be on its way to a store write.
    this.claim(provider)
    this.flows.pending(provider)?.cancel()
    this.deviceFlows.pending(provider)?.cancel()
    if (provider === 'cursor') this.cancelCursorLogins()
    return Promise.resolve()
  }

  async logout(provider: ProviderId, account: string): Promise<void> {
    this.claim(provider)
    this.flows.pending(provider)?.cancel()
    this.deviceFlows.pending(provider)?.cancel()
    if (provider === 'cursor') this.cancelCursorLogins()
    if (provider === 'claude') {
      // The deletion is the identity change's own operation, so the account is closed to requests
      // before its credential is removed and stays closed unless the deletion really committed.
      const key = await resolveAccountKey('claude', account)
      await this.commitClaudeIdentity(key, 'logout', async () => {
        await deleteAccountSession('claude', account)
      })
    } else {
      await deleteAccountSession(provider, account)
    }
    this.lastError.delete(provider)
    this.onAuthChanged(provider, account, 'logout')
  }

  async setDefault(provider: ProviderId, account: string): Promise<void> {
    await setDefaultAccount(provider, account)
    this.onAuthChanged(provider, account, 'default')
  }

  /**
   * Persist one Claude account's credential-ownership mode.
   *
   * The change is a setting, not an authorization: this plugin's own OAuth flow is the only
   * thing that can produce an independently authorized credential, and an account this plugin
   * authorized itself has no external store to move to, so both directions are refused by
   * {@link planClaudeCredentialConversion}. Nothing else about the account changes — no token is
   * deleted, rewritten or re-authorized, the account keeps its key, and no background pass
   * touches any other account's mode.
   *
   * Moving onto `legacy-writeback` is the one conversion that may spend the same refresh grant
   * an external holder spends, so it needs the caller's explicit acknowledgement that the risk
   * was shown and accepted. That rule belongs to this server: a client's dialog is not what
   * makes the mode safe, and any other caller of the channel is held to the same statement. A
   * request that already names the account's current mode is an exact no-op — nothing is
   * written, so it needs no acknowledgement.
   * @param provider - the provider route; only `claude` owns an ownership mode.
   * @param account - the account key, canonical or a recorded alias.
   * @param mode - the mode to persist.
   * @param riskAcknowledged - whether the caller states the legacy-writeback risk was accepted.
   * @throws BadRequest when the account is unknown, the requested conversion is refused, or a
   *   real conversion onto legacy-writeback arrives unacknowledged.
   */
  async setCredentialOwnership(
    provider: ProviderId,
    account: string,
    mode: ClaudeCredentialMode,
    riskAcknowledged: boolean,
  ): Promise<void> {
    if (provider !== 'claude') {
      throw new BadRequest('credential ownership applies to the claude provider only')
    }
    const key = await resolveAccountKey('claude', account)
    const credential = await getAccountCredential('claude', key)
    if (credential === undefined) throw new BadRequest(`no claude account "${account}" is logged in`)
    const from = resolveClaudeCredentialMode(credential.session)
    if (from === mode) return
    if (mode === 'legacy-writeback' && riskAcknowledged !== true) {
      throw new BadRequest(
        'moving this account onto legacy-writeback spends the shared refresh grant and writes the '
        + 'rotation back to Claude Code\'s store; the request must state riskAcknowledged: true',
      )
    }
    const conversion = planClaudeCredentialConversion({
      from,
      to: mode,
      externallySourced: credential.session.keychainBound === true,
    })
    if (conversion.kind === 'refused') throw new BadRequest(conversion.message)
    // Conditional on the revision the mode was decided from: a rotation that landed while this
    // ran keeps its own record rather than being overwritten by one field's change. The save is the
    // identity change's own operation, so a refused compare-and-set publishes nothing and leaves
    // this account closed rather than counting a change that never committed.
    await this.commitClaudeIdentity(credential.key, 'ownership', async () => {
      const written = await saveAccountSession(
        'claude',
        credential.key,
        { ...credential.session, credentialOwnershipMode: mode },
        undefined,
        { expectedRevision: credential.revision },
      )
      if (!written) {
        throw new BadRequest('this account changed while the ownership mode was being saved; try again')
      }
    })
    // The mode decides the refresh path and the maintenance timer, so the caches built under
    // the previous mode are dropped; the credential itself is untouched.
    this.onAuthChanged('claude', credential.key, 'ownership')
  }
}

/**
 * The attribution one session's tool calls are judged by.
 *
 * A session is judged by the account its CURRENT request targets, never by every account it
 * has ever used: a session that moved from one Claude account to another, or from Claude to
 * another provider, must not keep answering to a retired account's restrictions. The
 * provider switch is observed on the committed request (`llm/stream`), not on a menu read,
 * and a request that names `claude` replaces the session's account set outright.
 *
 * A tool call dispatched for a session reads whatever is current at that instant; a call
 * already dispatched keeps the decision it was given, and a parallel child agent has its own
 * session, so no other session's policy can reach it.
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export function sessionAttribution(): {
  /** Record the provider of one committed model request for a session. */
  noteRequestOwner: (provider: string, sessionId: string | undefined) => void
  /** Record the account one committed Claude request targets, replacing any earlier one. */
  attributeAccount: (sessionId: string, account: string) => void
  /** The accounts the session's current request is judged by. */
  accountsFor: (sessionId: string) => ReadonlySet<string> | undefined
  /** Drop one session's attribution. */
  forgetSession: (sessionId: string) => void
  /** Drop every attribution of one account (logout, removal, rename). */
  forgetAccount: (account: string) => void
  /** Whether any session is still routing to this account. */
  hasAccount: (account: string) => boolean
} {
  const bySession = new Map<string, Set<string>>()
  return {
    noteRequestOwner: (provider, sessionId) => {
      if (sessionId === undefined) return
      // Another provider serves this session now, so no Claude account's policy may decide
      // its tool calls any more.
      if (provider !== 'claude') bySession.delete(sessionId)
    },
    attributeAccount: (sessionId, account) => { bySession.set(sessionId, new Set([account])) },
    accountsFor: sessionId => bySession.get(sessionId),
    forgetSession: (sessionId) => { bySession.delete(sessionId) },
    forgetAccount: (account) => {
      for (const [sessionId, accounts] of [...bySession]) {
        accounts.delete(account)
        if (accounts.size === 0) bySession.delete(sessionId)
      }
    },
    hasAccount: (account) => {
      for (const accounts of bySession.values()) {
        if (accounts.has(account)) return true
      }
      return false
    },
  }
}

/**
 * The maintenance cleanups this plugin has started and still owes.
 *
 * A release may be asynchronous, so it is tracked here the moment it starts: disposal waits
 * for every cleanup, and a rejection is reported through the warning sink instead of
 * surfacing as an unhandled rejection on a logout or a rename. The synchronous part of a
 * release — dropping the session's attribution — has already happened in the caller before
 * anything is tracked.
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export function ownedReleases(onWarn: (message: string) => void): {
  /** Track one started cleanup; the returned promise settles when it does. */
  track: (cleanup: Promise<void>, label: string) => Promise<void>
  /** Await every cleanup started so far. */
  drain: () => Promise<void>
} {
  const pending = new Set<Promise<void>>()
  return {
    track: (cleanup, label) => {
      const settling = cleanup.catch((error: unknown) => { onWarn(`${label}: ${errorChain(error)}`) })
      pending.add(settling)
      void settling.finally(() => { pending.delete(settling) })
      return settling
    },
    drain: async () => { await Promise.allSettled([...pending]) },
  }
}

/**
 * The classifier the managed-settings read reports a non-success response with.
 *
 * It is the reliability module's own classifier and bounded body reader, so a client-version
 * or permission refusal discovered on the settings endpoint carries exactly the decision —
 * including the hard-stop disposition — the Messages path produces. It classifies only: the
 * account-maintenance owner owns every side effect of a refusal it accepts, the shared
 * protocol-block record included, and awaits that before it refuses the request.
 * @returns the classifier the maintenance owner injects into its settings read.
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export function claudeSettingsFailureClassifier(): ClaudePolicyHttpClassifier {
  return async (response, context) => {
    let decided: ClaudeFailureDecision | undefined
    try {
      // The reliability helper reports its classified failure by throwing it; the ordered
      // decision it hands to `onDecision` is what this seam reports.
      await claudeHttpLlmError(response, {
        label: 'claude managed settings',
        profile: CLAUDE_PROTOCOL_PROFILE,
        onDecision: (decision) => { decided = decision },
      })
    } catch (error: unknown) {
      if (decided === undefined) throw error
    }
    if (decided === undefined) return undefined
    return {
      reason: decided.reason,
      ...decided.serverCode === undefined ? {} : { serverCode: decided.serverCode },
      ...decided.status === undefined ? {} : { status: decided.status },
      stage: decided.stage,
      scope: decided.scope,
      ...decided.retryDisposition === 'forbid' ? { retryDisposition: 'forbid' as const } : {},
      ...decided.retryAfterMs === undefined ? {} : { retryAfterMs: decided.retryAfterMs },
      outputDelivered: decided.outputDelivered,
      // The identity the caller was already reading under: never recomputed here.
      origin: context.origin,
      protocolFingerprint: context.protocolFingerprint,
    }
  }
}

  /**
   * The unified classifier for one failed `policy_limits` read.
   *
   * It reuses the same ordered reliability classifier the Messages and settings paths use —
   * no second regex lives here — and reports the reader's own vocabulary: a refusal the
   * classifier called final becomes `skipRetry`, so the reader stops rather than spending its
   * budget on it. It classifies only: it owns no side effect, and the shared protocol-block
   * record is written by the owner's failure handler, which is the plugin's single writer.
   * @returns the classifier the `policy_limits` owner injects into its read.
   * @internal Exported for tests only; not part of the plugin's public surface.
   */
export function claudePolicyLimitsFailureClassifier(): NonNullable<ClaudePolicyLimitsOptions['classifyFailure']> {
  return async (input) => {
    // The classifier reads `retry-after`; every other header it needs is not part of this
    // decision, so the synthetic response carries only what the shared rules read.
    const headers = new Headers()
    const retryAfter = input.headers.get('retry-after')
    if (retryAfter !== null) headers.set('retry-after', retryAfter)
    const response = new Response(input.body, { status: input.status, headers })
    let decided: ClaudeFailureDecision | undefined
    try {
      await claudeHttpLlmError(response, {
        label: 'claude policy limits',
        profile: CLAUDE_PROTOCOL_PROFILE,
        onDecision: (decision) => { decided = decision },
      })
    } catch (error: unknown) {
      if (decided === undefined) throw error
    }
    if (decided === undefined) return undefined
    // The reader's own failure vocabulary: a refusal the classifier called final is
    // terminal for both ends, and its fixed reason is carried without a response excerpt.
    return coreFailure(
      decided.retryDisposition === 'forbid' && decided.reason === CLIENT_VERSION_UNSUPPORTED_CODE
        ? 'unsupported'
        : 'request_failed',
      {
        status: input.status,
        reason: decided.reason,
        ...decided.retryDisposition === 'forbid' ? { skipRetry: true } : {},
      },
    )
  }
}

export function apply(ctx: Context, config: Config, internals: SubscriptionInternals = {}): void {
  const scheduling = resolvePoolScheduling(config.pool?.scheduling)
  const cachePolicy = resolveSubscriptionCachePolicy(config.cache)
  configureClaudeTransport(config.claudeTransportMaxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES)
  // Outbound requests (catalog discovery, the npm version lookup, token
  // refresh) must survive links where one TCP handshake exceeds Node's 250ms
  // The Bun transport child is a process. Disabling or reloading the plugin has to
  // take it down, or a reload leaves a live child holding a stdio pipe behind.
  ctx.effect(() => () => { void stopBridge() }, 'dsh-plugin-subscriptions: bun transport child')
  const preferences = new ProviderSettingsStore()
  const codexVersion = new CodexClientVersionCache()
  const providers = [...new Set(config.providers ?? [...PROVIDER_IDS])]
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  // Claude Code's credential store belongs to another application; writing a rotation
  // into it is opt-in, because a browser-authorized account never needs it.
  const syncClaudeCodeCredentials = config.syncClaudeCodeCredentials === true
  /**
   * The one reader of Claude Code's own credential store in this composition.
   *
   * The import path and every read-only credential use read through it, so the store is read
   * once per use and the injected test double never runs a real `security` command. It reports
   * the scopes the source itself declared alongside the session shape the plugin records, so a
   * read-only use can refuse a source that declares none.
   */
  const readClaudeCredentialSource: () => ClaudeSourceCredential | undefined =
    internals.claudeCredentialSource ?? readClaudeCodeCredentialSource
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error(`${name}: streamIdleTimeoutMs must be a positive finite number`)
  }
  const rateLimit = resolveRateLimitWait(config.rateLimit, `${name}: rateLimit`)
  const catalog = resolveCatalog(config.models)
  // The reliability route's Host prerequisite, read before any adapter is
  // registered and without any provider request. A Host that does not declare
  // the contract loses the Claude route and nothing else: refusing here is the
  // only honest alternative to running a retry guarantee this Host cannot keep.
  const failureRecoveryVersion: number | undefined = ctx.llm.failureRecoveryVersion
  const refused: ProviderId[] = []
  /**
   * Record that a route is not registered for this Host, so the status projection states the
   * fixed reason instead of an unexplained logout.
   * @param provider - the route this plugin did not register.
   */
  const refuseRoute = (provider: ProviderId): void => {
    if (!refused.includes(provider)) refused.push(provider)
  }
  /**
   * Withdraw that refusal once the Host provides what the route needs.
   * @param provider - the route that is registered again.
   */
  const allowRoute = (provider: ProviderId): void => {
    const at = refused.indexOf(provider)
    if (at >= 0) refused.splice(at, 1)
  }
  /**
   * The recording port the Claude route holds.
   *
   * The scoped injection below binds it to the Host's service for exactly as long as that
   * service is mounted, so the adapter reads one stable port while the route's lifetime is
   * decided by the service's own lifetime.
   */
  const claudeRecordPort = new ClaudeRequestRecordPort()
  // Validated at load, whether or not the Claude route ends up registered: a zero or
  // negative bound is a misconfiguration, and none of these values switches a
  // maintenance capability off, so it must not be silently ignored.
  const claudeMaintenanceConfig = resolveClaudeMaintenanceConfig({
    refreshLeadMs: CLAUDE_PREEMPT_MS,
    ...config.claudeMaintenance ?? {},
  })
  // A non-empty configured catalog is an explicit override: it wins over live
  // discovery entirely (schemastery injects [] for omitted arrays, so only a
  // non-empty list counts as configured).
  const overridden = new Set<ProviderId>(
    PROVIDER_IDS.filter(provider => (config.models?.[provider]?.length ?? 0) > 0),
  )
  const flows = new OAuthFlowManager()
  const deviceFlows = new DeviceFlowManager()
  const onWarn = (message: string): void => {
    ctx.logger.warn(`dsh-plugin-subscriptions: ${message}`)
  }
  // A refresh that spent its grant but crashed before the store write left a durable marker
  // beside the store. Recovery applies it only while the store still holds the credential the
  // rotation started from; the pass never deletes a credential and never blocks startup.
  void recoverPendingRefreshRotations({ onWarn }).then((report) => {
    for (const { provider, account } of report.unresolved) {
      onWarn(`refresh journal for ${provider}/${account} needs inspection`)
    }
  }, (error: unknown) => {
    onWarn(`the pending-refresh journal could not be recovered (${errorChain(error)})`)
  })
  /**
   * Which account each session's current request is judged by.
   *
   * Enforcement attribution only. The account-maintenance owner remains the single owner of
   * session bindings and their lifecycle; this answers one question at tool-execution time —
   * is THIS session, right now, bound to an account whose accepted policy refuses THIS tool.
   */
  const attribution = sessionAttribution()
  /**
   * The maintenance cleanups this plugin owes: a release may be asynchronous, so every one of
   * them is tracked and awaited by disposal, and a rejection is reported rather than becoming
   * an unhandled rejection on a logout or a rename.
   */
  const claudeReleases = ownedReleases(onWarn)
  /**
   * The durable owner of the Claude wire identity, the ATIS pin and the identity generation.
   *
   * One state per installation: the salt names accounts, the span store owns the wire identity and
   * the pin, and the generation store owns the epoch. It is created before any route registers and
   * its documents live in this plugin's own home beside the other private state.
   */
  const claudeContinuation = new ClaudeContinuationState({
    deadlineMs: resolveContinuationStateDeadlineMs(config),
    lockTimeoutMs: resolveContinuationStateLockTimeoutMs(config),
    root: dshHomePath('plugins', 'subscriptions', 'claude-continuation'),
    onWarn,
  })
  /**
   * Establish every Claude account the installation already holds.
   *
   * A request only reads and waits, so an account whose baseline was never established refuses
   * until this ran; a normal restart finds the baseline already recorded and leaves the count
   * alone. Started rather than awaited because registration must not block on private files, and
   * the refusal is fail-closed in the meantime.
   */
  /**
   * The startup hydration, as a settled result its consumers read.
   *
   * A promise rather than a flag, because the registration that builds the Claude route runs before
   * this finishes: a boolean sampled there would always look successful, and a hydration that failed
   * afterwards could never revoke the owner it had already passed on. The result states whether
   * startup completed, not whether any account is usable now — each request resolves its own
   * account's current identity, and an account a user repairs afterwards is usable without a restart.
   */
  const claudeContinuationReady: Promise<ClaudeContinuationReadiness> = (async () => {
    try {
      // The store's own key is the account key: it is what the adapter's credential resolution uses,
      // including a stored alias or a historical key whose session does not restate it.
      for (const { key } of await listAccounts('claude')) {
        const established = await claudeContinuation.initialize(key)
        if (established.kind !== 'advanced') {
          // One account's baseline could not be established — a state only that account's next
          // explicit change may judge. It is reported and left to that account; a route-wide failure
          // here would refuse every other account and outlive the user's own repair.
          onWarn(`claude continuation state for ${key} could not be established: ${established.reason}`)
        }
      }
      return { kind: 'ready' } as const
    } catch (error: unknown) {
      // Hydration that failed is not a healthy route: every Claude request reads this result and
      // refuses with the fixed code, so a startup that could not establish its accounts is never
      // mistaken for one that simply has none. Other providers are unaffected.
      const reason = `claude continuation state could not be hydrated (${errorChain(error)})`
      onWarn(reason)
      return { kind: 'failed', reason } as const
    }
  })()
  /**
   * The gate the auth lifecycle runs a Claude credential mutation behind.
   *
   * It establishes the account's owner first and then runs the caller's own write inside that
   * owner's synchronous transition: the request gate closes before the credential is touched, the
   * account's spans are dropped inside the same change, and only a write that really committed
   * publishes the new generation.
   */
  const claudeAuthIdentity: ClaudeAuthIdentityPort = {
    establish: async account => {
      // The auth side, not the request side: the owner is established even when the account's
      // generation is in a state only the change itself may judge, so a user's explicit login can
      // replace a known failed one without waiting for a restart.
      const owner = await claudeContinuation.establishForChange(account)
      if ('kind' in owner) {
        throw new Error(`the claude identity owner for this account could not be established (${owner.reason})`)
      }
    },
    changed: async (account, change, commit) => {
      const owner = claudeContinuation.owner(account)
      if ('kind' in owner) {
        throw new Error(`the claude identity change was refused (${owner.reason})`)
      }
      // The commit's own failure is kept: the transition reports it fail-closed, and the caller
      // must still see the error its own write produced instead of a replacement.
      let failure: unknown
      const transition = owner.changed(change, async () => {
        try {
          await commit()
        } catch (error: unknown) {
          failure = error
          throw error
        }
        // The account's maintenance state is released inside the same change and awaited: the new
        // identity must not inherit the previous one's timers and reads, and the request gate opens
        // only once that release really settled.
        await releaseClaudeAccountSettled(account)
      })
      const outcome = await transition.result
      if (outcome.kind === 'advanced') return
      if (failure !== undefined) throw failure
      throw new Error(`the claude identity change did not complete (${outcome.reason})`)
    },
  }
  /**
   * The Claude route's continuation options: the durable owner every request is prepared under, and
   * the startup hydration each request reads as a settled result.
   */
  const claudeRouteOptions = {
    continuation: claudeContinuation,
    continuationReady: claudeContinuationReady,
  }
  /**
   * Release one account's maintenance state and wait for it to settle.
   *
   * This is the awaitable form an identity change's own operation uses: the change publishes only
   * after its release settled, and a release failure fails the change instead of being tracked as
   * disposal accounting.
   * @param account - the account whose maintenance state is released.
   */
  const releaseClaudeAccountSettled = async (account: string): Promise<void> => {
    attribution.forgetAccount(account)
    claudeOrgPins?.forget(account)
    const limits = claudePolicyLimits
    if (limits !== undefined) await limits.releaseAccount(account)
    const controller = claudeMaintenance
    if (controller !== undefined) await controller.releaseAccount(account)
  }
  /**
   * Release one account's maintenance state. The attribution change is synchronous; only the
   * owner's own cleanup is asynchronous, and it is tracked from the moment it starts.
   */
  const releaseClaudeAccount = (account: string): void => {
    // The identity generation is not advanced here: the durable owner advances it inside the
    // identity change that really committed a new credential, so a release that merely drops this
    // account's local state cannot move the epoch or reuse another account's.
    attribution.forgetAccount(account)
    // The identity ends here: its policy document and its pin judgments are dropped, and the
    // owner's own I/O is aborted and awaited like every other release.
    claudeOrgPins?.forget(account)
    const limits = claudePolicyLimits
    if (limits !== undefined) {
      void claudeReleases.track(
        Promise.resolve().then(() => limits.releaseAccount(account)),
        'claude policy_limits account release failed',
      )
    }
    const controller = claudeMaintenance
    if (controller === undefined) return
    void claudeReleases.track(
      Promise.resolve().then(() => controller.releaseAccount(account)),
      'claude maintenance account release failed',
    )
  }
  /**
   * Release one session's maintenance binding, keeping the attribution change synchronous.
   *
   * Every owner's cleanup is awaited here, not merely started: a caller that continues after
   * this promise settles can rely on the binding being gone everywhere, which is what makes
   * the caller's next readiness check decide on settled state.
   * @returns a promise that settles once every owner's cleanup for this session has.
   */
  const releaseClaudeSession = (sessionId: string): Promise<void> => {
    const accounts = attribution.accountsFor(sessionId)
    attribution.forgetSession(sessionId)
    // A cadence belongs to a live binding: the owner suspends the account itself once this
    // was its last session, and keeps the adopted document while it is merely paused.
    const cleanups: Promise<void>[] = []
    const limits = claudePolicyLimits
    if (limits !== undefined && accounts !== undefined) {
      for (const account of accounts) {
        cleanups.push(claudeReleases.track(
          Promise.resolve().then(() => limits.releaseSession(account, sessionId)),
          'claude policy_limits session release failed',
        ))
      }
    }
    const controller = claudeMaintenance
    if (controller !== undefined) {
      cleanups.push(claudeReleases.track(
        Promise.resolve().then(() => controller.releaseSession(sessionId)),
        'claude maintenance session release failed',
      ))
    }
    return Promise.all(cleanups).then(() => undefined)
  }
  // Optional: resolves ImageBlock references to bytes for vision-capable
  // models. Resolved per request — the attachments service may start after
  // this plugin's apply, so a one-time capture would stay undefined forever.
  const resolveAttachments = (): AttachmentStore | undefined =>
    ctx.get('attachments') as AttachmentStore | undefined

  // Registration handles are kept so an auth-state change can re-announce the
  // route (`replace` fires `llm/adapters-updated`), which makes the web model
  // picker re-query `listModels` and show/hide the provider.
  const handles = new Map<string, AdapterRegistrationHandle>()
  // The constructed adapters, for the pool route to fail over between.
  const adapters = new Map<ProviderId, AccountAwareAdapter>()
  // Per-provider account token managers; also the pool's account lists.
  const accountTokens = new Map<ProviderId, AccountTokenManager<StoredSession>>()
  // Pool state, assigned when the pool route registers below; read here so an
  // auth change immediately recovers the account's cooling members and
  // refreshes its quota snapshot.
  let poolHealth: PoolHealthRegistry | undefined
  let poolUsage: PoolUsageTracker | undefined
  let poolAdapter: PoolAdapter | undefined
  let subscriptionsAuth: SubscriptionsAuthController | undefined
  const imagePool = new ImageAccountPool({
    enabled: config.pool?.enabled !== false && (config.pool?.autoAccounts ?? true),
    onWarn,
  })
  let codexTokens: AccountTokenManager<CodexSession> | undefined
  // DSH's search-provider probe is synchronous, so the Codex gate reads a cached flag
  // that every login, logout and credential death refreshes.
  let codexAccountPresent = false
  const refreshCodexPresence = (): void => {
    void codexTokens?.list().then(
      (accounts) => { codexAccountPresent = accounts.length > 0 },
      () => undefined,
    )
  }
  let cacheActive = true
  const authChanged = (provider: ProviderId, account?: string, reason: 'login' | 'logout' | 'default' | 'ownership' = 'login'): void => {
    if (!cacheActive) return
    if (provider === 'codex') refreshCodexPresence()
    poolAdapter?.invalidate()
    if (reason !== 'default') {
      subscriptionsAuth?.forgetResetCredits(provider, account)
      if (provider === 'codex' || provider === 'grok') imagePool.clear(provider, account)
      if (provider === 'copilot') copilotAdapter?.clearReplayState()
      if (provider === 'codex') codexAdapter?.clearReplayState()
      adapters.get(provider)?.clearAccountCatalog(account)
      poolHealth?.clear(provider, account)
      poolUsage?.forget(provider, account)
      forgetUnifiedRateLimit(provider, account)
      // The account's own maintenance release is not done here: for Claude it runs inside the
      // identity change that committed the new credential, awaited before the request gate opens
      // again. A post notification that released a second time would race that owner.
    }
    handles.get(provider)?.replace([provider])
    // An explicit login initializes only its own catalogue. Default-account changes
    // and ordinary token renewal reuse account-scoped snapshots without any query.
    if (reason === 'login' && account !== undefined) {
      void adapters.get(provider)?.refreshOwnCatalog?.(provider, account).catch(error => {
        if (cacheActive) onWarn(`catalogue initialization failed for ${provider}: ${errorChain(error)}`)
      })
    }
  }
  const renameAccountState = async (provider: ProviderId, from: string, to: string): Promise<void> => {
    poolUsage?.renameAccount(provider, from, to)
    poolHealth?.renameAccount(provider, from, to)
    renameUnifiedRateLimit(provider, from, to)
    imagePool.renameAccount(provider, from, to)
    // The owner keys its state by the account key the store reported; the retired key's
    // state is dropped rather than left addressing a key the store no longer resolves, and
    // the account's next real request binds it again under the canonical key.
    if (provider === 'claude') releaseClaudeAccount(from)
    subscriptionsAuth?.forgetResetCredits(provider, from)
    subscriptionsAuth?.forgetResetCredits(provider, to)
    const move = async (label: string, operation: () => Promise<void>): Promise<void> => {
      try { await operation() } catch (error: unknown) {
        onWarn(`${label} could not persist renamed account state (${errorChain(error)})`)
      }
    }
    // Policy projection is installed before either durable migration can fail.
    await Promise.all([
      move('account policy', () => preferences.renameAccount(provider, from, to)),
      move('catalogue cache', async () => { await adapters.get(provider)?.renameAccountCatalog?.(from, to) }),
    ])
    poolAdapter?.invalidate()
    if (cacheActive) handles.get(provider)?.replace([provider])
  }
  let identityReadiness: Promise<void> | undefined
  const reconcileIdentities = (): Promise<void> => {
    identityReadiness ??= providers.includes('codex')
      ? reconcileStoredCodexAliases({ move: renameAccountState, onWarn })
      : Promise.resolve()
    return identityReadiness
  }
  const onCatalogChanged = (provider: string): void => {
    if (!cacheActive) return
    poolAdapter?.invalidate()
    handles.get(provider)?.replace([provider])
  }
  // Per-model default effort overrides: start the load so the adapters'
  // synchronous `defaultEffortOf` callbacks see the persisted state as soon
  // as the model picker resolves; a load failure leaves the overrides empty.
  // A load failure leaves the overrides empty, which is indistinguishable from
  // "none configured" unless it is reported here.
  void loadModelDefaults().then(
    () => {
      const failure = modelDefaultsLoadError()
      if (failure !== undefined) {
        onWarn(`subscriptions: model default overrides could not be loaded; the picker follows provider defaults (${String(failure)})`)
      }
    },
    () => undefined,
  )
  // Token managers double as the tools' credential source, so they are
  // captured beside the registrations for the inject block below.
  let codexResetCredits: CodexResetCreditOps | undefined
  let codexAutoReset: CodexAutoReset | undefined
  const recoverCodexQuota = async (account: string, signal?: AbortSignal): Promise<boolean> => {
    if (codexAutoReset === undefined || preferences.get('codex').autoResetCredits !== true) return false
    const key = await codexTokens!.resolveAccount(account)
    return await withTimeout(deadline => codexAutoReset!.recover(key,
      signal === undefined ? deadline : AbortSignal.any([signal, deadline])), streamIdleTimeoutMs) ?? false
  }
  let claudeTokens: AccountTokenManager<ClaudeSession> | undefined
  /** Account-maintenance owner for the Claude route; absent when the route is refused. */
  let claudeMaintenance: ClaudeMaintenanceController | undefined
  /** The independent `policy_limits` owner for the Claude route. */
  let claudePolicyLimits: ClaudePolicyLimitsOwner | undefined
  /** The organization-pin checker the Claude route's readiness consults. */
  let claudeOrgPins: ClaudeOrgPinChecker | undefined
  /**
   * The one hydration every Claude request awaits before it can be served.
   *
   * Shared on purpose: no request may be judged by a projection that is still loading the
   * records a previous run stored, and every request waits on the same promise.
   */
  let claudeMaintenanceReady: Promise<void> | undefined
  /**
   * The one `policy_limits` hydration every Claude request awaits before a verdict is judged.
   *
   * The owner's own `ensure` waits for it too; this promise is what lets the status read and
   * the readiness seam decide only on settled state, so no caller is ever answered from a
   * projection that is still installing the records a previous run stored.
   */
  let claudePolicyLimitsReady: Promise<void> | undefined
  /** The one protocol-block store the adapter and the maintenance owner share. */
  let claudeProtocolBlocks: ClaudeProtocolBlockStore | undefined
  /**
   * The keys one account's `policy_limits` verdicts are consulted for: the pinned registry,
   * plus every key the account's own state states — including a key this build does not know.
   *
   * The keys the registry knows are always consulted, so the no-live-policy table answers
   * exactly as it does in the core, and the owner's own key list is what makes an unknown key
   * the provider stated reachable here instead of being silently skipped.
   * @param account - the canonical account key.
   * @returns the keys to consult.
   */
  const limitsKeysFor = (account: string): readonly string[] => {
    const stated = claudePolicyLimits?.restrictionKeys(account) ?? []
    return [...new Set<string>([...POLICY_KEYS, ...stated])]
  }
  /**
   * A counter naming the request-scoped binding one session-less request registers, so two
   * concurrent requests for one account never share a binding they must each release.
   */
  let transientRequestScope = 0
  let grokTokens: AccountTokenManager<GrokSession> | undefined
  // Usage lookups resolve the session through the refresh-aware path, so an
  // expired access token renews instead of failing the lookup.
  const usageFetchers: UsageFetchers = {}
  let codexAdapter: CodexAdapter | undefined
  let claudeAdapter: ClaudeAdapter | undefined
  // Dropped on every copilot auth transition so replay state (captured
  // reasoning) never survives an account switch in memory.
  let copilotAdapter: CopilotAdapter | undefined
  let cursorAdapter: CursorAdapter | undefined
  const memberAdapters = new Map<ProviderId, AccountAwareAdapter>()
  const register = (provider: ProviderId, adapter: AccountAwareAdapter): AdapterRegistrationHandle => {
    const route = new AccountPreferencesAdapter({
      provider, adapter, settings: preferences, pool: () => poolAdapter, onWarn,
      beforeRead: reconcileIdentities,
      resolveAccount: account => accountTokens.get(provider)?.resolveAccount(account) ?? Promise.resolve(account),
      accounts: async () => (await accountTokens.get(provider)?.list() ?? []).map(({ key, session }) => ({ key, label: accountOf(provider, session) ?? key })),
    })
    memberAdapters.set(provider, route.poolMember())
    return ctx.llm.registerAdapter([provider], route)
  }
  for (const provider of providers) {
    switch (provider) {
      case 'codex': {
        const tokens = new AccountTokenManager<CodexSession>({
          provider: 'codex',
          displayName: 'ChatGPT (Codex)',
          makeOptions: () => ({
            preemptMs: CODEX_PREEMPT_MS,
            refresh: refreshCodex,
            isPermanent: isCodexPermanentRefreshError,
          }),
          onAccountRenamed: (from, to) => renameAccountState('codex', from, to),
          onWarn,
        })
        codexTokens = tokens
        refreshCodexPresence()
        accountTokens.set('codex', tokens as AccountTokenManager<StoredSession>)
        const fetchUsage = async (account: string, signal: AbortSignal): Promise<ProviderUsage> =>
          fetchCodexUsage(await tokens.session(account), proxiedFetch, signal)
        usageFetchers.codex = async (account, signal) => {
          const startedAt = Date.now()
          const snapshot = await fetchUsage(account, signal)
          await codexAutoReset?.observeUsage(await tokens.resolveAccount(account), snapshot, startedAt)
          return snapshot
        }
        const creditOps: CodexResetCreditOps = {
          list: async (account, signal) => fetchCodexResetCredits(await tokens.session(account), proxiedFetch, signal),
          consume: async (account, creditId, redeemRequestId, signal) => consumeCodexResetCredit(
            await tokens.session(account),
            creditId,
            redeemRequestId,
            proxiedFetch,
            signal,
          ),
        }
        codexAutoReset = new CodexAutoReset({
          confirmationTimeoutMs: streamIdleTimeoutMs,
          enabled: () => preferences.get('codex').autoResetCredits === true,
          accounts: async () => (await tokens.list()).map(account => account.key),
          usage: fetchUsage,
          ...creditOps,
          changed: account => {
            subscriptionsAuth?.forgetResetCredits('codex', account)
            poolUsage?.invalidate('codex', account)
            poolHealth?.clear('codex', account)
          },
          onWarn,
        })
        codexResetCredits = {
          list: creditOps.list,
          consume: async (account, credit, requestId, signal) =>
            codexAutoReset!.manual(await tokens.resolveAccount(account), credit, requestId, signal),
        }
        let adapter!: CodexAdapter
        adapter = new CodexAdapter({
          ...config.codexClientVersion === undefined ? {} : { clientVersion: config.codexClientVersion },
          resolveClientVersion: () => codexVersion.resolve(),
          models: catalog.codex,
          streamIdleTimeoutMs,
          rateLimit,
          catalogMaxAgeMs: cachePolicy.modelMaxAgeMs,
          cacheRetryDelayMs: cachePolicy.retryDelayMs,
          onCatalogChanged,
          tokens,
          recoverQuota: recoverCodexQuota,
          discovery: !overridden.has('codex'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata (reasoning efforts) survives
          // restarts, so a resumed session's selected effort keeps resolving.
          catalogStore: catalogStore('codex', { onWarn }),
          defaultEffortOf: (model: string) => defaultEffortOf('codex', model),
          contextWindowOf: model => preferences.contextWindow('codex', model),
          pool: () => poolAdapter,
          speedFor: (model: string): boolean => defaultSpeedOf('codex', model) === 'fast',
        })
        codexAdapter = adapter
        adapters.set('codex', adapter)
        handles.set('codex', register('codex', adapter))
        break
      }
      case 'claude': {
        if (failureRecoveryVersion !== REQUIRED_FAILURE_RECOVERY_VERSION) {
          // No probe request, no half-configured route: the route is simply not
          // registered, the fixed code is logged, and the Settings card states
          // the reason. Other providers keep working.
          refused.push('claude')
          ctx.logger.error(
            `${name}: ${CLAUDE_HOST_INCOMPATIBLE}: this Host declares failureRecoveryVersion `
            + `${String(failureRecoveryVersion ?? 'none')}, requiring ${String(REQUIRED_FAILURE_RECOVERY_VERSION)}; `
            + 'the Claude route is not registered',
          )
          break
        }
        const tokens = new AccountTokenManager<ClaudeSession>({
          provider: 'claude',
          displayName: 'Claude (Subscription)',
          makeOptions: () => ({
            preemptMs: CLAUDE_PREEMPT_MS,
            // The resolved ownership mode decides the refresh path, never `keychainBound`
            // alone. The selector itself routes all three modes, so a mode change that lands
            // inside the manager's own window cannot hand a read-only record to this plugin's
            // grant: a read-only-import record is served from its source there, or the refresh
            // stops.
            refresh: session => refreshForClaudeOwnership(session, {
              syncClaudeCodeCredentials,
              readSource: readClaudeCredentialSource,
              onWarn,
            }),
            isPermanent: isClaudePermanentRefreshError,
          }),
          // The one use path every credential consumer goes through — a Messages request, a
          // forced refresh after a 401, usage, catalogue discovery and the maintenance reads.
          // A read-only-import account answers here with the winner re-read from Claude Code's
          // store, or fails closed; `list()` and `snapshot()` never call it, so no status read
          // touches that store.
          prepareSession: account => claudeReadOnlyUse(account, readClaudeCredentialSource),
          // Cooperating plugin instances share this credential store: a rotation must
          // take the store's own refresh ownership before spending a grant.
          refreshOwnership: durableStoreRefreshOwnership(),
        })
        claudeTokens = tokens
        accountTokens.set('claude', tokens as AccountTokenManager<StoredSession>)
        // One protocol-block store serves the adapter (which records and checks blocks)
        // and the maintenance controller (which refuses a request under a blocked
        // configuration). A second copy would let a refused profile be probed again.
        claudeProtocolBlocks = new ClaudeProtocolBlockStore({ onWarn })
        // The protocol configuration this route serves, and the answer to "was it refused":
        // recorded in-process the moment a refusal is written, so a request never has to
        // re-read the store to learn about a refusal its own readiness just discovered.
        const limitsFence = claudeProtocolFence()
        const refusedConfigurations = new Set<string>()
        const refusedConfigurationKey = `${limitsFence.provider}\n${limitsFence.origin}\n${limitsFence.fingerprint}`
        /**
         * The plugin's single writer of a protocol refusal, awaited by the owner before the
         * read result settles.
         *
         * It is handed the typed failure the shared classifier produced, and it records only
         * a vendor `provider-profile` refusal: every other failed read keeps the disposition
         * its own classifier and retry budget gave it, and no status or body text is
         * second-guessed into a block here. The fence and every same-configuration cadence are
         * fenced synchronously — the owner calls this from inside its own failure path, so it
         * may not await anything that waits for that read to settle — and only then is the
         * durable record awaited. The read that discovered the refusal is not stopped from
         * inside this callback: the owner settles it and the readiness seam reports it.
         * @param event - the account, its identity and the failure the owner classified.
         */
        const recordProtocolRefusal = async (event: PolicyLimitsReadFailure): Promise<void> => {
          const failure = event.failure
          if (failure.code !== 'unsupported' || failure.reason !== CLIENT_VERSION_UNSUPPORTED_CODE) return
          refusedConfigurations.add(refusedConfigurationKey)
          // A refusal is about the configuration, not the account that observed it: every
          // account reading under the same origin and profile stops its cadence now.
          const limits = claudePolicyLimits
          if (limits !== undefined) {
            for (const account of limits.accounts()) limits.stopCadence(account)
          }
          const blocks = claudeProtocolBlocks
          if (blocks === undefined) return
          const written = await blocks.block({
            ...limitsFence,
            reason: failure.code,
            serverCode: failure.reason,
          })
          if (!written.persisted) {
            onWarn('dsh-plugin-subscriptions: claude protocol refusal could not be persisted; it holds for this process only')
          }
        }
        /**
         * The timer source for the `policy_limits` cadence.
         *
         * A refused configuration is never polled again: the cadence is the owner's only
         * background work, so gating the timer here stops every same-configuration read
         * without a second copy of the refusal state. The authoritative record is consulted
         * before each fire, and an unreadable authority counts as blocked — the store's own
         * rule — so a refusal this process already wrote stops the next cycle too.
         */
        const claudeLimitsScheduler: ClaudePolicyLimitsScheduler = {
          after: (delayMs, run) => {
            if (refusedConfigurations.has(refusedConfigurationKey)) return () => {}
            const timer = setTimeout(() => {
              const blocks = claudeProtocolBlocks
              if (blocks === undefined) { run(); return }
              void blocks.isBlocked(limitsFence).then(
                (blocked) => { if (!blocked) run() },
                (error: unknown) => {
                  onWarn(`dsh-plugin-subscriptions: claude protocol block check failed (${errorChain(error)}); the refused configuration is not polled`)
                },
              )
            }, delayMs)
            timer.unref()
            return () => clearTimeout(timer)
          },
        }
        claudeMaintenance = new ClaudeMaintenanceController({
          tokens,
          config: claudeMaintenanceConfig,
          // Durable profile/policy state in the plugin's own home. Loading it reads one
          // file: it takes no credential and makes no provider request.
          persistence: new FileClaudeMaintenancePersistence({ onWarn }),
          readProfile: claudeProfileReader({ fetchFn: proxiedFetch }),
          fetchSettings: claudeSettingsFetch({ fetchFn: proxiedFetch }),
          // The settings endpoint's refusals are classified by the reliability module's own
          // classifier, so a version or permission refusal discovered here is the same hard
          // stop the Messages path produces rather than a generic transient status. The
          // maintenance owner records the shared protocol block for what it accepts.
          classifyHttpFailure: claudeSettingsFailureClassifier(),
          // Only the key meanings the fixed protocol schema states are enforced; this
          // build maps no exact wire tool name onto a DSH tool, so `permissions` keeps
          // the fail-closed treatment and the status card reports it.
          policyConsumers: CLAUDE_POLICY_CONSUMERS,
          protocolBlocks: claudeProtocolBlocks,
          protocolFingerprint: () => claudeProtocolFingerprint(CLAUDE_PROTOCOL_PROFILE),
          // No `onChanged` notification is wired: the only push this plugin owns re-announces
          // the model route (`llm/adapters-updated`), and rebuilding it for a maintenance
          // state change would disturb the sessions the change must not touch. Enforcement
          // does not depend on a notification — the execution guard reads the live policy —
          // and the Settings card states the new dimensions on its next status read.
          onWarn,
        })
        // Started here rather than awaited by `apply`: the route cannot serve a request
        // until this settles, because the pre-request seam awaits it, and plugin load does
        // not wait on a file read.
        claudeMaintenanceReady = claudeMaintenance.hydrate()
        // The independent policy_limits owner and the pin checker. Both read through the
        // plugin's own fetch, keep no credential of their own, and start nothing until a
        // readiness check asks them to.
        claudePolicyLimits = new ClaudePolicyLimitsOwner({
          baseUrl: CLAUDE_DEFAULT_POLICY_ORIGIN,
          userAgent: CLAUDE_POLICY_USER_AGENT,
          transport: internals.policyLimitsTransport ?? (request => policyLimitsTransport(request, proxiedFetch)),
          accessToken: async account => (await tokens.session(account)).accessToken,
          // The same ordered classifier the Messages and settings paths use, so a refusal read
          // here is the same decision; and the plugin's real forced-refresh path, which the
          // reader may invoke at most once and only when the classifier did not forbid it.
          // The classifier stays pure; this handler is the plugin's single writer of the
          // shared protocol-block record, for a poll read exactly as for a readiness read.
          classifyFailure: claudePolicyLimitsFailureClassifier(),
          refreshOnUnauthorized: async account => (await tokens.session(account, true)).accessToken,
          // Its own durable store, in the plugin's own home: adopted documents survive a
          // restart without ever living beside the credential store or the settings record.
          persistence: new FileClaudePolicyLimitsState({ onWarn }),
          readFailure: recordProtocolRefusal,
          scheduler: claudeLimitsScheduler,
          onWarn,
        })
        // Started, not awaited: the owner awaits its own hydration inside every read, and the
        // readiness seam awaits the shared promise before it judges an account.
        claudePolicyLimitsReady = claudePolicyLimits.hydrate()
        claudeOrgPins = new ClaudeOrgPinChecker({
          url: `${CLAUDE_DEFAULT_POLICY_ORIGIN}/api/oauth/validate`,
          userAgent: CLAUDE_POLICY_USER_AGENT,
          transport: internals.orgPinTransport ?? (request => policyLimitsTransport(request, proxiedFetch)),
          onWarn,
        })
        usageFetchers.claude = async (account, signal) =>
          // Refresh-and-replay on rejection, as the client issues this request.
          fetchClaudeUsage(await tokens.session(account), proxiedFetch, signal,
            async () => (await tokens.session(account, true)).accessToken)
        let adapter!: ClaudeAdapter
        adapter = new ClaudeAdapter({
          models: catalog.claude,
          requestRecord: claudeRecordPort,
          // The durable continuation owner and the startup hydration result: every request is
          // prepared under the owner and reads the settled hydration result.
          ...claudeRouteOptions,
          ...config.claudeIdentityLine === undefined ? {} : { identityLine: config.claudeIdentityLine },
          // The Messages transport a deployment leaves to this plugin's own Bun child; an
          // injected one exists so a test can observe a successful request without a runtime.
          ...internals.claudeMessagesFetch === undefined ? {} : { fetchFn: internals.claudeMessagesFetch },
          streamIdleTimeoutMs,
          rateLimit,
          catalogMaxAgeMs: cachePolicy.modelMaxAgeMs,
          cacheRetryDelayMs: cachePolicy.retryDelayMs,
          onCatalogChanged,
          tokens,
          discovery: !overridden.has('claude'),
          onWarn,
          resolveAttachments,
          catalogStore: catalogStore('claude', { onWarn }),
          usageObserverFor: account => poolUsage?.captureUnifiedObserver('claude', account) ?? (() => {}),
          defaultEffortOf: (model: string) => defaultEffortOf('claude', model),
          pool: () => poolAdapter,
          speedFor: (model: string): boolean => defaultSpeedOf('claude', model) === 'fast',
          protocolBlocks: claudeProtocolBlocks,
          // The trusted policy this route states for one build, read from the account's own
          // adopted policy_limits state: a confirmed HIPAA taint withholds the pinned
          // mid-conversation betas, and every other account states nothing.
          requestPolicy: ({ account }) => claudeRequestPolicyFor(claudePolicyLimits?.status(account)),
          maintenance: {
            // The seam the live-session binding and the policy gate hang off: it is
            // awaited before the first wire request, and a refusal throws so the
            // request is never sent.
            beforeAccountRequest: async (attempt) => {
              const controller = claudeMaintenance
              if (controller === undefined) return undefined
              // No request is served before the state a previous run stored is installed:
              // every request awaits the same hydration promise, so none can be judged by a
              // projection that is still loading.
              await claudeMaintenanceReady
              await claudePolicyLimitsReady
              // A real request from this session targets this account, so it is the account
              // whose accepted policy may decide this session's tool calls. Recorded before
              // the readiness decision: a refusal can then only remove a tool from that
              // session, never grant one.
              if (attempt.sessionId !== undefined) attribution.attributeAccount(attempt.sessionId, attempt.account)
              const decision = await controller.ensureReady({
                account: attempt.account,
                ...attempt.sessionId === undefined ? {} : { sessionId: attempt.sessionId },
                signal: attempt.signal,
              })
              if (!decision.ok) throw decision.error
              // The independent policy_limits read and the organization pin are judged at the
              // same readiness point, on facts this request already established: an account the
              // entitlement excludes starts neither of them. The owner's own projection of the
              // confirmed metadata is read once, for both the limits eligibility and the
              // organization-pin identity key.
              const view = controller.view().find(entry => entry.account === decision.account)
              const limits = claudePolicyLimits
              if (limits !== undefined) {
                // The owner's own projection of the confirmed metadata decides eligibility.
                // The stored session answers only when the profile said nothing at all about
                // the subscription type: an explicit `null` is the provider's statement, not
                // an absence, and must not be replaced by the stored copy.
                const subscriptionType = view?.profile.subscriptionType !== undefined
                  ? view.profile.subscriptionType
                  : decision.session.subscriptionType
                const eligibility = policyLimitsEligibilityFor({
                  // This plugin's Claude route is the pinned first-party OAuth route, and an
                  // imported credential was issued by that same first-party client. Ownership
                  // mode and `keychainBound` state where a credential came from and who may
                  // rotate it, which is not evidence about the OAuth client that issued it, so
                  // neither may excuse an account from an applicable organization policy.
                  firstPartyOAuth: CLAUDE_CREDENTIAL_IS_FIRST_PARTY_OAUTH,
                  // This route serves exactly one pinned origin under one pinned protocol
                  // profile, and the plugin publishes no Claude base-URL override: the pinned
                  // constant is the whole proof this input needs. A configured override would
                  // have to make this false.
                  defaultBaseUrl: true,
                  scopes: decision.session.scopes ?? '',
                  accessToken: decision.session.accessToken,
                  subscriptionType,
                })
                if (eligibility.kind === 'eligible') {
                  // A request that names no session is judged exactly like one that does: it
                  // registers a request-scoped binding, takes the one bounded read, and
                  // releases that binding before returning, so no timer outlives it and no
                  // operation is served under a policy this plugin never read.
                  transientRequestScope += 1
                  const scopeId = attempt.sessionId ?? `claude-request:${String(transientRequestScope)}`
                  // The epoch is the durable identity generation this account is served under, read
                  // from the one owner that keeps it: a maintenance record confirmed for one
                  // identity is never reused for another, and no parallel counter can disagree. An
                  // undefined epoch is a refusal — a disposed or cancelled state, or an account with
                  // no baseline — and never the baseline: binding epoch-less policy state here would
                  // let a hook that began during disposal reach managed settings.
                  const epoch = await claudeContinuation.currentEpoch(decision.account)
                  if (epoch === undefined) {
                    throw new LlmError(
                      'claude request refused: the continuation state is unavailable (the identity generation could not be read)',
                      LOCAL_CONTINUATION_STATE_UNAVAILABLE,
                      { retryDisposition: 'forbid' },
                    )
                  }
                  // The binding is registered against this identity, and only its FIRST read
                  // issues a request: a later readiness check reuses the confirmed state. The
                  // UUID and organization are the credential's and the accepted policy's own,
                  // so a state confirmed for one identity is never reused for another.
                  const first = limits.bind(decision.account, scopeId, {
                    account: decision.account,
                    ...decision.session.accountUuid === undefined ? {} : { accountUuid: decision.session.accountUuid },
                    ...view?.organization === undefined ? {} : { organization: view.organization },
                    origin: CLAUDE_DEFAULT_POLICY_ORIGIN,
                    profileFingerprint: claudeProtocolFingerprint(CLAUDE_PROTOCOL_PROFILE),
                    ...epoch === 0 ? {} : { epoch: String(epoch) },
                  })
                  try {
                    const read = await limits.ensure(decision.account, {
                      force: first,
                      sessionId: scopeId,
                      ...attempt.signal === undefined ? {} : { signal: attempt.signal },
                    })
                    // The refusal is observed from the typed failure the shared classifier
                    // produced, after the owner's failure handler has recorded it — never from
                    // a status, a reason string or response text. A configuration the service
                    // refused must not serve this request, and the `forbid` disposition is what
                    // stops the pool from trying another account for it.
                    if (read.failure !== undefined) {
                      if (read.failure.code === 'unsupported'
                        && read.failure.reason === CLIENT_VERSION_UNSUPPORTED_CODE) {
                        throw claudeProtocolBlockedError()
                      }
                      // Any other failed read is a refusal too: this request must not be sent
                      // under a policy the plugin could not read, and a failure the pinned
                      // retry policy forbade keeps that prohibition for the Host and the pool.
                      throw policyLimitsReadError(read.failure)
                    }
                    // The same owner state decides this plugin's own Messages operation, from
                    // the same keys and the same mapping the execution guard uses: a key the
                    // account's document refuses reaches model inference exactly as it reaches
                    // a Host tool, so no path honours a restriction the other path ignores.
                    const modelRefusal = policyLimitsOperationDenial({
                      status: limits.status(decision.account),
                      operation: 'provider.messages',
                      keys: limitsKeysFor(decision.account),
                      verdict: key => limits.verdict(decision.account, key),
                      mapping: policyKeyMapping,
                    })
                    if (modelRefusal.decision === 'deny') throw policyLimitsRefusalError(modelRefusal)
                    // A cadence belongs to a live binding, and arming it is idempotent. A
                    // refused configuration is never armed: the scheduler itself refuses to
                    // arm or fire one, so no account re-probes a profile the service refused.
                    if (attempt.sessionId !== undefined) limits.arm(decision.account)
                  } finally {
                    // A request-scoped binding never becomes a background owner: releasing it
                    // stops any cadence and awaits the owner's cleanup for it.
                    if (attempt.sessionId === undefined) await limits.releaseSession(decision.account, scopeId)
                  }
                } else {
                  // The entitlement excludes this account: nothing polls it, and its state is
                  // dropped rather than left behind for a later read to trust.
                  await limits.suspend(decision.account)
                }
              }
              const pins = claudeOrgPins
              if (pins !== undefined) {
                const projected = controller.adoptedOrganizationPin(decision.account)
                const outcome = await pins.check({
                  account: decision.account,
                  // Only the owner's projection crosses this seam: an account whose accepted
                  // policy states no pin — an ordinary known Pro/Max account whose entitlement
                  // excluded the settings read, for example — sends nothing and is never
                  // refused for a pin it does not have.
                  projected,
                  // The judgment belongs to one identity. The credential revision is
                  // deliberately absent: an ordinary refresh is not a new login and must not
                  // re-send the validation, while a different account UUID, organization,
                  // origin or protocol profile is re-checked.
                  identity: {
                    ...decision.session.accountUuid === undefined ? {} : { accountUuid: decision.session.accountUuid },
                    ...view?.organization === undefined ? {} : { organization: view.organization },
                    origin: CLAUDE_DEFAULT_POLICY_ORIGIN,
                    profileFingerprint: claudeProtocolFingerprint(CLAUDE_PROTOCOL_PROFILE),
                  },
                  accessToken: async () => (await tokens.session(decision.account)).accessToken,
                  signal: attempt.signal,
                })
                if (outcome.kind === 'denied') {
                  // The refusal carries the hard stop: the Host must not retry the turn and the
                  // pool route must not move the request onto another account, because no other
                  // account satisfies the organization this one's accepted policy pinned.
                  // An unverified pin is a statement about this process's own view, not a
                  // provider rejection: the accepted record was restored without the settings
                  // body it was projected from, so the next real request states it again. The
                  // copy names the one request held back — the profile and settings reads this
                  // account already made did reach the provider — and nothing about a server
                  // validation; only a pin the policy itself stated, and this account then
                  // failed, goes back to the operator as a refusal.
                  const unverified = outcome.code === 'pin_unverified'
                  const pinCheckReason = unverified && projected?.kind === 'unknown' ? ` (${projected.reason})` : ''
                  throw new LlmError(
                    unverified
                      ? `claude organization policy not reverified locally; Messages request not sent; retry after policy check${pinCheckReason}`
                      : `claude organization validation refused this account (${outcome.code})`,
                    POLICY_ORG_PIN_REFUSED,
                    { retryDisposition: 'forbid' },
                  )
                }
              }
              return decision.session
            },
          },
        })
        claudeAdapter = adapter
        adapters.set('claude', adapter)
        // Every prepared Messages request is published into its session log before the POST, so
        // this route exists only while a Host provides `llmRequestRecord`. The scoped injection
        // keeps that requirement off every other provider: a Host without the service loses this
        // route, reports the fixed code on the route's status, and keeps codex, grok, copilot,
        // antigravity and cursor. The injection is also the route's lifetime — a service mounted
        // later registers the route, and one unmounted disposes it and restores the refusal.
        ctx.inject(['llmRequestRecord'], claudeCtx => {
          claudeRecordPort.bind(claudeCtx.llmRequestRecord)
          const handle = register('claude', adapter)
          handles.set('claude', handle)
          allowRoute('claude')
          return () => {
            claudeRecordPort.unbind()
            handles.delete('claude')
            refuseRoute('claude')
            handle()
          }
        })
        // A Host that mounts no recording service never runs the injection above; the status
        // projection says so now rather than after the first refused request.
        if (ctx.get('llmRequestRecord') === undefined) refuseRoute('claude')
        break
      }
      case 'grok': {
        const tokens = new AccountTokenManager<GrokSession>({
          provider: 'grok',
          displayName: 'Grok (Subscription)',
          makeOptions: () => ({
            preemptMs: GROK_PREEMPT_MS,
            refresh: refreshGrok,
            isPermanent: isGrokPermanentRefreshError,
          }),
          onAccountRenamed: (from, to) => renameAccountState('grok', from, to),
        })
        grokTokens = tokens
        accountTokens.set('grok', tokens as AccountTokenManager<StoredSession>)
        usageFetchers.grok = async (account, signal) =>
          fetchGrokUsage(await tokens.session(account), proxiedFetch, signal)
        const adapter = new GrokAdapter({
          models: catalog.grok,
          streamIdleTimeoutMs,
          rateLimit,
          catalogMaxAgeMs: cachePolicy.modelMaxAgeMs,
          cacheRetryDelayMs: cachePolicy.retryDelayMs,
          onCatalogChanged,
          tokens,
          discovery: !overridden.has('grok'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata (reasoning efforts) survives
          // restarts, so a resumed session's selected effort keeps resolving.
          catalogStore: catalogStore('grok', { onWarn }),
          defaultEffortOf: (model: string) => defaultEffortOf('grok', model),
          pool: () => poolAdapter,
        })
        adapters.set('grok', adapter)
        handles.set('grok', register('grok', adapter))
        break
      }
      case 'copilot': {
        const tokens = new AccountTokenManager<CopilotSession>({
          provider: 'copilot',
          displayName: 'GitHub Copilot',
          makeOptions: () => ({
            preemptMs: COPILOT_PREEMPT_MS,
            refresh: refreshCopilot,
            isPermanent: isCopilotPermanentRefreshError,
          }),
          onAccountRenamed: (from, to) => renameAccountState('copilot', from, to),
        })
        accountTokens.set('copilot', tokens as AccountTokenManager<StoredSession>)
        copilotAdapter = new CopilotAdapter({
          models: catalog.copilot,
          streamIdleTimeoutMs,
          rateLimit,
          catalogMaxAgeMs: cachePolicy.modelMaxAgeMs,
          cacheRetryDelayMs: cachePolicy.retryDelayMs,
          onCatalogChanged,
          tokens,
          discovery: !overridden.has('copilot'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata (per-model vision support,
          // context windows) survives restarts and network failures.
          catalogStore: catalogStore('copilot', { onWarn }),
          defaultEffortOf: (model: string) => defaultEffortOf('copilot', model),
          pool: () => poolAdapter,
        })
        adapters.set('copilot', copilotAdapter)
        handles.set('copilot', register('copilot', copilotAdapter))
        break
      }
      case 'antigravity': {
        const tokens = new AccountTokenManager<AntigravitySession>({
          provider: 'antigravity',
          displayName: 'Google Antigravity',
          makeOptions: () => ({
            preemptMs: ANTIGRAVITY_PREEMPT_MS,
            refresh: session => refreshAntigravity(session, resolveAntigravityOAuthConfig(config.antigravity)),
            isPermanent: isAntigravityPermanentRefreshError,
          }),
          onAccountRenamed: (from, to) => renameAccountState('antigravity', from, to),
        })
        accountTokens.set('antigravity', tokens as AccountTokenManager<StoredSession>)
        usageFetchers.antigravity = async (account, signal) => fetchAntigravityUsage(
          await tokens.session(account), config.antigravity, proxiedFetch, signal,
        )
        const adapter = new AntigravityAdapter({
          models: catalog.antigravity,
          streamIdleTimeoutMs,
          rateLimit,
          catalogMaxAgeMs: cachePolicy.modelMaxAgeMs,
          cacheRetryDelayMs: cachePolicy.retryDelayMs,
          onCatalogChanged,
          tokens,
          discovery: !overridden.has('antigravity'),
          ...config.antigravity === undefined ? {} : { runtime: config.antigravity },
          onWarn,
          resolveAttachments,
          catalogStore: catalogStore('antigravity', { onWarn }),
          defaultEffortOf: model => defaultEffortOf('antigravity', model),
          pool: () => poolAdapter,
        })
        adapters.set('antigravity', adapter)
        handles.set('antigravity', register('antigravity', adapter))
        break
      }
      case 'cursor': {
        const tokens = new AccountTokenManager<CursorSession>({
          provider: 'cursor',
          displayName: 'Cursor',
          makeOptions: () => ({
            preemptMs: CURSOR_PREEMPT_MS,
            refresh: refreshCursor,
            isPermanent: isCursorPermanentRefreshError,
          }),
          onAccountRenamed: (from, to) => renameAccountState('cursor', from, to),
        })
        accountTokens.set('cursor', tokens as AccountTokenManager<StoredSession>)
        let adapter!: CursorAdapter
        adapter = new CursorAdapter({
          models: catalog.cursor,
          streamIdleTimeoutMs,
          rateLimit,
          catalogMaxAgeMs: cachePolicy.modelMaxAgeMs,
          cacheRetryDelayMs: cachePolicy.retryDelayMs,
          onCatalogChanged,
          tokens,
          discovery: !overridden.has('cursor'),
          onWarn,
          resolveAttachments,
          catalogStore: catalogStore('cursor', { onWarn }),
          defaultEffortOf: model => defaultEffortOf('cursor', model),
          pool: () => poolAdapter,
          speedFor: (model: string): boolean => defaultSpeedOf('cursor', model) === 'fast',
          contextWindowOf: model => preferences.contextWindow('cursor', model),
        })
        cursorAdapter = adapter
        usageFetchers.cursor = async (account, signal) => loadCursorAccountUsage(
          await tokens.session(account),
          proxiedFetch,
          signal,
          async next => { await saveAccountSession('cursor', account, next) },
        )
        adapters.set('cursor', adapter)
        handles.set('cursor', register('cursor', adapter))
        break
      }
    }
  }

  // Same-subscription account pools: a catalog model with ≥2 accounts of
  // that provider is served through the pool (same id, same picker group).
  // Configured tiers are extra picker rows. Built whenever enabled; a
  // provider with fewer than two accounts simply has nothing to pool.
  const poolConfig = config.pool
  const autoAccounts = poolConfig?.autoAccounts ?? true
  const fetcherFor = (provider: ProviderId, account: string): UsageFetcher | undefined => {
    const fetchUsage = usageFetchers[provider]
    if (fetchUsage === undefined) return undefined
    if (provider === 'codex' && poolConfig?.enabled !== false && codexTokens !== undefined) {
      const tokens = codexTokens
      return async lifecycle => {
        const startedAt = Date.now()
        const snapshot = await fetchCodexPoolUsage(await tokens.session(account), proxiedFetch, usageReadSignal(lifecycle))
        await codexAutoReset?.observeUsage(await tokens.resolveAccount(account), snapshot, startedAt)
        return snapshot
      }
    }
    return lifecycle => fetchUsage(account, usageReadSignal(lifecycle))
  }
  const usageStore = createFileUsageStore({ file: dshHomePath('plugins', 'subscriptions', 'usage-cache.json'), onWarn })
  poolUsage = new PoolUsageTracker(fetcherFor, {
    freshMs: cachePolicy.usageMaxAgeMs,
    retryDelayMs: cachePolicy.retryDelayMs,
    store: usageStore,
  })
  const sharedUsage = poolUsage
  ctx.effect(() => async () => {
    cacheActive = false
    await Promise.all([...adapters.values()].map(adapter => adapter.drainOwnCatalogs?.()))
    await sharedUsage.dispose()
  }, 'subscriptions: metadata cache lifecycle')
  if (poolConfig?.enabled !== false && adapters.size >= 1) {
    poolHealth = new PoolHealthRegistry()
    // One provider at a time: every pool read names its route, so listing one
    // provider's accounts must not wait on another provider's discovery.
    const families = async (only?: ProviderId): Promise<Map<string, PoolDefinition>> => {
      const pools = new Map<string, PoolDefinition>()
      if (autoAccounts) {
        // Discover each account's catalog separately: a model only pools the
        // accounts that actually list it (Plus is not asked to serve Pro-only
        // models). Pool membership is advisory, so a known catalog answers
        // without waiting on its refresh and only an account with nothing known
        // pays one fetch, inside this same bound. A hang or discovery failure
        // sits that account out.
        const sources: Parameters<typeof buildAccountPools>[0] = {}
        const swept = [...adapters].filter(([provider]) => only === undefined || provider === only)
        await Promise.all(swept.map(async ([provider, adapter]) => {
          try {
            const accounts = (await accountTokens.get(provider)?.list() ?? []).map(entry => entry.key)
            if (accounts.length === 0) return
            const catalogs = (await Promise.all(accounts.map(async account => {
              // An adapter with an advisory read uses it; an unavailable result is
              // cancellation, never a reason to start a second attempt.
              const advisory = adapter.resolveOwnCatalog?.bind(adapter)
              const models = await withTimeout(
                signal => advisory === undefined
                  ? adapter.listOwnModels(provider, account, signal)
                  : advisory(provider, account, signal),
                POOL_USAGE_TIMEOUT_MS,
              )
              const settings = preferences.get(provider).accounts
              const policy = settings && Object.hasOwn(settings, account) ? settings[account] : undefined
              return models === undefined ? undefined : { account, models: models.filter(model => accountAllowsPool(policy, model.id)) }
            }))).filter(entry => entry !== undefined)
            if (catalogs.length > 0) sources[provider] = { catalogs }
          } catch {
            // Discovery failures are already reported by the owning adapter.
          }
        }))
        for (const [key, definition] of buildAccountPools(sources)) pools.set(key, definition)
      }
      for (const [id, members] of Object.entries(poolConfig?.families ?? {})) {
        if (members.length === 0) continue
        const owner = members[0].provider
        if (only !== undefined && owner !== only) continue
        const kept = members.filter(member => member.provider === owner)
        if (kept.length < members.length) {
          onWarn(`pool "${id}": cross-provider members are ignored; only ${owner} accounts are pooled`)
        }
        pools.set(poolKey(owner, id), { members: kept })
      }
      return pools
    }
    poolAdapter = new PoolAdapter({
      adapters: Object.fromEntries(memberAdapters),
      health: poolHealth,
      usage: poolUsage,
      strategy: poolConfig?.strategy ?? 'quota_aware',
      scheduling,
      ...poolConfig?.concurrency === undefined ? {} : { concurrency: poolConfig.concurrency },
      defaultAccount: provider => accountTokens.get(provider)?.defaultAccount() ?? Promise.resolve(undefined),
      resolveAccount: (provider, account) => accountTokens.get(provider)?.resolveAccount(account) ?? Promise.resolve(account),
      families,
      tiers: poolConfig?.tiers ?? {},
      recoverQuota: (member, signal) => member.provider === 'codex'
        ? recoverCodexQuota(member.account, signal) : Promise.resolve(false),
      onWarn,
    })
    // The pool binds each session's turns to one account and limits how many
    // sessions one account serves; both need the session log's own turn
    // boundaries, and both must forget a session the moment it is disposed.
    const pool = poolAdapter
    ctx.on('session/event', (session, event) => {
      const sessionId = String(session.id)
      if (event.type === 'turn/start') pool.noteTurnStart(sessionId, event.data.turn)
      else if (event.type === 'turn/end') pool.noteTurnEnd(sessionId, event.data.turn)
    }, { global: true })
    ctx.on('session/disposed', (session) => { pool.forgetSession(String(session.id)) })
    ctx.on('agent/disposed', ({ agent }) => { pool.forgetSession(String(agent.session.id)) })
    ctx.effect(() => () => { pool.dispose() }, 'dsh-plugin-subscriptions: account pool gate')
  }

  // The `usage` endpoint's pool attribution: whether THIS account is parked,
  // and whether another account that may serve this provider's pool is clear.
  // Membership comes from the account preferences the pool itself obeys rather
  // than from a pool sweep, so a Settings read never triggers model discovery;
  // the peer test is the pool's own rule, floors included, because a peer past
  // its Claude usage floor cannot serve in this account's place.
  const poolStateFor = async (provider: ProviderId, account: string): Promise<UsagePoolState | undefined> => {
    const health = poolHealth
    if (health === undefined) return undefined
    const configured = preferences.get(provider).accounts
    const pooled = (key: string): boolean =>
      configured !== undefined && Object.hasOwn(configured, key) ? configured[key].poolEnabled !== false : true
    const peers = (await accountTokens.get(provider)?.list() ?? []).map(entry => entry.key)
    return await usagePoolState(health, poolAdapter, provider, account, peers, pooled)
  }

  // Keep the full catalog for the editor and routing; filter only picker enumeration.
  const fullCatalogs = new Map<ProviderId, (provider: string) => Promise<readonly LlmModelInfo[]>>()
  for (const [provider, adapter] of adapters) {
    const list = adapter.listModels.bind(adapter)
    fullCatalogs.set(provider, list)
    adapter.listModels = async route => (await list(route)).filter(model => preferences.visible(provider, model.id))
  }

  // The composer Speed control and the Settings per-model picker share one
  // durable tier per provider model, stored beside the per-model effort
  // defaults. Each route applies it only where its own catalog advertises the
  // fast tier, so a stored fast on a model that cannot honour it — a
  // hand-edited file naming a plain model, or a catalog that stopped
  // advertising the tier — stays on standard routing.
  const speed: SpeedController = {
    async speed(provider, model) {
      await reconcileIdentities()
      // A speed read belongs to one provider; unrelated catalog discovery must not delay it.
      const fastModels = provider === 'codex'
        ? await codexAdapter?.fastCapableModels() ?? []
        : provider === 'cursor'
          ? await cursorAdapter?.fastCapableModels() ?? []
          : provider === 'claude'
            ? await claudeAdapter?.fastCapableModels() ?? []
            : []
      if (provider === 'codex') {
        const accountPreferences = preferences.get(provider).accounts
        for (const { key } of await codexTokens?.list() ?? []) {
          if (!accountPreferences || !Object.hasOwn(accountPreferences, key) || accountPreferences[key].independentEntry !== true) continue
          for (const model of [...fastModels]) {
            if (parseAccountModelId(model)) continue
            if (await codexAdapter?.supportsFastTier(model, key)) fastModels.push(accountModelId(key, model))
          }
        }
      }
      return {
        tier: defaultSpeedOf(provider, model) ?? 'standard',
        fastModels,
      }
    },
    async setSpeed(provider, model, tier) {
      await setDefaultSpeed(provider, model, tier)
    },
  }
  const refreshCatalog = async (provider: ProviderId, force: boolean): Promise<void> => {
    if (!cacheActive || overridden.has(provider)) return
    const adapter = adapters.get(provider)
    if (adapter?.refreshOwnCatalog === undefined) return
    if (provider === 'codex' && force) codexVersion.invalidate()
    const accounts = await accountTokens.get(provider)?.list() ?? []
    await Promise.all(accounts.map(account => adapter.refreshOwnCatalog!(provider, account.key, { force })))
  }
  // Manage reads providerSettings; effort writes validate against the same cached capabilities.
  const modelDefaults: ModelDefaultsController = {
    async set(provider, model, effort) {
      // Garbage in, garbage out: accept only levels the model's own catalog
      // actually advertises (clearing with `undefined` always passes). A value
      // from elsewhere — a hand-edited store file — would otherwise ride on
      // every request and 400. An unknown effort fails the save instead of
      // silently saving something unusable.
      if (effort !== undefined) {
        let info: LlmResolvedModelInfo | undefined
        try {
          info = await ctx.llm.resolveModelInfo(provider, model)
        } catch {
          // Fall through when the catalog is unavailable: rejecting the save
          // here would make every write fail during an outage.
        }
        const offered = info?.reasoning?.efforts ?? []
        if (offered.length > 0 && !offered.some(entry => entry.id === effort)) {
          throw new BadRequest(`model ${model} does not advertise a "${effort}" reasoning effort`)
        }
      }
      await setDefaultEffort(provider, model, effort)
      // Re-announce the route so the model picker re-queries `listModels` and
      // reflects the new default immediately (same path as auth changes).
      handles.get(provider)?.replace([provider])
    },
  }
  /**
   * The locally recorded account dimensions the status projection reports
   * beside the credential store: the pool's parking records, the account
   * maintenance owner's credential/profile/policy state, the independent
   * `policy_limits` dimension and the protocol-block store. Read only — a
   * status call never contacts a provider and never starts a cadence.
   */
  const accountStateFor: AccountStateReader = async (provider, account) => {
    const health = cooldownDimensions(poolHealth?.accountCooling(provider, account))
    if (provider !== 'claude') return health
    // A status read waits for the same hydration every request waits for. It starts no
    // upstream work; it only avoids reporting an empty projection as if no restriction had
    // ever been accepted.
    await claudeMaintenanceReady
    await claudePolicyLimitsReady
    const view = claudeMaintenance?.view().find(entry => entry.account === account)
    const merged: AccountStateReport = { ...health }
    // The limits dimension is omitted while its owner reports nothing for this account, so
    // an account this build never made eligible is not presented as having a policy. The
    // notice is the owner's own fresh, normalized DTO — never the adopted document and never
    // a taint list — and its absence is reported by the status' own presence flag instead.
    const limits = projectPolicyLimits(
      claudePolicyLimits?.status(account),
      claudePolicyLimits?.unsupported(account),
      claudePolicyLimits?.monitoringNotice(account),
    )
    if (limits !== undefined) merged.policyLimits = limits
    if (view !== undefined) {
      merged.credential = health?.credential ?? {
        state: view.credential.status,
        ...view.credential.status === 'reauth_required' ? { code: 'REAUTH_REQUIRED' as const } : {},
        ...view.credential.nextCheckAt === undefined ? {} : { nextCheckAt: view.credential.nextCheckAt },
        ...view.credential.expiresAt === undefined ? {} : { until: view.credential.expiresAt },
      }
      merged.profile = {
        state: view.profile.status,
        ...view.profile.capturedAt === undefined ? {} : { capturedAt: view.profile.capturedAt },
        complete: view.profile.complete,
      }
      const blocker = view.policy.blockers[0]
      merged.policy = {
        state: view.policy.status,
        ...blocker === undefined ? {} : { code: blocker.code, scope: blocker.scope },
        ...view.policy.fetchedAt === undefined ? {} : { fetchedAt: view.policy.fetchedAt },
      }
      const block = await claudeProtocolBlocks?.state({
        provider: 'claude',
        origin: view.origin,
        fingerprint: view.protocolFingerprint,
      }).then(
        state => state,
        // A store that cannot answer is not an all-clear: the block store's own rule is
        // that an unverifiable record is treated as a block, so the status reports the
        // protocol dimension as blocked instead of healthy.
        (error: unknown) => {
          onWarn(`claude protocol block state could not be read: ${errorChain(error)}`)
          return 'unreadable' as const
        },
      )
      if (block !== undefined && block !== 'absent') {
        const listing = await claudeProtocolBlocks?.list().catch(() => undefined)
        const record = listing?.blocks.find(
          entry => entry.origin === view.origin && entry.fingerprint === view.protocolFingerprint,
        )
        merged.protocol = {
          state: 'upgrade_required',
          code: 'CLIENT_VERSION_UNSUPPORTED',
          profileId: view.protocolFingerprint,
          ...record === undefined ? {} : { since: Date.parse(record.firstSeenAt) },
        }
      }
    }
    return merged
  }
  subscriptionsAuth = new SubscriptionsAuthController(
    // The import path records the source's session shape; the read-only use path is the one
    // that judges what the source itself declared.
    flows, deviceFlows, authChanged, resolveAttachments, usageFetchers,
    () => readClaudeCredentialSource()?.session, poolUsage, config.antigravity,
    codexResetCredits,
    // A re-authorization keeps the device the account already presented, read from the
    // session store. Without this, signing in again would mint a new device id and the
    // machine values derived from it, silently changing the device the service sees.
    async session => carryClaudeIdentity(
      session,
      await claudeTokens?.peek(accountKeyOf('claude', session)),
    ) as ClaudeSession,
    poolStateFor,
    reconcileIdentities,
    accountStateFor,
    refused,
    // The identity gate every Claude credential mutation runs behind.
    claudeAuthIdentity,
  )
  // Live-session ownership of the account maintenance loops.
  //
  // The binding is created by the adapter's pre-request seam for the account a real
  // request actually routed to, and released by the facts that end a session's
  // ownership: session disposal (close or unload), a user stop recorded as an
  // aborted turn, agent disposal, logout or account removal, and plugin disposal.
  // A stream that simply finishes is none of these: the session can send its next
  // prompt, so its maintenance keeps running.
  if (claudeMaintenance !== undefined) {
    const maintenance = claudeMaintenance
    // Every committed model request names its provider and its session, so this is where a
    // session's current owner is read. A request served by another provider retires THIS
    // session's Claude attribution and releases the account binding it held — a no-op when
    // it held none — before the stream is delegated; no other session is touched.
    ctx.on('llm/stream', async function* (options, next) {
      const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
      attribution.noteRequestOwner(options.provider, sessionId)
      if (options.provider !== 'claude' && sessionId !== undefined) {
        await releaseClaudeSession(sessionId)
      }
      yield* next()
    })
    const released = (sessionId: string): void => { void releaseClaudeSession(sessionId) }
    ctx.on('session/disposed', (session) => { released(String(session.id)) })
    ctx.on('agent/disposed', ({ agent }) => { released(String(agent.session.id)) })
    // The user's stop is the recorded cancellation of a live turn, not an idle
    // turn: `turn/end`'s own reason is the durable fact, so a normal completion
    // (or an attempt timeout) never releases the session's maintenance.
    ctx.on('session/event', (session, event) => {
      // The request being built states its own startup fact when its header is appended, and the
      // append calls this listener synchronously: the route therefore reads, while it prepares that
      // very request, whether the session is new or restored. An absent observation stays
      // conservative on the route's side and never becomes "new".
      if (event.type === 'request/header') {
        claudeContinuation.observeRequestHeader(String(session.id), event.data.reason)
        return
      }
      if (event.type !== 'turn/end') return
      const reason = event.data.reason
      if (reason.kind !== 'aborted' || reason.reason.kind !== 'user') return
      released(String(session.id))
    }, { global: true })
    ctx.effect(() => () => (async () => {
      // Admission closes first: the state refuses every new Claude request from this point, so
      // nothing registering or starting during disposal can begin another one. Then each owner is
      // awaited to its own real settlement — the continuation state settles the transition it owns
      // and its file operations, and the release ledger holds only disposal accounting.
      await claudeContinuation.close()
      await claudePolicyLimits?.dispose()
      await claudeReleases.drain()
      await maintenance.dispose()
    })(), 'dsh-plugin-subscriptions: claude account maintenance')
  }
  registerAuthRpc(ctx, subscriptionsAuth, speed, {
    get: () => proxyGetConfig(),
    set: input => proxySetConfig(input),
    test: payload => proxyTestConnection(payload.url, payload.proxy),
  }, modelDefaults, {
    async get(provider, force, refresh = false) {
      await reconcileIdentities()
      await loadModelDefaults()
      const adapter = adapters.get(provider)
      if (!adapter) throw new BadRequest(`provider ${provider} is not configured`)
      if (force || refresh) await refreshCatalog(provider, force)
      const models = await fullCatalogs.get(provider)!(provider)
      // Enumerate each account once, with the same bounds used by pool discovery.
      const accounts = await accountTokens.get(provider)?.list() ?? []
      const accountCatalogs = await Promise.all(accounts.map(async account => ({
        account: account.key,
        models: await withTimeout(signal => adapter.listOwnModels(provider, account.key, signal), DISCOVERY_TIMEOUT_MS).catch(() => undefined),
      })))
      const tierIds = new Set((await poolAdapter?.modelsForProvider(provider).catch(() => []) ?? []).map(model => model.id))
      const rows = await Promise.all(models.map(async model => {
        const contexts: { default: number; max: number }[] = []
        if (provider === 'codex' || provider === 'cursor') {
          const listed = accountCatalogs.filter(account => account.models?.some(entry => entry.id === model.id))
          const targets = listed.length > 0 ? listed.map(account => account.account) : [undefined]
          for (const account of targets) {
            const limits = provider === 'codex'
              ? await codexAdapter?.contextLimits(model.id, account).catch(() => undefined)
              : await cursorAdapter?.contextLimits(model.id, account).catch(() => undefined)
            if (limits) contexts.push(limits)
          }
        }
        // A model with unavailable capabilities can still be hidden or restored.
        const info = await withTimeout(() => adapter.resolveModel(provider, model.id), DISCOVERY_TIMEOUT_MS).catch(() => undefined)
        // Whether this route advertises the model's fast tier: the same
        // question the request-side gate asks, so the Settings picker offers
        // the tier exactly where a chosen fast can reach the wire.
        const fastTier = await adapter.supportsFastTier?.(model.id) ?? false
        const storedSpeed = defaultSpeedOf(provider, model.id)
        return {
          id: model.id, name: model.name,
          contextWindow: info?.context?.contextWindow,
          efforts: tierIds.has(model.id) ? [] : info?.reasoning?.efforts.map(({ id, name }) => ({ id, name })) ?? [],
          configured: defaultEffortOf(provider, model.id),
          ...fastTier ? { fastTier: true } : {},
          ...storedSpeed === undefined ? {} : { configuredSpeed: storedSpeed },
          ...(contexts.length ? {
            defaultContextWindow: Math.min(...contexts.map(entry => entry.default)),
            maxContextWindow: Math.min(...contexts.map(entry => entry.max)),
          } : {}),
        }
      }))
      return {
        provider, settings: preferences.get(provider), models: rows, tools: PROVIDER_TOOLS[provider],
        accounts: accounts.map(({ key, session }) => {
          const catalog = accountCatalogs.find(entry => entry.account === key)?.models
          return {
            key,
            label: accountOf(provider, session) ?? key,
            models: (catalog ?? []).map(model => {
              const disabledReason = modelDisabledReason(model)
              return {
                id: model.id,
                name: model.name,
                ...disabledReason === undefined ? {} : { disabledReason },
              }
            }),
            ...(catalog === undefined ? { unavailable: true } : {}),
          }
        }),
      }
    },
    async set(provider, settings) {
      if (!adapters.has(provider)) throw new BadRequest(`provider ${provider} is not configured`)
      let validated
      try { validated = validatePreferences(provider, settings) } catch (error) {
        throw new BadRequest(error instanceof Error ? error.message : String(error))
      }
      await preferences.set(provider, validated)
      poolAdapter?.invalidate()
      for (const [route, handle] of handles) handle.replace([route])
    },
  })

  // Proactively keep legacy-writeback Claude accounts synced with Claude Code's own store
  // (Keychain/file) every 5 minutes, so a session left idle between requests does not go stale
  // from a token rotation that happened outside this plugin (the `claude` CLI refreshing on its
  // own, or another consumer). This is compatibility behavior, not coordination: the same grant
  // may still be spent twice, and the status says so. A read-only-import account is excluded —
  // its use path re-reads the source instead — and an independent-oauth account has no external
  // source, so neither is touched here.
  if (claudeTokens !== undefined && syncClaudeCodeCredentials) {
    const tokens = claudeTokens
    const syncTimer = setInterval(() => {
      void tokens.list().then((accounts) => {
        for (const { key, session } of accounts) {
          if (!claudeCredentialWritesBack(resolveClaudeCredentialMode(session))) continue
          tokens.session(key).catch(() => {
            // Best-effort: the manager reports a refused grant through the account's status and
            // keeps the credential stored, so a later explicit logout is the only removal.
          })
        }
      }, () => undefined)
    }, 5 * 60_000)
    ctx.effect(() => () => { clearInterval(syncTimer) }, 'dsh-plugin-subscriptions: claude background sync timer')
  }

  // `web` is optional on headless/minimal compositions. Register Codex behind
  // DSH's native web_search tool when the capability seam is mounted.
  //
  // `web_search` is the host's tool, not one this plugin registers, so the
  // Codex switch gates this provider's `available()` rather than the tool
  // itself: turned off, the seam auto-selects another registered provider, or
  // reports WEB_PROVIDER_UNAVAILABLE the way dsh-tool-web expects. Denying the
  // tool per agent would instead take web_search away from every other
  // provider in the composition.
  if (codexTokens !== undefined) {
    const tokens = codexTokens
    ctx.inject(['web'], webCtx => {
      webCtx.web.registerSearchProvider(new CodexWebSearchProvider({
        tokens,
        enabled: () => preferences.toolEnabled('codex', 'web_search'),
        hasAccount: () => codexAccountPresent,
        fetchFn: proxiedFetch,
      }))
      // Seed the flag: registration happens after the accounts are known.
      refreshCodexPresence()
    })
  }

  // `tools` is optional (headless/minimal compositions may not mount it), so
  // registration waits for the service instead of injecting it at load.
  // x_search and video_generate follow the grok provider; image_generate
  // prefers the codex provider and falls back to grok.
  ctx.inject(['tools'], (toolsCtx) => {
    const registeredNames = new Map<string, string>()
    if (grokTokens !== undefined) {
      for (const definition of [
        createXSearchTool({ tokens: grokTokens }),
        createVideoGenerateTool({ tokens: grokTokens }),
      ]) {
        const registered = registerWithAlias(toolsCtx.tools, definition)
        if (registered !== undefined) registeredNames.set(definition.name, registered)
      }
    }
    if (codexTokens !== undefined || grokTokens !== undefined) {
      const registered = registerWithAlias(toolsCtx.tools, createImageGenerateTool({
        imagePool,
        ...codexTokens === undefined ? {} : { codexTokens },
        ...grokTokens === undefined ? {} : { grokTokens },
        resolveAttachments,
        resolveLlm: () => ctx.get('llm'),
        providerEnabled: (provider, createdAt) => preferences.toolEnabled(provider, 'image_generate', createdAt),
      }))
      if (registered !== undefined) registeredNames.set('image_generate', registered)
    }
    // Managed-policy enforcement lives at the execution stage, not in a one-time
    // visibility scan: a policy adopted long after this agent was created must still stop
    // the call, and one that stops denying must stop blocking. The guard reads the live
    // policy for the accounts THIS session routed to, so it never narrows another
    // session's surface — which is also why it is registered once for every agent rather
    // than per agent.
    if (claudeMaintenance !== undefined) {
      const controller = claudeMaintenance
      const decide = internals.toolPolicyDecision ?? ((account: string, tool: string): ToolPolicyDecision => {
        // The Host's own registered definition is the only evidence of what this call does: a
        // tool whose name merely resembles a capability is not that capability.
        const operation = claudeToolOperation(toolsCtx.tools.get(tool))
        // The accepted managed-settings policy first: its taints, its non-empty `defaults`
        // and its unmapped keys are the general blockers, and this build cannot prove which
        // capabilities an arbitrary tool exercises, so they are judged over every scope.
        const policy = controller.assertAllowed({
          account,
          capabilities: claudeScopesFor('unknown'),
          tool,
        })
        if (policy.decision === 'deny') return { decision: 'deny', code: policy.code }
        // Then the independent `policy_limits` verdicts, only for the operations their own
        // mapping declares. An account this build never made eligible holds no limits state
        // and contributes nothing here, so a known Pro/Max account is never constrained by a
        // document that was never read for it.
        const limits = claudePolicyLimits
        if (limits === undefined) return { decision: 'allow' }
        return policyLimitsOperationDenial({
          status: limits.status(account),
          operation,
          keys: limitsKeysFor(account),
          verdict: key => limits.verdict(account, key),
          mapping: policyKeyMapping,
        })
      })
      toolsCtx.tools.guard(execution => claudeToolPolicyDenial({
        execution,
        accountsFor: sessionId => attribution.accountsFor(sessionId),
        decide,
      }))
    }
    // Restrictions are scoped to each agent. Keep global definitions registered
    // so already-open sessions retain both their schemas and execution path.
    toolsCtx.on('agent/created', ({ agent }) => {
      const at = agent.session.header.createdAt
      const deny: string[] = []
      if (grokTokens !== undefined) {
        for (const tool of ['x_search', 'video_generate'] as const) {
          const registered = registeredNames.get(tool)
          if (registered !== undefined && !preferences.toolEnabled('grok', tool, at)) deny.push(registered)
        }
      }
      if ((codexTokens !== undefined || grokTokens !== undefined)
        && !(codexTokens !== undefined && preferences.toolEnabled('codex', 'image_generate', at))
        && !(grokTokens !== undefined && preferences.toolEnabled('grok', 'image_generate', at))) {
        const registered = registeredNames.get('image_generate')
        if (registered !== undefined) deny.push(registered)
      }
      if (deny.length) agent.ctx.tools.restrict({ deny })
      return undefined
    })
  })
}
