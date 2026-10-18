/**
 * Durable generation index and backwards (`beforeSeq`) windows over current
 * JSONL generations: sidecar schema and identity binding, rebuild on a missing,
 * stale, or corrupt index, and equality with the complete-read slice for
 * compressed and plaintext logs.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionFormatMigrationContext } from '@deepseek-ai/dsh-session-format'
import { assertV4RowAdmission, releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import type { SessionPersistence, SessionWindow, SessionWindowRequest } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { eventLines, generationLogPath, toHeaderLine } from '../src/format.ts'
import {
  readWindowIndex, rebuildWindowIndex, WINDOW_INDEX_VERSION, windowIndexPath, type JsonlWindowIndexFrame,
} from '../src/window-index.ts'
import { compressZstdFrame, createZstdFrameDecoder, scanZstdFrames } from '../src/zstd.ts'
import type { ZstdFrameRange } from '../src/zstd.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

const zstdProbe = vi.hoisted(() => ({ decompressCalls: 0, decodedFrames: 0 }))

vi.mock('../src/zstd.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/zstd.ts')>()
  return {
    ...actual,
    async decompressZstdFrame(input: Buffer): Promise<Buffer> {
      zstdProbe.decompressCalls += 1
      return actual.decompressZstdFrame(input)
    },
    createZstdFrameDecoder(): ReturnType<typeof actual.createZstdFrameDecoder> {
      const decoder = actual.createZstdFrameDecoder()
      return {
        *decode(source: Buffer, frames: readonly ZstdFrameRange[]): Generator<Buffer, void, void> {
          for (const plaintext of decoder.decode(source, frames)) {
            zstdProbe.decodedFrames += 1
            yield plaintext
          }
        },
        close(): void {
          decoder.close()
        },
      }
    },
  }
})

interface Mounted {
  readonly persistence: SessionPersistence
  readonly ctx: Context
  readonly root: string
  readonly compression: 'none' | 'zstd'
}

interface Sidecar {
  readonly version: number
  readonly source: { readonly sizeBytes: number; readonly mtimeMs: number }
  readonly inheritedEventCount: number
  readonly frames: readonly {
    readonly offset: number
    readonly length: number
    readonly firstRow: number
    readonly firstSeq: number
    readonly events: number
  }[]
}

const mounts: Mounted[] = []

async function mount(compression: 'none' | 'zstd', root?: string): Promise<Mounted> {
  const actualRoot = root ?? await mkdtemp(join(tmpdir(), 'dsh-jsonl-window-index-'))
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root: actualRoot, compression })
  } catch (error: unknown) {
    if (root === undefined) await rm(actualRoot, { recursive: true, force: true })
    throw error
  }
  const mounted = { persistence: ctx.sessionPersistence, ctx, root: actualRoot, compression }
  mounts.push(mounted)
  return mounted
}

afterEach(async () => {
  const pending = mounts.splice(0)
  const failures: unknown[] = []
  for (const mounted of pending) {
    try {
      await mounted.ctx.fiber.dispose()
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  for (const root of new Set(pending.map(mounted => mounted.root))) {
    try {
      await rm(root, { recursive: true, force: true })
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'window index fixture cleanup failed')
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

/** Materialize one session in append batches so a compressed log gains several frames. */
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

async function readAll(persistence: SessionPersistence, id: string): Promise<readonly SessionEvent[]> {
  const handle = await persistence.open(SessionId(id), 'read')
  try {
    return (await handle.read()).events
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
  expect(window?.events).toStrictEqual(expected)
  expect(window?.cursor).toBe(expected.length === 0 ? -1 : Number(expected.at(-1)?.seq))
  expect(window?.hasMore).toBe(expected.length > 0 && Number(expected[0]?.seq) > 0)
}

async function readSidecar(mounted: Mounted, id: string): Promise<Sidecar> {
  const text = await readFile(windowIndexPath(logOf(mounted, id)), 'utf8')
  return JSON.parse(text) as Sidecar
}

/** Header line and parsed value of one unseeded current generation. */
function headerOf(id: string): { headerLine: string; headerValue: Record<string, unknown> } {
  const headerLine = JSON.stringify(toHeaderLine(meta(id, '/work')))
  return { headerLine, headerValue: JSON.parse(headerLine) as Record<string, unknown> }
}

/** Write one hand-assembled compressed current generation at its canonical path. */
async function writeZstdGeneration(mounted: Mounted, id: string, payloads: readonly string[]): Promise<string> {
  const path = logOf(mounted, id)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.concat(await Promise.all(payloads.map(payload => compressZstdFrame(payload)))))
  return path
}

/**
 * The superseded build: JSON-parse, admit, and decode every physical row. It
 * exists only as the cost and equality reference for the counted build.
 */
function strictBuildFrames(bytes: Buffer, headerValue: unknown, headerLine: string): JsonlWindowIndexFrame[] {
  const scan = scanZstdFrames(bytes)
  if (scan.tornStart !== undefined) throw new Error('strict walk found a torn frame')
  const frames: JsonlWindowIndexFrame[] = []
  let rows = 0
  let position = 0
  const context: SessionFormatMigrationContext = {
    emitEvent() {},
    emitRun() {},
  }
  const frameDecoder = createZstdFrameDecoder()
  try {
    const decoder = releasedV4SessionFormatCodec.createDecoder(headerValue, 'strict')
    for (const plaintext of frameDecoder.decode(bytes, scan.frames)) {
      const range = scan.frames[position] as ZstdFrameRange
      position += 1
      if (position === 1) {
        expect(plaintext.subarray(0, -1).toString('utf8')).toBe(headerLine)
        frames.push({ offset: range.start, length: range.end - range.start, firstRow: 0, firstSeq: 0, events: 0 })
        continue
      }
      let frameRows = 0
      let lineStart = 0
      while (lineStart < plaintext.length) {
        const newline = plaintext.indexOf(0x0A, lineStart)
        const row: unknown = JSON.parse(plaintext.subarray(lineStart, newline).toString('utf8'))
        assertV4RowAdmission(row, KNOWN_SESSION_EVENT_TYPES)
        decoder.decodeRow(row, context)
        lineStart = newline + 1
        frameRows += 1
      }
      frames.push({
        offset: range.start,
        length: range.end - range.start,
        firstRow: rows,
        firstSeq: rows,
        events: frameRows,
      })
      rows += frameRows
    }
    decoder.finish(context)
  } finally {
    frameDecoder.close()
  }
  return frames
}

/** Median of the recorded samples; the build comparison asserts a direction, not a budget. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

describe('JSONL durable generation index', () => {
  it('persists a versioned sidecar beside the generation and matches the complete read (compressed)', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted
    const id = 'index-round-trip'
    const events = turnLog(1_200)
    await store(persistence, id, events, 40)
    const full = await readAll(persistence, id)
    expect(full).toStrictEqual(events)

    const window = await readWindow(persistence, id, { beforeSeq: 1_000, maxEvents: 50 })
    expectWindow(window, events.slice(950, 1_000))
    expect(window?.hasMore).toBe(true)
    expect(window?.inheritedEventCount).toBe(SessionLogOffset(0))
    expect(window?.header.id).toBe(id)

    const source = await stat(logOf(mounted, id), { bigint: true })
    const sidecar = await readSidecar(mounted, id)
    expect(sidecar.version).toBe(WINDOW_INDEX_VERSION)
    expect(sidecar.source.sizeBytes).toBe(Number(source.size))
    expect(sidecar.source.mtimeMs).toBe(Number(source.mtimeMs))
    expect(sidecar.inheritedEventCount).toBe(0)
    expect(sidecar.frames).toHaveLength(31)
    expect(sidecar.frames[0]).toStrictEqual({ offset: 0, length: sidecar.frames[0]?.length, firstRow: 0, firstSeq: 0, events: 0 })
    expect(sidecar.frames.reduce((total, frame) => total + frame.events, 0)).toBe(events.length)
    const last = sidecar.frames[sidecar.frames.length - 1]
    expect((last?.offset ?? 0) + (last?.length ?? 0)).toBe(Number(source.size))

    // The sidecar is a sibling file, not a selectable Session generation.
    const listed = await persistence.list()
    expect(listed.map(snapshot => snapshot.header.id)).toStrictEqual([id])

    const replay = await readWindow(persistence, id, { beforeSeq: 1_000, maxEvents: 50 })
    expect(replay).toStrictEqual(window)
    expect(await readWindowIndex(logOf(mounted, id), sidecar.source)).toStrictEqual(sidecar)
  })

  it('matches the complete-read slice across pages and boundaries (plaintext)', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const id = 'index-pages'
    const events = turnLog(2_100)
    await store(persistence, id, events, 100)

    const pages: ReadonlyArray<{ beforeSeq: number; maxEvents?: number; expected: readonly SessionEvent[] }> = [
      { beforeSeq: 500, maxEvents: 10, expected: events.slice(490, 500) },
      { beforeSeq: 1, maxEvents: 5, expected: events.slice(0, 1) },
      { beforeSeq: 2_100, maxEvents: 2_000, expected: events.slice(100) },
      { beforeSeq: 2_100, maxEvents: 10_000, expected: events },
      { beforeSeq: 5_000, expected: events.slice(100) },
      { beforeSeq: 256, maxEvents: 1, expected: events.slice(255, 256) },
    ]
    for (const page of pages) {
      const window = await readWindow(persistence, id, page.maxEvents === undefined
        ? { beforeSeq: page.beforeSeq }
        : { beforeSeq: page.beforeSeq, maxEvents: page.maxEvents })
      expectWindow(window, page.expected)
    }

    const sidecar = await readSidecar(mounted, id)
    expect(sidecar.frames).toHaveLength(1 + Math.ceil(events.length / 256))
    expect(sidecar.frames.reduce((total, frame) => total + frame.events, 0)).toBe(events.length)
  })

  it('builds the index from counted frame records without parsing events', async () => {
    const mounted = await mount('zstd')
    const id = 'index-counted-build'
    const events = turnLog(20_000)
    const { headerLine, headerValue } = headerOf(id)
    const payloads = [`${headerLine}\n`]
    for (let start = 0; start < events.length; start += 4_000) {
      payloads.push(`${eventLines(events.slice(start, start + 4_000))}\n`)
    }
    const path = await writeZstdGeneration(mounted, id, payloads)
    const bytes = await readFile(path)
    const expected = strictBuildFrames(bytes, headerValue, headerLine)

    const countedSamples: number[] = []
    const counted: Array<readonly JsonlWindowIndexFrame[] | undefined> = []
    const parse = vi.spyOn(JSON, 'parse')
    let parses = 0
    try {
      for (let round = 0; round < 3; round += 1) {
        const started = performance.now()
        const index = await rebuildWindowIndex(path, 'zstd', headerValue, headerLine)
        countedSamples.push(performance.now() - started)
        counted.push(index?.frames)
      }
      parses = parse.mock.calls.length
    } finally {
      parse.mockRestore()
    }
    // Counting records never materializes an event object for them.
    expect(parses).toBe(0)
    expect(counted).toStrictEqual([expected, expected, expected])
    // A live signal changes nothing: the build still publishes after its
    // cancellation checkpoint.
    expect(await rebuildWindowIndex(path, 'zstd', headerValue, headerLine, new AbortController().signal))
      .toBeDefined()

    const strictSamples: number[] = []
    for (let round = 0; round < 3; round += 1) {
      const started = performance.now()
      expect(strictBuildFrames(bytes, headerValue, headerLine)).toStrictEqual(expected)
      strictSamples.push(performance.now() - started)
    }
    // Measured on this 20,000-event fixture (Node 24, Windows): the counted
    // median was about 5.6 ms and the strict per-row median about 29.7 ms. Keep
    // the direction rather than a wall-clock budget so the check tracks actual
    // work instead of one host's speed.
    expect(median(countedSamples)).toBeLessThan(median(strictSamples))
  })

  it('declines counted generations whose records are not one event each', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted

    // A blank record is a physical row that decodes to no event.
    const blankId = 'index-counted-blank'
    const blank = headerOf(blankId)
    const blankFirst = turnLog(1)[0] as SessionEvent
    const blankSecond = turnLog(2)[1] as SessionEvent
    await writeZstdGeneration(mounted, blankId, [
      `${blank.headerLine}\n`,
      `${JSON.stringify(blankFirst)}\n`,
      '\n',
      `${JSON.stringify(blankSecond)}\n`,
    ])
    // The counted build records the blank row; the strict served decoder refuses
    // every page that reaches it or whose row numbering depends on it.
    expect(await readWindow(persistence, blankId, { beforeSeq: 3, maxEvents: 2 })).toBeUndefined()
    expect(await readWindow(persistence, blankId, { beforeSeq: 3, maxEvents: 1 })).toBeUndefined()
    expect(await readWindow(persistence, blankId, { beforeSeq: 2, maxEvents: 1 })).toBeUndefined()
    const blankSidecar = await readSidecar(mounted, blankId)
    expect(blankSidecar.frames.reduce((total, frame) => total + frame.events, 0)).toBe(3)

    // A committed sequence gap is the other shape where counted records are not
    // the dense event stream the window decoder seeds itself into.
    const gapId = 'index-counted-gap'
    const gap = headerOf(gapId)
    await writeZstdGeneration(mounted, gapId, [
      `${gap.headerLine}\n`,
      `${JSON.stringify({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })}\n`,
      `${JSON.stringify({ type: 'step/start', seq: 2, time: 1, data: { turn: 1, step: 1 } })}\n`,
      `${JSON.stringify({ type: 'turn/end', seq: 3, time: 2, data: { turn: 1, reason: { kind: 'completed' } } })}\n`,
    ])
    expect(await readWindow(persistence, gapId, { beforeSeq: 3, maxEvents: 3 })).toBeUndefined()
    // The complete read is the fallback that diagnoses the committed hole.
    await expect(readAll(persistence, gapId)).rejects.toThrow(/seq gap/)
  })

  it('replaces a counted sidecar whose row counts disagree with its bytes', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted
    const id = 'index-counted-repair'
    const events = turnLog(1_200)
    await store(persistence, id, events, 40)
    const page = { beforeSeq: 1_000, maxEvents: 50 }
    expectWindow(await readWindow(persistence, id, page), events.slice(950, 1_000))
    const valid = await readSidecar(mounted, id)

    // Keep offsets and coverage exact but inflate every body segment's row count:
    // structural validation still accepts the sidecar, and only decoding the
    // claimed rows can disprove it.
    let rows = 0
    const inflated = {
      ...valid,
      frames: valid.frames.map((frame, position) => {
        if (position === 0) return { ...frame, firstRow: 0, firstSeq: 0 }
        const counted = { ...frame, firstRow: rows, firstSeq: rows, events: frame.events + 1 }
        rows += counted.events
        return counted
      }),
    }
    await writeFile(windowIndexPath(logOf(mounted, id)), `${JSON.stringify(inflated)}\n`)

    zstdProbe.decodedFrames = 0
    expectWindow(await readWindow(persistence, id, page), events.slice(950, 1_000))
    const repaired = await readSidecar(mounted, id)
    expect(repaired.frames).toStrictEqual(valid.frames)
    expect(repaired.frames.reduce((total, frame) => total + frame.events, 0)).toBe(events.length)
    // One complete rebuild walk, then the retry's selected segments.
    expect(zstdProbe.decodedFrames).toBeGreaterThanOrEqual(valid.frames.length)
  })

  it('yields cooperatively while counting a plaintext record run', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const id = 'index-counted-yield'
    const { headerLine, headerValue } = headerOf(id)
    const path = logOf(mounted, id)
    await mkdir(dirname(path), { recursive: true })
    const events = turnLog(600)
    await writeFile(path, `${headerLine}\n${eventLines(events)}\n`)

    // Advance the build clock past its scheduling interval so each 256-row
    // checkpoint takes the cooperative yield path; the records are unchanged.
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 100
      return clock
    })
    try {
      const index = await rebuildWindowIndex(path, 'none', headerValue, headerLine)
      expect(index?.frames.map(frame => frame.events)).toStrictEqual([0, 256, 256, 88])
    } finally {
      now.mockRestore()
    }
    // The yielded build still serves exactly the complete-read slice.
    expectWindow(await readWindow(persistence, id, { beforeSeq: 600, maxEvents: 5 }), events.slice(595, 600))
  })

  it('rebuilds after an append changes the recorded size', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted
    const id = 'index-append'
    const first = turnLog(200)
    await store(persistence, id, first, 20)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 150, maxEvents: 10 }), first.slice(140, 150))

    const handle = await persistence.open(SessionId(id), 'write')
    try {
      await handle.append(turnLog(100, first.length))
      await handle.flush()
    } finally {
      await handle.close()
    }

    const all = await readAll(persistence, id)
    expect(all).toHaveLength(300)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 250, maxEvents: 10 }), all.slice(240, 250))
    const source = await stat(logOf(mounted, id))
    expect((await readSidecar(mounted, id)).source.sizeBytes).toBe(source.size)
  })

  it('rebuilds when only the modification time changed', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const id = 'index-mtime'
    const events = turnLog(60)
    await store(persistence, id, events, 10)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 50, maxEvents: 5 }), events.slice(45, 50))

    const changed = new Date(Date.now() + 5_000)
    await utimes(logOf(mounted, id), changed, changed)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 50, maxEvents: 5 }), events.slice(45, 50))
    expect((await readSidecar(mounted, id)).source.mtimeMs)
      .toBe(Number((await stat(logOf(mounted, id), { bigint: true })).mtimeMs))
  })

  it('ignores a corrupt, truncated, or missing sidecar and rebuilds it', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted
    const id = 'index-corrupt'
    const events = turnLog(100)
    await store(persistence, id, events, 10)
    const path = windowIndexPath(logOf(mounted, id))
    expectWindow(await readWindow(persistence, id, { beforeSeq: 80, maxEvents: 5 }), events.slice(75, 80))

    await writeFile(path, '{"version":1,"frames":[')
    expectWindow(await readWindow(persistence, id, { beforeSeq: 80, maxEvents: 5 }), events.slice(75, 80))
    expect((await readSidecar(mounted, id)).version).toBe(WINDOW_INDEX_VERSION)

    await writeFile(path, JSON.stringify({ version: 2, source: {}, inheritedEventCount: 0, frames: [] }))
    expectWindow(await readWindow(persistence, id, { beforeSeq: 80, maxEvents: 5 }), events.slice(75, 80))

    // Structurally valid but semantically wrong: the recorded cut disagrees
    // with the log, so the accepted sidecar is discarded and rebuilt once.
    const sidecar = await readSidecar(mounted, id)
    await writeFile(path, JSON.stringify({ ...sidecar, inheritedEventCount: 1 }))
    expectWindow(await readWindow(persistence, id, { beforeSeq: 80, maxEvents: 5 }), events.slice(75, 80))
    expect((await readSidecar(mounted, id)).inheritedEventCount).toBe(0)

    await unlink(path)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 80, maxEvents: 5 }), events.slice(75, 80))
    expect((await readSidecar(mounted, id)).version).toBe(WINDOW_INDEX_VERSION)
  })

  it('reads and decodes only the selected segments once the index is valid', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted
    const small = 'index-bounded-small'
    const large = 'index-bounded-large'
    const smallEvents = turnLog(300)
    const largeEvents = turnLog(900)
    await store(persistence, small, smallEvents, 3)
    await store(persistence, large, largeEvents, 3)

    zstdProbe.decompressCalls = 0
    zstdProbe.decodedFrames = 0
    expectWindow(await readWindow(persistence, small, { beforeSeq: 200, maxEvents: 10 }), smallEvents.slice(190, 200))
    const smallBuild = zstdProbe.decodedFrames
    zstdProbe.decodedFrames = 0
    expectWindow(await readWindow(persistence, large, { beforeSeq: 200, maxEvents: 10 }), largeEvents.slice(190, 200))
    const largeBuild = zstdProbe.decodedFrames
    // A build decodes every scanned frame once: 100 and 300 event frames plus the header frame.
    expect(smallBuild).toBeGreaterThanOrEqual(101)
    expect(largeBuild).toBeGreaterThanOrEqual(301)

    zstdProbe.decompressCalls = 0
    zstdProbe.decodedFrames = 0
    expectWindow(await readWindow(persistence, small, { beforeSeq: 200, maxEvents: 10 }), smallEvents.slice(190, 200))
    const smallPage = zstdProbe.decodedFrames
    zstdProbe.decodedFrames = 0
    expectWindow(await readWindow(persistence, large, { beforeSeq: 200, maxEvents: 10 }), largeEvents.slice(190, 200))
    const largePage = zstdProbe.decodedFrames
    // The page decodes only the segments covering rows 190..199 in one batched
    // pass: the same count for both logs, independent of log length.
    expect(smallPage).toBeGreaterThanOrEqual(2)
    expect(smallPage).toBe(largePage)
    expect(largePage).toBeLessThan(largeBuild)
  })

  it('reuses a durable sidecar from another backend instance', async () => {
    const writer = await mount('zstd')
    const id = 'index-shared'
    const events = turnLog(300)
    await store(writer.persistence, id, events, 3)
    expectWindow(await readWindow(writer.persistence, id, { beforeSeq: 200, maxEvents: 10 }), events.slice(190, 200))

    const reader = await mount('zstd', writer.root)
    zstdProbe.decodedFrames = 0
    expectWindow(await readWindow(reader.persistence, id, { beforeSeq: 200, maxEvents: 10 }), events.slice(190, 200))
    expect(zstdProbe.decodedFrames).toBeGreaterThanOrEqual(2)
    expect(zstdProbe.decodedFrames).toBeLessThanOrEqual(6)
  })

  it('keeps the newest window index-free', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted
    const id = 'index-tail-free'
    const events = turnLog(40)
    await store(persistence, id, events, 5)

    expectWindow(await readWindow(persistence, id, { maxEvents: 10 }), events.slice(-10))
    await expect(stat(windowIndexPath(logOf(mounted, id)))).rejects.toMatchObject({ code: 'ENOENT' })

    expectWindow(await readWindow(persistence, id, { beforeSeq: 30, maxEvents: 10 }), events.slice(20, 30))
    expect((await readSidecar(mounted, id)).version).toBe(WINDOW_INDEX_VERSION)
  })

  it('serves an empty window below seq 0 and clamps a cut past the end', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const empty = 'index-empty'
    const emptyHandle = await persistence.create(meta(empty, '/work'))
    await emptyHandle.flush()
    await emptyHandle.close()
    const emptyWindow = await readWindow(persistence, empty, { beforeSeq: 0, maxEvents: 10 })
    expect(emptyWindow?.events).toStrictEqual([])
    expect(emptyWindow?.cursor).toBe(-1)
    expect(emptyWindow?.hasMore).toBe(false)
    expect(emptyWindow?.inheritedEventCount).toBe(SessionLogOffset(0))

    const id = 'index-clamp'
    const events = turnLog(20)
    await store(persistence, id, events)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 0 }), [])
    expectWindow(await readWindow(persistence, id, { beforeSeq: 25 }), events)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 10, maxEvents: 4 }), events.slice(6, 10))
  })

  it('falls back for seeded headers, historical generations, and invalid bounds', async () => {
    const mounted = await mount('none')
    const { persistence, root } = mounted
    const id = 'index-fallbacks'
    const events = turnLog(20)
    await store(persistence, id, events)

    for (const beforeSeq of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -0]) {
      expect(await readWindow(persistence, id, { beforeSeq })).toBeUndefined()
    }
    for (const maxEvents of [0, -1, 1.5, Number.NaN]) {
      expect(await readWindow(persistence, id, { beforeSeq: 10, maxEvents })).toBeUndefined()
    }

    const seeded = 'index-seeded'
    const seededHandle = await persistence.create({ ...meta(seeded, '/work'), isSeeded: true }, {
      inheritedEventCount: SessionLogOffset(2),
    })
    await seededHandle.flush()
    await seededHandle.close()
    expect(await readWindow(persistence, seeded, { beforeSeq: 1 })).toBeUndefined()
    expect(await readWindow(persistence, seeded)).toBeUndefined()

    const historical = 'index-historical'
    const historicalPath = generationLogPath(root, '/work', SessionId(historical), 0, 'none')
    await mkdir(dirname(historicalPath), { recursive: true })
    await writeFile(historicalPath, `${JSON.stringify({
      type: 'session',
      version: 0,
      id: historical,
      createdAt: 1_000,
      cwd: '/work',
      delegationDepth: 0,
    })}\n`)
    expect(await readWindow(persistence, historical, { beforeSeq: 1 })).toBeUndefined()

    const controller = new AbortController()
    controller.abort()
    await expect(readWindow(persistence, id, { beforeSeq: 10, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})
