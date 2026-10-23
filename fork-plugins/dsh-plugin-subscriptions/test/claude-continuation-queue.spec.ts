/**
 * The continuation-state queue: FIFO admission, cancellation, and disposal.
 *
 * These cases exist because the queue is the document's only in-process owner: a caller that
 * arrives while an operation holds the document must wait for its turn instead of being refused
 * because a configured duration passed, and the text it reads must be the one its predecessor
 * committed rather than a document a pending write may still replace. The cancellation cases pin
 * the two different obligations: a caller stopped while queued starts no file work at all, while a
 * caller stopped after its operation started is answered only once that operation really settled —
 * and that settlement, not the cancellation, admits the next caller.
 *
 * Every wait in these cases is driven by a deferred promise rather than a sleep, so a case observes
 * the queue while the work is genuinely in flight. The injected wait host schedules no timer; its
 * `schedule` throws, which proves the queue never bounds a wait with one, and it counts every abort
 * subscription so a case can assert each one was removed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContinuationIo, continuationBudget, nodeContinuationFiles } from '../src/providers/claude-continuation-io.js'
import type { ContinuationFiles, ContinuationWaitHost } from '../src/providers/claude-continuation-io.js'
import { ClaudeIdentityGeneration } from '../src/providers/claude-identity-generation.js'
import { claudeAccountRef } from '../src/providers/claude-salt-store.js'
import type { ClaudeAccountRef } from '../src/providers/claude-salt-store.js'

/** How long one operation may wait for the owned lock in these cases. */
const LOCK_TIMEOUT_MS = 2_000

/** The configured per-operation accounting; it never ends a wait. */
const DEADLINE_MS = 2_000

/** The account the transition cases name. */
const ACCOUNT: ClaudeAccountRef = claudeAccountRef('queue-salt', 'acct@example.invalid')

/** One private root the caller removes when the case settles. */
function privateRoot(): string {
  return mkdtempSync(join(tmpdir(), 'claude-continuation-queue-'))
}

/** A deferred promise, so a case can hold real work at a deterministic point. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, resolve: release }
}

/** How many file operations one case's port observed. */
interface FileCalls {
  reads: number
  writes: number
  directories: number
}

/**
 * The real filesystem behind counters, optionally signalling and holding each write.
 *
 * Holding the actual write is what makes "the caller stopped while its operation was genuinely
 * pending" a real state rather than a simulated one, and it lets a case prove the write was not
 * cancelled when the caller stopped waiting.
 * @param options - what the case observes and where it holds a write.
 * @returns the port and the operations it has seen.
 */
function countingFiles(options: {
  readonly hold?: Promise<void>
  readonly onWrite?: () => void
} = {}): { files: ContinuationFiles; calls: FileCalls } {
  const calls: FileCalls = { reads: 0, writes: 0, directories: 0 }
  const files: ContinuationFiles = {
    ensureDirectory: async (directory) => {
      calls.directories += 1
      await nodeContinuationFiles.ensureDirectory(directory)
    },
    read: async (path) => {
      calls.reads += 1
      return await nodeContinuationFiles.read(path)
    },
    writeAtomic: async (path, text) => {
      calls.writes += 1
      if (options.onWrite !== undefined) options.onWrite()
      if (options.hold !== undefined) await options.hold
      await nodeContinuationFiles.writeAtomic(path, text)
    },
  }
  return { files, calls }
}

/** What one case observed of the wait resources it handed out. */
interface WaitRecord {
  scheduled: number
  subscribed: number
  removed: number
}

/**
 * A wait host that refuses to schedule and counts every abort subscription and removal.
 *
 * A thrown `schedule` is the proof that no wait here is bounded by a timer, and the subscription
 * counters prove every listener a wait installed was removed on its outcome.
 * @returns the host and what it observed.
 */
function instrumentedWaits(): { host: ContinuationWaitHost; record: WaitRecord } {
  const record: WaitRecord = { scheduled: 0, subscribed: 0, removed: 0 }
  const host: ContinuationWaitHost = {
    now: () => Date.now(),
    schedule: () => {
      record.scheduled += 1
      throw new Error('the continuation queue must not schedule a timer')
    },
    onAbort: (signal, fire) => {
      record.subscribed += 1
      signal.addEventListener('abort', fire, { once: true })
      return () => {
        record.removed += 1
        signal.removeEventListener('abort', fire)
      }
    },
  }
  return { host, record }
}

/** A document owner over one private path, with the timing a real composition resolves. */
function ioAt(
  path: string,
  overrides: { readonly files?: ContinuationFiles; readonly waits?: ContinuationWaitHost } = {},
): ContinuationIo {
  return new ContinuationIo({
    path,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    deadlineMs: DEADLINE_MS,
    ...overrides.files === undefined ? {} : { files: overrides.files },
    ...overrides.waits === undefined ? {} : { waits: overrides.waits },
  })
}

/** Let every pending microtask and one macrotask boundary run, without a timing assumption. */
async function settleMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

test('queued updates are admitted in arrival order and each reads the committed text', async (t) => {
  const root = privateRoot()
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const path = join(root, 'document.json')
  const hold = deferred()
  const writing = deferred()
  const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => { writing.resolve() } })
  const { host, record } = instrumentedWaits()
  const io = ioAt(path, { files, waits: host })
  const order: number[] = []
  const seen: (string | undefined)[] = []
  const first = io.update((current) => {
    order.push(1)
    seen.push(current)
    return 'a'
  })
  await writing.promise
  // Arrival order is synchronous: both later callers are queued before either can start any file
  // work, so the port still shows only the first caller's read and write.
  const second = io.update((current) => {
    order.push(2)
    seen.push(current)
    return `${current ?? ''}+b`
  })
  const third = io.update((current) => {
    order.push(3)
    seen.push(current)
    return `${current ?? ''}+c`
  })
  assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })
  hold.resolve()
  const outcomes = await Promise.all([first, second, third])
  assert.deepEqual(order, [1, 2, 3])
  assert.deepEqual(seen, [undefined, 'a', 'a+b'])
  assert.deepEqual(outcomes, [
    { kind: 'applied', text: 'a', written: true },
    { kind: 'applied', text: 'a+b', written: true },
    { kind: 'applied', text: 'a+b+c', written: true },
  ])
  assert.equal(readFileSync(path, 'utf8'), 'a+b+c')
  assert.deepEqual(calls, { reads: 3, writes: 3, directories: 3 })
  assert.equal(record.scheduled, 0)
  assert.equal(record.subscribed, record.removed)
})

test('eight callers queued behind one barrier complete in arrival order', async (t) => {
  const root = privateRoot()
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const path = join(root, 'document.json')
  const hold = deferred()
  const writing = deferred()
  const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => { writing.resolve() } })
  const { host, record } = instrumentedWaits()
  const io = ioAt(path, { files, waits: host })
  const arrival = Array.from({ length: 8 }, (_, index) => index + 1)
  const order: number[] = []
  const pending = arrival.map((index) => io.update((current) => {
    order.push(index)
    return index === 1 ? 'x' : `${current ?? ''}${String(index)}`
  }))
  await writing.promise
  assert.equal(calls.writes, 1)
  hold.resolve()
  await Promise.all(pending)
  assert.deepEqual(order, arrival)
  assert.equal(readFileSync(path, 'utf8'), 'x2345678')
  assert.equal(calls.writes, 8)
  assert.equal(record.scheduled, 0)
  assert.equal(record.subscribed, record.removed)
})

test('an elapsed budget without an aborted signal runs and commits', async (t) => {
  const root = privateRoot()
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const path = join(root, 'document.json')
  const { files, calls } = countingFiles()
  const { host, record } = instrumentedWaits()
  const io = ioAt(path, { files, waits: host })
  // The budget instant is long past and no caller is cancelled: the operation still runs.
  const expired = await io.update(() => 'a', { expiresAt: Date.now() - 60_000 })
  assert.deepEqual(expired, { kind: 'applied', text: 'a', written: true })
  // A signal that has not aborted does not turn the expired instant into a refusal either.
  const controller = new AbortController()
  const withSignal = await io.update(current => `${current ?? ''}b`, continuationBudget(0, controller.signal))
  assert.deepEqual(withSignal, { kind: 'applied', text: 'ab', written: true })
  assert.equal(readFileSync(path, 'utf8'), 'ab')
  assert.equal(calls.writes, 2)
  assert.equal(record.scheduled, 0)
  assert.equal(record.subscribed, record.removed)
})

test('a caller cancelled while queued performs no file work and the held write still commits', async (t) => {
  const root = privateRoot()
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const path = join(root, 'document.json')
  const hold = deferred()
  const writing = deferred()
  const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => { writing.resolve() } })
  const { host, record } = instrumentedWaits()
  const io = ioAt(path, { files, waits: host })
  const seen: (string | undefined)[] = []
  const first = io.update((current) => {
    seen.push(current)
    return 'a'
  })
  await writing.promise
  const controller = new AbortController()
  const cancelled = io.update(() => 'never', continuationBudget(DEADLINE_MS, controller.signal))
  controller.abort()
  const refusal = await cancelled
  assert.equal(refusal.kind, 'unavailable')
  // The cancelled caller started nothing: no additional directory, read, write or lock.
  assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })
  const observed = seen.length
  // A caller arriving afterwards takes the cancelled caller's place in the queue.
  const later = io.update((current) => {
    seen.push(current)
    return `${current ?? ''}+later`
  })
  assert.equal(seen.length, observed)
  hold.resolve()
  assert.deepEqual(await first, { kind: 'applied', text: 'a', written: true })
  assert.deepEqual(await later, { kind: 'applied', text: 'a+later', written: true })
  assert.deepEqual(seen, [undefined, 'a'])
  assert.equal(readFileSync(path, 'utf8'), 'a+later')
  assert.equal(record.scheduled, 0)
  assert.equal(record.subscribed, record.removed)
})

test('a caller cancelled after its operation started waits for real settlement', async (t) => {
  const root = privateRoot()
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const path = join(root, 'document.json')
  const hold = deferred()
  const writing = deferred()
  const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => { writing.resolve() } })
  const { host, record } = instrumentedWaits()
  const io = ioAt(path, { files, waits: host })
  const seen: (string | undefined)[] = []
  const controller = new AbortController()
  const started = io.update(current => {
    seen.push(current)
    return 'a'
  }, continuationBudget(DEADLINE_MS, controller.signal))
  await writing.promise
  const queued = io.update(current => {
    seen.push(current)
    return `${current ?? ''}+b`
  })
  controller.abort()
  let settled = false
  const answered = started.finally(() => { settled = true })
  await settleMicrotasks()
  // The started write is owned until it really settles; the queued caller must not start before.
  assert.equal(settled, false)
  assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })
  hold.resolve()
  const refusal = await answered
  assert.equal(refusal.kind, 'unavailable')
  assert.match(refusal.kind === 'unavailable' ? refusal.reason : '', /stopped waiting/)
  // The write committed, and the next caller reads exactly the settled text.
  assert.equal(readFileSync(path, 'utf8'), 'a')
  assert.deepEqual(await queued, { kind: 'applied', text: 'a+b', written: true })
  assert.deepEqual(seen, [undefined, 'a'])
  assert.equal(record.scheduled, 0)
  assert.equal(record.subscribed, record.removed)
})

test('close refuses queued callers without file work and waits for the running write', async (t) => {
  const root = privateRoot()
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const path = join(root, 'document.json')
  const hold = deferred()
  const writing = deferred()
  const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => { writing.resolve() } })
  const { host, record } = instrumentedWaits()
  const io = ioAt(path, { files, waits: host })
  const running = io.update(() => 'a')
  await writing.promise
  const queued = io.update(() => 'b')
  let closedSettled = false
  const closing = io.close().then(() => { closedSettled = true })
  const refused = await queued
  assert.equal(refused.kind, 'unavailable')
  assert.match(refused.kind === 'unavailable' ? refused.reason : '', /disposed/)
  assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })
  await settleMicrotasks()
  assert.equal(closedSettled, false)
  hold.resolve()
  assert.deepEqual(await running, { kind: 'applied', text: 'a', written: true })
  await closing
  assert.equal(closedSettled, true)
  // New admissions are refused, and closing twice is harmless.
  const late = await io.update(() => 'c')
  assert.equal(late.kind, 'unavailable')
  assert.match(late.kind === 'unavailable' ? late.reason : '', /disposed/)
  await io.close()
  assert.equal(readFileSync(path, 'utf8'), 'a')
  assert.equal(record.scheduled, 0)
  assert.equal(record.subscribed, record.removed)
})

test('a cancelled place in the queue does not let a later caller pass unfinished work', async (t) => {
  const root = privateRoot()
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const path = join(root, 'document.json')
  const directoryHold = deferred()
  const directoryStarted = deferred()
  const calls: FileCalls = { reads: 0, writes: 0, directories: 0 }
  const files: ContinuationFiles = {
    ensureDirectory: async (directory) => {
      calls.directories += 1
      // The first caller is held before its lock acquisition: its own read-modify-write has not
      // started, so anything admitted after it must still wait for it rather than barging.
      if (calls.directories === 1) {
        directoryStarted.resolve()
        await directoryHold.promise
      }
      await nodeContinuationFiles.ensureDirectory(directory)
    },
    read: async (documentPath) => {
      calls.reads += 1
      return await nodeContinuationFiles.read(documentPath)
    },
    writeAtomic: async (documentPath, text) => {
      calls.writes += 1
      await nodeContinuationFiles.writeAtomic(documentPath, text)
    },
  }
  const { host, record } = instrumentedWaits()
  const io = ioAt(path, { files, waits: host })
  const first = io.update(() => 'a')
  await directoryStarted.promise
  // The middle caller stops while queued; its place is abandoned, not settled work.
  const controller = new AbortController()
  const cancelled = io.update(() => 'never', continuationBudget(DEADLINE_MS, controller.signal))
  controller.abort()
  const refusal = await cancelled
  assert.equal(refusal.kind, 'unavailable')
  const seen: (string | undefined)[] = []
  const later = io.update((current) => {
    seen.push(current)
    return `${current ?? ''}c`
  })
  // The later caller must not even create the directory while the first caller's operation is
  // unsettled, and its change must read the text the first caller commits.
  await settleMicrotasks()
  assert.deepEqual(calls, { reads: 0, writes: 0, directories: 1 })
  assert.deepEqual(seen, [])
  directoryHold.resolve()
  assert.deepEqual(await first, { kind: 'applied', text: 'a', written: true })
  assert.deepEqual(await later, { kind: 'applied', text: 'ac', written: true })
  assert.deepEqual(seen, ['a'])
  assert.equal(readFileSync(path, 'utf8'), 'ac')
  assert.equal(record.scheduled, 0)
  assert.equal(record.subscribed, record.removed)
})

test('close cancels a lock acquisition another holder never releases', async (t) => {
  const root = privateRoot()
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const path = join(root, 'document.json')
  const lockPath = `${path}.lock`
  mkdirSync(lockPath)
  writeFileSync(join(lockPath, 'owner'), 'another-process')
  const { host, record } = instrumentedWaits()
  const io = ioAt(path, { waits: host })
  const waiting = io.update(() => 'a')
  // The caller is now waiting on the other holder's live lock; disposal must end that wait instead
  // of leaving teardown to wait for a holder that never releases.
  await settleMicrotasks()
  await io.close()
  const refusal = await waiting
  assert.equal(refusal.kind, 'unavailable')
  assert.match(refusal.kind === 'unavailable' ? refusal.reason : '', /disposed/)
  // The lock belongs to the other holder and was neither taken over nor removed.
  assert.equal(readFileSync(join(lockPath, 'owner'), 'utf8'), 'another-process')
  assert.equal(existsSync(path), false)
  assert.equal(record.scheduled, 0)
  assert.equal(record.subscribed, record.removed)
})

test('a pre-aborted caller starts no work', async (t) => {
  const root = privateRoot()
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const path = join(root, 'document.json')
  const { files, calls } = countingFiles()
  const { host, record } = instrumentedWaits()
  const io = ioAt(path, { files, waits: host })
  const controller = new AbortController()
  controller.abort()
  const refusal = await io.update(() => 'a', continuationBudget(DEADLINE_MS, controller.signal))
  assert.equal(refusal.kind, 'unavailable')
  assert.match(refusal.kind === 'unavailable' ? refusal.reason : '', /before the continuation state was touched/)
  assert.deepEqual(calls, { reads: 0, writes: 0, directories: 0 })
  assert.equal(existsSync(root), true)
  assert.equal(existsSync(path), false)
  assert.equal(record.scheduled, 0)
})

test('a change that writes nothing leaves the document and admits the next caller', async (t) => {
  const root = privateRoot()
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const path = join(root, 'document.json')
  const { files, calls } = countingFiles()
  const { host, record } = instrumentedWaits()
  const io = ioAt(path, { files, waits: host })
  assert.deepEqual(await io.update(() => undefined), { kind: 'applied', text: '', written: false })
  assert.equal(existsSync(path), false)
  assert.deepEqual(await io.update(() => 'a'), { kind: 'applied', text: 'a', written: true })
  // Returning the text that already stands is a read, not a second write.
  assert.deepEqual(await io.update(current => current), { kind: 'applied', text: 'a', written: false })
  const seen: (string | undefined)[] = []
  assert.deepEqual(await io.update((current) => {
    seen.push(current)
    return `${current ?? ''}+b`
  }), { kind: 'applied', text: 'a+b', written: true })
  assert.deepEqual(seen, ['a'])
  assert.deepEqual(calls, { reads: 4, writes: 2, directories: 4 })
  assert.equal(readFileSync(path, 'utf8'), 'a+b')
  assert.equal(record.scheduled, 0)
  assert.equal(record.subscribed, record.removed)
})

test('a transition wait is unbounded and ends on settlement, abort, or disposal', async (t) => {
  const root = privateRoot()
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const path = join(root, 'identity-generation.json')
  const { host, record } = instrumentedWaits()
  const generation = new ClaudeIdentityGeneration({
    accountRef: ACCOUNT,
    path,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    deadlineMs: DEADLINE_MS,
    waits: host,
  })
  const baseline = await generation.initialize()
  assert.deepEqual(baseline, { kind: 'advanced', generation: 0 })

  // A wait with an already-expired instant is not refused by time; it settles with the transition.
  const firstHold = deferred()
  const first = generation.changed('login', async () => { await firstHold.promise })
  assert.equal(first.closed, true)
  const waiting = generation.waitSettled(continuationBudget(0))
  let settled = false
  const observed = waiting.finally(() => { settled = true })
  await settleMicrotasks()
  assert.equal(settled, false)
  firstHold.resolve()
  assert.deepEqual(await observed, { kind: 'settled', generation: 1 })
  await first.result

  // The caller's own cancellation ends the wait while the transition keeps running.
  const secondHold = deferred()
  const second = generation.changed('login', async () => { await secondHold.promise })
  const controller = new AbortController()
  const aborted = generation.waitSettled(continuationBudget(0, controller.signal))
  controller.abort()
  assert.deepEqual(await aborted, { kind: 'aborted' })
  secondHold.resolve()
  await second.result

  // Disposal wakes a waiting request instead of letting it wait for the transition being torn down.
  const thirdHold = deferred()
  const third = generation.changed('login', async () => { await thirdHold.promise })
  const waitingAgain = generation.waitSettled(continuationBudget(0))
  let closing = false
  const closingPromise = generation.close().then(() => { closing = true })
  const disposed = await waitingAgain
  assert.equal(disposed.kind, 'failed')
  assert.match(disposed.kind === 'failed' ? disposed.reason : '', /disposed/)
  await settleMicrotasks()
  assert.equal(closing, false)
  thirdHold.resolve()
  await third.result
  await closingPromise
  assert.equal(record.scheduled, 0)
  assert.equal(record.subscribed, record.removed)
})
