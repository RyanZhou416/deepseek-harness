/**
 * The account identity generation: durable proof that a request belongs to the identity it was
 * prepared for.
 *
 * A generation advances only when the authenticated account itself changes — a login, a logout,
 * an account removal, or a change of credential ownership. A token rotation does not advance it:
 * the account is the same account, and starting a new identity for every refresh would drop a
 * live conversation's continuation and ATIS state for no reason.
 *
 * One file keeps one record per derived account reference, so a change on one account cannot
 * invalidate another account's live span. Every read and every read-modify-write runs inside the
 * plugin's own lock, and the decisions that must not be made from a stale read are made inside
 * that critical section: a baseline is created only when the account has no record, and the one
 * generation a change may publish is fixed together with its own statement, in the same lock that
 * states the change, rather than re-derived from whatever the record holds later.
 *
 * **The producer owns one whole identity change, not one counter write.** The plugin's auth
 * lifecycle notifies only after it has already committed a credential, so a gate that closed at
 * notification time would close after the new credential is visible. The lifecycle therefore
 * hands this producer the complete work of one change — the credential commit, the account's
 * release and the span cleanup — and the gate is closed synchronously, before that work's first
 * await, and reopened only once every part of it has settled.
 *
 * **An unfinished change is durable, not remembered.** Before the operation runs, the record on
 * disk states that this account has a change in flight, and the whole transition — that statement,
 * the operation's real work and the generation's publication — runs under one cooperative lock on
 * this record's document, so another process cannot begin its own change while one is in flight and
 * cannot run its credential work beside it. A request that reads an unfinished statement refuses to
 * be served, and so does a fresh process: a process that died between the credential commit and the
 * publication cannot come back and serve requests under the epoch that preceded them.
 *
 * A statement that is still `active` is never taken over and never replaced by a later change: a
 * stale lock is not evidence that the instance running the change has stopped, so it stays closed
 * until that change is resolved. A change whose publication settled without confirming waits for its
 * own file operation to really settle, reads the record back once, and then either reports the
 * generation that landed or states the failure durably — only such a recorded failure, and a
 * statement of a finished change, is replaced by a later lifecycle action publishing the next
 * generation.
 *
 * **Disposal waits for the whole transition.** Closing the record stops new changes, waits for the
 * transition this instance owns — the operation's work and the publication — to really settle, and
 * only then drains its own file operations. A caller's cancellation never shortens that: the wait
 * is the caller's, and the settlement is the account's.
 *
 * **Requests read the durable record; they never establish one.** Establishing a baseline is a
 * separate lifecycle action that does not advance the account: a normal restart finds the
 * baseline already recorded and leaves it alone, and only a real identity change moves the
 * number. A request that finds no baseline is refused, because serving it would invent the
 * identity it is supposed to be gated by.
 *
 * @module dsh-plugin-subscriptions/providers/claude-identity-generation
 */

import { randomUUID } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { withStoreLockOwned } from '../auth/store-lock.js'
import { isClaudeAccountRef, sameClaudeAccountRef } from '../claude-core/account-ref.js'
import type { ClaudeAccountRef } from '../claude-core/account-ref.js'
import type {
  ContinuationDeadline,
  ContinuationFiles,
  ContinuationUnavailable,
  ContinuationWaitHost,
} from './claude-continuation-io.js'
import {
  ContinuationIo,
  continuationLockTiming,
  continuationUnavailable,
  errorCode,
  nodeContinuationFiles,
  systemContinuationWaits,
} from './claude-continuation-io.js'

/** The document version this build writes and reads. */
export const CLAUDE_IDENTITY_GENERATION_VERSION = 1

/** The identity changes that advance a generation; a rotation is not one of them. */
export type ClaudeIdentityChange = 'login' | 'logout' | 'removal' | 'ownership'

/** The fixed fact a refused request reports while a change has not published or been replaced. */
const UNFINISHED_CHANGE = 'an identity change did not complete'

/** The fixed fact a refused request reports while a change is recorded as having failed. */
const FAILED_CHANGE = 'an identity change failed and has not been replaced'

/**
 * The one identity change a record states.
 *
 * `active` means the change may still be running somewhere: its credentials may already be
 * committed, and nothing may be served or begun on top of it. `failed` means its operation settled
 * without publishing, which only a later lifecycle change replaces.
 */
type StoredPendingChange =
  | {
    readonly kind: 'active'
    /** Identifies the producer that began it, so only that producer may publish it. */
    readonly id: string
    readonly change: ClaudeIdentityChange
    /** ISO instant the change was begun. */
    readonly startedAt: string
  }
  | {
    readonly kind: 'failed'
    readonly id: string
    readonly change: ClaudeIdentityChange
    readonly startedAt: string
    /** ISO instant the change settled without publishing. */
    readonly failedAt: string
  }

/** The fixed fact one unfinished statement is reported as. */
function pendingReason(pending: StoredPendingChange): string {
  return pending.kind === 'active' ? UNFINISHED_CHANGE : FAILED_CHANGE
}

/** Whether a caller's cancellation has already fired; a call re-reads the signal. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

/** One persisted generation record, for one derived account. */
interface StoredGeneration {
  readonly accountRef: ClaudeAccountRef
  readonly generation: number
  /** True while this record is only the established baseline, not a completed change. */
  readonly baseline: boolean
  /** The change that produced this generation, for diagnostics. */
  readonly reason: ClaudeIdentityChange | 'baseline'
  /** The change this record states as begun or failed; null when none is unfinished. */
  readonly pending: StoredPendingChange | null
  /** ISO instant this generation was written. */
  readonly advancedAt: string
}

/** One persisted document. */
interface StoredDocument {
  readonly version: typeof CLAUDE_IDENTITY_GENERATION_VERSION
  readonly accounts: readonly StoredGeneration[]
}

/** What reading the current generation produced. */
export type ClaudeGenerationState =
  /** The generation this account is on; the gate is open. */
  | { readonly kind: 'ready'; readonly generation: number }
  /** No baseline exists yet; the lifecycle must establish it. */
  | { readonly kind: 'uninitialized' }
  /** No request for this account may be served. */
  | ContinuationUnavailable

/** What establishing the baseline or running one change produced. */
export type ClaudeGenerationAdvance =
  /** The generation is durable. */
  | { readonly kind: 'advanced'; readonly generation: number }
  /** The work did not settle or did not commit; the gate stays closed until one succeeds. */
  | { readonly kind: 'failed'; readonly reason: string }

/** What waiting for a transition produced. */
export type ClaudeGenerationWait =
  /** No transition is in flight; the generation is usable. */
  | { readonly kind: 'settled'; readonly generation: number }
  /** The caller aborted the wait; no request may be built. */
  | { readonly kind: 'aborted' }
  /** A transition failed, the record cannot be read, or disposal began; this account is refused. */
  | { readonly kind: 'failed'; readonly reason: string }

/**
 * The producer's own authority over one identity change.
 *
 * A transition opens with this capability and closes with it. Nothing else can open the gate:
 * the capability is created by the producer, handed only to the operation the producer is
 * running, and settling it is the only path to a reopened gate. It carries no power to declare a
 * request finished and none to publish a generation directly.
 */
export interface ClaudeIdentityCompletion {
  /**
   * The account this change belongs to.
   * @returns the derived reference the change is keyed by.
   */
  accountRef(): ClaudeAccountRef
  /**
   * Whether the gate is still closed for this change.
   * @returns true while no request may be prepared for this account.
   */
  isGateClosed(): boolean
}

/** The work of one identity change, run inside the producer's gate. */
export type ClaudeIdentityOperation = (completion: ClaudeIdentityCompletion) => Promise<void>

/** Constructor options for {@link ClaudeIdentityGeneration}. */
export interface ClaudeIdentityGenerationOptions {
  /** The account this counter belongs to. */
  readonly accountRef: ClaudeAccountRef
  /** File holding the record; absent uses the plugin's own home directory. */
  readonly path?: string
  /** Advisory accounting for one operation; elapsed time never ends its wait or refuses a caller. */
  readonly deadlineMs: number
  /** Backoff and lease input for the owned lock; it is not a wait bound. */
  readonly lockTimeoutMs: number
  /** Sink for a diagnostic about the record itself; never used for a credential. */
  readonly onWarn?: (message: string) => void
  /** The private file operations; a test injects one to hold a write. */
  readonly files?: ContinuationFiles
  /** The timers and abort listeners a wait may use; a test injects one to observe it. */
  readonly waits?: ContinuationWaitHost
}

/** The path the generation record lives under when the caller names none. */
function defaultPath(): string {
  return dshHomePath('plugins', 'subscriptions', 'claude-continuation', 'identity-generation.json')
}

/**
 * Whether a value read back from disk names one of the identity changes this build runs.
 * @param value - the candidate.
 * @returns true when it is one of the four changes.
 */
function isIdentityChange(value: unknown): value is ClaudeIdentityChange {
  return value === 'login' || value === 'logout' || value === 'removal' || value === 'ownership'
}

/**
 * Validate one change statement read back from disk.
 * @param value - the parsed member.
 * @returns true when every required field is present and well typed for its own kind.
 */
function isStoredPendingChange(value: unknown): value is StoredPendingChange {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const kind = record['kind']
  const failedAt = record['failedAt']
  return (kind === 'active' || kind === 'failed')
    && typeof record['id'] === 'string' && record['id'].length > 0
    && isIdentityChange(record['change'])
    && typeof record['startedAt'] === 'string'
    && (kind === 'active' ? failedAt === undefined : typeof failedAt === 'string')
}

/**
 * Validate one account entry read back from disk.
 * @param value - the parsed entry.
 * @returns true when every required field is present and well typed.
 */
function isStoredGeneration(value: unknown): value is StoredGeneration {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const reason = record['reason']
  const pending = record['pending']
  return isClaudeAccountRef(record['accountRef'])
    && typeof record['generation'] === 'number' && Number.isSafeInteger(record['generation']) && record['generation'] >= 0
    && typeof record['baseline'] === 'boolean'
    && (reason === 'baseline' || isIdentityChange(reason))
    && (pending === null || isStoredPendingChange(pending))
    && typeof record['advancedAt'] === 'string'
}

/**
 * Validate a whole document read back from disk.
 * @param value - the parsed document.
 * @returns true when every required field is present and well typed.
 */
function isStoredDocument(value: unknown): value is StoredDocument {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record['version'] === CLAUDE_IDENTITY_GENERATION_VERSION
    && Array.isArray(record['accounts']) && record['accounts'].every(isStoredGeneration)
}

/** Parse one document, distinguishing an absent one from an untrustworthy one. */
function parseDocument(text: string | undefined): { kind: 'parsed'; document: StoredDocument } | { kind: 'untrusted'; reason: string } {
  if (text === undefined) return { kind: 'parsed', document: { version: CLAUDE_IDENTITY_GENERATION_VERSION, accounts: [] } }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Only the parse is swallowed: an unparseable record is reported as untrusted.
    return { kind: 'untrusted', reason: 'the identity generation is not valid JSON' }
  }
  if (!isStoredDocument(parsed)) return { kind: 'untrusted', reason: 'the identity generation document is not one this build writes' }
  return { kind: 'parsed', document: parsed }
}

/** The record for one account, when the document holds it. */
function findRecord(document: StoredDocument, accountRef: ClaudeAccountRef): StoredGeneration | undefined {
  return document.accounts.find(entry => sameClaudeAccountRef(entry.accountRef, accountRef))
}

/** The document with one account's record replaced or appended, every other account kept. */
function upsert(document: StoredDocument, record: StoredGeneration): StoredDocument {
  const accounts = document.accounts.filter(entry => !sameClaudeAccountRef(entry.accountRef, record.accountRef))
  accounts.push(record)
  return { version: CLAUDE_IDENTITY_GENERATION_VERSION, accounts }
}

/** One in-flight transition, with the waiters it must wake exactly once. */
interface PendingTransition {
  readonly settled: Promise<void>
  readonly settle: () => void
}

/**
 * What one publication attempt confirmed.
 *
 * `unconfirmed` is not a failure: the attempt's own file operation may still settle, so the record
 * is read back before anything is concluded. The generation a change may publish is not a fact of
 * this result — it is fixed with the change's own statement, before the operation runs.
 */
type PublicationAttempt =
  | { readonly kind: 'advanced'; readonly generation: number }
  | { readonly kind: 'unconfirmed'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * The durable identity generation of one derived account.
 *
 * Every read and every read-modify-write runs inside the plugin's own lock, so a request sees the
 * same durable row another process wrote and two processes cannot each read the document and then
 * drop the other's account. The record is written atomically at owner-only mode.
 */
export class ClaudeIdentityGeneration {
  private readonly path: string
  private readonly accountRef: ClaudeAccountRef
  private readonly io: ContinuationIo
  private readonly waits: ContinuationWaitHost
  /** Waiters that disposal must wake, so no request waits on a transition being torn down. */
  private readonly disposalWaiters = new Set<() => void>()
  private damaged: string | undefined
  private pending: PendingTransition | undefined
  private running: Promise<ClaudeGenerationAdvance> | undefined
  private closing = false
  private warned = false

  /**
   * @param options - the account this counter belongs to, path, the lock policy and the I/O boundary.
   */
  constructor(private readonly options: ClaudeIdentityGenerationOptions) {
    this.path = options.path ?? defaultPath()
    this.accountRef = options.accountRef
    this.waits = options.waits ?? systemContinuationWaits
    this.io = new ContinuationIo({
      path: this.path,
      lockTimeoutMs: options.lockTimeoutMs,
      deadlineMs: options.deadlineMs,
      files: options.files ?? nodeContinuationFiles,
      waits: this.waits,
    })
  }

  /**
   * The generation this account's requests carry, read from the durable record.
   *
   * The record is re-read because another process's legitimate change is exactly the case a
   * cached number would get wrong. A missing baseline is `uninitialized` rather than an implicit
   * write, and a record that states an unfinished change refuses, because the epoch it names is
   * the one that change was meant to replace.
   * @param deadline - the cancellation and advisory accounting the caller resolved; absent uses the
   *   configured accounting and no signal.
   * @returns the current generation, or why no request may be served.
   */
  async current(deadline?: ContinuationDeadline): Promise<ClaudeGenerationState> {
    if (this.pending !== undefined) return this.unavailable('an identity transition is in flight')
    return await this.readState(deadline)
  }

  /**
   * Establish this account's baseline, which the lifecycle calls before any request.
   *
   * The record is created only when the account has none, inside the lock that decides it, so a
   * normal restart establishes nothing, a later initialization cannot overwrite an advanced row
   * with zero, and two initializations that race leave one baseline. Only the lifecycle calls it.
   * @param deadline - the cancellation and advisory accounting the caller resolved; absent uses the
   *   configured accounting and no signal.
   * @returns the generation in force, or why it could not be established.
   */
  async initialize(deadline?: ContinuationDeadline): Promise<ClaudeGenerationAdvance> {
    if (this.damaged !== undefined) return { kind: 'failed', reason: this.damaged }
    const proposed: StoredGeneration = {
      accountRef: this.accountRef,
      generation: 0,
      baseline: true,
      reason: 'baseline',
      pending: null,
      advancedAt: new Date().toISOString(),
    }
    let observed: { readonly generation: number; readonly blocked: string | undefined } | undefined
    let untrustedReason: string | undefined
    const outcome = await this.io.update((current) => {
      const document = parseDocument(current)
      if (document.kind === 'untrusted') {
        untrustedReason = document.reason
        return undefined
      }
      const record = findRecord(document.document, this.accountRef)
      if (record !== undefined) {
        observed = {
          generation: record.generation,
          blocked: record.pending === null ? undefined : pendingReason(record.pending),
        }
        return undefined
      }
      observed = { generation: proposed.generation, blocked: undefined }
      return JSON.stringify(upsert(document.document, proposed))
    }, deadline)
    if (untrustedReason !== undefined) return { kind: 'failed', reason: this.distrust(untrustedReason) }
    if (outcome.kind === 'unavailable') return { kind: 'failed', reason: outcome.reason }
    if (observed === undefined) return { kind: 'failed', reason: 'the identity generation could not be established' }
    if (observed.blocked !== undefined) return { kind: 'failed', reason: observed.blocked }
    return { kind: 'advanced', generation: observed.generation }
  }

  /**
   * Run one whole identity change inside the producer's gate.
   *
   * The gate closes synchronously, before this call yields, so no request can be prepared while the
   * change's own commit is in progress, and the whole transition then runs under a cooperative lock
   * on this account that another process's change also has to take. The change's statement is made
   * durable before the operation runs, and the operation is awaited to real settlement; the
   * returned `result` resolves only after the operation and the generation publication have both
   * settled. A second change for the same account while one is in flight is refused, and a change
   * that this record states as still active is refused rather than taken over.
   * @param change - the identity change this operation performs.
   * @param operation - the complete work of the change.
   * @returns the transition handle; its `result` is the one completion signal.
   */
  changed(change: ClaudeIdentityChange, operation: ClaudeIdentityOperation): ClaudeIdentityTransition {
    if (this.closing) {
      return {
        closed: false,
        result: Promise.resolve({ kind: 'failed', reason: 'the identity generation is being disposed' }),
      }
    }
    if (this.pending !== undefined) {
      return {
        closed: false,
        result: Promise.resolve({ kind: 'failed', reason: 'another identity transition is in flight' }),
      }
    }
    const transition = this.begin()
    const result = this.advance(change, operation, transition)
    this.running = result
    void result.then(() => {
      if (this.running === result) this.running = undefined
    })
    return { closed: true, result }
  }

  /**
   * Whether a transition is in flight, so a request must wait before it is served.
   * @returns true while a transition has not settled.
   */
  hasPendingTransition(): boolean {
    return this.pending !== undefined
  }

  /**
   * Wait for the transition this process is running until it settles, the caller stops, or disposal.
   *
   * The wait never starts a transition: a request waits for the auth lifecycle's work, which is the
   * only owner allowed to begin one. No timer bounds it — elapsed time is not an outcome — and a
   * pre-aborted caller is answered before anything else. A failure is a fixed state a later call
   * reads rather than a wait. The durable read that follows a settled transition keeps the same
   * cancellation, and disposal wakes the wait with a refusal instead of answering it from the
   * snapshot the transition was tearing down.
   * @param deadline - the caller's cancellation; its expiry instant is advisory only.
   * @returns the settled generation, or the fixed reason this account is not served.
   */
  async waitSettled(deadline: ContinuationDeadline): Promise<ClaudeGenerationWait> {
    if (isAborted(deadline.signal)) return { kind: 'aborted' }
    if (this.closing) return { kind: 'failed', reason: 'the identity generation is being disposed' }
    const transition = this.pending
    if (transition === undefined) {
      const state = await this.settledState(deadline)
      return state.kind === 'failed' && isAborted(deadline.signal) ? { kind: 'aborted' } : state
    }
    const ended = await this.waitForTransition(transition, deadline.signal)
    if (ended === 'aborted') return { kind: 'aborted' }
    if (ended === 'disposed') return { kind: 'failed', reason: 'the identity generation is being disposed' }
    if (isAborted(deadline.signal)) return { kind: 'aborted' }
    const state = await this.settledState(deadline)
    return state.kind === 'failed' && isAborted(deadline.signal) ? { kind: 'aborted' } : state
  }

  /**
   * Stop accepting new changes and wait for the whole transition this instance owns to settle.
   *
   * The order matters: new changes are refused and every waiting request is woken first, so no
   * operation starts after this call and no wait outlives disposal; the running transition — its
   * operation and its publication — is then awaited to real settlement, and only after that are
   * this record's own file operations drained. Disposal reports settlement, not success, and a
   * caller's cancellation never shortens it. It must not be awaited from inside the operation, and
   * it awaits no work of its own.
   */
  async close(): Promise<void> {
    this.closing = true
    for (const wake of [...this.disposalWaiters]) wake()
    this.disposalWaiters.clear()
    const running = this.running
    if (running !== undefined) await running
    await this.io.close()
  }

  /**
   * Wait for one transition to settle, the caller to stop, or disposal to begin.
   *
   * No timer and no polling: the transition's own settlement promise is the only progress signal,
   * and disposal is signalled by {@link close}. The abort listener and the disposal wake are
   * removed on every outcome.
   * @param transition - the in-flight transition.
   * @param signal - the caller's own cancellation, when it has one.
   * @returns what ended the wait.
   */
  private async waitForTransition(
    transition: PendingTransition,
    signal: AbortSignal | undefined,
  ): Promise<'settled' | 'aborted' | 'disposed'> {
    if (isAborted(signal)) return 'aborted'
    if (this.closing) return 'disposed'
    return await new Promise<'settled' | 'aborted' | 'disposed'>((resolve) => {
      let finished = false
      let cancelAbort: () => void = () => undefined
      const wakeDisposal = (): void => { finish('disposed') }
      const finish = (outcome: 'settled' | 'aborted' | 'disposed'): void => {
        if (finished) return
        finished = true
        cancelAbort()
        this.disposalWaiters.delete(wakeDisposal)
        resolve(outcome)
      }
      this.disposalWaiters.add(wakeDisposal)
      if (signal !== undefined) cancelAbort = this.waits.onAbort(signal, () => { finish('aborted') })
      void transition.settled.then(() => { finish('settled') })
      // Re-read both enders after subscribing: an abort or disposal that landed during this
      // synchronous turn still ends the wait.
      if (isAborted(signal)) finish('aborted')
      else if (this.closing) finish('disposed')
    })
  }

  /** Read the durable state this account is served under. */
  private async readState(deadline?: ContinuationDeadline): Promise<ClaudeGenerationState> {
    const read = await this.readRecord(deadline)
    if (read.kind === 'unreadable') return this.unavailable(read.reason)
    if (read.record === undefined) return { kind: 'uninitialized' }
    if (read.record.pending !== null) return this.unavailable(pendingReason(read.record.pending))
    return { kind: 'ready', generation: read.record.generation }
  }

  /** Read this account's record once under the plugin's own lock, writing nothing. */
  private async readRecord(deadline?: ContinuationDeadline): Promise<
    | { readonly kind: 'record'; readonly record: StoredGeneration | undefined }
    | { readonly kind: 'unreadable'; readonly reason: string }
  > {
    if (this.damaged !== undefined) return { kind: 'unreadable', reason: this.damaged }
    let parsed: StoredDocument | undefined
    let untrustedReason: string | undefined
    const outcome = await this.io.update((current) => {
      const document = parseDocument(current)
      if (document.kind === 'untrusted') {
        untrustedReason = document.reason
        return undefined
      }
      parsed = document.document
      return undefined
    }, deadline)
    if (untrustedReason !== undefined) return { kind: 'unreadable', reason: this.distrust(untrustedReason) }
    if (outcome.kind === 'unavailable') return { kind: 'unreadable', reason: outcome.reason }
    if (parsed === undefined) return { kind: 'unreadable', reason: 'the identity generation could not be read' }
    return { kind: 'record', record: findRecord(parsed, this.accountRef) }
  }

  /** Read the durable state a settled wait reports. */
  private async settledState(deadline?: ContinuationDeadline): Promise<ClaudeGenerationWait> {
    const state = await this.readState(deadline)
    if (state.kind === 'ready') return { kind: 'settled', generation: state.generation }
    return {
      kind: 'failed',
      reason: state.kind === 'unavailable' ? state.reason : 'the identity generation is not established',
    }
  }

  /**
   * Run one transition: the durable statement, the operation, then the publication.
   *
   * The whole transition runs under a cooperative lock taken on a resource beside the record, so
   * the record's own read-modify-write locks never nest. That lock belongs to the whole document
   * rather than to one account, which serialises the accounts in one file conservatively: the
   * document's read-modify-write locks are per file anyway, and a per-account resource would add a
   * second naming rule for no correctness this round needs. The lock is what keeps a second instance
   * from running its credential work beside this one, and the durable statement is what keeps it
   * from taking over a change that may still be running: a lock whose lease expired says nothing
   * about the instance that held it.
   */
  private async advance(
    change: ClaudeIdentityChange,
    operation: ClaudeIdentityOperation,
    transition: PendingTransition,
  ): Promise<ClaudeGenerationAdvance> {
    try {
      await this.io.ensureDirectory()
      const locked = await withStoreLockOwned<ClaudeGenerationAdvance>(
        this.transitionResource(),
        async (): Promise<ClaudeGenerationAdvance> => {
          const begun = await this.beginChange(change)
          if (begun.kind === 'failed') return begun
          try {
            await operation(this.completion(transition))
          } catch (error: unknown) {
            const reason = `the identity change did not settle (${errorCode(error)})`
            this.warnOnce(reason)
            await this.recordFailure(begun.id, reason)
            return { kind: 'failed', reason }
          }
          return await this.publishChange(begun.id, change, begun.baseGeneration + 1)
        },
        continuationLockTiming(this.options.lockTimeoutMs),
      )
      if (!locked.acquired) {
        return { kind: 'failed', reason: 'another identity change holds this account' }
      }
      return locked.value
    } catch (error: unknown) {
      const reason = `the identity change did not settle (${errorCode(error)})`
      this.warnOnce(reason)
      return { kind: 'failed', reason }
    } finally {
      // Only this transition clears its own gate, and it clears it after its own work settled.
      if (this.pending === transition) this.pending = undefined
      transition.settle()
    }
  }

  /**
   * The lock resource every identity transition of this document takes.
   *
   * It is one resource for the whole document, beside the record so the record's own read-modify-
   * write locks never nest; accounts sharing one file therefore serialise conservatively rather
   * than concurrently.
   */
  private transitionResource(): string {
    return `${this.path}.transition`
  }

  /** The capability one transition hands its operation; it can only observe the gate. */
  private completion(transition: PendingTransition): ClaudeIdentityCompletion {
    return {
      accountRef: () => this.accountRef,
      isGateClosed: () => this.pending === transition,
    }
  }

  /**
   * State one change as begun, durably, before the operation it covers runs.
   *
   * A record that names an account with no baseline cannot begin a change: a generation this call
   * invented would not be the one the account is served under. A change this record still states as
   * active is never taken over, because the instance that began it may be running its credential
   * work right now and neither a stale lock nor a fresh process is evidence that it stopped. Only a
   * statement of a settled failure is replaced, and only by this lifecycle action.
   */
  private async beginChange(
    change: ClaudeIdentityChange,
  ): Promise<
    | { readonly kind: 'begun'; readonly id: string; readonly baseGeneration: number }
    | { readonly kind: 'failed'; readonly reason: string }
  > {
    const id = randomUUID()
    let established = false
    let baseGeneration: number | undefined
    let blockedReason: string | undefined
    let untrustedReason: string | undefined
    const outcome = await this.io.update((current) => {
      const document = parseDocument(current)
      if (document.kind === 'untrusted') {
        untrustedReason = document.reason
        return undefined
      }
      const record = findRecord(document.document, this.accountRef)
      if (record === undefined) return undefined
      const pending = record.pending
      if (pending !== null && pending.kind === 'active') {
        blockedReason = pendingReason(pending)
        return undefined
      }
      established = true
      // The generation this change starts from is a fact of the same locked read that states the
      // change, so it is fixed before the operation runs and never has to be re-derived later.
      baseGeneration = record.generation
      const next: StoredGeneration = {
        ...record,
        pending: { kind: 'active', id, change, startedAt: new Date().toISOString() },
      }
      return JSON.stringify(upsert(document.document, next))
    })
    if (untrustedReason !== undefined) return { kind: 'failed', reason: this.distrust(untrustedReason) }
    if (outcome.kind === 'unavailable') return { kind: 'failed', reason: outcome.reason }
    if (blockedReason !== undefined) return { kind: 'failed', reason: blockedReason }
    if (!established) return { kind: 'failed', reason: 'the identity generation is not established' }
    if (baseGeneration === undefined) return { kind: 'failed', reason: 'the identity generation could not be read' }
    if (!outcome.written) return { kind: 'failed', reason: 'the identity change could not be stated durably' }
    return { kind: 'begun', id, baseGeneration }
  }

  /**
   * Publish the generation one change produced, clearing the statement in the same lock.
   *
   * An attempt that does not confirm is not a verdict: the write it started may still be on its way,
   * so the outcome is settled from the durable record rather than from the attempt's own report, and
   * against the generation this change's own statement was made for.
   * @param id - the statement this change wrote.
   * @param change - the identity change being published.
   * @param expected - the one generation this change may publish: its base plus one.
   */
  private async publishChange(
    id: string,
    change: ClaudeIdentityChange,
    expected: number,
  ): Promise<ClaudeGenerationAdvance> {
    const attempt = await this.attemptPublication(id, change, expected)
    if (attempt.kind === 'advanced') return { kind: 'advanced', generation: attempt.generation }
    if (attempt.kind === 'refused') return { kind: 'failed', reason: attempt.reason }
    return await this.settlePublication(id, change, expected, attempt.reason)
  }

  /**
   * Attempt the publication once, reporting what it confirmed.
   *
   * The generation written is the one this change's own statement was made for, fixed before the
   * operation ran, so two changes can never publish the same number and a later attempt cannot be
   * re-derived from whatever the record happens to hold when a wait ends. A record that does not
   * state this change's own active statement at the generation it was made for is not this change's
   * to publish, and a damaged record is refused rather than reconciled against.
   * @param id - the statement this change wrote.
   * @param change - the identity change being published.
   * @param expected - the one generation this change may publish: its base plus one.
   * @returns what the attempt itself confirmed.
   */
  private async attemptPublication(
    id: string,
    change: ClaudeIdentityChange,
    expected: number,
  ): Promise<PublicationAttempt> {
    let mismatched = false
    let untrustedReason: string | undefined
    const outcome = await this.io.update((current) => {
      const document = parseDocument(current)
      if (document.kind === 'untrusted') {
        untrustedReason = document.reason
        return undefined
      }
      const record = findRecord(document.document, this.accountRef)
      if (record === undefined) {
        mismatched = true
        return undefined
      }
      const pending = record.pending
      if (pending === null || pending.kind !== 'active' || pending.id !== id
        || record.generation !== expected - 1) {
        mismatched = true
        return undefined
      }
      const next: StoredGeneration = {
        accountRef: this.accountRef,
        generation: expected,
        baseline: false,
        reason: change,
        pending: null,
        advancedAt: new Date().toISOString(),
      }
      return JSON.stringify(upsert(document.document, next))
    })
    if (untrustedReason !== undefined) return { kind: 'refused', reason: this.distrust(untrustedReason) }
    if (outcome.kind === 'unavailable') return { kind: 'unconfirmed', reason: outcome.reason }
    if (mismatched) return { kind: 'refused', reason: 'the identity change was not the one recorded' }
    if (!outcome.written) {
      return { kind: 'unconfirmed', reason: 'the identity generation was not confirmed as published' }
    }
    return { kind: 'advanced', generation: expected }
  }

  /**
   * Settle one publication attempt that did not confirm, and read the record back once.
   *
   * The first step waits for this producer's own file operation to really settle: a logical bound or
   * an abort ended the caller's wait, not the write, and a late write must be observed rather than
   * assumed away. Then one read-only pass decides, against the one generation this change's own
   * statement was made for rather than against anything the ended wait happened to observe: that
   * generation standing with this change's reason means the change published and is reported as
   * such, without running the operation again or incrementing twice, while this change's own
   * statement still standing is stated as a failure so that a later explicit lifecycle action can
   * begin. A record that still cannot be read, or a failure that still cannot be stated, keeps the
   * account refused instead of ready, and never takes over a statement this change does not own.
   * @param id - the statement this change wrote.
   * @param change - the identity change being published.
   * @param expected - the one generation this change may publish: its base plus one.
   * @param reason - the attempt's own reason, reported when the record cannot be settled.
   * @returns the settled outcome this change may report.
   */
  private async settlePublication(
    id: string,
    change: ClaudeIdentityChange,
    expected: number,
    reason: string,
  ): Promise<ClaudeGenerationAdvance> {
    await this.io.drain()
    const read = await this.readRecord()
    if (read.kind === 'unreadable') return { kind: 'failed', reason }
    const record = read.record
    if (record === undefined) return { kind: 'failed', reason }
    if (record.pending === null) {
      if (record.generation === expected && record.reason === change) {
        return { kind: 'advanced', generation: record.generation }
      }
      return { kind: 'failed', reason: 'the identity generation does not match this change' }
    }
    if (record.pending.id !== id) {
      return { kind: 'failed', reason: 'the identity change was not the one recorded' }
    }
    if (record.pending.kind === 'active') await this.recordFailure(id, reason)
    return { kind: 'failed', reason }
  }

  /**
   * State durably that one change settled without publishing.
   *
   * Only this transition's own active statement is turned into a failed one. When the state cannot
   * be confirmed — the write refused, or the record no longer states this change — the active
   * statement stands, and the account keeps refusing rather than being reported as ready.
   */
  private async recordFailure(id: string, reason: string): Promise<void> {
    this.warnOnce(reason)
    let stated = false
    const outcome = await this.io.update((current) => {
      const document = parseDocument(current)
      if (document.kind === 'untrusted') return undefined
      const record = findRecord(document.document, this.accountRef)
      if (record === undefined) return undefined
      const pending = record.pending
      if (pending === null || pending.kind !== 'active' || pending.id !== id) return undefined
      stated = true
      const next: StoredGeneration = {
        ...record,
        pending: {
          kind: 'failed',
          id: pending.id,
          change: pending.change,
          startedAt: pending.startedAt,
          failedAt: new Date().toISOString(),
        },
      }
      return JSON.stringify(upsert(document.document, next))
    })
    if (outcome.kind !== 'applied' || !stated) {
      // The statement could not be made; the active one stands, so the account stays closed.
      this.warnOnce('the failed identity change could not be recorded')
    }
  }

  private begin(): PendingTransition {
    let settle!: () => void
    const settled = new Promise<void>((resolve) => { settle = resolve })
    const transition: PendingTransition = { settled, settle }
    this.pending = transition
    return transition
  }

  /** Report a refusal that may pass, and remember a document this build cannot trust. */
  private unavailable(reason: string): ContinuationUnavailable {
    this.warnOnce(reason)
    return continuationUnavailable(reason)
  }

  /** Remember a document this build cannot trust, and report it once. */
  private distrust(reason: string): string {
    this.damaged = reason
    this.warnOnce(reason)
    return reason
  }

  private warnOnce(reason: string): void {
    if (this.warned) return
    this.warned = true
    this.options.onWarn?.(`dsh-plugin-subscriptions: ${reason}`)
  }
}

/**
 * One identity transition, as the auth lifecycle starts it and a request observes it.
 *
 * `result` is the single completion signal: it resolves after the operation and the generation
 * publication have both settled, so no caller has to await a second promise to learn whether the
 * account may be served again.
 */
export interface ClaudeIdentityTransition {
  /** Whether the gate closed for this transition (false when another one already owns it). */
  readonly closed: boolean
  /** The transition's outcome, resolved once all of its work has settled. */
  readonly result: Promise<ClaudeGenerationAdvance>
}

/**
 * The auth lifecycle's typed producer for one account's identity generation.
 *
 * The producer is the only owner that establishes a baseline or runs an identity change, and it
 * runs a change only for the four that replace the authenticated account. Its synchronous return
 * closes the request gate, and the operation it runs carries the change's real work — the
 * credential commit, the account's release and the span cleanup — so the gate is never reopened
 * around a half-applied change. A credential rotation is explicitly not a change.
 */
export interface ClaudeIdentityLifecycleProducer {
  /**
   * Establish this account's baseline, before any request is served.
   * @returns the generation in force, or why it could not be established.
   */
  initialize(): Promise<ClaudeGenerationAdvance>
  /**
   * Run one whole identity change inside the producer's gate.
   * @param change - the account identity change that happened.
   * @param operation - the complete work of that change.
   * @returns the transition whose `result` is the one completion signal.
   */
  changed(change: ClaudeIdentityChange, operation: ClaudeIdentityOperation): ClaudeIdentityTransition
  /**
   * Report that a credential rotation kept the same account.
   * @returns the generation in force, unchanged.
   */
  rotated(): Promise<ClaudeGenerationState>
}

/**
 * Build the producer over one account's generation record.
 * @param generation - the record to establish and advance.
 * @returns the producer the auth lifecycle calls.
 */
export function claudeIdentityLifecycle(generation: ClaudeIdentityGeneration): ClaudeIdentityLifecycleProducer {
  return {
    initialize: async () => await generation.initialize(),
    changed: (change, operation) => generation.changed(change, operation),
    rotated: async () => await generation.current(),
  }
}
