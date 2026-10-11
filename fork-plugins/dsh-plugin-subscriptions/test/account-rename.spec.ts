/**
 * The identity-rename follow-through: when the token store renames one Codex
 * account's canonical key during a save, every account-keyed owner moves that
 * account's own state to the new key instead of losing it.
 *
 * Each case pins the property a rename must not break: the catalogue's cached
 * snapshot and its failure cooldown, the usage reading and its endpoint
 * cooldown, a parked account staying parked, the captured rate-limit report and
 * the account's own policy (pool membership, allowlist, independent entry).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { accountKeyOf, saveAccountSession } from '../src/auth/store.js'
import type { CodexSession } from '../src/auth/store.js'
import { AccountPreferencesAdapter, accountAllowsPool, accountModelId } from '../src/providers/account-preferences.js'
import { reconcileStoredCodexAliases, storedCodexAliases } from '../src/providers/cache-identities.js'
import { ProviderSettingsStore } from '../src/provider-settings.js'
import { ProviderCatalog } from '../src/providers/provider-catalog.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import { accountKey, memberKey, PoolHealthRegistry } from '../src/providers/pool-health.js'
import {
  forgetUnifiedRateLimit,
  rememberUnifiedRateLimit,
  renameUnifiedRateLimit,
  unifiedRateLimitFor,
} from '../src/providers/unified-rate-limit.js'
import type { UnifiedRateLimitState } from '../src/providers/unified-rate-limit.js'
import type { AccountAwareAdapter } from '../src/providers/accounts.js'
import type { CatalogRecord, CatalogStoreFactory, DiscoveredModel, ProviderUsage } from '../src/providers/common.js'
import type { PersistedUsageAccount, UsageStore } from '../src/providers/usage-store.js'

/** A discovered entry the catalogue cases can store and compare. */
function model(id: string, name = id): DiscoveredModel {
  return { id, name }
}

/** A usage payload with one session window. */
function usage(usedPercent: number): ProviderUsage {
  return { supported: true, windows: [{ kind: 'session', usedPercent }] }
}

/** The catalogue owner over an in-memory durable store. */
function catalogHarness(options: { failures?: boolean } = {}) {
  const records = new Map<string, CatalogRecord>()
  const fetches: string[] = []
  let fetch: () => Promise<DiscoveredModel[]> = async () => []
  const factory: CatalogStoreFactory = account => ({
    load: async () => records.get(account),
    save: async snapshot => { records.set(account, { snapshot }) },
    ...options.failures === false ? {} : {
      saveFailure: async (failure: { notBefore: number }) => {
        records.set(account, { ...records.get(account), failure })
      },
    },
    clear: async () => { records.delete(account) },
  })
  const catalogs = new ProviderCatalog({
    tokens: {
      list: async () => [{ key: 'legacy' }],
      session: async () => ({}),
      hasSession: async () => true,
      defaultAccount: async () => 'legacy',
    },
    catalogStore: factory,
    discovery: true,
  }, 'codex', 'codex', {
    staticRows: () => [],
    fetchCatalog: async (account) => {
      fetches.push(account)
      return await fetch()
    },
    row: (provider, entry) => ({ provider, id: entry.id, name: entry.name }),
  })
  return {
    catalogs,
    records,
    fetches,
    answer: (next: () => Promise<DiscoveredModel[]>) => { fetch = next },
  }
}

test('catalogue rename keeps the newer snapshot and the later cooldown under the new key', async () => {
  const harness = catalogHarness()
  harness.records.set('legacy', { snapshot: { at: 500, models: [model('m1')] }, failure: { notBefore: 1_000 } })
  harness.records.set('canonical', { snapshot: { at: 400, models: [model('old')] }, failure: { notBefore: 9_000 } })
  await harness.catalogs.renameAccount('legacy', 'canonical')
  const moved = harness.records.get('canonical')
  assert.deepEqual(moved?.snapshot?.models.map(entry => entry.id), ['m1'], 'the newer snapshot wins')
  assert.equal(moved?.failure?.notBefore, 9_000, 'the later cooldown is kept')
  assert.equal(harness.records.has('legacy'), false, 'the retired key holds nothing')
})

test('an in-memory catalogue cooldown survives the rename', async () => {
  // No durable failure half: the cooldown exists only in the moved cache, so
  // this fails if the rename builds a fresh cache for the new key instead.
  const harness = catalogHarness({ failures: false })
  let calls = 0
  harness.answer(async () => {
    calls += 1
    throw new Error('catalogue endpoint refused')
  })
  assert.deepEqual(await harness.catalogs.refresh('codex', 'legacy'),
    { fetched: [], skipped: [], failed: ['legacy'], cancelled: [] })
  assert.equal(calls, 1)
  await harness.catalogs.renameAccount('legacy', 'canonical')
  assert.deepEqual(
    await harness.catalogs.refresh('codex', 'canonical'),
    { fetched: [], skipped: ['canonical'], failed: [], cancelled: [] },
    'the moved cache answered from its cooldown instead of fetching',
  )
  assert.equal(calls, 1, 'the cooling account is not asked again under the new key')
})

test('renaming does not wait on an in-flight request, and that request lands under the new key', async () => {
  const harness = catalogHarness()
  const pending = Promise.withResolvers<DiscoveredModel[]>()
  harness.answer(() => pending.promise)
  const running = harness.catalogs.refresh('codex', 'legacy')
  // The hook runs inside the save this very request is waiting for: awaiting the
  // cache here would deadlock, so the rename must resolve while the fetch is out.
  await harness.catalogs.renameAccount('legacy', 'canonical')
  pending.resolve([model('m-late')])
  await running
  assert.deepEqual(harness.records.get('canonical')?.snapshot?.models.map(entry => entry.id), ['m-late'])
  assert.equal(harness.records.has('legacy'), false, 'no write landed under the retired key')
  assert.deepEqual(harness.fetches, ['legacy'], 'the request already running was not restarted')
})

/** A usage tracker over an in-memory durable store, with an injectable clock. */
function usageHarness(options: { freshMs?: number; retryDelayMs?: number } = {}) {
  const saved: { provider: string; account: string }[] = []
  const removed: { provider: string; account: string }[] = []
  let calls = 0
  let next: () => Promise<ProviderUsage> = async () => usage(10)
  const clock = { now: 1_000_000 }
  const store: UsageStore = {
    records: () => [] as readonly PersistedUsageAccount[],
    save: record => { saved.push({ provider: record.provider, account: record.account }) },
    remove: (provider, account) => { removed.push({ provider, account }) },
    flush: async () => {},
    dispose: async () => {},
  }
  const tracker = new PoolUsageTracker(() => () => {
    calls += 1
    return next()
  }, {
    freshMs: options.freshMs ?? 1_000,
    retryDelayMs: options.retryDelayMs ?? 60_000,
    store,
    now: () => clock.now,
  })
  return {
    tracker,
    clock,
    saved,
    removed,
    calls: () => calls,
    answer: (fetcher: () => Promise<ProviderUsage>) => { next = fetcher },
  }
}

test('usage rename keeps the reading and the endpoint cooldown, and the old key resolves to it', async () => {
  const harness = usageHarness()
  harness.tracker.observe('claude', 'legacy', { windows: [{ kind: 'session', usedPercent: 42 }] })
  harness.tracker.renameAccount('claude', 'legacy', 'canonical')
  assert.equal(harness.tracker.quotaFor({ provider: 'claude', account: 'canonical' }).windows?.[0].usedPercent, 42)
  assert.equal(harness.tracker.quotaFor({ provider: 'claude', account: 'legacy' }).windows?.[0].usedPercent, 42,
    'a query naming the retired key reaches the same reading')
  assert.equal(harness.tracker.quotaFor({ provider: 'claude', account: 'legacy' }).observation, 'observed')
  assert.deepEqual(harness.saved.at(-1), { provider: 'claude', account: 'canonical' },
    'the retained reading is written under the new key')
  assert.deepEqual(harness.removed, [{ provider: 'claude', account: 'legacy' }], 'the retired key is dropped once')
})

test('a failure cooldown survives the usage rename and is not re-asked', async () => {
  const harness = usageHarness()
  harness.answer(async () => { throw new Error('usage endpoint refused') })
  await harness.tracker.ensureForUse({ provider: 'claude', account: 'legacy' })
  assert.equal(harness.calls(), 1)
  harness.tracker.renameAccount('claude', 'legacy', 'canonical')
  const held = harness.tracker.snapshotFor('claude', 'canonical')
  assert.equal(held.cache?.state, 'error')
  assert.equal(held.cache?.retryAt, harness.clock.now + 60_000, 'the cooldown moved with the account')
  await harness.tracker.ensureForUse({ provider: 'claude', account: 'canonical' })
  assert.equal(harness.calls(), 1, 'the cooling endpoint is not asked again under the new key')
})

test('a usage read of the retired key cannot land after the rename', async () => {
  const harness = usageHarness()
  harness.tracker.observe('claude', 'legacy', { windows: [{ kind: 'session', usedPercent: 10 }] })
  harness.clock.now += 5_000
  const pending = Promise.withResolvers<ProviderUsage>()
  harness.answer(() => pending.promise)
  const running = harness.tracker.ensureForUse({ provider: 'claude', account: 'legacy' })
  assert.equal(harness.calls(), 1, 'the stale reading started a read')
  const writesBefore = harness.saved.length
  harness.tracker.renameAccount('claude', 'legacy', 'canonical')
  pending.resolve(usage(96))
  await running
  assert.equal(harness.tracker.quotaFor({ provider: 'claude', account: 'legacy' }).windows?.[0].usedPercent, 10,
    'the superseded reading did not land')
  assert.deepEqual(harness.saved.slice(writesBefore), [{ provider: 'claude', account: 'canonical' }],
    'nothing was written back under the retired key')
})

test('a usage collision merges per window, keeping each lane its own statement', () => {
  const harness = usageHarness()
  const base = harness.clock.now
  harness.tracker.observe('claude', 'legacy', { windows: [{ kind: 'weekly', usedPercent: 30 }], observedAt: base })
  harness.tracker.observe('claude', 'canonical', {
    windows: [{ kind: 'session', usedPercent: 10 }],
    observedAt: base + 5,
  })
  harness.tracker.renameAccount('claude', 'legacy', 'canonical')
  const windows = harness.tracker.quotaFor({ provider: 'claude', account: 'canonical' }).windows ?? []
  const byKind = new Map(windows.map(window => [window.kind, window.usedPercent]))
  assert.equal(byKind.get('session'), 10, "the newer record's own lane survives")
  assert.equal(byKind.get('weekly'), 30, "the other record's lane survives too")
})

test('a parked account stays parked after the health rename', () => {
  const health = new PoolHealthRegistry()
  health.markUnavailable(memberKey('claude', 'legacy', 'm'), 60_000, 'RATE_LIMIT')
  health.markUnavailable(accountKey('claude', 'legacy'), 120_000, 'AUTH')
  health.renameAccount('claude', 'legacy', 'canonical')
  assert.equal(health.isMemberAvailable('claude', 'canonical', 'm'), false, 'the member stays parked')
  assert.equal(health.accountCooling('claude', 'canonical')?.reason, 'AUTH', 'the account-wide record moved')
})

test('a health rename collision keeps whichever cooldown runs longer', () => {
  const now = Date.now()
  const destinationLonger = new PoolHealthRegistry()
  destinationLonger.markUnavailable(memberKey('claude', 'canonical', 'm'), 120_000, 'AUTH', now)
  destinationLonger.markUnavailable(memberKey('claude', 'legacy', 'm'), 30_000, 'RATE_LIMIT', now)
  destinationLonger.renameAccount('claude', 'legacy', 'canonical')
  assert.equal(destinationLonger.accountCooling('claude', 'canonical', now)?.reason, 'AUTH',
    'a shorter incoming cooldown does not replace the destination')
  const sourceLonger = new PoolHealthRegistry()
  sourceLonger.markUnavailable(memberKey('claude', 'canonical', 'm'), 30_000, 'RATE_LIMIT', now)
  sourceLonger.markUnavailable(memberKey('claude', 'legacy', 'm'), 120_000, 'QUOTA_EXCEEDED', now)
  sourceLonger.renameAccount('claude', 'legacy', 'canonical')
  assert.equal(sourceLonger.accountCooling('claude', 'canonical', now)?.reason, 'QUOTA_EXCEEDED',
    'a longer incoming cooldown replaces the destination')
})

test('the captured rate-limit report follows the rename, and the new key wins a collision', () => {
  forgetUnifiedRateLimit()
  const report: UnifiedRateLimitState = { status: 'rejected', windows: [], observedAt: 10 }
  const held: UnifiedRateLimitState = { status: 'allowed_warning', windows: [], observedAt: 20 }
  rememberUnifiedRateLimit('claude', 'legacy', report)
  renameUnifiedRateLimit('claude', 'legacy', 'canonical')
  assert.equal(unifiedRateLimitFor('claude', 'canonical'), report)
  assert.equal(unifiedRateLimitFor('claude', 'legacy'), undefined)
  rememberUnifiedRateLimit('claude', 'legacy', report)
  rememberUnifiedRateLimit('claude', 'canonical', held)
  renameUnifiedRateLimit('claude', 'legacy', 'canonical')
  assert.equal(unifiedRateLimitFor('claude', 'canonical'), held, 'a report already held under the new key wins')
  forgetUnifiedRateLimit()
})

test('account policy moves whole, and an entry written under the new key wins field by field', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-rename-'))
  try {
    const store = new ProviderSettingsStore(join(dir, 'settings.json'))
    await store.set('codex', {
      accounts: { legacy: { alias: 'Work', poolEnabled: false, independentEntry: true, poolModels: [] } },
    })
    await store.renameAccount('codex', 'legacy', 'canonical')
    const moved = store.get('codex').accounts
    assert.deepEqual(moved?.canonical, { alias: 'Work', poolEnabled: false, independentEntry: true, poolModels: [] })
    assert.equal(Object.hasOwn(moved ?? {}, 'legacy'), false)
    assert.equal(accountAllowsPool(moved?.canonical, 'm'), false, 'the allowlist did not revert to permissive')

    await store.set('codex', {
      accounts: { legacy: { alias: 'Work', poolEnabled: false }, canonical: { independentEntry: true } },
    })
    await store.renameAccount('codex', 'legacy', 'canonical')
    assert.deepEqual(store.get('codex').accounts?.canonical, {
      independentEntry: true, alias: 'Work', poolEnabled: false,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a rename edits the queued state, so a save already queued is not overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-rename-queue-'))
  try {
    const store = new ProviderSettingsStore(join(dir, 'settings.json'))
    await store.set('codex', { accounts: { legacy: { poolEnabled: false } } })
    // Both are in flight: the rename must edit the state the queued save leaves
    // behind, not the snapshot taken before it landed.
    const queued = store.set('codex', {
      accounts: { legacy: { poolEnabled: false }, other: { independentEntry: true } },
    })
    const rename = store.renameAccount('codex', 'legacy', 'canonical')
    await Promise.all([queued, rename])
    const accounts = store.get('codex').accounts
    assert.deepEqual(accounts?.canonical, { poolEnabled: false })
    assert.deepEqual(accounts?.other, { independentEntry: true }, 'the queued save survived the rename')
    assert.equal(Object.hasOwn(accounts ?? {}, 'legacy'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed policy move still serves the same policy under the canonical key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-rename-failed-'))
  try {
    const path = join(dir, 'settings.json')
    const store = new ProviderSettingsStore(path)
    await store.set('codex', {
      accounts: { legacy: { poolEnabled: false, independentEntry: true, poolModels: [] } },
    })
    // Block the write half only: replacing the file with a directory makes the
    // atomic rename fail, while reads still see the policy that was stored.
    await rm(path, { force: true })
    await mkdir(path)
    await assert.rejects(store.renameAccount('codex', 'legacy', 'canonical'))
    const accounts = store.get('codex').accounts
    assert.deepEqual(accounts?.canonical, { poolEnabled: false, independentEntry: true, poolModels: [] },
      'the canonical key still reads the stored policy')
    assert.equal(Object.hasOwn(accounts ?? {}, 'legacy'), false, 'the retired key is not projected')
    assert.equal(accountAllowsPool(accounts?.canonical, 'm'), false, 'the allowlist still excludes the model')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** A raw route that records the account every independent-entry call addresses. */
class Raw extends LlmAdapter {
  readonly calls: string[] = []
  async listOwnModels(provider: string) { return [{ provider, id: 'm', name: 'Model' }] }
  async resolveOwnModel(provider: string, model: string, account?: string) {
    this.calls.push(`resolve:${account}:${model}`)
    return { provider, id: model, name: 'Model', context: { contextWindow: 100 } }
  }
  clearAccountCatalog() {}
  async *stream(): AsyncIterable<StreamChunk> { throw new Error('default path forbidden') }
  async *streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    this.calls.push(`stream:${account}:${options.model}`)
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('an independent entry selected before the rename keeps resolving through the store alias', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-rename-id-'))
  try {
    const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
    const raw = new Raw()
    const route = new AccountPreferencesAdapter({
      provider: 'codex',
      adapter: raw,
      settings,
      accounts: async () => [{ key: 'canonical', label: 'Canonical' }],
      pool: () => undefined,
      resolveAccount: async account => account === 'legacy' ? 'canonical' : account,
      onWarn: () => {},
    })
    await settings.set('codex', { accounts: { canonical: { alias: 'Work', independentEntry: true } } })
    const id = accountModelId('legacy', 'm')
    const resolved = await route.resolveModel('codex', id)
    assert.equal(resolved.name, 'Work · Model', 'the resolved key supplies the label')
    assert.deepEqual(raw.calls, ['resolve:canonical:m'])
    for await (const _chunk of route.stream({ provider: 'codex', model: id } as GenerateOptions)) { /* drain */ }
    assert.deepEqual(raw.calls, ['resolve:canonical:m', 'stream:canonical:m'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** A stored Codex session with no identity claims: the store keys it by workspace. */
const STORE_CODEX: CodexSession = {
  accessToken: 'codex-at',
  refreshToken: 'codex-rt',
  expiresAt: Date.now() + 3_600_000,
  accountId: 'acct-1',
}

/** The same workspace account once its id token carries the stable user id. */
function codexUser(user: string): CodexSession {
  const payload = { 'https://api.openai.com/auth': { chatgpt_user_id: user } }
  return { ...STORE_CODEX, idToken: 'header.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.signature' }
}

/**
 * Store an account under its email-fallback key, then save the same account with
 * its user-id claim — the store rekeys it and records the alias, exactly as a
 * token refresh does.
 */
async function storeRenamedCodexAccount(path: string): Promise<{ from: string; to: string }> {
  const emailSession = { ...STORE_CODEX, emailAddress: 'alice@example.com', accessToken: 'old' }
  const from = accountKeyOf('codex', emailSession)
  await saveAccountSession('codex', from, emailSession, path)
  const userSession = { ...codexUser('alice-user'), emailAddress: 'alice@example.com', accessToken: 'fresh' }
  const to = accountKeyOf('codex', userSession)
  await saveAccountSession('codex', from, userSession, path)
  return { from, to }
}

test('a stored Codex rename is reconciled at load, with no provider call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-rename-load-'))
  const realFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = (() => { fetches += 1; return Promise.reject(new Error('no provider request expected')) }) as typeof fetch
  try {
    const path = join(dir, 'auth.json')
    const { from, to } = await storeRenamedCodexAccount(path)
    assert.deepEqual(await storedCodexAliases(path), [{ from, to }],
      'the pair comes from the store alias record, never from a guessed identity')
    const moved: string[] = []
    const warnings: string[] = []
    await reconcileStoredCodexAliases({
      move: async (provider, oldKey, newKey) => { moved.push(`${provider}:${oldKey}->${newKey}`) },
      onWarn: message => { warnings.push(message) },
      path,
    })
    assert.deepEqual(moved, [`codex:${from}->${to}`])
    assert.deepEqual(warnings, [])
    assert.equal(fetches, 0, 'reconciliation reads the auth store only')
  } finally {
    globalThis.fetch = realFetch
    await rm(dir, { recursive: true, force: true })
  }
})

test('only recorded aliases whose target account still exists are applied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-rename-alias-'))
  try {
    const path = join(dir, 'auth.json')
    writeFileSync(path, JSON.stringify({
      codex: {
        default: 'acct-1',
        accounts: { 'acct-1': STORE_CODEX },
        aliases: { gone: 'acct-2', same: 'acct-1', 'acct-1': 'acct-1' },
      },
    }))
    assert.deepEqual(await storedCodexAliases(path), [{ from: 'same', to: 'acct-1' }],
      'a missing target and a self-alias are not renames')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unreadable auth store is reported and left exactly as it was', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-rename-corrupt-'))
  try {
    const path = join(dir, 'auth.json')
    writeFileSync(path, 'not json')
    await assert.rejects(storedCodexAliases(path), 'the store read stays loud')
    const warnings: string[] = []
    await reconcileStoredCodexAliases({
      move: async () => { throw new Error('no move may run') },
      onWarn: message => { warnings.push(message) },
      path,
    })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /auth store could not be read/)
    assert.equal(readFileSync(path, 'utf8'), 'not json', 'nothing was rewritten or wiped')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the readiness gate runs before the first policy read and never inside the pool-member seam', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-rename-ready-'))
  try {
    const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
    const raw = new Raw()
    let ready = false
    const events: string[] = []
    const route = new AccountPreferencesAdapter({
      provider: 'codex',
      adapter: raw,
      settings,
      accounts: async () => {
        events.push(`accounts ready=${String(ready)}`)
        return [{ key: 'canonical', label: 'Canonical' }]
      },
      pool: () => undefined,
      beforeRead: async () => { events.push('gate'); ready = true },
      onWarn: () => {},
    })
    await route.listModels('codex')
    assert.deepEqual(events.slice(0, 2), ['gate', 'accounts ready=true'],
      'no account policy is read before the one-time reconciliation')

    // The pool-member seam is reached only from inside a stream that already
    // passed the gate; awaiting it there would deadlock the migration.
    const blocked = Promise.withResolvers<void>()
    const gated = new AccountPreferencesAdapter({
      provider: 'codex',
      adapter: raw,
      settings,
      accounts: async () => [{ key: 'canonical', label: 'Canonical' }],
      pool: () => undefined,
      beforeRead: () => blocked.promise,
      onWarn: () => {},
    })
    let guard: ReturnType<typeof setTimeout> | undefined
    try {
      const resolved = await Promise.race([
        gated.poolMember().resolveOwnModel('codex', 'm', 'canonical'),
        new Promise<never>((_, reject) => {
          guard = setTimeout(() => { reject(new Error('the pool-member seam awaited the readiness gate')) }, 500)
        }),
      ])
      assert.equal(resolved.id, 'm')
    } finally {
      clearTimeout(guard)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
