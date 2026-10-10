/**
 * The unified rate-limit capture: reading `anthropic-ratelimit-unified-*` off
 * one response, retaining it per account under a fixed bound, and dropping it
 * when an account's credentials change. No network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  forgetUnifiedRateLimit,
  parseUnifiedRateLimit,
  rememberUnifiedRateLimit,
  unifiedRateLimitFor,
} from '../src/providers/unified-rate-limit.js'

/** The 429 shape the provider documents for a rejected account. */
function rejectedHeaders(): Headers {
  return new Headers({
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-reset': '1786147200',
    'anthropic-ratelimit-unified-representative-claim': 'seven_day',
    'anthropic-ratelimit-unified-overage-status': 'rejected',
    'anthropic-ratelimit-unified-overage-reset': '1786147200',
    'anthropic-ratelimit-unified-overage-utilization': '1',
    'anthropic-ratelimit-unified-overage-surpassed-threshold': '1',
    'anthropic-ratelimit-unified-overage-disabled-reason': 'org_spend_cap_reached',
    'anthropic-ratelimit-unified-5h-utilization': '0.82',
    'anthropic-ratelimit-unified-5h-reset': '1786100000',
    'anthropic-ratelimit-unified-5h-surpassed-threshold': '0.75',
    'request-id': 'req_1',
  })
}

test('the unified family is parsed into status, claim, resets and per-window readings', () => {
  const state = parseUnifiedRateLimit(rejectedHeaders(), 1_786_000_000_000)
  assert.ok(state !== undefined)
  assert.equal(state.status, 'rejected')
  assert.equal(state.claim, 'seven_day')
  assert.equal(state.resetsAt, 1_786_147_200_000)
  assert.equal(state.overageStatus, 'rejected')
  assert.equal(state.overageResetsAt, 1_786_147_200_000)
  assert.equal(state.overageDisabledReason, 'org_spend_cap_reached')
  assert.deepEqual(state.windows, [
    { window: '5h', utilization: 0.82, resetsAt: 1_786_100_000_000, surpassedThreshold: 0.75 },
    { window: 'overage', utilization: 1, resetsAt: 1_786_147_200_000, surpassedThreshold: 1 },
  ])
  assert.equal(state.observedAt, 1_786_000_000_000)
})

test('the overage and fallback members keep their own readings', () => {
  const state = parseUnifiedRateLimit(new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-fallback': 'available',
    'anthropic-ratelimit-unified-overage-in-use': 'true',
    'anthropic-ratelimit-unified-overage-scope': 'group_pool',
    'anthropic-ratelimit-unified-7d-utilization': '0.62',
  }), 1_000)
  assert.ok(state !== undefined)
  assert.equal(state.status, 'allowed')
  assert.equal(state.fallbackAvailable, true)
  assert.equal(state.overageInUse, true)
  assert.equal(state.overageScope, 'group_pool')
  assert.deepEqual(state.windows, [{ window: '7d', utilization: 0.62 }])
})

test('a response outside the family is not a report, and an unknown status stays visible', () => {
  assert.equal(
    parseUnifiedRateLimit(new Headers({ 'anthropic-ratelimit-requests-limit': '1000' }), 0),
    undefined,
    'a per-bucket rollover header is not the unified report',
  )
  assert.equal(
    parseUnifiedRateLimit(new Headers({ 'anthropic-ratelimit-unified-upgrade-paths': 'max_20x' }), 0),
    undefined,
    'a member this module does not read reports nothing on its own',
  )
  const state = parseUnifiedRateLimit(
    new Headers({ 'anthropic-ratelimit-unified-status': 'throttled' }),
    0,
  )
  assert.equal(state?.status, 'other', 'an unrecognized token is not read as allowed')
})

test('an absent status member reports the windows but leaves the standing unstated', () => {
  const state = parseUnifiedRateLimit(new Headers({ 'anthropic-ratelimit-unified-5h-reset': '1786100000' }), 0)
  // Reading the absence as `allowed` would present a blocked account as healthy;
  // the response said nothing about its standing, so the report says `other`.
  assert.equal(state?.status, 'other')
  assert.deepEqual(state?.windows, [{ window: '5h', resetsAt: 1_786_100_000_000 }])
})

test('a refusal that carried only a disabled reason is not recorded as allowed', () => {
  const state = parseUnifiedRateLimit(new Headers({
    'anthropic-ratelimit-unified-overage-disabled-reason': 'org_spend_cap_reached',
    'anthropic-ratelimit-unified-overage-reset': '1786147200',
  }), 0)
  assert.equal(state?.status, 'other')
  assert.equal(state?.overageDisabledReason, 'org_spend_cap_reached')
})

test('captures are per provider and account, replaced by the account\'s next report', () => {
  forgetUnifiedRateLimit()
  const first = parseUnifiedRateLimit(rejectedHeaders(), 1)
  const second = parseUnifiedRateLimit(new Headers({ 'anthropic-ratelimit-unified-status': 'allowed' }), 2)
  assert.ok(first !== undefined && second !== undefined)
  rememberUnifiedRateLimit('claude', 'a1', first)
  rememberUnifiedRateLimit('claude', 'a2', second)
  assert.equal(unifiedRateLimitFor('claude', 'a1')?.status, 'rejected')
  assert.equal(unifiedRateLimitFor('claude', 'a2')?.status, 'allowed')
  assert.equal(unifiedRateLimitFor('codex', 'a1'), undefined, 'another provider is a different key')
  assert.equal(unifiedRateLimitFor('claude', 'missing'), undefined)

  rememberUnifiedRateLimit('claude', 'a1', second)
  assert.equal(unifiedRateLimitFor('claude', 'a1')?.observedAt, 2, 'the latest report replaces the previous one')
})

test('the capture table is bounded, evicting the oldest account first', () => {
  forgetUnifiedRateLimit()
  const state = parseUnifiedRateLimit(new Headers({ 'anthropic-ratelimit-unified-status': 'allowed' }), 0)
  assert.ok(state !== undefined)
  for (let index = 0; index < 300; index += 1) rememberUnifiedRateLimit('claude', `acct-${String(index)}`, state)
  assert.equal(unifiedRateLimitFor('claude', 'acct-0'), undefined, 'the oldest entry is evicted')
  assert.equal(unifiedRateLimitFor('claude', 'acct-299')?.status, 'allowed', 'the newest entry survives')
  assert.ok(unifiedRateLimitFor('claude', 'acct-44') !== undefined, 'the table stops evicting once it is at the bound')
})

test('forgetting drops one account, a whole provider, or everything', () => {
  forgetUnifiedRateLimit()
  const state = parseUnifiedRateLimit(new Headers({ 'anthropic-ratelimit-unified-status': 'rejected' }), 0)
  assert.ok(state !== undefined)
  rememberUnifiedRateLimit('claude', 'a1', state)
  rememberUnifiedRateLimit('claude', 'a2', state)
  rememberUnifiedRateLimit('codex', 'a1', state)
  forgetUnifiedRateLimit('claude', 'a1')
  assert.equal(unifiedRateLimitFor('claude', 'a1'), undefined)
  assert.equal(unifiedRateLimitFor('claude', 'a2')?.status, 'rejected')
  forgetUnifiedRateLimit('claude')
  assert.equal(unifiedRateLimitFor('claude', 'a2'), undefined)
  assert.equal(unifiedRateLimitFor('codex', 'a1')?.status, 'rejected', 'another provider is untouched')
  forgetUnifiedRateLimit()
  assert.equal(unifiedRateLimitFor('codex', 'a1'), undefined)
})
