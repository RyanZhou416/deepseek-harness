// DeepSeek Harness fork modification: a completed sweep records its state version so later Host starts skip the on-demand catalog reads.
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { deriveHeadState } from './foldState'
import { asRecord } from './record'
import { NODE_FILE_IO, storagePathOf, type FileIo } from './storage'

const ROW_KEY = 'contextTimeline'

const LEGACY_VERSION = 36

/**
 * The head-only shape generation this sweep writes. The completion marker keys
 * on it, so a later generation sweeps the catalog once more.
 */
const HEAD_ONLY_STATE_VERSION = 37

/** Layout version of the completion marker; bump only when its own fields change. */
export const TIMELINE_SWEEP_MARKER_FORMAT = 1

/** Completion marker file inside the plugin's own storage directory. */
export const TIMELINE_SWEEP_MARKER_FILE = `timeline-sweep.v${TIMELINE_SWEEP_MARKER_FORMAT}.json`

/**
 * Resolve the completion marker path in this deployment's plugin storage.
 * @param env - environment carrying the optional `DSH_HOME` override.
 * @param home - home directory used when `DSH_HOME` is unset.
 * @returns the marker file path.
 */
export function timelineSweepMarkerPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return storagePathOf(TIMELINE_SWEEP_MARKER_FILE, env, home)
}

/**
 * Overrides for {@link watchTimelineRowSweep}.
 */
export interface TimelineSweepOptions {
  /** Marker file path; defaults to {@link timelineSweepMarkerPath}. */
  markerPath?: string
  /** Marker file IO; defaults to the plugin's atomic file helper. */
  markerIo?: FileIo
}

/**
 * Longest synchronous slice of the sweep between event-loop yields. The cache
 * table reads one record per `get`, so a full-catalog migration must not run as
 * one turn; the budget matches the fork's other maintenance slices.
 */
const SWEEP_SLICE_MS = 50

interface RowLike {
  ver?: unknown
  seq?: unknown
  val?: unknown
}

interface RecordLike {
  rows?: Record<string, RowLike>
}

interface TableLike {
  keys(): IterableIterator<string>
  get(id: string): RecordLike | undefined
  update(id: string, fn: (current: RecordLike) => RecordLike): Promise<unknown>
}

function tableOf(ctx: Context): TableLike | undefined {
  const facility = asRecord(ctx.get('storageDomain'))
  if (facility === null || typeof facility.get !== 'function') return undefined
  const domain = asRecord((facility.get as (name: string) => unknown)('session_projcache'))
  if (domain === null || typeof domain.table !== 'function') return undefined
  const table = asRecord((domain.table as (name: string) => unknown)('sessions'))
  if (
    table === null
    || typeof table.keys !== 'function'
    || typeof table.get !== 'function'
    || typeof table.update !== 'function'
  ) return undefined
  return table as unknown as TableLike
}

/**
 * Rewrite every legacy `contextTimeline` row to the head-only shape, once per
 * state version. The catalog streams one record per synchronous read, so the
 * walk yields between slices and skips rows a concurrent delete removed.
 * @param ctx - the plugin context owning the watcher.
 * @param options - marker path and IO overrides, used by tests.
 */
export function watchTimelineRowSweep(ctx: Context, options: TimelineSweepOptions = {}): void {
  const markerPath = options.markerPath ?? timelineSweepMarkerPath()
  const markerIo = options.markerIo ?? NODE_FILE_IO
  let disposed = false
  ctx.effect(() => () => { disposed = true }, 'dsh-context: timeline row sweep')
  ctx.inject(['sessionProjectionCache', 'storageDomain'], (c) => {
    const table = tableOf(c)
    if (table === undefined) return
    void runSweep(ctx, table, markerPath, markerIo, () => disposed).catch((error: unknown) => {
      ctx.logger.warn(`dsh-context: timeline row sweep stopped early (${String(error)})`)
    })
  })
}

async function runSweep(
  ctx: Context,
  table: TableLike,
  markerPath: string,
  markerIo: FileIo,
  aborted: () => boolean,
): Promise<void> {
  const completed = await markerVersionOf(markerIo, markerPath)
  if (completed !== undefined && completed >= HEAD_ONLY_STATE_VERSION) {
    ctx.logger.debug(`dsh-context: timeline row sweep already completed at state version ${String(completed)}`)
    return
  }
  const finished = await sweep(ctx, table, aborted)
  // An interrupted walk records nothing, so the next start rescans for real.
  if (!finished || aborted()) return
  try {
    await markerIo.write(markerPath, JSON.stringify({
      format: TIMELINE_SWEEP_MARKER_FORMAT,
      version: HEAD_ONLY_STATE_VERSION,
    }))
  } catch (error: unknown) {
    ctx.logger.warn(`dsh-context: could not record the timeline row sweep (${String(error)})`)
  }
}

async function markerVersionOf(io: FileIo, path: string): Promise<number | undefined> {
  let text: string
  try {
    text = await io.read(path)
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const marker = asRecord(parsed)
  if (marker === null || marker.format !== TIMELINE_SWEEP_MARKER_FORMAT) return undefined
  const version = marker.version
  return typeof version === 'number' && Number.isSafeInteger(version) ? version : undefined
}

async function sweep(ctx: Context, table: TableLike, aborted: () => boolean): Promise<boolean> {
  let migrated = 0
  let stalled = 0
  let sliceStartedAt = Date.now()
  for (const id of table.keys()) {
    if (aborted()) return false
    // A full catalog streams one record per sync read: yield between slices so
    // the migration never blocks a request turn.
    if (Date.now() - sliceStartedAt >= SWEEP_SLICE_MS) {
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      sliceStartedAt = Date.now()
    }
    const record = table.get(id)
    if (record === undefined) continue
    const row = record.rows?.[ROW_KEY]
    if (row === undefined || row.ver !== LEGACY_VERSION) continue
    const slim = deriveHeadState(row.val)
    if (slim === undefined) continue
    try {
      await table.update(id, (current) => {
        const currentRow = current.rows?.[ROW_KEY]
        if (currentRow === undefined || currentRow.ver !== LEGACY_VERSION) return current
        return {
          ...current,
          rows: {
            ...current.rows,
            [ROW_KEY]: { ver: HEAD_ONLY_STATE_VERSION, seq: currentRow.seq, val: slim },
          },
        }
      })
      migrated++
    } catch {
      stalled++
    }
  }
  if (migrated > 0) {
    ctx.logger.info(`dsh-context: compacted ${migrated} persisted contextTimeline row(s) to the head-only shape`)
  }
  if (stalled > 0) {
    ctx.logger.warn(`dsh-context: ${stalled} legacy contextTimeline row(s) stayed behind (their sessions refold on the next read)`)
  }
  return true
}
