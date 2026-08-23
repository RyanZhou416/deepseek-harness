/** Shared event metadata and semantic-document projection. */

import { foldSurface, isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventRecord, SessionEventSearchDocument, SessionEventSurface } from './types.ts'
import { SessionQueryError } from './config.ts'
import { extractSessionEventText } from './extraction.ts'

/**
 * Project a raw log into lightweight surface-aware event records.
 * @param sessionId - session that owns the log.
 * @param events - complete contiguous raw event log.
 * @returns one record per event in ascending seq order.
 */
export function buildSessionEventRecords(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventRecord[] {
  const surfaceBySeq = classifySurface(events)
  return events.map(event => ({
    sessionId,
    seq: event.seq,
    type: event.type,
    time: event.time,
    surface: surfaceBySeq.get(event.seq) ?? 'log-only',
  }))
}

/**
 * Build first-party semantic documents for one complete raw event log.
 * @param sessionId - session that owns the log.
 * @param events - complete contiguous raw event log.
 * @returns searchable documents in ascending seq order; structural events are omitted.
 */
export function buildSessionEventSearchDocuments(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventSearchDocument[] {
  const surfaceBySeq = classifySurface(events)
  const documents: SessionEventSearchDocument[] = []
  for (const event of events) {
    const text = extractSessionEventText(event)
    if (text.length === 0) continue
    documents.push({
      sessionId,
      seq: event.seq,
      type: event.type,
      time: event.time,
      surface: surfaceBySeq.get(event.seq) ?? 'log-only',
      text,
    })
  }
  return documents
}

/**
 * Build documents for a proven append-only suffix of one live Session.
 *
 * A caller may use this only when the Session's canonical
 * `surface.replaceGeneration` is unchanged from the indexed prefix. Under that
 * invariant, an eligible suffix event can only append to the current surface;
 * prior surface classifications cannot change and non-surface events remain
 * log-only. A replacement is rejected defensively so an incorrect fast-path
 * admission rolls its surrounding index transaction back instead of silently
 * misclassifying history.
 *
 * @param sessionId - session that owns the log.
 * @param events - complete immutable live event snapshot.
 * @param fromIndex - first newly appended event index.
 * @returns searchable documents owned by the suffix only.
 */
export function buildAppendedSessionEventSearchDocuments(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  fromIndex: number,
): SessionEventSearchDocument[] {
  if (!Number.isSafeInteger(fromIndex) || fromIndex < 0 || fromIndex > events.length) {
    throw new RangeError(`invalid appended document boundary ${fromIndex}`)
  }
  const documents: SessionEventSearchDocument[] = []
  for (let index = fromIndex; index < events.length; index += 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- loop bounds own the indexed event.
    const event = events[index]!
    if (isReplacementSurfaceEvent(event)) {
      throw new SessionQueryError(
        `live session append suffix unexpectedly contains a surface replacement at seq ${event.seq}`,
        'SESSION_QUERY_INVALID_SURFACE',
      )
    }
    const text = extractSessionEventText(event)
    if (text.length === 0) continue
    documents.push({
      sessionId,
      seq: event.seq,
      type: event.type,
      time: event.time,
      surface: isAppendSurfaceEvent(event) ? 'current' : 'log-only',
      text,
    })
  }
  return documents
}

function classifySurface(events: readonly SessionEvent[]): Map<number, SessionEventSurface> {
  let folded: ReturnType<typeof foldSurface>
  try {
    folded = foldSurface(events)
  } catch (error: unknown) {
    throw new SessionQueryError(
      /* v8 ignore next -- foldSurface throws Error instances */
      `invalid session surface: ${error instanceof Error ? error.message : 'unknown error'}`,
      'SESSION_QUERY_INVALID_SURFACE',
      { cause: error },
    )
  }
  const result = new Map<number, SessionEventSurface>()
  for (const seq of folded.nodes) result.set(seq, 'current')
  for (const replacement of folded.replacements) {
    for (const seq of replacement.shadowedSeqs) result.set(seq, 'shadowed')
  }
  return result
}
