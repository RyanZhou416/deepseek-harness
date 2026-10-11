/** Cache durations govern explicit demand checks, not periodic refresh tasks. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSubscriptionCachePolicy } from '../src/cache-policy.js'

test('cache freshness and retry duration have independent validated defaults', () => {
  assert.deepEqual(resolveSubscriptionCachePolicy(), {
    modelMaxAgeMs: 86_400_000,
    usageMaxAgeMs: 300_000,
    retryDelayMs: 60_000,
  })
  assert.deepEqual(resolveSubscriptionCachePolicy({ usageMaxAgeMs: 120_000 }), {
    modelMaxAgeMs: 86_400_000,
    usageMaxAgeMs: 120_000,
    retryDelayMs: 60_000,
  })
})

test('cache durations reject values that cannot bound a demand check', () => {
  for (const key of ['modelMaxAgeMs', 'usageMaxAgeMs', 'retryDelayMs'] as const) {
    for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => resolveSubscriptionCachePolicy({ [key]: value }), `${key}: ${value}`)
    }
  }
})
