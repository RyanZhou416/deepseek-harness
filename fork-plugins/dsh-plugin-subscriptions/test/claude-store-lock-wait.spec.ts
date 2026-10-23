import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withStoreLockWait, type LockTiming } from '../src/auth/store-lock.js'

// `retries: 0` states the property under test: the wait has no attempt budget, so a single
// refusal must not end it. The bounded primitives would give up on the first one.
const WAIT: LockTiming = { retries: 0, minTimeoutMs: 10, maxTimeoutMs: 20, staleMs: 60_000 }

// A delay a sleep that ignored the abort would still be inside when the promptness assertion
// runs, so answering the abort early is observable.
const UNABORTABLE_SLEEP_MS = 5_000

async function scratch(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'lock-wait-')), 'credentials.json')
}

/** A path whose parent is a regular file, so no lock directory can be created beside it. */
async function unusablePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lock-wait-'))
  const blocker = join(root, 'not-a-directory')
  await writeFile(blocker, 'a file, not a directory')
  return join(blocker, 'credentials.json')
}

/** A holder that is alive now: its lease is fresh, so it is never presumed dead. */
async function holdLive(lockPath: string, owner: string): Promise<void> {
  await mkdir(lockPath)
  await writeFile(join(lockPath, 'owner'), owner)
}

async function ownerOf(lockPath: string): Promise<string | undefined> {
  return readFile(join(lockPath, 'owner'), 'utf8').catch(() => undefined)
}

async function held(lockPath: string): Promise<boolean> {
  return stat(lockPath).then(() => true, () => false)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Fail instead of hanging when a wait never ends. */
async function within<T>(work: Promise<T>, ms = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`did not settle within ${ms}ms`)) }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The timers keeping this process alive; a leaked wait or renewal timer adds one. */
function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length
}

test('a live holder is waited out and the lock is owned after it releases', async () => {
  const path = await scratch()
  const lockPath = `${path}.lock`
  await holdLive(lockPath, 'live-holder')
  const controller = new AbortController()
  const timersBefore = activeTimers()
  const order: string[] = []
  let settled = false
  const pending = withStoreLockWait(path, async () => {
    order.push('run')
    assert.notEqual(await ownerOf(lockPath), 'live-holder', 'the work runs under a lock this caller owns')
    return 'value'
  }, WAIT, controller.signal)
  void pending.then(() => { settled = true }, () => { settled = true })
  await delay(50)
  assert.equal(settled, false, 'a live holder keeps the caller waiting; no elapsed attempt budget refuses it')
  assert.deepEqual(order, [], 'no work starts while another holder owns the lock')
  // The holder releases: the next attempt must take the free lock and run the work.
  await rm(lockPath, { recursive: true, force: true })
  const result = await within(pending)
  assert.equal(result.kind, 'owned', 'the waited-out lock is acquired')
  if (result.kind !== 'owned') assert.fail('expected ownership after the holder released')
  assert.equal(result.value, 'value')
  assert.deepEqual(order, ['run'], 'the work ran after the holder released, and only then')
  assert.equal(await held(lockPath), false, 'the caller released the lock it took')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'the wait removed its abort listener')
  assert.equal(activeTimers(), timersBefore, 'the wait left no timer behind')
})

test('aborting while waiting returns promptly with no lock and no work', async () => {
  const path = await scratch()
  const lockPath = `${path}.lock`
  await holdLive(lockPath, 'live-holder')
  const controller = new AbortController()
  let ran = false
  const pending = withStoreLockWait(
    path,
    async () => { ran = true; return 'value' },
    { retries: 0, minTimeoutMs: UNABORTABLE_SLEEP_MS, maxTimeoutMs: UNABORTABLE_SLEEP_MS, staleMs: 60_000 },
    controller.signal,
  )
  // Let the first attempt fail and the wait enter its backoff before cancelling.
  await delay(30)
  const abortedAt = Date.now()
  controller.abort()
  const result = await within(pending, 1_000)
  assert.deepEqual(result, { kind: 'aborted' }, 'the caller is told it stopped waiting')
  assert.ok(Date.now() - abortedAt < 1_000, 'the wait answered the abort instead of finishing its delay')
  assert.equal(ran, false, 'no work runs under the lock')
  assert.equal(await ownerOf(lockPath), 'live-holder', 'the live holder keeps its lock')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'the wait removed its abort listener')
})

test('a stale holder is taken over and replaced', async () => {
  const path = await scratch()
  const lockPath = `${path}.lock`
  await mkdir(lockPath)
  await writeFile(join(lockPath, 'owner'), 'abandoned-holder')
  const past = new Date(Date.now() - 60_000)
  await utimes(lockPath, past, past)
  let ownerWhileHeld: string | undefined
  const result = await within(withStoreLockWait(path, async () => {
    ownerWhileHeld = await ownerOf(lockPath)
    return 'value'
  }, { retries: 0, minTimeoutMs: 10, maxTimeoutMs: 20, staleMs: 1_000 }))
  assert.equal(result.kind, 'owned', 'the expired lease is taken over')
  assert.notEqual(ownerWhileHeld, undefined, 'the work ran while a lock was held')
  assert.notEqual(ownerWhileHeld, 'abandoned-holder', 'the dead holder was replaced, not waited out')
  assert.equal(await held(lockPath), false, 'the holder released it')
})

test('a fresh live holder is never removed, however many attempts pass', async () => {
  const path = await scratch()
  const lockPath = `${path}.lock`
  await holdLive(lockPath, 'live-holder')
  const controller = new AbortController()
  let settled = false
  const pending = withStoreLockWait(path, async () => 'value', WAIT, controller.signal)
  void pending.then(() => { settled = true }, () => { settled = true })
  await delay(80)
  assert.equal(settled, false, 'the caller keeps waiting')
  assert.equal(await ownerOf(lockPath), 'live-holder', 'waiting never removes a holder whose lease is current')
  controller.abort()
  assert.deepEqual(await within(pending), { kind: 'aborted' })
  assert.equal(await ownerOf(lockPath), 'live-holder', 'the cancellation left the live lock alone')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'the wait removed its abort listener')
})

test('a lock path that cannot be created is refused with a reason, not thrown', async () => {
  const path = await unusablePath()
  let ran = false
  const result = await within(withStoreLockWait(path, async () => { ran = true; return 'value' }, WAIT))
  assert.equal(result.kind, 'unavailable', 'a path failure is reported as an outcome')
  if (result.kind !== 'unavailable') assert.fail('expected the lock path to be unusable')
  assert.ok(result.reason.length > 0, 'the refusal names the failure')
  assert.equal(ran, false, 'no work runs when the lock path cannot be used')
})

test('a pre-aborted signal never attempts the lock path', async () => {
  // An attempt on this path reports `unavailable`, so `aborted` proves nothing was tried.
  const path = await unusablePath()
  const controller = new AbortController()
  controller.abort()
  let ran = false
  const result = await withStoreLockWait(path, async () => { ran = true; return 'value' }, WAIT, controller.signal)
  assert.deepEqual(result, { kind: 'aborted' })
  assert.equal(ran, false)
})

test('waiting for a live holder sleeps instead of spinning', async () => {
  const path = await scratch()
  const lockPath = `${path}.lock`
  await holdLive(lockPath, 'live-holder')
  const controller = new AbortController()
  const cpuBefore = process.cpuUsage()
  const pending = withStoreLockWait(path, async () => 'value', {
    retries: 0,
    minTimeoutMs: 40,
    maxTimeoutMs: 40,
    staleMs: 60_000,
  }, controller.signal)
  await delay(100)
  controller.abort()
  assert.deepEqual(await within(pending), { kind: 'aborted' })
  // A wait that spun for these 100 ms would spend about that long on the CPU; the margin is
  // half the wall time, which no amount of sleeping approaches.
  const used = process.cpuUsage(cpuBefore)
  assert.ok(used.user + used.system < 50_000, `the wait spent ${used.user + used.system}µs of CPU while asleep`)
})

test('an owned, aborted, and unusable lock path leave no lock directory or timer behind', async () => {
  const path = await scratch()
  const lockPath = `${path}.lock`

  const timersBeforeOwned = activeTimers()
  const owned = await within(withStoreLockWait(path, async () => 'value', WAIT))
  assert.deepEqual(owned, { kind: 'owned', value: 'value' })
  assert.equal(await held(lockPath), false, 'an owned wait released the lock directory')
  assert.equal(activeTimers(), timersBeforeOwned, 'an owned wait left no timer behind')

  await holdLive(lockPath, 'live-holder')
  const controller = new AbortController()
  const timersBeforeAbort = activeTimers()
  const pending = withStoreLockWait(path, async () => 'value', WAIT, controller.signal)
  await delay(30)
  controller.abort()
  assert.deepEqual(await within(pending), { kind: 'aborted' })
  assert.equal(await ownerOf(lockPath), 'live-holder', 'the aborted wait created no lock of its own')
  assert.equal(activeTimers(), timersBeforeAbort, 'an aborted wait left no timer behind')

  const unusable = await unusablePath()
  const timersBeforeUnavailable = activeTimers()
  assert.equal((await within(withStoreLockWait(unusable, async () => 'value', WAIT))).kind, 'unavailable')
  assert.equal(activeTimers(), timersBeforeUnavailable, 'an unusable path left no timer behind')
})

test('work that throws still releases the lock and its renewal', async () => {
  const path = await scratch()
  const lockPath = `${path}.lock`
  const timersBefore = activeTimers()
  await assert.rejects(within(withStoreLockWait(path, async () => { throw new Error('work failed') }, WAIT)), /work failed/)
  assert.equal(await held(lockPath), false, 'the lock was released after the work failed')
  assert.equal(activeTimers(), timersBefore, 'the renewal timer was stopped')
})
