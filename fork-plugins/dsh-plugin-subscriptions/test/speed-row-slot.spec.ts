/**
 * The composer's Speed setting has one control, and it is a row of the model menu: mounting
 * the client half contributes `codex-speed` to ui-model-selection's additive
 * `conversation.input.model.row` child slot, alongside the model and effort cells, and
 * contributes nothing to the composer's own tool row — a second control there would be the
 * same setting twice. The row's inject face binds the session's RPC calls.
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

/** One recorded slot registration. */
interface Registration {
  name: string
  id?: string
  locale?: string
  inject?: (sessionId: string) => SpeedSelectInjected
}

/** The DOM the plugin's settings-panel style effect needs; nothing here renders. */
const styleElement = { setAttribute: () => {}, textContent: '', remove: () => {} }

/** Mount the client half over fake slot/locale/connection faces. */
function mount(): Map<string, Registration> {
  const style = styleElement
  Object.defineProperty(globalThis, 'document', {
    value: { createElement: () => style, head: { appendChild: () => {} } },
    configurable: true,
  })
  try {
    const ctx = new Context()
    const registrations = new Map<string, Registration>()
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
    ctx.provide('connection', { rpc: { call: () => Promise.resolve({ ok: true, value: {} }) } })
    apply(ctx)
    return registrations
  } finally {
    Reflect.deleteProperty(globalThis, 'document')
  }
}

test('the Speed control is a row inside the model menu, and the composer tool row carries none', () => {
  const registrations = mount()
  const row = registrations.get('conversation.input.model.row')
  assert.ok(row, 'the Speed row is contributed to the model menu seat')
  assert.equal(row.id, 'codex-speed')
  assert.equal(row.locale, 'settings.subscriptions', 'the row renders through the plugin dictionary')
  // The standalone chip and the row would be one setting in two places.
  assert.equal(registrations.has('conversation.input.right'), false)
  // The row's inject face is session-bound, exactly as the seat's own entries are.
  const face = row.inject!('session-1')
  assert.equal(typeof face.loadSpeed, 'function')
  assert.equal(typeof face.setSpeed, 'function')
})
