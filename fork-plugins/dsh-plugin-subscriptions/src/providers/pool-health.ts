/**
 * Health bookkeeping for pool members: which `(provider, account, model)`
 * member is cooling down after a failure, and for how long. Purely in-memory
 * — a restart re-probes members naturally, so nothing here is persisted.
 *
 * The failure classifier states what one failure is evidence about. It never
 * says "try the sibling account": a turn is bound to one account, and answering
 * a request from a second account is the amplification the concurrency policy
 * exists to stop. The effects it can name are:
 *
 * - the session backs off alone (`session-backoff`), which is what a transient
 *   status, an ordinary rate limit, a network fault or a timeout says;
 * - the account is parked until a disclosed reset (`account-cooldown`), which is
 *   what a window/quota 429, a spent allowance or an exhausted refresh budget says;
 * - the credential is refreshed on the same account (`refresh`), which is what a
 *   401 or a revoked 403 says;
 * - the model is the subject and the account is untouched (`model-scoped`);
 * - the member could not be used at all and no request was sent
 *   (`member-ineligible`), which is the local account-policy refusal.
 *
 * Everything else is rethrown untouched: the request itself is at fault, the
 * provider stated a version/policy/content refusal, or the failure may not be
 * repeated.
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { ProviderId } from '../auth/store.js'
import { CONFLICT_CODE, ENFORCEMENT_CODE, MODEL_DENIED_CODE } from './common.js'
import { CLIENT_VERSION_UNSUPPORTED_CODE, PERMISSION_DENIED_CODE } from './claude-failure.js'

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

/**
 * Codes naming a refusal the provider aimed at one identity: an
 * enforcement-shaped rejection, every credential refusal, and the two Claude
 * refusals that are evidence about the request's identity or its compatibility
 * profile rather than about an allowance.
 *
 * Used to name why a pool served nothing and to order those reasons.
 */
const REFUSAL_CODES: readonly string[] = [
  ENFORCEMENT_CODE,
  CLIENT_VERSION_UNSUPPORTED_CODE,
  PERMISSION_DENIED_CODE,
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
 * cooling-down state they have in common.
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

/**
 * What the pool does about a member failure.
 *
 * No effect switches accounts: the session keeps the account its turn is bound
 * to, and the next turn decides whether a rematch is allowed.
 */
export type PoolFailureAction =
  /**
   * Back off this session alone. `delayMs` is the provider's own disclosed wait
   * when it sent one; absent means the session's local exponential backoff.
   */
  | { action: 'session-backoff'; reason: string; delayMs?: number }
  /** Park the failing account for `cooldownMs`, shared by every session. */
  | { action: 'account-cooldown'; cooldownMs: number; reason: string }
  /**
   * Refresh the credential and retry on the same account. The gate bounds how
   * many refresh cycles a turn may spend and parks the account after that.
   */
  | { action: 'refresh'; reason: string }
  /**
   * The member could not be used: account policy or catalogue resolution
   * refused it before any request was sent, so another member may take this
   * request without contacting two accounts.
   */
  | { action: 'member-ineligible'; reason: string }
  /** A model-scoped refusal: fail this model, do not touch the account or switch. */
  | { action: 'model-scoped'; reason: string }
  /** Fail the turn with this error; nothing about the account may be recorded. */
  | { action: 'throw' }

/** The `retry-after` an adapter propagated through `httpLlmError`, when any. */
function retryAfterMs(error: LlmError): number | undefined {
  return error.failure.providerRetryAfterMs
}

/**
 * Classify a member failure into the effect the pool applies.
 *
 * The table is the subscription account's error taxonomy:
 *
 * - transient statuses (408, 409, 500/502/503/504/529), an ordinary 429, and
 *   network, TLS or timeout failures back only their session off, so the same
 *   account may retry after the disclosed or local delay;
 * - a window/quota 429, a spent allowance, or an exhausted refresh budget parks
 *   the account until it can serve again, which every session sees;
 * - 401 and a revoked 403 refresh the credential on the same account first;
 * - a 403 or 404 that names one model is model-scoped and never changes the
 *   account;
 * - a stated final refusal, a request fault, an abort, a version/policy/content
 *   refusal and a malformed post-delivery stream are terminal.
 *
 * A failure that already carries the hard stop is decided by that field before
 * its code is read: the route stated the logical request may not be repeated.
 * @param error - the failure thrown by a member adapter's stream.
 * @param _provider - the failing member's provider (kept for the classifier's stable call shape).
 * @returns the effect the pool should apply.
 */
export function classifyPoolFailure(error: unknown, _provider: ProviderId): PoolFailureAction {
  if (!(error instanceof LlmError)) return { action: 'throw' }
  const status = error.failure.status
  if (error.failure.retryDisposition === 'forbid') {
    switch (error.code) {
      case ENFORCEMENT_CODE:
        // A stated-final 429 is the window/quota refusal this account must sit out;
        // a 403 refusal is the identity being unavailable. Any other stated-final
        // refusal is terminal for the turn.
        return status === 429 || status === 403 || retryAfterMs(error) !== undefined
          ? { action: 'account-cooldown', cooldownMs: retryAfterMs(error) ?? DEFAULT_QUOTA_COOLDOWN_MS, reason: error.code }
          : { action: 'throw' }
      case 'INVALID_CREDENTIAL':
      case 'MISSING_CREDENTIAL':
        return { action: 'account-cooldown', cooldownMs: AUTH_COOLDOWN_MS, reason: error.code }
      case MODEL_DENIED_CODE:
        // The hard stop forbids a resend of this model, but the account is the wrong
        // subject: report the model scope, not an account or request failure.
        return { action: 'model-scoped', reason: error.code }
      default:
        // A hard-stopped protocol, permission, request or unclassified refusal says
        // nothing about this account's allowance or its login, and may not be repeated.
        return { action: 'throw' }
    }
  }
  switch (error.code) {
    case 'RATE_LIMIT':
    case 'SERVER':
    case 'TIMEOUT':
    case 'TRANSPORT':
    case 'EMPTY_RESPONSE':
    case 'MALFORMED_RESPONSE':
    case CONFLICT_CODE: {
      const delayMs = retryAfterMs(error)
      return {
        action: 'session-backoff',
        reason: error.code,
        ...delayMs === undefined ? {} : { delayMs },
      }
    }
    case QUOTA_EXCEEDED_CODE:
      return {
        action: 'account-cooldown',
        cooldownMs: retryAfterMs(error) ?? DEFAULT_QUOTA_COOLDOWN_MS,
        reason: error.code,
      }
    case ENFORCEMENT_CODE:
      // Only the window/quota 429 and an account-shaped 403 are account state. A
      // stated-final refusal on any other status (a policy or request refusal) is
      // terminal for this turn.
      return status === 429 || status === 403
        ? { action: 'account-cooldown', cooldownMs: retryAfterMs(error) ?? DEFAULT_QUOTA_COOLDOWN_MS, reason: error.code }
        : { action: 'throw' }
    case 'AUTH':
      // 401 and a revoked 403 refresh the credential on the same account first; the
      // gate parks the account when its refresh budget is spent.
      return { action: 'refresh', reason: error.code }
    case 'INVALID_CREDENTIAL':
    case 'MISSING_CREDENTIAL':
      return { action: 'account-cooldown', cooldownMs: AUTH_COOLDOWN_MS, reason: error.code }
    case MODEL_DENIED_CODE:
    case 'HTTP_404':
      // The model, not the account, is the subject: the same account may serve
      // another model, and the account is not parked.
      return { action: 'model-scoped', reason: error.code }
    case 'HTTP_402':
      return { action: 'account-cooldown', cooldownMs: TRANSIENT_COOLDOWN_MS, reason: error.code }
    case 'NO_ADAPTER':
      // The local account-policy seam refused this member before any request.
      return { action: 'member-ineligible', reason: error.code }
    case CLIENT_VERSION_UNSUPPORTED_CODE:
    case PERMISSION_DENIED_CODE:
    case 'UNCLASSIFIED_PROVIDER_ERROR':
    case 'INVALID_REQUEST':
    case CONTEXT_WINDOW_EXCEEDED_CODE:
    case 'ABORTED':
    default:
      // A request fault, a version/policy/content refusal, an abort or an unnamed
      // status: nothing about the account is recorded and no sibling is asked.
      return { action: 'throw' }
  }
}

/** One parked account or member: how long it sits out, and the failure code that parked it. */
interface HealthRecord {
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
   * pool's retry hint.
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

  /**
   * Move one account's cooldown records to the canonical key the token store
   * renamed it to: both the account-wide key and every member key under it.
   *
   * The records move rather than clear, because the rename is not a re-login: a
   * parked account must stay parked, exactly as the cooldown the provider asked
   * for says, instead of becoming selectable again under the new key. A record
   * already held at the destination keeps whichever cooldown runs longer, so the
   * move can neither shorten a wait nor un-park the account it lands on.
   * @param provider - the provider route.
   * @param from - the key the account's records were held under.
   * @param to - the canonical key the account now resolves to.
   */
  renameAccount(provider: ProviderId, from: string, to: string): void {
    if (from === to) return
    const prefix = `${provider}/${from}/`
    for (const [key, record] of [...this.records]) {
      if (!key.startsWith(prefix)) continue
      const moved = `${provider}/${to}/${key.slice(prefix.length)}`
      const held = this.records.get(moved)
      this.records.delete(key)
      if (held !== undefined && held.unavailableUntil >= record.unavailableUntil) continue
      this.records.set(moved, record)
    }
  }
}
