/**
 * Login-gated model catalogs and live discovery: `listModels` returns [] when
 * logged out, maps discovered catalogs when logged in (via an injected fetch,
 * no network), and falls back to the static catalog with a warning on
 * discovery failure.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import './keep-alive.js'
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, Message } from '@deepseek-ai/dsh-llm'
import { CodexAdapter, codexRequestBody, fetchCodexModels } from '../src/providers/codex.js'
import { GrokAdapter } from '../src/providers/grok.js'
import { ClaudeAdapter, claudeThinkingBody, fetchClaudeCatalogue } from '../src/providers/claude.js'
import { claudeBuiltInCatalogue, claudeCatalogueListing } from '../src/providers/claude-catalogue.js'
import { claudeDocumentedLimits, claudeModelLimits, claudeProfileLimits } from '../src/providers/claude-model-limits.js'
import { CLAUDE_CODE_2_1_288_PROFILE } from '@tormentalabs/claude-code-wire-compat'
import { CopilotAdapter, fetchCopilotModels } from '../src/providers/copilot.js'
import { ModelCatalogCache, OAuthEndpointError } from '../src/providers/common.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { AccountAwareAdapter } from '../src/providers/accounts.js'
import type { CatalogFailure, CatalogPersistence, CatalogRecord, CatalogSnapshot, CatalogStoreFactory, FetchFn } from '../src/providers/common.js'
import type { ClaudeSession, CodexSession, CopilotSession, GrokSession } from '../src/auth/store.js'
import { withTimeout } from '../src/providers/common.js'

const STATIC_CODEX = [{ id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' }]
const STATIC_CLAUDE = [{ id: 'claude-opus-4-5', name: 'Claude Opus 4.5' }]
const STATIC_GROK = [{ id: 'grok-4', name: 'Grok 4' }]

/**
 * Older than the route's default freshness window (24 h), so an explicit
 * refresh is eligible to replace it and a read still serves it as-is.
 */
const PAST_FRESHNESS_MS = 25 * 60 * 60_000

test('Codex context overrides clamp per account, restore defaults, and distrust missing maxima', async () => {
  let requested: number | undefined = 512_000
  const sessions = {
    pro: { accessToken: 'pro', refreshToken: 'r', accountId: 'pro', expiresAt: Date.now() + 3600000 },
    plus: { accessToken: 'plus', refreshToken: 'r', accountId: 'plus', expiresAt: Date.now() + 3600000 },
  }
  const adapter = new CodexAdapter({
    models: [], discovery: true, tokens: memoryAccounts(sessions), streamIdleTimeoutMs: 1000,
    contextWindowOf: () => requested,
    fetchFn: (async (_url, init) => new Response(JSON.stringify({ models: [
      { slug: 'm', context_window: 272000, max_context_window: new Headers(init?.headers).get('chatgpt-account-id') === 'pro' ? 872000 : 300000 },
      { slug: 'unknown-max', context_window: 272000 },
    ] }))) as FetchFn,
  })
  // Each account's ceiling is discovered per account, at an explicit refresh.
  await primeCatalog(adapter, 'codex', 'pro')
  await primeCatalog(adapter, 'codex', 'plus')
  assert.equal((await adapter.resolveOwnModel('codex', 'm', 'pro')).context?.contextWindow, 512000)
  assert.equal((await adapter.resolveOwnModel('codex', 'm', 'plus')).context?.contextWindow, 300000)
  assert.equal((await adapter.resolveOwnModel('codex', 'unknown-max', 'pro')).context?.contextWindow, 272000)
  requested = undefined
  assert.equal((await adapter.resolveOwnModel('codex', 'm', 'pro')).context?.contextWindow, 272000)
  requested = 128000
  assert.equal((await adapter.resolveOwnModel('codex', 'm', 'pro')).context?.contextWindow, 128000)
})

const codexSession: CodexSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  accountId: 'acct-1',
}
const claudeSession: ClaudeSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  scopes: 'scope',
}
const grokSession: GrokSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  tokenEndpoint: 'https://auth.x.ai/token',
}
const copilotSession: CopilotSession = {
  accessToken: 'copilot-at',
  refreshToken: 'gh-token',
  expiresAt: Date.now() + 3_600_000,
}

/** An AccountTokenManager over several in-memory sessions (insertion order = default first). */
function memoryAccounts<S extends { accessToken: string; refreshToken: string; expiresAt: number }>(
  accounts: Record<string, S>,
): AccountTokenManager<S> {
  const stored = new Map(Object.entries(accounts))
  return new AccountTokenManager<S>({
    provider: 'codex',
    displayName: 'Test',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: session => Promise.resolve(session),
      isPermanent: () => false,
    }),
    io: {
      list: () => Promise.resolve([...stored.entries()].map(([key, session]) => ({ key, session }))),
      get: account => Promise.resolve(
        account === undefined ? stored.values().next().value : stored.get(account),
      ),
      save: (account, session) => {
        stored.set(account, session)
        return Promise.resolve()
      },
      remove: account => {
        stored.delete(account)
        return Promise.resolve()
      },
    },
  })
}

/** An AccountTokenManager over an in-memory session; refresh never fires in these tests. */
function memoryTokens<S extends { accessToken: string; refreshToken: string; expiresAt: number }>(
  initial: S | undefined,
): AccountTokenManager<S> {
  let stored = initial
  return new AccountTokenManager<S>({
    provider: 'codex',
    displayName: 'Test',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: session => Promise.resolve(session),
      isPermanent: () => false,
    }),
    io: {
      list: () => Promise.resolve(stored === undefined ? [] : [{ key: 'acct', session: stored }]),
      get: () => Promise.resolve(stored),
      save: (_account, session) => {
        stored = session
        return Promise.resolve()
      },
      remove: () => {
        stored = undefined
        return Promise.resolve()
      },
    },
  })
}

/** A fetch implementation answering one JSON payload; records invocation count. */
function fakeFetch(payload: unknown, status = 200): { fetchFn: FetchFn; calls: () => number } {
  let calls = 0
  const fetchFn: FetchFn = (() => {
    calls += 1
    return Promise.resolve(new Response(JSON.stringify(payload), { status }))
  }) as FetchFn
  return { fetchFn, calls: () => calls }
}

function codexAdapter(overrides: {
  session?: CodexSession
  discovery?: boolean
  fetchFn?: FetchFn
  warnings?: string[]
  defaultEffortOf?: (model: string) => string | undefined
  discoveryTimeoutMs?: number
}): CodexAdapter {
  return new CodexAdapter({
    models: STATIC_CODEX,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(overrides.session),
    discovery: overrides.discovery ?? true,
    ...overrides.fetchFn === undefined ? {} : { fetchFn: overrides.fetchFn },
    ...overrides.warnings === undefined
      ? {}
      : { onWarn: (message: string) => { overrides.warnings?.push(message) } },
    ...overrides.defaultEffortOf === undefined ? {} : { defaultEffortOf: overrides.defaultEffortOf },
    ...overrides.discoveryTimeoutMs === undefined ? {} : { discoveryTimeoutMs: overrides.discoveryTimeoutMs },
  })
}

/** One release-on-demand barrier, so a pending request is a state, not a delay. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

const CODEX_MODELS_PAYLOAD = {
  models: [
    {
      slug: 'gpt-5.2-codex',
      display_name: 'GPT-5.2 Codex',
      description: 'newest',
      context_window: 500_000,
      supported_reasoning_levels: [
        { effort: 'low', description: 'fast' },
        { effort: 'high', description: 'thorough' },
      ],
      default_reasoning_level: 'high',
      visibility: 'list',
      priority: 2,
    },
    {
      slug: 'gpt-5.1-codex',
      display_name: 'GPT-5.1 Codex',
      visibility: 'list',
      priority: 1,
    },
    { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide', priority: 0 },
    { slug: 'gpt-none', display_name: 'None', visibility: 'none', priority: 0 },
  ],
}

test('listModels returns [] when logged out (codex, claude, grok)', async () => {
  const codex = codexAdapter({})
  assert.deepEqual(await codex.listModels('codex'), [])
  const claude = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens<ClaudeSession>(undefined),
    discovery: false,
  })
  assert.deepEqual(await claude.listModels('claude'), [])
  const grok = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens<GrokSession>(undefined),
    discovery: true,
    fetchFn: fakeFetch({ data: [{ id: 'grok-9' }] }).fetchFn,
  })
  assert.deepEqual(await grok.listModels('grok'), [])
})

test('codex catalog version gates GPT-6 and supports an explicit compatibility override', async () => {
  const seen: string[] = []
  const fetchFn: FetchFn = async (input) => {
    const version = new URL(String(input)).searchParams.get('client_version') ?? ''
    seen.push(version)
    return new Response(JSON.stringify({ models: version === '0.147.0'
      ? [{ slug: 'gpt-5.6-sol' }]
      : [{ slug: 'gpt-6-astra', visibility: 'list', supported_reasoning_levels: [{ effort: 'max' }] }, { slug: 'hidden', visibility: 'hide' }],
    }))
  }
  assert.deepEqual((await fetchCodexModels(codexSession, fetchFn)).map(model => model.id), ['gpt-6-astra'])
  assert.deepEqual((await fetchCodexModels(codexSession, fetchFn, undefined, '0.147.0')).map(model => model.id), ['gpt-5.6-sol'])
  assert.deepEqual(seen, ['0.153.4', '0.147.0'])
  await assert.rejects(() => fetchCodexModels(codexSession, fetchFn, undefined, '0.153.4&bad=1'), /codexClientVersion/)
  assert.equal(seen.length, 2, 'invalid versions must not reach the network')
})

test('codex catalog refresh invalidates all accounts and preserves configured version', async () => {
  let fresh = false
  const calls: string[] = []
  const adapter = new CodexAdapter({
    models: STATIC_CODEX, streamIdleTimeoutMs: 1000, discovery: true,
    clientVersion: '0.154.0-alpha.3',
    resolveClientVersion: async () => { throw new Error('explicit version must bypass lookup') },
    tokens: memoryAccounts({ first: codexSession, second: { ...codexSession, accountId: 'second' } }),
    fetchFn: async (input) => {
      assert.equal(new URL(String(input)).searchParams.get('client_version'), '0.154.0-alpha.3')
      calls.push(String(input))
      return new Response(JSON.stringify({ models: [{ slug: fresh ? 'gpt-6-astra' : 'gpt-5.6-sol' }] }))
    },
  })
  /** Refresh both accounts explicitly, then read the union. */
  const refreshed = async (): Promise<string[]> => {
    await primeCatalog(adapter, 'codex', 'first')
    await primeCatalog(adapter, 'codex', 'second')
    return (await adapter.listModels('codex')).map(model => model.id)
  }
  assert.deepEqual(await refreshed(), ['gpt-5.6-sol'])
  assert.equal(calls.length, 2)
  fresh = true
  assert.deepEqual(await refreshed(), ['gpt-5.6-sol'], 'a fresh entry is not re-requested')
  assert.equal(calls.length, 2)
  adapter.clearAccountCatalog()
  assert.deepEqual(await refreshed(), ['gpt-6-astra'])
  assert.equal(calls.length, 4, 'both accounts are fetched again after their caches were dropped')
})

test('codex adapter uses the automatic compatibility version for catalog requests', async () => {
  let lookups = 0
  const adapter = new CodexAdapter({
    models: STATIC_CODEX, streamIdleTimeoutMs: 1000, discovery: true,
    tokens: memoryTokens(codexSession),
    resolveClientVersion: async () => { lookups++; return '0.155.0' },
    fetchFn: async (input) => {
      assert.equal(new URL(String(input)).searchParams.get('client_version'), '0.155.0')
      return Response.json({ models: [{ slug: 'gpt-6-astra' }] })
    },
  })
  await primeCatalog(adapter, 'codex')
  assert.deepEqual((await adapter.listModels('codex')).map(model => model.id), ['gpt-6-astra'])
  await primeCatalog(adapter, 'codex')
  assert.equal(lookups, 1, 'a cached model list needs no version lookup')
})

test('codex discovery maps, filters hidden entries, and sorts by priority', async () => {
  const { fetchFn, calls } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = codexAdapter({ session: codexSession, fetchFn })
  await primeCatalog(adapter, 'codex')
  const models = await adapter.listModels('codex')
  assert.deepEqual(models.map(model => model.id), ['gpt-5.1-codex', 'gpt-5.2-codex'])
  assert.equal(models[1].name, 'GPT-5.2 Codex')
  assert.equal(models[1].description, 'newest')
  // Reads never request: the one request was the explicit refresh above.
  await adapter.listModels('codex')
  assert.equal(calls(), 1)
})

test('resolveModel prefers discovered context window and reasoning efforts', async () => {
  const { fetchFn } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = codexAdapter({ session: codexSession, fetchFn })
  await primeCatalog(adapter, 'codex')
  const resolved = await adapter.resolveModel('codex', 'gpt-5.2-codex')
  assert.equal(resolved.context?.contextWindow, 500_000)
  assert.deepEqual(
    resolved.reasoning?.efforts.map(effort => effort.id),
    ['low', 'high'],
  )
  assert.equal(resolved.reasoning?.defaultEffort, 'high')
  // A model the catalog did not advertise falls back to static defaults.
  const fallback = await adapter.resolveModel('codex', 'gpt-unknown')
  assert.equal(fallback.context?.contextWindow, 400_000)
  assert.equal(fallback.reasoning?.efforts.length, 5)
})

test('a configured default effort wins over the discovered one (codex)', async () => {
  const { fetchFn } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = codexAdapter({
    session: codexSession,
    fetchFn,
    defaultEffortOf: model => model === 'gpt-5.2-codex' ? 'low' : undefined,
  })
  await primeCatalog(adapter, 'codex')
  const resolved = await adapter.resolveModel('codex', 'gpt-5.2-codex')
  assert.equal(resolved.reasoning?.defaultEffort, 'low')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['low', 'high'])
  // Unconfigured models keep the built-in default, untouched by the override.
  const other = await adapter.resolveModel('codex', 'gpt-5.1-codex')
  assert.equal(other.reasoning?.defaultEffort, 'high')
})

test('a configured default the discovered catalog dropped does not reach the wire (codex)', async () => {
  // The discovered catalog is the truth about what the model accepts, so a
  // stale override (a level the backend stopped advertising) must fall back to
  // the provider's own default instead of riding on every request.
  const { fetchFn } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = codexAdapter({
    session: codexSession,
    fetchFn,
    defaultEffortOf: () => 'max',
  })
  await primeCatalog(adapter, 'codex')
  const resolved = await adapter.resolveModel('codex', 'gpt-5.2-codex')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['low', 'high'],
    'an unadvertised level is not invented into the capability set')
  assert.equal(resolved.reasoning?.defaultEffort, 'high', 'the discovered default stands')
})

test('a configured default extends only the built-in fallback list (codex)', async () => {
  // With no discovered catalog the static list is a known-stale fallback, so a
  // configured level it omits still has to be selectable — otherwise a newly
  // shipped tier could never be chosen.
  const adapter = codexAdapter({
    session: codexSession,
    fetchFn: fakeFetch(CODEX_MODELS_PAYLOAD).fetchFn,
    discovery: false,
    defaultEffortOf: () => 'ultra',
  })
  const resolved = await adapter.resolveModel('codex', 'gpt-5.2-codex')
  const ids: string[] = (resolved.reasoning?.efforts ?? []).map(effort => String(effort.id))
  assert.ok(ids.includes('ultra'), 'the configured level joins the fallback set')
  assert.equal(resolved.reasoning?.defaultEffort, 'ultra')
  assert.ok(ids.includes('high'), 'the fallback levels survive alongside it')
})

test('a configured default cannot invent a reasoning block for claude', async () => {
  // Claude advertises efforts only through its live catalog; a model it does
  // not cover exposes none, so the harness rejects an explicit effort before
  // provider I/O rather than letting the API 400. A configured default must
  // not manufacture the capability.
  const claude = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    discovery: false,
    defaultEffortOf: () => 'high',
  })
  assert.equal((await claude.resolveModel('claude', 'claude-opus-4-5')).reasoning, undefined)
  // Same with no configured default at all: unchanged from before the feature.
  const plain = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    discovery: false,
  })
  assert.equal((await plain.resolveModel('claude', 'claude-opus-4-5')).reasoning, undefined)
})

test('the pinned catalogue is what advertises claude reasoning efforts', async () => {
  // The effort levels come from the pinned profile, not from discovery: the adapter below
  // never reads a catalog, and the settings surface still has to offer what the model accepts.
  const claude = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    discovery: false,
  })
  // `effort` carries low/medium/high, `xhigh_effort` adds xhigh and `max_effort` adds max.
  const sonnet5 = await claude.resolveModel('claude', 'claude-sonnet-5')
  assert.deepEqual(sonnet5.reasoning?.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(sonnet5.reasoning?.efforts[3].name, 'Extra High')
  // The catalogue's own `default_effort` is what the picker preselects.
  assert.equal(sonnet5.reasoning?.defaultEffort, 'high')
  const sonnet46 = await claude.resolveModel('claude', 'claude-sonnet-4-6')
  assert.deepEqual(sonnet46.reasoning?.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'max'])
  assert.equal(sonnet46.reasoning?.defaultEffort, undefined, 'a model the catalogue gives no default keeps none')
  assert.equal((await claude.resolveModel('claude', 'claude-opus-5-5')).reasoning?.defaultEffort, 'medium')
  // A model whose entry carries no effort flag advertises none, so a level cannot be chosen
  // for it in the first place.
  assert.equal((await claude.resolveModel('claude', 'claude-opus-4-5')).reasoning, undefined)
  assert.equal((await claude.resolveModel('claude', 'claude-3-7-sonnet')).reasoning, undefined)
})

test('codex discovery failure falls back to the static catalog with a warning', async () => {
  const warnings: string[] = []
  const { fetchFn } = fakeFetch({ error: 'boom' }, 500)
  const adapter = codexAdapter({ session: codexSession, fetchFn, warnings })
  await primeCatalog(adapter, 'codex')
  const models = await adapter.listModels('codex')
  assert.deepEqual(models.map(model => model.id), ['gpt-5.1-codex'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /codex model catalogue refresh failed/)
})

test('codex config override wins over discovery entirely', async () => {
  const { fetchFn, calls } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = codexAdapter({ session: codexSession, fetchFn, discovery: false })
  // Even an explicit refresh is a no-op: the configured catalog is the answer.
  await primeCatalog(adapter, 'codex')
  const models = await adapter.listModels('codex')
  assert.deepEqual(models.map(model => model.id), ['gpt-5.1-codex'])
  assert.equal(calls(), 0)
})

test('grok discovery maps the data array', async () => {
  const { fetchFn } = fakeFetch({ data: [{ id: 'grok-4-1' }, { id: 'grok-code-2' }, { nope: true }] })
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn,
  })
  await primeCatalog(adapter, 'grok')
  const models = await adapter.listModels('grok')
  assert.deepEqual(models.map(model => model.id), ['grok-4-1', 'grok-code-2'])
})

test('claude logged in returns the static catalog', async () => {
  const claude = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    discovery: false,
  })
  const models = await claude.listModels('claude')
  assert.deepEqual(models.map(model => model.id), ['claude-opus-4-5'])
})

// The endpoint carries additions to the catalogue the client already holds, under the
// field name `additional_model_options` beside `additional_model_costs`.
const CLAUDE_BOOTSTRAP_PAYLOAD = {
  client_data: null,
  additional_model_options: [
    { model: 'claude-opus-5-5', name: 'Claude Opus 5.5', description: 'newest' },
    { model: 'claude-bare' },
    { model: 'claude-retired', name: 'Retired', disabled_reason: 'no longer offered' },
    { name: 'nameless' },
  ],
}

test('claudeThinkingBody refuses a manual budget on Opus 5.5', () => {
  assert.deepEqual(
    claudeThinkingBody('claude-opus-5-5', 'enabled', 32_000),
    { type: 'adaptive' },
  )
  assert.deepEqual(
    claudeThinkingBody('claude-opus-5-5', undefined, 32_000),
    { type: 'adaptive' },
  )
  assert.deepEqual(
    claudeThinkingBody('claude-opus-4-5', 'enabled', 32_000),
    { type: 'enabled', budgetTokens: 16_000 },
  )
  assert.equal(claudeThinkingBody('claude-opus-4-5', undefined, 32_000), undefined)
})

test('the thinking budget stays strictly under the output cap it is derived from', () => {
  // `budget_tokens >= max_tokens` is an API error in extended thinking, so the derived budget
  // has to stay below whatever cap a model now resolves to — including the 128K a flagship
  // reports, which is four times the pair this route used to report for every model.
  for (const model of ['claude-opus-4-5', 'claude-haiku-4-5', 'claude-fable-5']) {
    for (const maxTokens of [8_192, 32_000, 64_000, 128_000]) {
      const thinking = claudeThinkingBody(model, 'enabled', maxTokens)
      if (thinking?.budgetTokens === undefined) continue
      assert.ok(thinking.budgetTokens < maxTokens, `${model} at ${String(maxTokens)} keeps the budget under the cap`)
    }
  }
  assert.deepEqual(claudeThinkingBody('claude-opus-4-5', 'enabled', 128_000), { type: 'enabled', budgetTokens: 64_000 })
})

test('the documented limit outranks the catalogue window, which outranks the conservative pair', () => {
  // A native-1M flagship reports the documented window, which is also the catalogue's.
  assert.deepEqual(claudeModelLimits('claude-opus-5'), { contextWindow: 1_000_000, maxOutputTokens: 128_000 })
  // Sonnet 4.6's documented 1M needs the long-context beta this route never sends, so the
  // catalogue's own window is what a request can use and what the picker reports. The output
  // ceiling is not beta-gated and stays as documented.
  assert.deepEqual(claudeDocumentedLimits('claude-sonnet-4-6'), { contextWindow: 1_000_000, maxOutputTokens: 128_000 })
  assert.deepEqual(claudeModelLimits('claude-sonnet-4-6'), { contextWindow: 200_000, maxOutputTokens: 128_000 })
  assert.deepEqual(claudeModelLimits('claude-opus-4-6'), { contextWindow: 200_000, maxOutputTokens: 128_000 })
  // Haiku 4.5 is the one model the documentation states below the flagship pair.
  assert.deepEqual(claudeDocumentedLimits('claude-haiku-4-5'), { contextWindow: 200_000, maxOutputTokens: 64_000 })
  // A model the documentation does not name takes the pinned catalogue's entry...
  assert.equal(claudeDocumentedLimits('claude-3-7-sonnet'), undefined)
  assert.deepEqual(claudeProfileLimits('claude-3-7-sonnet'), { contextWindow: 200_000, maxOutputTokens: 32_000 })
  // ...and only an id neither source carries takes the conservative pair.
  assert.equal(claudeProfileLimits('claude-unknown'), undefined)
  assert.deepEqual(claudeModelLimits('claude-unknown'), { contextWindow: 200_000, maxOutputTokens: 32_000 })
})

test('a documented window is reported only where a request can reach it without the 1M beta', () => {
  for (const id of ['claude-sonnet-4-6', 'claude-opus-4-6']) {
    const context = CLAUDE_CODE_2_1_288_PROFILE.supportedModels[id]?.context
    // The catalogue marks these two with the 1M beta and a 200000 window, and a plain id
    // composes no beta, so the documented million is withheld from the resolved limit.
    assert.equal(context?.supports1mBeta, true, id)
    assert.equal(context?.native1m, undefined, id)
    assert.equal(claudeModelLimits(id).contextWindow, 200_000, id)
  }
  // Every documented window a request can reach is reported as documented, and no other model
  // loses its documented window to the beta rule.
  for (const [id, entry] of Object.entries(CLAUDE_CODE_2_1_288_PROFILE.supportedModels)) {
    const documented = claudeDocumentedLimits(id)
    if (documented === undefined) continue
    if (entry.context?.supports1mBeta === true && entry.context.native1m !== true) continue
    assert.equal(claudeModelLimits(id).contextWindow, documented.contextWindow, id)
  }
})

test('the 1M marker is the one channel that reports the beta window, and it clamps where the pin denies it', () => {
  // Every entry the profile marks with the 1M beta and a below-1M window is one the marker
  // raises, and it is the only id under which that window is reported.
  const raised = Object.entries(CLAUDE_CODE_2_1_288_PROFILE.supportedModels)
    .filter(([, entry]) => entry.context?.supports1mBeta === true && entry.context.native1m !== true)
    .map(([id]) => id)
  assert.deepEqual(raised, ['claude-sonnet-4-0', 'claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'])
  for (const id of raised) {
    const marked = `${id}[1m]`
    assert.equal(claudeModelLimits(marked).contextWindow, 1_000_000, id)
    assert.equal(claudeModelLimits(id).contextWindow, 200_000, id)
    // The output ceiling is not beta-gated and does not move with the marker.
    assert.equal(claudeModelLimits(marked).maxOutputTokens, claudeModelLimits(id).maxOutputTokens, id)
  }
  // A marked id the pin does not declare the beta for is clamped back to the plain window: a
  // window a request cannot reach is never reported.
  assert.equal(claudeModelLimits('claude-haiku-4-5[1m]').contextWindow, 200_000)
  assert.equal(claudeModelLimits('claude-3-7-sonnet[1m]').contextWindow, 200_000)
  assert.equal(claudeModelLimits('claude-unknown[1m]').contextWindow, 200_000)
})

test('the catalogue lists a 1M row for exactly the models the marker buys a window for', () => {
  const rows = claudeCatalogueListing()
  // One variant per raised model, listed directly after its own model, named for its window
  // and inheriting everything else from the row it is derived from.
  assert.deepEqual(
    rows.filter(row => row.id.includes('[1m]')).map(row => row.id),
    ['claude-sonnet-4-0[1m]', 'claude-sonnet-4-5[1m]', 'claude-sonnet-4-6[1m]', 'claude-opus-4-6[1m]'],
  )
  assert.deepEqual(
    rows.slice(rows.findIndex(row => row.id === 'claude-sonnet-4-6'), rows.findIndex(row => row.id === 'claude-sonnet-4-6') + 2),
    [
      { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' },
      { id: 'claude-sonnet-4-6[1m]', name: 'Sonnet 4.6 (1M)' },
    ],
  )
  // The plain table is unchanged: the variants are a listing, not a second membership rule.
  assert.deepEqual(claudeBuiltInCatalogue().map(row => row.id), Object.keys(CLAUDE_CODE_2_1_288_PROFILE.supportedModels))
})

test('a disabled account model carries its 1M row into the listing', async () => {
  const payload = {
    client_data: null,
    additional_model_options: [{ model: 'claude-sonnet-4-6', disabled_reason: 'org disabled' }],
  }
  const rows = await fetchClaudeCatalogue(claudeSession, [], fakeFetch(payload).fetchFn)
  assert.deepEqual(rows.find(row => row.id === 'claude-sonnet-4-6[1m]'), {
    id: 'claude-sonnet-4-6[1m]',
    name: 'Sonnet 4.6 (1M)',
    disabledReason: 'org disabled',
  })
})

test('the documented limits name catalogue models and never fall below the catalogue entry', () => {
  const catalogue = CLAUDE_CODE_2_1_288_PROFILE.supportedModels
  const documented = Object.keys(catalogue).filter(id => claudeDocumentedLimits(id) !== undefined)
  // The documentation's current-model table: its flagships plus the one Haiku exception.
  assert.deepEqual(documented, [
    'claude-haiku-4-5',
    'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-sonnet-5-5',
    'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5',
    'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5', 'claude-mythos-5-1',
  ])
  for (const [id, entry] of Object.entries(catalogue)) {
    const stated = claudeDocumentedLimits(id)
    if (stated === undefined) continue
    // The documented figure is the model's limit and the catalogue's is a policy window, so
    // the documentation can never state less than the catalogue reports.
    assert.ok(stated.contextWindow >= (entry.context?.window ?? 0), `${id} states at least the catalogue window`)
    assert.ok(stated.maxOutputTokens >= (entry.maxOutputTokens?.default ?? 0), `${id} states at least the catalogue output`)
  }
})

test('the built-in catalogue lists the pinned profile with the client display names and no request', () => {
  const rows = claudeBuiltInCatalogue()
  // Membership is the pinned profile's own table, in the catalogue's own order.
  assert.deepEqual(rows.map(row => row.id), Object.keys(CLAUDE_CODE_2_1_288_PROFILE.supportedModels))
  assert.ok(rows.length > 0)
  assert.equal(rows.find(row => row.id === 'claude-sonnet-5')?.name, 'Sonnet 5')
  assert.equal(rows.find(row => row.id === 'claude-3-5-haiku')?.name, 'Haiku 3.5')
  // Every id the pinned profile carries has display text of its own; a bare id here means
  // the transcribed table fell behind the profile.
  assert.deepEqual(rows.filter(row => row.name === row.id), [])
})

test('the account options add to the built-in catalogue rather than replacing it', async () => {
  const rows = await fetchClaudeCatalogue(claudeSession, [], fakeFetch(CLAUDE_BOOTSTRAP_PAYLOAD).fetchFn)
  const base = claudeCatalogueListing()
  // Every built-in model survives in its catalogue position, with the account's own addition appended.
  assert.deepEqual(rows.map(row => row.id), [...base.map(row => row.id), 'claude-bare', 'claude-retired'])
  assert.deepEqual(rows.slice(base.length), [
    { id: 'claude-bare', name: 'claude-bare' },
    { id: 'claude-retired', name: 'Retired', disabledReason: 'no longer offered' },
  ])
  // An option naming a built-in model replaces that row's display text in place, once, and
  // leaves the capability the pinned catalogue gave it standing.
  const opus = rows.filter(row => row.id === 'claude-opus-5-5')
  assert.deepEqual(opus, [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', fastTier: true, description: 'newest' },
  ])
  // An option naming no model is not a row.
  assert.equal(rows.some(row => row.id === 'nameless'), false)
})

test('a disabled option surfaces as a disabled row instead of disappearing', async () => {
  const rows = await fetchClaudeCatalogue(claudeSession, [], fakeFetch(CLAUDE_BOOTSTRAP_PAYLOAD).fetchFn)
  assert.deepEqual(rows.find(row => row.id === 'claude-retired'), {
    id: 'claude-retired',
    name: 'Retired',
    disabledReason: 'no longer offered',
  })
  assert.equal(rows.find(row => row.id === 'claude-bare')?.disabledReason, undefined)
  // The picker row keeps the state the endpoint declared.
  const claude = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    discovery: true,
    fetchFn: fakeFetch(CLAUDE_BOOTSTRAP_PAYLOAD).fetchFn,
  })
  await primeCatalog(claude, 'claude')
  const listed = await claude.listModels('claude') as readonly (LlmModelInfo & { disabledReason?: string })[]
  assert.equal(listed.find(row => row.id === 'claude-retired')?.disabledReason, 'no longer offered')
  assert.equal(listed.find(row => row.id === 'claude-bare')?.disabledReason, undefined)
})

test('a response that is not the document leaves the built-in catalogue standing', async () => {
  const base = claudeCatalogueListing()
  const malformed = await fetchClaudeCatalogue(
    claudeSession, [], fakeFetch({ unexpected: true }).fetchFn,
  )
  assert.deepEqual(malformed, base)
  const refused = await fetchClaudeCatalogue(
    claudeSession, [],
    (async () => new Response('{}', { status: 500 })) as never,
  )
  assert.deepEqual(refused, base)
})

test('claude discovery lists the built-in catalogue when the options read is refused', async () => {
  const claude = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    discovery: true,
    fetchFn: (async () => new Response('{}', { status: 500 })) as never,
  })
  await primeCatalog(claude, 'claude')
  const ids = (await claude.listModels('claude')).map(row => row.id)
  assert.ok(ids.length > 1)
  assert.equal(ids.includes('claude-sonnet-5'), true)
})

test('a cold claude menu is the pinned catalogue, not the configured shortlist', async () => {
  const { fetchFn, calls } = fakeFetch(CLAUDE_BOOTSTRAP_PAYLOAD)
  const claude = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    discovery: true,
    fetchFn,
  })
  const pinned = claudeCatalogueListing().map(row => row.id)
  const rows = await claude.listModels('claude')
  assert.equal(pinned.length, 25, 'the pinned table carries its 1M rows')
  assert.deepEqual(rows.map(row => row.id), pinned, 'a cold menu offers every pinned model')
  assert.ok(rows.some(row => row.id.endsWith('[1m]')), 'the 1M variants are listed')
  assert.equal(calls(), 0, 'a cold menu must not ask the provider')
  // An explicit configuration is the operator's decision: it is listed as given.
  const configured = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    discovery: false,
  })
  assert.deepEqual((await configured.listModels('claude')).map(row => row.id), ['claude-opus-4-5'])
})

test('the options read carries the desktop client headers', async () => {
  let seen: Record<string, string> = {}
  const fetchFn = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    seen = init?.headers ?? {}
    return new Response(JSON.stringify(CLAUDE_BOOTSTRAP_PAYLOAD), { status: 200 })
  }) as never
  await fetchClaudeCatalogue(claudeSession, [['anthropic-client-platform', 'desktop_app']], fetchFn)
  assert.equal(seen['anthropic-client-platform'], 'desktop_app')
  assert.equal(seen['content-type'], 'application/json')
  assert.equal(seen['anthropic-beta'], 'oauth-2025-04-20')
  assert.equal(seen['authorization']?.startsWith('Bearer '), true)
})

test('claude reports the documented capacity for each model the documentation names', async () => {
  const claude = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    discovery: true,
    fetchFn: fakeFetch(CLAUDE_BOOTSTRAP_PAYLOAD).fetchFn,
  })
  // The options endpoint names models; it does not describe them. The documented per-model
  // limits therefore answer, and every native-1M flagship the documentation lists is 1M/128K.
  const flagship = await claude.resolveModel('claude', 'claude-opus-5-5')
  assert.equal(flagship.context?.contextWindow, 1_000_000)
  assert.equal(flagship.defaultMaxTokens, 128_000)
  const fable = await claude.resolveModel('claude', 'claude-fable-5')
  assert.equal(fable.context?.contextWindow, 1_000_000)
  assert.equal(fable.defaultMaxTokens, 128_000)
  // These two are documented at 1M too, but only inside the long-context beta this route never
  // sends, so the picker reports the window a request is actually served at.
  const sonnet46 = await claude.resolveModel('claude', 'claude-sonnet-4-6')
  assert.equal(sonnet46.context?.contextWindow, 200_000)
  assert.equal(sonnet46.defaultMaxTokens, 128_000)
  const opus46 = await claude.resolveModel('claude', 'claude-opus-4-6')
  assert.equal(opus46.context?.contextWindow, 200_000)
  assert.equal(opus46.defaultMaxTokens, 128_000)
  // The one model the documentation states at 200K/64K.
  const haiku = await claude.resolveModel('claude', 'claude-haiku-4-5')
  assert.equal(haiku.context?.contextWindow, 200_000)
  assert.equal(haiku.defaultMaxTokens, 64_000)
  // A model the documentation does not name keeps the pinned catalogue's own entry.
  const legacy = await claude.resolveModel('claude', 'claude-3-5-haiku')
  assert.equal(legacy.context?.contextWindow, 200_000)
  assert.equal(legacy.defaultMaxTokens, 8_192)
  // An id neither source carries is the only thing the conservative pair answers for.
  const unknown = await claude.resolveModel('claude', 'claude-unknown')
  assert.equal(unknown.context?.contextWindow, 200_000)
  assert.equal(unknown.defaultMaxTokens, 32_000)
})

test('claude honours the configured output cap and the catalogue window', async () => {
  const configured = [
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', maxTokens: 16_000 },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', maxTokens: 256_000, contextWindow: 400_000 },
  ]
  const claude = new ClaudeAdapter({
    models: configured,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    // No options read: this is about what the adapter does with the catalogue alone.
    discovery: false,
  })
  // The operator's cap is their decision and stands on its own: the ceiling it used to be
  // clamped against came from an endpoint the genuine client never calls on this path.
  assert.equal((await claude.resolveModel('claude', 'claude-opus-4-5')).defaultMaxTokens, 16_000)
  assert.equal((await claude.resolveModel('claude', 'claude-opus-5-5')).defaultMaxTokens, 256_000)
  // The configured entry is authoritative for the models it names; the pinned catalogue
  // still answers for everything it does not, which is where the fallbacks below come from.
  const window = await claude.resolveModel('claude', 'claude-opus-5-5')
  assert.equal(window.context?.contextWindow, 400_000)
})

test('fetchCodexModels tolerates entries without visibility or priority', async () => {
  const models = await fetchCodexModels(codexSession, fakeFetch({
    models: [{ slug: 'bare', display_name: 'Bare' }],
  }).fetchFn)
  assert.deepEqual(models, [{ id: 'bare', name: 'Bare' }])
})

test('codex discovery flags models whose catalog advertises a fast service tier', async () => {
  const models = await fetchCodexModels(codexSession, fakeFetch({
    models: [
      {
        slug: 'gpt-5.2-codex',
        display_name: 'GPT-5.2 Codex',
        service_tiers: [{ id: 'priority', name: 'Fast', description: 'Priority processing.' }],
        priority: 1,
      },
      // The legacy catalog spelling (codex-rs additional_speed_tiers).
      { slug: 'gpt-5.2-codex-spark', display_name: 'Spark', additional_speed_tiers: ['fast'], priority: 2 },
      // A model without a fast tier gets no flag.
      { slug: 'gpt-5.1-codex', display_name: 'GPT-5.1 Codex', priority: 3 },
    ],
  }).fetchFn)
  assert.deepEqual(models.map(model => model.id), ['gpt-5.2-codex', 'gpt-5.2-codex-spark', 'gpt-5.1-codex'])
  assert.deepEqual(models.map(model => model.fastTier ?? false), [true, true, false])

  const { fetchFn } = fakeFetch({
    models: [
      { slug: 'gpt-5.2-codex', service_tiers: [{ id: 'priority' }], priority: 1 },
      { slug: 'gpt-5.1-codex', priority: 2 },
    ],
  })
  const adapter = codexAdapter({ session: codexSession, fetchFn })
  await primeCatalog(adapter, 'codex')
  assert.deepEqual(await adapter.fastCapableModels(), ['gpt-5.2-codex'])
  assert.equal(await adapter.supportsFastTier('gpt-5.2-codex'), true)
  assert.equal(await adapter.supportsFastTier('gpt-5.1-codex'), false)
  // Discovery off (config override): no fast capability is claimed.
  const staticAdapter = codexAdapter({ session: codexSession, discovery: false })
  assert.deepEqual(await staticAdapter.fastCapableModels(), [])
  assert.equal(await staticAdapter.supportsFastTier('gpt-5.1-codex'), false)
  // Logged out: no fast models, so the Speed toggle hides after logout.
  const loggedOut = codexAdapter({ fetchFn })
  assert.deepEqual(await loggedOut.fastCapableModels(), [])
})

test('claude fast capability comes from the pinned catalogue, not from discovery', async () => {
  // Every catalogue row carries the tier the profile's own `fast_mode` string gives it.
  const rows = claudeCatalogueListing()
  assert.deepEqual(
    rows.filter(row => row.fastTier === true).map(row => row.id),
    Object.entries(CLAUDE_CODE_2_1_288_PROFILE.supportedModels)
      .filter(([, entry]) => entry.capabilities.includes('fast_mode'))
      .map(([id]) => id),
    'the flag is the profile capability itself',
  )
  assert.deepEqual(rows.filter(row => row.fastTier === true).map(row => row.id), [
    'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5',
  ])
  assert.equal(rows.find(row => row.id === 'claude-fable-5')?.fastTier, undefined)

  // Discovery is off and no request is issued: the capability is compiled in, so the picker
  // offers the tier while the options read is unavailable.
  const claude = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    discovery: false,
  })
  assert.deepEqual(await claude.fastCapableModels(), ['claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5'])
  assert.equal(claude.supportsFastTier('claude-opus-5-5'), true)
  assert.equal(claude.supportsFastTier('claude-opus-5-5[1m]'), true, 'the marker is not part of the catalogue key')
  assert.equal(claude.supportsFastTier('claude-fable-5'), false)
  assert.equal(claude.supportsFastTier('claude-not-a-model'), false)

  // Logged out: no fast models, so the Speed toggle hides after logout.
  const loggedOut = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens<ClaudeSession>(undefined),
    discovery: false,
  })
  assert.deepEqual(await loggedOut.fastCapableModels(), [])
})

test('codexRequestBody sends service_tier priority only on the fast tier', () => {
  const base = codexRequestBody(
    { provider: 'codex', model: 'gpt-5.1-codex', messages: [] },
    { input: [] },
    false,
  )
  assert.equal(base.model, 'gpt-5.1-codex')
  assert.equal('service_tier' in base, false)

  const fast = codexRequestBody(
    {
      provider: 'codex',
      model: 'gpt-5.1-codex',
      messages: [],
      reasoningEffort: ReasoningEffortId('high'),
    },
    { input: [] },
    true,
  )
  assert.equal(fast.model, 'gpt-5.1-codex')
  assert.equal(fast.service_tier, 'priority')
  assert.deepEqual(fast.reasoning, { effort: 'high', summary: 'auto' })
})

test('codexRequestBody reconciles orphaned tool calls before dispatch', () => {
  const missing = codexRequestBody(
    { provider: 'codex', model: 'gpt-5.6-sol', messages: [] },
    {
      input: [
        { type: 'function_call', call_id: 'call-missing', name: 'lookup', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-orphan', output: 'stale' },
        { type: 'function_call', call_id: 'call-ok', name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-ok', output: 'done' },
      ],
    },
    false,
  )
  const input = missing.input as Record<string, unknown>[]
  assert.equal(input.length, 4)
  assert.equal(input[0].type, 'function_call')
  assert.equal(input[0].call_id, 'call-missing')
  assert.equal(input[1].type, 'function_call_output')
  assert.equal(input[1].call_id, 'call-missing')
  assert.match(String(input[1].output), /outcome is unknown/)
  assert.equal(input[2].call_id, 'call-ok')
  assert.equal(input[3].type, 'function_call_output')
  assert.equal(input[3].call_id, 'call-ok')

  const balanced = codexRequestBody(
    { provider: 'codex', model: 'gpt-5.6-sol', messages: [] },
    {
      input: [
        { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-1', output: 'done' },
      ],
    },
    false,
  )
  assert.equal((balanced.input as Record<string, unknown>[]).length, 2)
})

test('codexRequestBody bounds tool-call ids without losing their pairings', () => {
  const short = 'call-short'
  const sharedPrefix = `call_${'x'.repeat(60)}`
  const longA = `${sharedPrefix}-a`
  const longB = `${sharedPrefix}-b`
  const resolved = {
    input: [
      { type: 'function_call', call_id: short, name: 'short', arguments: '{}' },
      { type: 'function_call_output', call_id: short, output: 'short result' },
      { type: 'function_call', call_id: longA, name: 'long_a', arguments: '{}' },
      { type: 'function_call_output', call_id: longA, output: 'long A result' },
      { type: 'function_call', call_id: longB, name: 'long_b', arguments: '{}' },
      { type: 'function_call_output', call_id: longB, output: 'long B result' },
    ],
  }
  const options = { provider: 'codex', model: 'gpt-5.1-codex', messages: [] }
  const first = codexRequestBody(options, resolved, false)
  const second = codexRequestBody(options, resolved, false)
  const ids = (first.input as Record<string, unknown>[]).map(item => String(item.call_id))

  assert.equal(ids[0], short)
  assert.equal(ids[1], short)
  assert.ok(ids.every(id => id.length <= 64))
  assert.equal(ids[2], ids[3])
  assert.equal(ids[4], ids[5])
  assert.notEqual(ids[2], ids[4])
  assert.deepEqual(second.input, first.input)

  const reserved = ids[2]
  const collision = codexRequestBody(options, {
    input: [
      { type: 'function_call', call_id: reserved, name: 'reserved', arguments: '{}' },
      { type: 'function_call', call_id: longA, name: 'long_a', arguments: '{}' },
      { type: 'function_call_output', call_id: longA, output: 'long A result' },
    ],
  }, false)
  const collisionIds = (collision.input as Record<string, unknown>[]).map(item => String(item.call_id))
  // The orphaned reserved call now carries a repaired output of its own, so
  // the id pairs are [reserved, reserved] then [hash, hash] instead of the
  // pre-repair adjacency [reserved, hash, hash].
  assert.equal(collisionIds[0], reserved)
  assert.equal(collisionIds[1], reserved)
  assert.equal(collisionIds[2], collisionIds[3])
  assert.notEqual(collisionIds[0], collisionIds[2])
})

test('modalities: codex and claude declare image input; grok gates text-only models', async () => {
  const codex = codexAdapter({ session: codexSession, discovery: false })
  const codexModels = await codex.listModels('codex')
  assert.deepEqual(codexModels[0].inputModalities, ['text', 'image'])
  const codexResolved = await codex.resolveModel('codex', 'gpt-5.1-codex')
  assert.deepEqual(codexResolved.inputModalities, ['text', 'image'])

  const claude = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    discovery: false,
  })
  assert.deepEqual((await claude.listModels('claude'))[0].inputModalities, ['text', 'image'])

  const grok = new GrokAdapter({
    models: [{ id: 'grok-4' }, { id: 'grok-code-fast-1' }, { id: 'grok-embedding-1' }],
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: false,
  })
  const grokModels = await grok.listModels('grok')
  assert.deepEqual(grokModels[0].inputModalities, ['text', 'image'])
  assert.deepEqual(grokModels[1].inputModalities, ['text'])
  assert.deepEqual(grokModels[2].inputModalities, ['text'])
  assert.deepEqual((await grok.resolveModel('grok', 'grok-4.6')).inputModalities, ['text', 'image'])
  assert.deepEqual((await grok.resolveModel('grok', 'grok-code-fast-1')).inputModalities, ['text'])
})

test('modalities: config entry inputModalities win over the provider default', async () => {
  const adapter = new CodexAdapter({
    models: [{ id: 'gpt-5.1-codex', inputModalities: ['text'] }],
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(codexSession),
    discovery: false,
  })
  assert.deepEqual((await adapter.listModels('codex'))[0].inputModalities, ['text'])
  assert.deepEqual((await adapter.resolveModel('codex', 'gpt-5.1-codex')).inputModalities, ['text'])
})

test('grok discovery drops generation and embedding models', async () => {
  const { fetchFn } = fakeFetch({
    data: [
      { id: 'grok-4.6' },
      { id: 'grok-build-0.1' },
      { id: 'grok-imagine-image' },
      { id: 'grok-imagine-image-2.0' },
      { id: 'grok-imagine-video-1.5' },
      { id: 'grok-embedding-1' },
    ],
  })
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn,
  })
  await primeCatalog(adapter, 'grok')
  const models = await adapter.listModels('grok')
  assert.deepEqual(models.map(model => model.id), ['grok-4.6', 'grok-build-0.1'])
})

/** The api.x.ai model list: authoritative for which models exist. */
const GROK_API_PAYLOAD = { data: [{ id: 'grok-4.6' }, { id: 'grok-4.5' }, { id: 'grok-build-0.1' }] }
/**
 * The CLI catalog: contributes reasoning/name/context per model. grok-4.6
 * marks two levels `default: true` like the live payload does, so the test
 * proves the top-level `reasoning_effort` field wins.
 */
const GROK_CLI_PAYLOAD = {
  data: [
    {
      id: 'grok-4.6',
      name: 'Grok 4.6',
      description: 'frontier',
      context_window: 500_000,
      supports_reasoning_effort: true,
      reasoning_effort: 'high',
      reasoning_efforts: [
        { value: 'xhigh', label: 'Extra High Effort', default: true },
        { value: 'high', label: 'High Effort', description: 'extensive reasoning', default: true },
        { value: 'medium', label: 'Medium Effort' },
        { value: 'low', label: 'Low Effort' },
      ],
    },
    {
      id: 'grok-4.5',
      name: 'Grok 4.5',
      context_window: 500_000,
      supports_reasoning_effort: true,
      reasoning_effort: 'high',
      reasoning_efforts: [
        { value: 'high', label: 'High Effort', default: true },
        { value: 'medium', label: 'Medium Effort' },
        { value: 'low', label: 'Low Effort' },
      ],
    },
  ],
}

/** A fetch dispatching on URL: the CLI catalog host vs the api.x.ai list. */
function grokDualFetch(cliPayload: unknown = GROK_CLI_PAYLOAD, cliStatus = 200): FetchFn {
  return ((url: unknown) => {
    const isCliCatalog = String(url).includes('cli-chat-proxy')
    return Promise.resolve(new Response(
      JSON.stringify(isCliCatalog ? cliPayload : GROK_API_PAYLOAD),
      { status: isCliCatalog ? cliStatus : 200 },
    ))
  }) as FetchFn
}

test('grok discovery merges CLI-catalog reasoning metadata by model id', async () => {
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: grokDualFetch(),
  })
  await primeCatalog(adapter, 'grok')
  const models = await adapter.listModels('grok')
  assert.deepEqual(models.map(model => model.name), ['Grok 4.6', 'Grok 4.5', 'grok-build-0.1'])
  assert.equal(models[0].description, 'frontier')

  const g46 = await adapter.resolveModel('grok', 'grok-4.6')
  assert.deepEqual(g46.reasoning?.efforts.map(effort => effort.id), ['xhigh', 'high', 'medium', 'low'])
  assert.equal(g46.reasoning?.efforts[1].name, 'High Effort')
  assert.equal(g46.reasoning?.efforts[1].description, 'extensive reasoning')
  // The top-level reasoning_effort wins over the double default flags.
  assert.equal(g46.reasoning?.defaultEffort, 'high')
  assert.equal(g46.context?.contextWindow, 500_000)

  const g45 = await adapter.resolveModel('grok', 'grok-4.5')
  assert.deepEqual(g45.reasoning?.efforts.map(effort => effort.id), ['high', 'medium', 'low'])

  // A model the CLI catalog does not cover exposes no efforts.
  const build = await adapter.resolveModel('grok', 'grok-build-0.1')
  assert.equal(build.reasoning, undefined)
  assert.equal(build.context?.contextWindow, 256_000)
})

test('grok discovery survives a CLI catalog failure with a warning', async () => {
  const warnings: string[] = []
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: grokDualFetch({ error: 'boom' }, 500),
    onWarn: message => warnings.push(message),
  })
  await primeCatalog(adapter, 'grok')
  const models = await adapter.listModels('grok')
  assert.deepEqual(models.map(model => model.id), ['grok-4.6', 'grok-4.5', 'grok-build-0.1'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /CLI catalog fetch failed/)
  assert.equal((await adapter.resolveModel('grok', 'grok-4.6')).reasoning, undefined)
})

test('grok discovery keeps last-known reasoning when the CLI catalog fails', async () => {
  const warnings: string[] = []
  const store = memoryCatalogStore({
    at: Date.now() - PAST_FRESHNESS_MS,
    models: [{
      id: 'grok-4.6',
      name: 'Grok 4.6',
      contextWindow: 500_000,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('xhigh'), name: 'Extra High Effort' },
          { id: ReasoningEffortId('high'), name: 'High Effort' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    }],
  })
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: grokDualFetch({ error: 'boom' }, 500),
    onWarn: message => warnings.push(message),
    catalogStore: store,
  })
  await primeCatalog(adapter, 'grok')
  const resolved = await adapter.resolveModel('grok', 'grok-4.6')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['xhigh', 'high'])
  assert.equal(resolved.reasoning?.defaultEffort, 'high')
  assert.equal(resolved.context?.contextWindow, 500_000)
  assert.match(warnings[0], /keeping last-known reasoning efforts/)
  await settle()
  assert.equal(store.saved()?.models.find(model => model.id === 'grok-4.6')?.reasoning?.defaultEffort, 'high')
})

test('grok discovery keeps last-known reasoning when the CLI catalog omits a model', async () => {
  const store = memoryCatalogStore({
    at: Date.now() - PAST_FRESHNESS_MS,
    models: [{
      id: 'grok-4.6',
      name: 'Grok 4.6',
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('xhigh'), name: 'Extra High Effort' },
          { id: ReasoningEffortId('high'), name: 'High Effort' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    }],
  })
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: grokDualFetch({ data: GROK_CLI_PAYLOAD.data.filter(entry => entry.id === 'grok-4.5') }),
    catalogStore: store,
  })
  await primeCatalog(adapter, 'grok')
  const g46 = await adapter.resolveModel('grok', 'grok-4.6')
  assert.deepEqual(g46.reasoning?.efforts.map(effort => effort.id), ['xhigh', 'high'])
  const g45 = await adapter.resolveModel('grok', 'grok-4.5')
  assert.deepEqual(g45.reasoning?.efforts.map(effort => effort.id), ['high', 'medium', 'low'])
})

test('grok entries without reasoning support expose no efforts', async () => {
  const cliPayload = {
    data: [
      { id: 'grok-4.6', supports_reasoning_effort: false },
      { id: 'grok-4.5', supports_reasoning_effort: true, reasoning_efforts: [] },
    ],
  }
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: grokDualFetch(cliPayload),
  })
  await primeCatalog(adapter, 'grok')
  assert.equal((await adapter.resolveModel('grok', 'grok-4.6')).reasoning, undefined)
  assert.equal((await adapter.resolveModel('grok', 'grok-4.5')).reasoning, undefined)
})

test('empty discovery payload falls back to the static catalog with a warning', async () => {
  const warnings: string[] = []
  const { fetchFn } = fakeFetch({ models: [] })
  const adapter = codexAdapter({ session: codexSession, fetchFn, warnings })
  await primeCatalog(adapter, 'codex')
  const models = await adapter.listModels('codex')
  assert.deepEqual(models.map(model => model.id), ['gpt-5.1-codex'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /empty catalog/)
})

/** An in-memory per-account CatalogStoreFactory fake with a snapshot inspection hook. */
function memoryCatalogStore(initial?: CatalogSnapshot): CatalogStoreFactory & {
  saved: () => CatalogSnapshot | undefined
} {
  let stored = initial
  const factory = (_account: string): CatalogPersistence => ({
    load: () => Promise.resolve(stored === undefined ? undefined : { snapshot: stored }),
    save: (snapshot) => {
      stored = snapshot
      return Promise.resolve()
    },
    clear: () => {
      stored = undefined
      return Promise.resolve()
    },
  })
  return Object.assign(factory, { saved: () => stored })
}

/** An in-memory store that keeps one record per account, as the durable one does. */
function memoryAccountStore(): CatalogStoreFactory & {
  snapshot: (account: string) => CatalogSnapshot | undefined
  failure: (account: string) => CatalogFailure | undefined
} {
  const entries = new Map<string, CatalogRecord>()
  const factory = (account: string): CatalogPersistence => ({
    load: () => Promise.resolve(entries.get(account)),
    save: (snapshot) => {
      entries.set(account, { snapshot })
      return Promise.resolve()
    },
    saveFailure: (failure) => {
      entries.set(account, { ...entries.get(account), failure })
      return Promise.resolve()
    },
    clear: () => {
      entries.delete(account)
      return Promise.resolve()
    },
  })
  return Object.assign(factory, {
    snapshot: (account: string) => entries.get(account)?.snapshot,
    failure: (account: string) => entries.get(account)?.failure,
  })
}

/**
 * Prime one account's catalogue the way an explicit event does. Listing and
 * capability reads are cache-only, so a test that wants discovered rows has to
 * ask the provider for them first — exactly as the host does.
 */
async function primeCatalog(adapter: AccountAwareAdapter, provider: string, account?: string): Promise<void> {
  await adapter.refreshOwnCatalog?.(provider, account)
}

/** Let fire-and-forget promise chains (a detached refresh, a write-through) settle. */
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

test('ModelCatalogCache reads are pure: no read starts a request, stale included', async () => {
  const cache = new ModelCatalogCache({ maxAgeMs: 0 })
  let calls = 0
  const fetchOnce = (): Promise<{ id: string; name: string }[]> => {
    calls += 1
    return Promise.resolve([{ id: 'a', name: 'A' }])
  }
  assert.equal(await cache.read(), undefined)
  assert.equal(cache.stale(), true)
  assert.deepEqual(cache.lastKnown(), undefined)
  assert.equal(calls, 0, 'a cold read must not request anything')

  // Only an explicit refresh asks; every later read answers from what it stored.
  assert.equal((await cache.refresh(fetchOnce)).status, 'fetched')
  assert.equal(calls, 1)
  assert.deepEqual((await cache.read())?.map(model => model.id), ['a'])
  assert.deepEqual(cache.lastKnown()?.map(model => model.id), ['a'])
  assert.equal(calls, 1, 'a read after a refresh must not request anything')
  // maxAgeMs 0 makes the stored entry instantly stale and the read still answers
  // it: freshness decides when a refresh MAY run, never what a read returns.
  assert.equal(cache.stale(), true)
  assert.deepEqual((await cache.read())?.map(model => model.id), ['a'])
  assert.equal(calls, 1)
})

test('ModelCatalogCache refresh coalesces concurrent callers into one request', async () => {
  const cache = new ModelCatalogCache()
  let calls = 0
  let finish!: (models: { id: string; name: string }[]) => void
  const fetchOnce = (): Promise<{ id: string; name: string }[]> => {
    calls += 1
    return new Promise(resolve => { finish = resolve })
  }
  const first = cache.refresh(fetchOnce)
  await settle()
  const second = cache.refresh(fetchOnce)
  await settle()
  assert.equal(calls, 1, 'the second caller must join the request in flight')
  finish([{ id: 'a', name: 'A' }])
  assert.deepEqual((await first).status, 'fetched')
  assert.deepEqual((await second).status, 'fetched')
  assert.equal(calls, 1)
})

test('ModelCatalogCache refresh skips a fresh entry and a cooling-down failure', async () => {
  const cache = new ModelCatalogCache()
  let calls = 0
  const ok = (): Promise<{ id: string; name: string }[]> => {
    calls += 1
    return Promise.resolve([{ id: 'a', name: 'A' }])
  }
  assert.equal((await cache.refresh(ok)).status, 'fetched')
  assert.deepEqual(await cache.refresh(ok), { status: 'skipped', reason: 'fresh' })
  assert.equal(calls, 1)
  // `force` re-requests a fresh SUCCESS, which is what an explicit refresh means.
  assert.equal((await cache.refresh(ok, { force: true })).status, 'fetched')
  assert.equal(calls, 2)
})

test('ModelCatalogCache honours a failure cooldown, and force never bypasses it', async () => {
  const cache = new ModelCatalogCache({ maxAgeMs: 0, retryDelayMs: 60_000 })
  let calls = 0
  const fail = (): Promise<{ id: string; name: string }[]> => {
    calls += 1
    return Promise.reject(new Error('offline'))
  }
  await assert.rejects(() => cache.refresh(fail))
  assert.equal(calls, 1)
  assert.deepEqual(await cache.refresh(fail), { status: 'skipped', reason: 'cooldown' })
  assert.deepEqual(await cache.refresh(fail, { force: true }), { status: 'skipped', reason: 'cooldown' })
  assert.equal(calls, 1, 'a failing provider must not be queried on every action')
})

test('a catalogue failure that disclosed retry-after cools down for that long, force included', async () => {
  const realNow = Date.now
  const cache = new ModelCatalogCache({ maxAgeMs: 0, retryDelayMs: 60_000 })
  let calls = 0
  const fail = (): Promise<{ id: string; name: string }[]> => {
    calls += 1
    return Promise.reject(new OAuthEndpointError('slow down', 429, undefined, 600_000))
  }
  let now = realNow()
  try {
    Date.now = () => now
    await assert.rejects(() => cache.refresh(fail))
    assert.equal(calls, 1)
    // Five minutes on: a default cooldown would have lapsed, the disclosed ten
    // minutes have not, and a manual (forced) refresh waits it out too.
    now += 5 * 60_000
    assert.deepEqual(await cache.refresh(fail), { status: 'skipped', reason: 'cooldown' })
    assert.deepEqual(await cache.refresh(fail, { force: true }), { status: 'skipped', reason: 'cooldown' })
    assert.equal(calls, 1, 'the disclosed delay outlasts the configured default')
    now += 6 * 60_000
    await assert.rejects(() => cache.refresh(fail, { force: true }))
    assert.equal(calls, 2, 'once the disclosed delay lapses the request may run again')
  } finally {
    Date.now = realNow
  }
})

test('ModelCatalogCache keeps the last good snapshot when a refresh fails', async () => {
  const cache = new ModelCatalogCache()
  assert.equal((await cache.refresh(() => Promise.resolve([{ id: 'a', name: 'A' }]), { force: true })).status, 'fetched')
  await assert.rejects(() => cache.refresh(
    () => Promise.reject(new Error('offline')),
    { force: true },
  ))
  assert.deepEqual((await cache.read())?.map(model => model.id), ['a'])
})

test('ModelCatalogCache cancellation detaches one waiter and not the shared request', async () => {
  const cache = new ModelCatalogCache()
  const controller = new AbortController()
  let finish!: (models: { id: string; name: string }[]) => void
  let calls = 0
  const fetchOnce = (): Promise<{ id: string; name: string }[]> => {
    calls += 1
    return new Promise(resolve => { finish = resolve })
  }
  const detaching = cache.refresh(fetchOnce, { signal: controller.signal })
  await settle()
  const joined = cache.refresh(fetchOnce)
  controller.abort()
  assert.deepEqual(await detaching, { status: 'cancelled' })
  assert.equal(calls, 1, 'the cancelled waiter owns no separate request')
  finish([{ id: 'a', name: 'A' }])
  assert.equal((await joined).status, 'fetched')
  // The cancelled waiter did not abort what the other one awaited.
  assert.deepEqual((await cache.read())?.map(model => model.id), ['a'])
})

test('ModelCatalogCache invalidate drops in-flight work so it cannot write back', async () => {
  const cache = new ModelCatalogCache()
  let finishFirst!: (models: { id: string; name: string }[]) => void
  const first = cache.refresh(() => new Promise(resolve => { finishFirst = resolve }), { force: true })
  await settle()
  cache.invalidate()
  const second = cache.refresh(() => Promise.resolve([{ id: 'good', name: 'Good' }]), { force: true })
  finishFirst([{ id: 'expired', name: 'Expired' }])
  assert.equal((await first).status, 'fetched')
  assert.equal((await second).status, 'fetched')
  assert.deepEqual(cache.lastKnown()?.map(model => model.id), ['good'])
})

test('ModelCatalogCache persists per account and reports an unreadable file once', async () => {
  const store = memoryAccountStore()
  const alpha = new ModelCatalogCache({ persistence: store('alpha') })
  const beta = new ModelCatalogCache({ persistence: store('beta') })
  await alpha.refresh(() => Promise.resolve([{ id: 'a', name: 'A' }]), { force: true })
  await beta.refresh(() => Promise.resolve([{ id: 'b', name: 'B' }]), { force: true })
  assert.deepEqual(store.snapshot('alpha')?.models.map(model => model.id), ['a'])
  assert.deepEqual(store.snapshot('beta')?.models.map(model => model.id), ['b'])
  // A second cache over the same entry seeds from disk, exactly as a restart does.
  const reloaded = new ModelCatalogCache({ persistence: store('alpha') })
  assert.deepEqual((await reloaded.read())?.map(model => model.id), ['a'])

  const warnings: string[] = []
  const broken = new ModelCatalogCache({
    persistence: {
      load: () => Promise.reject(new Error('EACCES')),
      save: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    },
    onWarn: message => warnings.push(message),
    label: 'codex',
  })
  assert.equal(await broken.read(), undefined)
  assert.equal(warnings.length, 1, 'an unreadable cache is reported, not silently treated as the provider answer')
  assert.match(warnings[0], /codex catalogue cache could not be read/)
})

test('grok resolveModel never fetches: a cold cache answers from the built-in metadata', async () => {
  let calls = 0
  const dual = grokDualFetch()
  const counting: FetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1
    return dual(input, init)
  }) as FetchFn
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: counting,
  })
  // No refresh first: after a restart, a resumed session's prepareCall can be
  // the first caller, and it must not turn a capability read into discovery.
  const resolved = await adapter.resolveModel('grok', 'grok-4.6')
  assert.equal(calls, 0, 'resolveModel started a provider request')
  assert.equal(resolved.reasoning, undefined, 'nothing was discovered yet, so no effort is claimed')
  assert.equal(resolved.context?.contextWindow, 256_000)
  // An explicit refresh is what discovers, and the read then serves it.
  await primeCatalog(adapter, 'grok')
  assert.equal(calls, 2, 'the refresh is the one place a catalogue request happens')
  const discovered = await adapter.resolveModel('grok', 'grok-4.6')
  assert.deepEqual(discovered.reasoning?.efforts.map(effort => effort.id), ['xhigh', 'high', 'medium', 'low'])
  assert.equal(discovered.reasoning?.defaultEffort, 'high')
})

test('grok resolveModel falls back to the persisted catalog when discovery fails', async () => {
  const store = memoryCatalogStore({
    // Past the freshness window, and still what a read serves: freshness only
    // decides when a refresh MAY run.
    at: Date.now() - PAST_FRESHNESS_MS,
    models: [{
      id: 'grok-4.6',
      name: 'Grok 4.6',
      contextWindow: 500_000,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('high'), name: 'High Effort' },
          { id: ReasoningEffortId('low'), name: 'Low Effort' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    }],
  })
  const failing: FetchFn = () => Promise.reject(new Error('offline'))
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: failing,
    catalogStore: store,
  })
  const resolved = await adapter.resolveModel('grok', 'grok-4.6')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['high', 'low'])
  assert.equal(resolved.context?.contextWindow, 500_000)
})

test('grok resolveModel survives discovery failure with no persisted catalog', async () => {
  const failing: FetchFn = () => Promise.reject(new Error('offline'))
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: failing,
  })
  const resolved = await adapter.resolveModel('grok', 'grok-4.6')
  assert.equal(resolved.reasoning, undefined)
  assert.equal(resolved.context?.contextWindow, 256_000)
})

test('grok discovery writes the fetched catalog through to the store', async () => {
  const store = memoryCatalogStore()
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: grokDualFetch(),
    catalogStore: store,
  })
  await primeCatalog(adapter, 'grok')
  const snapshot = store.saved()
  assert.notEqual(snapshot, undefined)
  const g46 = snapshot?.models.find(model => model.id === 'grok-4.6')
  assert.equal(g46?.reasoning?.defaultEffort, 'high')
})

test('an explicit refresh retries a 401 after a forced token refresh before invalidating', async () => {
  const store = memoryCatalogStore({
    at: Date.now() - PAST_FRESHNESS_MS,
    models: [{
      id: 'grok-4.6',
      name: 'Grok 4.6',
      reasoning: {
        efforts: [{ id: ReasoningEffortId('high'), name: 'High Effort' }],
        defaultEffort: ReasoningEffortId('high'),
      },
    }],
  })
  let modelsCalls = 0
  const fetchFn: FetchFn = ((url: unknown) => {
    const isCli = String(url).includes('cli-chat-proxy')
    if (isCli) {
      return Promise.resolve(new Response(JSON.stringify(GROK_CLI_PAYLOAD), { status: 200 }))
    }
    modelsCalls += 1
    if (modelsCalls === 1) {
      return Promise.resolve(new Response('{}', { status: 401 }))
    }
    return Promise.resolve(new Response(JSON.stringify(GROK_API_PAYLOAD), { status: 200 }))
  }) as FetchFn
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn,
    catalogStore: store,
  })
  await primeCatalog(adapter, 'grok')
  const models = await adapter.listModels('grok')
  assert.deepEqual(models.map(model => model.id), ['grok-4.6', 'grok-4.5', 'grok-build-0.1'])
  assert.equal(modelsCalls, 2)
  assert.notEqual(store.saved(), undefined)
  assert.equal((await adapter.resolveModel('grok', 'grok-4.6')).reasoning?.defaultEffort, 'high')
})

test('a 401 that survives the forced refresh drops the catalog instead of serving it', async () => {
  const store = memoryCatalogStore({
    at: Date.now() - PAST_FRESHNESS_MS,
    models: [{
      id: 'grok-4.6',
      name: 'Grok 4.6',
      reasoning: {
        efforts: [{ id: ReasoningEffortId('high'), name: 'High Effort' }],
        defaultEffort: ReasoningEffortId('high'),
      },
    }],
  })
  let saved: CatalogSnapshot | undefined
  const storeWithSpy: CatalogStoreFactory = account => {
    const persistence = store(account)
    return {
      load: persistence.load,
      save: (snapshot) => { saved = snapshot; return persistence.save(snapshot) },
      clear: persistence.clear,
    }
  }
  const fetchFn: FetchFn = ((url: unknown) => {
    const isCli = String(url).includes('cli-chat-proxy')
    return Promise.resolve(new Response(
      JSON.stringify(isCli ? GROK_CLI_PAYLOAD : {}),
      { status: isCli ? 200 : 401 },
    ))
  }) as FetchFn
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn,
    catalogStore: storeWithSpy,
  })
  await primeCatalog(adapter, 'grok')
  const models = await adapter.listModels('grok')
  assert.deepEqual(models.map(model => model.id), ['grok-4'])
  assert.equal(saved, undefined, 'an auth failure must not persist a catalogue')
  assert.equal(store.saved(), undefined, 'the dropped entry does not come back')
})

test('codex resolveModel never fetches: a cold cache answers the built-in capabilities', async () => {
  const { fetchFn, calls } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = codexAdapter({ session: codexSession, fetchFn })
  const resolved = await adapter.resolveModel('codex', 'gpt-5.2-codex')
  assert.equal(calls(), 0, 'resolveModel started a provider request')
  assert.equal(resolved.context?.contextWindow, 400_000)
  await primeCatalog(adapter, 'codex')
  assert.equal(calls(), 1)
  const discovered = await adapter.resolveModel('codex', 'gpt-5.2-codex')
  assert.deepEqual(discovered.reasoning?.efforts.map(effort => effort.id), ['low', 'high'])
  assert.equal(discovered.context?.contextWindow, 500_000)
})

const STATIC_COPILOT = [{
  id: 'gpt-4o',
  name: 'GPT-4o',
  inputModalities: ['text', 'image'] as ('text' | 'image')[],
}]

function copilotAdapter(overrides: {
  session?: CopilotSession
  discovery?: boolean
  fetchFn?: FetchFn
  warnings?: string[]
}): CopilotAdapter {
  return new CopilotAdapter({
    models: STATIC_COPILOT,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(overrides.session),
    discovery: overrides.discovery ?? true,
    ...overrides.fetchFn === undefined ? {} : { fetchFn: overrides.fetchFn },
    ...overrides.warnings === undefined
      ? {}
      : { onWarn: (message: string) => { overrides.warnings?.push(message) } },
  })
}

const COPILOT_MODELS_PAYLOAD = {
  data: [
    {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      model_picker_enabled: true,
      policy: { state: 'enabled' },
      supported_endpoints: ['/chat/completions'],
      capabilities: {
        supports: { vision: true, tool_calls: true },
        limits: { max_context_window_tokens: 1_000_000 },
      },
    },
    {
      id: 'o4-mini',
      name: 'o4 Mini',
      model_picker_enabled: true,
      policy: { state: 'enabled' },
      supported_endpoints: ['/chat/completions', '/responses'],
      capabilities: {
        supports: { vision: false, reasoning_effort: ['low', 'medium', 'high'] },
      },
    },
    {
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      model_picker_enabled: true,
      policy: { state: 'enabled' },
      // The newer GPT families only list the Responses endpoint.
      supported_endpoints: ['/responses', 'ws:/responses'],
      capabilities: {
        supports: { vision: true, reasoning_effort: ['low', 'medium', 'high', 'xhigh'] },
        limits: { max_context_window_tokens: 1_050_000 },
      },
    },
    { id: 'picker-hidden', model_picker_enabled: false, policy: { state: 'enabled' } },
    { id: 'policy-disabled', model_picker_enabled: true, policy: { state: 'disabled' } },
    {
      id: 'ws-only',
      model_picker_enabled: true,
      policy: { state: 'enabled' },
      supported_endpoints: ['ws:/responses'],
    },
  ],
}

test('copilot listModels returns [] when logged out', async () => {
  const adapter = copilotAdapter({})
  assert.deepEqual(await adapter.listModels('copilot'), [])
})

test('copilot listModels maps the discovered catalog and filters unusable entries', async () => {
  const { fetchFn } = fakeFetch(COPILOT_MODELS_PAYLOAD)
  const adapter = copilotAdapter({ session: copilotSession, fetchFn })
  await primeCatalog(adapter, 'copilot')
  const models = await adapter.listModels('copilot')
  assert.deepEqual(models.map(model => model.id), ['gpt-4.1', 'o4-mini', 'gpt-5.6-sol'])
  // Vision support from the catalog becomes the model's input modalities.
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  assert.deepEqual(models[1].inputModalities, ['text'])
  assert.deepEqual(models[2].inputModalities, ['text', 'image'])
  assert.equal(models[0].name, 'GPT-4.1')
})

test('copilot discovery records the wire protocol per model', async () => {
  const { fetchFn } = fakeFetch(COPILOT_MODELS_PAYLOAD)
  const discovered = await fetchCopilotModels(copilotSession, fetchFn)
  assert.deepEqual(discovered.map(model => [model.id, model.copilotWire ?? 'chat-completions']), [
    ['gpt-4.1', 'chat-completions'],
    // Both endpoints listed → the chat wire (models listing both accept it),
    // with /responses availability recorded for the tools+effort reroute.
    ['o4-mini', 'chat-completions'],
    ['gpt-5.6-sol', 'responses'],
  ])
  // The dual-protocol flag rides only entries listing /responses.
  assert.equal(discovered[0]?.copilotResponses, undefined)
  assert.equal(discovered[1]?.copilotResponses, true)
  assert.equal(discovered[2]?.copilotResponses, true)
  assert.equal(discovered[2]?.contextWindow, 1_050_000)
})

test('copilot discovery maps the supports.reasoning_effort array into efforts', async () => {
  const { fetchFn } = fakeFetch(COPILOT_MODELS_PAYLOAD)
  const discovered = await fetchCopilotModels(copilotSession, fetchFn)
  // A model without the array (or with null/empty) exposes no efforts.
  assert.equal(discovered[0]?.reasoning, undefined)
  const o4 = discovered[1]?.reasoning
  assert.deepEqual(o4?.efforts.map(effort => [effort.id, effort.name]), [
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
  ])
  assert.equal(o4?.defaultEffort, undefined)
  const sol = discovered[2]?.reasoning
  assert.equal(sol?.efforts[3]?.name, 'Extra High')
})

test('copilot discovery tolerates duplicate, empty, and null effort entries', async () => {
  const models = await fetchCopilotModels(copilotSession, fakeFetch({
    data: [
      {
        id: 'gpt-5.1',
        name: 'GPT-5.1',
        model_picker_enabled: true,
        policy: { state: 'enabled' },
        supported_endpoints: ['/chat/completions'],
        capabilities: { supports: { reasoning_effort: ['high', 'high', '', 'max'] } },
      },
      {
        id: 'claude-opus-4-5',
        name: 'Claude Opus 4.5',
        model_picker_enabled: true,
        policy: { state: 'enabled' },
        supported_endpoints: ['/chat/completions'],
        capabilities: { supports: { reasoning_effort: null } },
      },
    ],
  }).fetchFn)
  // Duplicates collapse and empty strings drop (the harness rejects duplicate
  // effort ids); "max" survives with a display name.
  assert.deepEqual(models[0]?.reasoning?.efforts.map(effort => [effort.id, effort.name]), [
    ['high', 'High'],
    ['max', 'Max'],
  ])
  assert.equal(models[1]?.reasoning, undefined)
})

test('copilot resolveModel serves discovered reasoning efforts', async () => {
  const { fetchFn } = fakeFetch(COPILOT_MODELS_PAYLOAD)
  const adapter = copilotAdapter({ session: copilotSession, fetchFn })
  await primeCatalog(adapter, 'copilot')
  const resolved = await adapter.resolveModel('copilot', 'o4-mini')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  const sol = await adapter.resolveModel('copilot', 'gpt-5.6-sol')
  assert.deepEqual(sol.reasoning?.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh'])
  // A model the catalog listed without efforts (and one it filtered out,
  // falling back to static metadata) claims no reasoning at all: the harness
  // then rejects explicit efforts before the API can 400.
  assert.equal((await adapter.resolveModel('copilot', 'gpt-4.1')).reasoning, undefined)
  assert.equal((await adapter.resolveModel('copilot', 'policy-disabled')).reasoning, undefined)
})

test('copilot resolveModel serves discovered context windows and modalities', async () => {
  const { fetchFn } = fakeFetch(COPILOT_MODELS_PAYLOAD)
  const adapter = copilotAdapter({ session: copilotSession, fetchFn })
  await primeCatalog(adapter, 'copilot')
  const resolved = await adapter.resolveModel('copilot', 'gpt-4.1')
  assert.equal(resolved.context?.contextWindow, 1_000_000)
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
  // A model the catalog filtered out falls back to static/defaults.
  const missing = await adapter.resolveModel('copilot', 'policy-disabled')
  assert.equal(missing.context?.contextWindow, 128_000)
  assert.deepEqual(missing.inputModalities, ['text'])
})

test('copilot listModels falls back to the static catalog on discovery failure', async () => {
  const { fetchFn } = fakeFetch({ message: 'boom' }, 500)
  const warnings: string[] = []
  const adapter = copilotAdapter({ session: copilotSession, fetchFn, warnings })
  await primeCatalog(adapter, 'copilot')
  const models = await adapter.listModels('copilot')
  assert.deepEqual(models.map(model => model.id), ['gpt-4o'])
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  assert.equal(warnings.length, 1)
})

test('copilot listModels treats an empty discovered catalog as a failure', async () => {
  const { fetchFn } = fakeFetch({ data: [] })
  const warnings: string[] = []
  const adapter = copilotAdapter({ session: copilotSession, fetchFn, warnings })
  await primeCatalog(adapter, 'copilot')
  const models = await adapter.listModels('copilot')
  assert.deepEqual(models.map(model => model.id), ['gpt-4o'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /empty catalog/)
})

test('copilot listModels without discovery serves the static catalog', async () => {
  const adapter = copilotAdapter({ session: copilotSession, discovery: false })
  const models = await adapter.listModels('copilot')
  assert.deepEqual(models.map(model => model.id), ['gpt-4o'])
})

test('a member adapter keeps catalog rows and delegates pooled / extra ids', async () => {
  // Account pools reuse the catalog wire id; configured tiers append extra
  // picker rows. resolve/stream for an owned id go to the pool.
  const delegated: string[] = []
  const fakePool = {
    modelsForProvider: (provider: string) =>
      Promise.resolve([{ provider, id: 'smart', name: 'smart' }]),
    owns: (_provider: string, model: string) =>
      Promise.resolve(model === 'smart' || model === 'gpt-5.1-codex'),
    resolveModel: (provider: string, model: string) => {
      delegated.push(`resolve:${model}`)
      return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1000 } })
    },
    stream: (options: { model: string }) => {
      delegated.push(`stream:${options.model}`)
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'pooled' } as const
      })()
    },
  }
  const adapter = new CodexAdapter({
    models: STATIC_CODEX,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(codexSession),
    discovery: false,
    pool: () => fakePool as never,
  })
  const models = await adapter.listModels('codex')
  assert.deepEqual(models.map(model => model.id), ['gpt-5.1-codex', 'smart'])
  const resolved = await adapter.resolveModel('codex', 'gpt-5.1-codex')
  assert.equal(resolved.context?.contextWindow, 1000)
  const chunks: { type: string }[] = []
  for await (const chunk of adapter.stream({
    provider: 'codex', model: 'smart', messages: [],
  })) chunks.push(chunk)
  assert.deepEqual(chunks, [{ type: 'text-delta', index: 0, text: 'pooled' }])
  assert.deepEqual(delegated, ['resolve:gpt-5.1-codex', 'stream:smart'])
})

/** A fetch that hangs until `init.signal` aborts, then rejects. */
function abortableHang(): { fetchFn: FetchFn; signals: AbortSignal[] } {
  const signals: AbortSignal[] = []
  const fetchFn = ((_url: string, init?: RequestInit) => {
    const signal = init?.signal ?? undefined
    if (signal !== undefined) signals.push(signal)
    return new Promise<Response>((_resolve, reject) => {
      if (signal === undefined) return
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        return
      }
      signal.addEventListener('abort', () => {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
  }) as FetchFn
  return { fetchFn, signals }
}

test('a healthy account catalogue survives the default account failing its refresh', async () => {
  const expired = { ...codexSession, accountId: 'expired', expiresAt: Date.now() - 1_000 }
  const good = { ...codexSession, accountId: 'good' }
  const solPayload = {
    models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 1 }],
  }
  const fetchFn = ((_url: string, init?: RequestInit) => {
    const accountId = new Headers(init?.headers).get('chatgpt-account-id')
    if (accountId === 'expired') {
      return Promise.reject(new Error('refresh failed'))
    }
    return Promise.resolve(new Response(JSON.stringify(solPayload), { status: 200 }))
  }) as FetchFn
  const adapter = new CodexAdapter({
    models: STATIC_CODEX,
    streamIdleTimeoutMs: 1000,
    tokens: memoryAccounts({ expired, good }),
    discovery: true,
    fetchFn,
    discoveryTimeoutMs: 50,
  })
  // One account's failed refresh sits that account out; the sibling still lists.
  await primeCatalog(adapter, 'codex', 'expired')
  await primeCatalog(adapter, 'codex', 'good')
  const models = await adapter.listModels('codex')
  assert.ok(models.some(model => model.id === 'gpt-5.6-sol'), models.map(model => model.id).join(','))
})

test('listModels orders the account union by catalog priority', async () => {
  const plus = { ...codexSession, accountId: 'plus' }
  const pro = { ...codexSession, accountId: 'pro' }
  const plusPayload = {
    models: [
      { slug: 'gpt-5.6-terra', display_name: 'Terra', visibility: 'list', priority: 2 },
      { slug: 'gpt-5.6-luna', display_name: 'Luna', visibility: 'list', priority: 3 },
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 7 },
      { slug: 'gpt-5.4-mini', display_name: 'Mini', visibility: 'list', priority: 23 },
    ],
  }
  const proPayload = {
    models: [
      { slug: 'gpt-5.6-sol', display_name: 'Sol', visibility: 'list', priority: 1 },
      { slug: 'gpt-5.6-terra', display_name: 'Terra', visibility: 'list', priority: 2 },
      { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', priority: 8 },
    ],
  }
  const fetchFn = ((_url: string, init?: RequestInit) => {
    const accountId = new Headers(init?.headers).get('chatgpt-account-id')
    const payload = accountId === 'pro' ? proPayload : plusPayload
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
  }) as FetchFn
  const adapter = new CodexAdapter({
    models: STATIC_CODEX,
    streamIdleTimeoutMs: 1000,
    tokens: memoryAccounts({ plus, pro }),
    discovery: true,
    fetchFn,
  })
  await primeCatalog(adapter, 'codex', 'plus')
  await primeCatalog(adapter, 'codex', 'pro')
  const models = await adapter.listModels('codex')
  assert.deepEqual(models.map(model => model.id), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
  ])
})

test('resolveModel and Speed use a non-default account catalog for a model only that account lists', async () => {
  const plus = { ...codexSession, accountId: 'plus' }
  const pro = { ...codexSession, accountId: 'pro' }
  const plusPayload = {
    models: [
      {
        slug: 'gpt-5.6-terra',
        display_name: 'Terra',
        visibility: 'list',
        priority: 2,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
        default_reasoning_level: 'high',
      },
    ],
  }
  const proPayload = {
    models: [
      {
        slug: 'gpt-5.6-sol',
        display_name: 'Sol',
        visibility: 'list',
        priority: 1,
        supported_reasoning_levels: [
          { effort: 'low' },
          { effort: 'medium' },
          { effort: 'high' },
          { effort: 'xhigh' },
          { effort: 'max' },
        ],
        default_reasoning_level: 'medium',
        service_tiers: [{ id: 'priority' }],
      },
    ],
  }
  const fetchFn = ((_url: string, init?: RequestInit) => {
    const accountId = new Headers(init?.headers).get('chatgpt-account-id')
    const payload = accountId === 'pro' ? proPayload : plusPayload
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
  }) as FetchFn
  const adapter = new CodexAdapter({
    models: STATIC_CODEX,
    streamIdleTimeoutMs: 1000,
    tokens: memoryAccounts({ plus, pro }),
    discovery: true,
    fetchFn,
  })
  await primeCatalog(adapter, 'codex', 'plus')
  await primeCatalog(adapter, 'codex', 'pro')
  const resolved = await adapter.resolveModel('codex', 'gpt-5.6-sol')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
  assert.equal(await adapter.supportsFastTier('gpt-5.6-sol'), true)
  assert.equal(await adapter.supportsFastTier('gpt-5.6-sol', 'pro'), true)
  assert.equal(await adapter.supportsFastTier('gpt-5.6-sol', 'plus'), false)
  assert.deepEqual(await adapter.fastCapableModels(), ['gpt-5.6-sol'])
})

test('a hanging account is bounded by its own refresh, and its sibling still lists', async () => {
  const plus = { ...codexSession, accountId: 'plus' }
  const max = { ...codexSession, accountId: 'max' }
  const fetchFn = ((_url: string, init?: RequestInit) => {
    const accountId = new Headers(init?.headers).get('chatgpt-account-id')
    if (accountId === 'max') {
      const signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        if (signal === undefined) return
        if (signal.aborted) {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          return
        }
        signal.addEventListener('abort', () => {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    }
    return Promise.resolve(new Response(JSON.stringify(CODEX_MODELS_PAYLOAD), { status: 200 }))
  }) as FetchFn
  const adapter = new CodexAdapter({
    models: STATIC_CODEX,
    streamIdleTimeoutMs: 1000,
    tokens: memoryAccounts({ plus, max }),
    discovery: true,
    fetchFn,
    discoveryTimeoutMs: 20,
  })
  const started = Date.now()
  // The hanging account's own request is bounded by the route's timeout, so the
  // explicit refresh reports it failed instead of blocking the caller.
  const hung = await adapter.refreshOwnCatalog('codex', 'max')
  assert.deepEqual(hung.failed, ['max'])
  await primeCatalog(adapter, 'codex', 'plus')
  const models = await adapter.listModels('codex')
  assert.deepEqual(models.map(model => model.id), ['gpt-5.1-codex', 'gpt-5.2-codex'])
  assert.ok(Date.now() - started < 500)
})

test('clearAccountCatalog drops a non-default account cache so the next refresh requests again', async () => {
  const plus = { ...codexSession, accountId: 'plus' }
  const max = { ...codexSession, accountId: 'max' }
  const { fetchFn, calls } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = new CodexAdapter({
    models: STATIC_CODEX,
    streamIdleTimeoutMs: 1000,
    tokens: memoryAccounts({ plus, max }),
    discovery: true,
    fetchFn,
  })
  await primeCatalog(adapter, 'codex', 'max')
  const first = await adapter.listOwnModels('codex', 'max')
  assert.deepEqual(first.map(model => model.id), ['gpt-5.1-codex', 'gpt-5.2-codex'])
  await primeCatalog(adapter, 'codex', 'max')
  assert.equal(calls(), 1)
  adapter.clearAccountCatalog('max')
  assert.deepEqual(
    (await adapter.listOwnModels('codex', 'max')).map(model => model.id),
    ['gpt-5.1-codex'],
    'a dropped catalogue serves the built-in rows until the next refresh',
  )
  await primeCatalog(adapter, 'codex', 'max')
  assert.equal(calls(), 2)
})

test('clearAccountCatalog invalidates one account and leaves its sibling cached', async () => {
  const plus = { ...codexSession, accountId: 'plus' }
  const pro = { ...codexSession, accountId: 'pro' }
  const { fetchFn, calls } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = new CodexAdapter({
    models: STATIC_CODEX,
    streamIdleTimeoutMs: 1000,
    tokens: memoryAccounts({ plus, pro }),
    discovery: true,
    fetchFn,
  })
  await primeCatalog(adapter, 'codex', 'plus')
  await primeCatalog(adapter, 'codex', 'pro')
  assert.equal(calls(), 2)
  adapter.clearAccountCatalog('pro')
  assert.deepEqual(
    (await adapter.listOwnModels('codex', 'plus')).map(model => model.id),
    ['gpt-5.1-codex', 'gpt-5.2-codex'],
  )
  assert.deepEqual(
    (await adapter.listOwnModels('codex', 'pro')).map(model => model.id),
    ['gpt-5.1-codex'],
  )
  await primeCatalog(adapter, 'codex', 'pro')
  assert.equal(calls(), 3, 'only the dropped account requests again')
})

test('fetchCodexModels forwards the abort signal and rejects when it fires', async () => {
  const { fetchFn, signals } = abortableHang()
  const controller = new AbortController()
  const pending = fetchCodexModels(codexSession, fetchFn, controller.signal)
  controller.abort()
  await assert.rejects(pending)
  assert.equal(signals.length, 1)
  assert.equal(signals[0].aborted, true)
})

test('a read is local: it answers from the built-in rows and ignores caller cancellation', async () => {
  const warnings: string[] = []
  const { fetchFn } = abortableHang()
  const adapter = codexAdapter({ session: codexSession, fetchFn, warnings })
  // Nothing is known yet, so the built-in rows stand in — without any request.
  assert.deepEqual(
    (await adapter.listOwnModels('codex', 'acct')).map(model => model.id),
    ['gpt-5.1-codex'],
  )
  // A caller that already cancelled gets no rows for that account rather than an
  // error the picker would have to report.
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await adapter.listOwnModels('codex', 'acct', controller.signal), [])
  assert.deepEqual(warnings, [])
})

test('a cancelled waiter leaves the shared catalogue refresh running for its sibling', async () => {
  const gate = deferred()
  const calls: string[] = []
  const fetchFn: FetchFn = (async (_url: string, init?: RequestInit) => {
    calls.push('catalogue')
    await gate.promise
    init?.signal?.throwIfAborted()
    return new Response(JSON.stringify(CODEX_MODELS_PAYLOAD), { status: 200 })
  }) as FetchFn
  const adapter = codexAdapter({ session: codexSession, fetchFn })
  const controller = new AbortController()
  const detaching = adapter.refreshOwnCatalog('codex', 'acct', { signal: controller.signal })
  await settle()
  const joined = adapter.refreshOwnCatalog('codex', 'acct')
  await settle()
  assert.equal(calls.length, 1, 'the two callers share one request')
  controller.abort()
  assert.deepEqual((await detaching).cancelled, ['acct'])
  gate.release()
  assert.deepEqual((await joined).fetched, ['acct'], 'the sibling waiter still gets the result')
  await adapter.drainOwnCatalogs()
  assert.deepEqual(
    (await adapter.listOwnModels('codex', 'acct')).map(model => model.id),
    ['gpt-5.1-codex', 'gpt-5.2-codex'],
  )
})

test('withTimeout bounds a catalogue refresh and the request it started is aborted', async () => {
  const { fetchFn, signals } = abortableHang()
  const adapter = codexAdapter({ session: codexSession, fetchFn, discoveryTimeoutMs: 20 })
  const report = await adapter.refreshOwnCatalog('codex', 'acct')
  assert.deepEqual(report.failed, ['acct'])
  assert.equal(signals.length, 1)
  assert.equal(signals[0].aborted, true, 'a bounded request is aborted, not left running')
  await adapter.drainOwnCatalogs()
})

test('withTimeout still settles when work ignores the abort signal', async () => {
  const models = await withTimeout(() => new Promise<string>(() => undefined), 20)
  assert.equal(models, undefined)
})

test('withTimeout returns the value when work finishes in time', async () => {
  const models = await withTimeout(async () => ['ok'], 50)
  assert.deepEqual(models, ['ok'])
})
