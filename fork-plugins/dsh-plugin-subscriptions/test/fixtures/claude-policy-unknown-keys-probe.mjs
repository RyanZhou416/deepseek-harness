/**
 * Drive two synthetic Claude Messages attempts through the composition's REGISTERED `claude`
 * route under an accepted `policy_limits` document that states one unregistered restriction key.
 *
 * This module reuses the recording assembly's own surface — `createCapture`,
 * `createRecordingAssembly`, `driveRecordedAttempts` and `requireRecordedAttempts` — and states
 * only the scenario's inputs: an eligible synthetic account, the one managed-settings answer the
 * maintenance owner reads, and the policy document its own transport answers. The route under
 * test is still the one the real `apply` registers, and every attempt is dispatched through
 * `ctx.llm.stream`.
 *
 * The unregistered key is ignored for forward compatibility, so both Messages attempts reach the
 * transport and complete; the registered connector and web-fetch refusals stay in their own
 * operation scopes and never reach `provider.messages`. The durable projection keeps the
 * unregistered key only as a count.
 *
 * No external request, real credential or provider is used: the account is synthetic, the reads
 * are answered locally, every other destination is refused, and `DSH_HOME` is the child
 * composition's own.
 */

import { readFile } from 'node:fs/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  createCapture,
  createRecordingAssembly,
  driveRecordedAttempts,
  requireRecordedAttempts,
} from './claude-request-recording-probe.mjs'
import { deriveClaudeDeviceId, subscriptions } from './subscription-test-modules.mjs'

export const name = 'claude-policy-unknown-keys-probe'

/** The real plugin's injections, plus the persistence the driver reads its log through. */
export const inject = ['llm', 'sessionPersistence']

/** The real plugin's own config schema, so the Loader validates this entry the same way. */
export const Config = subscriptions.Config

/** The caller system text of each attempt, in order; the driver requires the last one posted. */
export const ATTEMPTS = ['first policy attempt', 'second policy attempt']

/** The exact managed-settings endpoint the maintenance owner builds over `proxiedFetch`. */
const SETTINGS_URL = 'https://api.anthropic.com/api/claude_code/settings'

/** The pinned `policy_limits` endpoint the owner reads through its injected transport. */
const POLICY_URL = 'https://api.anthropic.com/api/claude_code/policy_limits'

/** The unregistered key the live service added after this build was pinned. */
const UNREGISTERED_KEY = 'allow_cobalt_plinth_alkanet'

/** A registered key whose refusal reaches no operation in this provider. */
const REGISTERED_CONNECTOR_KEY = 'allow_connector_file_downloads'

/** The document answered for the one policy read: ignored, inapplicable and unsupported keys. */
const POLICY_DOCUMENT = JSON.stringify({
  restrictions: {
    [UNREGISTERED_KEY]: { allowed: false },
    [REGISTERED_CONNECTOR_KEY]: { allowed: false },
    allow_web_fetch: { allowed: false },
  },
})

/** The synthetic account this composition stores. */
const ACCOUNT_UUID = '00000000-0000-4000-8000-0000000000c2'

/** One plain async iterable, the branch the core's own body reader takes. */
function bodyOf(text) {
  return (async function* generate() {
    yield new TextEncoder().encode(text)
  })()
}

/**
 * Require the durable projection of the accepted document.
 *
 * The unregistered key is a count and never a name; the registered key keeps the name its own
 * inapplicable refusal needs. This is the same projection the running plugin writes for a later
 * restart, so the restart cannot read an unknown key as a restriction.
 * @param text - the stored `policy_limits` document.
 */
function requirePersistedProjection(text) {
  if (text.includes(UNREGISTERED_KEY)) {
    throw new Error('policy probe: the store kept the unregistered key name')
  }
  if (!text.includes(`"key":"${REGISTERED_CONNECTOR_KEY}"`)) {
    throw new Error('policy probe: the store dropped the registered key by name')
  }
  if (!text.includes('"lossyTaints":false')) {
    throw new Error('policy probe: the stored taint set is unexpectedly lossy')
  }
  if (!text.includes('"unknownKeys":1')) {
    throw new Error('policy probe: the accepted document left no stored unknown-key count')
  }
}

/**
 * Read the store record once after the plugin's own disposal has settled its persist work.
 *
 * Disposing the production fiber waits for the limits owner's owned work, including the record
 * write adoption started; a single read then states the durable projection without polling. The
 * harness turn that follows is the replayed provider and uses no Claude route.
 * @param capture - the capture whose mounted production fiber owns the persist work.
 */
async function requirePersistedLimits(capture) {
  const production = capture.productionFiber
  if (production === undefined) throw new Error('policy probe: the production plugin fiber was not mounted')
  await production.dispose()
  requirePersistedProjection(await readFile(dshHomePath('plugins', 'subscriptions', 'claude-policy-limits.json'), 'utf8'))
}

/**
 * The capture this composition mounts: the recording capture, one exact managed-settings answer,
 * and the incident policy document behind the owner's own transport.
 * @returns the capture, its policy read counter, and its refused destination list.
 */
function createPolicyCapture() {
  const capture = createCapture()
  const reads = { policy: 0, org: 0 }
  capture.exact = async (url, init) => {
    const target = new URL(String(url))
    if (init?.method !== undefined && init.method !== 'GET') return undefined
    if (`${target.origin}${target.pathname}` !== SETTINGS_URL) return undefined
    return Response.json({
      uuid: 'synthetic-policy-settings',
      checksum: 'synthetic-policy-checksum',
      settings: {},
    })
  }
  capture.policyLimitsTransport = async (request) => {
    const target = new URL(String(request.url))
    if (request.method !== 'GET' || `${target.origin}${target.pathname}` !== POLICY_URL) {
      capture.refused.push(`policy_limits transport: ${request.method} ${request.url}`)
      throw new Error(`policy probe: the owner read no policy_limits destination it owns (${request.method} ${request.url})`)
    }
    reads.policy += 1
    return { status: 200, headers: { get: () => null }, body: bodyOf(POLICY_DOCUMENT) }
  }
  capture.orgPinTransport = async (request) => {
    reads.org += 1
    capture.refused.push(`organization transport: ${request.url}`)
    throw new Error('policy probe: the settings document states no organization pin')
  }
  return { capture, reads }
}

/**
 * Mount the reuse assembly and drive the two attempts on the session's first model-stream dispatch.
 *
 * A failed structural observation rejects the dispatch, so the Loader cannot settle it away: the
 * `requireRecordedAttempts` call is the same success contract the recording scenario uses.
 * @param ctx - composition context.
 * @param config - the real plugin's config, validated by the Loader against {@link Config}.
 */
export async function apply(ctx, config) {
  const { capture, reads } = createPolicyCapture()
  const session = {
    accessToken: 'synthetic-policy-access',
    refreshToken: 'synthetic-policy-refresh',
    expiresAt: Date.now() + 3_600_000,
    // Inference only: the maintenance owner's scope-missing branch starts no profile read.
    scopes: 'user:inference',
    // An organization subscription is eligible for both the settings and policy_limits reads.
    subscriptionType: 'team',
    accountUuid: ACCOUNT_UUID,
    deviceId: deriveClaudeDeviceId(`uuid:${ACCOUNT_UUID}`),
    emailAddress: 'synthetic-policy-account@example.invalid',
  }
  await createRecordingAssembly(capture, { session }).apply(ctx, config)
  let driven = false
  ctx.on('llm/stream', async function* (options, next) {
    if (!driven && options.sessionId !== undefined) {
      driven = true
      const observed = await driveRecordedAttempts(ctx, options.sessionId, ATTEMPTS, capture)
      requireRecordedAttempts(observed, ATTEMPTS)
      if (reads.policy !== 1) {
        throw new Error(`policy probe: the owner read the policy document ${reads.policy} times, expected exactly one`)
      }
      if (reads.org !== 0) {
        throw new Error(`policy probe: the organization validation ran ${reads.org} times for a document with no pin`)
      }
      await requirePersistedLimits(capture)
    }
    yield* next()
  })
}
