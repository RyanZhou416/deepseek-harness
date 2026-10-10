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
 * Giving up is deliberate and safe. A holder that cannot be waited out degrades to running
 * without the lock — the behaviour every consumer had before this existed — because the
 * write-back path already compares the token it expects against the one on disk and refuses
 * to overwrite a rotation it did not make.
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
  const stopRenewal = renewHeldLock(lockPath, owner, timing)
  try {
    return await run()
  } finally {
    stopRenewal()
    await release(lockPath, owner)
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
    const owner = randomUUID()
    let created = false
    try {
      await mkdir(lockPath)
      created = true
      // The token identifies this holder for the whole critical section, so a release can
      // never remove a lock that a later holder took over.
      await writeFile(`${lockPath}/${OWNER_FILE}`, owner, { encoding: 'utf8', mode: 0o600 })
      return owner
    } catch (error) {
      // Only a lock this attempt created may be cleaned up: on EEXIST the directory belongs
      // to a live holder.
      if (created) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
      // A holder that stopped renewing its lease is gone, so its lock is taken away and the
      // attempt repeats at once, as the client does. A lock that cannot be removed is waited
      // out like a live one rather than retried in a tight loop.
      if (await removeIfAbandoned(lockPath, timing)) continue
      await new Promise((resolve) => { setTimeout(resolve, delay) })
      delay = Math.min(delay * 2, timing.maxTimeoutMs)
    }
  }
  return undefined
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
