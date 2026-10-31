/**
 * Configuration schema and provider-profile validation for the pi-ai adapter.
 * Profiles are a dict keyed by provider route, so the composition base and a
 * user-settings layer merge per provider and the route set is structural.
 *
 * A route key is not required to name an installed pi-ai provider. When it does,
 * that provider's endpoint, protocol, display name, and model catalog are the
 * profile's defaults and the profile overrides them field by field; when it does
 * not, the profile is the whole provider declaration. Stored reads retain
 * catalog diagnostics beside serviceable models; writes validate every changed
 * provider before persistence. Self-contained profile constraints apply to both.
 *
 * @module dsh-llm-pi-ai/config
 */
import type { Volatile } from '@deepseek-ai/cordis'

import type { CacheRetention, ChatTemplateKwargValue, ModelThinkingLevel, Provider, ThinkingBudgets, Transport } from '@earendil-works/pi-ai'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import {
  CACHE_CONTROL_FORMATS,
  CHAT_TEMPLATE_VARS,
  MAX_TOKENS_FIELDS,
  MODALITIES,
  PiAiCatalogError,
  resolveRouteModels,
  SUPPORTED_THINKING_FORMATS,
  THINKING_LEVELS,
  THINKING_TOKEN_BUDGET_FIELDS,
} from './catalog.ts'
import type {
  PiAiCompatProfile,
  PiAiModality,
  PiAiModelOverride,
  PiAiModelProfile,
  PiAiReasoningEfforts,
  RouteCatalog,
} from './catalog.ts'
import { POOL_RETRYABLE_CODES } from './pool-error.ts'
import { buildProvider, supportedProtocols } from './provider.ts'
import {
  DEFAULT_REQUEST_LOG_MAX_FILE_BYTES,
  DEFAULT_REQUEST_LOG_MAX_FILES,
  defaultRequestLogPath,
  MAX_REQUEST_LOG_TOTAL_BYTES,
  redactEndpoint,
} from './request-log.ts'
import type { ResolvedRequestLogConfig } from './request-log.ts'

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Default request-level bound on base64-encoded image payload. Every image in
 * history is re-encoded into every request body, so an unbounded conversation
 * eventually exceeds a provider or gateway request-size cap and the session
 * can never complete another request. The 20MiB default admits fifteen 1MiB
 * request versions after base64 expansion and reserves request capacity for
 * system prompts, history, tools, and JSON.
 * Deployments behind stricter gateways lower it per route.
 */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** Default total-pixel budget preserves the complete 2048px normalized attachment. */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
/** Default raw encoded-byte target before inline base64 expansion; the smallest quality-ladder output is used when no quality fits. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/**
 * Prompt-cache marker placement policies a route may opt into.
 *
 * Omission leaves placement to pi-ai's `cacheRetention` handling. `cc3` is the
 * Claude Code 2.1.288 layout: the client's identity system block, the harness
 * system block, and the last cacheable user content block. The policy owns the
 * complete marker set, the identity block, and the top-level field order on the
 * route, so it removes every marker pi-ai or a caller placed first, marks no
 * message before the last user turn, and never marks a tool declaration. It is
 * class-aware about the lifetime: a main or subagent request gets the one-hour
 * marker with the extended beta the route declares, while a helper (`compaction`,
 * `auxiliary`) request keeps the API's default five-minute lifetime with no
 * `ttl` and no extended beta.
 */
export const CACHE_MARKER_POLICIES = ['cc3'] as const

/** One placement policy from {@link CACHE_MARKER_POLICIES}. */
export type PiAiCacheMarkerPolicy = (typeof CACHE_MARKER_POLICIES)[number]

/**
 * Member header names this adapter owns: the class, system layout, and cache
 * intent of one wire-parity request. On a wire-parity request the adapter writes
 * all three or none, and on every route it strips a profile header spelled the
 * same way in any casing, so a profile can neither race the adapter's values nor
 * inject a partial wire-parity header set on a route that never enables wire
 * parity. Resolution refuses such a header instead of allowing either outcome.
 */
export const CC_WIRE_PARITY_MEMBER_HEADERS = Object.freeze({
  requestClass: 'x-cc-request-class',
  systemLayout: 'x-cc-system-layout',
  cacheIntent: 'x-cc-cache-intent',
} as const)

/**
 * The member header names this adapter owns, folded once for case-insensitive
 * comparison.
 *
 * Header names are case-insensitive, so both the resolution refusal and the
 * per-request stripping compare a lower-cased spelling. One frozen set keeps
 * the two decisions reading the same pre-folded names.
 */
export const CC_WIRE_PARITY_OWNED_HEADERS: ReadonlySet<string> = Object.freeze(new Set(
  Object.values(CC_WIRE_PARITY_MEMBER_HEADERS).map(name => name.toLowerCase()),
))

/**
 * Cache intents a CC wire parity route may declare for a main or subagent request.
 *
 * `main` leaves the pool's main cache plan in place: the worker marks the
 * static, dynamic, and last-user slots under its own TTL and beta decisions.
 * `off` is the wire-parity-on form of a deployment that turned prompt caching
 * off: the same member body, class, and layout, but cache intent `off`, so the
 * worker writes no marker, no TTL, and no cache beta. Helpers (`compaction`,
 * `auxiliary`) always declare `helper`, which is already marker-free, so this
 * choice never applies to them.
 */
export const CC_WIRE_PARITY_CACHE_MODES = ['main', 'off'] as const

/** One wire-parity cache intent from {@link CC_WIRE_PARITY_CACHE_MODES}. */
export type PiAiCcWireParityCache = (typeof CC_WIRE_PARITY_CACHE_MODES)[number]

/**
 * The capability answer that may enable one route's CC wire parity wire.
 *
 * A proof is runtime evidence, not configuration: a fixed-route plugin that
 * interrogated its own capability endpoint passes it to profile resolution
 * after a positive answer. Profile resolution refuses
 * {@link PiAiProviderProfile.ccWireParity} without one, so loader
 * configuration cannot enable the wire, and the proof binds to the origin that
 * answered.
 */
export interface PiAiCcWireParityProof {
  /** Absolute capability-endpoint URL that answered. */
  readonly endpoint: string
  /** Pool build identity that the answer named. */
  readonly buildId: string
}

/**
 * Capability proofs keyed by the route each one may enable CC wire parity for.
 *
 * Only the plugin that owns the probe supplies these to
 * {@link resolvePiAiProfiles}; the generic plugin's loader configuration has
 * none, which confines the wire to the route that proved it.
 */
export type PiAiCcWireParityProofs = ReadonlyMap<string, PiAiCcWireParityProof>

/** Context capacity assumed for a model neither configuration nor the catalog sizes. */
export const DEFAULT_CONTEXT_WINDOW = 262_144

/** Output capability assumed for a model neither configuration nor the catalog sizes. */
export const DEFAULT_MAX_TOKENS = 32_768

/**
 * Modalities assumed for a model neither configuration nor the catalog
 * declares. Text is the floor every supported protocol certainly carries, so
 * this is the absence of a declaration rather than a guess at the endpoint:
 * nothing can interrogate a gateway for its modalities, and the two wrong
 * answers do not cost the same. Under-claiming refuses the image before it is
 * attached, naming the model. Over-claiming admits one the provider then
 * rejects mid-turn, after the message is durable, leaving the session
 * repeating a request that cannot succeed.
 */
export const DEFAULT_INPUT: readonly PiAiModality[] = ['text']

export type {
  PiAiCompatProfile,
  PiAiModality,
  PiAiModelOverride,
  PiAiModelProfile,
  PiAiReasoningEfforts,
  PiAiThinkingFormat,
} from './catalog.ts'

/** Configuration for one pi-ai provider route; the `providers` dict key IS the route. */
export interface PiAiProviderProfile {
  /** Credential reference (environment-variable name) resolved per request through `ctx.credentials`. */
  apiKeyEnv?: string
  /** Name shown by configuration surfaces; defaults to the route key. */
  displayName?: string
  /**
   * Wire protocol every model on this route speaks. Omission keeps each
   * installed catalog model's own protocol, which is why a catalog route needs
   * no protocol at all; a route the catalog does not ship must name one.
   */
  api?: string
  /** Endpoint for this route's models; defaults to the installed catalog's endpoint. */
  baseURL?: string
  /**
   * This route's model catalog. Omission serves the installed catalog for the
   * route unchanged; an explicit list replaces it, each entry defaulting its
   * unset fields from the installed model of the same id.
   */
  models?: PiAiModelProfile[]
  /**
   * Installed-catalog customizations by model id: each entry reshapes that
   * one model with the same fields a {@link models} entry takes, while the
   * rest of the catalog keeps serving untouched. Only meaningful on a catalog
   * route with no `models` list — `models` already replaces the catalog, so
   * an override beside it, on a route the catalog does not ship, or naming a
   * model the catalog does not describe is refused rather than skipped.
   */
  modelOverrides?: Record<string, PiAiModelOverride>
  /**
   * pi-ai wire-compatibility switches defaulting every model on this route
   * whose protocol declares them; each model's own `compat` overrides per
   * field. What neither sets keeps the installed catalog entry's value, then
   * pi-ai's own detection. A switch no model on the route could read is
   * refused rather than left looking applied.
   */
  compat?: PiAiCompatProfile
  /**
   * Context capacity for a model this route lists that neither the entry nor
   * the installed catalog sizes (default 262,144). A guess by construction, so
   * a deployment whose gateway serves smaller models corrects it here.
   */
  defaultContextWindow?: number
  /**
   * Output capability for a model this route lists that neither the entry nor
   * the installed catalog sizes (default 32,768). This sizes the model; it
   * never becomes a per-request cap on its own.
   */
  defaultMaxTokens?: number
  /**
   * Request modalities for a model this route lists that neither its entry's
   * {@link PiAiModelProfile.input} nor the installed catalog declares (default
   * `[text]`). A fallback like the capacities above, not an override: a
   * catalog model keeps the modalities the catalog records for it, and this
   * value never narrows one. A gateway serving vision models the catalog does
   * not describe declares `[text, image]` once here instead of on every entry.
   * Unlike an entry's list, this one may not be empty — nothing sits below it
   * to answer instead.
   */
  defaultInput?: PiAiModality[]
  /** Provider request headers, validated against Fetch when the profile resolves; Harness attribution wins reserved names. */
  headers?: Record<string, string>
  /**
   * Route-level default pi-ai reasoning level: described as the default effort
   * of every model on this route that configures no {@link PiAiModelProfile.reasoning}
   * of its own, and materialized into a request that names no effort. A level
   * describes only where the model offers it, so one model that cannot take it
   * does not hide the rest; a request asking for such a level still fails
   * before provider I/O.
   */
  reasoning?: ModelThinkingLevel
  /** Token budgets used by reasoning providers that support them. */
  thinkingBudgets?: ThinkingBudgets
  /** Prompt-cache retention preference. */
  cacheRetention?: CacheRetention
  /**
   * Add `extended-cache-ttl-2025-04-11` to the `anthropic-beta` header of an
   * Anthropic Messages request. Opt-in and independent of
   * {@link cacheRetention}: `long` retention writes `ttl: "1h"` on the cache
   * markers but does not declare the beta, so a route that needs the extended
   * lifetime sets both. The beta joins the request's `betas` list before the
   * Anthropic SDK serializes it, which keeps every automatic beta pi-ai derives
   * for the route. On a `cc3` route it permits the one-hour lifetime that
   * policy writes on a main or subagent request; a helper request keeps the API
   * default five-minute lifetime and declares no beta. Refused when no model on
   * the route speaks `anthropic-messages`.
   */
  extendedCacheBeta?: boolean
  /**
   * Prompt-cache marker placement this route's adapter performs on an Anthropic
   * Messages request. Omission keeps pi-ai's placement from
   * {@link cacheRetention}. `cc3` places the Claude Code 2.1.288 layout — the
   * client's identity system block, the caller's filtered prompt block, and the
   * last cacheable user content block — and discards every other marker on the
   * route.
   * The harness-describing sections (`harness:source`, `app:web-surface`) are
   * never forwarded, and `harness:identity` is replaced by the pinned line, on
   * every request class that states a matching section assembly; the caller's
   * other sections are kept in assembly order. A main or subagent request marks
   * each slot with
   * `{type: "ephemeral", ttl: "1h"}`; a helper request (`compaction`,
   * `auxiliary`) keeps the API's default five-minute lifetime with
   * `{type: "ephemeral"}` and no extended beta. It marks no tool declaration and
   * no message before the last user turn, and the billing block the pool places
   * ahead of the identity block stays unmarked too. It owns placement outright,
   * so it takes precedence over `cacheRetention` and over
   * `compat.supportsCacheControlOnTools`; a request with no caller system prompt
   * marks the identity and last-user slots. The policy also writes the pinned
   * client's top-level field order with `stream` last, and an absent `metadata`
   * gains the empty object a pool's `user_id` splice fills in its canonical
   * slot. It adds no `scope` field and no scope beta, and
   * {@link extendedCacheBeta} stays a separate explicit opt-in. Refused when no
   * model on the route speaks `anthropic-messages`.
   */
  cacheMarkerPolicy?: PiAiCacheMarkerPolicy
  /**
   * Claude Code wire parity on this route's Anthropic Messages requests (default
   * `false`): the member body and the three `x-cc-*` headers a wire-parity
   * endpoint reads. The adapter builds `[identity, static, dynamic]` from the
   * request's `systemSections` — the pinned interactive identity line, the
   * reordered `stable` sections, then the session-specific remainder — and
   * applies the pinned top-level field order, the `updates` thinking display,
   * and the cache-beta removals while keeping a transport's
   * `eager_input_streaming` flag — a model that withholds that per-tool field
   * also has pi-ai's derived fine-grained tool-streaming beta removed, because
   * the pinned client declares neither — with no
   * `cache_control` of its own. The cache-beta removal covers both the request's
   * `betas` list and a deployment `anthropic-beta` header, which pi-ai would
   * otherwise send unchanged and from which it derives the list: non-cache betas
   * stay, and a header with no remaining beta is removed rather than sent empty.
   * A helper class (`compaction`, `auxiliary`)
   * keeps the caller's non-harness system, layout `none`, and no markers, so it
   * under-emits the subscription helper form (billing, identity, three five-minute
   * markers) that the worker's frame does not admit; a main or
   * subagent request that cannot state a real boundary, or that names no class
   * at all, is served as the current non-wire-parity request instead of a
   * partial wire-parity body. The three header names are adapter-owned on every
   * route, and the flag replaces {@link cacheMarkerPolicy} `cc3` on a
   * wire-parity request while a wire-parity-off request keeps that policy's
   * body. {@link ccWireParityCache} selects the cache intent a main or subagent
   * request declares. Resolution refuses the flag unless the plugin that
   * probed the route's endpoint supplies a capability proof whose origin covers
   * {@link baseURL}, so loader configuration cannot enable this wire; a proof
   * for a different origin is refused rather than carried over. Refused when no
   * model on the route speaks `anthropic-messages`.
   */
  ccWireParity?: boolean
  /**
   * Cache intent a wire-parity route's `main` and `subagent` requests declare
   * (default `main`), and with it whether the pool's worker writes cache
   * markers: `main` keeps the worker's main cache plan, while `off` is the
   * wire-parity-on form of a deployment that disabled prompt caching — the same
   * member body, class, and layout with `x-cc-cache-intent: off`, so the worker
   * writes no marker, no TTL, and no cache beta. Both modes already send a body
   * with no `cache_control` and no caller cache beta; `off` withholds the
   * worker's plan instead of adding anything. Helpers always declare `helper`.
   * The field is only meaningful with {@link ccWireParity}: resolution refuses
   * it on a route that does not send the wire-parity headers, because no request
   * would read it.
   */
  ccWireParityCache?: PiAiCcWireParityCache
  /** Streaming transport preference. */
  transport?: Transport
  /** HTTP/provider SDK timeout in milliseconds. */
  timeoutMs?: number
  /** WebSocket connection timeout in milliseconds. */
  websocketConnectTimeoutMs?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /**
   * Maximum base64-encoded image payload per request. When a request's
   * accumulated images exceed it, the oldest images are replaced by text
   * placeholders until the request fits, so a long session keeps completing
   * requests instead of being rejected by a request-size cap.
   */
  maxRequestImageBytes?: number
  /** Total-pixel budget for each deterministic inline request version. */
  requestImagePixelBudget?: number
  /**
   * Raw encoded-byte target for each deterministic inline request version;
   * the smallest quality-ladder output is used when no quality fits.
   */
  requestImageMaxBytes?: number
  /**
   * Provider-owned model-request retry policy. Omission uses normal mode with
   * five retries over the harness transient codes plus the pool codes this
   * adapter classifies; a configured `retryableCodes` list is used exactly as
   * written.
   */
  retryPolicy?: RetryPolicyConfig
}

/** Validated profile with its route stamped and every adapter-owned default resolved. */
export interface ResolvedPiAiProviderProfile
  extends Omit<PiAiProviderProfile, 'apiKeyEnv' | 'retryPolicy' | 'models' | 'displayName' | 'ccWireParityCache'> {
  /** Harness route key and the `Models` collection key (the configuration dict key). */
  provider: string
  /** Resolved display name for selectors and configuration surfaces. */
  displayName: string
  /** Validated credential reference, when one is configured. */
  apiKeyEnv?: CredentialRef
  /**
   * Cache intent this route's main and subagent wire-parity requests declare,
   * defaulted to `main`. Read only when {@link PiAiProviderProfile.ccWireParity}
   * is enabled; the value is resolved here so a request never invents a
   * configuration default.
   */
  ccWireParityCache: PiAiCcWireParityCache
  /** Positive finite provider-idle interval after defaulting. */
  streamIdleTimeoutMs: number
  /** Positive request-level base64 image payload bound after defaulting. */
  maxRequestImageBytes: number
  /** Positive total-pixel request-version budget after defaulting. */
  requestImagePixelBudget: number
  /** Positive raw request-version byte target after defaulting; the smallest quality-ladder output is used when no quality fits. */
  requestImageMaxBytes: number
  /** Immutable retry policy captured with this provider route. */
  retryPolicy: ResolvedRetryPolicy
  /**
   * The pi-ai provider containing this route's serviceable models. Absent when
   * a stored route cannot be constructed; its configuration remains editable.
   */
  piProvider?: Provider
  /** First model diagnostic, or the route failure when no model diagnostic is available. */
  catalogError?: string
  /** Per-model failures reported before attempting a request. */
  modelErrors: ReadonlyMap<string, string>
  /**
   * Per-request output caps this profile explicitly configured, by model id.
   * The seam materializes one only into a request that names no cap of its
   * own, so a catalog capability must not appear here.
   */
  configuredMaxTokens: ReadonlyMap<string, number>
  /**
   * Per-model default reasoning effort this profile explicitly configured, by
   * model id. One of these wins over the route-level {@link PiAiProviderProfile.reasoning}
   * when the adapter describes the model's default effort.
   */
  defaultReasoning: ReadonlyMap<string, ModelThinkingLevel>
}

/** Plugin configuration: the provider routes this instance owns. */
export interface Config {
  /**
   * pi-ai provider routes, keyed by provider. An empty (or omitted) dict is
   * the dormant settings-driven posture: the adapter mounts with no routes
   * and registers them the moment a settings section supplies profiles.
   */
  providers: Volatile<Record<string, PiAiProviderProfile>>
  /**
   * Provider routes whose requests carry the Claude Code session identity a
   * conversation-aware endpoint reads: `X-Claude-Code-Session-Id` from the
   * request's `sessionId`, `x-cc-session-name` from its display name when it has
   * one, and one `x-client-request-id` per deliberate attempt, so a retry never
   * resends the id the endpoint already recorded. These names are adapter-owned
   * on such a route: a profile header spelled the same way in any casing is
   * replaced rather than sent beside them. The display name is sanitized to the
   * pool's accepted display set (no control, bidi, or zero-width scalars, and no
   * reserved placeholder such as 空闲 or 未知) before it is encoded. One route
   * name or a list of them; a route not named here is left alone. A name
   * matching no configured route has no effect, because the route set is
   * settings-owned and may be supplied after this composition layer.
   */
  sessionHeaders?: string | string[]
  /**
   * Optional durable NDJSON file for the same request diagnostics the plugin
   * logger records. With no configuration, routes named by `sessionHeaders`
   * still persist their records to `$DSH_HOME/logs/llm-pi-ai-requests.jsonl`,
   * so a pool route keeps client-side evidence without extra configuration;
   * `enabled: true` extends persistence to every route, and `enabled: false`
   * turns the file off entirely. The file never carries messages, request
   * bodies, credentials, token counts, session titles, or provider failure
   * text: an endpoint is reduced to its origin and path, and the process logger
   * remains the place to read a failure's message and cause. Loader
   * configuration is read when the plugin mounts, so a change takes effect at
   * the next start. A fixed-route plugin owns its own file and default, which is
   * why this one never writes the `llm-cc-pool` route's log.
   */
  requestLog?: PiAiRequestLogProfile
}

/**
 * Durable request-diagnostic log settings.
 *
 * Records rotate by size and the retained set stays within 128 MiB: the
 * effective per-file bound is the smaller of `maxFileBytes` and that total, and
 * the effective file count is the smaller of `maxFiles` and the total divided
 * by the per-file bound. The oldest rotation is deleted first.
 */
export interface PiAiRequestLogProfile {
  /** Absolute NDJSON file path; defaults to `$DSH_HOME/logs/llm-pi-ai-requests.jsonl`. */
  path?: string
  /** Bytes one file holds before it rotates (default 16 MiB). */
  maxFileBytes?: number
  /** Files retained including the active one (default 8). */
  maxFiles?: number
  /** Persist every route rather than only `sessionHeaders` routes (default false). */
  enabled?: boolean
}

/** Plain options accepted by the provider resolver. */
export type Options = { [K in keyof Config]?: Config[K] extends Volatile<infer T> ? T : never }

const thinkingBudgets = z.object({
  minimal: z.number(),
  low: z.number(),
  medium: z.number(),
  high: z.number(),
})

/**
 * One `chat_template_kwargs` or `chat_template_args` value. The `$var` member
 * is pi-ai's placeholder for a value dispatch fills from the request's
 * thinking state, which makes a template-driven gateway configurable without
 * restating its template.
 */
const chatTemplateKwarg: z<ChatTemplateKwargValue> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.const(null),
  z.object({
    $var: z.union(CHAT_TEMPLATE_VARS).required(),
    omitWhenOff: z.boolean(),
  }),
])

const compatProfile: z<PiAiCompatProfile> = z.object({
  supportsStore: z.boolean(),
  supportsDeveloperRole: z.boolean(),
  supportsReasoningEffort: z.boolean(),
  supportsUsageInStreaming: z.boolean(),
  supportsFinishReason: z.boolean(),
  maxTokensField: z.union(MAX_TOKENS_FIELDS),
  requiresToolResultName: z.boolean(),
  requiresAssistantAfterToolResult: z.boolean(),
  requiresThinkingAsText: z.boolean(),
  requiresReasoningContentOnAssistantMessages: z.boolean(),
  thinkingFormat: z.union(SUPPORTED_THINKING_FORMATS),
  chatTemplateKwargs: z.dict(chatTemplateKwarg),
  chatTemplateArgs: z.dict(chatTemplateKwarg),
  supportsThinkingTokenBudget: z.boolean(),
  thinkingTokenBudgetField: z.union(THINKING_TOKEN_BUDGET_FIELDS),
  vllmPriority: z.number().step(1),
  supportsMaxOutputTokens: z.boolean(),
  supportsStrictMode: z.boolean(),
  cacheControlFormat: z.union(CACHE_CONTROL_FORMATS),
  supportsLongCacheRetention: z.boolean(),
  supportsEagerToolInputStreaming: z.boolean(),
  supportsCacheControlOnTools: z.boolean(),
  supportsTemperature: z.boolean(),
  forceAdaptiveThinking: z.boolean(),
  allowEmptySignature: z.boolean(),
  supportsStrictTools: z.boolean(),
})

/**
 * Keys are the offered levels, values their wire spellings. A valueless key
 * (`off:`) survives validation because schemastery passes nullable data
 * through before any member schema runs — `z.const(null)` only controls the
 * error for non-null wrong values and what a configuration UI renders.
 * Only resolution decides which levels may leave the value empty, so the
 * diagnostic can name the route and model. The assertion narrows
 * schemastery's `Dict`, which types every literal key as required; dict
 * validation checks only present keys, so the runtime value is a partial record.
 */
const reasoningEfforts = z.dict(
  z.union([z.string(), z.const(null)]),
  z.union(THINKING_LEVELS),
) as unknown as z<PiAiReasoningEfforts>

/** The fields a `models` entry and a `modelOverrides` value share; only the id's home differs. */
const modelFields = {
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  // No explicit default, unlike the route's `defaultInput`: schemastery
  // materializes `[]` for an absent array, and resolution reads that as "no
  // answer here" so the catalog entry below still applies.
  input: z.array(z.union(MODALITIES)),
  // The union, not a bare dict: schemastery materializes an absent dict as
  // `{}`, and absent must stay distinguishable — it means "inherit the
  // installed catalog's capability", while `false` disables reasoning.
  reasoningEfforts: z.union([z.const(false), reasoningEfforts]),
  reasoning: z.union(THINKING_LEVELS),
  compat: compatProfile,
}

const modelProfile: z<PiAiModelProfile> = z.object({
  id: z.string().required(),
  ...modelFields,
})

/** A {@link modelProfile} whose id lives in the `modelOverrides` dict key. */
const modelOverride: z<PiAiModelOverride> = z.object(modelFields)

const profile = z.object({
  apiKeyEnv: z.string().role('credential-ref'),
  displayName: z.string(),
  api: z.union(supportedProtocols()),
  baseURL: z.string(),
  models: z.array(modelProfile),
  modelOverrides: z.dict(modelOverride),
  compat: compatProfile,
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  defaultInput: z.array(z.union(MODALITIES)).default([...DEFAULT_INPUT]),
  headers: z.dict(z.string()),
  reasoning: z.union(THINKING_LEVELS),
  thinkingBudgets,
  cacheRetention: z.union(['none', 'short', 'long']),
  extendedCacheBeta: z.boolean(),
  cacheMarkerPolicy: z.union(CACHE_MARKER_POLICIES),
  ccWireParity: z.boolean(),
  ccWireParityCache: z.union(CC_WIRE_PARITY_CACHE_MODES),
  transport: z.union(['sse', 'websocket', 'websocket-cached', 'auto']),
  timeoutMs: z.natural(),
  websocketConnectTimeoutMs: z.natural(),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  requestImagePixelBudget: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET),
  requestImageMaxBytes: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES),
  retryPolicy: RetryPolicySchema,
})

/** Runtime schema for one {@link PiAiRequestLogProfile}. */
export const PiAiRequestLogProfileSchema: z<PiAiRequestLogProfile> = z.object({
  path: z.string().min(1),
  maxFileBytes: z.number().step(1).min(1),
  maxFiles: z.number().step(1).min(1),
  enabled: z.boolean(),
})

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  providers: z.dict(profile).default({}).volatile(),
  sessionHeaders: z.union([z.string().min(1), z.array(z.string().min(1))]),
  requestLog: PiAiRequestLogProfileSchema,
})

/** The route set of a composition that opted no provider into session headers. */
const NO_SESSION_HEADERS: ReadonlySet<string> = new Set()

/**
 * Resolve the configured `sessionHeaders` value into the immutable route set
 * the adapter tests per request.
 *
 * One route name and a list are both accepted so a composition with a single
 * conversation-aware route need not spell out a list. A repeated or empty name
 * is refused rather than deduplicated: both are configuration mistakes whose
 * effect would otherwise depend on order.
 * @param value - the configured route name, route names, or omission.
 * @returns frozen provider routes that receive session identity headers.
 * @throws Error naming the empty or repeated route.
 */
export function resolveSessionHeaders(value: string | readonly string[] | undefined): ReadonlySet<string> {
  if (value === undefined) return NO_SESSION_HEADERS
  const names = typeof value === 'string' ? [value] : [...value]
  const routes = new Set<string>()
  for (const name of names) {
    if (name.length === 0) throw new Error('llm-pi-ai: sessionHeaders names an empty provider route')
    if (routes.has(name)) throw new Error(`llm-pi-ai: sessionHeaders names provider route "${name}" twice`)
    routes.add(name)
  }
  return routes.size === 0 ? NO_SESSION_HEADERS : Object.freeze(routes)
}

/**
 * Resolve the request-log configuration into the settings one sink runs with.
 *
 * The sink exists when the deployment configured it or when a route carries
 * the session identity: a pool route is the one whose client-side evidence
 * matters when a request never reaches the pool, so it persists without
 * opting in. `enabled: true` extends persistence to every route, while
 * `enabled: false` turns the file off even for `sessionHeaders` routes.
 *
 * The retained set stays within {@link MAX_REQUEST_LOG_TOTAL_BYTES}: the
 * per-file bound is clamped to that total and the file count to the total
 * divided by the per-file bound, so configured bounds cannot exceed it.
 * @param value - the configured request-log settings, if any.
 * @param sessionHeaders - routes that receive the session identity headers.
 * @param defaultPath - file used when the configuration names none; a
 *   fixed-route plugin passes its own file name so two plugins never write one
 *   default path.
 * @returns the resolved settings, or undefined when no file is written.
 * @throws Error naming a bound that is not a positive integer or an empty path.
 */
export function resolveRequestLog(
  value: PiAiRequestLogProfile | undefined,
  sessionHeaders: ReadonlySet<string>,
  defaultPath: string = defaultRequestLogPath(),
): ResolvedRequestLogConfig | undefined {
  if (value?.enabled === false) return undefined
  const allRoutes = value?.enabled === true
  if (!allRoutes && sessionHeaders.size === 0) return undefined
  const path = value?.path ?? defaultPath
  if (path.length === 0) throw new Error('llm-pi-ai: requestLog.path must be a non-empty file path')
  const maxFileBytes = value?.maxFileBytes ?? DEFAULT_REQUEST_LOG_MAX_FILE_BYTES
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new Error('llm-pi-ai: requestLog.maxFileBytes must be a positive integer')
  }
  const maxFiles = value?.maxFiles ?? DEFAULT_REQUEST_LOG_MAX_FILES
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error('llm-pi-ai: requestLog.maxFiles must be a positive integer')
  }
  const fileBytes = Math.min(maxFileBytes, MAX_REQUEST_LOG_TOTAL_BYTES)
  const files = Math.min(maxFiles, Math.floor(MAX_REQUEST_LOG_TOTAL_BYTES / fileBytes))
  return Object.freeze({ path, maxFileBytes: fileBytes, maxFiles: files, allRoutes })
}

/**
 * Reject new or changed provider profiles that cannot be served. Unchanged
 * stored profiles may need repair after a catalog upgrade and do not block
 * edits to another provider. Removed profiles require no catalog validation.
 * @param config - the resolved section to check.
 * @param previous - current resolved section; omission checks every provider.
 * @throws Error naming the route and configuration entry that cannot be served.
 */
export function assertServiceable(config: Options, previous?: Options): void {
  const changed = Object.fromEntries(Object.entries(config.providers ?? {}).filter(([provider, profile]) =>
    !deepEqualJson(profile, previous?.providers?.[provider])))
  resolveProfiles(changed)
}

/** Reject removed pre-release profile fields and name their replacements. */
function rejectRemovedFields(provider: string, source: PiAiProviderProfile): void {
  const legacy = source as PiAiProviderProfile & {
    provider?: unknown
    maxRetries?: unknown
    maxRetryDelayMs?: unknown
  }
  if ('provider' in legacy) {
    throw new Error(`llm-pi-ai: provider "${provider}" sets "provider", which moved to the providers dict key`)
  }
  if ('maxRetries' in legacy || 'maxRetryDelayMs' in legacy) {
    throw new Error(
      `llm-pi-ai: provider "${provider}" sets maxRetries or maxRetryDelayMs, which were removed;`
      + ' compose agent recovery with dsh-llm-retry',
    )
  }
}

/** Reject a profile header that Fetch cannot put on a provider request. */
function assertValidHeaders(provider: string, headers: Readonly<Record<string, string>> | undefined): void {
  for (const [name, value] of Object.entries(headers ?? {})) {
    try {
      new Headers([[name, value]])
    } catch {
      throw new Error(
        `llm-pi-ai: provider "${provider}" header "${name}" is not valid for Fetch;`
        + ' use a valid HTTP field name and a single-line value representable as bytes',
      )
    }
  }
}

/**
 * Reject a profile header this adapter owns on every route.
 *
 * The three member headers travel as one set the adapter composes for each
 * wire-parity request and strips from every route's deployment headers. A
 * profile value would either send another spelling beside the adapter's or
 * leave a partial set once the adapter writes its own, so the profile is
 * refused rather than silently overridden — including on a route whose profile
 * never enables wire parity.
 * @param provider - route the profile names, for diagnostics.
 * @param headers - the profile's configured request headers.
 * @throws Error naming the adapter-owned header.
 */
function assertNoCcWireParityHeaders(provider: string, headers: Readonly<Record<string, string>> | undefined): void {
  for (const name of Object.keys(headers ?? {})) {
    if (CC_WIRE_PARITY_OWNED_HEADERS.has(name.toLowerCase())) {
      throw new Error(
        `llm-pi-ai: provider "${provider}" sets header "${name}", which this adapter owns on every route`,
      )
    }
  }
}

/**
 * Resolve one route's immutable retry policy.
 *
 * A route that names no `retryableCodes` — by omitting the policy or by setting
 * only its budget or backoff — extends the harness transient codes with the
 * pool codes this adapter's classifier emits, so a pool refusal that the
 * client is allowed to repeat is retryable without every deployment restating
 * the list. Configuration parsing leaves an omitted list unset, so this reads
 * the deployment's own decision rather than a materialized default. A
 * configured list is the deployment's decision and is kept exactly.
 * @param config - the route's configured policy, if any.
 * @param path - diagnostic path naming the provider config that owns the value.
 * @returns the policy captured with route registration.
 */
function resolveProfileRetryPolicy(config: RetryPolicyConfig | undefined, path: string): ResolvedRetryPolicy {
  const policy = resolveRetryPolicy(config, path)
  if (policy.mode !== 'normal' || (config?.mode === 'normal' && config.retryableCodes !== undefined)) {
    return policy
  }
  return resolveRetryPolicy({
    mode: 'normal',
    maxRetries: policy.maxRetries,
    retryableCodes: [...policy.retryableCodes, ...POOL_RETRYABLE_CODES],
    backoff: {
      initialDelayMs: policy.initialDelayMs,
      maxDelayMs: policy.maxDelayMs,
      providerWaitMaxMs: policy.providerWaitMaxMs,
      jitterRatio: policy.jitterRatio,
    },
  }, path)
}

/**
 * The profile field that makes a route Anthropic Messages-only, if one does.
 *
 * Each of these options edits the Anthropic Messages wire, so a route none of
 * whose models speaks that protocol could not serve it; strict validation
 * refuses the combination and names one of the fields the profile set.
 * @param source - the configured profile.
 * @returns the first such field the profile sets, in declaration order.
 */
function anthropicOnlyProfileField(
  source: PiAiProviderProfile,
): 'ccWireParity' | 'cacheMarkerPolicy' | 'extendedCacheBeta' | undefined {
  if (source.ccWireParity === true) return 'ccWireParity'
  if (source.cacheMarkerPolicy !== undefined) return 'cacheMarkerPolicy'
  if (source.extendedCacheBeta === true) return 'extendedCacheBeta'
  return undefined
}

/**
 * The scheme and authority of one absolute URL.
 * @param value - a configured base URL or capability-proof endpoint.
 * @returns the origin, or undefined when the value is not an absolute URL.
 */
function urlOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    // Not an absolute URL, so no request can reach it and it binds no proof.
    return undefined
  }
}

/**
 * Refuse a wire-parity flag the supplied capability proofs do not grant.
 *
 * The gate runs in resolution, which is the operation that decides the resolved
 * profile the adapter reads: a route enables the wire only when the plugin that
 * interrogated its endpoint supplied a proof for this exact route, and that
 * proof's endpoint shares the profile's origin. A proof supplied for a route
 * that does not request the wire is a caller bug and is refused instead of
 * silently dropped. Diagnostics name an endpoint without its userinfo or query,
 * since either may carry a credential.
 * @param provider - the route being resolved.
 * @param source - its configured profile.
 * @param proofs - capability proofs supplied by the probing plugin, if any.
 * @throws Error when the flag and the proofs disagree, or the proof does not
 *   cover the route's origin.
 */
function assertCcWireParityProof(
  provider: string,
  source: PiAiProviderProfile,
  proofs: PiAiCcWireParityProofs | undefined,
): void {
  const proof = proofs?.get(provider)
  if (source.ccWireParity !== true) {
    if (proof !== undefined) {
      throw new Error(
        `llm-pi-ai: provider "${provider}" has a CC wire parity capability proof`
        + ' but does not set ccWireParity: true',
      )
    }
    return
  }
  if (proof === undefined) {
    throw new Error(
      `llm-pi-ai: provider "${provider}" sets ccWireParity, which only a route whose endpoint proved the`
      + ' capability may enable; the fixed-route plugin that interrogated the endpoint supplies that proof,'
      + ' and profile configuration cannot',
    )
  }
  if (proof.buildId.length === 0) {
    throw new Error(`llm-pi-ai: provider "${provider}" has a CC wire parity proof with an empty build id`)
  }
  const baseURL = source.baseURL
  const origin = baseURL === undefined ? undefined : urlOrigin(baseURL)
  if (origin === undefined || baseURL === undefined) {
    throw new Error(
      `llm-pi-ai: provider "${provider}" sets ccWireParity but names no absolute baseURL a capability proof could cover`,
    )
  }
  const proofOrigin = urlOrigin(proof.endpoint)
  if (proofOrigin === undefined) {
    throw new Error(
      `llm-pi-ai: provider "${provider}" has a CC wire parity proof endpoint that is not an absolute URL:`
      + ` ${JSON.stringify(redactEndpoint(proof.endpoint))}`,
    )
  }
  if (proofOrigin !== origin) {
    throw new Error(
      `llm-pi-ai: provider "${provider}" sets ccWireParity, but its capability proof for`
      + ` ${JSON.stringify(redactEndpoint(proof.endpoint))} does not cover baseURL`
      + ` ${JSON.stringify(redactEndpoint(baseURL))}`,
    )
  }
}

/**
 * Resolve scalar defaults and materialize each route's serviceable models.
 * Deferred catalog validation retains diagnostics without deleting configured
 * routes. An omitted dict resolves to the empty, dormant route set.
 * @param providers - configured provider profiles keyed by route.
 * @param validation - writes require a complete catalog; stored reads retain catalog diagnostics.
 * @param proofs - capability proofs a fixed-route plugin obtained from its
 *   endpoint probe, keyed by the route each one may enable wire parity for.
 *   Omitted for loader configuration, whose profiles therefore cannot enable
 *   the wire.
 * @returns validated profiles in configuration order.
 * @throws Error when the configured profiles and the supplied proofs disagree.
 */
export function resolveProfiles(
  providers: Readonly<Record<string, PiAiProviderProfile>> | undefined,
  validation: 'strict' | 'deferred' = 'strict',
  proofs?: PiAiCcWireParityProofs,
): Map<string, ResolvedPiAiProviderProfile> {
  if (Array.isArray(providers)) {
    throw new Error('llm-pi-ai: providers is now a dict keyed by provider route, not an array of profiles')
  }
  const entries = Object.entries(providers ?? {})
  const resolved = new Map<string, ResolvedPiAiProviderProfile>()
  for (const [provider, source] of entries) {
    rejectRemovedFields(provider, source)
    if (provider.length === 0) throw new Error('llm-pi-ai: provider names must be non-empty')
    if (source.baseURL !== undefined && source.baseURL.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" has an empty baseURL`)
    }
    if (source.displayName !== undefined && source.displayName.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" has an empty displayName`)
    }
    assertValidHeaders(provider, source.headers)
    assertNoCcWireParityHeaders(provider, source.headers)
    if (source.ccWireParityCache !== undefined && source.ccWireParity !== true) {
      throw new Error(
        `llm-pi-ai: provider "${provider}" sets ccWireParityCache, which is only meaningful with ccWireParity: true;`
        + ' a route that sends no wire-parity headers declares no cache intent',
      )
    }
    assertCcWireParityProof(provider, source, proofs)
    const streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    if (!Number.isFinite(streamIdleTimeoutMs)
      || streamIdleTimeoutMs <= 0
      || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `llm-pi-ai: provider "${provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    const maxRequestImageBytes = source.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
    if (!Number.isInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" maxRequestImageBytes must be a positive integer`)
    }
    const requestImagePixelBudget = source.requestImagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET
    if (!Number.isSafeInteger(requestImagePixelBudget) || requestImagePixelBudget <= 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" requestImagePixelBudget must be a positive safe integer`)
    }
    const requestImageMaxBytes = source.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES
    if (!Number.isSafeInteger(requestImageMaxBytes) || requestImageMaxBytes <= 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" requestImageMaxBytes must be a positive safe integer`)
    }
    // Detached from the configuration object because pi-ai types `Model.input`
    // mutable. The schema's explicit default covers an absent key, so an empty
    // list here is always one someone typed — and unlike an entry's, nothing
    // below it can answer instead — so it is refused rather than read as "no
    // answer".
    const defaultInput = [...source.defaultInput ?? DEFAULT_INPUT]
    if (defaultInput.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" defaultInput must name at least one modality`)
    }
    // The route key, not the installed provider's own name: the directory has
    // always shown route keys, and a catalog route must not silently rename
    // itself on every configuration surface just because it gained a profile.
    const displayName = source.displayName ?? provider
    let catalog: RouteCatalog | undefined
    let piProvider: Provider | undefined
    let catalogError: string | undefined
    try {
      catalog = resolveRouteModels({
        provider,
        ...source.api === undefined ? {} : { api: source.api },
        ...source.baseURL === undefined ? {} : { baseURL: source.baseURL },
        ...source.models === undefined ? {} : { models: source.models },
        ...source.modelOverrides === undefined ? {} : { modelOverrides: source.modelOverrides },
        ...source.compat === undefined ? {} : { compat: source.compat },
        defaultInput,
        defaultContextWindow: source.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
        defaultMaxTokens: source.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
      }, validation)
      catalogError = catalog.modelErrors.values().next().value
      piProvider = buildProvider({
        provider,
        displayName,
        ...source.api === undefined ? {} : { api: source.api },
        ...source.baseURL === undefined ? {} : { baseURL: source.baseURL },
        models: catalog.models,
        namesCredential: source.apiKeyEnv !== undefined,
      })
    } catch (error) {
      if (validation === 'strict' || !(error instanceof PiAiCatalogError)) throw error
      catalogError ??= error.message
    }
    const anthropicOnlyField = anthropicOnlyProfileField(source)
    if (validation === 'strict'
      && anthropicOnlyField !== undefined
      && !catalog?.models.some(model => model.api === 'anthropic-messages')) {
      throw new Error(
        `llm-pi-ai: provider "${provider}" sets ${anthropicOnlyField},`
        + ' but no model on the route speaks anthropic-messages',
      )
    }
    const { apiKeyEnv, retryPolicy, models: _models, displayName: _displayName, ...rest } = source
    resolved.set(provider, {
      ...rest,
      provider,
      displayName,
      // The one cache intent a main or subagent wire-parity request can declare;
      // resolved here so the adapter reads a decided value instead of defaulting
      // per request. A route that never enables wire parity still carries it,
      // unread.
      ccWireParityCache: source.ccWireParityCache ?? 'main',
      ...apiKeyEnv === undefined ? {} : { apiKeyEnv: credentialRef(apiKeyEnv) },
      streamIdleTimeoutMs,
      maxRequestImageBytes,
      requestImagePixelBudget,
      requestImageMaxBytes,
      retryPolicy: resolveProfileRetryPolicy(retryPolicy, `llm-pi-ai: provider "${provider}" retryPolicy`),
      ...rest.headers === undefined ? {} : { headers: { ...rest.headers } },
      ...rest.thinkingBudgets === undefined ? {} : { thinkingBudgets: { ...rest.thinkingBudgets } },
      configuredMaxTokens: catalog?.configuredMaxTokens ?? new Map(),
      defaultReasoning: catalog?.defaultReasoning ?? new Map(),
      modelErrors: catalog?.modelErrors ?? new Map(),
      ...piProvider === undefined ? {} : { piProvider },
      ...catalogError === undefined ? {} : { catalogError },
    })
  }
  // A proof names the route it covers, so one that covers no resolved profile is
  // a caller bug rather than an unused extra: accepting it would let a stale
  // probe grant look applied while no request reads it.
  for (const provider of proofs?.keys() ?? []) {
    if (!resolved.has(provider)) {
      throw new Error(
        `llm-pi-ai: a CC wire parity capability proof names route "${provider}", which no profile declares`,
      )
    }
  }
  return resolved
}
