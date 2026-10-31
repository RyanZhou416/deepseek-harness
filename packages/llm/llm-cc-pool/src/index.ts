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
 * `cache_control` markers, and `extendedCacheBeta` declares the beta a one-hour
 * lifetime requires. The defaults enable the three-marker Claude Code 2.1.288
 * layout — `cacheTtl: 1h`, `extendedCacheBeta: true`, `cacheMarkerPolicy: cc3` —
 * and an impossible combination is refused when the plugin loads. The route can
 * also ask for the CC wire parity wire format: the plugin probes the member endpoint's
 * `/v1/capabilities` at profile load and when the member credential changes,
 * accepts a positive proof only for the endpoint and pool build that answered,
 * puts wire parity on the route profile only after that proof, and never
 * rewrites a request body or header for it. A failed probe retries with bounded
 * backoff, the first routed request waits for the initial probe's outcome under
 * a bounded deadline, and a `503` the endpoint marks with
 * `x-cc-wire-parity-unavailable: 1` on a wire-parity-on request drops the proof
 * and schedules another probe after a cooldown instead of leaving the route
 * permanently on the non-parity wire. Wire parity declares its own cache
 * intent, which the profile carries: `cacheTtl: none` — this route's
 * caching-disabled state — makes a main or subagent wire-parity request declare
 * `off`, so the worker writes no marker, no TTL, and no cache beta, and every
 * other lifetime declares `main` for the worker's own cache plan, including the
 * HIPAA-driven five-minute fallback on that wire. All
 * of them reach the wire only through this route's profile;
 * no other provider's request is touched. The durable request log is opt-in: a
 * request carrying the session identity does not write a file by itself,
 * `requestLog` turns it on, and its default path is the pool's own so the pi-ai
 * sink never gains a second writer.
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
  defaultRequestLogPath,
  PiAiAdapter,
  piAiAuthFrom,
  piAiDiagnosticHooks,
} from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, PiAiRequestDiagnostic, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { Config } from './config.ts'
import { DISCOVERY_NAMESPACE, discoverPoolModels, probePoolCapabilities } from './discovery.ts'
import type { PoolCapabilityProof } from './discovery.ts'
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
 * Stamp a session-busy retry as a new attempt of one request.
 *
 * The loop's `attemptNonce` identifies its own deliberate attempt, so a retry
 * inside that attempt combines the two rather than replacing it: replacing
 * would make the retry indistinguishable from a different loop attempt, and
 * deriving it from the loop nonce alone would repeat the refused attempt's wire
 * id. The value is model-hidden transport metadata; the pi-ai adapter hashes it
 * into `x-client-request-id`.
 * @param options - the request as the caller assembled it.
 * @param retryNonce - the fresh nonce the session gate minted for this retry.
 * @returns a copy of the request whose attempt carries its own ledger identity.
 */
function retriedAttempt(options: GenerateOptions, retryNonce: string): GenerateOptions {
  const attemptNonce = options.attemptNonce === undefined ? retryNonce : `${options.attemptNonce}/${retryNonce}`
  return { ...options, attemptNonce }
}

/**
 * Retry delays for a failed capability probe: the first retry starts after
 * {@link WIRE_PARITY_RETRY_INITIAL_MS} and every later failure doubles the delay
 * up to {@link WIRE_PARITY_RETRY_MAX_MS}. The ceiling bounds background traffic
 * when the endpoint stays unreachable while the route keeps serving the safe
 * non-parity wire.
 */
const WIRE_PARITY_RETRY_INITIAL_MS = 2_000

/** Ceiling of the probe retry backoff; see {@link WIRE_PARITY_RETRY_INITIAL_MS}. */
const WIRE_PARITY_RETRY_MAX_MS = 60_000

/**
 * Minimum spacing between a marked `503` refusal and the next probe. The refusal
 * clears the proof immediately, but asking again inside this window would let a
 * still-unsupported pool turn every refused request into a probe.
 */
const WIRE_PARITY_REFUSAL_COOLDOWN_MS = 30_000

/**
 * Upper bound on one request's wait for the load probe. The probe itself is
 * bounded by the capability timeout; this deadline also covers a credential
 * lookup that stops answering, so the first request proceeds on the safe
 * non-parity wire instead of hanging.
 */
const WIRE_PARITY_READY_TIMEOUT_MS = 6_000

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
   * @param readiness - settles when the load capability probe first answers, so
   *   a request cannot decide the wire before that probe does.
   */
  constructor(
    options: PiAiAdapterOptions,
    private readonly catalogue: () => readonly CcPoolModel[],
    private readonly readiness: () => Promise<void>,
  ) {
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
   * @param open - opens this dispatch's upstream stream for one attempt.
   * @returns the session-ordered stream.
   */
  private ordered(
    options: GenerateOptions,
    open: (attempt: GenerateOptions) => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    if (options.sessionId === undefined) return open(options)
    return this.sessions.serialize({
      sessionId: String(options.sessionId),
      signal: options.signal,
      open: retryNonce => open(retryNonce === undefined ? options : retriedAttempt(options, retryNonce)),
    })
  }

  /**
   * Await the load probe before opening one dispatch.
   *
   * The probe decides whether the route profile carries the wire-parity flag,
   * and the adapter's snapshot is captured at dispatch preparation. Waiting on
   * the probe's first outcome — bounded by the caller's deadline — keeps the
   * first request from deciding the wire before the endpoint answered.
   * @param open - opens the dispatch after the probe's first outcome.
   * @returns the deferred stream.
   */
  private async * afterReadiness(open: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    await this.readiness()
    yield* open()
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.afterReadiness(() => this.ordered(options, attempt => super.stream(attempt)))
  }

  /**
   * Bind the model generation and its dispatch, then order that dispatch by
   * session. The pi-ai base binds its snapshot directly rather than routing
   * through {@link stream}, so a dispatch enters exactly one queue here.
   *
   * The load probe is awaited before the base captures its snapshot: that
   * snapshot reads the profile whose wire-parity flag the probe decides, so a
   * request issued at the same moment as the load probe must not prepare first.
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
    await this.readiness()
    const call = await super.prepareCall(provider, model, signal)
    return {
      model: call.model,
      stream: options => this.ordered(options, attempt => call.stream(attempt)),
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
    /* v8 ignore next -- the schema default always names a placement policy */
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
  let lastBuildId: string | undefined
  let snapshot: PoolSnapshot | undefined
  // Wire parity is proven only by the member endpoint itself, for the member
  // endpoint and pool build that answered, and only for this plugin instance: no
  // proof exists at load. The stored proof carries that `buildId`, and the route
  // profiles are resolved for the build it names, so a new probe replaces both
  // and a profile built for another build is never reused. A load or credential
  // probe drops the previous proof before it asks. A failed probe is retried with
  // bounded backoff instead of leaving the route permanently off; a probe that
  // answers without a build identity cannot produce one, and a superseded probe
  // never writes its answer.
  let capabilityProof: PoolCapabilityProof | undefined
  let capabilityProbe: AbortController | undefined
  let probeRetryTimer: ReturnType<typeof setTimeout> | undefined
  let probeFailures = 0
  let disposed = false
  // The first routed request waits for the load probe's first outcome, so it
  // cannot prepare its snapshot before the probe decides the wire. The promise
  // never rejects; `awaitInitialProbe` bounds the wait.
  let initialProbeSettled = false
  let initialProbeWaitExpired = false
  let settleInitialProbe: () => void = () => {}
  const initialProbe = new Promise<void>((resolve) => { settleInitialProbe = resolve })
  // Read once, with the rest of the loader configuration: the cache policy a
  // deployment asks for is not a per-request setting, and it is captured here so
  // every resolution of this route's profiles carries the same policy.
  const cachePolicy = cachePolicyOf(config)
  // Fail loud at load, before the route is registered or any probe is sent: an
  // impossible marker/lifetime combination belongs here, not in a provider
  // rejection at the first request.
  resolvePoolCachePolicy(cachePolicy)
  /**
   * The stored proof when it may enable the wire parity flag on this route.
   *
   * A proof is valid only for the endpoint and pool build that answered:
   * {@link probePoolCapabilities} scopes it to the fixed capability endpoint, and
   * its `buildId` names the build. {@link current} resolves the profiles from
   * exactly the proof returned here, so a probe that answers for a different
   * build — or proves nothing — replaces this value and the next resolution
   * builds a new profile instead of reusing the previous build's.
   * @returns the current proof, or `undefined` when wire parity is off.
   */
  const wireParityProof = (): PoolCapabilityProof | undefined => {
    if (!config.ccWireParity) return undefined
    return capabilityProof
  }
  /** Whether the route profile currently carries the wire parity flag. */
  const wireParity = (): boolean => wireParityProof() !== undefined
  /**
   * The snapshot for the current `models` value and wire parity proof, memoized
   * by those identities so both a request and the listing it precedes share one
   * profile set. The proof's `buildId` is the wire key, not just its presence:
   * the profiles are valid only for the pool build that proved the wire, so a
   * probe that answers a different build — or proves nothing — resolves a new
   * snapshot instead of reusing the previous build's. Resolution runs the strict
   * catalogue check every time the value moves, which is what refuses a
   * configuration the route cannot serve.
   */
  const current = (): PoolSnapshot => {
    const raw = config.models.get()
    const proof = wireParityProof()
    const buildId = proof?.buildId
    if (snapshot === undefined || raw !== lastRaw || buildId !== lastBuildId) {
      const models = resolvePoolModels(raw)
      snapshot = { models, profiles: resolvePoolProfiles(models, cachePolicy, proof) }
      lastRaw = raw
      lastBuildId = buildId
    }
    return snapshot
  }
  // Fail loud at load, before the route is registered.
  current()

  /** Settle the first-request wait; repeated calls are no-ops. */
  const markInitialProbeSettled = (): void => {
    if (initialProbeSettled) return
    initialProbeSettled = true
    settleInitialProbe()
  }

  /** Read the settled flag without narrowing it across the wait's await boundary. */
  const isInitialProbeSettled = (): boolean => initialProbeSettled

  /** Cancel a pending retry; a new probe generation and disposal both do. */
  const clearProbeRetry = (): void => {
    if (probeRetryTimer === undefined) return
    clearTimeout(probeRetryTimer)
    probeRetryTimer = undefined
  }

  /** The bounded backoff before the next probe attempt after the failures seen. */
  const nextProbeDelay = (): number => Math.min(
    WIRE_PARITY_RETRY_INITIAL_MS * 2 ** Math.max(probeFailures - 1, 0),
    WIRE_PARITY_RETRY_MAX_MS,
  )

  /**
   * Ask the member endpoint whether this route may use the CC wire parity wire format.
   *
   * This runs at profile load, when the member credential changes, and after a
   * failed attempt's backoff. A route that does not request wire parity sends no
   * probe request at all, and a missing credential is wire-parity off rather
   * than a route failure: the route keeps its non-parity wire until the
   * endpoint proves wire parity, and a stored credential reopens the question
   * through the credentials event. A failed, timed-out, malformed, or
   * build-less answer leaves no proof and schedules another attempt with bounded
   * backoff, so one failed probe cannot leave the process permanently off. The
   * failure is logged at warning level with the attempt number and the next
   * delay; a proof logs the answering build identity at info level. Both carry no
   * credential.
   *
   * Each probe supersedes the previous one and drops its proof before asking, so
   * a stale positive proof never outlives the endpoint or pool build it described.
   */
  const startProbe = (): void => {
    if (disposed || !config.ccWireParity) return
    clearProbeRetry()
    capabilityProbe?.abort()
    const controller = new AbortController()
    capabilityProbe = controller
    capabilityProof = undefined
    void (async () => {
      let apiKey: string
      try {
        apiKey = await resolvePoolApiKey(ctx, PROVIDER)
      } catch {
        // A missing member credential cannot prove wire parity; the route keeps its
        // current wire instead of failing to load. The proof is already cleared,
        // and a probe that outlived its own generation never writes an answer.
        if (controller.signal.aborted || capabilityProbe !== controller) return
        capabilityProbe = undefined
        markInitialProbeSettled()
        ctx.logger.info(
          'llm-cc-pool: no member credential for the CC wire parity probe;'
          + ' serving the non-parity wire until a credential is stored',
        )
        return
      }
      const proof = await probePoolCapabilities(apiKey, controller.signal)
      // A superseded probe and a disposed plugin both abort this controller, so
      // an answer that arrives after either never writes a proof.
      if (controller.signal.aborted || capabilityProbe !== controller) return
      capabilityProbe = undefined
      if (proof !== undefined) {
        capabilityProof = proof
        probeFailures = 0
        markInitialProbeSettled()
        ctx.logger.info(
          `llm-cc-pool: CC wire parity proved for endpoint build "${proof.buildId}"; serving the parity wire`,
        )
        return
      }
      probeFailures += 1
      const delay = nextProbeDelay()
      markInitialProbeSettled()
      ctx.logger.warn(
        `llm-cc-pool: CC wire parity probe failed (attempt ${probeFailures});`
        + ` serving the non-parity wire; retrying in ${delay}ms`,
      )
      scheduleProbe(delay)
    })()
  }

  /**
   * Schedule one probe generation after `delayMs`.
   * @param delayMs - bounded wait before the next attempt.
   */
  const scheduleProbe = (delayMs: number): void => {
    if (disposed || !config.ccWireParity) return
    clearProbeRetry()
    probeRetryTimer = setTimeout(() => {
      probeRetryTimer = undefined
      startProbe()
    }, delayMs)
  }

  /**
   * Reopen the capability question now, dropping the current proof and any
   * pending retry. A replaced member credential resets the failure count because
   * the new credential may be the fact the previous attempts lacked.
   */
  const refreshWireParity = (): void => {
    probeFailures = 0
    startProbe()
  }

  /**
   * Wait for the load probe's first outcome under a bounded deadline.
   *
   * The first routed request calls this before preparing its snapshot. A probe
   * that answers proves the wire or leaves it off; a probe that stalls past the
   * deadline leaves the request on the safe non-parity wire while the retry
   * schedule keeps asking.
   */
  const awaitInitialProbe = async (): Promise<void> => {
    if (isInitialProbeSettled() || initialProbeWaitExpired) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        initialProbe,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, WIRE_PARITY_READY_TIMEOUT_MS) }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (!isInitialProbeSettled()) {
      // One bounded wait per process: a probe that outlived it keeps retrying in
      // the background, and later requests serve the current non-parity wire
      // without paying the same wait again.
      initialProbeWaitExpired = true
      ctx.logger.warn(
        'llm-cc-pool: the initial CC wire parity probe did not answer within'
        + ` ${WIRE_PARITY_READY_TIMEOUT_MS}ms; serving the non-parity wire while it keeps retrying`,
      )
    }
  }

  // A positive proof belongs to the member credential that asked for it, so a
  // replaced CC_POOL_API_KEY reopens the question instead of inheriting it.
  ctx.on('credentials/reference-updated', (ref) => {
    if (ref === credentialRef(API_KEY_REF)) refreshWireParity()
  })
  ctx.effect(() => () => {
    disposed = true
    clearProbeRetry()
    capabilityProbe?.abort()
    // A request already waiting on the load probe must not hang behind a fiber
    // that can no longer prove anything.
    markInitialProbeSettled()
  }, 'llm-cc-pool.capability-probe')

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
    // The pool route carries session headers, but that is no reason to write a
    // file: the durable sink is opt-in, and an unconfigured plugin stays silent.
    implicit: false,
    // Its own file, so enabling both this sink and llm-pi-ai's never puts two
    // writers on one default path.
    defaultPath: defaultRequestLogPath('llm-cc-pool'),
  })
  if (requestLog !== undefined) ctx.effect(() => () => requestLog.close(), 'llm-cc-pool.request-log')

  // The existing channel, logger, and optional sink; the wrapper below adds one
  // observation without replacing what this callback already records.
  const diagnostics = piAiDiagnosticHooks({
    label: 'llm-cc-pool',
    retainedRoutes: SESSION_HEADERS,
    logger: ctx.logger,
    ...requestLog === undefined ? {} : { append: (event) => { requestLog.append(event) } },
  })
  /**
   * Observe each settled request for the one signal that wire parity may no
   * longer be served: a `503` on this route that the member endpoint marked as
   * its `cc_wire_parity_unavailable` refusal.
   *
   * The status alone is not that signal: any other `503` — an upstream failure, a
   * restart, a proxy error — leaves wire parity exactly as it was. Only the
   * response carrying `x-cc-wire-parity-unavailable: 1` is evidence against the
   * capability, so only that response drops the proof and the next request uses
   * the three-marker wire. The refusal schedules another probe after a cooldown
   * instead of leaving the route permanently off; a probe already in flight is
   * the fresher question, and the cooldown means a burst of refusals cannot
   * become a probe storm. The standard request-log and logging callback runs
   * first and is not replaced.
   * @param event - one request or settled-response diagnostic.
   */
  const observeWireParityFailure = (event: PiAiRequestDiagnostic): void => {
    diagnostics.onRequestDiagnostic?.(event)
    if (event.kind === 'response' && event.status === 503 && event.wireParityUnavailable === true && wireParity()) {
      capabilityProof = undefined
      ctx.logger.warn(
        'llm-cc-pool: pool refused CC wire parity with 503 on a wire-parity-on request;'
        + ' dropping the proof and serving the non-parity wire until the endpoint proves it again',
      )
      // A probe already in flight is the newer question; a pending retry keeps its
      // shorter delay. Otherwise ask again after the cooldown.
      if (capabilityProbe === undefined && probeRetryTimer === undefined) {
        scheduleProbe(WIRE_PARITY_REFUSAL_COOLDOWN_MS)
      }
    }
  }

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
    ...diagnostics,
    onRequestDiagnostic: observeWireParityFailure,
  }
  const adapter = new CcPoolAdapter(options, () => current().models, awaitInitialProbe)
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

  // The route loads on its current wire and switches only after the member
  // endpoint proves wire parity. A disabled route records no pending
  // first-request wait; an enabled one starts its probe now, and the first
  // request awaits that probe's first outcome under a bounded deadline.
  if (config.ccWireParity) refreshWireParity()
  else markInitialProbeSettled()
}
