/** Detail-field elision for history reads that set `elideDetails`. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionHistoryRecord } from '../types.ts'

type JsonObject = { readonly [key: string]: JsonValue }

function objectOf(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function nonEmptyArray(value: JsonValue | undefined): boolean {
  return Array.isArray(value) && value.length > 0
}

/** @returns the elided data, or undefined when the event carries none of its type's detail fields. */
function elidedData(type: string, data: JsonObject): JsonObject | undefined {
  switch (type) {
    case 'assistant/message': {
      const message = objectOf(data.message)
      const source = objectOf(message?.source)
      const stream = nonEmptyArray(data.stream)
      if (message === undefined || source === undefined || !('replayState' in source)) {
        return stream ? { ...data, stream: [] } : undefined
      }
      const { replayState: _replayState, ...kept } = source
      return { ...data, ...stream ? { stream: [] } : {}, message: { ...message, source: kept } }
    }
    case 'request/header': {
      // A Session event omits an empty tool catalog, so the elided catalog is removed rather than emptied.
      const header = objectOf(data.header)
      if (header === undefined || !nonEmptyArray(header.tools)) return undefined
      const { tools: _tools, ...kept } = header
      return { ...data, header: kept }
    }
    case 'llm/request-record':
      return nonEmptyArray(data.systemBlocks) ? { ...data, systemBlocks: [] } : undefined
    default:
      // Other event types keep every field.
      return undefined
  }
}

/**
 * Empty the detail fields `SessionPageRequest.elideDetails` names.
 * @param records - page records, unchanged.
 * @returns the records, each changed one copied with `elided: true`.
 */
export function elideRecordDetails(records: readonly SessionHistoryRecord[]): SessionHistoryRecord[] {
  return records.map((record) => {
    const data = objectOf(record.event.data)
    const elided = data === undefined ? undefined : elidedData(record.event.type, data)
    return elided === undefined ? record : { ...record, event: { ...record.event, data: elided }, elided: true }
  })
}
