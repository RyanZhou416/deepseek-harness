/**
 * Read-only browser projection for completed model streams. The durable log
 * retains every chunk and provenance seq; history responses can derive the
 * same finalized assistant node without transporting those replay records.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isTokenDelta } from '@deepseek-ai/dsh-llm'

/** Identify one model step without depending on object identity. */
function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

/**
 * Remove provenance only when every cited event is a chunk from this exact
 * model step. Other provenance may carry extension semantics and stays intact.
 */
function withoutChunkProvenance(
  fullLog: readonly SessionEvent[],
  event: SessionEvent,
): SessionEvent {
  if (event.type !== 'assistant/message') return event
  const sources = event.sourceEventSeqs
  if (sources === undefined || sources.length === 0) return event
  for (const seq of sources) {
    const source = fullLog[seq]
    if (source === undefined || source.seq !== seq) return event
    if (source.type !== 'assistant/chunk') return event
    if (source.data.turn !== event.data.turn || source.data.step !== event.data.step) return event
  }
  const projected = { ...event }
  delete projected.sourceEventSeqs
  return projected
}

/**
 * Project one raw history page for browser consumption.
 *
 * A turn/step that has any finalized `assistant/message` in the complete log
 * retains its usage records and only its first token delta in this raw page.
 * Those events preserve retry-inclusive usage, first-token, and first-visible
 * timing while the final message remains authoritative for complete content.
 * Chunks on older pages and chunks from a failed retry use the same rule.
 * Valid chunk-only `sourceEventSeqs` are omitted from the returned message
 * copy after pagination has consumed them. The input arrays and events are
 * never mutated.
 *
 * @param fullLog - complete dense session log used to determine settled steps.
 * @param rawPage - unprojected page selected by message-aligned pagination.
 * @returns sparse event projection for the history response.
 */
export function projectSettledHistoryPage(
  fullLog: readonly SessionEvent[],
  rawPage: readonly SessionEvent[],
): SessionEvent[] {
  const settledSteps = new Set<string>()
  for (const event of fullLog) {
    if (event.type === 'assistant/message') {
      settledSteps.add(stepKey(event.data.turn, event.data.step))
    }
  }

  const projected: SessionEvent[] = []
  const tokenSteps = new Set<string>()
  for (const event of rawPage) {
    if (event.type === 'assistant/chunk') {
      const key = stepKey(event.data.turn, event.data.step)
      if (settledSteps.has(key)) {
        if (event.data.chunk.type !== 'usage') {
          if (!isTokenDelta(event.data.chunk) || tokenSteps.has(key)) continue
          tokenSteps.add(key)
        }
      }
    }
    projected.push(withoutChunkProvenance(fullLog, event))
  }
  return projected
}
