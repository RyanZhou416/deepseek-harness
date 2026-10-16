/**
 * Drive synthetic Claude Messages attempts through the composition's REGISTERED `claude`
 * route and prove each prepared record is already in the session's log when its POST arrives.
 *
 * This module is the P1 test assembly, and it says exactly what it replaces. The plugin body it
 * mounts is the real production module: `apply` below calls that module's own `apply` with the
 * non-serializable internals a deterministic test must state — the Messages transport, the two
 * independent read transports and the credential-source reader — so no adapter, service,
 * registry or recording path is rebuilt here. The route under test is the one that real `apply`
 * registers on this composition's `ctx.llm`, and every attempt is dispatched through
 * `ctx.llm.stream`; this module constructs no `ClaudeAdapter` and binds no port.
 *
 * `createRecordingAssembly` is what a programmatic host (the production spec) mounts as its
 * Loader entry; `apply` is what the headless snapshot composition mounts, and it adds the
 * first-dispatch driver on top. Both use `driveRecordedAttempts`, so one driver serves both
 * hosts. `name`, `inject` and `Config` are the real plugin's own, so the Loader validates the
 * entry's config with the production schema.
 *
 * Egress is closed for the whole life of the mounted composition, without a server or a new
 * production option. Every path the production route can reach is stated: the Messages POST and
 * the adapter's own identity-profile read go through the injected `claudeMessagesFetch`; the
 * `policy_limits` read and the organization validation go through their injected
 * `CoreTransport`s; the managed-settings read the maintenance owner builds over `proxiedFetch`,
 * and anything else that reaches the process-global fetch, is refused by a guard installed in
 * this `apply` before the seed and the real `apply`, owned by the composition's context through
 * `ctx.effect` and restored when that context is disposed. A published outbound proxy policy is
 * refused up front as well: the host's mandatory Claude route and its scheme proxy are read
 * through this plugin's own `host-egress` readers, and either one being published fails the
 * composition, because that is the one configuration in which `proxiedFetch` would leave the
 * guarded process-global fetch for undici's own. `NODE_USE_ENV_PROXY` is sampled by Node at
 * process start, so it cannot be undone from inside a run: the launcher that starts this
 * composition clears it, and this module's refusal is the in-run check that no policy survived.
 * Everything refused is recorded in `capture.refused` rather than forwarded.
 *
 * The synthetic account is written into the plugin's own durable store below the composition's
 * `DSH_HOME` before the real `apply` runs, and its stored fields are the ones the production
 * request path reads before the wire (see `storedSession`). No real credential file, Keychain,
 * helper, grant or socket is read or written.
 */

import { reconstructRequestSystem } from '@deepseek-ai/dsh-llm-request-record'
import {
  CLAUDE_PROTOCOL_PROFILE,
  deriveClaudeDeviceId,
  hostClaudeRoute,
  hostProxyForScheme,
  saveAccountSession,
  subscriptions,
} from './subscription-test-modules.mjs'

export const name = 'claude-request-recording-probe'

/** The real plugin's injections, plus the persistence the driver reads its log through. */
export const inject = ['llm', 'sessionPersistence']

/** The real plugin's own config schema, so the Loader validates this entry the same way. */
export const Config = subscriptions.Config

/** Model this route builds for; an unlisted id is accepted, as the producer's own suite shows. */
export const MODEL = 'claude-opus-4-5'

/** Synthetic identity; module-local so no caller can observe it. */
const ACCOUNT = 'synthetic-recording-account'
const ACCOUNT_UUID = '00000000-0000-4000-8000-0000000000c1'

/**
 * The pinned Messages endpoint itself, so the transport admits exactly this origin and this
 * pathname. The count-tokens path, the OAuth profile path and every other host are refused
 * rather than tolerated as a substring.
 */
const MESSAGES_ENDPOINT = new URL(CLAUDE_PROTOCOL_PROFILE.endpoints.messages)

/** One completed text turn, the shape the adapter's translator accepts. */
const RESPONSE_SSE = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"recorded"}}\n\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'data: {"type":"message_stop"}\n\n',
].join('')

/** The caller system text of each attempt; different text keeps the two records distinguishable. */
export const ATTEMPTS = ['first recorded attempt', 'second recorded attempt']

/** The caller system text the refusal case drives; the same shape, one attempt. */
export const REFUSED_ATTEMPT = ATTEMPTS[0]

/** The user turn both attempts carry; text only, so no attachment service is needed. */
const MESSAGES = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]

/**
 * One synthetic stored session carrying the fields the production request path reads before it
 * builds the wire request:
 *  - `accountUuid` plus the device id this host derives for that UUID satisfy the adapter's
 *    identity gate, so the profile backfill and its request never start;
 *  - `scopes: 'user:inference'` states no `user:profile`, which is the maintenance owner's
 *    `scope-missing` branch, so it starts no profile read;
 *  - `subscriptionType: 'max'` is the confirmed pro/max branch, which both the maintenance
 *    owner's eligibility and the independent `policy_limits` eligibility treat as ineligible,
 *    so neither reads managed settings or the policy endpoint;
 *  - `expiresAt` is far beyond the route's refresh lead, so no credential cycle is due.
 * @returns the session the plugin's own store holds.
 */
function storedSession() {
  return {
    accessToken: 'synthetic-recording-access',
    refreshToken: 'synthetic-recording-refresh',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    subscriptionType: 'max',
    accountUuid: ACCOUNT_UUID,
    deviceId: deriveClaudeDeviceId(`uuid:${ACCOUNT_UUID}`),
    emailAddress: 'synthetic-recording-account@example.invalid',
  }
}

/**
 * Store the synthetic account in the plugin's own durable store.
 *
 * The assembly calls this before the real `apply` runs, so the composition never serves a
 * request from a store that holds nothing yet; the write lands under the caller's private
 * `DSH_HOME`.
 */
async function seedSyntheticAccount() {
  await saveAccountSession('claude', ACCOUNT, storedSession())
}

/**
 * The ordered system text of one serialized body, parsed here rather than by the producer's own
 * reader so the comparison has two independent sides.
 * @param body - the exact serialized body the transport received.
 * @returns one entry per emitted system block, in order.
 */
function postedSystemTexts(body) {
  const parsed = JSON.parse(body)
  if (!Array.isArray(parsed?.system)) throw new Error('recording probe: the posted body carries no system list')
  return parsed.system.map((block, index) => {
    if (typeof block?.text !== 'string') throw new Error(`recording probe: posted system block ${index} carries no text`)
    return block.text
  })
}

/**
 * The transports this composition states, and the requests they refused.
 *
 * The injected Messages transport is the only one that answers; the other instance transports
 * exist so a destination this composition did not state fails the case instead of being
 * reached. The log reader the POST-time check needs belongs to one driven sequence, so it is
 * attached for exactly that sequence.
 * @returns the capture the composing host reads and the assembly mounts.
 */
export function createCapture() {
  const posts = []
  const refused = []
  let recordsNow = undefined
  const capture = {
    posts,
    refused,
    productionFiber: undefined,
    proxy: undefined,
    attach(reader) { recordsNow = reader },
    detach() { recordsNow = undefined },
  }
  const refuse = (label) => {
    refused.push(label)
    throw new Error(`recording probe: this composition reaches no ${label}`)
  }
  capture.transport = async (url, init) => {
    let target
    try {
      target = new URL(String(url))
    } catch (error) {
      throw new Error(`recording probe: the route requested a URL this transport cannot parse (${String(error)})`)
    }
    if (target.origin !== MESSAGES_ENDPOINT.origin || target.pathname !== MESSAGES_ENDPOINT.pathname) {
      refuse(`${target.origin}${target.pathname}`)
    }
    const systemTexts = postedSystemTexts(String(init?.body))
    // Endpoint identity is all this transport admits. The order the record must already satisfy
    // here is durability before the wire: the route reaches this transport only after the
    // recording service reported a flushed record, so the record for THIS attempt is already in
    // the session's log, and its text is the text of the body this very POST carries.
    const records = await recordsNow()
    if (records.length !== posts.length + 1) {
      throw new Error(`recording probe: ${records.length} prepared records were in the log at POST ${posts.length + 1}`)
    }
    const prepared = records[records.length - 1]
    if (JSON.stringify(prepared.data.systemBlocks) !== JSON.stringify(systemTexts)) {
      throw new Error(`recording probe: record ${prepared.seq} does not carry the system text of its own body`)
    }
    posts.push({ preparedId: prepared.seq, systemTexts })
    return new Response(RESPONSE_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return {
    ...capture,
    policyLimitsTransport: async () => refuse('policy_limits read'),
    orgPinTransport: async () => refuse('organization validation'),
  }
}

/**
 * Refuse every process-global fetch for the whole life of the mounted composition.
 *
 * The route's remaining egress path — the maintenance owner's managed-settings read — is built
 * over `proxiedFetch`, so a process-global guard is what makes it fail here instead of reaching
 * a peer. It is installed before the seed and the real `apply` and lives until the composition's
 * context is disposed, which is also what covers the registration, pre-request and teardown
 * windows. The exact previous property descriptor is captured first and returned as the
 * restoration, so a host that already stated its own fetch keeps it.
 * @param capture - the capture that records what was refused.
 * @returns the restoration, idempotent so a failure path may also run it.
 */
function installEgressGuard(capture) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? input)
    capture.refused.push(`process-global fetch: ${url}`)
    throw new Error(`recording probe: the driven composition reached the process-global fetch (${url})`)
  }
  return () => {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'fetch')
    else Object.defineProperty(globalThis, 'fetch', previous)
  }
}

/**
 * Refuse to run under a published outbound proxy policy.
 *
 * The host publishes a mandatory Claude route and a general proxy through the environment, and
 * `proxiedFetch` reads the same names through this plugin's own readers, so a published value is
 * what would make one path leave the process-global fetch the guard covers and use undici's own
 * fetch instead. The values are recorded either way; a published one fails the composition rather
 * than being waved through as uncovered egress.
 * @param capture - the capture that records the observed policy.
 */
function requireNoProxyPolicy(capture) {
  const claudeRoute = hostClaudeRoute(process.env)
  const httpsProxy = hostProxyForScheme(MESSAGES_ENDPOINT, process.env)
  capture.proxy = { claudeRoute, httpsProxy }
  if (claudeRoute !== undefined) {
    throw new Error('recording probe: the host published a mandatory Claude route; this composition states no proxy')
  }
  if (httpsProxy !== undefined) {
    throw new Error('recording probe: the host published an https proxy; this composition states no proxy')
  }
}

/**
 * Every prepared record this session's log carries, read through a fresh read handle. The
 * handle is opened and closed per read, so nothing of the composition's writer is borrowed.
 * @param ctx - the composition context holding the persistence owner.
 * @param sessionId - the session whose log is read.
 * @returns the whole log and, separately, its prepared records in log order.
 */
async function readLog(ctx, sessionId) {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  try {
    const { events } = await handle.read()
    return { events, records: events.filter(event => event.type === 'llm/request-record') }
  } finally {
    await handle.close()
  }
}

/**
 * Drain one attempt's stream and report its terminal outcome.
 *
 * Only a failed or aborted finish carries a failure; every other terminal kind reports its kind
 * alone, so a route that stopped short of an error is never reported from a missing field.
 * @param stream - the registered route's chunk stream.
 * @returns the finish kind, and the failure code and retry disposition when it failed.
 */
async function drainAttempt(stream) {
  let outcome = { kind: 'none' }
  for await (const chunk of stream) {
    if (chunk.type !== 'finish') continue
    const failed = chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted'
    outcome = failed
      ? {
        kind: chunk.reason.kind,
        code: chunk.reason.failure.code,
        retryDisposition: chunk.reason.failure.retryDisposition,
      }
      : { kind: chunk.reason.kind }
  }
  return outcome
}

/**
 * Drive one synthetic Messages attempt per caller system text through the registered route.
 *
 * The composing host decides what its composition must observe; this function only refuses a
 * structurally impossible attempt — a request outside the pinned Messages route, or a POST
 * whose record is absent from the log — and reports everything else.
 * @param ctx - the composition context holding `llm`, the recording service and persistence.
 * @param sessionId - the live session every attempt is recorded into.
 * @param texts - the caller system text of each attempt, in order.
 * @param capture - the capture whose transport this composition's route was given.
 * @returns the admitted POSTs, the attempts' terminal outcomes, and the log the records reached.
 */
export async function driveRecordedAttempts(ctx, sessionId, texts, capture) {
  if (sessionId === undefined) throw new Error('recording probe: the route carried no session id')
  const finishes = []
  capture.attach(async () => (await readLog(ctx, sessionId)).records)
  try {
    for (const system of texts) {
      finishes.push(await drainAttempt(ctx.llm.stream({
        provider: 'claude',
        model: MODEL,
        system,
        sessionId,
        messages: MESSAGES,
      })))
    }
  } finally {
    capture.detach()
  }
  return { posts: capture.posts, finishes, readBack: await readLog(ctx, sessionId) }
}

/**
 * Require the plain success contract of a driven sequence over the log just read back.
 *
 * The comparison is made twice on purpose: the record's own blocks against the bytes this probe
 * parsed out of the POSTed body, and the package reader's projection selected by the recorded
 * `preparedId` — which is what shows one attempt is addressed rather than "the latest".
 * @param observed - what {@link driveRecordedAttempts} returned.
 * @param texts - the caller system text of each attempt, in order.
 */
export function requireRecordedAttempts(observed, texts) {
  const { posts, finishes, readBack } = observed
  if (posts.length !== texts.length) {
    throw new Error(`recording probe: ${posts.length} Messages requests reached the transport, expected ${texts.length}`)
  }
  if (readBack.records.length !== texts.length) {
    throw new Error(`recording probe: ${readBack.records.length} prepared records reached the log, expected ${texts.length}`)
  }
  if (new Set(posts.map(post => post.preparedId)).size !== posts.length) {
    throw new Error('recording probe: two attempts shared one preparedId')
  }
  for (const [index, text] of texts.entries()) {
    const finish = finishes[index]
    if (finish.kind !== 'stop') throw new Error(`recording probe: attempt ${index + 1} ended as ${finish.kind}`)
    const posted = posts[index]
    const stored = reconstructRequestSystem(readBack.events, posted.preparedId)
    if (stored === undefined) {
      throw new Error(`recording probe: the session log holds no record at preparedId ${posted.preparedId}`)
    }
    if (JSON.stringify(stored) !== JSON.stringify(posted.systemTexts)) {
      throw new Error(`recording probe: record ${posted.preparedId} does not carry the system text that was posted`)
    }
    if (posted.systemTexts[posted.systemTexts.length - 1] !== text) {
      throw new Error("recording probe: the posted body does not end with this attempt's caller system text")
    }
  }
}

/**
 * Mount the real plugin behind the transports this composition states.
 *
 * The egress guard and the proxy-policy refusal are installed first, then the synthetic account
 * is stored, and only then does the real `apply` run: this `apply` is async so the Loader's
 * awaited fiber lifecycle runs it after both. The production fiber is kept and awaited here, so a
 * startup or apply failure rejects this apply instead of being settled away by the Loader's own
 * `Promise.allSettled`. The inner wrapper returns the real `apply`'s own result, so a production
 * `apply` that becomes asynchronous is awaited rather than treated as already finished.
 * @param capture - the capture whose transports the route is given.
 * @param options - `seed: false` mounts a composition whose account was stored by an earlier
 *   process, so this one reads that store instead of writing it again.
 * @returns the plugin object a composition mounts, carrying its capture.
 */
export function createRecordingAssembly(capture, options = {}) {
  return {
    name,
    inject,
    Config,
    capture,
    async apply(ctx, config) {
      requireNoProxyPolicy(capture)
      const restoreEgress = installEgressGuard(capture)
      // The context owns the restoration for as long as it lives; the refusal below also restores
      // it on the failure path, where a rejected apply never collects this effect's disposer.
      ctx.effect(() => restoreEgress, 'claude-request-recording-probe: process-global fetch guard')
      try {
        if (options.seed !== false) await seedSyntheticAccount()
        const production = ctx.plugin(Object.assign(
          (inner) => subscriptions.apply(inner, config, {
            claudeMessagesFetch: capture.transport,
            // Claude Code's own credential store is not this composition's source: stating the
            // reader as absent keeps every file, Keychain and helper read out of the case.
            claudeCredentialSource: () => undefined,
            policyLimitsTransport: capture.policyLimitsTransport,
            orgPinTransport: capture.orgPinTransport,
          }),
          { inject: subscriptions.inject },
        ))
        capture.productionFiber = production
        await production
      } catch (failure) {
        restoreEgress()
        throw failure
      }
    },
  }
}

/**
 * Mount the assembly and drive it once on the session's first model-stream dispatch, failing the
 * turn on a mismatch. This is the headless snapshot composition's entry.
 * @param ctx - composition context.
 * @param config - the real plugin's config, validated by the Loader against {@link Config}.
 */
export async function apply(ctx, config) {
  const capture = createCapture()
  await createRecordingAssembly(capture).apply(ctx, config)
  let driven = false
  ctx.on('llm/stream', async function* (options, next) {
    if (!driven && options.sessionId !== undefined) {
      driven = true
      requireRecordedAttempts(await driveRecordedAttempts(ctx, options.sessionId, ATTEMPTS, capture), ATTEMPTS)
    }
    yield* next()
  })
}
