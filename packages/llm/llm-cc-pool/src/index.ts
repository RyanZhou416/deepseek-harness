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
 * `x-cc-wire-parity-unavailable: 1` on a wire-parity-on request withdraws the
 * whole capability answer — wire proof and A-off cache grant together — and
 * schedules another probe after a cooldown instead of leaving the route
 * permanently on the non-parity wire.
 *
 * The same probe answers whether the pool build advertises
 * `aOffHipaaCache: "downgrade"`. On the route's non-parity wire — wire parity
 * not requested, or requested and not proved — a main or subagent request under
 * a one-hour policy would send one-hour `cache_control` markers. The pool owns
 * the HIPAA downgrade for that wire, so the route sends it only while the
 * current answer carries a live grant for that build, and otherwise refuses the
 * dispatch with `POOL_A_OFF_HIPAA_CACHE_UNAVAILABLE` before any provider
 * request: it neither sends the one-hour markers nor silently substitutes five
 * minutes. A helper request keeps the API's default five-minute lifetime and is
 * unaffected. The grant is one optional lease inside the answer state, replaced
 * atomically with the answer and bounded by a short TTL, because an A-off
 * request cannot observe a silent pool swap through the wire headers; a live
 * lease is revalidated before it expires and an expired one refuses the
 * dispatch until a fresh answer carries the exact token again. The wire-parity
 * proof still grants the wire on its own; an absent or malformed A-off field
 * never weakens it.
 *
 * Wire parity declares its own cache intent, which the profile carries:
 * `cacheTtl: none` — this route's caching-disabled state — makes a main or
 * subagent wire-parity request declare `off`, so the worker writes no marker, no
 * TTL, and no cache beta, and every other lifetime declares `main` for the
 * worker's own cache plan, including the HIPAA-driven five-minute fallback on
 * that wire. All of them reach the wire only through this route's profile;
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
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  createPiAiRequestLog,
  defaultRequestLogPath,
  isHelperRequest,
  PiAiAdapter,
  piAiAuthFrom,
  piAiDiagnosticHooks,
} from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, PiAiRequestDiagnostic, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { Config } from './config.ts'
import { DISCOVERY_NAMESPACE, discoverPoolModels, probePoolCapabilities } from './discovery.ts'
import type { PoolCapabilityProof } from './discovery.ts'
import { API_KEY_REF, BASE_URL, MODEL_INPUT, PROVIDER, resolvePoolCachePolicy, resolvePoolModels, resolvePoolProfiles } from './pool.ts'
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
 * Stable failure code for a dispatch the route refuses because the pool did not
 * advertise `aOffHipaaCache: "downgrade"` while the non-parity wire would send
 * its one-hour prompt-cache markers. The refusal happens before any provider
 * request, so no prompt reaches the pool under a cache lifetime the answering
 * build has not licensed.
 */
export const A_OFF_HIPAA_CACHE_UNAVAILABLE_CODE = 'POOL_A_OFF_HIPAA_CACHE_UNAVAILABLE'

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
 * How long one `aOffHipaaCache: "downgrade"` grant stays live after the answer
 * that carried it, in milliseconds.
 *
 * The permission belongs to the pool build that answered, and an A-off request
 * never carries the wire headers or receives the marked 503 that would reveal a
 * silent swap to an older build. A finite lease therefore bounds how long this
 * route can keep sending unlicensed one-hour markers after the pool changes
 * under it: at most one TTL, and the proactive revalidation below normally
 * replaces the answer well before expiry.
 */
const A_OFF_HIPAA_CACHE_TTL_MS = 120_000

/**
 * Age at which a live A-off grant is revalidated, in milliseconds. It is half
 * the lease, so a probe failure or two still leaves room for the retry backoff
 * to recover the answer before the lease expires.
 */
const A_OFF_HIPAA_CACHE_REFRESH_MS = 60_000

/**
 * Recheck delay after an answer that did not grant the A-off permission. The
 * route refuses its one-hour non-parity dispatch meanwhile, so this only decides
 * how soon a newly upgraded pool build can be noticed without a credential or
 * wire event.
 */
const A_OFF_HIPAA_CACHE_RECHECK_MS = 120_000

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
   *   a request cannot decide the wire before that probe does; it accepts the
   *   request's cancellation so a cancelled first request does not wait for the
   *   probe.
   * @param admit - refuses a dispatch the route's current capability state does
   *   not license, before any provider request opens.
   */
  constructor(
    options: PiAiAdapterOptions,
    private readonly catalogue: () => readonly CcPoolModel[],
    private readonly readiness: (signal?: AbortSignal) => Promise<void>,
    private readonly admit: (options: GenerateOptions) => void,
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
   *
   * The A-off admission check runs immediately before every upstream open —
   * including a queued request after its session wait and a retry after a
   * session-busy pause — so a credential refresh that withdraws the permission
   * while this request waits cannot let it open under the stale grant.
   * @param options - the assembled request carrying the session identity.
   * @param open - opens this dispatch's upstream stream for one attempt.
   * @returns the session-ordered stream.
   */
  private ordered(
    options: GenerateOptions,
    open: (attempt: GenerateOptions) => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const checked = (attempt: GenerateOptions): AsyncIterable<StreamChunk> => {
      this.admit(attempt)
      return open(attempt)
    }
    if (options.sessionId === undefined) return checked(options)
    return this.sessions.serialize({
      sessionId: String(options.sessionId),
      signal: options.signal,
      open: retryNonce => checked(retryNonce === undefined ? options : retriedAttempt(options, retryNonce)),
    })
  }

  /**
   * Await the load probe, then open one dispatch.
   *
   * The probe decides whether the route profile carries the wire-parity flag
   * and whether the A-off HIPAA cache lifetime is available, and the adapter's
   * snapshot is captured at dispatch preparation. Waiting on the probe's first
   * outcome — bounded by the caller's deadline — keeps the first request from
   * deciding either before the endpoint answered. Admission runs in
   * {@link ordered}, immediately before the upstream opens.
   * @param open - opens the dispatch after the probe's first outcome.
   * @param signal - the request's cancellation; a cancelled request stops waiting.
   * @returns the deferred stream.
   */
  private async * afterReadiness(open: () => AsyncIterable<StreamChunk>, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    await this.readiness(signal)
    yield* open()
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.afterReadiness(
      () => this.ordered(options, attempt => super.stream(attempt)),
      options.signal,
    )
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
    await this.readiness(signal)
    const call = await super.prepareCall(provider, model, signal)
    return {
      model: call.model,
      stream: options => this.afterReadiness(
        () => this.ordered(options, attempt => call.stream(attempt)),
        options.signal,
      ),
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
 * The capability facts one committed probe answer licenses, replaced atomically.
 *
 * The A-off cache grant lives inside this value rather than beside it, so a
 * permission can never outlive the answer and build that advertised it: a new
 * answer replaces the whole value, and any revocation clears it. The optional
 * expiry makes the grant a lease, bounding a silent pool swap that an A-off
 * request cannot observe through the wire headers.
 */
interface PoolCapabilityState {
  /** The wire-parity proof scoped to the answering endpoint and build. */
  readonly proof: PoolCapabilityProof
  /** When the A-off HIPAA cache grant stops being live; absent when not granted. */
  readonly aOffHipaaCacheExpiresAt?: number
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
  // Capabilities are proven only by the member endpoint itself, for the member
  // endpoint and pool build that answered, and only for this plugin instance: no
  // answer exists at load. The stored state carries that `buildId`, and the route
  // profiles are resolved for the build it names, so a new probe replaces it and
  // a profile built for another build is never reused. A load or credential
  // probe drops the previous answer before it asks. A failed probe is retried
  // with bounded backoff instead of leaving the route permanently off; a probe
  // that answers without a build identity cannot produce one, and a superseded
  // probe never writes its answer. The A-off HIPAA cache grant is one optional
  // lease inside the same state, so it never outlives the answer that advertised
  // it; a marked wire-parity refusal withdraws the whole state, because the
  // selected worker has changed and the next answer must re-establish both
  // facts.
  let capabilityState: PoolCapabilityState | undefined
  let capabilityProbe: AbortController | undefined
  let probeRetryTimer: ReturnType<typeof setTimeout> | undefined
  let aOffRefreshTimer: ReturnType<typeof setTimeout> | undefined
  let probeFailures = 0
  // The first routed request waits for the load probe's first outcome, so it
  // cannot prepare its snapshot before the probe decides the wire. The promise
  // never rejects; `awaitInitialProbe` bounds the wait and accepts the request's
  // own cancellation.
  let initialProbeSettled = false
  let initialProbeWaitExpired = false
  const initialProbe = Promise.withResolvers<void>()
  // Read once, with the rest of the loader configuration: the cache policy a
  // deployment asks for is not a per-request setting, and it is captured here so
  // every resolution of this route's profiles carries the same policy.
  const cachePolicy = cachePolicyOf(config)
  // Fail loud at load, before the route is registered or any probe is sent: an
  // impossible marker/lifetime combination belongs here, not in a provider
  // rejection at the first request.
  const resolvedCachePolicy = resolvePoolCachePolicy(cachePolicy)
  // A one-hour policy is the only one whose wire-parity-off path writes a
  // one-hour marker, so it is the only one that needs the pool's A-off HIPAA
  // cache permission. Under `cc3` a helper request stays at five minutes and
  // never needs it.
  const requiresAOffHipaaCache = resolvedCachePolicy.cacheTtl === '1h'
  // The capability probe is sent when it must answer either question: the wire
  // opt-in, or the A-off cache permission the default one-hour policy needs.
  // A caching-disabled route that does not request wire parity asks nothing.
  const probesCapabilities = config.ccWireParity || requiresAOffHipaaCache
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
    return capabilityState?.proof
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
    initialProbe.resolve()
  }

  /** Read the settled flag without narrowing it across the wait's await boundary. */
  const isInitialProbeSettled = (): boolean => initialProbeSettled

  /** Cancel a pending retry; a new probe generation and disposal both do. */
  const clearProbeRetry = (): void => {
    if (probeRetryTimer === undefined) return
    clearTimeout(probeRetryTimer)
    probeRetryTimer = undefined
  }

  /** Cancel the proactive A-off revalidation; a new probe and disposal both do. */
  const clearAOffRefresh = (): void => {
    if (aOffRefreshTimer === undefined) return
    clearTimeout(aOffRefreshTimer)
    aOffRefreshTimer = undefined
  }

  /**
   * Schedule the next A-off capability answer, which is also the fresh check
   * that bounds a silent pool swap.
   *
   * A live grant is revalidated at half its lease; an answer that withheld the
   * permission is rechecked after a full lease. Both paths only ask; the current
   * state stays in force until the new answer replaces it, and a grant that
   * outlives its expiry is refused by admission instead.
   */
  const scheduleAOffRefresh = (): void => {
    clearAOffRefresh()
    if (!requiresAOffHipaaCache) return
    const delay = capabilityState?.aOffHipaaCacheExpiresAt === undefined
      ? A_OFF_HIPAA_CACHE_RECHECK_MS
      : A_OFF_HIPAA_CACHE_REFRESH_MS
    aOffRefreshTimer = setTimeout(() => {
      aOffRefreshTimer = undefined
      startProbe(false)
    }, delay)
  }

  /** The bounded backoff before the next probe attempt after the failures seen. */
  const nextProbeDelay = (): number => Math.min(
    WIRE_PARITY_RETRY_INITIAL_MS * 2 ** Math.max(probeFailures - 1, 0),
    WIRE_PARITY_RETRY_MAX_MS,
  )

  /**
   * Ask the member endpoint which capabilities this route may use.
   *
   * This runs at profile load, when the member credential changes, and after a
   * failed attempt's backoff. It asks whenever the route requests wire parity or
   * a one-hour policy needs the pool's A-off HIPAA cache permission; a
   * caching-disabled route that does not request the wire asks nothing. A
   * missing credential is a route that proves nothing rather than a route
   * failure: it keeps its current wire and schedules another attempt, so a
   * credential stored without an update event is still picked up. A failed,
   * timed-out, malformed, or build-less answer leaves no capability and
   * schedules another attempt with bounded backoff, so one failed probe cannot
   * leave the process permanently off. The failure is logged at warning level
   * with the attempt number and the next delay; a proof logs the answering
   * build identity at info level, and the A-off cache permission logs at info
   * when advertised and at warning when absent. None carries a credential.
   *
   * Each probe supersedes the previous one and drops its answer before asking, so
   * a stale proof or A-off permission never outlives the endpoint, pool build,
   * or member credential it described.
   */
  const startProbe = (revoke: boolean): void => {
    if (!probesCapabilities) return
    clearProbeRetry()
    clearAOffRefresh()
    capabilityProbe?.abort()
    const controller = new AbortController()
    capabilityProbe = controller
    // A load, credential, or refusal probe invalidates the current answer before
    // asking. A revalidation keeps it in force until the answer replaces it, so a
    // transient probe failure does not withdraw a live lease early.
    if (revoke) capabilityState = undefined
    void (async () => {
      let apiKey: string
      try {
        apiKey = await resolvePoolApiKey(ctx, PROVIDER)
      } catch {
        // A missing member credential proves nothing; the route keeps its current
        // wire instead of failing to load. A superseded or disposed probe must not
        // log, clear a newer answer, or schedule its own retry.
        if (controller.signal.aborted) return
        capabilityProbe = undefined
        markInitialProbeSettled()
        probeFailures += 1
        const delay = nextProbeDelay()
        ctx.logger.warn(
          `llm-cc-pool: member credential unavailable for the capability probe (attempt ${probeFailures});`
          + ` ${config.ccWireParity ? 'serving the non-parity wire' : 'refusing the one-hour A-off wire'};`
          + ` retrying in ${delay}ms`,
        )
        scheduleProbe(delay, revoke)
        return
      }
      const answer = await probePoolCapabilities(apiKey, controller.signal)
      // A superseded probe and a disposed plugin both abort this controller, so
      // an answer that arrives after either never writes a capability.
      if (controller.signal.aborted) return
      capabilityProbe = undefined
      if (answer !== undefined) {
        capabilityState = {
          proof: answer.proof,
          ...answer.aOffHipaaCache
            ? { aOffHipaaCacheExpiresAt: Date.now() + A_OFF_HIPAA_CACHE_TTL_MS }
            : {},
        }
        probeFailures = 0
        markInitialProbeSettled()
        if (config.ccWireParity) {
          ctx.logger.info(
            `llm-cc-pool: CC wire parity proved for endpoint build "${answer.proof.buildId}"; serving the parity wire`,
          )
        }
        if (requiresAOffHipaaCache) {
          if (answer.aOffHipaaCache) {
            ctx.logger.info(
              `llm-cc-pool: pool build "${answer.proof.buildId}" advertises aOffHipaaCache "downgrade";`
              + ' the A-off wire may send its one-hour prompt-cache markers',
            )
          } else {
            ctx.logger.warn(
              `llm-cc-pool: pool build "${answer.proof.buildId}" does not advertise aOffHipaaCache "downgrade";`
              + ' refusing the A-off wire\'s one-hour prompt-cache markers until it does',
            )
          }
        }
        scheduleAOffRefresh()
        return
      }
      probeFailures += 1
      const delay = nextProbeDelay()
      markInitialProbeSettled()
      ctx.logger.warn(
        `llm-cc-pool: ${config.ccWireParity ? 'CC wire parity probe' : 'pool capability probe'} failed (attempt ${probeFailures});`
        + ` ${config.ccWireParity ? 'serving the non-parity wire' : 'refusing the one-hour A-off wire'};`
        + ` retrying in ${delay}ms`,
      )
      scheduleProbe(delay, revoke)
    })()
  }

  /**
   * Schedule one probe generation after `delayMs`. Callers only reach this while
   * the route probes capabilities, and disposal clears a pending timer.
   * @param delayMs - bounded wait before the next attempt.
   * @param revoke - whether the attempt invalidates the current answer before asking.
   */
  const scheduleProbe = (delayMs: number, revoke: boolean): void => {
    clearProbeRetry()
    probeRetryTimer = setTimeout(() => {
      probeRetryTimer = undefined
      startProbe(revoke)
    }, delayMs)
  }

  /**
   * Reopen the capability question now, dropping the current answer and any
   * pending retry. A replaced member credential resets the failure count because
   * the new credential may be the fact the previous attempts lacked.
   */
  const refreshCapabilities = (): void => {
    probeFailures = 0
    startProbe(true)
  }

  /**
   * Ask for a fresh A-off capability answer when admission finds the current one
   * unusable.
   *
   * No answer, no live lease, or an expired lease all mean the next request must
   * be refused; this only starts the revalidation that can restore the grant. A
   * probe or retry already in flight is the fresher question, and an answer that
   * withheld the permission keeps its own scheduled recheck instead of turning
   * every refused request into a probe. An expired lease is different: the
   * scheduled refresh has already failed to arrive in time, so it is discarded
   * and the question is asked immediately.
   * @param expired - whether the current answer carried a grant that has expired.
   */
  const requestAOffRevalidation = (expired: boolean): void => {
    if (capabilityProbe !== undefined || probeRetryTimer !== undefined) return
    if (!expired && aOffRefreshTimer !== undefined) return
    clearAOffRefresh()
    startProbe(false)
  }

  /**
   * Wait for the load probe's first outcome under a bounded deadline.
   *
   * The first routed request calls this before preparing its snapshot. A probe
   * that answers grants or withholds the wire and the A-off cache permission; a
   * probe that stalls past the deadline leaves the request on the safe
   * non-parity wire and the A-off cache permission unavailable while the retry
   * schedule keeps asking. The request's own cancellation ends the wait without
   * marking the deadline expired, so a cancelled first request never extends the
   * next request's wait.
   * @param signal - the request's cancellation.
   */
  const awaitInitialProbe = async (signal?: AbortSignal): Promise<void> => {
    // Read the live cancellation state: the signal can fire during an await, so
    // a check made once before the wait is not the answer after it.
    const isAborted = (): boolean => signal?.aborted === true
    // A request cancelled before this call must not wait for an abort event that
    // has already fired.
    if (isInitialProbeSettled() || initialProbeWaitExpired || isAborted()) return
    // A request cancelled before preparation never reaches the adapter: the LLM
    // seam throws the abort before dispatch. An abort while waiting resolves
    // through the listener below.
    const deadline = Promise.withResolvers<void>()
    const timer = setTimeout(deadline.resolve, WIRE_PARITY_READY_TIMEOUT_MS)
    const aborted = signal === undefined
      ? undefined
      : new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    try {
      await Promise.race([
        initialProbe.promise,
        deadline.promise,
        ...aborted === undefined ? [] : [aborted],
      ])
    } finally {
      clearTimeout(timer)
    }
    // Cancellation ends the wait without expiring the deadline, so a later
    // request still gets its own bounded wait.
    if (isAborted()) return
    if (!isInitialProbeSettled()) {
      // One bounded wait per process: a probe that outlived it keeps retrying in
      // the background, and later requests use the current capability state
      // without paying the same wait again.
      initialProbeWaitExpired = true
      ctx.logger.warn(
        'llm-cc-pool: the initial pool capability probe did not answer within'
        + ` ${WIRE_PARITY_READY_TIMEOUT_MS}ms;`
        + ` ${config.ccWireParity ? 'serving the non-parity wire' : 'refusing the one-hour A-off wire'}`
        + ' while it keeps retrying',
      )
    }
  }

  // A positive capability belongs to the member credential that asked for it, so
  // a replaced CC_POOL_API_KEY reopens the question instead of inheriting it.
  ctx.on('credentials/reference-updated', (ref) => {
    if (ref === credentialRef(API_KEY_REF)) refreshCapabilities()
  })
  ctx.effect(() => () => {
    clearProbeRetry()
    clearAOffRefresh()
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
  ctx.on('internal/config', (fiber, next) => {
    const raw: unknown = next()
    if (fiber !== ctx.fiber) return raw
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
   * response carrying `x-cc-wire-parity-unavailable: 1` is evidence that the
   * selected worker changed, so that response withdraws the whole capability
   * answer: the wire proof and the A-off HIPAA cache grant together. Keeping the
   * grant would let an older pool build, swapped in under a request that no
   * longer carries the wire headers, receive unlicensed one-hour markers
   * indefinitely. The next request is therefore refused on the A-off wire until
   * a cooldown probe answers with the exact token again, and that probe is the
   * only thing that can restore either fact. The cooldown means a burst of
   * refusals cannot become a probe storm. The standard request-log and logging
   * callback runs first and is not replaced.
   * @param event - one request or settled-response diagnostic.
   */
  const observeWireParityFailure = (event: PiAiRequestDiagnostic): void => {
    diagnostics.onRequestDiagnostic?.(event)
    if (event.kind === 'response' && event.status === 503 && event.wireParityUnavailable === true && wireParity()) {
      // A lease revalidation can be in flight while the wire proof is still live;
      // abort it so its pre-refusal answer cannot restore the grant after this
      // withdrawal. The cooldown probe is the only question that may re-grant.
      capabilityProbe?.abort()
      capabilityProbe = undefined
      capabilityState = undefined
      clearAOffRefresh()
      ctx.logger.warn(
        'llm-cc-pool: pool refused CC wire parity with 503 on a wire-parity-on request;'
        + ' withdrawing the wire proof and the A-off cache grant until the endpoint answers again',
      )
      scheduleProbe(WIRE_PARITY_REFUSAL_COOLDOWN_MS, true)
    }
  }

  /**
   * Whether the current capability answer carries a live A-off HIPAA cache lease.
   *
   * The grant is stored inside {@link capabilityState}, so it is automatically
   * scoped to the build and probe answer that advertised it; the deadline is the
   * remaining bound against a silent pool swap that no A-off request can see on
   * the wire.
   * @returns whether the one-hour non-parity dispatch may open.
   */
  const aOffHipaaCacheGrantLive = (): boolean => {
    const expiresAt = capabilityState?.aOffHipaaCacheExpiresAt
    return expiresAt !== undefined && Date.now() < expiresAt
  }

  /**
   * Refuse a dispatch the current capability state does not license.
   *
   * On the non-parity wire — wire parity not requested or not proved — a main,
   * subagent, or unclassified request under a one-hour policy sends one-hour
   * `cache_control` markers, and only a pool build that advertises
   * `aOffHipaaCache: "downgrade"` accepts that lifetime for HIPAA traffic. The
   * route therefore refuses before opening a provider request unless the current
   * answer carries a live grant. A missing grant starts a revalidation (subject
   * to the cooldown and retry state); an expired one starts it immediately. A
   * helper request keeps the API's default five-minute lifetime under `cc3` and
   * needs no permission; a route whose policy sends no one-hour marker needs none
   * either. On the proved parity wire the worker owns the cache plan, so the
   * unchanged A-on path applies.
   *
   * This runs at the dispatch open point — after any session-queue wait and after
   * the load probe — so a credential refresh that withdraws the grant while a
   * request waits cannot let that request open under the stale permission.
   * @param options - the assembled request about to open.
   * @throws {LlmError} code `POOL_A_OFF_HIPAA_CACHE_UNAVAILABLE` when the A-off
   *   wire would send one-hour markers without a live grant.
   */
  const admitAOffHipaaCache = (options: GenerateOptions): void => {
    if (resolvedCachePolicy.cacheTtl !== '1h') return
    if (resolvedCachePolicy.cacheMarkerPolicy === 'cc3' && isHelperRequest(options)) return
    if (wireParity()) return
    if (aOffHipaaCacheGrantLive()) return
    // An expired lease is a failed refresh, not an absent answer: ask again now
    // instead of waiting for the recheck the old answer scheduled.
    requestAOffRevalidation(capabilityState?.aOffHipaaCacheExpiresAt !== undefined)
    throw new LlmError(
      'llm-cc-pool: refusing the request because the non-parity wire would send one-hour prompt-cache markers and'
      + ` the pool at ${BASE_URL} has no live aOffHipaaCache: "downgrade" grant from /v1/capabilities;`
      + ' install a pool build that advertises it, or set cacheTtl: none to disable prompt caching',
      A_OFF_HIPAA_CACHE_UNAVAILABLE_CODE,
      { retryDisposition: 'forbid' },
    )
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
  const adapter = new CcPoolAdapter(options, () => current().models, awaitInitialProbe, admitAOffHipaaCache)
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

  // The route loads on its current wire and cache behaviour, then adopts the
  // member endpoint's answer. A route that needs no capability answer records no
  // pending first-request wait; one that probes starts now, and the first
  // request awaits that probe's first outcome under a bounded deadline.
  if (probesCapabilities) refreshCapabilities()
  else markInitialProbeSettled()
}
