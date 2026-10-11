/**
 * The composer Speed control's two halves. The client half decides visibility from the session's
 * current provider and the node half's fast-capable listing; the node half builds that listing
 * from every route whose models carry a fast tier. Both are asserted here, so a control that
 * would switch nothing stays hidden and a route that can switch stays reachable.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
// The section imports host primitives that ship CSS modules; this spec needs only their empty
// class map, not a browser stylesheet loader.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css')
    ? { format: 'module', source: 'export default {}', shortCircuit: true }
    : nextLoad(url, context)
} })
const { settleChoice, settleRead, speedControlVisible } = await import('../src/client/SpeedSelect.js')
css.deregister()
import type { SpeedView } from '../src/client/SpeedSelect.js'
import { createFakeConnection } from './fake-connection.js'
import type { FakeRpcHandler } from './fake-connection.js'
import { saveAccountSession } from '../src/auth/store.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { SpeedState } from '../src/client/SpeedSelect.js'

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
  const result = await handler('speed', { sessionId: 'session-1' }, new AbortController().signal)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const state = result.value as SpeedState
  assert.deepEqual(state.fastModels, ['claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5'])
  // The listing is the node half's answer to the client gate: every id it names is one the
  // control offers, and a catalogue model without the capability is not among them.
  for (const model of state.fastModels) assert.equal(speedControlVisible({ provider: 'claude', model }, state.fastModels), true)
  assert.equal(speedControlVisible({ provider: 'claude', model: 'claude-fable-5' }, state.fastModels), false)
})
