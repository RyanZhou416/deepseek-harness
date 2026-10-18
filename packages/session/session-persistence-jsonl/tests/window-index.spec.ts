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
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionWindow, SessionWindowRequest } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath } from '../src/format.ts'
import { readWindowIndex, WINDOW_INDEX_VERSION, windowIndexPath } from '../src/window-index.ts'
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
    expectWindow(await readWindow(persistence, small, { beforeSeq: 200, maxEvents: 10 }), smallEvents.slice(190, 200))
    const smallPage = zstdProbe.decompressCalls
    zstdProbe.decompressCalls = 0
    expectWindow(await readWindow(persistence, large, { beforeSeq: 200, maxEvents: 10 }), largeEvents.slice(190, 200))
    const largePage = zstdProbe.decompressCalls
    // The header frame plus the segments covering rows 190..199, independent of log length.
    expect(smallPage).toBeGreaterThanOrEqual(2)
    expect(smallPage).toBeLessThanOrEqual(6)
    expect(largePage).toBeGreaterThanOrEqual(2)
    expect(largePage).toBeLessThanOrEqual(6)
  })

  it('reuses a durable sidecar from another backend instance', async () => {
    const writer = await mount('zstd')
    const id = 'index-shared'
    const events = turnLog(300)
    await store(writer.persistence, id, events, 3)
    expectWindow(await readWindow(writer.persistence, id, { beforeSeq: 200, maxEvents: 10 }), events.slice(190, 200))

    const reader = await mount('zstd', writer.root)
    zstdProbe.decompressCalls = 0
    expectWindow(await readWindow(reader.persistence, id, { beforeSeq: 200, maxEvents: 10 }), events.slice(190, 200))
    expect(zstdProbe.decompressCalls).toBeLessThanOrEqual(6)
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
