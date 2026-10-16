/**
 * The continuation stores' shared private-file machinery: owned work, bounded waits and
 * cross-process serialisation.
 *
 * Four properties here are correctness requirements rather than conveniences:
 *
 * 1. One logical deadline bounds the *wait*, never the work. The bound is an absolute instant, so
 *    every step a caller passes it to shares what is left instead of starting a fresh clock, and a
 *    step whose budget already ended refuses before it starts new I/O. A caller that arrives while
 *    this document's operation is still running waits for that operation inside the same absolute
 *    budget and then runs its own change: waiting never adopts the earlier operation's result, and
 *    a wait that ends first starts none of the arriving caller's own I/O. The operation a caller
 *    started stays owned by this helper: it keeps running, it stays on the document's critical
 *    path, and a caller whose own wait ended is told only that the state is unavailable. Such an
 *    operation is uncertain until it really settles, and every later operation on the document is
 *    refused for as long as that lasts, because a decision read from a document a pending write
 *    may still replace is not one the store can vouch for. Once it settles, the document is read
 *    again — this helper never retries a write, or completes one, after the wait that abandoned it
 *    ended. The write runs inside the lock, so a process that honours this lock cannot decide from
 *    the document either while the abandoned work is still writing.
 * 2. Every outcome of a wait — elapsed, timed out, aborted — releases that wait's own timer and
 *    abort listener, so a caller that keeps sending requests accumulates neither.
 * 3. One read-modify-write runs entirely inside the lock this plugin already owns
 *    ({@link withStoreLockOwned}); locking only the write would let two processes read the same
 *    document and each drop the other's change. A lock that cannot be owned is a refusal, not a
 *    degraded unowned run. A held lock refuses under the lock budget, independently of the
 *    logical deadline. The lock's staleness bound is that primitive's own lease semantics: a
 *    holder that does not take this lock is not serialised by it.
 * 4. A document is replaced by one exclusively created owner-only temporary file renamed into
 *    place, so a crash leaves either the old record or the new one, and a failed write removes
 *    only its own temporary file. The document's directory is created first, so the first use in
 *    a directory that does not exist yet is a creation rather than a lock that looks busy.
 *
 * The failure code lives here rather than in one store because every store here reports the same
 * refusal, and a second spelling of it would let a caller route on the wrong one.
 *
 * @module dsh-plugin-subscriptions/providers/claude-continuation-io
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withStoreLockOwned } from '../auth/store-lock.js'
import type { LockTiming } from '../auth/store-lock.js'

/** The fixed refusal every continuation store reports; a caller must then send nothing. */
export const LOCAL_CONTINUATION_STATE_UNAVAILABLE = 'LOCAL_CONTINUATION_STATE_UNAVAILABLE'

/** The failure every continuation store reports. */
export type ContinuationUnavailable = {
  readonly kind: 'unavailable'
  readonly code: typeof LOCAL_CONTINUATION_STATE_UNAVAILABLE
  readonly reason: string
}

/**
 * Build the refusal one operation reports.
 * @param reason - the specific fact the caller must act on; never a credential.
 * @returns the fixed refusal.
 */
export function continuationUnavailable(reason: string): ContinuationUnavailable {
  return { kind: 'unavailable', code: LOCAL_CONTINUATION_STATE_UNAVAILABLE, reason }
}

/**
 * One absolute budget a caller shares across a whole preparation chain.
 *
 * The instant, not a duration, is what makes the budget shared: a step that starts later computes
 * a smaller remaining wait from the same value, so a chain of steps cannot extend the caller's
 * bound by starting each one with a fresh duration. A step whose budget has already ended refuses
 * before it starts new I/O; work that already started stays owned until it really settles.
 */
export interface ContinuationDeadline {
  /** The instant (epoch milliseconds) this budget ends. */
  readonly expiresAt: number
  /** The caller's own cancellation, which ends each wait and never the owned work. */
  readonly signal?: AbortSignal
}

/**
 * Start one absolute budget from a configured duration and the caller's cancellation.
 *
 * A request preparation chain resolves this once and passes the same value to every step.
 * @param deadlineMs - how long the chain may wait, from the configured deadline.
 * @param signal - the caller's own cancellation, when it has one.
 * @returns the budget every step of that chain shares.
 */
export function continuationBudget(deadlineMs: number, signal?: AbortSignal): ContinuationDeadline {
  const expiresAt = Date.now() + Math.max(0, Math.floor(deadlineMs))
  return signal === undefined ? { expiresAt } : { expiresAt, signal }
}

/** Whether a caller's cancellation has already fired; a call re-reads the signal. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

/** What ended a bounded wait. */
export type ContinuationWaitOutcome = 'elapsed' | 'timed-out' | 'aborted'

/** The private file operations one continuation document needs. */
export interface ContinuationFiles {
  /**
   * Create the document's directory when it is not there yet.
   * @param directory - the directory the document lives in.
   */
  ensureDirectory(directory: string): Promise<void>
  /**
   * Read the document.
   * @param path - the document's path.
   * @returns its text, or undefined when it does not exist.
   */
  read(path: string): Promise<string | undefined>
  /**
   * Replace the document with `text`, at owner-only mode.
   * @param path - the document's path.
   * @param text - the complete document text.
   */
  writeAtomic(path: string, text: string): Promise<void>
}

/** The timers, clock and abort listeners one bounded wait uses; a test injects one to control them. */
export interface ContinuationWaitHost {
  /**
   * Read the current instant.
   * @returns epoch milliseconds, from which a remaining budget is computed.
   */
  now(): number
  /**
   * Start a timer.
   * @param delayMs - how long to wait.
   * @param fire - what the elapsed timer calls.
   * @returns the disposer that cancels the timer.
   */
  schedule(delayMs: number, fire: () => void): () => void
  /**
   * Subscribe to a signal's abort.
   * @param signal - the caller's cancellation.
   * @param fire - what an abort calls.
   * @returns the disposer that removes the listener.
   */
  onAbort(signal: AbortSignal, fire: () => void): () => void
}

/** The filesystem this host provides, at owner-only mode. */
export const nodeContinuationFiles: ContinuationFiles = {
  async ensureDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  },
  async read(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8')
    } catch (error: unknown) {
      if (isMissing(error)) return undefined
      throw error
    }
  },
  async writeAtomic(path: string, text: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
      await rename(temporary, path)
    } catch (error: unknown) {
      await rm(temporary, { force: true })
      throw error
    }
  },
}

/** This process's clock, timers and abort listeners. */
export const systemContinuationWaits: ContinuationWaitHost = {
  now(): number {
    return Date.now()
  },
  schedule(delayMs: number, fire: () => void): () => void {
    const timer = setTimeout(fire, Math.max(1, Math.floor(delayMs)))
    return () => { clearTimeout(timer) }
  },
  onAbort(signal: AbortSignal, fire: () => void): () => void {
    signal.addEventListener('abort', fire, { once: true })
    return () => { signal.removeEventListener('abort', fire) }
  },
}

/**
 * The filesystem code a caught failure carries.
 * @param error - the caught value.
 * @returns its code, or a fixed label when it carries none.
 */
export function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && code.length > 0 ? code : 'unknown error'
}

/**
 * Whether a caught failure means the path simply is not there.
 * @param error - the caught value.
 * @returns true when the path was absent.
 */
export function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

/**
 * The lock policy this module's own stores use, derived from the configured lock budget.
 *
 * The staleness bound stays in the same order as the plugin's existing lock policy: a
 * continuation document is tiny and its critical sections are milliseconds, so a longer lease
 * only delays recovering a dead holder. The retry budget is what turns a live holder into a
 * refusal, and it is the configured lock bound rather than the request's deadline.
 * @param lockTimeoutMs - the resolved `continuationStateLockTimeoutMs`.
 * @returns the timing the guarded read-modify-write runs under.
 */
export function continuationLockTiming(lockTimeoutMs: number): LockTiming {
  const budget = Math.max(1, Math.floor(lockTimeoutMs))
  return {
    retries: 3,
    minTimeoutMs: Math.max(1, Math.floor(budget / 8)),
    maxTimeoutMs: Math.max(1, Math.floor(budget / 4)),
    staleMs: Math.max(budget * 4, 120_000),
  }
}

/** What one guarded update left standing. */
export type ContinuationOutcome =
  | {
    readonly kind: 'applied'
    /** The text that stands after the operation, whether or not it was written. */
    readonly text: string
    /** Whether this operation persisted the text; false means it only read. */
    readonly written: boolean
  }
  | ContinuationUnavailable

/** Constructor options for {@link ContinuationIo}. */
export interface ContinuationIoOptions {
  /** The document every operation on this helper reads or replaces. */
  readonly path: string
  /** How long one operation may wait for the owned lock. */
  readonly lockTimeoutMs: number
  /** How long one operation may wait when its caller passes no deadline. */
  readonly deadlineMs: number
  /** The private file operations; absent uses this host's filesystem. */
  readonly files?: ContinuationFiles
  /** The timers and abort listeners; absent uses this process's timers. */
  readonly waits?: ContinuationWaitHost
}

/**
 * One continuation document's owned work.
 *
 * The helper is the document's owner in this process: it starts every read-modify-write under
 * the plugin's own lock, keeps a started operation alive past the caller's wait, refuses new
 * work while an operation that lost its caller is still settling, and can be closed once the
 * plugin is disposed. One caller at a time changes the document: a caller that arrives while
 * another operation runs waits for it under its own budget and then changes the document itself,
 * so two requests that merely overlap are serialised rather than refused.
 */
export class ContinuationIo {
  private readonly path: string
  private readonly lockTimeoutMs: number
  private readonly deadlineMs: number
  private readonly files: ContinuationFiles
  private readonly waits: ContinuationWaitHost
  private readonly settling = new Set<Promise<ContinuationOutcome>>()
  /**
   * Owned work whose caller stopped waiting while its own I/O was still running. Every later
   * operation is refused until each of these really settles, and settlement clears only its own
   * entry.
   */
  private readonly uncertain = new Set<Promise<ContinuationOutcome>>()
  private closed = false

  /**
   * @param options - the document, both configured budgets and the injectable I/O boundary.
   */
  constructor(options: ContinuationIoOptions) {
    this.path = options.path
    this.lockTimeoutMs = options.lockTimeoutMs
    this.deadlineMs = options.deadlineMs
    this.files = options.files ?? nodeContinuationFiles
    this.waits = options.waits ?? systemContinuationWaits
  }

  /**
   * Run one read-modify-write under the plugin's own lock, bounded by the caller's budget.
   *
   * The change runs inside the lock with the document it read, so two processes cannot each read
   * the same document and then drop the other's change. Returning `undefined` leaves the
   * document as it is, which is how a caller reads without writing. A caller whose signal is
   * already aborted, and a caller whose budget has already ended, perform no file operation at
   * all. A caller that arrives while an operation this helper owns is still running waits for it
   * inside the same budget and then runs its own change; a wait that ends first starts none of
   * this caller's work, and an operation whose own caller stopped waiting is refused to every
   * later caller until it really settles.
   * @param change - the pure change, given the current text (undefined when the document is
   *   absent); returning undefined means "write nothing".
   * @param deadline - the absolute budget and cancellation the caller resolved; absent starts one
   *   from the configured deadline and carries no signal.
   * @returns the text that stands, whether it was written, or the fixed refusal.
   */
  async update(
    change: (current: string | undefined) => string | undefined,
    deadline?: ContinuationDeadline,
  ): Promise<ContinuationOutcome> {
    const bound: ContinuationDeadline = deadline ?? this.budget()
    if (isAborted(bound.signal)) {
      return continuationUnavailable('the caller stopped before the continuation state was touched')
    }
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    if (this.remainingMs(bound) <= 0) {
      return continuationUnavailable('the caller\'s budget ended before the continuation state was touched')
    }
    // Admission: wait out the operation that holds the document, then re-read everything that can
    // have changed while waiting. Every check and the admission below run in one synchronous turn,
    // so waiters cannot pass them together, and each waiter reports its own change's result.
    for (;;) {
      if (isAborted(bound.signal)) {
        return continuationUnavailable('the caller stopped waiting before the continuation state settled')
      }
      if (this.closed) return continuationUnavailable('the continuation state is being disposed')
      if (this.uncertain.size > 0) {
        return continuationUnavailable('an earlier continuation state operation has not settled')
      }
      if (this.remainingMs(bound) <= 0) {
        return continuationUnavailable('the continuation state did not settle within the deadline')
      }
      const pending = [...this.settling]
      if (pending.length === 0) break
      const waited = await this.awaitSettlement(Promise.all(pending), bound)
      if (waited !== 'elapsed') {
        return continuationUnavailable(waited === 'aborted'
          ? 'the caller stopped waiting before the continuation state settled'
          : 'the continuation state did not settle within the deadline')
      }
    }
    const owned = this.own(change)
    const outcome = await this.awaitSettlement(owned, bound)
    if (outcome === 'elapsed') return await owned
    // This call's own I/O was still running when its wait ended, so it is uncertain until it really
    // settles: no later caller may decide from the document before then.
    if (this.settling.has(owned)) this.uncertain.add(owned)
    return continuationUnavailable(outcome === 'aborted'
      ? 'the caller stopped waiting before the continuation state settled'
      : 'the continuation state did not settle within the deadline')
  }

  /**
   * Wait for one owned work promise under a budget and the caller's cancellation.
   *
   * The wait's own timer and abort listener are removed on every outcome. Neither outcome
   * cancels the work: the caller learns only that it stopped waiting.
   * @param work - the owned work; it reports its own outcome to its own caller and must not
   *   reject.
   * @param deadline - the absolute budget and cancellation.
   * @returns 'elapsed' when the work settled first, otherwise what ended the wait.
   */
  async awaitSettlement(work: Promise<unknown>, deadline: ContinuationDeadline): Promise<ContinuationWaitOutcome> {
    if (isAborted(deadline.signal)) return 'aborted'
    const signal = deadline.signal
    return await new Promise<ContinuationWaitOutcome>((resolve) => {
      let finished = false
      let cancelTimer: () => void = () => undefined
      let cancelAbort: () => void = () => undefined
      const finish = (outcome: ContinuationWaitOutcome): void => {
        if (finished) return
        finished = true
        cancelTimer()
        cancelAbort()
        resolve(outcome)
      }
      if (signal !== undefined) cancelAbort = this.waits.onAbort(signal, () => { finish('aborted') })
      cancelTimer = this.waits.schedule(Math.max(1, this.remainingMs(deadline)), () => { finish('timed-out') })
      // Subscribing and scheduling before this check closes the window between the caller's own
      // pre-abort check and this subscription: an abort landing in between still ends the wait.
      if (isAborted(signal)) finish('aborted')
      void work.then(() => { finish('elapsed') }, () => { finish('elapsed') })
    })
  }

  /**
   * How much of one budget is left.
   * @param deadline - the caller's absolute budget.
   * @returns the remaining milliseconds, never below zero; zero means no new I/O may start.
   */
  remainingMs(deadline: ContinuationDeadline): number {
    return Math.max(0, deadline.expiresAt - this.waits.now())
  }

  /**
   * Start one budget from this document's configured deadline.
   * @returns the budget one lifecycle step runs under.
   */
  budget(): ContinuationDeadline {
    return { expiresAt: this.waits.now() + this.deadlineMs }
  }

  /**
   * Create the document's directory, so a lock beside the document can be created.
   *
   * This is not owned work: it writes nothing a later read depends on, and repeating it is
   * harmless.
   */
  async ensureDirectory(): Promise<void> {
    await this.files.ensureDirectory(dirname(this.path))
  }

  /**
   * Stop accepting new work and wait for the work already owned to reach real settlement.
   *
   * This is the plugin's dispose obligation: it reports settlement, not success, and each
   * operation's own outcome was already returned to its caller. It must not be awaited from
   * inside an operation this helper owns, and it never pretends a committed write was cancelled.
   * A caller that is waiting for admission when this is called wakes to the closed state and is
   * refused instead of admitted, so no work starts after disposal began. A caller that has to
   * bound its own teardown does so around this call; this never reports a settlement it did not
   * observe.
   */
  async close(): Promise<void> {
    this.closed = true
    await this.drain()
  }

  /**
   * Wait until every operation this helper owns has really settled.
   *
   * Owned work reports its outcome to its caller and never rejects, so this waits for settlement
   * rather than deciding anything about it.
   */
  async drain(): Promise<void> {
    while (this.settling.size > 0) await Promise.all([...this.settling])
  }

  /** Start one owned read-modify-write and keep it tracked until it really settles. */
  private own(change: (current: string | undefined) => string | undefined): Promise<ContinuationOutcome> {
    const work = this.run(change)
    this.settling.add(work)
    const release = (): void => {
      this.settling.delete(work)
      // Real settlement clears this work's own uncertainty mark, and no other.
      this.uncertain.delete(work)
    }
    void work.then(release, release)
    return work
  }

  /** The real operation: create the directory, take the lock, read, change, write. */
  private async run(change: (current: string | undefined) => string | undefined): Promise<ContinuationOutcome> {
    try {
      await this.files.ensureDirectory(dirname(this.path))
      const locked = await withStoreLockOwned(this.path, async () => {
        const current = await this.files.read(this.path)
        const next = change(current)
        if (next === undefined || next === current) return { text: current ?? '', written: false }
        await this.files.writeAtomic(this.path, next)
        return { text: next, written: true }
      }, continuationLockTiming(this.lockTimeoutMs))
      if (!locked.acquired) {
        return continuationUnavailable('the continuation state lock is held by another holder')
      }
      return { kind: 'applied', text: locked.value.text, written: locked.value.written }
    } catch (error: unknown) {
      return continuationUnavailable(`the continuation state could not be used (${errorCode(error)})`)
    }
  }
}
