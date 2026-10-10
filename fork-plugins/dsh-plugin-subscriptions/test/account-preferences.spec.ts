import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountPreferencesAdapter, accountModelId, parseAccountModelId, accountAllowsPool } from '../src/providers/account-preferences.js'
import { ProviderSettingsStore, validatePreferences } from '../src/provider-settings.js'
import { PoolAdapter } from '../src/providers/pool.js'
import { resolvePoolScheduling } from '../src/providers/pool-scheduling.js'
import { accountKey, PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import type { AccountAwareAdapter } from '../src/providers/accounts.js'
import type { ProviderUsage } from '../src/providers/common.js'
import type { ProviderId } from '../src/auth/store.js'

class Raw extends LlmAdapter {
  calls: string[] = []
  failAccount?: string
  async listOwnModels(provider: string, account?: string) { return [{ provider, id: 'm:/模型', name: 'Model' }, ...(account === 'b' ? [{ provider, id: 'exclusive', name: 'Exclusive' }] : [])] }
  async resolveOwnModel(provider: string, model: string, account?: string) { this.calls.push(`resolve:${account}:${model}`); return { provider, id: model, name: 'Model', context: { contextWindow: account === 'b' ? 200 : 100 } } }
  clearAccountCatalog() {}
  async *stream(): AsyncIterable<StreamChunk> { throw new Error('default path forbidden') }
  async *streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> { this.calls.push(`stream:${account}:${options.model}`); if (this.failAccount === account) throw new LlmError('quota exhausted', 'RATE_LIMIT'); yield { type: 'text-delta', index: 0, text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } } }
}
const options = (model: string) => ({ provider: 'codex', model } as GenerateOptions)
async function consume(route: LlmAdapter, id: string) { for await (const _ of route.stream(options(id))) { /* collect */ } }

test('registered account routes preserve the provider retry budget and backoff', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'account-retry-policy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const raw = new Raw()
  const expected = resolveRetryPolicy({ mode: 'normal', maxRetries: 10,
    backoff: { initialDelayMs: 1000, maxDelayMs: 60000, jitterRatio: 0.2 } }, 'test')
  const seen: string[] = []
  raw.providerRetryPolicy = provider => { seen.push(provider); return expected }
  const route = new AccountPreferencesAdapter({ provider: 'codex', adapter: raw,
    settings: new ProviderSettingsStore(join(dir, 'settings.json')), accounts: async () => [], pool: () => undefined, onWarn: () => {} })
  assert.deepEqual(route.providerRetryPolicy('codex'), expected)
  assert.deepEqual(seen, ['codex'])
})

test('account preferences validate, persist and distinguish absent and empty allowlists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-preferences-'))
  try {
    const store = new ProviderSettingsStore(join(dir, 'settings.json'))
    await store.set('codex', { accounts: JSON.parse('{"__proto__":{"alias":"  Work  ","poolEnabled":false,"independentEntry":true,"poolModels":[]},"b":{}}') })
    const prefs = new ProviderSettingsStore(store.path).get('codex').accounts!
    assert.equal(prefs['__proto__'].alias, 'Work')
    assert.equal(accountAllowsPool(prefs['__proto__'], 'm'), false)
    assert.equal(accountAllowsPool(prefs.b, 'm'), true)
    assert.equal(accountAllowsPool({ poolModels: [] }, 'm'), false)
    assert.equal(accountAllowsPool({ poolModels: ['m'] }, 'm'), true)
    for (const account of [{ poolEnabled: 'true' }, { independentEntry: 1 }, { poolModels: [null] }, { alias: 3 }, []]) assert.throws(() => validatePreferences('codex', { accounts: { a: account } }))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('independent entries use stable IDs, raw account capabilities and no default fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-route-'))
  try {
    const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
    const raw = new Raw()
    let accounts = [{ key: 'a:/账户', label: 'Original' }, { key: 'b', label: 'Other' }]
    const route = new AccountPreferencesAdapter({ provider: 'codex', adapter: raw, settings, accounts: async () => accounts, pool: () => undefined, onWarn: () => {} })
    const id = accountModelId('a:/账户', 'm:/模型')
    assert.deepEqual(parseAccountModelId(id), { account: 'a:/账户', model: 'm:/模型' })
    await settings.set('codex', { accounts: { 'a:/账户': { alias: 'Work', independentEntry: true, poolEnabled: false, poolModels: [] } } })
    assert.equal((await route.listModels('codex')).find(model => model.id === id)?.name, 'Work · Model')
    assert.equal((await route.resolveModel('codex', id)).context?.contextWindow, 100)
    await consume(route, id)
    assert.ok(raw.calls.includes('stream:a:/账户:m:/模型'))
    raw.failAccount = 'a:/账户'
    const beforeFailure = raw.calls.length
    await assert.rejects(consume(route, id), /quota exhausted/)
    assert.deepEqual(raw.calls.slice(beforeFailure), ['stream:a:/账户:m:/模型'])
    delete raw.failAccount
    await consume(route, 'm:/模型')
    assert.ok(raw.calls.includes('stream:b:m:/模型'))
    await settings.set('codex', { accounts: { 'a:/账户': { independentEntry: false }, b: { poolModels: [] } } })
    await assert.rejects(consume(route, id), /unavailable/)
    await assert.rejects(route.resolveModel('codex', id), /unavailable/)
    accounts = []
    await assert.rejects(consume(route, id), /unavailable/)
    await assert.rejects(consume(route, '~account:broken'), /Invalid/)
    await assert.rejects(consume(route, '~account:%ZZ:m'), /Invalid/)
    await assert.rejects(consume(route, 'm:/模型'), /No eligible/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('singleton and explicit families/tiers enforce account and model exclusion at pool seams', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-pool-'))
  try {
    const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
    const raw = new Raw()
    let pool: PoolAdapter | undefined
    let accounts = [{ key: 'a', label: 'A' }]
    const route = new AccountPreferencesAdapter({ provider: 'codex', adapter: raw, settings, accounts: async () => accounts, pool: () => pool, onWarn: () => {} })
    await settings.set('codex', { accounts: { a: { poolModels: [] } } })
    await assert.rejects(consume(route, 'm:/模型'), /No eligible/)
    pool = new PoolAdapter({ scheduling: resolvePoolScheduling(), adapters: { codex: route.poolMember() }, health: new PoolHealthRegistry(), usage: new PoolUsageTracker(() => undefined), strategy: 'priority', switchMargin: 2, defaultAccount: async () => 'a', families: async () => new Map([['codex/m:/模型', { members: [{ provider: 'codex', account: 'a', model: 'm:/模型' }] }]]), tiers: { tier: [{ provider: 'codex', model: 'm:/模型' }] }, onWarn: () => {} })
    for (const id of ['m:/模型', 'tier']) {
      await assert.rejects(consume(route, id))
      await assert.rejects(route.resolveModel('codex', id), /no usable member/)
    }
    assert.equal(raw.calls.length, 0)
    assert.deepEqual(await route.listModels('codex'), [])
    await settings.set('codex', { accounts: { a: { poolModels: ['m:/模型'] } } })
    await consume(route, 'tier')
    assert.ok(raw.calls.includes('stream:a:m:/模型'))
    accounts = [...accounts, { key: 'b', label: 'B' }]
    await settings.set('codex', { accounts: { a: { poolEnabled: false } } })
    pool = new PoolAdapter({ scheduling: resolvePoolScheduling(), adapters: { codex: route.poolMember() }, health: new PoolHealthRegistry(), usage: new PoolUsageTracker(() => undefined), strategy: 'priority', switchMargin: 2, defaultAccount: async () => 'a', families: async () => new Map(), tiers: { mixed: [{ provider: 'codex', account: 'a', model: 'm:/模型' }, { provider: 'codex', account: 'b', model: 'm:/模型' }] }, onWarn: () => {} })
    assert.equal((await route.resolveModel('codex', 'mixed')).context?.contextWindow, 200)
    await consume(route, 'mixed')
    assert.ok(raw.calls.includes('stream:b:m:/模型'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the registered route reports the wrapped adapter\'s display identity', () => {
  // The harness reads providerInfo for every registered route and shows the name in the model
  // picker; the registered adapter is this wrapper, so it has to pass the name through.
  const adapter = new AccountPreferencesAdapter({
    provider: 'claude',
    adapter: {
      providerInfo: () => ({ id: 'claude', name: 'Claude' }),
      providerRetryPolicy: () => undefined,
    } as never,
    settings: new ProviderSettingsStore(),
    accounts: async () => [],
    pool: () => undefined,
    onWarn: () => {},
  })
  assert.deepEqual(adapter.providerInfo('claude'), { id: 'claude', name: 'Claude' })
})

/**
 * A registered route whose pool owns no entry at all (the shape of
 * `pool.autoAccounts: false` with no configured families or tiers), so every
 * request for a catalog model takes the non-pool fallback. The pool is built
 * over the route's own member seam, as the plugin wires it.
 */
function unownedPool(
  provider: ProviderId,
  usage: (provider: ProviderId, account: string) => (() => Promise<ProviderUsage>) | undefined,
) {
  const raw = new Raw()
  const health = new PoolHealthRegistry()
  const warnings: string[] = []
  let pool: PoolAdapter | undefined
  const route = new AccountPreferencesAdapter({
    provider,
    adapter: raw,
    settings: new ProviderSettingsStore(),
    accounts: async () => [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
    pool: () => pool,
    onWarn: message => { warnings.push(message) },
  })
  const adapters: Partial<Record<ProviderId, AccountAwareAdapter>> = { [provider]: route.poolMember() }
  pool = new PoolAdapter({ scheduling: resolvePoolScheduling(), adapters, health,
    usage: new PoolUsageTracker(usage), strategy: 'priority', switchMargin: 2,
    defaultAccount: async () => 'a', families: async () => new Map(), tiers: {}, onWarn: () => {} })
  return { route, raw, health, warnings }
}

test('an unowned model still refuses the account the pool would have held back', async () => {
  const { route, raw, health, warnings } = unownedPool('codex', () => undefined)
  health.markUnavailable(accountKey('codex', 'a'), 60_000, 'RATE_LIMIT')
  await consume(route, 'm:/模型')
  assert.deepEqual(raw.calls, ['stream:b:m:/模型'])
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('codex/m:/模型'), warnings[0])
  // The configuration gap is stated once per model, not once per request.
  await consume(route, 'm:/模型')
  assert.equal(warnings.length, 1)
})

test('an unowned model still refuses a Claude account past a usage floor', async () => {
  const { route, raw } = unownedPool('claude', (_provider, account) => async () => ({
    supported: true,
    windows: [{ kind: 'session' as const, usedPercent: account === 'a' ? 90 : 5 }],
  }))
  await consume(route, 'm:/模型')
  assert.deepEqual(raw.calls, ['stream:b:m:/模型'])
})

test('an unowned model reports the pool\'s cause and recovery hint when every account is held back', async () => {
  // Both accounts are unusable for a TEMPORARY reason: `a` is past its Claude session
  // floor with a disclosed reset, `b` is parked by a rate limit. Naming an unavailable
  // model (NO_ADAPTER) for that would discard the reset the provider just disclosed.
  const resetsAt = Date.now() + 600_000
  const { route, health } = unownedPool('claude', (_provider, account) => async () => ({
    supported: true,
    windows: [{ kind: 'session' as const, usedPercent: account === 'a' ? 90 : 5, resetsAt }],
  }))
  health.markUnavailable(accountKey('claude', 'b'), 60_000, 'RATE_LIMIT')
  const held = await consume(route, 'm:/模型').then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(held instanceof LlmError, String(held))
  assert.equal(held.code, 'RATE_LIMIT')
  const retryAfterMs = held.failure.providerRetryAfterMs
  assert.ok(retryAfterMs !== undefined && retryAfterMs > 59_000 && retryAfterMs <= 60_000, String(retryAfterMs))

  // A refusal outranks the rate limit and reaches the caller: another account must not
  // be asked, and the code has to say so instead of inviting a retry.
  health.markUnavailable(accountKey('claude', 'b'), 24 * 60 * 60_000, 'AUTH')
  const refused = await consume(route, 'm:/模型').then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(refused instanceof LlmError, String(refused))
  assert.equal(refused.code, 'AUTH')
})

test('an unowned model that no account lists still names an unavailable model', async () => {
  // Held-back accounts alone earn the pool's cause; a model the catalog does not list
  // anywhere stays NO_ADAPTER, because no retry can make it exist.
  const { route, raw } = unownedPool('codex', () => undefined)
  raw.listOwnModels = async () => []
  const missing = await consume(route, 'm:/模型').then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(missing instanceof LlmError, String(missing))
  assert.equal(missing.code, 'NO_ADAPTER')
})
