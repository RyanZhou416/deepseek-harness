/** Tail windows over current JSONL generations: equality with the full-read slice and safe fallbacks. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { eventLines, generationLogPath, toHeaderLine } from '../src/format.ts'
import { readWindowIndex, readWindowIndexSource, windowIndexPath } from '../src/window-index.ts'
import type { JsonlWindowIndex } from '../src/window-index.ts'
import { WindowIndexMemo } from '../src/window-index-memo.ts'
import { readJsonlIndexedWindow } from '../src/window.ts'
import { compressZstdFrame } from '../src/zstd.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

/**
 * Observations the memo module does not expose: how many sidecar parses the
 * backend's memo performed, and which memo instances the backend constructed.
 */
const memoProbe = vi.hoisted(() => ({
  capture: false,
  parses: 0,
  instances: [] as { readonly size: number; readonly isDisposed: boolean }[],
}))

vi.mock('../src/window-index-memo.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/window-index-memo.ts')>()
  class ProbeWindowIndexMemo extends actual.WindowIndexMemo {
    constructor(maxEntries?: number) {
      super(maxEntries)
      if (memoProbe.capture) memoProbe.instances.push(this)
    }

    override async load(
      sourcePath: string,
      source: { readonly sizeBytes: number; readonly mtimeMs: number },
      parse: () => Promise<JsonlWindowIndex | undefined>,
    ): Promise<JsonlWindowIndex | undefined> {
      return super.load(sourcePath, source, async () => {
        memoProbe.parses += 1
        return parse()
      })
    }
  }
  return { ...actual, WindowIndexMemo: ProbeWindowIndexMemo }
})

interface Mounted {
  readonly persistence: SessionPersistence
  readonly ctx: Context
  readonly root: string
}

const mounts: Mounted[] = []

async function mount(compression: 'none' | 'zstd'): Promise<Mounted> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-window-'))
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root, compression })
  } catch (error: unknown) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const mounted = { persistence: ctx.sessionPersistence, ctx, root }
  mounts.push(mounted)
  return mounted
}

async function disposeMounted(mounted: Mounted): Promise<void> {
  await mounted.ctx.fiber.dispose()
  await rm(mounted.root, { recursive: true, force: true })
}

afterEach(async () => {
  const pending = mounts.splice(0)
  const failures: unknown[] = []
  for (const mounted of pending) {
    try {
      await disposeMounted(mounted)
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'window fixture cleanup failed')
})

beforeEach(() => {
  memoProbe.capture = false
  memoProbe.parses = 0
  memoProbe.instances.length = 0
})

/** A valid contiguous log of alternating turn boundaries, at least two events. */
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

/** Materialize one session in append batches so a compressed log has several frames. */
async function store(
  persistence: SessionPersistence,
  id: string,
  events: readonly SessionEvent[],
  batchSize = events.length,
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

function expectWindow(
  window: Awaited<ReturnType<NonNullable<SessionPersistence['readWindow']>>>,
  expected: readonly SessionEvent[],
): void {  expect(window).toBeDefined()
  expect(window?.events.map(event => event.seq)).toStrictEqual(expected.map(event => Number(event.seq)))
  expect(window?.events).toStrictEqual(expected)
  expect(window?.cursor).toBe(expected.at(-1) === undefined ? -1 : Number(expected.at(-1)?.seq))
}

/** Selected current-generation path of one fixture session. */
function logOf(mounted: Mounted, id: string, compression: 'none' | 'zstd'): string {
  return generationLogPath(mounted.root, '/work', SessionId(id), SESSION_FORMAT_VERSION, compression)
}

/** Exact header record text and parsed value for one unseeded current generation. */
function headerOf(id: string): { headerLine: string; headerValue: unknown } {
  const headerLine = JSON.stringify(toHeaderLine(meta(id, '/work')))
  return { headerLine, headerValue: JSON.parse(headerLine) }
}

/** The sidecar beside one generation, read back through the shipped reader. */
async function sidecarOf(path: string): Promise<JsonlWindowIndex | undefined> {
  const source = await readWindowIndexSource(path)
  return source === undefined ? undefined : readWindowIndex(path, source)
}

describe('JsonlSessionPersistence.readWindow: index-free tail', () => {
  it('returns the newest bounded window equal to the full-read slice (plaintext)', async () => {
    const { persistence } = await mount('none')
    const id = 'window-plain'
    const events = turnLog(2_100)
    await store(persistence, id, events)

    const window = await persistence.readWindow?.(SessionId(id))
    expectWindow(window, events.slice(-2_000))
    expect(window?.header.id).toBe(id)
    expect(window?.inheritedEventCount).toBe(SessionLogOffset(0))
    expect(window?.hasMore).toBe(true)

    const wider = await persistence.readWindow?.(SessionId(id), { maxEvents: 10_000 })
    expectWindow(wider, events)
    expect(wider?.hasMore).toBe(false)
  })

  it('returns the newest bounded window equal to the full-read slice (compressed multi-frame)', async () => {
    const { persistence } = await mount('zstd')
    const id = 'window-zstd'
    const events = turnLog(2_100)
    await store(persistence, id, events, 100)

    const window = await persistence.readWindow?.(SessionId(id), { maxEvents: 500 })
    expectWindow(window, events.slice(-500))
    expect(window?.hasMore).toBe(true)

    const partial = await persistence.readWindow?.(SessionId(id), { maxEvents: 137 })
    expectWindow(partial, events.slice(-137))
    expect(partial?.hasMore).toBe(true)

    const everything = await persistence.readWindow?.(SessionId(id), { maxEvents: 10_000 })
    expectWindow(everything, events)
    expect(everything?.hasMore).toBe(false)
  })

  it('caps maxEvents and treats the whole small log as the tail', async () => {
    const { persistence } = await mount('zstd')
    const id = 'window-small'
    const events = turnLog(6)
    await store(persistence, id, events)

    const window = await persistence.readWindow?.(SessionId(id), { maxEvents: 100_000 })
    expectWindow(window, events)
    expect(window?.hasMore).toBe(false)
  })

  it('serves beforeSeq paging and falls back for seeded headers and invalid bounds', async () => {
    const { persistence, root } = await mount('none')
    const id = 'window-fallbacks'
    const events = turnLog(20)
    await store(persistence, id, events)

    expectWindow(await persistence.readWindow?.(SessionId(id), { beforeSeq: 10 }), events.slice(0, 10))
    const older = await persistence.readWindow?.(SessionId(id), { beforeSeq: 15, maxEvents: 5 })
    expectWindow(older, events.slice(10, 15))
    expect(older?.hasMore).toBe(true)
    expect(await persistence.readWindow?.(SessionId(id), { maxEvents: 0 })).toBeUndefined()
    expect(await persistence.readWindow?.(SessionId(id), { maxEvents: 1.5 })).toBeUndefined()
    expect(await persistence.readWindow?.(SessionId(id), { beforeSeq: -1 })).toBeUndefined()

    const seededId = 'window-seeded'
    const seeded = await persistence.create({ ...meta(seededId, '/work'), isSeeded: true }, {
      inheritedEventCount: SessionLogOffset(2),
    })
    await seeded.flush()
    await seeded.close()
    expect(await persistence.readWindow?.(SessionId(seededId))).toBeUndefined()
    expect(await persistence.readWindow?.(SessionId(seededId), { beforeSeq: 1 })).toBeUndefined()

    const missing = await persistence.readWindow?.(SessionId('window-missing'))
    expect(missing).toBeUndefined()
    expect(root.length).toBeGreaterThan(0)
  })

  it('falls back when the physical tail is torn or a selected row is invalid', async () => {
    const { persistence, root } = await mount('none')
    const id = 'window-torn'
    await store(persistence, id, turnLog(20))
    await appendFile(generationLogPath(root, '/work', SessionId(id), SESSION_FORMAT_VERSION, 'none'), '{"type":"turn/start","seq":')
    expect(await persistence.readWindow?.(SessionId(id))).toBeUndefined()
    expect(await readAll(persistence, id)).toHaveLength(20)
  })
})

describe('bounded parsed-index memo', () => {
  it('serves warm beforeSeq pages from one parsed sidecar and releases it on backend teardown', async () => {
    memoProbe.capture = true
    const mounted = await mount('zstd')
    memoProbe.capture = false
    const { persistence } = mounted
    const id = 'window-memo-backend'
    const events = turnLog(1_000)
    await store(persistence, id, events, 40)

    expectWindow(
      await persistence.readWindow?.(SessionId(id), { beforeSeq: 800, maxEvents: 50 }),
      events.slice(750, 800),
    )
    const memo = memoProbe.instances.at(-1)
    expect(memoProbe.parses).toBe(1)
    expect(memo?.size).toBe(1)
    expect(memo?.isDisposed).toBe(false)

    expectWindow(
      await persistence.readWindow?.(SessionId(id), { beforeSeq: 600, maxEvents: 50 }),
      events.slice(550, 600),
    )
    expectWindow(
      await persistence.readWindow?.(SessionId(id), { beforeSeq: 400, maxEvents: 50 }),
      events.slice(350, 400),
    )
    // Warm pages reused the retained parse instead of re-reading the sidecar.
    expect(memoProbe.parses).toBe(1)
    expect(memo?.size).toBe(1)

    // A changed generation identity drops the retained parse and rebuilds.
    const writer = await persistence.open(SessionId(id), 'write')
    try {
      await writer.append(turnLog(20, events.length))
      await writer.flush()
    } finally {
      await writer.close()
    }
    const all = [...events, ...turnLog(20, events.length)]
    expectWindow(
      await persistence.readWindow?.(SessionId(id), { beforeSeq: all.length, maxEvents: 10 }),
      all.slice(-10),
    )
    expect(memoProbe.parses).toBe(2)
    expect(memo?.size).toBe(1)

    mounts.splice(mounts.indexOf(mounted), 1)
    await disposeMounted(mounted)
    expect(memo?.isDisposed).toBe(true)
    expect(memo?.size).toBe(0)
  })

  it('reuses the retained parse for warm pages and matches the uncached indexed read', async () => {
    const mounted = await mount('zstd')
    const id = 'window-memo-warm'
    const events = turnLog(420)
    await store(mounted.persistence, id, events, 20)
    const path = logOf(mounted, id, 'zstd')
    const { headerLine, headerValue } = headerOf(id)

    const uncached = await readJsonlIndexedWindow(path, 'zstd', headerValue, headerLine, 300, 25)
    expect(uncached?.events).toStrictEqual(events.slice(275, 300))

    memoProbe.parses = 0
    const memo = new WindowIndexMemo()
    const first = await readJsonlIndexedWindow(path, 'zstd', headerValue, headerLine, 300, 25, undefined, memo)
    expect(first).toStrictEqual(uncached)
    expect(memoProbe.parses).toBe(1)
    expect(memo.size).toBe(1)

    memoProbe.parses = 0
    const warm = await readJsonlIndexedWindow(path, 'zstd', headerValue, headerLine, 200, 25, undefined, memo)
    expect(warm?.events).toStrictEqual(events.slice(175, 200))
    expect(warm?.hasMore).toBe(true)
    expect(memoProbe.parses).toBe(0)
    expect(memo.size).toBe(1)
  })

  it('shares one sidecar parse between concurrent pages', async () => {
    const mounted = await mount('zstd')
    const id = 'window-memo-concurrent'
    const events = turnLog(300)
    await store(mounted.persistence, id, events, 15)
    const path = logOf(mounted, id, 'zstd')
    const { headerLine, headerValue } = headerOf(id)
    // Build the sidecar first so the concurrent pages share a sidecar read
    // rather than racing two rebuilds.
    await readJsonlIndexedWindow(path, 'zstd', headerValue, headerLine, 250, 20)

    const memo = new WindowIndexMemo()
    memoProbe.parses = 0
    const [first, second] = await Promise.all([
      readJsonlIndexedWindow(path, 'zstd', headerValue, headerLine, 250, 20, undefined, memo),
      readJsonlIndexedWindow(path, 'zstd', headerValue, headerLine, 150, 20, undefined, memo),
    ])
    expect(first?.events).toStrictEqual(events.slice(230, 250))
    expect(second?.events).toStrictEqual(events.slice(130, 150))
    expect(memoProbe.parses).toBe(1)
    expect(memo.size).toBe(1)
  })

  it('invalidates on a corrupt sidecar, an appended generation, and a deleted generation', async () => {
    const mounted = await mount('zstd')
    const id = 'window-memo-invalidate'
    const events = turnLog(240)
    await store(mounted.persistence, id, events, 20)
    const path = logOf(mounted, id, 'zstd')
    const sidecar = windowIndexPath(path)
    const { headerLine, headerValue } = headerOf(id)
    const memo = new WindowIndexMemo()

    await readJsonlIndexedWindow(path, 'zstd', headerValue, headerLine, 200, 10, undefined, memo)
    expect(memo.size).toBe(1)

    // A corrupt sidecar is re-read and rebuilt exactly as the uncached path does.
    await writeFile(sidecar, '{"version":1,"frames":[')
    const rebuilt = await readJsonlIndexedWindow(path, 'zstd', headerValue, headerLine, 200, 10, undefined, memo)
    expect(rebuilt?.events).toStrictEqual(events.slice(190, 200))
    expect(await sidecarOf(path)).toBeDefined()
    expect(memo.size).toBe(1)

    // An appended generation changes the source identity and rebuilds the index.
    const appended = turnLog(40, events.length)
    await appendFile(path, await compressZstdFrame(`${eventLines(appended)}\n`))
    const all = [...events, ...appended]
    const afterAppend = await readJsonlIndexedWindow(
      path, 'zstd', headerValue, headerLine, all.length, 10, undefined, memo,
    )
    expect(afterAppend?.events).toStrictEqual(all.slice(-10))
    const generation = await stat(path, { bigint: true })
    expect((await sidecarOf(path))?.source.sizeBytes).toBe(Number(generation.size))
    expect(memo.size).toBe(1)

    // A deleted generation has no identity to reuse; the window falls back and
    // its retained parse is released.
    await unlink(path)
    expect(await readJsonlIndexedWindow(path, 'zstd', headerValue, headerLine, 100, 5, undefined, memo))
      .toBeUndefined()
    expect(memo.size).toBe(0)
  })
})
