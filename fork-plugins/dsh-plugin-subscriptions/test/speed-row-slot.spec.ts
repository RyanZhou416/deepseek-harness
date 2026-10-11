/**
 * The composer's two model-facing contributions, asserted against the plugin's
 * real apply path: the Speed row is contributed to ui-model-selection's additive
 * `conversation.input.model.row` child slot (and the composer's own tool row
 * carries no second control), the usage badge is contributed to the dock, and
 * both bind the session's model selection as a bare observable source.
 *
 * The forwarded-Host-event cases live here too: a finished run re-reads the
 * provider behind a session the composer is actually rendering, and an event for
 * a session no surface ever opened neither throws nor creates a model directory.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
// The client half reaches host primitives that ship CSS modules; this spec needs only
// their empty class map, not a browser stylesheet loader.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css')
    ? { format: 'module', source: 'export default {}', shortCircuit: true }
    : nextLoad(url, context)
} })
const { apply, inject } = await import('../src/client/index.js')
css.deregister()
import type { SpeedSelectInjected } from '../src/client/SpeedSelect.js'
import type { SubscriptionUsageBadgeInjected } from '../src/client/SubscriptionUsageBadge.js'

/** One recorded slot registration. */
interface Registration {
  name: string
  id?: string
  locale?: string
  inject?: (sessionId: string) => SpeedSelectInjected & SubscriptionUsageBadgeInjected
}

/** One recorded RPC call. */
interface Call {
  endpoint: string
  payload: Record<string, unknown>
}

/** The DOM the plugin's settings-panel style effect needs; nothing here renders. */
const styleElement = { setAttribute: () => {}, textContent: '', remove: () => {} }

/** One mounted plugin application plus the fakes its registrations reach. */
interface Mounted {
  registrations: Map<string, Registration>
  calls: Call[]
  directoryFor: string[]
  /** Fire one forwarded Host event. */
  emit: (name: string, ...args: unknown[]) => void
  /** Fire one context event (the connection-generation reset). */
  emitContext: (name: string, ...args: unknown[]) => void
  /** Current model selection the directories answer with. */
  setModel: (current: { provider: string; model: string } | null) => void
}

/** Mount the client half over fake slot/locale/connection/remote/model faces. */
async function mount(): Promise<Mounted> {
  const style = styleElement
  Object.defineProperty(globalThis, 'document', {
    value: { createElement: () => style, head: { appendChild: () => {} } },
    configurable: true,
  })
  try {
    const ctx = new Context()
    const registrations = new Map<string, Registration>()
    const calls: Call[] = []
    const directoryFor: string[] = []
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    let current: { provider: string; model: string } | null = { provider: 'claude', model: 'claude-opus-5' }
    ctx.provide('slots', {
      inject(_name: string, callback: () => () => void): () => void { return callback() },
      register(options: Registration): () => void {
        registrations.set(options.name, options)
        return () => { registrations.delete(options.name) }
      },
    })
    ctx.provide('locale', {
      register: () => () => {},
      bind: () => (key: string) => key,
    })
    ctx.provide('connection', {
      rpc: { call: (_channel: string, endpoint: string, payload: unknown) => {
        calls.push({ endpoint, payload: payload as Record<string, unknown> })
        return Promise.resolve({
          ok: true as const,
          value: endpoint === 'subscriptions-auth.status'
            ? { providers: { claude: { busy: false, accounts: [{ key: 'default', isDefault: true }] } } }
            : { supported: true, windows: [] },
        })
      } },
    })
    ctx.provide('modelDirectories', {
      directoryFor: (sessionId: string) => {
        directoryFor.push(sessionId)
        return {
          store: { getSnapshot: () => ({ current }), subscribe: () => () => {} },
          load: async () => ({ current }),
        }
      },
    })
    ctx.provide('remote', {
      $on: (name: string, listener: (...args: unknown[]) => void) => {
        const list = listeners.get(name) ?? []
        list.push(listener)
        listeners.set(name, list)
        return () => { listeners.set(name, (listeners.get(name) ?? []).filter(entry => entry !== listener)) }
      },
    })
    apply(ctx)
    // The model-facing contributions register inside a service wait, so let the
    // fibers that own them reach their callback before anything is read.
    await settle()
    return {
      registrations,
      calls,
      directoryFor,
      emit: (name, ...args) => { for (const listener of listeners.get(name) ?? []) listener(...args) },
      emitContext: (name, ...args) => {
        const emit = ctx.emit as (event: string, ...payload: unknown[]) => void
        emit(name, ...args)
      },
      setModel: (next) => { current = next },
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'document')
  }
}

/** Settle the microtask chain one event's read runs through. */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

test('the Speed control is a row inside the model menu, and the composer tool row carries none', async () => {
  const mounted = await mount()
  const row = mounted.registrations.get('conversation.input.model.row')
  assert.ok(row, 'the Speed row is contributed to the model menu seat')
  assert.equal(row.id, 'codex-speed')
  assert.equal(row.locale, 'settings.subscriptions', 'the row renders through the plugin dictionary')
  // The standalone chip and the row would be one setting in two places.
  assert.equal(mounted.registrations.has('conversation.input.right'), false)
  // The row's inject face is session-bound and carries the model source the
  // framework binds to `useModel`.
  const face = row.inject!('session-1')
  assert.equal(typeof face.loadSpeed, 'function')
  assert.equal(typeof face.setSpeed, 'function')
  assert.equal(typeof face.hooks.model.getSnapshot, 'function')
  assert.deepEqual(face.hooks.model.getSnapshot(), { provider: 'claude', model: 'claude-opus-5' })
  assert.deepEqual(mounted.directoryFor, ['session-1'], 'the row resolved its session directory once')
})

test('the usage badge is contributed to the composer dock over the shared cache', async () => {
  const mounted = await mount()
  const dock = mounted.registrations.get('conversation.composer.dock')
  assert.ok(dock, 'the usage badge is contributed to the dock')
  assert.equal(dock.id, 'subscription-usage')
  const face = dock.inject!('session-2')
  assert.equal(typeof face.readStatus, 'function')
  assert.equal(typeof face.readUsage, 'function')
  assert.equal(typeof face.hooks.usage.getSnapshot, 'function')
  assert.equal(typeof face.hooks.model.getSnapshot, 'function')
})

test('a finished run re-reads only a session the composer is rendering', async () => {
  const mounted = await mount()
  const row = mounted.registrations.get('conversation.input.model.row')!
  const face = row.inject!('session-1')
  const stop = face.hooks.model.subscribe(() => {})
  // The page has read the roster (a badge mount, or a credential change).
  mounted.emit('credentials/reference-updated')
  await settle()
  mounted.calls.length = 0

  // The session was never running: nothing to re-read.
  mounted.emit('api-session/status', 'session-1', false)
  await settle()
  assert.equal(mounted.calls.length, 0)

  mounted.emit('api-session/status', 'session-1', true)
  mounted.emit('api-session/status', 'session-1', false)
  await settle()
  assert.deepEqual(mounted.calls.map(call => call.payload), [
    { provider: 'claude', account: 'default' },
  ])

  // A session no surface ever opened neither throws nor creates a directory.
  mounted.emit('api-session/status', 'never-opened', true)
  mounted.emit('api-session/status', 'never-opened', false)
  await settle()
  assert.deepEqual(mounted.directoryFor, ['session-1'], 'no directory was created for the foreign id')
  assert.equal(mounted.calls.length, 1, 'the foreign id caused no read')

  // An unbound session stops being addressed once its surface unmounts.
  stop()
  mounted.emit('api-session/status', 'session-1', true)
  mounted.emit('api-session/status', 'session-1', false)
  await settle()
  assert.equal(mounted.calls.length, 1)
})

test('a credential change elsewhere re-reads the local roster once', async () => {
  const mounted = await mount()
  mounted.calls.length = 0
  mounted.emit('credentials/reference-updated')
  mounted.emit('llm/adapters-updated')
  await settle()
  // The two events collapse into one roster read, and that answer seeds the
  // first local snapshot read for the account it lists.
  assert.deepEqual(mounted.calls.map(call => call.endpoint), [
    'subscriptions-auth.status',
    'subscriptions-auth.usage',
  ])
})

test('a new connection generation forgets the old roster before reading the new one', async () => {
  const mounted = await mount()
  await settle()
  mounted.calls.length = 0
  mounted.emitContext('connection/reset')
  await settle()
  assert.deepEqual(mounted.calls.map(call => call.endpoint), [
    'subscriptions-auth.status',
    'subscriptions-auth.usage',
  ])
})

test('the plugin requires the seats its contributions bind', () => {
  assert.deepEqual(inject, ['slots', 'connection', 'locale'])
})
