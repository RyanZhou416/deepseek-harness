import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountModelRows, accountPoolSelection, mergeAccountChanges, mergeLatestAccounts } from '../src/client/account-preferences.js'
import { en, zh } from '../src/client/locales.js'

const models = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]
test('account pool defaults include newly discovered models; [] includes none', () => {
  assert.deepEqual([...accountPoolSelection({}, models)], ['a', 'b'])
  assert.deepEqual([...accountPoolSelection({ poolModels: [] }, models)], [])
  assert.deepEqual([...accountPoolSelection({ poolModels: ['a'] }, models)], ['a'])
})
test('saved unavailable model IDs remain editable without inventing discovered models', () => {
  assert.deepEqual(accountModelRows({ key: 'personal', label: 'Personal', models: [] }, { poolModels: ['gone'] }), [
    { id: 'gone', name: 'gone', unavailable: true },
  ])
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
test('account manager has bilingual copy and explicitly limits isolation claims', () => {
  for (const key of Object.keys(en).filter(key => key.startsWith('accounts')) as (keyof typeof en)[]) {
    assert.ok(en[key].length)
    assert.ok(zh[key].length)
  }
  assert.match(en.accountsHint, /only to LLM routing/)
  assert.match(en.accountsIndependentHint, /no fallback/)
  assert.match(zh.accountsIndependentHint, /不会回退/)
})
