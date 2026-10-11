/**
 * The Manage dialog's model list rows. The list is the only place that dialog lists a model,
 * so one model is one row: the provider's catalog in its own order, then the saved ids the
 * catalog no longer lists (a hidden model, or a saved pool membership), filtered by search.
 * No DOM and no React — this is the whole composition the list renders from.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeModelRows } from '../src/client/ProviderModelEditor.js'
import type { ModelRow } from '../src/client/ProviderModelEditor.js'

/** A two-model provider catalog carrying the per-row settings the list renders. */
const catalog: ModelRow[] = [
  { id: 'sonnet', name: 'Sonnet', efforts: [{ id: 'high', name: 'High' }] },
  { id: 'opus', name: 'Opus', fastTier: true },
]

test('the model list renders each model once, in catalog order, with its own row settings', () => {
  const rows = composeModelRows(catalog, [], '')
  assert.deepEqual(rows.map(row => row.id), ['sonnet', 'opus'])
  // The row keeps the catalog entry, so its visibility checkbox, effort and speed selectors
  // all render from that one row rather than from a second list of the same names.
  assert.equal(rows[0]?.efforts?.length, 1)
  assert.equal(rows[1]?.fastTier, true)
})

test('a saved id the catalog no longer lists gets its own row exactly once', () => {
  // A hidden model and a saved pool membership both reach this list as raw ids.
  assert.deepEqual(composeModelRows(catalog, ['gone', 'sonnet'], '').map(row => row.id), ['sonnet', 'opus', 'gone'])
  assert.deepEqual(composeModelRows(catalog, ['gone', 'gone', 'sonnet'], '').map(row => row.id), ['sonnet', 'opus', 'gone'])
  // The synthesized row carries its id as the display name, so it reads as the raw model.
  assert.deepEqual(composeModelRows([], ['gone'], '')[0], { id: 'gone', name: 'gone' })
})

test('the search box filters the composed rows by name or id', () => {
  assert.deepEqual(composeModelRows(catalog, ['gone'], '  OPUS ').map(row => row.id), ['opus'])
  assert.deepEqual(composeModelRows(catalog, ['gone'], 'gon').map(row => row.id), ['gone'])
  assert.deepEqual(composeModelRows(catalog, ['gone'], 'nothing').map(row => row.id), [])
  assert.deepEqual(composeModelRows(catalog, ['gone'], '   ').map(row => row.id), ['sonnet', 'opus', 'gone'])
})
