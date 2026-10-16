/**
 * Minimal SSE byte-stream parser: reassembles chunks, splits CRLF/LF lines, joins
 * multi-`data:` payloads, skips comments and non-data fields, and dispatches an
 * event only on its blank-line terminator. An unterminated tail at EOF is
 * truncation and is dropped, matching the spec-strict framing the harness's own
 * adapters use.
 *
 * The framing itself lives in `claude-engine/sse.ts`, which a caller outside the harness uses
 * directly; this module keeps only what is specific to the harness stream: reading a
 * `ReadableStream`, the idle-activity callback, and cancelling unread bytes on early exit.
 *
 * EOF releases the reader; an earlier iterator exit awaits source cancellation before
 * releasing it. Closing an async iterator does not interrupt an outstanding read:
 * callers must abort the underlying request to unblock a pending read.
 */

import { createSseFramer } from '../claude-engine/sse.js'

/** One parsed SSE event. */
interface SseEvent {
  /** Joined `data:` lines of the event. */
  data: string
  /** The `event:` field, when present. */
  event?: string
}

/**
 * Decode an SSE byte stream into events.
 * @param stream - raw response bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onActivity - called on every received chunk and comment line; drives the idle watchdog.
 * @returns events in arrival order.
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const framer = createSseFramer()
  let ended = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        ended = true
        return
      }
      onActivity?.()
      const pushed = framer.push(decoder.decode(value, { stream: true }), onActivity)
      for (const event of pushed.events) yield event
      // A frame past the framer's cap ends this stream where it stands rather than growing.
      if (pushed.overflowed === true) return
    }
  } finally {
    // Early iterator exit owns cancellation of unread response bytes.
    if (!ended) {
      try {
        await reader.cancel()
      } catch (_cancelFailure) {
        // Preserve the consumer's return or original failure if source cleanup rejects.
      }
    }
    reader.releaseLock()
  }
}
