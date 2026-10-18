/**
 * Bounded in-process memo of parsed window-index sidecars for the JSONL backend.
 *
 * Warm backwards (`beforeSeq`) pages re-read and re-parse the complete sidecar
 * for the same unchanged generation; on a large log that parse dominates the
 * page. This memo retains the validated parse for one exact generation identity
 * — source path, byte size, and modification time — so those pages reuse it.
 *
 * Generation identity is checked on every lookup, so a generation that changed,
 * vanished, or moved never reuses an entry, and a mismatch drops it. Reuse is
 * additionally guarded by the sidecar file's own state: replacing, truncating,
 * or deleting the sidecar changes that state and forces the same re-read and
 * rebuild the uncached path performs, so a cached parse never hides a sidecar
 * that the durable cache contract would have discarded.
 *
 * A missed entry falls through to the caller's own sidecar read and rebuild,
 * and a parse that finds no usable sidecar caches nothing, so a malformed or
 * missing sidecar keeps the complete-read fallback exactly as the uncached path
 * does. Concurrent callers for one identity share one in-flight parse.
 *
 * Retained values are frozen before they are stored, so every holder shares the
 * parsed index read-only. The memo holds no Session, Agent, or backend
 * reference; its owner constructs it, bounds it, and disposes it at teardown.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/window-index-memo
 */

import { stat } from 'node:fs/promises'
import { windowIndexPath, type JsonlWindowIndex, type JsonlWindowIndexSource } from './window-index.ts'

/**
 * Retained parsed indexes. One parsed large sidecar is tens of megabytes, so
 * the bound covers the generation being paged plus one interleaved Session at
 * most; this is internal memory policy, not deployment configuration.
 */
const DEFAULT_WINDOW_INDEX_MEMO_ENTRIES = 2

/** One memoized parse bound to its exact generation identity and sidecar revision. */
interface MemoEntry {
  readonly source: JsonlWindowIndexSource
  readonly sidecar: SidecarState
  readonly index: JsonlWindowIndex
}

/**
 * The sidecar file's own observable state.
 *
 * A missing path and a non-file path are distinct states because a replaceable
 * sidecar path can move between them, and each move must re-read like the
 * uncached path does.
 */
type SidecarState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'not-file' }
  | { readonly kind: 'file'; readonly size: bigint; readonly mtimeNs: bigint }

const SIDECAR_MISSING: SidecarState = { kind: 'missing' }
const SIDECAR_NOT_FILE: SidecarState = { kind: 'not-file' }

/**
 * Bounded identity-keyed memo of parsed generation indexes.
 *
 * A disposed memo retains nothing and never retains again; reads that reach it
 * after disposal still parse and return their index, so teardown racing a page
 * cannot fail the page or repopulate the memo.
 */
export class WindowIndexMemo {
  private readonly entries = new Map<string, MemoEntry>()
  /** One in-flight sidecar parse per generation identity and sidecar revision. */
  private readonly inFlight = new Map<string, Promise<JsonlWindowIndex | undefined>>()
  private disposed = false

  /**
   * @param maxEntries - retained parsed indexes; the least recently used entry is evicted first.
   */
  constructor(private readonly maxEntries: number = DEFAULT_WINDOW_INDEX_MEMO_ENTRIES) {}

  /** Retained parses, for bound diagnostics and teardown assertions. */
  get size(): number {
    return this.entries.size
  }

  /** Whether this memo has been disposed; a disposed memo retains nothing. */
  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Return the parsed index for one exact generation identity, parsing it at
   * most once per identity and sidecar revision across concurrent callers.
   *
   * The parse runs only on a miss; a result is retained only when it found a
   * usable sidecar, and retention freezes the value before any holder can see
   * it again.
   * @param sourcePath - selected current-generation file path.
   * @param source - exact generation identity the index must describe.
   * @param parse - reads and validates one sidecar; skipped on a hit and shared on a concurrent miss.
   * @returns the memoized or newly parsed index, or `undefined` when no usable sidecar exists.
   */
  async load(
    sourcePath: string,
    source: JsonlWindowIndexSource,
    parse: () => Promise<JsonlWindowIndex | undefined>,
  ): Promise<JsonlWindowIndex | undefined> {
    if (this.isClosed()) return parse()
    const sidecar = await readSidecarState(sourcePath)
    if (this.isClosed()) return parse()
    const cached = this.take(sourcePath, source, sidecar)
    if (cached !== undefined) return cached
    const key = flightKey(sourcePath, source, sidecar)
    const pending = this.inFlight.get(key)
    if (pending !== undefined) return pending
    const flight = (async () => {
      try {
        return await parse()
      } finally {
        this.inFlight.delete(key)
      }
    })()
    this.inFlight.set(key, flight)
    const parsed = await flight
    if (parsed !== undefined && !this.isClosed()) this.store(sourcePath, source, sidecar, parsed)
    return parsed
  }

  /**
   * Retain one parsed index under its exact generation identity and the
   * sidecar revision currently on disk, replacing any entry for that path and
   * evicting the least recently used entry past the bound.
   * @param sourcePath - selected current-generation file path.
   * @param source - exact generation identity the index describes.
   * @param index - validated index to retain; frozen before it is stored.
   */
  async set(sourcePath: string, source: JsonlWindowIndexSource, index: JsonlWindowIndex): Promise<void> {
    if (this.isClosed()) return
    const sidecar = await readSidecarState(sourcePath)
    if (this.isClosed()) return
    this.store(sourcePath, source, sidecar, index)
  }

  /**
   * Drop one path's retained parse after it proved unusable, so a later read
   * re-reads or rebuilds instead of serving it again.
   * @param sourcePath - selected current-generation file path.
   */
  delete(sourcePath: string): void {
    this.entries.delete(sourcePath)
  }

  /**
   * Release every retained parse and joinable parse reference. Idempotent; a
   * later {@link WindowIndexMemo.load} still returns its parse without retaining it.
   */
  dispose(): void {
    this.disposed = true
    this.entries.clear()
    this.inFlight.clear()
  }

  /**
   * Read the disposal flag through a call: control-flow narrowing must not let
   * a disposal that lands during an await look impossible.
   * @returns whether this memo has been disposed.
   */
  private isClosed(): boolean {
    return this.disposed
  }

  /** Return one entry only while its identity and sidecar revision both match, refreshing its recency. */
  private take(
    sourcePath: string,
    source: JsonlWindowIndexSource,
    sidecar: SidecarState,
  ): JsonlWindowIndex | undefined {
    const entry = this.entries.get(sourcePath)
    if (entry === undefined) return undefined
    // The path alone is not the key: an entry belongs to the exact generation
    // bytes and sidecar file it was parsed from.
    if (entry.source.sizeBytes !== source.sizeBytes
      || entry.source.mtimeMs !== source.mtimeMs
      || !sameSidecarState(entry.sidecar, sidecar)) {
      this.entries.delete(sourcePath)
      return undefined
    }
    this.entries.delete(sourcePath)
    this.entries.set(sourcePath, entry)
    return entry.index
  }

  /** Retain one parsed value and evict least recently used entries past the bound. */
  private store(
    sourcePath: string,
    source: JsonlWindowIndexSource,
    sidecar: SidecarState,
    index: JsonlWindowIndex,
  ): void {
    this.entries.delete(sourcePath)
    this.entries.set(sourcePath, {
      source: { sizeBytes: source.sizeBytes, mtimeMs: source.mtimeMs },
      sidecar,
      index: freezeWindowIndex(index),
    })
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break
      this.entries.delete(oldest)
    }
  }
}

/** Read one sidecar's current observable state; an unreadable path is an absent cache. */
async function readSidecarState(sourcePath: string): Promise<SidecarState> {
  try {
    const info = await stat(windowIndexPath(sourcePath), { bigint: true })
    return info.isFile()
      ? { kind: 'file', size: info.size, mtimeNs: info.mtimeNs }
      : SIDECAR_NOT_FILE
  } catch {
    return SIDECAR_MISSING
  }
}

/** Exact in-flight key for one path, generation revision, and sidecar revision. */
function flightKey(sourcePath: string, source: JsonlWindowIndexSource, sidecar: SidecarState): string {
  const revision = sidecar.kind === 'file' ? `file:${sidecar.size}:${sidecar.mtimeNs}` : sidecar.kind
  return `${sourcePath}\u0000${source.sizeBytes}\u0000${source.mtimeMs}\u0000${revision}`
}

/** Compare two sidecar states exactly. */
function sameSidecarState(left: SidecarState, right: SidecarState): boolean {
  if (left.kind === 'file' && right.kind === 'file') {
    return left.size === right.size && left.mtimeNs === right.mtimeNs
  }
  // Both are an absent state of the same kind; a file on one side is a change.
  return left.kind === right.kind
}

/** Freeze one parsed index so every holder shares it read-only. */
function freezeWindowIndex(index: JsonlWindowIndex): JsonlWindowIndex {
  for (const frame of index.frames) Object.freeze(frame)
  Object.freeze(index.frames)
  Object.freeze(index.source)
  return Object.freeze(index)
}
