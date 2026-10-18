/**
 * Account and session admission for subscription pools.
 *
 * A pool member is one subscription account, and the service meters it as a
 * whole: a plan allows a few concurrent sessions, each session may have one turn
 * in flight, and one turn sends one request at a time. A 429 is evidence about
 * that shared meter, so it is answered where the meter lives instead of by
 * answering the same request from another account.
 *
 * This module owns those shared facts:
 *
 * - {@link PoolGate.acquireTurn} reserves one of an account's session slots for a
 *   session's turn, queueing the third session instead of sending it.
 * - {@link PoolGate.admit} serializes one session's requests, waits out that
 *   session's own backoff, and takes a token from the account's shared request
 *   limiter.
 * - {@link PoolGate.cooldown} parks an account until the reset a window or a
 *   refusal disclosed, and every session of that account sees it.
 *
 * The gate consumes failure effects classified in `pool-health.ts`; it does not
 * parse responses. That keeps the provider error mapping independent of the
 * scheduling rules: a new provider code only has to name the effect it has.
 *
 * @module dsh-plugin-subscriptions/providers/pool-gate
 */

import { LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmErrorOptions } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type { ProviderId } from '../auth/store.js'
import { accountKey, isAuthCooldownReason } from './pool-health.js'
import type { PoolHealthRegistry } from './pool-health.js'

/**
 * Stable code for a pool that found no account it may ask.
 *
 * Deliberately not `RATE_LIMIT`: the pool did not attempt a request, so no
 * provider stated a retry time, and presenting a retry countdown would promise a
 * recovery the pool cannot know.
 */
export const NO_AVAILABLE_ACCOUNT_CODE = 'NO_AVAILABLE_ACCOUNT'

/**
 * The typed outcome a denied admission reports.
 *
 * It is a scheduling decision, not a provider code: `rate_limited` means the
 * session must back off, `quota_exhausted` and `account_unavailable` mean the
 * account is parked until its recorded reset, and `no_available_account` means
 * the pool has nothing healthy to ask.
 */
export type PoolGateReason =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'account_unavailable'
  | 'model_denied'
  | 'no_available_account'

/** The harness error code each gate reason reports. */
const GATE_ERROR_CODES: Readonly<Record<PoolGateReason, string>> = Object.freeze({
  rate_limited: 'RATE_LIMIT',
  quota_exhausted: QUOTA_EXCEEDED_CODE,
  account_unavailable: 'AUTH',
  model_denied: 'HTTP_404',
  no_available_account: NO_AVAILABLE_ACCOUNT_CODE,
})

/**
 * The code a parked account's refusal reports: the failure code that parked it
 * where the surface can act on that code, otherwise the non-retryable
 * account-unavailable code.
 */
function coolingCode(reason: string): string {
  if (reason === QUOTA_EXCEEDED_CODE) return QUOTA_EXCEEDED_CODE
  if (reason === 'ENFORCEMENT') return 'ENFORCEMENT'
  if (reason === 'RATE_LIMIT') return 'RATE_LIMIT'
  return 'AUTH'
}

/**
 * A pool admission the gate refused.
 *
 * The `LlmError` code stays inside the routes' existing vocabulary, so retry
 * policy and the client error card keep working; `gateReason` is the scheduling
 * decision itself, for callers that must distinguish "wait for this session's
 * backoff" from "this account is parked".
 */
export class PoolGateError extends LlmError {
  /** The scheduling decision behind this refusal. */
  readonly gateReason: PoolGateReason

  /**
   * @param message - non-empty human-readable failure summary.
   * @param gateReason - the scheduling decision.
   * @param options - optional cause and provider facts, as `LlmError` accepts.
   * @param code - the harness code to report, when the surface should keep the
   *   provider's own classification (a parked account reports the code that parked it).
   */
  constructor(message: string, gateReason: PoolGateReason, options?: LlmErrorOptions, code?: string) {
    super(message, code ?? GATE_ERROR_CODES[gateReason], options)
    this.name = 'PoolGateError'
    this.gateReason = gateReason
  }
}

/** Local backoff shape for one session's own failures. */
export interface PoolGateBackoff {
  /** First local delay. */
  readonly initialDelayMs: number
  /** Local delay ceiling. */
  readonly maxDelayMs: number
  /** Symmetric jitter around each local delay. */
  readonly jitterRatio: number
  /** Consecutive backoffs one session may spend before the turn stops retrying. */
  readonly maxRetries: number
}

/**
 * Deployment-owned concurrency and backoff policy.
 *
 * Every value is validated at plugin load, so a typo fails the composition
 * instead of silently disabling a limit.
 */
export interface PoolGatePolicy {
  /** Concurrent sessions one account serves; the next session queues. */
  readonly maxSessionsPerAccount: number
  /** Longest wait for a session slot or a request token before the request is refused. */
  readonly queueTimeoutMs: number
  /** Fallback release for a session whose turn end was never observed. */
  readonly sessionIdleMs: number
  /** Minimum spacing between two requests of one account, in milliseconds. */
  readonly minGapMs: number
  /** Requests per minute one account serves across every session; zero disables the rate cap. */
  readonly requestsPerMinute: number
  /** Tokens a burst may consume at once. */
  readonly burst: number
  /** Credential refresh cycles one account may spend before it is parked. */
  readonly maxRefreshAttempts: number
  /** Local backoff for a failure that disclosed no wait. */
  readonly backoff: PoolGateBackoff
}

/** The `pool.concurrency` config section as a deployment writes it. */
export interface PoolGateConfig {
  /** Concurrent sessions one account serves; the next session queues. */
  maxSessionsPerAccount?: number
  /** Longest wait for a session slot or a request token before the request is refused. */
  queueTimeoutMs?: number
  /** Fallback release for a session whose turn end was never observed. */
  sessionIdleMs?: number
  /** Minimum spacing between two requests of one account, in milliseconds. */
  minGapMs?: number
  /** Requests per minute one account serves across every session; zero disables the rate cap. */
  requestsPerMinute?: number
  /** Tokens a burst may consume at once. */
  burst?: number
  /** Credential refresh cycles one account may spend before it is parked. */
  maxRefreshAttempts?: number
  /** Local backoff for a failure that disclosed no wait. */
  backoff?: Partial<PoolGateBackoff>
}

/** Schema for the `pool.concurrency.backoff` config section. */
export const PoolGateBackoffSchema = z.object({
  initialDelayMs: z.number().step(1).min(1).default(1_000),
  maxDelayMs: z.number().step(1).min(1).default(60_000),
  jitterRatio: z.number().min(0).max(1).default(0.2),
  maxRetries: z.number().step(1).min(0).max(100).default(10),
})

/** Schema for the `pool.concurrency` config section. */
export const PoolGateSchema = z.object({
  maxSessionsPerAccount: z.number().step(1).min(1).max(64).default(2),
  queueTimeoutMs: z.number().step(1).min(1).default(120_000),
  sessionIdleMs: z.number().step(1).min(1_000).default(600_000),
  minGapMs: z.number().step(1).min(0).default(1_500),
  requestsPerMinute: z.number().min(0).default(20),
  burst: z.number().step(1).min(1).default(2),
  maxRefreshAttempts: z.number().step(1).min(0).max(10).default(2),
  backoff: PoolGateBackoffSchema,
})

/**
 * Resolve and validate every concurrency choice before a request can use it.
 * @param input - optional deployment overrides.
 * @returns complete finite policy.
 */
export function resolvePoolGatePolicy(input: PoolGateConfig = {}): PoolGatePolicy {
  const policy = PoolGateSchema(input)
  for (const key of ['maxSessionsPerAccount', 'queueTimeoutMs', 'sessionIdleMs', 'minGapMs', 'requestsPerMinute', 'burst', 'maxRefreshAttempts'] as const) {
    if (!Number.isFinite(policy[key])) throw new Error(`pool.concurrency.${key} must be finite`)
  }
  for (const key of ['initialDelayMs', 'maxDelayMs', 'jitterRatio', 'maxRetries'] as const) {
    if (!Number.isFinite(policy.backoff[key])) throw new Error(`pool.concurrency.backoff.${key} must be finite`)
  }
  if (policy.backoff.maxDelayMs < policy.backoff.initialDelayMs) {
    throw new Error('pool.concurrency.backoff.maxDelayMs must be no less than initialDelayMs')
  }
  return Object.freeze({ ...policy, backoff: Object.freeze({ ...policy.backoff }) })
}

/** One open turn of a session, as observed on the session log. */
export interface SessionTurn {
  /** Monotonic identity of this turn within the process, distinct from the raw turn number. */
  readonly key: number
  /** The turn number the session log recorded. */
  readonly turn: number
}

/**
 * The open turn of every live session, fed by `turn/start` and `turn/end`.
 *
 * The session log's turn counter restarts when a session is resumed, so a raw
 * turn number cannot identify a turn across resumes; the gate therefore assigns
 * its own monotonic key at every `turn/start`. Requests belong to the open turn
 * of their session, which is what makes "rematch only at a turn boundary"
 * enforceable.
 */
export class SessionTurns {
  private readonly open = new Map<string, SessionTurn>()
  private generation = 0

  /**
   * @param limit - most sessions remembered; the oldest is evicted past it.
   */
  constructor(private readonly limit = 2_000) {}

  /**
   * Record a turn boundary for one session.
   * @param sessionId - the session the turn belongs to.
   * @param turn - the turn number the session log recorded.
   */
  noteTurnStart(sessionId: string, turn: number): void {
    // Re-insert so eviction follows activity rather than first sight.
    this.open.delete(sessionId)
    this.generation += 1
    this.open.set(sessionId, Object.freeze({ key: this.generation, turn }))
    if (this.open.size <= this.limit) return
    const oldest = this.open.keys().next()
    if (oldest.done !== true) this.open.delete(oldest.value)
  }

  /**
   * Close the open turn of one session, when it is the turn that ended.
   * @param sessionId - the session the turn belongs to.
   * @param turn - the turn number that ended, when the event named it.
   */
  noteTurnEnd(sessionId: string, turn?: number): void {
    const open = this.open.get(sessionId)
    if (open === undefined) return
    if (turn !== undefined && open.turn !== turn) return
    this.open.delete(sessionId)
  }

  /**
   * The open turn of one session.
   * @param sessionId - the session to read.
   * @returns the open turn, or undefined when the session has none.
   */
  current(sessionId: string): SessionTurn | undefined {
    return this.open.get(sessionId)
  }

  /**
   * Forget one session (disposal or account change).
   * @param sessionId - the session to forget.
   */
  forget(sessionId: string): void {
    this.open.delete(sessionId)
  }
}

/** One account's scheduling state, as the gate reports it. */
export interface AccountGateSnapshot {
  /** Sessions currently holding a turn slot on the account. */
  readonly activeSessions: number
  /** Sessions waiting for a turn slot on the account. */
  readonly queuedSessions: number
  /** Requests of this account's sessions currently in flight. */
  readonly inFlight: number
  /** Earliest instant the account's request limiter grants a token, when it is in the future. */
  readonly nextTokenAt?: number
  /** Failed credential refreshes recorded for the account since its last success. */
  readonly refreshAttempts?: number
  /** The account's parked instant, when a cooldown record holds it. */
  readonly cooldownUntil?: number
  /** The code of the record that parked the account. */
  readonly cooldownReason?: string
  /** Last instant an ordinary rate limit backed a session of this account off. */
  readonly lastRateLimitedAt?: number
}

/** A queue wait that ran out of budget; the gate turns it into a typed refusal. */
class QueueTimeout extends Error {}

/** One queued claimant of a shared resource. */
interface Waiter {
  grant(): void
  reject(error: unknown): void
}

/**
 * A FIFO mutex with a bounded wait.
 *
 * Ownership transfers directly from the releaser to the next waiter, so a freed
 * slot cannot be raced by a caller that only just arrived.
 */
class AsyncQueue {
  private held = false
  private disposed: unknown
  private readonly waiters: Waiter[] = []

  /** Waiters that have not been granted yet. */
  get queued(): number {
    return this.waiters.length
  }

  /**
   * Take ownership, or wait for the current owner.
   * @param timeoutMs - longest wait before {@link QueueTimeout}.
   * @param signal - caller cancellation.
   * @returns the release callback; call it exactly once.
   */
  async acquire(timeoutMs: number, signal?: AbortSignal): Promise<() => void> {
    if (this.disposed !== undefined) throw this.disposed
    signal?.throwIfAborted()
    if (!this.held) {
      this.held = true
      return () => { this.release() }
    }
    return await new Promise<() => void>((resolve, reject) => {
      let detach = (): void => {}
      const timer = setTimeout(() => {
        detach()
        reject(new QueueTimeout('queue wait timed out'))
      }, timeoutMs)
      timer.unref()
      const onAbort = (): void => {
        detach()
        reject(signal?.reason)
      }
      const waiter: Waiter = {
        grant: () => { detach(); resolve(() => { this.release() }) },
        reject: (error) => { detach(); reject(error) },
      }
      detach = () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /** Hand ownership to the next waiter, or free the queue. */
  private release(): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter.grant()
      return
    }
    this.held = false
  }

  /**
   * Refuse every current and future wait.
   * @param reason - the error each waiter receives.
   */
  dispose(reason: unknown): void {
    this.disposed = reason
    for (const waiter of [...this.waiters]) waiter.reject(reason)
    this.waiters.length = 0
    this.held = false
  }
}

/**
 * Sleep, unref'd so an idle timer never holds the process open.
 * @param ms - delay in milliseconds.
 * @param signal - caller cancellation.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted === true) return Promise.reject(signal.reason)
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Bookings the gate holds for one session. */
interface SessionState {
  /** Account the session's open turn is bound to, when one is held. */
  provider: ProviderId | undefined
  account: string | undefined
  /** Whether the session holds an account session slot. */
  turnHeld: boolean
  /** Requests of this session currently in flight (at most one by construction). */
  inFlight: number
  /** Instant the session's own backoff ends. */
  backoffUntil: number
  /** Consecutive backoffs, which set the next local delay. */
  backoffAttempts: number
  /** Last instant this session used its slot or sent a request. */
  lastUsedAt: number
  /** Last instant an ordinary rate limit was recorded for this session. */
  lastRateLimitedAt: number
}

/** One account's slot owners and queued sessions. */
interface SlotState {
  readonly sessions: Set<string>
  readonly waiters: Waiter[]
}

/** One account's shared request limiter. */
interface LimiterState {
  tokens: number
  updatedAt: number
  lastTakeAt: number
}

/**
 * Admission control for one pool: per-account session slots and request
 * limiter, per-session serialization and backoff, and account cooldowns.
 *
 * The gate holds no provider client and performs no I/O; it only decides when a
 * request may be sent and records the state the next decision reads. Account
 * cooldowns live in the pool's {@link PoolHealthRegistry}, so the Settings card
 * states the same fact the scheduler obeys.
 */
export class PoolGate {
  private readonly health: PoolHealthRegistry
  private readonly policy: PoolGatePolicy
  private readonly now: () => number
  private readonly random: () => number
  private readonly sessions = new Map<string, SessionState>()
  private readonly slots = new Map<string, SlotState>()
  private readonly limiters = new Map<string, LimiterState>()
  /** Failed credential refreshes per account since its last success. */
  private readonly refreshes = new Map<string, number>()
  private readonly sessionQueues = new Map<string, AsyncQueue>()
  private readonly limiterQueues = new Map<string, AsyncQueue>()
  private sweep: ReturnType<typeof setTimeout> | undefined
  private disposed: unknown

  /**
   * @param policy - validated concurrency and backoff choices.
   * @param health - the pool's account cooldown registry.
   * @param deps - clock and jitter source; the defaults are real time and `Math.random`.
   */
  constructor(
    policy: PoolGatePolicy,
    health: PoolHealthRegistry,
    deps: { now?: () => number; random?: () => number } = {},
  ) {
    this.policy = policy
    this.health = health
    this.now = deps.now ?? (() => Date.now())
    this.random = deps.random ?? Math.random
  }

  /** The policy this gate enforces. */
  get concurrency(): PoolGatePolicy {
    return this.policy
  }

  /**
   * Reserve one of the account's session slots for a session's turn.
   *
   * A session already holding this account's slot keeps it; a session moving to
   * another account releases the old slot first. The next session of one account
   * waits in FIFO order until a slot is released, and a wait beyond the
   * configured budget is refused rather than queued forever.
   * @param slotKey - session identity owning the slot (a request key for a sessionless request).
   * @param provider - the account's provider route.
   * @param account - the account key.
   * @param signal - caller cancellation.
   */
  async acquireTurn(slotKey: string, provider: ProviderId, account: string, signal?: AbortSignal): Promise<void> {
    this.assertUsable(provider, account, signal)
    const startedAt = this.now()
    this.releaseIdle(startedAt)
    const deadline = startedAt + this.policy.queueTimeoutMs
    let state = this.stateFor(slotKey)
    if (state.turnHeld && state.provider === provider && state.account === account) {
      state.lastUsedAt = startedAt
      return
    }
    if (state.turnHeld) {
      this.releaseTurn(slotKey)
      state = this.stateFor(slotKey)
    }
    try {
      await this.acquireSlot(slotKey, accountKey(provider, account), deadline, signal)
    } catch (error: unknown) {
      throw this.wrapWait(error, `session slot for ${provider}/${account}`)
    }
    state = this.stateFor(slotKey)
    state.turnHeld = true
    state.provider = provider
    state.account = account
    state.lastUsedAt = this.now()
    this.armSweep()
  }

  /**
   * Release a session's turn slot (turn end, disposal, or a slot that never
   * served a request).
   * @param slotKey - session identity holding the slot.
   */
  releaseTurn(slotKey: string): void {
    const state = this.sessions.get(slotKey)
    if (state === undefined) return
    if (!state.turnHeld) return
    state.turnHeld = false
    if (state.provider !== undefined && state.account !== undefined) {
      this.releaseSlot(slotKey, accountKey(state.provider, state.account))
    }
    state.provider = undefined
    state.account = undefined
  }

  /**
   * Start a new turn for one session: the retry budget is per logical request
   * cycle, so a new turn begins with a fresh one while its backoff stays in force.
   * @param slotKey - the session whose turn started.
   */
  beginTurn(slotKey: string): void {
    const state = this.sessions.get(slotKey)
    if (state !== undefined) state.backoffAttempts = 0
  }

  /**
   * Record one failed credential refresh and report whether the account's refresh
   * budget is spent. A spent budget resets the counter, because the account is
   * parked for a full auth cooldown and gets a fresh cycle afterwards.
   * @param provider - the account's provider route.
   * @param account - the account key.
   * @returns the attempt number and whether the account must now be parked.
   */
  noteRefreshFailure(provider: ProviderId, account: string): { attempts: number; exhausted: boolean } {
    const key = accountKey(provider, account)
    const attempts = (this.refreshes.get(key) ?? 0) + 1
    if (attempts > this.policy.maxRefreshAttempts) {
      this.refreshes.delete(key)
      return { attempts, exhausted: true }
    }
    this.refreshes.set(key, attempts)
    return { attempts, exhausted: false }
  }

  /**
   * Wait until this session may send one request to the account.
   *
   * The three waits compose: the session's own serialization (one request in
   * flight), its own backoff, and a token of the account's shared limiter. A
   * wait longer than the configured budget becomes a typed refusal carrying the
   * instant the request may be retried.
   * @param slotKey - session identity; requests of one session never overlap.
   * @param provider - the account's provider route.
   * @param account - the account key.
   * @param signal - caller cancellation.
   * @returns the release callback; call it when the request ends, whatever its outcome.
   */
  async admit(slotKey: string, provider: ProviderId, account: string, signal?: AbortSignal): Promise<() => void> {
    this.assertUsable(provider, account, signal)
    const startedAt = this.now()
    const deadline = startedAt + this.policy.queueTimeoutMs
    this.releaseIdle(startedAt)
    const queue = this.queueFor(this.sessionQueues, slotKey)
    let unlock: (() => void) | undefined
    try {
      unlock = await queue.acquire(this.remaining(deadline), signal)
    } catch (error: unknown) {
      throw this.wrapWait(error, `request slot for ${provider}/${account}`)
    }
    const state = this.stateFor(slotKey)
    try {
      if (state.backoffAttempts > this.policy.backoff.maxRetries) {
        throw this.retryBudgetError(state.backoffUntil - this.now())
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const wait = state.backoffUntil - this.now()
        if (wait <= 0) break
        if (wait > this.remaining(deadline)) throw this.backoffError(wait)
        await sleep(wait, signal)
      }
      if (state.backoffUntil > this.now()) throw this.backoffError(state.backoffUntil - this.now())
      this.assertUsable(provider, account, signal)
      await this.takeToken(provider, account, deadline, signal)
      this.assertUsable(provider, account, signal)
      state.inFlight += 1
      state.lastUsedAt = this.now()
      return () => {
        state.inFlight = Math.max(0, state.inFlight - 1)
        state.lastUsedAt = this.now()
        unlock?.()
      }
    } catch (error: unknown) {
      unlock()
      throw error
    }
  }

  /**
   * Record an ordinary failure of one session: it backs off alone, and no other
   * session or account is affected.
   * @param slotKey - the session whose request failed.
   * @param failure - the classified effect; `delayMs` is the provider's own wait when it stated one.
   */
  noteSessionFailure(slotKey: string, failure: { readonly reason: string; readonly delayMs?: number }): void {
    const state = this.stateFor(slotKey)
    state.backoffAttempts += 1
    const delay = failure.delayMs ?? this.backoffDelay(state.backoffAttempts)
    state.backoffUntil = Math.max(state.backoffUntil, this.now() + delay)
    if (failure.reason === 'RATE_LIMIT') state.lastRateLimitedAt = this.now()
  }

  /**
   * Clear one session's backoff after a request completed.
   * @param slotKey - the session that succeeded.
   */
  noteSuccess(slotKey: string): void {
    const state = this.sessions.get(slotKey)
    if (state === undefined) return
    state.backoffAttempts = 0
    state.backoffUntil = 0
    if (state.provider !== undefined && state.account !== undefined) {
      this.refreshes.delete(accountKey(state.provider, state.account))
    }
  }

  /**
   * Park one account until the instant its window or refusal disclosed.
   *
   * The record lives in the shared health registry, so every session and the
   * Settings card read the same cooldown.
   * @param provider - the account's provider route.
   * @param account - the account key.
   * @param cooldownMs - how long the account stays parked.
   * @param reason - the failure code the record names.
   */
  cooldown(provider: ProviderId, account: string, cooldownMs: number, reason: string): void {
    this.health.markUnavailable(accountKey(provider, account), cooldownMs, reason)
  }

  /**
   * Forget one session's bookings (session or agent disposal).
   * @param slotKey - the session to forget.
   */
  forget(slotKey: string): void {
    this.releaseTurn(slotKey)
    this.sessionQueues.get(slotKey)?.dispose(new Error('session disposed'))
    this.sessionQueues.delete(slotKey)
    this.sessions.delete(slotKey)
  }

  /**
   * Report the account's current scheduling state.
   * @param provider - the account's provider route.
   * @param account - the account key.
   * @returns the account's slot, limiter and cooldown facts.
   */
  snapshot(provider: ProviderId, account: string): AccountGateSnapshot {
    const key = accountKey(provider, account)
    const slotState = this.slots.get(key)
    const now = this.now()
    const cooling = this.health.accountCooling(provider, account, now)
    let inFlight = 0
    let lastRateLimitedAt: number | undefined
    for (const state of this.sessions.values()) {
      if (state.provider !== provider || state.account !== account) continue
      inFlight += state.inFlight
      if (state.lastRateLimitedAt > 0
        && (lastRateLimitedAt === undefined || state.lastRateLimitedAt > lastRateLimitedAt)) {
        lastRateLimitedAt = state.lastRateLimitedAt
      }
    }
    const limiter = this.limiters.get(key)
    const readyAt = limiter === undefined ? undefined : this.limiterReadyAt(limiter, now)
    const refreshAttempts = this.refreshes.get(key)
    return {
      activeSessions: slotState?.sessions.size ?? 0,
      queuedSessions: slotState?.waiters.length ?? 0,
      inFlight,
      ...readyAt === undefined || readyAt <= now ? {} : { nextTokenAt: readyAt },
      ...refreshAttempts === undefined ? {} : { refreshAttempts },
      ...cooling === undefined ? {} : { cooldownUntil: cooling.unavailableUntil, cooldownReason: cooling.reason },
      ...lastRateLimitedAt === undefined ? {} : { lastRateLimitedAt },
    }
  }

  /**
   * Refuse every queued wait; used when the pool is disposed.
   * @param reason - the error each waiter receives.
   */
  dispose(reason: unknown = new Error('pool gate disposed')): void {
    this.disposed = reason
    if (this.sweep !== undefined) clearTimeout(this.sweep)
    this.sweep = undefined
    for (const queue of this.sessionQueues.values()) queue.dispose(reason)
    for (const queue of this.limiterQueues.values()) queue.dispose(reason)
    for (const slots of this.slots.values()) {
      for (const waiter of [...slots.waiters]) waiter.reject(reason)
      slots.waiters.length = 0
    }
  }

  /** Refuse admission when the gate is disposed. */
  private assertAlive(): void {
    if (this.disposed !== undefined) throw this.disposed
  }

  /** Refuse admission for a parked account. */
  private assertUsable(provider: ProviderId, account: string, signal?: AbortSignal): void {
    this.assertAlive()
    signal?.throwIfAborted()
    const now = this.now()
    const cooling = this.health.accountCooling(provider, account, now)
    if (cooling === undefined) return
    const retryAfter = Math.max(cooling.unavailableUntil - now, 1)
    const reason: PoolGateReason = isAuthCooldownReason(cooling.reason) ? 'account_unavailable'
      : cooling.reason === QUOTA_EXCEEDED_CODE ? 'quota_exhausted'
        : cooling.reason === 'RATE_LIMIT' ? 'rate_limited'
          : 'account_unavailable'
    throw new PoolGateError(
      `${provider}/${account} is parked until ${new Date(cooling.unavailableUntil).toISOString()}`
      + ` (${cooling.reason}); no request is sent while it is cooling`,
      reason,
      { providerRetryAfterMs: retryAfter },
      coolingCode(cooling.reason),
    )
  }

  /** One session's state, created on first use. */
  private stateFor(slotKey: string): SessionState {
    let state = this.sessions.get(slotKey)
    if (state === undefined) {
      state = {
        provider: undefined,
        account: undefined,
        turnHeld: false,
        inFlight: 0,
        backoffUntil: 0,
        backoffAttempts: 0,
        lastUsedAt: this.now(),
        lastRateLimitedAt: 0,
      }
      this.sessions.set(slotKey, state)
    }
    return state
  }

  /** One account's slot book. */
  private slotsFor(key: string): SlotState {
    let slots = this.slots.get(key)
    if (slots === undefined) {
      slots = { sessions: new Set(), waiters: [] }
      this.slots.set(key, slots)
    }
    return slots
  }

  /** Wait for, or take, one session slot of an account. */
  private async acquireSlot(slotKey: string, key: string, deadline: number, signal?: AbortSignal): Promise<void> {
    this.assertAlive()
    if (signal?.aborted === true) throw signal.reason
    const slots = this.slotsFor(key)
    if (slots.sessions.has(slotKey)) return
    if (slots.sessions.size < this.policy.maxSessionsPerAccount) {
      slots.sessions.add(slotKey)
      return
    }
    await new Promise<void>((resolve, reject) => {
      let detach = (): void => {}
      const timer = setTimeout(() => {
        detach()
        reject(new QueueTimeout(`all ${String(this.policy.maxSessionsPerAccount)} sessions are busy`))
      }, this.remaining(deadline))
      timer.unref()
      const onAbort = (): void => {
        detach()
        reject(signal?.reason)
      }
      const waiter: Waiter = {
        grant: () => { detach(); resolve() },
        reject: (error) => { detach(); reject(error) },
      }
      detach = () => {
        const index = slots.waiters.indexOf(waiter)
        if (index >= 0) slots.waiters.splice(index, 1)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      slots.waiters.push(waiter)
    })
    // The granted waiter takes the freed slot here, before any other arrival can.
    slots.sessions.add(slotKey)
  }

  /** Free one session slot and hand it to the oldest waiter. */
  private releaseSlot(slotKey: string, key: string): void {
    const slots = this.slots.get(key)
    if (slots === undefined) return
    slots.sessions.delete(slotKey)
    slots.waiters.shift()?.grant()
  }

  /** Release slots of sessions that stopped using them without a turn end. */
  private releaseIdle(now: number): void {
    for (const [slotKey, state] of this.sessions) {
      if (state.inFlight > 0) continue
      const idle = now - state.lastUsedAt
      if (state.turnHeld && idle < this.policy.sessionIdleMs) continue
      if (state.turnHeld) {
        this.releaseTurn(slotKey)
        continue
      }
      if (idle >= this.policy.sessionIdleMs && state.backoffUntil <= now) this.sessions.delete(slotKey)
    }
  }

  /**
   * Schedule one idle sweep, so a session that lost its turn end still frees its
   * slot for a queued session instead of holding it until disposal.
   */
  private armSweep(): void {
    if (this.sweep !== undefined) return
    this.sweep = setTimeout(() => {
      this.sweep = undefined
      if (this.disposed !== undefined) return
      this.releaseIdle(this.now())
    }, this.policy.sessionIdleMs)
    this.sweep.unref()
  }

  /** Remaining budget of one admission, never below one millisecond. */
  private remaining(deadline: number): number {
    return Math.max(deadline - this.now(), 1)
  }

  /** Wrap a queue wait that ran out of budget into the typed refusal. */
  private wrapWait(error: unknown, subject: string): unknown {
    if (!(error instanceof QueueTimeout)) return error
    return new PoolGateError(
      `no ${subject} within ${String(this.policy.queueTimeoutMs)}ms; the account is at its session or rate limit`,
      'rate_limited',
      { providerRetryAfterMs: this.policy.queueTimeoutMs },
    )
  }

  /** The typed refusal of a session whose backoff exceeds the queue budget. */
  private backoffError(waitMs: number): PoolGateError {
    const retryAfter = Math.max(Math.ceil(waitMs), 1)
    return new PoolGateError(
      `session must back off for another ${String(retryAfter)}ms before its next request`,
      'rate_limited',
      { providerRetryAfterMs: retryAfter },
    )
  }

  /**
   * The typed refusal of a session that spent its whole retry budget.
   *
   * It carries the hard stop: the next turn starts a fresh budget, but this
   * logical request may not spend another resend.
   */
  private retryBudgetError(waitMs: number): PoolGateError {
    const retryAfter = Math.max(Math.ceil(waitMs), 1)
    return new PoolGateError(
      `session retry budget of ${String(this.policy.backoff.maxRetries)} backoffs is spent;`
      + ' the turn stops retrying',
      'rate_limited',
      { providerRetryAfterMs: retryAfter, retryDisposition: 'forbid' },
    )
  }

  /** Exponential local backoff with bounded symmetric jitter. */
  private backoffDelay(attempt: number): number {
    const { initialDelayMs, maxDelayMs, jitterRatio } = this.policy.backoff
    const base = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.max(attempt - 1, 0))
    const jitter = (this.random() * 2 - 1) * jitterRatio
    return Math.max(1, Math.round(base * (1 + jitter)))
  }

  /** The queue serializing one session's requests. */
  private queueFor(queues: Map<string, AsyncQueue>, key: string): AsyncQueue {
    let queue = queues.get(key)
    if (queue === undefined) {
      queue = new AsyncQueue()
      queues.set(key, queue)
    }
    return queue
  }

  /** One account's limiter state. */
  private limiterFor(key: string): LimiterState {
    let limiter = this.limiters.get(key)
    if (limiter === undefined) {
      limiter = { tokens: this.policy.burst, updatedAt: this.now(), lastTakeAt: 0 }
      this.limiters.set(key, limiter)
    }
    return limiter
  }

  /** Refill an account's bucket to the present instant. */
  private refill(limiter: LimiterState, now: number): void {
    if (this.policy.requestsPerMinute <= 0) {
      limiter.tokens = this.policy.burst
      limiter.updatedAt = now
      return
    }
    const perMs = this.policy.requestsPerMinute / 60_000
    limiter.tokens = Math.min(this.policy.burst, limiter.tokens + (now - limiter.updatedAt) * perMs)
    limiter.updatedAt = now
  }

  /** Earliest instant a token is available, including the account's minimum gap. */
  private limiterReadyAt(limiter: LimiterState, now: number): number {
    this.refill(limiter, now)
    const gapReady = limiter.lastTakeAt > 0 ? limiter.lastTakeAt + this.policy.minGapMs : now
    if (this.policy.requestsPerMinute <= 0) return Math.max(gapReady, now)
    if (limiter.tokens >= 1) return Math.max(gapReady, now)
    const perMs = this.policy.requestsPerMinute / 60_000
    return Math.max(gapReady, now + (1 - limiter.tokens) / perMs)
  }

  /** Take one token of the account's shared limiter, waiting inside the budget. */
  private async takeToken(provider: ProviderId, account: string, deadline: number, signal?: AbortSignal): Promise<void> {
    if (this.policy.requestsPerMinute <= 0 && this.policy.minGapMs <= 0) return
    const key = accountKey(provider, account)
    const queue = this.queueFor(this.limiterQueues, key)
    let unlock: (() => void) | undefined
    try {
      unlock = await queue.acquire(this.remaining(deadline), signal)
    } catch (error: unknown) {
      throw this.wrapWait(error, `request token for ${provider}/${account}`)
    }
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const now = this.now()
        const limiter = this.limiterFor(key)
        const readyAt = this.limiterReadyAt(limiter, now)
        if (readyAt > deadline) {
          const retryAfter = Math.max(Math.ceil(readyAt - now), 1)
          throw new PoolGateError(
            `${provider}/${account} request limiter allows its next request in ${String(retryAfter)}ms`,
            'rate_limited',
            { providerRetryAfterMs: retryAfter },
          )
        }
        if (readyAt > now) {
          await sleep(readyAt - now, signal)
          continue
        }
        this.refill(limiter, now)
        limiter.tokens = this.policy.requestsPerMinute <= 0 ? this.policy.burst : limiter.tokens - 1
        limiter.lastTakeAt = now
        return
      }
      throw new PoolGateError(
        `${provider}/${account} request limiter did not grant a token within ${String(this.policy.queueTimeoutMs)}ms`,
        'rate_limited',
        { providerRetryAfterMs: this.policy.queueTimeoutMs },
      )
    } finally {
      unlock()
    }
  }
}
