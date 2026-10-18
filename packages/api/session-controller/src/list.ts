/** Cold-safe Session list and search projection. */

import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  SessionQueryError,
  type SessionRecord,
  type SessionSearchCursor,
  type SessionTitleObservationResult,
} from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './types.ts'
import type {
  SessionListMetadata, SessionProjectionHints, SessionProjectionValues, SessionSearchItem,
  SessionSearchValue, SessionSummary,
} from './types.ts'

const SEARCH_PROVIDER_CALL_LIMIT = 100
const SESSION_SEARCH_QUERY_MAX_CHARS = 500
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * Largest stored artifact a listing may fold only to name its row. A title
 * read decodes the complete log, so this bound keeps that work off the list
 * path for every large history; such a row stays unnamed.
 */
const COLD_TITLE_BACKFILL_MAX_BYTES = 2 * 1024 * 1024

/**
 * Most cold rows one listing may name this way, newest first in query order.
 * Each candidate costs one bounded full-log fold, so a listing pays a fixed
 * ceiling instead of one read per unnamed row.
 */
const COLD_TITLE_BACKFILL_ROW_LIMIT = 16

/**
 * Titles retained per listing instance, keyed by Session. A repeat listing of
 * the same unchanged artifact then costs its stat but no fold; the bound keeps
 * the memo proportional to the rows a deployment can show, never to history.
 */
const COLD_TITLE_MEMO_LIMIT = 64

/** Concurrent metadata reads while judging which candidates are small enough. */
const COLD_TITLE_BACKFILL_STAT_CONCURRENCY = 4

const sessionListMetadataSchema: z.ZodType<SessionListMetadata> = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

const imageLimitsSchema = z.object({
  maxImageBytes: z.number().int().positive(),
  maxImagesPerMessage: z.number().int().positive(),
  maxMessageImageBytes: z.number().int().positive(),
  maxImagePixels: z.number().int().positive(),
  maxImageDimension: z.number().int().positive(),
  mediaTypes: z.array(z.string()),
}) as unknown as z.ZodType<ImageAttachmentLimits>

/**
 * Advance the Session-list metadata projection by one committed event.
 * @param state - metadata before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced metadata value.
 */
export function applySessionListMetadata(
  state: SessionListMetadata,
  event: SessionEvent,
): SessionListMetadata {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/**
 * Return the longest prefix containing at most `maximum` Unicode code points.
 * @param value - source text.
 * @param maximum - maximum number of Unicode code points.
 * @returns the source text or its longest allowed prefix.
 */
export function truncateUnicodeCodePoints(value: string, maximum: number): string {
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end)
    count++
    end += codePoint.length
  }
  return value
}

/** Owns list projection registration, bounded cold summaries, and authorized search. */
export class ApiSessionList {
  /**
   * @param ctx - Host context carrying Session, query, persistence, and projection services.
   * @param workSliceMs - Resolved positive integral list-work budget in milliseconds.
   * @param excludedProjectionKeys - deployment-selected keys omitted before rendering catalog hints.
   */
  constructor(
    private readonly ctx: Context,
    private readonly workSliceMs: number,
    private readonly excludedProjectionKeys: ReadonlySet<string> = new Set(),
  ) {
    ctx.sessionProjections.register<'sessionListMetadata', SessionListMetadata>({
      key: 'sessionListMetadata',
      stateSchema: sessionListMetadataSchema,
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: applySessionListMetadata,
      wire: { viewSchema: sessionListMetadataSchema, view: state => state },
      stateVersion: 1,
    })
    ctx.inject(['attachments'], (attachmentCtx) => {
      ctx.sessionProjections.register<'imageLimits', null>({
        key: 'imageLimits',
        stateSchema: z.null(),
        init: () => null,
        apply: state => state,
        wire: {
          viewSchema: imageLimitsSchema,
          view: () => attachmentCtx.attachments.imageLimits,
        },
        stateVersion: 1,
      })
    })
  }

  /**
   * Successful title folds keyed by Session, guarded by the artifact size that
   * produced them. A grown or replaced log no longer matches and is refolded.
   */
  private readonly coldTitles = new Map<SessionId, { readonly sizeBytes: number; readonly hint: SessionProjectionHints }>()

  /**
   * Build one current attached-Session summary.
   * @param session - attached Session to summarize.
   * @returns current list metadata and available projections.
   */
  summaryFor(session: Session): SessionSummary {
    const projections = this.projectionsFor(session.header, session)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: session.id,
      updatedAt: updatedAt(session.header, metadata),
      agentAvailable: this.ctx.agents.get(session.id)?.session === session,
      formatStatus: 'current',
      running: this.ctx.agents.get(session.id)?.status === 'running',
      blank: metadata?.blank ?? session.seq === 0,
      ...listFields(session.header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Read every visible attached and persisted Session without activating an Agent.
   * @param signal - optional cancellation for persistence reads and summary generation.
   * @param options - when `includeArchived` is true, archived Sessions are listed too.
   * @returns visible Session summaries ordered by activity.
   */
  async list(signal?: AbortSignal, options?: { readonly includeArchived?: boolean }): Promise<SessionSummary[]> {
    signal?.throwIfAborted()
    const registry = options?.includeArchived === true ? undefined : this.ctx.get('workspaceRegistry')
    const archived = registry?.archivedSessionIds
    const excludeSessionIds = archived === undefined || archived.length === 0 ? undefined : new Set(archived)
    // Subagent rows are reached through their parent's catalog, never through
    // this list; excluding them there keeps the pull to ordinary Sessions.
    const records = await this.ctx.sessionQuery.listSessions(signal, {
      ...(excludeSessionIds === undefined ? {} : { excludeSessionIds }),
      excludeSubagentSessions: true,
    })
    signal?.throwIfAborted()
    const items: SessionSummary[] = []
    const cold: SessionRecord[] = []
    const coldBlocks = new Map<SessionId, SessionProjectionHints | undefined>()
    let yieldDeadline = performance.now() + this.workSliceMs
    for (const record of records) {
      signal?.throwIfAborted()
      const live = this.ctx.sessions.get(record.header.id)
      if (live !== undefined) {
        items.push(this.summaryFor(live))
      } else if (record.header.cwd !== undefined) {
        cold.push(record)
      }
      if (performance.now() >= yieldDeadline) {
        await scheduler.yield()
        signal?.throwIfAborted()
        yieldDeadline = performance.now() + this.workSliceMs
      }
    }
    for (const record of cold) {
      signal?.throwIfAborted()
      coldBlocks.set(record.header.id, this.projectionsFor(record.header, undefined))
      if (performance.now() >= yieldDeadline) {
        await scheduler.yield()
        signal?.throwIfAborted()
        yieldDeadline = performance.now() + this.workSliceMs
      }
    }
    // Cache first: only rows the cache could not name pay the bounded title read.
    const backfilledTitles = await this.coldTitleHints(cold, coldBlocks, signal)
    for (const record of cold) {
      signal?.throwIfAborted()
      const projections = withBackfilledTitle(
        coldBlocks.get(record.header.id),
        backfilledTitles.get(record.header.id),
      )
      items.push(this.summarizeCold(record, projections))
      if (performance.now() >= yieldDeadline) {
        await scheduler.yield()
        signal?.throwIfAborted()
        yieldDeadline = performance.now() + this.workSliceMs
      }
    }
    signal?.throwIfAborted()
    items.sort((left, right) => right.updatedAt - left.updatedAt)
    return items
  }

  /**
   * Fold the latest logged title for cold rows the cache served no title for.
   *
   * The listing never decodes a large Session: a candidate first proves its
   * artifact small through persistence metadata, and only then pays one
   * bounded full-log fold. Candidates and their reads are bounded, one
   * unreadable row never fails the listing, and cancellation stays fatal.
   * @param cold - cold rows in list order (newest first).
   * @param blocks - the cache block already resolved for each cold row.
   * @param signal - cancellation for metadata and log reads.
   * @returns title hints keyed by Session id; empty when nothing was read.
   */
  private async coldTitleHints(
    cold: readonly SessionRecord[],
    blocks: ReadonlyMap<SessionId, SessionProjectionHints | undefined>,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<SessionId, SessionProjectionHints>> {
    const hints = new Map<SessionId, SessionProjectionHints>()
    // The deployment removed title from list hints; a backfilled one would
    // re-introduce exactly the value it excluded.
    if (this.excludedProjectionKeys.has('title')) return hints
    const query = this.ctx.get('sessionQuery')
    const persistence = this.ctx.get('sessionPersistence')
    if (query === undefined || persistence === undefined) return hints
    const candidates: SessionRecord[] = []
    for (const record of cold) {
      if (candidates.length === COLD_TITLE_BACKFILL_ROW_LIMIT) break
      const block = blocks.get(record.header.id)
      // A present key is the cache's answer, including an explicit "no title".
      if (block !== undefined && Object.hasOwn(block.values, 'title')) continue
      candidates.push(record)
    }
    if (candidates.length === 0) return hints
    const sizes = new Map<SessionId, number>()
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        signal?.throwIfAborted()
        const record = candidates[cursor]
        cursor += 1
        if (record === undefined) return
        try {
          const stored = await persistence.stat(record.header.id, signal === undefined ? undefined : { signal })
          const sizeBytes = stored?.sizeBytes
          // An unknown size keeps the row unnamed: the fold's cost is unproven.
          if (sizeBytes !== undefined && sizeBytes <= COLD_TITLE_BACKFILL_MAX_BYTES) sizes.set(record.header.id, sizeBytes)
        } catch (error: unknown) {
          if (signal?.aborted) signal.throwIfAborted()
          this.ctx.logger.warn(
            `api-session.list: title source size for "${record.header.id}" is unavailable; serving the row without it: ${String(error)}`,
          )
        }
      }
    }
    await Promise.allSettled(
      Array.from({ length: Math.min(COLD_TITLE_BACKFILL_STAT_CONCURRENCY, candidates.length) }, worker),
    )
    signal?.throwIfAborted()
    const unmemoized: SessionId[] = []
    for (const record of candidates) {
      const sizeBytes = sizes.get(record.header.id)
      if (sizeBytes === undefined) continue
      const memo = this.coldTitles.get(record.header.id)
      if (memo !== undefined && memo.sizeBytes === sizeBytes) {
        hints.set(record.header.id, memo.hint)
        continue
      }
      // An artifact that changed since the fold keeps no reusable title.
      if (memo !== undefined) this.coldTitles.delete(record.header.id)
      unmemoized.push(record.header.id)
    }
    if (unmemoized.length === 0) return hints
    let observations: readonly SessionTitleObservationResult[]
    try {
      observations = await query.readTitleSnapshots(unmemoized, signal)
    } catch (error: unknown) {
      if (signal?.aborted) signal.throwIfAborted()
      this.ctx.logger.warn(
        `api-session.list: title backfill failed; serving the listed rows without it: ${String(error)}`,
      )
      return hints
    }
    for (const observation of observations) {
      if (observation.status === 'rejected') continue
      const title = observation.value.title
      if (title === undefined) continue
      const hint = {
        kind: 'cached' as const,
        asOfSeq: title.eventSeq,
        values: { title: title.title },
      }
      hints.set(observation.sessionId, hint)
      this.rememberColdTitle(observation.sessionId, sizes.get(observation.sessionId), hint)
    }
    return hints
  }

  /**
   * Retain one successful title fold for the artifact size that produced it.
   * @param sessionId - Session the title was folded for.
   * @param sizeBytes - artifact size that produced the hint, when known.
   * @param hint - the title-only cached hint.
   */
  private rememberColdTitle(
    sessionId: SessionId,
    sizeBytes: number | undefined,
    hint: SessionProjectionHints,
  ): void {
    if (sizeBytes === undefined) return
    this.coldTitles.delete(sessionId)
    if (this.coldTitles.size >= COLD_TITLE_MEMO_LIMIT) {
      const oldest = this.coldTitles.keys().next()
      if (!oldest.done) this.coldTitles.delete(oldest.value)
    }
    this.coldTitles.set(sessionId, { sizeBytes, hint })
  }

  /**
   * Build one cold-Session summary from already resolved projection hints.
   * @param record - listed record for the unattached Session.
   * @param projections - cache block plus any backfilled title hint.
   * @returns the list row.
   */
  private summarizeCold({ header, formatStatus }: SessionRecord, projections: SessionProjectionHints | undefined): SessionSummary {
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: header.id,
      updatedAt: updatedAt(header, metadata),
      agentAvailable: false,
      ...(formatStatus === undefined ? {} : { formatStatus }),
      running: false,
      // A large, metadata-less, or inaccessible cache miss remains unknown and visible.
      blank: metadata?.blank ?? false,
      ...listFields(header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Search current visible message content without activating any matching Session.
   * @param query - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  async search(query: string, signal: AbortSignal): Promise<SessionSearchValue> {
    const normalizedQuery = normalizeSearchQuery(query)
    signal.throwIfAborted()
    const provider = this.ctx.get('sessionQuery')
    if (provider === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query',
        {},
      )
    }
    try {
      const visible = await provider.listSessions(signal)
      signal.throwIfAborted()
      const visibleIds = new Set(visible
        .filter(record => record.header.cwd !== undefined)
        .map(record => record.header.id))
      if (visibleIds.size === 0) return { items: [], hasMore: false }
      const authorized: SessionSearchItem[] = []
      const acceptedIds = new Set<SessionId>()
      const seenCursors = new Set<SessionSearchCursor>()
      let cursor: SessionSearchCursor | undefined
      let providerCalls = 0
      let pageLimit = SESSION_SEARCH_RESULT_LIMIT
      while (authorized.length <= SESSION_SEARCH_RESULT_LIMIT) {
        signal.throwIfAborted()
        if (providerCalls >= SEARCH_PROVIDER_CALL_LIMIT) {
          throw new Error(`session search provider exceeded the ${SEARCH_PROVIDER_CALL_LIMIT}-call work budget`)
        }
        providerCalls++
        const requestedCursor = cursor
        const requestedLimit = pageLimit
        let page
        try {
          page = await provider.searchSessions({
            query: normalizedQuery,
            eventFilters: [
              { kind: 'type', values: ['user/message', 'assistant/message'] },
              { kind: 'surface', values: ['current'] },
            ],
            limit: requestedLimit,
            ...(requestedCursor === undefined ? {} : { cursor: requestedCursor }),
          }, { signal })
          signal.throwIfAborted()
        } catch (error: unknown) {
          signal.throwIfAborted()
          if (requestedCursor === undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_INVALID_LIMIT'
            && requestedLimit > 1) {
            pageLimit = Math.max(1, Math.floor(requestedLimit / 2))
            continue
          }
          if (requestedCursor !== undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_STALE_CURSOR') {
            authorized.length = 0
            acceptedIds.clear()
            seenCursors.clear()
            cursor = undefined
            continue
          }
          throw error
        }
        if (page.items.length > requestedLimit) {
          throw new Error(`session search provider returned ${String(page.items.length)} items; maximum is ${String(requestedLimit)}`)
        }
        for (const hit of page.items) {
          if (authorized.length > SESSION_SEARCH_RESULT_LIMIT) continue
          if (!visibleIds.has(hit.header.id)
            || hit.bestMatch.sessionId !== hit.header.id
            || hit.bestMatch.surface !== 'current'
            || !MESSAGE_TYPES.has(hit.bestMatch.type)
            || acceptedIds.has(hit.header.id)) continue
          acceptedIds.add(hit.header.id)
          authorized.push({
            sessionId: hit.header.id,
            snippet: truncateUnicodeCodePoints(hit.bestMatch.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
          })
        }
        if (page.nextCursor !== undefined) {
          if (seenCursors.has(page.nextCursor)) {
            throw new Error('session search provider repeated a continuation cursor')
          }
          seenCursors.add(page.nextCursor)
        }
        if (authorized.length > SESSION_SEARCH_RESULT_LIMIT || page.nextCursor === undefined) break
        cursor = page.nextCursor
      }
      return {
        items: authorized.slice(0, SESSION_SEARCH_RESULT_LIMIT),
        hasMore: authorized.length > SESSION_SEARCH_RESULT_LIMIT,
      }
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED') {
        throw new RemoteError('gateway/cancelled', 'session search was aborted', {})
      }
      throw new RemoteError('gateway/internal', `session search failed: ${String(error)}`, {})
    }
  }

  private projectionsFor(
    header: SessionHeader,
    session: Session | undefined,
  ): SessionProjectionHints | undefined {
    try {
      if (session !== undefined) {
        // The live registry computed the block for this Session: its watermark
        // shares the sequence space of the Session's baselines and frames.
        return hintsOf('sequenced', this.ctx.sessionProjections.cachedSnapshot(session, undefined, this.excludedProjectionKeys))
      }
      // A cold row reads the persisted cache by header alone; the cache serves
      // seeded and unseeded lifecycles alike because a listing never seeds a
      // fold. The watermark is the stored record's own.
      const cache = this.ctx.get('sessionProjectionCache')
      return hintsOf('cached', cache?.cachedSnapshot(header, undefined, this.excludedProjectionKeys)
      ?? (this.excludedProjectionKeys.has('title') ? undefined : cache?.cachedPredecessorTitle(header)))
    } catch (error) {
      this.ctx.logger.warn(
        `api-session.list: projection column for "${header.id}" failed; serving the row without it: ${String(error)}`,
      )
      return undefined
    }
  }
}

/**
 * Wrap one projection block as Session-list hints of the named sequence space.
 * @param kind - which sequence space the block's watermark belongs to.
 * @param block - the block, or `undefined` when no source served one.
 * @returns the hints, or `undefined` when the block is absent or carries no value.
 */
function hintsOf(
  kind: SessionProjectionHints['kind'],
  block: ProjectionSnapshot | undefined,
): SessionProjectionHints | undefined {
  if (block === undefined || Object.keys(block.values).length === 0) return undefined
  // Listing hints contain every wire value the source currently holds but
  // remain partial: missing cells and cache rows are never materialized here.
  return { kind, asOfSeq: block.asOfSeq, values: block.values as SessionProjectionValues }
}

/**
 * Add one backfilled title to the cache block a cold row already carries.
 * @param block - block served by the projection cache, possibly `undefined`.
 * @param title - title-only hint read from the stored log, possibly `undefined`.
 * @returns the merged block, the one side that exists, or `undefined` for neither.
 */
function withBackfilledTitle(
  block: SessionProjectionHints | undefined,
  title: SessionProjectionHints | undefined,
): SessionProjectionHints | undefined {
  if (title === undefined) return block
  if (block === undefined) return title
  // Both sides are cached hints; the lowest served watermark keeps the block's
  // promise that every value folded through at least `asOfSeq`.
  return {
    kind: block.kind,
    asOfSeq: Math.min(block.asOfSeq, title.asOfSeq),
    values: { ...block.values, ...title.values },
  }
}

function normalizeSearchQuery(query: string): string {
  const normalized = query.trim()
  if (normalized.length === 0) {
    throw new RemoteError('gateway/bad-request', 'session search query must not be empty', {})
  }
  if (normalized.length > SESSION_SEARCH_QUERY_MAX_CHARS) {
    throw new RemoteError(
      'gateway/bad-request',
      `session search query must contain at most ${SESSION_SEARCH_QUERY_MAX_CHARS} UTF-16 code units`,
      {},
    )
  }
  if (normalized.includes('\0')) {
    throw new RemoteError('gateway/bad-request', 'session search query must not contain NUL', {})
  }
  return normalized
}

function updatedAt(header: SessionHeader, metadata: SessionListMetadata | undefined): number {
  return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)
}

function listFields(header: SessionHeader): {
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
} {
  return {
    ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
  }
}
