/**
 * One opened JSON unit in `per-record` layout: the unit is a directory at
 * `dir`, holding one document per record under `<dir>/<table>/<key>.json`
 * plus `global.json` for the global slot. The directory is the state — this
 * unit holds NO in-memory state of its own: `loadAll` re-reads the tree, each
 * put or delete touches one durable document, and a batch delete renames its
 * documents out of the readable set before unlinking them. The domain layer owns the live
 * in-memory tables (seeded by the open-time `loadAll`) and serializes writes
 * through its write chain. A rejected write leaves domain memory unchanged;
 * a failed deletion restores its staged documents or quarantines the unit
 * with `unknown-state` when restoration cannot be established.
 *
 * Per-record contract: a record document that is malformed or stamped with a
 * version outside the accepted set (the descriptor's current version plus
 * its `compatibleVersions`) reads as an absent record — one bad or stale
 * file never bricks the whole unit, and an unaccepted version stamp discards
 * the record instead of migrating it. Record keys become path segments, so
 * they must be path-safe (`[a-zA-Z0-9_-]+`); an unsafe key rejects at write.
 *
 * Legacy bootstrap: when the new tree has no declared table directory or
 * global document, a whole-unit file `<root>/<name>.json` seeds
 * per-record documents, provided its stored unit version is in the accepted
 * set — a legacy file stamped with any other version is left alone and reads
 * as the empty unit. An existing declared table directory, even when empty,
 * or a declared global document suppresses the bootstrap for the whole unit.
 * The legacy file is never changed or deleted.
 * @module @deepseek-ai/dsh-storage-json/src/per-record-unit
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Dirent } from 'node:fs'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvRecordReader, KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { fsyncDirectory, writeAtomic } from './atomic.ts'
import { parseRecord, serializeRecord } from './format.ts'
import type { UnitState } from './format.ts'

/** Keys become path segments in this layout; this set is path-safe on every OS. */
const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/

/**
 * Record documents one table load keeps open at once. Unbounded fan-out over a
 * large table exhausts the process descriptor table (EMFILE near 8192 on
 * Windows) and fails unrelated file opens elsewhere in the process.
 */
const RECORD_LOAD_CONCURRENCY = 64

/**
 * Open one `per-record`-layout unit under `root`: the unit directory is
 * `<root>/<name>/`. Loads lazily on the first `loadAll` — this unit holds no
 * state, so opening touches nothing on the medium.
 * @param descriptor - Static identity and shape of the unit.
 * @param root - Absolute backend root directory.
 * @param onClose - Backend callback releasing the unit's open-slot.
 * @returns the opened unit.
 */

export async function openPerRecordUnit(
  descriptor: KvUnitDescriptor,
  root: string,
  onClose: () => void,
): Promise<KvUnit> {
  return new PerRecordJsonUnit(descriptor, join(root, descriptor.name), onClose)
}

/** The unit's readable tree without record values: exactly what a lazy open costs. */
interface PerRecordTree {
  /** Whether the current layout left any trace (a declared table directory or the global document). */
  found: boolean
  /** Declared table → readable record keys, in directory order. */
  tables: Map<string, string[]>
  /** Parsed global value; `null` when never written, not declared, or unreadable. */
  global: unknown
}

/**
 * Read every record document under the unit directory: each declared table's
 * `<key>.json` files plus `global.json`. A missing directory is the empty
 * unit (materialization defers to the first write); a foreign document
 * (missing, malformed, or stamped with an unaccepted version) reads as an absent
 * record, per the per-record contract.
 * @param descriptor - Static identity and shape of the unit.
 * @param dir - Absolute unit directory path.
 * @returns the authoritative state reconstructed from the tree.
 */
async function loadPerRecordState(descriptor: KvUnitDescriptor, dir: string): Promise<UnitState> {
  const versions = acceptedStamps(descriptor)
  let tree = await readTree(descriptor, dir)
  if (!tree.found) {
    await bootstrapLegacyUnit(descriptor, dir)
    tree = await readTree(descriptor, dir)
  }
  const state: UnitState = { version: descriptor.version, global: tree.global, tables: new Map() }
  for (const [table, keys] of tree.tables) {
    const records = new Map<string, unknown>()
    await loadTableRecords(records, versions, join(dir, table), keys)
    state.tables.set(table, records)
  }
  return state
}

/**
 * Enumerate the unit's readable tree without reading record documents. A
 * missing directory is the empty unit.
 * @param descriptor - Static identity and shape of the unit.
 * @param dir - Absolute unit directory path.
 * @returns the tree's presence, table key lists, and global slot.
 */
async function readTree(descriptor: KvUnitDescriptor, dir: string): Promise<PerRecordTree> {
  const versions = acceptedStamps(descriptor)
  const tree: PerRecordTree = {
    found: false,
    tables: new Map(descriptor.tables.map(table => [table, []])),
    global: null,
  }
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return tree
  }
  for (const entry of entries) {
    if (entry.isDirectory() && tree.tables.has(entry.name)) {
      tree.found = true
      tree.tables.set(entry.name, await listTableKeys(join(dir, entry.name)))
      continue
    }
    if (entry.name === 'global.json' && descriptor.hasGlobal) {
      tree.found = true
      const global = await readRecord(join(dir, entry.name), versions)
      if (global !== undefined) tree.global = global
    }
  }
  return tree
}

/**
 * List one table directory's readable record keys: `<key>.json` documents with
 * a path-safe key. A missing directory lists nothing (an unreadable one still
 * propagates).
 * @param dir - Absolute table directory path.
 * @returns the record keys in directory order.
 */
async function listTableKeys(dir: string): Promise<string[]> {
  const files = await readdir(dir, { withFileTypes: true })
  const keys: string[] = []
  for (const file of files) {
    if (!file.name.endsWith('.json')) continue
    const key = file.name.slice(0, -'.json'.length)
    if (SAFE_KEY_RE.test(key)) keys.push(key)
  }
  return keys
}

/** The version stamps this unit reads as its own: current plus declared compatible versions. */
function acceptedStamps(descriptor: KvUnitDescriptor): readonly number[] {
  return [descriptor.version, ...descriptor.compatibleVersions ?? []]
}


/**
 * Bootstrap an unmaterialized per-record tree from a legacy whole-unit file
 * (`<root>/<name>.json`, the pre-per-record layout). Every declared-table
 * record is copied into a current-version document, while the legacy file is
 * retained unchanged. A missing, foreign (another unit's name), malformed,
 * or non-unit legacy file is left alone, and so is one whose stored unit
 * version is outside the accepted set — migrating records the owner never
 * vouched for would stamp them with the current version and turn a
 * discardable stale cache into schema failures at the domain layer. Other
 * read failures propagate.
 * @param descriptor - Static identity and shape of the unit.
 * @param dir - The per-record unit directory (`<root>/<name>`).
 */
async function bootstrapLegacyUnit(descriptor: KvUnitDescriptor, dir: string): Promise<void> {
  const legacyPath = join(dirname(dir), `${descriptor.name}.json`)
  let text: string | undefined
  try {
    text = await readFile(legacyPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return
  }
  // The legacy document is runtime data: only `unit.name`, `unit.version`,
  // and the tables map shape are checked here — the record values are
  // migrated as-is and the domain layer's schemas judge them.
  let document: { unit?: { name?: unknown; version?: unknown }; tables?: unknown }
  try {
    document = JSON.parse(text) as { unit?: { name?: unknown; version?: unknown }; tables?: unknown }
  } catch {
    return // Malformed legacy file: not ours to interpret or delete.
  }
  if (document.unit?.name !== descriptor.name) return
  const stamped = document.unit.version
  if (typeof stamped !== 'number' || !acceptedStamps(descriptor).includes(stamped)) return
  const tables = document.tables
  if (typeof tables !== 'object' || tables === null) return
  const recordsByTable = tables as Record<string, Record<string, unknown>>
  for (const [table, records] of Object.entries(recordsByTable)) {
    if (!descriptor.tables.includes(table)) continue
    for (const [key, value] of Object.entries(records)) {
      const path = join(dir, table, `${key}.json`)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeAtomic(path, serializeRecord(descriptor.version, value))
    }
  }
}

/**
 * Read one declared table's indexed record documents into `records`.
 * @param records - Target map, filled in index order.
 * @param versions - Accepted version stamps.
 * @param dir - Absolute table directory path.
 * @param keys - The table's readable record keys, as `readTree` listed them.
 */
async function loadTableRecords(
  records: Map<string, unknown>,
  versions: readonly number[],
  dir: string,
  keys: readonly string[],
): Promise<void> {
  const loaded = await mapBounded(keys, RECORD_LOAD_CONCURRENCY, async key =>
    [key, await readRecord(join(dir, `${key}.json`), versions)] as const)
  for (const [key, record] of loaded) {
    if (record !== undefined) records.set(key, record)
  }
}

/**
 * Map `items` through `fn` with at most `limit` calls in flight.
 * @param items - inputs, mapped in order.
 * @param limit - maximum concurrent calls.
 * @param fn - async mapper.
 * @returns the results in input order.
 */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Read one record document; a foreign (unreadable or stale) one reads as absent. */
async function readRecord(path: string, versions: readonly number[]): Promise<unknown> {
  try {
    return parseRecord(await readFile(path, 'utf8'), versions)
  } catch {
    return undefined
  }
}

/**
 * One opened `per-record`-layout unit. Stateless by design: the directory is
 * the medium and the domain layer owns the live memory. Replacements publish
 * one document; deletions stage and sync their documents before cleanup.
 * Write ordering belongs to the caller (the domain layer's write chain).
 */
export class PerRecordJsonUnit implements KvUnit {
  private closed = false
  /** Set when a failed batch could not restore its staged documents. */
  private unusable: StorageError | undefined
  /** In-flight durable writes; close() drains them before releasing the unit. */
  private readonly inFlight = new Set<Promise<void>>()
  /** Accepted record document stamps; every read path checks them. */
  private readonly versions: readonly number[]
  /** On-demand reads for a lazy domain: enumerate keys at open, read one document per read miss. */
  readonly recordReader: KvRecordReader

  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly dir: string,
    private readonly onClose: () => void,
  ) {
    this.versions = acceptedStamps(descriptor)
    this.recordReader = {
      listKeys: () => this.listRecordKeys(),
      read: (table, key) => this.readRecordNow(table, key),
      readAsync: (table, key) => this.readRecordLater(table, key),
    }
  }

  /** Re-read the tree: the directory is the authoritative state. */
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const state = await loadPerRecordState(this.descriptor, this.dir)
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of state.tables) {
      tables[table] = Object.fromEntries(records)
    }
    return { tables, global: state.global }
  }

  /**
   * Enumerate the readable tree without reading record documents. This is the
   * whole cost of a lazy open: two directory reads plus the small global
   * document.
   * @returns readable keys per declared table, plus the global slot.
   */
  private async listRecordKeys(): Promise<{ tables: Record<string, readonly string[]>; global: unknown }> {
    this.assertOpen()
    let tree = await readTree(this.descriptor, this.dir)
    if (!tree.found) {
      await bootstrapLegacyUnit(this.descriptor, this.dir)
      tree = await readTree(this.descriptor, this.dir)
    }
    return { tables: Object.fromEntries(tree.tables), global: tree.global }
  }

  /**
   * Read one record document synchronously. A document that is missing,
   * malformed, or stamped with an unaccepted version reads as absent, exactly
   * as the open-time load would have read it.
   * @param table - Declared table name.
   * @param key - Record key, a path segment.
   * @returns the version-checked record value, or `undefined` when absent.
   */
  private readRecordNow(table: string, key: string): unknown {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    const path = join(this.tableDir(table), `${key}.json`)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return undefined // No readable document: the per-record contract's "absent".
    }
    return parseRecord(text, this.versions)
  }

  /**
   * Read one record document without blocking the event loop. Same contract as
   * {@link readRecordNow}, for the maintenance scans that stream a table.
   * @param table - Declared table name.
   * @param key - Record key, a path segment.
   * @returns the version-checked record value, or `undefined` when absent.
   */
  private async readRecordLater(table: string, key: string): Promise<unknown> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    try {
      return parseRecord(await readFile(join(this.tableDir(table), `${key}.json`), 'utf8'), this.versions)
    } catch {
      return undefined // No readable document: the per-record contract's "absent".
    }
  }

  /** Durably replace one record: its own document, atomically. */
  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    await this.tracked(this.writeDocument(join(this.tableDir(table), `${key}.json`), value))
  }

  /** Durably delete one record. Idempotent: a missing key is a no-op. */
  deleteRecord(table: string, key: string): Promise<void> {
    return this.deleteRecords(table, [key])
  }

  /**
   * Durably delete many records as one batch. Documents are renamed out of the
   * readable set first; only after the whole batch is staged are the staged
   * copies unlinked. A failure while staging restores the documents it moved,
   * so a rejection normally leaves the batch unapplied. If that restoration
   * itself fails, the readable or durable state is unknown: the unit rejects with
   * `unknown-state` and every later operation on it rejects, while `close`
   * still releases it. Staged directory changes are synced before cleanup on
   * POSIX, so a resolved deletion remains absent after a crash. Cleanup residue
   * is not readable (`open` reads `*.json` documents only).
   */
  async deleteRecords(table: string, keys: readonly string[]): Promise<void> {
    this.assertOpen()
    const dir = this.tableDir(table)
    const unique = [...new Set(keys)]
    for (const key of unique) assertSafeKey(this.descriptor.name, key)
    // Track staging, restoration, and cleanup together so close() drains them.
    await this.tracked(this.removeDocuments(dir, unique))
  }

  /**
   * Remove one batch's documents under a single tracked promise.
   * @param dir - Declared table directory.
   * @param keys - Validated, de-duplicated record keys.
   */
  private async removeDocuments(dir: string, keys: readonly string[]): Promise<void> {
    const staged: Array<{ from: string; to: string }> = []
    try {
      for (const key of keys) {
        const from = join(dir, `${key}.json`)
        const to = `${from}.deleting`
        try {
          await rename(from, to)
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        staged.push({ from, to })
      }
      if (staged.length > 0) await fsyncDirectory(dir)
    } catch (error: unknown) {
      const restoreFailures: unknown[] = []
      for (const { from, to } of staged) {
        try {
          await rename(to, from)
        } catch (restoreError: unknown) {
          restoreFailures.push(restoreError)
        }
      }
      if (staged.length > 0) {
        try {
          await fsyncDirectory(dir)
        } catch (restoreError: unknown) {
          restoreFailures.push(restoreError)
        }
      }
      if (restoreFailures.length === 0) throw error
      this.unusable = new StorageError(
        'unknown-state',
        `unit '${this.descriptor.name}' could not restore a failed batch delete; its state is unknown`,
        { cause: new AggregateError([error, ...restoreFailures], 'batch delete failed and restoration failed') },
      )
      throw this.unusable
    }
    // The renames already removed the batch from the readable set; unlinking is
    // cleanup, and a failed unlink leaves an unreadable file rather than an entry.
    await Promise.allSettled(staged.map(({ to }) => rm(to, { force: true })))
  }

  /**
   * Move one record's document aside as `<key>.json.bak.<YYYYMMDDHHmm>`. The
   * moved file no longer ends in `.json`, so every later read ignores it; the
   * bytes stay on disk for inspection. A same-minute backup of the same
   * key overwrites the previous backup (the newer bytes are the ones worth
   * keeping).
   */
  async backupRecord(table: string, key: string): Promise<string> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    const path = join(this.tableDir(table), `${key}.json`)
    const moved = `${path}.bak.${backupStamp(new Date())}`
    await this.tracked(rename(path, moved))
    return moved
  }

  /** Durably replace the global singleton. Only valid when declared. */
  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
    await this.tracked(this.writeDocument(join(this.dir, 'global.json'), value))
  }

  /* jscpd:ignore-start -- the two unit classes are standalone; the drain/guard lifecycle mirrors the shared KvUnit contract */
  /** Drain in-flight writes and release the unit. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled(this.inFlight)
      return
    }
    this.closed = true
    await Promise.allSettled(this.inFlight)
    this.onClose()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
    }
    if (this.unusable !== undefined) throw this.unusable
  }
  /* jscpd:ignore-end */

  /** Resolve a declared table's directory; an undeclared table is a caller bug and throws. */
  private tableDir(table: string): string {
    if (!this.descriptor.tables.includes(table)) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return join(this.dir, table)
  }

  /** Durably replace one document, creating its parent directory. */
  private async writeDocument(path: string, value: unknown): Promise<void> {
    const text = serializeRecord(this.descriptor.version, value)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeAtomic(path, text)
  }

  /** Track one durable write so close() drains it. */
  private tracked(write: Promise<void>): Promise<void> {
    this.inFlight.add(write)
    // Swallow only on the tracking branch: the caller still awaits `write`
    // itself, so rejections stay observed exactly once.
    write.catch(() => {}).finally(() => this.inFlight.delete(write))
    return write
  }
}

/** Local-time `YYYYMMDDHHmm` suffix for backed-up documents. */
function backupStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`
}

/** Reject a record key that would be unsafe as a path segment. */
function assertSafeKey(unit: string, key: string): void {
  if (!SAFE_KEY_RE.test(key)) {
    throw new Error(`unit '${unit}': per-record key '${key}' is not path-safe (must match ${SAFE_KEY_RE})`)
  }
}
