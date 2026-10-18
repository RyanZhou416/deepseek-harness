/**
 * Work-count and barrier regressions for what a subscription catalogue read
 * costs through the registered `AccountPreferencesAdapter` route, plus the
 * negative controls that prove the counts:
 *
 * - no read — capability resolution, listing, pool membership, a Speed read —
 *   starts a provider request, however cold or stale the catalogue is;
 * - an actual request ensures the ONE selected account, not every peer;
 * - N concurrent callers of one account produce one request;
 * - a targeted refresh leaves its siblings alone, and `force` never bypasses a
 *   live failure cooldown;
 * - a logout during an in-flight refresh cannot resurrect the dropped catalogue.
 *
 * All are stated as deterministic work counts and barriers, never as elapsed
 * time: the catalog request is a counted stand-in the test releases explicitly,
 * so no assertion can pass or fail on scheduler luck.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountPreferencesAdapter } from '../src/providers/account-preferences.js'
import { catalogStore } from '../src/providers/catalog-store.js'
import { PoolBackedAdapter } from '../src/providers/pool-delegation.js'
import { ProviderCatalog } from '../src/providers/provider-catalog.js'
import { PoolAdapter } from '../src/providers/pool.js'
import { PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import { resolvePoolScheduling } from '../src/providers/pool-scheduling.js'
import { buildAccountPools, poolKey } from '../src/providers/pool-family.js'
import type { PoolDefinition, PoolMemberRef } from '../src/providers/pool-family.js'
import { DISCOVERY_TIMEOUT_MS, OAuthEndpointError, withTimeout } from '../src/providers/common.js'
import type { CatalogPersistence, CatalogSnapshot, CatalogStoreFactory, DiscoveredModel } from '../src/providers/common.js'
import { ProviderSettingsStore } from '../src/provider-settings.js'
import { saveAccountSession } from '../src/auth/store.js'
import type { ProviderId } from '../src/auth/store.js'
import { CodexAdapter } from '../src/providers/codex.js'
import { createFakeConnection } from './fake-connection.js'

const plugin = await import('../src/index.js')

const MODELS: readonly DiscoveredModel[] = [
  { id: 'm1', name: 'Model 1' },
  { id: 'm2', name: 'Model 2' },
]

/** The catalog request's payload; a fresh array because the cache owns what it stores. */
function servedModels(): DiscoveredModel[] {
  return [...MODELS]
}

/** One release-on-demand barrier, so a pending catalog request is a state, not a delay. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

/**
 * Flush every pending microtask chain. `setImmediate` runs after the microtask
 * queue has emptied, so a promise chain needing no external resource has settled
 * by the time this resolves, and one waiting on an unreleased barrier provably
 * has not.
 */
function drain(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve) })
}

/** The account store both the catalog and the registered route read. */
interface AccountStore {
  keys(provider: ProviderId): readonly string[]
  list(provider: ProviderId): Promise<readonly { key: string }[]>
}

function accountStore(accounts: Partial<Record<ProviderId, readonly string[]>>): AccountStore {
  return {
    keys: provider => accounts[provider] ?? [],
    list: async provider => (accounts[provider] ?? []).map(key => ({ key })),
  }
}

interface ComposeOptions {
  /** Routes to register, mirroring the plugin's provider set. */
  providers: readonly ProviderId[]
  store: AccountStore
  /** Providers the auto-account sweep may name; defaults to every registered route. */
  swept?: readonly ProviderId[]
  /** One provider's catalog request. Counted by the fixture; may await a barrier. */
  fetch: (provider: ProviderId, account: string) => Promise<DiscoveredModel[]>
  /** Persisted snapshot age in ms; undefined leaves the catalog cold. */
  persistedAgeMs?: number
  /** Explicit family source, replacing the auto-account sweep. */
  families?: (provider: ProviderId | undefined) => Map<string, PoolDefinition>
  /**
   * How the auto-account sweep reads one account's catalog. `read` is the
   * plugin's own path (a pure cache read that requests nothing); `refresh` is
   * the negative control that awaits an explicit refresh per account, which is
   * what a sweep would have to do to discover anything cold.
   */
  sweep?: 'read' | 'refresh'
  /** Configured extra picker entries, by pool id. */
  tiers?: Record<string, PoolMemberRef[]>
}

interface Fixture {
  route(provider: ProviderId): AccountPreferencesAdapter
  /** The raw adapter behind the registered route (its own catalogue seam). */
  adapter(provider: ProviderId): CatalogAdapter
  pool: PoolAdapter
  /** Catalog requests issued for one provider so far. */
  fetches(provider: ProviderId): number
  /** Catalog requests issued for one provider/account so far. */
  fetchesFor(provider: ProviderId, account: string): number
  /** Auto-account sweeps performed so far. */
  sweeps(): number
  dispose(): Promise<void>
}

/** A concrete adapter over a real {@link ProviderCatalog}, as the plugin wires one. */
class CatalogAdapter extends PoolBackedAdapter {
  protected readonly catalogs: ProviderCatalog

  constructor(
    private readonly providerId: ProviderId,
    poolHost: { pool?: () => PoolAdapter | undefined },
    private readonly store: AccountStore,
    private readonly options: ComposeOptions,
  ) {
    super(poolHost)
    this.catalogs = new ProviderCatalog(
      {
        tokens: {
          list: async () => (await this.store.list(this.providerId)).map(entry => ({ key: entry.key })),
          session: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
          hasSession: async account => account !== undefined && this.store.keys(this.providerId).includes(account),
          defaultAccount: async () => this.store.keys(this.providerId)[0],
        },
        discovery: true,
        ...this.options.persistedAgeMs === undefined
          ? {}
          : { catalogStore: persistedStore(this.options.persistedAgeMs, this.providerId) },
      },
      providerId,
      providerId,
      {
        staticRows: provider => MODELS.map(model => ({ provider, id: model.id, name: model.name })),
        fetchCatalog: (account) => this.options.fetch(this.providerId, account),
        row: (provider, model): LlmModelInfo => ({ provider, id: model.id, name: model.name }),
      },
    )
  }

  /** Mirrors a concrete adapter's discovered-catalog capability lookup: a pure read. */
  async resolveOwnModel(provider: string, model: string, account?: string): Promise<LlmResolvedModelInfo> {
    const found = await this.catalogs.findModel(model, account)
    return { provider, id: model, name: found?.name ?? model }
  }

  clearAccountCatalog(account?: string): void {
    this.catalogs.clearAccountCatalog(account)
  }

  protected async *streamOwn(options: GenerateOptions, _account?: string): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: options.model }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * A store factory that serves one snapshot of the given age for EVERY account.
 * The per-account isolation itself is covered by the store's own spec; this
 * fixture only needs a catalogue that is already known and already stale.
 */
function persistedStore(ageMs: number, _provider: ProviderId): CatalogStoreFactory {
  const snapshot: CatalogSnapshot = { at: Date.now() - ageMs, models: [...MODELS] }
  const persistence: CatalogPersistence = {
    load: async () => ({ snapshot }),
    save: async () => undefined,
    clear: async () => undefined,
  }
  return () => persistence
}

/**
 * Compose the production wiring: one registered route per provider over its own
 * account catalogs, the pool built over those routes' member seams, and the
 * account sweep the plugin passes as `families`.
 */
async function compose(options: ComposeOptions): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-resolution-cost-'))
  const counts = new Map<string, number>()
  const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
  const concrete = new Map<ProviderId, CatalogAdapter>()
  const routes = new Map<ProviderId, AccountPreferencesAdapter>()
  const members: Partial<Record<ProviderId, ReturnType<AccountPreferencesAdapter['poolMember']>>> = {}
  let pool!: PoolAdapter
  let sweeps = 0

  const counted: ComposeOptions = {
    ...options,
    fetch: async (provider, account) => {
      const key = `${provider}/${account}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
      return await options.fetch(provider, account)
    },
  }

  for (const provider of options.providers) {
    const adapter = new CatalogAdapter(provider, { pool: () => pool }, options.store, counted)
    concrete.set(provider, adapter)
    const route = new AccountPreferencesAdapter({
      provider,
      adapter,
      settings,
      pool: () => pool,
      onWarn: () => undefined,
      accounts: async () => (await options.store.list(provider)).map(entry => ({ key: entry.key, label: entry.key })),
    })
    routes.set(provider, route)
    members[provider] = route.poolMember()
  }

  // Mirrors the plugin's `families`: the auto-account sweep names every account
  // of every provider it is asked about, plus the configured families.
  const families = async (provider?: ProviderId): Promise<Map<string, PoolDefinition>> => {
    sweeps += 1
    if (options.families !== undefined) return options.families(provider)
    const sources: Partial<Record<ProviderId, { catalogs: readonly { account: string; models: readonly LlmModelInfo[] }[] }>> = {}
    const swept = (options.swept ?? options.providers).filter(key => provider === undefined || key === provider)
    await Promise.all(swept.map(async (key) => {
      const accounts = options.store.keys(key)
      if (accounts.length === 0) return
      const catalogs = (await Promise.all(accounts.map(async (account) => {
        const adapter = concrete.get(key)!
        if (options.sweep === 'refresh') {
          // The negative control: discover each account explicitly, which is the
          // only way a cold catalogue ever produces rows.
          await withTimeout(
            async signal => { await adapter.refreshOwnCatalog(key, account, { signal }) },
            DISCOVERY_TIMEOUT_MS,
          )
          return { account, models: await adapter.listOwnModels(key, account) }
        }
        const listed = await withTimeout(
          async signal => await adapter.resolveOwnCatalog?.(key, account, signal)
            ?? await adapter.listOwnModels(key, account, signal),
          DISCOVERY_TIMEOUT_MS,
        )
        return listed === undefined ? undefined : { account, models: listed }
      }))).filter(entry => entry !== undefined)
      if (catalogs.length > 0) sources[key] = { catalogs }
    }))
    return buildAccountPools(sources)
  }

  pool = new PoolAdapter({
    adapters: members,
    health: new PoolHealthRegistry(),
    usage: new PoolUsageTracker(() => undefined),
    strategy: 'priority',
    scheduling: resolvePoolScheduling(),
    concurrency: { requestsPerMinute: 0, minGapMs: 0 },
    defaultAccount: async provider => options.store.keys(provider)[0],
    families,
    tiers: options.tiers ?? {},
    onWarn: () => undefined,
  })

  const forProvider = (provider: ProviderId): number =>
    [...counts.entries()].filter(([key]) => key.startsWith(`${provider}/`)).reduce((total, [, count]) => total + count, 0)

  return {
    route: provider => routes.get(provider)!,
    adapter: provider => concrete.get(provider)!,
    pool,
    fetches: forProvider,
    fetchesFor: (provider, account) => counts.get(`${provider}/${account}`) ?? 0,
    sweeps: () => sweeps,
    dispose: async () => { await rm(dir, { recursive: true, force: true }) },
  }
}

/** One provider's account pool, exactly as `buildAccountPools` would key it. */
function ownPool(provider: ProviderId, account: string, model: string): Map<string, PoolDefinition> {
  return new Map([[poolKey(provider, model), { members: [{ provider, account, model }] }]])
}

/** What one route's ProviderCatalog is given, as an adapter's own options shape it. */
interface CatalogHarnessOptions {
  /** Durable store; absent keeps every cache in memory. */
  store?: CatalogStoreFactory
  /** Accounts the store lists, default first. */
  accounts?: readonly string[]
  /** Accounts that still hold a credential; defaults to `accounts`. */
  sessions?: () => readonly string[]
  /** One account's catalogue request. */
  fetch?: (account: string) => Promise<readonly DiscoveredModel[]>
  /** Called when a stored catalogue moved. */
  onCatalogChanged?: (provider: string) => void
}

/** A ProviderCatalog over a provider route, as the adapters wire one. */
function catalogHarness(options: CatalogHarnessOptions = {}): ProviderCatalog {
  const accounts = options.accounts ?? ['a1', 'a2']
  const live = options.sessions ?? ((): readonly string[] => accounts)
  return new ProviderCatalog(
    {
      tokens: {
        list: async () => (await live()).map(key => ({ key })),
        session: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
        hasSession: async account => account !== undefined && live().includes(account),
        defaultAccount: async () => (await live())[0],
      },
      ...options.store === undefined ? {} : { catalogStore: options.store },
      discovery: true,
      ...options.onCatalogChanged === undefined ? {} : { onCatalogChanged: options.onCatalogChanged },
    },
    'codex',
    'codex',
    {
      staticRows: provider => MODELS.map(model => ({ provider, id: model.id, name: model.name })),
      fetchCatalog: async account => [...await (options.fetch ?? (async () => servedModels()))(account)],
      row: (provider, model): LlmModelInfo => ({ provider, id: model.id, name: model.name }),
    },
  )
}

/** A store file path inside its own private temporary directory. */
async function storePath(prefix: string): Promise<{ dir: string; store: CatalogStoreFactory }> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return { dir, store: catalogStore('codex', { path: join(dir, 'models.json') }) }
}

const STALE_AGE_MS = 25 * 60 * 60_000

test('capability resolution requests nothing, even from a stale catalogue', async t => {
  const gate = deferred()
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a'] }),
    persistedAgeMs: STALE_AGE_MS,
    families: () => ownPool('codex', 'a', 'm1'),
    fetch: async () => { await gate.promise; return servedModels() },
  })
  t.after(async () => { gate.release(); await fixture.dispose() })

  // The gated request would hang forever if the read joined it, so settling here
  // IS the assertion; the count below names what did not happen.
  const resolved = await fixture.route('codex').resolveModel('codex', 'm1')
  assert.equal(resolved.id, 'm1')
  assert.equal(
    (await fixture.adapter('codex').resolveOwnModel('codex', 'm1', 'a')).name,
    'Model 1',
    'the stale catalogue is what answered the capability question',
  )
  assert.equal(fixture.fetches('codex'), 0, 'a stale capability read started a request')
  gate.release()
})

test('negative control: the same catalogue does request when something asks explicitly', async t => {
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a'] }),
    persistedAgeMs: STALE_AGE_MS,
    families: () => ownPool('codex', 'a', 'm1'),
    fetch: async () => servedModels(),
  })
  t.after(async () => { await fixture.dispose() })

  const report = await fixture.adapter('codex').refreshOwnCatalog('codex', 'a')
  assert.deepEqual(report.fetched, ['a'])
  assert.equal(fixture.fetchesFor('codex', 'a'), 1)
  // A second explicit call finds the entry fresh and requests nothing.
  assert.deepEqual((await fixture.adapter('codex').refreshOwnCatalog('codex', 'a')).skipped, ['a'])
  assert.equal(fixture.fetchesFor('codex', 'a'), 1)
})

test('listing a provider requests nothing, and a cold account serves the built-in rows', async t => {
  const fixture = await compose({
    providers: ['codex', 'claude'],
    store: accountStore({ codex: ['a1', 'a2'], claude: ['a1', 'a2'] }),
    fetch: async () => servedModels(),
  })
  t.after(async () => { await fixture.dispose() })

  const listed = await fixture.route('codex').listModels('codex')
  assert.deepEqual(listed.map(model => model.id), ['m1', 'm2'], 'the built-in rows stand in while nothing is known')
  assert.equal(fixture.fetches('codex'), 0, 'listing requested a catalogue')
  assert.equal(fixture.fetches('claude'), 0, "the codex list touched claude's catalogue")
})

test('pool membership reads request nothing', async t => {
  const fixture = await compose({
    providers: ['codex', 'claude'],
    store: accountStore({ codex: ['a1', 'a2'], claude: ['a1', 'a2'] }),
    fetch: async () => servedModels(),
  })
  t.after(async () => { await fixture.dispose() })

  assert.equal(await fixture.pool.owns('codex', 'm1'), true)
  assert.equal(fixture.fetches('codex'), 0, "pool membership requested codex's catalogue")
  assert.equal(fixture.fetches('claude'), 0, "the codex pool read touched claude's catalogue")
})

test('a cold pool membership read never waits on a catalogue request', async t => {
  const gate = deferred()
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a'] }),
    sweep: 'read',
    fetch: async () => { await gate.promise; return servedModels() },
  })
  t.after(async () => { gate.release(); await fixture.dispose() })

  const owns = await withTimeout(async () => await fixture.pool.owns('codex', 'm1'), DISCOVERY_TIMEOUT_MS)
  assert.equal(owns, true, 'a cold pool snapshot waited on the membership read')
  assert.equal(fixture.fetches('codex'), 0)
  gate.release()
})

test('negative control: a sweep that awaits an explicit refresh does wait on it', async t => {
  const gate = deferred()
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a'] }),
    sweep: 'refresh',
    fetch: async () => { await gate.promise; return servedModels() },
  })
  t.after(async () => { gate.release(); await fixture.dispose() })

  let settled = false
  const owns = fixture.pool.owns('codex', 'm1').then(() => { settled = true }, () => { settled = true })
  await drain()
  assert.equal(settled, false, 'the refreshing sweep must await the request it started')
  gate.release()
  await owns
  assert.equal(fixture.fetches('codex'), 1)
})

test('an actual request ensures only the account it is about to use', async t => {
  const gate = deferred()
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a1', 'a2'] }),
    // No families: the request falls back to the first eligible account itself.
    families: () => new Map(),
    fetch: async (_provider, account) => {
      if (account === 'a1') await gate.promise
      return [MODELS[0]]
    },
  })
  t.after(async () => { gate.release(); await fixture.dispose() })

  let first = true
  const streaming = (async () => {
    for await (const _chunk of fixture.route('codex').stream({ provider: 'codex', model: 'm1', messages: [] })) {
      if (first) { first = false }
    }
  })().then(() => undefined, () => undefined)
  await drain()
  assert.equal(fixture.fetchesFor('codex', 'a1'), 1, 'the selected account was not ensured')
  assert.equal(fixture.fetchesFor('codex', 'a2'), 0, 'a peer was ensured for a request that never reaches it')
  gate.release()
  await streaming
})

test('a request about to be sent does not proceed on a catalogue it cannot confirm', async t => {
  const gate = deferred()
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a'] }),
    families: () => new Map(),
    fetch: async () => { await gate.promise; return [] },
  })
  t.after(async () => { gate.release(); await fixture.dispose() })

  let settled = false
  const streaming = (async () => {
    for await (const _chunk of fixture.route('codex').stream({ provider: 'codex', model: 'm1', messages: [] })) {
      // the gated catalogue never lists m1
    }
  })().then(() => { settled = true }, () => { settled = true })
  await drain()
  assert.equal(settled, false, 'the request must await the ensure of the account it is about to use')
  gate.release()
  await streaming
  assert.equal(settled, true)
})

test('concurrent ensures of one account collapse into a single request', async t => {
  const gate = deferred()
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a'] }),
    families: () => new Map(),
    fetch: async () => { await gate.promise; return servedModels() },
  })
  t.after(async () => { gate.release(); await fixture.dispose() })

  const adapter = fixture.adapter('codex')
  const attempts = Array.from({ length: 5 }, async () => await adapter.refreshOwnCatalog('codex', 'a'))
  await drain()
  assert.equal(fixture.fetchesFor('codex', 'a'), 1, 'each caller started its own request')
  gate.release()
  for (const report of await Promise.all(attempts)) assert.deepEqual(report.fetched, ['a'])
  assert.equal(fixture.fetchesFor('codex', 'a'), 1)
})

test('a targeted refresh touches one account and leaves its sibling alone', async t => {
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a1', 'a2'] }),
    families: () => new Map(),
    fetch: async () => servedModels(),
  })
  t.after(async () => { await fixture.dispose() })

  await fixture.adapter('codex').refreshOwnCatalog('codex', 'a2')
  assert.equal(fixture.fetchesFor('codex', 'a2'), 1)
  assert.equal(fixture.fetchesFor('codex', 'a1'), 0, 'refreshing one account refreshed a peer')
  // An omitted account means the provider's default account, not every account.
  await fixture.adapter('codex').refreshOwnCatalog('codex')
  assert.equal(fixture.fetchesFor('codex', 'a1'), 1)
  assert.equal(fixture.fetchesFor('codex', 'a2'), 1, 'a default-account refresh must not sweep the peers')
})

test('force re-requests a fresh success that an ordinary ensure skips', async t => {
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a'] }),
    families: () => new Map(),
    fetch: async () => servedModels(),
  })
  t.after(async () => { await fixture.dispose() })

  const adapter = fixture.adapter('codex')
  assert.deepEqual((await adapter.refreshOwnCatalog('codex', 'a')).fetched, ['a'])
  assert.deepEqual((await adapter.refreshOwnCatalog('codex', 'a')).skipped, ['a'])
  assert.equal(fixture.fetchesFor('codex', 'a'), 1)
  assert.deepEqual((await adapter.refreshOwnCatalog('codex', 'a', { force: true })).fetched, ['a'])
  assert.equal(fixture.fetchesFor('codex', 'a'), 2)
})

test('a failure cooldown holds for an ordinary ensure and for a forced refresh', async t => {
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a'] }),
    families: () => new Map(),
    fetch: async () => { throw new LlmError('catalog unavailable', 'TRANSPORT') },
  })
  t.after(async () => { await fixture.dispose() })

  const adapter = fixture.adapter('codex')
  assert.deepEqual((await adapter.refreshOwnCatalog('codex', 'a')).failed, ['a'])
  assert.equal(fixture.fetchesFor('codex', 'a'), 1)
  // Retrying past the cooldown is exactly the storm it exists to prevent, so a
  // manual (forced) refresh waits it out too.
  assert.deepEqual((await adapter.refreshOwnCatalog('codex', 'a')).skipped, ['a'])
  assert.deepEqual((await adapter.refreshOwnCatalog('codex', 'a', { force: true })).skipped, ['a'])
  assert.equal(fixture.fetchesFor('codex', 'a'), 1, 'a failing provider was queried again')
})

test('a configured tier stays with the provider that owns it', async t => {
  const fixture = await compose({
    providers: ['codex', 'claude'],
    store: accountStore({ codex: ['a1'], claude: ['a1'] }),
    swept: [],
    fetch: async () => servedModels(),
    tiers: { smart: [{ provider: 'codex', account: 'a1', model: 'm1' }] },
  })
  t.after(async () => { await fixture.dispose() })

  assert.deepEqual((await fixture.pool.modelsForProvider('codex')).map(model => model.id), ['smart'])
  assert.deepEqual(await fixture.pool.modelsForProvider('claude'), [])
})

test('a logged-out route still refuses a model no account lists', async t => {
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: [] }),
    persistedAgeMs: STALE_AGE_MS,
    fetch: async () => servedModels(),
  })
  t.after(async () => { await fixture.dispose() })

  await assert.rejects(
    fixture.route('codex').resolveModel('codex', 'm1'),
    (error: unknown) => error instanceof LlmError && /No eligible account/.test(error.message),
  )
})

test('a vanished login lists nothing even while a catalog is still known', async t => {
  const keys = ['a']
  const fixture = await compose({
    providers: ['codex'],
    store: { keys: () => keys, list: async () => keys.map(key => ({ key })) },
    persistedAgeMs: 0,
    families: () => ownPool('codex', 'a', 'm1'),
    fetch: async () => servedModels(),
  })
  t.after(async () => { await fixture.dispose() })

  // The credential is gone but the persisted catalog still holds rows: the login
  // check, not the cache, decides that no account may serve the model. The pool
  // reports the member's refusal as its own unusable-pool error.
  keys.length = 0
  await assert.rejects(
    fixture.route('codex').resolveModel('codex', 'm1'),
    (error: unknown) => error instanceof LlmError && /no usable member/.test(error.message),
  )
})

test('extra tier rows are configuration: listing them neither sweeps nor requests a catalogue', async t => {
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a1', 'a2'] }),
    swept: [],
    tiers: { smart: [{ provider: 'codex', account: 'a1', model: 'm1' }] },
    fetch: async () => { throw new LlmError('catalog unavailable', 'TRANSPORT') },
  })
  t.after(async () => { await fixture.dispose() })

  await fixture.route('codex').listModels('codex')
  const sweepsAfterListing = fixture.sweeps()
  assert.deepEqual((await fixture.pool.modelsForProvider('codex')).map(model => model.id), ['smart'])
  assert.equal(fixture.sweeps(), sweepsAfterListing, 'listing extra rows swept the account catalogs')
  assert.equal(fixture.fetches('codex'), 0, 'a read requested a catalogue')
})

test('extra rows keep their tier id, order and the usable-member rule', async t => {
  const fixture = await compose({
    providers: ['codex', 'claude'],
    store: accountStore({ codex: ['a1'], claude: ['a1'] }),
    swept: [],
    tiers: {
      first: [{ provider: 'codex', account: 'a1', model: 'm1' }],
      skipped: [],
      second: [{ provider: 'codex', account: 'a1', model: 'm2' }],
      foreign: [{ provider: 'claude', account: 'a1', model: 'm1' }],
    },
    fetch: async () => servedModels(),
  })
  t.after(async () => { await fixture.dispose() })

  assert.deepEqual((await fixture.pool.modelsForProvider('codex')).map(model => model.id), ['first', 'second'])
  assert.deepEqual((await fixture.pool.modelsForProvider('claude')).map(model => model.id), ['foreign'])
  assert.deepEqual((await fixture.pool.modelsForProvider('claude')).map(model => model.provider), ['claude'])
})

test('a logout during an in-flight refresh cannot resurrect the dropped catalogue', async () => {
  const gate = deferred()
  const calls: { provider: ProviderId; account: string }[] = []
  const catalog = new ProviderCatalog(
    {
      tokens: {
        list: async () => [{ key: 'a' }],
        session: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
        hasSession: async () => true,
        defaultAccount: async () => 'a',
      },
      discovery: true,
    },
    'codex',
    'codex',
    {
      staticRows: provider => MODELS.map(model => ({ provider, id: model.id, name: model.name })),
      fetchCatalog: async (account) => {
        calls.push({ provider: 'codex', account })
        await gate.promise
        return servedModels()
      },
      row: (provider, model): LlmModelInfo => ({ provider, id: model.id, name: model.name }),
    },
  )

  const pending = catalog.refresh('codex', 'a')
  await drain()
  catalog.clearAccountCatalog('a')
  gate.release()
  assert.deepEqual((await pending).fetched, ['a'], 'the request itself still settles for its caller')
  assert.equal(await catalog.read('a'), undefined, 'the dropped catalogue must not come back')
  assert.deepEqual((await catalog.list('codex', 'a')).map(model => model.id), ['m1', 'm2'],
    'a dropped catalogue lists the built-in rows, never the login that was dropped')
  assert.deepEqual(calls, [{ provider: 'codex', account: 'a' }])
})

test('an advisory read serves the built-in rows when nothing is known, without a request', async () => {
  let requested = 0
  const catalog = new ProviderCatalog(
    {
      tokens: {
        list: async () => [{ key: 'a' }],
        session: async () => { throw new LlmError('login expired or was revoked', 'MISSING_CREDENTIAL') },
        hasSession: async () => true,
        defaultAccount: async () => 'a',
      },
      discovery: true,
    },
    'codex',
    'codex',
    {
      staticRows: provider => MODELS.map(model => ({ provider, id: model.id, name: model.name })),
      fetchCatalog: async () => { requested += 1; return servedModels() },
      row: (provider, model): LlmModelInfo => ({ provider, id: model.id, name: model.name }),
    },
  )

  assert.deepEqual((await catalog.resolve('codex', 'a'))?.map(model => model.id), ['m1', 'm2'])
  assert.deepEqual((await catalog.list('codex', 'a')).map(model => model.id), ['m1', 'm2'])
  assert.equal(requested, 0, 'an advisory read requested a catalogue')
})

test('an authoritative empty catalogue lists nothing, where an unknown one lists the built-ins', async () => {
  const catalog = new ProviderCatalog(
    {
      tokens: {
        list: async () => [{ key: 'a' }],
        session: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
        hasSession: async () => true,
        defaultAccount: async () => 'a',
      },
      discovery: true,
    },
    'codex',
    'codex',
    {
      staticRows: provider => MODELS.map(model => ({ provider, id: model.id, name: model.name })),
      fetchCatalog: async () => [],
      row: (provider, model): LlmModelInfo => ({ provider, id: model.id, name: model.name }),
    },
  )

  // Nothing known yet: the built-in rows stand in, so a cold picker is never empty.
  assert.deepEqual((await catalog.list('codex', 'a')).map(model => model.id), ['m1', 'm2'])
  // The provider answered "no models for this account": that answer is authoritative.
  assert.deepEqual((await catalog.refresh('codex', 'a')).fetched, ['a'])
  assert.deepEqual(await catalog.list('codex', 'a'), [])
  assert.deepEqual(await catalog.resolve('codex', 'a'), [])
})

test('a stored catalogue is announced once, and only when it actually moved', async () => {
  const announced: string[] = []
  let served: DiscoveredModel[] = [MODELS[0]]
  const catalog = new ProviderCatalog(
    {
      tokens: {
        list: async () => [{ key: 'a' }],
        session: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
        hasSession: async () => true,
        defaultAccount: async () => 'a',
      },
      discovery: true,
      onCatalogChanged: provider => announced.push(provider),
    },
    'codex',
    'codex',
    {
      staticRows: provider => MODELS.map(model => ({ provider, id: model.id, name: model.name })),
      fetchCatalog: async () => [...served],
      row: (provider, model): LlmModelInfo => ({ provider, id: model.id, name: model.name }),
    },
  )

  await catalog.refresh('codex', 'a')
  assert.deepEqual(announced, ['codex'], 'the first stored catalogue is a change')
  await catalog.refresh('codex', 'a', { force: true })
  assert.deepEqual(announced, ['codex'], 're-requesting the same rows is not a change')
  served = [MODELS[1]]
  await catalog.refresh('codex', 'a', { force: true })
  assert.deepEqual(announced, ['codex', 'codex'], 'moved rows are announced')
})

test('a non-default account keeps its own catalogue across a reload', async () => {
  const { dir, store } = await storePath('catalog-reload-')
  try {
    const first = catalogHarness({ store })
    await first.refresh('codex', 'a2')
    assert.equal(await first.read('a1'), undefined, 'the unrefreshed account has nothing of its own')
    assert.deepEqual((await first.read('a2'))?.map(model => model.id), ['m1', 'm2'])
    await first.drain()

    const reloaded = catalogHarness({ store })
    assert.deepEqual(
      (await reloaded.read('a2'))?.map(model => model.id),
      ['m1', 'm2'],
      'the non-default account catalogue survives a restart',
    )
    assert.equal(
      await reloaded.read('a1'),
      undefined,
      'no other account may be attributed that catalogue',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an account logged out before any read built its cache loses its persisted catalogue', async () => {
  const { dir, store } = await storePath('catalog-unloaded-logout-')
  try {
    // A previous process discovered and persisted this account's catalogue.
    await store('a2').save({ at: Date.now(), models: servedModels() })
    assert.notEqual(await store('a2').load(), undefined)

    // This process logs the account out without ever reading its catalogue, so
    // no cache holds it and only the store can be told to forget it.
    const catalog = catalogHarness({ store })
    catalog.clearAccountCatalog('a2')
    await catalog.drain()

    assert.equal(await store('a2').load(), undefined, 'the durable record outlived the logout')
    assert.equal(await catalogHarness({ store }).read('a2'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('clearing without an account drops every persisted catalogue, loaded or not', async () => {
  const { dir, store } = await storePath('catalog-forget-all-')
  try {
    await store('a1').save({ at: Date.now(), models: servedModels() })
    await store('a2').save({ at: Date.now(), models: servedModels() })
    const catalog = catalogHarness({ store })
    // One account is loaded into a cache, the other is not; both must go.
    assert.deepEqual((await catalog.read('a1'))?.map(model => model.id), ['m1', 'm2'])

    catalog.clearAccountCatalog()
    await catalog.drain()

    assert.equal(await store('a1').load(), undefined)
    assert.equal(await store('a2').load(), undefined, 'an unloaded account kept its record')
    assert.equal(await catalog.read('a1'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('one stored catalogue is announced once, however many callers shared the request', async () => {
  const gate = deferred()
  const announced: string[] = []
  let calls = 0
  const catalog = catalogHarness({
    onCatalogChanged: provider => announced.push(provider),
    fetch: async () => {
      calls += 1
      await gate.promise
      return servedModels()
    },
  })

  const callers = Array.from({ length: 5 }, async () => await catalog.refresh('codex', 'a1'))
  await drain()
  assert.equal(calls, 1, 'the five callers share one request')
  gate.release()
  for (const report of await Promise.all(callers)) assert.deepEqual(report.fetched, ['a1'])
  assert.deepEqual(announced, ['codex'], 'one stored catalogue is one notification')
})

test('a stored catalogue is announced even when its only caller detached', async () => {
  const gate = deferred()
  const announced: string[] = []
  const catalog = catalogHarness({
    onCatalogChanged: provider => announced.push(provider),
    fetch: async () => { await gate.promise; return servedModels() },
  })

  const controller = new AbortController()
  const detaching = catalog.refresh('codex', 'a1', { signal: controller.signal })
  await drain()
  controller.abort()
  assert.deepEqual((await detaching).cancelled, ['a1'])
  // The shared request keeps running, and the catalogue it stores is still
  // announced: the notification belongs to the stored result, not to a waiter.
  gate.release()
  await catalog.drain()
  assert.deepEqual(announced, ['codex'])
  assert.deepEqual((await catalog.read('a1'))?.map(model => model.id), ['m1', 'm2'])
})

test('a capability read refuses an account whose credential was removed elsewhere', async () => {
  const { dir, store } = await storePath('catalog-external-removal-')
  try {
    // The catalogue is on disk and the login is gone: the record describes a
    // plan nothing may serve, so a named account is checked before its cache is.
    await store('a1').save({ at: Date.now(), models: servedModels() })
    const live = new Set<string>(['a1'])
    const catalog = catalogHarness({ store, accounts: ['a1'], sessions: () => [...live] })
    assert.equal((await catalog.findModel('m1', 'a1'))?.name, 'Model 1')

    live.clear()
    assert.equal(await catalog.findModel('m1', 'a1'), undefined, 'a removed credential kept its capabilities')
    assert.deepEqual(
      (await catalog.list('codex', 'a1')).map(model => model.id),
      [],
      'a logged-out account lists nothing',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a disclosed cooldown outlives the process that earned it', async () => {
  const realNow = Date.now
  const { dir, store } = await storePath('catalog-persisted-cooldown-')
  let calls = 0
  const refusing = async (): Promise<readonly DiscoveredModel[]> => {
    calls += 1
    throw new OAuthEndpointError('slow down', 429, undefined, 600_000)
  }
  let now = realNow()
  try {
    Date.now = () => now
    const first = catalogHarness({ store, fetch: refusing })
    assert.deepEqual((await first.refresh('codex', 'a1')).failed, ['a1'])
    assert.equal(calls, 1)
    await first.drain()

    // A fresh instance stands in for a restarted process: it never saw that
    // failure in memory, and the store is the only thing that can tell it.
    now += 5 * 60_000
    const restarted = catalogHarness({ store, fetch: refusing })
    assert.deepEqual((await restarted.refresh('codex', 'a1')).skipped, ['a1'])
    assert.deepEqual((await restarted.refresh('codex', 'a1', { force: true })).skipped, ['a1'])
    assert.equal(calls, 1, 'a restart re-asked a provider that named its own retry instant')

    now += 6 * 60_000
    assert.deepEqual((await restarted.refresh('codex', 'a1', { force: true })).failed, ['a1'])
    assert.equal(calls, 2, 'once the disclosed instant lapses the request may run again')
  } finally {
    Date.now = realNow
    await rm(dir, { recursive: true, force: true })
  }
})

test('a cold failure keeps the cache cold and invents no catalogue', async () => {
  const realNow = Date.now
  const { dir, store } = await storePath('catalog-cold-failure-')
  let calls = 0
  let now = realNow()
  try {
    Date.now = () => now
    // A provider that failed before it ever listed anything: the record must
    // hold the cooldown and nothing that looks like a fetched catalogue.
    const persistence = store('a1')
    assert.ok(persistence.saveFailure !== undefined)
    await persistence.saveFailure({ notBefore: now + 600_000 })

    const file = JSON.parse(await readFile(join(dir, 'models.json'), 'utf8')) as {
      providers: { codex: { accounts: Record<string, Record<string, unknown>> } }
    }
    const entry = file.providers.codex.accounts.a1!
    assert.deepEqual(Object.keys(entry), ['failure'], 'a cold failure must not fabricate at/models')

    const catalog = catalogHarness({
      store,
      fetch: async () => { calls += 1; return servedModels() },
    })
    assert.equal(await catalog.read('a1'), undefined, 'no catalogue was ever stored')
    assert.deepEqual(
      (await catalog.list('codex', 'a1')).map(model => model.id),
      ['m1', 'm2'],
      'the built-in rows stand in for a cold account',
    )
    assert.deepEqual((await catalog.refresh('codex', 'a1')).skipped, ['a1'])
    assert.equal(calls, 0, 'the persisted cooldown held')
    now += 11 * 60_000
    assert.deepEqual((await catalog.refresh('codex', 'a1')).fetched, ['a1'])
  } finally {
    Date.now = realNow
    await rm(dir, { recursive: true, force: true })
  }
})

test('a request that answers clears the persisted cooldown beside its snapshot', async () => {
  const realNow = Date.now
  const { dir, store } = await storePath('catalog-failure-cleared-')
  let fail = true
  let now = realNow()
  try {
    Date.now = () => now
    const catalog = catalogHarness({
      store,
      fetch: async () => {
        if (fail) throw new OAuthEndpointError('slow down', 429, undefined, 600_000)
        return servedModels()
      },
    })
    assert.deepEqual((await catalog.refresh('codex', 'a1')).failed, ['a1'])
    assert.notEqual((await store('a1').load())?.failure, undefined)

    now += 11 * 60_000
    fail = false
    assert.deepEqual((await catalog.refresh('codex', 'a1')).fetched, ['a1'])
    const record = await store('a1').load()
    assert.equal(record?.failure, undefined, 'the answered request left its old cooldown behind')
    assert.deepEqual(record?.snapshot?.models.map(model => model.id), ['m1', 'm2'])
  } finally {
    Date.now = realNow
    await rm(dir, { recursive: true, force: true })
  }
})

test('a cache file written before cooldowns were persisted still loads', async () => {
  const { dir, store } = await storePath('catalog-old-shape-')
  try {
    await writeFile(join(dir, 'models.json'), JSON.stringify({
      version: 2,
      providers: { codex: { accounts: { a1: { at: 1_700_000_000_000, models: [...MODELS] } } } },
    }))
    const catalog = catalogHarness({ store })
    assert.deepEqual((await catalog.read('a1'))?.map(model => model.id), ['m1', 'm2'])
    assert.deepEqual((await catalog.refresh('codex', 'a1', { force: true })).fetched, ['a1'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the mounted pool sweep consults the advisory read and starts no fresh listing behind it', async t => {
  await saveAccountSession('codex', 'account', {
    accessToken: 'token', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000, accountId: 'account', idToken: '',
  })
  const advisoryCalls = { count: 0 }
  const listingCalls = { count: 0 }
  const originalAdvisory = CodexAdapter.prototype.resolveOwnCatalog
  const originalListing = CodexAdapter.prototype.listOwnModels
  CodexAdapter.prototype.resolveOwnCatalog = async () => { advisoryCalls.count += 1; return undefined }
  CodexAdapter.prototype.listOwnModels = async () => { listingCalls.count += 1; return [] }
  t.after(() => {
    CodexAdapter.prototype.resolveOwnCatalog = originalAdvisory
    CodexAdapter.prototype.listOwnModels = originalListing
  })

  const routes = new Map<string, AccountPreferencesAdapter>()
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('llm', {
    registerAdapter: (providers: string[], adapter: AccountPreferencesAdapter) => {
      for (const provider of providers) routes.set(provider, adapter)
      return Object.assign(() => {}, { replace: () => {} })
    },
  })
  ctx.provide('connection', createFakeConnection().connection)
  ctx.plugin(plugin, { providers: ['codex'], pool: { enabled: true, autoAccounts: true } })
  await new Promise(resolve => setTimeout(resolve, 50))
  const route = routes.get('codex')
  assert.ok(route !== undefined, 'the codex route was registered')

  // A selection reads the pool's membership, which is the mounted `families`.
  await route.resolveModel('codex', 'gpt-5.1-codex').catch(() => undefined)

  assert.ok(advisoryCalls.count > 0, 'the sweep never consulted the advisory read')
  assert.equal(listingCalls.count, 0, 'the sweep started a fresh listing behind the advisory read')
})
