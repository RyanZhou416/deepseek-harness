/**
 * The durable model-catalogue store: per-ACCOUNT round-trips over one file,
 * tolerance for missing/corrupt files, strict snapshot validation (a malformed
 * persisted entry must read as absent, never flow into `resolveModel`), and the
 * two properties the multi-account design depends on — one account's write can
 * never clobber another's, and a cache written before accounts were keyed is
 * discarded instead of being attributed to some account.
 *
 * Every fixture below uses synthetic ids; no credential, token or account
 * secret belongs in this file.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { catalogStore, sanitizeSnapshot } from '../src/providers/catalog-store.js'

async function tempStorePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'dsh-models-')), 'models.json')
}

/** One provider's store factory plus the warnings it emitted. */
interface StoreFixture {
  path: string
  account(key: string): ReturnType<ReturnType<typeof catalogStore>>
  warnings: string[]
}

async function storeFixture(provider: 'grok' | 'codex'): Promise<StoreFixture> {
  const path = await tempStorePath()
  const warnings: string[] = []
  const factory = catalogStore(provider, { path, onWarn: message => warnings.push(message) })
  return { path, account: key => factory(key), warnings }
}

test('the store round-trips one entry per account of one provider', async () => {
  const fixture = await storeFixture('grok')
  const alpha = fixture.account('alpha')
  const beta = fixture.account('beta')
  await alpha.save({
    at: 123,
    models: [{
      id: 'grok-4.6',
      name: 'Grok 4.6',
      contextWindow: 500_000,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('high'), name: 'High Effort', description: 'extensive' }],
        defaultEffort: ReasoningEffortId('high'),
      },
    }],
  })
  await beta.save({ at: 456, models: [{ id: 'grok-4-fast', name: 'Grok 4 Fast' }] })

  const loaded = await alpha.load()
  assert.equal(loaded?.snapshot?.at, 123)
  assert.equal(loaded?.snapshot?.models[0].reasoning?.defaultEffort, 'high')
  assert.equal(loaded?.snapshot?.models[0].reasoning?.efforts[0].description, 'extensive')
  assert.equal((await beta.load())?.snapshot?.models[0].id, 'grok-4-fast')

  // Clearing one account keeps its sibling.
  await alpha.clear()
  assert.equal(await alpha.load(), undefined)
  assert.equal((await beta.load())?.snapshot?.at, 456)
  // The file itself stays valid JSON (parse throws otherwise).
  assert.equal((JSON.parse(await readFile(fixture.path, 'utf8')) as { version?: number }).version, 2)
})

test('a second provider never loses the first one\'s accounts', async () => {
  const path = await tempStorePath()
  const grok = catalogStore('grok', { path })('alpha')
  const codex = catalogStore('codex', { path })('alpha')
  await grok.save({ at: 1, models: [{ id: 'grok-4', name: 'Grok 4' }] })
  await codex.save({ at: 2, models: [{ id: 'gpt-5-codex', name: 'GPT-5 Codex' }] })
  assert.equal((await grok.load())?.snapshot?.models[0].id, 'grok-4')
  assert.equal((await codex.load())?.snapshot?.models[0].id, 'gpt-5-codex')
})

test('concurrent writes of two accounts cannot clobber each other', async () => {
  const path = await tempStorePath()
  const factory = catalogStore('grok', { path })
  const accounts = ['alpha', 'beta', 'gamma', 'delta']
  // Started together, without awaiting in between: an unserialized
  // read-modify-write would let the last writer drop its siblings' entries.
  await Promise.all(accounts.map(async (account, index) =>
    await factory(account).save({ at: index, models: [{ id: `grok-${account}`, name: account }] })))
  for (const [index, account] of accounts.entries()) {
    const loaded = await factory(account).load()
    assert.equal(loaded?.snapshot?.at, index, `${account} lost its entry`)
  }
})

test('the store round-trips output token limits', async () => {
  const fixture = await storeFixture('grok')
  const snapshot = {
    at: 123,
    models: [
      { id: 'g', name: 'G', maxOutputTokens: 32_768 },
      { id: 'min', name: 'Minimum', maxOutputTokens: 1 },
      { id: 'max', name: 'Maximum', maxOutputTokens: Number.MAX_SAFE_INTEGER },
    ],
  }
  await fixture.account('alpha').save(snapshot)
  assert.deepEqual((await fixture.account('alpha').load())?.snapshot, snapshot)
})

test('an authoritative empty catalogue round-trips as an empty list, not as absent', async () => {
  const fixture = await storeFixture('grok')
  const empty = { at: 9, models: [] }
  await fixture.account('alpha').save(empty)
  const loaded = await fixture.account('alpha').load()
  assert.notEqual(loaded, undefined, 'an empty catalogue must stay distinguishable from no catalogue')
  assert.deepEqual(loaded?.snapshot, empty)
  // A sibling's entry is unaffected by the empty one.
  await fixture.account('beta').save({ at: 10, models: [{ id: 'grok-4', name: 'Grok 4' }] })
  assert.deepEqual((await fixture.account('alpha').load())?.snapshot, empty)
})

test('catalog store accepts old caches without output token limits', async () => {
  const fixture = await storeFixture('grok')
  const snapshot = { at: 123, models: [{ id: 'g', name: 'G', contextWindow: 500_000 }] }
  await writeFile(fixture.path, JSON.stringify({
    version: 2,
    providers: { grok: { accounts: { alpha: snapshot } } },
  }))
  const loaded = await fixture.account('alpha').load()
  assert.deepEqual(loaded?.snapshot, snapshot)
  assert.equal(Object.hasOwn(loaded!.snapshot!.models[0], 'maxOutputTokens'), false)
})

test('sanitizeSnapshot rejects invalid output token limits', () => {
  for (const maxOutputTokens of [
    0, -1, 1.5, '32768', null, Number.MAX_SAFE_INTEGER + 1,
    NaN, Infinity, -Infinity, true, {}, [],
  ]) {
    assert.equal(sanitizeSnapshot({
      at: 123,
      models: [
        { id: 'valid', name: 'Valid' },
        { id: 'invalid', name: 'Invalid', maxOutputTokens },
      ],
    }), undefined, `Invalid maxOutputTokens: ${String(maxOutputTokens)}`)
  }
})

test('catalog store tolerates a missing file and reports a corrupt one', async () => {
  const fixture = await storeFixture('grok')
  const store = fixture.account('alpha')
  // Missing file reads as absent; clear on a missing file is a no-op.
  assert.equal(await store.load(), undefined)
  await store.clear()
  assert.deepEqual(fixture.warnings, [], 'a missing cache file is not a problem worth reporting')
  // Corrupt JSON reads as absent, and says so instead of passing for "no data".
  await writeFile(fixture.path, 'not json')
  assert.equal(await store.load(), undefined)
  assert.equal(fixture.warnings.length, 1)
  assert.match(fixture.warnings[0], /not valid JSON/)
  // A corrupt file is still writable: save rebuilds it from scratch.
  await store.save({ at: 2, models: [{ id: 'g', name: 'G' }] })
  assert.equal((await store.load())?.snapshot?.at, 2)
})

test('a cache written before accounts were keyed is discarded, never attributed', async () => {
  const fixture = await storeFixture('grok')
  // The shipped pre-account layout: one snapshot per provider, with no account.
  await writeFile(fixture.path, JSON.stringify({
    grok: { at: 1, models: [{ id: 'grok-4', name: 'Grok 4' }] },
  }))
  assert.equal(await fixture.account('alpha').load(), undefined)
  assert.equal(await fixture.account('beta').load(), undefined)
  assert.equal(fixture.warnings.length, 1)
  assert.match(fixture.warnings[0], /pre-account layout/)
  // The next save replaces the file with the current layout.
  await fixture.account('alpha').save({ at: 2, models: [{ id: 'grok-4', name: 'Grok 4' }] })
  const file = JSON.parse(await readFile(fixture.path, 'utf8')) as { version: number }
  assert.equal(file.version, 2)
})

test('one unusable account entry is dropped without discarding its siblings', async () => {
  const fixture = await storeFixture('grok')
  await writeFile(fixture.path, JSON.stringify({
    version: 2,
    providers: {
      grok: {
        accounts: {
          good: { at: 1, models: [{ id: 'grok-4', name: 'Grok 4' }] },
          broken: { at: 'soon', models: [{ id: 'grok-4', name: 'Grok 4' }] },
        },
      },
    },
  }))
  assert.equal((await fixture.account('good').load())?.snapshot?.at, 1)
  assert.equal(await fixture.account('broken').load(), undefined)
  assert.equal(fixture.warnings.length, 1)
  assert.match(fixture.warnings[0], /grok\/broken/)
})

test('a failure cooldown round-trips beside a snapshot and alone when the cache is cold', async () => {
  const fixture = await storeFixture('grok')
  const alpha = fixture.account('alpha')
  const snapshot = { at: 7, models: [{ id: 'grok-4', name: 'Grok 4' }] }
  await alpha.save(snapshot)
  await alpha.saveFailure?.({ notBefore: 1_000 })

  const kept = await alpha.load()
  assert.deepEqual(kept?.snapshot, snapshot, 'the last good catalogue stays')
  assert.deepEqual(kept?.failure, { notBefore: 1_000 })

  // A success supersedes the hint: this request was answered.
  await alpha.save({ at: 8, models: snapshot.models })
  assert.equal((await alpha.load())?.failure, undefined)

  // A cold failure is written on its own: nothing invents an `at` or models.
  await alpha.saveFailure?.({ notBefore: 2_000 })
  await alpha.clear()
  await alpha.saveFailure?.({ notBefore: 2_000 })
  const cold = await alpha.load()
  assert.equal(cold?.snapshot, undefined)
  assert.deepEqual(cold?.failure, { notBefore: 2_000 })
  const file = JSON.parse(await readFile(fixture.path, 'utf8')) as {
    providers: { grok: { accounts: Record<string, Record<string, unknown>> } }
  }
  assert.deepEqual(Object.keys(file.providers.grok.accounts.alpha!), ['failure'])
})

test('a malformed failure hint is ignored without discarding the snapshot beside it', async () => {
  const fixture = await storeFixture('grok')
  await writeFile(fixture.path, JSON.stringify({
    version: 2,
    providers: {
      grok: {
        accounts: {
          alpha: { at: 3, models: [{ id: 'grok-4', name: 'Grok 4' }], failure: { notBefore: 'soon' } },
          beta: { failure: { notBefore: -5 } },
        },
      },
    },
  }))
  const alpha = await fixture.account('alpha').load()
  assert.equal(alpha?.snapshot?.at, 3)
  assert.equal(alpha?.failure, undefined)
  // A record holding only an unusable hint is no record at all.
  assert.equal(await fixture.account('beta').load(), undefined)
})

test('sanitizeSnapshot drops malformed snapshots wholesale but accepts an empty catalogue', () => {
  const model = { id: 'g', name: 'G' }
  const efforts = [{ id: 'high', name: 'High' }]
  // A valid snapshot passes through, including one that lists nothing.
  assert.notEqual(sanitizeSnapshot({ at: 1, models: [model] }), undefined)
  assert.deepEqual(sanitizeSnapshot({ at: 1, models: [] }), { at: 1, models: [] })
  assert.notEqual(
    sanitizeSnapshot({ at: 1, models: [{ ...model, reasoning: { efforts, defaultEffort: 'high' } }] }),
    undefined,
  )
  // The codex fast-tier flag round-trips; a non-boolean one drops the snapshot.
  assert.equal(
    sanitizeSnapshot({ at: 1, models: [{ ...model, fastTier: true }] })?.models[0].fastTier,
    true,
  )
  assert.equal(sanitizeSnapshot({ at: 1, models: [{ ...model, fastTier: 'yes' }] }), undefined)
  // Copilot per-model modalities round-trip; malformed ones drop the snapshot.
  assert.deepEqual(
    sanitizeSnapshot({ at: 1, models: [{ ...model, inputModalities: ['text', 'image'] }] })?.models[0].inputModalities,
    ['text', 'image'],
  )
  assert.equal(sanitizeSnapshot({ at: 1, models: [{ ...model, inputModalities: [] }] }), undefined)
  assert.equal(sanitizeSnapshot({ at: 1, models: [{ ...model, inputModalities: ['video'] }] }), undefined)
  // The Copilot wire choice and dual-protocol flag round-trip (a snapshot
  // losing them would route every restarted model to the chat wire); a
  // malformed value drops the snapshot.
  const copilot = sanitizeSnapshot({
    at: 1,
    models: [{ ...model, copilotWire: 'responses', copilotResponses: true }],
  })?.models[0]
  assert.equal(copilot?.copilotWire, 'responses')
  assert.equal(copilot?.copilotResponses, true)
  assert.equal(sanitizeSnapshot({ at: 1, models: [{ ...model, copilotWire: 'grpc' }] }), undefined)
  assert.equal(sanitizeSnapshot({ at: 1, models: [{ ...model, copilotResponses: 'yes' }] }), undefined)
  for (const malformed of [
    undefined,
    null,
    'text',
    { at: 'soon', models: [model] },
    { at: 1, models: 'none' },
    { at: 1, models: [{ id: '', name: 'G' }] },
    { at: 1, models: [{ id: 'g', name: '' }] },
    { at: 1, models: [model, model] }, // duplicate ids
    { at: 1, models: [{ ...model, contextWindow: -5 }] },
    { at: 1, models: [{ ...model, description: 42 }] },
    { at: 1, models: [{ ...model, reasoning: { efforts: [] } }] },
    { at: 1, models: [{ ...model, reasoning: { efforts: [{ id: 'high', name: '' }] } }] },
    { at: 1, models: [{ ...model, reasoning: { efforts: [{ id: '', name: 'High' }] } }] },
    { at: 1, models: [{ ...model, reasoning: { efforts, defaultEffort: 'unknown' } }] },
    { at: 1, models: [{ ...model, reasoning: { efforts: [...efforts, ...efforts] } }] }, // duplicate efforts
  ]) {
    assert.equal(sanitizeSnapshot(malformed), undefined, JSON.stringify(malformed))
  }
})
