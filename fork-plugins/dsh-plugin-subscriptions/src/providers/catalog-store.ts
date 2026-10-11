/**
 * On-disk discovered-catalogue cache at
 * `~/.dsh/plugins/subscriptions/models.json` — the durable half of each
 * provider account's {@link ModelCatalogCache}.
 *
 * One entry per provider ACCOUNT, so a machine with several logins to the same
 * provider caches each account's own plan. The file carries a layout version:
 * rows written before accounts were keyed are DISCARDED rather than assigned to
 * some account, because ownership cannot be proven, and each account re-discovers
 * at its next explicit refresh. No credential, token or other secret is stored
 * here; the entry is only the advertised model metadata.
 *
 * Unlike the auth store, this file is a cache: a missing file reads as absent
 * and is rewritten by the next successful discovery. Loads are validated per
 * entry — a malformed entry passed through `resolveModel` would make the
 * harness's metadata validation throw on every call, which is worse than having
 * no fallback at all — and one unusable entry is dropped and reported without
 * discarding its siblings. Writes are serialized per file and applied by atomic
 * rename, so two accounts saving at once cannot lose each other's entry.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ReasoningEffortId, errorChain } from '@deepseek-ai/dsh-llm'
import type { ProviderId } from '../auth/store.js'
import type {
  CatalogFailure,
  CatalogPersistence,
  CatalogRecord,
  CatalogSnapshot,
  CatalogStoreFactory,
  DiscoveredModel,
} from './common.js'

/**
 * Absolute path of the catalog store file.
 * @returns `dshHomePath('plugins', 'subscriptions', 'models.json')`.
 */
function modelsFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'models.json')
}

/** Layout version written by this module; anything else is a pre-account file. */
const CATALOG_FILE_VERSION = 2

/** One account's validated record, keyed by account, for one provider. */
type AccountRecords = Record<string, CatalogRecord>

/** Every provider's validated records in the file. */
type StoredAccounts = Record<string, AccountRecords>

/** The file this module writes: layout version plus one entry per provider account. */
interface CatalogFile {
  version: typeof CATALOG_FILE_VERSION
  providers: Record<string, { accounts: Record<string, unknown> }>
}

/** Options for {@link catalogStore}. */
export interface CatalogStoreOptions {
  /** Store file path; defaults to {@link modelsFilePath}. */
  path?: string
  /** Warning sink for an unreadable, unparsable, or discarded cache entry. */
  onWarn?: (message: string) => void
}

/** Validate one persisted reasoning block, or undefined when malformed. */
function sanitizeReasoning(value: unknown): NonNullable<DiscoveredModel['reasoning']> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as { efforts?: unknown; defaultEffort?: unknown }
  if (!Array.isArray(raw.efforts) || raw.efforts.length === 0) return undefined
  const seen = new Set<string>()
  const efforts: NonNullable<DiscoveredModel['reasoning']>['efforts'] = []
  for (const entry of raw.efforts) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const effort = entry as Record<string, unknown>
    if (typeof effort.id !== 'string' || effort.id.length === 0
      || typeof effort.name !== 'string' || effort.name.length === 0
      || (effort.description !== undefined && typeof effort.description !== 'string')
      || seen.has(effort.id)) return undefined
    seen.add(effort.id)
    efforts.push({
      id: ReasoningEffortId(effort.id),
      name: effort.name,
      ...effort.description === undefined ? {} : { description: effort.description },
    })
  }
  if (raw.defaultEffort !== undefined
    && (typeof raw.defaultEffort !== 'string' || !seen.has(raw.defaultEffort))) return undefined
  return {
    efforts,
    ...raw.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(raw.defaultEffort as string) },
  }
}

/** Validate one persisted model, or undefined when malformed. */
function sanitizeModel(value: unknown): DiscoveredModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id.length === 0
    || typeof raw.name !== 'string' || raw.name.length === 0
    || (raw.description !== undefined && typeof raw.description !== 'string')
    || (raw.contextWindow !== undefined
      && (typeof raw.contextWindow !== 'number' || !Number.isInteger(raw.contextWindow) || raw.contextWindow <= 0))
    || (raw.maxContextWindow !== undefined
      && (typeof raw.maxContextWindow !== 'number' || !Number.isSafeInteger(raw.maxContextWindow) || raw.maxContextWindow <= 0))
    || (raw.maxOutputTokens !== undefined
      && (typeof raw.maxOutputTokens !== 'number' || !Number.isSafeInteger(raw.maxOutputTokens) || raw.maxOutputTokens <= 0))
    || (raw.priority !== undefined
      && (typeof raw.priority !== 'number' || !Number.isFinite(raw.priority)))) return undefined
  const reasoning = raw.reasoning === undefined ? undefined : sanitizeReasoning(raw.reasoning)
  if (raw.reasoning !== undefined && reasoning === undefined) return undefined
  const fastTier = raw.fastTier
  if (fastTier !== undefined && typeof fastTier !== 'boolean') return undefined
  const copilotWire = raw.copilotWire
  if (copilotWire !== undefined && copilotWire !== 'chat-completions' && copilotWire !== 'responses') {
    return undefined
  }
  const copilotResponses = raw.copilotResponses
  if (copilotResponses !== undefined && typeof copilotResponses !== 'boolean') return undefined
  const inputModalities = raw.inputModalities
  if (inputModalities !== undefined
    && (!Array.isArray(inputModalities) || inputModalities.length === 0
      || inputModalities.some(modality => modality !== 'text' && modality !== 'image'))) return undefined
  const cursorParameters = raw.cursorParameters === undefined
    ? undefined
    : sanitizeCursorParameters(raw.cursorParameters)
  if (raw.cursorParameters !== undefined && cursorParameters === undefined) return undefined
  const cursorDefaults = raw.cursorDefaults === undefined
    ? undefined
    : sanitizeCursorDefaults(raw.cursorDefaults)
  if (raw.cursorDefaults !== undefined && cursorDefaults === undefined) return undefined
  return {
    id: raw.id,
    name: raw.name,
    ...raw.description === undefined ? {} : { description: raw.description as string },
    ...raw.contextWindow === undefined ? {} : { contextWindow: raw.contextWindow as number },
    ...raw.maxContextWindow === undefined ? {} : { maxContextWindow: raw.maxContextWindow as number },
    ...raw.maxOutputTokens === undefined ? {} : { maxOutputTokens: raw.maxOutputTokens as number },
    ...raw.priority === undefined ? {} : { priority: raw.priority as number },
    ...reasoning === undefined ? {} : { reasoning },
    ...fastTier === undefined ? {} : { fastTier },
    ...copilotWire === undefined ? {} : { copilotWire: copilotWire as 'chat-completions' | 'responses' },
    ...copilotResponses === undefined ? {} : { copilotResponses },
    ...inputModalities === undefined ? {} : { inputModalities: [...inputModalities] as ('text' | 'image')[] },
    ...cursorParameters === undefined ? {} : { cursorParameters },
    ...cursorDefaults === undefined ? {} : { cursorDefaults },
  }
}

function sanitizeCursorParameters(value: unknown): DiscoveredModel['cursorParameters'] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) return undefined
  const parameters: NonNullable<DiscoveredModel['cursorParameters']> = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const raw = entry as Record<string, unknown>
    if (typeof raw.id !== 'string' || raw.id.length === 0 || !Array.isArray(raw.values) || raw.values.length === 0) {
      return undefined
    }
    const values: NonNullable<DiscoveredModel['cursorParameters']>[number]['values'] = []
    for (const item of raw.values) {
      if (typeof item !== 'object' || item === null) return undefined
      const valueRaw = item as Record<string, unknown>
      if (typeof valueRaw.value !== 'string' || valueRaw.value.length === 0) return undefined
      if (valueRaw.name !== undefined && typeof valueRaw.name !== 'string') return undefined
      values.push({
        value: valueRaw.value,
        ...typeof valueRaw.name === 'string' && valueRaw.name.length > 0 ? { name: valueRaw.name } : {},
      })
    }
    parameters.push({ id: raw.id, values })
  }
  return parameters
}

function sanitizeCursorDefaults(value: unknown): DiscoveredModel['cursorDefaults'] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) return undefined
  const defaults: NonNullable<DiscoveredModel['cursorDefaults']> = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const raw = entry as Record<string, unknown>
    if (typeof raw.id !== 'string' || raw.id.length === 0
      || typeof raw.value !== 'string' || raw.value.length === 0) return undefined
    defaults.push({ id: raw.id, value: raw.value })
  }
  return defaults
}

/**
 * Validate one persisted snapshot. Strict: any malformed field drops the
 * whole snapshot rather than repairing it — the next successful discovery
 * rewrites the entry anyway. An empty model list is valid and authoritative:
 * it records that the provider answered with no models for this account.
 * @param value - the raw per-account file entry.
 * @returns the validated snapshot, or undefined when unusable.
 */
export function sanitizeSnapshot(value: unknown): CatalogSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as { at?: unknown; models?: unknown }
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined
  if (!Array.isArray(raw.models)) return undefined
  const seen = new Set<string>()
  const models: DiscoveredModel[] = []
  for (const entry of raw.models) {
    const model = sanitizeModel(entry)
    if (model === undefined || seen.has(model.id)) return undefined
    seen.add(model.id)
    models.push(model)
  }
  return { at: raw.at, models }
}

/**
 * Validate one persisted failure cooldown, or undefined when it is unusable.
 * A hint, not data: an entry beside a valid snapshot keeps that snapshot even
 * when this half is malformed.
 */
function sanitizeFailure(value: unknown): CatalogFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as { notBefore?: unknown }
  if (typeof raw.notBefore !== 'number' || !Number.isFinite(raw.notBefore) || raw.notBefore <= 0) return undefined
  return { notBefore: raw.notBefore }
}

/**
 * Validate one persisted account entry. The snapshot half keeps the strict
 * rules of {@link sanitizeSnapshot}; the failure half is an optional hint beside
 * it, so an entry may legitimately hold either one or both.
 * @param value - the raw per-account file entry.
 * @returns the validated record, or undefined when the entry holds neither half.
 */
export function sanitizeRecord(value: unknown): CatalogRecord | undefined {
  const snapshot = sanitizeSnapshot(value)
  const failure = sanitizeFailure(
    typeof value === 'object' && value !== null ? (value as { failure?: unknown }).failure : undefined,
  )
  if (snapshot === undefined && failure === undefined) return undefined
  return {
    ...snapshot === undefined ? {} : { snapshot },
    ...failure === undefined ? {} : { failure },
  }
}

/**
 * The file form of one record: the snapshot's own fields, plus the failure hint
 * when there is one. A cold failure is written on its own — no `at` and no
 * `models` are invented for it.
 */
function serializeRecord(record: CatalogRecord): Record<string, unknown> {
  if (record.snapshot === undefined) return { ...record.failure === undefined ? {} : { failure: record.failure } }
  return {
    at: record.snapshot.at,
    models: record.snapshot.models,
    ...record.failure === undefined ? {} : { failure: record.failure },
  }
}

/** Whether a failed read means the file simply is not there yet. */
function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Read every validated account snapshot in the file.
 *
 * A file written before accounts were keyed reads as empty: those rows cannot be
 * attributed to an account, and serving one account's plan to another is worse
 * than re-discovering. One unusable account entry is dropped and reported on its
 * own; its siblings survive.
 * @param path - store file path.
 * @param onWarn - warning sink, when the caller wants diagnostics.
 * @returns the validated snapshots, keyed provider then account.
 */
async function readStore(path: string, onWarn?: (message: string) => void): Promise<StoredAccounts> {
  // One entry per account reads this file, so a file-level problem would
  // otherwise repeat verbatim for every account. Report each distinct
  // diagnostic once per path, and forget it as soon as a read is clean.
  let warned = false
  const warn = (message: string): void => {
    if (onWarn === undefined) return
    warned = true
    const already = reportedDiagnostics.get(path)
    if (already?.has(message) === true) return
    if (already === undefined) reportedDiagnostics.set(path, new Set([message]))
    else already.add(message)
    onWarn(message)
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      warn(`models.json could not be read (${errorChain(error)}); its cached catalogues are ignored`)
    }
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    warn('models.json is not valid JSON; its cached catalogues are ignored until the next refresh')
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warn('models.json does not hold an object; its cached catalogues are ignored until the next refresh')
    return {}
  }
  const record = parsed as Record<string, unknown>
  if (record.version !== CATALOG_FILE_VERSION) {
    if (Object.keys(record).length > 0) {
      warn(
        'models.json uses a pre-account layout; its cached catalogues were discarded rather than '
        + 'assigned to an account, and each account re-discovers at its next refresh',
      )
    }
    return {}
  }
  const providers = record.providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
    warn('models.json has no readable provider map; its cached catalogues are ignored')
    return {}
  }
  const store: StoredAccounts = {}
  for (const [provider, value] of Object.entries(providers as Record<string, unknown>)) {
    const accounts = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as { accounts?: unknown }).accounts
      : undefined
    if (typeof accounts !== 'object' || accounts === null || Array.isArray(accounts)) {
      warn(`cached catalogues for "${provider}" are unusable and were dropped`)
      continue
    }
    const kept: AccountRecords = {}
    for (const [account, entry] of Object.entries(accounts as Record<string, unknown>)) {
      const record = sanitizeRecord(entry)
      if (record === undefined) {
        warn(
          `the cached catalogue for "${provider}/${account}" is unusable and was dropped; `
          + 'that account re-discovers at its next refresh',
        )
        continue
      }
      kept[account] = record
    }
    if (Object.keys(kept).length > 0) store[provider] = kept
  }
  if (!warned) reportedDiagnostics.delete(path)
  return store
}

/** Persist the whole file atomically (tmp file + rename). */
async function writeStore(store: StoredAccounts, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  const providers: CatalogFile['providers'] = {}
  for (const [provider, records] of Object.entries(store)) {
    const accounts: Record<string, unknown> = {}
    for (const [account, record] of Object.entries(records)) accounts[account] = serializeRecord(record)
    providers[provider] = { accounts }
  }
  const file: CatalogFile = { version: CATALOG_FILE_VERSION, providers }
  try {
    await writeFile(tmp, JSON.stringify(file, null, 2))
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** One file's pending writes, so two accounts cannot lose each other's entry. */
const writeQueues = new Map<string, Promise<unknown>>()

/**
 * Diagnostics already reported per store path. Several account caches read the
 * same file, and each distinct problem is a statement about the file, so it is
 * reported once until a read of that file comes back clean.
 */
const reportedDiagnostics = new Map<string, Set<string>>()

/**
 * Run one read-modify-write against a store file with no other write of this
 * process interleaved. The chain is keyed by path, so two accounts (or two
 * providers) saving at once each read the other's committed result.
 * @param path - store file path.
 * @param work - the whole read-modify-write.
 * @returns the work's own result.
 */
function serialized<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve()
  const next = previous.then(work, work)
  // The queue entry never rejects: a failed write must not poison the next one.
  writeQueues.set(path, next.then(() => undefined, () => undefined))
  return next
}

/**
 * Build the durable half of a provider's catalogue cache over the shared
 * models.json file. The returned factory keys one {@link CatalogPersistence} per
 * ACCOUNT, so every login keeps its own discovered plan, and carries the
 * provider-wide operations a logout needs when no cache was ever built for the
 * account it drops.
 * @param provider - the provider route keying the file entries.
 * @param options - store path and warning sink.
 * @returns a per-account persistence factory.
 */
export function catalogStore(provider: ProviderId, options: CatalogStoreOptions = {}): CatalogStoreFactory {
  const path = options.path ?? modelsFilePath()
  const onWarn = options.onWarn
  const factory: CatalogStoreFactory = (account: string): CatalogPersistence => ({
    async load() {
      return (await readStore(path, onWarn))[provider]?.[account]
    },
    async save(snapshot) {
      await serialized(path, async () => {
        const store = await readStore(path, onWarn)
        const records = store[provider] ?? {}
        // The answer supersedes the failure hint: this request was answered.
        records[account] = { snapshot }
        store[provider] = records
        await writeStore(store, path)
      })
    },
    async saveFailure(failure) {
      await serialized(path, async () => {
        const store = await readStore(path, onWarn)
        const records = store[provider] ?? {}
        records[account] = { ...records[account], failure }
        store[provider] = records
        await writeStore(store, path)
      })
    },
    async clear() {
      await serialized(path, async () => {
        const store = await readStore(path, onWarn)
        const records = store[provider]
        if (records === undefined || records[account] === undefined) return
        delete records[account]
        if (Object.keys(records).length === 0) delete store[provider]
        await writeStore(store, path)
      })
    },
  })
  // Read-only: an account whose cache was never built still has a persisted
  // entry, and only the file knows which accounts those are.
  factory.accounts = async () => Object.keys((await readStore(path, onWarn))[provider] ?? {})
  factory.clearAll = async () => {
    await serialized(path, async () => {
      const store = await readStore(path, onWarn)
      if (store[provider] === undefined) return
      delete store[provider]
      await writeStore(store, path)
    })
  }
  return factory
}
