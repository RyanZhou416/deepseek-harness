/**
 * Bounded slots for log folds behind paged projection reads.
 *
 * A stored Session without a checkpoint row for the paged key folds its log to
 * answer one page. A Client that opens a level reads many child pages at once,
 * and unbounded folds would starve the Session opening that runs beside them.
 * Stored page reads also wait while a Session opening is in progress: an
 * opening is a chain of short awaits that each long synchronous fold delays.
 *
 * @module @deepseek-ai/dsh-api-session-controller/history/fold-slots
 */

/** FIFO slots; a slot passes straight to the next waiter, and a cancelled waiter leaves the queue. */
export class FoldSlots {
  private active = 0
  private readonly waiting: Array<{ readonly grant: () => void }> = []
  private openings = 0
  private quiet = Promise.withResolvers<void>()

  /**
   * Mark one Session opening in progress; reads wait in {@link afterOpenings} until none is.
   * @returns idempotent end of this opening.
   */
  beginOpening(): () => void {
    if (this.openings === 0) this.quiet = Promise.withResolvers<void>()
    this.openings += 1
    let open = true
    return () => {
      if (!open) return
      open = false
      this.openings -= 1
      if (this.openings === 0) this.quiet.resolve()
    }
  }

  /**
   * Wait until no Session opening is in progress.
   * @param signal - cancellation; rejects with its reason.
   * @returns resolution once openings are done.
   */
  async afterOpenings(signal: AbortSignal): Promise<void> {
    while (this.openings > 0) {
      signal.throwIfAborted()
      const aborted = Promise.withResolvers<never>()
      const onAbort = (): void => { aborted.reject(signal.reason) }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        await Promise.race([this.quiet.promise, aborted.promise])
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    }
    signal.throwIfAborted()
  }

  /**
   * @param limit - positive integral number of folds that may run at once.
   */
  constructor(private readonly limit: number) {}

  /**
   * Run one fold in a slot.
   * @param signal - cancellation; a waiter rejects with its reason and never runs.
   * @param task - the fold; its slot is released when it settles.
   * @returns the fold's result.
   */
  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    if (this.active < this.limit) this.active += 1
    else await this.acquire(signal)
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    const granted = Promise.withResolvers<void>()
    // Granting removes the waiter and its abort listener in one step, so a
    // waiter that holds a slot no longer reacts to cancellation.
    const onAbort = (): void => {
      this.waiting.splice(this.waiting.indexOf(waiter), 1)
      granted.reject(signal.reason)
    }
    const waiter = {
      grant: (): void => {
        signal.removeEventListener('abort', onAbort)
        granted.resolve()
      },
    }
    this.waiting.push(waiter)
    signal.addEventListener('abort', onAbort, { once: true })
    await granted.promise
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next === undefined) this.active -= 1
    else next.grant()
  }
}
