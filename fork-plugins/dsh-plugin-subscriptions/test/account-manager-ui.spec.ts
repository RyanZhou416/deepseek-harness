import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accountPoolSelection,
  mergeAccountChanges,
  mergeLatestAccounts,
  modelPoolCells,
  unlistedPoolModels,
} from '../src/client/account-preferences.js'
import type { ModelPoolAccount } from '../src/client/account-preferences.js'
import { fallbackTranslate, modelRowLabel } from '../src/client/format.js'
import { en, zh } from '../src/client/locales.js'

const models = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]
test('account pool defaults include newly discovered models; [] includes none', () => {
  assert.deepEqual([...accountPoolSelection({}, models)], ['a', 'b'])
  assert.deepEqual([...accountPoolSelection({ poolModels: [] }, models)], [])
  assert.deepEqual([...accountPoolSelection({ poolModels: ['a'] }, models)], ['a'])
})

/** Two accounts over one catalog; the second allows only `Beta` and still names a dropped id. */
const accounts: ModelPoolAccount[] = [
  { key: 'personal', label: 'Personal', models: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] },
  { key: 'work', label: 'Work', models: [{ id: 'b', name: 'Beta', disabledReason: 'no longer offered' }] },
]
const selection = (key: string): ReadonlySet<string> => key === 'personal'
  ? accountPoolSelection({}, models)
  : accountPoolSelection({ poolModels: ['b', 'gone'] }, [{ id: 'b' }])

test('one model states every account\'s pool membership on its own row', () => {
  // The model list is the only place a model is listed, so each account's membership has to
  // ride that model's row: one cell per account whose catalog lists it, carrying the
  // account's own refusal reason when the provider stated one.
  assert.deepEqual(modelPoolCells('b', accounts, selection), [
    { key: 'personal', label: 'Personal', allowed: true },
    { key: 'work', label: 'Work', allowed: true, disabledReason: 'no longer offered' },
  ])
  assert.deepEqual(modelPoolCells('a', accounts, selection), [
    { key: 'personal', label: 'Personal', allowed: true },
  ])
})

test('a saved pool membership the catalog dropped keeps both its row and its cell', () => {
  // `work` still names `gone`, which no catalog lists any more: the id stays listed so the
  // account's selection is neither lost nor silently widened.
  assert.deepEqual(unlistedPoolModels(accounts, selection), ['gone'])
  assert.deepEqual(modelPoolCells('gone', accounts, selection), [
    { key: 'work', label: 'Work', allowed: true },
  ])
  // An automatic selection is the catalog itself, so nothing is unlisted.
  assert.deepEqual(unlistedPoolModels([accounts[0]!], () => accountPoolSelection({}, models)), [])
})

test('model editor saves latest accounts, not its old draft, including removal', () => {
  const draft = { visibleModels: ['a'], accounts: { personal: { alias: 'Old' } } }
  assert.deepEqual(mergeLatestAccounts(draft, { accounts: { personal: { alias: 'New', poolEnabled: false } } }), {
    visibleModels: ['a'], accounts: { personal: { alias: 'New', poolEnabled: false } },
  })
  assert.deepEqual(mergeLatestAccounts(draft, {}), { visibleModels: ['a'] })
  assert.equal(draft.accounts.personal.alias, 'Old')
})
test('account manager preserves latest other settings and untouched accounts', () => {
  const latest = { visibleModels: [], tools: { image_generate: false }, contextWindows: { a: 1000 },
    accounts: { work: { alias: 'Work' }, personal: { alias: 'Old' } } }
  assert.deepEqual(mergeAccountChanges(latest, { personal: { poolEnabled: false, independentEntry: true, poolModels: [] } }), {
    ...latest, accounts: { work: { alias: 'Work' }, personal: { poolEnabled: false, independentEntry: true, poolModels: [] } },
  })
  assert.equal(latest.accounts.personal.alias, 'Old')
})

test('a model draft cannot overwrite a newer automatic-credit setting', () => {
  assert.deepEqual(mergeLatestAccounts({ autoResetCredits: false, visibleModels: ['a'] }, { autoResetCredits: true }), {
    autoResetCredits: true, visibleModels: ['a'],
  })
  assert.deepEqual(mergeLatestAccounts({ autoResetCredits: true, visibleModels: ['a'] }, {}), { visibleModels: ['a'] })
})
test('a model the provider refuses is still listed once, with its marker', () => {
  const listed = modelPoolCells('gone', [{ key: 'personal', label: 'Personal', models: [{ id: 'gone', name: 'Gone' }] }], () => new Set(['gone']))
  assert.deepEqual(listed, [{ key: 'personal', label: 'Personal', allowed: true }])
  assert.equal(
    modelRowLabel(fallbackTranslate, { name: 'Gone', disabledReason: 'no longer offered' }),
    'Gone (Disabled by the provider: no longer offered)',
  )
})

/** The zh dictionary read through the same template substitution the locale seat performs. */
function zhTranslate(key: keyof typeof en, params?: Record<string, unknown>): string {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

test('a model row states the provider\'s own reason beside its name in both languages', () => {
  assert.equal(
    modelRowLabel(fallbackTranslate, { name: 'Retired', disabledReason: 'no longer offered' }),
    'Retired (Disabled by the provider: no longer offered)',
  )
  assert.equal(
    modelRowLabel(zhTranslate, { name: 'Retired', disabledReason: 'no longer offered' }),
    'Retired (已被服务商禁用：no longer offered)',
  )
  // The two markers are independent: a saved model the catalog no longer lists keeps
  // its "currently unavailable" suffix, and an ordinary row carries neither.
  assert.equal(
    modelRowLabel(fallbackTranslate, { name: 'Retired', disabledReason: 'gone', unavailable: true }),
    'Retired (Disabled by the provider: gone) (Currently unavailable)',
  )
  assert.equal(modelRowLabel(fallbackTranslate, { name: 'Alpha' }), 'Alpha')
})

test('account manager has bilingual copy and explicitly limits isolation claims', () => {
  for (const key of Object.keys(en).filter(key => key.startsWith('accounts')) as (keyof typeof en)[]) {
    assert.ok(en[key].length)
    assert.ok(zh[key].length)
  }
  assert.match(en.accountsHint, /only to LLM routing/)
  assert.match(en.accountsIndependentHint, /no fallback/)
  assert.match(zh.accountsIndependentHint, /不会回退/)
})
