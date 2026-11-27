/**
 * Domain data form (`ctx.storage.domain`): schema-validated, change-emitting
 * KV domains over storage backends. The single implementation of the domain
 * layer — consumers depend on this package and never touch backends directly.
 * Plugin `Config` is schemastery; record schemas inside domain specs are zod
 * (see `src/spec.ts` for the split rationale).
 * @module @deepseek-ai/dsh-storage-domain
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvRecordReader, KvUnit } from '@deepseek-ai/dsh-storage'
import { DomainError } from './error.ts'
import { descriptorOf } from './spec.ts'
import type { DomainOpenOptions, DomainSpec } from './spec.ts'
import { DomainImpl } from './domain.ts'
import type { Domain } from './domain.ts'
import { parseRecord } from './record.ts'
import { EagerTableRecords, ResidentTableRecords } from './records.ts'
import type { TableRecords } from './records.ts'

export { DomainError } from './error.ts'
export type { DomainErrorCode, DomainErrorOptions, InvalidRecordDetail } from './error.ts'
export { defineDomain, domainTable, descriptorOf } from './spec.ts'
export type {
  DomainSpec, DomainGlobalSpec, DomainTableSpec, DomainOpenOptions,
  TableKeyOf, TableValueOf, GlobalValueOf,
} from './spec.ts'
export type { DomainChanged } from './events.ts'
export type { Domain, DomainGlobal, DomainGlobalHandleOf, KvTable } from './domain.ts'

declare module '@deepseek-ai/dsh-storage' {
  interface StorageForms {
    domain: DomainFacility
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    storageDomain: DomainFacility
  }
}

/** Cordis plugin name. */
export const name = 'storage-domain'
/** The storage hub must be present before the form can mount. */
export const inject = ['storage']

/**
 * Plugin config. Which backend serves which domain is decided here, not
 * globally on the hub: `backend` is the default route and `routes` overrides
 * it per domain name. A route naming an unregistered backend fails loud at
 * `open` with `backend-not-found`.
 */
export interface Config {
  /** Default backend name for every domain without an explicit route. Required: there is no universally correct medium. */
  backend: string
  /** Per-domain overrides: domain name → backend name. */
  routes?: Record<string, string>
}

export const Config: z<Config> = z.object({
  backend: z.string().required(),
  routes: z.dict(z.string()).default({}),
})

/**
 * The mounted domain facility. Opens declared domains over routed backends;
 * one facility instance owns the open-domain table and enforces single-open
 * per domain name.
 */
export class DomainFacility {
  private readonly domains = new Map<string, DomainImpl>()
  /** Names reserved by an in-flight or completed open, so concurrent opens of one name fail loud. */
  private readonly reserved = new Set<string>()

  /**
   * @param ctx - Context of the domain plugin; open-domain effects and change
   * events attach here.
   * @param config - Validated plugin config.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  /**
   * Open one declared domain. Steps, each failing the whole call: reject a
   * name that is already open (`already-open`); resolve the backend route
   * (`backend-not-found` passes through from the hub); require its `kv` facet
   * (`facet-unsupported`); open the unit projected from the spec (backend
   * `version-mismatch`/`malformed-medium` pass through); load the stored
   * records; construct the domain.
   *
   * Record loading is eager unless {@link DomainOpenOptions.lazyReads} asks
   * otherwise: the eager path validates every stored record against the
   * spec's zod schemas (`invalid-record` with the offending table and key —
   * unless the spec declares `invalidRecords: 'backup-and-skip'` and the unit
   * can move documents aside, in which case the failing record is backed up,
   * logged, and skipped). The lazy path reads only the key index at open and
   * validates each record when a table read loads it, with the same policy.
   *
   * Lifecycle: the CALLER owns the returned handle and closes it via
   * `Domain.close()` (typically as its own `ctx.effect` disposer) — the
   * facility does not tie the domain to any consumer fiber. Domains still
   * open when the facility unmounts are closed by the plugin disposer.
   * @param spec - The domain declaration, typically from `defineDomain`.
   * @param options - Record-loading options; omitted means eager materialization.
   * @returns the opened domain handle, typed by the spec.
   */
  async open<S extends DomainSpec>(spec: S, options?: DomainOpenOptions): Promise<Domain<S>> {
    if (this.reserved.has(spec.name)) {
      throw new DomainError('already-open', `domain '${spec.name}' is already open`)
    }
    this.reserved.add(spec.name)
    try {
      const maxResidentBytes = resolveOpenOptions(spec, options)
      const backendName = this.config.routes?.[spec.name] ?? this.config.backend
      const backend = this.ctx.storage.backend.get(backendName)
      if (!backend.kv) {
        throw new DomainError(
          'facet-unsupported',
          `backend '${backendName}' routed for domain '${spec.name}' has no kv facet`,
        )
      }
      const unit = await backend.kv.open(descriptorOf(spec))
      try {
        const loaded = maxResidentBytes !== undefined && unit.recordReader !== undefined
          ? await loadResident(spec, unit, unit.recordReader, maxResidentBytes, this.ctx.logger)
          : await this.loadEager(spec, unit, maxResidentBytes !== undefined)
        // The onClosed hook runs strictly after teardown completes: writes
        // landing during the drain still emit domain/changed, and the name
        // frees up for reopening only once the domain is fully closed.
        const domain: DomainImpl = new DomainImpl(this.ctx, spec, unit, loaded.tables, loaded.globalValue, () => {
          this.domains.delete(spec.name)
          this.reserved.delete(spec.name)
        })
        this.domains.set(spec.name, domain)
        // The single type-erasure point: DomainImpl is the untyped runtime,
        // Domain<S> the spec-typed view; the unknown hop is required because
        // S's conditional global-handle type stays unresolved here.
        return domain as unknown as Domain<S>
      } catch (error) {
        await unit.close()
        throw error
      }
    } catch (error) {
      // Any failure means the domain never registered (nothing can throw
      // after it), so releasing the name reservation is unconditional.
      this.reserved.delete(spec.name)
      throw error
    }
  }

  /**
   * Load every stored record and validate it against the spec: the default
   * open-time materialization.
   * @param spec - The domain declaration.
   * @param unit - The opened unit.
   * @param lazyRequested - Whether the caller asked for lazy reads and this
   * unit cannot serve them (warned here).
   * @returns the stores and validated global slot.
   */
  private async loadEager(spec: DomainSpec, unit: KvUnit, lazyRequested: boolean): Promise<LoadedTables> {
    if (lazyRequested) {
      this.ctx.logger.warn(
        `domain '${spec.name}': the routed backend cannot read records on demand; opening eagerly`,
      )
    }
    const snapshot = await unit.loadAll()
    const tables = new Map<string, TableRecords>()
    for (const [table, tableSpec] of Object.entries(spec.tables)) {
      const records = new Map<string, unknown>()
      for (const [key, raw] of Object.entries(snapshot.tables[table] ?? {})) {
        let parsed: unknown
        try {
          parsed = parseRecord(spec.name, table, key, () => tableSpec.valueSchema.parse(raw))
        } catch (error) {
          // Backup-and-skip policy (disposable derived data): move the record's
          // document aside, log the concrete failure, and open without the
          // record. Backends that cannot move a document keep the loud path.
          if (spec.invalidRecords !== 'backup-and-skip' || unit.backupRecord === undefined) throw error
          const moved = await unit.backupRecord(table, key)
          // parseRecord always wraps the zod failure as the cause.
          this.ctx.logger.error(
            `domain '${spec.name}': stored record '${key}' in table '${table}' failed schema validation; `
            + `moved to '${moved}' and treated as absent. Cause: ${String((error as DomainError).cause)}`,
          )
          continue
        }
        records.set(key, parsed)
      }
      tables.set(table, new EagerTableRecords(records))
    }
    return { tables, globalValue: this.globalValueOf(spec, snapshot.global) }
  }

  /**
   * Validate the stored global slot, or serve the spec's `initial` when the
   * medium holds none.
   * @param spec - The domain declaration.
   * @param stored - The stored global value (`null` = never written).
   * @returns the validated global, or `undefined` when the spec declares none.
   */
  private globalValueOf(spec: DomainSpec, stored: unknown): unknown {
    // A null stored global means "never written": serve `initial` without
    // materializing it — the first `set` writes.
    const globalSpec = spec.global
    if (globalSpec === undefined) return undefined
    return stored === null
      ? globalSpec.initial
      : parseRecord(spec.name, '', '', () => globalSpec.schema.parse(stored))
  }

  /**
   * Look up an open domain by name, untyped. Diagnostic surface; typed
   * consumers hold the handle returned by {@link open}.
   * @param name - Domain name.
   * @returns the open domain runtime, or `undefined` when not open.
   */
  get(name: string): DomainImpl | undefined {
    return this.domains.get(name)
  }

  /**
   * Close every domain still open on this facility. The unmount path for
   * consumers that never called `Domain.close()` themselves; closing is
   * idempotent, so double-closing an already-closed domain is harmless.
   * @returns resolution after every unit is released.
   */
  async closeAll(): Promise<void> {
    await Promise.all([...this.domains.values()].map(domain => domain.close()))
  }
}

/**
 * The stores and validated global slot one open produced.
 */
interface LoadedTables {
  /** One record store per declared table, keyed by table name. */
  readonly tables: Map<string, TableRecords>
  /** Validated stored global, or the spec's `initial`; `undefined` when not declared. */
  readonly globalValue: unknown
}

/**
 * Load a per-record domain for on-demand reads: the unit's key index plus a
 * bounded resident store per declared table. Only the index is read here;
 * every record is validated when a read loads it.
 * @param spec - The domain declaration.
 * @param unit - The opened unit; owns the document salvage used by the policy.
 * @param reader - The unit's on-demand reader.
 * @param maxResidentBytes - Serialized-byte ceiling of each table's resident set.
 * @param logger - Domain logger for salvage diagnostics.
 * @returns the stores and validated global slot.
 */
async function loadResident(
  spec: DomainSpec,
  unit: KvUnit,
  reader: KvRecordReader,
  maxResidentBytes: number,
  logger: Context['logger'],
): Promise<LoadedTables> {
  const index = await reader.listKeys()
  const backup = unit.backupRecord?.bind(unit)
  const tables = new Map<string, TableRecords>()
  for (const [table, tableSpec] of Object.entries(spec.tables)) {
    tables.set(table, new ResidentTableRecords({
      domain: spec.name,
      table,
      schema: tableSpec.valueSchema,
      backupAndSkip: spec.invalidRecords === 'backup-and-skip',
      ...backup === undefined ? {} : { backupRecord: backup },
      reader,
      maxResidentBytes,
      logger,
    }, index.tables[table] ?? []))
  }
  // A null stored global means "never written": serve `initial`.
  const globalSpec = spec.global
  const globalValue = globalSpec === undefined
    ? undefined
    : index.global === null
      ? globalSpec.initial
      : parseRecord(spec.name, '', '', () => globalSpec.schema.parse(index.global))
  return { tables, globalValue }
}

/**
 * Validate the open options against the spec and resolve the record-loading
 * mode: `undefined` means eager materialization.
 * @param spec - The domain declaration.
 * @param options - The caller's open options.
 * @returns the resident-byte ceiling, or `undefined` for the eager path.
 */
function resolveOpenOptions(spec: DomainSpec, options: DomainOpenOptions | undefined): number | undefined {
  const requested = options?.lazyReads === true
  if (!requested) {
    if (options?.maxResidentBytes !== undefined) {
      throw new Error(`domain '${spec.name}': maxResidentBytes is only meaningful with lazyReads`)
    }
    return undefined
  }
  if (spec.layout !== 'per-record') {
    throw new Error(`domain '${spec.name}': lazyReads requires the 'per-record' layout`)
  }
  const bytes = options.maxResidentBytes
  if (bytes === undefined || !Number.isInteger(bytes) || bytes <= 0) {
    throw new Error(`domain '${spec.name}': lazyReads requires a positive integer maxResidentBytes`)
  }
  return bytes
}

/**
 * Mount the domain data form on the storage hub.
 * @param ctx - Plugin context.
 * @param config - Validated plugin config.
 * @returns resolution after an already-available backend set activates the form.
 */
export function apply(ctx: Context, config: Config): Promise<void> {
  const backendServices = [...new Set([
    config.backend,
    ...Object.values(config.routes ?? {}),
  ])].map(storageBackendServiceKey)

  const fiber = ctx.inject(backendServices, (domainCtx) => {
    const facility = new DomainFacility(domainCtx, config)
    domainCtx.effect(() => {
      const unmount = domainCtx.storage.mount('domain', facility)
      return async () => {
        // Close leftovers before unmounting: draining writes still emit
        // domain/changed.
        await facility.closeAll()
        unmount()
      }
    })
    domainCtx.provide('storageDomain', facility)
  })
  return Promise.resolve(fiber).then(() => {})
}
