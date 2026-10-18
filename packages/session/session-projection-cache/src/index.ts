/**
 * Persisted projection cache (`ctx.sessionProjectionCache`): durable
 * checkpoints of every projection unit's state, one record per session on
 * the `session_projcache` domain (`per-record` layout — the shipped json
 * backend stores one document per session under its root). Reads and writes
 * share ONE coherent state: the domain's in-memory tables serve every read
 * synchronously, and each write lands on the domain's write chain (durability
 * first, then memory), so a read can never observe a disk write the memory
 * has not applied, or a memory value the disk does not hold. The cache is a
 * fold shortcut, never an authority: a row
 * is possibly stale (its `seq` says how stale) but never wrong, so every
 * write path is fail-soft (a lost write costs a longer tail replay on the
 * next cold read) and a `ver` mismatch discards the row instead of migrating
 * it. Design authority: the session-projection RFC
 * (.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
 * @module @deepseek-ai/dsh-session-projection-cache
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isJsonValue, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type {
  ProjectionCheckpoint,
  ProjectionSnapshot,
  SessionProjectionMap,
} from '@deepseek-ai/dsh-session-projection'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { projectionCacheDomainSpec } from './spec.ts'
import type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

/**
 * The identity a Session header alone witnesses: the format generation the
 * fold must have run under and the fields that distinguish one lifecycle
 * stored under a session id. The read-only listing face matches exactly this.
 */
type LifecycleIdentity = Omit<CurrentCheckpointIdentity, 'inheritedEventCount'>

/**
 * Complete identity written by the current cache generation: the lifecycle
 * identity plus the exact inherited cut, which only a caller holding the
 * Session or its body knows. The fold face (hydration, checkpoint writes)
 * matches this.
 */
type CurrentCheckpointIdentity = CheckpointIdentity & {
  formatVersion: number
  isSeeded: boolean
  inheritedEventCount: SessionLogOffset
}

const PREDECESSOR_TITLE_KEY = 'title' as Extract<keyof SessionProjectionMap, string>

/**
 * Listing hint rows a record outside the retained-byte budget keeps. Both are
 * small zero-fold values the Session list names and orders a row by; every
 * other row is fold state that only an opened Session reads. The metadata key
 * is contributed by the API layer, so it is matched by its stored name rather
 * than through this package's projection-map declaration.
 */
const LIST_HINT_KEYS = ['title', 'sessionListMetadata'] as const

/**
 * Default ceiling on the serialized checkpoint bytes the cache keeps complete.
 * The storage domain materializes every stored record at open and holds it for
 * the process lifetime, so this budget is what bounds that always-resident set;
 * a deployment with a long history stores far more than it can use. Records
 * outside it keep only their listing hint rows.
 */
export const DEFAULT_MAX_RETAINED_BYTES = 256 * 1024 * 1024

/** Records visited between event-loop yields in the startup budget pass. */
const BUDGET_YIELD_INTERVAL = 64

export { checkpointIdentity, checkpointRecord, checkpointRow, projectionCacheDomainSpec } from './spec.ts'
export type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProjectionCache: SessionProjectionCache
  }
}

/**
 * Plugin config. Both throttle triggers are deployment choices with no
 * universally correct value, so the composition states them explicitly
 * (cordis.yml); the three mandatory write points (session creation,
 * `turn/end`, and session disposal) are policy, not tunables, and always
 * fire.
 */
export interface Config {
  /** Committed events per session that force a durable checkpoint write between mandatory points. */
  writeEveryEvents: number
  /** Longest time (milliseconds) a dirty checkpoint may stay unwritten between mandatory points. */
  writeIntervalMs: number
  /**
   * Largest total serialized checkpoint payload the cache keeps complete
   * across all Sessions. At init the newest records (ranked by their highest
   * checkpoint seq) stay complete until this budget is reached, and every
   * remaining record is replaced by a lightweight record holding only its
   * listing hint rows (`title`, `sessionListMetadata`) — or deleted when it
   * has none. Dropping fold rows only costs a longer cold replay, never a
   * value; the listing hints keep such a Session named and ordered in the
   * list without opening it. Defaults to {@link DEFAULT_MAX_RETAINED_BYTES}.
   */
  maxRetainedBytes?: number
}

export const Config: z<Config> = z.object({
  writeEveryEvents: z.natural().min(1).required(),
  writeIntervalMs: z.natural().min(1).required(),
  maxRetainedBytes: z.natural().min(1).default(DEFAULT_MAX_RETAINED_BYTES),
})

/** Per-session write-behind bookkeeping (live sessions only; dropped at retire). */
interface DirtyState {
  /** Committed events since the last durable write. */
  pending: number
  /** Interval trigger armed at the first dirty event after a clean write. */
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * The persisted projection cache service. Opens the `session_projcache`
 * domain at init, checkpoints live sessions on a throttled write-behind
 * (count/interval triggers from {@link Config}) plus three mandatory points —
 * session creation, `turn/end`, and session disposal (the live-to-cold
 * moment) — and serves the
 * cached rows for a session header. Every durable write is fail-soft:
 * failures log a warning and the cache self-heals on the next write.
 */
export class SessionProjectionCache extends Service {
  static inject = ['storageDomain', 'sessionProjections', 'sessions']

  static Config: z<Config> = Config

  private table?: KvTable<SessionId, CheckpointRecord>
  private readonly dirty = new Map<Session, DirtyState>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'sessionProjectionCache')
  }

  /** Open the domain, install the write-behind listeners, then bound the inherited records. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'sessionProjectionCache.domainClose')
    this.table = domain.table('sessions')
    this.installWritePath()
    // The domain materializes every stored record at open, so the byte budget
    // only reaches an already-populated deployment through this first pass.
    void this.boundRetainedBytes()
  }

  /**
   * The stored record for one session, accepted only when its bound log
   * identity matches `expected`. A session id names a slot, not a lifecycle:
   * a recreated id or a persistence store swapped under a surviving cache
   * must not let an old record seed state folded from an unrelated log.
   * Synchronous from the domain's in-memory state — the same state every
   * write mutated, so a read can never go around the write chain to the
   * medium.
   * @param id - the session whose record is read.
   * @param expected - the log identity the caller holds (live or stored header).
   * @returns the identity-matching record, or `undefined` (absent or unrelated).
   */
  private recordFor(id: SessionId, expected: CurrentCheckpointIdentity): CheckpointRecord | undefined {
    const record = this.requireTable().get(id)
    if (record === undefined) return undefined
    return identityMatches(record.identity, expected) ? record : undefined
  }

  /**
   * The zero-I/O listing read: whole values viewed straight from the stored
   * rows (version-matching keys only) of the record bound to the caller's
   * lifecycle. The header is the only identity witness a listing holds, so
   * this face matches the lifecycle identity (`formatVersion`, `createdAt`,
   * `cwd`, `isSeeded`) and not the inherited cut: within one format
   * generation the cut is fixed at fork time, so it distinguishes no
   * lifecycle the other fields do not, and a viewed value never seeds a fold.
   * The view is as stale as the last durable checkpoint but never wrong and
   * never from an unrelated log. A record outside the retained-byte budget
   * serves only its listing hint rows, so a caller that needs the complete
   * block still sees such a block as partial. Its `asOfSeq` is the lowest
   * watermark among the served rows: the stored record's own position, which
   * the header cannot relate to the log the caller later opens. The Session
   * list therefore labels the block as cached, and the client lets every value
   * the connected Session produces supersede it whatever this number says.
   * @param meta - the listed session's header (identity witness; no log read).
   * @param keys - optional projection keys required by the caller's audience.
   * @param excludeKeys - keys omitted before state validation or viewing; stored rows remain available to other readers.
   * @returns the viewed block, or `undefined` when no usable row exists for
   *   this lifecycle at the current Session format.
   */
  cachedSnapshot(
    meta: SessionHeader,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
    excludeKeys?: ReadonlySet<string>,
  ): ProjectionSnapshot | undefined {
    const expected = lifecycleIdentityOf(meta)
    const record = this.requireTable().get(meta.id)
    if (record === undefined || !currentLifecycleMatches(record.identity, expected)) return undefined
    return this.viewRecord(record, keys, excludeKeys)
  }

  /**
   * Read only a predecessor checkpoint's title as a zero-I/O listing hint.
   *
   * The authoritative Session header supplies the lifecycle identity. A cache
   * checkpoint can lag that log but cannot lead it because writes flush the
   * log first, so a matching predecessor title is a genuine (possibly stale)
   * fact from this Session. The registry still requires the current title
   * projection's row version and schema. No other predecessor projection is
   * exposed: format normalization can change their current meaning, and the
   * {@link cachedSnapshot} / hydration paths continue to reject them.
   * @param meta - authoritative listed Session header.
   * @returns a title-only block at the stored title row's watermark, or
   *   `undefined` when the record is current, newer, unrelated, missing, or
   *   incompatible with the title unit.
   */
  cachedPredecessorTitle(meta: SessionHeader): ProjectionSnapshot | undefined {
    const expected = lifecycleIdentityOf(meta)
    const record = this.requireTable().get(meta.id)
    if (record === undefined || !predecessorIdentityMatches(record.identity, expected)) return undefined
    return this.viewRecord(record, [PREDECESSOR_TITLE_KEY])
  }

  /**
   * View selected wire rows as one block bound to the lowest served
   * watermark: the seq every served value has folded through at least. The
   * number is the record's own; whether a consumer may compare it with a
   * live Session's seqs is decided by the face that serves the block, not
   * here.
   */
  private viewRecord(
    record: CheckpointRecord,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
    excludeKeys?: ReadonlySet<string>,
  ): ProjectionSnapshot | undefined {
    const values = this.ctx.sessionProjections.viewCheckpoint(record.rows, keys, excludeKeys)
    let asOfSeq: ProjectionSnapshot['asOfSeq'] | undefined
    for (const [key, row] of Object.entries(record.rows)) {
      if (!Object.hasOwn(values, key)) continue
      if (asOfSeq === undefined || row.seq < asOfSeq) asOfSeq = row.seq
    }
    return asOfSeq === undefined ? undefined : { asOfSeq, values }
  }

  /**
   * Hydrate projection cells for an already-prepared Session without another
   * persistence read. The cache seeds matching rows; the supplied exact log
   * advances every unit to the observation cut. No checkpoint is written
   * because the logical observation may contain recovery events not yet durable.
   * @param session - exact unpublished Session retained by persistence.
   * @param events - exact logical event prefix represented by the observation.
   * @returns all projection values at the event cut.
   */
  hydratePrepared(
    session: Session,
    events: readonly SessionEvent[],
  ): ProjectionSnapshot {
    const record = this.recordFor(
      session.id,
      identityOf(session.header, session.inheritedEventCount),
    )
    if (record === undefined) {
      return this.ctx.sessionProjections.hydrate(session, {}, events, SessionLogOffset(0))
    }
    try {
      return this.ctx.sessionProjections.hydrate(
        session,
        record.rows,
        events,
        SessionLogOffset(0),
      )
    } catch {
      // Cached rows are disposable derived data. Retry from the exact log so a
      // stale schema cannot make a valid Session unreadable.
      return this.ctx.sessionProjections.hydrate(session, {}, events, SessionLogOffset(0))
    }
  }

  /**
   * Durably checkpoint one live session NOW (all mandatory points call
   * this; tests and carriers may too). The registry cut is snapshotted at
   * this boundary (states are live references), then the session's record is
   * replaced on the domain's write chain. NOT fail-soft — callers on the
   * fail-soft paths contain it.
   * @param session - the live session to checkpoint.
   * @returns resolution after durability and event emission.
   */
  async write(session: Session): Promise<void> {
    const rows = this.ctx.sessionProjections.checkpoint(session)
    this.markClean(session)
    // Durability barrier: the checkpoint cut was taken above, so flushing
    // AFTER it guarantees every event inside the cut is durably logged
    // before the cache row lands — a crash can leave the cache behind the
    // log (longer tail replay) but never ahead of it (phantom values folded
    // from events no stored log contains). At detach the store entry is
    // already gone; persistence's own retirement drain covers that path and
    // any residual overreach is caught by the cold read's anchored floor.
    if (this.ctx.sessions.get(session.id) === session) await this.ctx.sessions.flush(session)
    await this.put(
      session.id,
      identityOf(session.header, session.inheritedEventCount),
      rows,
      'owned',
    )
  }

  /**
   * Cold-read one session's projections from its complete log. Each unit is
   * seeded from the identity-checked cached rows — the registry skips `apply`
   * for the already-folded prefix (events at or below the row's `seq`) — and
   * the refreshed checkpoint is written back (fail-soft, fire-and-forget), so
   * the first cold read creates the cache row and later ones seed from it.
   * The caller supplies the complete log in seq order: this service never
   * consults the persistence layer.
   * @param meta - the stored session header (identity witness).
   * @param inheritedEventCount - exact inherited prefix length for projection initialization and identity.
   * @param events - the session's complete log, in seq order.
   * @returns the projection cut at the log end.
   */
  coldSnapshot(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    events: readonly SessionEvent[],
  ): ProjectionSnapshot {
    const identity = identityOf(meta, inheritedEventCount)
    const restored = this.ctx.sessionProjections.restore(
      this.recordFor(meta.id, identity)?.rows ?? {},
      events,
      SessionLogOffset(0),
      meta,
      inheritedEventCount,
    )
    // Refresh the row so the next cold read seeds from it; fail-soft and
    // fire-and-forget — a failed write-back only costs a longer tail replay.
    void this.put(meta.id, identity, restored.checkpoint, 'borrowed').catch((error: unknown) => {
      this.ctx.logger.warn(`session projection cache: cold-read write-back for "${meta.id}" failed (cache stays stale): ${String(error)}`)
    })
    return restored.snapshot
  }

  /**
   * Bound the always-resident checkpoint set to {@link Config.maxRetainedBytes}.
   *
   * The storage domain materializes every stored record at open, so a long
   * history costs heap for records nothing can use. Records rank by their
   * highest checkpoint seq (the recency proxy: a Session that commits further
   * has a newer row); the newest stay complete until the budget is reached.
   * Every remaining record is then REPLACED by a lightweight record that keeps
   * its identity and only the listing hint rows (`title`, `sessionListMetadata`)
   * — the zero-I/O list face can still name and order the Session — and a
   * record with no listing hint row is deleted. A retained record keeps every
   * row, so `readWindow`'s complete-checkpoint gate and cached reads are
   * unchanged for it; a dropped fold row only costs a longer cold replay, never
   * a value.
   *
   * The pass runs in the background after init, sizes records only as it
   * reaches them, yields to the event loop while it scans, and never rejects:
   * a failed replace or delete warns and the pass continues, and a closed
   * domain ends it. A record rewritten by a live Session while the pass runs is
   * left alone (the ranked reference no longer matches), so the pass never
   * clobbers a fresher checkpoint. The newest record is always retained, so a
   * deployment whose single newest record exceeds the budget still keeps one
   * complete checkpoint.
   */
  private async boundRetainedBytes(): Promise<void> {
    const table = this.table
    /* v8 ignore next -- Service.init assigns the table before this pass starts */
    if (table === undefined) return
    /* v8 ignore next -- Config resolves maxRetainedBytes to its default before construction */
    const budget = this.config.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES
    let ranked: { id: SessionId; record: CheckpointRecord; seq: number }[]
    try {
      ranked = [...table.entries()]
        .map(([id, record]) => ({ id, record, seq: newestSeq(record.rows) }))
        .sort((left, right) => right.seq - left.seq || left.id.localeCompare(right.id))
    } catch (error: unknown) {
      /* v8 ignore start -- fail-soft scan fault; the suite has no fault-injecting domain */
      this.ctx.logger.warn(`session projection cache: retained-byte scan failed (cache stays complete): ${String(error)}`)
      return
      /* v8 ignore stop */
    }
    let retainedBytes = 0
    let retained = 0
    let lightened = 0
    let lightBytes = 0
    let droppedBytes = 0
    let deleted = 0
    let reclaimed = 0
    let scanned = 0
    let withinBudget = true
    for (const entry of ranked) {
      scanned += 1
      if (scanned % BUDGET_YIELD_INTERVAL === 0) await yieldToEventLoop()
      const record = table.get(entry.id)
      // A live Session's checkpoint write replaced this record since the scan:
      // keep the fresh complete checkpoint instead of an older lightweight cut.
      /* v8 ignore next -- interleaving a live checkpoint write with the startup pass is not reachable from the suite */
      if (record === undefined || record !== entry.record) continue
      const bytes = jsonBytes(record.rows)
      if (withinBudget && (retained === 0 || retainedBytes + bytes <= budget)) {
        retainedBytes += bytes
        retained += 1
        continue
      }
      withinBudget = false
      const light = listHintRows(record.rows)
      if (light === undefined) {
        try {
          // `delete` is idempotent; the record was read from this table moments
          // ago, so a missing key would only mean a concurrent delete.
          await table.delete(entry.id)
          deleted += 1
          reclaimed += bytes
        } catch (error: unknown) {
          /* v8 ignore start -- fail-soft domain close; the suite has no fault-injecting domain */
          if (this.table === undefined) return
          this.ctx.logger.warn(`session projection cache: delete of "${entry.id}" failed (record kept): ${String(error)}`)
          /* v8 ignore stop */
        }
        continue
      }
      const keptBytes = jsonBytes(light)
      if (keptBytes === bytes) {
        // Written lightweight by an earlier pass: account it without rewriting.
        lightened += 1
        lightBytes += keptBytes
        continue
      }
      try {
        await table.put(entry.id, { identity: { ...record.identity }, rows: light })
        lightened += 1
        lightBytes += keptBytes
        droppedBytes += bytes - keptBytes
      } catch (error: unknown) {
        /* v8 ignore start -- fail-soft domain close; the suite has no fault-injecting domain */
        if (this.table === undefined) return
        this.ctx.logger.warn(`session projection cache: lightweight replace of "${entry.id}" failed (record kept complete): ${String(error)}`)
        /* v8 ignore stop */
      }
    }
    if (retained > 0 || lightened > 0 || deleted > 0) {
      this.ctx.logger.info(
        `session projection cache: retained ${String(retained)} records (${String(retainedBytes)} bytes) within the ${String(budget)}-byte budget; `
        + `pruned ${String(deleted)} records (${String(reclaimed)} bytes)`
        + (lightened === 0
          ? ''
          : `; kept lightweight list rows for ${String(lightened)} records (${String(lightBytes)} bytes), dropping ${String(droppedBytes)} bytes of fold state`),
      )
    }
  }


  // --- write-behind (throttle + mandatory points) ---

  private installWritePath(): void {
    // Every committed event advances the dirty counter; turn/end is a
    // mandatory point (the durable value most reads want is the turn-final
    // one), count/interval throttle the in-turn stream.
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type === 'turn/end') {
        void this.flushSoft(session, 'turn/end')
        return
      }
      const state = this.dirty.get(session) ?? { pending: 0, timer: undefined }
      this.dirty.set(session, state)
      state.pending += 1
      if (state.pending >= this.config.writeEveryEvents) {
        void this.flushSoft(session, 'count threshold')
        return
      }
      state.timer ??= setTimeout(() => {
        void this.flushSoft(session, 'interval')
      }, this.config.writeIntervalMs)
    })

    // Creation is the FIRST mandatory point: a session that never talks (a
    // forked child seeded with its ancestor's title, say) would otherwise
    // get its first row only at detach — so a crash, or a fork held live in
    // the store, would leave the seed-derived values (the title) unreadable
    // on the cold list. The creation write captures the seed-derived cut.
    this.ctx.on('session/created', (session: Session) => {
      void this.flushSoft(session, 'create')
    })

    // Detach (the live-to-cold moment): the final mandatory point. After
    // this write the cold-read ladder serves the session from the cache.
    // flushSoft's synchronous prefix reads and resets the dirty state, so
    // dropping it (timer already cleared by markClean) right after is safe.
    this.ctx.on('session/disposed', (session: Session) => {
      void this.flushSoft(session, 'detach')
      this.markClean(session)
      this.dirty.delete(session)
    })

    // With the plugin (their sessions outlive the cache): clear pending
    // timers and stop accepting new work. The domain-close effect registered
    // in init runs after this disposer and drains already-queued writes, so
    // a late flush can never land after disposal (it rejects `closed` into
    // flushSoft's warning instead).
    this.ctx.effect(() => () => {
      for (const state of this.dirty.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer)
      }
      this.dirty.clear()
    }, 'sessionProjectionCache.timers')
  }

  /**
   * One fail-soft durable checkpoint. Every caller has work by construction:
   * the throttle triggers only fire dirty (markClean clears the timer with
   * the counter) and the mandatory points write unconditionally.
   */
  private async flushSoft(session: Session, trigger: string): Promise<void> {
    try {
      await this.write(session)
    } catch (error) {
      this.ctx.logger.warn(`session projection cache: ${trigger} write for "${session.id}" failed (cache stays stale): ${String(error)}`)
    }
  }

  /** Reset one session's dirty bookkeeping (its checkpoint is being written). */
  private markClean(session: Session): void {
    const state = this.dirty.get(session)
    if (state === undefined) return
    state.pending = 0
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  /** Registry checkpoints are owned clones; cold restoration can share state with the returned view. */
  private async put(
    id: SessionId,
    identity: CheckpointIdentity,
    rows: ProjectionCheckpoint,
    ownership: 'owned' | 'borrowed',
  ): Promise<void> {
    const detached = ownership === 'borrowed' ? snapshotJsonValue(rows) : rows
    if (detached === undefined || ownership === 'owned' && !isJsonValue(detached)) {
      throw new TypeError('projection checkpoint is not losslessly JSON-serializable (a unit state violates the plain-JSON contract)')
    }
    await this.requireTable().put(id, { identity, rows: detached as CheckpointRecord['rows'] })
  }

  private requireTable(): KvTable<SessionId, CheckpointRecord> {
    /* v8 ignore next -- Service.init assigns the table before the service becomes injectable */
    if (this.table === undefined) throw new Error('session projection cache is not initialized')
    return this.table
  }
}

/** Project a header onto the identity fields a header alone can witness. */
function lifecycleIdentityOf(header: SessionHeader): LifecycleIdentity {
  return {
    formatVersion: header.version,
    createdAt: header.createdAt,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    isSeeded: header.isSeeded,
  }
}

/** Project a header and its exact inherited cut onto the complete fold identity. */
function identityOf(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
): CurrentCheckpointIdentity {
  const cut = SessionLogOffset(inheritedEventCount)
  if (!header.isSeeded && cut !== 0) {
    throw new Error('unseeded projection-cache identity inherited event count must be 0')
  }
  return { ...lifecycleIdentityOf(header), inheritedEventCount: cut }
}

/**
 * Whether a stored record may seed the caller's fold: the current format
 * generation, the same lifecycle, and the same inherited cut. A record folded
 * under another cut encodes that cut in unit states (`schedule`,
 * `subagentCatalog`, `permissions`) and would carry it into the continued
 * fold and the next checkpoint. Absent lineage fields (records admitted via
 * `compatibleVersions` predate them) read as the unseeded lineage: exact for
 * an unseeded caller, while a seeded caller fails the match.
 */
function identityMatches(stored: CheckpointIdentity, expected: CurrentCheckpointIdentity): boolean {
  return currentLifecycleMatches(stored, expected)
    && (stored.inheritedEventCount ?? 0) === expected.inheritedEventCount
}

/**
 * Whether a stored record was folded from the caller's lifecycle at the
 * current Session format. An absent format generation cannot prove the fold
 * semantics and never matches. This is the whole identity a header-only
 * reader can check, and the whole identity a view needs.
 */
function currentLifecycleMatches(stored: CheckpointIdentity, expected: LifecycleIdentity): boolean {
  return stored.formatVersion === expected.formatVersion
    && lifecycleIdentityMatches(stored, expected)
}

/** Match one predecessor cache record to the authoritative listed lifecycle. */
function predecessorIdentityMatches(
  stored: CheckpointIdentity,
  expected: LifecycleIdentity,
): boolean {
  const predecessor = stored.formatVersion === undefined
    || stored.formatVersion < expected.formatVersion
  return predecessor && lifecycleIdentityMatches(stored, expected)
}

/** Match the format-independent fields that distinguish one Session lifecycle. */
function lifecycleIdentityMatches(
  stored: CheckpointIdentity,
  expected: LifecycleIdentity,
): boolean {
  return stored.createdAt === expected.createdAt
    && stored.cwd === expected.cwd
    && (stored.isSeeded ?? false) === expected.isSeeded
}

/**
 * Highest checkpoint watermark in one record, the retention plan's recency
 * proxy: a Session that committed further has a newer row. An empty record
 * ranks below every written one.
 * @param rows - The record's checkpoint rows.
 * @returns The highest row seq, or -1 when the record has no rows.
 */
function newestSeq(rows: CheckpointRecord['rows']): number {
  let newest = -1
  for (const row of Object.values(rows)) if (row.seq > newest) newest = row.seq
  return newest
}

/**
 * The listing hint rows a record keeps once it falls outside the retained-byte
 * budget. Any other row is fold state that only an opened Session reads, so it
 * is dropped; the value of a dropped row is never lost, only its fold shortcut.
 * @param rows - The record's complete checkpoint rows.
 * @returns A record holding only the present listing hint rows, or `undefined`
 *   when the record carries none (nothing names the Session without a fold).
 */
function listHintRows(rows: CheckpointRecord['rows']): CheckpointRecord['rows'] | undefined {
  const kept: CheckpointRecord['rows'] = {}
  for (const key of LIST_HINT_KEYS) {
    const row = rows[key]
    if (row !== undefined) kept[key] = row
  }
  return Object.keys(kept).length === 0 ? undefined : kept
}

/**
 * UTF-8 size of one serialized rows object; the retention budget's unit.
 * Every row is validated plain JSON, so stringification is total.
 * @param value - A record's rows object.
 * @returns Its UTF-8 byte count.
 */
function jsonBytes(value: unknown): number {
  // Stored rows passed the lossless-JSON write check, so stringification yields text.
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/**
 * Yield to the event loop between budget-pass chunks so bounding a large
 * history cannot stall the caller in one long synchronous pass.
 * @returns Resolution on the next immediate turn.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve) })
}

export default SessionProjectionCache
