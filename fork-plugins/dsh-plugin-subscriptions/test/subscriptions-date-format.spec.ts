/**
 * Absolute times in the settings surfaces. `Date#toLocaleString` follows the
 * browser language, so the browser-language formatter this helper replaces is
 * asserted absent from the Client sources as well as covered by output.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatDateTime } from '../src/client/format.js'
import { en, zh } from '../src/client/locales.js'

/** Dictionary-bound translator with `{name}` substitution, as the locale seat supplies it. */
function translateFrom(dictionary: Record<keyof typeof en, string>) {
  return (key: keyof typeof en, params?: Record<string, unknown>): string =>
    dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

test('absolute times follow the dictionary date template in both languages', () => {
  const at = new Date(2026, 6, 12, 9, 5).getTime()
  assert.equal(formatDateTime(translateFrom(en), at), '2026-7-12 09:05')
  assert.equal(formatDateTime(translateFrom(zh), at), '2026年7月12日 09:05')
})

test('no Client source formats dates through the browser locale', async () => {
  // The scan follows whichever Client tree sits beside this spec: the compiled
  // half during `npm test`, or the TypeScript sources when run through tsx.
  const dir = fileURLToPath(new URL('../src/client/', import.meta.url))
  const sources = (await readdir(dir, { recursive: true })).filter(file => /\.(ts|tsx|js)$/.test(file))
  assert.ok(sources.length > 0, 'the Client source scan found no file')
  for (const file of sources) {
    const source = await readFile(join(dir, file), 'utf8')
    assert.ok(!source.includes('toLocaleString'), `${file} must format through formatDateTime`)
  }
})
