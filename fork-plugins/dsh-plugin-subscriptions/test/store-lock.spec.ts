import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withStoreLock, type LockTiming } from '../src/auth/store-lock.js'

// Short enough to keep the suite quick, long enough to outlast a held lock's work.
const FAST: LockTiming = { retries: 400, minTimeoutMs: 2, maxTimeoutMs: 20, staleMs: 50 }

// The budget a caller gets when it only needs to observe the give-up path.
const IMPATIENT: LockTiming = { retries: 2, minTimeoutMs: 1, maxTimeoutMs: 2, staleMs: 50 }

// A bound a held lock can outlive inside one test, while still leaving the renewal period
// (half the bound) room to run several times.
const LEASE: LockTiming = { retries: 400, minTimeoutMs: 5, maxTimeoutMs: 25, staleMs: 500 }

async function scratch(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'lock-')), 'credentials.json')
}

/** The token the lock directory currently names, or undefined when it is unheld. */
async function ownerOf(lockPath: string): Promise<string | undefined> {
  return readFile(join(lockPath, 'owner'), 'utf8').catch(() => undefined)
}

/** Whether the lock directory exists. */
async function held(lockPath: string): Promise<boolean> {
  return stat(lockPath).then(() => true, () => false)
}

test('two holders of one resource never overlap', async () => {
  const path = await scratch()
  // Which holder wins the create is unspecified, so the invariant is the depth, not an order.
  let depth = 0
  let peak = 0
  let runs = 0
  const hold = async (): Promise<void> => {
    depth += 1
    peak = Math.max(peak, depth)
    runs += 1
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    depth -= 1
  }
  await Promise.all([
    withStoreLock(path, hold, FAST),
    withStoreLock(path, hold, FAST),
  ])
  assert.equal(runs, 2, 'both holders ran')
  assert.equal(peak, 1, 'no two holders were inside the lock at once')
})

test('a lock whose holder stopped renewing is taken over', async () => {
  const path = await scratch()
  const lockPath = `${path}.lock`
  await mkdir(lockPath)
  await writeFile(join(lockPath, 'owner'), 'abandoned-holder')
  const past = new Date(Date.now() - 60_000)
  await utimes(lockPath, past, past)
  // The token observed under the lock tells takeover from giving up: a waiter that cannot
  // take the dead lock over runs its work without owning one and still sees the old token.
  let ownerWhileHeld: string | undefined
  let ran = false
  await withStoreLock(path, async () => {
    ran = true
    ownerWhileHeld = await ownerOf(lockPath)
  }, FAST)
  assert.equal(ran, true)
  assert.notEqual(ownerWhileHeld, undefined, 'the work ran while a lock was held')
  assert.notEqual(ownerWhileHeld, 'abandoned-holder', 'the dead lock was replaced, not waited out')
  assert.equal(await held(lockPath), false, 'the holder released it')
})

test('a live lock is waited out, and the waiter leaves it alone', async () => {
  const path = await scratch()
  const lockPath = `${path}.lock`
  await mkdir(lockPath)
  await writeFile(join(lockPath, 'owner'), 'live-holder')
  let ran = false
  await withStoreLock(path, async () => { ran = true }, IMPATIENT)
  // Giving up is deliberate: a consumer must not fail a refresh because a lock was held.
  assert.equal(ran, true)
  assert.equal(await ownerOf(lockPath), 'live-holder', 'a lock that was never stale is not removed')
})

test('a holder whose work outlasts the staleness bound keeps its lock', async () => {
  const path = await scratch()
  let depth = 0
  let peak = 0
  let runs = 0
  const hold = async (): Promise<void> => {
    depth += 1
    peak = Math.max(peak, depth)
    runs += 1
    await new Promise((resolve) => { setTimeout(resolve, LEASE.staleMs + 200) })
    depth -= 1
  }
  await Promise.all([
    withStoreLock(path, hold, LEASE),
    withStoreLock(path, hold, LEASE),
  ])
  assert.equal(runs, 2, 'both holders ran')
  // The lease is renewed while the work runs, so a waiter never sees it expire underneath it.
  assert.equal(peak, 1, 'no two holders were inside the lock at once')
})
