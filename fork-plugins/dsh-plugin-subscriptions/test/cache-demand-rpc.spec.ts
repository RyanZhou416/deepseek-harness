/** Display RPCs read snapshots; only scoped, explicit refresh flags contact catalogue owners. */
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.js'
import { saveAccountSession } from '../src/auth/store.js'
import { CodexAdapter } from '../src/providers/codex.js'
import { ClaudeAdapter } from '../src/providers/claude.js'
import { createFakeConnection } from './fake-connection.js'

async function mount(t: TestContext) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const adapters = new Map<string, LlmAdapter>()
  ctx.provide('llm', {
    // The Claude route registers only against a host that declares failure recovery 1.
    failureRecoveryVersion: 1,
    registerAdapter: (providers: string[], adapter: LlmAdapter) => {
      for (const provider of providers) adapters.set(provider, adapter)
      return Object.assign(() => {}, { replace: () => {} })
    },
    resolveModelInfo: (provider: string, model: string) => adapters.get(provider)!.resolveModel(provider, model),
  })
  // The Claude route mounts only while a Host provides the recording seam; these
  // reads never prepare a request, so the recorder only has to exist.
  ctx.provide('llmRequestRecord', {
    recordPreparedRequest: async () => ({ ok: false, code: 'REQUEST_RECORD_UNAVAILABLE' }),
  })
  const fake = createFakeConnection()
  const ready = Promise.withResolvers<void>()
  ctx.provide('connection', { fetch: { register: (route: Parameters<typeof fake.connection.fetch.register>[0]) => {
    const dispose = fake.connection.fetch.register(route)
    if (route.path === '/api/subscriptions-auth.providerSettings') ready.resolve()
    return dispose
  } } })
  ctx.plugin(plugin, { providers: ['claude', 'codex'], pool: { enabled: false } })
  await ready.promise
  const call = (endpoint: string, payload: unknown) => fake.handler(endpoint, payload, new AbortController().signal)
  return { call, adapters }
}

test('repeated model and display reads do not request catalogue or usage refreshes', async t => {
  await saveAccountSession('claude', 'c', {
    accessToken: 'fixture-at', refreshToken: 'fixture-rt', expiresAt: Date.now() + 3_600_000, scopes: 'user:inference',
  })
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected external read') })
  const claudeRefresh = t.mock.method(ClaudeAdapter.prototype, 'refreshOwnCatalog', async () => ({ fetched: [], skipped: ['c'], failed: [], cancelled: [] }))
  const codexRefresh = t.mock.method(CodexAdapter.prototype, 'refreshOwnCatalog', async () => ({ fetched: [], skipped: [], failed: [], cancelled: [] }))
  const { call, adapters } = await mount(t)
  for (let index = 0; index < 3; index += 1) {
    const route = adapters.get('claude')!
    assert.ok((await route.listModels('claude')).length > 0)
    await route.resolveModel('claude', 'claude-opus-5')
    assert.equal((await call('providerSettings', { provider: 'claude' })).ok, true)
    assert.equal((await call('usage', { provider: 'claude', account: 'c' })).ok, true)
    assert.equal((await call('speed', { provider: 'claude', model: 'claude-opus-5' })).ok, true)
  }
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(claudeRefresh.mock.callCount(), 0)
  assert.equal(codexRefresh.mock.callCount(), 0)
  assert.equal((await call('providerSettings', { provider: 'claude', refresh: true })).ok, true)
  assert.equal(claudeRefresh.mock.callCount(), 1)
  assert.equal(codexRefresh.mock.callCount(), 0, 'Manage only addresses the requested provider')
})

test('refresh flags reject ambiguous payloads before contacting a provider', async t => {
  const { call } = await mount(t)
  for (const endpoint of ['usage', 'providerSettings']) {
    const result = await call(endpoint, { provider: 'claude', account: 'c', refresh: 'yes' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'bad-request')
  }
})
