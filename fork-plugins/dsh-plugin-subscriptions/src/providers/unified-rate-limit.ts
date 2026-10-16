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
 * Reading those headers and reporting them are the shared pure core's job
 * (`../claude-core/quota-observation.js`): this module adapts a header source to the core's
 * read-only one, injects the providers' shared reset reader, and owns the bounded per-account
 * record below. The core is the only reader of the header family, so the plugin has one header
 * parse rather than one per consumer.
 *
 * @module dsh-plugin-subscriptions/providers/unified-rate-limit
 */

import {
  CLAUDE_UNIFIED_HEADER_PREFIX,
  CLAUDE_UNIFIED_MEMBER_SUFFIXES,
  CLAUDE_UNIFIED_WINDOW_PREFIXES,
  CLAUDE_UNIFIED_WINDOW_SUFFIXES,
  parseRawFacts,
  projectLegacy,
} from '../claude-core/quota-observation.js'
import type {
  LegacyResetResolver,
  QuotaHeaderSource,
  QuotaLegacyState,
} from '../claude-core/quota-observation.js'
import { resetInstantFromValue } from './rate-limit.js'
import type { ProviderId } from '../auth/store.js'

/**
 * The header source this module reads: the one operation it uses, with this platform's
 * absence convention.
 *
 * A `Headers` satisfies it, and so does any object carrying the same method — which is what
 * lets a caller observe the reads without constructing a response. The return stays
 * `string | null` because that is what `Headers.get` answers and the difference is resolved
 * exactly once, in {@link headerSource}.
 */
export interface UnifiedRateLimitHeaders {
  /** One response header's value, or `null` when the response carried none. */
  get(name: string): string | null
}

/**
 * The shared reset reader as the core's resolver port. `Headers.get` answers `null` for a
 * member the response did not carry while the port states absence as `undefined`, so this
 * adapter is where that one difference is resolved; a value present but blank stays blank
 * and the core classifies it.
 * @param rawText - the reset member's text as the core read it.
 * @param now - the current epoch milliseconds.
 * @returns epoch milliseconds of the reset, or undefined when the value disclosed none.
 */
const resolveUnifiedReset: LegacyResetResolver = (rawText, now) =>
  resetInstantFromValue(rawText === undefined ? null : rawText, now)

/**
 * Adapt a header source to the core's read-only source.
 *
 * This platform's `get` answers `null` for an absent member, and the core's source states
 * absence as `undefined`; the conversion happens here and nowhere else, so a missing member
 * is never handed on as an empty string.
 * @param headers - the response headers to read.
 * @returns the read-only source the core reads.
 */
function headerSource(headers: UnifiedRateLimitHeaders): QuotaHeaderSource {
  return {
    get: (name: string): string | undefined => headers.get(name) ?? undefined,
  }
}

/** One account's last unified rate-limit report. */
export type UnifiedRateLimitState = QuotaLegacyState

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

/**
 * Whether a response carries any member of the family this plugin reads.
 *
 * The member and window names come from the core, which is the family's only reader: this gate
 * asks the same response for the same names so a response that carried none still answers
 * `undefined` rather than an empty report.
 * @param headers - the response headers to test.
 * @returns true when the response carried at least one member of the family.
 */
function carriesUnifiedReport(headers: UnifiedRateLimitHeaders): boolean {
  const named = [
    ...CLAUDE_UNIFIED_MEMBER_SUFFIXES,
    ...CLAUDE_UNIFIED_WINDOW_PREFIXES.flatMap(
      window => CLAUDE_UNIFIED_WINDOW_SUFFIXES.map(suffix => `${window}-${suffix}`),
    ),
  ]
  return named.some(suffix => headers.get(`${CLAUDE_UNIFIED_HEADER_PREFIX}${suffix}`) !== null)
}

/**
 * Read one response's unified rate-limit report.
 *
 * A response is a report when it carries any member this module reads; one
 * carrying none answers `undefined`, so an account with no captured report is
 * distinguishable from one whose provider reported `allowed`.
 *
 * The reading itself belongs to the shared core: this function hands it the response
 * headers and the providers' own reset reader, and returns the report unchanged. It reads
 * no more of the response than {@link UnifiedRateLimitHeaders} declares.
 * @param headers - the response headers to read.
 * @param now - the current epoch milliseconds, injected so parsing is testable.
 * @returns the reported state, or undefined when the response carried no such member.
 */
export function parseUnifiedRateLimit(
  headers: UnifiedRateLimitHeaders,
  now: number,
): UnifiedRateLimitState | undefined {
  if (!carriesUnifiedReport(headers)) return undefined
  return projectLegacy(parseRawFacts(headerSource(headers)), { resolveReset: resolveUnifiedReset, now })
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

/**
 * Move one account's retained report to the canonical key the token store
 * renamed it to, so the usage card keeps stating the provider's own standing for
 * an account that is still the same login. When the new key already holds a
 * report, the newer of the two is kept, so a rename never replaces a fresher
 * answer with an older one.
 * @param provider - the provider route.
 * @param from - the key the report was retained under.
 * @param to - the canonical key the account now resolves to.
 */
export function renameUnifiedRateLimit(provider: ProviderId, from: string, to: string): void {
  const source = captureKey(provider, from)
  const target = captureKey(provider, to)
  if (source === target) return
  const report = captures.get(source)
  if (report === undefined) return
  const held = captures.get(target)
  captures.delete(source)
  if (held !== undefined && held.observedAt >= report.observedAt) return
  // Re-inserted at the most-recent end: only the eviction order of accounts that
  // stopped answering changes, and the bound still holds.
  captures.delete(target)
  captures.set(target, report)
}
