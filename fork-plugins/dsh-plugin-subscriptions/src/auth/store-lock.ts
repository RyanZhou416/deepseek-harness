/**
 * A lock file guarding one account's credential store, so two processes sharing an account
 * cannot both rotate its refresh token.
 *
 * The protocol is the one the genuine client uses, taken from its own bundled copy: the
 * lock is a directory created atomically, a holder is considered dead when the directory's
 * modification time is older than the staleness bound, and the release removes it. The
 * client applies it to its device-key and job files, and it is what keeps a rotation on one
 * side from invalidating the token the other side just stored.
 *
 * Coordination with Claude Code's own CLI is not claimed: that process locks the paths it
 * owns, and whether it locks this credential file the same way is not established. What this
 * guarantees is that this plugin's own processes serialise, which is the case that arises
 * when several harness instances share one account.
 *
 * Giving up is deliberate and safe. A holder that cannot be waited out degrades to running
 * without the lock — the behaviour every consumer had before this existed — because the
 * write-back path already compares the token it expects against the one on disk and refuses
 * to overwrite a rotation it did not make.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

/**
 * How long a lock may go untouched before its holder is presumed dead.
 *
 * A holder touches its own lock while it works, so this bounds how long a *dead* holder's
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
  try {
    return await run()
  } finally {
    if (owner !== undefined) await release(lockPath, owner)
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
      if (await isStale(lockPath, timing)) {
        // The holder is gone; the client removes such a lock and retries immediately.
        continue
      }
      await new Promise((resolve) => { setTimeout(resolve, delay) })
      delay = Math.min(delay * 2, timing.maxTimeoutMs)
    }
  }
  return undefined
}

/**
 * Whether a lock has gone untouched for longer than the staleness bound.
 *
 * @param lockPath - the lock directory.
 * @param timing - the waiting policy, whose staleness bound this reads.
 * @returns true when the holder may be presumed dead.
 */
async function isStale(lockPath: string, timing: LockTiming): Promise<boolean> {
  try {
    const info = await stat(lockPath)
    return info.mtime.getTime() < Date.now() - timing.staleMs
  } catch {
    // Vanished between the failed create and this stat: the next attempt can take it.
    return true
  }
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
