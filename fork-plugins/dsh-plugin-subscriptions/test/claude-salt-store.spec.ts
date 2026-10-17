/**
 * The continuation salt: one durable account-naming material per installation.
 *
 * The cases exist because the reference is what a later request compares a stored row against. A
 * salt that was re-created, substituted or read from a damaged document must not produce a
 * reference that quietly matches another account's rows, so those failures are asserted as typed
 * refusals. The counterpart matters just as much: a held lock, an elapsed deadline and a document
 * removed while the process runs are refusals that pass, so a later call must be able to read the
 * installation's identity again instead of carrying a permanent distrust.
 *
 * The last cases drive the private I/O boundary rather than the store's own logic: they hold a
 * real write, let a real deadline elapse while that write is genuinely unsettled, and count every
 * timer and abort listener the wait hands out. The cases after them drive one document's owner
 * directly, with barriers and an injected clock rather than sleeps: a caller that arrives while
 * the owner is writing waits for it and then runs its own change, a caller whose own wait ends
 * first runs none of its own work, a caller whose wait ended leaves the write it started owned,
 * and a caller still waiting when the owner is closed is refused. Nothing here sleeps or simulates
 * a store state, so the behaviour under test is the store's own.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_SALT_VERSION, ClaudeSaltStore, isClaudeAccountRef } from '../src/providers/claude-salt-store.js'
import {
  ContinuationIo,
  LOCAL_CONTINUATION_STATE_UNAVAILABLE,
  continuationBudget,
  nodeContinuationFiles,
} from '../src/providers/claude-continuation-io.js'
import type { ContinuationFiles, ContinuationWaitHost } from '../src/providers/claude-continuation-io.js'

/** How long a store operation may wait in these cases. */
const DEADLINE_MS = 2_000

/** How long an operation may wait for the owned lock in these cases. */
const LOCK_TIMEOUT_MS = 2_000

/** The budget a waiting caller runs under in the cases that end its wait. */
const QUEUED_WAIT_MS = 50

/** One private root this file owns and removes when it settles. */
function privateRoot(): string {
  return mkdtempSync(join(tmpdir(), 'claude-salt-spec-'))
}

/** Facts a case states instead of the configured timing. */
interface StoreOverrides {
  readonly deadlineMs?: number
  readonly lockTimeoutMs?: number
  readonly files?: ContinuationFiles
  readonly waits?: ContinuationWaitHost
}

/** A store over one path, with the timing a real composition resolves from the plugin's config. */
function storeAt(path: string, overrides: StoreOverrides = {}): ClaudeSaltStore {
  return new ClaudeSaltStore({
    path,
    deadlineMs: overrides.deadlineMs ?? DEADLINE_MS,
    lockTimeoutMs: overrides.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
    ...overrides.files === undefined ? {} : { files: overrides.files },
    ...overrides.waits === undefined ? {} : { waits: overrides.waits },
  })
}

/** How many file operations one case's port observed. */
interface FileCalls {
  reads: number
  writes: number
  directories: number
}

/** A deferred promise, so a case can hold a real write at a deterministic point. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, resolve: release }
}

/**
 * The real filesystem behind counters, optionally signalling and holding each write.
 *
 * Holding the actual write is what makes "the deadline passed while the write was still pending" a
 * real state rather than a simulated one, and it lets a case prove that the work was not cancelled
 * when the caller stopped waiting.
 */
function countingFiles(options: {
  readonly hold?: Promise<void>
  readonly onWrite?: () => void
  readonly onSettled?: () => void
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
      if (options.onSettled !== undefined) options.onSettled()
    },
  }
  return { files, calls }
}

/** What one case observed of the wait resources it handed out. */
interface WaitRecord {
  scheduled: number
  cancelled: number
  subscribed: number
  removed: number
}

/**
 * A wait host that counts every resource it hands out and every disposal of one.
 * @param onWait - called when a bounded wait starts, so a case can observe a caller waiting at a
 *   deterministic point instead of polling or sleeping.
 */
function recordingWaits(onWait?: () => void): { host: ContinuationWaitHost; record: WaitRecord } {
  const record: WaitRecord = { scheduled: 0, cancelled: 0, subscribed: 0, removed: 0 }
  const host: ContinuationWaitHost = {
    now: () => Date.now(),
    schedule: (delayMs, fire) => {
      record.scheduled += 1
      if (onWait !== undefined) onWait()
      const timer = setTimeout(fire, delayMs)
      return () => {
        record.cancelled += 1
        clearTimeout(timer)
      }
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

/** What one case can drive on its own clock and timers. */
interface FakeClock {
  readonly host: ContinuationWaitHost
  readonly record: WaitRecord
  /** Move the clock forward and fire every timer whose instant has arrived. */
  advance(ms: number): void
  /** How many timers are still registered. */
  pending(): number
}

/**
 * A wait host whose clock and timers one case drives, so a budget can end with no real time
 * passing and several waits can be pending at once.
 * @param onWait - called when a bounded wait starts, so a case can observe a caller waiting at a
 *   deterministic point instead of polling or sleeping.
 * @returns the host, what it handed out, and the controls for its clock.
 */
function fakeClockWaits(onWait?: () => void): FakeClock {
  let now = 0
  let nextTimer = 0
  const timers = new Map<number, { readonly dueAt: number; readonly fire: () => void }>()
  const record: WaitRecord = { scheduled: 0, cancelled: 0, subscribed: 0, removed: 0 }
  const host: ContinuationWaitHost = {
    now: () => now,
    schedule: (delayMs, fire) => {
      record.scheduled += 1
      if (onWait !== undefined) onWait()
      const id = (nextTimer += 1)
      timers.set(id, { dueAt: now + Math.max(1, Math.floor(delayMs)), fire })
      return () => {
        record.cancelled += 1
        timers.delete(id)
      }
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
  return {
    host,
    record,
    advance: (ms) => {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.dueAt > now) continue
        timers.delete(id)
        timer.fire()
      }
    },
    pending: () => timers.size,
  }
}

test('the first use creates a salt and derives a verifiable reference', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'salt.json')
    const store = storeAt(path)
    const status = await store.ensure()
    assert.deepEqual(status, { kind: 'ready', version: CLAUDE_SALT_VERSION })
    // Nothing the store reports carries a field that could hold the material.
    assert.deepEqual(Object.keys(status).sort(), ['kind', 'version'])

    const derived = await store.hashRef('acct@example.invalid')
    assert.equal(derived.kind, 'derived')
    if (derived.kind !== 'derived') return
    assert.equal(isClaudeAccountRef(derived.accountRef), true)
    assert.equal(derived.accountRef.kind, 'salt-sha256')
    assert.equal(derived.accountRef.version, 1)
    assert.deepEqual(Object.keys(derived.accountRef).sort(), ['kind', 'ref', 'version'])

    // The same installation, asked again, derives the same reference.
    const again = await storeAt(path).hashRef('acct@example.invalid')
    assert.deepEqual(again, derived)
    // A different account cannot collide with it.
    const other = await store.hashRef('other@example.invalid')
    assert.equal(other.kind, 'derived')
    if (other.kind !== 'derived') return
    assert.notEqual(other.accountRef.ref, derived.accountRef.ref)

    const document = JSON.parse(readFileSync(path, 'utf8')) as { version: number; salt: string }
    assert.equal(document.version, CLAUDE_SALT_VERSION)
    assert.equal(document.salt.length > 0, true)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a second installation derives a different reference for the same account', async () => {
  const root = privateRoot()
  try {
    const first = await storeAt(join(root, 'a', 'salt.json')).hashRef('acct@example.invalid')
    const second = await storeAt(join(root, 'b', 'salt.json')).hashRef('acct@example.invalid')
    assert.equal(first.kind, 'derived')
    assert.equal(second.kind, 'derived')
    if (first.kind !== 'derived' || second.kind !== 'derived') return
    assert.notEqual(first.accountRef.ref, second.accountRef.ref)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('two instances that start together leave one salt and derive the same reference', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'salt.json')
    // Both instances hold the same generous budgets: the case is about which critical section
    // creates the document, not about which refusal wins a short budget.
    const timing: StoreOverrides = { deadlineMs: 10_000, lockTimeoutMs: 10_000 }
    const [left, right] = await Promise.all([
      storeAt(path, timing).hashRef('acct@example.invalid'),
      storeAt(path, timing).hashRef('acct@example.invalid'),
    ])
    assert.equal(left.kind, 'derived')
    assert.equal(right.kind, 'derived')
    if (left.kind !== 'derived' || right.kind !== 'derived') return
    assert.equal(left.accountRef.ref, right.accountRef.ref, 'one installation, one identity')
    const document = JSON.parse(readFileSync(path, 'utf8')) as { version: number; salt: string }
    assert.equal(document.version, CLAUDE_SALT_VERSION)
    assert.equal(document.salt.length > 0, true)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a damaged salt is untrusted, and the document it could not verify is not replaced', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'salt.json')
    writeFileSync(path, 'not json', { mode: 0o600 })
    const store = storeAt(path)
    assert.equal((await store.ensure()).kind, 'untrusted')
    const derived = await store.hashRef('acct@example.invalid')
    assert.equal(derived.kind, 'failed')
    if (derived.kind !== 'failed') return
    assert.equal(derived.code, LOCAL_CONTINUATION_STATE_UNAVAILABLE)

    // The record was not replaced: the untrusted file is still the one on disk.
    assert.equal(readFileSync(path, 'utf8'), 'not json')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a salt substituted while in use is refused instead of masked by a cached value', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'salt.json')
    const store = storeAt(path)
    const first = await store.hashRef('acct@example.invalid')
    assert.equal(first.kind, 'derived')

    // Another writer replaces the document under this store: the reference it would now derive is
    // a different identity, so the store refuses rather than reusing its cached material.
    writeFileSync(path, JSON.stringify({
      version: CLAUDE_SALT_VERSION,
      salt: 'substituted-material',
      createdAt: new Date().toISOString(),
    }), { mode: 0o600 })
    const second = await store.hashRef('acct@example.invalid')
    assert.equal(second.kind, 'failed')
    if (second.kind !== 'failed') return
    assert.equal(second.code, LOCAL_CONTINUATION_STATE_UNAVAILABLE)
    assert.match(second.reason, /replaced/)
    // The verdict stands: this store never derives from material that is not the one it adopted.
    assert.equal((await store.ensure()).kind, 'untrusted')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a salt removed while in use is a refusal that passes, not a permanent distrust', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'salt.json')
    const store = storeAt(path)
    const first = await store.hashRef('acct@example.invalid')
    assert.equal(first.kind, 'derived')
    if (first.kind !== 'derived') return
    const document = readFileSync(path, 'utf8')

    rmSync(path)
    const lost = await store.hashRef('acct@example.invalid')
    assert.equal(lost.kind, 'failed')
    if (lost.kind !== 'failed') return
    assert.equal(lost.code, LOCAL_CONTINUATION_STATE_UNAVAILABLE)
    assert.match(lost.reason, /removed/)

    // The same material coming back is the same identity, so the store is usable again rather
    // than permanently distrusted.
    writeFileSync(path, document, { mode: 0o600 })
    assert.deepEqual(await store.hashRef('acct@example.invalid'), first)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a document this build does not write is untrusted, and an empty account key is refused', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'salt.json')
    writeFileSync(path, JSON.stringify({ version: 99, salt: 'substituted', createdAt: 'now' }), { mode: 0o600 })
    const store = storeAt(path)
    assert.equal((await store.ensure()).kind, 'untrusted')

    const empty = await storeAt(join(root, 'other.json')).hashRef('')
    assert.equal(empty.kind, 'failed')
    if (empty.kind !== 'failed') return
    assert.equal(empty.code, LOCAL_CONTINUATION_STATE_UNAVAILABLE)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('an unreadable path is a typed refusal rather than a thrown error', async () => {
  const root = privateRoot()
  try {
    // A directory where the document belongs makes every read and write fail.
    const path = join(root, 'salt.json')
    mkdirSync(path, { recursive: true })
    const store = storeAt(path)
    const status = await store.ensure()
    assert.equal(status.kind, 'unavailable')
    if (status.kind !== 'unavailable') return
    assert.equal(status.code, LOCAL_CONTINUATION_STATE_UNAVAILABLE)
    assert.equal((await store.hashRef('acct@example.invalid')).kind, 'failed')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a lock another holder owns refuses under the lock budget and passes when it is released', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'salt.json')
    // A live holder: the lock directory is fresh, so the lock primitive waits it out and then
    // refuses, rather than treating the holder as dead.
    mkdirSync(`${path}.lock`, { recursive: true })
    writeFileSync(`${path}.lock/owner`, 'another-holder', { mode: 0o600 })
    const store = storeAt(path, { deadlineMs: 5_000, lockTimeoutMs: 100 })
    const refused = await store.ensure()
    assert.equal(refused.kind, 'unavailable')
    if (refused.kind !== 'unavailable') return
    assert.match(refused.reason, /lock/)

    // The held lock was the refusal, not the deadline: a released lock makes the same store
    // usable again, and the verdict was never recorded as distrust.
    rmSync(`${path}.lock`, { recursive: true, force: true })
    assert.deepEqual(await store.ensure(), { kind: 'ready', version: CLAUDE_SALT_VERSION })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a first use creates a document directory that does not exist yet', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'nested', 'deeper', 'salt.json')
    assert.equal(existsSync(join(root, 'nested')), false)
    assert.deepEqual(await storeAt(path).ensure(), { kind: 'ready', version: CLAUDE_SALT_VERSION })
    assert.equal(existsSync(path), true)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

/** The two ways a caller's own wait can end while the write it started is still held. */
const abandonedWaits = {
  cancel: 'a caller that stops waiting leaves its held write owned, and the caller that arrives next is served',
  deadline: 'a caller whose budget ends leaves its held write owned, and the caller that arrives next is served',
} as const

for (const variant of ['cancel', 'deadline'] as const) {
  test(abandonedWaits[variant], async () => {
    const root = privateRoot()
    const path = join(root, 'salt.json')
    const started = deferred()
    const hold = deferred()
    const secondWaits = deferred()
    let secondQueued = false
    const clock = fakeClockWaits(() => { if (secondQueued) secondWaits.resolve() })
    const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => started.resolve() })
    const io = new ContinuationIo({
      path,
      deadlineMs: DEADLINE_MS,
      lockTimeoutMs: LOCK_TIMEOUT_MS,
      files,
      waits: clock.host,
    })
    const stopping = new AbortController()
    const seen: (string | undefined)[] = []
    try {
      const first = io.update(
        (current) => { seen.push(current); return 'account-a' },
        variant === 'cancel' ? { expiresAt: 1_000, signal: stopping.signal } : { expiresAt: 10 },
      )
      await started.promise
      // The caller's own wait ends while the write it started is genuinely still running.
      if (variant === 'cancel') stopping.abort()
      else clock.advance(10)
      const stopped = await first
      assert.equal(stopped.kind, 'unavailable')
      if (stopped.kind !== 'unavailable') return
      assert.match(stopped.reason, variant === 'cancel' ? /stopped waiting/ : /deadline/)
      assert.equal(calls.writes, 1, 'the write it started is still owned and still running')

      secondQueued = true
      const second = io.update(
        (current) => { seen.push(current); return `${current ?? ''}+account-b` },
        { expiresAt: 1_000 },
      )
      secondQueued = false
      // The arriving caller must be waiting, not already refused: an early result here is the
      // regression this case exists for.
      assert.equal(await Promise.race([
        secondWaits.promise.then(() => 'waiting' as const),
        second.then(() => 'finished' as const),
      ]), 'waiting')
      assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })
      assert.deepEqual(seen, [undefined], 'the waiting caller ran no change of its own')

      hold.resolve()
      assert.deepEqual(await second, { kind: 'applied', text: 'account-a+account-b', written: true },
        'the waiting caller changed the document the abandoned write committed')
      assert.deepEqual(seen, [undefined, 'account-a'])
      assert.deepEqual(calls, { reads: 2, writes: 2, directories: 2 })
      assert.equal(readFileSync(path, 'utf8'), 'account-a+account-b')
      assert.equal(clock.record.scheduled, clock.record.cancelled, 'every wait released its timer')
      assert.equal(clock.record.subscribed, clock.record.removed, 'every wait released its abort listener')
      assert.equal(clock.pending(), 0, 'no timer is left registered')
    } finally {
      hold.resolve()
      await io.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })
}

test('close waits for the owned write to settle rather than reporting a settlement it did not see', async () => {
  const root = privateRoot()
  const path = join(root, 'salt.json')
  const started = deferred()
  const hold = deferred()
  let writeSettled = false
  const { files, calls } = countingFiles({
    hold: hold.promise,
    onWrite: () => started.resolve(),
    onSettled: () => { writeSettled = true },
  })
  const store = storeAt(path, { deadlineMs: 30, files })
  try {
    const pending = store.ensure()
    assert.equal((await pending).kind, 'unavailable')
    await started.promise

    let closeSettled = false
    const closing = store.close().then(() => { closeSettled = true })
    // Give the disposal's own continuation several turns to (wrongly) finish while the write is
    // held; the observations below hold whether or not it uses them.
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    assert.equal(writeSettled, false, 'the owned write is genuinely still held')
    assert.equal(closeSettled, false, 'disposal cannot have observed a settlement that has not happened')

    hold.resolve()
    await closing
    assert.equal(writeSettled, true)
    assert.equal(closeSettled, true)
    assert.equal(calls.writes, 1)
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { salt: string }).salt.length > 0, true)
  } finally {
    hold.resolve()
    await store.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a pre-aborted caller performs no file operation at all', async () => {
  const root = privateRoot()
  try {
    const { files, calls } = countingFiles()
    const store = storeAt(documentPath(root), { files })
    const controller = new AbortController()
    controller.abort()
    const refused = await store.ensure(continuationBudget(DEADLINE_MS, controller.signal))
    assert.equal(refused.kind, 'unavailable')
    if (refused.kind !== 'unavailable') return
    assert.match(refused.reason, /stopped/)
    assert.deepEqual(calls, { reads: 0, writes: 0, directories: 0 })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a budget that has already ended refuses before any file operation', async () => {
  const root = privateRoot()
  try {
    const { files, calls } = countingFiles()
    const store = storeAt(documentPath(root), { files })
    const refused = await store.ensure(continuationBudget(0))
    assert.equal(refused.kind, 'unavailable')
    if (refused.kind !== 'unavailable') return
    assert.match(refused.reason, /budget ended/)
    assert.deepEqual(calls, { reads: 0, writes: 0, directories: 0 })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a successful operation releases its timer and its abort listener', async () => {
  const root = privateRoot()
  try {
    const { host, record } = recordingWaits()
    const store = storeAt(join(root, 'salt.json'), { waits: host })
    const controller = new AbortController()
    assert.equal((await store.ensure(continuationBudget(DEADLINE_MS, controller.signal))).kind, 'ready')
    assert.deepEqual(record, { scheduled: 1, cancelled: 1, subscribed: 1, removed: 1 })
    // Nothing of this wait is left listening on the caller's signal.
    controller.abort()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('an abort ends the wait, releases both resources, and leaves the owned write running', async () => {
  const root = privateRoot()
  const path = join(root, 'salt.json')
  const started = deferred()
  const hold = deferred()
  const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => started.resolve() })
  const { host, record } = recordingWaits()
  const store = storeAt(path, { deadlineMs: 10_000, files, waits: host })
  try {
    const controller = new AbortController()
    const pending = store.ensure(continuationBudget(10_000, controller.signal))
    await started.promise
    controller.abort()
    const refused = await pending
    assert.equal(refused.kind, 'unavailable')
    if (refused.kind !== 'unavailable') return
    assert.match(refused.reason, /stopped waiting/)
    assert.deepEqual(record, { scheduled: 1, cancelled: 1, subscribed: 1, removed: 1 })

    // The abort ended the caller's wait; the write it started still commits.
    hold.resolve()
    await store.close()
    assert.equal(calls.writes, 1)
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { salt: string }).salt.length > 0, true)
  } finally {
    hold.resolve()
    await store.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a write that fails is a typed refusal, not a permanent distrust', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'salt.json')
    const files: ContinuationFiles = {
      ensureDirectory: async (directory) => { await nodeContinuationFiles.ensureDirectory(directory) },
      read: async (documentPath) => await nodeContinuationFiles.read(documentPath),
      writeAtomic: async () => {
        throw Object.assign(new Error('the document could not be replaced'), { code: 'EACCES' })
      },
    }
    const store = storeAt(path, { files })
    const refused = await store.ensure()
    assert.equal(refused.kind, 'unavailable')
    if (refused.kind !== 'unavailable') return
    assert.equal(refused.code, LOCAL_CONTINUATION_STATE_UNAVAILABLE)
    assert.match(refused.reason, /EACCES/)

    // The next call reads the path again instead of carrying a permanent verdict.
    assert.deepEqual(await storeAt(path).ensure(), { kind: 'ready', version: CLAUDE_SALT_VERSION })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('two callers of one document: the second waits for the first, and both changes stand', async () => {
  const root = privateRoot()
  const path = join(root, 'salt.json')
  const started = deferred()
  const hold = deferred()
  let writes = 0
  const { files, calls } = countingFiles({
    hold: hold.promise,
    onWrite: () => {
      writes += 1
      if (writes === 1) started.resolve()
    },
  })
  // The first caller's own wait is registered before this flag is set, so the next wait the host
  // sees is the second caller's: an observed wait, not a sleep.
  let secondCallerQueued = false
  const secondWaits = deferred()
  const { host, record } = recordingWaits(() => { if (secondCallerQueued) secondWaits.resolve() })
  const io = new ContinuationIo({
    path,
    deadlineMs: DEADLINE_MS,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    files,
    waits: host,
  })
  const controller = new AbortController()
  const seen: (string | undefined)[] = []
  try {
    const first = io.update((current) => { seen.push(current); return 'account-a' })
    await started.promise
    secondCallerQueued = true
    const second = io.update(
      (current) => { seen.push(current); return `${current ?? ''}+account-b` },
      continuationBudget(DEADLINE_MS, controller.signal),
    )
    secondCallerQueued = false
    await secondWaits.promise
    // The second caller is really inside its wait, and none of its own work has started.
    assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })
    assert.deepEqual(seen, [undefined], 'the waiting caller ran no change of its own yet')

    hold.resolve()
    assert.deepEqual(await first, { kind: 'applied', text: 'account-a', written: true },
      'the first caller keeps its own result')
    assert.deepEqual(await second, { kind: 'applied', text: 'account-a+account-b', written: true },
      'the second caller reports its own change, not the first one\'s')
    // Two real read-modify-writes: the second change read the text the first one committed.
    assert.deepEqual(seen, [undefined, 'account-a'])
    assert.deepEqual(calls, { reads: 2, writes: 2, directories: 2 })
    assert.equal(readFileSync(path, 'utf8'), 'account-a+account-b')
    // Every wait this case handed out released its timer and its abort listener.
    assert.ok(record.scheduled >= 2, 'the queued caller registered a bounded wait of its own')
    assert.equal(record.scheduled, record.cancelled)
    assert.equal(record.subscribed, record.removed)
  } finally {
    hold.resolve()
    await io.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

/** The subjects of the two ways one caller's wait can end while the document is held. */
const stoppingSubjects = {
  cancel: 'a caller that stops waiting for the document runs none of its own work',
  deadline: 'a waiting caller whose own budget ends runs none of its own work',
} as const

for (const variant of ['cancel', 'deadline'] as const) {
  test(`${stoppingSubjects[variant]}, and later callers are unaffected`, async () => {
    const root = privateRoot()
    const path = join(root, 'salt.json')
    const started = deferred()
    const hold = deferred()
    let writes = 0
    const { files, calls } = countingFiles({
      hold: hold.promise,
      onWrite: () => {
        writes += 1
        if (writes === 1) started.resolve()
      },
    })
    let secondCallerQueued = false
    const secondWaits = deferred()
    const { host, record } = recordingWaits(() => { if (secondCallerQueued) secondWaits.resolve() })
    const io = new ContinuationIo({
      path,
      deadlineMs: DEADLINE_MS,
      lockTimeoutMs: LOCK_TIMEOUT_MS,
      files,
      waits: host,
    })
    const controller = new AbortController()
    const seen: (string | undefined)[] = []
    try {
      const first = io.update((current) => { seen.push(current); return 'account-a' })
      await started.promise
      secondCallerQueued = true
      const second = io.update(
        (current) => { seen.push(current); return 'never' },
        variant === 'cancel'
          ? continuationBudget(DEADLINE_MS, controller.signal)
          : continuationBudget(QUEUED_WAIT_MS),
      )
      secondCallerQueued = false
      await secondWaits.promise
      if (variant === 'cancel') controller.abort()
      const refused = await second
      assert.equal(refused.kind, 'unavailable')
      if (refused.kind !== 'unavailable') return
      assert.equal(refused.code, LOCAL_CONTINUATION_STATE_UNAVAILABLE)
      assert.match(refused.reason, variant === 'cancel' ? /stopped waiting/ : /deadline/)
      // The caller whose wait ended ran no change and no file operation of its own, and it did not
      // disturb the work already committed to on the same document.
      assert.equal(seen.length, 1)
      assert.equal(seen[0], undefined)
      assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })

      hold.resolve()
      assert.deepEqual(await first, { kind: 'applied', text: 'account-a', written: true })
      assert.equal(readFileSync(path, 'utf8'), 'account-a')

      // A later caller takes a fresh budget of its own and is served: the ended wait neither
      // carried its budget over nor left the document's owner unusable.
      let laterRuns = 0
      assert.deepEqual(await io.update((current) => { laterRuns += 1; seen.push(current); return `${current ?? ''}-c` }),
        { kind: 'applied', text: 'account-a-c', written: true })
      assert.equal(laterRuns, 1)
      assert.deepEqual(seen, [undefined, 'account-a'])
      assert.equal(readFileSync(path, 'utf8'), 'account-a-c')
      assert.deepEqual(calls, { reads: 2, writes: 2, directories: 2 })
      assert.equal(record.scheduled, record.cancelled)
      assert.equal(record.subscribed, record.removed)
    } finally {
      hold.resolve()
      await io.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })
}

test('close waits for the held write and refuses the caller that was waiting for admission', async () => {
  const root = privateRoot()
  const path = join(root, 'salt.json')
  const started = deferred()
  const hold = deferred()
  let writes = 0
  const { files, calls } = countingFiles({
    hold: hold.promise,
    onWrite: () => {
      writes += 1
      if (writes === 1) started.resolve()
    },
  })
  let secondCallerQueued = false
  const secondWaits = deferred()
  const { host } = recordingWaits(() => { if (secondCallerQueued) secondWaits.resolve() })
  const io = new ContinuationIo({
    path,
    deadlineMs: DEADLINE_MS,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    files,
    waits: host,
  })
  let queuedRuns = 0
  try {
    const first = io.update(() => 'account-a')
    await started.promise
    secondCallerQueued = true
    const queued = io.update(() => { queuedRuns += 1; return 'account-b' })
    secondCallerQueued = false
    await secondWaits.promise

    let closeSettled = false
    const closing = io.close().then(() => { closeSettled = true })
    // Several turns for the disposal to (wrongly) report itself settled while the write is held.
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    assert.equal(closeSettled, false, 'disposal cannot observe a settlement that has not happened')

    hold.resolve()
    await closing
    assert.equal(closeSettled, true)

    // The caller that was already waiting when disposal began is refused, and it runs nothing.
    const refused = await queued
    assert.equal(refused.kind, 'unavailable')
    if (refused.kind !== 'unavailable') return
    assert.match(refused.reason, /disposed/)
    assert.equal(queuedRuns, 0)
    assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })
    assert.deepEqual(await first, { kind: 'applied', text: 'account-a', written: true })
    assert.equal(readFileSync(path, 'utf8'), 'account-a', 'no late file was written')

    // Disposal is terminal for a caller that arrives after it as well.
    assert.equal((await io.update(() => 'account-c')).kind, 'unavailable')
    assert.equal(calls.writes, 1)
  } finally {
    hold.resolve()
    await io.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

/** The two ways a caller waiting for an abandoned write can stop waiting. */
const waitingEnds = {
  cancel: 'a caller that stops waiting for an abandoned write runs no work of its own, and the next caller is served',
  deadline: 'a caller whose budget ends while it waits for an abandoned write runs no work of its own, and the next caller is served',
} as const

for (const variant of ['cancel', 'deadline'] as const) {
  test(waitingEnds[variant], async () => {
    const root = privateRoot()
    const path = join(root, 'salt.json')
    const started = deferred()
    const hold = deferred()
    const secondWaits = deferred()
    let secondQueued = false
    const clock = fakeClockWaits(() => { if (secondQueued) secondWaits.resolve() })
    const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => started.resolve() })
    const io = new ContinuationIo({
      path,
      deadlineMs: DEADLINE_MS,
      lockTimeoutMs: LOCK_TIMEOUT_MS,
      files,
      waits: clock.host,
    })
    const abandoned = new AbortController()
    const stopping = new AbortController()
    const seen: (string | undefined)[] = []
    try {
      const first = io.update(
        (current) => { seen.push(current); return 'account-a' },
        { expiresAt: 1_000, signal: abandoned.signal },
      )
      await started.promise
      abandoned.abort()
      assert.equal((await first).kind, 'unavailable')
      assert.equal(calls.writes, 1, 'the abandoned write is still owned and still running')

      secondQueued = true
      const second = io.update(
        (current) => { seen.push(current); return 'never' },
        variant === 'deadline' ? { expiresAt: 50 } : { expiresAt: 1_000, signal: stopping.signal },
      )
      secondQueued = false
      assert.equal(await Promise.race([
        secondWaits.promise.then(() => 'waiting' as const),
        second.then(() => 'finished' as const),
      ]), 'waiting', 'the caller is really waiting for the abandoned write')
      // The caller's own wait ends, with no real time passing, while the write it waits for is held.
      if (variant === 'deadline') clock.advance(50)
      else stopping.abort()
      const refused = await second
      assert.equal(refused.kind, 'unavailable')
      if (refused.kind !== 'unavailable') return
      assert.equal(refused.code, LOCAL_CONTINUATION_STATE_UNAVAILABLE)
      assert.match(refused.reason, variant === 'deadline' ? /deadline/ : /stopped waiting/)
      assert.equal(seen.length, 1, 'the waiting caller ran no change of its own')
      assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })

      hold.resolve()
      await io.drain()
      assert.equal(readFileSync(path, 'utf8'), 'account-a', 'the abandoned write still committed')

      // A caller after both ended waits takes its own fresh budget and is served: neither ended
      // wait left a permanent refusal behind.
      assert.deepEqual(await io.update((current) => { seen.push(current); return `${current ?? ''}-c` }),
        { kind: 'applied', text: 'account-a-c', written: true })
      assert.deepEqual(seen, [undefined, 'account-a'])
      assert.deepEqual(calls, { reads: 2, writes: 2, directories: 2 })
      assert.equal(readFileSync(path, 'utf8'), 'account-a-c')
      assert.equal(clock.record.scheduled, clock.record.cancelled, 'every wait released its timer')
      assert.equal(clock.record.subscribed, clock.record.removed, 'every wait released its abort listener')
      assert.equal(clock.pending(), 0, 'no timer is left registered')
    } finally {
      hold.resolve()
      await io.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })
}

test('close settles an abandoned write and refuses the caller that was waiting for it', async () => {
  const root = privateRoot()
  const path = join(root, 'salt.json')
  const started = deferred()
  const hold = deferred()
  const secondWaits = deferred()
  let secondQueued = false
  const clock = fakeClockWaits(() => { if (secondQueued) secondWaits.resolve() })
  const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => started.resolve() })
  const io = new ContinuationIo({
    path,
    deadlineMs: DEADLINE_MS,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    files,
    waits: clock.host,
  })
  const abandoned = new AbortController()
  let queuedRuns = 0
  try {
    const first = io.update(() => 'account-a', { expiresAt: 1_000, signal: abandoned.signal })
    await started.promise
    abandoned.abort()
    assert.equal((await first).kind, 'unavailable')

    secondQueued = true
    const queued = io.update(() => { queuedRuns += 1; return 'account-b' })
    secondQueued = false
    assert.equal(await Promise.race([
      secondWaits.promise.then(() => 'waiting' as const),
      queued.then(() => 'finished' as const),
    ]), 'waiting', 'the caller is really waiting for the abandoned write')

    let closeSettled = false
    const closing = io.close().then(() => { closeSettled = true })
    // Several turns for the disposal to (wrongly) report itself settled while the write is held.
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    assert.equal(closeSettled, false, 'disposal cannot observe a settlement that has not happened')

    hold.resolve()
    await closing
    assert.equal(closeSettled, true)

    // The caller that was waiting on the abandoned write wakes to the closed state and runs nothing.
    const refused = await queued
    assert.equal(refused.kind, 'unavailable')
    if (refused.kind !== 'unavailable') return
    assert.match(refused.reason, /disposed/)
    assert.equal(queuedRuns, 0)
    assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })
    assert.equal(readFileSync(path, 'utf8'), 'account-a')
    assert.equal(clock.record.scheduled, clock.record.cancelled, 'every wait released its timer')
    assert.equal(clock.pending(), 0, 'no timer is left registered')
  } finally {
    hold.resolve()
    await io.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

/** The document path one case uses inside its private root. */
function documentPath(root: string): string {
  return join(root, 'salt.json')
}
