/** FIFO step-admission gate with concurrency and V8-heap hysteresis. */

interface Waiter {
  readonly signal: AbortSignal
  readonly resolve: (release: () => void) => void
  readonly reject: (reason: unknown) => void
  readonly abort: () => void
}

/** Resolved deployment choices used by {@link StepAdmissionGate}. */
export interface GateConfig {
  readonly maxConcurrentSteps: number
  readonly heapHighWatermarkRatio: number
  readonly heapLowWatermarkRatio: number
  readonly sampleIntervalMs: number
}

/**
 * Serialize admissions through a FIFO queue. Heap pressure uses hysteresis:
 * reaching the high watermark closes admission until a later sample reaches
 * the low watermark. Active steps finish naturally.
 */
export class StepAdmissionGate {
  private readonly waiters: Waiter[] = []
  private active = 0
  private pressured = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed: Error | undefined

  constructor(
    private readonly config: GateConfig,
    private readonly sampleHeapRatio: () => number,
  ) {}

  /**
   * Wait for one step slot. Caller cancellation removes only that waiter.
   * @param signal - owning step cancellation.
   * @returns an idempotent release closure after admission.
   */
  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.closed !== undefined) return Promise.reject(this.closed)
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.waiters.indexOf(waiter)
          /* v8 ignore next -- admitted waiters remove this listener before resolve; a later abort cannot re-enter it. */
          if (index < 0) return
          this.waiters.splice(index, 1)
          reject(signal.reason instanceof Error
            ? signal.reason
            : new Error('memory-admission: admission aborted', { cause: signal.reason }))
          this.drain()
        },
      }
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.waiters.push(waiter)
      this.drain()
    })
  }

  /**
   * Reject queued admissions and stop heap polling. Active release closures remain safe.
   * @param reason - rejection delivered to every queued and later caller.
   */
  close(reason: Error): void {
    if (this.closed !== undefined) return
    this.closed = reason
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(reason)
    }
  }

  private drain(): void {
    if (this.closed !== undefined) return
    while (this.waiters.length > 0 && this.active < this.config.maxConcurrentSteps && !this.heapPressured()) {
      const waiter = this.waiters.shift() as Waiter
      waiter.signal.removeEventListener('abort', waiter.abort)
      /* v8 ignore start -- dequeue and listener removal are synchronous; abort cannot interleave between them. */
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason)
        continue
      }
      /* v8 ignore stop */
      this.active += 1
      let held = true
      waiter.resolve(() => {
        if (!held) return
        held = false
        this.active -= 1
        this.drain()
      })
    }
    if (this.waiters.length > 0) this.armPoll()
  }

  private heapPressured(): boolean {
    const ratio = this.sampleHeapRatio()
    if (this.pressured) {
      if (ratio <= this.config.heapLowWatermarkRatio) this.pressured = false
    } else if (ratio >= this.config.heapHighWatermarkRatio) {
      this.pressured = true
    }
    return this.pressured
  }

  private armPoll(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.drain()
    }, this.config.sampleIntervalMs)
    this.timer.unref()
  }
}
