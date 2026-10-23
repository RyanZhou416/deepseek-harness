/**
 * A lock file guarding one account's credential store, so two processes sharing an account
 * cannot both rotate its refresh token.
 *
 * The protocol is the one the genuine client uses, taken from its own bundled copy: the
 * lock is a directory created atomically, a holder is considered dead when the directory's
 * modification time is older than the staleness bound, a live holder renews that time so
 * its own lease cannot expire while it works, and a waiter takes a dead holder's lock away
 * and retries. The client applies it to its device-key and job files, and it is what keeps
 * a rotation on one side from invalidating the token the other side just stored.
 *
 * Coordination with Claude Code's own CLI is not claimed: that process locks the paths it
 * owns, and whether it locks this credential file the same way is not established. What this
 * guarantees is that this plugin's own processes serialise, which is the case that arises
 * when several harness instances share one account.
 *
 * An expired lease is the only evidence of death a file lock has. A holder that is alive but
 * frozen for a whole staleness bound can still be taken over, so the guarded work must stay
 * safe when two holders run it at once.
 *
 * Giving up is deliberate and safe for the credential-store call sites. A holder that cannot
 * be waited out degrades to running without the lock — the behaviour every consumer had before
 * this existed — because the write-back path already compares the token it expects against the
 * one on disk and refuses to overwrite a rotation it did not make.
 *
 * A continuation-state read-modify-write cannot degrade that way: running it unowned would let
 * two processes each read the same document and drop the other's change. {@link withStoreLockWait}
 * therefore has no attempt budget. It waits, with asynchronous backoff, until it owns the lock,
 * the caller cancels, or the lock's path cannot be used at all; a live holder is never removed,
 * and only an expired lease is taken over.
 */

import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

/**
 * How long a lock may go untouched before its holder is presumed dead.
 *
 * A holder renews its own lock while it works, so this bounds how long a *dead* holder's
 * lock survives rather than how long the guarded work may take: a refresh slower than this
 * keeps its lock.
 */
const STALE_MS = 120_000

/** The file a holder writes its identity into, inside the lock directory. */
const OWNER_FILE = 'owner'

/** The waiting a holder does before it gives up and runs without the lock. */
export interface LockTiming {
  /** Attempts after the first failure. */
  readonly retries: number
  /** First wait between attempts, doubling up to the cap. */
  readonly minTimeoutMs: number
  /** Cap on the wait between attempts. */
  readonly maxTimeoutMs: number
  /** How long a lock may go untouched before its holder is presumed dead. */
  readonly staleMs: number
}

/** The timing upstream uses, in the same order of magnitude. */
const DEFAULT_TIMING: LockTiming =
  { retries: 10, minTimeoutMs: 100, maxTimeoutMs: 1_000, staleMs: STALE_MS }

/**
 * What {@link withStoreLockOwned} reports: the work's result under an owned lock, or the
 * refusal to run it at all.
 *
 * The two outcomes are separate members rather than an optional value, so a `run` that
 * legitimately answers `undefined` is never read as "the lock was not acquired".
 */
export type StoreLockOutcome<T> = { readonly acquired: true; readonly value: T } | { readonly acquired: false }

/**
 * What {@link withStoreLockWait} reports: the work's result under an owned lock, the caller's
 * cancellation, or the refusal to use the lock's path at all.
 *
 * A live holder never produces `unavailable`, because that wait has no budget to run out.
 * `unavailable` is reserved for a failure of the lock path itself — an ancestor that is not a
 * directory, or a permission the process does not have — so a caller can tell a busy lock from
 * a path it cannot use. `reason` is that failure's errno code, or a fixed label when it has none.
 */
export type StoreLockWaitResult<T> =
  | { readonly kind: 'owned'; readonly value: T }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Run one operation with the lock held for the given resource.
 *
 * @param resourcePath - the file the lock protects; the lock is `${path}.lock`, as upstream
 *   names it.
 * @param run - the work to perform while holding the lock.
 * @param timing - the waiting policy; the default is the one described above.
 * @returns whatever `run` returned.
 */
export async function withStoreLock<T>(
  resourcePath: string,
  run: () => Promise<T>,
  timing: LockTiming = DEFAULT_TIMING,
): Promise<T> {
  const lockPath = `${resourcePath}.lock`
  const owner = await acquire(lockPath, timing)
  if (owner === undefined) return run()
  return await runHeld(lockPath, owner, timing, run)
}

/**
 * Run one operation only while this process owns the lock.
 *
 * Unlike {@link withStoreLock}, a lock that cannot be waited out does NOT degrade to
 * running unowned: the caller is told it did not acquire ownership, so work that must not
 * overlap — spending a refresh grant two processes would invalidate — stops instead of
 * running without mutual exclusion. The wait is bounded by `timing`, so a caller that
 * keeps being refused reports a busy failure rather than blocking forever. Callers that must
 * not report a busy failure at all use {@link withStoreLockWait}, which has no attempt budget.
 *
 * @param resourcePath - the file the lock protects; the lock is `${path}.lock`.
 * @param run - the work to perform while owning the lock; it never starts on refusal.
 * @param timing - the waiting policy; the default is the one described above.
 * @returns the work's outcome, or `{ acquired: false }` when another holder could not be
 *   waited out.
 */
export async function withStoreLockOwned<T>(
  resourcePath: string,
  run: () => Promise<T>,
  timing: LockTiming = DEFAULT_TIMING,
): Promise<StoreLockOutcome<T>> {
  const lockPath = `${resourcePath}.lock`
  const owner = await acquire(lockPath, timing)
  if (owner === undefined) return { acquired: false }
  return { acquired: true, value: await runHeld(lockPath, owner, timing, run) }
}

/**
 * Run one operation only after waiting out every live holder of the lock.
 *
 * Unlike {@link withStoreLockOwned}, this wait has no attempt budget: it ends when this process
 * owns the lock, when `signal` aborts, or when the lock's path cannot be used at all. A live
 * holder is never removed however long it holds; a holder whose lease expired is taken over
 * exactly as the bounded primitives do. Waiting is an asynchronous backoff, and the wait between
 * attempts answers the caller's cancellation, so a cancelled caller returns promptly with none
 * of `run` started and no lock directory created. A cancellation that lands while the lock is
 * being created releases it before returning.
 *
 * @param resourcePath - the file the lock protects; the lock is `${path}.lock`.
 * @param run - the work to perform while owning the lock; it never starts on cancellation or
 *   refusal.
 * @param timing - the backoff and lease policy; `retries` is unused because the wait is
 *   unbounded, and `staleMs` still decides when a holder may be taken over.
 * @param signal - the caller's cancellation; absent means the wait ends only by ownership or by
 *   the lock path failing.
 * @returns the work's result under the lock, the caller's cancellation, or why the lock path
 *   could not be used.
 */
export async function withStoreLockWait<T>(
  resourcePath: string,
  run: () => Promise<T>,
  timing: LockTiming,
  signal?: AbortSignal,
): Promise<StoreLockWaitResult<T>> {
  const lockPath = `${resourcePath}.lock`
  const acquired = await waitForLock(lockPath, timing, signal)
  if (acquired.kind !== 'owned') return acquired
  // A cancellation that landed while the lock was being created must not run the work under a
  // lock this caller no longer needs; the release keeps the directory from leaking.
  if (signal !== undefined && signal.aborted) {
    await release(lockPath, acquired.owner)
    return { kind: 'aborted' }
  }
  return { kind: 'owned', value: await runHeld(lockPath, acquired.owner, timing, run) }
}

/**
 * Run `run` with a held lock, renewing the lease while it works and releasing it afterwards.
 *
 * @param lockPath - the lock directory.
 * @param owner - this holder's token.
 * @param timing - the waiting policy, whose staleness bound sets the renewal period.
 * @param run - the work to perform while holding the lock.
 * @returns whatever `run` returned.
 */
async function runHeld<T>(
  lockPath: string,
  owner: string,
  timing: LockTiming,
  run: () => Promise<T>,
): Promise<T> {
  const stopRenewal = renewHeldLock(lockPath, owner, timing)
  try {
    return await run()
  } finally {
    stopRenewal()
    await release(lockPath, owner)
  }
}

/** What one attempt at creating the lock directory produced. */
type LockAttempt =
  | { readonly kind: 'owned'; readonly owner: string }
  | { readonly kind: 'busy' }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Create the lock directory and name this holder in it.
 *
 * Only a directory this attempt created may be cleaned up, so a failed attempt never removes a
 * holder's lock. A failure other than the directory already existing is a failure of the path
 * itself, which no amount of waiting repairs.
 *
 * @param lockPath - the lock directory.
 * @returns this holder's token, that the lock is held, or why the path could not be used.
 */
async function createLock(lockPath: string): Promise<LockAttempt> {
  const owner = randomUUID()
  let created = false
  try {
    await mkdir(lockPath)
    created = true
    // The token identifies this holder for the whole critical section, so a release can never
    // remove a lock that a later holder took over.
    await writeFile(`${lockPath}/${OWNER_FILE}`, owner, { encoding: 'utf8', mode: 0o600 })
    return { kind: 'owned', owner }
  } catch (error) {
    // Only a lock this attempt created may be cleaned up: on EEXIST the directory belongs
    // to a live holder.
    if (created) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { kind: 'busy' }
    return { kind: 'unavailable', reason: failureCode(error) }
  }
}

/**
 * Take the lock, waiting out a live holder and taking over a dead one.
 *
 * @param lockPath - the lock directory.
 * @param timing - the waiting policy.
 * @returns this holder's token, or undefined when the lock was given up on.
 */
async function acquire(lockPath: string, timing: LockTiming): Promise<string | undefined> {
  let delay = timing.minTimeoutMs
  for (let attempt = 0; attempt <= timing.retries; attempt += 1) {
    const created = await createLock(lockPath)
    if (created.kind === 'owned') return created.owner
    if (created.kind === 'unavailable') return undefined
    // A holder that stopped renewing its lease is gone, so its lock is taken away and the
    // attempt repeats at once, as the client does. A lock that cannot be removed is waited
    // out like a live one rather than retried in a tight loop.
    if (await removeIfAbandoned(lockPath, timing)) continue
    await new Promise((resolve) => { setTimeout(resolve, delay) })
    delay = Math.min(delay * 2, timing.maxTimeoutMs)
  }
  return undefined
}

/** What one unbounded wait for the lock produced. */
type LockAcquisition =
  | { readonly kind: 'owned'; readonly owner: string }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Wait until this process owns the lock, the caller cancels, or the lock's path fails.
 *
 * A failed create is either contention — another holder, whose lease may have expired — or a
 * failure of the path itself. Contention re-reads the lease immediately and takes an expired one
 * over; a live holder is never removed and is simply waited out, with the delay doubling up to
 * `maxTimeoutMs` so a long wait costs no CPU.
 *
 * @param lockPath - the lock directory.
 * @param timing - the backoff and lease policy.
 * @param signal - the caller's cancellation.
 * @returns this holder's token, the caller's cancellation, or why the path could not be used.
 */
async function waitForLock(
  lockPath: string,
  timing: LockTiming,
  signal: AbortSignal | undefined,
): Promise<LockAcquisition> {
  let delay = Math.max(1, Math.floor(timing.minTimeoutMs))
  for (;;) {
    if (signal !== undefined && signal.aborted) return { kind: 'aborted' }
    const created = await createLock(lockPath)
    if (created.kind === 'owned') return created
    if (created.kind === 'unavailable') return created
    if (await removeIfAbandoned(lockPath, timing)) continue
    if (await sleepBeforeRetry(delay, signal) === 'aborted') return { kind: 'aborted' }
    delay = Math.min(delay * 2, Math.max(1, Math.floor(timing.maxTimeoutMs)))
  }
}

/**
 * Wait before the next attempt, ending early when the caller stops waiting.
 *
 * The timer and the abort subscription are both removed on either outcome, so repeated waits
 * accumulate neither. An absent signal waits the whole delay and has nothing to remove.
 *
 * @param delayMs - how long this backoff step waits.
 * @param signal - the caller's cancellation.
 * @returns 'elapsed' when the delay passed, 'aborted' when the caller stopped waiting first.
 */
async function sleepBeforeRetry(delayMs: number, signal: AbortSignal | undefined): Promise<'elapsed' | 'aborted'> {
  if (signal === undefined) {
    await new Promise((resolve) => { setTimeout(resolve, delayMs) })
    return 'elapsed'
  }
  return await new Promise<'elapsed' | 'aborted'>((resolve) => {
    let finished = false
    let cancelTimer: () => void = () => undefined
    let cancelAbort: () => void = () => undefined
    const finish = (outcome: 'elapsed' | 'aborted'): void => {
      if (finished) return
      finished = true
      cancelTimer()
      cancelAbort()
      resolve(outcome)
    }
    const fireAbort = (): void => { finish('aborted') }
    signal.addEventListener('abort', fireAbort, { once: true })
    cancelAbort = () => { signal.removeEventListener('abort', fireAbort) }
    const timer = setTimeout(() => { finish('elapsed') }, delayMs)
    cancelTimer = () => { clearTimeout(timer) }
    // Subscribing before this check closes the window between the caller's abort and this wait.
    if (signal.aborted) finish('aborted')
  })
}

/**
 * The code a failed lock-path operation reports.
 * @param error - the caught failure.
 * @returns its errno code, or a fixed label when it carries none.
 */
function failureCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && code.length > 0 ? code : 'unknown error'
}

/**
 * Take away a lock whose holder stopped renewing it.
 *
 * The staleness read happens again immediately before the removal, so a lock is removed only
 * on a fresh observation that its lease is still expired; the removal is one recursive
 * delete of the lock directory.
 *
 * @param lockPath - the lock directory.
 * @param timing - the waiting policy, whose staleness bound this reads.
 * @returns true when the lock is gone, so the caller may create it again.
 */
async function removeIfAbandoned(lockPath: string, timing: LockTiming): Promise<boolean> {
  if (!await isStale(lockPath, timing)) return false
  await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
  return (await stat(lockPath).catch(() => undefined)) === undefined
}

/**
 * Whether a lock has gone untouched for longer than the staleness bound.
 *
 * @param lockPath - the lock directory.
 * @param timing - the waiting policy, whose staleness bound this reads.
 * @returns true when the holder's lease has expired.
 */
async function isStale(lockPath: string, timing: LockTiming): Promise<boolean> {
  try {
    const info = await stat(lockPath)
    return info.mtime.getTime() < Date.now() - timing.staleMs
  } catch (error) {
    // Only a stat that reports the path absent proves the lock is gone; any other failure
    // leaves it unread, which counts as held so no lock is removed on a guess.
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/**
 * Keep this holder's lease alive for as long as its work runs.
 *
 * A lock's age is its directory's modification time, so a holder whose work outlasts the
 * staleness bound would otherwise look dead and be taken over while it is still working.
 * Renewing at half the bound leaves the other half as scheduling slack.
 *
 * @param lockPath - the lock directory.
 * @param owner - this holder's token.
 * @param timing - the waiting policy, whose staleness bound sets the renewal period.
 * @returns the disposer that stops renewal.
 */
function renewHeldLock(lockPath: string, owner: string, timing: LockTiming): () => void {
  const periodMs = Math.max(1, Math.floor(timing.staleMs / 2))
  const timer = setInterval(() => { void renew(lockPath, owner) }, periodMs)
  return () => { clearInterval(timer) }
}

/**
 * Touch this holder's lock, unless another holder owns it now.
 *
 * A lock taken over after this holder was presumed dead belongs to that holder and must not
 * be kept alive from here, so the owner file decides whether the touch happens.
 *
 * @param lockPath - the lock directory.
 * @param owner - this holder's token.
 */
async function renew(lockPath: string, owner: string): Promise<void> {
  const current = await readFile(`${lockPath}/${OWNER_FILE}`, 'utf8').catch(() => undefined)
  if (current !== owner) return
  const now = new Date()
  // A lock removed underneath this holder fails the touch with ENOENT; the work in flight is
  // unaffected, and the release that follows removes nothing.
  await utimes(lockPath, now, now).catch(() => undefined)
}

/**
 * Release the lock.
 *
 * @param lockPath - the lock directory.
 */
async function release(lockPath: string, owner: string): Promise<void> {
  // Only the holder that still owns the lock removes it: a lock taken over after this
  // holder was presumed dead belongs to someone else.
  const current = await readFile(`${lockPath}/${OWNER_FILE}`, 'utf8').catch(() => undefined)
  if (current !== owner) return
  await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
}
