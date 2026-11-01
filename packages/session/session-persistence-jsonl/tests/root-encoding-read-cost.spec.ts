/**
 * Root encoding discovery over a large synthetic corpus: a targeted stat or
 * window read validates only the accessed Session directory, a concurrent
 * listing never queues behind a whole-root encoding traversal, and a complete
 * listing still reports a root that mixes physical encodings.
 */

import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { eventLines, generationLogPath, sessionDir, toHeaderLine } from '../src/format.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

/**
 * Read directory observations for this spec. `held` directories suspend their
 * readdir on `gate` while the fence is enabled, so a test can prove which
 * traversal is in flight.
 */
const fence = vi.hoisted(() => ({
  enabled: false,
  readdir: [] as string[],
  held: new Set<string>(),
  starts: 0,
  gate: Promise.resolve(undefined),
  open: (): void => {},
  onStart: undefined as (() => void) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      const path = String(args[0])
      if (!fence.enabled) return actual.readdir(...args)
      fence.readdir.push(path)
      if (fence.held.has(path)) {
        fence.starts += 1
        fence.onStart?.()
        await fence.gate
      }
      return actual.readdir(...args)
    }) as typeof actual.readdir,
  }
})

const roots: string[] = []
const contexts: Context[] = []

beforeEach(() => {
  const gate = Promise.withResolvers<undefined>()
  fence.enabled = false
  fence.held = new Set()
  fence.readdir = []
  fence.starts = 0
  fence.gate = gate.promise
  fence.open = () => { gate.resolve(undefined) }
  fence.onStart = undefined
})

afterEach(async () => {
  fence.enabled = false
  fence.held = new Set()
  fence.onStart = undefined
  fence.open()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** One targeted Session plus many empty Session directories the corpus traversal would visit. */
interface Corpus {
  readonly root: string
  readonly target: SessionId
  readonly targetPath: string
  readonly events: readonly SessionEvent[]
  readonly foreign: readonly SessionId[]
  readonly foreignDirs: readonly string[]
  readonly oppositeId: SessionId
  readonly oppositePath: string
}

const FOREIGN_COUNT = 60

/** A valid two-event current log. */
function turnLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** Write one current plaintext generation plus the empty directories of a large corpus. */
async function corpus(): Promise<Corpus> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-encoding-'))
  roots.push(root)
  const target = SessionId('encoding-target')
  const targetPath = generationLogPath(root, '/work', target, SESSION_FORMAT_VERSION, 'none')
  const events = turnLog()
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, `${JSON.stringify(toHeaderLine(meta(String(target), '/work')))}\n${eventLines(events)}\n`)
  const foreign = Array.from({ length: FOREIGN_COUNT }, (_, index) => SessionId(`encoding-subagent-${index}`))
  for (const id of foreign) await mkdir(sessionDir(root, '/work', id), { recursive: true })
  const oppositeId = SessionId('encoding-opposite')
  const oppositePath = generationLogPath(root, '/work', oppositeId, SESSION_FORMAT_VERSION, 'zstd')
  return {
    root,
    target,
    targetPath,
    events,
    foreign,
    foreignDirs: foreign.map(id => sessionDir(root, '/work', id)),
    oppositeId,
    oppositePath,
  }
}

/** Mount a plaintext backend on an existing corpus. */
async function mount(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

/** Start recording readdir calls. */
function startFence(): void {
  fence.readdir = []
  fence.enabled = true
}

/** Resolve once `count` held readdir calls have started. */
function heldStarts(count: number): Promise<void> {
  if (fence.starts >= count) return Promise.resolve()
  return new Promise<void>((resolve) => {
    fence.onStart = () => {
      if (fence.starts >= count) resolve()
    }
  })
}

/** Resolve after `milliseconds`, without keeping the process alive. */
function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref()
  })
}

/** Every Session directory in the corpus, at any encoding. */
function sessionDirs(scope: Corpus): Set<string> {
  return new Set([sessionDir(scope.root, '/work', scope.target), ...scope.foreignDirs])
}

describe('root encoding read cost', () => {
  it('reads only the accessed Session directory on the first stat', async () => {
    const fixture = await corpus()
    const ctx = await mount(fixture.root)

    startFence()
    const snapshot = await ctx.sessionPersistence.stat(fixture.target)
    fence.enabled = false

    expect(snapshot?.header.id).toBe(fixture.target)
    const touched = fence.readdir.filter(path => sessionDirs(fixture).has(path))
    expect(touched).toEqual([sessionDir(fixture.root, '/work', fixture.target)])
    for (const dir of fixture.foreignDirs) expect(fence.readdir).not.toContain(dir)
  })

  it('reads only the accessed Session directory on the first window read', async () => {
    const fixture = await corpus()
    const ctx = await mount(fixture.root)

    startFence()
    const window = await ctx.sessionPersistence.readWindow?.(fixture.target)
    fence.enabled = false

    expect(window?.events.map(event => Number(event.seq))).toEqual(fixture.events.map(event => Number(event.seq)))
    const touched = fence.readdir.filter(path => sessionDirs(fixture).has(path))
    expect(touched).toEqual([sessionDir(fixture.root, '/work', fixture.target)])
    for (const dir of fixture.foreignDirs) expect(fence.readdir).not.toContain(dir)
  })

  it('keeps a concurrent listing out of an in-flight window read traversal', async () => {
    const fixture = await corpus()
    const ctx = await mount(fixture.root)
    startFence()
    fence.held = new Set(fixture.foreignDirs)

    let window: Promise<unknown> | undefined
    let listed: Promise<unknown> | undefined
    try {
      window = ctx.sessionPersistence.readWindow?.(fixture.target)
      // A whole-root encoding traversal would hold these directories here.
      await Promise.race([heldStarts(3), delay(250)])
      const traversed = fence.readdir.filter(path => fence.held.has(path))
      listed = ctx.sessionPersistence.listHeaders({ excludeSessionIds: new Set(fixture.foreign) })
      const outcome = await Promise.race([
        listed.then(() => 'listed' as const),
        delay(2_000).then(() => 'queued' as const),
      ])
      expect(traversed).toEqual([])
      expect(outcome).toBe('listed')
    } finally {
      fence.held = new Set()
      fence.enabled = false
      fence.open()
    }
    await window
    await listed
  })

  it('still reports a mixed root on a complete listing while a targeted read stays local', async () => {
    const fixture = await corpus()
    await mkdir(dirname(fixture.oppositePath), { recursive: true })
    await writeFile(fixture.oppositePath, 'opposite encoding')
    const ctx = await mount(fixture.root)

    // The complete scan is the root encoding check: every visited directory
    // rejects a generation in the other encoding.
    await expect(ctx.sessionPersistence.list()).rejects.toThrow(JSON.stringify(fixture.oppositePath))
    await expect(ctx.sessionPersistence.stat(fixture.oppositeId)).rejects.toThrow(/configured for compression "none"/)
    await expect(ctx.sessionPersistence.open(fixture.oppositeId, 'read')).rejects.toThrow(/uses \.jsonl\.zstd/)

    // A targeted read validates only the directory it accesses; the mixed root
    // is reported by the listing above, not by an unrelated Session's read.
    const window = await ctx.sessionPersistence.readWindow?.(fixture.target)
    expect(window?.events.map(event => Number(event.seq))).toEqual(fixture.events.map(event => Number(event.seq)))
  })
})
