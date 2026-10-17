/** Tail windows over current JSONL generations: equality with the full-read slice and safe fallbacks. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath } from '../src/format.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

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

/** A valid contiguous log of alternating turn boundaries, at least two events. */
function turnLog(count: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let index = 0; index < count; index += 1) {
    const turn = Math.floor(index / 2) + 1
    events.push(index % 2 === 0
      ? { type: 'turn/start', seq: SessionSeq(index), time: index, data: { turn } }
      : { type: 'turn/end', seq: SessionSeq(index), time: index, data: { turn, reason: { kind: 'completed' } } })
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
