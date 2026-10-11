/**
 * Durable per-account usage observations: the windows the pool last saw, when
 * each was seen, and the cooldown of a failed read.
 *
 * The file is a cache, not a source of truth: a restart loads it and serves it
 * as stale, and nothing here ever performs a network read. Writes are coalesced,
 * serialized, and land through a temporary file plus rename, so a reader never
 * observes a partial record.
 *
 * A write is a read-modify-write of the file's current contents under the shared
 * store lock: several harness instances share one cache path, and one instance
 * saving its own account must not erase records another instance owns. Only the
 * keys this store changed are applied, so an untouched account's record is never
 * rewritten from a stale in-memory copy.
 *
 * No credential, token, request id or provider message is stored — only the
 * normalized window readings and a safe failure classification.
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withStoreLock } from '../auth/store-lock.js'
import type { ProviderId } from '../auth/store.js'
import type { UsageFailureReason } from './common.js'

/** One window's durable reading, with the instant it was observed. */
export interface PersistedUsageWindow {
  /** Window kind: `session` for the short rolling window, `weekly` for the 7-day one. */
  kind: 'session' | 'weekly' | 'other'
  /** Model scope for model-specific windows (e.g. `Opus`), when the provider named one. */
  scope?: string
  /** Percent of the window consumed (0–100) as of {@link observedAt}. */
  usedPercent: number
  /** Epoch milliseconds at which the window resets, when the provider disclosed it. */
  resetsAt?: number
  /** Epoch milliseconds this reading was observed. */
  observedAt: number
}

/** A failed read whose retry is suppressed until {@link retryAt}. */
export interface PersistedUsageFailure {
  /** Epoch milliseconds the read failed. */
  at: number
  /** Epoch milliseconds the failure stops suppressing upstream reads. */
  retryAt: number
  /** Safe classification; never a provider message or token. */
  reason: UsageFailureReason
}

/** One account's durable usage state. */
export interface PersistedUsageAccount {
  /** The account's provider route. */
  provider: ProviderId
  /** The canonical account key the readings belong to. */
  account: string
  /** Epoch milliseconds of the newest observation of any window, when one exists. */
  observedAt?: number
  /**
   * Epoch milliseconds the usage endpoint last answered this account, whether or
   * not it reported a window. It throttles the next read of an unknown reading.
   */
  checkedAt?: number
  /** Plan name the usage endpoint last reported, when it reported one. */
  plan?: string
  /** Per-window readings, each carrying its own observation time. */
  windows: PersistedUsageWindow[]
  /** The read failure still cooling down, when the last read failed. */
  failure?: PersistedUsageFailure
}

/**
 * Persistence seam for usage observations. Implementations are optional: a
 * tracker without one keeps the same state in memory for the plugin's lifetime.
 */
export interface UsageStore {
  /** Every record the store was loaded with, read once when it was created. */
  records(): readonly PersistedUsageAccount[]
  /** Replace one account's record, scheduling a coalesced serial write. */
  save(record: PersistedUsageAccount): void
  /** Drop one account's record, scheduling a coalesced serial write. */
  remove(provider: ProviderId, account: string): void
  /** Resolve once every scheduled write has been attempted. */
  flush(): Promise<void>
  /** Flush, then refuse further writes. */
  dispose(): Promise<void>
}

/** What one decoded store file yielded, including what could not be read. */
export interface UsageFileRead {
  /** The records this build can use. */
  records: PersistedUsageAccount[]
  /** Entries the file listed that this build could not read. */
  dropped: number
  /** True when the file declared a format version this build does not read. */
  unsupportedVersion: boolean
}

/** File format version; an unrecognized version is discarded rather than migrated. */
const FORMAT_VERSION = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A finite nonnegative number, or undefined when the value is not one. */
function nonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** A finite number, or undefined when the value is not one. */
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A non-empty string, or undefined when the value is not one. */
function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The provider routes this plugin persists usage for. */
const PROVIDERS: readonly ProviderId[] = [
  'claude', 'codex', 'grok', 'copilot', 'antigravity', 'cursor',
]

function providerOf(value: unknown): ProviderId | undefined {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value)
    ? value as ProviderId
    : undefined
}

function failureOf(value: unknown): PersistedUsageFailure | undefined {
  if (!isRecord(value)) return undefined
  const at = nonnegative(value.at)
  const retryAt = nonnegative(value.retryAt)
  const reason = failureReasonOf(value.reason)
  if (at === undefined || retryAt === undefined || reason === undefined) return undefined
  return { at, retryAt, reason }
}

function failureReasonOf(value: unknown): UsageFailureReason | undefined {
  switch (value) {
    case 'rate_limited':
    case 'unauthorized':
    case 'unreachable':
    case 'invalid_response':
    case 'unknown':
      return value
    default:
      return undefined
  }
}

function windowsOf(value: unknown): PersistedUsageWindow[] | undefined {
  if (!Array.isArray(value)) return undefined
  const windows: PersistedUsageWindow[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return undefined
    const kind = entry.kind === 'session' || entry.kind === 'weekly' || entry.kind === 'other'
      ? entry.kind
      : undefined
    const usedPercent = finite(entry.usedPercent)
    const observedAt = nonnegative(entry.observedAt)
    if (kind === undefined || usedPercent === undefined || observedAt === undefined) return undefined
    const scope = nonempty(entry.scope)
    const resetsAt = finite(entry.resetsAt)
    windows.push({
      kind,
      ...scope === undefined ? {} : { scope },
      usedPercent,
      ...resetsAt === undefined ? {} : { resetsAt },
      observedAt,
    })
  }
  return windows
}

/**
 * One account's record from an untrusted durable value. A record missing a
 * required reading is dropped whole rather than partially trusted: a window
 * with an invented percentage would steer routing with data no provider sent.
 * @param value - the parsed value to normalize.
 * @returns the record, or undefined when the value is not a complete record.
 */
export function normalizeUsageAccount(value: unknown): PersistedUsageAccount | undefined {
  if (!isRecord(value)) return undefined
  const provider = providerOf(value.provider)
  const account = nonempty(value.account)
  const windows = windowsOf(value.windows)
  if (provider === undefined || account === undefined || windows === undefined) return undefined
  const observedAt = nonnegative(value.observedAt)
  const checkedAt = nonnegative(value.checkedAt)
  const plan = nonempty(value.plan)
  const failure = failureOf(value.failure)
  return {
    provider,
    account,
    ...observedAt === undefined ? {} : { observedAt },
    ...checkedAt === undefined ? {} : { checkedAt },
    ...plan === undefined ? {} : { plan },
    windows,
    ...failure === undefined ? {} : { failure },
  }
}

/**
 * Every intact record in one decoded store file. Entries this version cannot
 * read are dropped, and only a value that is not an object at all — or that
 * declares another format version — discards the file.
 * @param value - the parsed file contents.
 * @returns the retained records plus what could not be read.
 */
export function readUsageRecords(value: unknown): UsageFileRead {
  if (!isRecord(value)) return { records: [], dropped: 0, unsupportedVersion: false }
  if (value.version !== FORMAT_VERSION) {
    return { records: [], dropped: 0, unsupportedVersion: true }
  }
  if (!Array.isArray(value.accounts)) return { records: [], dropped: 0, unsupportedVersion: false }
  const records: PersistedUsageAccount[] = []
  let dropped = 0
  for (const entry of value.accounts) {
    const record = normalizeUsageAccount(entry)
    if (record === undefined) dropped += 1
    else records.push(record)
  }
  return { records, dropped, unsupportedVersion: false }
}

/** The `provider/account` key every record is indexed by. */
function accountKey(provider: ProviderId, account: string): string {
  return `${provider}/${account}`
}

/** One file's decoded contents, or why it could not be decoded. */
type DecodedUsageFile =
  | { kind: 'missing' }
  | { kind: 'content'; value: unknown }
  | { kind: 'corrupt' }
  | { kind: 'unreadable'; code: string }

/** Decode one file's text, reporting why nothing could be read. */
function decodeUsageText(text: string): DecodedUsageFile {
  try {
    const parsed: unknown = JSON.parse(text)
    return { kind: 'content', value: parsed }
  } catch (error: unknown) {
    // A corrupt cache is discardable state: the next observation rewrites it.
    if (error instanceof SyntaxError) return { kind: 'corrupt' }
    return { kind: 'unreadable', code: errorCode(error) }
  }
}

/** Read and decode the cache file synchronously, for the one load at construction. */
function readUsageFile(file: string): DecodedUsageFile {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error: unknown) {
    // A missing cache file is the ordinary first-run state, not a failure.
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', code: errorCode(error) }
  }
  return decodeUsageText(text)
}

/** Read and decode the cache file, for the read half of a locked read-modify-write. */
async function readUsageFileAsync(file: string): Promise<DecodedUsageFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', code: errorCode(error) }
  }
  return decodeUsageText(text)
}

/** A filesystem error's errno code, or `unknown`; never the raw message. */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return 'unknown'
}

/**
 * A JSON-file-backed {@link UsageStore}.
 *
 * The file is read synchronously once, at construction, so a restart serves the
 * last known readings without an upstream read. Later writes coalesce onto one
 * in-flight drain, and each drain re-reads the file under the shared store lock,
 * applies only the keys this store changed, and replaces the file atomically —
 * so a writer that knows nothing of another instance's account cannot erase it.
 * A failed write keeps its keys queued and leaves the previous file intact; the
 * drain reports the failure once and stops rather than retrying in a loop.
 */
class FileUsageStore implements UsageStore {
  private readonly loaded = new Map<string, PersistedUsageAccount>()
  /** Keys this store changed and has not landed yet; `null` is a deletion. */
  private readonly pending = new Map<string, PersistedUsageAccount | null>()
  /** The temporary file an atomic write goes through; one per process. */
  private readonly temporary: string
  private drain: Promise<void> | undefined
  private closed = false
  /** Set when the file belongs to a format this build must not overwrite. */
  private writeBlocked = false

  /**
   * @param file - absolute path of the usage cache file.
   * @param onWarn - receives a safe diagnostic when the file cannot be read or written.
   */
  constructor(
    private readonly file: string,
    private readonly onWarn: (message: string) => void = () => {},
  ) {
    this.temporary = `${file}.${String(process.pid)}.tmp`
    const read = readUsageFile(file)
    if (read.kind === 'unreadable') {
      this.onWarn(`subscriptions usage cache: cannot read ${file} (${read.code}); starting with no stored readings`)
      return
    }
    if (read.kind === 'corrupt') {
      this.onWarn(`subscriptions usage cache: ${file} is not valid JSON; starting with no stored readings`)
      return
    }
    if (read.kind === 'missing') return
    const decoded = readUsageRecords(read.value)
    if (decoded.unsupportedVersion) {
      this.onWarn(`subscriptions usage cache: ${file} declares a format this build does not read; starting with no stored readings`)
      return
    }
    if (decoded.dropped > 0) {
      this.onWarn(`subscriptions usage cache: dropped ${decoded.dropped} unreadable account record(s) from ${file}`)
    }
    for (const record of decoded.records) {
      this.loaded.set(accountKey(record.provider, record.account), record)
    }
  }

  /** @returns every record the store was loaded with, in insertion order. */
  records(): readonly PersistedUsageAccount[] {
    return [...this.loaded.values()]
  }

  /**
   * @param record - the account record to retain and persist.
   */
  save(record: PersistedUsageAccount): void {
    if (this.closed || this.writeBlocked) return
    this.pending.set(accountKey(record.provider, record.account), record)
    this.schedule()
  }

  /**
   * @param provider - the account's provider route.
   * @param account - the canonical account key.
   */
  remove(provider: ProviderId, account: string): void {
    if (this.closed || this.writeBlocked) return
    this.pending.set(accountKey(provider, account), null)
    this.schedule()
  }

  /**
   * @returns a promise resolved once every scheduled write has been attempted. A
   *   failed write is reported and leaves its keys queued rather than holding
   *   this promise open.
   */
  async flush(): Promise<void> {
    while (this.drain !== undefined) await this.drain
  }

  /** @returns a promise resolved once the queued writes were attempted and writes are refused. */
  async dispose(): Promise<void> {
    await this.flush()
    this.closed = true
  }

  /** Mark the pending keys dirty and ensure exactly one drain is running. */
  private schedule(): void {
    if (this.drain !== undefined || this.pending.size === 0) return
    // The drain body must run after this assignment: a synchronous body would
    // clear the in-flight marker before it was ever set, and {@link flush} would
    // then await a promise that never goes away.
    const drain = this.drainOnce().finally(() => {
      if (this.drain === drain) this.drain = undefined
    })
    this.drain = drain
  }

  /**
   * Land the pending keys, one attempt per pass. A pass that fails leaves its
   * keys queued and returns, so a persistently unwritable file reports once per
   * drain instead of spinning, and a later save or flush tries again.
   */
  private async drainOnce(): Promise<void> {
    while (this.pending.size > 0 && !this.closed) {
      const batch = new Map(this.pending)
      if (!await this.writeBatch(batch)) return
      for (const [key, value] of batch) {
        if (this.pending.get(key) === value) this.pending.delete(key)
      }
    }
  }

  /** Read the file under the lock, apply this batch, and write it back atomically. */
  private async writeBatch(batch: ReadonlyMap<string, PersistedUsageAccount | null>): Promise<boolean> {
    try {
      await withStoreLock(this.file, async () => {
        const current = await this.currentRecords()
        for (const [key, value] of batch) {
          if (value === null) current.delete(key)
          else current.set(key, value)
        }
        await writeUsageFile(this.file, this.temporary, [...current.values()])
      })
      return true
    } catch (error: unknown) {
      // The cache is disposable state: a write failure costs a re-read after the
      // next restart, and must never fail a request or a teardown.
      this.onWarn(`subscriptions usage cache: cannot write ${this.file} (${errorCode(error)}); readings stay in memory`)
      return false
    }
  }

  /** The records currently on disk; an unreadable or foreign file reads as empty. */
  private async currentRecords(): Promise<Map<string, PersistedUsageAccount>> {
    const read = await readUsageFileAsync(this.file)
    if (read.kind !== 'content') return new Map()
    const decoded = readUsageRecords(read.value)
    if (decoded.unsupportedVersion) {
      // Another build owns this file. Overwriting it would destroy data this
      // build cannot read, so this store stops writing rather than clobbering it.
      this.writeBlocked = true
      this.pending.clear()
      this.onWarn(`subscriptions usage cache: ${this.file} declares a format this build does not read; not overwriting it`)
      return new Map()
    }
    return new Map(decoded.records.map(record => [accountKey(record.provider, record.account), record]))
  }
}

/** Serialize the records and replace the cache file atomically. */
async function writeUsageFile(
  file: string,
  temporary: string,
  records: readonly PersistedUsageAccount[],
): Promise<void> {
  const body = JSON.stringify({ version: FORMAT_VERSION, accounts: records })
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, file)
  } catch (error: unknown) {
    // The rename never happened, so the previous file is still the valid one; a
    // partial temporary is cleaned up so it cannot be mistaken for a cache.
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Create the plugin's durable usage cache.
 * @param options - the cache file path and its warning sink.
 * @param options.file - absolute path of the usage cache file.
 * @param options.onWarn - receives a safe diagnostic when the file cannot be read or written.
 * @returns the store, loaded from disk when that file holds usable records.
 */
export function createFileUsageStore(options: { file: string; onWarn?: (message: string) => void }): UsageStore {
  return new FileUsageStore(options.file, options.onWarn)
}
