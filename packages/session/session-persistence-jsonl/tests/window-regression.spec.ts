/**
 * Independent regression coverage for the JSONL `readWindow` history path:
 * equality with the complete-read slice, bounds and cursor/hasMore, compressed
 * multi-frame logs, append freshness, empty sessions, and every fallback that
 * keeps an unvalidated window out of the API.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionWindow, SessionWindowRequest } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame, scanZstdFrames } from '../src/zstd.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

const zstdProbe = vi.hoisted(() => ({ decompressCalls: 0 }))

vi.mock('../src/zstd.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/zstd.ts')>()
  return {
    ...actual,
    async decompressZstdFrame(input: Buffer): Promise<Buffer> {
      zstdProbe.decompressCalls += 1
      return actual.decompressZstdFrame(input)
    },
  }
})

interface Mounted {
  readonly persistence: SessionPersistence
  readonly ctx: Context
  readonly root: string
  readonly compression: 'none' | 'zstd'
}

const mounts: Mounted[] = []

async function mount(compression: 'none' | 'zstd'): Promise<Mounted> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-window-regression-'))
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
  if (failures.length > 0) throw new AggregateError(failures, 'window fixture cleanup failed')
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
        id: MessageId(`window-user-${turn}`),
        role: 'user',
        content: [{ type: 'text', text: `turn ${turn}` }],
        source: { kind: 'user' },
      }) },
      { type: 'step/start', seq: SessionSeq(base + 2), time: base + 2, data: { turn, step: 1 } },
      { type: 'assistant/message', seq: SessionSeq(base + 3), time: base + 3, surfaceOp: 'append', data: {
        turn,
        step: 1,
        message: freezeMessage({
          id: MessageId(`window-assistant-${turn}`),
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
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

describe('JSONL readWindow: tail equality with the complete read', () => {
  it('matches the full-read slice at default, narrow, and exact event bounds', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const id = 'window-default-bounds'
    const events = turnLog(2_100)
    await store(persistence, id, events)

    const full = await readAll(persistence, id)
    expect(full.events).toEqual(events)

    const implicit = await readWindow(persistence, id)
    expectWindow(implicit, events.slice(-2_000))
    expect(implicit?.header).toEqual(full.header)
    expect(implicit?.inheritedEventCount).toBe(SessionLogOffset(0))

    expectWindow(await readWindow(persistence, id, { maxEvents: 1 }), events.slice(-1))
    expectWindow(await readWindow(persistence, id, { maxEvents: 2_099 }), events.slice(-2_099))
    expectWindow(await readWindow(persistence, id, { maxEvents: 2_100 }), events)
  })

  it('matches the full-read slice across message, step, and assistant-stream rows', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const id = 'window-conversation'
    const events = conversationLog(4)
    await store(persistence, id, events, 7)

    const full = await readAll(persistence, id)
    expect(full.events).toEqual(events)
    for (const maxEvents of [1, 6, 23, 24]) {
      const window = await readWindow(persistence, id, { maxEvents })
      expectWindow(window, events.slice(-maxEvents))
      expect(window?.header).toEqual(full.header)
    }
  })

  it('caps a window at 10,000 events while older history remains', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const id = 'window-cap'
    const events = turnLog(10_001)
    await store(persistence, id, events)

    const capped = await readWindow(persistence, id, { maxEvents: 100_000 })
    expectWindow(capped, events.slice(-10_000))
    expect(capped?.hasMore).toBe(true)
    expectWindow(await readWindow(persistence, id, { maxEvents: 10_000 }), events.slice(-10_000))
  })

  it('matches the full-read slice across a compressed multi-frame log', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted
    const id = 'window-frames'
    const events = turnLog(300)
    await store(persistence, id, events, 1)

    const bytes = await readFile(logOf(mounted, id))
    const scan = scanZstdFrames(bytes)
    expect(scan.tornStart).toBeUndefined()
    expect(scan.frames.length).toBe(301)

    const full = await readAll(persistence, id)
    expect(full.events).toEqual(events)
    for (const maxEvents of [1, 7, 128, 300]) {
      const window = await readWindow(persistence, id, { maxEvents })
      expectWindow(window, events.slice(-maxEvents))
      expect(window?.header).toEqual(full.header)
    }
    expectWindow(await readWindow(persistence, id, { maxEvents: 10_000 }), events)
  })

  it('decompresses only the compressed frames a tail window needs', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted
    const id = 'window-frame-budget'
    const events = turnLog(400)
    await store(persistence, id, events, 5)

    const bytes = await readFile(logOf(mounted, id))
    expect(scanZstdFrames(bytes).frames.length).toBe(81)
    await readAll(persistence, id)

    zstdProbe.decompressCalls = 0
    expectWindow(await readWindow(persistence, id, { maxEvents: 10 }), events.slice(-10))
    expect(zstdProbe.decompressCalls).toBeGreaterThan(0)
    expect(zstdProbe.decompressCalls).toBeLessThanOrEqual(6)

    zstdProbe.decompressCalls = 0
    expectWindow(await readWindow(persistence, id, { maxEvents: 25 }), events.slice(-25))
    expect(zstdProbe.decompressCalls).toBeGreaterThan(0)
    expect(zstdProbe.decompressCalls).toBeLessThanOrEqual(10)
  })

  it('serves the same window when the complete log was read first', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const id = 'window-after-full-read'
    const events = turnLog(50)
    await store(persistence, id, events)

    await readAll(persistence, id)
    const first = await readWindow(persistence, id, { maxEvents: 7 })
    const second = await readWindow(persistence, id, { maxEvents: 7 })
    expectWindow(first, events.slice(-7))
    expect(second).toEqual(first)
  })
})

describe('JSONL readWindow: append freshness', () => {
  it('reflects appends to the current generation without a stale window', async () => {
    const { persistence } = await mount('none')
    const id = 'window-append'
    const first = turnLog(10)
    await store(persistence, id, first)
    expectWindow(await readWindow(persistence, id), first)

    const handle = await persistence.open(SessionId(id), 'write')
    try {
      const second = turnLog(14, first.length)
      await handle.append(second)
      await handle.flush()
      expectWindow(await readWindow(persistence, id), [...first, ...second])
    } finally {
      await handle.close()
    }

    const reopened = await persistence.open(SessionId(id), 'write')
    try {
      await reopened.append(turnLog(2_000, 24))
      await reopened.flush()
    } finally {
      await reopened.close()
    }

    const all = (await readAll(persistence, id)).events
    expect(all).toHaveLength(2_024)
    expectWindow(await readWindow(persistence, id), all.slice(-2_000))
    expect(all.slice(0, 24)).toEqual([...first, ...turnLog(14, 10)])
  })

  it('reflects appends made by another instance over the same storage', async () => {
    const writer = await mount('zstd')
    const id = 'window-cross-instance'
    const events = turnLog(30)
    await store(writer.persistence, id, events, 3)

    const readerCtx = new Context()
    await readerCtx.plugin(JsonlSessionPersistence, { root: writer.root, compression: 'zstd' })
    const reader: Mounted = {
      persistence: readerCtx.sessionPersistence,
      ctx: readerCtx,
      root: writer.root,
      compression: 'zstd',
    }
    mounts.push(reader)
    expectWindow(await readWindow(reader.persistence, id), events)

    const handle = await writer.persistence.open(SessionId(id), 'write')
    try {
      await handle.append(turnLog(9, events.length))
      await handle.flush()
    } finally {
      await handle.close()
    }

    const all = (await readAll(writer.persistence, id)).events
    expect(all).toHaveLength(39)
    expectWindow(await readWindow(reader.persistence, id, { maxEvents: 25 }), all.slice(-25))
  })

  it('reflects appends to a compressed generation', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted
    const id = 'window-append-zstd'
    const first = turnLog(8)
    await store(persistence, id, first, 2)
    expectWindow(await readWindow(persistence, id), first)
    const framesBefore = scanZstdFrames(await readFile(logOf(mounted, id))).frames.length

    const handle = await persistence.open(SessionId(id), 'write')
    try {
      await handle.append(turnLog(6, first.length))
      await handle.flush()
    } finally {
      await handle.close()
    }

    const all = (await readAll(persistence, id)).events
    expect(all).toHaveLength(14)
    expectWindow(await readWindow(persistence, id, { maxEvents: 5 }), all.slice(-5))
    expect(scanZstdFrames(await readFile(logOf(mounted, id))).frames.length).toBeGreaterThan(framesBefore)
  })
})

describe('JSONL readWindow: empty, invalid, and unavailable sources', () => {
  it('returns an empty window for a materialized header-only session', async () => {
    const { persistence } = await mount('zstd')
    const id = 'window-empty'
    const handle = await persistence.create(meta(id, '/work'))
    await handle.flush()
    await handle.close()

    const window = await readWindow(persistence, id)
    expect(window).toBeDefined()
    expect(window?.events).toEqual([])
    expect(window?.cursor).toBe(-1)
    expect(window?.hasMore).toBe(false)
    expect(window?.inheritedEventCount).toBe(SessionLogOffset(0))
    expect(window?.header.id).toBe(id)
  })

  it('serves backwards paging and declines invalid bounds so callers keep the full read', async () => {
    const { persistence } = await mount('none')
    const id = 'window-declines'
    const events = turnLog(20)
    await store(persistence, id, events)

    expectWindow(await readWindow(persistence, id, { beforeSeq: 0 }), [])
    expectWindow(await readWindow(persistence, id, { beforeSeq: 1 }), events.slice(0, 1))
    expectWindow(await readWindow(persistence, id, { beforeSeq: 10 }), events.slice(0, 10))
    expectWindow(await readWindow(persistence, id, { beforeSeq: 20, maxEvents: 5 }), events.slice(15, 20))
    expectWindow(await readWindow(persistence, id, { beforeSeq: 21 }), events)
    expectWindow(await readWindow(persistence, id, { beforeSeq: 1_000, maxEvents: 3 }), events.slice(-3))

    for (const beforeSeq of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -0, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await readWindow(persistence, id, { beforeSeq })).toBeUndefined()
    }
    for (const maxEvents of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await readWindow(persistence, id, { maxEvents })).toBeUndefined()
    }
    expect((await readAll(persistence, id)).events).toEqual(events)
  })

  it('declines a torn compressed tail while the complete read keeps the committed log', async () => {
    const mounted = await mount('zstd')
    const { persistence } = mounted
    const id = 'window-torn-tail'
    const events = turnLog(20)
    await store(persistence, id, events)
    const frame = await compressZstdFrame('{"type":"turn/start","seq":20,"time":20,"data":{"turn":11}}\n')
    await appendFile(logOf(mounted, id), frame.subarray(0, 8))

    expect(await readWindow(persistence, id)).toBeUndefined()
    expect((await readAll(persistence, id)).events).toEqual(events)
  })

  it('declines a tail whose selected rows cannot be decoded', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const malformedId = 'window-malformed-row'
    await store(persistence, malformedId, turnLog(20))
    await appendFile(logOf(mounted, malformedId), '{"type":"turn/start","seq":20\n')
    expect(await readWindow(persistence, malformedId)).toBeUndefined()

    const gapId = 'window-seq-gap'
    await store(persistence, gapId, turnLog(20))
    await appendFile(logOf(mounted, gapId), '{"type":"turn/start","seq":21,"time":21,"data":{"turn":11}}\n')
    expect(await readWindow(persistence, gapId)).toBeUndefined()
  })

  it('declines an unreadable stored header and refuses a mismatched stored identity', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const badHeaderId = 'window-bad-header'
    await store(persistence, badHeaderId, turnLog(4))
    await writeFile(logOf(mounted, badHeaderId), 'not a session header\n')
    expect(await readWindow(persistence, badHeaderId)).toBeUndefined()

    const mismatchId = 'window-id-mismatch'
    await store(persistence, mismatchId, turnLog(4))
    const path = logOf(mounted, mismatchId)
    const source = await readFile(path, 'utf8')
    const newline = source.indexOf('\n')
    const header = JSON.parse(source.slice(0, newline)) as Record<string, unknown>
    header.id = 'window-other-session'
    await writeFile(path, JSON.stringify(header) + source.slice(newline))
    await expect(readWindow(persistence, mismatchId)).rejects.toThrow(/does not match header id/)
  })

  it('declines historical generations that still need migration', async () => {
    const mounted = await mount('none')
    const id = 'window-historical'
    const path = generationLogPath(mounted.root, '/work', SessionId(id), 0, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({
      type: 'session',
      version: 0,
      id,
      createdAt: 1_000,
      cwd: '/work',
      delegationDepth: 0,
    })}\n`)

    expect(await readWindow(mounted.persistence, id)).toBeUndefined()
  })

  it('honors cancellation before reading', async () => {
    const { persistence } = await mount('none')
    const id = 'window-aborted'
    await store(persistence, id, turnLog(4))
    const controller = new AbortController()
    controller.abort()
    await expect(readWindow(persistence, id, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps the index-free newest window independent of a damaged generation index', async () => {
    const mounted = await mount('none')
    const { persistence } = mounted
    const id = 'window-sidecar'
    const events = turnLog(60)
    await store(persistence, id, events)
    const path = logOf(mounted, id)
    const sidecar = `${path}.window-index.json`

    // Build the durable index through a backwards page, then damage it: the
    // newest window never consults the sidecar.
    expectWindow(await readWindow(persistence, id, { beforeSeq: 50, maxEvents: 10 }), events.slice(40, 50))
    await writeFile(sidecar, '{"version":1,"frames":[')
    expectWindow(await readWindow(persistence, id, { maxEvents: 10 }), events.slice(-10))

    await writeFile(sidecar, JSON.stringify({
      version: 1,
      source: { sizeBytes: 0, mtimeMs: 0 },
      inheritedEventCount: 0,
      frames: [],
    }))
    expectWindow(await readWindow(persistence, id, { maxEvents: 10 }), events.slice(-10))

    await rm(sidecar)
    expectWindow(await readWindow(persistence, id, { maxEvents: 10 }), events.slice(-10))
  })
})
