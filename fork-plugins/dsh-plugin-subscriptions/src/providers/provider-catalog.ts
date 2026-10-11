/**
 * The catalog plumbing the subscription adapters share. One
 * {@link ProviderCatalog} owns a provider's account-indexed model caches and
 * runs the listing skeleton: union every logged-in account, map a catalogue onto
 * the static rows when nothing is known, and keep every read free of provider
 * I/O. An adapter supplies only what is genuinely its own — the discovery fetch,
 * the static rows, the row mapping and the fallback wording.
 *
 * The split that matters: {@link ProviderCatalog.list}, {@link resolve} and
 * {@link read} only ever answer from the local cache or the built-in rows, while
 * {@link refresh} is the single path that asks the provider. Callers decide when
 * that is warranted — login, opening Manage, an explicit refresh, or the account
 * a request is about to use.
 */

import { LlmError, errorChain } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { ProviderId } from '../auth/store.js'
import { unionAccountCatalogs } from './accounts.js'
import {
  DISCOVERY_TIMEOUT_MS,
  ModelCatalogCache,
  discoverAcrossAccounts,
  discoverOrRetryAuth,
  withTimeout,
} from './common.js'
import type {
  CatalogFailure,
  CatalogPersistence,
  CatalogRecord,
  CatalogRefreshOutcome,
  CatalogRefreshReport,
  CatalogStoreFactory,
  DiscoveredModel,
} from './common.js'

/** The account-store surface catalog listing reads. */
interface CatalogAccounts {
  /** The provider's accounts, default first. */
  list(): Promise<readonly { key: string }[]>
  /** Resolve a usable session for one account, refreshing on demand. */
  session(account?: string, forceRefresh?: boolean): Promise<unknown>
  /** Whether a session is stored for one account (cheap; never refreshes). */
  hasSession(account?: string): Promise<boolean>
  /** The default account's key, or undefined when logged out. */
  defaultAccount(): Promise<string | undefined>
}

/** The pool seam that contributes picker rows beyond the discovered catalog. */
interface CatalogTierSource {
  /** The provider's configured tier rows. */
  modelsForProvider(provider: ProviderId): Promise<LlmModelInfo[]>
}

/** The catalog-relevant slice of every subscription adapter's options. */
interface CatalogHost {
  /** The provider's account store. */
  tokens: CatalogAccounts
  /** Durable per-account store factory; every account keeps its own catalogue. */
  catalogStore?: CatalogStoreFactory
  /** Whether to discover the live catalogue; false serves the static rows. */
  discovery: boolean
  /** Freshness window before an explicit event may refresh an entry. */
  catalogMaxAgeMs?: number
  /** Failure cooldown when a request failed without disclosing a retry-after. */
  cacheRetryDelayMs?: number
  /** Called once after a refresh stored a catalogue different from the previous one. */
  onCatalogChanged?: (provider: string) => void
  /** Warn sink for a cache problem or a failed refresh that kept the last-known rows. */
  onWarn?: (message: string) => void
}

/** The provider-specific pieces of one adapter's catalog listing. */
interface CatalogHooks {
  /** The provider's configured rows, served when discovery is off or nothing is known. */
  staticRows: (provider: string) => LlmModelInfo[]
  /** Fetches one account's catalog from the provider. Only refresh calls this. */
  fetchCatalog: (account: string, signal: AbortSignal) => Promise<DiscoveredModel[]>
  /** One discovered entry as a picker row, filling the provider's capability fields. */
  row: (provider: string, model: DiscoveredModel) => LlmModelInfo
  /** Per-account bound for one catalogue request; defaults to {@link DISCOVERY_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** What one account's refresh did, before it is mapped onto the provider report. */
type AccountRefreshStatus = 'fetched' | 'skipped' | 'cancelled' | 'failed'

/**
 * One provider's account-indexed catalogue caches and listing behaviour. Every
 * logged-in account has its own cache and its own persisted entry, so switching
 * accounts never serves another account's plan and a restart keeps each account's
 * capability metadata.
 */
export class ProviderCatalog {
  /** One cache per account key, created on first use. */
  private readonly caches = new Map<string, ModelCatalogCache>()
  /** The durable half of each cache, with the key it currently persists under. */
  private readonly durable = new Map<ModelCatalogCache, { persistence: CatalogPersistence; target: { key: string } }>()
  /** Durable drops still running, so {@link drain} can wait for them. */
  private readonly pending = new Set<Promise<unknown>>()

  /**
   * @param host - the adapter's token store and catalog configuration.
   * @param provider - the route this instance serves, named in change announcements.
   * @param label - provider name in diagnostics, e.g. `codex`.
   * @param hooks - the provider-specific listing pieces.
   */
  constructor(
    private readonly host: CatalogHost,
    private readonly provider: string,
    private readonly label: string,
    private readonly hooks: CatalogHooks,
  ) {}

  /**
   * Drop one account's cached catalogue, or every account's when omitted.
   *
   * The durable record is the point: an account can be logged out before any
   * read ever built its cache, so the store is cleared directly for an account
   * this instance holds no cache for, and the whole provider entry is dropped
   * when no account is named. A cache that does hold the account has its
   * generation bumped in the same breath, so an in-flight request cannot write
   * the dropped catalogue back. Callers use this for logout, removal, or a
   * changed catalogue identity — never for a routine default-account switch.
   * @param account - the account to forget; every persisted account when undefined.
   */
  clearAccountCatalog(account?: string): void {
    const store = this.host.catalogStore
    if (account === undefined) {
      for (const cache of new Set(this.caches.values())) cache.invalidate()
      if (store?.clearAll !== undefined) this.trackClear(store.clearAll(), 'every account')
      else if (store?.accounts !== undefined) this.trackClear(this.clearPersisted(store), 'every account')
      return
    }
    const cache = this.caches.get(account)
    if (cache !== undefined) {
      cache.invalidate()
      return
    }
    if (store !== undefined) this.trackClear(store(account).clear(), `"${account}"`)
  }

  /** Drop every persisted account entry when the store cannot do it in one call. */
  private async clearPersisted(store: CatalogStoreFactory): Promise<void> {
    const keys = await store.accounts?.() ?? []
    await Promise.all(keys.map(async key => { await store(key).clear() }))
  }

  /** Track one durable drop so {@link drain} waits for it; a failure is reported, not thrown. */
  private trackClear(work: Promise<void>, what: string): void {
    const tracked = work.catch((error: unknown) => {
      this.host.onWarn?.(
        `${this.label} catalogue cache could not be cleared for ${what} (${errorChain(error)})`,
      )
    })
    this.pending.add(tracked)
    const done = (): void => { this.pending.delete(tracked) }
    void tracked.then(done, done)
  }

  /**
   * Await every refresh and cache clear still running, without starting new
   * work, so a route can be dropped without leaving a write behind.
   */
  async drain(): Promise<void> {
    await Promise.all([...new Set(this.caches.values())].map(async cache => await cache.drain()))
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  /**
   * Move one account's cached catalogue to its renamed canonical key.
   *
   * The SAME cache object moves, so its seeded snapshot, its freshness instant
   * and its failure cooldown all survive; nothing here waits on an in-flight
   * request, because this runs inside the save the account's own token refresh
   * triggered and awaiting the cache would deadlock against the request waiting
   * for that save to return. The retired key keeps resolving to the moved cache,
   * so a read or a clear that still names it reaches the same account and no
   * later write can recreate a record under the old key. A cache already built
   * for the new key is superseded by the moved one.
   * @param from - the key the account's catalogue was stored under.
   * @param to - the canonical key the account now resolves to.
   */
  async renameAccount(from: string, to: string): Promise<void> {
    if (from === to) return
    const cache = this.caches.get(from)
    if (cache !== undefined) {
      this.caches.delete(from)
      this.caches.set(to, cache)
      this.caches.set(from, cache)
      const durable = this.durable.get(cache)
      if (durable !== undefined) durable.target.key = to
    }
    await this.movePersisted(from, to)
  }

  /** Move one account's durable record, merging what the target already holds. */
  private async movePersisted(from: string, to: string): Promise<void> {
    const factory = this.host.catalogStore
    if (factory === undefined) return
    const source = await factory(from).load()
    if (source === undefined) return
    const record = mergedRecord(source, await factory(to).load())
    // The snapshot is written first because it supersedes a stored failure; the
    // merged cooldown is re-attached straight after, so neither half is lost.
    if (record.snapshot !== undefined) await factory(to).save(record.snapshot)
    if (record.failure !== undefined) await factory(to).saveFailure?.(record.failure)
    await factory(from).clear()
  }

  /** The cache for one account, created with its own durable entry on first use. */
  private cache(account: string): ModelCatalogCache {
    let cache = this.caches.get(account)
    if (cache === undefined) {
      const durable = this.durableFor(account)
      cache = new ModelCatalogCache({
        ...durable === undefined ? {} : { persistence: durable.persistence },
        ...this.host.catalogMaxAgeMs === undefined ? {} : { maxAgeMs: this.host.catalogMaxAgeMs },
        ...this.host.cacheRetryDelayMs === undefined ? {} : { retryDelayMs: this.host.cacheRetryDelayMs },
        ...this.host.onWarn === undefined ? {} : { onWarn: this.host.onWarn },
        // The accepted catalogue announces itself, so one stored result is one
        // notification however many callers waited for it.
        ...this.host.onCatalogChanged === undefined
          ? {}
          : { onStored: () => { this.host.onCatalogChanged?.(this.provider) } },
        label: this.label,
      })
      if (durable !== undefined) this.durable.set(cache, durable)
      this.caches.set(account, cache)
    }
    return cache
  }

  /**
   * The durable half for one cache, over a target a rename can re-point: the
   * cache keeps one persistence object for its lifetime, so a moved account
   * keeps its in-memory state and simply persists under the new key afterwards.
   */
  private durableFor(account: string): { persistence: CatalogPersistence; target: { key: string } } | undefined {
    const factory = this.host.catalogStore
    if (factory === undefined) return undefined
    const target = { key: account }
    const saveFailure = factory(target.key).saveFailure
    const persistence: CatalogPersistence = {
      load: () => factory(target.key).load(),
      save: snapshot => factory(target.key).save(snapshot),
      clear: () => factory(target.key).clear(),
      ...saveFailure === undefined ? {} : {
        saveFailure: async (failure: CatalogFailure): Promise<void> => {
          const current = factory(target.key)
          if (current.saveFailure !== undefined) await current.saveFailure(failure)
        },
      },
    }
    return { persistence, target }
  }

  /**
   * One account's last-known catalogue. Pure: it may load the local cache file
   * on the first call and never starts a provider request.
   * @param account - the account key.
   * @returns the models, `undefined` when nothing is known yet, or an empty
   *   list for an account whose provider answered with no models.
   */
  async read(account: string): Promise<readonly DiscoveredModel[] | undefined> {
    return await this.cache(account).read()
  }

  /**
   * The last-known catalogue for one account, the default account when omitted.
   * @param account - the account key, or undefined for the default account.
   * @returns the models, or undefined when nothing is known.
   */
  async lastKnown(account?: string): Promise<readonly DiscoveredModel[] | undefined> {
    const target = account ?? await this.host.tokens.defaultAccount()
    return target === undefined ? undefined : await this.read(target)
  }

  /**
   * One account's own rows for an advisory read: the last-known catalogue, or
   * the static rows while nothing is known. Pure — a cold or stale catalogue
   * answers from disk and static rows rather than paying a provider request, so
   * no picker, pool or capability read can start one. `undefined` is caller
   * cancellation alone, which the caller reads as "this account sits out".
   * @param provider - the provider route the rows belong to.
   * @param account - the account to read.
   * @param signal - caller cancellation, observed after the local read.
   * @returns that account's rows, or `undefined` when the caller cancelled.
   */
  async resolve(
    provider: string,
    account: string,
    signal?: AbortSignal,
  ): Promise<readonly LlmModelInfo[] | undefined> {
    if (!await this.host.tokens.hasSession(account)) return []
    if (!this.host.discovery) return this.hooks.staticRows(provider)
    const models = await this.read(account)
    if (signal?.aborted === true) return undefined
    return models === undefined
      ? this.hooks.staticRows(provider)
      : models.map(model => this.hooks.row(provider, model))
  }

  /**
   * The provider's own catalog: the union over every logged-in account, or one
   * account when named. Reads never start a provider request; an account with no
   * catalogue yet contributes its static rows, and one that is logged out or
   * failing contributes nothing.
   * @param provider - the provider route the rows belong to.
   * @param account - the account to list; every logged-in account when undefined.
   * @param signal - caller cancellation; aborting drops the whole union.
   * @returns the provider's own model rows.
   */
  async list(provider: string, account?: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    if (account === undefined) {
      const accounts = (await this.host.tokens.list()).map(entry => entry.key)
      if (accounts.length === 0) return []
      return unionAccountCatalogs(
        accounts,
        (key, accountSignal) => this.list(provider, key, accountSignal),
        {
          timeoutMs: this.hooks.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
          ...signal === undefined ? {} : { signal },
        },
      )
    }
    return await this.resolve(provider, account, signal) ?? []
  }

  /**
   * The first account whose last-known catalogue lists one model. Pure: it reads
   * each account's local snapshot in turn and never starts a provider request, so
   * capability resolution cannot turn into discovery.
   *
   * A named account is checked against the store first: a credential removed
   * outside this process leaves its cached catalogue on disk, and those rows say
   * nothing about an account that can no longer serve a request.
   * @param model - the wire model id to look for.
   * @param account - the account to ask; every logged-in account (default first) when omitted.
   * @returns the advertised entry, or undefined when no consulted account lists it.
   */
  async findModel(model: string, account?: string): Promise<DiscoveredModel | undefined> {
    const accounts = account === undefined
      ? (await this.host.tokens.list()).map(entry => entry.key)
      : [account]
    return discoverAcrossAccounts(
      accounts,
      async key => {
        if (!await this.host.tokens.hasSession(key)) return undefined
        return (await this.read(key))?.find(entry => entry.id === model)
      },
    )
  }

  /**
   * Every known model id whose catalogue advertises the fast tier, unioned over
   * the logged-in accounts. Pure: an account with nothing known contributes
   * nothing, so the Speed control follows what the caches already hold.
   * @returns the fast-capable model ids, in account then catalogue order.
   */
  async fastTierIds(): Promise<string[]> {
    const accounts = (await this.host.tokens.list()).map(entry => entry.key)
    const seen = new Set<string>()
    const ids: string[] = []
    for (const account of accounts) {
      for (const model of await this.read(account) ?? []) {
        if (model.fastTier !== true || seen.has(model.id)) continue
        seen.add(model.id)
        ids.push(model.id)
      }
    }
    return ids
  }

  /**
   * Request the provider's catalogue for one account and store it. The only
   * path in this class that starts a provider request; it is called for login,
   * opening Manage, an explicit refresh, and the account a request is about to use.
   * @param provider - the provider route the rows belong to.
   * @param account - the account to refresh; the default account when undefined.
   * @param options - `force` re-requests a fresh success snapshot (an explicit
   *   user refresh) but never bypasses a live failure cooldown; `signal` detaches
   *   this caller alone from a request other waiters still share.
   * @returns which account was requested, skipped, cancelled or failed.
   */
  async refresh(
    provider: string,
    account?: string,
    options: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<CatalogRefreshReport> {
    const target = account ?? await this.host.tokens.defaultAccount()
    if (target === undefined) return { fetched: [], skipped: [], failed: [], cancelled: [] }
    const status = await this.refreshAccount(target, options)
    return {
      fetched: status === 'fetched' ? [target] : [],
      skipped: status === 'skipped' ? [target] : [],
      failed: status === 'failed' ? [target] : [],
      cancelled: status === 'cancelled' ? [target] : [],
    }
  }

  /**
   * One account's explicit refresh. The stored result announces itself (see
   * {@link cache}), so a caller that waits, a caller that detached, and a caller
   * that joined someone else's request all produce at most that one report.
   */
  private async refreshAccount(
    account: string,
    options: { force?: boolean; signal?: AbortSignal },
  ): Promise<AccountRefreshStatus> {
    if (!this.host.discovery) return 'skipped'
    const cache = this.cache(account)
    if (!await this.host.tokens.hasSession(account)) return 'skipped'
    let outcome: CatalogRefreshOutcome
    try {
      // The session is resolved through the refresh-aware path so an expired
      // access token renews here instead of failing discovery into the fallback.
      outcome = await discoverOrRetryAuth(
        force => this.host.tokens.session(account, force),
        cache,
        () => cache.refresh(
          () => this.fetchOnce(account),
          {
            ...options.force === true ? { force: true } : {},
            ...options.signal === undefined ? {} : { signal: options.signal },
          },
        ),
      )
    } catch (error: unknown) {
      // A request that cannot answer keeps the last-known catalogue: this is a
      // cache, and dropping capability metadata on a network blip would fail
      // calls for models the session already selected.
      this.host.onWarn?.(
        `${this.label} model catalogue refresh failed for "${account}" (${errorChain(error)}); `
        + 'the last known catalogue is kept',
      )
      return 'failed'
    }
    if (outcome.status === 'skipped') return 'skipped'
    if (outcome.status === 'cancelled') return 'cancelled'
    return 'fetched'
  }

  /**
   * One bounded request for an account's catalogue. The bound is this call's
   * own, never the caller's signal: a caller that stops waiting must not abort a
   * request other callers still share.
   */
  private async fetchOnce(account: string): Promise<readonly DiscoveredModel[]> {
    const models = await withTimeout(
      signal => this.hooks.fetchCatalog(account, signal),
      this.hooks.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
    )
    if (models === undefined) {
      throw new LlmError(`${this.label} model catalogue request timed out`, 'TIMEOUT')
    }
    return models
  }
}

/**
 * Picker-row fields only some providers discover: the catalog description, the
 * Codex sort priority, the provider's own context size, and an entry the account
 * cannot select.
 */
interface CatalogRowExtras {
  description?: string
  priority?: number
  contextWindow?: number
  disabledReason?: string
}

/**
 * One durable record from a rename's two sides: the newer snapshot wins (the
 * target's on a tie), and the later of the two cooldowns is kept so a rename can
 * never shorten a wait a provider asked for.
 * @param source - the record held under the key being retired.
 * @param target - the record already held under the canonical key, when any.
 * @returns the merged record.
 */
function mergedRecord(source: CatalogRecord, target: CatalogRecord | undefined): CatalogRecord {
  let snapshot = target?.snapshot
  if (source.snapshot !== undefined && (snapshot === undefined || source.snapshot.at > snapshot.at)) {
    snapshot = source.snapshot
  }
  const cooldowns = [source.failure?.notBefore, target?.failure?.notBefore]
    .filter((notBefore): notBefore is number => notBefore !== undefined)
  const notBefore = cooldowns.length === 0 ? undefined : Math.max(...cooldowns)
  return {
    ...snapshot === undefined ? {} : { snapshot },
    ...notBefore === undefined ? {} : { failure: { notBefore } },
  }
}

/**
 * The provider's own disabled marker on one picker row, when the route published one.
 *
 * The harness model-info contract has no field for it, so a route that receives a
 * `disabled_reason` from its catalogue carries the marker as an extension of its own row.
 * The owning adapters and the settings RPC both read it through here, so the extension
 * has one spelling.
 * @param model - one row as a subscription route published it.
 * @returns the provider's reason for refusing the model, or undefined when it may serve.
 */
export function modelDisabledReason(model: LlmModelInfo): string | undefined {
  return (model as LlmModelInfo & Pick<CatalogRowExtras, 'disabledReason'>).disabledReason
}

/**
 * One picker row for a discovered catalog entry: the advertised id, name and
 * modalities, plus the provider's own extra fields. A provider that does not
 * surface a catalog description passes no `description` extra.
 * @param provider - the provider route the row belongs to.
 * @param model - the discovered entry.
 * @param inputModalities - modalities to advertise; undefined leaves the field off.
 * @param extras - provider-specific row fields.
 * @returns the picker row.
 */
export function catalogRow(
  provider: string,
  model: DiscoveredModel,
  inputModalities: readonly ('text' | 'image')[] | undefined,
  extras?: CatalogRowExtras,
): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    ...inputModalities === undefined ? {} : { inputModalities },
    ...extras,
  } as LlmModelInfo
}

/**
 * One provider's picker rows: its own catalog plus any configured pool tiers
 * the catalog does not already list. An account pool reuses the catalog row of
 * the same wire id for its members, so only configured tiers are extra.
 * @param own - the provider's own rows.
 * @param pool - the provider's account pool, when one is configured.
 * @param provider - the provider route the pool is keyed by.
 * @returns the own rows followed by the unseen pool rows.
 */
export async function withPoolTiers(
  own: readonly LlmModelInfo[],
  pool: CatalogTierSource | undefined,
  provider: string,
): Promise<readonly LlmModelInfo[]> {
  if (pool === undefined) return own
  const extra = await pool.modelsForProvider(provider as ProviderId)
  const seen = new Set(own.map(model => model.id))
  return [...own, ...extra.filter(model => !seen.has(model.id))]
}
