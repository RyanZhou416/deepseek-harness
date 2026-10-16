/**
 * Continuation recovery across a restart, and the identity generation that gates it.
 *
 * These cases exist because the two facts a restart must not change — the wire identity a
 * conversation declares and the generation an account is served under — are exactly the ones that
 * decide model-visible bytes and whether a chain may be sent at all. The generation cases also pin
 * the ownership rules: a request reads the durable row and waits for a transition the auth
 * lifecycle started, it never establishes or advances one, it never treats a stale process-local
 * number as the current identity, and a change that a process began but never published is still
 * closed to the next process rather than reset or taken over.
 *
 * The barrier cases drive a transition with a deferred promise rather than a sleep, so the gate and
 * the account's cooperative lock are observed while the change is genuinely in flight. Every case
 * that holds one releases it in its own `finally` and then waits for the store to settle, so a
 * failing assertion cannot leave owned work or a lock renewal behind.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeIdentityGeneration, claudeIdentityLifecycle } from '../src/providers/claude-identity-generation.js'
import { ClaudeSpanBindingStore, LOCAL_CONTINUATION_STATE_UNAVAILABLE } from '../src/providers/claude-span-store.js'
import type { ClaudeSpanPrepareResult, ClaudeSpanPrepared } from '../src/providers/claude-span-store.js'
import { continuationBudget, nodeContinuationFiles } from '../src/providers/claude-continuation-io.js'
import type { ContinuationFiles, ContinuationWaitHost } from '../src/providers/claude-continuation-io.js'
import { claudeAccountRef } from '../src/providers/claude-salt-store.js'
import type { ClaudeAccountRef } from '../src/providers/claude-salt-store.js'

/** The account these cases name. */
const ACCOUNT: ClaudeAccountRef = claudeAccountRef('salt-a', 'acct@example.invalid')

/** Another account, for the isolation case. */
const OTHER: ClaudeAccountRef = claudeAccountRef('salt-a', 'other@example.invalid')

/** The timing a test composition resolves from the plugin's own config. */
const LOCK_TIMEOUT_MS = 2_000

/** How long one operation may wait before its caller is refused. */
const DEADLINE_MS = 2_000

/** One private root the caller removes when the case settles. */
function privateRoot(): string {
  return mkdtempSync(join(tmpdir(), 'claude-continuation-resume-'))
}

/** Facts a case states instead of the configured timing. */
interface GenerationOverrides {
  readonly lockTimeoutMs?: number
  readonly deadlineMs?: number
  readonly files?: ContinuationFiles
  readonly waits?: ContinuationWaitHost
}

/** What one instrumented port observed. */
interface FileCalls {
  writes: number
  reads: number
}

/**
 * The real continuation files behind a counter that fails chosen writes and holds one read.
 *
 * The failure and the hold happen at the real boundary, so a case drives the store's own
 * publication path rather than a simulated one. The document's writes are, in order, the baseline,
 * each change's statement, and each publication or failure statement; its reads are one per guarded
 * read-modify-write.
 * @param options - which write fails, from which write failures persist, which read is held, and
 *   what the case observes.
 * @returns the port and the operations it has seen.
 */
function instrumentedFiles(options: {
  readonly failOn?: number
  readonly failFrom?: number
  readonly holdReadOn?: number
  readonly holdRead?: Promise<void>
  readonly onWrite?: (write: number) => void
  readonly onRead?: (read: number) => void
} = {}): { files: ContinuationFiles; calls: FileCalls } {
  const calls: FileCalls = { writes: 0, reads: 0 }
  const files: ContinuationFiles = {
    ensureDirectory: async (directory) => { await nodeContinuationFiles.ensureDirectory(directory) },
    read: async (documentPath) => {
      calls.reads += 1
      const read = calls.reads
      if (options.onRead !== undefined) options.onRead(read)
      if (options.holdReadOn === read && options.holdRead !== undefined) await options.holdRead
      return await nodeContinuationFiles.read(documentPath)
    },
    writeAtomic: async (documentPath, text) => {
      calls.writes += 1
      const write = calls.writes
      if (options.onWrite !== undefined) options.onWrite(write)
      if (options.failOn === write || (options.failFrom !== undefined && write >= options.failFrom)) {
        throw Object.assign(new Error('the document could not be replaced'), { code: 'EACCES' })
      }
      await nodeContinuationFiles.writeAtomic(documentPath, text)
    },
  }
  return { files, calls }
}

/** What one case observed of the wait resources it handed out. */
interface WaitObservation {
  scheduled: number
  cancelled: number
  subscribed: number
  removed: number
  fired: number
}

/**
 * A wait host whose clock a case moves and whose timer it fires itself.
 *
 * No real timer is created: a case that must prove a deadline fired does so by moving the clock past
 * the budget and invoking the captured callback, so the case cannot pass merely because a short
 * sleep elapsed on a fast host, and it observes that exactly one timer was live and disposed.
 * @returns the host, what it observed, and the controls the case drives it with.
 */
function controlledWaits(): {
  host: ContinuationWaitHost
  record: WaitObservation
  advanceBy: (milliseconds: number) => void
  fireScheduled: () => void
} {
  const record: WaitObservation = { scheduled: 0, cancelled: 0, subscribed: 0, removed: 0, fired: 0 }
  let now = 1_000_000
  let pending: (() => void) | undefined
  const host: ContinuationWaitHost = {
    now: () => now,
    schedule: (_delayMs, fire) => {
      record.scheduled += 1
      pending = fire
      return () => {
        record.cancelled += 1
        if (pending === fire) pending = undefined
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
    advanceBy: (milliseconds) => { now += milliseconds },
    fireScheduled: () => {
      const fire = pending
      pending = undefined
      if (fire === undefined) return
      record.fired += 1
      fire()
    },
  }
}

/** A generation record over one private path. */
function generationAt(
  path: string,
  accountRef: ClaudeAccountRef = ACCOUNT,
  overrides: GenerationOverrides = {},
): ClaudeIdentityGeneration {
  return new ClaudeIdentityGeneration({
    accountRef,
    path,
    lockTimeoutMs: overrides.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
    deadlineMs: overrides.deadlineMs ?? DEADLINE_MS,
    ...overrides.files === undefined ? {} : { files: overrides.files },
    ...overrides.waits === undefined ? {} : { waits: overrides.waits },
  })
}

/** A span store over one private path. */
function spanStoreAt(path: string): ClaudeSpanBindingStore {
  return new ClaudeSpanBindingStore({ path, lockTimeoutMs: LOCK_TIMEOUT_MS, deadlineMs: DEADLINE_MS })
}

/**
 * The prepared span of a result this case expects to be ready.
 * @param result - what `prepare` returned.
 * @returns the committed span.
 */
function preparedSpan(result: ClaudeSpanPrepareResult): ClaudeSpanPrepared {
  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') throw new Error('the span was not prepared')
  return result.span
}

/**
 * A deferred promise, so a case can place a race at a deterministic point.
 * @returns the promise and the resolver that releases it; resolving twice is harmless.
 */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, resolve: () => { release() } }
}

test('the same span identity keeps its wire session across a restart, and a new session or generation does not', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    const first = preparedSpan(await spanStoreAt(path)
      .prepare({ accountRef: ACCOUNT, harnessSessionId: 'session-1', spanEpoch: 1 }, 'initial'))

    const reopened = spanStoreAt(path)
    const same = preparedSpan(await reopened
      .prepare({ accountRef: ACCOUNT, harnessSessionId: 'session-1', spanEpoch: 1 }, 'initial'))
    assert.equal(same.wireSessionId, first.wireSessionId)

    const otherSession = preparedSpan(await reopened
      .prepare({ accountRef: ACCOUNT, harnessSessionId: 'session-2', spanEpoch: 1 }, 'initial'))
    const otherGeneration = preparedSpan(await reopened
      .prepare({ accountRef: ACCOUNT, harnessSessionId: 'session-1', spanEpoch: 2 }, 'initial'))
    assert.notEqual(otherSession.wireSessionId, first.wireSessionId)
    assert.notEqual(otherGeneration.wireSessionId, first.wireSessionId)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a restored identity stays committed and empty-pinned across a reopen', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    const store = spanStoreAt(path)
    // A span whose record already exists but holds no pin, and an account candidate that would
    // fill it in if a restore were allowed to seed one.
    const unfrozenRecord = preparedSpan(await store
      .prepare({ accountRef: ACCOUNT, harnessSessionId: 'session-1', spanEpoch: 1 }, 'initial'))
    const ticket = await store.beginCapture(ACCOUNT)
    assert.equal(ticket.kind, 'ticket')
    if (ticket.kind !== 'ticket') return
    assert.deepEqual(await store.commitCapture(ticket.ticket, 'candidate-token'), { kind: 'committed' })

    const unfrozen = preparedSpan(await store
      .prepare({ accountRef: ACCOUNT, harnessSessionId: 'session-1', spanEpoch: 1 }, 'resume'))
    assert.deepEqual(unfrozen.pin, { kind: 'empty' })
    assert.equal(unfrozen.created, false)
    assert.equal(unfrozen.wireSessionId, unfrozenRecord.wireSessionId)

    // A restored span with no record at all gets a fresh identity that is on disk before it is
    // returned, with an empty pin.
    const missing = preparedSpan(await store
      .prepare({ accountRef: ACCOUNT, harnessSessionId: 'session-2', spanEpoch: 1 }, 'resume'))
    assert.deepEqual(missing.pin, { kind: 'empty' })
    assert.equal(missing.created, true)
    assert.equal(readFileSync(path, 'utf8').includes(missing.wireSessionId), true)

    // A restart reads the same identities and the same empty pins.
    const reopened = spanStoreAt(path)
    const sameUnfrozen = preparedSpan(await reopened
      .prepare({ accountRef: ACCOUNT, harnessSessionId: 'session-1', spanEpoch: 1 }, 'resume'))
    assert.equal(sameUnfrozen.wireSessionId, unfrozenRecord.wireSessionId)
    assert.deepEqual(sameUnfrozen.pin, { kind: 'empty' })
    const sameMissing = preparedSpan(await reopened
      .prepare({ accountRef: ACCOUNT, harnessSessionId: 'session-2', spanEpoch: 1 }, 'resume'))
    assert.equal(sameMissing.wireSessionId, missing.wireSessionId)
    assert.deepEqual(await reopened.pinFor({ accountRef: ACCOUNT, harnessSessionId: 'session-2', spanEpoch: 1 }),
      { kind: 'pin', pin: { kind: 'empty' } })
    assert.deepEqual(await reopened.freeze({ accountRef: ACCOUNT, harnessSessionId: 'session-1', spanEpoch: 1 }),
      { kind: 'frozen', pin: { kind: 'empty' } })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('the lifecycle establishes the baseline once, and a restart or a rotation does not move it', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'generation.json')
    const generation = generationAt(path)
    const lifecycle = claudeIdentityLifecycle(generation)

    // A request never establishes the identity: before the lifecycle does, there is none.
    assert.deepEqual(await generation.current(), { kind: 'uninitialized' })
    assert.deepEqual(await generation.waitSettled(continuationBudget(50)),
      { kind: 'failed', reason: 'the identity generation is not established' })

    assert.deepEqual(await lifecycle.initialize(), { kind: 'advanced', generation: 0 })
    assert.deepEqual(await generation.current(), { kind: 'ready', generation: 0 })
    // A restart establishes nothing new, and a rotation keeps the account.
    assert.deepEqual(await claudeIdentityLifecycle(generationAt(path)).initialize(), { kind: 'advanced', generation: 0 })
    assert.deepEqual(await lifecycle.rotated(), { kind: 'ready', generation: 0 })
    // The count is per account.
    assert.deepEqual(await generationAt(path, OTHER).current(), { kind: 'uninitialized' })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('one document keeps one generation row per account', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'generation.json')
    assert.deepEqual(await claudeIdentityLifecycle(generationAt(path, ACCOUNT)).initialize(),
      { kind: 'advanced', generation: 0 })
    assert.deepEqual(await claudeIdentityLifecycle(generationAt(path, OTHER)).initialize(),
      { kind: 'advanced', generation: 0 })

    // A change on one account leaves the other account's row exactly where it was.
    const changed = claudeIdentityLifecycle(generationAt(path, ACCOUNT)).changed('login', async () => {})
    assert.deepEqual(await changed.result, { kind: 'advanced', generation: 1 })
    assert.deepEqual(await generationAt(path, OTHER).current(), { kind: 'ready', generation: 0 })
    const document = JSON.parse(readFileSync(path, 'utf8')) as {
      accounts: readonly { accountRef: { ref: string }; generation: number }[]
    }
    assert.equal(document.accounts.length, 2, 'both accounts keep their own row')
    assert.deepEqual(document.accounts.map(entry => entry.generation).sort(), [0, 1])
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a delayed initializer leaves an advanced row alone', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'generation.json')
    const first = generationAt(path)
    assert.deepEqual(await claudeIdentityLifecycle(first).initialize(), { kind: 'advanced', generation: 0 })
    assert.deepEqual(await claudeIdentityLifecycle(first).changed('login', async () => {}).result,
      { kind: 'advanced', generation: 1 })

    // A record that has not read the row yet initializes now: creating the baseline must be a
    // decision inside the lock, so it cannot write zero over the advanced generation.
    const delayed = generationAt(path)
    assert.deepEqual(await claudeIdentityLifecycle(delayed).initialize(), { kind: 'advanced', generation: 1 })
    assert.deepEqual(await first.current(), { kind: 'ready', generation: 1 })
    const document = JSON.parse(readFileSync(path, 'utf8')) as { accounts: readonly { generation: number }[] }
    assert.deepEqual(document.accounts.map(entry => entry.generation), [1])
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a change runs its whole operation inside the gate and opens only after it settles', async () => {
  const root = privateRoot()
  const path = join(root, 'generation.json')
  const generation = generationAt(path)
  const lifecycle = claudeIdentityLifecycle(generation)
  const barrier = deferred()
  try {
    await lifecycle.initialize()

    const observed: boolean[] = []
    const transition = lifecycle.changed('login', async (completion) => {
      observed.push(completion.isGateClosed())
      await barrier.promise
      observed.push(completion.isGateClosed())
    })
    // The gate closed synchronously, before the operation's own work yielded.
    assert.equal(transition.closed, true)
    assert.equal(generation.hasPendingTransition(), true)
    assert.deepEqual(await generation.current(),
      { kind: 'unavailable', code: LOCAL_CONTINUATION_STATE_UNAVAILABLE, reason: 'an identity transition is in flight' })
    // A second change while one is in flight is refused rather than replacing it.
    const second = lifecycle.changed('logout', async () => {})
    assert.equal(second.closed, false)
    assert.deepEqual(await second.result, { kind: 'failed', reason: 'another identity transition is in flight' })

    barrier.resolve()
    // One completion signal covers both the operation and the generation publication.
    assert.deepEqual(await transition.result, { kind: 'advanced', generation: 1 })
    assert.deepEqual(observed, [true, true], 'the gate stayed closed for the whole operation')
    assert.equal(generation.hasPendingTransition(), false)
    assert.deepEqual(await generation.waitSettled(continuationBudget(50)), { kind: 'settled', generation: 1 })
  } finally {
    barrier.resolve()
    await generation.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('an unfinished change is durable, so a new instance refuses the account until one publishes', async () => {
  const root = privateRoot()
  const path = join(root, 'generation.json')
  const writerGeneration = generationAt(path)
  const writer = claudeIdentityLifecycle(writerGeneration)
  // The other instance waits only briefly for the account lock, so the case is about the refusal
  // rather than about how long a short budget takes to elapse.
  const observerGeneration = generationAt(path, ACCOUNT, { lockTimeoutMs: 100 })
  const observer = claudeIdentityLifecycle(observerGeneration)
  const started = deferred()
  const hold = deferred()
  let observerOperations = 0
  try {
    assert.deepEqual(await writer.initialize(), { kind: 'advanced', generation: 0 })
    const transition = writer.changed('logout', async () => {
      started.resolve()
      await hold.promise
    })
    // The statement is durable before the operation runs, so waiting for the operation's start is
    // waiting for the durable fact.
    await started.promise

    // Reads refuse, the lifecycle's baseline action does not clear the statement, and a fresh
    // change cannot begin while the statement says the change may still be running.
    assert.equal((await observerGeneration.current()).kind, 'unavailable')
    assert.equal((await observerGeneration.waitSettled(continuationBudget(50))).kind, 'failed')
    assert.equal((await observer.initialize()).kind, 'failed')
    const blocked = observer.changed('login', async () => { observerOperations += 1 })
    assert.equal(blocked.closed, true)
    assert.equal((await blocked.result).kind, 'failed')
    assert.equal(observerOperations, 0, 'the other instance ran no credential work')

    hold.resolve()
    assert.deepEqual(await transition.result, { kind: 'advanced', generation: 1 })
    assert.deepEqual(await observerGeneration.current(), { kind: 'ready', generation: 1 })
  } finally {
    hold.resolve()
    await writerGeneration.close()
    await observerGeneration.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a live change keeps the account, and the next change counts after it settles', async () => {
  const root = privateRoot()
  const path = join(root, 'generation.json')
  const firstGeneration = generationAt(path)
  const secondGeneration = generationAt(path, ACCOUNT, { lockTimeoutMs: 100 })
  const first = claudeIdentityLifecycle(firstGeneration)
  const second = claudeIdentityLifecycle(secondGeneration)
  const started = deferred()
  const hold = deferred()
  let firstOperations = 0
  let secondOperations = 0
  try {
    await first.initialize()
    const live = first.changed('logout', async () => {
      firstOperations += 1
      started.resolve()
      await hold.promise
    })
    await started.promise

    // The other instance cannot run its own credential work beside the live one, and it publishes
    // nothing while the account is held by a change that has not settled.
    const refused = second.changed('login', async () => { secondOperations += 1 })
    assert.equal((await refused.result).kind, 'failed')
    assert.equal(secondOperations, 0, 'no credential work ran beside the live change')
    assert.equal((await secondGeneration.current()).kind, 'unavailable')

    hold.resolve()
    assert.deepEqual(await live.result, { kind: 'advanced', generation: 1 })
    assert.equal(firstOperations, 1)

    // With the account released, a later change is a real one: its own statement, its own count.
    const later = second.changed('login', async () => { secondOperations += 1 })
    assert.deepEqual(await later.result, { kind: 'advanced', generation: 2 })
    assert.equal(secondOperations, 1)
    assert.deepEqual(await firstGeneration.current(), { kind: 'ready', generation: 2 })
  } finally {
    hold.resolve()
    await firstGeneration.close()
    await secondGeneration.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a lost lock does not authorize taking over a change that may still be running', async () => {
  const root = privateRoot()
  const path = join(root, 'generation.json')
  const liveGeneration = generationAt(path)
  const otherGeneration = generationAt(path, ACCOUNT, { lockTimeoutMs: 100 })
  const live = claudeIdentityLifecycle(liveGeneration)
  const other = claudeIdentityLifecycle(otherGeneration)
  const started = deferred()
  const hold = deferred()
  let otherOperations = 0
  try {
    await live.initialize()
    const transition = live.changed('logout', async () => {
      started.resolve()
      await hold.promise
    })
    await started.promise

    // The account's lock disappears as a dead holder's would; the durable statement does not, and
    // a missing lock is not evidence that the change stopped.
    rmSync(`${path}.transition.lock`, { recursive: true, force: true })

    const refused = other.changed('login', async () => { otherOperations += 1 })
    assert.equal((await refused.result).kind, 'failed')
    assert.equal(otherOperations, 0, 'a missing lock authorized no credential work')
    assert.equal((await otherGeneration.current()).kind, 'unavailable')

    hold.resolve()
    assert.deepEqual(await transition.result, { kind: 'advanced', generation: 1 })
  } finally {
    hold.resolve()
    await liveGeneration.close()
    await otherGeneration.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a failed change is recorded, requests stay refused, and a later lifecycle change replaces it', async () => {
  const root = privateRoot()
  const path = join(root, 'generation.json')
  const writerGeneration = generationAt(path)
  const writer = claudeIdentityLifecycle(writerGeneration)
  try {
    await writer.initialize()
    const failed = await writer.changed('logout', async () => {
      throw new Error('the credential store refused the commit')
    }).result
    assert.equal(failed.kind, 'failed')

    // A process that never saw the failure still refuses to serve the old epoch.
    const freshGeneration = generationAt(path)
    const fresh = claudeIdentityLifecycle(freshGeneration)
    try {
      assert.equal((await freshGeneration.current()).kind, 'unavailable')
      assert.equal((await freshGeneration.waitSettled(continuationBudget(50))).kind, 'failed')
      // A request's own paths never clear it: only a lifecycle change does.
      assert.equal((await fresh.initialize()).kind, 'failed')
      assert.deepEqual(await fresh.changed('login', async () => {}).result, { kind: 'advanced', generation: 1 })
      assert.deepEqual(await freshGeneration.current(), { kind: 'ready', generation: 1 })
    } finally {
      await freshGeneration.close()
    }
  } finally {
    await writerGeneration.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a stale instance cannot publish the generation it would have read before another change', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'generation.json')
    const first = generationAt(path)
    assert.deepEqual(await claudeIdentityLifecycle(first).initialize(), { kind: 'advanced', generation: 0 })

    // The second instance has read nothing yet: its increment must come from the durable row, not
    // from a number it remembered.
    const second = generationAt(path)
    assert.deepEqual(await claudeIdentityLifecycle(first).changed('login', async () => {}).result,
      { kind: 'advanced', generation: 1 })
    assert.deepEqual(await claudeIdentityLifecycle(second).changed('logout', async () => {}).result,
      { kind: 'advanced', generation: 2 })
    assert.deepEqual(await first.current(), { kind: 'ready', generation: 2 })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a request reads the durable row, so another process\'s change is never masked by a cache', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'generation.json')
    const local = generationAt(path)
    assert.deepEqual(await claudeIdentityLifecycle(local).initialize(), { kind: 'advanced', generation: 0 })
    assert.deepEqual(await local.current(), { kind: 'ready', generation: 0 })

    // Another process over the same installation advances the account; a request in this process
    // must observe the new generation rather than its own remembered number.
    const other = generationAt(path)
    assert.deepEqual(await claudeIdentityLifecycle(other).changed('login', async () => {}).result,
      { kind: 'advanced', generation: 1 })
    assert.deepEqual(await local.current(), { kind: 'ready', generation: 1 })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('an uninitialized account cannot run a change, and a blocked record is a fixed refusal', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'generation.json')
    const generation = generationAt(path)
    const lifecycle = claudeIdentityLifecycle(generation)
    // An identity change before the lifecycle established the account cannot invent one.
    const refused = await lifecycle.changed('logout', async () => {}).result
    assert.equal(refused.kind, 'failed')
    if (refused.kind !== 'failed') return
    assert.equal(refused.reason, 'the identity generation is not established')

    // A directory where the document belongs makes every read and write of the record fail.
    const blockedPath = join(root, 'blocked')
    mkdirSync(blockedPath, { recursive: true })
    const blockedGeneration = generationAt(blockedPath)
    const blocked = claudeIdentityLifecycle(blockedGeneration)
    assert.equal((await blocked.initialize()).kind, 'failed')
    const blockedChange = blocked.changed('login', async () => {})
    assert.equal((await blockedChange.result).kind, 'failed')
    // The wait belongs to the record, not to the lifecycle producer.
    assert.equal((await blockedGeneration.waitSettled(continuationBudget(50))).kind, 'failed')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a caller can abort its wait, and its transition is untouched by that abort', async () => {
  const root = privateRoot()
  const path = join(root, 'generation.json')
  const generation = generationAt(path)
  const lifecycle = claudeIdentityLifecycle(generation)
  const started = deferred()
  const barrier = deferred()
  try {
    await lifecycle.initialize()

    const controller = new AbortController()
    // A pre-aborted caller is answered before anything else, even with no transition pending.
    controller.abort()
    assert.deepEqual(await generation.waitSettled(continuationBudget(50, controller.signal)), { kind: 'aborted' })

    // The abort of a wait does not cancel the transition the lifecycle owns.
    const transition = lifecycle.changed('ownership', async () => {
      started.resolve()
      await barrier.promise
    })
    await started.promise
    const waiter = new AbortController()
    const waiting = generation.waitSettled(continuationBudget(20, waiter.signal))
    waiter.abort()
    assert.deepEqual(await waiting, { kind: 'aborted' })
    barrier.resolve()
    assert.deepEqual(await transition.result, { kind: 'advanced', generation: 1 })
  } finally {
    barrier.resolve()
    await generation.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a wait that reaches its bound leaves the account closed until the transition settles', async () => {
  const root = privateRoot()
  const path = join(root, 'generation.json')
  const generation = generationAt(path)
  const lifecycle = claudeIdentityLifecycle(generation)
  const started = deferred()
  const hold = deferred()
  try {
    await lifecycle.initialize()

    const transition = lifecycle.changed('ownership', async () => {
      started.resolve()
      await hold.promise
    })
    await started.promise
    assert.deepEqual(await generation.waitSettled(continuationBudget(20)), { kind: 'timed-out' })
    assert.equal(generation.hasPendingTransition(), true)

    hold.resolve()
    assert.deepEqual(await transition.result, { kind: 'advanced', generation: 1 })
    assert.deepEqual(await generation.waitSettled(continuationBudget(200)), { kind: 'settled', generation: 1 })
  } finally {
    hold.resolve()
    await generation.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('disposal stops new changes and waits for the transition it owns to settle', async () => {
  const root = privateRoot()
  const path = join(root, 'generation.json')
  const generation = generationAt(path)
  const lifecycle = claudeIdentityLifecycle(generation)
  const started = deferred()
  const hold = deferred()
  let operationSettled = false
  let laterOperations = 0
  try {
    await lifecycle.initialize()
    const transition = lifecycle.changed('logout', async () => {
      started.resolve()
      await hold.promise
      operationSettled = true
    })
    await started.promise

    let closeSettled = false
    const closing = generation.close().then(() => { closeSettled = true })
    // Disposal refuses new changes outright, with no effect on the operation it was not given.
    const refused = generation.changed('login', async () => { laterOperations += 1 })
    assert.equal(refused.closed, false)
    assert.equal((await refused.result).kind, 'failed')
    assert.equal(laterOperations, 0)

    // Give disposal's own continuation several turns to (wrongly) finish while the operation is
    // held; the observations below hold whether or not it uses them.
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    assert.equal(operationSettled, false, 'the owned operation is genuinely still held')
    assert.equal(closeSettled, false, 'disposal cannot have observed a settlement that has not happened')

    hold.resolve()
    assert.deepEqual(await transition.result, { kind: 'advanced', generation: 1 })
    await closing
    assert.equal(operationSettled, true)
    assert.equal(closeSettled, true)
  } finally {
    hold.resolve()
    await generation.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('disposal settles after a transition that fails, without pretending it published', async () => {
  const root = privateRoot()
  const path = join(root, 'generation.json')
  const generation = generationAt(path)
  const lifecycle = claudeIdentityLifecycle(generation)
  const hold = deferred()
  let operationSettled = false
  try {
    await lifecycle.initialize()
    const transition = lifecycle.changed('logout', async () => {
      await hold.promise
      operationSettled = true
      throw new Error('the credential store refused the commit')
    })
    const closing = generation.close()
    assert.equal(operationSettled, false)
    hold.resolve()
    assert.equal((await transition.result).kind, 'failed')
    await closing
    assert.equal(operationSettled, true)
    assert.equal((await generation.current()).kind, 'unavailable')
  } finally {
    hold.resolve()
    await generation.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a publication that fails once is settled and recorded, so the next explicit change can begin', async () => {
  const root = privateRoot()
  const path = join(root, 'generation.json')
  // Writes in order: the baseline, the change's statement, its publication.
  const { files, calls } = instrumentedFiles({ failOn: 3 })
  const generation = generationAt(path, ACCOUNT, { files })
  const lifecycle = claudeIdentityLifecycle(generation)
  let firstOperations = 0
  let laterOperations = 0
  try {
    assert.deepEqual(await lifecycle.initialize(), { kind: 'advanced', generation: 0 })
    const first = await lifecycle.changed('logout', async () => { firstOperations += 1 }).result
    assert.equal(first.kind, 'failed')
    assert.equal(firstOperations, 1, 'the credential work ran exactly once')
    // The publication settled as a failure, and that failure is on disk rather than an unknown
    // statement: the failed publication is followed by one recorded failure, and nothing retried.
    assert.equal(calls.writes, 4, 'baseline, statement, failed publication, recorded failure')
    const document = JSON.parse(readFileSync(path, 'utf8')) as {
      accounts: readonly { pending: { kind: string } | null; generation: number }[]
    }
    assert.equal(document.accounts[0]?.pending?.kind, 'failed')
    assert.equal(document.accounts[0]?.generation, 0)

    // The instance that saw it and a fresh one both refuse, and neither clears it by reading.
    assert.equal((await generation.current()).kind, 'unavailable')
    const freshGeneration = generationAt(path)
    try {
      assert.equal((await freshGeneration.current()).kind, 'unavailable')
      assert.equal((await claudeIdentityLifecycle(freshGeneration).initialize()).kind, 'failed')
    } finally {
      await freshGeneration.close()
    }

    // With the I/O fault gone, an explicit lifecycle change publishes; nothing republished by itself.
    const later = await lifecycle.changed('login', async () => { laterOperations += 1 }).result
    assert.deepEqual(later, { kind: 'advanced', generation: 1 })
    assert.equal(laterOperations, 1)
    assert.deepEqual(await generation.current(), { kind: 'ready', generation: 1 })
  } finally {
    await generation.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a deadline that fires while the publication read is pending still reports the generation that lands', async () => {
  const root = privateRoot()
  const path = join(root, 'generation.json')
  const readStarted = deferred()
  const releaseRead = deferred()
  // The third read is the publication's own read, taken just before its in-lock decision.
  const { files, calls } = instrumentedFiles({
    holdReadOn: 3,
    holdRead: releaseRead.promise,
    onRead: (read) => { if (read === 3) readStarted.resolve() },
  })
  const waits = controlledWaits()
  const generation = generationAt(path, ACCOUNT, { files, waits: waits.host, deadlineMs: 30 })
  const lifecycle = claudeIdentityLifecycle(generation)
  let operations = 0
  try {
    assert.deepEqual(await lifecycle.initialize(), { kind: 'advanced', generation: 0 })
    const transition = lifecycle.changed('logout', async () => { operations += 1 })
    await readStarted.promise
    // The publication's read is genuinely pending and exactly one timer is live for it; the clock
    // has not passed the budget, so this case cannot be passing because a short sleep elapsed.
    assert.equal(waits.record.scheduled - waits.record.cancelled, 1, 'one timer is live')
    assert.equal(waits.record.fired, 0, 'no deadline has fired yet')

    // Move the clock past the budget and fire the captured timer: the deadline really fires once.
    waits.advanceBy(1_000)
    waits.fireScheduled()
    assert.equal(waits.record.fired, 1, 'the deadline fired exactly once')
    assert.equal(waits.record.scheduled - waits.record.cancelled, 0, 'the fired wait was disposed')

    // Only now does the owned read settle, and the decision it carries is the one that really lands.
    releaseRead.resolve()
    assert.deepEqual(await transition.result, { kind: 'advanced', generation: 1 })
    assert.equal(operations, 1, 'the credential work ran once')
    assert.equal(calls.writes, 3, 'baseline, statement, one publication')
    assert.equal(calls.reads, 4, 'baseline, statement, held publication read, reconciliation read')
    const document = JSON.parse(readFileSync(path, 'utf8')) as {
      accounts: readonly { generation: number; pending: { kind: string } | null }[]
    }
    assert.equal(document.accounts[0]?.generation, 1)
    assert.equal(document.accounts[0]?.pending, null)
    // Every wait handed out — the two that settled, the fired one and the reconciliation read's —
    // was disposed, and no abort listener was ever subscribed.
    assert.deepEqual(waits.record, { scheduled: 4, cancelled: 4, subscribed: 0, removed: 0, fired: 1 })
    assert.deepEqual(await generation.current(), { kind: 'ready', generation: 1 })
  } finally {
    releaseRead.resolve()
    await generation.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a publication whose failure cannot be recorded keeps refusing instead of reporting ready', async () => {
  const root = privateRoot()
  const path = join(root, 'generation.json')
  // Every write after the change's statement fails, so neither the publication nor its failure
  // statement can land.
  const { files, calls } = instrumentedFiles({ failFrom: 3 })
  const generation = generationAt(path, ACCOUNT, { files })
  const lifecycle = claudeIdentityLifecycle(generation)
  let operations = 0
  try {
    assert.deepEqual(await lifecycle.initialize(), { kind: 'advanced', generation: 0 })
    const first = await lifecycle.changed('logout', async () => { operations += 1 }).result
    assert.equal(first.kind, 'failed')
    assert.equal(operations, 1)
    assert.equal(calls.writes, 4, 'baseline, statement, failed publication, failed failure statement')

    // The record still states an unfinished change, so nothing is served and nothing is taken over.
    const document = JSON.parse(readFileSync(path, 'utf8')) as {
      accounts: readonly { pending: { kind: string } | null }[]
    }
    assert.equal(document.accounts[0]?.pending?.kind, 'active')
    assert.equal((await generation.current()).kind, 'unavailable')
    const later = await lifecycle.changed('login', async () => { operations += 1 }).result
    assert.equal(later.kind, 'failed')
    assert.equal(operations, 1, 'an unknown statement authorized no second credential work')
    assert.equal(calls.writes, 4, 'the refused change attempted no write of its own')
    assert.equal((await generation.current()).kind, 'unavailable')
  } finally {
    await generation.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})
