/**
 * Per-model defaults — the durable half of the Settings page's per-model
 * pickers and of the composer's Speed control.
 *
 * The file lives at `~/.dsh/plugins/subscriptions/model-defaults.json`
 * (mode 0600, atomic replace). Shape:
 * `{ "<provider>": { "<model id>": "<effort>" }, "speed": { "<provider>": { "<model id>": "fast" | "standard" } } }`.
 * The effort sections keep the original top-level layout, so a file written by
 * an earlier build still reads and an earlier build ignores the `speed` section
 * it does not know. An absent entry means "follow the provider's own default":
 * for effort the `Default` chip the model picker shows when the discovered
 * catalog advertises no default at all, for speed standard routing.
 *
 * Writes are single-process and atomic, but *not* as serialised as the rest
 * of the page: the Settings page disables only the row being saved, and the
 * composer's Speed control writes independently of it, so two saves can
 * overlap. One write chain serialises every writer, so no update is lost to a
 * read-modify-write race. Every read comes from the in-memory snapshot, so the
 * on-disk file only needs to survive a restart: a malformed file reads as
 * empty and is rewritten on the next save, never taking the plugin down with
 * it.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { PROVIDER_IDS, type ProviderId } from './auth/store.js'

/** One stored speed choice: standard routing or the provider's fast tier. */
export type SpeedTier = 'standard' | 'fast'

/** One model id → its configured default reasoning effort id. */
type ModelDefaultMap = Readonly<Record<string, string>>
/** One model id → its configured speed tier. */
type ModelSpeedMap = Readonly<Record<string, SpeedTier>>
/** Provider route → model defaults. */
type ModelDefaults = Readonly<Partial<Record<ProviderId, ModelDefaultMap>>>
/** Provider route → model speed tiers. */
type ModelSpeeds = Readonly<Partial<Record<ProviderId, ModelSpeedMap>>>

/**
 * The persisted document as one value: the per-provider effort sections plus
 * the speed section. Both are written together, because the file holds one
 * document and a save of either must not drop the other.
 */
interface DefaultsState {
  readonly efforts: ModelDefaults
  readonly speeds: ModelSpeeds
}

/** Top-level key of the speed section; never a provider id. */
const SPEED_SECTION = 'speed'
/** The two tier ids the store accepts. */
const SPEED_TIERS: readonly SpeedTier[] = ['standard', 'fast']

/** Absolute path of the defaults file. */
export function modelDefaultsFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'model-defaults.json')
}

const EMPTY: ModelDefaults = Object.freeze({})
const EMPTY_STATE: DefaultsState = Object.freeze({ efforts: EMPTY, speeds: Object.freeze({}) })
/** In-memory snapshot read by every consumer (adapters, RPC). */
let current: DefaultsState = EMPTY_STATE
/** One lazy load of the on-disk file (read once per process). */
let ready: Promise<void> | undefined
/** Last load failure, surfaced to callers that care; defaults stay empty. */
let loadError: unknown
/**
 * Serialises every write: the read-modify-write sequence must not interleave,
 * or a fast second save would compute its snapshot from the stale `current`
 * and silently drop the first update (the UI disables only the row being
 * saved, and the composer control saves independently, so overlaps are
 * reachable).
 */
let writeChain: Promise<void> = Promise.resolve()

/**
 * Validate one persisted provider section into a string→value map, or
 * undefined. Malformed *entries* are skipped, not the whole section: one bad
 * value (a hand edit losing its quotes) must not silently un-configure every
 * model in that provider. What was dropped is reported so the caller can
 * surface it instead of the loss disappearing.
 * @param value - the raw section.
 * @param provider - the route the section belongs to (for the report).
 * @param accept - whether one string value is a valid setting.
 * @param dropped - collector for entries the section had to skip.
 * @returns the validated section, or undefined when it holds nothing usable.
 */
function sanitizeSection<T extends string>(
  value: unknown,
  provider: ProviderId,
  accept: (entry: string) => entry is T,
  dropped: string[],
): Readonly<Record<string, T>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries: Record<string, T> = {}
  for (const [model, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' || !accept(entry)) {
      dropped.push(`${provider}/${model}`)
      continue
    }
    entries[model] = entry
  }
  if (Object.keys(entries).length === 0) return undefined
  return Object.freeze(entries)
}

/** Validate the raw document: only known providers, malformed sections dropped. */
function sanitizeDefaults(value: unknown): { state: DefaultsState; dropped: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { state: EMPTY_STATE, dropped: [] }
  }
  const record = value as Record<string, unknown>
  const dropped: string[] = []
  const efforts: Partial<Record<ProviderId, ModelDefaultMap>> = {}
  for (const provider of PROVIDER_IDS) {
    const section = sanitizeSection(record[provider], provider, (entry): entry is string => entry.length > 0, dropped)
    if (section !== undefined) efforts[provider] = section
  }
  const speeds: Partial<Record<ProviderId, ModelSpeedMap>> = {}
  const rawSpeeds = record[SPEED_SECTION]
  if (typeof rawSpeeds === 'object' && rawSpeeds !== null && !Array.isArray(rawSpeeds)) {
    const speedRecord = rawSpeeds as Record<string, unknown>
    for (const provider of PROVIDER_IDS) {
      const section = sanitizeSection(
        speedRecord[provider],
        provider,
        (entry): entry is SpeedTier => (SPEED_TIERS as readonly string[]).includes(entry),
        dropped,
      )
      if (section !== undefined) speeds[provider] = section
    }
  }
  return { state: Object.freeze({ efforts: Object.freeze(efforts), speeds: Object.freeze(speeds) }), dropped }
}

/** The document one state persists: effort sections plus the speed section. */
function documentOf(state: DefaultsState): Record<string, unknown> {
  const providers = Object.keys(state.speeds).length === 0
    ? {}
    : { [SPEED_SECTION]: state.speeds }
  return { ...state.efforts, ...providers }
}

/** Read and validate the on-disk file; a missing file reads as empty. */
async function loadFile(path: string): Promise<DefaultsState> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_STATE
    throw error
  }
  try {
    const { state, dropped } = sanitizeDefaults(JSON.parse(text))
    if (dropped.length > 0) loadError = new Error(
      `subscriptions model defaults: ${dropped.length} malformed entr${dropped.length === 1 ? 'y' : 'ies'} skipped (${dropped.join(', ')}); fix or delete the file`,
    )
    return state
  } catch {
    throw new Error(`subscriptions model defaults at ${path} are not valid JSON; fix or delete the file`)
  }
}

/** Resolve the module state once from disk; failures leave the defaults empty. */
async function ensureReady(): Promise<void> {
  ready ??= loadFile(modelDefaultsFilePath()).then(
    (loaded) => {
      current = loaded
      // loadFile itself sets loadError for skipped entries; do not clobber it.
    },
    (error) => {
      loadError = error
      current = EMPTY_STATE
    },
  )
  return ready
}

/** Persist a snapshot atomically with owner-only permissions. */
async function atomicPersist(defaults: Record<string, unknown>, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, JSON.stringify(defaults, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

let persistDefaults: (defaults: Record<string, unknown>, path: string) => Promise<void> = atomicPersist

/**
 * Clone one provider section, or undefined when nothing is configured for it.
 * The clone is prototype-less: model ids are provider-supplied catalog data
 * used as object keys, and consumers index the section directly (the RPC
 * catalog in index.ts does), so an id like `toString` would otherwise yield an
 * inherited *function* where a string is declared.
 */
function sectionOf<T>(sections: Readonly<Partial<Record<ProviderId, Readonly<Record<string, T>>>>>, provider: ProviderId): Readonly<Record<string, T>> | undefined {
  const section = sections[provider]
  if (section === undefined) return undefined
  return Object.assign(Object.create(null) as Record<string, T>, section)
}

/** Own-property read of one provider section: model ids are catalog data. */
function readSection<T>(sections: Readonly<Partial<Record<ProviderId, Readonly<Record<string, T>>>>>, provider: ProviderId, model: string): T | undefined {
  const section = sections[provider]
  if (section === undefined) return undefined
  // A plain index would inherit from Object.prototype for names like
  // `toString`, handing a *function* where a value is declared.
  return Object.prototype.hasOwnProperty.call(section, model) ? section[model] : undefined
}

/**
 * Replace one provider section, dropping it entirely when it becomes empty so
 * the document never carries an empty object.
 */
function withEntry<T extends string>(
  sections: Readonly<Partial<Record<ProviderId, Readonly<Record<string, T>>>>>,
  provider: ProviderId,
  model: string,
  value: T | undefined,
): Partial<Record<ProviderId, Readonly<Record<string, T>>>> {
  const section = { ...sectionOf(sections, provider) ?? {} }
  if (value === undefined) delete section[model]
  else section[model] = value
  const next = { ...sections }
  if (Object.keys(section).length === 0) delete next[provider]
  else next[provider] = Object.freeze(section)
  return next
}

/**
 * Serialise one read-modify-write of the document. The chain is shared by
 * every writer, so a composer speed write and a Settings effort save cannot
 * each compute their document from a state taken before the other landed.
 * The memory snapshot updates only after the atomic write succeeds, so a
 * failed write never leaves the live state ahead of the file.
 * @param mutate - computes the next state from the current one.
 * @returns the write's own outcome; a rejection reaches the caller.
 */
function enqueueWrite(mutate: (state: DefaultsState) => DefaultsState): Promise<void> {
  const run = writeChain.then(async () => {
    await ensureReady()
    const next = mutate(current)
    await persistDefaults(documentOf(next), modelDefaultsFilePath())
    current = next
  })
  // Keep the chain alive even when one write fails, or every later save would
  // be stuck behind the rejected promise. The caller has already received the
  // rejection through `run`.
  writeChain = run.catch(() => undefined)
  return run
}

/**
 * Ready the defaults store.
 * @internal Exported for tests; index.ts calls it at apply time so every
 * later synchronous read sees the persisted state.
 */
export async function loadModelDefaults(): Promise<void> {
  await ensureReady()
}

/**
 * The last load failure, or a warning about entries that were skipped while
 * loading; consumers only use it for diagnostics.
 */
export function modelDefaultsLoadError(): unknown {
  return loadError
}

/**
 * The configured default effort for one model, or undefined when none (the
 * picker then follows the provider's own default).
 * @internal Exported for the adapters' `defaultEffortOf` options.
 */
export function defaultEffortOf(provider: ProviderId, model: string): string | undefined {
  return readSection(current.efforts, provider, model)
}

/**
 * The configured speed tier for one model, or undefined when none (the
 * request then stays on standard routing). The RPC catalog also reads it, so
 * the Settings picker shows the tier stored for that exact model.
 * @internal Exported for index.ts's `speedFor` wiring and the editor catalog.
 */
export function defaultSpeedOf(provider: ProviderId, model: string): SpeedTier | undefined {
  return readSection(current.speeds, provider, model)
}

/** A detached snapshot of the effort sections for the RPC surface (render + diffing). */
export function modelDefaultsSnapshot(): ModelDefaults {
  const result: Partial<Record<ProviderId, ModelDefaultMap>> = {}
  for (const provider of PROVIDER_IDS) {
    const section = sectionOf(current.efforts, provider)
    if (section !== undefined) result[provider] = section
  }
  return Object.freeze(result)
}

/**
 * Set or clear one model's configured default effort, then persist.
 * @param provider - the subscription provider route.
 * @param model - the wire model id.
 * @param effort - the effort id, or undefined to clear the override.
 */
export function setDefaultEffort(
  provider: ProviderId,
  model: string,
  effort: string | undefined,
): Promise<void> {
  return enqueueWrite(state => ({
    efforts: Object.freeze(withEntry(state.efforts, provider, model, effort === undefined ? undefined : effort)),
    speeds: state.speeds,
  }))
}

/**
 * Store one model's speed tier, then persist. `standard` clears the entry:
 * standard routing is the absence of a stored tier, the way an absent effort
 * follows the provider.
 * @param provider - the subscription provider route.
 * @param model - the wire model id (never an account-qualified picker id).
 * @param tier - the chosen tier.
 */
export function setDefaultSpeed(
  provider: ProviderId,
  model: string,
  tier: SpeedTier,
): Promise<void> {
  return enqueueWrite(state => ({
    efforts: state.efforts,
    speeds: Object.freeze(withEntry(state.speeds, provider, model, tier === 'fast' ? tier : undefined)),
  }))
}

/**
 * Drop the in-memory state and the cached load. Test-only: lets a suite
 * unwind the lazy singleton before the next `loadModelDefaults`.
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export async function resetModelDefaultsForTests(): Promise<void> {
  current = EMPTY_STATE
  ready = undefined
  loadError = undefined
  writeChain = Promise.resolve()
  persistDefaults = atomicPersist
}

/**
 * Test-only seam: replace the atomic persistence so a failure happens on the
 * real write path. Proves a failed write propagates to the caller and does
 * not wedge the write chain (resetModelDefaultsForTests restores the real
 * implementation).
 * @internal Exported for tests only.
 */
export function overridePersistForTests(
  persist: (defaults: Record<string, unknown>, path: string) => Promise<void>,
): void {
  persistDefaults = persist
}
