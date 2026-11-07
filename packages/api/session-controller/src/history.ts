/** Shared Session history pagination, address validation and wire conversion. */

import type { Context } from '@deepseek-ai/cordis'
import {
  isAppendSurfaceEvent,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session'
import type {
  SessionPersistenceSnapshot,
  SessionWindow,
  SessionWindowRequest,
} from '@deepseek-ai/dsh-session-persistence'
import { SessionQueryError, type SessionObservation, type SessionWindowRead } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SessionAddress,
  SessionEventEntry,
  SessionHistoryRecord,
  SessionPageRequest,
  SessionProjectionBaseline,
  SessionProjectionValues,
  SessionWireHeader,
  SessionWireEvent,
} from './types.ts'

/** Message budget applied when a history request omits `maxMessages`. */
export const DEFAULT_MAX_MESSAGES = 50
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])
/** Largest event count one bounded stored-history window read may request. */
const SESSION_WINDOW_MAX_EVENTS = 10_000
/** Smallest event budget one message-aligned page requests beyond its tail alignment span. */
const SESSION_WINDOW_MIN_EVENTS = 2_000
/**
 * First event count one stored window read requests when a serialized byte
 * budget is configured.
 *
 * That budget trims a page near the caller's cut, so requesting the complete
 * alignment bound first decodes rows the page cannot carry. 256 keeps the first
 * decode to about an eighth of that bound while a typical 500-message opening
 * still resolves inside the growth sequence.
 */
const SESSION_WINDOW_FIRST_EVENTS = 256
/** Factor by which a budgeted window read grows while its page is undecided. */
const SESSION_WINDOW_GROWTH = 4
/**
 * Stored artifact size below which a complete observation is cheaper than a
 * cold window index build. Backends that report no size keep the window path.
 */
const SMALL_STORED_SESSION_BYTES = 2 * 1024 * 1024

/**
 * Reject an invalid message budget or turn window.
 * @param request - history window fields.
 */
export function validateHistoryWindow(request: Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'>): void {
  if (request.maxMessages !== undefined
    && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
    throw new RemoteError('gateway/bad-request', 'maxMessages must be a positive safe integer', {})
  }
  const window = request.turnWindow
  if (window !== undefined) {
    if (!Number.isSafeInteger(window.minMessages) || window.minMessages <= 0
      || window.minMessages > (request.maxMessages ?? DEFAULT_MAX_MESSAGES)) {
      throw new RemoteError('gateway/bad-request', 'turnWindow.minMessages must be a positive safe integer no greater than maxMessages', {})
    }
    if (!Number.isSafeInteger(window.minTurns) || window.minTurns <= 0) {
      throw new RemoteError('gateway/bad-request', 'turnWindow.minTurns must be a positive safe integer', {})
    }
  }
}

/**
 * Select the Session whose log an address names.
 * @param address - ordinary Session or direct-subagent address.
 * @returns the Session whose log the address reads.
 */
export function addressId(address: SessionAddress): SessionId {
  return address.kind === 'session' ? address.sessionId : address.childSessionId
}

/**
 * Reject an address that does not match the observed Session.
 * @param address - ordinary Session or direct-subagent address.
 * @param header - observed Session header.
 * @param inheritedEventCount - observed fork-inherited event count.
 * @param projections - observed projections; subagent addresses require them.
 */
export function validateAddress(
  address: SessionAddress,
  header: SessionHeader,
  inheritedEventCount: SessionLogOffsetType,
  projections: SessionObservation['projections'],
): void {
  if (address.kind === 'session') {
    if (header.origin === 'subagent') {
      throw new RemoteError('session/agent-busy', 'subagent Sessions require their durable parent address', {
        reason: 'use subagent delivery for this child session',
      })
    }
    return
  }
  if (header.origin !== 'subagent' || header.parentSession !== address.parentSessionId) {
    throw new RemoteError('subagent/unauthorized', 'subagent does not belong to the supplied parent', {
      childSessionId: address.childSessionId,
    })
  }
  const identity = projections?.values.subagent
  if (identity === null) {
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is corrupt', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'corrupt',
    })
  }
  if (identity === undefined || identity.seq < inheritedEventCount) {
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is unavailable', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'unsupported',
    })
  }
  if (address.mode !== 'unknown' && identity.mode !== address.mode) {
    throw new RemoteError('subagent/unauthorized', 'subagent mode does not match the supplied address', {
      childSessionId: address.childSessionId,
    })
  }
}

/**
 * Reject a missing Session using its address-specific error.
 * @param address - ordinary Session or direct-subagent address.
 * @returns never; this operation always throws.
 * @throws RemoteError `session/not-found` or `subagent/not-found`.
 */
export function rejectNotFound(address: SessionAddress): never {
  if (address.kind === 'session') {
    throw new RemoteError('session/not-found', `session "${address.sessionId}" not found`, { sessionId: address.sessionId })
  }
  throw new RemoteError('subagent/not-found', 'subagent is unavailable', {
    parentSessionId: address.parentSessionId,
    childSessionId: address.childSessionId,
  })
}

/**
 * Cut one message-aligned backwards page from a contiguous event prefix.
 * @param events - contiguous events starting at seq 0.
 * @param beforeSeq - exclusive upper offset of an older page.
 * @param maxMessages - message budget.
 * @param throughSeq - inclusive log cut.
 * @param turnWindow - optional turn-boundary stop rule.
 * @param maxBytes - serialized-record byte budget; `0` keeps the message/Turn limits alone.
 * @returns the page events and whether older events remain.
 */
export function paginate(
  events: readonly SessionEvent[],
  beforeSeq: SessionLogOffsetType | undefined,
  maxMessages: number,
  throughSeq: SessionSeqCursor,
  turnWindow?: SessionPageRequest['turnWindow'],
  maxBytes = 0,
): { readonly events: SessionEvent[]; readonly hasMore: boolean } {
  const end = SessionLogOffset(Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1))
  const page = paginateSlice(events, SessionLogOffset(0), end, maxMessages, turnWindow, maxBytes)
  /* v8 ignore next 3 -- A complete log starts at seq 0, so its cut never falls below the slice. */
  if (page === undefined) {
    throw new RemoteError('gateway/internal', 'complete session log pagination fell below its start', {})
  }
  return page
}

/**
 * Cut one message-aligned backwards page from the slice `[baseSeq, endSeq)`.
 *
 * The returned start always falls on a counted message's group start, so a
 * message whose cited source events lie below it can never be served without
 * them. Under a byte budget the start also moves forward toward newer messages
 * until the serialized records fit; the newest message group is always kept so
 * a page always makes progress.
 * @param events - contiguous events covering `[baseSeq, endSeq)`.
 * @param baseSeq - offset of the slice's first event.
 * @param endSeq - exclusive upper offset of the slice.
 * @param maxMessages - message budget.
 * @param turnWindow - optional turn-boundary stop rule.
 * @param maxBytes - serialized-record byte budget; `0` keeps the message/Turn limits alone.
 * @returns the page events and whether older events remain, or undefined when the slice hides its cut.
 */
export function paginateSlice(
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffsetType,
  endSeq: SessionLogOffsetType,
  maxMessages: number,
  turnWindow?: SessionPageRequest['turnWindow'],
  maxBytes = 0,
): { readonly events: SessionEvent[]; readonly hasMore: boolean } | undefined {
  const end = endSeq - baseSeq
  // An empty tail cut at seq 0 is a real page; any other empty slice hides the cut below it.
  if (end < 0 || (end === 0 && endSeq > 0)) return undefined
  let count = 0
  let turns = 0
  let cut = baseSeq
  let resolved = false
  for (let index = end - 1; index >= 0; index--) {
    const event = events[index] as SessionEvent
    if (turnWindow !== undefined && event.type === 'turn/start') {
      turns++
      if (count >= turnWindow.minMessages && turns >= turnWindow.minTurns) {
        cut = SessionLogOffset(event.seq)
        resolved = true
        break
      }
    }
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    const sources = event.sourceEventSeqs
    let groupStart = event.seq
    if (sources !== undefined) {
      for (const source of sources) {
        if (source < groupStart) groupStart = source
      }
    }
    if (groupStart < baseSeq) return undefined
    if (count >= maxMessages) {
      cut = SessionLogOffset(groupStart)
      resolved = true
      break
    }
  }
  if (!resolved && baseSeq > 0) {
    if (maxBytes <= 0) return undefined
    const budgetCut = trimToByteBudget(events, baseSeq, 0, end, maxBytes)
    if (budgetCut === 0) return undefined
    return { events: events.slice(budgetCut, end), hasMore: baseSeq + budgetCut > 0 }
  }
  const start = cut - baseSeq
  const trimmed = trimToByteBudget(events, baseSeq, start, end, maxBytes)
  return { events: events.slice(trimmed, end), hasMore: baseSeq + trimmed > 0 }
}

/**
 * Move one message-aligned page start toward newer events until its serialized
 * records fit the byte budget.
 *
 * The scan is linear in the page: group starts and their suffix minima decide
 * which starts keep every message's cited sources on the page, then one
 * newest-first pass sums serialized bytes. The newest message group is kept even
 * when it alone exceeds the budget.
 * @param events - contiguous events covering the page.
 * @param baseSeq - offset of the page slice's first event.
 * @param start - page-relative candidate start.
 * @param end - page-relative exclusive end.
 * @param maxBytes - serialized-record byte budget; `0` keeps `start`.
 * @returns the page-relative start that fits the budget.
 */
function trimToByteBudget(
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffsetType,
  start: number,
  end: number,
  maxBytes: number,
): number {
  if (maxBytes <= 0 || end <= start) return start
  const length = end - start
  const sliceSeq = baseSeq + start
  /**
   * Group start of the counted message at each page offset, in page-relative
   * coordinates: `0` is the page start. A value below `0` cites an event below
   * the page, so a candidate at or below that message would omit the source;
   * offsets without a counted message hold positive infinity.
   */
  const groupStarts = new Float64Array(length).fill(Number.POSITIVE_INFINITY)
  for (let offset = 0; offset < length; offset++) {
    const event = events[start + offset] as SessionEvent
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    const sources = event.sourceEventSeqs
    let groupStart = event.seq
    if (sources !== undefined) {
      for (const source of sources) {
        if (source < groupStart) groupStart = source
      }
    }
    groupStarts[offset] = groupStart - sliceSeq
  }
  /** Lowest page-relative group start among messages at or above each offset. */
  const suffixMin = new Float64Array(length + 1).fill(Number.POSITIVE_INFINITY)
  for (let offset = length - 1; offset >= 0; offset--) {
    suffixMin[offset] = Math.min(suffixMin[offset + 1] as number, groupStarts[offset] as number)
  }
  const usable = new Uint8Array(length)
  for (let offset = 0; offset < length; offset++) {
    const groupStart = groupStarts[offset] as number
    if (groupStart < 0) continue
    // Every message at or above this start must cite an event at or above it.
    if (suffixMin[groupStart] === groupStart) usable[groupStart] = 1
  }
  let bytes = 0
  let newest: number | undefined
  let best: number | undefined
  for (let offset = length - 1; offset >= 0; offset--) {
    bytes += Buffer.byteLength(JSON.stringify(entryFor(events[start + offset] as SessionEvent)), 'utf8')
    // The untouched page keeps its original start whenever the whole page fits.
    if (offset === 0) break
    if (usable[offset] === 0) continue
    newest ??= offset
    // Older starts only add bytes, so the first over-budget start ends the scan.
    if (bytes > maxBytes) break
    best = offset
  }
  if (bytes <= maxBytes) return start
  return start + (best ?? newest ?? 0)
}

/**
 * Convert a committed event to its wire entry.
 * @param event - committed Session event.
 * @returns the wire event entry.
 */
export function entryFor(event: SessionEvent): SessionEventEntry {
  return {
    type: 'event',
    // Session.append validates and freezes event data as JSON before publication.
    event: event as unknown as SessionWireEvent,
  }
}

/**
 * Encode one bounded logical page without changing its pagination cut.
 * @param events - page events.
 * @returns the wire records.
 */
export function pageRecords(events: readonly SessionEvent[]): SessionHistoryRecord[] {
  return events.map(entryFor)
}

/**
 * Event count one message-aligned page needs above its own lookback: enough
 * rows to reach the message and Turn minima.
 * @param request - caller history limits.
 * @returns the bounded `maxEvents` to request from persistence.
 */
export function windowEventBound(request: Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'>): number {
  const messages = request.maxMessages ?? DEFAULT_MAX_MESSAGES
  const turnHeadroom = (request.turnWindow?.minTurns ?? 0) * 64
  return Math.min(
    SESSION_WINDOW_MAX_EVENTS,
    Math.max(SESSION_WINDOW_MIN_EVENTS, messages * 4 + turnHeadroom),
  )
}

/**
 * Event counts to try for one stored window read.
 *
 * Without a serialized byte budget the window requests the alignment bound
 * once. With one, the first request uses 256 events and each retry multiplies
 * the bound by four up to the alignment bound: the caller stops at the first
 * bound whose page is decided (alignment resolved, history start reached, or
 * budget exhausted). Every bound stays within the alignment bound, so a window
 * that never decides its page still falls back to the complete read.
 * @param request - caller history limits.
 * @param maxBytes - configured serialized-record byte budget; `0` requests one bounded read.
 * @returns the event counts to request, strictly increasing and ending at the alignment bound.
 */
export function windowReadBounds(
  request: Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'>,
  maxBytes: number,
): readonly number[] {
  const bound = windowEventBound(request)
  let limit = maxBytes > 0 ? Math.min(bound, SESSION_WINDOW_FIRST_EVENTS) : bound
  const bounds = [limit]
  while (limit < bound) {
    limit = Math.min(bound, limit * SESSION_WINDOW_GROWTH)
    bounds.push(limit)
  }
  return bounds
}

/**
 * Whether one tail window shows the log's final Turn boundary.
 *
 * `interruptedTurnClosers` decides from the last `turn/start` or `turn/end` it
 * observes. A window that reaches any such boundary reaches the log's latest
 * one, because the window ends at the stored cursor, so its synthetic closers
 * match the complete observation. A window with no boundary cannot tell an
 * interrupted Turn from one whose start lies below the window; only a window
 * that reaches seq 0 is settled without one.
 * @param events - contiguous stored window events.
 * @param baseSeq - absolute seq of `events[0]`.
 * @returns true when the window's closer decision matches the complete log.
 */
export function tailTurnSettled(events: readonly SessionEvent[], baseSeq: SessionLogOffsetType): boolean {
  if (baseSeq === 0) return true
  for (const event of events) {
    if (event.type === 'turn/start' || event.type === 'turn/end') return true
  }
  return false
}

/**
 * Translate current logical Session metadata to the browser wire.
 * @param header - immutable logical Session metadata.
 * @returns the detached wire header.
 */
export function wireHeader(header: SessionHeader): SessionWireHeader {
  return { ...header }
}

/**
 * Wrap one projection snapshot as the wire baseline.
 * @param snapshot - validated projection values from an observation or window.
 * @returns the detached baseline block.
 */
export function projectionBlock(
  snapshot: NonNullable<SessionObservation['projections']>,
): SessionProjectionBaseline {
  return {
    asOfSeq: snapshot.asOfSeq,
    // Projection definitions validate whole JSON values before snapshot publication.
    values: snapshot.values as SessionProjectionValues,
  }
}

/**
 * Resolve a non-live ordinary Session the bounded window path may serve.
 * @param ctx - Host context owning the Session store.
 * @param address - durable history address.
 * @returns the addressed Session id, or undefined when the complete source is required.
 */
export function windowSessionId(ctx: Context, address: SessionAddress): SessionId | undefined {
  if (address.kind !== 'session') return undefined
  return ctx.sessions.get(address.sessionId) === undefined ? address.sessionId : undefined
}

/**
 * Whether a stored artifact is small enough that the complete observation
 * costs less than a window read.
 *
 * A window avoids materializing a large log, but below the threshold its cold
 * index build costs more than the complete observation. Missing, unsized, or
 * failed metadata keeps the window path.
 * @param ctx - Host context owning persistence.
 * @param sessionId - stored Session to size.
 * @param signal - caller cancellation for the metadata read.
 * @returns true only when the backend reports a size below the threshold.
 */
export async function isSmallStoredSource(ctx: Context, sessionId: SessionId, signal: AbortSignal): Promise<boolean> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return false
  let stored: SessionPersistenceSnapshot | undefined
  try {
    stored = await persistence.stat(sessionId, { signal })
  } catch {
    // An unknown size is not evidence of a small artifact, so the window path
    // reports the canonical failure; caller cancellation still wins.
    signal.throwIfAborted()
    return false
  }
  signal.throwIfAborted()
  const sizeBytes = stored?.sizeBytes
  return sizeBytes !== undefined && sizeBytes < SMALL_STORED_SESSION_BYTES
}

/**
 * Read one bounded stored window, mapping a missing Session to the complete
 * source path's canonical not-found handling.
 * @param ctx - Host context owning Session Query.
 * @param sessionId - stored Session to read.
 * @param request - bounded window request.
 * @returns the validated window and checkpoint, or undefined to fall back.
 */
export async function readStoredWindow(
  ctx: Context,
  sessionId: SessionId,
  request: SessionWindowRequest,
): Promise<SessionWindowRead | undefined> {
  try {
    return await ctx.sessionQuery.readWindow(sessionId, request)
  } catch (error: unknown) {
    if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return undefined
    throw error
  }
}

/**
 * Validate a stored window header exactly as a complete observation.
 * @param address - durable history address being served.
 * @param window - stored window whose header identifies the generation.
 * @param projections - checkpoint baseline, when the window path carries one.
 */
export function validateWindow(
  address: SessionAddress,
  window: SessionWindow,
  projections: SessionWindowRead['projections'],
): void {
  if (window.header.cwd === undefined) rejectNotFound(address)
  validateAddress(address, window.header, window.inheritedEventCount, projections)
}
