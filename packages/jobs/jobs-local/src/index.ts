/**
 * Process-local provider for the background-job capability seam
 * (`ctx.jobs`). It keeps every record in memory and hands out fresh
 * snapshots, never live state.
 *
 * Registrations outlive producer and controller fibers. Agent or service
 * disposal cancels live work and awaits compliant producers; a throwing
 * teardown cancel force-fails only the record and reports a possible orphan.
 * @module @deepseek-ai/dsh-jobs-local
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AnonymousEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeLayer } from '@deepseek-ai/dsh-scope'
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { JobRegistry, JobId } from '@deepseek-ai/dsh-jobs'
import type {
  JobDoneListener, JobKind, JobOutcome, JobRead, JobSnapshot, JobStart, JobStatus,
  JobsChangedListener,
} from '@deepseek-ai/dsh-jobs'

/** Timeout code that distinguishes a bounded wait from caller cancellation. */
export const TASK_WAIT_TIMEOUT = 'TASK_WAIT_TIMEOUT'

/** Default maximum number of active jobs in one exact-owner bucket. */
const DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER = 10

/** Configuration for the process-local job registry. */
export interface Config {
  /**
   * Maximum `running` plus `stopping` jobs per exact owner or in the shared unowned bucket;
   * omission defaults to 10.
   */
  maxConcurrentJobsPerOwner?: number
  /**
   * Milliseconds to retain a terminal job before removing it, whether or not
   * its result was reported. Omission preserves terminal jobs until owner or
   * service disposal.
   */
  terminalJobRetentionMs?: number
  /**
   * Target maximum terminal jobs retained per exact owner or in the shared
   * unowned bucket. Count pruning removes only reported records; unreported
   * records remain until {@link terminalJobRetentionMs} expires or teardown.
   * Omission disables count pruning.
   */
  maxRetainedTerminalJobsPerOwner?: number
}

/** The registry's mutable per-job record (never handed out — see {@link LocalJobRegistry.snapshot}). */
interface TrackedTask {
  id: JobId
  kind: JobKind
  label: string
  outputLimitBytes: number | undefined
  /** Exact lifecycle owner; session-id authorization is derived from it. */
  owner: Agent | undefined
  cancel: (reason?: string) => void
  readOutput: (() => string) | undefined
  /** Whether reads use consuming producer output rather than replayable final output. */
  streamOutput: boolean
  status: JobStatus
  detail: string | undefined
  output: string | undefined
  /** Stable Map insertion order used to break equal-finish-time retention ties. */
  registrationOrder: number
  startedAt: number
  finishedAt: number | undefined
  reported: boolean
  /** Whether this terminal record contributes to its owner's indexed count. */
  terminalIndexed: boolean
  /** Whether one lightweight candidate exists in the owner's reported heap. */
  reportedIndexed: boolean
  /** Resolves once the terminal snapshot is recorded and listeners notified. */
  settled: Promise<void>
  /** Resolver for {@link settled}, called by the first effective settlement. */
  markSettled: () => void
  /** Live waits; settlement with a waiter marks the job reported. */
  waiters: number
  /** Removable resolvers for live waits; timeout/abort unregister before the job settles. */
  waitResolvers: Set<() => void>
}

/** True for the three terminal {@link JobStatus} values. */
function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

/** Lightweight terminal identity retained by ordered indexes after a job is removed. */
interface TerminalRef {
  readonly id: JobId
  readonly finishedAt: number
  readonly registrationOrder: number
}

/** One terminal deadline in the process-wide expiry heap. */
interface ExpiryRef extends TerminalRef {
  readonly expiresAt: number
}

/** Incremental terminal state for one exact owner or the shared unowned bucket. */
interface TerminalBucket {
  count: number
  readonly reported: MinHeap<TerminalRef>
}

/** Minimal binary min-heap used by the private retention indexes. */
class MinHeap<T> {
  private readonly values: T[] = []

  constructor(private readonly compare: (left: T, right: T) => number) {}

  peek(): T | undefined {
    return this.values[0]
  }

  push(value: T): void {
    const values = this.values
    let index = values.push(value) - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      const parentValue = values[parent] as T
      if (this.compare(parentValue, value) <= 0) break
      values[index] = parentValue
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
      let child = left
      if (right < values.length
        && this.compare(values[right] as T, values[left] as T) < 0) child = right
      const childValue = values[child] as T
      if (this.compare(last, childValue) <= 0) break
      values[index] = childValue
      index = child
    }
    values[index] = last
    return first
  }

  clear(): void {
    this.values.length = 0
  }
}

/** Oldest terminal first, preserving the former stable Map-order tie break. */
function compareTerminalRef(left: TerminalRef, right: TerminalRef): number {
  return left.finishedAt - right.finishedAt
    || left.registrationOrder - right.registrationOrder
}

/** Nearest expiry first, with the same stable terminal tie break. */
function compareExpiryRef(left: ExpiryRef, right: ExpiryRef): number {
  return left.expiresAt - right.expiresAt || compareTerminalRef(left, right)
}

/**
 * One scope's contributions: the job controllers attached from it and the
 * completion listeners registered there. Both tables are anonymous because a
 * contribution is identified by its own disposer, never by a name a second
 * registrant could shadow.
 */
class JobLayer implements ScopeLayer {
  readonly controllers = new AnonymousEntries<symbol>()
  readonly listeners = new AnonymousEntries<JobDoneListener>()
  readonly changed = new AnonymousEntries<JobsChangedListener>()

  isEmpty(): boolean {
    return this.controllers.isEmpty() && this.listeners.isEmpty() && this.changed.isEmpty()
  }
}

/**
 * The in-memory `jobs` registry. See the Service Definition contract in
 * `@deepseek-ai/dsh-jobs` for the ownership, isolation, and lifecycle
 * semantics this implementation honors.
 */
export class LocalJobRegistry extends JobRegistry {
  static Config: z<Config> = z.object({
    maxConcurrentJobsPerOwner: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER),
    terminalJobRetentionMs: z.number()
      .step(1)
      .min(1)
      .max(MAX_TIMER_DELAY_MS),
    maxRetainedTerminalJobsPerOwner: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER),
  })

  /** Schemastery-defaulted active-job limit. */
  private readonly maxConcurrentJobsPerOwner: number
  /** Optional wall-clock expiry for terminal records. */
  private readonly terminalJobRetentionMs: number | undefined
  /** Optional per-owner target for reported terminal records. */
  private readonly maxRetainedTerminalJobsPerOwner: number | undefined
  private store = new Map<JobId, TrackedTask>()
  private counters = new Map<string, number>()
  private nextRegistrationOrder = 0
  /** Exact-owner terminal counts and oldest-reported candidate heaps. */
  private readonly terminalBuckets = new Map<Agent | undefined, TerminalBucket>()
  /** Process-wide terminal deadlines; removed jobs leave only lightweight stale refs. */
  private readonly expiry = new MinHeap<ExpiryRef>(compareExpiryRef)
  /**
   * Surfaces and listeners layered by the scope that registered them, in the
   * tools-registry shape: a contribution files into its registering context's
   * scope, and a read unions the global layer with the reader's scope chain.
   *
   * The registry is one process-wide instance serving every composition, so a
   * flat table would answer a per-owner question process-wide: one preset's
   * job controls would hold `start()` open for an agent whose own composition
   * loads none, and one settlement would reach every preset's notice listener.
   * Layers make both reads owner-relative. Nothing derives a cache from a
   * layer, so change notification is a no-op.
   */
  private readonly layers = new ScopedLayers<JobLayer>(() => new JobLayer(), () => {})
  private listenersClosed = false
  /** One service-owned timer shared by deferred count pruning and terminal expiry. */
  private retentionTimer: ReturnType<typeof setTimeout> | undefined
  private retentionTimerDeadline: number | undefined
  /** Owners whose newly reported terminals receive one next-task count prune. */
  private readonly deferredPruneOwners = new Set<Agent | undefined>()
  /** Owner agents with attached scope cleanup, mapped to the exact disposer. */
  private ownerCleanups = new Map<Agent, () => Promise<void> | void>()
  /** Service context used by detached settlement continuations and teardown. */
  private readonly selfCtx: Context

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery validates and fills the default before constructing the service.
    this.maxConcurrentJobsPerOwner = (config as Required<Config>).maxConcurrentJobsPerOwner
    this.terminalJobRetentionMs = config.terminalJobRetentionMs
    this.maxRetainedTerminalJobsPerOwner = config.maxRetainedTerminalJobsPerOwner
    this.selfCtx = ctx
    ctx.effect(() => () => this.disposeAll(), 'jobs teardown')
  }

  start(spec: JobStart): JobId {
    if (!this.servesOwner(spec.owner)) {
      throw new Error('background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)')
    }
    if (spec.kind.length === 0) throw new Error('invalid job kind: expected a non-empty string')
    if (spec.label.length === 0) throw new Error('invalid job label: expected a non-empty string')
    if (spec.outputLimitBytes !== undefined
      && (!Number.isSafeInteger(spec.outputLimitBytes) || spec.outputLimitBytes <= 0)) {
      throw new Error(`invalid outputLimitBytes: expected a positive safe integer, got ${JSON.stringify(spec.outputLimitBytes)}`)
    }
    if (spec.owner !== undefined) this.ensureOwnerCleanup(spec.owner)

    const active = this.activeTaskCount(spec.owner)
    if (active >= this.maxConcurrentJobsPerOwner) {
      throw new Error(
        `background job limit reached for this owner (limit: ${this.maxConcurrentJobsPerOwner}); use job_kill to stop an unneeded job, wait for it to finish, then retry`,
      )
    }

    const hooks = spec.run()
    const count = (this.counters.get(spec.kind) ?? 0) + 1
    this.counters.set(spec.kind, count)
    const id = JobId(`${spec.kind}-${count}`)

    let markSettled!: () => void
    const settled = new Promise<void>((resolve) => { markSettled = resolve })
    const job: TrackedTask = {
      id,
      kind: spec.kind,
      label: spec.label,
      outputLimitBytes: spec.outputLimitBytes,
      owner: spec.owner,
      cancel: hooks.cancel.bind(hooks),
      readOutput: hooks.readOutput?.bind(hooks),
      streamOutput: hooks.readOutput !== undefined,
      status: 'running',
      detail: undefined,
      output: undefined,
      registrationOrder: this.nextRegistrationOrder++,
      startedAt: Date.now(),
      finishedAt: undefined,
      reported: false,
      terminalIndexed: false,
      reportedIndexed: false,
      settled,
      markSettled,
      waiters: 0,
      waitResolvers: new Set(),
    }
    this.store.set(id, job)

    void hooks.done.then(
      (outcome) => { this.settle(job, outcome) },
      (error: unknown) => {
        // Contain a producer contract violation (`done` rejected) so cleanup and waiters cannot hang.
        this.selfCtx.logger.warn(`jobs: job ${job.id} producer done promise rejected (producer contract violation): ${String(error)}`)
        this.settle(job, { status: 'failed', detail: String(error) })
      },
    )
    // Registration is complete and cannot fail from here, so the visible set
    // has genuinely changed.
    this.notifyChanged(job.owner)
    return id
  }

  list(caller?: Agent): JobSnapshot[] {
    const session = caller?.id
    return [...this.store.values()]
      .filter(job => job.owner === undefined || job.owner.id === session)
      .map(job => this.snapshot(job))
  }

  get(id: JobId, caller?: Agent): JobSnapshot {
    const job = this.expect(id)
    this.assertAccess(job, caller)
    return this.snapshot(job)
  }

  read(id: JobId, caller?: Agent): JobRead {
    const job = this.expect(id)
    this.assertAccess(job, caller)
    const readOutput = job.readOutput
    const text = readOutput !== undefined
      ? readOutput()
      : job.streamOutput ? '' : isTerminal(job.status) ? job.output ?? '' : ''
    if (!isTerminal(job.status)) return { text, snapshot: this.snapshot(job) }
    // A terminal stream cannot produce more bytes after `done`; its first
    // successful read consumed the remaining delta, so release the producer
    // closure while preserving subsequent empty reads.
    if (readOutput !== undefined) job.readOutput = undefined
    return { text, snapshot: this.reportTerminal(job) }
  }

  kill(id: JobId, caller?: Agent, reason?: string): 'requested' | 'already-finished' {
    const job = this.expect(id)
    this.assertAccess(job, caller)
    if (isTerminal(job.status)) {
      this.reportTerminal(job, true)
      return 'already-finished'
    }
    // Cancel first so a throw leaves both lifecycle and notice state unchanged.
    job.cancel(reason)
    job.status = 'stopping'
    job.reported = true
    this.notifyChanged(job.owner)
    return 'requested'
  }

  async wait(id: JobId, timeoutMs: number, caller?: Agent, signal?: AbortSignal): Promise<JobSnapshot> {
    const job = this.expect(id)
    this.assertAccess(job, caller)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`invalid wait timeout: expected a positive number of milliseconds, got ${JSON.stringify(timeoutMs)}`)
    }
    if (!isTerminal(job.status)) {
      if (signal?.aborted) throw new Error('wait aborted')
      // Abort removes the waiter synchronously so same-tick settlement cannot
      // suppress a notice for a wait that will reject.
      job.waiters += 1
      let counted = true
      const uncount = (): void => {
        if (!counted) return
        counted = false
        job.waiters -= 1
      }
      try {
        // The scoped deadline distinguishes a successful wait timeout from
        // caller cancellation and clears its timer on every exit.
        using d = deadline(signal, timeoutMs, TASK_WAIT_TIMEOUT)
        await new Promise<void>((resolve, reject) => {
          const onSettled = (): void => {
            job.waitResolvers.delete(onSettled)
            d.signal.removeEventListener('abort', onAbort)
            resolve()
          }
          const onAbort = (): void => {
            job.waitResolvers.delete(onSettled)
            // A settled job cannot reach here: settlement releases every waiter
            // before it announces completion, and each released waiter detaches
            // this listener in the same synchronous span, so nothing that reacts
            // to a settlement can abort a wait the settlement already owed.
            if (timeoutOf(d.signal, TASK_WAIT_TIMEOUT) !== undefined) {
              resolve()
            } else {
              uncount()
              reject(new Error('wait aborted'))
            }
          }
          job.waitResolvers.add(onSettled)
          d.signal.addEventListener('abort', onAbort, { once: true })
        })
      } finally {
        uncount()
      }
    }
    return isTerminal(job.status) ? this.reportTerminal(job, true) : this.snapshot(job)
  }

  onJobDone(listener: JobDoneListener): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.listeners.append(listener),
      { label: 'jobs.onJobDone()' },
    )
  }

  onJobsChanged(listener: JobsChangedListener): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.changed.append(listener),
      { label: 'jobs.onJobsChanged()' },
    )
  }

  attachController(name: string): () => void {
    // One token per call keeps duplicate labels independently disposable.
    const token = Symbol(name)
    return this.layers.effect(
      this.ctx,
      layer => layer.controllers.append(token),
      { label: 'jobs.attachController()' },
    )
  }

  /**
   * Whether an attached job controller can collect and stop work owned by
   * `owner`. The global layer holds every controller attached from an unscoped
   * context — a host composition's own controls — and therefore serves every
   * owner; a scoped controller serves exactly the agents composed under it.
   * @param owner - the job's owner, or undefined for unowned work.
   * @returns whether some reachable controller serves the owner.
   */
  private servesOwner(owner?: Agent): boolean {
    if (!this.layers.global.controllers.isEmpty()) return true
    return this.layers.chainLayers(owner === undefined ? undefined : scopeOf(owner.ctx))
      .some(layer => !layer.controllers.isEmpty())
  }

  /** Count authoritative active records for one exact owner or the shared unowned bucket. */
  private activeTaskCount(owner: Agent | undefined): number {
    let count = 0
    for (const job of this.store.values()) {
      if (job.owner === owner && (job.status === 'running' || job.status === 'stopping')) count += 1
    }
    return count
  }

  /**
   * The completion listeners that own `owner`'s notices: the global layer's
   * first, then each scoped layer along the owner's chain. A listener outside
   * that chain belongs to another composition and must not deliver, or the
   * owner reads one notice per mounted preset.
   * @param owner - the settled job's owner, or undefined for unowned work.
   * @returns the listeners to notify, in registration order per layer.
   */
  private *listenersFor(owner?: Agent): IterableIterator<JobDoneListener> {
    yield* this.layers.global.listeners.values()
    const scope = owner === undefined ? undefined : scopeOf(owner.ctx)
    for (const layer of this.layers.chainLayers(scope)) yield* layer.listeners.values()
  }

  /** Look up a job or fail loud. */
  private expect(id: JobId): TrackedTask {
    const job = this.store.get(id)
    if (job === undefined) throw new Error(`unknown job ${id}`)
    return job
  }

  /**
   * The isolation fence: a job with an owner is reachable only by callers
   * whose session id matches (`!== undefined` semantics — an unowned job is
   * open, and a no-agent caller can never match an owned one).
   */
  private assertAccess(job: TrackedTask, caller?: Agent): void {
    if (job.owner !== undefined && job.owner.id !== caller?.id) {
      throw new Error(`job ${job.id} belongs to another session`)
    }
  }

  /** Project a fresh read-only snapshot from the mutable record. */
  private snapshot(job: TrackedTask): JobSnapshot {
    const ownerSession = job.owner?.id
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      ...job.outputLimitBytes !== undefined ? { outputLimitBytes: job.outputLimitBytes } : {},
      ...ownerSession !== undefined ? { ownerSession } : {},
      status: job.status,
      ...job.detail !== undefined ? { detail: job.detail } : {},
      startedAt: job.startedAt,
      ...job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {},
      reported: job.reported,
    }
  }

  /**
   * Mark one terminal result collected and apply count retention. Wait and
   * kill callers defer pruning one task so their immediate read/get can finish.
   */
  private reportTerminal(job: TrackedTask, deferPrune = false): JobSnapshot {
    job.reported = true
    this.indexReportedTerminal(job)
    const snapshot = this.snapshot(job)
    if (deferPrune) this.scheduleReportedPrune(job.owner)
    else if (this.pruneReportedTerminals(job.owner)) this.notifyChanged(job.owner)
    return snapshot
  }

  /** Batch deferred count pruning behind the current tool operation. */
  private scheduleReportedPrune(owner: Agent | undefined): void {
    if (this.maxRetainedTerminalJobsPerOwner === undefined || this.listenersClosed) return
    this.deferredPruneOwners.add(owner)
    this.scheduleRetentionTimer(Date.now())
  }

  /**
   * The change observers that own `owner`'s updates, resolved exactly like
   * {@link listenersFor}: the global layer — a host composition's own carrier,
   * which serves every owner — then each scoped layer along the owner's chain.
   * An observer outside that chain belongs to another composition and would
   * otherwise be told about agents it does not compose.
   * @param owner - the owner whose visible set moved, or undefined for unowned work.
   * @returns the observers to notify, in registration order per layer.
   */
  private *changedFor(owner?: Agent): IterableIterator<JobsChangedListener> {
    yield* this.layers.global.changed.values()
    const scope = owner === undefined ? undefined : scopeOf(owner.ctx)
    for (const layer of this.layers.chainLayers(scope)) yield* layer.changed.values()
  }

  /**
   * Announce that one owner's visible set changed. Each listener is contained
   * so an observer cannot break a lifecycle commit that already happened.
   */
  private notifyChanged(owner: Agent | undefined): void {
    for (const listener of this.changedFor(owner)) {
      try {
        listener(owner)
      } catch (error: unknown) {
        this.selfCtx.logger.warn(`jobs: onJobsChanged listener threw: ${String(error)}`)
      }
    }
  }

  /**
   * Record the first terminal outcome, release waiters, then announce
   * completion. First-wins preserves a teardown force-failure against late
   * producer settlement. Pending waits mark the job reported before listeners
   * run. Completion is announced last because a reporter may open a model turn
   * synchronously: every other observer of this settlement must already have
   * seen the committed record.
   */
  private settle(job: TrackedTask, outcome: JobOutcome): void {
    if (isTerminal(job.status)) return
    job.status = outcome.status
    job.detail = outcome.detail
    job.output = outcome.output
    job.finishedAt = Date.now()
    // Terminal records never call cancel again. Drop its bound hooks object,
    // which can otherwise retain producer resources until owner teardown.
    job.cancel = () => {}
    if (job.waiters > 0) job.reported = true
    this.indexTerminal(job)
    const snapshot = this.snapshot(job)
    const waitResolvers = [...job.waitResolvers]
    job.waitResolvers.clear()
    for (const resolveWait of waitResolvers) resolveWait()
    job.markSettled()
    this.notifyChanged(job.owner)
    // Publish any count-driven removal before completion: a reporter may open
    // a model turn synchronously and must see the final visible set. Protect
    // the just-settled id for a waiter that was released above.
    if (this.pruneReportedTerminals(job.owner, job.id)) this.notifyChanged(job.owner)
    if (this.listenersClosed) return
    for (const listener of this.listenersFor(job.owner)) {
      try {
        const returned = listener(snapshot, job.owner)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.selfCtx.logger.warn(`jobs: onJobDone listener rejected for ${job.id}: ${String(error)}`)
        })
      } catch (error: unknown) {
        this.selfCtx.logger.warn(`jobs: onJobDone listener threw for ${job.id}: ${String(error)}`)
      }
    }
    this.armNextTerminalExpiry()
  }

  /**
   * Remove the oldest reported terminal records until one owner bucket reaches
   * its configured target. Live and unreported records are never candidates.
   * @param owner - exact lifecycle owner, or undefined for the shared unowned bucket.
   * @param protectedId - a just-settled id that an already-released waiter may read next.
   * @returns whether the visible set changed.
   */
  private pruneReportedTerminals(owner: Agent | undefined, protectedId?: JobId): boolean {
    const maximum = this.maxRetainedTerminalJobsPerOwner
    if (maximum === undefined) return false
    const bucket = this.terminalBuckets.get(owner)
    if (bucket === undefined) return false
    this.discardStaleReportedHead(owner, bucket)
    let excess = bucket.count - maximum
    if (excess <= 0) return false
    let changed = false
    const blocked: TerminalRef[] = []
    while (excess > 0) {
      const candidate = bucket.reported.pop()
      if (candidate === undefined) break
      const job = this.resolveReportedCandidate(owner, candidate)
      if (job === undefined) continue
      // A settlement may release a waiter before that wait continuation can
      // collect output. Another same-turn settlement must not remove its id.
      if (job.waiters > 0 || job.id === protectedId) {
        blocked.push(candidate)
        continue
      }
      if (this.removeTerminal(job)) {
        changed = true
        excess -= 1
      }
    }
    for (const candidate of blocked) bucket.reported.push(candidate)
    return changed
  }

  /** Add one settled job to its exact-owner count and ordered retention indexes. */
  private indexTerminal(job: TrackedTask): void {
    if (job.terminalIndexed) return
    const countEnabled = this.maxRetainedTerminalJobsPerOwner !== undefined
    const retentionMs = this.terminalJobRetentionMs
    const expiryEnabled = retentionMs !== undefined
    if (!countEnabled && !expiryEnabled) return
    const finishedAt = job.finishedAt
    /* v8 ignore next -- settle assigns finishedAt before indexing. */
    if (finishedAt === undefined) throw new Error(`terminal job ${job.id} has no finish time`)
    job.terminalIndexed = true
    if (countEnabled) {
      let bucket = this.terminalBuckets.get(job.owner)
      if (bucket === undefined) {
        bucket = { count: 0, reported: new MinHeap(compareTerminalRef) }
        this.terminalBuckets.set(job.owner, bucket)
      }
      bucket.count += 1
      if (job.reported) this.indexReportedTerminal(job)
    }
    if (expiryEnabled) {
      this.expiry.push({
        ...this.refOf(job),
        expiresAt: finishedAt + retentionMs,
      })
    }
  }

  /** Add one newly reported terminal to its owner's oldest-first candidate heap. */
  private indexReportedTerminal(job: TrackedTask): void {
    if (this.maxRetainedTerminalJobsPerOwner === undefined
      || !job.terminalIndexed || job.reportedIndexed) return
    const bucket = this.terminalBuckets.get(job.owner)
    /* v8 ignore next -- every indexed terminal owns a bucket. */
    if (bucket === undefined) throw new Error(`terminal job ${job.id} has no owner bucket`)
    job.reportedIndexed = true
    bucket.reported.push(this.refOf(job))
  }

  /** Project one lightweight ordered reference from an indexed terminal job. */
  private refOf(job: TrackedTask): TerminalRef {
    const finishedAt = job.finishedAt
    /* v8 ignore next -- only indexed terminal jobs reach this helper. */
    if (finishedAt === undefined) throw new Error(`terminal job ${job.id} has no finish time`)
    return { id: job.id, finishedAt, registrationOrder: job.registrationOrder }
  }

  /** Resolve one reported-heap entry, discarding removed or superseded refs. */
  private resolveReportedCandidate(owner: Agent | undefined, candidate: TerminalRef): TrackedTask | undefined {
    const job = this.store.get(candidate.id)
    if (job === undefined || job.owner !== owner || !job.terminalIndexed || !job.reported
      || job.finishedAt !== candidate.finishedAt
      || job.registrationOrder !== candidate.registrationOrder) return undefined
    return job
  }

  /** Drop stale oldest entries without traversing the complete candidate heap. */
  private discardStaleReportedHead(owner: Agent | undefined, bucket: TerminalBucket): void {
    while (true) {
      const candidate = bucket.reported.peek()
      if (candidate === undefined || this.resolveReportedCandidate(owner, candidate) !== undefined) return
      bucket.reported.pop()
    }
  }

  /** Remove one terminal record and decrement only its exact-owner index. */
  private removeTerminal(job: TrackedTask): boolean {
    if (!this.store.delete(job.id)) return false
    if (!job.terminalIndexed) return true
    job.terminalIndexed = false
    job.reportedIndexed = false
    if (this.maxRetainedTerminalJobsPerOwner === undefined) return true
    const bucket = this.terminalBuckets.get(job.owner)
    /* v8 ignore next -- indexed terminals always contribute to one bucket. */
    if (bucket === undefined) return true
    bucket.count -= 1
    if (bucket.count === 0) this.terminalBuckets.delete(job.owner)
    return true
  }

  /** Return the nearest still-live expiry while lazily dropping stale refs. */
  private nextTerminalExpiry(): ExpiryRef | undefined {
    while (true) {
      const candidate = this.expiry.peek()
      if (candidate === undefined) return undefined
      const job = this.store.get(candidate.id)
      if (job !== undefined && job.terminalIndexed
        && job.finishedAt === candidate.finishedAt
        && job.registrationOrder === candidate.registrationOrder) return candidate
      this.expiry.pop()
    }
  }

  /** Schedule the single maintenance timer earlier only when required. */
  private scheduleRetentionTimer(deadline: number): void {
    if (this.listenersClosed) return
    if (this.retentionTimer !== undefined
      && this.retentionTimerDeadline !== undefined
      && this.retentionTimerDeadline <= deadline) return
    if (this.retentionTimer !== undefined) clearTimeout(this.retentionTimer)
    this.retentionTimerDeadline = deadline
    this.retentionTimer = setTimeout(() => {
      this.retentionTimer = undefined
      this.retentionTimerDeadline = undefined
      const deferred = [...this.deferredPruneOwners]
      this.deferredPruneOwners.clear()
      for (const owner of deferred) {
        if (this.pruneReportedTerminals(owner)) this.notifyChanged(owner)
      }
      this.expireTerminalJobs()
      this.armNextTerminalExpiry()
    }, Math.max(0, deadline - Date.now()))
    this.retentionTimer.unref()
  }

  /** Point maintenance at the current valid expiry without resetting an earlier timer. */
  private armNextTerminalExpiry(): void {
    const next = this.nextTerminalExpiry()
    if (next !== undefined) this.scheduleRetentionTimer(next.expiresAt)
  }

  /** Expire every due terminal record from the ordered deadline heap. */
  private expireTerminalJobs(): void {
    if (this.terminalJobRetentionMs === undefined) return
    const now = Date.now()
    const changedOwners = new Set<Agent | undefined>()
    while (true) {
      const candidate = this.nextTerminalExpiry()
      if (candidate === undefined || candidate.expiresAt > now) break
      this.expiry.pop()
      const job = this.store.get(candidate.id)
      if (job !== undefined && this.removeTerminal(job)) changedOwners.add(job.owner)
    }
    for (const owner of changedOwners) this.notifyChanged(owner)
  }

  /**
   * Attach one awaited cleanup through the exact owner's scope. This survives
   * producer reloads and joins agent quiescence; the retained disposer lets
   * service teardown detach the cross-fiber effect. Fails when the registry is
   * absent or the owner is not its currently registered instance.
   */
  private ensureOwnerCleanup(owner: Agent): void {
    const ownerId = owner.id
    const agents = this.selfCtx.get('agents')
    if (agents === undefined) {
      throw new Error('background job ownership requires the agent registry (load @deepseek-ai/dsh-agent)')
    }
    if (agents.get(ownerId) !== owner) {
      throw new Error(`agent "${ownerId}" is not the registered agent instance (background job owner must be live)`)
    }
    if (this.ownerCleanups.has(owner)) return
    // Record only after attach succeeds; a disposing scope rejects new effects.
    const detach = owner.ctx.effect(() => async () => {
      this.ownerCleanups.delete(owner)
      await this.disposeOwned(owner)
    }, 'jobs.ownerCleanup()')
    this.ownerCleanups.set(owner, detach)
  }

  /** Cancel, await terminal records, and drop every job owned by one exact agent lifecycle. */
  private async disposeOwned(owner: Agent): Promise<void> {
    const owned = [...this.store.values()].filter(job => job.owner === owner)
    this.cancelForTeardown(owned, 'owner disposed')
    await Promise.all(owned.map(job => job.settled))
    for (const job of owned) {
      if (job.terminalIndexed) this.removeTerminal(job)
      else this.store.delete(job.id)
    }
    // Removal is the one visible-set change no per-job record carries, so it
    // must be announced here or an observer keeps the dropped rows forever.
    if (owned.length > 0) this.notifyChanged(owner)
  }

  /**
   * Close listeners, cancel live jobs, await settlement, and detach owner
   * effects. Throwing cancels are force-failed to avoid teardown deadlock.
   */
  private async disposeAll(): Promise<void> {
    // The flag is the whole guard: each layer entry's undo belongs to the fiber
    // that registered it, so this service may not drop them on its own way out.
    this.listenersClosed = true
    if (this.retentionTimer !== undefined) clearTimeout(this.retentionTimer)
    this.retentionTimer = undefined
    this.retentionTimerDeadline = undefined
    this.deferredPruneOwners.clear()
    const all = [...this.store.values()]
    this.cancelForTeardown(all, 'jobs service disposed')
    await Promise.all(all.map(job => job.settled))
    // Distinct owners whose records just disappeared. A change observer files
    // into the layer of the context that registered it, so a consumer mounted
    // outside this service — the api-proxy carrier registers from the mux
    // stream — is still reachable here. Without this it keeps the rows it last
    // received after a registry reload.
    const emptied = new Set(all.map(job => job.owner))
    this.store.clear()
    this.terminalBuckets.clear()
    this.expiry.clear()
    for (const owner of emptied) this.notifyChanged(owner)
    // Detach cross-fiber owner effects after the shared store is quiescent.
    const ownerCleanups = [...this.ownerCleanups.values()]
    this.ownerCleanups.clear()
    await Promise.all(ownerCleanups.map(cleanup => Promise.resolve(cleanup())))
  }

  /**
   * Cancel jobs during teardown with per-job containment. A throwing cancel
   * force-fails the record and reports a possible orphan; a cancel that returns
   * without settling remains indistinguishable from a slow stop and may stall.
   */
  private cancelForTeardown(jobs: TrackedTask[], reason: string): void {
    for (const job of jobs) {
      if (isTerminal(job.status)) continue
      // Teardown cancellation is a kill without a caller, so it claims the
      // terminal report the same way `kill()` does. Nothing will read a notice
      // for a job whose owner or service is being destroyed, and a waking
      // reporter would spend a model request per teardown layer. This is
      // decided before the producer runs: the force-failure below settles the
      // record too, so a throwing cancel must not be the one path that
      // announces an unreported completion into a disposing owner.
      job.reported = true
      try {
        job.cancel(reason)
        job.status = 'stopping'
        // Teardown reaches settlement only after the producer releases, which a
        // slow stop can defer; announcing the transition here is what keeps an
        // observer from showing `running` for that whole window.
        this.notifyChanged(job.owner)
      } catch (error: unknown) {
        const detail = `cancel threw during teardown; work may be orphaned: ${String(error)}`
        this.selfCtx.logger.warn(`jobs: cancel of ${job.id} threw during teardown; job record forced failed and work may be orphaned: ${String(error)}`)
        this.settle(job, { status: 'failed', detail })
      }
    }
  }
}

export default LocalJobRegistry
