/**
 * The composer Speed control's two halves. The client half decides visibility from the session's
 * current provider and the node half's fast-capable listing, and addresses the stored tier by that
 * model; the node half lists fast-capable models from the addressed provider only and answers
 * the tier stored for the addressed model. Both are asserted here, so a control that
 * would switch nothing stays hidden and a route that can switch stays reachable.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// The section imports host primitives that ship CSS modules; this spec needs only their empty
// class map, not a browser stylesheet loader.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css')
    ? { format: 'module', source: 'export default {}', shortCircuit: true }
    : nextLoad(url, context)
} })
const { createSpeedLoader, createSpeedSetter, settleChoice, settleRead, speedControlVisible }
  = await import('../src/client/SpeedSelect.js')
css.deregister()
import type { ModelDirectoriesLike, SpeedView } from '../src/client/SpeedSelect.js'
import { createFakeConnection } from './fake-connection.js'
import type { FakeRpcHandler } from './fake-connection.js'
import { saveAccountSession } from '../src/auth/store.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { SpeedState, SpeedTier } from '../src/client/SpeedSelect.js'
import { CodexAdapter } from '../src/providers/codex.js'
import { CursorAdapter } from '../src/providers/cursor.js'
import { ClaudeAdapter } from '../src/providers/claude.js'

const plugin = await import('../src/index.js')

/** A stored claude login; these tests never reach the wire with it. */
const CLAUDE_SESSION: ClaudeSession = {
  accessToken: 'test-at',
  refreshToken: 'test-rt',
  expiresAt: Date.now() + 3_600_000,
  scopes: 'user:inference',
}

/** Mount the plugin for the claude route alone and return its RPC handler. */
async function mount(): Promise<FakeRpcHandler> {
  const ctx = new Context()
  ctx.provide('llm', { registerAdapter: () => Object.assign(() => {}, { replace: () => {} }) })
  const fake = createFakeConnection()
  ctx.provide('connection', fake.connection)
  ctx.plugin(plugin, { providers: ['claude'], pool: { enabled: false } })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(fake.registered(), 'the subscriptions-auth routes were registered')
  return fake.handler
}

test('the Speed control is reachable for every route whose models carry a fast tier', () => {
  // The three routes with a per-model fast capability: Claude's catalogue `fast_mode`, Codex's
  // priority service tier and Cursor's `fast` parameter.
  for (const provider of ['claude', 'codex', 'cursor']) {
    assert.equal(speedControlVisible({ provider, model: 'm' }, ['m']), true, provider)
  }
  // A route with no per-model fast tier never shows the control, however the listing is built.
  for (const provider of ['grok', 'copilot', 'antigravity']) {
    assert.equal(speedControlVisible({ provider, model: 'm' }, ['m']), false, provider)
  }
  // The model half: a model the node half does not list as fast-capable cannot be switched, and
  // a session with no model selection has nothing to switch.
  assert.equal(speedControlVisible({ provider: 'claude', model: 'claude-fable-5' }, ['claude-opus-5']), false)
  assert.equal(speedControlVisible(null, ['claude-opus-5']), false)
})

test('a settled choice outranks a read that started before it', () => {
  // The control watches this shape: the state it last published plus the generation its reads
  // are stamped with.
  const reading: SpeedView = { generation: 0, state: { visible: true, tier: 'standard' } }
  // The race: a 3 s poll starts (stamped with the generation it starts under), the user picks
  // Fast, and only then does the slower poll settle. Publishing it would put the replaced tier
  // back on screen, which is the setting appearing to revert to standard on its own.
  const read = reading.generation
  const chosen = settleChoice(reading, 'fast')
  assert.deepEqual(chosen, { generation: 1, state: { visible: true, tier: 'fast' } })
  assert.equal(
    settleRead(chosen, read, { visible: true, tier: 'standard' }),
    chosen,
    'the superseded read cannot undo the choice',
  )

  // A read the current generation still owns is what keeps the control following the host: the
  // selector hides and returns as the session's model changes.
  assert.deepEqual(
    settleRead(chosen, chosen.generation, { visible: false, tier: 'fast' }),
    { generation: 1, state: { visible: false, tier: 'fast' } },
  )
})

test('the speed endpoint offers the claude models the pinned catalogue marks fast', async () => {
  await saveAccountSession('claude', 'acct', CLAUDE_SESSION)
  const handler = await mount()
  const result = await handler('speed', { provider: 'claude', model: 'claude-opus-5' }, new AbortController().signal)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const state = result.value as SpeedState
  assert.deepEqual(state.fastModels, ['claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5'])
  // The listing is the node half's answer to the client gate: every id it names is one the
  // control offers, and a catalogue model without the capability is not among them.
  for (const model of state.fastModels) assert.equal(speedControlVisible({ provider: 'claude', model }, state.fastModels), true)
  assert.equal(speedControlVisible({ provider: 'claude', model: 'claude-fable-5' }, state.fastModels), false)
})

test('reading one provider model\'s speed does not enumerate unrelated providers', async (t) => {
  const codex = t.mock.method(CodexAdapter.prototype, 'fastCapableModels', async () => ['codex-fast'])
  const cursor = t.mock.method(CursorAdapter.prototype, 'fastCapableModels', async () => ['cursor-fast'])
  const claude = t.mock.method(ClaudeAdapter.prototype, 'fastCapableModels', async () => ['claude-opus-5'])
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('llm', { registerAdapter: () => Object.assign(() => {}, { replace: () => {} }) })
  const fake = createFakeConnection()
  const ready = Promise.withResolvers<void>()
  ctx.provide('connection', { fetch: { register: (route: Parameters<typeof fake.connection.fetch.register>[0]) => {
    const dispose = fake.connection.fetch.register(route)
    if (route.path === '/api/subscriptions-auth.speed') ready.resolve()
    return dispose
  } } })
  ctx.plugin(plugin, { providers: ['codex', 'cursor', 'claude'], pool: { enabled: false } })
  await ready.promise
  for (const [provider, model] of [['claude', 'claude-opus-5'], ['codex', 'codex-fast'], ['cursor', 'cursor-fast']]) {
    codex.mock.resetCalls()
    cursor.mock.resetCalls()
    claude.mock.resetCalls()
    const result = await fake.handler('speed', { provider, model }, new AbortController().signal)
    assert.equal(result.ok, true)
    assert.equal(codex.mock.callCount(), Number(provider === 'codex'), `${provider}: Codex discovery`)
    assert.equal(cursor.mock.callCount(), Number(provider === 'cursor'), `${provider}: Cursor discovery`)
    assert.equal(claude.mock.callCount(), Number(provider === 'claude'), `${provider}: Claude lookup`)
    if (result.ok) assert.deepEqual((result.value as SpeedState).fastModels, [model])
  }
})

/** One session's model directory, as the host service answers it. */
function directories(current: { provider: string; model: string } | null): ModelDirectoriesLike {
  return { directoryFor: () => ({ load: async () => ({ current }) }) }
}

/**
 * The Connection RPC face the control calls through, recording every endpoint it reaches.
 * `model` doubles as the session's current selection for the loader and the setter.
 */
function speedRpc(
  model: { provider: string; model: string } | null,
  tier: SpeedTier,
  fastModels: string[],
): { rpc: ConnectionHandle['rpc']; calls: { endpoint: string; payload: unknown }[]; available: () => ModelDirectoriesLike | undefined } {
  const calls: { endpoint: string; payload: unknown }[] = []
  return {
    calls,
    available: () => directories(model),
    rpc: {
      call: (_channel, endpoint, payload) => {
        calls.push({ endpoint, payload })
        return Promise.resolve(endpoint === 'subscriptions-auth.speed'
          ? { ok: true as const, value: { tier, fastModels } }
          : { ok: true as const, value: { ok: true } })
      },
    },
  }
}

test('the composer control reads and writes the tier of the session\'s current model', async () => {
  const { rpc, calls, available } = speedRpc({ provider: 'claude', model: 'claude-opus-5' }, 'fast', ['claude-opus-5'])
  assert.deepEqual(await createSpeedLoader(rpc, available, 'session-1')(), { visible: true, tier: 'fast' })
  assert.deepEqual(calls, [{ endpoint: 'subscriptions-auth.speed', payload: { provider: 'claude', model: 'claude-opus-5' } }])
  // The write addresses the same model, so the stored tier follows the model rather than the
  // session it was chosen in.
  assert.equal(await createSpeedSetter(rpc, available, 'session-1')('standard'), true)
  assert.deepEqual(calls[1], {
    endpoint: 'subscriptions-auth.setSpeed',
    payload: { provider: 'claude', model: 'claude-opus-5', tier: 'standard' },
  })
})

test('the composer control hides and writes nothing without a current model', async () => {
  const { rpc, calls, available } = speedRpc(null, 'fast', ['claude-opus-5'])
  assert.deepEqual(await createSpeedLoader(rpc, available, 'session-1')(), { visible: false, tier: 'standard' })
  assert.equal(await createSpeedSetter(rpc, available, 'session-1')('fast'), false)
  // A shell with no model-selection service keeps the control hidden too.
  assert.deepEqual(await createSpeedLoader(rpc, () => undefined, 'session-1')(), { visible: false, tier: 'standard' })
  assert.equal(await createSpeedSetter(rpc, () => undefined, 'session-1')('fast'), false)
  assert.deepEqual(calls, [], 'no endpoint is called without a model to address')
})

test('providers without a speed control make no speed RPC calls', async () => {
  for (const provider of ['deepseek-official', 'grok', 'copilot', 'antigravity']) {
    const { rpc, calls, available } = speedRpc({ provider, model: 'm' }, 'fast', ['m'])
    const state = await createSpeedLoader(rpc, available, 'session-1')()
    assert.deepEqual(calls, [], `${provider}: no read`)
    assert.deepEqual(state, { visible: false, tier: 'standard' })
    assert.equal(await createSpeedSetter(rpc, available, 'session-1')('fast'), false)
    assert.deepEqual(calls, [], `${provider}: no write`)
  }
})

test('a failed speed write settles as a failed choice rather than rejecting', async () => {
  // The composer leaves its busy state on the promise's settlement, so a rejection would stick
  // the control; the fetch failure has to arrive as `false`.
  const rpc: ConnectionHandle['rpc'] = { call: () => Promise.reject(new Error('offline')) }
  const available = () => directories({ provider: 'claude', model: 'claude-opus-5' })
  assert.equal(await createSpeedSetter(rpc, available, 'session-1')('fast'), false)
})
