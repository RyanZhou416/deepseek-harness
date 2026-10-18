/**
 * Independent verification of the accelerated window-index build against the
 * complete read. Over compressed multi-frame generations, the persisted sidecar
 * must describe exactly the physical frames and dense rows; an indexed
 * `beforeSeq` window must serve the complete-read slice whether the sidecar was
 * just built, cached, stale, or corrupt; and an aborted build must stop without
 * publishing anything. The expectations here are derived from the generation's
 * own frame scan and the complete-read events, not from the build under test.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionWindow, SessionWindowRequest } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath, toHeaderLine } from '../src/format.ts'
import { compressZstdFrame, scanZstdFrames, type ZstdFrameRange } from '../src/zstd.ts'
import {
  WINDOW_INDEX_VERSION,
  readWindowIndex,
  readWindowIndexSource,
  rebuildWindowIndex,
  windowIndexPath,
} from '../src/window-index.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

interface Mounted {
  readonly persistence: SessionPersistence
  readonly ctx: Context
  readonly root: string
  readonly compression: 'none' | 'zstd'
}

const mounts: Mounted[] = []
const tempRoots: string[] = []

async function mount(compression: 'none' | 'zstd'): Promise<Mounted> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-index-speed-'))
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root, compression })
  } catch (error: unknown) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const mounted = { persistence: ctx.sessionPersistence, ctx, root, compression }
  mounts.push(mounted)
  return mounted
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-index-speed-fixture-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  const failures: unknown[] = []
  const roots = new Set(tempRoots.splice(0))
  for (const mounted of mounts.splice(0)) {
    roots.add(mounted.root)
    try {
      await mounted.ctx.fiber.dispose()
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  for (const root of roots) {
    try {
      await rm(root, { recursive: true, force: true })
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'window index speed fixture cleanup failed')
})

/** A contiguous log of alternating turn boundaries; `startSeq` continues an existing log. */
function turnLog(count: number, startSeq = 0): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let index = 0; index < count; index += 1) {
    const seq = startSeq + index
    const turn = Math.floor(seq / 2) + 1
    events.push(index % 2 === 0
      ? { type: 'turn/start', seq: SessionSeq(seq), time: seq, data: { turn } }
      : { type: 'turn/end', seq: SessionSeq(seq), time: seq, data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

/** Materialize one session in append batches, so a compressed log gains one frame per batch. */
async function store(
  persistence: SessionPersistence,
  id: string,
  events: readonly SessionEvent[],
  batchSize = Math.max(1, events.length),
): Promise<void> {
  const handle = await persistence.create(meta(id, '/work'))
  try {
    for (let index = 0; index < events.length; index += batchSize) {
      await handle.append(events.slice(index, index + batchSize))
    }
  } finally {
    await handle.close()
  }
}

async function readAll(
  persistence: SessionPersistence,
  id: string,
): Promise<{ header: SessionHeader; events: readonly SessionEvent[] }> {
  const handle = await persistence.open(SessionId(id), 'read')
  try {
    return { header: handle.header, events: (await handle.read()).events }
  } finally {
    await handle.close()
  }
}

function logOf(mounted: Mounted, id: string): string {
  return generationLogPath(mounted.root, '/work', SessionId(id), SESSION_FORMAT_VERSION, mounted.compression)
}

async function readWindow(
  persistence: SessionPersistence,
  id: string,
  request?: SessionWindowRequest,
): Promise<SessionWindow | undefined> {
  if (typeof persistence.readWindow !== 'function') throw new Error('JSONL persistence must implement readWindow')
  return persistence.readWindow(SessionId(id), request)
}

function expectWindow(window: SessionWindow | undefined, expected: readonly SessionEvent[]): void {
  expect(window).toBeDefined()
  expect(window?.events).toEqual(expected)
  expect(window?.cursor).toBe(expected.length === 0 ? -1 : Number(expected.at(-1)?.seq))
  const first = expected[0]
  expect(window?.hasMore).toBe(first !== undefined && Number(first.seq) > 0)
}

/** Physical sidecar fields this spec inspects; the build under test writes them. */
interface SidecarFrameJson {
  offset: number
  length: number
  firstRow: number
  firstSeq: number
  events: number
}

interface SidecarJson {
  version: number
  source: { sizeBytes: number; mtimeMs: number }
  inheritedEventCount: number
  frames: SidecarFrameJson[]
}

/**
 * Read the persisted sidecar through the shipped reader, which also proves the
 * build wrote a structurally valid sidecar bound to the current generation.
 */
async function readSidecar(logPath: string): Promise<SidecarJson> {
  const source = await readWindowIndexSource(logPath)
  if (source === undefined) throw new Error('built generation must remain stattable')
  const index = await readWindowIndex(logPath, source)
  if (index === undefined) throw new Error('built sidecar must be a structurally valid window index')
  return {
    version: index.version,
    source: { sizeBytes: index.source.sizeBytes, mtimeMs: index.source.mtimeMs },
    inheritedEventCount: index.inheritedEventCount,
    frames: index.frames.map(frame => ({
      offset: frame.offset,
      length: frame.length,
      firstRow: frame.firstRow,
      firstSeq: frame.firstSeq,
      events: frame.events,
    })),
  }
}

/**
 * Prove from the generation's own bytes that the persisted sidecar is a valid
 * index: one segment per physical frame at its exact byte range, contiguous
 * cumulative rows, the header segment carrying no event, and `rows` total
 * dense rows.
 */
async function expectValidSidecar(logPath: string, rows: number): Promise<void> {
  const info = await stat(logPath, { bigint: true })
  const scan = scanZstdFrames(await readFile(logPath))
  expect(scan.tornStart).toBeUndefined()
  const sidecar = await readSidecar(logPath)
  expect(sidecar.version).toBe(WINDOW_INDEX_VERSION)
  expect(sidecar.source).toStrictEqual({ sizeBytes: Number(info.size), mtimeMs: Number(info.mtimeMs) })
  expect(sidecar.inheritedEventCount).toBe(0)

  expect(sidecar.frames.map(frame => [frame.offset, frame.length]))
    .toStrictEqual(scan.frames.map(frame => [frame.start, frame.end - frame.start]))
  expect(sidecar.frames.length).toBeGreaterThan(1)
  const header = scan.frames[0] as ZstdFrameRange
  expect(sidecar.frames[0]).toStrictEqual({
    offset: 0,
    length: header.end - header.start,
    firstRow: 0,
    firstSeq: 0,
    events: 0,
  })

  let firstRow = 0
  for (const frame of sidecar.frames.slice(1)) {
    expect(frame.firstRow).toBe(firstRow)
    expect(frame.firstSeq).toBe(firstRow)
    expect(frame.events).toBeGreaterThan(0)
    firstRow += frame.events
  }
  // The current format is dense: exactly one decoded event per physical row.
  expect(firstRow).toBe(rows)
  const last = sidecar.frames.at(-1) as SidecarFrameJson
  expect(last.offset + last.length).toBe(Number(info.size))
}

/** Header line and parsed header value for one unseeded current generation. */
function headerOf(id: string): { headerLine: string; headerValue: unknown } {
  const headerLine = JSON.stringify(toHeaderLine(meta(id, '/work')))
  const headerValue: unknown = JSON.parse(headerLine)
  return { headerLine, headerValue }
}

describe('JSONL window index build: complete-read equality on compressed multi-frame generations', () => {
  it('records one segment per physical frame and serves the complete-read slice', async () => {
    const mounted = await mount('zstd')
    const id = 'index-speed-equality'
    const events = turnLog(240)
    await store(mounted.persistence, id, events, 3)

    const logPath = logOf(mounted, id)
    const scan = scanZstdFrames(await readFile(logPath))
    expect(scan.tornStart).toBeUndefined()
    expect(scan.frames).toHaveLength(81)

    const full = await readAll(mounted.persistence, id)
    expect(full.events).toEqual(events)

    // The first backwards page builds the sidecar; the following pages reuse it.
    const pages = [[240, 17], [120, 8], [1, 10], [240, 240]] as const
    for (const [beforeSeq, maxEvents] of pages) {
      const window = await readWindow(mounted.persistence, id, { beforeSeq, maxEvents })
      expectWindow(window, full.events.slice(Math.max(0, beforeSeq - maxEvents), beforeSeq))
      expect(window?.header).toStrictEqual(full.header)
    }
    await expectValidSidecar(logPath, full.events.length)

    // A sidecar rewritten in a different but equivalent JSON layout is still
    // accepted, so the next paged read is served from it rather than rebuilt.
    const sidecar = await readSidecar(logPath)
    const reformatted = `${JSON.stringify(sidecar, null, 2)}\n`
    await writeFile(windowIndexPath(logPath), reformatted)
    expectWindow(await readWindow(mounted.persistence, id, { beforeSeq: 240, maxEvents: 9 }), full.events.slice(231, 240))
    expect(await readFile(windowIndexPath(logPath), 'utf8')).toBe(reformatted)
  })

  it('rebuilds a stale sidecar after an append and matches the new complete-read slice', async () => {
    const mounted = await mount('zstd')
    const id = 'index-speed-stale'
    const first = turnLog(40)
    await store(mounted.persistence, id, first, 4)
    const logPath = logOf(mounted, id)

    expectWindow(await readWindow(mounted.persistence, id, { beforeSeq: 40 }), first)
    await expectValidSidecar(logPath, first.length)

    const writer = await mounted.persistence.open(SessionId(id), 'write')
    try {
      await writer.append(turnLog(24, first.length))
      await writer.flush()
    } finally {
      await writer.close()
    }
    const all = await readAll(mounted.persistence, id)
    expect(all.events).toHaveLength(64)

    // The previous sidecar still describes the pre-append revision, so the
    // paged read must rebuild over the complete generation.
    expectWindow(await readWindow(mounted.persistence, id, { beforeSeq: 64, maxEvents: 12 }), all.events.slice(52, 64))
    await expectValidSidecar(logPath, all.events.length)
  })

  it('discards an unparsable or inconsistent sidecar and rebuilds a valid one', async () => {
    const mounted = await mount('zstd')
    const id = 'index-speed-corrupt'
    const events = turnLog(72)
    await store(mounted.persistence, id, events, 6)
    const logPath = logOf(mounted, id)

    expectWindow(await readWindow(mounted.persistence, id, { beforeSeq: 72 }), events)
    await expectValidSidecar(logPath, events.length)

    // An unparseable sidecar is an absent cache.
    await writeFile(windowIndexPath(logPath), '{"version":1,"source":')
    expectWindow(await readWindow(mounted.persistence, id, { beforeSeq: 72, maxEvents: 11 }), events.slice(61, 72))
    await expectValidSidecar(logPath, events.length)

    // A structurally valid sidecar that disagrees with the bytes it indexes is
    // rejected by the decode, which rebuilds exactly once.
    const sidecar = await readSidecar(logPath)
    let rows = 0
    const inflated: SidecarJson = {
      ...sidecar,
      frames: sidecar.frames.map((frame, position) => {
        if (position === 0) return { ...frame, firstRow: 0, firstSeq: 0 }
        const events = frame.events + 1
        const shifted = { ...frame, firstRow: rows, firstSeq: rows, events }
        rows += events
        return shifted
      }),
    }
    await writeFile(windowIndexPath(logPath), `${JSON.stringify(inflated)}\n`)
    expectWindow(await readWindow(mounted.persistence, id, { beforeSeq: 72, maxEvents: 11 }), events.slice(61, 72))
    await expectValidSidecar(logPath, events.length)
  })
})

describe('JSONL window index build: cancellation', () => {
  it('refuses a pre-aborted paged read without writing a sidecar', async () => {
    const mounted = await mount('zstd')
    const id = 'index-speed-preaborted'
    const events = turnLog(12)
    await store(mounted.persistence, id, events, 2)

    const controller = new AbortController()
    controller.abort()
    await expect(readWindow(mounted.persistence, id, { beforeSeq: events.length, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    await expect(stat(windowIndexPath(logOf(mounted, id)))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stops an in-flight build on abort and leaves no sidecar or temporary file', async () => {
    const root = await tempRoot()
    const { headerLine, headerValue } = headerOf('index-speed-inflight')
    // The count pass is row-bound rather than byte-bound: many short records keep
    // it running across its 50 ms yield interval without a large fixture, so the
    // timer-driven abort lands inside the pass. The build never parses these rows;
    // only the served decoder validates records.
    const rows = 4_000_000
    const path = join(root, 'inflight.jsonl.zstd')
    await writeFile(path, Buffer.concat([
      await compressZstdFrame(`${headerLine}\n`),
      await compressZstdFrame('x\n'.repeat(rows)),
    ]))

    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, 25)
    try {
      await expect(rebuildWindowIndex(path, 'zstd', headerValue, headerLine, controller.signal))
        .rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      clearTimeout(timer)
    }
    expect(controller.signal.aborted).toBe(true)
    await expect(stat(windowIndexPath(path))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(root)).toEqual(['inflight.jsonl.zstd'])

    // Cancellation published nothing and the same generation still builds.
    const index = await rebuildWindowIndex(path, 'zstd', headerValue, headerLine)
    expect(index?.frames.reduce((total, frame) => total + frame.events, 0)).toBe(rows)
    await expectValidSidecar(path, rows)
  })
})
