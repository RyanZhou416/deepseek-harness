/** Shared event metadata and semantic-document projection. */

import { foldSurface, isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
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
 * Build documents for a suffix whose live Session lifecycle and canonical
 * surface replacement generation are unchanged from the indexed prefix.
 * Prior surface classifications therefore remain valid: an appended surface
 * event is current and every non-surface event is log-only. A replacement
 * rejects so an invalid fast-path admission rolls back its index transaction.
 * @param sessionId - session that owns the log.
 * @param events - newly appended immutable events only.
 * @returns searchable documents owned by the suffix.
 */
export function buildAppendedSessionEventSearchDocuments(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventSearchDocument[] {
  const documents: SessionEventSearchDocument[] = []
  for (const event of events) {
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

function classifySurface(events: readonly SessionEvent[]): Map<SessionSeq, SessionEventSurface> {
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
  const result = new Map<SessionSeq, SessionEventSurface>()
  for (const seq of folded.nodes) result.set(seq, 'current')
  for (const replacement of folded.replacements) {
    for (const seq of replacement.shadowedSeqs) result.set(seq, 'shadowed')
  }
  return result
}
