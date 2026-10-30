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
 * {@link CcPoolCachePolicy.cacheMarkerPolicy} selects the Claude Code 2.1.288
 * three-marker layout. The default policy is `cc3` with `cacheTtl: "1h"` and
 * `extendedCacheBeta: true`, and {@link resolvePoolCachePolicy} refuses a
 * combination that cannot serve a request. The profile resolver carries these
 * as the route's pi-ai `cacheRetention`, `extendedCacheBeta`, and
 * `cacheMarkerPolicy`; pi-ai builds the `cache_control` markers, the identity
 * system block, the beta, and the pinned client's top-level field order from
 * them, and nothing here rewrites a request body. No other route reads these
 * values.
 *
 * The route may additionally ask for the CC wire parity wire, but only the member
 * endpoint can grant it: {@link poolProviderProfile} adds the `ccWireParity` flag
 * to the profile once the plugin's capability probe proved it for this endpoint
 * and the pool build that answered. The cache policy fields still ship alongside
 * that flag, because a wire-parity-off request keeps the route's current wire,
 * and the adapter's wire-parity branch owns the wire-parity body and headers;
 * nothing here rewrites either.
 *
 * Wire parity declares its own cache intent, so it can carry any policy this
 * route's own rules admit: a policy whose {@link CcPoolCachePolicy.cacheTtl} is
 * `none` is the deployment's caching-disabled state, and
 * {@link poolProviderProfile} maps it to `ccWireParityCache: "off"` so a main or
 * subagent wire-parity request asks the worker for no marker, no TTL, and no
 * cache beta. Every other lifetime maps to `"main"`, the worker's own cache
 * plan. The intent is profile data the adapter declares in its member headers;
 * no cache setting here reaches a wire-parity body.
 *
 * @module dsh-llm-cc-pool/pool
 */
import { resolvePiAiProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type {
  PiAiCacheMarkerPolicy,
  PiAiCcWireParityCache,
  PiAiModality,
  PiAiProviderProfile,
  PiAiReasoningEfforts,
  ResolvedPiAiProviderProfile,
} from '@deepseek-ai/dsh-llm-pi-ai'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { POOL_REQUEST_CLOSED_CODE } from '@deepseek-ai/dsh-llm'
import type { PoolCapabilityProof } from './discovery.ts'

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
 * request to another provider never reads it. The route's default policy
 * declares `1h` and the three-marker layout, and that combination also requires
 * {@link CcPoolCachePolicy.extendedCacheBeta}; {@link resolvePoolCachePolicy}
 * refuses the other lifetimes while `cc3` owns placement.
 */
export const CACHE_TTLS = Object.freeze(['5m', '1h', 'none'] as const)

/** One prompt-cache TTL this route may declare; see {@link CACHE_TTLS}. */
export type CcPoolCacheTtl = (typeof CACHE_TTLS)[number]

/**
 * The route's prompt-cache policy, one explicit choice per field.
 *
 * A policy applies to the whole route and reaches the wire only through this
 * route's profile: `cacheTtl` selects the marker lifetime, `extendedCacheBeta`
 * adds the beta a one-hour lifetime declares, and `cacheMarkerPolicy` replaces
 * the transport's placement with the Claude Code 2.1.288 layout when configured.
 * {@link resolvePoolCachePolicy} refuses a policy whose fields cannot serve a
 * request together. A policy of `cacheTtl: "none"` is also this route's
 * caching-disabled state, so a profile that enables wire parity declares cache
 * intent `off`; every other policy declares `main`. Wire parity does not
 * constrain the policy itself, because the wire-parity body carries no marker
 * of its own and the worker, not this route, writes the cache plan.
 */
export interface CcPoolCachePolicy {
  /** Marker lifetime every block marked on this route declares; see {@link CACHE_TTLS}. */
  cacheTtl: CcPoolCacheTtl
  /**
   * Add `extended-cache-ttl-2025-04-11` to the request's `anthropic-beta`
   * header. `1h` writes `ttl: "1h"` on the markers, while this field alone
   * declares the beta that permits it; {@link resolvePoolCachePolicy} refuses
   * a one-hour lifetime without it.
   */
  extendedCacheBeta: boolean
  /**
   * Prompt-cache marker placement pi-ai performs for this route, or omission
   * for the transport's own placement. `cc3` places the Claude Code 2.1.288
   * layout — the client identity system block, the harness system block, and
   * the last cacheable user content block — and takes precedence over the
   * marker field on this route: it discards the markers {@link cacheTtl}
   * selects and writes `{type: "ephemeral", ttl: "1h"}` on the slots it owns. It
   * marks no tool declaration and no message before the last user turn, writes
   * the pinned client's top-level field order with an empty `metadata` in its
   * canonical slot, and requires `cacheTtl: "1h"` and
   * `extendedCacheBeta: true`.
   */
  cacheMarkerPolicy?: PiAiCacheMarkerPolicy
}

/**
 * The policy this route serves by default: the three Claude Code markers with
 * the explicit one-hour lifetime and the beta that permits it.
 */
export const DEFAULT_CACHE_POLICY: CcPoolCachePolicy = Object.freeze({
  cacheTtl: '1h',
  extendedCacheBeta: true,
  cacheMarkerPolicy: 'cc3',
})

/**
 * A prompt-cache policy that cannot serve a request.
 *
 * Raised while the plugin resolves its loader configuration and each route
 * profile, so the deployment learns the combination at load instead of at the
 * first turn. No caller catches it into a fallback: an impossible policy fails
 * the plugin.
 */
export class CcPoolCachePolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CcPoolCachePolicyError'
  }
}

/**
 * The cache intent a wire parity request of this route declares.
 *
 * A route whose policy writes no marker — `cacheTtl: "none"`, the deployment's
 * caching-disabled state — keeps wire parity and asks the worker for no cache
 * plan, so it declares `off`. Every other lifetime keeps the worker's main
 * plan.
 * @param policy - the route's resolved cache policy.
 * @returns the cache intent a main or subagent wire-parity request declares.
 */
function wireParityCacheIntent(policy: CcPoolCachePolicy): PiAiCcWireParityCache {
  return policy.cacheTtl === 'none' ? 'off' : 'main'
}

/**
 * Validate one prompt-cache policy before it can become a route profile.
 *
 * The one-hour lifetime requires the extended beta, and the `cc3` policy
 * requires both; a policy that names one without the other would only fail at
 * the provider, after the request left the host. A CC wire parity request adds no
 * requirement of its own: its body carries no cache marker, so the worker's plan
 * follows {@link wireParityCacheIntent} rather than these fields. This runs at
 * plugin load and on every profile resolution — including the settings-write
 * validation — so an impossible combination is refused where it is written.
 * @param policy - the policy a deployment or caller supplied.
 * @returns the same policy, unchanged, when it can serve a request.
 * @throws {CcPoolCachePolicyError} naming the field combination that cannot serve a request.
 */
export function resolvePoolCachePolicy(policy: CcPoolCachePolicy): CcPoolCachePolicy {
  if (policy.cacheTtl === 'none') {
    // A caching-disabled route has no marker placement to perform. The
    // configured marker policy is not applicable, so it cannot veto `none`;
    // the resolved policy carries neither markers nor the extended beta.
    const { cacheMarkerPolicy: _marker, ...rest } = policy
    return { ...rest, extendedCacheBeta: false }
  }
  if (policy.cacheMarkerPolicy === 'cc3') {
    if (policy.cacheTtl !== '1h') {
      throw new CcPoolCachePolicyError(
        `llm-cc-pool: cacheMarkerPolicy "cc3" requires cacheTtl "1h"; got ${JSON.stringify(policy.cacheTtl)}`,
      )
    }
    if (!policy.extendedCacheBeta) {
      throw new CcPoolCachePolicyError('llm-cc-pool: cacheMarkerPolicy "cc3" requires extendedCacheBeta: true')
    }
  }
  if (policy.cacheTtl === '1h' && !policy.extendedCacheBeta) {
    throw new CcPoolCachePolicyError('llm-cc-pool: cacheTtl "1h" requires extendedCacheBeta: true')
  }
  return policy
}

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
 *   three-marker, one-hour policy with the extended beta.
 * @param proof - the capability proof the member endpoint answered for this
 *   endpoint and pool build. Omission keeps the profile on the current
 *   three-marker wire; a proof adds the adapter-owned flag and the cache intent
 *   its main and subagent requests declare — `off` for a `cacheTtl` of `none`,
 *   the route's caching-disabled state, and `main` otherwise. The policy fields
 *   stay as the wire-parity-off fallback the adapter reproduces.
 * @returns the raw profile the generic resolver validates.
 * @throws {CcPoolCachePolicyError} when the policy combination cannot serve a
 *   request.
 */
export function poolProviderProfile(
  models: readonly CcPoolModel[] = MODELS,
  policy: CcPoolCachePolicy = DEFAULT_CACHE_POLICY,
  proof?: PoolCapabilityProof,
): PiAiProviderProfile {
  const resolved = resolvePoolCachePolicy(policy)
  return {
    displayName: DISPLAY_NAME,
    apiKeyEnv: API_KEY_REF,
    api: 'anthropic-messages',
    baseURL: BASE_URL,
    headers: { ...REQUEST_HEADERS },
    cacheRetention: CACHE_RETENTION[resolved.cacheTtl],
    extendedCacheBeta: resolved.extendedCacheBeta,
    ...resolved.cacheMarkerPolicy === undefined ? {} : { cacheMarkerPolicy: resolved.cacheMarkerPolicy },
    ...proof === undefined ? {} : { ccWireParity: true, ccWireParityCache: wireParityCacheIntent(resolved) },
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
 *   three-marker, one-hour policy with the extended beta.
 * @param proof - the capability proof the member endpoint answered; see
 *   {@link poolProviderProfile}. The proof is passed to the generic resolver as
 *   the capability grant, so the flag it enables is backed by evidence for this
 *   route instead of by profile configuration.
 * @returns the resolved profiles keyed by {@link PROVIDER}.
 * @throws {CcPoolCachePolicyError} when the policy combination cannot serve a request.
 */
export function resolvePoolProfiles(
  models: readonly CcPoolModel[] = MODELS,
  policy: CcPoolCachePolicy = DEFAULT_CACHE_POLICY,
  proof?: PoolCapabilityProof,
): ReadonlyMap<string, ResolvedPiAiProviderProfile> {
  return resolvePiAiProfiles(
    { [PROVIDER]: poolProviderProfile(models, policy, proof) },
    proof === undefined ? undefined : new Map([[PROVIDER, proof]]),
  )
}
