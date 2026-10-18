/**
 * Durable per-generation window index for the JSONL session-persistence backend.
 *
 * The index records row-aligned decode segments: one entry per physically
 * complete Zstandard frame, or per bounded row segment of an uncompressed
 * body. It lets a backwards `readWindow` seed the released v4 decoder at the
 * first selected segment and decode only that segment range.
 *
 * The sidecar is a rebuildable cache, never a validating path. It is valid only
 * while the generation's size and modification time match the recorded source
 * identity; any read, parse, structural, or identity failure discards it and one
 * full frame walk rebuilds it. A build failure returns `undefined` so the caller
 * keeps the complete read as the fallback and exact-validation path.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/window-index
 */

import { randomBytes } from 'node:crypto'
import { open as openFile, readFile, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { SessionFormatMigrationContext } from '@deepseek-ai/dsh-session-format'
import { assertV4RowAdmission, releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import type { JsonlCompression } from './format.ts'
import { readStableJsonlFile, type StablePhysicalFile } from './generation.ts'
import { createZstdFrameDecoder, scanZstdFrames, type ZstdFrameRange, type ZstdFrameScan } from './zstd.ts'

/** Schema version of the durable generation index this build reads and writes. */
export const WINDOW_INDEX_VERSION = 1

/** Suffix appended to the generation filename for its index sidecar. */
const WINDOW_INDEX_SUFFIX = '.window-index.json'

/** Rows per uncompressed decode segment; bounds one backwards-page byte read. */
const PLAIN_INDEX_SEGMENT_ROWS = 256

/** Upper bound on a readable sidecar; a larger file is not an index this build wrote. */
const MAX_WINDOW_INDEX_BYTES = 64 * 1024 * 1024

/** Internal scheduling bound for one index-build decode slice, not deployment configuration. */
const INDEX_BUILD_YIELD_INTERVAL_MS = 50

const INDEX_KEYS = ['version', 'source', 'inheritedEventCount', 'frames'] as const
const SOURCE_KEYS = ['sizeBytes', 'mtimeMs'] as const
const FRAME_KEYS = ['offset', 'length', 'firstRow', 'firstSeq', 'events'] as const

/** Physical generation identity the index was derived from. */
export interface JsonlWindowIndexSource {
  /** Exact generation size in bytes. */
  readonly sizeBytes: number
  /** Generation modification time in milliseconds. */
  readonly mtimeMs: number
}

/** One row-aligned decode segment of a generation. */
export interface JsonlWindowIndexFrame {
  /** Segment start byte in the generation file. */
  readonly offset: number
  /** Segment byte length. */
  readonly length: number
  /** Physical row index of the segment's first event row. */
  readonly firstRow: number
  /** Logical seq of the segment's first event row; equal to {@link firstRow} for a dense current log. */
  readonly firstSeq: number
  /** Event rows contained in the segment. */
  readonly events: number
}

/** One validated generation index sidecar. */
export interface JsonlWindowIndex {
  /** Schema version; only {@link WINDOW_INDEX_VERSION} is read. */
  readonly version: typeof WINDOW_INDEX_VERSION
  /** Generation identity this index describes. */
  readonly source: JsonlWindowIndexSource
  /** Exact inherited cut the build validated; an unseeded generation records `0`. */
  readonly inheritedEventCount: number
  /** Decode segments covering the complete generation, in file order. */
  readonly frames: readonly JsonlWindowIndexFrame[]
}

/** A loaded index plus whether it came from the sidecar or from a rebuild in this call. */
export interface LoadedWindowIndex {
  readonly index: JsonlWindowIndex
  /** True when the sidecar was accepted; a decode failure may then justify one rebuild. */
  readonly cached: boolean
}

interface BuiltWindowIndex {
  readonly inheritedEventCount: number
  readonly frames: readonly JsonlWindowIndexFrame[]
}

/**
 * The sidecar path for one generation.
 * @param generationPath - selected generation file path.
 * @returns the index sidecar path beside that generation.
 */
export function windowIndexPath(generationPath: string): string {
  return `${generationPath}${WINDOW_INDEX_SUFFIX}`
}

/**
 * Read one generation's current physical identity.
 * @param generationPath - selected generation file path.
 * @param signal - optional cancellation.
 * @returns the size and modification time the index must match, or `undefined`
 *   when the generation cannot be statted (the complete read reports the fault).
 */
export async function readWindowIndexSource(
  generationPath: string,
  signal?: AbortSignal,
): Promise<JsonlWindowIndexSource | undefined> {
  signal?.throwIfAborted()
  try {
    const info = await stat(generationPath, { bigint: true })
    signal?.throwIfAborted()
    return { sizeBytes: Number(info.size), mtimeMs: Number(info.mtimeMs) }
  } catch {
    // A vanished or unreadable generation has no index identity; the caller
    // falls back to the complete read, which surfaces the storage fault.
    signal?.throwIfAborted()
    return undefined
  }
}

/**
 * Read the sidecar for one generation when it is structurally valid and matches
 * {@link source}.
 * @param generationPath - selected generation file path.
 * @param source - current generation identity.
 * @returns the accepted index, or `undefined` when the sidecar is missing,
 *   unreadable, corrupt, structurally invalid, or bound to another revision.
 */
export async function readWindowIndex(
  generationPath: string,
  source: JsonlWindowIndexSource,
): Promise<JsonlWindowIndex | undefined> {
  const path = windowIndexPath(generationPath)
  let text: string
  try {
    const info = await stat(path, { bigint: true })
    if (!info.isFile() || info.size > BigInt(MAX_WINDOW_INDEX_BYTES)) return undefined
    text = await readFile(path, 'utf8')
  } catch {
    // A missing, unreadable, or non-file sidecar is an absent cache.
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const index = parseWindowIndex(value)
  if (index === undefined) return undefined
  if (index.source.sizeBytes !== source.sizeBytes || index.source.mtimeMs !== source.mtimeMs) return undefined
  return index
}

/** Validate one parsed sidecar value; any deviation is a discarded cache. */
function parseWindowIndex(value: unknown): JsonlWindowIndex | undefined {
  if (!isRecord(value) || !hasExactKeys(value, INDEX_KEYS)) return undefined
  if (value.version !== WINDOW_INDEX_VERSION) return undefined
  const source = value.source
  if (!isRecord(source) || !hasExactKeys(source, SOURCE_KEYS)) return undefined
  if (!isCount(source.sizeBytes) || !isMilliseconds(source.mtimeMs)) return undefined
  if (!isCount(value.inheritedEventCount)) return undefined
  const entries = value.frames
  if (!Array.isArray(entries) || entries.length === 0) return undefined
  const frames: JsonlWindowIndexFrame[] = []
  let previousEnd = 0
  let rows = 0
  for (const [position, entry] of entries.entries()) {
    if (!isRecord(entry) || !hasExactKeys(entry, FRAME_KEYS)) return undefined
    const { offset, length, firstRow, firstSeq, events } = entry
    if (!isCount(offset) || !isCount(length) || !isCount(firstRow) || !isCount(firstSeq) || !isCount(events)) {
      return undefined
    }
    if (length === 0 || offset !== previousEnd) return undefined
    if (firstRow !== rows || firstSeq !== rows) return undefined
    // The first segment is the header record and holds no event row.
    if (position === 0 && (offset !== 0 || events !== 0)) return undefined
    previousEnd = offset + length
    rows += events
    frames.push({ offset, length, firstRow, firstSeq, events })
  }
  if (previousEnd !== source.sizeBytes) return undefined
  return {
    version: WINDOW_INDEX_VERSION,
    source: { sizeBytes: source.sizeBytes, mtimeMs: source.mtimeMs },
    inheritedEventCount: value.inheritedEventCount,
    frames,
  }
}

/**
 * Load the sidecar, or build and persist it with one full frame walk.
 * @param generationPath - selected generation file path.
 * @param compression - configured physical encoding.
 * @param headerValue - parsed physical header of that generation.
 * @param headerLine - exact header record text the walk must reproduce.
 * @param signal - optional cancellation.
 * @returns the accepted or rebuilt index, or `undefined` when neither can be established.
 */
export async function loadWindowIndex(
  generationPath: string,
  compression: JsonlCompression,
  headerValue: unknown,
  headerLine: string,
  signal?: AbortSignal,
): Promise<LoadedWindowIndex | undefined> {
  signal?.throwIfAborted()
  const source = await readWindowIndexSource(generationPath, signal)
  if (source === undefined) return undefined
  const cached = await readWindowIndex(generationPath, source)
  if (cached !== undefined) return { index: cached, cached: true }
  signal?.throwIfAborted()
  const rebuilt = await rebuildWindowIndex(generationPath, compression, headerValue, headerLine, signal)
  return rebuilt === undefined ? undefined : { index: rebuilt, cached: false }
}

/**
 * Build and persist one index from a complete validated frame walk.
 * @param generationPath - selected generation file path.
 * @param compression - configured physical encoding.
 * @param headerValue - parsed physical header of that generation.
 * @param headerLine - exact header record text the walk must reproduce.
 * @param signal - optional cancellation.
 * @returns the persisted index, or `undefined` when the walk cannot validate the generation.
 */
export async function rebuildWindowIndex(
  generationPath: string,
  compression: JsonlCompression,
  headerValue: unknown,
  headerLine: string,
  signal?: AbortSignal,
): Promise<JsonlWindowIndex | undefined> {
  signal?.throwIfAborted()
  let source: StablePhysicalFile
  try {
    source = await readStableJsonlFile(generationPath, signal)
  } catch {
    // A concurrent change or storage fault keeps the window out of this build;
    // the caller falls back to the complete read.
    signal?.throwIfAborted()
    return undefined
  }
  signal?.throwIfAborted()
  if (source.bytes.length !== Number(source.identity.size)) return undefined
  const built = compression === 'zstd'
    ? await buildZstdIndex(source.bytes, headerValue, headerLine, signal)
    : await buildPlainIndex(source.bytes, headerValue, headerLine, signal)
  if (built === undefined) return undefined
  const index: JsonlWindowIndex = {
    version: WINDOW_INDEX_VERSION,
    source: {
      sizeBytes: source.bytes.length,
      // Whole milliseconds, matching `stat(..., { bigint: true }).mtimeMs`.
      mtimeMs: Number(source.identity.mtimeNs / 1_000_000n),
    },
    inheritedEventCount: built.inheritedEventCount,
    frames: built.frames,
  }
  try {
    await writeWindowIndex(generationPath, index)
  } catch {
    // The sidecar is a rebuildable cache: a read-only generation directory or a
    // failed atomic publish must not fail a window this call already validated.
  }
  return index
}

/**
 * Write one index beside its generation with a synced temporary file and an
 * atomic rename, so readers observe either the previous or the complete index.
 * @param generationPath - selected generation file path.
 * @param index - validated index to persist.
 */
export async function writeWindowIndex(
  generationPath: string,
  index: JsonlWindowIndex,
): Promise<void> {
  const target = windowIndexPath(generationPath)
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`
  const handle: FileHandle = await openFile(temporary, 'wx', 0o600)
  let failure: Error | undefined
  try {
    await handle.writeFile(`${JSON.stringify(index)}\n`)
    await handle.sync()
  } catch (error: unknown) {
    failure = asError(error)
  }
  try {
    await handle.close()
  } catch (error: unknown) {
    failure ??= asError(error)
  }
  if (failure !== undefined) {
    await rm(temporary, { force: true })
    throw failure
  }
  try {
    await rename(temporary, target)
  } catch (error: unknown) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** Build index segments for one uncompressed generation from a complete row walk. */
async function buildPlainIndex(
  bytes: Buffer,
  headerValue: unknown,
  headerLine: string,
  signal: AbortSignal | undefined,
): Promise<BuiltWindowIndex | undefined> {
  const headerEnd = bytes.indexOf(0x0A)
  if (headerEnd === -1) return undefined
  if (bytes.subarray(0, headerEnd).toString('utf8') !== headerLine) return undefined
  // A torn physical tail belongs to the write-repair path, not to a window.
  if (bytes.length > headerEnd + 1 && bytes.at(-1) !== 0x0A) return undefined
  const frames: JsonlWindowIndexFrame[] = [{
    offset: 0,
    length: headerEnd + 1,
    firstRow: 0,
    firstSeq: 0,
    events: 0,
  }]
  let rows = 0
  let emitted = 0
  const context: SessionFormatMigrationContext = {
    emitEvent() {
      emitted += 1
    },
    emitRun(run) {
      emitted += run.eventCount
    },
  }
  try {
    const decoder = releasedV4SessionFormatCodec.createDecoder(headerValue, 'strict')
    let segmentStart = headerEnd + 1
    let segmentRows = 0
    let lineStart = headerEnd + 1
    let yieldDeadline = performance.now() + INDEX_BUILD_YIELD_INTERVAL_MS
    while (lineStart < bytes.length) {
      const newline = bytes.indexOf(0x0A, lineStart)
      if (newline === -1) return undefined
      const row: unknown = JSON.parse(bytes.subarray(lineStart, newline).toString('utf8'))
      assertV4RowAdmission(row, KNOWN_SESSION_EVENT_TYPES)
      decoder.decodeRow(row, context)
      lineStart = newline + 1
      rows += 1
      segmentRows += 1
      if (segmentRows === PLAIN_INDEX_SEGMENT_ROWS && lineStart < bytes.length) {
        frames.push({
          offset: segmentStart,
          length: lineStart - segmentStart,
          firstRow: rows - segmentRows,
          firstSeq: rows - segmentRows,
          events: segmentRows,
        })
        segmentStart = lineStart
        segmentRows = 0
      }
      if (performance.now() >= yieldDeadline) {
        await scheduler.yield()
        signal?.throwIfAborted()
        yieldDeadline = performance.now() + INDEX_BUILD_YIELD_INTERVAL_MS
      }
    }
    if (segmentRows > 0) {
      frames.push({
        offset: segmentStart,
        length: lineStart - segmentStart,
        firstRow: rows - segmentRows,
        firstSeq: rows - segmentRows,
        events: segmentRows,
      })
    }
    // One decoded event per physical row is what the window decoder relies on.
    if (emitted !== rows) return undefined
    return { inheritedEventCount: decoder.finish(context), frames }
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
}

/** Build index segments for one concatenated Zstandard generation from a complete frame walk. */
async function buildZstdIndex(
  bytes: Buffer,
  headerValue: unknown,
  headerLine: string,
  signal: AbortSignal | undefined,
): Promise<BuiltWindowIndex | undefined> {
  let scan: ZstdFrameScan
  try {
    scan = scanZstdFrames(bytes)
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
  if (scan.tornStart !== undefined || scan.frames.length === 0) return undefined

  const frames: JsonlWindowIndexFrame[] = []
  let rows = 0
  let emitted = 0
  const context: SessionFormatMigrationContext = {
    emitEvent() {
      emitted += 1
    },
    emitRun(run) {
      emitted += run.eventCount
    },
  }
  const frameDecoder = createZstdFrameDecoder()
  try {
    const decoder = releasedV4SessionFormatCodec.createDecoder(headerValue, 'strict')
    // One synchronous decode pass over the scanned frames: the decoder yields
    // exactly one plaintext buffer per range, header frame first, and reuses its
    // scratch buffer, so each frame is consumed before the iterator advances.
    const decoded = frameDecoder.decode(bytes, scan.frames)
    let yieldDeadline = performance.now() + INDEX_BUILD_YIELD_INTERVAL_MS
    let position = 0
    for (const plaintext of decoded) {
      signal?.throwIfAborted()
      const range = scan.frames[position] as ZstdFrameRange
      position += 1
      if (position === 1) {
        // The header frame is the exact header record and nothing else.
        if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) return undefined
        if (plaintext.subarray(0, -1).toString('utf8') !== headerLine) return undefined
        frames.push({
          offset: range.start,
          length: range.end - range.start,
          firstRow: 0,
          firstSeq: 0,
          events: 0,
        })
        continue
      }
      // A complete frame that does not end on a record boundary is not a
      // window unit; the complete read owns that diagnosis and recovery.
      if (plaintext.length === 0 || plaintext.at(-1) !== 0x0A) return undefined
      let frameRows = 0
      let lineStart = 0
      while (lineStart < plaintext.length) {
        const newline = plaintext.indexOf(0x0A, lineStart)
        if (newline === -1) return undefined
        const row: unknown = JSON.parse(plaintext.subarray(lineStart, newline).toString('utf8'))
        assertV4RowAdmission(row, KNOWN_SESSION_EVENT_TYPES)
        decoder.decodeRow(row, context)
        lineStart = newline + 1
        frameRows += 1
        if (performance.now() >= yieldDeadline) {
          await scheduler.yield()
          signal?.throwIfAborted()
          yieldDeadline = performance.now() + INDEX_BUILD_YIELD_INTERVAL_MS
        }
      }
      frames.push({
        offset: range.start,
        length: range.end - range.start,
        firstRow: rows,
        firstSeq: rows,
        events: frameRows,
      })
      rows += frameRows
      // One decoded event per physical row is what the window decoder relies on.
      if (emitted !== rows) return undefined
    }
    if (emitted !== rows) return undefined
    return { inheritedEventCount: decoder.finish(context), frames }
  } catch {
    signal?.throwIfAborted()
    return undefined
  } finally {
    frameDecoder.close()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('window index write failed with a non-Error rejection', { cause: error })
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function isMilliseconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
