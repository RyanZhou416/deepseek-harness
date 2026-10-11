/**
 * Unit tests for the per-model default-effort overrides: the durable store
 * (`model-defaults.json` at a redirected DSH_HOME) and the reasoning-block
 * merge helper shared by the four adapters.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const HOME = mkdtempSync(join(tmpdir(), 'model-defaults-test-'))

const {
  defaultEffortOf,
  defaultSpeedOf,
  loadModelDefaults,
  modelDefaultsFilePath,
  modelDefaultsLoadError,
  modelDefaultsSnapshot,
  resetModelDefaultsForTests,
  setDefaultEffort,
  setDefaultSpeed,
} = await import('../src/model-defaults.js')
const { effortDisplayName, mergeReasoning } = await import('../src/providers/common.js')

/**
 * Wipe the module state and the file, with DSH_HOME pointed at this spec's
 * own temp home for the duration of the call.
 *
 * The override has to be per call, not a top-level assignment: every spec in
 * the aggregate run shares one process, and ESM evaluates all top-level bodies
 * before any test callback, so the last importer's home would win for
 * everyone. This suite used to write into another spec's home that way, and
 * only passed because the leftover keys happened not to collide.
 */
async function fresh(): Promise<void> {
  process.env.DSH_HOME = HOME
  // Assert rather than trust: were the path ever captured at import time, this
  // suite would silently start writing somewhere else again.
  assert.ok(modelDefaultsFilePath().startsWith(HOME), 'the store resolves inside this spec\'s temp home')
  await resetModelDefaultsForTests()
  rmSync(modelDefaultsFilePath(), { force: true })
  await loadModelDefaults()
}

/**
 * The snapshot as plain data. Sections are deliberately prototype-less, so a
 * model id like `toString` cannot resolve to an inherited function; that shows
 * up as a difference under deepStrictEqual against a literal, so compare the
 * structure through JSON and assert the missing prototype on its own.
 */
function plainSnapshot(): unknown {
  return JSON.parse(JSON.stringify(modelDefaultsSnapshot()))
}

test('an absent file reads as empty: no model has a configured default', async () => {
  await fresh()
  assert.equal(defaultEffortOf('claude', 'claude-sonnet-5'), undefined)
  assert.deepEqual(plainSnapshot(), {})
})

test('setDefaultEffort persists the override and serves it from memory', async () => {
  await fresh()
  await setDefaultEffort('claude', 'claude-sonnet-5', 'high')
  assert.equal(defaultEffortOf('claude', 'claude-sonnet-5'), 'high')
  assert.equal(defaultEffortOf('codex', 'gpt-5.6-sol'), undefined)
  assert.deepEqual(plainSnapshot(), { claude: { 'claude-sonnet-5': 'high' } })
  assert.equal(Object.getPrototypeOf(modelDefaultsSnapshot().claude), null,
    'sections are prototype-less so a model id cannot inherit from Object.prototype')
  const path = modelDefaultsFilePath()
  assert.ok(statSync(path).isFile(), 'the file exists after a write')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).claude['claude-sonnet-5'], 'high')
  // Owner-only permissions, matching the rest of the plugin's durable state.
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('clearing the last override drops the provider section', async () => {
  await fresh()
  await setDefaultEffort('grok', 'grok-4', 'medium')
  await setDefaultEffort('grok', 'grok-4', undefined)
  assert.equal(defaultEffortOf('grok', 'grok-4'), undefined)
  assert.deepEqual(plainSnapshot(), {})
  assert.deepEqual(JSON.parse(readFileSync(modelDefaultsFilePath(), 'utf8')), {})
})

test('a malformed file reads as empty and is rewritten by the next save', async () => {
  await fresh()
  writeFileSync(modelDefaultsFilePath(), '{ not json', 'utf8')
  await resetModelDefaultsForTests()
  await loadModelDefaults()
  assert.equal(defaultEffortOf('claude', 'claude-sonnet-5'), undefined)
  await setDefaultEffort('claude', 'claude-sonnet-5', 'max')
  assert.equal(defaultEffortOf('claude', 'claude-sonnet-5'), 'max')
})

test('a malformed entry is skipped, the rest of its section survives', async () => {
  await fresh()
  writeFileSync(modelDefaultsFilePath(), JSON.stringify({
    claude: { 'claude-sonnet-5': 'high', broken: 42 },
    codex: { 'gpt-5.6-sol': 'low' },
    unknown: { 'x': 'y' },
  }), 'utf8')
  await resetModelDefaultsForTests()
  await loadModelDefaults()
  // One bad value must not un-configure the sibling that was fine.
  assert.equal(defaultEffortOf('claude', 'claude-sonnet-5'), 'high')
  assert.equal(defaultEffortOf('codex', 'gpt-5.6-sol'), 'low')
  // The skip is surfaced, not silent.
  assert.match(String(modelDefaultsLoadError()), /malformed/)
  assert.match(String(modelDefaultsLoadError()), /broken/)
})

test('setDefaultSpeed persists one model\'s tier and leaves its siblings on standard', async () => {
  await fresh()
  // Absence is standard routing, exactly as an absent effort follows the provider.
  assert.equal(defaultSpeedOf('claude', 'claude-opus-5'), undefined)
  await setDefaultSpeed('claude', 'claude-opus-5', 'fast')
  assert.equal(defaultSpeedOf('claude', 'claude-opus-5'), 'fast')
  // The tier belongs to the model it was stored for, on that route alone.
  assert.equal(defaultSpeedOf('claude', 'claude-sonnet-5'), undefined)
  assert.equal(defaultSpeedOf('codex', 'claude-opus-5'), undefined)

  const path = modelDefaultsFilePath()
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    speed: { claude: { 'claude-opus-5': 'fast' } },
  })
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('standard clears the stored tier and drops the speed section', async () => {
  await fresh()
  await setDefaultSpeed('cursor', 'composer-2', 'fast')
  await setDefaultSpeed('cursor', 'composer-2', 'standard')
  assert.equal(defaultSpeedOf('cursor', 'composer-2'), undefined)
  assert.deepEqual(JSON.parse(readFileSync(modelDefaultsFilePath(), 'utf8')), {})
})

test('effort and speed share one document: neither overlapping save drops the other', async () => {
  await fresh()
  // The Settings rows save independently of the composer control, so an effort
  // save and a speed save can overlap. One chain writes both.
  await Promise.all([
    setDefaultEffort('codex', 'gpt-5.6-sol', 'high'),
    setDefaultSpeed('codex', 'gpt-5.6-sol', 'fast'),
    setDefaultSpeed('claude', 'claude-opus-5', 'fast'),
  ])
  assert.equal(defaultEffortOf('codex', 'gpt-5.6-sol'), 'high')
  assert.equal(defaultSpeedOf('codex', 'gpt-5.6-sol'), 'fast')
  assert.equal(defaultSpeedOf('claude', 'claude-opus-5'), 'fast')
  const onDisk = JSON.parse(readFileSync(modelDefaultsFilePath(), 'utf8')) as {
    codex: Record<string, string>
    speed: Record<string, Record<string, string>>
  }
  assert.equal(onDisk.codex['gpt-5.6-sol'], 'high')
  assert.equal(onDisk.speed.codex['gpt-5.6-sol'], 'fast')
  assert.equal(onDisk.speed.claude['claude-opus-5'], 'fast')
})

test('a malformed speed entry is skipped and reported without losing its sibling', async () => {
  await fresh()
  writeFileSync(modelDefaultsFilePath(), JSON.stringify({
    claude: { 'claude-opus-5': 'high', broken: 42 },
    speed: { claude: { 'claude-opus-5': 'fast', 'claude-sonnet-5': 'turbo' } },
  }), 'utf8')
  await resetModelDefaultsForTests()
  await loadModelDefaults()
  assert.equal(defaultEffortOf('claude', 'claude-opus-5'), 'high')
  assert.equal(defaultSpeedOf('claude', 'claude-opus-5'), 'fast')
  assert.equal(defaultSpeedOf('claude', 'claude-sonnet-5'), undefined)
  assert.match(String(modelDefaultsLoadError()), /malformed/)
  assert.match(String(modelDefaultsLoadError()), /claude-sonnet-5/)
})

test('a file written before the speed section existed keeps its effort defaults', async () => {
  await fresh()
  writeFileSync(modelDefaultsFilePath(), JSON.stringify({ codex: { 'gpt-5.6-sol': 'high' } }), 'utf8')
  await resetModelDefaultsForTests()
  await loadModelDefaults()
  assert.equal(defaultEffortOf('codex', 'gpt-5.6-sol'), 'high')
  assert.equal(defaultSpeedOf('codex', 'gpt-5.6-sol'), undefined)
})

test('a hostile speed section cannot pollute Object.prototype or smuggle in a provider', async () => {
  await fresh()
  writeFileSync(modelDefaultsFilePath(), JSON.stringify({
    __proto__: { polluted: 'yes' },
    speed: {
      __proto__: { polluted: 'yes' },
      evil: { x: 'fast' },
      claude: { __proto__: 'fast', 'real-model': 'fast' },
    },
  }), 'utf8')
  await resetModelDefaultsForTests()
  await loadModelDefaults()
  assert.equal((({}) as Record<string, unknown>).polluted, undefined, 'Object.prototype is untouched')
  assert.equal(defaultSpeedOf('claude', 'real-model'), 'fast')
  assert.equal(defaultSpeedOf('claude', 'toString'), undefined, 'an inherited key never resolves')
  // Only the known provider survives the next write, so `evil` was never loaded.
  await setDefaultSpeed('claude', 'second-model', 'fast')
  const onDisk = JSON.parse(readFileSync(modelDefaultsFilePath(), 'utf8')) as { speed: Record<string, unknown> }
  assert.deepEqual(Object.keys(onDisk.speed).sort(), ['claude'])
})

test('a failed speed save propagates and does not wedge later saves', async () => {
  await fresh()
  const { overridePersistForTests } = await import('../src/model-defaults.js')
  overridePersistForTests(() => Promise.reject(new Error('injected persist failure')))
  await assert.rejects(() => setDefaultSpeed('claude', 'x', 'fast'), /injected persist failure/)
  // The failed write must not leave the live state ahead of the file.
  assert.equal(defaultSpeedOf('claude', 'x'), undefined)
  await fresh()
  await setDefaultSpeed('claude', 'x', 'fast')
  assert.equal(defaultSpeedOf('claude', 'x'), 'fast')
})

test('effortDisplayName spells xhigh out', () => {
  assert.equal(effortDisplayName('xhigh'), 'Extra High')
  assert.equal(effortDisplayName('low'), 'Low')
})

test('mergeReasoning: a configured default wins over the advertised one', () => {
  const base = {
    efforts: [
      { id: ReasoningEffortId('low'), name: 'Low' },
      { id: ReasoningEffortId('high'), name: 'High' },
    ],
    defaultEffort: ReasoningEffortId('low'),
  }
  const merged = mergeReasoning('high', base)
  assert.equal(merged?.defaultEffort, 'high')
  assert.deepEqual(merged?.efforts.map(effort => effort.id), ['low', 'high'])
})

test('mergeReasoning: a configured default outside a discovered set is dropped', () => {
  // The base is the provider's live catalog, i.e. what the model actually
  // accepts. Honouring a level it no longer lists would put an unsupported
  // effort on every request instead of letting the harness reject it before
  // provider I/O.
  const base = {
    efforts: [
      { id: ReasoningEffortId('low'), name: 'Low' },
      { id: ReasoningEffortId('high'), name: 'High' },
    ],
    defaultEffort: ReasoningEffortId('low'),
  }
  const merged = mergeReasoning('max', base)
  assert.deepEqual(merged?.efforts.map(effort => effort.id), ['low', 'high'])
  assert.equal(merged?.defaultEffort, 'low', 'falls back to the advertised default')
})

test('mergeReasoning: an extendable base accepts a configured level it omits', () => {
  // `extendable` marks a built-in fallback list that is known to trail the
  // backend (codex without a discovered catalog), where a newly shipped tier
  // has to remain selectable.
  const base = {
    efforts: [
      { id: ReasoningEffortId('low'), name: 'Low' },
      { id: ReasoningEffortId('high'), name: 'High' },
    ],
  }
  const merged = mergeReasoning('max', base, { extendable: true })
  assert.equal(merged?.defaultEffort, 'max')
  assert.deepEqual(merged?.efforts.map(effort => effort.id), ['low', 'high', 'max'])
  assert.equal(merged?.efforts[2]?.name, 'Max')
})

test('mergeReasoning: a configured default that the set already lists becomes the default', () => {
  const base = {
    efforts: [
      { id: ReasoningEffortId('low'), name: 'Low' },
      { id: ReasoningEffortId('high'), name: 'High' },
    ],
    defaultEffort: ReasoningEffortId('low'),
  }
  assert.equal(mergeReasoning('high', base)?.defaultEffort, 'high')
})

test('mergeReasoning: no configured default returns the advertised block (fresh copy)', () => {
  const base = {
    efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }],
    defaultEffort: ReasoningEffortId('low'),
  }
  const merged = mergeReasoning(undefined, base)
  assert.deepEqual(merged, base)
  assert.notEqual(merged, base, 'returns a detached block, not the caller object')
})

test('mergeReasoning: without a base, a configured default claims no capability', () => {
  // No capability information at all (catalog unavailable, or a model it does
  // not cover): inventing a reasoning block would advertise something no
  // provider ever confirmed.
  assert.equal(mergeReasoning('high', undefined), undefined)
  // A fallback-based provider is the one exception.
  const extended = mergeReasoning('high', undefined, { extendable: true })
  assert.equal(extended?.defaultEffort, 'high')
  assert.deepEqual(extended?.efforts.map(effort => effort.id), ['high'])
})

test('mergeReasoning: nothing configured, nothing discovered, nothing returned', () => {
  assert.equal(mergeReasoning(undefined, undefined), undefined)
})

test('a model named after an Object.prototype member has no configured default', async () => {
  await fresh()
  // Model ids are provider-supplied catalog data used as object keys, so a
  // plain index would inherit from Object.prototype and hand a *function* to
  // mergeReasoning, which then throws and breaks that model's resolution.
  // Reachable only once the provider has any override at all (section exists).
  await setDefaultEffort('codex', 'gpt-5.6-sol', 'high')
  for (const inherited of ['toString', 'valueOf', 'hasOwnProperty', 'constructor']) {
    assert.equal(defaultEffortOf('codex', inherited), undefined, `${inherited} must not resolve`)
    assert.doesNotThrow(() => mergeReasoning(defaultEffortOf('codex', inherited), {
      efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }],
    }))
  }
  assert.equal(defaultEffortOf('codex', 'gpt-5.6-sol'), 'high', 'real overrides still resolve')
})

test('mergeReasoning keeps defaultEffort ∈ efforts through the pool intersection', () => {
  // The DSH runtime rejects an unknown default with INVALID_MODEL_REASONING,
  // and a pooled model's block is the *intersection* across members — so a
  // configured level that only one member advertises must not survive as the
  // pool's default. Mirrors intersectReasoning from providers/pool.ts, which
  // is module-private.
  const intersect = (
    members: readonly (ReturnType<typeof mergeReasoning>)[],
  ): ReturnType<typeof mergeReasoning> => {
    const [first, ...rest] = members
    if (first === undefined) return undefined
    const efforts = first.efforts.filter(effort =>
      rest.every(other => other?.efforts.some(entry => entry.id === effort.id) === true))
    if (efforts.length === 0) return undefined
    const keep = first.defaultEffort !== undefined && efforts.some(effort => effort.id === first.defaultEffort)
    return { efforts, ...keep ? { defaultEffort: first.defaultEffort } : {} }
  }
  const levels = (ids: string[]) => ({ efforts: ids.map(id => ({ id: ReasoningEffortId(id), name: id })) })
  const legal = (block: ReturnType<typeof mergeReasoning>): boolean => block === undefined
    || block.defaultEffort === undefined
    || block.efforts.some(effort => effort.id === block.defaultEffort)

  for (const configured of [undefined, 'ultra', 'low', 'nonexistent']) {
    for (const first of [['low', 'high', 'ultra'], ['low', 'high'], ['x']]) {
      for (const second of [['low', 'high', 'ultra'], ['low', 'medium'], ['x']]) {
        const a = mergeReasoning(configured, levels(first))
        const b = mergeReasoning(configured, levels(second))
        for (const [label, block] of [['a', a], ['b', b], ['pool', intersect([a, b])], ['rev', intersect([b, a])]] as const) {
          assert.ok(legal(block), `${label}: configured=${String(configured)} ${first.join('/')} vs ${second.join('/')}`)
        }
      }
    }
  }
})

test('a hostile file cannot pollute Object.prototype or smuggle in a provider', async () => {
  await fresh()
  writeFileSync(modelDefaultsFilePath(), JSON.stringify({
    __proto__: { polluted: 'yes' },
    evil: { x: 'high' },
    codex: { __proto__: 'high', 'real-model': 'low' },
  }), 'utf8')
  await resetModelDefaultsForTests()
  await loadModelDefaults()
  assert.equal((({}) as Record<string, unknown>).polluted, undefined, 'Object.prototype is untouched')
  assert.deepEqual(
    plainSnapshot(),
    { codex: { 'real-model': 'low' } },
    'unknown providers and inherited keys are dropped, real entries survive',
  )
})

test('overlapping saves do not lose either update', async () => {
  await fresh()
  // The UI disables only the row being saved, so two fast saves can overlap.
  // The write chain must serialise them: neither update may be computed from
  // a snapshot taken before the other landed.
  await Promise.all([
    setDefaultEffort('codex', 'model-a', 'high'),
    setDefaultEffort('codex', 'model-b', 'low'),
    setDefaultEffort('claude', 'model-c', 'max'),
  ])
  assert.deepEqual(plainSnapshot(), {
    codex: { 'model-a': 'high', 'model-b': 'low' },
    claude: { 'model-c': 'max' },
  })
  // And both survive on disk, not just in memory.
  const onDisk = JSON.parse(readFileSync(modelDefaultsFilePath(), 'utf8')) as Record<string, Record<string, string>>
  assert.equal(onDisk.codex['model-a'], 'high')
  assert.equal(onDisk.codex['model-b'], 'low')
  assert.equal(onDisk.claude['model-c'], 'max')
})

test('a failed save propagates and does not wedge later saves', async () => {
  await fresh()
  const { overridePersistForTests } = await import('../src/model-defaults.js')
  overridePersistForTests(() => Promise.reject(new Error('injected persist failure')))
  await assert.rejects(() => setDefaultEffort('codex', 'x', 'high'), /injected persist failure/)
  // The failed write must not leave the live state ahead of the file.
  assert.equal(defaultEffortOf('codex', 'x'), undefined)
  // fresh() restores the real persist; the chain survives the failure.
  await fresh()
  await setDefaultEffort('codex', 'model-a', 'high')
  assert.equal(defaultEffortOf('codex', 'model-a'), 'high')
})
