/**
 * Health bookkeeping for pool members: which `(provider, account, model)`
 * member is cooling down after a failure, and for how long. Purely in-memory
 * — a restart re-probes members naturally, so nothing here is persisted.
 *
 * The failure classifier maps the adapters' stable `LlmError` codes (see
 * `httpLlmError`/`mapFetchFailure` in `common.ts`) to one of three actions:
 * switch to another member with a cooldown, switch without recording a
 * cooldown (transport blips say nothing about the account), or rethrow
 * (the request itself is at fault and another account would fail alike).
 *
 * An enforcement-shaped refusal — a rate-limit refusal the provider stated is
 * final, and every credential refusal — is neither: it parks the account and
 * ends the turn on that refusal, because answering it from another account
 * multiplies the traffic the refusal was aimed at.
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { ProviderId } from '../auth/store.js'
import { ENFORCEMENT_CODE } from './common.js'

/** Registry key for one pool member. */
export function memberKey(provider: ProviderId, account: string, model: string): string {
  return `${provider}/${account}/${model}`
}

/** Registry key parking EVERY member of one account (account-level failures). */
export function accountKey(provider: ProviderId, account: string): string {
  return `${provider}/${account}/*`
}

/** Default cooldown when a quota, rate, or enforcement failure carries no `retry-after`. */
export const DEFAULT_QUOTA_COOLDOWN_MS = 5 * 60_000
/** Auth failures recheck after a day; a re-login clears the record immediately. */
export const AUTH_COOLDOWN_MS = 24 * 60 * 60_000
/** Transient server-side failures cool down briefly. */
export const TRANSIENT_COOLDOWN_MS = 60_000

/** Whether a failure parks one member or the account's whole quota. */
export type PoolFailureScope = 'member' | 'account'

/**
 * Codes naming a refusal the provider aimed at one identity: an
 * enforcement-shaped rejection, and every credential refusal. A pool answers
 * none of them from another account.
 */
const REFUSAL_CODES: readonly string[] = [
  ENFORCEMENT_CODE,
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
]

/**
 * Whether a failure code names a refusal the provider aimed at one identity.
 * @param code - the failure code a member reported.
 * @returns true when another account of the same subscription must not be asked.
 */
export function isRefusalCode(code: string): boolean {
  return REFUSAL_CODES.includes(code)
}

/**
 * The code naming why a pool served nothing: the refusal when its members
 * reported one, otherwise their single shared reason, otherwise the
 * cooling-down state they have in common. A refusal outranks a rate limit
 * another member reported, because naming the rate limit would hand a refused
 * account's turn back to the retry loop.
 * @param codes - every reason a selection recorded or found parked.
 * @returns the terminal error's code.
 */
export function exhaustionCode(codes: ReadonlySet<string>): string {
  for (const reason of REFUSAL_CODES) {
    if (codes.has(reason)) return reason
  }
  const [onlyReason, ...others] = [...codes]
  return onlyReason !== undefined && others.length === 0 ? onlyReason : 'RATE_LIMIT'
}

/**
 * Whether a cooldown reason records a login that stopped working rather than a
 * spent allowance. Only a re-login clears these; every other parked account
 * recovers on its own once its window reopens.
 */
export function isAuthCooldownReason(reason: string): boolean {
  return reason === 'AUTH' || reason === 'INVALID_CREDENTIAL' || reason === 'MISSING_CREDENTIAL'
}

/** What the pool should do with a member that just failed. */
export type PoolFailureAction =
  /** Park the failing member or account, then try the next one. */
  | { action: 'switch'; cooldownMs: number; reason: string; scope: PoolFailureScope }
  /** Try the next member without recording anything about this one. */
  | { action: 'switch' }
  /** Fail the turn with this error; another member would fail alike. */
  | { action: 'throw' }
  /**
   * Park the account and fail the turn on this refusal. The provider refused
   * this identity, so another account of the same subscription only repeats the
   * refusal — which is the traffic such a refusal is meant to stop.
   */
  | { action: 'park'; cooldownMs: number; reason: string; scope: PoolFailureScope }

/**
 * Providers whose quota windows are model-scoped, so a quota failure on one
 * model says nothing about its siblings (Claude's Opus/Sonnet lanes). Every
 * other provider meters the account as a whole: one member hitting the wall
 * means its siblings on the SAME account would too, so the cooldown parks
 * the account (other accounts of the provider are unaffected).
 */
const MODEL_SCOPED_QUOTA_PROVIDERS: ReadonlySet<ProviderId> = new Set(['claude'])

/** The `retry-after` an adapter propagated through `httpLlmError`, when any. */
function retryAfterMs(error: LlmError): number | undefined {
  return error.failure.providerRetryAfterMs
}

/**
 * Classify a member failure. Quota and rate-limit failures cool down (using
 * the provider's own `retry-after` when sent, which is more accurate than
 * any fixed guess) — account-wide for account-metered providers, per-member
 * for model-scoped ones; server/timeout failures get a short per-member
 * cooldown; transport failures switch without a record; everything else —
 * most importantly CONTEXT_WINDOW_EXCEEDED and ABORTED — is the request's own
 * fault and is rethrown untouched.
 *
 * Enforcement-shaped refusals park the account and end the turn instead of
 * switching: a rate-limit refusal the provider stated is final
 * ({@link ENFORCEMENT_CODE}), and every credential refusal, since credentials
 * are account-level. Both record a cooldown — the disclosed reset when the
 * refusal carried one, {@link AUTH_COOLDOWN_MS} for a dead login — so the
 * account is not asked again until something may have changed.
 * @param error - the failure thrown by a member adapter's stream.
 * @param provider - the failing member's provider (decides the quota scope).
 * @returns the action the pool should take.
 */
export function classifyPoolFailure(error: unknown, provider: ProviderId): PoolFailureAction {
  if (!(error instanceof LlmError)) return { action: 'throw' }
  switch (error.code) {
    case QUOTA_EXCEEDED_CODE:
    case 'RATE_LIMIT':
      return {
        action: 'switch',
        cooldownMs: retryAfterMs(error) ?? DEFAULT_QUOTA_COOLDOWN_MS,
        reason: error.code,
        scope: MODEL_SCOPED_QUOTA_PROVIDERS.has(provider) ? 'member' : 'account',
      }
    case ENFORCEMENT_CODE:
      return {
        action: 'park',
        cooldownMs: retryAfterMs(error) ?? DEFAULT_QUOTA_COOLDOWN_MS,
        reason: error.code,
        scope: 'account',
      }
    case 'AUTH':
    case 'INVALID_CREDENTIAL':
    case 'MISSING_CREDENTIAL':
      return { action: 'park', cooldownMs: AUTH_COOLDOWN_MS, reason: error.code, scope: 'account' }
    case 'SERVER':
    case 'TIMEOUT':
    case 'EMPTY_RESPONSE':
      return { action: 'switch', cooldownMs: TRANSIENT_COOLDOWN_MS, reason: error.code, scope: 'member' }
    case 'TRANSPORT':
      return { action: 'switch' }
    case 'HTTP_402':
    case 'HTTP_404':
      // Plan/model availability is account-shaped: another account of the
      // same subscription may still serve. A 400 that is not a context-window
      // error stays HTTP_400 and throws (the request itself is at fault).
      return { action: 'switch', cooldownMs: TRANSIENT_COOLDOWN_MS, reason: error.code, scope: 'member' }
    case CONTEXT_WINDOW_EXCEEDED_CODE:
    case 'ABORTED':
    default:
      return { action: 'throw' }
  }
}

/** One parked account or member: how long it sits out, and the failure code that parked it. */
export interface HealthRecord {
  unavailableUntil: number
  reason: string
}

/**
 * Cooldown registry keyed by {@link memberKey}. A member whose cooldown has
 * expired is simply available again — recovery is proven by the next real
 * request, not by a background probe.
 */
export class PoolHealthRegistry {
  private readonly records = new Map<string, HealthRecord>()

  /** Whether a member may serve: neither it nor its whole account is cooling. */
  isMemberAvailable(provider: ProviderId, account: string, model: string, now = Date.now()): boolean {
    return this.isAvailable(accountKey(provider, account), now)
      && this.isAvailable(memberKey(provider, account, model), now)
  }

  /** Whether one registry key is clear right now. */
  isAvailable(key: string, now = Date.now()): boolean {
    const record = this.records.get(key)
    if (record === undefined) return true
    if (record.unavailableUntil <= now) {
      this.records.delete(key)
      return true
    }
    return false
  }

  /** Park a member for `cooldownMs`; a longer existing cooldown wins. */
  markUnavailable(key: string, cooldownMs: number, reason: string, now = Date.now()): void {
    const until = now + cooldownMs
    const existing = this.records.get(key)
    if (existing !== undefined && existing.unavailableUntil > until) return
    this.records.set(key, { unavailableUntil: until, reason })
  }

  /**
   * The cooldown parking one account right now, when any: the longest-lived
   * unexpired record among that account's account key and its member keys,
   * with the reason that record holds. Expired records are dropped on the way,
   * the same recovery {@link isAvailable} performs.
   * @param provider - the account's provider route.
   * @param account - the account key.
   * @param now - the current epoch milliseconds.
   * @returns the parking record, or undefined when the account may serve.
   */
  accountCooling(provider: ProviderId, account: string, now = Date.now()): HealthRecord | undefined {
    const prefix = `${provider}/${account}/`
    let found: HealthRecord | undefined
    for (const [key, record] of [...this.records]) {
      if (!key.startsWith(prefix)) continue
      if (record.unavailableUntil <= now) {
        this.records.delete(key)
        continue
      }
      if (found === undefined || record.unavailableUntil > found.unavailableUntil) found = record
    }
    return found
  }

  /**
   * Epoch ms at which the earliest cooling record among `keys` recovers;
   * `undefined` when none of them is cooling. The registry is shared by
   * every pool, so the caller passes the keys of ITS members (member and
   * account keys alike) — an unrelated pool's cooldown must not shape this
   * pool's retry hint. Feeds the pool-exhausted error's
   * `providerRetryAfterMs`.
   */
  earliestRecovery(keys: ReadonlySet<string>, now = Date.now()): number | undefined {
    let earliest: number | undefined
    for (const [key, record] of this.records) {
      if (record.unavailableUntil <= now) {
        this.records.delete(key)
        continue
      }
      if (!keys.has(key)) continue
      if (earliest === undefined || record.unavailableUntil < earliest) {
        earliest = record.unavailableUntil
      }
    }
    return earliest
  }

  /** Drop records of one provider, or of a single account when given (auth changes). */
  clear(provider: ProviderId, account?: string): void {
    const prefix = account === undefined ? `${provider}/` : `${provider}/${account}/`
    for (const key of [...this.records.keys()]) {
      if (key.startsWith(prefix)) this.records.delete(key)
    }
  }
}
