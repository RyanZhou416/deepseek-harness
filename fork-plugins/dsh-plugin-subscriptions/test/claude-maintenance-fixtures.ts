/**
 * Deterministic fixtures for the Claude account-maintenance tests and the wire tests that need a
 * durable continuation owner.
 *
 * The clock and the scheduler are injected, so no test sleeps or depends on wall-clock
 * timing. The credential store is the shipped one, writing into the private `DSH_HOME`
 * `test/isolate-home.mjs` created for this process — credentials are synthetic labels and
 * no real account, endpoint or harness home is touched. The continuation owner is the
 * shipped state over a directory the case owns and removes with it.
 *
 * `TokenManager` itself reads the wall clock when it decides whether a credential is
 * inside the preempt window, so seeded expiries are stated relative to `Date.now()` and
 * the manual clock starts there.
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { AccountTokenManagerOptions } from '../src/providers/accounts.js'
import { saveAccountSession } from '../src/auth/store.js'
import type { ClaudeSession } from '../src/auth/store.js'
import { ClaudeContinuationState } from '../src/providers/claude-continuation-state.js'
import type { ClaudeClock, ClaudeScheduler, ClaudeTimer } from '../src/providers/claude-account-state.js'

/** The instant every manual clock starts from. */
export const TEST_NOW = Date.now()

/** A clock the test moves by hand. */
export class ManualClock implements ClaudeClock {
  constructor(private at: number = TEST_NOW) {}

  /** Current manual time. */
  now(): number {
    return this.at
  }

  /** Move the manual time forward without firing anything. */
  advanceTo(at: number): void {
    this.at = at
  }
}

/** A scheduler that runs nothing until {@link ManualScheduler.advance} says so. */
export class ManualScheduler implements ClaudeScheduler {
  private nextId = 1
  private readonly timers = new Map<number, { at: number; run: () => void }>()

  constructor(private readonly clock: ManualClock) {}

  setTimer(delayMs: number, run: () => void): ClaudeTimer {
    const id = this.nextId
    this.nextId += 1
    this.timers.set(id, { at: this.clock.now() + Math.max(delayMs, 0), run })
    return { cancel: () => { this.timers.delete(id) } }
  }

  /** How many timers are still armed; zero after the last release is the point of several tests. */
  get pending(): number {
    return this.timers.size
  }

  /**
   * Move the clock forward and run every timer that becomes due, yielding to real I/O
   * between callbacks so each cycle's store reads and writes settle before the next.
   * @param ms - how far to advance.
   */
  async advance(ms: number): Promise<void> {
    const target = this.clock.now() + ms
    for (let guard = 0; guard < 200; guard += 1) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (due === undefined) break
      this.timers.delete(due[0])
      this.clock.advanceTo(Math.max(this.clock.now(), due[1].at))
      due[1].run()
      await settle()
    }
    this.clock.advanceTo(target)
  }

  /**
   * Run every timer due within `ms`, including ones a finished cycle arms while draining.
   *
   * {@link advance} fires the timers that exist when it starts; a cycle that re-arms its
   * own timer from a real store read needs the loop to keep yielding, which is what this
   * does — bounded by a round budget so a zero-delay loop is still observable as one.
   * @param ms - how far to advance.
   * @param rounds - how many fire/yield rounds to allow.
   * @returns the number of timers that ran.
   */
  async drain(ms: number, rounds = 300): Promise<number> {
    const target = this.clock.now() + ms
    let fired = 0
    for (let round = 0; round < rounds; round += 1) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (due !== undefined) {
        this.timers.delete(due[0])
        this.clock.advanceTo(Math.max(this.clock.now(), due[1].at))
        due[1].run()
        fired += 1
      }
      // A real timer turn, so the store lock's own retries and pending file I/O complete.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    }
    return fired
  }
}

/**
 * Yield to the event loop enough times for real file I/O and timer callbacks to settle.
 * @param rounds - how many turns to yield; the default covers a store round trip plus its callback.
 */
export async function settle(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
}

/**
 * Yield until a condition holds, so a test waits for real file I/O without a fixed sleep.
 *
 * The wait is bounded by wall-clock time and yields through the timer phase as well as the
 * check phase, because the shipped store lock waits with real timers.
 * @param predicate - the condition to wait for.
 * @param timeoutMs - how long to allow before giving up.
 * @returns true when the condition held.
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }
  return predicate()
}

/** A synthetic account key unique to one test. */
export function uniqueAccount(label: string): string {
  return `${label}-${randomBytes(4).toString('hex')}@example.invalid`
}

/** A synthetic session; a negative `expiresInMs` is already expired. */
export function claudeSession(account: string, overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    accessToken: `at-${account}`,
    refreshToken: `rt-${account}`,
    expiresAt: TEST_NOW + 3_600_000,
    scopes: 'user:profile user:inference',
    emailAddress: account,
    ...overrides,
  }
}

/** Store one synthetic session in the private test home. */
export async function seedClaudeSession(session: ClaudeSession): Promise<void> {
  await saveAccountSession('claude', session.emailAddress ?? session.accessToken, session)
}

/** Options for {@link claudeTokens}. */
export interface ClaudeTokensOptions {
  refresh: (session: ClaudeSession) => Promise<ClaudeSession>
  preemptMs?: number
  isPermanent?: (error: unknown) => boolean
  refreshOwnership?: AccountTokenManagerOptions<ClaudeSession>['refreshOwnership']
}

/** The shipped account token manager over the private test store. */
export function claudeTokens(options: ClaudeTokensOptions): AccountTokenManager<ClaudeSession> {
  return new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Claude (maintenance test)',
    makeOptions: () => ({
      preemptMs: options.preemptMs ?? 0,
      refresh: options.refresh,
      isPermanent: options.isPermanent ?? (() => false),
    }),
    ...options.refreshOwnership === undefined ? {} : { refreshOwnership: options.refreshOwnership },
  })
}

/** A deferred promise, so a test can decide when one provider answer lands. */
export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

/** Create one externally settled promise. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((settleResolve, settleReject) => {
    resolve = settleResolve
    reject = settleReject
  })
  return { promise, resolve, reject }
}

/**
 * The shipped durable continuation owner over a private directory this case owns.
 *
 * The owner is not a mock: each named account key is established as an identity generation before
 * the case runs, and the state is closed and its directory removed however the case ends, so no
 * request is served under an identity a later case could reuse.
 * @param t - the case that owns the state.
 * @param accounts - the canonical account keys the case serves.
 * @returns the established state, for an adapter's `continuation` option.
 */
export async function ownedClaudeContinuation(
  t: Pick<TestContext, 'after'>,
  accounts: readonly string[],
): Promise<ClaudeContinuationState> {
  const root = await mkdtemp(join(tmpdir(), 'claude-continuation-'))
  const state = new ClaudeContinuationState({ root, deadlineMs: 1_000, lockTimeoutMs: 2_000 })
  t.after(async () => {
    await state.close()
    await rm(root, { recursive: true, force: true })
  })
  for (const account of accounts) {
    const advanced = await state.initialize(account)
    assert.equal(advanced.kind, 'advanced', `the identity generation of ${account} was not established`)
  }
  return state
}
