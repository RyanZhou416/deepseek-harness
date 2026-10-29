/**
 * Reading the pool's own model list for an explicit "sync models" action.
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
 * carries none of that protocol's headers.
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
