/** The effort writer persists validated choices; catalogue reads belong to providerSettings. */
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { createFakeConnection } from './fake-connection.js'
import type { FakeRpcHandler } from './fake-connection.js'
import {
  defaultEffortOf, loadModelDefaults, resetModelDefaultsForTests,
} from '../src/model-defaults.js'
import * as plugin from '../src/index.js'

/** One private plugin composition with event-based route readiness. */
async function mount(t: TestContext): Promise<{ handler: FakeRpcHandler; replaced: string[] }> {
  const home = await mkdtemp(join(tmpdir(), 'model-defaults-rpc-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    await resetModelDefaultsForTests()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  await resetModelDefaultsForTests()
  const replaced: string[] = []
  ctx.provide('llm', {
    resolveModelInfo: async (provider: string, model: string) => ({
      provider, id: model, name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }],
        defaultEffort: ReasoningEffortId('low'),
      },
    }),
    registerAdapter: () => Object.assign(() => {}, {
      replace: (routes: string[]) => { replaced.push(...routes) },
    }),
  })
  const fake = createFakeConnection()
  const ready = Promise.withResolvers<void>()
  ctx.provide('connection', { fetch: { register: (route: Parameters<typeof fake.connection.fetch.register>[0]) => {
    const stop = fake.connection.fetch.register(route)
    if (route.path === '/api/subscriptions-auth.setModelDefault') ready.resolve()
    return stop
  } } })
  ctx.plugin(plugin, { providers: ['codex'], pool: { enabled: false } })
  await ready.promise
  return { handler: fake.handler, replaced }
}

const call = (handler: FakeRpcHandler, payload: unknown) =>
  handler('setModelDefault', payload, new AbortController().signal)

test('a configured effort survives reloading its durable store and re-announces only its route', async t => {
  const { handler, replaced } = await mount(t)
  const result = await call(handler, { provider: 'codex', model: 'm', effort: 'high' })
  assert.deepEqual(result, { ok: true, value: { ok: true } })
  assert.deepEqual(replaced, ['codex'])
  await resetModelDefaultsForTests()
  await loadModelDefaults()
  assert.equal(defaultEffortOf('codex', 'm'), 'high')
})

test('clearing an effort removes only that model override', async t => {
  const { handler } = await mount(t)
  await call(handler, { provider: 'codex', model: 'm', effort: 'high' })
  await call(handler, { provider: 'codex', model: 'sibling', effort: 'low' })
  assert.equal((await call(handler, { provider: 'codex', model: 'm' })).ok, true)
  assert.equal(defaultEffortOf('codex', 'm'), undefined)
  assert.equal(defaultEffortOf('codex', 'sibling'), 'low')
})

test('the effort writer rejects invalid providers, empty values and unsupported levels', async t => {
  const { handler } = await mount(t)
  for (const payload of [
    { provider: 'nope', model: 'm', effort: 'high' },
    { provider: 'codex', model: 'm', effort: '' },
    { provider: 'codex', model: 'm', effort: 'max' },
  ]) {
    const result = await call(handler, payload)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'bad-request')
  }
  assert.equal(defaultEffortOf('codex', 'm'), undefined)
})

test('there is no unscoped modelDefaults read endpoint that can refresh every provider', async t => {
  const { handler } = await mount(t)
  await assert.rejects(handler('modelDefaults', { force: true }, new AbortController().signal), /no route registered/)
})
