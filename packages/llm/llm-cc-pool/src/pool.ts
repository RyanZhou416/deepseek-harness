/**
 * The mac pool's fixed provider facts and model catalogue.
 *
 * The route, endpoint, credential reference, and headers are external
 * specifications of the deployed pool, not deployment tunables: one route
 * (`cc-pool`), one Anthropic Messages endpoint, one credential reference. A
 * change to any of them is a new plugin version, so the module exposes those
 * facts as frozen values and resolves them through the generic pi-ai profile
 * resolver. The model catalogue is the deployment's own choice: without
 * configuration it is the built-in four-model catalogue, and a profile may
 * replace it wholesale through `Config.models`. Either way the catalogue passes
 * {@link resolvePoolModels} before it can serve a request. The plugin
 * deliberately registers no configurable-provider entry: a model can only enter
 * this route through the validated catalogue, and the separate discovery read
 * reports candidates without writing that catalogue.
 *
 * Prompt-cache policy is the third deployment choice: {@link CACHE_TTLS} names
 * the route's marker value, {@link CcPoolCachePolicy.extendedCacheBeta} declares
 * the beta a one-hour lifetime requires, and
 * {@link CcPoolCachePolicy.toolCacheBreakpoint} selects whether a tool
 * definition carries a marker. The profile resolver carries all three as the
 * route's pi-ai `cacheRetention`, `extendedCacheBeta`, and
 * `compat.supportsCacheControlOnTools`; pi-ai builds the `cache_control` markers
 * and beta from them, and nothing here rewrites a request body. No other route
 * reads these values.
 *
 * @module dsh-llm-cc-pool/pool
 */
import { resolvePiAiProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type {
  PiAiModality,
  PiAiProviderProfile,
  PiAiReasoningEfforts,
  ResolvedPiAiProviderProfile,
} from '@deepseek-ai/dsh-llm-pi-ai'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { POOL_REQUEST_CLOSED_CODE } from '@deepseek-ai/dsh-llm'

/** Harness route key, pi-ai provider key, and the only provider this plugin owns. */
export const PROVIDER = 'cc-pool'

/** Label selector surfaces show for the route. */
export const DISPLAY_NAME = 'CC 订阅池'

/** The pool member endpoint the reverse tunnel proxies. */
export const BASE_URL = 'https://ccpool.tiancegames.com'

/** Credential reference resolved per request through the harness credential seam. */
export const API_KEY_REF = 'CC_POOL_API_KEY'

/** Deployment header the pool member endpoint selects the direct backend with. */
export const REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({ 'x-cc-backend': 'direct' })

/** Request modalities every catalogue model accepts. */
export const MODEL_INPUT: readonly PiAiModality[] = Object.freeze(['text', 'image'])

/**
 * The prompt-cache TTL choices this route may declare, in the order a
 * configuration surface offers them.
 *
 * A choice is the marker lifetime Anthropic caches the request prefix under,
 * not a request field of its own: `5m` is the API's default lifetime and sends
 * `cache_control: {type: "ephemeral"}`, `1h` extends it with
 * `cache_control: {type: "ephemeral", ttl: "1h"}`, and `none` sends no marker
 * at all. The value reaches the wire only through this route's profile, so a
 * request to another provider never reads it.
 */
export const CACHE_TTLS = Object.freeze(['5m', '1h', 'none'] as const)

/** One prompt-cache TTL this route may declare; see {@link CACHE_TTLS}. */
export type CcPoolCacheTtl = (typeof CACHE_TTLS)[number]

/**
 * The route's prompt-cache policy, one explicit choice per field.
 *
 * A policy applies to the whole route and reaches the wire only through this
 * route's profile: `cacheTtl` selects the marker lifetime, `extendedCacheBeta`
 * adds the beta a one-hour lifetime declares, and `toolCacheBreakpoint`
 * selects whether the last tool definition carries a marker.
 */
export interface CcPoolCachePolicy {
  /** Marker lifetime every block marked on this route declares; see {@link CACHE_TTLS}. */
  cacheTtl: CcPoolCacheTtl
  /**
   * Add `extended-cache-ttl-2025-04-11` to the request's `anthropic-beta`
   * header. Independent of {@link cacheTtl}: `1h` writes `ttl: "1h"` on the
   * markers, while this field alone declares the beta that permits it.
   */
  extendedCacheBeta: boolean
  /**
   * Mark the last tool declaration with `cache_control`. `false` keeps the
   * Claude Code 2.1.288 layout this route mirrors, which marks the system
   * prompt and the last user content block and no tool definition.
   */
  toolCacheBreakpoint: boolean
}

/** The policy this route served before its fields were configurable. */
export const DEFAULT_CACHE_POLICY: CcPoolCachePolicy = Object.freeze({
  cacheTtl: '5m',
  extendedCacheBeta: false,
  toolCacheBreakpoint: true,
})

/** The profile field that carries a TTL choice to pi-ai. */
type PiAiCacheRetention = NonNullable<PiAiProviderProfile['cacheRetention']>

/**
 * pi-ai's retention tier for each TTL choice. The tier is what selects the
 * `cache_control` value: `short` keeps the default 5-minute lifetime, `long`
 * adds `ttl: "1h"`, and `none` suppresses the marker.
 */
const CACHE_RETENTION: Readonly<Record<CcPoolCacheTtl, PiAiCacheRetention>> = Object.freeze({
  '5m': 'short',
  '1h': 'long',
  none: 'none',
})

/**
 * A default thinking level a pool model starts from. The pool offers the five
 * escalating levels below; `off` and `minimal` are not part of its catalogue.
 */
export type CcPoolReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * The five selectable efforts of every pool model, in escalation order.
 *
 * The list is a fixed pool fact rather than configuration: a catalogue entry
 * chooses its default among these levels and cannot widen or narrow the offer.
 * `off`, `minimal`, and the fast `speed` tier are deliberately absent — the
 * pool's adaptive thinking has no "do not think" level and no priority tier, so
 * a selector must not offer one.
 */
export const REASONING_LEVELS: readonly CcPoolReasoningLevel[] = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Selectable reasoning efforts for every catalogue model: the offered level is
 * also its wire spelling.
 */
export const REASONING_EFFORTS: PiAiReasoningEfforts = Object.freeze({
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
})

/**
 * A mac-pool model catalogue entry: the deployable facts of one wire model id.
 * `defaultReasoning` is that model's default effort, materialized by the seam
 * into a request that names none.
 */
export interface CcPoolModel {
  /** Wire model id sent to the pool; non-empty and unique within the catalogue. */
  id: string
  /** Display name selector surfaces show; non-empty. */
  name: string
  /** Maximum combined request and response context in tokens. */
  contextWindow: number
  /** Maximum output tokens; also this model's per-request default cap. */
  maxTokens: number
  /** Default thinking level this model starts from; one of {@link REASONING_LEVELS}. */
  defaultReasoning: CcPoolReasoningLevel
}

/**
 * The built-in model catalogue, in selector order.
 *
 * The capacities are the pool catalogue's: 1M context for every model, 128k
 * output for Sonnet/Opus and 64k for Fable/Mythos. This is the catalogue a
 * profile that configures no `models` list serves; a deployment whose pool
 * serves a different model set replaces it through `Config.models`.
 */
export const MODELS: readonly CcPoolModel[] = Object.freeze([
  Object.freeze({ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxTokens: 128_000, defaultReasoning: 'medium' }),
  Object.freeze({ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 1_000_000, maxTokens: 128_000, defaultReasoning: 'medium' }),
  Object.freeze({ id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextWindow: 1_000_000, maxTokens: 64_000, defaultReasoning: 'high' }),
  Object.freeze({ id: 'claude-mythos-5-1', name: 'Claude Mythos 5.1', contextWindow: 1_000_000, maxTokens: 64_000, defaultReasoning: 'high' }),
])

/**
 * Resolve the catalogue a deployment configured, or the built-in one.
 *
 * Omission serves {@link MODELS}; a provided list replaces it wholesale. Every
 * entry is validated here because this is the one step both the plugin load and
 * a settings write pass through, so a catalogue that could not serve a request
 * fails loud with the offending entry named instead of surfacing at the first
 * turn. A field schema cannot express the catalogue-wide facts (unique ids, at
 * least one model), and programmatic callers bypass the schema entirely.
 * @param configured - the configured catalogue, when a deployment supplied one.
 * @returns the effective catalogue in selector order, detached and frozen.
 * @throws Error naming the entry and field that cannot serve a request.
 */
export function resolvePoolModels(configured?: readonly CcPoolModel[]): readonly CcPoolModel[] {
  if (configured === undefined) return MODELS
  if (configured.length === 0) {
    throw new Error('llm-cc-pool: models must name at least one model; omit models to serve the built-in catalogue')
  }
  const seen = new Set<string>()
  const resolved = configured.map((model, index) => {
    if (model.id.length === 0) throw new Error(`llm-cc-pool: models[${index}] has an empty id`)
    if (seen.has(model.id)) throw new Error(`llm-cc-pool: models lists "${model.id}" more than once`)
    seen.add(model.id)
    if (model.name.length === 0) throw new Error(`llm-cc-pool: model "${model.id}" has an empty name`)
    if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) {
      throw new Error(`llm-cc-pool: model "${model.id}" contextWindow must be a positive integer`)
    }
    if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) {
      throw new Error(`llm-cc-pool: model "${model.id}" maxTokens must be a positive integer`)
    }
    if (!REASONING_LEVELS.includes(model.defaultReasoning)) {
      throw new Error(
        `llm-cc-pool: model "${model.id}" defaultReasoning must be one of ${REASONING_LEVELS.join(', ')};`
        + ' off, minimal, and speed are not pool levels',
      )
    }
    return Object.freeze({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      defaultReasoning: model.defaultReasoning,
    })
  })
  return Object.freeze(resolved)
}

/**
 * The pool route's fixed retry policy: two retries over rate limits and server
 * faults, plus a closed client request id. The explicit list is used exactly as
 * written, which keeps `TRANSPORT`, `EMPTY_RESPONSE`, and `TIMEOUT` out of
 * automatic resends: each can follow an attempt that already reached the pool,
 * so the pool may hold a ledger record whose outcome is unknown and repeating it
 * is the deployment's decision. A closed request id is different: the loop
 * stamps a new attempt id on the retry, so the next send is a new ledger entry
 * instead of a replay of the refused one. Capacity and rate-limit refusals are
 * likewise not in the list, so their `Retry-After` reaches the caller instead of
 * being resent automatically.
 * @returns a detached policy the profile resolver captures at mount.
 */
function retryPolicy(): RetryPolicyConfig {
  return {
    mode: 'normal',
    maxRetries: 2,
    retryableCodes: ['RATE_LIMIT', 'SERVER', POOL_REQUEST_CLOSED_CODE],
  }
}

/**
 * The one configured profile this plugin resolves.
 * @param models - the effective catalogue; omission serves the built-in catalogue.
 * @param policy - prompt-cache policy this route declares; omission declares the
 *   five-minute lifetime and tool marker the route served before the policy was
 *   configurable.
 * @returns the raw profile the generic resolver validates.
 */
export function poolProviderProfile(
  models: readonly CcPoolModel[] = MODELS,
  policy: CcPoolCachePolicy = DEFAULT_CACHE_POLICY,
): PiAiProviderProfile {
  return {
    displayName: DISPLAY_NAME,
    apiKeyEnv: API_KEY_REF,
    api: 'anthropic-messages',
    baseURL: BASE_URL,
    headers: { ...REQUEST_HEADERS },
    cacheRetention: CACHE_RETENTION[policy.cacheTtl],
    extendedCacheBeta: policy.extendedCacheBeta,
    compat: { supportsCacheControlOnTools: policy.toolCacheBreakpoint },
    retryPolicy: retryPolicy(),
    models: models.map(model => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: [...MODEL_INPUT],
      reasoningEfforts: { ...REASONING_EFFORTS },
      reasoning: model.defaultReasoning,
      // Adaptive thinking makes a level an effort rather than a token budget;
      // without it pi-ai sends budget-based thinking instead of output_config.
      compat: { forceAdaptiveThinking: true },
    })),
  }
}

/**
 * Resolve one catalogue strictly, so a malformed entry fails the plugin at load
 * instead of at the first request.
 * @param models - the effective catalogue; omission serves the built-in catalogue.
 * @param policy - prompt-cache policy this route declares; omission declares the
 *   five-minute lifetime and tool marker.
 * @returns the resolved profiles keyed by {@link PROVIDER}.
 */
export function resolvePoolProfiles(
  models: readonly CcPoolModel[] = MODELS,
  policy: CcPoolCachePolicy = DEFAULT_CACHE_POLICY,
): ReadonlyMap<string, ResolvedPiAiProviderProfile> {
  return resolvePiAiProfiles({ [PROVIDER]: poolProviderProfile(models, policy) })
}
