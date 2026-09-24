/** Bounded terminal-job indexes owned by the local registry. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

interface TerminalRef {
  readonly id: JobId
  readonly finishedAt: number
  readonly order: number
}

interface ExpiryRef extends TerminalRef {
  readonly expiresAt: number
}

interface Entry extends ExpiryRef {
  readonly owner: Agent | undefined
  reported: boolean
}

interface Bucket {
  readonly ids: Set<JobId>
  readonly reported: MinHeap<TerminalRef>
}

class MinHeap<T> {
  private values: T[] = []

  constructor(private readonly compare: (left: T, right: T) => number) {}

  get size(): number { return this.values.length }
  peek(): T | undefined { return this.values[0] }

  push(value: T): void {
    const values = this.values
    let index = values.push(value) - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      const before = values[parent] as T
      if (this.compare(before, value) <= 0) break
      values[index] = before
      index = parent
    }
    values[index] = value
  }

  pop(): T | undefined {
    const values = this.values
    const first = values[0]
    const last = values.pop()
    if (values.length === 0 || last === undefined) return first
    let index = 0
    while (true) {
      const left = index * 2 + 1
      if (left >= values.length) break
      const right = left + 1
      const child = right < values.length && this.compare(values[right] as T, values[left] as T) < 0 ? right : left
      const next = values[child] as T
      if (this.compare(last, next) <= 0) break
      values[index] = next
      index = child
    }
    values[index] = last
    return first
  }

  replace(values: readonly T[]): void {
    this.values = []
    for (const value of values) this.push(value)
  }

  clear(): void { this.values = [] }
}

function compareTerminal(left: TerminalRef, right: TerminalRef): number {
  return left.finishedAt - right.finishedAt || left.order - right.order
}

function compareExpiry(left: ExpiryRef, right: ExpiryRef): number {
  return left.expiresAt - right.expiresAt || compareTerminal(left, right)
}

/** Configured terminal retention. Omission of both options retains upstream behavior. */
export class TerminalRetention {
  private readonly entries = new Map<JobId, Entry>()
  private readonly buckets = new Map<Agent | undefined, Bucket>()
  private readonly expiry = new MinHeap<ExpiryRef>(compareExpiry)
  private order = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private scheduledFor: number | undefined
  private pruneTimer: ReturnType<typeof setTimeout> | undefined
  private readonly pendingPrunes = new Set<Agent | undefined>()

  constructor(
    private readonly retentionMs: number | undefined,
    private readonly maxPerOwner: number | undefined,
    private readonly remove: (id: JobId) => void,
  ) {}

  /** Index one settled record after its final output signal; protect it from this settlement's count prune.
   * @param id - settled job identity.
   * @param owner - exact Agent owner, or the unowned bucket.
   * @param finishedAt - settlement time in milliseconds.
   * @param reported - whether a live waiter already received the settlement.
   */
  track(id: JobId, owner: Agent | undefined, finishedAt: number, reported: boolean): void {
    if (this.retentionMs === undefined && this.maxPerOwner === undefined) return
    const entry: Entry = { id, owner, finishedAt, order: ++this.order,
      expiresAt: finishedAt + (this.retentionMs ?? 0), reported }
    this.entries.set(id, entry)
    if (this.maxPerOwner !== undefined) {
      let bucket = this.buckets.get(owner)
      if (bucket === undefined) {
        bucket = { ids: new Set(), reported: new MinHeap(compareTerminal) }
        this.buckets.set(owner, bucket)
      }
      bucket.ids.add(id)
      if (reported) bucket.reported.push(this.terminalRef(entry))
      this.prune(owner, id)
      if (reported && (this.buckets.get(owner)?.ids.size ?? 0) > this.maxPerOwner) this.deferPrune(owner)
    }
    if (this.retentionMs !== undefined) {
      this.expiry.push(this.expiryRef(entry))
      this.armExpiry()
    }
  }

  /** A terminal model read consumed the available output and may satisfy the owner target.
   * @param id - read terminal job identity.
   */
  report(id: JobId): void {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.reported || this.maxPerOwner === undefined) return
    entry.reported = true
    this.buckets.get(entry.owner)?.reported.push(this.terminalRef(entry))
    this.prune(entry.owner)
  }

  /** Remove indexes when the registry drops an owner, explicit id, or retained record.
   * @param id - removed job identity.
   */
  forget(id: JobId): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    this.entries.delete(id)
    const bucket = this.buckets.get(entry.owner)
    if (bucket !== undefined) {
      bucket.ids.delete(id)
      if (bucket.ids.size === 0) this.buckets.delete(entry.owner)
      else if (bucket.reported.size > bucket.ids.size * 2 + 64) {
        bucket.reported.replace([...bucket.ids].flatMap((candidate) => {
          const live = this.entries.get(candidate)
          return live?.reported ? [this.terminalRef(live)] : []
        }))
      }
    }
    if (this.expiry.size > this.entries.size * 2 + 64) {
      this.expiry.replace([...this.entries.values()].map(candidate => this.expiryRef(candidate)))
    }
    if (this.entries.size === 0) {
      this.expiry.clear()
      if (this.timer !== undefined) clearTimeout(this.timer)
      this.timer = undefined
      this.scheduledFor = undefined
    }
  }

  /** Release the sole expiry timer and all transient indexes on service disposal. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.pruneTimer !== undefined) clearTimeout(this.pruneTimer)
    this.timer = undefined
    this.pruneTimer = undefined
    this.scheduledFor = undefined
    this.pendingPrunes.clear()
    this.entries.clear()
    this.buckets.clear()
    this.expiry.clear()
  }

  private prune(owner: Agent | undefined, protectedId?: JobId): void {
    const maximum = this.maxPerOwner
    const bucket = this.buckets.get(owner)
    if (maximum === undefined || bucket === undefined) return
    const protectedRefs: TerminalRef[] = []
    while (bucket.ids.size > maximum) {
      const candidate = bucket.reported.pop()
      if (candidate === undefined) break
      const entry = this.entries.get(candidate.id)
      if (entry === undefined || entry.owner !== owner || !entry.reported || entry.order !== candidate.order) continue
      if (candidate.id === protectedId) {
        protectedRefs.push(candidate)
        continue
      }
      this.forget(candidate.id)
      this.remove(candidate.id)
    }
    if (this.buckets.get(owner) === bucket) {
      for (const candidate of protectedRefs) bucket.reported.push(candidate)
    }
  }

  private deferPrune(owner: Agent | undefined): void {
    this.pendingPrunes.add(owner)
    if (this.pruneTimer !== undefined) return
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = undefined
      const owners = [...this.pendingPrunes]
      this.pendingPrunes.clear()
      for (const pending of owners) this.prune(pending)
    }, 1)
    this.pruneTimer.unref()
  }

  private terminalRef(entry: Entry): TerminalRef {
    return { id: entry.id, finishedAt: entry.finishedAt, order: entry.order }
  }

  private expiryRef(entry: Entry): ExpiryRef {
    return { ...this.terminalRef(entry), expiresAt: entry.expiresAt }
  }

  private armExpiry(): void {
    if (this.retentionMs === undefined) return
    let next = this.expiry.peek()
    while (next !== undefined && this.entries.get(next.id)?.order !== next.order) {
      this.expiry.pop()
      next = this.expiry.peek()
    }
    if (next === undefined) return
    if (this.timer !== undefined && this.scheduledFor !== undefined && this.scheduledFor <= next.expiresAt) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.scheduledFor = next.expiresAt
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.scheduledFor = undefined
      this.expire()
    }, Math.max(1, Math.min(MAX_TIMER_DELAY_MS, next.expiresAt - Date.now())))
    this.timer.unref()
  }

  private expire(): void {
    try {
      let next = this.expiry.peek()
      while (next !== undefined && next.expiresAt <= Date.now()) {
        this.expiry.pop()
        if (this.entries.get(next.id)?.order === next.order) {
          this.forget(next.id)
          this.remove(next.id)
        }
        next = this.expiry.peek()
      }
    } finally {
      this.armExpiry()
    }
  }
}
