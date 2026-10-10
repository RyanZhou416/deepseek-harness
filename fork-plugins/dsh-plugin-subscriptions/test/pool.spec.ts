/**
 * Same-subscription account pools: aggregation by catalog wire id, member
 * selection (priority failover and quota-aware urgency with sticky
 * hysteresis), stream failover (switch before the first chunk, never after),
 * extra tier listing, and capability intersection. Members are fake adapters.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import './keep-alive.js'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PoolAdapter, usagePoolState } from '../src/providers/pool.js'
import type { PoolAdapterOptions } from '../src/providers/pool.js'
import { resolvePoolScheduling } from '../src/providers/pool-scheduling.js'
import type { PoolSchedulingPolicy } from '../src/providers/pool-scheduling.js'
import { unionAccountCatalogs } from '../src/providers/accounts.js'
import { buildAccountPools, poolKey } from '../src/providers/pool-family.js'
import type { PoolDefinition, PoolMemberRef, ProviderPoolSource } from '../src/providers/pool-family.js'
import { accountKey, memberKey, PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import { ENFORCEMENT_CODE, OAuthEndpointError } from '../src/providers/common.js'
import type { ProviderUsage, UsagePoolState } from '../src/providers/common.js'
import type { ProviderId } from '../src/auth/store.js'
import type { AccountAwareAdapter } from '../src/providers/accounts.js'

/** Brand a string as a GenerateOptions sessionId (the loop-stamped session identity). */
const SessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

const OPTIONS: GenerateOptions = { provider: 'codex', model: 'm', messages: [] }

test('pool canonicalizes legacy aliases before deduplication', async () => {
  const adapter = new FakeAdapter(() => serveOk())
  const pool = new PoolAdapter({ scheduling: resolvePoolScheduling(),
    adapters: { codex: adapter }, health: new PoolHealthRegistry(),
    usage: new PoolUsageTracker(() => undefined), strategy: 'priority', switchMargin: 2,
    defaultAccount: async () => 'canonical',
    resolveAccount: async (_provider, account) => account === 'legacy' ? 'canonical' : account,
    families: async () => new Map([[poolKey('codex', 'm'), { members: [
      { provider: 'codex', model: 'm', account: 'legacy' },
      { provider: 'codex', model: 'm', account: 'canonical' },
    ] }]]), tiers: {}, onWarn: () => {},
  })
  await collect(pool.stream(OPTIONS))
  assert.deepEqual(adapter.accounts, ['canonical'])
})

test('network failures remain retryable without borrowing a different account cooldown in either attempt order', async () => {
  for (const transportAccount of ['a1', 'a2']) {
    const network = new LlmError('claude API request failed', 'TRANSPORT')
    const adapter = new FakeAdapter((_options, account) => serveFail(account === transportAccount ? network
      : new LlmError('quota exhausted', 'RATE_LIMIT', { providerRetryAfterMs: 32 * 3_600_000 })))
    const { pool, health } = makePool({ codex: adapter })
    await assert.rejects(collect(pool.stream(OPTIONS)), error => {
      assert.equal(error, network)
      assert.equal(network.failure.providerRetryAfterMs, undefined)
      return true
    })
    assert.equal(health.isMemberAvailable('codex', transportAccount, 'm'), true)
    // The next request can still try the network-failed account while its sibling is cooling.
    await assert.rejects(collect(pool.stream(OPTIONS)), error => error === network)
  }
})

test('pool context intersects each account and each model, including same-provider tiers', async () => {
  const adapter = new FakeAdapter(() => serveOk())
  const visited: string[] = []
  adapter.resolveOwnModel = async (provider: string, model: string, account?: string) => {
    visited.push(`${model}/${account}`)
    return { provider, id: model, name: model, context: { contextWindow: account === 'small' ? 300000 : 872000 } }
  }
  const pool = new PoolAdapter({ scheduling: resolvePoolScheduling(),
    adapters: { codex: adapter }, health: new PoolHealthRegistry(),
    usage: new PoolUsageTracker(() => undefined), strategy: 'priority', switchMargin: 2,
    defaultAccount: async () => 'large', onWarn: () => {},
    families: async () => new Map([[poolKey('codex', 'm'), { members: [
      { provider: 'codex', model: 'm', account: 'large' },
      { provider: 'codex', model: 'm', account: 'small' },
    ] }]]),
    tiers: {},
  })
  assert.equal((await pool.resolveModel('codex', 'm')).context?.contextWindow, 300000)
  assert.deepEqual(visited, ['m/large', 'm/small'])
})

/** A scripted member adapter: serves chunks from `serve`, counts calls and the accounts used. */
class FakeAdapter extends LlmAdapter implements AccountAwareAdapter {
  calls = 0
  readonly accounts: string[] = []
  /** resolveModel calls that bypassed the own-model seam (must stay zero from the pool). */
  directResolves = 0

  constructor(
    private readonly serve: (options: GenerateOptions, account: string) => AsyncIterable<StreamChunk>,
    private readonly resolved: Partial<LlmResolvedModelInfo> = {},
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.directResolves += 1
    return this.resolveOwnModel(provider, model)
  }

  resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, ...this.resolved })
  }

  listOwnModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  clearAccountCatalog(): void {}

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamCore(options, 'default')
  }

  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    return this.streamCore(options, account)
  }

  private async *streamCore(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.accounts.push(account)
    yield* this.serve(options, account)
  }
}

async function* serveOk(text = 'hi'): AsyncIterable<StreamChunk> {
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* serveFail(error: LlmError): AsyncIterable<StreamChunk> {
  throw error
}

async function* servePartial(error: LlmError): AsyncIterable<StreamChunk> {
  yield { type: 'text-delta', index: 0, text: 'partial' }
  throw error
}

async function* serveEmpty(): AsyncIterable<StreamChunk> {
  // A stream that ends without a single chunk.
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** Two Codex accounts of one catalog model (the default account-pool shape). */
const freshAccounts = (): Map<string, PoolDefinition> =>
  new Map([[poolKey('codex', 'm'), {
    members: [
      { provider: 'codex', account: 'a1', model: 'm' },
      { provider: 'codex', account: 'a2', model: 'm' },
    ],
  }]])

interface PoolHarness {
  pool: PoolAdapter
  health: PoolHealthRegistry
  usage: PoolUsageTracker
  warnings: string[]
}

function makePool(
  adapters: Partial<Record<ProviderId, FakeAdapter>>,
  options: {
    strategy?: 'priority' | 'quota_aware'
    switchMargin?: number
    scheduling?: Partial<PoolSchedulingPolicy>
    usage?: (provider: ProviderId, account: string) => (() => Promise<ProviderUsage>) | undefined
    families?: Map<string, PoolDefinition>
    tiers?: Record<string, PoolMemberRef[]>
    defaultAccount?: string
    familiesFn?: () => Promise<Map<string, PoolDefinition>>
    recoverQuota?: PoolAdapterOptions['recoverQuota']
  } = {},
): PoolHarness {
  const health = new PoolHealthRegistry()
  const usage = new PoolUsageTracker(options.usage ?? (() => undefined))
  const warnings: string[] = []
  const pool = new PoolAdapter({ scheduling: resolvePoolScheduling(options.scheduling),
    adapters,
    health,
    usage,
    strategy: options.strategy ?? 'priority',
    switchMargin: options.switchMargin ?? 2,
    defaultAccount: () => Promise.resolve(options.defaultAccount ?? 'a1'),
    families: options.familiesFn ?? (() => Promise.resolve(options.families ?? freshAccounts())),
    tiers: options.tiers ?? {},
    onWarn: message => { warnings.push(message) },
    ...(options.recoverQuota === undefined ? {} : { recoverQuota: options.recoverQuota }),
  })
  return { pool, health, usage, warnings }
}

test('a depleted sticky account checks reset recovery before switching to an account with quota', async () => {
  for (const recover of [true, false]) {
    const adapter = new FakeAdapter(() => serveOk())
    let used = 90
    const checked: string[] = []
    const { pool, usage: tracker } = makePool({ codex: adapter }, {
      strategy: 'quota_aware',
      usage: (_provider, account) => async () => ({ supported: true, windows: [{ kind: 'weekly', usedPercent: account === 'a1' ? used : 90 }] }),
      recoverQuota: async member => { checked.push(member.account); if (recover) used = 0; return recover },
    })
    const options = { ...OPTIONS, sessionId: SessionId('auto-reset') }
    await collect(pool.stream(options))
    used = 100
    tracker.invalidate('codex', 'a1')
    await collect(pool.stream(options))
    assert.deepEqual(checked, ['a1'])
    assert.deepEqual(adapter.accounts, ['a1', recover ? 'a1' : 'a2'])
  }
})

/** A one-or-more-account pool source (every account sees the same catalog). */
function source(provider: ProviderId, ids: string[], accounts: readonly string[] = ['a1']): ProviderPoolSource {
  const models = ids.map(id => ({ provider, id, name: id }))
  return { catalogs: accounts.map(account => ({ account, models })) }
}

test('unionAccountCatalogs keeps the first account\'s row and appends unique ids', async () => {
  const models = await unionAccountCatalogs(['plus', 'max'], account => Promise.resolve(
    account === 'plus'
      ? [{ provider: 'claude', id: 'sonnet', name: 'Sonnet' }]
      : [
          { provider: 'claude', id: 'sonnet', name: 'Sonnet from Max' },
          { provider: 'claude', id: 'opus', name: 'Opus' },
        ],
  ))
  assert.deepEqual(models.map(model => model.id), ['sonnet', 'opus'])
  assert.equal(models[0].name, 'Sonnet')
})

test('unionAccountCatalogs reorders by catalog priority after the merge', async () => {
  const models = await unionAccountCatalogs(['plus', 'pro'], account => Promise.resolve(
    account === 'plus'
      ? [
          { provider: 'codex', id: 'gpt-5.6-terra', name: 'Terra', priority: 2 } as LlmModelInfo,
          { provider: 'codex', id: 'gpt-5.6-luna', name: 'Luna', priority: 3 } as LlmModelInfo,
          { provider: 'codex', id: 'gpt-5.5', name: 'GPT-5.5', priority: 7 } as LlmModelInfo,
          { provider: 'codex', id: 'gpt-5.4-mini', name: 'Mini', priority: 23 } as LlmModelInfo,
        ]
      : [
          { provider: 'codex', id: 'gpt-5.6-sol', name: 'Sol', priority: 1 } as LlmModelInfo,
          { provider: 'codex', id: 'gpt-5.6-terra', name: 'Terra', priority: 2 } as LlmModelInfo,
          { provider: 'codex', id: 'gpt-5.4', name: 'GPT-5.4', priority: 8 } as LlmModelInfo,
        ],
  ))
  assert.deepEqual(models.map(model => model.id), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
  ])
})

test('unionAccountCatalogs sits out an account that throws so siblings still list', async () => {
  const models = await unionAccountCatalogs(
    ['expired', 'ok'],
    account => account === 'ok'
      ? Promise.resolve([{ provider: 'codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }])
      : Promise.reject(new Error('refresh failed')),
  )
  assert.deepEqual(models.map(model => model.id), ['gpt-5.6-sol'])
})

test('unionAccountCatalogs sits out an account that exceeds the timeout', async () => {
  const started = Date.now()
  const models = await unionAccountCatalogs(
    ['plus', 'max'],
    (account, signal) => {
      if (account === 'plus') {
        return Promise.resolve([{ provider: 'claude', id: 'sonnet', name: 'Sonnet' }])
      }
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    },
    { timeoutMs: 20 },
  )
  assert.deepEqual(models.map(model => model.id), ['sonnet'])
  assert.ok(Date.now() - started < 500)
})

test('buildAccountPools pools two accounts of one provider under the wire id', () => {
  const pools = buildAccountPools({
    claude: source('claude', ['claude-sonnet-4-5-20250929'], ['alice', 'bob']),
  })
  assert.deepEqual(pools.get(poolKey('claude', 'claude-sonnet-4-5-20250929'))?.members, [
    { provider: 'claude', account: 'alice', model: 'claude-sonnet-4-5-20250929' },
    { provider: 'claude', account: 'bob', model: 'claude-sonnet-4-5-20250929' },
  ])
})

test('buildAccountPools does not cross providers or invent a family key', () => {
  const pools = buildAccountPools({
    copilot: source('copilot', ['gpt-5.4', 'claude-sonnet-4.5']),
    codex: source('codex', ['gpt-5.4']),
    claude: source('claude', ['claude-sonnet-4-5-20250929']),
  })
  // Each model stays on its own provider — even when the wire id matches.
  assert.deepEqual(pools.get(poolKey('codex', 'gpt-5.4'))?.members.map(member => member.provider), ['codex'])
  assert.deepEqual(pools.get(poolKey('copilot', 'gpt-5.4'))?.members.map(member => member.provider), ['copilot'])
  assert.equal(pools.has(poolKey('claude', 'claude-sonnet-4.5')), false)
  assert.equal(pools.has(poolKey('claude', 'claude-sonnet-4-5-20250929')), true)
})

test('buildAccountPools only pools accounts whose catalog lists the model', () => {
  const pools = buildAccountPools({
    claude: {
      catalogs: [
        { account: 'plus', models: [{ provider: 'claude', id: 'sonnet', name: 'Sonnet' }] },
        { account: 'max', models: [
          { provider: 'claude', id: 'sonnet', name: 'Sonnet' },
          { provider: 'claude', id: 'opus', name: 'Opus' },
        ] },
      ],
    },
  })
  assert.deepEqual(pools.get(poolKey('claude', 'sonnet'))?.members, [
    { provider: 'claude', account: 'plus', model: 'sonnet' },
    { provider: 'claude', account: 'max', model: 'sonnet' },
  ])
  // Only the Max account lists Opus — pinned to Max, still in the picker.
  assert.deepEqual(pools.get(poolKey('claude', 'opus'))?.members, [
    { provider: 'claude', account: 'max', model: 'opus' },
  ])
})

test('buildAccountPools records a single-account model as a one-member route', () => {
  const pools = buildAccountPools({
    claude: source('claude', ['claude-sonnet-5'], ['alice']),
    codex: source('codex', ['gpt-5.4'], ['a1', 'a2']),
  })
  assert.deepEqual(pools.get(poolKey('claude', 'claude-sonnet-5'))?.members, [
    { provider: 'claude', account: 'alice', model: 'claude-sonnet-5' },
  ])
  assert.equal(pools.get(poolKey('codex', 'gpt-5.4'))?.members.length, 2)
})

test('modelsForProvider lists only extra tiers, not account pools', async () => {
  const { pool } = makePool(
    { codex: new FakeAdapter(() => serveOk()) },
    { tiers: { smart: [{ provider: 'codex', account: 'a1', model: 'other' }] } },
  )
  const extras = await pool.modelsForProvider('codex')
  assert.deepEqual(extras.map(model => model.id), ['smart'])
  assert.equal(extras[0].provider, 'codex')
  // The account pool reuses the catalog row — it is not listed again.
  assert.equal(extras.some(model => model.id === 'm'), false)
  assert.deepEqual(await pool.modelsForProvider('claude'), [])
})

test('a model listed by one account is pinned to that account', async () => {
  const family = new Map<string, PoolDefinition>([
    [poolKey('codex', 'pro-only'), {
      members: [{ provider: 'codex', account: 'max', model: 'pro-only' }],
    }],
  ])
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex }, { families: family })
  assert.equal(await pool.owns('codex', 'pro-only'), true)
  const chunks = await collect(pool.stream({ provider: 'codex', model: 'pro-only', messages: [] }))
  assert.equal((chunks[0] as { text: string }).text, 'max')
  assert.deepEqual(codex.accounts, ['max'])
})

test('owns recognizes the account pool on its provider and catalog id', async () => {
  const { pool } = makePool({ codex: new FakeAdapter(() => serveOk()) })
  assert.equal(await pool.owns('codex', 'm'), true)
  assert.equal(await pool.owns('claude', 'm'), false)
  assert.equal(await pool.owns('codex', 'unknown'), false)
})

test('a tier overriding an account-pool id wins with a single warning', async () => {
  const { pool, warnings } = makePool(
    { codex: new FakeAdapter(() => serveOk()), claude: new FakeAdapter(() => serveOk()) },
    { tiers: { m: [{ provider: 'codex', account: 'a1', model: 'other' }] } },
  )
  const extras = await pool.modelsForProvider('codex')
  assert.deepEqual(extras.map(model => model.id), ['m'])
  await pool.modelsForProvider('codex')
  assert.equal(warnings.filter(message => message.includes('overrides')).length, 1)
})

test('invalidate drops the pools snapshot so the next read reassembles', async () => {
  let reads = 0
  const familiesFn = async (): Promise<Map<string, PoolDefinition>> => {
    reads += 1
    return freshAccounts()
  }
  const { pool } = makePool({ codex: new FakeAdapter(() => serveOk()) }, { familiesFn })
  await pool.owns('codex', 'm')
  await pool.owns('codex', 'm')
  assert.equal(reads, 1)
  pool.invalidate()
  await pool.owns('codex', 'm')
  assert.equal(reads, 2)
})

test('priority: the first healthy account serves', async () => {
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex })
  const chunks = await collect(pool.stream(OPTIONS))
  assert.equal((chunks[0] as { text: string }).text, 'a1')
  assert.deepEqual(codex.accounts, ['a1'])
  assert.equal(codex.calls, 1)
})

test('priority: a configured member without an account uses the default account', async () => {
  const codex = new FakeAdapter(() => serveOk('codex'))
  const family = new Map<string, PoolDefinition>([
    [poolKey('codex', 'm'), { members: [{ provider: 'codex', model: 'm' }, { provider: 'codex', account: 'bob', model: 'm' }] }],
  ])
  const { pool } = makePool({ codex }, { families: family, defaultAccount: 'alice' })
  await collect(pool.stream(OPTIONS))
  assert.deepEqual(codex.accounts, ['alice'])
})

test('priority: a cooling account is skipped', async () => {
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool, health } = makePool({ codex })
  health.markUnavailable(memberKey('codex', 'a1', 'm'), 60_000, 'QUOTA')
  const chunks = await collect(pool.stream(OPTIONS))
  assert.equal((chunks[0] as { text: string }).text, 'a2')
  assert.deepEqual(codex.accounts, ['a2'])
})

test('priority: a sticky session keeps its account after the leader recovers', async () => {
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool, health } = makePool({ codex })
  const options = { ...OPTIONS, sessionId: SessionId('s1') }
  health.markUnavailable(memberKey('codex', 'a1', 'm'), 60_000, 'QUOTA')
  await collect(pool.stream(options))
  assert.deepEqual(codex.accounts, ['a2'])
  health.clear('codex')
  const chunks = await collect(pool.stream(options))
  assert.equal((chunks[0] as { text: string }).text, 'a2')
  assert.deepEqual(codex.accounts, ['a2', 'a2'])
})

/** Usage fetchers reading a mutable snapshot, keyed by provider or provider/account. */
function usageFetchers(data: Record<string, ProviderUsage>) {
  return (provider: ProviderId, account: string): (() => Promise<ProviderUsage>) | undefined => {
    const snapshot = data[`${provider}/${account}`] ?? data[provider]
    return snapshot === undefined ? undefined : () => Promise.resolve(snapshot)
  }
}

/** A usage snapshot with one session window of `usedPercent`, resetting in `horizonMs`. */
function windowUsage(usedPercent: number, horizonMs: number): ProviderUsage {
  return {
    supported: true,
    windows: [{ kind: 'session', usedPercent, resetsAt: Date.now() + horizonMs }],
  }
}

test('quota_aware: the most urgent window (soon reset, plenty left) wins', async () => {
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex }, {
    strategy: 'quota_aware',
    usage: usageFetchers({
      'codex/a1': windowUsage(50, 5 * 60 * 60_000),
      'codex/a2': windowUsage(10, 30 * 60_000),
    }),
  })
  const chunks = await collect(pool.stream(OPTIONS))
  assert.equal((chunks[0] as { text: string }).text, 'a2')
})

test('quota_aware: a ChatGPT window at 100% gates its account out', async () => {
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex }, {
    strategy: 'quota_aware',
    usage: usageFetchers({
      'codex/a1': windowUsage(50, 5 * 60 * 60_000),
      'codex/a2': windowUsage(100, 30 * 60_000),
    }),
  })
  await collect(pool.stream(OPTIONS))
  assert.deepEqual(codex.accounts, ['a1'])
})

test('quota_aware: ChatGPT stays selectable at 99%', async () => {
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex }, {
    strategy: 'quota_aware',
    usage: usageFetchers({
      'codex/a1': windowUsage(50, 5 * 60 * 60_000),
      'codex/a2': windowUsage(99, 60_000),
    }),
  })
  await collect(pool.stream(OPTIONS))
  assert.deepEqual(codex.accounts, ['a2'])
})

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** One weekly window, optionally with the earliest available reset-credit expiry. */
function weeklyUsage(usedPercent: number, remainingMs: number, expiresInMs?: number): ProviderUsage {
  return {
    supported: true,
    windows: [{ kind: 'weekly', usedPercent, resetsAt: Date.now() + remainingMs }],
    ...expiresInMs === undefined ? {} : {
      resetCredits: { availableCount: 1, soonestExpiresAt: Date.now() + expiresInMs },
    },
  }
}

test('quota_aware: an approaching ChatGPT reset can outweigh a fresh expiring credit', async () => {
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex }, {
    strategy: 'quota_aware',
    usage: usageFetchers({
      // The card preference is bounded, so it cannot force traffic away from a near reset.
      'codex/a1': weeklyUsage(20, 12 * 60 * 60 * 1000, 2 * DAY_MS),
      'codex/a2': weeklyUsage(5, WEEK_MS - 12 * 60 * 60 * 1000, 2 * DAY_MS),
    }),
  })
  await collect(pool.stream(OPTIONS))
  assert.deepEqual(codex.accounts, ['a1'])
})

test('quota_aware: sticky holds against a fresh-credit account inside the margin', async () => {
  const data: Record<string, ProviderUsage> = {
    'codex/a1': weeklyUsage(10, 2 * 60 * 60 * 1000),
    'codex/a2': weeklyUsage(10, 3 * DAY_MS),
  }
  const usage = usageFetchers(data)
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool, usage: tracker } = makePool({ codex }, { strategy: 'quota_aware', switchMargin: 2, usage })
  const options = { ...OPTIONS, sessionId: SessionId('fresh-credit') }
  await collect(pool.stream(options))
  assert.deepEqual(codex.accounts, ['a1'])
  data['codex/a2'] = weeklyUsage(5, WEEK_MS - 12 * 60 * 60 * 1000, DAY_MS)
  tracker.invalidate('codex')
  await collect(pool.stream(options))
  assert.deepEqual(codex.accounts, ['a1', 'a1'])
})

test('quota_aware: remaining quota outranks a full account that holds an expiring credit', async () => {
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex }, {
    strategy: 'quota_aware',
    usage: usageFetchers({
      'codex/a1': weeklyUsage(40, 2 * DAY_MS),
      'codex/a2': {
        supported: true,
        windows: [
          { kind: 'weekly', usedPercent: 10, resetsAt: Date.now() + WEEK_MS - 12 * 60 * 60 * 1000 },
          { kind: 'session', usedPercent: 100, resetsAt: Date.now() + 60 * 60 * 1000 },
        ],
        resetCredits: { availableCount: 1, soonestExpiresAt: Date.now() + DAY_MS },
      },
    }),
  })
  await collect(pool.stream(OPTIONS))
  assert.deepEqual(codex.accounts, ['a1'])
})

test('quota_aware: a full fresh-credit account leads the last-resort tail', async () => {
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex }, {
    strategy: 'quota_aware',
    usage: usageFetchers({
      'codex/a1': weeklyUsage(100, 12 * 60 * 60 * 1000, DAY_MS),
      'codex/a2': weeklyUsage(100, WEEK_MS - 12 * 60 * 60 * 1000, DAY_MS),
    }),
  })
  await collect(pool.stream(OPTIONS))
  assert.deepEqual(codex.accounts, ['a2'])
})

test('quota_aware: Claude prefers the account whose window resets first', async () => {
  const claude = new FakeAdapter((_options, account) => serveOk(account))
  const family = new Map<string, PoolDefinition>([
    [poolKey('claude', 'm'), {
      members: [
        { provider: 'claude', account: 'a1', model: 'm' },
        { provider: 'claude', account: 'a2', model: 'm' },
      ],
    }],
  ])
  const { pool } = makePool({ claude }, {
    strategy: 'quota_aware',
    families: family,
    usage: usageFetchers({
      // Below the session floor: the reserve is what keeps a turn off a window that is
      // about to close, and the preference this test proves still holds under it.
      'claude/a1': windowUsage(45, 30 * 60_000),
      'claude/a2': windowUsage(20, 5 * 60 * 60_000),
    }),
  })
  await collect(pool.stream({ ...OPTIONS, provider: 'claude' }))
  assert.deepEqual(claude.accounts, ['a1'])
})

test('quota_aware: an account without telemetry sinks behind a measured one', async () => {
  const copilot = new FakeAdapter((_options, account) => serveOk(account))
  const family = new Map<string, PoolDefinition>([
    [poolKey('copilot', 'm'), {
      members: [
        { provider: 'copilot', account: 'a1', model: 'm' },
        { provider: 'copilot', account: 'a2', model: 'm' },
      ],
    }],
  ])
  const { pool } = makePool({ copilot }, {
    strategy: 'quota_aware',
    families: family,
    // a1 has no fetcher (urgency 0); a2 is measured — even 90% used wins.
    usage: usageFetchers({ 'copilot/a2': windowUsage(90, 60 * 60_000) }),
  })
  await collect(pool.stream({ ...OPTIONS, provider: 'copilot' }))
  assert.deepEqual(copilot.accounts, ['a2'])
})

test('quota_aware: hysteresis holds the sticky account until the margin is beaten', async () => {
  const data: Record<string, ProviderUsage> = {
    'codex/a1': windowUsage(0, 100 * 60_000),
    'codex/a2': windowUsage(0, 10 * 60_000),
  }
  const usage = usageFetchers(data)
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool, usage: tracker } = makePool({ codex }, { strategy: 'quota_aware', switchMargin: 2, usage })
  const options = { ...OPTIONS, sessionId: SessionId('s1') }

  await collect(pool.stream(options))
  assert.deepEqual(codex.accounts, ['a2'])

  data['codex/a2'] = windowUsage(0, 100 * 60_000)
  data['codex/a1'] = windowUsage(0, 60 * 60_000)
  tracker.invalidate('codex')
  const chunks = await collect(pool.stream(options))
  assert.equal((chunks[0] as { text: string }).text, 'a2')

  data['codex/a1'] = windowUsage(0, 30 * 60_000)
  tracker.invalidate('codex')
  const switched = await collect(pool.stream(options))
  assert.equal((switched[0] as { text: string }).text, 'a1')
})

test('stream: a pre-chunk enforcement refusal ends the turn without another account or a usage re-poll', async () => {
  const refusal = new LlmError('refused', ENFORCEMENT_CODE, { providerRetryAfterMs: 10_800_000 })
  const codex = new FakeAdapter((_options, account) => account === 'a1' ? serveFail(refusal) : serveOk('a2'))
  const usageCalls: string[] = []
  const { pool, health, usage } = makePool({ codex }, {
    usage: (provider, account) => {
      if (provider !== 'codex' || account !== 'a1') return undefined
      return () => { usageCalls.push(account); return Promise.resolve(windowUsage(10, 60 * 60_000)) }
    },
  })
  const member = { provider: 'codex' as const, account: 'a1', model: 'm' }
  await usage.quotaFor(member)
  assert.equal(usageCalls.length, 1)
  await assert.rejects(collect(pool.stream(OPTIONS)), error => error === refusal)
  assert.deepEqual(codex.accounts, ['a1'], 'the refusal is not repeated on the sibling account')
  assert.equal(health.isMemberAvailable('codex', 'a1', 'other-model'), false, 'the account is parked')
  await usage.quotaFor(member)
  assert.equal(usageCalls.length, 1, 'a refusal does not invalidate the usage snapshot')
})

test('stream: a 403 permission_error refusal ends the turn instead of walking the pool', async () => {
  const denied = new LlmError('denied', 'AUTH')
  const codex = new FakeAdapter((_options, account) => account === 'a1' ? serveFail(denied) : serveOk('a2'))
  const { pool, health } = makePool({ codex })
  await assert.rejects(collect(pool.stream(OPTIONS)), error => error === denied)
  assert.deepEqual(codex.accounts, ['a1'], 'one turn issues one request, not one per pool account')
  assert.equal(health.isMemberAvailable('codex', 'a1', 'm'), false)
  assert.equal(health.isMemberAvailable('codex', 'a2', 'm'), true, 'the sibling account is untouched')
})

test('stream: a pre-chunk quota failure cools the whole account and fails over', async () => {
  const usageCalls: string[] = []
  const codex = new FakeAdapter((_options, account) =>
    account === 'a1'
      ? serveFail(new LlmError('limited', 'RATE_LIMIT', { providerRetryAfterMs: 42_000 }))
      : serveOk('a2'))
  const { pool, health, usage, warnings } = makePool({ codex }, {
    usage: (provider, account) => {
      if (provider !== 'codex' || account !== 'a1') return undefined
      return () => {
        usageCalls.push(account)
        return Promise.resolve(windowUsage(10, 60 * 60_000))
      }
    },
  })
  const member = { provider: 'codex' as const, account: 'a1', model: 'm' }
  await usage.quotaFor(member)
  assert.equal(usageCalls.length, 1)
  const chunks = await collect(pool.stream(OPTIONS))
  assert.equal((chunks[0] as { text: string }).text, 'a2')
  assert.deepEqual(codex.accounts, ['a1', 'a2'])
  assert.equal(health.isMemberAvailable('codex', 'a1', 'm'), false)
  assert.equal(health.isMemberAvailable('codex', 'a1', 'other-model'), false)
  assert.equal(health.isMemberAvailable('codex', 'a2', 'm'), true)
  assert.equal(warnings.some(message => message.includes('trying the next member')), true)
  await usage.quotaFor(member)
  assert.equal(usageCalls.length, 2)
})

test('stream: a claude quota failure cools only the failing member', async () => {
  const claude = new FakeAdapter((_options, account) =>
    account === 'a1' ? serveFail(new LlmError('lane full', 'QUOTA')) : serveOk('a2'))
  const family = new Map<string, PoolDefinition>([
    [poolKey('claude', 'claude-opus-5'), {
      members: [
        { provider: 'claude', account: 'a1', model: 'claude-opus-5' },
        { provider: 'claude', account: 'a2', model: 'claude-opus-5' },
      ],
    }],
  ])
  const { pool, health } = makePool({ claude }, { families: family })
  await collect(pool.stream({ provider: 'claude', model: 'claude-opus-5', messages: [] }))
  assert.equal(health.isMemberAvailable('claude', 'a1', 'claude-opus-5'), false)
  assert.equal(health.isMemberAvailable('claude', 'a1', 'claude-sonnet-5'), true)
})

test('stream: a transient failure does not invalidate the usage snapshot', async () => {
  const usageCalls: string[] = []
  const codex = new FakeAdapter((_options, account) =>
    account === 'a1' ? serveFail(new LlmError('boom', 'SERVER')) : serveOk('a2'))
  const { pool, usage } = makePool({ codex }, {
    usage: (provider, account) => {
      if (provider !== 'codex' || account !== 'a1') return undefined
      return () => {
        usageCalls.push(account)
        return Promise.resolve(windowUsage(10, 60 * 60_000))
      }
    },
  })
  const member = { provider: 'codex' as const, account: 'a1', model: 'm' }
  await usage.quotaFor(member)
  assert.equal(usageCalls.length, 1)
  await collect(pool.stream(OPTIONS))
  await usage.quotaFor(member)
  assert.equal(usageCalls.length, 1)
})

test('stream: quota_aware selection never re-hits a usage endpoint still cooling down from a 429 (issue #46)', async () => {
  // Every quota_aware stream() re-consults quotaFor for every usable member
  // (see select() above), so a real completion loop calls it once per
  // request. Anthropic's usage endpoint rate-limits progressively — each hit
  // inside the retry-after window pushes the next one further out — so
  // retrying it on every request permanently locks the account out.
  const usageCalls: string[] = []
  const error = new OAuthEndpointError('claude usage token endpoint error (HTTP 429)', 429, undefined, 60_000)
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex }, {
    strategy: 'quota_aware',
    usage: (provider, account) => {
      if (provider !== 'codex' || account !== 'a1') return undefined
      return () => { usageCalls.push(account); return Promise.reject(error) }
    },
  })
  await collect(pool.stream(OPTIONS))
  await collect(pool.stream(OPTIONS))
  await collect(pool.stream(OPTIONS))
  assert.equal(usageCalls.length, 1, 'three requests in a row must cost at most one usage-endpoint hit')
})

test('stream: a caller abandoning the stream closes the member stream', async () => {
  let closed = false
  async function* longServe(): AsyncIterable<StreamChunk> {
    try {
      yield { type: 'text-delta', index: 0, text: 'a' }
      yield { type: 'text-delta', index: 0, text: 'b' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      closed = true
    }
  }
  const { pool } = makePool({ codex: new FakeAdapter(() => longServe()) })
  for await (const chunk of pool.stream(OPTIONS)) {
    void chunk
    break
  }
  assert.equal(closed, true)
})

test('stream: a post-chunk failure propagates without switching accounts', async () => {
  const codex = new FakeAdapter((_options, account) =>
    account === 'a1' ? servePartial(new LlmError('boom', 'SERVER')) : serveOk('a2'))
  const { pool } = makePool({ codex })
  await assert.rejects(
    collect(pool.stream(OPTIONS)),
    (error: unknown) => error instanceof LlmError && error.code === 'SERVER',
  )
  assert.deepEqual(codex.accounts, ['a1'])
})

test('stream: request-fault failures rethrow without trying other accounts', async () => {
  const codex = new FakeAdapter((_options, account) =>
    account === 'a1'
      ? serveFail(new LlmError('too long', 'CONTEXT_WINDOW_EXCEEDED'))
      : serveOk('a2'))
  const { pool, health } = makePool({ codex })
  await assert.rejects(
    collect(pool.stream(OPTIONS)),
    (error: unknown) => error instanceof LlmError && error.code === 'CONTEXT_WINDOW_EXCEEDED',
  )
  assert.deepEqual(codex.accounts, ['a1'])
  assert.equal(health.isAvailable(memberKey('codex', 'a1', 'm')), true)
})

test('stream: an empty first stream counts as a transient failure', async () => {
  const codex = new FakeAdapter((_options, account) =>
    account === 'a1' ? serveEmpty() : serveOk('a2'))
  const { pool } = makePool({ codex })
  const chunks = await collect(pool.stream(OPTIONS))
  assert.equal((chunks[0] as { text: string }).text, 'a2')
})

test('stream: an exhausted pool throws RATE_LIMIT with the earliest recovery hint', async () => {
  const codex = new FakeAdapter((_options, account) =>
    serveFail(new LlmError(account, 'RATE_LIMIT', {
      providerRetryAfterMs: account === 'a1' ? 42_000 : 90_000,
    })))
  const { pool } = makePool({ codex })
  await assert.rejects(
    collect(pool.stream(OPTIONS)),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'RATE_LIMIT')
      const retryAfter = error.failure.providerRetryAfterMs
      assert.ok(retryAfter !== undefined && retryAfter > 0 && retryAfter <= 42_000)
      return true
    },
  )
})

test('resolveModel uses the pool display name', async () => {
  const family = new Map<string, PoolDefinition>([
    [poolKey('codex', 'm'), {
      members: [
        { provider: 'codex', account: 'a1', model: 'm' },
        { provider: 'codex', account: 'a2', model: 'm' },
      ],
      name: 'GPT-5.4',
      description: 'Latest frontier model.',
    }],
  ])
  const { pool } = makePool({ codex: new FakeAdapter(() => serveOk()) }, { families: family })
  const resolved = await pool.resolveModel('codex', 'm')
  assert.equal(resolved.name, 'GPT-5.4')
  assert.equal(resolved.description, 'Latest frontier model.')
})

test('resolveModel intersects member capabilities conservatively', async () => {
  const first = new FakeAdapter(() => serveOk(), {
    context: { contextWindow: 200_000 },
    defaultMaxTokens: 128_000,
    reasoning: {
      efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('medium'), name: 'Medium' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ],
      defaultEffort: ReasoningEffortId('high'),
    },
    inputModalities: ['text', 'image'],
  })
  const second = new FakeAdapter(() => serveOk(), {
    context: { contextWindow: 100_000 },
    defaultMaxTokens: 64_000,
    reasoning: {
      efforts: [
        { id: ReasoningEffortId('medium'), name: 'Medium' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ],
      defaultEffort: ReasoningEffortId('medium'),
    },
    inputModalities: ['text'],
  })
  const family = new Map<string, PoolDefinition>([
    [poolKey('codex', 'smart'), {
      members: [
        { provider: 'codex', account: 'a1', model: 'big' },
        { provider: 'claude', account: 'a1', model: 'small' },
      ],
      extra: true,
    }],
  ])
  const { pool } = makePool({ codex: first, claude: second }, { families: family })
  const resolved = await pool.resolveModel('codex', 'smart')
  assert.equal(resolved.context?.contextWindow, 100_000)
  assert.equal(resolved.defaultMaxTokens, 64_000)
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['medium', 'high'])
  assert.equal(resolved.reasoning?.defaultEffort, 'high')
  assert.deepEqual(resolved.inputModalities, ['text'])
})

/** A member whose resolveModel always fails (misconfigured id, logged out). */
class FailingResolveAdapter extends FakeAdapter {
  constructor() {
    super(() => serveOk())
  }

  override resolveOwnModel(): Promise<LlmResolvedModelInfo> {
    return Promise.reject(new LlmError('logged out', 'AUTH'))
  }
}

test('resolveModel skips a member that fails to resolve and warns once', async () => {
  const ok = new FakeAdapter(() => serveOk(), { context: { contextWindow: 200_000 } })
  const family = new Map<string, PoolDefinition>([
    [poolKey('codex', 'smart'), {
      members: [
        { provider: 'codex', account: 'a1', model: 'm' },
        { provider: 'claude', account: 'a1', model: 'm' },
      ],
    }],
  ])
  const { pool, warnings } = makePool({ codex: ok, claude: new FailingResolveAdapter() }, { families: family })
  const resolved = await pool.resolveModel('codex', 'smart')
  assert.equal(resolved.context?.contextWindow, 200_000)
  await pool.resolveModel('codex', 'smart')
  assert.equal(warnings.filter(message => message.includes('failed to resolve')).length, 1)
})

test('resolveModel throws NO_ADAPTER only when every member fails to resolve', async () => {
  const { pool } = makePool({
    codex: new FailingResolveAdapter(),
  })
  await assert.rejects(
    pool.resolveModel('codex', 'm'),
    (error: unknown) => error instanceof LlmError && error.code === 'NO_ADAPTER',
  )
})

test('resolveModel reports unknown modalities when members share none', async () => {
  const family = new Map<string, PoolDefinition>([
    [poolKey('codex', 'smart'), {
      members: [
        { provider: 'codex', account: 'a1', model: 'vision' },
        { provider: 'claude', account: 'a1', model: 'text' },
      ],
    }],
  ])
  const { pool } = makePool({
    codex: new FakeAdapter(() => serveOk(), { inputModalities: ['image'] }),
    claude: new FakeAdapter(() => serveOk(), { inputModalities: ['text'] }),
  }, { families: family })
  const resolved = await pool.resolveModel('codex', 'smart')
  assert.equal(resolved.inputModalities, undefined)
})

test('resolveModel: a pool id equal to the catalog wire id cannot recurse', async () => {
  const codex = new FakeAdapter(() => serveOk(), { context: { contextWindow: 100_000 } })
  const { pool } = makePool({ codex })
  const resolved = await pool.resolveModel('codex', 'm')
  assert.equal(resolved.context?.contextWindow, 100_000)
  assert.equal(codex.directResolves, 0, 'member resolution went through resolveOwnModel')
})

for (const provider of ['claude', 'codex'] as const) {
  test(`quota_aware: ${provider} gives a bounded preference to its approaching weekly reset`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 30) })
    const adapter = new FakeAdapter((_options, account) => serveOk(account))
    const families = new Map([[poolKey(provider, 'm'), { members: [
      { provider, account: 'a1', model: 'm' }, { provider, account: 'a2', model: 'm' },
    ] }]])
    const { pool } = makePool({ [provider]: adapter }, { strategy: 'quota_aware', families, usage: usageFetchers({
      [`${provider}/a1`]: weeklyUsage(20, 2 * DAY_MS),
      [`${provider}/a2`]: weeklyUsage(50, 2 * 60 * 60_000),
    }) })
    await collect(pool.stream({ ...OPTIONS, provider }))
    assert.deepEqual(adapter.accounts, ['a2'])
  })
}

test('quota_aware: finishes a small ChatGPT remainder without overriding a healthy sticky session', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 30) })
  const data = { 'codex/a1': weeklyUsage(80, 2 * DAY_MS), 'codex/a2': weeklyUsage(70, 2 * DAY_MS) }
  const adapter = new FakeAdapter((_options, account) => serveOk(account))
  const { pool, usage } = makePool({ codex: adapter }, { strategy: 'quota_aware', usage: usageFetchers(data) })
  const existing = { ...OPTIONS, sessionId: SessionId('established') }
  await collect(pool.stream(existing))
  assert.deepEqual(adapter.accounts, ['a2'])
  data['codex/a1'] = weeklyUsage(97, 2 * DAY_MS)
  usage.invalidate('codex')
  await collect(pool.stream({ ...OPTIONS, sessionId: SessionId('new') }))
  await collect(pool.stream(existing))
  assert.deepEqual(adapter.accounts, ['a2', 'a1', 'a2'])
  data['codex/a2'] = weeklyUsage(100, 2 * DAY_MS)
  usage.invalidate('codex')
  await collect(pool.stream(existing))
  assert.deepEqual(adapter.accounts, ['a2', 'a1', 'a2', 'a1'])
})

test('quota_aware: reset urgency and finishing compete using the same bounded score', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 30) })
  const adapter = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex: adapter }, { strategy: 'quota_aware', usage: usageFetchers({
    'codex/a1': weeklyUsage(97, 5 * DAY_MS),
    'codex/a2': weeklyUsage(50, 30 * 60_000),
  }) })
  await collect(pool.stream(OPTIONS))
  assert.deepEqual(adapter.accounts, ['a2'])
})

test('quota_aware: drains one ChatGPT remainder when every account has only a few percent left', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 30) })
  const adapter = new FakeAdapter((_options, account) => serveOk(account))
  const data = {
    'codex/a1': weeklyUsage(98, 2 * DAY_MS),
    'codex/a2': weeklyUsage(97, 2 * DAY_MS),
    'codex/a3': weeklyUsage(96, 2 * DAY_MS),
  }
  const families = new Map([[poolKey('codex', 'm'), { members: ['a3', 'a2', 'a1'].map(account => ({
    provider: 'codex' as const, account, model: 'm',
  })) }]])
  const { pool, usage } = makePool({ codex: adapter }, { strategy: 'quota_aware', families, usage: usageFetchers(data) })
  await collect(pool.stream(OPTIONS))
  data['codex/a1'] = weeklyUsage(99.9, 2 * DAY_MS)
  usage.invalidate('codex')
  await collect(pool.stream(OPTIONS))
  data['codex/a1'] = weeklyUsage(100, 2 * DAY_MS)
  usage.invalidate('codex')
  await collect(pool.stream(OPTIONS))
  assert.deepEqual(adapter.accounts, ['a1', 'a1', 'a2'])
})

test('quota_aware: simultaneous cold selections distribute first-byte waits across accounts and model pools', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 30) })
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  let count = 0
  const adapter = new FakeAdapter(async function* (_options, account) {
    if (++count === 4) started.resolve()
    await gate.promise
    yield* serveOk(account)
  })
  const families = new Map(['m', 'm2'].map(model => [poolKey('codex', model), { members: [
    { provider: 'codex' as const, account: 'a1', model }, { provider: 'codex' as const, account: 'a2', model },
  ] }]))
  const { pool } = makePool({ codex: adapter }, { strategy: 'quota_aware', families,
    usage: usageFetchers({ codex: windowUsage(50, 5 * 60 * 60_000) }) })
  const iterators = ['m', 'm2', 'm', 'm2'].map(model => pool.stream({ ...OPTIONS, model })[Symbol.asyncIterator]())
  const reads = iterators.map(iterator => iterator.next())
  try {
    await Promise.race([started.promise, Promise.all(reads)])
    assert.deepEqual(adapter.accounts, ['a1', 'a2', 'a1', 'a2'])
    gate.resolve()
    await Promise.all(reads)
    await iterators[1].return?.()
    await collect(pool.stream(OPTIONS))
    assert.equal(adapter.accounts.at(-1), 'a2', 'released capacity is visible while the other streams remain active')
  } finally {
    gate.resolve()
    await Promise.allSettled(reads)
    await Promise.all(iterators.map(iterator => iterator.return?.()))
  }
  await collect(pool.stream(OPTIONS))
  assert.equal(adapter.accounts.at(-1), 'a1', 'completed and abandoned streams released every reservation')
})

test('quota_aware: load can divert a new request away from an account with a finishing bonus', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 30) })
  const adapter = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex: adapter }, { strategy: 'quota_aware', usage: usageFetchers({
    'codex/a1': weeklyUsage(97, 2 * DAY_MS), 'codex/a2': weeklyUsage(70, 2 * DAY_MS),
  }) })
  const first = pool.stream({ ...OPTIONS, sessionId: SessionId('first') })[Symbol.asyncIterator]()
  try {
    await first.next()
    await collect(pool.stream({ ...OPTIONS, sessionId: SessionId('second') }))
    await collect(pool.stream({ ...OPTIONS, sessionId: SessionId('third') }))
    assert.deepEqual(adapter.accounts, ['a1', 'a2', 'a2'])
  } finally {
    await first.return?.()
  }
  await collect(pool.stream(OPTIONS))
  assert.equal(adapter.accounts.at(-1), 'a1')
})

test('quota_aware: scoped or full windows cannot be bypassed by a reset or finishing bonus', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 30) })
  const adapter = new FakeAdapter((_options, account) => serveOk(account))
  const data: Record<string, ProviderUsage> = {
    'codex/a1': { supported: true, windows: [
      { kind: 'session', usedPercent: 100, resetsAt: Date.now() + 60_000 },
      { kind: 'weekly', usedPercent: 97, resetsAt: Date.now() + 2 * DAY_MS },
    ] },
    'codex/a2': weeklyUsage(20, 2 * DAY_MS),
  }
  const { pool } = makePool({ codex: adapter }, { strategy: 'quota_aware', usage: usageFetchers(data) })
  await collect(pool.stream(OPTIONS))
  assert.deepEqual(adapter.accounts, ['a2'])
})

for (const phase of ['before', 'after', 'abort'] as const) {
  test(`quota_aware: releases account load after ${phase}-output failure`, async () => {
    let failing = true
    const adapter = new FakeAdapter(() => !failing ? serveOk()
      : phase === 'after' ? servePartial(new LlmError('failed', 'SERVER'))
        : serveFail(new LlmError('failed', phase === 'abort' ? 'ABORTED' : 'SERVER')))
    const { pool, health } = makePool({ codex: adapter }, { strategy: 'quota_aware' })
    await assert.rejects(collect(pool.stream(OPTIONS)))
    failing = false
    health.clear('codex')
    await collect(pool.stream(OPTIONS))
    assert.equal(adapter.accounts.at(-1), 'a1')
  })
}

test('quota_aware: cancellation after a shared quota fetch starts no account request', async () => {
  const ready = Promise.withResolvers<void>()
  const fetched = Promise.withResolvers<ProviderUsage>()
  const adapter = new FakeAdapter(() => serveOk())
  const { pool } = makePool({ codex: adapter }, { strategy: 'quota_aware', usage: () => async () => {
    ready.resolve()
    return fetched.promise
  } })
  const controller = new AbortController()
  const result = collect(pool.stream({ ...OPTIONS, signal: controller.signal }))
  await ready.promise
  controller.abort(new Error('cancelled selection'))
  fetched.resolve({ supported: false })
  await assert.rejects(result, /cancelled selection/)
  assert.deepEqual(adapter.accounts, [])
  await collect(pool.stream(OPTIONS))
  assert.deepEqual(adapter.accounts, ['a1'])
})

test('pool affinity stays separate when providers share the same model id', async () => {
  let failClaude = true
  const claude = new FakeAdapter((_options, account) => failClaude && account === 'a1'
    ? serveFail(new LlmError('unavailable', 'SERVER')) : serveOk(account))
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const families = new Map((['claude', 'codex'] as const).map(provider => [poolKey(provider, 'm'), { members:
    ['a1', 'a2'].map(account => ({ provider, account, model: 'm' })),
  }]))
  const { pool, health } = makePool({ claude, codex }, { families })
  const options = { ...OPTIONS, sessionId: SessionId('shared-model-name') }
  await collect(pool.stream({ ...options, provider: 'claude' }))
  await collect(pool.stream(options))
  failClaude = false
  health.clear('claude')
  await collect(pool.stream({ ...options, provider: 'claude' }))
  assert.deepEqual(claude.accounts, ['a1', 'a2', 'a2'])
  assert.deepEqual(codex.accounts, ['a1'])
})

test('quota_aware: a zero load weight preserves configured order for equal scores', async () => {
  const adapter = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex: adapter }, { strategy: 'quota_aware', scheduling: { loadPenalty: 0 } })
  const streams = [pool.stream(OPTIONS)[Symbol.asyncIterator](), pool.stream(OPTIONS)[Symbol.asyncIterator]()]
  try {
    await Promise.all(streams.map(stream => stream.next()))
    assert.deepEqual(adapter.accounts, ['a1', 'a1'])
  } finally {
    await Promise.all(streams.map(stream => stream.return?.()))
  }
})

test('quota_aware: a member whose cooldown ends after the quota snapshot is still tried', async () => {
  const adapter = new FakeAdapter((_options, account) =>
    account === 'a1' ? serveFail(new LlmError('connection lost', 'TRANSPORT')) : serveOk(account))
  const { pool, health } = makePool({ codex: adapter }, {
    strategy: 'quota_aware',
    usage: (_provider, account) => async () => {
      if (account === 'a1') await new Promise(resolve => setTimeout(resolve, 300))
      return { supported: true, windows: [{ kind: 'weekly' as const, usedPercent: 10 }] }
    },
  })
  // a2 is cooling when the quota snapshot is taken, so it reads no quota at
  // all; by the time a1 fails over, that cooldown is over.
  health.markUnavailable(accountKey('codex', 'a2'), 150, 'RATE_LIMIT')
  const chunks = await collect(pool.stream(OPTIONS))
  assert.deepEqual(adapter.accounts, ['a1', 'a2'])
  assert.equal((chunks[0] as { text: string }).text, 'a2')
})

// ---------------------------------------------------------------------------
// The Claude usage floors: an account past either floor is not selected at all,
// because an account ranked last is still chosen once its siblings are cooling
// ---------------------------------------------------------------------------

/** One window in the shape the usage tracker reports. */
interface FloorWindow {
  kind: 'session' | 'weekly' | 'other'
  usedPercent: number
  resetsAt?: number
}

/** A two-account Claude pool of one catalog model. */
function claudeFloorFamilies(): Map<string, PoolDefinition> {
  return new Map([[poolKey('claude', 'm'), { members: [
    { provider: 'claude' as const, model: 'm', account: 'a1' },
    { provider: 'claude' as const, model: 'm', account: 'a2' },
  ] }]])
}

/** A two-account Claude pool whose per-account windows come from `windowsFor`. */
function claudeFloorPool(
  windowsFor: (account: string) => FloorWindow[],
  scheduling?: Partial<PoolSchedulingPolicy>,
) {
  const adapter = new FakeAdapter(() => serveOk())
  const families = claudeFloorFamilies()
  const harness = makePool({ claude: adapter }, {
    families,
    usage: (_provider, account) => async () => ({ supported: true, windows: windowsFor(account) }),
    ...scheduling === undefined ? {} : { scheduling },
  })
  return { ...harness, adapter }
}

const CLAUDE_OPTIONS: GenerateOptions = { ...OPTIONS, provider: 'claude' }

test('a Claude account at or above the session floor is not selected', async () => {
  for (const [usedPercent, expected] of [[49, ['a1']], [50, ['a2']], [70, ['a2']]] as const) {
    const { adapter, pool } = claudeFloorPool(account =>
      account === 'a1' ? [{ kind: 'session', usedPercent }] : [{ kind: 'session', usedPercent: 10 }])
    await collect(pool.stream(CLAUDE_OPTIONS))
    assert.deepEqual(adapter.accounts, [...expected], `session ${String(usedPercent)}%`)
  }
})

test('a Claude account at or above the weekly floor is not selected', async () => {
  for (const [usedPercent, expected] of [[88, ['a1']], [89, ['a2']], [95, ['a2']]] as const) {
    const { adapter, pool } = claudeFloorPool(account =>
      account === 'a1' ? [{ kind: 'weekly', usedPercent }] : [{ kind: 'weekly', usedPercent: 10 }])
    await collect(pool.stream(CLAUDE_OPTIONS))
    assert.deepEqual(adapter.accounts, [...expected], `weekly ${String(usedPercent)}%`)
  }
})

test('the floors are configurable, and other providers keep their own rule', async () => {
  // Raised past the account's own usage, the same account becomes selectable again.
  const raised = claudeFloorPool(
    account => account === 'a1' ? [{ kind: 'session', usedPercent: 60 }] : [{ kind: 'session', usedPercent: 10 }],
    { claudeSessionPercentFloor: 90 },
  )
  await collect(raised.pool.stream(CLAUDE_OPTIONS))
  assert.deepEqual(raised.adapter.accounts, ['a1'])

  // A codex account high in its weekly window is still selected: the floors are Claude's.
  const codexAdapter = new FakeAdapter(() => serveOk())
  const codex = makePool({ codex: codexAdapter }, {
    usage: (_provider, account) => async () => ({
      supported: true,
      windows: [{ kind: 'weekly' as const, usedPercent: account === 'a1' ? 95 : 10 }],
    }),
  })
  await collect(codex.pool.stream(OPTIONS))
  assert.deepEqual(codexAdapter.accounts, ['a1'])
})

test('the usage card counts a peer only when the pool would accept it', async () => {
  // `a1` is parked, so the card must say whether another account can serve in its place.
  // Health alone is not that answer on a route with usage floors: a peer past its Claude
  // floor is one the pool would hold back, so no failover exists to report.
  const run = async (usedPercent: number): Promise<UsagePoolState> => {
    const harness = claudeFloorPool(account =>
      account === 'a1' ? [{ kind: 'session', usedPercent: 5 }] : [{ kind: 'session', usedPercent }])
    harness.health.markUnavailable(accountKey('claude', 'a1'), 60_000, 'RATE_LIMIT')
    return await usagePoolState(harness.health, harness.pool, 'claude', 'a1', ['a1', 'a2'], () => true)
  }
  const served = await run(5)
  assert.equal(served.peerAvailable, true, 'a peer the pool would select is a peer')
  assert.equal(served.coolingReason, 'quota')
  assert.ok(served.coolingUntil !== undefined && served.coolingUntil > Date.now())
  assert.equal((await run(50)).peerAvailable, false, 'a peer past its session floor cannot serve')

  // A pool that is not wired keeps the health-only answer, and an account outside the
  // pool (its own preference) is not a peer either.
  const harness = claudeFloorPool(() => [{ kind: 'session', usedPercent: 5 }])
  assert.equal((await usagePoolState(harness.health, undefined, 'claude', 'a1', ['a2'], () => true)).peerAvailable, true)
  assert.equal((await usagePoolState(harness.health, harness.pool, 'claude', 'a1', ['a2'], () => false)).peerAvailable, false)
  assert.equal((await usagePoolState(harness.health, harness.pool, 'claude', 'a1', ['a1'], () => true)).peerAvailable, false)
})

test('a Claude account past every floor leaves the pool with no usable member', async () => {
  // Every member is past its floor, so the route reports the state that caused it rather than
  // starting a turn it cannot finish.
  const { pool } = claudeFloorPool(() => [{ kind: 'session', usedPercent: 60 }])
  await assert.rejects(collect(pool.stream(CLAUDE_OPTIONS)), error => {
    assert.equal((error as { code?: string }).code, 'RATE_LIMIT')
    return true
  })
})

test('a usage poll that fails after a real one still applies the floor that poll reported', async () => {
  let reachable = true
  const adapter = new FakeAdapter(() => serveOk())
  const harness = makePool({ claude: adapter }, {
    families: claudeFloorFamilies(),
    usage: (_provider, account) => async () => {
      if (!reachable) {
        throw new OAuthEndpointError('claude usage token endpoint error (HTTP 429)', 429, undefined, 60_000)
      }
      return { supported: true, windows: [{ kind: 'session' as const, usedPercent: account === 'a1' ? 60 : 5 }] }
    },
  })
  await collect(harness.pool.stream(CLAUDE_OPTIONS))
  assert.deepEqual(adapter.accounts, ['a2'], 'a1 is past the session floor')
  // The display keeps the last real snapshot; the routing view degrades to a
  // zero-score failure while still holding the floor that snapshot established.
  reachable = false
  assert.deepEqual(await harness.usage.snapshotFor('claude', 'a1', true), {
    supported: true,
    windows: [{ kind: 'session', usedPercent: 60 }],
  })
  await collect(harness.pool.stream(CLAUDE_OPTIONS))
  assert.deepEqual(adapter.accounts, ['a2', 'a2'], 'an unreachable usage endpoint cannot make a spent allowance selectable')
  // An enforcement failure drops the cached snapshot before the next poll. The
  // floor still applies: the earlier poll observed a spent allowance, and a poll
  // that cannot run is no evidence that the allowance came back.
  harness.usage.invalidate('claude', 'a1')
  await collect(harness.pool.stream(CLAUDE_OPTIONS))
  assert.deepEqual(adapter.accounts, ['a2', 'a2', 'a2'], 'a dropped snapshot must not wash out a spent allowance')
})

test('a pool held back only by the floors reports the earliest window reset as its wait', async () => {
  const now = Date.now()
  const { pool } = claudeFloorPool(account => [{
    kind: 'session',
    usedPercent: 60,
    resetsAt: account === 'a1' ? now + 90_000 : now + 300_000,
  }])
  await assert.rejects(collect(pool.stream(CLAUDE_OPTIONS)), error => {
    assert.equal((error as { code?: string }).code, 'RATE_LIMIT')
    const retryAfter = (error as LlmError).failure.providerRetryAfterMs
    assert.ok(retryAfter !== undefined && retryAfter > 0 && retryAfter <= 90_000, `retry hint ${String(retryAfter)}`)
    return true
  })

  // A window under its floor releases nothing when it resets, so it must not
  // shorten the hint: the session window resetting in a minute leaves the
  // account blocked by its weekly window for days either way.
  const fiveDays = 5 * 24 * 60 * 60_000
  const twoWindow = claudeFloorPool(() => [
    { kind: 'weekly', usedPercent: 95, resetsAt: now + fiveDays },
    { kind: 'session', usedPercent: 20, resetsAt: now + 60_000 },
  ])
  await assert.rejects(collect(twoWindow.pool.stream(CLAUDE_OPTIONS)), error => {
    assert.equal((error as { code?: string }).code, 'RATE_LIMIT')
    const retryAfter = (error as LlmError).failure.providerRetryAfterMs
    assert.ok(retryAfter !== undefined && retryAfter > 60_000, `retry hint ${String(retryAfter)}`)
    return true
  })
})

// ---------------------------------------------------------------------------
// A pool that ran out says why: every member failing for one reason reports it
// ---------------------------------------------------------------------------

test('an exhausted pool reports the reason its members failed, not a blanket rate limit', async () => {
  for (const [failure, expected] of [
    [new LlmError('login expired', 'MISSING_CREDENTIAL'), 'MISSING_CREDENTIAL'],
    [new LlmError('upstream exploded', 'SERVER'), 'SERVER'],
  ] as const) {
    const adapter = new FakeAdapter(() => serveFail(failure))
    const { pool } = makePool({ codex: adapter })
    await assert.rejects(collect(pool.stream({ ...OPTIONS, sessionId: SessionId(`reason-${expected}`) })), error => {
      assert.equal((error as { code?: string }).code, expected)
      return true
    })
  }
})

test('a credential refusal from the second member surfaces instead of an exhausted rate limit', async () => {
  const refused = new LlmError('login expired', 'MISSING_CREDENTIAL')
  const adapter = new FakeAdapter((_options, account) => serveFail(account === 'a1'
    ? new LlmError('slow down', 'RATE_LIMIT', { providerRetryAfterMs: 60_000 })
    : refused))
  const { pool } = makePool({ codex: adapter })
  await assert.rejects(collect(pool.stream(OPTIONS)), error => {
    // The sibling's rate limit must not launder the refusal into a retryable code.
    assert.equal(error, refused)
    return true
  })
  assert.deepEqual(adapter.accounts, ['a1', 'a2'])
})

test('an exhausted pool reports an enforcement refusal over any other member reason', async () => {
  const adapter = new FakeAdapter(() => serveOk())
  const { pool, health } = makePool({ codex: adapter })
  health.markUnavailable(accountKey('codex', 'a2'), 60_000, ENFORCEMENT_CODE)
  health.markUnavailable(memberKey('codex', 'a1', 'm'), 60_000, 'RATE_LIMIT')
  await assert.rejects(collect(pool.stream(OPTIONS)), error => {
    assert.equal((error as { code?: string }).code, ENFORCEMENT_CODE)
    return true
  })
  assert.equal(adapter.calls, 0, 'both members are parked, so neither is contacted')
})

test('an exhausted pool parked entirely by auth failures reports the auth code, not a rate limit', async () => {
  const adapter = new FakeAdapter(() => serveOk())
  const { pool, health } = makePool({ codex: adapter })
  for (const account of ['a1', 'a2']) health.markUnavailable(accountKey('codex', account), 60_000, 'MISSING_CREDENTIAL')
  await assert.rejects(collect(pool.stream(OPTIONS)), error => {
    assert.equal((error as { code?: string }).code, 'MISSING_CREDENTIAL')
    return true
  })
  assert.equal(adapter.calls, 0, 'every account is already parked, so none is contacted')
})
