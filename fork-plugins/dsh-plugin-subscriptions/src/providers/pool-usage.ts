/**
 * Quota tracking for pool members: polls the providers' usage endpoints
 * (the same normalized `ProviderUsage` shape the Settings page consumes) and
 * turns the windows into a scheduling score.
 *
 * The baseline is the remaining quota fraction divided by time until reset.
 * Model-scoped live windows accompany that rate so the pool can add bounded
 * reset and finishing preferences. An elapsed window supplies no score or
 * quota-full assertion until the provider reports a replacement.
 */

import { isMissingOrInvalidCredential, OAuthEndpointError } from './common.js'
import type { ProviderUsage, UsageWindow } from './common.js'
import type { ProviderId } from '../auth/store.js'
import type { ConcretePoolMember } from './pool-family.js'

/** Other providers enter the quota-full fallback band at this reported usage. */
export const QUOTA_FULL_PERCENT = 95
/** Claude and ChatGPT can consume their remaining quota until a window reaches 100%. */
export const CONSUMABLE_QUOTA_FULL_PERCENT = 100
/** Length of the Codex weekly window used to tell a fresh window from an old one. */
const CODEX_WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** A weekly window that opened within this long counts as just refreshed. */
const CODEX_WEEKLY_FRESH_MS = 24 * 60 * 60 * 1000
/** An available reset credit expiring within this long counts as near expiry. */
const CODEX_CREDIT_EXPIRING_MS = 3 * 24 * 60 * 60 * 1000
/** How long a usage snapshot is trusted before a background refresh. */
export const USAGE_TTL_MS = 5 * 60_000

/** Assumed window length when the provider discloses no `resetsAt`. */
const FALLBACK_HORIZON_MS: Record<UsageWindow['kind'], number> = {
  session: 5 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
  other: 30 * 24 * 60 * 60_000,
}

/** The scheduling view of one member's quota. */
export interface MemberQuota {
  /** False when a window is effectively full or the login is gone. */
  available: boolean
  /** Required burn rate (fraction of window per ms); 0 when unknown. */
  urgency: number
  /** Epoch ms of the snapshot this was computed from; 0 when none. */
  fetchedAt: number
  /** Applicable windows whose recorded reset has not elapsed; absent when usage is unknown. */
  windows?: readonly UsageWindow[]
  /**
   * Windows from the last successful poll of this account, retained when the
   * current poll degraded so an availability floor still sees an allowance that
   * was already spent. Selection scores read {@link windows} instead: a window
   * the endpoint is not currently vouching for must not steer routing.
   */
  floorWindows?: readonly UsageWindow[]
  /**
   * ChatGPT: the weekly window opened within the last day and an available
   * reset credit expires within three days. Selection ranks these accounts
   * with a bounded bonus inside its availability band. The pool never
   * spends the credit.
   */
  preferFreshCredit?: boolean
}

/** A successful snapshot, cached until `ttlMs` (or the entry's own `cooldownMs`) elapses. */
interface SnapshotEntry {
  snapshot: ProviderUsage
  error?: undefined
  at: number
  cooldownMs?: undefined
}

/**
 * A cached fetch failure — the negative-cache counterpart of {@link SnapshotEntry}.
 * Without this, a failing endpoint (a 429, a timeout) is retried on every
 * single `quotaFor`/`snapshotFor` call, since nothing about a rejected
 * promise ever reached `entries`. For an endpoint that rate-limits
 * progressively (each hit within the window pushes the next one further
 * out), that retry storm is a permanent lockout, not a transient blip.
 *
 * `lastSnapshot` carries forward the most recent successful fetch, when one
 * exists, so a member/display that was showing real data before this
 * failure keeps showing it (stale, but not blank) through the cooldown
 * instead of falling back to the zero-urgency/no-data degraded state.
 */
interface FailureEntry {
  snapshot?: undefined
  error: unknown
  at: number
  /** Overrides `ttlMs` — the endpoint's own `retry-after` when it sent one. */
  cooldownMs: number
  /** The last successful snapshot before this failure, when one exists. */
  lastSnapshot?: ProviderUsage
}

type CacheEntry = SnapshotEntry | FailureEntry

/**
 * Per-ACCOUNT usage snapshots with in-flight dedupe and
 * stale-while-revalidate refresh. Providers without a usage endpoint
 * (copilot) resolve no fetcher and score a constant zero urgency — which
 * naturally ranks them behind every measured member. Fetchers are resolved
 * lazily per (provider, account) so accounts added after startup join
 * tracking on their first score.
 */
export class PoolUsageTracker {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, { epoch: number; promise: Promise<ProviderUsage> }>()
  /** Bumped by {@link invalidate} so an older in-flight response cannot restore a dropped snapshot. */
  private readonly epochs = new Map<string, number>()

  constructor(
    private readonly fetcherFor: (provider: ProviderId, account: string) => (() => Promise<ProviderUsage>) | undefined,
    private readonly ttlMs = USAGE_TTL_MS,
  ) {}

  /**
   * The quota view of one member. A cold cache awaits the first fetch; a
   * stale one answers immediately while the refresh serves the NEXT call
   * (member selection must never block on the network mid-conversation). A
   * failure still cooling down degrades immediately with no network call.
   *
   * Deliberately does NOT score from `lastSnapshot` the way
   * {@link snapshotFor} displays it: ranking routing decisions off data that is
   * known to be stale-and-unrefreshable risks steering traffic by an urgency
   * number the endpoint itself is no longer vouching for, whereas
   * `snapshotFor`'s stale-display concern (the Settings page, the composer
   * badge) has no such downside — showing an old percentage beats showing
   * nothing. The stale windows still reach {@link MemberQuota.floorWindows},
   * which feeds the availability floors rather than the scores.
   * @param member - the pool member to score (account resolved).
   * @returns availability plus the urgency score.
   */
  async quotaFor(member: ConcretePoolMember): Promise<MemberQuota> {
    const key = `${member.provider}/${member.account}`
    const fetcher = this.fetcherFor(member.provider, member.account)
    if (fetcher === undefined) return { available: true, urgency: 0, fetchedAt: 0 }
    const entry = this.entries.get(key)
    if (entry !== undefined) {
      const now = Date.now()
      const resetElapsed = entry.snapshot?.windows?.some(window =>
        window.resetsAt !== undefined && entry.at < window.resetsAt && window.resetsAt <= now) === true
      const fresh = now - entry.at < (entry.cooldownMs ?? this.ttlMs) && !resetElapsed
      if (entry.snapshot !== undefined) {
        if (!fresh) void this.refresh(key, fetcher).catch(() => undefined)
        return this.score(member, entry)
      }
      if (fresh) return degradedQuota(member, entry.error, entry.lastSnapshot)
      // The cooldown expired: fall through to a fresh, blocking attempt.
    }
    try {
      const snapshot = await this.refresh(key, fetcher)
      return this.score(member, { snapshot, at: Date.now() })
    } catch (error: unknown) {
      // `refresh` recorded the failure before rethrowing, so the snapshot it
      // carried forward is the one this degraded view keeps for the floors.
      return degradedQuota(member, error, lastSnapshotOf(this.entries.get(key)))
    }
  }

  /**
   * Same cache as {@link quotaFor}, for direct display (the Settings page):
   * the raw snapshot, or the original fetch error, instead of a routing
   * score.
   * @param provider - the account's provider.
   * @param account - the account key.
   * @param force - bypass a fresh cached SNAPSHOT for an honest re-check (the
   *   manual Refresh button). A live failure cooldown is never bypassed —
   *   retrying through it is exactly what turns a 429 into a permanent
   *   lockout, so even a forced call still answers from the negative cache.
   * @returns `{ supported: false }` when the provider has no usage fetcher.
   */
  async snapshotFor(provider: ProviderId, account: string, force = false): Promise<ProviderUsage> {
    const fetcher = this.fetcherFor(provider, account)
    if (fetcher === undefined) return { supported: false }
    const key = `${provider}/${account}`
    const entry = this.entries.get(key)
    if (entry !== undefined && Date.now() - entry.at < (entry.cooldownMs ?? this.ttlMs)) {
      if (entry.snapshot !== undefined) {
        if (!force) return entry.snapshot
      } else if (entry.lastSnapshot !== undefined) {
        // A stale-but-real snapshot beats surfacing the cooldown error to
        // every display surface — this is what was previously showing, so
        // keep showing it (even through a forced refresh: retrying past the
        // cooldown is exactly the retry storm `cooldownMs` exists to avoid).
        return entry.lastSnapshot
      } else {
        throw entry.error
      }
    }
    try {
      return await this.refresh(key, fetcher)
    } catch (error: unknown) {
      // Same fallback as the already-cooling-down branch above, for the
      // fetch that just failed on THIS call: `refresh` recorded whatever
      // snapshot was on record before it ran onto the new failure entry.
      const failed = this.entries.get(key)
      if (failed?.snapshot === undefined && failed?.lastSnapshot !== undefined) return failed.lastSnapshot
      throw error
    }
  }

  /** Drop cached snapshots: one account, or a whole provider when `account` is omitted. */
  invalidate(provider: ProviderId, account?: string): void {
    const bump = (key: string): void => {
      this.entries.delete(key)
      this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1)
    }
    if (account !== undefined) {
      bump(`${provider}/${account}`)
      return
    }
    const prefix = `${provider}/`
    const keys = new Set([...this.entries.keys(), ...this.epochs.keys(), ...this.inflight.keys()])
    for (const key of keys) {
      if (key.startsWith(prefix)) bump(key)
    }
  }

  /**
   * Run (or join) the single in-flight fetch for one account key, caching
   * either outcome. A missing/invalid credential is deliberately NOT
   * negative-cached: it costs no network round trip (the session lookup
   * fails before the request goes out) and re-checking live means the
   * member rejoins routing the instant its login is fixed, rather than
   * waiting out a stale cooldown.
   */
  private refresh(key: string, fetcher: () => Promise<ProviderUsage>): Promise<ProviderUsage> {
    const epoch = this.epochs.get(key) ?? 0
    const pending = this.inflight.get(key)
    if (pending !== undefined && pending.epoch === epoch) return pending.promise
    // Captured before the fetch starts: whichever real snapshot is on
    // record right now is what a failure below should fall back to. A
    // failure entry's own `lastSnapshot` counts too — otherwise the stale
    // snapshot would survive exactly one cooldown and vanish on the next
    // consecutive failure, even though nothing newer ever replaced it.
    const lastSnapshot = lastSnapshotOf(this.entries.get(key))
    const request = fetcher().then(
      (snapshot) => {
        if ((this.epochs.get(key) ?? 0) === epoch) this.entries.set(key, { snapshot, at: Date.now() })
        return snapshot
      },
      (error: unknown) => {
        if ((this.epochs.get(key) ?? 0) === epoch && !isMissingOrInvalidCredential(error)) {
          this.entries.set(key, {
            error,
            at: Date.now(),
            cooldownMs: cooldownFor(error, this.ttlMs),
            ...lastSnapshot === undefined ? {} : { lastSnapshot },
          })
        }
        throw error
      },
    ).finally(() => {
      if (this.inflight.get(key)?.promise === request) this.inflight.delete(key)
    })
    this.inflight.set(key, { epoch, promise: request })
    return request
  }

  /** Score one member against a snapshot's windows. */
  private score(member: ConcretePoolMember, entry: SnapshotEntry): MemberQuota {
    const now = Date.now()
    const windows = applicableWindows(member, entry.snapshot, now)
    const fullAt = member.provider === 'codex' || member.provider === 'claude'
      ? CONSUMABLE_QUOTA_FULL_PERCENT : QUOTA_FULL_PERCENT
    let available = true
    let urgency = 0
    for (const window of windows) {
      if (window.usedPercent >= fullAt) available = false
      urgency = Math.max(urgency, windowUrgency(window, now))
    }
    const preferFreshCredit = member.provider === 'codex' && codexPreferFreshCredit(entry.snapshot)
    return {
      available,
      urgency,
      fetchedAt: entry.at,
      windows,
      ...preferFreshCredit ? { preferFreshCredit: true } : {},
    }
  }
}

/** The most recent successful snapshot a cache entry carries, of either kind. */
function lastSnapshotOf(entry: CacheEntry | undefined): ProviderUsage | undefined {
  return entry?.snapshot ?? entry?.lastSnapshot
}

/**
 * The windows of one snapshot that constrain this member: a model-scoped window
 * applies to its family, and an elapsed reset stops constraining anything.
 */
function applicableWindows(member: ConcretePoolMember, snapshot: ProviderUsage, now: number): UsageWindow[] {
  return (snapshot.windows ?? []).filter(window => windowApplies(window, member.model)
    && (window.resetsAt === undefined || window.resetsAt > now))
}

/**
 * The routing view of a fetch failure. Logged out: the member cannot serve
 * at all. Any other failure (network, endpoint rate limit) must not block
 * routing — the member stays available with a zero score, degrading the
 * strategy to plain priority order for it. Whichever the failure, the windows
 * of the last successful poll ride along for the availability floors, which
 * decide whether a turn may start at all rather than how it is ranked; a
 * route whose usage endpoint stays unreachable must keep excluding an account
 * past its floor, not silently treat it as unmeasured.
 * @param member - the member the quota view describes.
 * @param error - the failure that degraded this poll.
 * @param last - the last successful snapshot on record, when one exists.
 * @returns the degraded quota view.
 */
function degradedQuota(member: ConcretePoolMember, error: unknown, last: ProviderUsage | undefined): MemberQuota {
  const floorWindows = last === undefined ? undefined : applicableWindows(member, last, Date.now())
  return {
    available: !isMissingOrInvalidCredential(error),
    urgency: 0,
    fetchedAt: 0,
    ...floorWindows === undefined ? {} : { floorWindows },
  }
}

/** How long to hold a failure in the negative cache: the endpoint's own `retry-after`, or the default TTL. */
function cooldownFor(error: unknown, defaultTtlMs: number): number {
  return error instanceof OAuthEndpointError && error.retryAfterMs !== undefined ? error.retryAfterMs : defaultTtlMs
}

/**
 * Whether a window constrains this model: unscoped windows always do; a
 * model-scoped window (Claude's Opus/Sonnet lanes) applies when its scope
 * names the model family.
 */
function windowApplies(window: UsageWindow, model: string): boolean {
  if (window.scope === undefined) return true
  return model.toLowerCase().includes(window.scope.toLowerCase())
}

/**
 * Whether a ChatGPT account should be preferred because its weekly window
 * just opened and it holds a reset credit that expires soon. A credit alone,
 * or a window that is about to reset on its own, does not qualify.
 */
function codexPreferFreshCredit(snapshot: ProviderUsage, now = Date.now()): boolean {
  const weekly = (snapshot.windows ?? []).find(window => window.kind === 'weekly' && window.resetsAt !== undefined)
  const resetsAt = weekly?.resetsAt
  if (resetsAt === undefined) return false
  const remaining = resetsAt - now
  const elapsed = CODEX_WEEKLY_WINDOW_MS - remaining
  if (remaining <= 0 || elapsed < 0 || elapsed > CODEX_WEEKLY_FRESH_MS) return false
  const expiresAt = snapshot.resetCredits?.soonestExpiresAt
  if (expiresAt === undefined) return false
  const untilExpiry = expiresAt - now
  return untilExpiry > 0 && untilExpiry <= CODEX_CREDIT_EXPIRING_MS
}

/** The required burn rate of one window (fraction per ms). */
function windowUrgency(window: UsageWindow, now = Date.now()): number {
  const remaining = Math.max(0, 1 - window.usedPercent / 100)
  const horizon = window.resetsAt !== undefined
    ? Math.max(window.resetsAt - now, 1)
    : FALLBACK_HORIZON_MS[window.kind]
  return remaining / horizon
}
