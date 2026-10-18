/**
 * Direct index builds over hand-assembled compressed multi-frame generations:
 * the synchronous decoder pass must record exactly the segments and dense row
 * counts an independent one-shot per-frame walk produces, keep the exact header
 * validation, refuse non-window-unit frames, rebuild after an append, and
 * propagate cancellation without publishing a sidecar.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { eventLines, toHeaderLine } from '../src/format.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../src/zstd.ts'
import {
  loadWindowIndex,
  readWindowIndex,
  readWindowIndexSource,
  rebuildWindowIndex,
  windowIndexPath,
  type JsonlWindowIndexFrame,
} from '../src/window-index.ts'
import { readJsonlIndexedWindow } from '../src/window.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

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
  if (failures.length > 0) throw new AggregateError(failures, 'window index build fixture cleanup failed')
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-index-build-'))
  roots.push(root)
  return root
}

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

/** One independently decodable, checksummed frame per JSONL payload. */
async function encodeFrames(payloads: readonly string[]): Promise<Buffer> {
  const frames = await Promise.all(payloads.map(payload => compressZstdFrame(payload)))
  return Buffer.concat(frames)
}

/** Write a compressed generation whose frames are exactly `payloads`, in order. */
async function writeFixture(root: string, name: string, payloads: readonly string[]): Promise<{ path: string; bytes: Buffer }> {
  const path = join(root, `${name}.jsonl.zstd`)
  await writeFile(path, await encodeFrames(payloads))
  return { path, bytes: await readFile(path) }
}

/** Header line and parsed header value for one unseeded current generation. */
function headerOf(id: string): { headerLine: string; headerValue: Record<string, unknown> } {
  const headerLine = JSON.stringify(toHeaderLine(meta(id, '/work')))
  return { headerLine, headerValue: JSON.parse(headerLine) as Record<string, unknown> }
}

/** Dense event frames for one log, split at `batchSizes`. */
function eventFrames(events: readonly SessionEvent[], batchSizes: readonly number[]): string[] {
  const payloads: string[] = []
  let start = 0
  for (const size of batchSizes) {
    payloads.push(`${eventLines(events.slice(start, start + size))}\n`)
    start += size
  }
  return payloads
}

/**
 * The index the superseded build produced: one awaited one-shot decompression
 * per scanned frame, rows counted per physical JSONL record.
 */
async function oneShotWalk(bytes: Buffer): Promise<readonly JsonlWindowIndexFrame[]> {
  const scan = scanZstdFrames(bytes)
  expect(scan.tornStart).toBeUndefined()
  const frames: JsonlWindowIndexFrame[] = []
  let rows = 0
  for (const [position, range] of scan.frames.entries()) {
    const plaintext = await decompressZstdFrame(bytes.subarray(range.start, range.end))
    let events = 0
    if (position > 0) {
      expect(plaintext.length).toBeGreaterThan(0)
      expect(plaintext.at(-1)).toBe(0x0A)
      for (let lineStart = 0; lineStart < plaintext.length;) {
        const newline = plaintext.indexOf(0x0A, lineStart)
        if (newline === -1) throw new Error('independent walk found a record without a line end')
        events += 1
        lineStart = newline + 1
      }
    }
    frames.push({ offset: range.start, length: range.end - range.start, firstRow: rows, firstSeq: rows, events })
    rows += events
  }
  return frames
}

describe('JSONL window index build: synchronous multi-frame pass', () => {
  it('records exactly the one-shot per-frame walk over a compressed multi-frame fixture', async () => {
    const root = await tempRoot()
    const { headerLine, headerValue } = headerOf('build-direct')
    const events = turnLog(12)
    const { path, bytes } = await writeFixture(root, 'direct', [`${headerLine}\n`, ...eventFrames(events, [3, 5, 4])])

    const index = await rebuildWindowIndex(path, 'zstd', headerValue, headerLine)
    expect(index).toBeDefined()
    expect(index?.frames).toStrictEqual(await oneShotWalk(bytes))
    expect(index?.frames).toHaveLength(4)
    expect(index?.frames[0]).toStrictEqual({ offset: 0, length: index?.frames[0]?.length, firstRow: 0, firstSeq: 0, events: 0 })
    expect(index?.frames.reduce((total, frame) => total + frame.events, 0)).toBe(events.length)
    expect(index?.inheritedEventCount).toBe(0)

    const source = await stat(path, { bigint: true })
    expect(index?.source).toStrictEqual({ sizeBytes: Number(source.size), mtimeMs: Number(source.mtimeMs) })
    expect(await readWindowIndex(path, index?.source ?? { sizeBytes: 0, mtimeMs: 0 })).toStrictEqual(index)
    const loaded = await loadWindowIndex(path, 'zstd', headerValue, headerLine)
    expect(loaded).toStrictEqual({ index, cached: true })

    // The rebuilt index serves exactly the fixture rows it claims to cover.
    const window = await readJsonlIndexedWindow(path, 'zstd', headerValue, headerLine, 10, 4)
    expect(window?.events).toStrictEqual(events.slice(6, 10))
    expect(window?.hasMore).toBe(true)
    expect(window?.inheritedEventCount).toBe(0)
  })

  it('records only the header segment for a header-only generation', async () => {
    const root = await tempRoot()
    const { headerLine, headerValue } = headerOf('build-header-only')
    const { path, bytes } = await writeFixture(root, 'header-only', [`${headerLine}\n`])

    const index = await rebuildWindowIndex(path, 'zstd', headerValue, headerLine)
    expect(index?.frames).toStrictEqual(await oneShotWalk(bytes))
    expect(index?.frames).toHaveLength(1)
    expect(index?.frames[0]?.events).toBe(0)
    expect(index?.inheritedEventCount).toBe(0)
    expect(await readJsonlIndexedWindow(path, 'zstd', headerValue, headerLine, 0, 10))
      .toStrictEqual({ events: [], hasMore: false, inheritedEventCount: 0 })
  })

  it('keeps the exact header record validation', async () => {
    const root = await tempRoot()
    const { headerLine, headerValue } = headerOf('build-header')

    const empty = await writeFixture(root, 'empty-header', [''])
    expect(await rebuildWindowIndex(empty.path, 'zstd', headerValue, headerLine)).toBeUndefined()

    const extra = await writeFixture(root, 'extra-newline', [`${headerLine}\n\n`])
    expect(await rebuildWindowIndex(extra.path, 'zstd', headerValue, headerLine)).toBeUndefined()

    const valid = await writeFixture(root, 'wrong-header', [`${headerLine}\n`])
    expect(await rebuildWindowIndex(valid.path, 'zstd', headerValue, `${headerLine} `)).toBeUndefined()
    // A refused build publishes no sidecar, so the window keeps its fallback.
    for (const path of [empty.path, extra.path, valid.path]) {
      await expect(stat(windowIndexPath(path))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('refuses seeded and unvalidated headers instead of recording a zero cut', async () => {
    const root = await tempRoot()
    const { headerLine, headerValue } = headerOf('build-header-guard')
    const { path } = await writeFixture(root, 'header-guard', [
      `${headerLine}\n`,
      ...eventFrames(turnLog(4), [2, 2]),
    ])

    // The count-only build cannot establish a seeded generation's inherited cut,
    // so it declines rather than publishing a sidecar with a zero cut.
    expect(await rebuildWindowIndex(path, 'zstd', { ...headerValue, isSeeded: true }, headerLine)).toBeUndefined()
    await expect(stat(windowIndexPath(path))).rejects.toMatchObject({ code: 'ENOENT' })
    // A header the released codec rejects is not an indexable generation.
    expect(await rebuildWindowIndex(path, 'zstd', {}, headerLine)).toBeUndefined()
    await expect(stat(windowIndexPath(path))).rejects.toMatchObject({ code: 'ENOENT' })

    // The same bytes with their genuine unseeded header still build.
    expect(await rebuildWindowIndex(path, 'zstd', headerValue, headerLine)).toBeDefined()
  })

  it('refuses empty and non-record-aligned event frames', async () => {
    const root = await tempRoot()
    const { headerLine, headerValue } = headerOf('build-frames')
    const events = turnLog(6)

    const emptyFrame = await writeFixture(root, 'empty-frame', [`${headerLine}\n`, '', ...eventFrames(events, [3, 3])])
    expect(await rebuildWindowIndex(emptyFrame.path, 'zstd', headerValue, headerLine)).toBeUndefined()

    const partial = await writeFixture(root, 'partial-record', [`${headerLine}\n`, eventLines(events.slice(0, 3))])
    expect(await rebuildWindowIndex(partial.path, 'zstd', headerValue, headerLine)).toBeUndefined()

    for (const path of [emptyFrame.path, partial.path]) {
      await expect(stat(windowIndexPath(path))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('refuses a torn final frame', async () => {
    const root = await tempRoot()
    const { headerLine, headerValue } = headerOf('build-torn')
    const { path, bytes } = await writeFixture(root, 'torn', [`${headerLine}\n`, ...eventFrames(turnLog(6), [3, 3])])
    await writeFile(path, bytes.subarray(0, bytes.length - 1))

    expect(await rebuildWindowIndex(path, 'zstd', headerValue, headerLine)).toBeUndefined()
    await expect(stat(windowIndexPath(path))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rebuilds over the complete generation after an append', async () => {
    const root = await tempRoot()
    const { headerLine, headerValue } = headerOf('build-append')
    const first = turnLog(12)
    const { path } = await writeFixture(root, 'append', [`${headerLine}\n`, ...eventFrames(first, [3, 5, 4])])
    const original = await rebuildWindowIndex(path, 'zstd', headerValue, headerLine)
    expect(original).toBeDefined()

    const appended = turnLog(6, first.length)
    await appendFile(path, await encodeFrames(eventFrames(appended, [2, 4])))
    const source = await stat(path, { bigint: true })
    const current = await readWindowIndexSource(path)
    expect(current).toStrictEqual({ sizeBytes: Number(source.size), mtimeMs: Number(source.mtimeMs) })
    // The previous sidecar still describes the pre-append revision.
    expect(await readWindowIndex(path, current ?? { sizeBytes: 0, mtimeMs: 0 })).toBeUndefined()

    const loaded = await loadWindowIndex(path, 'zstd', headerValue, headerLine)
    expect(loaded?.cached).toBe(false)
    const rebuilt = loaded?.index
    expect(rebuilt?.frames).toStrictEqual(await oneShotWalk(await readFile(path)))
    expect(rebuilt?.frames).toHaveLength(6)
    expect(rebuilt?.frames.reduce((total, frame) => total + frame.events, 0)).toBe(first.length + appended.length)
    expect(rebuilt?.source).toStrictEqual({ sizeBytes: Number(source.size), mtimeMs: Number(source.mtimeMs) })
    expect(await readWindowIndex(path, current ?? { sizeBytes: 0, mtimeMs: 0 })).toStrictEqual(rebuilt)

    const all = [...first, ...appended]
    const window = await readJsonlIndexedWindow(path, 'zstd', headerValue, headerLine, 12, 5)
    expect(window?.events).toStrictEqual(all.slice(7, 12))
  })

  it('propagates cancellation without publishing a sidecar', async () => {
    const root = await tempRoot()
    const { headerLine, headerValue } = headerOf('build-aborted')
    const { path } = await writeFixture(root, 'aborted', [`${headerLine}\n`, ...eventFrames(turnLog(12), [3, 5, 4])])
    const controller = new AbortController()
    controller.abort()

    await expect(rebuildWindowIndex(path, 'zstd', headerValue, headerLine, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    await expect(loadWindowIndex(path, 'zstd', headerValue, headerLine, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    await expect(stat(windowIndexPath(path))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
