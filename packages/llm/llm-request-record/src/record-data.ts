/**
 * Pure functions of the request-record vocabulary: complete one producer payload
 * into a logged record, digest the recorded system text the one way every reader
 * compares it, and project a session's events back to the recorded system text of
 * one prepared request.
 *
 * @module @deepseek-ai/dsh-llm-request-record/record-data
 */

import { createHash } from 'node:crypto'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { LlmRequestRecordData, LlmRequestRecordPayload } from './types.ts'

/**
 * Digest the recorded system text exactly as every record and comparison does.
 * @param systemBlocks - ordered emitted system text.
 * @returns lowercase hex `sha256` of `JSON.stringify(systemBlocks)`.
 */
export function requestRecordDigest(systemBlocks: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(systemBlocks)).digest('hex')
}

/** Reject a record field whose empty value a reader could not state. */
function assertNonEmpty(name: string, value: string): void {
  if (value.length === 0) {
    throw new TypeError(`llm-request-record: ${name} must be a non-empty string`)
  }
}

/**
 * Complete one producer payload into the record that enters the session log.
 *
 * The record is durable: another build reads it back without this process's
 * types, and a reader derives model-visible facts from it. The version, the
 * phase and the system digest are therefore supplied here rather than accepted
 * from the caller, so no producer can state a schema its own text does not
 * satisfy or a digest that disagrees with the text beside it.
 *
 * @param payload - the producer's observation of one prepared request.
 * @returns the complete, frozen record for the session log.
 * @throws TypeError naming the first field the record cannot carry.
 */
export function validateRequestRecord(payload: LlmRequestRecordPayload): LlmRequestRecordData {
  assertNonEmpty('model', payload.model)
  assertNonEmpty('profile', payload.profile)
  assertNonEmpty('wireLibrary', payload.wireLibrary)
  const systemBlocks = Object.freeze([...payload.systemBlocks])
  return Object.freeze({
    v: 1,
    phase: 'prepared',
    provider: payload.provider,
    model: payload.model,
    purpose: payload.purpose,
    systemBlocks,
    systemDigest: requestRecordDigest(systemBlocks),
    wireLibrary: payload.wireLibrary,
    profile: payload.profile,
  })
}

/**
 * Project one session's events back to the ordered system text of a prepared
 * request.
 *
 * The log already stores emitted block text, so this reads what was recorded; it
 * does not rebuild a wire body, whose `cache_control` markers and inter-block
 * serialization whitespace were never part of the record. It reads the events it
 * is handed and never a Session's own history accessors, so a caller selects from
 * a durable read exactly as it does from live events.
 *
 * @param events - one session's events, in log order.
 * @param preparedId - the exact record to read, named by the sequence number a
 *   successful `recordPreparedRequest` returned. Omitted reads the latest record,
 *   which is only a default for a caller that holds no id: one request produces
 *   one record per attempt, so a consumer reconstructing a specific send passes
 *   the id it recorded for that send.
 * @returns the selected record's system text, or undefined when the log holds no
 *   record with that id (and, for the omitted form, when it holds none at all).
 */
export function reconstructRequestSystem(
  events: readonly SessionEvent[],
  preparedId?: SessionSeq,
): readonly string[] | undefined {
  let latest: readonly string[] | undefined
  for (const event of events) {
    if (event.type !== 'llm/request-record') continue
    if (preparedId === undefined) {
      latest = event.data.systemBlocks
      continue
    }
    if (event.seq === preparedId) return event.data.systemBlocks
  }
  return latest
}
