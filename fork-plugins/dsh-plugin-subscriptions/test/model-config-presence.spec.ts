/**
 * The config schema's optional fields: the model-entry `inputModalities` array and the two
 * continuation budgets.
 *
 * `ModelEntry.inputModalities` is optional, so an omitted field must stay absent instead of
 * becoming the empty list schemastery gives an omitted array field: that value is a list every
 * consumer has to reject, and it made a configuration that stated nothing unusable. The wire
 * field, whose plain union states no default, is the control: the array default is not a
 * property of every optional union.
 *
 * The continuation budgets carry a shipped default and the number bounds a stated value must
 * respect, so their cases read the resolved value for an omitted field and for an explicit legal
 * bound, and the refusal's own path for a value the bounds reject.
 *
 * These cases call the plugin's real exported `Config`, which parses against the model-entry
 * schema and its own resolution rules; they mount no plugin, read no credential store and reach
 * no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import z from '@deepseek-ai/schemastery'
import { Config, resolveContinuationStateDeadlineMs } from '../src/index.js'
import type { Config as SubscriptionsConfig, ModelEntry } from '../src/index.js'

/** A config stating only Claude, with the entries this case names. */
function config(models: ModelEntry[]): SubscriptionsConfig {
  return Config({ providers: ['claude'], models: { claude: models } })
}

test('an entry that omits inputModalities stays undefined through the real config schema', () => {
  const resolved = config([{ id: 'claude-opus-4-5' }])
  const first = resolved.models?.claude?.[0]
  assert.ok(first !== undefined, 'the configured entry survives resolution')
  assert.equal(first.inputModalities, undefined)
  assert.equal(first.wire, undefined)
})

test('an explicit empty inputModalities list is refused', () => {
  assert.throws(
    () => config([{ id: 'claude-opus-4-5', inputModalities: [] }]),
    (error: unknown) =>
      z.ValidationError.is(error) && /\.inputModalities /.test(error.message),
  )
})

test('an explicit text/image inputModalities list keeps both values in order', () => {
  const both = config([{ id: 'claude-opus-4-5', inputModalities: ['text', 'image'] }])
  assert.deepEqual(both.models?.claude?.[0]?.inputModalities, ['text', 'image'])

  const textOnly = config([{ id: 'claude-opus-4-5', inputModalities: ['text'] }])
  assert.deepEqual(textOnly.models?.claude?.[0]?.inputModalities, ['text'])
})

test('an omitted wire field stays undefined while an explicit one survives', () => {
  const stated = config([{ id: 'claude-opus-4-5', wire: 'responses' }])
  assert.equal(stated.models?.claude?.[0]?.wire, 'responses')
})

test('the continuation budgets default to 5000 and 2000, and the resolved deadline outlasts the lock', () => {
  const omitted = config([])
  assert.equal(omitted.continuationStateDeadlineMs, 5_000)
  assert.equal(omitted.continuationStateLockTimeoutMs, 2_000)
  assert.equal(resolveContinuationStateDeadlineMs(omitted), 5_000)
  // A lock wait as long as the request budget can only end as a false unavailable refusal.
  assert.ok(resolveContinuationStateDeadlineMs(omitted) > omitted.continuationStateLockTimeoutMs)

  const equal = Config({
    providers: ['claude'], models: { claude: [] },
    continuationStateDeadlineMs: 5_000, continuationStateLockTimeoutMs: 5_000,
  })
  assert.equal(equal.continuationStateDeadlineMs, 5_000)
  assert.equal(resolveContinuationStateDeadlineMs(equal), 7_000)
  assert.equal(equal.continuationStateLockTimeoutMs, 5_000)
})

test('each continuation budget refuses a value its own number bounds do not allow', () => {
  for (const key of ['continuationStateDeadlineMs', 'continuationStateLockTimeoutMs'] as const) {
    for (const refused of [0, 99, 10_001, 100.5]) {
      assert.throws(
        () => Config({ providers: ['claude'], models: { claude: [] }, [key]: refused }),
        (error: unknown) => z.ValidationError.is(error) && error.message.includes(`.${key}`),
      )
    }
  }
})
