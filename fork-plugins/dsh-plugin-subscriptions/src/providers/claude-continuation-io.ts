/**
 * The continuation stores' shared private-file machinery: the FIFO queue that owns a document,
 * cancellation that never abandons started work, and cross-process serialisation.
 *
 * Four properties here are correctness requirements rather than conveniences:
 *
 * 1. One document has one queue. A caller waits for every earlier caller to settle, then runs its
 *    own read-modify-write; only its own `AbortSignal` or this helper's disposal ends that wait.
 *    Elapsed time never ends a wait, so a queued request waits for its turn rather than being
 *    refused because a configured duration passed. Arrival order is the order of {@link
 *    ContinuationIo.update} calls, and each admitted caller reads the text its predecessor
 *    committed.
 * 2. A caller cancelled before its turn starts no file work — no directory creation, no read, no
 *    write, no lock. A caller whose operation already started cannot abandon it: it is answered
 *    only after that operation really settled, and that settlement — not the caller's cancellation
 *    — is what admits the next caller. Cancellation changes only the reported outcome.
 * 3. Every read-modify-write runs entirely inside the lock this plugin already owns
 *    ({@link withStoreLockWait}); locking only the write would let two processes read the same
 *    document and each drop the other's change. A held lock is waited out with backoff until it is
 *    released or its expired lease is taken over; a lock that cannot be created at all is a
 *    refusal, not a degraded unowned run. Disposal cancels a lock acquisition, so teardown cannot
 *    wait forever on another process's holder.
 * 4. A document is replaced by one exclusively created owner-only temporary file renamed into
 *    place, so a crash leaves either the old record or the new one, and a failed write removes
 *    only its own temporary file. The document's directory is created first, so the first use in
 *    a directory that does not exist yet is a creation rather than a lock that looks busy.
 *
 * Disposal stops new admissions, wakes every queued caller, cancels lock acquisitions, and resolves
 * only once queued and running work has really settled — it never reports a settlement that did
 * not happen.
 *
 * The failure code lives here rather than in one store because every store here reports the same
 * refusal, and a second spelling of it would let a caller route on the wrong one.
 *
 * @module dsh-plugin-subscriptions/providers/claude-continuation-io
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withStoreLockWait } from '../auth/store-lock.js'
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
 * The accounting instant and cancellation one caller shares across a whole preparation chain.
 *
 * A request preparation chain resolves this once and passes the same value to every step, so the
 * steps share one cancellation. The instant is advisory accounting: a wait ends on settlement, the
 * caller's own cancellation, or disposal, never because the instant passed.
 */
export interface ContinuationDeadline {
  /** The instant (epoch milliseconds) this budget ends; advisory, never a refusal. */
  readonly expiresAt: number
  /** The caller's own cancellation, which ends each wait and never the started work. */
  readonly signal?: AbortSignal
}

/**
 * Start the accounting instant and cancellation one preparation chain shares.
 *
 * @param deadlineMs - the configured duration the chain's accounting starts from.
 * @param signal - the caller's own cancellation, when it has one.
 * @returns the deadline every step of that chain shares.
 */
export function continuationBudget(deadlineMs: number, signal?: AbortSignal): ContinuationDeadline {
  const expiresAt = Date.now() + Math.max(0, Math.floor(deadlineMs))
  return signal === undefined ? { expiresAt } : { expiresAt, signal }
}

/** Whether a caller's cancellation has already fired; a call re-reads the signal. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

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

/**
 * The timers, clock and abort listeners one wait uses; a test injects one to control and observe it.
 *
 * `schedule` is retained for compatibility with the host shape the stores accept, but this module's
 * waits never schedule a timer: a sentinel "infinite" delay is forbidden because Node clamps a
 * delay above 2147483647 ms to 1 ms, which would turn an unbounded wait into an immediate refusal.
 */
export interface ContinuationWaitHost {
  /**
   * Read the current instant.
   * @returns epoch milliseconds, from which a budget's advisory expiry is derived.
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
   * @param signal - the cancellation to observe.
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
 * only delays recovering a dead holder. The backoff is what keeps a live holder from being
 * polled in a tight loop; the cooperative wait itself has no attempt budget, so this no longer
 * turns a live holder into a refusal. The identity transition still takes its own lock through the
 * bounded primitive, which reads `retries`.
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
  /** The backoff and lease input for the document's cooperative lock. */
  readonly lockTimeoutMs: number
  /** Advisory per-operation accounting; it never ends a wait. */
  readonly deadlineMs: number
  /** The private file operations; absent uses this host's filesystem. */
  readonly files?: ContinuationFiles
  /** The timers and abort listeners; absent uses this process's timers. */
  readonly waits?: ContinuationWaitHost
}

/** One caller's place in the queue. */
interface QueueTicket {
  /** Resolves when every earlier caller has settled. */
  readonly turn: Promise<void>
  /** Resolves when this caller has settled, or abandoned its queued turn. */
  readonly done: Promise<void>
  /** Advance the queue; idempotent, and called exactly once per ticket. */
  readonly release: () => void
}

/** What ended a wait for this caller's turn. */
type Admission = 'turn' | 'aborted' | 'disposed'

/**
 * One continuation document's queue and cross-process lock.
 *
 * The helper is the document's owner in this process: it admits one read-modify-write at a time in
 * arrival order, starts each under the plugin's own lock, makes a later caller wait for every
 * earlier operation's real settlement, and can be closed once the plugin is disposed. Only the
 * caller's cancellation or this helper's disposal ends a wait; a configured duration never does.
 */
export class ContinuationIo {
  private readonly path: string
  private readonly lockTimeoutMs: number
  private readonly deadlineMs: number
  private readonly files: ContinuationFiles
  private readonly waits: ContinuationWaitHost
  /** Callers that have enqueued and not yet settled, in arrival order. */
  private readonly tickets = new Set<QueueTicket>()
  /** Queued callers' wake callbacks, run once when disposal starts. */
  private readonly disposalWaiters = new Set<() => void>()
  /** Tripped by {@link close}, so in-flight lock acquisitions stop instead of waiting forever. */
  private readonly disposal = new AbortController()
  /**
   * The tail of the admission chain: resolves once every caller enqueued so far has settled, or
   * abandoned a queued place without starting work.
   */
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  /**
   * @param options - the document, the lock policy and the injectable I/O boundary.
   */
  constructor(options: ContinuationIoOptions) {
    this.path = options.path
    this.lockTimeoutMs = options.lockTimeoutMs
    this.deadlineMs = options.deadlineMs
    this.files = options.files ?? nodeContinuationFiles
    this.waits = options.waits ?? systemContinuationWaits
  }

  /**
   * Run one read-modify-write under the plugin's own lock, after every earlier operation settled.
   *
   * The change runs inside the lock with the document it read, so two processes cannot each read
   * the same document and then drop the other's change. Returning `undefined` leaves the
   * document as it is, which is how a caller reads without writing. A caller whose signal is
   * already aborted starts no file operation, and a caller cancelled while queued starts none
   * either. A caller cancelled after its operation started is answered only once that operation
   * really settled; the started write is not revoked, the next caller is admitted by that
   * settlement, and the answer is the cancellation refusal.
   * @param change - the pure change, given the current text (undefined when the document is
   *   absent); returning undefined means "write nothing".
   * @param deadline - the cancellation the caller resolved; absent carries no signal.
   * @returns the text that stands, whether it was written, or the fixed refusal.
   */
  async update(
    change: (current: string | undefined) => string | undefined,
    deadline?: ContinuationDeadline,
  ): Promise<ContinuationOutcome> {
    const bound: ContinuationDeadline = deadline ?? this.budget()
    const signal = bound.signal
    if (isAborted(signal)) {
      return continuationUnavailable('the caller stopped before the continuation state was touched')
    }
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    const ticket = this.enqueue()
    try {
      const admission = await this.waitForTurn(ticket, signal)
      if (admission === 'aborted') {
        return continuationUnavailable('the caller stopped waiting before the continuation state settled')
      }
      // The closed check shares the turn decision's synchronous continuation: no operation starts
      // after disposal began, and a caller woken by disposal is refused without any file work.
      if (admission === 'disposed' || this.closed) {
        return continuationUnavailable('the continuation state is being disposed')
      }
      const outcome = await this.run(change, signal)
      // The operation reached real settlement; a caller that stopped meanwhile learns only that it
      // stopped. The settlement, not this answer, is what admitted the next caller.
      if (isAborted(signal)) {
        return continuationUnavailable('the caller stopped waiting before the continuation state settled')
      }
      return outcome
    } finally {
      ticket.release()
    }
  }

  /**
   * Start one budget from this document's configured deadline.
   *
   * The instant is advisory accounting; no wait in this module refuses because of it.
   * @returns the budget a caller that passed none runs under.
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
   * Stop accepting new work and wait for the queued and running work to reach real settlement.
   *
   * This is the plugin's dispose obligation: it reports settlement, not success, and each
   * operation's own outcome was already returned to its caller. The closed flag is set in this
   * call's first synchronous turn, so no operation starts after disposal began; every caller
   * waiting for admission is woken and refused without file work; a lock acquisition already in
   * flight is cancelled; and the returned promise resolves only once those callers and the owned
   * operations have really settled. Repeated calls are harmless. It must not be awaited from
   * inside an operation this helper owns, and it never pretends a committed write was cancelled.
   */
  async close(): Promise<void> {
    this.closed = true
    for (const wake of [...this.disposalWaiters]) wake()
    this.disposalWaiters.clear()
    this.disposal.abort()
    await this.drain()
  }

  /**
   * Wait until every caller enqueued at this instant has really settled.
   *
   * A caller's ticket is released only after its operation settled (or after it abandoned a queued
   * place without starting work), so the snapshot covers both queued and running callers and
   * callers admitted after this call cannot extend it. No work rejects, so this waits for
   * settlement rather than deciding anything about it.
   */
  async drain(): Promise<void> {
    const pending = [...this.tickets].map(ticket => ticket.done)
    if (pending.length === 0) return
    await Promise.all(pending)
  }

  /** Take the next FIFO position synchronously, so arrival order is call order. */
  private enqueue(): QueueTicket {
    const turn = this.tail
    let advance!: () => void
    const done = new Promise<void>((resolve) => { advance = resolve })
    // The next caller's turn waits for this ticket's turn as well as its settlement. A caller that
    // stops while queued has settled without starting any work, but its abandoned place must not
    // advance the queue past an earlier operation that has not settled: the next caller still
    // waits for every operation admitted before it.
    this.tail = Promise.all([turn, done]).then(() => undefined)
    let released = false
    const ticket: QueueTicket = {
      turn,
      done,
      release: () => {
        if (released) return
        released = true
        this.tickets.delete(ticket)
        advance()
      },
    }
    this.tickets.add(ticket)
    return ticket
  }

  /**
   * Wait for this caller's turn, its own cancellation, or disposal — whichever comes first.
   *
   * No timer and no polling: the turn is the earlier caller's settlement promise, and disposal is
   * signalled by {@link close}. The abort listener and the disposal wake are removed on every
   * outcome.
   * @param ticket - this caller's queue position.
   * @param signal - the caller's own cancellation, when it has one.
   * @returns what ended the wait.
   */
  private async waitForTurn(ticket: QueueTicket, signal: AbortSignal | undefined): Promise<Admission> {
    if (isAborted(signal)) return 'aborted'
    if (this.closed) return 'disposed'
    return await new Promise<Admission>((resolve) => {
      let finished = false
      let cancelAbort: () => void = () => undefined
      const wakeDisposal = (): void => { finish('disposed') }
      const finish = (outcome: Admission): void => {
        if (finished) return
        finished = true
        cancelAbort()
        this.disposalWaiters.delete(wakeDisposal)
        resolve(outcome)
      }
      this.disposalWaiters.add(wakeDisposal)
      if (signal !== undefined) cancelAbort = this.waits.onAbort(signal, () => { finish('aborted') })
      void ticket.turn.then(() => { finish('turn') }, () => { finish('turn') })
      // Re-read both enders after subscribing: an abort or disposal that landed during this
      // synchronous turn still ends the wait, and nothing here schedules a timer.
      if (isAborted(signal)) finish('aborted')
      else if (this.closed) finish('disposed')
    })
  }

  /**
   * The cancellation one lock acquisition observes: the caller's stop and this helper's disposal.
   *
   * Disposal aborts the acquisition so teardown cannot wait forever on another process's live
   * holder; it never aborts work that already holds the lock, which runs to its own settlement.
   * @param signal - the caller's own cancellation, when it has one.
   * @returns the cancellation to pass to the lock and the disposer that removes its listeners.
   */
  private lockCancellation(signal: AbortSignal | undefined): {
    readonly signal: AbortSignal
    readonly dispose: () => void
  } {
    const disposal = this.disposal.signal
    if (signal === undefined) return { signal: disposal, dispose: () => undefined }
    const controller = new AbortController()
    const stop = (): void => { controller.abort() }
    const cancelCaller = this.waits.onAbort(signal, stop)
    const cancelDisposal = this.waits.onAbort(disposal, stop)
    if (signal.aborted || disposal.aborted) controller.abort()
    return {
      signal: controller.signal,
      dispose: () => {
        cancelCaller()
        cancelDisposal()
      },
    }
  }

  /**
   * The real operation: create the directory, take the lock, read, change, write.
   * @param change - the pure change applied inside the lock.
   * @param signal - the caller's cancellation, when it has one.
   * @returns the applied outcome or the fixed refusal.
   */
  private async run(
    change: (current: string | undefined) => string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ContinuationOutcome> {
    const cancellation = this.lockCancellation(signal)
    try {
      await this.files.ensureDirectory(dirname(this.path))
      const locked = await withStoreLockWait(this.path, async () => {
        const current = await this.files.read(this.path)
        const next = change(current)
        if (next === undefined || next === current) return { text: current ?? '', written: false }
        await this.files.writeAtomic(this.path, next)
        return { text: next, written: true }
      }, continuationLockTiming(this.lockTimeoutMs), cancellation.signal)
      if (locked.kind === 'aborted') {
        return continuationUnavailable(this.closed
          ? 'the continuation state is being disposed'
          : 'the caller stopped waiting before the continuation state settled')
      }
      if (locked.kind === 'unavailable') {
        return continuationUnavailable(`the continuation state could not be used (${locked.reason})`)
      }
      return { kind: 'applied', text: locked.value.text, written: locked.value.written }
    } catch (error: unknown) {
      return continuationUnavailable(`the continuation state could not be used (${errorCode(error)})`)
    } finally {
      cancellation.dispose()
    }
  }
}
