/**
 * In-memory {@link StorageBackend} test double implementing the full KvUnit
 * primitive set. Shared test infrastructure: the domain suite uses it to
 * exercise open/route/write semantics without touching disk, and the
 * workspace package's tests import it by relative path (it lives under
 * `tests/`, never `src/`, so it stays out of the published surface).
 *
 * Fidelity to the backend contract (`dsh-storage` `src/backend.ts`): version
 * stamping and `version-mismatch` on reopen, `malformed` never (memory cannot
 * corrupt), per-call atomicity trivially, `closed` after close, delete
 * idempotence. Media survive across backends through the shared `media` map
 * passed into the constructor, which simulates process restarts; stamp
 * `versions` directly to fabricate an on-medium version and force a
 * `version-mismatch` without a prior open.
 * @module
 */

import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvRecordReader, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'

/** One unit's medium: tables of records plus the global slot (`null` = never written). */
export interface MemoryMedium {
  tables: Map<string, Map<string, unknown>>
  global: unknown
}

/**
 * Shared media pool. Construct one and hand it to several
 * {@link MemoryStorageBackend} instances to simulate reopening the same
 * medium after a restart; `versions` holds the stamped unit versions and is
 * writable by tests to inject a mismatching on-medium version, and
 * `failNextWrites` injects write-primitive failures.
 */
export class MemoryMediaPool {
  /** Unit name → its records; a missing entry is a never-materialized unit. */
  readonly media = new Map<string, MemoryMedium>()
  /** Unit name → stamped version; tests may pre-stamp to force `version-mismatch`. */
  readonly versions = new Map<string, number>()
  /**
   * When positive, that many subsequent mutations reject without touching
   * the medium, decrementing per rejection. A missing-key delete is a no-op
   * and leaves this counter unchanged. Callers assert their state is
   * untouched after a durability failure.
   */
  failNextWrites = 0

  /** Whole-unit loads requested so far: a lazy open must leave this at 0. */
  loads = 0

  /** Single-record reads through the on-demand reader. */
  recordReads = 0

  /** Asynchronous single-record reads through the on-demand reader. */
  recordAsyncReads = 0

  /** Records the unit moved aside through {@link KvUnit.backupRecord}. */
  readonly backups: string[] = []

  /** Consume one injected failure, throwing in a rejected write's place. */
  consumeInjectedFailure(): void {
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1
      throw new Error('injected write failure')
    }
  }
}

/** In-memory KV unit over one pooled medium. */
class MemoryKvUnit implements KvUnit {
  private closed = false

  /** On-demand reads over the same medium, for the domain layer's lazy table mode. */
  readonly recordReader: KvRecordReader
  /** Present only when the backend declares document salvage. */
  readonly backupRecord?: (table: string, key: string) => Promise<string>

  constructor(
    private readonly pool: MemoryMediaPool,
    private readonly medium: MemoryMedium,
    private readonly descriptor: KvUnitDescriptor,
    private readonly onClose: () => void,
    backup: boolean,
  ) {
    this.recordReader = {
      listKeys: async () => {
        this.assertOpen()
        const tables: Record<string, string[]> = {}
        for (const table of descriptor.tables) tables[table] = [...this.medium.tables.get(table)?.keys() ?? []]
        return { tables, global: this.medium.global }
      },
      read: (table: string, key: string) => {
        this.assertOpen()
        this.pool.recordReads += 1
        return this.medium.tables.get(table)?.get(key)
      },
      readAsync: async (table: string, key: string) => {
        this.assertOpen()
        this.pool.recordAsyncReads += 1
        return this.medium.tables.get(table)?.get(key)
      },
    }
    if (backup) {
      this.backupRecord = async (table, key) => {
        this.assertOpen()
        const records = this.medium.tables.get(table)
        if (records === undefined || !records.delete(key)) throw new Error(`memory unit: no record '${key}' to back up`)
        const moved = `memory:${descriptor.name}/${table}/${key}.bak`
        this.pool.backups.push(moved)
        return moved
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `memory unit '${this.descriptor.name}' is closed`)
    }
  }

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    this.pool.loads += 1
    const tables: Record<string, Record<string, unknown>> = {}
    for (const table of this.descriptor.tables) {
      tables[table] = Object.fromEntries(this.medium.tables.get(table) ?? [])
    }
    return { tables, global: this.medium.global }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    this.pool.consumeInjectedFailure()
    let records = this.medium.tables.get(table)
    if (records === undefined) {
      records = new Map()
      this.medium.tables.set(table, records)
    }
    records.set(key, value)
    this.pool.versions.set(this.descriptor.name, this.descriptor.version)
  }

  deleteRecord(table: string, key: string): Promise<void> {
    return this.deleteRecords(table, [key])
  }

  async deleteRecords(table: string, keys: readonly string[]): Promise<void> {
    this.assertOpen()
    const records = this.medium.tables.get(table)
    if (records === undefined) return
    const present = [...new Set(keys)].filter(key => records.has(key))
    if (present.length === 0) return
    this.pool.consumeInjectedFailure()
    for (const key of present) records.delete(key)
    this.pool.versions.set(this.descriptor.name, this.descriptor.version)
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    this.pool.consumeInjectedFailure()
    this.medium.global = value
    this.pool.versions.set(this.descriptor.name, this.descriptor.version)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.onClose()
  }
}

/**
 * In-memory storage backend with a `kv` facet. Pass a shared
 * {@link MemoryMediaPool} to let a second instance reopen the same media;
 * omit it for a throwaway isolated pool.
 */
export class MemoryStorageBackend implements StorageBackend {
  readonly kv: KvFacet
  private readonly openUnits = new Set<string>()
  private closed = false

  /**
   * @param pool - Media shared across instances; a fresh private pool when omitted.
   * @param options - `backup` declares document salvage (absent by default, so
   * the `invalidRecords: 'backup-and-skip'` policy keeps its rejecting
   * fallback). On-demand reads are always available.
   */
  constructor(
    readonly pool: MemoryMediaPool = new MemoryMediaPool(),
    readonly options: { backup?: boolean } = {},
  ) {
    this.kv = {
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        if (this.closed) {
          throw new StorageError('closed', 'memory backend is closed')
        }
        // Double-open is a caller bug per the backend contract; no dedicated
        // StorageError code exists for it, so a plain Error is correct.
        if (this.openUnits.has(descriptor.name)) {
          throw new Error(`memory unit '${descriptor.name}' is already open (double-open is a caller bug)`)
        }
        const stamped = this.pool.versions.get(descriptor.name)
        if (stamped === undefined) {
          this.pool.versions.set(descriptor.name, descriptor.version)
        } else if (stamped !== descriptor.version && !descriptor.compatibleVersions?.includes(stamped)) {
          throw new StorageError(
            'version-mismatch',
            `memory unit '${descriptor.name}' is stamped v${stamped}, descriptor wants v${descriptor.version}`,
          )
        }
        let medium = this.pool.media.get(descriptor.name)
        if (medium === undefined) {
          medium = { tables: new Map(), global: null }
          this.pool.media.set(descriptor.name, medium)
        }
        this.openUnits.add(descriptor.name)
        return new MemoryKvUnit(
          this.pool,
          medium,
          descriptor,
          () => this.openUnits.delete(descriptor.name),
          this.options.backup === true,
        )
      },
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.openUnits.clear()
  }
}
