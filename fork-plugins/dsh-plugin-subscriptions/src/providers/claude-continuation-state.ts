/**
 * The continuation state one plugin installation owns: the durable wire identity, the ATIS pin and
 * the account identity generation, composed behind one owner.
 *
 * This module adds no authority of its own. The salt names accounts, the span store owns the wire
 * identity and the pin, and the generation store owns the identity epoch; what this module does is
 * hold one of each per installation and per canonical account, hand the request path the facts it
 * prepared, and give the auth lifecycle one place to run a whole identity change. Nothing here
 * decides a chain, invents an identity or keeps a second pin.
 *
 * The facts a request needs are fixed before the stages that can reach the network: the account
 * reference, the epoch, the committed wire session id and the pin are all prepared under the
 * caller's cancellation, and the pin is frozen after the maintenance read that produces its
 * candidate and before anything is uploaded or built. No wait in this chain ends on elapsed time.
 * A state that cannot be read or committed refuses the request with the one fixed code every
 * continuation store reports; no caller falls back to a random identity or to a previous process's
 * map.
 *
 * @module dsh-plugin-subscriptions/providers/claude-continuation-state
 */

import { join } from 'node:path'
import { ClaudeSaltStore } from './claude-salt-store.js'
import type { ClaudeAccountRef } from './claude-salt-store.js'
import { ClaudeSpanBindingStore } from './claude-span-store.js'
import type {
  ClaudeCaptureBeginResult,
  ClaudeCaptureCommitResult,
  ClaudeCaptureTicket,
  ClaudeSpanDiscardResult,
  ClaudeSpanIdentity,
  ClaudeSpanOrigin,
  ClaudeSpanPin,
  ClaudeSpanRestoredIdentity,
} from './claude-span-store.js'
import { ClaudeIdentityGeneration, claudeIdentityLifecycle } from './claude-identity-generation.js'
import type {
  ClaudeGenerationAdvance,
  ClaudeGenerationState,
  ClaudeIdentityChange,
  ClaudeIdentityLifecycleProducer,
  ClaudeIdentityOperation,
  ClaudeIdentityTransition,
} from './claude-identity-generation.js'
import type {
  ContinuationDeadline,
  ContinuationFiles,
  ContinuationUnavailable,
  ContinuationWaitHost,
} from './claude-continuation-io.js'
import { continuationBudget, continuationUnavailable } from './claude-continuation-io.js'

/** The `request/header` reason the plugin observes, which is the request's own startup fact. */
export type ClaudeRequestHeaderReason = 'initial' | 'resume' | 'change' | 'series'

/** Constructor options for {@link ClaudeContinuationState}. */
export interface ClaudeContinuationStateOptions {
  /** Advisory accounting for one operation; elapsed time never ends its wait or refuses a caller. */
  readonly deadlineMs: number
  /** Backoff and lease input for the owned lock; it is not a wait bound. */
  readonly lockTimeoutMs: number
  /** Directory holding this installation's continuation documents. */
  readonly root: string
  /** Sink for a diagnostic about the state itself; never used for a credential. */
  readonly onWarn?: (message: string) => void
  /** The private file operations; a test injects one to hold a write. */
  readonly files?: ContinuationFiles
  /** The timers and abort listeners; a test injects one to control them. */
  readonly waits?: ContinuationWaitHost
}

/** The facts one prepared request carries to the wire, the pin and the metadata. */
export interface ClaudeContinuationPrepared {
  /** The account this request is served for, as the store's verifiable reference. */
  readonly accountRef: ClaudeAccountRef
  /** The identity generation in force. */
  readonly spanEpoch: number
  /** The harness session the request belongs to. */
  readonly harnessSessionId: string
  /** The wire session identity committed for this span. */
  readonly wireSessionId: string
  /** The pin in force; unfrozen until the first freeze of a new span. */
  readonly pin: ClaudeSpanPin
}

/** The reference and epoch one request is served under, before its span identity is prepared. */
export interface ClaudeContinuationIdentity {
  /** The account this request is served for. */
  readonly accountRef: ClaudeAccountRef
  /** The identity generation in force. */
  readonly spanEpoch: number
}

/** What one request's preparation needs. */
export interface ClaudeContinuationPrepareInput {
  /** The canonical account key serving this request. */
  readonly account: string
  /** The harness session the conversation belongs to. */
  readonly harnessSessionId: string
  /** Whether this is a new Session or a restored one, from the observed request header. */
  readonly origin: ClaudeSpanOrigin
  /** The wire identity a verified session-log fact states for this restored span. */
  readonly restored?: ClaudeSpanRestoredIdentity
  /** The identity already resolved under this same cancellation, so it is not derived twice. */
  readonly identity?: ClaudeContinuationIdentity
  /** The caller's cancellation and advisory accounting, shared by the whole preparation chain. */
  readonly deadline: ContinuationDeadline
}

/** A prepared request, or the fixed reason nothing may be sent. */
export type ClaudeContinuationPrepareResult =
  | { readonly kind: 'ready'; readonly prepared: ClaudeContinuationPrepared }
  | ContinuationUnavailable

/** The frozen pin, or the fixed reason nothing may be sent. */
export type ClaudeContinuationFreezeResult =
  | { readonly kind: 'frozen'; readonly pin: ClaudeSpanPin }
  | ContinuationUnavailable

/**
 * The state one installation and its accounts share.
 *
 * One instance owns one salt document and one span document, and one generation document per
 * canonical account reference; every method reads that state through the store that owns it.
 */
export class ClaudeContinuationState {
  /** The configured per-operation accounting input, which callers share. */
  readonly deadlineMs: number
  private readonly salt: ClaudeSaltStore
  private readonly spans: ClaudeSpanBindingStore
  private readonly options: ClaudeContinuationStateOptions
  private readonly generations = new Map<string, ClaudeIdentityGeneration>()
  private readonly owners = new Map<string, ClaudeContinuationOwner>()
  private readonly headerReasons = new Map<string, ClaudeRequestHeaderReason>()
  private closed = false

  /**
   * @param options - both configured timing inputs, the state directory and the injectable I/O
   *   boundary.
   */
  constructor(options: ClaudeContinuationStateOptions) {
    this.options = options
    this.deadlineMs = options.deadlineMs
    this.salt = new ClaudeSaltStore({
      path: join(options.root, 'salt.json'),
      deadlineMs: options.deadlineMs,
      lockTimeoutMs: options.lockTimeoutMs,
      ...options.onWarn === undefined ? {} : { onWarn: options.onWarn },
      ...options.files === undefined ? {} : { files: options.files },
      ...options.waits === undefined ? {} : { waits: options.waits },
    })
    this.spans = new ClaudeSpanBindingStore({
      path: join(options.root, 'spans.json'),
      deadlineMs: options.deadlineMs,
      lockTimeoutMs: options.lockTimeoutMs,
      ...options.onWarn === undefined ? {} : { onWarn: options.onWarn },
      ...options.files === undefined ? {} : { files: options.files },
      ...options.waits === undefined ? {} : { waits: options.waits },
    })
  }

  /**
   * Observe the reason the session's own request header was appended with.
   *
   * The log append is the durable fact; this only remembers the newest observed one per session so
   * the request being built can read it. The fact belongs to that session's own append, so an
   * identity change for one account does not invalidate another session's observation — the next
   * request of any session overwrites its own entry before that request is prepared. An absent
   * observation conservatively means "restored", and only disposal drops the table.
   * @param harnessSessionId - the harness session the header belongs to.
   * @param reason - the reason the header event stated.
   */
  observeRequestHeader(harnessSessionId: string, reason: ClaudeRequestHeaderReason): void {
    this.headerReasons.set(harnessSessionId, reason)
  }

  /**
   * The startup fact the request being built was appended with.
   * @param harnessSessionId - the harness session the request belongs to.
   * @returns the observed reason, or undefined when nothing was observed for this session.
   */
  requestHeaderReason(harnessSessionId: string): ClaudeRequestHeaderReason | undefined {
    return this.headerReasons.get(harnessSessionId)
  }

  /**
   * The span origin one observed header reason states.
   *
   * Only `initial` states that a new span may be seeded; a restored session, an absent observation
   * and the reasons that carry no startup fact are all treated as restored, which refuses to seed a
   * pin rather than inventing one.
   * @param reason - the observed reason, when there was one.
   * @returns the origin the preparation uses.
   */
  originFor(reason: ClaudeRequestHeaderReason | undefined): ClaudeSpanOrigin {
    return reason === 'initial' ? 'initial' : 'resume'
  }

  /**
   * Resolve the reference and epoch one request is served under.
   *
   * This reads the two independent durable facts and nothing else: it never creates a baseline, so
   * a request for an account the lifecycle has not established is refused rather than served under
   * an identity the request invented. The wait for an in-flight transition ends only when that
   * transition really settles, the caller cancels, or the state is disposed.
   * @param account - the canonical account key.
   * @param deadline - the caller's cancellation and advisory accounting, shared by the chain.
   * @returns the identity, or the fixed reason the request cannot be served.
   */
  async resolveIdentity(
    account: string,
    deadline: ContinuationDeadline,
  ): Promise<ClaudeContinuationIdentity | ContinuationUnavailable> {
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    const resolved = await this.resolveAccount(account, deadline)
    if (resolved.kind === 'unavailable') return resolved
    // Disposal may have started while the salt read ran; no generation is created after that close.
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    // A request waits for the auth lifecycle's transition rather than racing it: the wait ends only
    // when that transition settles, the caller stops, or disposal begins. It never ends by elapsed
    // time, and a caller that stops is answered as a cancellation rather than from the old epoch.
    const settled = await this.generationFor(resolved.accountRef).waitSettled(deadline)
    if (settled.kind === 'settled') {
      // Disposal may have started while the transition settled; no request is prepared after it.
      if (this.closed) return continuationUnavailable('the continuation state is being disposed')
      return { accountRef: resolved.accountRef, spanEpoch: settled.generation }
    }
    if (settled.kind === 'failed') return continuationUnavailable(settled.reason)
    return continuationUnavailable('the caller stopped waiting for the identity transition')
  }

  /**
   * Prepare one request's durable facts.
   *
   * The account reference, the current epoch and the committed wire identity are read or created in
   * that order, each inside the lock of the store that owns it, and the pin is deliberately not
   * frozen here: the maintenance read that produces its candidate has not run yet.
   * @param input - the account, session, origin, restored fact and shared cancellation.
   * @returns the prepared facts, or the fixed reason nothing may be sent.
   */
  async prepareRequest(input: ClaudeContinuationPrepareInput): Promise<ClaudeContinuationPrepareResult> {
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    const resolved = input.identity ?? await this.resolveIdentity(input.account, input.deadline)
    if (!('accountRef' in resolved)) return resolved
    // The identity resolution is a wait; disposal may have started while it ran.
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    const identity: ClaudeSpanIdentity = {
      accountRef: resolved.accountRef,
      harnessSessionId: input.harnessSessionId,
      spanEpoch: resolved.spanEpoch,
    }
    const prepared = await this.spans.prepare(identity, input.origin, {
      ...input.restored === undefined ? {} : { restored: input.restored },
      deadline: input.deadline,
    })
    if (prepared.kind !== 'ready') return prepared
    // The span commit is a wait too; a request answered after disposal began sends nothing.
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    return {
      kind: 'ready',
      prepared: {
        accountRef: resolved.accountRef,
        spanEpoch: resolved.spanEpoch,
        harnessSessionId: input.harnessSessionId,
        wireSessionId: prepared.span.wireSessionId,
        pin: prepared.span.pin,
      },
    }
  }

  /**
   * Freeze one prepared span's pin, once the maintenance read that produces its candidate settled.
   * @param prepared - the facts {@link prepareRequest} returned.
   * @param deadline - the same cancellation and advisory accounting the preparation chain shares.
   * @returns the frozen pin, or the fixed reason nothing may be sent.
   */
  async freezeRequest(
    prepared: ClaudeContinuationPrepared,
    deadline?: ContinuationDeadline,
  ): Promise<ClaudeContinuationFreezeResult> {
    // A freeze after disposal began would be a write the close did not account for.
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    return await this.spans.freeze(this.identityOf(prepared), deadline)
  }

  /**
   * Whether the epoch a prepared request carries is still the one this account is served under.
   *
   * This runs between the maintenance read and the stages that upload or build, so a change that
   * landed meanwhile refuses the request instead of letting it carry an old span's identity.
   * @param prepared - the facts {@link prepareRequest} returned.
   * @param deadline - the cancellation and advisory accounting the request resolution and this read
   *   share.
   * @returns the fixed refusal when the epoch moved or cannot be read, otherwise nothing.
   */
  async assertPreparedCurrent(
    prepared: ClaudeContinuationPrepared,
    deadline: ContinuationDeadline,
  ): Promise<ContinuationUnavailable | undefined> {
    // Disposal refuses before any state is read for this request: a close that started while the
    // request was prepared must not be answered with an epoch read after the snapshot it took.
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    const state = await this.generationFor(prepared.accountRef).current(deadline)
    // The epoch read is a wait; disposal refuses rather than answering from it.
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    if (state.kind === 'ready' && state.generation === prepared.spanEpoch) return undefined
    return continuationUnavailable(
      state.kind === 'unavailable' ? state.reason : 'the identity generation changed while this request was prepared',
    )
  }

  /**
   * Claim the right to record what one bootstrap read discloses for an account.
   * @param account - the canonical account key the read belongs to.
   * @param deadline - the cancellation and advisory accounting this read shares.
   * @returns the durable ticket, or the fixed refusal.
   */
  async beginCapture(account: string, deadline?: ContinuationDeadline): Promise<ClaudeCaptureBeginResult> {
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    const derived = await this.salt.hashRef(account, deadline)
    if (derived.kind !== 'derived') return continuationUnavailable(derived.reason)
    // The salt read is a wait; a capture claimed after disposal began owns nothing.
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    return await this.spans.beginCapture(derived.accountRef, deadline)
  }

  /**
   * Record what a successful bootstrap read disclosed, when its ticket still owns the account.
   * @param ticket - the ticket {@link beginCapture} returned.
   * @param disclosed - the raw value the read disclosed.
   * @param deadline - the cancellation and advisory accounting this read shares.
   * @returns whether the capture became the account's candidate.
   */
  async commitCapture(
    ticket: ClaudeCaptureTicket,
    disclosed: unknown,
    deadline?: ContinuationDeadline,
  ): Promise<ClaudeCaptureCommitResult> {
    // A late capture commit after disposal began would be a write the close did not account for.
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    return await this.spans.commitCapture(ticket, disclosed, deadline)
  }

  /**
   * Establish an account's identity owner, which the lifecycle calls before it changes anything.
   *
   * This is the one action that may derive the account reference: it creates the baseline when the
   * account has none and registers the owner, so the change that follows can close the gate in the
   * same turn it is asked to, with no asynchronous step between the two. Repeating it establishes
   * nothing new and reuses the owner and its generation.
   * @param account - the canonical account key.
   * @returns the generation in force, or why the owner could not be established.
   */
  async initialize(account: string): Promise<ClaudeGenerationAdvance | ContinuationUnavailable> {
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    const resolved = await this.resolveAccount(account)
    if (resolved.kind === 'unavailable') return resolved
    // The salt read awaited, so disposal may have started while it ran: a generation created after
    // that close would escape the snapshot it took, and the account is refused instead.
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    const generation = this.generationFor(resolved.accountRef)
    const advance = await generation.initialize()
    if (advance.kind !== 'advanced') return advance
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    if (!this.owners.has(account)) {
      this.owners.set(account, new ClaudeContinuationOwner(
        resolved.accountRef,
        claudeIdentityLifecycle(generation),
        this.spans,
        () => this.closed,
      ))
    }
    return advance
  }

  /**
   * Prepare one account for an explicit auth operation.
   *
   * This is the auth side of the state, not the request side: it resolves the reference and returns
   * the owner an explicit change runs through, establishing a baseline when none exists. A generation
   * the core refuses to change is deliberately not reported as ready here — whether the change may
   * proceed is the core's judgment (an active intent and a corrupt document are refused, a known
   * failed state is replaceable) — so this never inspects a failure's text and never clears a failed
   * document.
   * @param account - the canonical account key.
   * @returns the owner an explicit change starts from, or the fixed refusal.
   */
  async establishForChange(account: string): Promise<ClaudeContinuationOwner | ContinuationUnavailable> {
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    const resolved = await this.resolveAccount(account)
    if (resolved.kind === 'unavailable') return resolved
    // Disposal may have started while the salt read ran; no owner is created after that close.
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    const generation = this.generationFor(resolved.accountRef)
    // A baseline is established when none exists. The result is not read as readiness: a state the
    // core will refuse reaches the caller as that refusal, from the change itself.
    await generation.initialize()
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    const existing = this.owners.get(account)
    if (existing !== undefined) return existing
    const owner = new ClaudeContinuationOwner(
      resolved.accountRef,
      claudeIdentityLifecycle(generation),
      this.spans,
      () => this.closed,
    )
    this.owners.set(account, owner)
    return owner
  }

  /**
   * The initialized owner of one account.
   *
   * A missing owner is a typed refusal with no side effects: an identity change whose account was
   * never established must not run its credential work first and discover the gap afterwards.
   * @param account - the canonical account key.
   * @returns the owner a synchronous change starts from, or the fixed refusal.
   */
  owner(account: string): ClaudeContinuationOwner | ContinuationUnavailable {
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    const owner = this.owners.get(account)
    if (owner === undefined) {
      return continuationUnavailable('the account identity generation is not established')
    }
    return owner
  }

  /**
   * The durable identity generation one account is served under, when it is established.
   *
   * A maintenance owner binds its own record to this epoch, so a change of identity cannot have the
   * previous identity's confirmed state reused for it. There is no second counter: the generation
   * the span store is keyed by is the only one.
   * @param account - the canonical account key.
   * @returns the generation, or undefined when this account has none or cannot be read.
   */
  async currentEpoch(account: string): Promise<number | undefined> {
    const identity = await this.resolveIdentity(account, continuationBudget(this.deadlineMs))
    return 'accountRef' in identity ? identity.spanEpoch : undefined
  }

  /**
   * Forget this installation's continuation state for one account, which is the one clear owner.
   *
   * The epoch is the identity's, not the wire session's: dropping the spans makes a later request
   * for the same account start without the pins and wire identity an older identity froze, and the
   * old log rows are left exactly as they are.
   * @param account - the canonical account key whose spans are dropped.
   * @returns that the state was dropped, or the fixed reason it was not.
   */
  async clearAccountCatalog(account: string): Promise<ClaudeSpanDiscardResult> {
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    const resolved = await this.resolveAccount(account)
    if (resolved.kind === 'unavailable') return resolved
    // The salt read is a wait; a discard after disposal began would be a write close did not own.
    if (this.closed) return continuationUnavailable('the continuation state is being disposed')
    return await this.spans.discard(resolved.accountRef)
  }

  /**
   * Stop accepting work and wait for every owned store to really settle.
   *
   * The closed flag is set synchronously, so every later call refuses before it can wait or write;
   * each generation then wakes the requests waiting on its transition and awaits the transition it
   * owns; the span and salt stores drain their own queues last, in the order their owners depend on
   * each other.
   */
  async close(): Promise<void> {
    this.closed = true
    this.headerReasons.clear()
    const generations = [...this.generations.values()]
    this.generations.clear()
    for (const generation of generations) await generation.close()
    await this.spans.close()
    await this.salt.close()
  }

  /** The generation store of one reference, created on first use. */
  private generationFor(accountRef: ClaudeAccountRef): ClaudeIdentityGeneration {
    const key = `${accountRef.kind}:${String(accountRef.version)}:${accountRef.ref}`
    const existing = this.generations.get(key)
    if (existing !== undefined) return existing
    const generation = new ClaudeIdentityGeneration({
      accountRef,
      path: join(this.options.root, 'identity-generation.json'),
      deadlineMs: this.options.deadlineMs,
      lockTimeoutMs: this.options.lockTimeoutMs,
      ...this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn },
      ...this.options.files === undefined ? {} : { files: this.options.files },
      ...this.options.waits === undefined ? {} : { waits: this.options.waits },
    })
    this.generations.set(key, generation)
    return generation
  }

  /** The reference one canonical account key resolves to, or the fixed refusal. */
  private async resolveAccount(
    account: string,
    deadline?: ContinuationDeadline,
  ): Promise<{ readonly kind: 'resolved'; readonly accountRef: ClaudeAccountRef } | ContinuationUnavailable> {
    const derived = await this.salt.hashRef(account, deadline)
    if (derived.kind !== 'derived') return continuationUnavailable(derived.reason)
    return { kind: 'resolved', accountRef: derived.accountRef }
  }

  /** The identity one prepared request was keyed by. */
  private identityOf(prepared: ClaudeContinuationPrepared): ClaudeSpanIdentity {
    return {
      accountRef: prepared.accountRef,
      harnessSessionId: prepared.harnessSessionId,
      spanEpoch: prepared.spanEpoch,
    }
  }
}

/**
 * One initialized account's identity owner.
 *
 * The owner exists only after {@link ClaudeContinuationState.initialize} established the account, so
 * {@link ClaudeContinuationOwner.changed} closes the request gate in the same synchronous call that
 * starts the change: the credential work the caller passes cannot begin before the gate is closed,
 * because nothing between them awaits. The account's own spans are dropped inside that same
 * transition, so this owner is the only site that clears them and no second asynchronous clear can
 * race it.
 */
export class ClaudeContinuationOwner {
  /**
   * @param accountRef - the derived reference this owner changes the identity of.
   * @param producer - the generation producer that closes the gate and publishes the change.
   * @param spans - the span store whose rows this account's change drops.
   * @param isClosed - whether the state that built this owner has been disposed.
   */
  constructor(
    private readonly accountRef: ClaudeAccountRef,
    private readonly producer: ClaudeIdentityLifecycleProducer,
    private readonly spans: ClaudeSpanBindingStore,
    private readonly isClosed: () => boolean,
  ) {}

  /**
   * Run one whole identity change, this account's spans included.
   *
   * The caller's operation is its own credential commit; the gate is already closed when it runs.
   * This account's spans must really be gone first: a clear that could not be made is not a change,
   * so the credential commit and the publication are refused rather than leaving the new identity
   * to inherit the old span's wire identity and pin. A state being disposed starts no change at all.
   * @param change - which identity change is happening.
   * @param operation - the caller's own credential work.
   * @returns the transition whose `result` is the one completion signal.
   */
  changed(change: ClaudeIdentityChange, operation: ClaudeIdentityOperation): ClaudeIdentityTransition {
    if (this.isClosed()) {
      return {
        closed: false,
        result: Promise.resolve({ kind: 'failed', reason: 'the continuation state is being disposed' }),
      }
    }
    return this.producer.changed(change, async (completion) => {
      const discarded = await this.spans.discard(this.accountRef)
      if (discarded.kind !== 'discarded') {
        throw new Error(`this account's continuation spans could not be discarded (${discarded.reason})`)
      }
      await operation(completion)
    })
  }

  /**
   * Report that a credential rotation kept the same account.
   * @returns the generation in force, unchanged.
   */
  async rotated(): Promise<ClaudeGenerationState> {
    return await this.producer.rotated()
  }
}
