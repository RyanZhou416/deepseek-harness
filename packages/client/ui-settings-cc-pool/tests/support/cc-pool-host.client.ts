/**
 * A scripted Host for the CC subscription pool page's interaction specs.
 *
 * The fixture owns an in-memory settings document with revision fencing, the
 * catalogue rules the Host's config schema and catalogue resolver enforce, the
 * credential store the page writes, and the pool discovery the sync reads. It
 * answers the same Remote namespaces the browser consumes, so a spec drives the
 * real settings mirror and the real page against a synthetic Host instead of a
 * stubbed form or a real pool request.
 */

import Schema from '@deepseek-ai/schemastery'
import { CC_POOL_API_KEY_REF, CC_POOL_NS, CC_POOL_REASONING_LEVELS } from '../../src/client/contract.ts'

/** JSON-shaped settings value. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** One path-addressed edit, as the settings wire carries it. */
export type PathOp =
  | { op: 'set'; path: readonly string[]; value: Json }
  | { op: 'unset'; path: readonly string[] }

/** One profile entry the scripted Host serves: the stored user layer and the section it resolves. */
interface HostEntry {
  value: Json
  user?: Json
  revision: number
}

/** The built-in catalogue the Host applies when no override is stored. */
export const BUILT_IN_MODELS: Json[] = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxTokens: 128_000, defaultReasoning: 'medium' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 1_000_000, maxTokens: 128_000, defaultReasoning: 'medium' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextWindow: 1_000_000, maxTokens: 64_000, defaultReasoning: 'high' },
  { id: 'claude-mythos-5-1', name: 'Claude Mythos 5.1', contextWindow: 1_000_000, maxTokens: 64_000, defaultReasoning: 'high' },
]

/** The pool listing the scripted pool starts with: the built-in ids and names. */
export const POOL_LISTING: Json[] = BUILT_IN_MODELS.map((model) => {
  const entry = model as { id: string; name: string }
  return { id: entry.id, name: entry.name }
})

/** Settings namespace of an unrelated provider the page must leave alone. */
export const OTHER_NS = 'llm-pi-ai'

/** Default value of the unrelated provider entry. */
export const OTHER_VALUE: Json = { providers: { 'deepseek-official': { apiKeyEnv: 'DEEPSEEK_API_KEY' } } }

/** The entry schema the Host serializes for the pool section (schemastery wire envelope). */
const CC_POOL_SCHEMA = JSON.parse(JSON.stringify(Schema.object({
  models: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string().required(),
    contextWindow: Schema.number().required(),
    maxTokens: Schema.number().required(),
    defaultReasoning: Schema.union(CC_POOL_REASONING_LEVELS).required(),
  })).required(),
}).toJSON())) as Json

/** The unrelated provider's schema envelope; no page decodes it in these specs. */
const OTHER_SCHEMA = JSON.parse(JSON.stringify(Schema.object({ providers: Schema.any() }).toJSON())) as Json

/** One accepted write's answer, the view the settings client folds back. */
export interface MutateAnswer {
  ok: boolean
  value?: Json
  error?: { code: string; message: string }
}

/** One discovery answer, as the llm namespace carries it. */
export type DiscoveryAnswer =
  | { ok: true; value: Json[] }
  | { ok: false; error: { code: string; message: string } }

/** One discovery request the page sent, recorded verbatim. */
export interface DiscoveryRequest {
  /** Settings namespace the page asked about. */
  ns: string
  /** Route the page described. */
  request: Json
}

/** What the fixture scripts before the page mounts. */
export interface CcPoolHostOptions {
  /** Credential literal the store already holds, as a deployment-provided key would. */
  token?: string
  /** Models the pool lists; defaults to {@link POOL_LISTING}. */
  pool?: readonly Json[]
  /**
   * Catalogue the settings document already stores as the user layer. Omitted
   * serves the built-in catalogue with no override; a value here is what the
   * Host resolved from a profile the user edited outside the page.
   */
  models?: readonly Json[]
}

/** The scripted Host: document state plus the Remote faces the page calls. */
export interface CcPoolHost {
  /** Current stored value of the pool entry. */
  entry(ns?: string): Json
  /** Current revision of one entry. */
  revision(ns?: string): number
  /** Last credential literal stored through the credentials namespace. */
  storedToken(): string | undefined
  /** Replace the models the pool lists for the next discovery. */
  setPool(models: readonly Json[]): void
  /** Make every discovery answer fail with the given Host diagnostic. */
  refuseDiscovery(message: string): void
  /** Store a credential literal outside the page, as another surface would. */
  storeToken(value: string): void
  /** Every discovery request the page sent, in order. */
  discoveryRequests(): readonly DiscoveryRequest[]
  /** The settings namespace face (`remote.settings`). */
  readonly settings: {
    describe(): Promise<{ ok: true; value: Json }>
    mutate(ns: string, ops: readonly PathOp[], expectedRevision?: number): Promise<MutateAnswer>
  }
  /** The credentials namespace face (`remote.credentials`). */
  readonly credentials: {
    describe(refs: readonly string[]): Promise<{ ok: true; value: Json }>
    set(ref: string, value: string): Promise<{ ok: true; value: undefined }>
    unset(ref: string): Promise<{ ok: true; value: undefined }>
  }
  /** The llm namespace face (`remote.llm`): the pool's own model discovery. */
  readonly llm: {
    discoverModels(ns: string, request: Json): Promise<DiscoveryAnswer>
  }
}

/** Clone one value through the JSON the wire would carry. */
function clone<T extends Json | readonly Json[]>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Whether a pool value's catalogue satisfies the Host's catalogue rules. */
function catalogueValid(value: Json): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const models = value['models']
  if (models === undefined) return true
  if (!Array.isArray(models) || models.length === 0) return false
  const ids = new Set<string>()
  return models.every((model) => {
    if (typeof model !== 'object' || model === null || Array.isArray(model)) return false
    const entry = model as Record<string, Json>
    const id = entry['id']
    const name = entry['name']
    const context = entry['contextWindow']
    const max = entry['maxTokens']
    const level = entry['defaultReasoning']
    if (typeof id !== 'string' || id.length === 0 || ids.has(id)) return false
    ids.add(id)
    return typeof name === 'string' && name.length > 0
      && typeof context === 'number' && Number.isSafeInteger(context) && context > 0
      && typeof max === 'number' && Number.isSafeInteger(max) && max > 0
      && typeof level === 'string' && (CC_POOL_REASONING_LEVELS as readonly string[]).includes(level)
  })
}

/** Apply one write's path edits to the user layer and resolve the served section. */
function edit(user: Json | undefined, ops: readonly PathOp[]): { value: Json; user?: Json } {
  const record = user === undefined ? {} : clone(user) as Record<string, Json>
  for (const op of ops) {
    const head = op.path[0]
    if (op.path.length !== 1 || head === undefined) throw new Error(`scripted Host: unsupported path ${op.path.join('.')}`)
    if (op.op === 'unset') Reflect.deleteProperty(record, head)
    else record[head] = clone(op.value)
  }
  const override = Object.keys(record).length === 0 ? undefined : record
  // The Host schema declares a default for `models`, so an unset (or a section
  // that never carried one) resolves back to the built-in catalogue.
  return {
    value: { ...override ?? {}, models: override?.['models'] ?? clone(BUILT_IN_MODELS) },
    ...override === undefined ? {} : { user: override },
  }
}

/**
 * Create a scripted Host with the pool entry and one unrelated provider entry.
 * @param options - credential state and pool listing the spec stages before mount.
 * @returns the Host faces and document accessors.
 */
export function createCcPoolHost(options: CcPoolHostOptions = {}): CcPoolHost {
  const poolEntry: HostEntry = options.models === undefined
    ? { value: { models: clone(BUILT_IN_MODELS) }, revision: 0 }
    // A stored override resolves to itself, and its key presence is what marks
    // the catalogue overridden.
    : {
      value: { models: clone([...options.models]) },
      user: { models: clone([...options.models]) },
      revision: 0,
    }
  const entries = new Map<string, HostEntry>([
    [CC_POOL_NS, poolEntry],
    [OTHER_NS, { value: clone(OTHER_VALUE), revision: 0 }],
  ])
  let token = options.token
  let pool = [...clone(options.pool ?? POOL_LISTING)]
  let refusal: string | undefined
  const requests: DiscoveryRequest[] = []
  const entryOf = (ns: string = CC_POOL_NS): HostEntry => {
    const entry = entries.get(ns)
    if (entry === undefined) throw new Error(`scripted Host: no entry ${ns}`)
    return entry
  }
  // One namespace view, including the two layers a settings form distinguishes:
  // the composition base a reset returns to, and the raw user layer whose key
  // presence marks an overridden field.
  const viewOf = (ns: string, entry: HostEntry): Json => ({
    ns,
    schema: clone(ns === CC_POOL_NS ? CC_POOL_SCHEMA : OTHER_SCHEMA),
    value: clone(entry.value),
    ...ns === CC_POOL_NS ? { base: { models: clone(BUILT_IN_MODELS) } } : {},
    ...entry.user === undefined ? {} : { user: clone(entry.user) },
    applies: 'live',
    autoGenerate: false,
    secrets: [],
    revision: entry.revision,
  })
  return {
    entry: ns => clone(entryOf(ns).value),
    revision: ns => entryOf(ns).revision,
    storedToken: () => token,
    setPool: (models) => { pool = [...clone(models)] },
    refuseDiscovery: (message) => { refusal = message },
    storeToken: (value) => { token = value },
    discoveryRequests: () => [...requests],
    llm: {
      discoverModels: async (ns, request) => {
        requests.push({ ns, request })
        if (ns !== CC_POOL_NS) {
          return { ok: false, error: { code: 'llm/model-discovery-rejected', message: `no model discovery is registered for "${ns}"` } }
        }
        if (refusal !== undefined) {
          return { ok: false, error: { code: 'llm/model-discovery-rejected', message: refusal } }
        }
        // The Host's discovery resolves the pool credential per request, so a
        // missing token refuses instead of answering from the built-in list.
        if (token === undefined) {
          return { ok: false, error: { code: 'llm/model-discovery-rejected', message: 'llm-cc-pool: no credential for the pool route' } }
        }
        return { ok: true, value: clone(pool) }
      },
    },
    settings: {
      describe: async () => ({
        ok: true,
        value: {
          writable: true,
          hasDocument: true,
          namespaces: [...entries].map(([ns, entry]) => viewOf(ns, entry)),
        },
      }),
      mutate: async (ns, ops, expectedRevision) => {
        const entry = entries.get(ns)
        if (entry === undefined) {
          return { ok: false, error: { code: 'settings/rejected', message: `No configurable plugin entry "${ns}"` } }
        }
        if (expectedRevision !== undefined && expectedRevision !== entry.revision) {
          return { ok: false, error: { code: 'settings/conflict', message: `settings namespace "${ns}" changed` } }
        }
        const next = edit(entry.user, ops)
        if (!catalogueValid(next.value)) {
          return { ok: false, error: { code: 'settings/rejected', message: 'the catalogue cannot serve a request' } }
        }
        entry.value = next.value
        if (next.user === undefined) Reflect.deleteProperty(entry, 'user')
        else entry.user = next.user
        entry.revision += 1
        return { ok: true, value: viewOf(ns, entry) }
      },
    },
    credentials: {
      describe: async refs => ({
        ok: true,
        value: Object.fromEntries(refs.map(ref => [ref, {
          configured: ref === CC_POOL_API_KEY_REF && token !== undefined,
          ...token === undefined ? {} : { source: 'file' },
          writable: true,
        }])),
      }),
      set: async (ref, value) => {
        if (ref === CC_POOL_API_KEY_REF) token = value
        return { ok: true, value: undefined }
      },
      unset: async (ref) => {
        if (ref === CC_POOL_API_KEY_REF) token = undefined
        return { ok: true, value: undefined }
      },
    },
  }
}
