/**
 * Backend-shared storage validation: the version gate, the fail-closed event
 * vocabulary, append-batch materialization, and contiguity — one place so
 * every backend refuses the same inputs identically.
 * @module @deepseek-ai/dsh-session-persistence/storage-contract
 */

import {
  adoptSessionEvent,
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_FORMAT_VERSION,
} from '@deepseek-ai/dsh-session'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  sessionFormatVersionRefusal,
  type SessionLocation,
} from './errors.ts'

/** Build a format refusal that points at the raw artifact when the backend has one. */
function unsupported(reason: string, location: SessionLocation | undefined): SessionFormatUnsupportedError {
  return new SessionFormatUnsupportedError(
    location === undefined ? reason : `${reason} (raw log: ${location.path})`,
    location,
  )
}

/**
 * Refuse stored metadata that is not bound to the requested session id.
 * @param id - the requested session id.
 * @param meta - the stored header.
 */
export function assertStoredId(id: SessionId, meta: SessionHeader): void {
  if (meta.id !== id) {
    throw new Error(`stored session identity mismatch: requested "${id}", header contains "${meta.id}"`)
  }
}

/**
 * Refuse a header that has not been restored to the current logical format.
 * @param meta - the stored header.
 * @param location - the backend's artifact location for the refusal, when one exists.
 */
export function assertVersion(
  meta: { readonly id: SessionId; readonly version: number },
  location?: SessionLocation,
): void {
  if (meta.version !== SESSION_FORMAT_VERSION) {
    throw unsupported(sessionFormatVersionRefusal(meta.id, meta.version), location)
  }
}

/**
 * Validate one exclusively owned stored event array in place: adopt each
 * record (validating and freezing it) and refuse any event type this build
 * does not know, unless its writer marked it `ignorable: true` — silently
 * skipping an unknown required event could reconstruct a wrong session (the
 * envelope contract on `SessionEvent.ignorable`). Unknown required types and
 * retired pre-release shapes refuse here; this validator performs no migration.
 * @param meta - the stored header the events belong to.
 * @param events - exclusively owned decoded events; validated in place.
 * @param location - the backend's artifact location for refusals, when one exists.
 * @returns the same array, validated and frozen.
 * @throws {SessionFormatUnsupportedError} for unknown event types.
 * @throws {SessionPersistenceCorruptionError} for records that fail validation.
 */
export function validateStoredEvents(
  meta: SessionHeader,
  events: SessionEvent[],
  location?: SessionLocation,
): SessionEvent[] {
  assertStoredEventTypes(meta, events, location)
  for (const [index, event] of events.entries()) events[index] = adoptStoredEvent(meta, event)
  return events
}

/**
 * Refuse unknown required event types and retired pre-release shapes across a
 * whole stored log. Run it over every event before {@link adoptStoredEvent} so
 * a log from a newer harness refuses as unsupported rather than corrupt.
 * @param meta - the stored header the events belong to.
 * @param events - decoded events of one stored log.
 * @param location - the backend's artifact location for refusals, when one exists.
 * @throws {SessionFormatUnsupportedError} for unknown or retired event shapes.
 */
export function assertStoredEventTypes(
  meta: SessionHeader,
  events: readonly SessionEvent[],
  location?: SessionLocation,
): void {
  for (const event of events) {
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
      throw unsupported(
        `session "${meta.id}" contains event type "${event.type}" (seq ${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness`,
        location,
      )
    }
    // The one retired shape hiding under a known type: the removed delta codec's
    // full-header "fallback" reason. Everything else retired was a whole type.
    if (event.type === 'request/header') {
      const data: unknown = event.data
      if (typeof data === 'object' && data !== null
        && (data as Record<string, unknown>)['reason'] === 'fallback') {
        throw unsupported(
          `session "${meta.id}" contains a request/header event (seq ${event.seq}) with the unsupported legacy reason "fallback"; refusing to interpret the log — it was written by a retired pre-release harness`,
          location,
        )
      }
    }
  }
}

/**
 * Adopt one exclusively owned stored event after {@link assertStoredEventTypes}
 * accepted its log: validate it and deeply freeze its identified message.
 * @param meta - the stored header the event belongs to.
 * @param event - exclusively owned decoded event.
 * @returns the same event object, validated.
 * @throws {SessionPersistenceCorruptionError} for a record that fails validation.
 */
export function adoptStoredEvent(meta: SessionHeader, event: SessionEvent): SessionEvent {
  try {
    return adoptSessionEvent(event)
  } catch (error: unknown) {
    if (error instanceof SessionFormatUnsupportedError) throw error
    throw new SessionPersistenceCorruptionError(
      `stored session "${meta.id}" failed validation: ${String(error)}`,
      { cause: error },
    )
  }
}

/**
 * Validate and deep-snapshot a header passed to `create` in one traversal.
 * @param header - the caller's header.
 * @returns the detached lossless-JSON header.
 * @throws {TypeError} for non-JSON metadata or an invalid `createdAt`.
 */
export function materializeCreateHeader(header: SessionHeader): SessionHeader {
  const snapshot = snapshotJsonValue(header)
  if (snapshot === undefined) {
    throw new TypeError('session metadata must be losslessly JSON-serializable')
  }
  if (!Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt < 0) {
    throw new TypeError('session metadata createdAt must be a non-negative safe integer')
  }
  return snapshot
}

/**
 * Validate and deep-snapshot one append batch in a single traversal, so the
 * checked value is exactly the value persisted (a check followed by a copy
 * could reread accessors into a different record).
 * @param events - the caller's batch.
 * @returns the detached lossless-JSON batch.
 * @throws {TypeError} when any event data is not losslessly JSON-serializable.
 */
export function materializeAppendBatch(events: readonly SessionEvent[]): readonly SessionEvent[] {
  const batch = snapshotJsonValue(events)
  if (batch === undefined) {
    throw new TypeError('session event batch is not losslessly JSON-serializable because it contains non-JSON-serializable data')
  }
  return batch
}

/**
 * Refuse a batch that does not contiguously continue the stored log.
 * @param id - the session the batch belongs to.
 * @param events - the batch, in seq order.
 * @param cursor - the stored next-seq.
 */
export function assertContiguous(id: SessionId, events: readonly SessionEvent[], cursor: number): void {
  for (const [index, event] of events.entries()) {
    if (event.seq !== cursor + index) {
      throw new Error(`append seq mismatch for "${id}": expected ${cursor + index} at index ${index}, got ${event.seq}`)
    }
  }
}
