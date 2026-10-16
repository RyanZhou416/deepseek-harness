/**
 * Server-sent-event framing over raw bytes.
 *
 * The framing is the spec's own: `data:` lines are joined, comments and other fields are
 * skipped, an event is dispatched on its blank-line terminator, and an unterminated tail at EOF
 * is truncation rather than an event. This module is DSH-free so a caller outside the harness can
 * use it; the plugin's translator delegates here instead of keeping a second parser.
 *
 * Every buffer is bounded. A provider cannot make this framer hold unbounded memory: the
 * unterminated tail and a single frame's data are both capped, and a stream that exceeds a cap is
 * reported as overflow rather than growing without limit.
 *
 * @module dsh-plugin-subscriptions/claude-engine/sse
 */

/** The largest unterminated tail the framer will buffer. */
export const SSE_TAIL_LIMIT_BYTES = 1_048_576

/** The largest single frame's joined data the framer will dispatch. */
export const SSE_FRAME_LIMIT_BYTES = 8_388_608

/** One parsed SSE event. */
export interface ClaudeEngineSseEvent {
  /** Joined `data:` payload lines. */
  readonly data: string
  /** The `event:` field, when the frame carried one. */
  readonly event?: string
}

/** The outcome of feeding one chunk. */
export interface ClaudeEngineSsePushResult {
  /** The events this chunk completed, in order. */
  readonly events: readonly ClaudeEngineSseEvent[]
  /**
   * Set when a cap was exceeded: the framer stops dispatching from this point, and the caller must
   * treat the response as malformed rather than as a normal stream.
   */
  readonly overflowed?: true
}

/** Incremental SSE framer: feed decoded text, take the events each chunk completed. */
export interface ClaudeEngineSseFramer {
  /**
   * Feed one decoded chunk.
   * @param text - the text decoded so far; a partial frame stays buffered.
   * @param onActivity - called for a comment line, which is traffic without an event.
   * @returns the events this chunk completed, and whether a cap was exceeded.
   */
  push(text: string, onActivity?: () => void): ClaudeEngineSsePushResult
}

/**
 * Create one incremental framer.
 * @returns a framer that keeps the unterminated tail buffered until it is completed, under caps.
 */
export function createSseFramer(): ClaudeEngineSseFramer {
  let pending = ''
  let dataLines: string[] = []
  let dataLength = 0
  let eventName: string | undefined
  let overflowed = false
  return {
    push(text, onActivity) {
      if (overflowed) return { events: [], overflowed: true }
      const events: ClaudeEngineSseEvent[] = []
      pending += text
      if (pending.length > SSE_TAIL_LIMIT_BYTES) {
        // An unterminated tail past the cap is not a frame this framer will ever dispatch.
        overflowed = true
        pending = ''
        dataLines = []
        return { events: [], overflowed: true }
      }
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        let line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line.length === 0) {
          if (dataLines.length > 0) {
            events.push({ data: dataLines.join('\n'), ...eventName === undefined ? {} : { event: eventName } })
          }
          dataLines = []
          dataLength = 0
          eventName = undefined
        } else if (line.startsWith(':')) {
          onActivity?.()
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '')
          dataLength += value.length
          if (dataLength > SSE_FRAME_LIMIT_BYTES) {
            overflowed = true
            dataLines = []
            return { events, overflowed: true }
          }
          dataLines.push(value)
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).replace(/^ /, '')
        }
      }
      return { events }
    },
  }
}

/**
 * Decode a byte stream into SSE events.
 *
 * Reads may split anywhere, including mid-UTF-8 sequence, so the decoder is kept in streaming
 * mode. An event without a terminating blank line is never dispatched: at EOF it is dropped, which
 * is what makes a truncated tail distinguishable from a complete one. The generator ends early
 * when a cap is exceeded, without dispatching a partial frame.
 * @param stream - raw response bytes.
 * @param onActivity - called for every received chunk and comment line, for a caller's idle bound.
 * @returns events in arrival order.
 */
export async function* parseSseBytes(
  stream: AsyncIterable<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<ClaudeEngineSseEvent> {
  const decoder = new TextDecoder()
  const framer = createSseFramer()
  for await (const chunk of stream) {
    onActivity?.()
    const result = framer.push(decoder.decode(chunk, { stream: true }), onActivity)
    for (const event of result.events) yield event
    if (result.overflowed === true) return
  }
}
