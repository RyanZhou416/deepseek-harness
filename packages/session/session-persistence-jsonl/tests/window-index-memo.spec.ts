/**
 * The backend's bounded parsed window-index memo: reuse only while the exact
 * generation identity and sidecar revision still match, one shared parse for
 * concurrent readers, a bounded least-recently-used set, and disposal that
 * releases every retained parse without failing a page already in flight.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WINDOW_INDEX_VERSION, windowIndexPath,
  type JsonlWindowIndex, type JsonlWindowIndexSource,
} from '../src/window-index.ts'
import { WindowIndexMemo } from '../src/window-index-memo.ts'

const roots: string[] = []

afterEach(async () => {
  const pending = roots.splice(0)
  const failures: unknown[] = []
  for (const root of pending) {
    try {
      await rm(root, { recursive: true, force: true })
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'window index memo fixture cleanup failed')
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-window-memo-'))
  roots.push(root)
  return root
}

function generationPath(root: string, name: string): string {
  return join(root, `${name}.jsonl.zstd`)
}

/** Write one sidecar beside its generation; only its file state matters to the memo. */
async function writeSidecar(path: string, text = '{"version":1}\n'): Promise<void> {
  await writeFile(windowIndexPath(path), text)
}

/** One exchange identity for the generation the index claims to describe. */
function sourceIdentity(sizeBytes = 100, mtimeMs = 1_000): JsonlWindowIndexSource {
  return { sizeBytes, mtimeMs }
}

/** One valid-shaped parsed index; the memo stores values the sidecar reader validated. */
function indexFixture(events = 4, sizeBytes = 100): JsonlWindowIndex {
  return {
    version: WINDOW_INDEX_VERSION,
    source: { sizeBytes, mtimeMs: 1_000 },
    inheritedEventCount: 0,
    frames: [
      { offset: 0, length: 10, firstRow: 0, firstSeq: 0, events: 0 },
      { offset: 10, length: sizeBytes - 10, firstRow: 0, firstSeq: 0, events },
    ],
  }
}

/** One manually settled promise, so a parse can be observed while it is in flight. */
function deferred(): { promise: Promise<JsonlWindowIndex | undefined>; settle(value: JsonlWindowIndex | undefined): void } {
  let settle!: (value: JsonlWindowIndex | undefined) => void
  const promise = new Promise<JsonlWindowIndex | undefined>((resolve) => { settle = resolve })
  return { promise, settle }
}

/** One manually rejected promise, so concurrent readers can share a failure. */
function rejecting(): { promise: Promise<JsonlWindowIndex | undefined>; fail(error: unknown): void } {
  let fail!: (error: unknown) => void
  const promise = new Promise<JsonlWindowIndex | undefined>((_resolve, reject) => { fail = reject })
  return { promise, fail }
}

/** Yield until pending filesystem callbacks and continuations have run. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
}

describe('WindowIndexMemo: identity-keyed reuse', () => {
  it('reuses one frozen parse while the generation and sidecar identity are unchanged', async () => {
    const root = await tempRoot()
    const path = generationPath(root, 'hit')
    await writeSidecar(path)
    const memo = new WindowIndexMemo()
    const index = indexFixture()
    const parse = vi.fn(async () => index)

    expect(await memo.load(path, sourceIdentity(), parse)).toBe(index)
    expect(await memo.load(path, sourceIdentity(), parse)).toBe(index)
    expect(parse).toHaveBeenCalledTimes(1)
    expect(memo.size).toBe(1)
    expect(Object.isFrozen(index)).toBe(true)
    expect(Object.isFrozen(index.source)).toBe(true)
    expect(Object.isFrozen(index.frames)).toBe(true)
    expect(Object.isFrozen(index.frames[0])).toBe(true)
  })

  it('retains an externally built index under its identity', async () => {
    const root = await tempRoot()
    const path = generationPath(root, 'set-hit')
    await writeSidecar(path)
    const memo = new WindowIndexMemo()
    const built = indexFixture()
    await memo.set(path, sourceIdentity(), built)

    const parse = vi.fn(async () => indexFixture())
    expect(await memo.load(path, sourceIdentity(), parse)).toBe(built)
    expect(parse).not.toHaveBeenCalled()
    expect(memo.size).toBe(1)
  })

  it('does not retain a miss and retries the parse', async () => {
    const root = await tempRoot()
    const path = generationPath(root, 'miss')
    await writeSidecar(path)
    const memo = new WindowIndexMemo()
    const parse = vi.fn(async () => undefined)

    expect(await memo.load(path, sourceIdentity(), parse)).toBeUndefined()
    expect(await memo.load(path, sourceIdentity(), parse)).toBeUndefined()
    expect(parse).toHaveBeenCalledTimes(2)
    expect(memo.size).toBe(0)
  })

  it('drops the entry when the generation size or modification time changes', async () => {
    const root = await tempRoot()
    const path = generationPath(root, 'generation-identity')
    await writeSidecar(path)
    const memo = new WindowIndexMemo()
    const parse = vi.fn(async () => indexFixture())

    await memo.load(path, sourceIdentity(), parse)
    await memo.load(path, sourceIdentity(101), parse)
    expect(parse).toHaveBeenCalledTimes(2)
    expect(memo.size).toBe(1)

    await memo.load(path, sourceIdentity(101, 2_000), parse)
    expect(parse).toHaveBeenCalledTimes(3)

    // Both mismatches dropped their entry, so the original identity parses anew.
    await memo.load(path, sourceIdentity(), parse)
    expect(parse).toHaveBeenCalledTimes(4)
    expect(memo.size).toBe(1)
  })

  it('re-reads when the sidecar is rewritten, restamped, or deleted', async () => {
    const root = await tempRoot()
    const path = generationPath(root, 'sidecar-revision')
    await writeSidecar(path)
    const memo = new WindowIndexMemo()
    const parse = vi.fn(async () => indexFixture())

    await memo.load(path, sourceIdentity(), parse)
    // A different sidecar length invalidates the retained parse.
    await writeSidecar(path, '{"version":1,"frames":[]}\n')
    await memo.load(path, sourceIdentity(), parse)
    expect(parse).toHaveBeenCalledTimes(2)

    // The same length with a new modification time is a different revision too.
    const restamped = new Date(Date.now() + 5_000)
    await utimes(windowIndexPath(path), restamped, restamped)
    await memo.load(path, sourceIdentity(), parse)
    expect(parse).toHaveBeenCalledTimes(3)

    // A deleted sidecar is an absent cache, never a cached parse.
    await rm(windowIndexPath(path))
    await memo.load(path, sourceIdentity(), parse)
    expect(parse).toHaveBeenCalledTimes(4)
  })

  it('keeps a non-file sidecar state distinct from a missing sidecar', async () => {
    const root = await tempRoot()
    const path = generationPath(root, 'sidecar-directory')
    await mkdir(windowIndexPath(path))
    const memo = new WindowIndexMemo()
    await memo.set(path, sourceIdentity(), indexFixture())

    const parse = vi.fn(async () => undefined)
    expect(await memo.load(path, sourceIdentity(), parse)).toBeDefined()
    expect(parse).not.toHaveBeenCalled()

    // Removing the directory is a state change, so the next read re-reads.
    await rm(windowIndexPath(path), { recursive: true })
    expect(await memo.load(path, sourceIdentity(), parse)).toBeUndefined()
    expect(parse).toHaveBeenCalledTimes(1)
    expect(memo.size).toBe(0)
  })

  it('keys distinct generation paths separately', async () => {
    const root = await tempRoot()
    const first = generationPath(root, 'separate-first')
    const second = generationPath(root, 'separate-second')
    await writeSidecar(first)
    await writeSidecar(second)
    const memo = new WindowIndexMemo()
    const parse = vi.fn(async () => indexFixture())

    await memo.load(first, sourceIdentity(), parse)
    await memo.load(second, sourceIdentity(), parse)
    expect(parse).toHaveBeenCalledTimes(2)
    expect(memo.size).toBe(2)

    await memo.load(first, sourceIdentity(), parse)
    await memo.load(second, sourceIdentity(), parse)
    expect(parse).toHaveBeenCalledTimes(2)
  })

  it('drops one retained parse without touching the others', async () => {
    const root = await tempRoot()
    const first = generationPath(root, 'drop-first')
    const second = generationPath(root, 'drop-second')
    await writeSidecar(first)
    await writeSidecar(second)
    const memo = new WindowIndexMemo()
    const parse = vi.fn(async () => indexFixture())

    await memo.load(first, sourceIdentity(), parse)
    await memo.load(second, sourceIdentity(), parse)
    memo.delete(first)
    expect(memo.size).toBe(1)

    await memo.load(second, sourceIdentity(), parse)
    expect(parse).toHaveBeenCalledTimes(2)
    await memo.load(first, sourceIdentity(), parse)
    expect(parse).toHaveBeenCalledTimes(3)
  })
})

describe('WindowIndexMemo: single-flight parsing', () => {
  it('parses once for concurrent readers of one identity', async () => {
    const root = await tempRoot()
    const path = generationPath(root, 'single-flight')
    await writeSidecar(path)
    const memo = new WindowIndexMemo()
    const index = indexFixture()
    const gate = deferred()
    const parse = vi.fn(() => gate.promise)

    const first = memo.load(path, sourceIdentity(), parse)
    const second = memo.load(path, sourceIdentity(), parse)
    await settle()
    expect(parse).toHaveBeenCalledTimes(1)
    gate.settle(index)
    expect(await first).toBe(index)
    expect(await second).toBe(index)
    expect(memo.size).toBe(1)
  })

  it('parses once per identity when concurrent readers disagree', async () => {
    const root = await tempRoot()
    const path = generationPath(root, 'single-flight-identities')
    await writeSidecar(path)
    const memo = new WindowIndexMemo()
    const firstGate = deferred()
    const secondGate = deferred()
    const firstParse = vi.fn(() => firstGate.promise)
    const secondParse = vi.fn(() => secondGate.promise)

    const first = memo.load(path, sourceIdentity(100), firstParse)
    const second = memo.load(path, sourceIdentity(101), secondParse)
    await settle()
    expect(firstParse).toHaveBeenCalledTimes(1)
    expect(secondParse).toHaveBeenCalledTimes(1)
    firstGate.settle(indexFixture(4, 100))
    secondGate.settle(indexFixture(4, 101))
    expect((await first)?.source.sizeBytes).toBe(100)
    expect((await second)?.source.sizeBytes).toBe(101)
    expect(memo.size).toBe(1)
  })

  it('shares a rejected parse and retries afterwards', async () => {
    const root = await tempRoot()
    const path = generationPath(root, 'single-flight-failure')
    await writeSidecar(path)
    const memo = new WindowIndexMemo()
    const failure = new Error('sidecar read failed')
    const gate = rejecting()
    const parse = vi.fn()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce(indexFixture())

    const first = memo.load(path, sourceIdentity(), parse)
    const second = memo.load(path, sourceIdentity(), parse)
    await settle()
    expect(parse).toHaveBeenCalledTimes(1)
    gate.fail(failure)
    const settled = await Promise.allSettled([first, second])
    expect(settled).toStrictEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ])
    expect(memo.size).toBe(0)

    expect(await memo.load(path, sourceIdentity(), parse)).toBeDefined()
    expect(parse).toHaveBeenCalledTimes(2)
    expect(memo.size).toBe(1)
  })
})

describe('WindowIndexMemo: bound and disposal', () => {
  it('evicts the least recently used parse past its bound', async () => {
    const root = await tempRoot()
    const first = generationPath(root, 'bound-first')
    const second = generationPath(root, 'bound-second')
    const third = generationPath(root, 'bound-third')
    for (const path of [first, second, third]) await writeSidecar(path)
    const memo = new WindowIndexMemo(2)
    const parse = vi.fn(async () => indexFixture())

    await memo.load(first, sourceIdentity(), parse)
    await memo.load(second, sourceIdentity(), parse)
    // Touch the first entry so the second becomes the eviction candidate.
    await memo.load(first, sourceIdentity(), parse)
    expect(parse).toHaveBeenCalledTimes(2)

    await memo.load(third, sourceIdentity(), parse)
    expect(memo.size).toBe(2)
    await memo.load(first, sourceIdentity(), parse)
    await memo.load(third, sourceIdentity(), parse)
    expect(parse).toHaveBeenCalledTimes(3)

    await memo.load(second, sourceIdentity(), parse)
    expect(parse).toHaveBeenCalledTimes(4)
    expect(memo.size).toBe(2)
  })

  it('releases retained parses and never retains again after disposal', async () => {
    const root = await tempRoot()
    const path = generationPath(root, 'dispose')
    await writeSidecar(path)
    const memo = new WindowIndexMemo()
    await memo.load(path, sourceIdentity(), async () => indexFixture())
    expect(memo.size).toBe(1)
    expect(memo.isDisposed).toBe(false)

    memo.dispose()
    expect(memo.isDisposed).toBe(true)
    expect(memo.size).toBe(0)

    const parse = vi.fn(async () => indexFixture())
    expect(await memo.load(path, sourceIdentity(), parse)).toBeDefined()
    expect(parse).toHaveBeenCalledTimes(1)
    expect(memo.size).toBe(0)

    await memo.set(path, sourceIdentity(), indexFixture())
    expect(memo.size).toBe(0)

    memo.dispose()
    expect(memo.size).toBe(0)
  })

  it('parses without retaining when disposal lands during the sidecar read', async () => {
    const root = await tempRoot()
    const path = generationPath(root, 'dispose-during-read')
    await writeSidecar(path)
    const memo = new WindowIndexMemo()
    const parse = vi.fn(async () => indexFixture())

    const pending = memo.load(path, sourceIdentity(), parse)
    memo.dispose()
    expect(await pending).toBeDefined()
    expect(parse).toHaveBeenCalledTimes(1)
    expect(memo.size).toBe(0)
  })

  it('does not retain a parse that settles after disposal', async () => {
    const root = await tempRoot()
    const path = generationPath(root, 'dispose-during-parse')
    await writeSidecar(path)
    const memo = new WindowIndexMemo()
    const gate = deferred()
    const parse = vi.fn(() => gate.promise)

    const pending = memo.load(path, sourceIdentity(), parse)
    await settle()
    expect(parse).toHaveBeenCalledTimes(1)
    memo.dispose()
    gate.settle(indexFixture())
    expect(await pending).toBeDefined()
    expect(memo.size).toBe(0)
  })

  it('does not retain a set that resolves after disposal', async () => {
    const root = await tempRoot()
    const path = generationPath(root, 'dispose-during-set')
    await writeSidecar(path)
    const memo = new WindowIndexMemo()

    const pending = memo.set(path, sourceIdentity(), indexFixture())
    memo.dispose()
    await pending
    expect(memo.size).toBe(0)
  })
})
