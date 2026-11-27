/**
 * Record storage behind one table handle. The eager store is the map the open
 * loaded; the resident store serves reads from the medium on demand and keeps
 * only a bounded, least-recently-used set of loaded records. Both apply writes
 * only after the backend reported durability, so a read never observes a value
 * the medium does not hold.
 * @module @deepseek-ai/dsh-storage-domain/src/records
 */

import type { ZodType } from 'zod'
import type { KvRecordReader } from '@deepseek-ai/dsh-storage'
import { parseRecord } from './record.ts'

/** Where a lazily read table gets its records and diagnostics from. */
export interface LazyTablePolicy {
  /** Domain name for diagnostics. */
  readonly domain: string
  /** Declared table name. */
  readonly table: string
  /** Validates every record read from the medium. */
  readonly schema: ZodType
  /** The spec's `invalidRecords: 'backup-and-skip'` policy: records are disposable derived data. */
  readonly backupAndSkip: boolean
  /** Backend document salvage; absent when the medium cannot move one record aside. */
  readonly backupRecord?: (table: string, key: string) => Promise<string>
  /** The unit's on-demand record reader. */
  readonly reader: KvRecordReader
  /** Serialized-byte ceiling of the resident set; a larger record stays resident alone. */
  readonly maxResidentBytes: number
  /** Domain logger for salvage diagnostics. */
  readonly logger: {
    error(message: string): void
    warn(message: string): void
  }
}

/**
 * The record storage a table handle reads and writes through.
 */
export interface TableRecords {
  /**
   * Read one record. A lazy store loads and validates it on a resident miss.
   * @param key - Record key.
   * @returns the record, or `undefined` when absent or unreadable.
   */
  get(key: string): unknown

  /**
   * Whether the record exists on the medium. Never loads a record, so a
   * delete decides existence without paying for a read.
   * @param key - Record key.
   * @returns `true` when the key is readable.
   */
  has(key: string): boolean

  /**
   * Every known record key in stable order.
   * @returns a snapshot of the keys.
   */
  keys(): readonly string[]

  /**
   * The `[key, record]` pairs currently held in memory. A lazy store reports
   * its bounded resident set, not every record on the medium.
   * @returns a snapshot of the pairs.
   */
  entries(): readonly (readonly [string, unknown])[]

  /** Known record count. */
  readonly size: number

  /**
   * Serialized bytes charged for one value before it is written. Eager stores
   * keep no budget and report 0.
   * @param value - The record value about to be written.
   * @returns its charge in bytes.
   */
  bytesOf(value: unknown): number

  /**
   * Apply one durably written record.
   * @param key - Record key.
   * @param value - The record now on the medium.
   * @param bytes - The charge reported by {@link bytesOf}.
   */
  set(key: string, value: unknown, bytes: number): void

  /**
   * Apply one durably deleted record.
   * @param key - Record key.
   */
  remove(key: string): void

  /**
   * Stream every stored record once without retaining it: the maintenance read
   * a bounded table's owner uses to shrink or migrate its corpus. Each record
   * is read from the medium and validated at that boundary, the spec's
   * `invalidRecords` policy applies, and the resident set is neither used nor
   * changed. Present only on stores that read records on demand.
   * @param assertReadable - Guard run before each record; rejects after close.
   * @returns an async iterator over the pairs in key order.
   */
  scan?(assertReadable: () => void): AsyncIterableIterator<readonly [string, unknown]>
}

/** The fully loaded table: every record from the open-time snapshot. */
export class EagerTableRecords implements TableRecords {
  /** @param records - The validated records the open loaded. */
  constructor(private readonly records: Map<string, unknown>) {}

  get(key: string): unknown {
    return this.records.get(key)
  }

  has(key: string): boolean {
    return this.records.has(key)
  }

  keys(): readonly string[] {
    return [...this.records.keys()]
  }

  entries(): readonly (readonly [string, unknown])[] {
    return [...this.records.entries()]
  }

  get size(): number {
    return this.records.size
  }

  /** No resident budget: nothing is charged and nothing is ever released. */
  bytesOf(): number {
    return 0
  }

  set(key: string, value: unknown): void {
    this.records.set(key, value)
  }

  remove(key: string): void {
    this.records.delete(key)
  }
}

/** One resident record and the bytes it is charged. */
interface ResidentRecord {
  readonly value: unknown
  readonly bytes: number
}

/**
 * The lazily read table: an index of every readable key plus a bounded,
 * least-recently-used set of loaded records. A resident miss reads and
 * validates that one record; the oldest records are released when the
 * resident bytes would exceed the budget, so a long history never accumulates
 * in memory. Records the medium cannot serve read as absent, exactly like the
 * open-time load.
 */
export class ResidentTableRecords implements TableRecords {
  /** Every readable key, in medium order plus later writes. */
  private readonly known: Set<string>
  /** Resident records, least recently used first. */
  private readonly resident = new Map<string, ResidentRecord>()
  private residentBytes = 0

  /**
   * @param policy - Reader, schema, salvage policy, budget, and logger.
   * @param keys - The readable keys the open-time index reported.
   */
  constructor(
    private readonly policy: LazyTablePolicy,
    keys: readonly string[],
  ) {
    this.known = new Set(keys)
  }

  get(key: string): unknown {
    const hit = this.resident.get(key)
    if (hit !== undefined) {
      this.touch(key, hit)
      return hit.value
    }
    if (!this.known.has(key)) return undefined
    return this.load(key)
  }

  has(key: string): boolean {
    return this.known.has(key)
  }

  keys(): readonly string[] {
    return [...this.known]
  }

  entries(): readonly (readonly [string, unknown])[] {
    return [...this.resident].map(([key, record]) => [key, record.value] as const)
  }

  get size(): number {
    return this.known.size
  }

  bytesOf(value: unknown): number {
    const text = JSON.stringify(value)
    // The charge is computed inside the write slot, before durability: a value
    // that is not JSON rejects the write with memory and medium untouched.
    if (text === undefined) throw new TypeError('record value is not JSON-serializable')
    return Buffer.byteLength(text, 'utf8')
  }

  set(key: string, value: unknown, bytes: number): void {
    this.known.add(key)
    this.retain(key, value, bytes)
  }

  remove(key: string): void {
    this.known.delete(key)
    this.release(key)
  }

  /**
   * Stream every stored record once, reading each from the medium without
   * retaining it. A record the medium no longer holds leaves the index; a
   * schema-failing one follows the spec's salvage policy exactly like a lazy
   * read does.
   * @param assertReadable - Guard run before each record.
   */
  async *scan(assertReadable: () => void): AsyncGenerator<readonly [string, unknown]> {
    for (const key of [...this.known]) {
      assertReadable()
      const stored = await this.policy.reader.readAsync(this.policy.table, key)
      if (stored === undefined) {
        this.known.delete(key)
        continue
      }
      let parsed: unknown
      try {
        parsed = parseRecord(this.policy.domain, this.policy.table, key, () => this.policy.schema.parse(stored))
      } catch (error) {
        const backup = this.policy.backupRecord
        if (!this.policy.backupAndSkip || backup === undefined) throw error
        this.known.delete(key)
        // The scan awaits the salvage: it streams one record at a time, so the
        // move costs no residency and keeps the report ordered.
        await this.salvage(key, backup, error)
        continue
      }
      yield [key, parsed] as const
    }
  }

  /** Load, validate, and retain one record the resident set does not hold. */
  private load(key: string): unknown {
    const stored = this.policy.reader.read(this.policy.table, key)
    if (stored === undefined) {
      // The medium no longer holds a readable document for a key the open-time
      // index listed (removed, or replaced by a foreign document).
      this.known.delete(key)
      return undefined
    }
    let parsed: unknown
    try {
      parsed = parseRecord(this.policy.domain, this.policy.table, key, () => this.policy.schema.parse(stored))
    } catch (error) {
      const backup = this.policy.backupRecord
      if (!this.policy.backupAndSkip || backup === undefined) throw error
      // Disposable derived data: the record is treated as absent and moved
      // aside for inspection. The salvage write is fail-soft and not awaited:
      // a synchronous read must return the absent record now.
      this.known.delete(key)
      void this.salvage(key, backup, error)
      return undefined
    }
    this.retain(key, parsed, compactBytes(parsed))
    return parsed
  }

  /**
   * Move one schema-failing record's document aside and report it. Fail-soft:
   * the record already reads as absent, so a failed move only has to be
   * visible in the log.
   * @param key - The failing record's key.
   * @param backup - The backend's document move.
   * @param cause - The schema failure the read discarded.
   * @returns resolution after the attempt, success or failure.
   */
  private salvage(
    key: string,
    backup: (table: string, key: string) => Promise<string>,
    cause: unknown,
  ): Promise<void> {
    return backup(this.policy.table, key).then(
      (moved) => {
        this.policy.logger.error(
          `domain '${this.policy.domain}': stored record '${key}' in table '${this.policy.table}' failed schema `
          + `validation; moved to '${moved}' and treated as absent. Cause: ${String(cause)}`,
        )
      },
      (error: unknown) => {
        this.policy.logger.warn(
          `domain '${this.policy.domain}': stored record '${key}' in table '${this.policy.table}' failed schema `
          + `validation and could not be moved aside; it reads as absent: ${String(error)}`,
        )
      },
    )
  }

  /** Retain one record, releasing least-recently-used entries beyond the budget. */
  private retain(key: string, value: unknown, bytes: number): void {
    this.release(key)
    if (bytes > this.policy.maxResidentBytes) {
      // A record above the whole budget is served and stays resident alone:
      // keeping anything else would only shorten the next read's win.
      for (const resident of [...this.resident.keys()]) this.release(resident)
      this.resident.set(key, { value, bytes })
      this.residentBytes = bytes
      return
    }
    while (this.resident.size > 0 && this.residentBytes + bytes > this.policy.maxResidentBytes) {
      // The size guard guarantees a first (least recently used) key.
      this.release(this.resident.keys().next().value as string)
    }
    this.resident.set(key, { value, bytes })
    this.residentBytes += bytes
  }

  /** Move one resident record to the most recently used end. */
  private touch(key: string, record: ResidentRecord): void {
    this.resident.delete(key)
    this.resident.set(key, record)
  }

  /** Release one record, if resident, from the budget. */
  private release(key: string): void {
    const record = this.resident.get(key)
    if (record === undefined) return
    this.resident.delete(key)
    this.residentBytes -= record.bytes
  }
}

/**
 * Compact JSON size of one record value: the resident budget's unit, computed
 * the same way on load and on write.
 * @param value - A record value.
 * @returns its UTF-8 byte count.
 */
function compactBytes(value: unknown): number {
  // Loaded values passed their schema; written values passed the domain's
  // write contract, so stringification is total.
  return Buffer.byteLength(JSON.stringify(value) as string, 'utf8')
}
