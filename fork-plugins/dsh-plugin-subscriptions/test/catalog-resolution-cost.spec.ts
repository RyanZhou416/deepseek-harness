/**
 * Work-count and barrier regressions for what resolving a subscription model
 * costs through the registered `AccountPreferencesAdapter` route:
 *
 * - a capability question answers from a catalog that is known but stale, the
 *   way `ModelCatalogCache.resolve` promises, instead of awaiting its refresh;
 * - one provider's pool read fetches that provider's catalogs only;
 * - the mounted plugin's own wiring picks the advisory read, never a second
 *   attempt behind it.
 *
 * All are stated as deterministic work counts and barriers, never as elapsed
 * time: the catalog request is a counted stand-in the test releases explicitly,
 * so no assertion can pass or fail on scheduler luck.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountPreferencesAdapter } from '../src/providers/account-preferences.js'
import { PoolBackedAdapter } from '../src/providers/pool-delegation.js'
import { ProviderCatalog } from '../src/providers/provider-catalog.js'
import { PoolAdapter } from '../src/providers/pool.js'
import { PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import { resolvePoolScheduling } from '../src/providers/pool-scheduling.js'
import { buildAccountPools, poolKey } from '../src/providers/pool-family.js'
import type { PoolDefinition, PoolMemberRef } from '../src/providers/pool-family.js'
import { DISCOVERY_TIMEOUT_MS, withTimeout } from '../src/providers/common.js'
import type { CatalogPersistence, CatalogSnapshot, DiscoveredModel } from '../src/providers/common.js'
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

/** `ModelCatalogCache`'s refresh window (common.ts `DISCOVERY_TTL_MS`), private to the module. */
const DISCOVERY_TTL_MS = 5 * 60_000

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
   * How the auto-account sweep reads one account's catalog. `swr` is the
   * plugin's read (last-known answers, a fetch only when nothing is known);
   * `blocking` is the read that awaited every refresh, kept as the negative
   * control for the sweep's cost.
   */
  sweep?: 'swr' | 'blocking'
  /** Configured extra picker entries, by pool id. */
  tiers?: Record<string, PoolMemberRef[]>
}

interface Fixture {
  route(provider: ProviderId): AccountPreferencesAdapter
  pool: PoolAdapter
  /** Catalog requests issued for one provider so far. */
  fetches(provider: ProviderId): number
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
          : { catalogStore: persistedCatalog(this.options.persistedAgeMs) },
      },
      providerId,
      {
        staticRows: provider => MODELS.map(model => ({ provider, id: model.id, name: model.name })),
        fetchCatalog: (account) => this.options.fetch(this.providerId, account ?? '<default>'),
        row: (provider, model): LlmModelInfo => ({ provider, id: model.id, name: model.name }),
      },
    )
  }

  /** Mirrors a concrete adapter's discovered-catalog capability lookup. */
  async resolveOwnModel(provider: string, model: string, account?: string): Promise<LlmResolvedModelInfo> {
    const keys = account === undefined ? this.store.keys(this.providerId) : [account]
    for (const key of keys) {
      const catalog = await this.catalogs.cache(key)
      const models = await catalog.resolve(() => this.options.fetch(this.providerId, key))
      const found = models?.find(entry => entry.id === model)
      if (found !== undefined) return { provider, id: model, name: found.name }
    }
    return { provider, id: model, name: model }
  }

  clearAccountCatalog(account?: string): void {
    this.catalogs.invalidate(account)
  }

  protected async *streamOwn(): AsyncIterable<StreamChunk> {
    throw new LlmError('the fixture does not stream', 'NO_ADAPTER')
  }
}

/** A snapshot of the given age, as `models.json` leaves one behind. */
function persistedCatalog(ageMs: number): CatalogPersistence {
  const snapshot: CatalogSnapshot = { at: Date.now() - ageMs, models: [...MODELS] }
  return { load: async () => snapshot, save: async () => undefined, clear: async () => undefined }
}

/**
 * Compose the production wiring: one registered route per provider over its own
 * account catalogs, the pool built over those routes' member seams, and the
 * account sweep the plugin passes as `families`.
 */
async function compose(options: ComposeOptions): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-resolution-cost-'))
  const counts = new Map<ProviderId, number>()
  const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
  const concrete = new Map<ProviderId, CatalogAdapter>()
  const routes = new Map<ProviderId, AccountPreferencesAdapter>()
  const members: Partial<Record<ProviderId, ReturnType<AccountPreferencesAdapter['poolMember']>>> = {}
  let pool!: PoolAdapter
  let sweeps = 0

  const counted: ComposeOptions = {
    ...options,
    fetch: async (provider, account) => {
      counts.set(provider, (counts.get(provider) ?? 0) + 1)
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
        const listed = await withTimeout(
          async signal => options.sweep === 'blocking'
            ? await adapter.listOwnModels(key, account, signal)
            : await adapter.resolveOwnCatalog?.(key, account, signal)
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
    switchMargin: 2,
    scheduling: resolvePoolScheduling(),
    defaultAccount: async provider => options.store.keys(provider)[0],
    families,
    tiers: options.tiers ?? {},
    onWarn: () => undefined,
  })

  return {
    route: provider => routes.get(provider)!,
    pool,
    fetches: provider => counts.get(provider) ?? 0,
    sweeps: () => sweeps,
    dispose: async () => { await rm(dir, { recursive: true, force: true }) },
  }
}

/** One provider's account pool, exactly as `buildAccountPools` would key it. */
function ownPool(provider: ProviderId, account: string, model: string): Map<string, PoolDefinition> {
  return new Map([[poolKey(provider, model), { members: [{ provider, account, model }] }]])
}

test('capability resolution answers from a stale catalog instead of awaiting its refresh', async t => {
  const gate = deferred()
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a'] }),
    persistedAgeMs: DISCOVERY_TTL_MS + 60_000,
    families: () => ownPool('codex', 'a', 'm1'),
    fetch: async () => { await gate.promise; return servedModels() },
  })
  t.after(async () => { gate.release(); await fixture.dispose() })

  let settled = false
  const resolution = fixture.route('codex').resolveModel('codex', 'm1').then(
    () => { settled = true },
    () => { settled = true },
  )
  await drain()
  assert.equal(settled, true, 'resolveModel awaited the refresh of a known catalog')

  // The refresh is deferred, not dropped: releasing it settles the resolution,
  // and the one catalog request it scheduled is the only one.
  gate.release()
  await resolution
  assert.equal(fixture.fetches('codex'), 1)
})

test('capability resolution still awaits the one fetch when nothing is known', async t => {
  const gate = deferred()
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a'] }),
    families: () => ownPool('codex', 'a', 'm1'),
    fetch: async () => { await gate.promise; return servedModels() },
  })
  t.after(async () => { gate.release(); await fixture.dispose() })

  let settled = false
  const resolution = fixture.route('codex').resolveModel('codex', 'm1').then(
    () => { settled = true },
    () => { settled = true },
  )
  await drain()
  assert.equal(settled, false, 'a cold catalog must await its fetch before answering')

  gate.release()
  await resolution
  assert.equal(settled, true)
})

test('pool assembly fetches only the provider the caller names', async t => {
  const fixture = await compose({
    providers: ['codex', 'claude'],
    store: accountStore({ codex: ['a1', 'a2'], claude: ['a1', 'a2'] }),
    fetch: async () => servedModels(),
  })
  t.after(async () => { await fixture.dispose() })

  assert.equal(await fixture.pool.owns('codex', 'm1'), true)
  assert.equal(fixture.fetches('claude'), 0, "the codex pool read fetched claude's catalog")
  assert.equal(fixture.fetches('codex'), 2, "the codex pool read still lists codex's own accounts")
})

test('listing one provider fetches only that provider', async t => {
  const fixture = await compose({
    providers: ['codex', 'claude'],
    store: accountStore({ codex: ['a1', 'a2'], claude: ['a1', 'a2'] }),
    fetch: async () => servedModels(),
  })
  t.after(async () => { await fixture.dispose() })

  const listed = await fixture.route('codex').listModels('codex')
  assert.deepEqual(listed.map(model => model.id), ['m1', 'm2'])
  assert.equal(fixture.fetches('claude'), 0, "the codex list fetched claude's catalog")
  assert.equal(fixture.fetches('codex'), 2)
})

test('resolving one provider fetches only that provider', async t => {
  const fixture = await compose({
    providers: ['codex', 'claude'],
    store: accountStore({ codex: ['a1', 'a2'], claude: ['a1', 'a2'] }),
    fetch: async () => servedModels(),
  })
  t.after(async () => { await fixture.dispose() })

  assert.equal((await fixture.route('codex').resolveModel('codex', 'm1')).id, 'm1')
  assert.equal(fixture.fetches('claude'), 0, "the codex resolution fetched claude's catalog")
  assert.ok(fixture.fetches('codex') > 0)
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
    persistedAgeMs: DISCOVERY_TTL_MS + 60_000,
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

test('extra tier rows are configuration: listing them neither sweeps nor retries a failed listing', async t => {
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a1', 'a2'] }),
    tiers: { smart: [{ provider: 'codex', account: 'a1', model: 'm1' }] },
    // Every catalog request fails, which is what a timed-out discovery leaves
    // behind: nothing cached and nothing in flight.
    fetch: async () => { throw new LlmError('catalog unavailable', 'TRANSPORT') },
  })
  t.after(async () => { await fixture.dispose() })

  await fixture.route('codex').listModels('codex')
  const afterListing = fixture.fetches('codex')
  const sweepsAfterListing = fixture.sweeps()
  assert.ok(afterListing > 0, 'the listing itself must have attempted the account catalogs')

  assert.deepEqual((await fixture.pool.modelsForProvider('codex')).map(model => model.id), ['smart'])
  assert.equal(fixture.sweeps(), sweepsAfterListing, 'listing extra rows swept the account catalogs')
  assert.equal(fixture.fetches('codex'), afterListing, 'the extra-row read retried the failed listing')
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

test('a cold pool snapshot reads membership without waiting on a stale refresh', async t => {
  const gate = deferred()
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a'] }),
    persistedAgeMs: DISCOVERY_TTL_MS + 60_000,
    sweep: 'swr',
    fetch: async () => { await gate.promise; return servedModels() },
  })
  t.after(async () => { gate.release(); await fixture.dispose() })

  let settled = false
  const resolution = fixture.route('codex').resolveModel('codex', 'm1').then(
    () => { settled = true },
    () => { settled = true },
  )
  await drain()
  assert.equal(settled, true, 'a cold pool snapshot waited on the membership refresh')
  gate.release()
  await resolution
})

test('the same cold membership read blocks when the sweep awaits the refresh', async t => {
  // Negative control: the pair proves the sweep's own read, not the pool cache,
  // is what the previous case removes.
  const gate = deferred()
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a'] }),
    persistedAgeMs: DISCOVERY_TTL_MS + 60_000,
    sweep: 'blocking',
    fetch: async () => { await gate.promise; return servedModels() },
  })
  t.after(async () => { gate.release(); await fixture.dispose() })

  let settled = false
  const resolution = fixture.route('codex').resolveModel('codex', 'm1').then(
    () => { settled = true },
    () => { settled = true },
  )
  await drain()
  assert.equal(settled, false, 'the blocking sweep must await the membership refresh')
  gate.release()
  await resolution
})

test('a request still validates its member freshly', async t => {
  const gate = deferred()
  const fixture = await compose({
    providers: ['codex'],
    store: accountStore({ codex: ['a'] }),
    persistedAgeMs: DISCOVERY_TTL_MS + 60_000,
    sweep: 'swr',
    fetch: async () => { await gate.promise; return servedModels() },
  })
  t.after(async () => { gate.release(); await fixture.dispose() })

  let settled = false
  const streaming = (async () => {
    for await (const _chunk of fixture.route('codex').stream({ provider: 'codex', model: 'm1', messages: [] })) {
      // the fixture adapter never yields
    }
  })().then(() => { settled = true }, () => { settled = true })
  await drain()
  assert.equal(settled, false, 'a request must not send against a catalog it cannot confirm')
  gate.release()
  await streaming
})

test('an advisory read that cannot answer leaves the stored login as the only fallback', async () => {
  // `list` reports a login that vanished during discovery as no rows, and the
  // advisory read must not answer with the static catalogue instead.
  let sessions = 1
  const catalog = new ProviderCatalog(
    {
      tokens: {
        list: async () => [{ key: 'a' }],
        session: async () => { throw new LlmError('login expired or was revoked', 'MISSING_CREDENTIAL') },
        hasSession: async () => sessions > 0,
        defaultAccount: async () => 'a',
      },
      discovery: true,
    },
    'codex',
    {
      staticRows: provider => MODELS.map(model => ({ provider, id: model.id, name: model.name })),
      fetchCatalog: async () => {
        // The permanent refresh failure deletes the stored session mid-fetch.
        sessions = 0
        throw new LlmError('login expired or was revoked', 'MISSING_CREDENTIAL')
      },
      row: (provider, model): LlmModelInfo => ({ provider, id: model.id, name: model.name }),
    },
  )

  assert.deepEqual(await catalog.resolve('codex', 'a'), [])
  assert.deepEqual(await catalog.list('codex', 'a'), [])
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
