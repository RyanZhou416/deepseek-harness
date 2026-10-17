/**
 * Index-free tail windows over one current JSONL Session generation.
 *
 * A window selects the trailing physical frames, seeds the released v4 decoder
 * at the first selected row's seq, and decodes only those rows. It never
 * establishes the complete-log relationships that `SessionLogScanner` checks;
 * readers that need those keep using the full read path.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/window
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionFormatEvent, SessionFormatMigrationContext } from '@deepseek-ai/dsh-session-format'
import { assertV4RowAdmission, releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import type { JsonlCompression } from './format.ts'
import { decompressZstdFrame, scanZstdFrames } from './zstd.ts'

/** Default trailing event bound for one history window. */
export const DEFAULT_WINDOW_EVENTS = 2_000
/** Hard upper bound for one history window. */
export const MAX_WINDOW_EVENTS = 10_000

/** One validated trailing slice of a current generation. */
export interface JsonlTailWindow {
  /** Decoded events in seq order; never empty for a non-empty log. */
  readonly events: readonly SessionEvent[]
  /** Whether durable events below the first returned seq still exist. */
  readonly hasMore: boolean
}

/**
 * Clamp one requested window bound to the backend's supported range.
 * @param maxEvents - caller bound, or `undefined` for the default.
 * @returns the clamped positive bound, or `undefined` for a non-integer request.
 */
export function windowEventLimit(maxEvents: number | undefined): number | undefined {
  if (maxEvents === undefined) return DEFAULT_WINDOW_EVENTS
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) return undefined
  return Math.min(maxEvents, MAX_WINDOW_EVENTS)
}

interface SelectedRows {
  readonly lines: readonly Buffer[]
  readonly firstSeq: number
  /** Whether the selection starts at the first event row of the generation. */
  readonly selectedAll: boolean
}

/**
 * Read the newest validated events from one current generation.
 *
 * A seeded header needs its inherited cut from the preceding prefix, which a
 * tail read cannot establish; callers refuse that case before calling this.
 * Any structural or row-level failure returns `undefined` so the caller falls
 * back to the complete read path rather than serving an unvalidated window.
 * @param bytes - complete bytes of one stable current generation revision.
 * @param compression - configured physical encoding.
 * @param headerValue - parsed physical header record of that same revision.
 * @param headerLine - exact header record text, compared against the selected bytes.
 * @param maxEvents - clamped positive window bound.
 * @param signal - optional cancellation.
 * @returns the validated trailing window, or `undefined` when it cannot be established.
 */
export async function readJsonlTailWindow(
  bytes: Buffer,
  compression: JsonlCompression,
  headerValue: unknown,
  headerLine: string,
  maxEvents: number,
  signal?: AbortSignal,
): Promise<JsonlTailWindow | undefined> {
  signal?.throwIfAborted()
  const selected = compression === 'zstd'
    ? await selectZstdTail(bytes, headerLine, maxEvents, signal)
    : selectPlainTail(bytes, headerLine, maxEvents)
  if (selected === undefined) return undefined
  signal?.throwIfAborted()
  return decodeRows(selected, headerValue, signal)
}

/** Decode selected rows with a decoder seeded at the first row's logical seq. */
function decodeRows(
  selected: SelectedRows,
  headerValue: unknown,
  signal: AbortSignal | undefined,
): JsonlTailWindow | undefined {
  const events: SessionEvent[] = []
  const context: SessionFormatMigrationContext = {
    emitEvent(event: SessionFormatEvent) {
      events.push(event as SessionEvent)
    },
    emitRun(run) {
      for (const event of run.expand()) events.push(event as SessionEvent)
    },
  }
  try {
    const decoder = releasedV4SessionFormatCodec.createDecoder(headerValue, 'strict', {
      eventCount: selected.firstSeq,
      partial: true,
    })
    for (const line of selected.lines) {
      signal?.throwIfAborted()
      const row: unknown = JSON.parse(line.toString('utf8'))
      assertV4RowAdmission(row, KNOWN_SESSION_EVENT_TYPES)
      decoder.decodeRow(row, context)
    }
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
  if (events.length !== selected.lines.length) return undefined
  if (selected.lines.length === 0) return { events, hasMore: false }
  const firstSeq = Number((events[0] as SessionEvent).seq)
  // The decoder gates every row on the seeded expected seq, so this proves the
  // index-free row numbering matched the selected rows.
  if (firstSeq !== selected.firstSeq) return undefined
  if ((firstSeq === 0) !== selected.selectedAll) return undefined
  return { events, hasMore: firstSeq > 0 }
}

/** Select the trailing `maxEvents` complete JSONL rows of an uncompressed generation. */
function selectPlainTail(
  bytes: Buffer,
  headerLine: string,
  maxEvents: number,
): SelectedRows | undefined {
  const headerEnd = bytes.indexOf(0x0A)
  if (headerEnd === -1) return undefined
  if (bytes.subarray(0, headerEnd).toString('utf8') !== headerLine) return undefined
  // A torn physical tail belongs to the write-repair path, not to a window.
  if (bytes.length > headerEnd + 1 && bytes.at(-1) !== 0x0A) return undefined
  const body = bytes.subarray(headerEnd + 1)
  if (body.length === 0) return { lines: [], firstSeq: 0, selectedAll: true }

  let totalRows = 0
  for (let newline = body.indexOf(0x0A); newline !== -1; newline = body.indexOf(0x0A, newline + 1)) {
    totalRows += 1
  }
  const startRow = Math.max(0, totalRows - maxEvents)
  let lineStart = 0
  for (let row = 0; row < startRow; row += 1) {
    const newline = body.indexOf(0x0A, lineStart)
    if (newline === -1) return undefined
    lineStart = newline + 1
  }
  const lines: Buffer[] = []
  while (lineStart < body.length) {
    const newline = body.indexOf(0x0A, lineStart)
    if (newline === -1) return undefined
    lines.push(body.subarray(lineStart, newline))
    lineStart = newline + 1
  }
  if (lines.length === 0) return undefined
  return { lines, firstSeq: startRow, selectedAll: startRow === 0 }
}

/** Select the trailing complete rows of a concatenated Zstandard generation. */
async function selectZstdTail(
  bytes: Buffer,
  headerLine: string,
  maxEvents: number,
  signal: AbortSignal | undefined,
): Promise<SelectedRows | undefined> {
  const { frames, tornStart } = scanZstdFrames(bytes)
  if (tornStart !== undefined || frames.length === 0) return undefined
  const headerRecord = frames[0] as { start: number; end: number }
  const headerFrame = await decompressZstdFrame(bytes.subarray(headerRecord.start, headerRecord.end))
  if (headerFrame.length === 0 || headerFrame.indexOf(0x0A) !== headerFrame.length - 1) return undefined
  if (headerFrame.subarray(0, -1).toString('utf8') !== headerLine) return undefined

  const selected: Buffer[] = []
  let totalRows = 0
  for (let index = frames.length - 1; index >= 1; index -= 1) {
    signal?.throwIfAborted()
    const frame = frames[index] as { start: number; end: number }
    const plaintext = await decompressZstdFrame(bytes.subarray(frame.start, frame.end))
    // A complete frame that does not end on a record boundary is not a
    // window unit; the full path owns that diagnosis and recovery.
    if (plaintext.length === 0 || plaintext.at(-1) !== 0x0A) return undefined
    selected.unshift(plaintext)
    for (let newline = plaintext.indexOf(0x0A); newline !== -1; newline = plaintext.indexOf(0x0A, newline + 1)) {
      totalRows += 1
    }
    if (totalRows >= maxEvents) break
  }
  const earliestFrame = frames.length - selected.length
  if (totalRows === 0) {
    return { lines: [], firstSeq: 0, selectedAll: earliestFrame === 1 }
  }

  const droppedRows = Math.max(0, totalRows - maxEvents)
  const selectedAll = earliestFrame === 1 && droppedRows === 0
  let drop = droppedRows
  const lines: Buffer[] = []
  for (const plaintext of selected) {
    let lineStart = 0
    while (lineStart < plaintext.length) {
      const newline = plaintext.indexOf(0x0A, lineStart)
      if (newline === -1) return undefined
      if (drop > 0) drop -= 1
      else lines.push(plaintext.subarray(lineStart, newline))
      lineStart = newline + 1
    }
  }
  if (drop !== 0 || lines.length === 0) return undefined
  const firstRow: unknown = JSON.parse((lines[0] as Buffer).toString('utf8'))
  const firstSeq = (firstRow as { seq?: unknown }).seq
  if (typeof firstSeq !== 'number' || !Number.isSafeInteger(firstSeq) || firstSeq < 0) return undefined
  return { lines, firstSeq, selectedAll }
}
