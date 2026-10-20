/**
 * Quota tracking for pool members: the plugin's own cache of what each account
 * last reported, and the scheduling score derived from it.
 *
 * Reads never poll. A snapshot read answers from what is already known, and
 * only an explicit refresh or a candidate about to serve a request may perform
 * one upstream read. Expiry marks a reading stale; no timer ever fires, and a
 * restart reuses the persisted readings under their own recorded age.
 *
 * The baseline score remains the remaining quota fraction divided by time until
 * reset, with model-scoped live windows accompanying that rate. An elapsed
 * window supplies no score or quota-full assertion until the provider reports a
 * replacement.
 */

import { isMissingOrInvalidCredential, OAuthEndpointError } from './common.js'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ProviderUsage, UsageCacheMeta, UsageCacheState, UsageFailureReason, UsageWindow } from './common.js'
import type { UnifiedRateLimitState } from './unified-rate-limit.js'
import type { PersistedUsageAccount, UsageStore } from './usage-store.js'
import type { ProviderId } from '../auth/store.js'

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
/** How long a usage reading is trusted before it reads as stale and a demand re-reads it. */
export const USAGE_TTL_MS = 5 * 60_000
/**
 * How long a failed read with no server `retry-after` suppresses the next one.
 * This is a request-retry policy, deliberately independent of the freshness
 * horizon: a reading may be stale enough to refresh while the endpoint is still
 * refusing reads.
 */
export const USAGE_RETRY_DELAY_MS = 60_000
/** Assumed window length when the provider discloses no `resetsAt`. */
const FALLBACK_HORIZON_MS: Record<UsageWindow['kind'], number> = {
  session: 5 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
  other: 30 * 24 * 60 * 60_000,
}

/**
 * One upstream usage read. The optional signal aborts the read when the tracker
 * is disposed; a fetcher that ignores it is still safe, because a completion
 * after disposal is discarded by the tracker's own state.
 */
export type UsageFetcher = (signal?: AbortSignal) => Promise<ProviderUsage>

/** The scheduling view of one member's quota. */
export interface MemberQuota {
  /** False when a window is effectively full or the login is gone. */
  available: boolean
  /** Required burn rate (fraction of window per ms); 0 when unknown. */
  urgency: number
  /** Epoch ms of the newest observation behind this reading; 0 when none. */
  fetchedAt: number
  /** Applicable windows whose recorded reset has not elapsed; absent when usage is unknown. */
  windows?: readonly UsageWindow[]
  /**
   * Retained on the same terms as {@link windows}: this tracker never drops a
   * last-known reading because a later read failed, so the availability floors
   * keep seeing an allowance that was already spent.
   */
  floorWindows?: readonly UsageWindow[]
  /**
   * ChatGPT: the weekly window opened within the last day and an available
   * reset credit expires within three days. Selection ranks these accounts
   * with a bounded bonus inside its availability band. The pool never
   * spends the credit.
   */
  preferFreshCredit?: boolean
  /** What stands behind this reading, for callers that rank on it. */
  observation?: 'observed' | 'unread' | 'unavailable'
  /** Freshness of the reading behind this score, for callers that report it. */
  cacheState?: UsageCacheState
  /** Epoch ms of the newest observation behind this score, when one exists. */
  observedAt?: number
}

/**
 * One account's quota read. A named model asks for the windows that constrain it;
 * an omitted model asks for the account's own session and weekly windows — the ones
 * every model shares — which is what a model-independent availability floor reads.
 */
export interface QuotaQuery {
  provider: ProviderId
  account: string
  model?: string
}

/** One window carried by a {@link UsageObservation}. */
export interface ObservedUsageWindow {
  /** Window kind: `session` for the short rolling window, `weekly` for the 7-day one. */
  kind: 'session' | 'weekly' | 'other'
  /** Model scope for model-specific windows (e.g. `Opus`), when the provider names one. */
  scope?: string
  /** Percent of the window consumed (0–100). */
  usedPercent: number
  /** Epoch milliseconds at which the window resets, when the provider discloses it. */
  resetsAt?: number
}

/**
 * A partial observation of one account: whatever a single provider response
 * stated. A window the observation omits keeps its own reading and its own age.
 */
export interface UsageObservation {
  /** Windows this observation vouches for. */
  windows?: readonly ObservedUsageWindow[]
  /** Plan name the response disclosed, when it did. */
  plan?: string
  /** Epoch milliseconds the response was read; defaults to the tracker's clock. */
  observedAt?: number
}

/** Construction options for {@link PoolUsageTracker}. */
export interface PoolUsageOptions {
  /** Freshness horizon of a served reading, in ms. */
  freshMs?: number
  /** Negative-cache window for a failed read that carried no server `retry-after`. */
  retryDelayMs?: number
  /** Optional durable store for observed windows, times and cooldowns. */
  store?: UsageStore
  /** Clock injection for tests; defaults to `Date.now`. */
  now?: () => number
}

/** One window's reading, carrying the instant it was observed. */
interface StoredWindow {
  kind: 'session' | 'weekly' | 'other'
  scope?: string
  usedPercent: number
  resetsAt?: number
  observedAt: number
}

/** One account's retained state. The tracker is its only owner. */
interface AccountRecord {
  windows: StoredWindow[]
  /**
   * Epoch ms of the newest window observation, derived from the windows
   * themselves: a partial observation refreshes only the windows it names, so
   * the account is never fresher than its oldest retained window.
   */
  observedAt?: number
  /**
   * Epoch ms the usage endpoint last answered, whether or not it reported a
   * window. It exists to throttle a redundant query for an account whose
   * reading is unknown or incomplete, and never makes that unknown reading
   * look current.
   */
  checkedAt?: number
  plan?: string
  resetCredits?: ProviderUsage['resetCredits']
  failure?: {
    at: number
    retryAt: number
    reason: UsageFailureReason
    errorCode?: string
    cause?: UsageFailureCause
    causeCode?: string
    status?: number
    code?: string
  }
  /**
   * Set when this reading must not be served as current: an invalidation
   * distrusted it. The windows stay — they still state what the account last
   * reported — and the next observation or successful read clears the mark.
   */
  distrusted?: true
}

/**
 * Per-ACCOUNT usage readings with in-flight dedupe. A read never polls: it
 * answers from the retained reading, and only
 * {@link PoolUsageTracker.refreshSnapshot} and
 * {@link PoolUsageTracker.ensureForUse} may perform the one upstream request a
 * caller asked for. Providers without a usage endpoint (copilot) resolve no
 * fetcher and cannot be measured at all, which naturally ranks them behind
 * every measured member. Fetchers are resolved lazily per (provider, account)
 * so accounts added after startup join tracking on their first read.
 */
export class PoolUsageTracker {
  private readonly records = new Map<string, AccountRecord>()
  /**
   * The outstanding read of one account, with the generation it belongs to. A
   * read that started before the account was forgotten or its reading
   * invalidated is superseded rather than joined, so a new login never waits on
   * — or inherits — the previous session's request.
   */
  private readonly inflight = new Map<string, { generation: number; promise: Promise<ProviderUsage> }>()
  /** Bumped by {@link forget} and {@link invalidate} to supersede outstanding reads. */
  private readonly generations = new Map<string, number>()
  /**
   * Bumped only by {@link forget}. A passive observation taken by a request that
   * started before an invalidation is still new evidence and is applied; one taken
   * before the credentials were removed belongs to a session that no longer exists
   * and must never restore it.
   */
  private readonly forgotten = new Map<string, number>()
  /**
   * Retired key -> canonical key, for an account the token store renamed. The
   * reading lives under the new key; a query, observation or clear that still
   * names the old one is resolved through here, so a rename can neither strand
   * the account's floors nor let a stale key write a second record.
   */
  private readonly renamed = new Map<string, string>()
  private readonly store: UsageStore | undefined
  private readonly freshMs: number
  private readonly retryDelayMs: number
  private readonly now: () => number
  private readonly lifecycle = new AbortController()
  private disposed = false

  /**
   * @param fetcherFor - resolves the upstream reader of one account, or undefined when its provider has no usage endpoint.
   * @param options - freshness, retry policy, durability and clock.
   */
  constructor(
    private readonly fetcherFor: (provider: ProviderId, account: string) => UsageFetcher | undefined,
    options: PoolUsageOptions = {},
  ) {
    this.freshMs = options.freshMs ?? USAGE_TTL_MS
    this.retryDelayMs = options.retryDelayMs ?? USAGE_RETRY_DELAY_MS
    this.now = options.now ?? Date.now
    this.store = options.store
    // A restart reuses the persisted readings under their own recorded age; only
    // their age decides whether the next demand re-reads them.
    for (const persisted of this.store?.records() ?? []) {
      this.records.set(keyOf(persisted), recordOf(persisted))
    }
  }

  /**
   * The retained reading of one account, for direct display (the Settings page).
   *
   * Wholly pure: it never performs an upstream read, never throws, and never
   * starts background work. A provider without a usage endpoint answers
   * `{ supported: false }`; an account with no reading answers
   * `{ supported: true, cache: { state: 'missing' } }` rather than pretending to
   * be empty. Use {@link refreshSnapshot} when a read is actually wanted.
   * @param provider - the account's provider.
   * @param account - the canonical account key.
   * @returns the retained payload with its freshness metadata.
   */
  snapshotFor(provider: ProviderId, account: string): ProviderUsage {
    const fetcher = this.fetcherFor(provider, account)
    if (fetcher === undefined) return { supported: false }
    const key = this.keyFor(provider, account)
    const record = this.records.get(key)
    const now = this.now()
    return payloadFor(record, this.meta(key, record, now), now)
  }

  /**
   * Refresh one account's reading from upstream when it is missing, incomplete
   * or stale — or, when `force` is set, past a fresh success too (the manual
   * Refresh control).
   *
   * A live failure cooldown is never bypassed, `force` included: retrying
   * through it is exactly what turns a progressively rate-limited endpoint's
   * 429 into a permanent lockout. A credential failure still propagates, because
   * it costs no round trip and must stay live so a fixed login rejoins
   * immediately; every other failure resolves with the retained reading and its
   * `cache.error` classification.
   * @param provider - the account's provider.
   * @param account - the canonical account key.
   * @param force - bypass a fresh success cache for an honest re-check.
   * @returns the payload after the attempted read.
   */
  async refreshSnapshot(provider: ProviderId, account: string, force = false): Promise<ProviderUsage> {
    const fetcher = this.fetcherFor(provider, account)
    if (fetcher === undefined) return { supported: false }
    const key = this.keyFor(provider, account)
    if (!force && !this.needsRead(this.records.get(key), this.now())) return this.snapshotFor(provider, account)
    try {
      await this.runFetch(key, fetcher)
    } catch (error: unknown) {
      if (isMissingOrInvalidCredential(error)) throw error
    }
    return this.snapshotFor(provider, account)
  }

  /**
   * The quota view of one member, from what is already known.
   *
   * Wholly pure: it never performs an upstream read and never starts background
   * work, so ranking every candidate of a pool costs nothing. An account with no
   * reading scores neutral and is reported `unread`; it is never assumed to be
   * empty. Callers that are about to commit to one candidate verify it with
   * {@link ensureForUse}.
   * @param query - the account to read, and the model whose lanes apply when one is named.
   * @returns availability plus the urgency score.
   */
  quotaFor(query: QuotaQuery): MemberQuota {
    const key = this.keyFor(query.provider, query.account)
    if (this.fetcherFor(query.provider, query.account) === undefined) {
      return { available: true, urgency: 0, fetchedAt: 0, observation: 'unavailable' }
    }
    const record = this.records.get(key)
    const now = this.now()
    const meta = this.meta(key, record, now)
    const unauthorized = record?.failure?.reason === 'unauthorized'
    const windows = record === undefined ? [] : applicableWindows(query, record.windows, now)
    if (record === undefined || windows.length === 0) {
      return {
        available: !unauthorized,
        urgency: 0,
        fetchedAt: 0,
        observation: 'unread',
        cacheState: meta.state,
        // A retained reading whose windows all elapsed still states them, as an
        // empty set: the account has been observed, nothing currently applies.
        ...record === undefined ? {} : { windows: [] },
        ...record?.observedAt === undefined ? {} : { observedAt: record.observedAt },
      }
    }
    return this.score(query, record, windows, meta, !unauthorized)
  }

  /**
   * The quota view of one candidate that is about to serve, permitting the one
   * upstream read it needs: missing, incomplete or stale readings are refreshed
   * once (single-flight, so concurrent callers join it), and a live cooldown is
   * answered from cache. Peers are never read, so ranking a pool cannot sweep
   * idle accounts.
   * @param query - the candidate account to verify, and the model whose lanes apply.
   * @returns the quota view after the attempted read.
   */
  async ensureForUse(query: QuotaQuery): Promise<MemberQuota> {
    const fetcher = this.fetcherFor(query.provider, query.account)
    if (fetcher === undefined) return { available: true, urgency: 0, fetchedAt: 0, observation: 'unavailable' }
    const key = this.keyFor(query.provider, query.account)
    if (this.needsRead(this.records.get(key), this.now())) {
      try {
        await this.runFetch(key, fetcher)
      } catch (_unusableReading) {
        // The failed read is already recorded with its cooldown and safe
        // classification; the quota view below states what is still known,
        // including a login the endpoint refused.
      }
    }
    return this.quotaFor(query)
  }

  /**
   * Merge a partial observation — a provider response that stated some of this
   * account's windows — into what is already known.
   *
   * Only the windows the observation names are refreshed; every other window
   * keeps its own reading and its own age, so a response that omitted a lane
   * cannot make that lane look current. An observation naming no window changes
   * no reading at all, and cannot clear an invalidation. A reading older than
   * the one on record is discarded window by window, so a slower in-flight fetch
   * cannot overwrite a newer statement with older data. A usage-endpoint
   * cooldown is unrelated to this account answering a request and is left alone.
   * @param provider - the account's provider route.
   * @param account - the canonical account key.
   * @param observation - the readings this response carried.
   */
  observe(provider: ProviderId, account: string, observation: UsageObservation): void {
    if (this.disposed) return
    const key = this.keyFor(provider, account)
    const at = observation.observedAt ?? this.now()
    const record = this.records.get(key) ?? { windows: [] }
    let observed = 0
    for (const window of observation.windows ?? []) {
      if (!Number.isFinite(window.usedPercent)) continue
      if (mergeWindow(record, window, at)) observed += 1
    }
    if (observed > 0) {
      restateObservedAt(record)
      delete record.distrusted
    }
    if (observation.plan !== undefined) record.plan = observation.plan
    dropElapsedWindows(record, this.now())
    this.records.set(key, record)
    if (observed > 0 || observation.plan !== undefined) this.persist(key, record)
  }

  /**
   * Merge a captured `anthropic-ratelimit-unified-*` report as an observation.
   *
   * The provider's own account-level report is a better statement than the usage
   * endpoint, so its utilization readings — converted from fractions to
   * percentages — become the account's session and weekly windows. The
   * `7d_oi` lane is a second reading of the same weekly period measured with
   * overage included and is deliberately not merged: reporting both would let
   * one period occupy two windows. A report carrying no reading leaves the
   * windows untouched.
   * @param provider - the account's provider route.
   * @param account - the canonical account key.
   * @param state - the report parsed from that account's response headers.
   */
  observeUnified(provider: ProviderId, account: string, state: UnifiedRateLimitState): void {
    const windows: ObservedUsageWindow[] = []
    for (const window of state.windows) {
      if (window.utilization === undefined) continue
      const kind = unifiedKind(window.window)
      if (kind === undefined) continue
      windows.push({
        kind,
        usedPercent: Math.max(0, Math.min(100, window.utilization * 100)),
        ...window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt },
      })
    }
    this.observe(provider, account, {
      ...windows.length === 0 ? {} : { windows },
      observedAt: state.observedAt,
    })
  }

  /**
   * Capture an observation sink for one request, bound to the account's cache
   * generation at the moment the request starts.
   *
   * A stream can answer long after it began, and by then the account may have
   * been logged out, or another request may have distrusted its reading.
   *
   * Only the logout case blocks the callback: removing the credentials ends the
   * session the response belongs to, so no authorization state has to be re-read
   * asynchronously to know the response must be discarded. An invalidation is a
   * statement about a reading that is already old, and a response taken after it
   * is new evidence — {@link observe} still refuses any window older than the one
   * on record, so applying the callback cannot restore what was distrusted.
   * @param provider - the account's provider route.
   * @param account - the canonical account key.
   * @returns the callback to hand to that request's response path.
   */
  captureUnifiedObserver(provider: ProviderId, account: string): (state: UnifiedRateLimitState) => void {
    const key = this.keyFor(provider, account)
    const forgotten = this.forgotten.get(key) ?? 0
    return (state: UnifiedRateLimitState): void => {
      if (this.disposed) return
      // Resolved per call: a rename between the request and its answer moves the
      // same account's record rather than ending the session the answer belongs
      // to, while a logout after the rename still blocks it.
      if ((this.forgotten.get(this.keyFor(provider, account)) ?? 0) !== forgotten) return
      this.observeUnified(provider, account, state)
    }
  }

  /**
   * Mark retained readings stale without dropping them: one account, or a whole
   * provider when `account` is omitted.
   *
   * The windows stay, so the availability floors keep excluding an account whose
   * allowance was already spent, and the next read on demand refreshes it. Reads
   * already in flight when the reading was distrusted are superseded, so an older
   * response cannot restore what the invalidation replaced.
   * @param provider - the provider route.
   * @param account - the account key; omitted marks the whole provider.
   */
  invalidate(provider: ProviderId, account?: string): void {
    for (const key of this.keysUnder(provider, account)) {
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
      const record = this.records.get(key)
      if (record !== undefined) this.records.set(key, { ...record, distrusted: true })
    }
  }

  /**
   * Drop everything retained for one account, or a whole provider when
   * `account` is omitted: the in-memory reading and its persisted record.
   *
   * This is the credential-removal path — a logout or a deleted login. It
   * differs from {@link invalidate} in that the last reading is deliberately
   * forgotten, and a read that was in flight when the credentials disappeared
   * cannot resurrect the account by landing afterwards.
   * @param provider - the provider route.
   * @param account - the account key; omitted drops the whole provider.
   */
  forget(provider: ProviderId, account?: string): void {
    for (const key of this.keysUnder(provider, account)) {
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
      this.forgotten.set(key, (this.forgotten.get(key) ?? 0) + 1)
      this.records.delete(key)
      this.store?.remove(...splitKey(key))
    }
  }

  /** Resolve once every durable write this tracker scheduled has landed. */
  async flush(): Promise<void> {
    await this.store?.flush()
  }

  /**
   * Move one account's retained readings to the canonical key the token store
   * renamed it to.
   *
   * The reading is the account's own state and is kept whole: its windows with
   * their observation instants, the endpoint check that throttles the next read,
   * the plan and the failure cooldown. The retired key resolves to the new one,
   * so a query that still names it reaches the same reading and the same
   * availability floors. An outstanding read of the retired key is superseded
   * rather than allowed to land, because landing would recreate a record under a
   * key nothing reads; the next demand re-reads if it still needs to. Nothing is
   * awaited — this runs inside the save the outstanding read itself triggered.
   * @param provider - the provider route.
   * @param from - the key the account's readings were held under.
   * @param to - the canonical key the account now resolves to.
   */
  renameAccount(provider: ProviderId, from: string, to: string): void {
    const source = `${provider}/${from}`
    const target = `${provider}/${to}`
    if (source === target) return
    const moved = this.records.get(source)
    if (moved !== undefined) {
      const held = this.records.get(target)
      this.records.set(target, held === undefined ? moved : mergedAccountRecords(held, moved))
      this.records.delete(source)
    }
    this.renamed.set(source, target)
    this.generations.set(source, (this.generations.get(source) ?? 0) + 1)
    this.inflight.delete(source)
    const retained = this.records.get(target)
    if (retained !== undefined) {
      // Write the new key first and retire the old one in the same drain, so a
      // failed write leaves both halves queued rather than losing the reading.
      this.persistAs(provider, to, retained)
      this.store?.remove(provider, from)
    }
  }

  /** The key one account's readings are held under now, following a rename. */
  private keyFor(provider: ProviderId, account: string): string {
    let key = `${provider}/${account}`
    // Renames are one-hop in practice; the bound keeps a malformed chain finite.
    for (let hops = 0; hops < 8; hops += 1) {
      const next = this.renamed.get(key)
      if (next === undefined) break
      key = next
    }
    return key
  }

  /**
   * Stop the tracker for teardown: refuse further observations, abort owned
   * upstream reads, wait for them to settle, and land the durable writes already
   * scheduled — so nothing of this tracker's is outstanding when it resolves.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.lifecycle.abort()
    await Promise.allSettled([...this.inflight.values()].map(entry => entry.promise))
    await this.store?.dispose()
  }

  /**
   * Every cache key an {@link invalidate}/{@link forget} call covers: the named
   * account, or every key the tracker knows of that provider.
   */
  private keysUnder(provider: ProviderId, account: string | undefined): string[] {
    if (account !== undefined) return [this.keyFor(provider, account)]
    const prefix = `${provider}/`
    const keys = new Set([...this.records.keys(), ...this.generations.keys(), ...this.inflight.keys()])
    return [...keys].filter(key => key.startsWith(prefix))
  }

  /**
   * Whether one account's reading is complete and current: it holds windows, and
   * every one of them was observed within the freshness horizon and has not
   * reset. A window the provider stopped naming keeps its reading until an
   * authoritative endpoint read replaces the set, so this can be false for an
   * account whose newest observation is recent.
   */
  private isFresh(record: AccountRecord, now: number): boolean {
    if (record.distrusted === true) return false
    if (record.windows.length === 0 || record.observedAt === undefined) return false
    return record.windows.every(window =>
      (window.resetsAt === undefined || window.resetsAt > now) && now - window.observedAt < this.freshMs)
  }

  /**
   * Whether a demand should read this account from upstream.
   *
   * A complete, current reading needs nothing. An unknown or incomplete one is
   * throttled by the last successful check instead, so an endpoint that reports
   * no windows is asked once per horizon rather than once per request — and its
   * reading stays unknown rather than becoming a fabricated zero.
   */
  private needsRead(record: AccountRecord | undefined, now: number): boolean {
    if (record === undefined || record.distrusted === true) return true
    if (this.isFresh(record, now)) return false
    return record.checkedAt === undefined || now - record.checkedAt >= this.freshMs
  }

  /** Freshness metadata of one account's retained reading. */
  private meta(key: string, record: AccountRecord | undefined, now: number): UsageCacheMeta {
    const failure = record?.failure
    const common: Pick<UsageCacheMeta, 'observedAt' | 'retryAt' | 'error' | 'errorCode' | 'cause' | 'causeCode' | 'status' | 'code'> = {
      ...record?.observedAt === undefined ? {} : { observedAt: record.observedAt },
      ...failure === undefined
        ? {}
        : {
            retryAt: failure.retryAt,
            error: failure.reason,
            ...failure.errorCode === undefined ? {} : { errorCode: failure.errorCode },
            ...failure.cause === undefined ? {} : { cause: failure.cause },
            ...failure.causeCode === undefined ? {} : { causeCode: failure.causeCode },
            ...failure.status === undefined ? {} : { status: failure.status },
            ...failure.code === undefined ? {} : { code: failure.code },
          },
    }
    if (this.refreshing(key)) return { state: 'refreshing', ...common }
    if (record === undefined || record.windows.length === 0 || record.observedAt === undefined) {
      return { state: failure === undefined ? 'missing' : 'error', ...common }
    }
    if (failure !== undefined || !this.isFresh(record, now)) return { state: 'stale', ...common }
    return { state: 'fresh', ...common }
  }

  /** Whether an upstream read of this account is outstanding for its current generation. */
  private refreshing(key: string): boolean {
    const pending = this.inflight.get(key)
    return pending !== undefined && pending.generation === (this.generations.get(key) ?? 0)
  }

  /** Score one member from the windows that constrain it. */
  private score(
    member: QuotaQuery,
    record: AccountRecord,
    windows: UsageWindow[],
    meta: UsageCacheMeta,
    authorized: boolean,
  ): MemberQuota {
    const now = this.now()
    const fullAt = member.provider === 'codex' || member.provider === 'claude'
      ? CONSUMABLE_QUOTA_FULL_PERCENT : QUOTA_FULL_PERCENT
    let available = authorized
    let urgency = 0
    for (const window of windows) {
      if (window.usedPercent >= fullAt) available = false
      urgency = Math.max(urgency, windowUrgency(window, now))
    }
    const preferFreshCredit = member.provider === 'codex' && codexPreferFreshCredit(record, now)
    return {
      available,
      urgency,
      fetchedAt: meta.observedAt ?? 0,
      windows,
      floorWindows: windows,
      observation: 'observed',
      cacheState: meta.state,
      ...meta.observedAt === undefined ? {} : { observedAt: meta.observedAt },
      ...preferFreshCredit ? { preferFreshCredit: true } : {},
    }
  }

  /**
   * Run (or join) the single in-flight read for one account key, merging either
   * outcome into the retained record. A missing/invalid credential is
   * deliberately NOT negative-cached with a cooldown: it costs no network round
   * trip (the session lookup fails before the request goes out) and re-checking
   * live means the member rejoins routing the instant its login is fixed.
   */
  private runFetch(key: string, fetcher: UsageFetcher): Promise<ProviderUsage> {
    const generation = this.generations.get(key) ?? 0
    const pending = this.inflight.get(key)
    if (pending !== undefined && pending.generation === generation) return pending.promise
    // A disposed tracker starts nothing new, and an endpoint still cooling down
    // from a failure is not asked again — that retry is what turns a
    // progressively rate-limited 429 into a permanent lockout.
    const retained = this.records.get(key)
    if (this.disposed || (retained?.failure !== undefined && retained.failure.retryAt > this.now())) {
      return Promise.resolve(this.snapshotFor(...splitKey(key)))
    }
    const startedAt = this.now()
    // The request starts before this call returns, so a concurrent caller joins
    // the same read instead of racing it.
    let started: Promise<ProviderUsage>
    try {
      started = fetcher(this.lifecycle.signal)
    } catch (error: unknown) {
      started = Promise.reject(error)
    }
    const request = started
      .then(
        (snapshot) => {
          if (this.landed(key, generation, startedAt)) this.merge(key, snapshot)
          return snapshot
        },
        (error: unknown) => {
          if (this.landed(key, generation, startedAt)) this.recordFailure(key, error)
          throw error
        },
      )
      .finally(() => {
        if (this.inflight.get(key)?.promise === request) this.inflight.delete(key)
      })
    this.inflight.set(key, { generation, promise: request })
    return request
  }

  /**
   * Whether a completed read may still write: the tracker is alive, the account
   * was not forgotten or invalidated since it started, and no newer observation
   * superseded it.
   */
  private landed(key: string, generation: number, startedAt: number): boolean {
    if (this.disposed) return false
    if ((this.generations.get(key) ?? 0) !== generation) return false
    const observedAt = this.records.get(key)?.observedAt
    return observedAt === undefined || observedAt <= startedAt
  }

  /**
   * Merge a successful endpoint read.
   *
   * The payload refreshes the lanes it names — per window, a reading the account
   * already superseded is kept, and an omitted `resetsAt` falls back to a reset
   * still ahead. A lane the payload omits keeps its own reading and its own age:
   * an absent lane is not evidence that a known allowance came back, so a floor a
   * spent window established survives both a partial and an empty answer. Such a
   * lane keeps the reading stale, which is what {@link needsRead} throttles
   * through this read's `checkedAt`.
   */
  private merge(key: string, snapshot: ProviderUsage): void {
    const at = this.now()
    const record = this.records.get(key) ?? { windows: [] }
    if (snapshot.supported) {
      for (const window of snapshot.windows ?? []) {
        if (!Number.isFinite(window.usedPercent)) continue
        mergeWindow(record, window, at)
      }
      restateObservedAt(record)
      if (snapshot.plan !== undefined) record.plan = snapshot.plan
      if (snapshot.resetCredits !== undefined) record.resetCredits = snapshot.resetCredits
    }
    // Any answer, windows or not, is a successful check: it throttles the next
    // read without ever making an unobserved quota look current.
    record.checkedAt = at
    delete record.failure
    delete record.distrusted
    dropElapsedWindows(record, at)
    this.records.set(key, record)
    this.persist(key, record)
  }

  /** Record a failed read with its cooldown and safe classification. */
  private recordFailure(key: string, error: unknown): void {
    const record = this.records.get(key) ?? { windows: [] }
    const at = this.now()
    const reason = classifyUsageFailure(error)
    const facts = usageFailureFacts(error)
    record.failure = {
      at,
      retryAt: at + (reason === 'unauthorized' ? 0 : cooldownFor(error, this.retryDelayMs)),
      reason,
      ...facts,
    }
    this.records.set(key, record)
    // A live login failure costs no round trip and must stay live; persisting it
    // would gate the next read behind a cooldown the endpoint never asked for.
    if (reason !== 'unauthorized') this.persist(key, record)
  }

  /** Write one account's retained reading through, when it holds anything worth keeping. */
  private persist(key: string, record: AccountRecord): void {
    const [provider, account] = splitKey(key)
    this.persistAs(provider, account, record)
  }

  /** Write one reading through under an explicit account key. */
  private persistAs(provider: ProviderId, account: string, record: AccountRecord): void {
    if (this.store === undefined) return
    this.store.save({
      provider,
      account,
      ...record.observedAt === undefined ? {} : { observedAt: record.observedAt },
      ...record.checkedAt === undefined ? {} : { checkedAt: record.checkedAt },
      ...record.plan === undefined ? {} : { plan: record.plan },
      windows: record.windows.map(window => ({ ...window })),
      ...record.failure === undefined ? {} : { failure: { ...record.failure } },
    })
  }
}

/** The `provider/account` key of one durable record. */
function keyOf(record: PersistedUsageAccount): string {
  return `${record.provider}/${record.account}`
}

/** The later of two optional instants. */
function laterOf(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.max(left, right)
}

/** The failure whose cooldown ends later, so a rename never shortens a wait. */
function laterFailure(
  left: AccountRecord['failure'],
  right: AccountRecord['failure'],
): AccountRecord['failure'] {
  if (left === undefined) return right
  if (right === undefined) return left
  return left.retryAt >= right.retryAt ? left : right
}

/**
 * One retained reading from a rename's two sides.
 *
 * The two sides may each have observed a different lane — one the session
 * window, the other the weekly one — so the windows merge PER WINDOW through
 * {@link mergeWindow}: a lane only one side names survives, and a lane both name
 * keeps the later of the two observations rather than the older record's whole
 * set being dropped. The account-level fields take the newer statement, the plan
 * and credits fall back to the other side when the newer omits them, and the
 * later endpoint check and later failure cooldown are kept, so a rename can
 * neither lose a cooldown the endpoint asked for nor make an account that was
 * cooling down look freshly checked.
 * @param held - the record already under the canonical key.
 * @param moved - the record held under the retired key.
 * @returns the merged record.
 */
function mergedAccountRecords(held: AccountRecord, moved: AccountRecord): AccountRecord {
  const newer = (moved.observedAt ?? 0) > (held.observedAt ?? 0) ? moved : held
  const older = newer === held ? moved : held
  const plan = newer.plan ?? older.plan
  const resetCredits = newer.resetCredits ?? older.resetCredits
  const merged: AccountRecord = {
    windows: newer.windows.map(window => ({ ...window })),
    ...plan === undefined ? {} : { plan },
    ...resetCredits === undefined ? {} : { resetCredits },
  }
  for (const window of older.windows) mergeWindow(merged, window, window.observedAt)
  // An invalidation is a statement that the reading must not be served as
  // current: carrying it over is the safe direction for a merge.
  if (held.distrusted === true || moved.distrusted === true) merged.distrusted = true
  const checkedAt = laterOf(newer.checkedAt, older.checkedAt)
  if (checkedAt !== undefined) merged.checkedAt = checkedAt
  const failure = laterFailure(newer.failure, older.failure)
  if (failure !== undefined) merged.failure = failure
  restateObservedAt(merged)
  return merged
}

/** Split a `provider/account` key; an account key may itself contain `/`. */
function splitKey(key: string): [ProviderId, string] {
  const separator = key.indexOf('/')
  return [key.slice(0, separator) as ProviderId, key.slice(separator + 1)]
}

/** The in-memory form of one durable record. */
function recordOf(record: PersistedUsageAccount): AccountRecord {
  return {
    windows: record.windows.map(window => ({ ...window })),
    ...record.observedAt === undefined ? {} : { observedAt: record.observedAt },
    ...record.checkedAt === undefined ? {} : { checkedAt: record.checkedAt },
    ...record.plan === undefined ? {} : { plan: record.plan },
    ...record.failure === undefined ? {} : { failure: { ...record.failure } },
  }
}

/** Whether a window constrains a read: identity is its kind plus its model scope. */
function windowIdentity(window: { kind: string; scope?: string }): string {
  return `${window.kind}|${window.scope ?? ''}`
}

/**
 * Merge one incoming reading into a record's windows.
 *
 * A reading the account already superseded states nothing new and is discarded.
 * An incoming reading that omits `resetsAt` inherits the reset on record while
 * that reset is still ahead — the same window period stated again — and loses it
 * once the period has elapsed, because the next period is not the old one.
 * @param record - the account record to update.
 * @param window - the incoming reading.
 * @param at - the instant the incoming reading was observed.
 * @returns true when the reading was applied.
 */
function mergeWindow(record: AccountRecord, window: ObservedUsageWindow | UsageWindow, at: number): boolean {
  const identity = windowIdentity(window)
  const index = record.windows.findIndex(held => windowIdentity(held) === identity)
  const prior = index === -1 ? undefined : record.windows[index]
  if (prior !== undefined && prior.observedAt > at) return false
  const inherited = prior?.resetsAt !== undefined && prior.resetsAt > at ? prior.resetsAt : undefined
  const resetsAt = window.resetsAt ?? inherited
  const next: StoredWindow = {
    kind: window.kind,
    ...window.scope === undefined ? {} : { scope: window.scope },
    usedPercent: window.usedPercent,
    ...resetsAt === undefined ? {} : { resetsAt },
    observedAt: at,
  }
  if (index === -1) record.windows.push(next)
  else record.windows[index] = next
  return true
}

/** The newest observation instant among a set of windows. */
function newestWindowAt(windows: readonly StoredWindow[]): number | undefined {
  let newest: number | undefined
  for (const window of windows) {
    if (newest === undefined || window.observedAt > newest) newest = window.observedAt
  }
  return newest
}

/** Restate a record's newest observation from its windows, dropping the field when it holds none. */
function restateObservedAt(record: AccountRecord): void {
  const newest = newestWindowAt(record.windows)
  if (newest === undefined) delete record.observedAt
  else record.observedAt = newest
}

/**
 * Drop windows whose recorded reset elapsed. A window past its reset states
 * nothing about the current period, and keeping it would hold an availability
 * floor against an allowance the provider has already reopened. No window is
 * dropped merely for being old: an old reading is served as stale and still
 * states what the account last reported.
 */
function dropElapsedWindows(record: AccountRecord, now: number): void {
  record.windows = record.windows.filter(window => window.resetsAt === undefined || window.resetsAt > now)
  restateObservedAt(record)
}

/** The payload one account's retained reading describes. */
function payloadFor(record: AccountRecord | undefined, meta: UsageCacheMeta, now: number): ProviderUsage {
  const windows = record === undefined ? [] : (record.windows
    .filter(window => window.resetsAt === undefined || window.resetsAt > now)
    .map(window => ({
      kind: window.kind,
      ...window.scope === undefined ? {} : { scope: window.scope },
      usedPercent: window.usedPercent,
      ...window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt },
    })))
  return {
    supported: true,
    ...windows.length === 0 ? {} : { windows },
    ...record?.plan === undefined ? {} : { plan: record.plan },
    ...record?.resetCredits === undefined ? {} : { resetCredits: record.resetCredits },
    cache: meta,
  }
}

/**
 * The windows of one account that constrain this read: a model-scoped window
 * applies to its family, a read naming no model takes only the windows every model
 * shares, and an elapsed reset stops constraining anything.
 */
function applicableWindows(
  member: QuotaQuery,
  windows: readonly StoredWindow[],
  now: number,
): UsageWindow[] {
  return windows
    .filter(window => windowApplies(window, member.model)
      && (window.resetsAt === undefined || window.resetsAt > now))
    .map(window => ({
      kind: window.kind,
      ...window.scope === undefined ? {} : { scope: window.scope },
      usedPercent: window.usedPercent,
      ...window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt },
    }))
}

/**
 * Whether a window constrains a read: unscoped windows always do; a model-scoped
 * window (Claude's Opus/Sonnet lanes) applies when its scope names the model, and a
 * read naming no model is constrained only by the unscoped windows.
 */
function windowApplies(window: { scope?: string }, model: string | undefined): boolean {
  if (window.scope === undefined) return true
  return model !== undefined && model.toLowerCase().includes(window.scope.toLowerCase())
}

/**
 * Whether a ChatGPT account should be preferred because its weekly window
 * just opened and it holds a reset credit that expires soon. A credit alone,
 * or a window that is about to reset on its own, does not qualify.
 */
function codexPreferFreshCredit(record: AccountRecord, now: number): boolean {
  const weekly = record.windows.find(window => window.kind === 'weekly' && window.resetsAt !== undefined)
  const resetsAt = weekly?.resetsAt
  if (resetsAt === undefined) return false
  const remaining = resetsAt - now
  const elapsed = CODEX_WEEKLY_WINDOW_MS - remaining
  if (remaining <= 0 || elapsed < 0 || elapsed > CODEX_WEEKLY_FRESH_MS) return false
  const expiresAt = record.resetCredits?.soonestExpiresAt
  if (expiresAt === undefined) return false
  const untilExpiry = expiresAt - now
  return untilExpiry > 0 && untilExpiry <= CODEX_CREDIT_EXPIRING_MS
}

/** The required burn rate of one window (fraction per ms). */
function windowUrgency(window: UsageWindow, now: number): number {
  const remaining = Math.max(0, 1 - window.usedPercent / 100)
  const horizon = window.resetsAt !== undefined
    ? Math.max(window.resetsAt - now, 1)
    : FALLBACK_HORIZON_MS[window.kind]
  return remaining / horizon
}

/** How long to hold a failure in the negative cache: the endpoint's own `retry-after`, or the configured default. */
function cooldownFor(error: unknown, defaultRetryMs: number): number {
  return error instanceof OAuthEndpointError && error.retryAfterMs !== undefined ? error.retryAfterMs : defaultRetryMs
}

/** Safe origin class of a failed usage read. */
export type UsageFailureCause = 'endpoint' | 'timeout' | 'transport' | 'credential' | 'unknown'

/** Safe HTTP/OAuth facts of a failed usage read, never a provider message or body. */
export interface UsageFailureFacts {
  /** Stable harness error code, when the failure object carried one. */
  errorCode?: string
  /** Origin class of the failure. */
  cause?: UsageFailureCause
  /** Platform transport code, when the origin was a transport failure. */
  causeCode?: string
  /** HTTP status, when the failure came from an endpoint response. */
  status?: number
  /** Provider OAuth error code, when it is a bounded fixed code. */
  code?: string
}

/** A provider OAuth code that is safe to persist and show. */
const SAFE_OAUTH_CODE = /^[a-z][a-z0-9_]{0,63}$/i
/** A harness or platform code that is safe to persist and show. */
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
/** Fixed transport-shaped platform codes; arbitrary error codes stay out of the log. */
const SAFE_TRANSPORT_CODE = /^(?:E[A-Z0-9]{2,31}|UND_ERR_[A-Z0-9_]+)$/

/** A bounded error code from an Error object, or undefined. */
function stableCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : undefined
}

/** Whether an error is the abort/timeout shape callers use for an unreachable read. */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/**
 * Extract credential-free facts from a failed usage read, following the cause
 * chain a wrapped token-refresh failure uses.
 * @param error - the failure the read reported.
 * @returns the safe HTTP status, OAuth code, stable error code, and origin class.
 */
export function usageFailureFacts(error: unknown): UsageFailureFacts {
  return factsInChain(error, 0)
}

/** Bound the cause walk and never follow a cycle. */
function factsInChain(error: unknown, depth: number): UsageFailureFacts {
  if (depth > 8) return { cause: 'unknown' }
  if (error instanceof OAuthEndpointError) {
    const code = error.oauthCode !== undefined && SAFE_OAUTH_CODE.test(error.oauthCode)
      ? error.oauthCode
      : undefined
    return {
      cause: 'endpoint',
      status: error.status,
      ...code === undefined ? {} : { code },
    }
  }
  if (isMissingOrInvalidCredential(error)) {
    const errorCode = stableCodeOf(error)
    return {
      cause: 'credential',
      ...errorCode === undefined ? {} : { errorCode },
    }
  }
  if (error instanceof LlmError && error.code === 'AUTH') {
    const cause = error.cause
    const inner = cause === undefined || cause === error ? { cause: 'unknown' as const } : factsInChain(cause, depth + 1)
    return { errorCode: 'AUTH', ...inner, cause: inner.cause ?? 'unknown' }
  }
  const cause = error instanceof Error ? error.cause : undefined
  if (cause !== undefined && cause !== error) {
    const inner = factsInChain(cause, depth + 1)
    if (inner.cause !== undefined && inner.cause !== 'unknown') return inner
  }
  if (isTimeoutError(error)) {
    const errorCode = stableCodeOf(error)
    return {
      cause: 'timeout',
      ...errorCode === undefined ? {} : { errorCode },
    }
  }
  const code = stableCodeOf(error)
  if (code !== undefined && SAFE_TRANSPORT_CODE.test(code)) {
    return { cause: 'transport', causeCode: code }
  }
  return {
    cause: 'unknown',
    ...code === undefined ? {} : { causeCode: code },
  }
}

/**
 * A safe classification of a failed usage read. It is what gets persisted and
 * shown, so it must never carry a provider message, response body or token.
 * @param error - the failure the read reported.
 * @returns the classification.
 */
export function classifyUsageFailure(error: unknown): UsageFailureReason {
  const facts = usageFailureFacts(error)
  if (facts.cause === 'credential') return 'unauthorized'
  if (facts.cause === 'timeout' || facts.cause === 'transport') return 'unreachable'
  if (facts.cause === 'endpoint') {
    if (facts.status === 401 || facts.status === 403) return 'unauthorized'
    if (facts.status === 429) return 'rate_limited'
    if (facts.status === undefined || facts.status >= 500) return 'unreachable'
    return 'invalid_response'
  }
  if (isMissingOrInvalidCredential(error)) return 'unauthorized'
  if (error instanceof OAuthEndpointError) {
    if (error.status === 401 || error.status === 403) return 'unauthorized'
    if (error.status === 429) return 'rate_limited'
    if (error.status >= 500) return 'unreachable'
    return 'invalid_response'
  }
  if (isTimeoutError(error)) return 'unreachable'
  return 'unknown'
}

/** The scheduling window kind one unified rate-limit lane reports, when this plugin tracks it. */
function unifiedKind(window: string): UsageWindow['kind'] | undefined {
  switch (window) {
    case '5h': return 'session'
    case '7d': return 'weekly'
    case 'overage': return 'other'
    default: return undefined
  }
}
