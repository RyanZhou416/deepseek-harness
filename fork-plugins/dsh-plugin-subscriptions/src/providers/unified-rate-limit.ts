/**
 * The `anthropic-ratelimit-unified-*` response headers, and the bounded
 * per-account record of the last report each account answered with.
 *
 * This family is the provider's own account-level rate-limit report, attached
 * to every answered Messages response: a status (`allowed`, `allowed_warning`,
 * `rejected`), the window that claims the limit with its reset instant, and the
 * per-window utilization and threshold readings.
 *
 * The names below are the members the genuine 2.1.288 client's own rate-limit
 * state reads: the reads are in `chunk-p8vbbyj7.js`, and the names that client
 * hoists into constants are in `chunk-pzdykw0r.js`. That client's window table
 * maps `five_hour` → `5h`, `seven_day` → `7d`,
 * `seven_day_overage_included` → `7d_oi` and `overage` → `overage`, each
 * carrying a `-utilization`, `-reset` and `-surpassed-threshold` member.
 * Values are a status token, an epoch-seconds reset, a utilization fraction
 * (`0.82`, or `1` once the cap is reached), or a threshold (`0.75`, `0.95`).
 *
 * @module dsh-plugin-subscriptions/providers/unified-rate-limit
 */

import { resetInstantFromValue } from './rate-limit.js'
import type { ProviderId } from '../auth/store.js'

/** Prefix every member of the unified rate-limit family shares. */
const UNIFIED_PREFIX = 'anthropic-ratelimit-unified-'

/**
 * The status member's accepted values; anything else is reported as `other` so
 * an unrecognized token is visible rather than silently read as `allowed`.
 */
export type UnifiedRateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected' | 'other'

/** Standalone members naming the account's standing and its overage route. */
const MEMBER_SUFFIXES = [
  'status',
  'reset',
  'representative-claim',
  'fallback',
  'overage-status',
  'overage-reset',
  'overage-disabled-reason',
  'overage-in-use',
  'overage-scope',
] as const

/** Window prefixes the provider meters separately, each with its own readings. */
const WINDOW_PREFIXES = ['5h', '7d', '7d_oi', 'overage'] as const

/** The three readings every window prefix carries. */
const WINDOW_SUFFIXES = ['utilization', 'reset', 'surpassed-threshold'] as const

/** One window's reading, from that window's three unified members. */
export interface UnifiedWindowReading {
  /** Window token: `5h`, `7d`, `7d_oi` or `overage`. */
  window: string
  /** Fraction of the window consumed (0–1), as the provider reported it. */
  utilization?: number
  /** Epoch milliseconds at which the window reopens. */
  resetsAt?: number
  /** Threshold (0.75 or 0.95) the utilization passed, when the provider sent it. */
  surpassedThreshold?: number
}

/** One account's last unified rate-limit report. */
export interface UnifiedRateLimitState {
  /** The account's standing: `rejected` is the provider refusing its requests. */
  status: UnifiedRateLimitStatus
  /** Epoch milliseconds the claiming window reopens, from the `reset` member. */
  resetsAt?: number
  /** The window claiming the limit (`5h`, `7d`, `overage`, ...), when named. */
  claim?: string
  /** Whether the provider advertised a fallback route past the limit. */
  fallbackAvailable?: boolean
  /** The overage route's own status; `allowed` means requests still flow on overage. */
  overageStatus?: UnifiedRateLimitStatus
  /** Epoch milliseconds the overage cap reopens. */
  overageResetsAt?: number
  /** Why overage is unavailable (`org_spend_cap_reached`, ...), when the provider said so. */
  overageDisabledReason?: string
  /** Whether this account's requests are currently drawing on paid overage. */
  overageInUse?: boolean
  /** Which budget the overage draws on: `service`, `channel` or `group_pool`. */
  overageScope?: string
  /** Per-window readings, in {@link WINDOW_PREFIXES} order. */
  windows: UnifiedWindowReading[]
  /** Epoch milliseconds this report was read off the response. */
  observedAt: number
}

/**
 * Accounts whose report is retained. Each entry is replaced by that account's
 * next response, so the bound only covers accounts that stopped answering;
 * oldest-first eviction matches the other per-account tables in this plugin.
 */
const CAPTURE_LIMIT = 256

/** Canonical account key → that account's latest report. */
const captures = new Map<string, UnifiedRateLimitState>()

function captureKey(provider: ProviderId, account: string): string {
  return `${provider}/${account}`
}

function statusOf(value: string | undefined): UnifiedRateLimitStatus {
  return value === 'allowed' || value === 'allowed_warning' || value === 'rejected' ? value : 'other'
}

/** One member's raw value, or undefined when absent or blank. */
function textOf(headers: Headers, name: string): string | undefined {
  const raw = headers.get(name)
  return raw === null || raw.trim() === '' ? undefined : raw.trim()
}

/** A numeric member, or undefined when absent, blank or not a number. */
function numberOf(headers: Headers, name: string): number | undefined {
  const raw = textOf(headers, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Read one response's unified rate-limit report.
 *
 * A response is a report when it carries any member this module reads; one
 * carrying none answers `undefined`, so an account with no captured report is
 * distinguishable from one whose provider reported `allowed`.
 * @param headers - the response headers to read.
 * @param now - the current epoch milliseconds, injected so parsing is testable.
 * @returns the reported state, or undefined when the response carried no such member.
 */
export function parseUnifiedRateLimit(headers: Headers, now: number): UnifiedRateLimitState | undefined {
  const member = (suffix: string): string => `${UNIFIED_PREFIX}${suffix}`
  const present = MEMBER_SUFFIXES.some(suffix => headers.get(member(suffix)) !== null)
    || WINDOW_PREFIXES.some(window => WINDOW_SUFFIXES.some(suffix => headers.get(member(`${window}-${suffix}`)) !== null))
  if (!present) return undefined
  const resetOf = (suffix: string): number | undefined =>
    resetInstantFromValue(headers.get(member(suffix)), now)
  const windows: UnifiedWindowReading[] = []
  for (const window of WINDOW_PREFIXES) {
    const utilization = numberOf(headers, member(`${window}-utilization`))
    const resetsAt = resetOf(`${window}-reset`)
    const surpassedThreshold = numberOf(headers, member(`${window}-surpassed-threshold`))
    if (utilization === undefined && resetsAt === undefined && surpassedThreshold === undefined) continue
    windows.push({
      window,
      ...utilization === undefined ? {} : { utilization },
      ...resetsAt === undefined ? {} : { resetsAt },
      ...surpassedThreshold === undefined ? {} : { surpassedThreshold },
    })
  }
  const status = textOf(headers, member('status'))
  const resetsAt = resetOf('reset')
  const overageResetsAt = resetOf('overage-reset')
  const claim = textOf(headers, member('representative-claim'))
  const fallback = textOf(headers, member('fallback'))
  const overageStatus = textOf(headers, member('overage-status'))
  const overageDisabledReason = textOf(headers, member('overage-disabled-reason'))
  const overageInUse = textOf(headers, member('overage-in-use'))
  const overageScope = textOf(headers, member('overage-scope'))
  return {
    // A response that carried windows but no status member reports those
    // windows and leaves the account's standing unstated. Reading the absence
    // as `allowed` would present a refusal the response did not describe as a
    // healthy account, so it reads `other` like any unrecognized token.
    status: statusOf(status),
    ...resetsAt === undefined ? {} : { resetsAt },
    ...claim === undefined ? {} : { claim },
    ...fallback === undefined ? {} : { fallbackAvailable: fallback === 'available' },
    ...overageStatus === undefined ? {} : { overageStatus: statusOf(overageStatus) },
    ...overageResetsAt === undefined ? {} : { overageResetsAt },
    ...overageDisabledReason === undefined ? {} : { overageDisabledReason },
    ...overageInUse === undefined ? {} : { overageInUse: overageInUse === 'true' },
    ...overageScope === undefined ? {} : { overageScope },
    windows,
    observedAt: now,
  }
}

/**
 * Keep one account's report, evicting the oldest entry at the bound.
 * @param provider - the account's provider route.
 * @param account - the canonical account key the response belonged to.
 * @param state - the report parsed from that response.
 */
export function rememberUnifiedRateLimit(
  provider: ProviderId,
  account: string,
  state: UnifiedRateLimitState,
): void {
  const key = captureKey(provider, account)
  captures.delete(key)
  if (captures.size >= CAPTURE_LIMIT) {
    const oldest = captures.keys().next()
    if (oldest.done !== true) captures.delete(oldest.value)
  }
  captures.set(key, state)
}

/**
 * The last report one account answered with, when one was captured.
 * @param provider - the account's provider route.
 * @param account - the canonical account key.
 * @returns the retained report, or undefined when that account never answered.
 */
export function unifiedRateLimitFor(provider: ProviderId, account: string): UnifiedRateLimitState | undefined {
  return captures.get(captureKey(provider, account))
}

/**
 * Drop retained reports: one account, every account of a provider, or
 * everything. A logout or a credential death must not leave the dead account's
 * last report on its card.
 * @param provider - the provider route; omitted drops every provider.
 * @param account - the account key; omitted drops the whole provider.
 */
export function forgetUnifiedRateLimit(provider?: ProviderId, account?: string): void {
  if (provider === undefined) {
    captures.clear()
    return
  }
  const prefix = `${provider}/`
  const key = captureKey(provider, account ?? '')
  for (const held of [...captures.keys()]) {
    if (account === undefined ? held.startsWith(prefix) : held === key) captures.delete(held)
  }
}
