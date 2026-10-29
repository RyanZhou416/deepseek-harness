/**
 * The mac-pool provider plugin: one fixed `cc-pool` route over the pool's
 * Anthropic Messages endpoint, with the deployment's model catalogue.
 *
 * The plugin is the whole mac-pool integration. A composition without it has
 * no `cc-pool` provider at all, and installing it adds exactly that one route:
 * no configurable-provider directory entry, so no generic Models page drafts a
 * route of its own. The route's model catalogue is the built-in four-model
 * catalogue unless a profile sets `models`, which replaces it wholesale; the
 * settings service projects that catalogue as a form and an edit reaches the
 * next request without a restart. The plugin also registers model discovery
 * for its own settings namespace: an explicit read of the pool's `/v1/models`
 * listing that reports candidates, never adopts them, and never falls back to
 * the configured catalogue when the read fails. Requests carry the Claude Code
 * session identity the pool binds conversations with, and a fixed retry
 * policy; failures reuse the generic pi-ai adapter's pool-error classification
 * rather than restating it here. Concurrent requests for one session are
 * ordered before they open, because the pool admits one in-flight direct
 * request per session and refuses a concurrent one instead of waiting.
 * `cacheTtl` declares the prompt-cache lifetime of this route's
 * `cache_control` markers, `extendedCacheBeta` declares the beta a one-hour
 * lifetime requires, and `toolCacheBreakpoint` selects whether a tool
 * definition carries a marker when the four-marker policy does not own
 * placement. The defaults enable the four-marker Claude Code layout —
 * `cacheTtl: 1h`, `extendedCacheBeta: true`, `cacheMarkerPolicy: cc4` — and an
 * impossible combination is refused when the plugin loads. All of them reach
 * the wire only through this route's profile; no other provider's request is
 * touched.
 *
 * ```yaml
 * - id: llm-cc-pool
 *   name: '@deepseek-ai/dsh-llm-cc-pool'
 *   config:
 *     requestLog:
 *       path: /var/log/dsh/cc-pool-requests.jsonl
 *       maxFileBytes: 16777216
 *       maxFiles: 8
 *     models:
 *       - id: claude-sonnet-5-5
 *         name: Claude Sonnet 5.5
 *         contextWindow: 1000000
 *         maxTokens: 128000
 *         defaultReasoning: medium
 * ```
 *
 * @module @deepseek-ai/dsh-llm-cc-pool
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  createPiAiRequestLog,
  PiAiAdapter,
  piAiAuthFrom,
  piAiDiagnosticHooks,
} from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { Config } from './config.ts'
import { DISCOVERY_NAMESPACE, discoverPoolModels } from './discovery.ts'
import { API_KEY_REF, MODEL_INPUT, PROVIDER, resolvePoolCachePolicy, resolvePoolModels, resolvePoolProfiles } from './pool.ts'
import type { CcPoolCachePolicy, CcPoolModel } from './pool.ts'
import { SessionSerialGate } from './session-gate.ts'

export { Config } from './config.ts'
export type { Options } from './config.ts'
export { DISCOVERY_NAMESPACE } from './discovery.ts'
export {
  CACHE_TTLS,
  DEFAULT_CACHE_POLICY,
  MODELS,
  REASONING_EFFORTS,
  REASONING_LEVELS,
  resolvePoolCachePolicy,
  resolvePoolModels,
  resolvePoolProfiles,
} from './pool.ts'
export type { CcPoolCachePolicy, CcPoolCacheTtl, CcPoolModel, CcPoolReasoningLevel } from './pool.ts'

export const name = 'llm-cc-pool'
export const inject = ['llm']

/**
 * Provider routes whose requests carry the Claude Code session identity: the
 * pool binds one conversation and its prompt identity to that header, so every
 * attempt of this route sends it (and a fixed route set means the name always
 * matches).
 */
const SESSION_HEADERS: ReadonlySet<string> = Object.freeze(new Set([PROVIDER]))

/**
 * The pi-ai adapter with two mac-pool differences: the model catalogue is the
 * plugin's configured catalogue, not a credential-gated discovery result, and
 * streams for one session are ordered before they reach the pool.
 *
 * The generic adapter reports no models while the route's credential does not
 * resolve, because a settings-declared route's catalog is unknown until its
 * endpoint answers. This route's catalogue is configuration, so the selector can
 * offer every model before a key is stored; a request without the key then
 * fails loud with `MISSING_CREDENTIAL` instead of hiding the provider.
 */
class CcPoolAdapter extends PiAiAdapter {
  /** Orders streams by session for the pool's one-in-flight-request-per-session rule. */
  private readonly sessions = new SessionSerialGate()

  /**
   * @param options - generic adapter hooks.
   * @param catalogue - the effective catalogue of the current configuration.
   */
  constructor(options: PiAiAdapterOptions, private readonly catalogue: () => readonly CcPoolModel[]) {
    super(options)
  }

  /**
   * Every catalogue model, independent of credential state.
   * @param provider - the registered provider route.
   * @returns the effective catalogue in selector order.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.all(this.catalogue().map(async (model) => {
      const info = await this.resolveModel(provider, model.id)
      return {
        provider,
        id: info.id,
        name: info.name,
        inputModalities: MODEL_INPUT,
      }
    }))
  }

  /**
   * Run one dispatch under its session's queue. A request without a session has
   * no pool binding to order against and opens directly.
   * @param options - the assembled request carrying the session identity.
   * @param open - opens this dispatch's upstream stream.
   * @returns the session-ordered stream.
   */
  private ordered(options: GenerateOptions, open: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    if (options.sessionId === undefined) return open()
    return this.sessions.serialize({
      sessionId: String(options.sessionId),
      signal: options.signal,
      open,
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.ordered(options, () => super.stream(options))
  }

  /**
   * Bind the model generation and its dispatch, then order that dispatch by
   * session. The pi-ai base binds its snapshot directly rather than routing
   * through {@link stream}, so a dispatch enters exactly one queue here.
   * @param provider - registered provider route.
   * @param model - exact model id.
   * @param signal - cancellation for model resolution.
   * @returns the bound model metadata and session-ordered stream entry point.
   */
  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    const call = await super.prepareCall(provider, model, signal)
    return {
      model: call.model,
      stream: options => this.ordered(options, () => call.stream(options)),
    }
  }

  /** Abort requests still queued for a session when the plugin fiber disposes. */
  dispose(): void {
    this.sessions.dispose()
  }
}

/**
 * Resolve the pool member credential for one request.
 *
 * The reference is fixed, so a miss is a deployment error, not a route waiting
 * to be configured: throwing `MISSING_CREDENTIAL` names the reference and the
 * two places that can supply it instead of letting pi-ai fall back to an
 * unrelated ambient provider key.
 * @param ctx - the plugin context.
 * @param provider - the route being served, for diagnostics.
 * @returns the usable credential value.
 * @throws {LlmError} code `MISSING_CREDENTIAL` when no layer supplies the reference.
 */
async function resolvePoolApiKey(ctx: Context, provider: string): Promise<string> {
  const ref = credentialRef(API_KEY_REF)
  const credentials = ctx.get('credentials')
  const hit = credentials !== undefined
    ? (await credentials.resolve(ref))?.value
    : launchEnvironmentOf(ctx).get(ref)?.value
  if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, 'llm-cc-pool', ref)
  throw new LlmError(
    `llm-cc-pool: no credential for provider route "${provider}"; store ${ref} through the credentials`
    + ` service or export ${ref} in the launching environment`,
    'MISSING_CREDENTIAL',
  )
}

/**
 * The resolved catalogue and profiles for one configuration snapshot. A
 * settings write swaps the volatile `models` reference, so a new snapshot is
 * built for the next request while any operation already running keeps the one
 * it captured.
 */
interface PoolSnapshot {
  /** The effective catalogue of the configuration that produced this snapshot. */
  readonly models: readonly CcPoolModel[]
  /** The route profile built from that catalogue. */
  readonly profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
}

/**
 * The prompt-cache policy one configuration snapshot declares.
 * @param config - schema-validated loader configuration.
 * @returns the policy fields, with marker placement present only when configured.
 */
function cachePolicyOf(config: Config): CcPoolCachePolicy {
  return {
    cacheTtl: config.cacheTtl,
    extendedCacheBeta: config.extendedCacheBeta,
    toolCacheBreakpoint: config.toolCacheBreakpoint,
    ...config.cacheMarkerPolicy === undefined ? {} : { cacheMarkerPolicy: config.cacheMarkerPolicy },
  }
}

/** Register the fixed mac-pool route on the harness LLM seam. */
export function apply(ctx: Context, config: Config): void {
  // The dedicated CC-pool settings page owns presentation; the generic
  // auto-generated page must not duplicate it. Optional, because a headless
  // composition has no settings service and the route still works.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })

  let lastRaw: readonly CcPoolModel[] | undefined
  let snapshot: PoolSnapshot | undefined
  // Read once, with the rest of the loader configuration: the cache policy a
  // deployment asks for is not a per-request setting, and it is captured here so
  // every resolution of this route's profiles carries the same policy.
  const cachePolicy = cachePolicyOf(config)
  // Fail loud at load, before the route is registered: an impossible marker
  // combination belongs here, not in a provider rejection at the first request.
  resolvePoolCachePolicy(cachePolicy)
  /**
   * The snapshot for the current `models` value, memoized by that value's
   * identity so both a request and the listing it precedes share one profile
   * set. Resolution runs the strict catalogue check every time the value moves,
   * which is what refuses a configuration the route cannot serve.
   */
  const current = (): PoolSnapshot => {
    const raw = config.models.get()
    if (snapshot === undefined || raw !== lastRaw) {
      const models = resolvePoolModels(raw)
      snapshot = { models, profiles: resolvePoolProfiles(models, cachePolicy) }
      lastRaw = raw
    }
    return snapshot
  }
  // Fail loud at load, before the route is registered.
  current()

  // The settings service validates the complete candidate through the schema
  // before persisting, but unique ids, a non-empty catalogue, and the cache
  // policy's cross-field requirements are facts no single field schema can
  // express; check them on the same waterfall so an invalid settings write is
  // refused instead of stored and re-loaded as a broken route.
  ctx.on('internal/config', function (this: Fiber, _raw, next) {
    const raw: unknown = next()
    if (this !== ctx.fiber) return raw
    const candidate = Config(raw as import('./config.ts').Options)
    resolvePoolModels(candidate.models.get())
    resolvePoolCachePolicy(cachePolicyOf(candidate))
    return raw
  })

  const requestLog = createPiAiRequestLog({
    config: config.requestLog,
    sessionHeaders: SESSION_HEADERS,
    warn: (message) => { ctx.logger.warn(message) },
  })
  if (requestLog !== undefined) ctx.effect(() => () => requestLog.close(), 'llm-cc-pool.request-log')

  const options: PiAiAdapterOptions = {
    profiles: () => current().profiles,
    resolveApiKey: provider => resolvePoolApiKey(ctx, provider),
    auth: piAiAuthFrom(ctx),
    sessionHeaders: SESSION_HEADERS,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    ...piAiDiagnosticHooks({
      label: 'llm-cc-pool',
      retainedRoutes: SESSION_HEADERS,
      logger: ctx.logger,
      ...requestLog === undefined ? {} : { append: (event) => { requestLog.append(event) } },
    }),
  }
  const adapter = new CcPoolAdapter(options, () => current().models)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  // Requests the session queue still holds cannot be served once the route is
  // gone; settling them as aborted keeps a disposed fiber from leaving them
  // waiting on a queue no stream will ever release.
  ctx.effect(() => () => { adapter.dispose() }, 'llm-cc-pool.session-queue')

  // The pool's own listing is a read surface for the settings page's explicit
  // sync action: candidates are reported for adoption, while this plugin never
  // writes the catalogue or the profile itself. The request's draft fields are
  // ignored — the endpoint and credential are this route's fixed facts, and a
  // read without a stored credential must fail instead of borrowing a draft
  // key. Registration is an effect, so it leaves with the plugin fiber.
  ctx.llm.registerModelDiscovery(DISCOVERY_NAMESPACE, async (_request, signal) => {
    const apiKey = await resolvePoolApiKey(ctx, PROVIDER)
    return discoverPoolModels(apiKey, signal)
  })
}
