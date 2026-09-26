// DeepSeek Harness fork modification: verified model rates and exact context-tier boundaries.
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { referenceModelPriceOf, usesLongContextPrice } from '../../src/shared/modelPricing'
import { priceOf, estimateSessionCost, mergeCostUsage } from '../../src/client/cost'
import { usageTotalsOf } from '../../src/client/overview'

describe('subscription API-equivalent prices', () => {
  test.each([
    ['codex', 'gpt-6-astra', 10, 1, 12.5, 50],
    ['codex', 'gpt-6-sol', 2, 0.2, 2.5, 10],
    ['claude', 'claude-opus-5-5', 4, 0.2, 5, 20],
    ['claude', 'claude-fable-5-1', 10, 0.25, 12.5, 50],
    ['cursor', 'grok-4.7', 2, 0.5, 2, 6],
  ] as const)('%s/%s has the verified rate without an online price book', (provider, model, miss, hit, write, out) => {
    assert.deepEqual(priceOf(null, provider, model), { miss, hit, write, out })
    assert.equal(estimateSessionCost({ [provider]: { [model]: { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } }, null, 'usd'), miss)
  })

  test('uses the reference for exact vendor aliases and rejects unrelated routes or model names', () => {
    assert.deepEqual(priceOf({}, 'openai', 'GPT-6-SOL'), priceOf(null, 'codex', 'gpt-6-sol'))
    assert.deepEqual(priceOf({}, 'anthropic', 'claude-opus-5-5'), priceOf(null, 'claude', 'claude-opus-5-5'))
    assert.deepEqual(priceOf({}, 'grok', 'grok-4.7'), priceOf(null, 'xai', 'grok-4.7'))
    assert.equal(referenceModelPriceOf('cursor', 'gpt-6-sol'), undefined)
    assert.equal(referenceModelPriceOf('claude', 'gpt-6-sol'), undefined)
    assert.equal(referenceModelPriceOf('codex', 'gpt-6-sol-other'), undefined)
    assert.equal(priceOf(null, 'unknown', 'gpt-6-sol'), null)
    assert.equal(priceOf(null, 'claude', 'claude-opus-5-5', true), null)
    assert.equal(usesLongContextPrice('claude', 'claude-opus-5-5', 900_000), false)
  })

  test('keeps the reference independent of duplicate or stale reseller entries', () => {
    const stale = { miss: 99, hit: 99, write: 99, out: 99 }
    const book = { openai: { 'gpt-6-sol': stale }, gateway: { 'gpt-6-sol': stale } }
    assert.equal(priceOf(book, 'codex', 'gpt-6-sol')?.miss, 2)
  })

  test.each([
    ['codex', 'gpt-6-astra', 272_000, { miss: 20, hit: 2, write: 25, out: 75 }],
    ['codex', 'gpt-6-sol', 272_000, { miss: 4, hit: 0.4, write: 5, out: 15 }],
    ['cursor', 'grok-4.7', 200_000, { miss: 4, hit: 1, write: 4, out: 12 }],
  ] as const)('%s/%s switches only above its per-request threshold', (provider, model, threshold, price) => {
    assert.equal(usesLongContextPrice(provider, model, threshold), false)
    assert.equal(usesLongContextPrice(provider, model, threshold + 1), true)
    assert.deepEqual(priceOf(null, provider, model, true), price)
  })

  test('keeps short and long requests distinct while merging agent costs and token totals', () => {
    const short = { codex: { 'gpt-6-sol': { peak: { uncached: 150_000, cacheRead: 0, cacheWrite: 0, output: 1_000 } } } }
    const long = { codex: { 'gpt-6-sol': { long: { uncached: 1_000, cacheRead: 300_000, cacheWrite: 0, output: 1_000 } } } }
    const merged = mergeCostUsage(short, short, long)
    assert.ok(merged)
    assert.equal(usageTotalsOf(merged)?.total, 604_000)
    assert.ok(Math.abs((estimateSessionCost(merged, null, 'usd') ?? 0) - 0.759) < 1e-12)
    assert.equal(long.codex['gpt-6-sol'].long.cacheRead, 300_000)
  })
})
