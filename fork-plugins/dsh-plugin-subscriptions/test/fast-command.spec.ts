/**
 * The `/fast` popup settles a picked tier through the session's speed setter.
 * The popup shell states a settlement failure only through its own error strip,
 * so a write that answers false must arrive as a rejected settlement carrying
 * the dictionary's failure copy — the same copy the composer control shows in
 * place. Both outcomes are asserted in both languages.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
// The section imports host primitives that ship CSS modules; this pure-logic
// spec needs only their empty class map, not a browser stylesheet loader.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css')
    ? { format: 'module', source: 'export default {}', shortCircuit: true }
    : nextLoad(url, context)
} })
const { settleSpeedTier } = await import('../src/client/SpeedSelect.js')
css.deregister()
import { en, zh } from '../src/client/locales.js'

/** Dictionary-bound translator with `{name}` substitution, as the locale seat supplies it. */
function translateFrom(dictionary: Record<keyof typeof en, string>) {
  return (key: keyof typeof en): string => dictionary[key]
}

test('a failed speed write rejects the /fast settlement with the failure copy', async () => {
  for (const dictionary of [en, zh]) {
    await assert.rejects(
      settleSpeedTier(async () => false, 'fast', translateFrom(dictionary)),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, dictionary.speedSaveFailed)
        return true
      },
    )
  }
})

test('a speed write that takes settles the /fast selection and asks for the picked tier', async () => {
  const asked: string[] = []
  await settleSpeedTier(
    async (tier) => { asked.push(tier); return true },
    'standard',
    translateFrom(en),
  )
  assert.deepEqual(asked, ['standard'])
})
