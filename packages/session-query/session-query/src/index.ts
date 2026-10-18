/**
 * Service Definition for combined session-history reads, traces, filters, and full-text search.
 *
 * @module @deepseek-ai/dsh-session-query
 */

import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  Session,
  SessionLogOffset,
  SessionSeq,
  snapshotSessionEvent,
  type SessionId,
  type SessionSeq as SessionSeqType,
} from '@deepseek-ai/dsh-session'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title'
import type { SessionWindowRequest } from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {
  SessionEventResultFilter,
  SessionEventSearchPage,
  SessionEventReadRequest,
  SessionEventRecord,
  SessionEventSearchDocument,
  SessionEventSearchRequest,
  SessionEventTraceObservation,
  SessionEventTraceRequest,
  SessionEventWindow,
  SessionLineageTrace,
  SessionLogSnapshot,
  SessionRecord,
  SessionResultFilter,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
  SessionSurfaceSnapshot,
  SessionTitleObservation,
  SessionTitleObservationResult,
  SessionWindowRead,
} from './types.ts'
import {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_MAX_ARTIFACT_BYTES,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  type Config,
} from './config.ts'
import { SessionCorpus } from './corpus.ts'
import {
  SessionObservationReader,
  type SessionObservation,
  type SessionObservationOptions,
} from './observation.ts'
import { buildSessionEventSearchDocuments } from './documents.ts'
import {
  filterSessionEventDocuments,
  filterSessionResults,
  materializeSessionEventResultFilters,
  materializeSessionResultFilters,
} from './filters.ts'
import * as tracing from './tracing.ts'

export type * from './types.ts'
export { SessionSearchCursor } from './cursor.ts'
export type { Config, SessionQueryErrorCode } from './config.ts'
export {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_MAX_ARTIFACT_BYTES,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
} from './config.ts'
export { readColdSessionLog } from './cold-read.ts'
export type { ColdSessionLog } from './cold-read.ts'
export { extractSessionEventText } from './extraction.ts'
export {
  buildAppendedSessionEventSearchDocuments,
  buildSessionEventRecords,
  buildSessionEventSearchDocuments,
} from './documents.ts'
export {
  compileSessionTextFilter,
  filterSessionEventDocuments,
  filterSessionResults,
  materializeSessionEventResultFilters,
  materializeSessionResultFilters,
} from './filters.ts'
export { assertSessionHeadersCompatible } from './sources.ts'
export type { SessionObservation, SessionObservationOptions } from './observation.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionQuery: SessionQueryEngine
  }
}

/**
 * Unified live-preferred session query service.
 *
 * Exact reads, filters, and traces are backend-independent concrete behavior.
 * A backend implements full-text observation, reconciliation, ranking, cursor
 * generations, and query execution on the same `ctx.sessionQuery` service.
 */
export abstract class SessionQueryEngine extends Service {
  static inject = ['sessions']

  private readonly _readWindowMax: number
  private readonly _corpus: SessionCorpus
  private readonly _observations: SessionObservationReader

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionQuery')
    this._readWindowMax = config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX
    if (!Number.isInteger(this._readWindowMax) || this._readWindowMax < 0) {
      throw new SessionQueryError(
        'session-query: readWindowMax must be a non-negative integer',
        'SESSION_QUERY_INVALID_CONFIG',
      )
    }
    const persistedReadConcurrency = config.persistedReadConcurrency
      ?? SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY
    if (!Number.isSafeInteger(persistedReadConcurrency) || persistedReadConcurrency < 1) {
      throw new SessionQueryError(
        'session-query: persistedReadConcurrency must be a positive safe integer',
        'SESSION_QUERY_INVALID_CONFIG',
      )
    }
    const preparedSessionCacheSize = config.preparedSessionCacheSize
      ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE
    if (!Number.isSafeInteger(preparedSessionCacheSize) || preparedSessionCacheSize < 1) {
      throw new SessionQueryError(
        'session-query: preparedSessionCacheSize must be a positive safe integer',
        'SESSION_QUERY_INVALID_CONFIG',
      )
    }
    const preparedSessionCacheMaxArtifactBytes = config.preparedSessionCacheMaxArtifactBytes
      ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_MAX_ARTIFACT_BYTES
    if (!Number.isSafeInteger(preparedSessionCacheMaxArtifactBytes) || preparedSessionCacheMaxArtifactBytes < 0) {
      throw new SessionQueryError(
        'session-query: preparedSessionCacheMaxArtifactBytes must be a non-negative safe integer',
        'SESSION_QUERY_INVALID_CONFIG',
      )
    }
    this._corpus = new SessionCorpus(ctx, persistedReadConcurrency)
    this._observations = new SessionObservationReader(ctx, preparedSessionCacheSize, preparedSessionCacheMaxArtifactBytes)
  }

  /**
   * Observe one exact live or prepared Session without a persistence listing preflight.
   * @param sessionId - logical Session identity.
   * @param options - cancellation and projection selection for this read.
   * @returns a caller-owned observation lease.
   */
  observeSession(
    sessionId: SessionId,
    options: SessionObservationOptions = {},
  ): Promise<SessionObservation> {
    return this._observations.read(sessionId, options)
  }

  /**
   * Read one bounded stored-history window through the persistence backend's
   * optional generation index, with the stored projection checkpoint when that
   * checkpoint is a complete baseline for the window.
   *
   * Backends without `readWindow` return nothing here, and callers fall back to
   * the full observation path. A window validates its own rows, not the
   * complete log's cross-event relationships; exact replay consumers keep
   * using {@link readSession}. The baseline is attached only when it does not
   * lead the window `cursor` and carries every registered client-visible key;
   * a baseline missing either condition is omitted; a parent-Session follow
   * opener then serves the window without an exact block instead of falling
   * back to the complete observation, while a subagent address still requires it.
   * @param sessionId - stored session to read.
   * @param request - optional cancellation, upper bound, and backwards cursor.
   * @returns the window plus its complete checkpoint projection baseline, or
   *   `undefined` when the backend cannot serve a validated window.
   */
  async readWindow(
    sessionId: SessionId,
    request: SessionWindowRequest = {},
  ): Promise<SessionWindowRead | undefined> {
    const persistence = this.ctx.get('sessionPersistence')
    const window = await persistence?.readWindow?.(sessionId, request)
    request.signal?.throwIfAborted()
    if (window === undefined) return undefined
    if (window.header.id !== sessionId) {
      throw new SessionQueryError(
        `session persistence returned "${window.header.id}" for "${sessionId}"`,
        'SESSION_QUERY_SOURCE_CONFLICT',
      )
    }
    const checkpoint = this.ctx.get('sessionProjectionCache')?.cachedSnapshot(window.header)
    const projections = checkpoint !== undefined && this._baselineComplete(checkpoint, window.cursor)
      ? checkpoint
      : undefined
    return { window, ...projections === undefined ? {} : { projections } }
  }

  /**
   * Search the live-preferred logical corpus and group by session.
   * @param request - query text, metadata filters, page size, and cursor.
   * @param exec - optional cancellation control.
   * @returns session hits ranked by their strongest matching event.
   */
  abstract searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>>

  /**
   * Search events within one live-preferred logical session.
   * @param request - target session, query text, filters, page size, and cursor.
   * @param exec - optional cancellation control.
   * @returns matching event hits and their target header from one indexed generation.
   */
  abstract searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage>

  /**
   * List the complete logical corpus using live-preferred records.
   * @param signal - optional cancellation for persistence listing.
   * @param options - session ids excluded before per-session reads (archived Sessions), and whether subagent Sessions are omitted.
   * @returns deterministic newest-first cloned session records.
   */
  listSessions(signal?: AbortSignal, options?: {
    readonly excludeSessionIds?: ReadonlySet<SessionId>
    readonly excludeSubagentSessions?: boolean
  }): Promise<SessionRecord[]> {
    return this._corpus.listSessions(signal, options)
  }

  /**
   * Read and replay-validate one complete logical session log without making it live.
   * @param sessionId - live or persisted session id to read.
   * @returns cloned header and complete raw event log from one observation.
   * @throws when persistence, header compatibility, or replay validation fails.
   */
  async readSession(sessionId: SessionId): Promise<SessionLogSnapshot> {
    const loaded = await this._corpus.load(sessionId)
    Session.create(
      sessionId,
      loaded.events,
      loaded.header,
      loaded.inheritedEventCount,
      currentSessionMessageProjections,
    )
    return {
      session: structuredClone(loaded.header),
      inheritedEventCount: loaded.inheritedEventCount,
      events: loaded.events.map(snapshotSessionEvent),
    }
  }

  /**
   * Filter the complete logical corpus with provider-independent predicates.
   * @param filters - ANDed session metadata and availability clauses.
   * @param signal - optional cancellation for persistence listing.
   * @returns matching cloned records in deterministic newest-first order.
   */
  async filterSessions(
    filters: readonly SessionResultFilter[],
    signal?: AbortSignal,
  ): Promise<SessionRecord[]> {
    const ownedFilters = materializeSessionResultFilters(filters)
    return this._filterSessions(ownedFilters, signal)
  }

  /**
   * Fold the latest log-backed title from one live-preferred logical session.
   * @param sessionId - live or persisted session id to read.
   * @param signal - optional cancellation for source resolution and title folding.
   * @returns latest title snapshot, or `undefined` when the log has no title event.
   */
  async readTitle(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionTitleSnapshot | undefined> {
    return (await this.readTitleSnapshot(sessionId, signal)).title
  }

  /**
   * Fold the latest title and return its source header from one corpus observation.
   * @param sessionId - live or persisted session id to read.
   * @param signal - optional cancellation for source resolution and title folding.
   * @returns cloned source header and optional latest title snapshot.
   */
  async readTitleSnapshot(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionTitleObservation> {
    const result = (await this.readTitleSnapshots([sessionId], signal))[0] as SessionTitleObservationResult
    if (result.status === 'rejected') throw result.reason
    return result.value
  }

  /**
   * Fold titles for unique sessions from one cancellable corpus observation.
   *
   * Results preserve first-occurrence input order. Operational failures stay
   * isolated per session, while cancellation rejects the complete operation.
   * @param sessionIds - live or persisted session ids to observe.
   * @param signal - optional cancellation shared by all source reads.
   * @returns one fulfilled or rejected result per unique requested id.
   */
  async readTitleSnapshots(
    sessionIds: readonly SessionId[],
    signal?: AbortSignal,
  ): Promise<SessionTitleObservationResult[]> {
    return this._corpus.projectMany(sessionIds, (source): SessionTitleObservation => {
      const title = foldSessionTitle(source.events)
      return {
        session: structuredClone(source.header),
        ...title === undefined ? {} : { title },
      }
    }, signal)
  }

  /**
   * List lightweight raw-log event records for one logical session.
   * @param sessionId - live-preferred session id to read.
   * @returns event records in ascending seq order.
   */
  async listEvents(sessionId: SessionId): Promise<SessionEventRecord[]> {
    const loaded = await this._corpus.load(sessionId)
    return tracing.eventRecords(sessionId, loaded.events)
  }

  /**
   * Scan first-party semantic event documents with provider-independent filters.
   * @param sessionId - live-preferred session id to scan.
   * @param filters - ANDed metadata and literal-text predicates.
   * @returns matching semantic documents in ascending seq order.
   */
  async filterEvents(
    sessionId: SessionId,
    filters: readonly SessionEventResultFilter[],
  ): Promise<SessionEventSearchDocument[]> {
    const ownedFilters = materializeSessionEventResultFilters(filters)
    return this._filterEvents(sessionId, ownedFilters)
  }

  private async _filterSessions(
    filters: readonly SessionResultFilter[],
    signal?: AbortSignal,
  ): Promise<SessionRecord[]> {
    return filterSessionResults(await this._corpus.listSessions(signal), filters)
  }

  private async _filterEvents(
    sessionId: SessionId,
    filters: readonly SessionEventResultFilter[],
  ): Promise<SessionEventSearchDocument[]> {
    const loaded = await this._corpus.load(sessionId)
    const documents = buildSessionEventSearchDocuments(sessionId, loaded.events)
    return filterSessionEventDocuments(documents, filters)
  }

  /**
   * Read one session's complete current model surface from one corpus observation.
   * @param sessionId - live-preferred session id to read.
   * @returns cloned header, current surface, and the last sequence number included in the raw-log capture.
   * @throws when source resolution fails or the session surface is invalid.
   */
  async readSurface(sessionId: SessionId): Promise<SessionSurfaceSnapshot> {
    const loaded = await this._corpus.load(sessionId)
    return {
      session: structuredClone(loaded.header),
      inheritedEventCount: loaded.inheritedEventCount,
      capturedThroughSeq: loaded.events.at(-1)?.seq ?? null,
      events: tracing.currentSurfaceEvents(sessionId, loaded.events),
    }
  }

  /**
   * Trace known ancestry and descendants from one corpus observation.
   * @param sessionId - logical session id to trace.
   * @param signal - optional cancellation for persistence listing.
   * @returns a complete lineage or the first parent that could not be resolved.
   * @throws when corpus resolution fails, the target is absent, or its known ancestry cycles.
   */
  async traceSession(sessionId: SessionId, signal?: AbortSignal): Promise<SessionLineageTrace> {
    const records = await this._corpus.listSessions(signal)
    signal?.throwIfAborted()
    return tracing.traceSession(records, sessionId)
  }

  /**
   * Trace one event's direct positional replacements and cited source events.
   * @param request - target session id and event seq.
   * @param signal - optional cancellation for persisted source resolution.
   * @returns source header, direct links, and the target's positional replacement chain.
   * @throws when source resolution fails, the target is absent, or surface/source-event validation fails.
   */
  async traceEvent(request: SessionEventTraceRequest, signal?: AbortSignal): Promise<SessionEventTraceObservation> {
    const loaded = await this._corpus.load(request.sessionId, signal)
    signal?.throwIfAborted()
    return {
      session: loaded.header,
      ...tracing.traceEvent(request.sessionId, loaded.events, request.seq),
    }
  }

  /**
   * Read one full event plus a bounded raw-log context window.
   * @param request - target session/seq and context sizes.
   * @param signal - optional cancellation for persisted source resolution.
   * @returns cloned target and neighboring events.
   */
  async readEvent(request: SessionEventReadRequest, signal?: AbortSignal): Promise<SessionEventWindow> {
    const before = this._readWindow('before', request.before)
    const after = this._readWindow('after', request.after)
    const sessionId = request.sessionId
    const seq = request.seq
    return this._readEvent(sessionId, seq, before, after, signal)
  }

  private async _readEvent(
    sessionId: SessionId,
    seq: SessionSeqType,
    before: number,
    after: number,
    signal?: AbortSignal,
  ): Promise<SessionEventWindow> {
    const live = this._corpus.liveSession(sessionId)
    if (live !== undefined) {
      // A live Session already owns its log in this process, so the requested
      // cut and its bounded neighbors are detached directly. Reading through a
      // corpus load here would deep-clone the complete log for one window.
      signal?.throwIfAborted()
      return this._liveEventWindow(sessionId, live, seq, before, after)
    }
    const loaded = await this._corpus.load(sessionId, signal)
    signal?.throwIfAborted()
    const target = loaded.events[seq]
    if (target === undefined || target.seq !== seq) {
      throw new SessionQueryError(
        `session "${sessionId}" has no event at seq ${seq}`,
        'SESSION_QUERY_EVENT_NOT_FOUND',
      )
    }
    const startSeq = SessionSeq(Math.max(0, seq - before))
    const endSeq = SessionSeq(Math.min(loaded.events.length - 1, seq + after))
    const targetSnapshot = snapshotSessionEvent(target)
    const events = loaded.events.slice(startSeq, endSeq + 1)
      .map(event => event === target
        ? targetSnapshot
        : snapshotSessionEvent(event))
    return {
      session: structuredClone(loaded.header),
      inheritedEventCount: loaded.inheritedEventCount,
      target: targetSnapshot,
      events,
      startSeq,
      endSeq,
    }
  }

  /**
   * Detach the target event and its bounded neighbors straight from a live log.
   * @param sessionId - session identity used in the not-found diagnostic.
   * @param session - live Session holding the authoritative log.
   * @param seq - exact target event sequence number.
   * @param before - earlier neighbor count, validated by {@link readEvent}.
   * @param after - later neighbor count, validated by {@link readEvent}.
   * @returns the detached header, target, and bounded window.
   * @throws {@link SessionQueryError} with code `SESSION_QUERY_EVENT_NOT_FOUND`
   *   when the log has no event at `seq`.
   */
  private _liveEventWindow(
    sessionId: SessionId,
    session: Session,
    seq: SessionSeqType,
    before: number,
    after: number,
  ): SessionEventWindow {
    // oxlint-disable-next-line typescript/no-deprecated -- Bounded live read: only the requested window is detached.
    const target = session.eventAt(seq)
    if (target === undefined || target.seq !== seq) {
      throw new SessionQueryError(
        `session "${sessionId}" has no event at seq ${seq}`,
        'SESSION_QUERY_EVENT_NOT_FOUND',
      )
    }
    const startSeq = SessionSeq(Math.max(0, seq - before))
    const endSeq = SessionSeq(Math.min(session.seq - 1, seq + after))
    const targetSnapshot = snapshotSessionEvent(target)
    // Bounded live read: slice the requested window out of the log instead of
    // materializing the complete event array.
    // oxlint-disable-next-line typescript/no-deprecated -- see above
    const window = session.snapshotEvents(SessionLogOffset(startSeq), SessionLogOffset(endSeq + 1))
    return {
      session: structuredClone(session.header),
      inheritedEventCount: session.inheritedEventCount,
      target: targetSnapshot,
      events: window.map(event => event === target ? targetSnapshot : snapshotSessionEvent(event)),
      startSeq,
      endSeq,
    }
  }

  private _readWindow(name: 'before' | 'after', value: number | undefined): number {
    if (value === undefined) return 0
    if (!Number.isInteger(value) || value < 0 || value > this._readWindowMax) {
      throw new SessionQueryError(
        `${name} must be an integer between 0 and ${this._readWindowMax}`,
        'SESSION_QUERY_INVALID_WINDOW',
      )
    }
    return value
  }

  /**
   * Whether one cached checkpoint is a complete projection baseline for a
   * stored window: it must not lead the window cursor and must carry a value
   * for every registered client-visible key. Without a mounted registry there
   * is no key set to prove completeness against, so only the watermark rule
   * applies. A checkpoint ahead of the window cannot describe it (detach-drain
   * crash, torn-tail repair, restored log); a partial checkpoint would clear
   * the client values of the keys it omits.
   * @param checkpoint - cache block served for the window's Session header.
   * @param cursor - last stored seq the window serves.
   * @returns whether a history opener may seed client values from the block.
   */
  private _baselineComplete(checkpoint: ProjectionSnapshot, cursor: number): boolean {
    if (checkpoint.asOfSeq > cursor) return false
    const registry = this.ctx.get('sessionProjections')
    return registry === undefined
      || registry.wireKeys().every(key => Object.hasOwn(checkpoint.values, key))
  }
}

export default SessionQueryEngine
