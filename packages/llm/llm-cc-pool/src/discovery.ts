/**
 * Reading the pool's own model list for an explicit "sync models" action, and
 * asking it whether this member may use the CC wire parity wire.
 *
 * The route's catalogue is configuration, and nothing here writes it: a
 * listing is candidate metadata an editing surface may offer for adoption. A
 * failed read therefore fails typed instead of falling back to the built-in
 * catalogue, and an empty answer is an empty candidate list rather than a
 * replacement catalogue.
 *
 * The endpoint and credential are the route's fixed facts, not draft fields:
 * this namespace only ever interrogates the deployed pool, so a discovery
 * request's `baseURL`, `api`, and one-shot `apiKey` are not consulted. The
 * listing endpoint is the pool's own registry, reached with the member
 * credential as a bearer token; it is not the Anthropic Messages endpoint and
 * carries none of that protocol's headers. The capability probe uses the same
 * member authentication and answers only with the pool's proof or nothing,
 * because wire parity is enabled on positive proof and never inferred from an
 * absent answer. That proof is the exact `{protocol: 2, ccWireParity: 1, buildId}` triple
 * for the endpoint and pool build that answered: a reply without the build
 * cannot bind the capability, and a proof is never carried to another endpoint
 * or a different build.
 *
 * @module dsh-llm-cc-pool/discovery
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { BASE_URL } from './pool.ts'

/**
 * Settings namespace this plugin's discovery serves. It is the configuration
 * section the dedicated settings page edits, so a surface holding that
 * namespace needs no separate discovery registration.
 */
export const DISCOVERY_NAMESPACE = 'llm-cc-pool'

/** The pool endpoint that lists the models the deployment serves. */
export const MODELS_URL = `${BASE_URL}/v1/models`

/** The pool endpoint that advertises this member's wire capabilities. */
export const CAPABILITIES_URL = `${BASE_URL}/v1/capabilities`

/**
 * Security bound on one capability probe, in milliseconds. The probe decides
 * whether a request may carry wire parity, so an endpoint that stops answering
 * answering must prove nothing instead of holding that decision open. It bounds
 * a single probe; it is not a polling interval, because the plugin asks only at
 * profile load and on a member credential change.
 */
const CAPABILITY_PROBE_TIMEOUT_MS = 5_000

/**
 * The longest pool build identity this reader accepts, in characters. The pool's
 * own bound on the `MacPoolBuildId` it publishes is 128 printable ASCII
 * characters, and a `sha256:` build-manifest digest is 71; a longer value cannot
 * be that identity.
 */
const CAPABILITY_BUILD_MAX_CHARACTERS = 128

/**
 * The capability fields wire parity requires, as far as this reader trusts them.
 * `buildId` binds the capability to the pool build that answered; a reply without it
 * proves nothing, because the proof could not be scoped.
 */
interface PoolCapabilities {
  protocol?: unknown
  ccWireParity?: unknown
  buildId?: unknown
}

/**
 * The positive capability proof for one endpoint and pool build.
 *
 * The build identity is the pool's own stable value: the packaged build
 * manifest digest it reports as `buildId`, the same identity its `/health`
 * publishes. A proof describes the endpoint and build that answered, so a
 * caller uses it only while both still apply and drops it rather than carrying
 * it to another endpoint or a different build.
 */
export interface PoolCapabilityProof {
  /** The member endpoint that returned this proof. */
  readonly endpoint: string
  /** The pool build identity that returned this proof. */
  readonly buildId: string
}

/** One entry of the pool's listing, as far as this reader trusts it. */
interface PoolListingEntry {
  id?: unknown
  display_name?: unknown
}

/**
 * Read the pool's `data` array of `{ id, display_name }` records.
 *
 * Each usable row becomes exactly an id and a name: the pool discloses no
 * context window, output cap, or effort default, so none is invented — a
 * surface adopting a candidate still owes those capacities. Rows without a
 * usable id are skipped rather than failing the whole read, because one
 * malformed row must not deny the operator the rest of a working listing. A
 * reply with no `data` array is not a listing at all and fails typed.
 * @param body - the parsed JSON reply.
 * @param url - the listing endpoint, for the failure message.
 * @returns the advertised models in pool order, with the id as the fallback name.
 * @throws {LlmError} code `DISCOVERY_FAILED` when the reply carries no `data` array.
 */
function readPoolListing(body: unknown, url: string): LlmDiscoveredModel[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new LlmError(`${url} did not answer with a "data" array of models`, 'DISCOVERY_FAILED')
  }
  const models: LlmDiscoveredModel[] = []
  for (const raw of data as readonly unknown[]) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as PoolListingEntry
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    const name = typeof entry.display_name === 'string' && entry.display_name.length > 0
      ? entry.display_name
      : entry.id
    models.push({ id: entry.id, name })
  }
  return models
}

/**
 * Interrogate the deployed pool for its model catalogue.
 *
 * The credential is supplied by the caller because resolving it is the
 * plugin's route policy (credentials service, then launch environment); this
 * function performs only the read. A failure of the request, a refused status,
 * or an unreadable reply is a typed `DISCOVERY_FAILED`, and caller
 * cancellation is `ABORTED` whether it lands before or during the body read.
 * @param apiKey - the resolved `CC_POOL_API_KEY` member credential.
 * @param signal - caller cancellation.
 * @returns the advertised models in pool order.
 * @throws {LlmError} code `DISCOVERY_FAILED` or `ABORTED`.
 */
export async function discoverPoolModels(
  apiKey: string,
  signal?: AbortSignal,
): Promise<LlmDiscoveredModel[]> {
  let response: Response
  try {
    response = await fetch(MODELS_URL, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      ...signal === undefined ? {} : { signal },
    })
  } catch (error: unknown) {
    if (signal?.aborted) {
      throw new LlmError('pool model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${MODELS_URL}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403
      ? '; check the CC_POOL_API_KEY credential'
      : ''
    throw new LlmError(`${MODELS_URL} answered ${response.status}${hint}`, 'DISCOVERY_FAILED')
  }
  let text: string
  try {
    text = await response.text()
  } catch (error: unknown) {
    if (signal?.aborted) {
      throw new LlmError('pool model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`${MODELS_URL} did not answer with a readable body`, 'DISCOVERY_FAILED', { cause: error })
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${MODELS_URL} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readPoolListing(body, MODELS_URL)
}

/**
 * Read one usable pool build identity from a capability reply.
 *
 * The value must be non-empty printable ASCII of at most
 * {@link CAPABILITY_BUILD_MAX_CHARACTERS} characters: it is the pool's
 * `MacPoolBuildId`, which that endpoint restricts the same way before publishing
 * it. Anything else is not a build identity, so a reply carrying it cannot bind
 * the capability and proves nothing.
 * @param raw - the reply's `buildId` member.
 * @returns the build identity, or `undefined` when the reply does not carry a usable one.
 */
function readBuildId(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > CAPABILITY_BUILD_MAX_CHARACTERS) {
    return undefined
  }
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    if (code <= 0x20 || code >= 0x7f) return undefined
  }
  return raw
}

/**
 * Read one parsed capability reply as the proof wire parity requires.
 *
 * Only the exact triple the member contract states counts: protocol version 2,
 * `ccWireParity: 1`, and a usable pool `buildId`. Any other value, a missing
 * member, or a non-object reply is not a partial grant.
 * @param body - the parsed JSON reply.
 * @param endpoint - the endpoint that returned the reply; the proof is scoped to it.
 * @returns the proof scoped to that endpoint and the answering pool build, or
 *   `undefined` when the reply proves nothing.
 */
function readCapabilityProof(body: unknown, endpoint: string): PoolCapabilityProof | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const capabilities = body as PoolCapabilities
  if (capabilities.protocol !== 2 || capabilities.ccWireParity !== 1) return undefined
  const buildId = readBuildId(capabilities.buildId)
  if (buildId === undefined) return undefined
  return { endpoint, buildId }
}

/**
 * Ask the deployed pool whether this member may use the CC wire parity wire.
 *
 * A single authenticated read, bounded by {@link CAPABILITY_PROBE_TIMEOUT_MS}.
 * Only a `200` reply carrying `{protocol: 2, ccWireParity: 1, buildId}` answers with
 * a proof; every other outcome — a different status, an unreadable or malformed
 * body, a missing or unusable build identity, an unreachable endpoint, the
 * deadline, or caller cancellation — answers `undefined`, so the caller keeps
 * the route's current wire instead of enabling wire parity on an endpoint that never
 * proved it for a build. The probe is neither retried nor polled: the caller
 * owns its triggers, and each trigger asks exactly once.
 * @param apiKey - the resolved `CC_POOL_API_KEY` member credential.
 * @param signal - caller cancellation, for fiber disposal or a superseding probe.
 * @returns the proof for this endpoint and pool build, or `undefined` when the
 *   endpoint proved no wire parity.
 */
export async function probePoolCapabilities(
  apiKey: string,
  signal?: AbortSignal,
): Promise<PoolCapabilityProof | undefined> {
  const abort = signal === undefined
    ? AbortSignal.timeout(CAPABILITY_PROBE_TIMEOUT_MS)
    : AbortSignal.any([signal, AbortSignal.timeout(CAPABILITY_PROBE_TIMEOUT_MS)])
  let response: Response
  try {
    response = await fetch(CAPABILITIES_URL, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      signal: abort,
    })
  } catch {
    // Unreachable, timed out, or cancelled: the probe proves nothing.
    return undefined
  }
  // Exactly 200, not `ok`: other 2xx statuses (a 204, for example) carry no
  // capability body, so they cannot prove the wire.
  if (response.status !== 200) return undefined
  let text: string
  try {
    text = await response.text()
  } catch {
    // A body the connection dropped mid-read is not a capability answer.
    return undefined
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // A non-JSON reply is not a capability answer.
    return undefined
  }
  return readCapabilityProof(body, CAPABILITIES_URL)
}
