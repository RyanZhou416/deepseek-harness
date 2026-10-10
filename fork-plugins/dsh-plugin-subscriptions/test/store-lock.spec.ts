import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withStoreLock, type LockTiming } from '../src/auth/store-lock.js'

// Short enough to keep the suite quick, long enough to outlast a held lock's work.
const FAST: LockTiming = { retries: 400, minTimeoutMs: 2, maxTimeoutMs: 20, staleMs: 50 }

// The budget a caller gets when it only needs to observe the give-up path.
const IMPATIENT: LockTiming = { retries: 2, minTimeoutMs: 1, maxTimeoutMs: 2, staleMs: 50 }

async function scratch(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'lock-')), 'credentials.json')
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

test('a lock whose holder is gone is taken over', async () => {
  const path = await scratch()
  await mkdir(`${path}.lock`)
  const past = new Date(Date.now() - 60_000)
  await utimes(`${path}.lock`, past, past)
  let ran = false
  await withStoreLock(path, async () => { ran = true }, FAST)
  assert.equal(ran, true)
})

test('a live lock is waited out, and the work still runs', async () => {
  const path = await scratch()
  await mkdir(`${path}.lock`)
  await writeFile(`${path}.lock/holder`, 'held')
  let ran = false
  await withStoreLock(path, async () => { ran = true }, IMPATIENT)
  // Giving up is deliberate: a consumer must not fail a refresh because a lock was held.
  assert.equal(ran, true)
})
