/**
 * The continuation salt: one durable account-naming material per installation.
 *
 * The cases exist because the reference is what a later request compares a stored row against. A
 * salt that was re-created, substituted or read from a damaged document must not produce a
 * reference that quietly matches another account's rows, so those failures are asserted as typed
 * refusals. The counterpart matters just as much: a document removed while the process runs is a
 * refusal that passes, so a later call must be able to read the installation's identity again
 * instead of carrying a permanent distrust.
 *
 * The later cases state the queue's own semantics: one operation runs at a time and every caller
 * behind it waits for that operation's real settlement, in arrival order. Elapsed time never ends a
 * wait and never refuses a caller; only the caller's own cancellation or the store's disposal does.
 * A caller that stops waiting while its operation is running is answered with the refusal only after
 * that operation really settled, so the next caller always reads the text its predecessor committed.
 * The cases drive the private I/O boundary rather than the store's own logic: they hold a real write,
 * count every file operation, and hand the queue a wait host that would fail the case if any wait
 * scheduled a timer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** How long a store operation's accounting budget allows in these cases. */
const DEADLINE_MS = 2_000

/** The lock policy input these cases resolve, as a real composition does from the plugin's config. */
const LOCK_TIMEOUT_MS = 2_000

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
 * Wait until one case-observable fact holds.
 *
 * This observes the store's own state (a port call it has already made); it never ends a queued
 * wait, so a case that observes a caller still waiting cannot pass because a sleep elapsed.
 * @param condition - the fact the case is waiting to observe.
 * @param what - the fact's description, reported when the bound runs out.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  const bound = Date.now() + 5_000
  while (!condition()) {
    assert.ok(Date.now() <= bound, what)
    await new Promise<void>((resolve) => { setTimeout(resolve, 2) })
  }
}

/**
 * The real filesystem behind counters, optionally signalling and holding each write.
 *
 * Holding the actual write is what makes "the operation is still running" a real state rather than a
 * simulated one, and it lets a case prove that cancellation changed only the reported outcome.
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
  subscribed: number
  removed: number
}

/**
 * A wait host that refuses to schedule and counts every abort subscription and its removal.
 *
 * The queue may not turn elapsed time into an answer, so any timer it asked for would fail the case
 * instead of silently ending a wait. What remains observable is the caller's cancellation: every
 * subscription a wait makes must be removed on every outcome.
 * @returns the host and what it handed out.
 */
function queueWaits(): { host: ContinuationWaitHost; record: WaitRecord } {
  const record: WaitRecord = { scheduled: 0, subscribed: 0, removed: 0 }
  const host: ContinuationWaitHost = {
    now: () => Date.now(),
    schedule: () => {
      record.scheduled += 1
      throw new Error('a continuation wait scheduled a timer')
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

test('a lock path that cannot be created is a typed refusal naming the failure, not a wait', async () => {
  const root = privateRoot()
  try {
    // The directory step is a no-op here, so the document's parent does not exist when the lock is
    // created: that is a failure of the path itself, which waiting can never repair.
    const path = join(root, 'missing', 'salt.json')
    const files: ContinuationFiles = {
      ensureDirectory: async () => {},
      read: async (documentPath) => await nodeContinuationFiles.read(documentPath),
      writeAtomic: async (documentPath, text) => await nodeContinuationFiles.writeAtomic(documentPath, text),
    }
    const refused = await storeAt(path, { files }).ensure()
    assert.equal(refused.kind, 'unavailable')
    if (refused.kind !== 'unavailable') return
    assert.equal(refused.code, LOCAL_CONTINUATION_STATE_UNAVAILABLE)
    assert.match(refused.reason, /could not be used \(ENOENT\)/)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a live cooperative lock is waited out rather than refused', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'salt.json')
    // A live holder: the lock directory is fresh, so it is waited out rather than treated as dead.
    mkdirSync(`${path}.lock`, { recursive: true })
    writeFileSync(`${path}.lock/owner`, 'another-holder', { mode: 0o600 })
    const { files, calls } = countingFiles()
    const store = storeAt(path, { deadlineMs: 5_000, lockTimeoutMs: 100, files })
    let answered = false
    const waiting = store.ensure().then((status) => {
      answered = true
      return status
    }, (error: unknown) => {
      answered = true
      throw error
    })
    // The directory has been ensured, so the caller is at the lock; it has read and written nothing.
    await until(() => calls.directories === 1, 'the caller reached the lock wait')
    assert.deepEqual(calls, { reads: 0, writes: 0, directories: 1 })
    // Held past the whole retry budget a bounded acquire would allow at this lock setting, so a
    // bounded implementation would already have refused. A queue waits for the holder itself.
    await new Promise<void>((resolve) => { setTimeout(resolve, 250) })
    assert.equal(answered, false, 'a live holder is waited out, not refused by a budget')

    rmSync(`${path}.lock`, { recursive: true, force: true })
    assert.deepEqual(await waiting, { kind: 'ready', version: CLAUDE_SALT_VERSION })
    assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a caller cancelled while another holder keeps the lock is refused without reading the state', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'salt.json')
    mkdirSync(`${path}.lock`, { recursive: true })
    writeFileSync(`${path}.lock/owner`, 'another-holder', { mode: 0o600 })
    const { files, calls } = countingFiles()
    const store = storeAt(path, { deadlineMs: 5_000, lockTimeoutMs: 100, files })
    const controller = new AbortController()
    const waiting = store.ensure(continuationBudget(5_000, controller.signal))
    await until(() => calls.directories === 1, 'the caller reached the lock wait')
    controller.abort()
    const refused = await waiting
    assert.equal(refused.kind, 'unavailable')
    if (refused.kind !== 'unavailable') return
    assert.match(refused.reason, /stopped waiting/)
    assert.equal(calls.reads, 0, 'the cancelled caller read nothing')
    assert.equal(calls.writes, 0, 'the cancelled caller wrote nothing')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('running cancellation is reported only after the operation settles, and the next caller reads the committed text', async () => {
  const root = privateRoot()
  const path = join(root, 'salt.json')
  const started = deferred()
  const hold = deferred()
  const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => started.resolve() })
  const { host, record } = queueWaits()
  const io = new ContinuationIo({
    path,
    deadlineMs: DEADLINE_MS,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    files,
    waits: host,
  })
  const stopping = new AbortController()
  const seen: (string | undefined)[] = []
  try {
    const first = io.update(
      (current) => { seen.push(current); return 'account-a' },
      { expiresAt: Date.now() + 1_000, signal: stopping.signal },
    )
    await started.promise
    stopping.abort()
    // Cancellation changes only the reported outcome: the caller cannot abandon its operation, so
    // it is answered after the held write really settles.
    let firstAnswered = false
    void first.then(() => { firstAnswered = true }, () => { firstAnswered = true })
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    assert.equal(firstAnswered, false, 'the cancelled caller is still waiting for its write')
    assert.equal(calls.writes, 1, 'the write it started is still owned and still running')

    // A caller arriving while that write runs queues behind it and runs none of its own work yet.
    const second = io.update(
      (current) => { seen.push(current); return `${current ?? ''}+account-b` },
      { expiresAt: Date.now() + 1_000 },
    )
    assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })
    assert.deepEqual(seen, [undefined], 'the queued caller ran no change of its own')

    hold.resolve()
    const stopped = await first
    assert.equal(stopped.kind, 'unavailable')
    if (stopped.kind !== 'unavailable') return
    assert.match(stopped.reason, /stopped waiting/)
    assert.deepEqual(await second, { kind: 'applied', text: 'account-a+account-b', written: true },
      'the queued caller changed the document the cancelled caller committed')
    assert.deepEqual(seen, [undefined, 'account-a'])
    assert.deepEqual(calls, { reads: 2, writes: 2, directories: 2 })
    assert.equal(readFileSync(path, 'utf8'), 'account-a+account-b')
    assert.equal(record.scheduled, 0, 'no wait scheduled a timer')
    assert.equal(record.subscribed, record.removed, 'every wait released its abort listener')
  } finally {
    hold.resolve()
    await io.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('an already-elapsed budget still commits its change, because elapsed time does not end the wait', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'salt.json')
    const { files, calls } = countingFiles()
    const store = storeAt(path, { files })
    assert.deepEqual(await store.ensure(continuationBudget(0)), { kind: 'ready', version: CLAUDE_SALT_VERSION })
    assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 }, 'the change really ran and was written')
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { salt: string }).salt.length > 0, true)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

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
    await started.promise
    // The configured budget is far shorter than the held write's life, and it still answers nothing:
    // elapsed time is not an outcome the queue reports.
    let answered = false
    void pending.then(() => { answered = true }, () => { answered = true })
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    assert.equal(answered, false, 'a passing budget does not end the running operation')

    let closeSettled = false
    const closing = store.close().then(() => { closeSettled = true })
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    assert.equal(writeSettled, false, 'the owned write is genuinely still held')
    assert.equal(closeSettled, false, 'disposal cannot have observed a settlement that has not happened')

    hold.resolve()
    await closing
    assert.equal(writeSettled, true)
    assert.deepEqual(await pending, { kind: 'ready', version: CLAUDE_SALT_VERSION })
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

test('a successful operation schedules no timer and leaves no abort listener behind', async () => {
  const root = privateRoot()
  try {
    const { host, record } = queueWaits()
    const store = storeAt(join(root, 'salt.json'), { waits: host })
    const controller = new AbortController()
    assert.equal((await store.ensure(continuationBudget(DEADLINE_MS, controller.signal))).kind, 'ready')
    assert.equal(record.scheduled, 0, 'the queue created no timer')
    assert.equal(record.subscribed, record.removed, 'the abort listener was removed when the wait ended')
    // Nothing of this wait is left listening on the caller's signal.
    controller.abort()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('an abort is answered with a refusal only once the write it started settles, and that write commits', async () => {
  const root = privateRoot()
  const path = join(root, 'salt.json')
  const started = deferred()
  const hold = deferred()
  const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => started.resolve() })
  const { host, record } = queueWaits()
  const store = storeAt(path, { files, waits: host })
  try {
    const controller = new AbortController()
    const pending = store.ensure(continuationBudget(DEADLINE_MS, controller.signal))
    await started.promise
    controller.abort()
    let answered = false
    void pending.then(() => { answered = true }, () => { answered = true })
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    assert.equal(answered, false, 'the caller is answered only after its write settles')

    hold.resolve()
    const refused = await pending
    assert.equal(refused.kind, 'unavailable')
    if (refused.kind !== 'unavailable') return
    assert.match(refused.reason, /stopped waiting/)
    assert.equal(calls.writes, 1)
    assert.equal(record.scheduled, 0, 'the abort wait created no timer')
    assert.equal(record.subscribed, record.removed, 'the abort listener was removed')

    // The write the cancelled caller started still commits.
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
  const { host, record } = queueWaits()
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
    const second = io.update(
      (current) => { seen.push(current); return `${current ?? ''}+account-b` },
      continuationBudget(DEADLINE_MS, controller.signal),
    )
    // The second caller is enqueued synchronously: none of its own work has started.
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
    assert.equal(record.scheduled, 0, 'no wait scheduled a timer')
    assert.equal(record.subscribed, record.removed, 'every wait released its abort listener')
  } finally {
    hold.resolve()
    await io.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a queued caller that is cancelled runs none of its own work, and the next caller is served', async () => {
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
  const { host, record } = queueWaits()
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
    const second = io.update(
      (current) => { seen.push(current); return 'never' },
      continuationBudget(DEADLINE_MS, controller.signal),
    )
    controller.abort()
    const refused = await second
    assert.equal(refused.kind, 'unavailable')
    if (refused.kind !== 'unavailable') return
    assert.equal(refused.code, LOCAL_CONTINUATION_STATE_UNAVAILABLE)
    assert.match(refused.reason, /stopped waiting/)
    // The cancelled queued caller ran no change and no file operation of its own, and it did not
    // disturb the work already committed to on the same document.
    assert.equal(seen.length, 1)
    assert.equal(seen[0], undefined)
    assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })

    hold.resolve()
    assert.deepEqual(await first, { kind: 'applied', text: 'account-a', written: true })
    assert.equal(readFileSync(path, 'utf8'), 'account-a')

    // A later caller is served: the ended wait left the document's owner usable.
    let laterRuns = 0
    assert.deepEqual(await io.update((current) => { laterRuns += 1; seen.push(current); return `${current ?? ''}-c` }),
      { kind: 'applied', text: 'account-a-c', written: true })
    assert.equal(laterRuns, 1)
    assert.deepEqual(seen, [undefined, 'account-a'])
    assert.equal(readFileSync(path, 'utf8'), 'account-a-c')
    assert.deepEqual(calls, { reads: 2, writes: 2, directories: 2 })
    assert.equal(record.scheduled, 0, 'no wait scheduled a timer')
    assert.equal(record.subscribed, record.removed, 'every wait released its abort listener')
  } finally {
    hold.resolve()
    await io.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a queued caller whose budget has already ended still runs after the holder settles', async () => {
  const root = privateRoot()
  const path = join(root, 'salt.json')
  const started = deferred()
  const hold = deferred()
  const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => started.resolve() })
  const { host, record } = queueWaits()
  const io = new ContinuationIo({
    path,
    deadlineMs: DEADLINE_MS,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    files,
    waits: host,
  })
  const seen: (string | undefined)[] = []
  try {
    const first = io.update((current) => { seen.push(current); return 'account-a' })
    await started.promise
    // The budget was over before this caller arrived; it is advisory accounting, not an outcome.
    const second = io.update(
      (current) => { seen.push(current); return `${current ?? ''}-c` },
      { expiresAt: Date.now() - 1_000 },
    )
    assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })
    assert.deepEqual(seen, [undefined], 'the waiting caller ran no change of its own')

    hold.resolve()
    assert.deepEqual(await first, { kind: 'applied', text: 'account-a', written: true })
    assert.deepEqual(await second, { kind: 'applied', text: 'account-a-c', written: true },
      'an elapsed budget does not end the queued wait')
    assert.deepEqual(seen, [undefined, 'account-a'])
    assert.equal(readFileSync(path, 'utf8'), 'account-a-c')
    assert.equal(record.scheduled, 0, 'no wait scheduled a timer')
    assert.equal(record.subscribed, record.removed, 'every wait released its abort listener')
  } finally {
    hold.resolve()
    await io.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

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
  const io = new ContinuationIo({
    path,
    deadlineMs: DEADLINE_MS,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    files,
  })
  let queuedRuns = 0
  try {
    const first = io.update(() => 'account-a')
    await started.promise
    const queued = io.update(() => { queuedRuns += 1; return 'account-b' })
    assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })

    let closeSettled = false
    const closing = io.close().then(() => { closeSettled = true })
    // The queued caller is woken by disposal and refused without any I/O, while the held write is
    // still running.
    const refused = await queued
    assert.equal(refused.kind, 'unavailable')
    if (refused.kind !== 'unavailable') return
    assert.match(refused.reason, /disposed/)
    assert.equal(queuedRuns, 0)
    assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })
    // Disposal itself cannot report a settlement that has not happened.
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    assert.equal(closeSettled, false, 'disposal cannot observe a settlement that has not happened')

    hold.resolve()
    await closing
    assert.equal(closeSettled, true)
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

test('many queued callers behind one held write run in arrival order, each on the committed text', async () => {
  const root = privateRoot()
  const path = join(root, 'salt.json')
  const started = deferred()
  const hold = deferred()
  const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => started.resolve() })
  const { host, record } = queueWaits()
  const io = new ContinuationIo({
    path,
    deadlineMs: DEADLINE_MS,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    files,
    waits: host,
  })
  const order: number[] = []
  const seen: (string | undefined)[] = []
  const results: string[] = []
  try {
    const first = io.update((current) => { seen.push(current); return 'start' })
    await started.promise
    // Eight callers arrive while the first write is held. Each is enqueued synchronously, so the
    // counters below cannot change until the holder's operation settles.
    const queued = Array.from({ length: 8 }, (_unused, index) => io.update((current) => {
      order.push(index)
      seen.push(current)
      return `${current ?? ''}+${String(index)}`
    }))
    assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })
    assert.deepEqual(seen, [undefined])
    assert.deepEqual(order, [])

    hold.resolve()
    assert.deepEqual(await first, { kind: 'applied', text: 'start', written: true })
    for (const result of await Promise.all(queued)) {
      assert.equal(result.kind, 'applied')
      if (result.kind !== 'applied') return
      results.push(result.text)
    }
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7], 'every caller ran in arrival order')
    assert.deepEqual(seen, [
      undefined,
      'start',
      'start+0',
      'start+0+1',
      'start+0+1+2',
      'start+0+1+2+3',
      'start+0+1+2+3+4',
      'start+0+1+2+3+4+5',
      'start+0+1+2+3+4+5+6',
    ], 'each caller read the text its predecessor committed')
    assert.deepEqual(results, [
      'start+0',
      'start+0+1',
      'start+0+1+2',
      'start+0+1+2+3',
      'start+0+1+2+3+4',
      'start+0+1+2+3+4+5',
      'start+0+1+2+3+4+5+6',
      'start+0+1+2+3+4+5+6+7',
    ])
    assert.equal(readFileSync(path, 'utf8'), 'start+0+1+2+3+4+5+6+7')
    // One initial read plus one per admitted caller; one write per changed document.
    assert.deepEqual(calls, { reads: 9, writes: 9, directories: 9 })
    assert.equal(record.scheduled, 0, 'no wait scheduled a timer')
    assert.equal(record.subscribed, record.removed, 'every wait released its abort listener')
  } finally {
    hold.resolve()
    await io.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a caller waiting behind a cancelled caller is served once that caller\'s write settles', async () => {
  const root = privateRoot()
  const path = join(root, 'salt.json')
  const started = deferred()
  const hold = deferred()
  const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => started.resolve() })
  const io = new ContinuationIo({
    path,
    deadlineMs: DEADLINE_MS,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    files,
  })
  const cancelled = new AbortController()
  const seen: (string | undefined)[] = []
  try {
    const first = io.update(
      (current) => { seen.push(current); return 'account-a' },
      { expiresAt: Date.now() + 1_000, signal: cancelled.signal },
    )
    await started.promise
    cancelled.abort()
    const second = io.update(
      (current) => { seen.push(current); return `${current ?? ''}+account-b` },
      { expiresAt: Date.now() + 1_000 },
    )
    assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })
    assert.deepEqual(seen, [undefined], 'the queued caller waits for the real settlement')

    hold.resolve()
    assert.equal((await first).kind, 'unavailable')
    assert.deepEqual(await second, { kind: 'applied', text: 'account-a+account-b', written: true })
    assert.deepEqual(seen, [undefined, 'account-a'])
    assert.equal(readFileSync(path, 'utf8'), 'account-a+account-b')
  } finally {
    hold.resolve()
    await io.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('close settles a cancelled caller\'s write and refuses the caller that was waiting for it', async () => {
  const root = privateRoot()
  const path = join(root, 'salt.json')
  const started = deferred()
  const hold = deferred()
  const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => started.resolve() })
  const io = new ContinuationIo({
    path,
    deadlineMs: DEADLINE_MS,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    files,
  })
  const abandoned = new AbortController()
  let queuedRuns = 0
  try {
    const first = io.update(() => 'account-a', { expiresAt: Date.now() + 1_000, signal: abandoned.signal })
    await started.promise
    abandoned.abort()

    const queued = io.update(() => { queuedRuns += 1; return 'account-b' })
    assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })

    let closeSettled = false
    const closing = io.close().then(() => { closeSettled = true })
    const refused = await queued
    assert.equal(refused.kind, 'unavailable')
    if (refused.kind !== 'unavailable') return
    assert.match(refused.reason, /disposed/)
    assert.equal(queuedRuns, 0)
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    assert.equal(closeSettled, false, 'disposal cannot observe a settlement that has not happened')

    hold.resolve()
    await closing
    assert.equal(closeSettled, true)
    // The cancelled caller is answered with its refusal only after the write it started settled,
    // and that write still committed.
    assert.equal((await first).kind, 'unavailable')
    assert.deepEqual(calls, { reads: 1, writes: 1, directories: 1 })
    assert.equal(readFileSync(path, 'utf8'), 'account-a')
  } finally {
    hold.resolve()
    await io.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('drain waits for the operations it saw settle, and a caller admitted after it is still served', async () => {
  const root = privateRoot()
  const path = join(root, 'salt.json')
  const started = deferred()
  const hold = deferred()
  const { files, calls } = countingFiles({ hold: hold.promise, onWrite: () => started.resolve() })
  const io = new ContinuationIo({
    path,
    deadlineMs: DEADLINE_MS,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    files,
  })
  try {
    const first = io.update(() => 'account-a')
    await started.promise
    let drained = false
    const draining = io.drain().then(() => { drained = true })
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    assert.equal(drained, false, 'drain cannot observe a settlement that has not happened')

    // A caller admitted after this drain call is not part of its set: draining must not starve on it.
    const late = io.update((current) => `${current ?? ''}+late`)
    hold.resolve()
    await draining
    assert.equal(drained, true, 'drain completed once the operation it saw settled')
    assert.deepEqual(await first, { kind: 'applied', text: 'account-a', written: true })
    assert.deepEqual(await late, { kind: 'applied', text: 'account-a+late', written: true })
    assert.deepEqual(calls, { reads: 2, writes: 2, directories: 2 })
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
