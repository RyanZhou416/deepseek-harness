/**
 * The catalog plumbing the subscription adapters share. One
 * {@link ProviderCatalog} owns a provider's account-indexed model caches and
 * runs the listing skeleton: union every logged-in account, bound each lookup,
 * map a discovery failure onto the static rows. An adapter supplies only what
 * is genuinely its own — the discovery fetch, the static rows, the row mapping
 * and the fallback wording.
 */

import { errorChain } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { ProviderId } from '../auth/store.js'
import { unionAccountCatalogs } from './accounts.js'
import {
  DISCOVERY_TIMEOUT_MS,
  ModelCatalogCache,
  discoverOrRetryAuth,
  isDiscoveryAborted,
  isMissingOrInvalidCredential,
} from './common.js'
import type { CatalogPersistence, DiscoveredModel } from './common.js'

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
  /** Durable half of the default account's cache (the persisted cache is the default's). */
  catalogStore?: CatalogPersistence
  /** Whether to fetch the live catalog when logged in; false serves the static rows. */
  discovery: boolean
  /** Warn sink for a discovery failure that fell back to the static rows. */
  onWarn?: (message: string) => void
}

/** The provider-specific pieces of one adapter's catalog listing. */
interface CatalogHooks {
  /** The provider's configured rows, served when discovery is off, absent, or failing. */
  staticRows: (provider: string) => LlmModelInfo[]
  /** Fetches one account's catalog from the provider. */
  fetchCatalog: (account: string | undefined, signal?: AbortSignal) => Promise<DiscoveredModel[]>
  /** One discovered entry as a picker row, filling the provider's capability fields. */
  row: (provider: string, model: DiscoveredModel) => LlmModelInfo
  /** Per-account bound for the union listing; defaults to {@link DISCOVERY_TIMEOUT_MS}. */
  timeoutMs?: number
}

/**
 * One provider's account-indexed catalog caches and listing behaviour. The
 * persisted cache serves the default account; every other account gets a
 * throwaway in-memory cache, so switching accounts never serves another
 * account's plan.
 */
export class ProviderCatalog {
  private readonly defaultCache: ModelCatalogCache
  /** In-memory catalogs for non-default accounts (the persisted cache is the default's). */
  private readonly accountCaches = new Map<string, ModelCatalogCache>()
  /** Account whose snapshot currently lives in {@link defaultCache}; cleared on default change. */
  private owner: string | undefined

  /**
   * @param host - the adapter's token store and catalog configuration.
   * @param label - provider name in the fallback warning, e.g. `codex`.
   * @param hooks - the provider-specific listing pieces.
   */
  constructor(
    private readonly host: CatalogHost,
    private readonly label: string,
    private readonly hooks: CatalogHooks,
  ) {
    this.defaultCache = new ModelCatalogCache(host.catalogStore)
  }

  /** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
  invalidate(account?: string): void {
    if (account === undefined) this.accountCaches.clear()
    else this.accountCaches.delete(account)
    if (account === undefined || this.owner === account || this.owner === undefined) {
      this.owner = undefined
      this.defaultCache.invalidate()
    }
  }

  /** The persisted cache for the default account; a throwaway cache for any other. */
  async cache(account?: string): Promise<ModelCatalogCache> {
    const defaultKey = await this.host.tokens.defaultAccount()
    const key = account ?? defaultKey
    if (key === undefined || key === defaultKey) {
      if (this.owner !== undefined && this.owner !== defaultKey) this.defaultCache.invalidate()
      this.owner = defaultKey
      return this.defaultCache
    }
    let cache = this.accountCaches.get(key)
    if (cache === undefined) {
      cache = new ModelCatalogCache()
      this.accountCaches.set(key, cache)
    }
    return cache
  }

  /**
   * The last successfully fetched catalog for one account, ignoring TTL. Used
   * to carry capability metadata forward when a later fetch cannot re-enrich.
   * @param account - the account key; the default account when undefined.
   * @returns the last-known models, or undefined when nothing has been stored.
   */
  async lastKnown(account?: string): Promise<readonly DiscoveredModel[] | undefined> {
    if (account !== undefined && account !== await this.host.tokens.defaultAccount()) {
      return this.accountCaches.get(account)?.lastKnown()
    }
    return this.defaultCache.lastKnown()
  }

  /**
   * The provider's own catalog: the union over every logged-in account, or one
   * account when named. Each account lookup is bounded and one failing account
   * sits out; a discovery failure warns and falls back to the static rows, a
   * cancellation propagates, and a vanished login lists nothing.
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
    if (!await this.host.tokens.hasSession(account)) return []
    if (!this.host.discovery) return this.hooks.staticRows(provider)
    const catalog = await this.cache(account)
    try {
      // The fetcher runs only on a cache miss, and resolves the session
      // through the refresh-aware path so an expired access token renews here
      // instead of failing discovery into the static fallback.
      const models = await discoverOrRetryAuth(
        force => this.host.tokens.session(account, force),
        catalog,
        () => catalog.get(() => this.hooks.fetchCatalog(account, signal)),
      )
      return models.map(model => this.hooks.row(provider, model))
    } catch (error: unknown) {
      // A cancelled discovery must not fall back to the static catalog — the
      // caller (pool assembly) treats abort as "this account sits out".
      if (isDiscoveryAborted(error, signal)) throw error
      // A permanent refresh failure deletes the stored session: the provider
      // is logged out, so hide it instead of showing a stale static catalog.
      if (isMissingOrInvalidCredential(error)) return []
      this.host.onWarn?.(
        `${this.label} model discovery failed; using the built-in catalog (${errorChain(error)})`,
      )
      return this.hooks.staticRows(provider)
    }
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
