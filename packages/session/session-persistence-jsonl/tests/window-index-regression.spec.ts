/**
 * Independent regression coverage for the durable JSONL generation index and
 * `beforeSeq` paging: sidecar schema and identity round-trip, rebuild after a
 * missing, stale, corrupt, or misaligned index, equality with the complete-read
 * slice for compressed and plaintext logs, `hasMore`/cursor paging, and the
 * fallbacks that keep an unindexed window out of the API.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionWindow, SessionWindowRequest } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath, toHeaderLine } from '../src/format.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../src/zstd.ts'
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

/** One sidecar as JSON; the durable file is asserted through its literal path. */
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
  const actualRoot = root ?? await mkdtemp(join(tmpdir(), 'dsh-jsonl-window-index-regression-'))
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
  if (failures.length > 0) throw new AggregateError(failures, 'window index regression fixture cleanup failed')
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

/** A valid log covering turn, message, step, and assistant-stream rows. */
function conversationLog(turns: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 1; turn <= turns; turn += 1) {
    const base = events.length
    events.push(
      { type: 'turn/start', seq: SessionSeq(base), time: base, data: { turn } },
      { type: 'user/message', seq: SessionSeq(base + 1), time: base + 1, surfaceOp: 'append', data: freezeMessage({
        id: MessageId(`window-index-user-${turn}`),
        role: 'user',
        content: [{ type: 'text', text: `turn ${turn}` }],
        source: { kind: 'user' },
      }) },
      { type: 'step/start', seq: SessionSeq(base + 2), time: base + 2, data: { turn, step: 1 } },
      { type: 'assistant/message', seq: SessionSeq(base + 3), time: base + 3, surfaceOp: 'append', data: {
        turn,
        step: 1,
        message: freezeMessage({
          id: MessageId(`window-index-assistant-${turn}`),
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
        }),
        stream: [
          { type: 'chunk', time: base + 2, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
          { type: 'text-chunks', time0: base + 2, index: 0, dt: [], texts: ['hello'] },
          { type: 'chunk', time: base + 3, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } } },
          { type: 'chunk', time: base + 3, chunk: { type: 'finish', reason: { kind: 'stop' } } },
        ],
      } },
      { type: 'step/end', seq: SessionSeq(base + 4), time: base + 4, data: { turn, step: 1 } },
      { type: 'turn/end', seq: SessionSeq(base + 5), time: base + 5, data: { turn, reason: { kind: 'completed' } } },
    )
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

/** The durable sidecar path fixed by the storage contract, independent of the implementation helper. */
function sidecarPath(logPath: string): string {
  return `${logPath}.window-index.json`
}

async function readWindow(
  persistence: SessionPersistence,
  id: string,
  request?: SessionWindowRequest,
): Promise<SessionWindow | undefined> {
  if (typeof persistence.readWindow !== 'function') throw new Error('JSONL persistence must implement readWindow')
  return persistence.readWindow(SessionId(id), request)
}

async function sidecarOf(mounted: Mounted, id: string): Promise<Sidecar> {
  return JSON.parse(await readFile(sidecarPath(logOf(mounted, id)), 'utf8')) as Sidecar
}

function expectWindow(
  window: SessionWindow | undefined,
  expected: readonly SessionEvent[],
  header?: SessionHeader,
): void {
  expect(window).toBeDefined()
  expect(window?.events).toStrictEqual(expected)
  expect(window?.cursor).toBe(expected.length === 0 ? -1 : Number(expected.at(-1)?.seq))
  const first = expected[0]
  expect(window?.hasMore).toBe(first !== undefined && Number(first.seq) > 0)
  expect(window?.inheritedEventCount).toBe(SessionLogOffset(0))
  if (header !== undefined) expect(window?.header).toEqual(header)
}

/** Counts sidecar segments containing any row of [startRow, boundary). */
function segmentsCovering(sidecar: Sidecar, startRow: number, boundary: number): number {
  return sidecar.frames.filter(frame => frame.events > 0
    && frame.firstRow < boundary
    && frame.firstRow + frame.events > startRow).length
}

function totalEvents(sidecar: Sidecar): number {
  return sidecar.frames.reduce((total, frame) => total + frame.events, 0)
}

/**
 * Expected segments derived from the generation's own bytes: one per complete
 * frame, with rows counted from newline-terminated plaintext rather than from
 * the build under test.
 */
async function countedFrames(logPath: string): Promise<Sidecar['frames']> {
  const bytes = await readFile(logPath)
  const scan = scanZstdFrames(bytes)
  if (scan.tornStart !== undefined) throw new Error('counted fixture scan found a torn frame')
  const frames: Array<Sidecar['frames'][number]> = []
  let rows = 0
  for (const [position, range] of scan.frames.entries()) {
    const plaintext = await decompressZstdFrame(bytes.subarray(range.start, range.end))
    let events = 0
    if (position > 0) {
      for (let lineStart = 0; lineStart < plaintext.length; lineStart = plaintext.indexOf(0x0A, lineStart) + 1) {
        events += 1
      }
    }
    frames.push({ offset: range.start, length: range.end - range.start, firstRow: rows, firstSeq: rows, events })
    rows += events
  }
  return frames
}

describe('JSONL window index: sidecar schema and identity round-trip', () => {
  it('records a versioned contiguous zstd index that another backend instance reuses', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted
    const id = 'before-index-schema'
    const events = turnLog(240)
    await store(persistence, id, events, 8)
    const full = await readAll(persistence, id)
    expect(full.events).toStrictEqual(events)

    const page = await readWindow(persistence, id, { beforeSeq: 170, maxEvents: 25 })
    expectWindow(page, full.events.slice(145, 170), full.header)

    const logPath = logOf(mounted, id)
    const generation = await stat(logPath, { bigint: true })
    const text = await readFile(sidecarPath(logPath), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(text.trimEnd()).not.toContain('\n')
    const sidecar = JSON.parse(text) as Sidecar
    expect(Object.keys(sidecar)).toStrictEqual(['version', 'source', 'inheritedEventCount', 'frames'])
    expect(sidecar.version).toBe(1)
    expect(Object.keys(sidecar.source)).toStrictEqual(['sizeBytes', 'mtimeMs'])
    expect(sidecar.source.sizeBytes).toBe(Number(generation.size))
    expect(sidecar.source.mtimeMs).toBe(Number(generation.mtimeMs))
    expect(sidecar.inheritedEventCount).toBe(0)
    // One header frame plus one frame per append batch.
    expect(sidecar.frames).toHaveLength(31)

    let offset = 0
    let rows = 0
    for (const [position, frame] of sidecar.frames.entries()) {
      expect(Object.keys(frame)).toStrictEqual(['offset', 'length', 'firstRow', 'firstSeq', 'events'])
      expect(frame.offset).toBe(offset)
      expect(frame.length).toBeGreaterThan(0)
      expect(frame.firstRow).toBe(rows)
      expect(frame.firstSeq).toBe(rows)
      if (position === 0) {
        expect(frame.offset).toBe(0)
        expect(frame.events).toBe(0)
      } else {
        expect(frame.events).toBe(8)
      }
      offset += frame.length
      rows += frame.events
    }
    expect(offset).toBe(Number(generation.size))
    expect(rows).toBe(events.length)
    expect(totalEvents(sidecar)).toBe(events.length)
    // The counted build records exactly the physical frames and rows an
    // independent newline scan of the generation produces.
    expect(sidecar.frames).toStrictEqual(await countedFrames(logPath))

    // The sidecar is a sibling cache file, not a selectable Session generation.
    expect((await persistence.list()).map(snapshot => snapshot.header.id)).toStrictEqual([id])

    // A second backend over the same root must accept the durable index rather
    // than walk all 30 event frames.
    const past = new Date('2001-02-03T04:05:06.000Z')
    await utimes(sidecarPath(logPath), past, past)
    const reader = await mount('zstd', mounted.root)
    zstdProbe.decodedFrames = 0
    const reused = await readWindow(reader.persistence, id, { beforeSeq: 170, maxEvents: 25 })
    expectWindow(reused, full.events.slice(145, 170), full.header)
    const selected = segmentsCovering(sidecar, 145, 170)
    expect(selected).toBeGreaterThanOrEqual(2)
    expect(zstdProbe.decodedFrames).toBe(selected)
    expect(Number((await stat(sidecarPath(logPath), { bigint: true })).mtimeMs)).toBe(past.getTime())
  })

  it('records 256-row decode segments for a plaintext generation and pages across them', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const id = 'before-index-plain-segments'
    const events = turnLog(520)
    await store(persistence, id, events, 7)
    const full = await readAll(persistence, id)
    expect(full.events).toStrictEqual(events)

    const pages: ReadonlyArray<{ beforeSeq: number; maxEvents: number; expected: readonly SessionEvent[] }> = [
      { beforeSeq: 520, maxEvents: 10, expected: full.events.slice(510) },
      { beforeSeq: 300, maxEvents: 90, expected: full.events.slice(210, 300) },
      { beforeSeq: 257, maxEvents: 2, expected: full.events.slice(255, 257) },
      { beforeSeq: 256, maxEvents: 1, expected: full.events.slice(255, 256) },
      { beforeSeq: 512, maxEvents: 257, expected: full.events.slice(255, 512) },
    ]
    for (const page of pages) {
      expectWindow(
        await readWindow(persistence, id, { beforeSeq: page.beforeSeq, maxEvents: page.maxEvents }),
        page.expected,
        full.header,
      )
    }

    // The default bound covers every row below the cut.
    expectWindow(await readWindow(persistence, id, { beforeSeq: 300 }), full.events.slice(0, 300), full.header)
    // A bound above the backend maximum is clamped to it.
    expectWindow(await readWindow(persistence, id, { beforeSeq: 520, maxEvents: 100_000 }), full.events, full.header)

    const sidecar = await sidecarOf(mounted, id)
    expect(totalEvents(sidecar)).toBe(events.length)
    // Header segment plus ceil(520 / 256) synthetic body segments.
    expect(sidecar.frames).toHaveLength(4)
    expect(sidecar.frames.map(frame => frame.events)).toStrictEqual([0, 256, 256, 8])
  })
})

describe('JSONL window index: rebuild after a missing, stale, or corrupt sidecar', () => {
  it('rebuilds every unreadable or inconsistent sidecar without changing the served page', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const id = 'before-index-corrupt'
    const events = turnLog(300)
    await store(persistence, id, events, 25)
    const full = await readAll(persistence, id)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 250, maxEvents: 7 }), full.events.slice(243, 250))

    const logPath = logOf(mounted, id)
    const path = sidecarPath(logPath)
    const valid = JSON.parse(await readFile(path, 'utf8')) as Sidecar
    const generation = await stat(logPath, { bigint: true })
    const variants: ReadonlyArray<readonly [string, string]> = [
      ['truncated JSON', '{"version":1,"source":{"sizeBytes":'],
      ['not JSON', 'not a window index'],
      ['empty file', ''],
      ['null root', 'null'],
      ['array root', '[]'],
      ['unknown version', JSON.stringify({ ...valid, version: 2 })],
      ['extra index key', JSON.stringify({ ...valid, extra: true })],
      ['missing frames', JSON.stringify({ version: 1, source: valid.source, inheritedEventCount: 0 })],
      ['source size mismatch', JSON.stringify({
        ...valid, source: { ...valid.source, sizeBytes: Number(generation.size) + 1 },
      })],
      ['source mtime mismatch', JSON.stringify({
        ...valid, source: { ...valid.source, mtimeMs: Number(generation.mtimeMs) + 1 },
      })],
      ['empty frames', JSON.stringify({ ...valid, frames: [] })],
      ['first segment not the header', JSON.stringify({
        ...valid,
        frames: valid.frames.map((frame, position) => position === 0 ? { ...frame, events: 1 } : frame),
      })],
      ['negative frame events', JSON.stringify({
        ...valid,
        frames: valid.frames.map((frame, position) => position === 1 ? { ...frame, events: -1 } : frame),
      })],
      ['non-integer offset', JSON.stringify({
        ...valid,
        frames: valid.frames.map((frame, position) => position === 1 ? { ...frame, offset: frame.offset + 0.5 } : frame),
      })],
      ['discontiguous offsets', JSON.stringify({
        ...valid,
        frames: valid.frames.map((frame, position) => position === 1 ? { ...frame, offset: frame.offset + 1 } : frame),
      })],
      ['coverage shorter than the file', JSON.stringify({ ...valid, frames: valid.frames.slice(0, 1) })],
      // Structurally valid but semantically wrong: the recorded inherited cut
      // disagrees with the log, so the accepted sidecar earns one rebuild.
      ['wrong inherited cut', JSON.stringify({ ...valid, inheritedEventCount: 1 })],
    ]

    for (const [name, text] of variants) {
      await writeFile(path, text)
      const window = await readWindow(persistence, id, { beforeSeq: 250, maxEvents: 7 })
      expectWindow(window, full.events.slice(243, 250), full.header)
      const rebuilt = await sidecarOf(mounted, id)
      expect(rebuilt.version, name).toBe(1)
      expect(rebuilt.inheritedEventCount, name).toBe(0)
      expect(totalEvents(rebuilt), name).toBe(events.length)
    }

    // A non-file at the sidecar path is an absent cache; the failed atomic
    // publish must not fail the window this call already validated.
    await unlink(path)
    await mkdir(path)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 250, maxEvents: 7 }), full.events.slice(243, 250))
    await rm(path, { recursive: true })
    expectWindow(await readWindow(persistence, id, { beforeSeq: 250, maxEvents: 7 }), full.events.slice(243, 250))
    expect((await sidecarOf(mounted, id)).version).toBe(1)
  })

  it('declines a plaintext generation whose counted rows are not dense events', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const id = 'before-index-counted-gap'
    const path = logOf(mounted, id)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, [
      JSON.stringify(toHeaderLine(meta(id, '/work'))),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }),
      JSON.stringify({ type: 'step/start', seq: 2, time: 1, data: { turn: 1, step: 1 } }),
      JSON.stringify({ type: 'turn/end', seq: 3, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
    ].join('\n') + '\n')

    // The counted build records three physical rows; the seeded strict decoder
    // proves they are not the dense event stream a window can serve.
    expect(await readWindow(persistence, id, { beforeSeq: 3, maxEvents: 3 })).toBeUndefined()
    expect(totalEvents(await sidecarOf(mounted, id))).toBe(3)
    // The complete read is the fallback that diagnoses the committed hole.
    await expect(readAll(persistence, id)).rejects.toThrow(/seq gap/)
  })

  it('rebuilds after an append and after a modification-time-only change', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted
    const id = 'before-index-stale'
    const first = turnLog(200)
    await store(persistence, id, first, 20)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 150, maxEvents: 5 }), first.slice(145, 150))
    expect((await sidecarOf(mounted, id)).source.sizeBytes).toBe(Number((await stat(logOf(mounted, id), { bigint: true })).size))

    const handle = await persistence.open(SessionId(id), 'write')
    try {
      await handle.append(turnLog(100, first.length))
      await handle.flush()
    } finally {
      await handle.close()
    }
    const all = await readAll(persistence, id)
    expect(all.events).toHaveLength(300)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 260, maxEvents: 10 }), all.events.slice(250, 260), all.header)
    const appended = await sidecarOf(mounted, id)
    expect(appended.source.sizeBytes).toBe(Number((await stat(logOf(mounted, id), { bigint: true })).size))
    expect(totalEvents(appended)).toBe(300)

    // Same size, new identity: only the modification time moved, and the index
    // still describes the previous revision.
    const changed = new Date(Date.now() + 5_000)
    await utimes(logOf(mounted, id), changed, changed)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 100, maxEvents: 5 }), all.events.slice(95, 100), all.header)
    const restamped = await sidecarOf(mounted, id)
    expect(restamped.source.mtimeMs).toBe(Number((await stat(logOf(mounted, id), { bigint: true })).mtimeMs))

    // An accepted index is never rewritten by a page read.
    const past = new Date('2002-03-04T05:06:07.000Z')
    await utimes(sidecarPath(logOf(mounted, id)), past, past)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 100, maxEvents: 5 }), all.events.slice(95, 100), all.header)
    expect(Number((await stat(sidecarPath(logOf(mounted, id)), { bigint: true })).mtimeMs)).toBe(past.getTime())
  })

  it('rebuilds exactly once for a structurally valid but misaligned sidecar', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted
    const id = 'before-index-misaligned'
    const events = turnLog(240)
    await store(persistence, id, events, 8)
    const full = await readAll(persistence, id)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 106, maxEvents: 10 }), full.events.slice(96, 106))

    const path = sidecarPath(logOf(mounted, id))
    const original = JSON.parse(await readFile(path, 'utf8')) as Sidecar
    // Keep the offsets contiguous and the coverage exact while moving one byte
    // from the first selected frame into its predecessor: validation accepts it,
    // and only decoding the claimed segments can disprove it.
    const frames = original.frames.map(frame => ({ ...frame }))
    const shifted = 13
    const predecessor = frames[shifted - 1] as Sidecar['frames'][number]
    const target = frames[shifted] as Sidecar['frames'][number]
    ;(frames[shifted - 1] as { length: number }).length = predecessor.length + 1
    ;(frames[shifted] as { offset: number }).offset = target.offset + 1
    ;(frames[shifted] as { length: number }).length = target.length - 1
    await writeFile(path, JSON.stringify({ ...original, frames }))

    // The sidecar is structurally accepted: a page from an intact segment is
    // served from it without a rebuild.
    const untouched = new Date('2003-04-05T06:07:08.000Z')
    await utimes(path, untouched, untouched)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 5, maxEvents: 2 }), full.events.slice(3, 5), full.header)
    expect(Number((await stat(path, { bigint: true })).mtimeMs)).toBe(untouched.getTime())

    // A page that has to decode the shifted segment disproves it and rebuilds.
    zstdProbe.decompressCalls = 0
    zstdProbe.decodedFrames = 0
    expectWindow(await readWindow(persistence, id, { beforeSeq: 106, maxEvents: 10 }), full.events.slice(96, 106), full.header)
    const selected = segmentsCovering(original, 96, 106)
    // Exactly one complete synchronous rebuild walk (every frame once), then the
    // retry's page decodes only its selected segments.
    expect(zstdProbe.decodedFrames).toBeGreaterThanOrEqual(original.frames.length + selected)
    expect(zstdProbe.decodedFrames).toBeLessThanOrEqual(original.frames.length + 2 * selected)
    expect(zstdProbe.decompressCalls).toBeLessThanOrEqual(3)

    const repaired = await sidecarOf(mounted, id)
    expect(repaired.frames).toStrictEqual(original.frames)
  })

  it('declines pages for torn tails, seeded headers, historical generations, and invalid bounds', async () => {
    const plain = await mount('none')
    const plainId = 'before-index-fallbacks'
    const plainEvents = turnLog(20)
    await store(plain.persistence, plainId, plainEvents)
    const plainFull = await readAll(plain.persistence, plainId)
    expectWindow(await readWindow(plain.persistence, plainId, { beforeSeq: 15, maxEvents: 4 }), plainFull.events.slice(11, 15))

    // Invalid bounds are refused before any index work, so no sidecar appears.
    const untouched = 'before-index-invalid-bounds'
    await store(plain.persistence, untouched, turnLog(9))
    for (const beforeSeq of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -0, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await readWindow(plain.persistence, untouched, { beforeSeq })).toBeUndefined()
    }
    await expect(stat(sidecarPath(logOf(plain, untouched)))).rejects.toMatchObject({ code: 'ENOENT' })

    // A seeded header needs the inherited cut from the omitted prefix.
    const seededId = 'before-index-seeded'
    const seeded = await plain.persistence.create({ ...meta(seededId, '/work'), isSeeded: true }, {
      inheritedEventCount: SessionLogOffset(2),
    })
    await seeded.flush()
    await seeded.close()
    expect(await readWindow(plain.persistence, seededId, { beforeSeq: 1 })).toBeUndefined()
    expect(await readWindow(plain.persistence, seededId)).toBeUndefined()
    await expect(stat(sidecarPath(logOf(plain, seededId)))).rejects.toMatchObject({ code: 'ENOENT' })

    // A historical generation keeps the complete read for migration.
    const historicalId = 'before-index-historical'
    const historicalPath = generationLogPath(plain.root, '/work', SessionId(historicalId), 0, 'none')
    await mkdir(dirname(historicalPath), { recursive: true })
    await writeFile(historicalPath, `${JSON.stringify({
      type: 'session',
      version: 0,
      id: historicalId,
      createdAt: 1_000,
      cwd: '/work',
      delegationDepth: 0,
    })}\n`)
    expect(await readWindow(plain.persistence, historicalId, { beforeSeq: 1 })).toBeUndefined()

    expect(await readWindow(plain.persistence, 'before-index-missing', { beforeSeq: 1 })).toBeUndefined()

    // A torn plaintext tail invalidates the stale index and cannot be rebuilt.
    const tornPlainId = 'before-index-torn-plain'
    await store(plain.persistence, tornPlainId, turnLog(20))
    expectWindow(await readWindow(plain.persistence, tornPlainId, { beforeSeq: 15, maxEvents: 5 }), turnLog(20).slice(10, 15))
    await appendFile(logOf(plain, tornPlainId), '{"type":"turn/start","seq":20')
    expect(await readWindow(plain.persistence, tornPlainId, { beforeSeq: 15, maxEvents: 5 })).toBeUndefined()
    expect((await readAll(plain.persistence, tornPlainId)).events).toHaveLength(20)

    const zstd = await mount('zstd')
    const tornZstdId = 'before-index-torn-zstd'
    await store(zstd.persistence, tornZstdId, turnLog(20), 5)
    expectWindow(await readWindow(zstd.persistence, tornZstdId, { beforeSeq: 15, maxEvents: 5 }), turnLog(20).slice(10, 15))
    const frame = await compressZstdFrame('{"type":"turn/start","seq":20,"time":20,"data":{"turn":11}}\n')
    await appendFile(logOf(zstd, tornZstdId), frame.subarray(0, 8))
    expect(await readWindow(zstd.persistence, tornZstdId, { beforeSeq: 15, maxEvents: 5 })).toBeUndefined()
    expect((await readAll(zstd.persistence, tornZstdId)).events).toHaveLength(20)

    const controller = new AbortController()
    controller.abort()
    await expect(readWindow(plain.persistence, plainId, { beforeSeq: 10, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('JSONL window index: beforeSeq paging contract', () => {
  it('matches the complete-read slice across mixed-row compressed boundaries', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted
    const id = 'before-index-conversation'
    const events = conversationLog(40)
    await store(persistence, id, events, 13)
    const full = await readAll(persistence, id)
    expect(full.events).toHaveLength(240)

    const pages: ReadonlyArray<{ beforeSeq: number; maxEvents: number; expected: readonly SessionEvent[] }> = [
      { beforeSeq: 0, maxEvents: 10, expected: [] },
      { beforeSeq: 1, maxEvents: 10, expected: full.events.slice(0, 1) },
      { beforeSeq: 7, maxEvents: 3, expected: full.events.slice(4, 7) },
      // Frames hold 13 rows: cut exactly on a frame boundary, then across it.
      { beforeSeq: 13, maxEvents: 1, expected: full.events.slice(12, 13) },
      { beforeSeq: 14, maxEvents: 2, expected: full.events.slice(12, 14) },
      { beforeSeq: 26, maxEvents: 25, expected: full.events.slice(1, 26) },
      { beforeSeq: 39, maxEvents: 26, expected: full.events.slice(13, 39) },
      { beforeSeq: 130, maxEvents: 10, expected: full.events.slice(120, 130) },
      { beforeSeq: 240, maxEvents: 2_000, expected: full.events },
      { beforeSeq: 240, maxEvents: 239, expected: full.events.slice(1, 240) },
      { beforeSeq: 239, maxEvents: 239, expected: full.events.slice(0, 239) },
      { beforeSeq: 241, maxEvents: 50, expected: full.events.slice(190, 240) },
      { beforeSeq: 10_000, maxEvents: 50, expected: full.events.slice(190, 240) },
    ]
    for (const page of pages) {
      expectWindow(
        await readWindow(persistence, id, { beforeSeq: page.beforeSeq, maxEvents: page.maxEvents }),
        page.expected,
        full.header,
      )
    }
    expectWindow(await readWindow(persistence, id, { beforeSeq: 240 }), full.events, full.header)
  })

  it('reconstructs the complete plaintext log by paging backwards with hasMore and cursor', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const id = 'before-index-walk'
    const events = turnLog(1_000)
    await store(persistence, id, events, 37)
    const full = await readAll(persistence, id)
    expect(full.events).toStrictEqual(events)

    let beforeSeq = full.events.length
    let collected: readonly SessionEvent[] = []
    let pages = 0
    for (;;) {
      const window = await readWindow(persistence, id, { beforeSeq, maxEvents: 137 })
      if (window === undefined) throw new Error('backwards page was declined')
      expect(window.events.length).toBeGreaterThan(0)
      const first = Number(window.events[0]?.seq)
      const last = Number(window.events.at(-1)?.seq)
      expect(last).toBe(beforeSeq - 1)
      expect(window.cursor).toBe(last)
      expect(window.hasMore).toBe(first > 0)
      expect(window.events).toStrictEqual(full.events.slice(first, last + 1))
      collected = [...window.events, ...collected]
      beforeSeq = first
      pages += 1
      expect(pages).toBeLessThanOrEqual(20)
      if (!window.hasMore) break
    }
    expect(collected).toStrictEqual(full.events)
    expect(pages).toBe(Math.ceil(full.events.length / 137))
  })

  it('serves empty windows and clamped cuts with the documented hasMore meaning', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const emptyId = 'before-index-empty'
    const empty = await persistence.create(meta(emptyId, '/work'))
    await empty.flush()
    await empty.close()
    const emptyWindow = await readWindow(persistence, emptyId, { beforeSeq: 0, maxEvents: 10 })
    expect(emptyWindow?.events).toStrictEqual([])
    expect(emptyWindow?.cursor).toBe(-1)
    expect(emptyWindow?.hasMore).toBe(false)
    expect(emptyWindow?.inheritedEventCount).toBe(SessionLogOffset(0))
    expect(emptyWindow?.header.id).toBe(emptyId)
    expectWindow(await readWindow(persistence, emptyId, { beforeSeq: 5 }), [])

    const id = 'before-index-bounds'
    const events = turnLog(20)
    await store(persistence, id, events)
    const full = await readAll(persistence, id)
    // A cut at zero still takes the indexed path and returns an empty window.
    expectWindow(await readWindow(persistence, id, { beforeSeq: 0, maxEvents: 10 }), [], full.header)
    expect((await sidecarOf(mounted, id)).version).toBe(1)

    // hasMore means "events exist below the returned first seq", not above the cut.
    expectWindow(await readWindow(persistence, id, { beforeSeq: 20, maxEvents: 2_000 }), full.events, full.header)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 25, maxEvents: 10_000 }), full.events, full.header)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 20, maxEvents: 19 }), full.events.slice(1), full.header)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 1, maxEvents: 1 }), full.events.slice(0, 1), full.header)
  })

  it('decodes only the selected segments once the index is valid', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted
    const smallId = 'before-index-bounded-small'
    const largeId = 'before-index-bounded-large'
    const smallEvents = turnLog(240)
    const largeEvents = turnLog(720)
    await store(persistence, smallId, smallEvents, 8)
    await store(persistence, largeId, largeEvents, 8)
    await readWindow(persistence, smallId, { beforeSeq: 106, maxEvents: 10 })
    await readWindow(persistence, largeId, { beforeSeq: 106, maxEvents: 10 })

    const smallSidecar = await sidecarOf(mounted, smallId)
    const largeSidecar = await sidecarOf(mounted, largeId)
    expect(smallSidecar.frames).toHaveLength(31)
    expect(largeSidecar.frames).toHaveLength(91)
    const selected = segmentsCovering(smallSidecar, 96, 106)
    expect(selected).toBe(2)

    zstdProbe.decodedFrames = 0
    expectWindow(await readWindow(persistence, smallId, { beforeSeq: 106, maxEvents: 10 }), smallEvents.slice(96, 106))
    const smallPage = zstdProbe.decodedFrames
    zstdProbe.decodedFrames = 0
    expectWindow(await readWindow(persistence, largeId, { beforeSeq: 106, maxEvents: 10 }), largeEvents.slice(96, 106))
    const largePage = zstdProbe.decodedFrames

    // The bounded page decodes exactly the segments covering rows 96..105 in one
    // batched pass, independent of how many frames the generation holds.
    for (const calls of [smallPage, largePage]) {
      expect(calls).toBe(selected)
      expect(calls).toBeLessThan(largeSidecar.frames.length)
    }
    expect(Math.abs(largePage - smallPage)).toBeLessThanOrEqual(1)

    // The page content is still the complete-read slice.
    const largeFull = await readAll(persistence, largeId)
    expectWindow(
      await readWindow(persistence, largeId, { beforeSeq: 106, maxEvents: 10 }),
      largeFull.events.slice(96, 106),
      largeFull.header,
    )
  })
})
