/**
 * Bounded windows over one current JSONL Session generation.
 *
 * The newest window stays index-free: it selects the trailing physical frames,
 * seeds the released v4 decoder at the first selected row's seq, and decodes
 * only those rows. A backwards (`beforeSeq`) window uses the durable generation
 * index to read and decode only the selected decode segments. Neither path
 * establishes the complete-log relationships that `SessionLogScanner` checks;
 * readers that need those keep using the full read path.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/window
 */

import { open as openFile, type FileHandle } from 'node:fs/promises'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionFormatEvent, SessionFormatMigrationContext } from '@deepseek-ai/dsh-session-format'
import { assertV4RowAdmission, releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import type { JsonlCompression } from './format.ts'
import {
  loadWindowIndex, readWindowIndex, readWindowIndexSource, rebuildWindowIndex,
  type JsonlWindowIndex, type JsonlWindowIndexFrame, type JsonlWindowIndexSource, type LoadedWindowIndex,
} from './window-index.ts'
import type { WindowIndexMemo } from './window-index-memo.ts'
import { createZstdFrameDecoder, decompressZstdFrame, scanZstdFrames } from './zstd.ts'

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

/** One validated backwards window read from a durable generation index. */
export interface JsonlIndexedWindow extends JsonlTailWindow {
  /** Exact inherited cut the index build validated; an unseeded generation reports `0`. */
  readonly inheritedEventCount: number
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

/** One selected decode segment paired with its plaintext bytes. */
interface FramePlaintext {
  readonly frame: JsonlWindowIndexFrame
  readonly plaintext: Buffer
}

/**
 * Read the events ending below `beforeSeq` from the durable generation index.
 *
 * The window selects the trailing index segments covering the requested row
 * range, reads only their byte range, and seeds the released v4 decoder at the
 * first selected segment. Rows in that segment below the requested start are
 * decoded and dropped so the decoder's sequence gate keeps proving row
 * numbering. Any missing, stale, corrupt, or inconsistent index returns
 * `undefined` so the caller reads the complete log.
 * @param sourcePath - selected current-generation file path.
 * @param compression - configured physical encoding.
 * @param headerValue - parsed physical header of the same revision.
 * @param headerLine - exact header record text the index must reproduce.
 * @param beforeSeq - exclusive end of the requested window.
 * @param maxEvents - clamped positive window bound.
 * @param signal - optional cancellation.
 * @param memo - backend-owned parsed-index memo; omit it to read the sidecar every time.
 * @returns the validated backwards window, or `undefined` when it cannot be established.
 */
export async function readJsonlIndexedWindow(
  sourcePath: string,
  compression: JsonlCompression,
  headerValue: unknown,
  headerLine: string,
  beforeSeq: number,
  maxEvents: number,
  signal?: AbortSignal,
  memo?: WindowIndexMemo,
): Promise<JsonlIndexedWindow | undefined> {
  signal?.throwIfAborted()
  let loaded = await loadIndexedSource(sourcePath, compression, headerValue, headerLine, signal, memo)
  if (loaded === undefined) return undefined
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted()
    const window = await decodeIndexedWindow(
      sourcePath, compression, headerValue, loaded.index, beforeSeq, maxEvents, signal,
    )
    if (window !== undefined) return window
    // A sidecar can be structurally valid and bound to the current revision yet
    // still disagree with the bytes it claims to index. Rebuild once instead of
    // disabling paging until the generation changes.
    if (!loaded.cached || attempt > 0) return undefined
    memo?.delete(sourcePath)
    const rebuilt = await rebuildWindowIndex(sourcePath, compression, headerValue, headerLine, signal)
    if (rebuilt === undefined) return undefined
    await memo?.set(sourcePath, rebuilt.source, rebuilt)
    loaded = { index: rebuilt, cached: false }
  }
}

/**
 * Load one generation's index through the owner's memo when it has one.
 *
 * The memo is an optimization, never an additional validation path: a miss
 * performs the same sidecar read and one rebuild, a rebuilt index is retained
 * under the identity that build observed, and every load failure still returns
 * `undefined` for the caller's complete-read fallback.
 * @param sourcePath - selected current-generation file path.
 * @param compression - configured physical encoding.
 * @param headerValue - parsed physical header of the same revision.
 * @param headerLine - exact header record text the index must reproduce.
 * @param signal - optional cancellation.
 * @param memo - backend-owned parsed-index memo, or `undefined` for a plain sidecar read.
 * @returns the loaded index and whether it came from a sidecar, or `undefined`.
 */
async function loadIndexedSource(
  sourcePath: string,
  compression: JsonlCompression,
  headerValue: unknown,
  headerLine: string,
  signal: AbortSignal | undefined,
  memo: WindowIndexMemo | undefined,
): Promise<LoadedWindowIndex | undefined> {
  if (memo === undefined) return loadWindowIndex(sourcePath, compression, headerValue, headerLine, signal)
  signal?.throwIfAborted()
  const source: JsonlWindowIndexSource | undefined = await readWindowIndexSource(sourcePath, signal)
  if (source === undefined) {
    // A vanished or unreadable generation has no identity to reuse; release its
    // retained parse now instead of keeping it until the bound evicts it.
    memo.delete(sourcePath)
    return undefined
  }
  const cached = await memo.load(sourcePath, source, () => readWindowIndex(sourcePath, source))
  if (cached !== undefined) return { index: cached, cached: true }
  signal?.throwIfAborted()
  const rebuilt = await rebuildWindowIndex(sourcePath, compression, headerValue, headerLine, signal)
  if (rebuilt === undefined) return undefined
  await memo.set(sourcePath, rebuilt.source, rebuilt)
  return { index: rebuilt, cached: false }
}

/** Select, read, and decode one backwards window from an accepted index. */
async function decodeIndexedWindow(
  sourcePath: string,
  compression: JsonlCompression,
  headerValue: unknown,
  index: JsonlWindowIndex,
  beforeSeq: number,
  maxEvents: number,
  signal: AbortSignal | undefined,
): Promise<JsonlIndexedWindow | undefined> {
  let totalEvents = 0
  for (const frame of index.frames) totalEvents += frame.events
  // A cut at or below the inherited boundary is empty; a cut past the log end
  // keeps every durable event.
  const boundary = Math.min(beforeSeq, totalEvents)
  if (boundary === 0) {
    return { events: [], hasMore: false, inheritedEventCount: index.inheritedEventCount }
  }
  const startRow = Math.max(0, boundary - maxEvents)
  const firstFrame = frameContainingRow(index.frames, startRow)
  const lastFrame = frameContainingRow(index.frames, boundary - 1)
  if (firstFrame === undefined || lastFrame === undefined || firstFrame > lastFrame) return undefined
  const selected = index.frames.slice(firstFrame, lastFrame + 1)
  const first = selected[0] as JsonlWindowIndexFrame
  const last = selected[selected.length - 1] as JsonlWindowIndexFrame
  const bytes = await readGenerationRange(sourcePath, first.offset, last.offset + last.length, signal)
  if (bytes === undefined) return undefined
  signal?.throwIfAborted()
  // The index describes one exact revision; a generation that changed while the
  // segments were read can no longer be served from their offsets.
  const current = await readWindowIndexSource(sourcePath, signal)
  if (current === undefined
    || current.sizeBytes !== index.source.sizeBytes
    || current.mtimeMs !== index.source.mtimeMs) return undefined
  return decodeIndexedFrames(
    selectedPlains(bytes, first, selected, compression, signal),
    startRow,
    boundary,
    headerValue,
    index.inheritedEventCount,
    signal,
  )
}

/**
 * Yield the selected segments' plaintext in file order, decoding them in one pass.
 *
 * One bounded page selects many small frames, so one awaited one-shot decode per
 * frame dominates the read. The backend frame decoder instead decodes the complete
 * contiguous byte range through one reused Zstandard context. Its plaintext
 * buffers are scratch memory, so {@link decodeIndexedFrames} consumes each one
 * before the iterator advances.
 * @param bytes - exact bytes of the selected frame range.
 * @param first - lowest selected segment, whose offset is byte 0 of `bytes`.
 * @param selected - selected segments in file order.
 * @param compression - configured physical encoding.
 * @param signal - optional cancellation.
 * @returns one plaintext segment per selected frame, paired with its index entry.
 */
function* selectedPlains(
  bytes: Buffer,
  first: JsonlWindowIndexFrame,
  selected: readonly JsonlWindowIndexFrame[],
  compression: JsonlCompression,
  signal: AbortSignal | undefined,
): Generator<FramePlaintext, void, void> {
  if (compression !== 'zstd') {
    for (const frame of selected) {
      signal?.throwIfAborted()
      const start = frame.offset - first.offset
      yield { frame, plaintext: bytes.subarray(start, start + frame.length) }
    }
    return
  }
  const ranges = selected.map(frame => ({
    start: frame.offset - first.offset,
    end: frame.offset - first.offset + frame.length,
  }))
  const frameDecoder = createZstdFrameDecoder()
  try {
    let position = 0
    for (const plaintext of frameDecoder.decode(bytes, ranges)) {
      signal?.throwIfAborted()
      const frame = selected[position]
      /* v8 ignore next -- the decoder yields exactly one plaintext per requested range. */
      if (frame === undefined) throw new Error('Zstandard frame decoder produced an unrequested frame')
      position += 1
      yield { frame, plaintext }
    }
    /* v8 ignore next -- the decoder yields exactly one plaintext per requested range. */
    if (position !== selected.length) throw new Error('Zstandard frame decoder omitted a requested frame')
  } finally {
    frameDecoder.close()
  }
}

/** Decode the selected segments and prove the returned slice is the requested dense range. */
function decodeIndexedFrames(
  plains: Iterable<FramePlaintext>,
  startRow: number,
  boundary: number,
  headerValue: unknown,
  inheritedEventCount: number,
  signal: AbortSignal | undefined,
): JsonlIndexedWindow | undefined {
  const expected = boundary - startRow
  const events: SessionEvent[] = []
  let currentRow = -1
  const context: SessionFormatMigrationContext = {
    emitEvent(event: SessionFormatEvent) {
      if (currentRow >= startRow) events.push(event as SessionEvent)
    },
    emitRun(run) {
      if (currentRow < startRow) return
      for (const event of run.expand()) events.push(event as SessionEvent)
    },
  }
  let decoder: ReturnType<typeof releasedV4SessionFormatCodec.createDecoder> | undefined
  let inherited: number
  try {
    for (const { frame, plaintext } of plains) {
      signal?.throwIfAborted()
      if (plaintext.length === 0 || plaintext.at(-1) !== 0x0A) return undefined
      decoder ??= releasedV4SessionFormatCodec.createDecoder(headerValue, 'strict', {
        rowIndex: frame.firstRow,
        eventCount: frame.firstSeq,
        partial: true,
      })
      let lineStart = 0
      let row = frame.firstRow
      let rows = 0
      for (let newline = plaintext.indexOf(0x0A); newline !== -1; newline = plaintext.indexOf(0x0A, lineStart)) {
        const line = plaintext.subarray(lineStart, newline)
        lineStart = newline + 1
        rows += 1
        // The final selected segment may continue past the requested cut.
        if (row >= boundary) continue
        currentRow = row
        row += 1
        const parsed: unknown = JSON.parse(line.toString('utf8'))
        assertV4RowAdmission(parsed, KNOWN_SESSION_EVENT_TYPES)
        decoder.decodeRow(parsed, context)
      }
      if (rows !== frame.events) return undefined
    }
    /* v8 ignore next -- one selected segment always exists for a non-empty range. */
    if (decoder === undefined) return undefined
    inherited = decoder.finish(context)
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
  if (inherited !== inheritedEventCount) return undefined
  if (events.length !== expected) return undefined
  if (events.length > 0) {
    if (Number((events[0] as SessionEvent).seq) !== startRow) return undefined
    if (Number((events[events.length - 1] as SessionEvent).seq) !== boundary - 1) return undefined
  }
  return { events, hasMore: startRow > 0, inheritedEventCount }
}

/** Binary-search the segment containing one physical row. */
function frameContainingRow(frames: readonly JsonlWindowIndexFrame[], row: number): number | undefined {
  let low = 0
  let high = frames.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const frame = frames[middle] as JsonlWindowIndexFrame
    if (row < frame.firstRow) high = middle - 1
    else if (row >= frame.firstRow + frame.events) low = middle + 1
    else return middle
  }
  return undefined
}

/** Read one exact byte range without loading the omitted prefix. */
async function readGenerationRange(
  path: string,
  start: number,
  end: number,
  signal: AbortSignal | undefined,
): Promise<Buffer | undefined> {
  const length = end - start
  if (!Number.isSafeInteger(length) || length <= 0) return undefined
  const buffer = Buffer.alloc(length)
  let handle: FileHandle | undefined
  try {
    handle = await openFile(path, 'r')
    let offset = 0
    while (offset < length) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset)
      if (bytesRead === 0) return undefined
      offset += bytesRead
    }
  } catch {
    // A vanished or unreadable generation keeps the window out; the complete
    // read reports the storage fault.
    signal?.throwIfAborted()
    return undefined
  } finally {
    await handle?.close()
  }
  return buffer
}
