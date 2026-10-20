/**
 * PoolUsageTracker's cache contract: a snapshot read never performs an upstream
 * request, a candidate about to serve may perform exactly one, and a failure
 * cools down the endpoint instead of being retried on every call. A usage
 * endpoint that rate-limits progressively (Anthropic's `/oauth/usage`: 429 with
 * a `retry-after` that grows on every hit inside the window) is permanently
 * locked out by a retry storm — see upstream issue #46. Credential failures are
 * the one exception: they cost no network round trip and must stay live so a
 * fixed login rejoins instantly.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { OAuthEndpointError } from '../src/providers/common.js'
import type { ProviderUsage } from '../src/providers/common.js'
import { classifyUsageFailure, PoolUsageTracker, usageFailureFacts } from '../src/providers/pool-usage.js'
import { usageFloorBreaches } from '../src/providers/pool.js'
import { resolvePoolScheduling } from '../src/providers/pool-scheduling.js'
import { createFileUsageStore } from '../src/providers/usage-store.js'
import type { PersistedUsageAccount, UsageStore } from '../src/providers/usage-store.js'
import type { ProviderId } from '../src/auth/store.js'

const MEMBER = { provider: 'claude' as const, account: 'a1', model: 'claude-opus-5' }

const OK_USAGE: ProviderUsage = { supported: true, windows: [{ kind: 'session', usedPercent: 10 }] }

/** One durable account record for the store cases. */
function storeRecord(account: string, usedPercent: number): PersistedUsageAccount {
  return {
    provider: 'claude',
    account,
    observedAt: 1_000,
    checkedAt: 1_000,
    windows: [{ kind: 'session', usedPercent, observedAt: 1_000 }],
  }
}

/** A deterministic clock the cases advance by hand; no timers are involved. */
interface Clock {
  at: number
  now: () => number
}

function clockAt(start = Date.UTC(2026, 8, 30)): Clock {
  const clock: Clock = { at: start, now: () => clock.at }
  return clock
}

/** A tracker whose sole fetcher counts calls and answers from a script. */
function trackerOf(
  fetcher: () => Promise<ProviderUsage>,
  options: { freshMs?: number; retryDelayMs?: number; clock?: Clock; store?: UsageStore } = {},
): { tracker: PoolUsageTracker; calls: { count: number } } {
  const calls = { count: 0 }
  const clock = options.clock ?? clockAt()
  const tracker = new PoolUsageTracker(
    (provider: ProviderId, account: string) =>
      provider === MEMBER.provider && account === MEMBER.account
        ? () => { calls.count += 1; return fetcher() }
        : undefined,
    {
      now: clock.now,
      ...options.freshMs === undefined ? {} : { freshMs: options.freshMs },
      ...options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs },
      ...options.store === undefined ? {} : { store: options.store },
    },
  )
  return { tracker, calls }
}

function rateLimited(retryAfterMs: number): OAuthEndpointError {
  return new OAuthEndpointError('claude usage token endpoint error (HTTP 429)', 429, undefined, retryAfterMs)
}

// ---------------------------------------------------------------------------
// Snapshot reads are pure.
// ---------------------------------------------------------------------------

test('snapshotFor: a cold account answers missing with no upstream request', () => {
  const { tracker, calls } = trackerOf(() => Promise.resolve(OK_USAGE))
  assert.deepEqual(tracker.snapshotFor('claude', 'a1'), {
    supported: true,
    cache: { state: 'missing' },
  })
  assert.equal(calls.count, 0)
})

test('snapshotFor: a provider without a usage fetcher answers supported:false', () => {
  const tracker = new PoolUsageTracker(() => undefined)
  assert.deepEqual(tracker.snapshotFor('grok', 'a1'), { supported: false })
})

test('snapshotFor: an idle clock never reaches the endpoint', async () => {
  const clock = clockAt()
  const { tracker, calls } = trackerOf(() => Promise.resolve(OK_USAGE), { clock })
  await tracker.refreshSnapshot('claude', 'a1')
  assert.equal(calls.count, 1)
  for (let index = 0; index < 50; index++) {
    clock.at += 60_000
    tracker.snapshotFor('claude', 'a1')
    tracker.quotaFor(MEMBER)
  }
  assert.equal(calls.count, 1, 'expiry marks a reading stale; it never schedules a read')
})

// ---------------------------------------------------------------------------
// refreshSnapshot: the one call allowed to reach upstream.
// ---------------------------------------------------------------------------

test('refreshSnapshot: a fresh reading is reused, and force bypasses it honestly', async () => {
  const { tracker, calls } = trackerOf(() => Promise.resolve(OK_USAGE), { freshMs: 300_000 })
  const first = await tracker.refreshSnapshot('claude', 'a1')
  assert.deepEqual(first.windows, [{ kind: 'session', usedPercent: 10 }])
  assert.equal(first.cache?.state, 'fresh')
  await tracker.refreshSnapshot('claude', 'a1')
  assert.equal(calls.count, 1, 'an if-needed refresh reuses the fresh reading')
  await tracker.refreshSnapshot('claude', 'a1', true)
  assert.equal(calls.count, 2, 'force re-checks despite the fresh reading')
})

test('refreshSnapshot: a stale reading is refreshed on demand, once', async () => {
  const clock = clockAt()
  const { tracker, calls } = trackerOf(() => Promise.resolve(OK_USAGE), { clock, freshMs: 300_000 })
  await tracker.refreshSnapshot('claude', 'a1')
  clock.at += 400_000
  assert.equal(tracker.snapshotFor('claude', 'a1').cache?.state, 'stale')
  assert.equal(calls.count, 1, 'reading a stale snapshot does not refresh it')
  await tracker.refreshSnapshot('claude', 'a1')
  assert.equal(calls.count, 2)
})

test('refreshSnapshot: a rate limit cools the endpoint down, and force never punches through', async () => {
  const clock = clockAt()
  const error = rateLimited(60_000)
  const { tracker, calls } = trackerOf(() => Promise.reject(error), { clock })
  const first = await tracker.refreshSnapshot('claude', 'a1')
  assert.equal(calls.count, 1)
  assert.deepEqual(first, {
    supported: true,
    cache: { state: 'error', retryAt: clock.at + 60_000, error: 'rate_limited', cause: 'endpoint', status: 429 },
  })
  await tracker.refreshSnapshot('claude', 'a1')
  await tracker.refreshSnapshot('claude', 'a1', true)
  await tracker.refreshSnapshot('claude', 'a1', true)
  assert.equal(calls.count, 1, 'a repeated manual Refresh respects retry-after')
  clock.at += 60_001
  await tracker.refreshSnapshot('claude', 'a1')
  assert.equal(calls.count, 2, 'the expired cooldown permits exactly one retry')
})

test('refreshSnapshot: a failure with no retry-after uses the configured retry delay', async () => {
  const clock = clockAt()
  const { tracker, calls } = trackerOf(() => Promise.reject(new Error('network blip')), {
    clock,
    retryDelayMs: 1_000,
  })
  await tracker.refreshSnapshot('claude', 'a1')
  clock.at += 999
  await tracker.refreshSnapshot('claude', 'a1')
  assert.equal(calls.count, 1, 'still inside the retry delay')
  clock.at += 2
  await tracker.refreshSnapshot('claude', 'a1')
  assert.equal(calls.count, 2, 'the retry delay expired')
})

test('refreshSnapshot: a last-known reading survives a failed refresh and stays stale', async () => {
  const clock = clockAt()
  let failing = false
  const { tracker, calls } = trackerOf(() => failing
    ? Promise.reject(rateLimited(60_000))
    : Promise.resolve({ supported: true, windows: [{ kind: 'session', usedPercent: 60 }] }), { clock })
  await tracker.refreshSnapshot('claude', 'a1')
  failing = true
  const failed = await tracker.refreshSnapshot('claude', 'a1', true)
  assert.deepEqual(failed.windows, [{ kind: 'session', usedPercent: 60 }])
  assert.equal(failed.cache?.state, 'stale')
  assert.equal(failed.cache?.error, 'rate_limited')
  assert.equal(calls.count, 2)
  // The retained windows keep feeding the availability floors.
  const quota = tracker.quotaFor(MEMBER)
  assert.equal(quota.observation, 'observed')
  assert.equal(quota.available, true)
  assert.deepEqual(quota.windows, [{ kind: 'session', usedPercent: 60 }])
  assert.deepEqual(quota.floorWindows, [{ kind: 'session', usedPercent: 60 }])
})

test('refreshSnapshot: a missing/invalid credential is never negative-cached, so recovery is immediate', async () => {
  let broken = true
  const { tracker, calls } = trackerOf(() =>
    broken ? Promise.reject(new LlmError('logged out', 'MISSING_CREDENTIAL')) : Promise.resolve(OK_USAGE))
  await assert.rejects(tracker.refreshSnapshot('claude', 'a1'), LlmError)
  assert.equal(tracker.snapshotFor('claude', 'a1').cache?.error, 'unauthorized')
  assert.equal(tracker.quotaFor(MEMBER).available, false, 'a logged-out account cannot serve')
  broken = false
  const recovered = await tracker.refreshSnapshot('claude', 'a1')
  assert.equal(recovered.cache?.state, 'fresh')
  assert.equal(calls.count, 2, 'every call re-checks credentials live, no cooldown')
})

// ---------------------------------------------------------------------------
// quotaFor is cache-only; ensureForUse is the one-candidate refresh.
// ---------------------------------------------------------------------------

test('refreshSnapshot: an endpoint reporting no window is asked once per horizon, not per demand', async () => {
  const clock = clockAt()
  const { tracker, calls } = trackerOf(() => Promise.resolve({ supported: true }), { clock, freshMs: 300_000 })
  const first = await tracker.refreshSnapshot('claude', 'a1')
  assert.equal(calls.count, 1)
  assert.equal(first.cache?.state, 'missing', 'no window is not a zero reading')
  for (let index = 0; index < 5; index++) await tracker.ensureForUse(MEMBER)
  assert.equal(calls.count, 1, 'a recent successful check throttles the redundant query')
  assert.equal(tracker.quotaFor(MEMBER).observation, 'unread', 'and the reading stays unknown')
  clock.at += 300_001
  await tracker.ensureForUse(MEMBER)
  assert.equal(calls.count, 2, 'past the horizon the next demand checks again')
})

test('quotaFor: a rejected login is unavailable even while a reading is retained', async () => {
  const clock = clockAt()
  let failing = false
  const { tracker } = trackerOf(() => failing
    ? Promise.reject(new LlmError('logged out', 'INVALID_CREDENTIAL'))
    : Promise.resolve({ supported: true, windows: [{ kind: 'session', usedPercent: 5 }] }), { clock })
  await tracker.refreshSnapshot('claude', 'a1')
  assert.equal(tracker.quotaFor(MEMBER).available, true)
  failing = true
  await assert.rejects(tracker.refreshSnapshot('claude', 'a1', true), LlmError)
  const quota = tracker.quotaFor(MEMBER)
  assert.equal(quota.available, false, 'a refused login cannot serve')
  assert.deepEqual(quota.windows, [{ kind: 'session', usedPercent: 5 }], 'the retained allowance still reaches the floors')
  assert.deepEqual(quota.floorWindows, [{ kind: 'session', usedPercent: 5 }])
})

test('quotaFor: a cold account scores neutral rather than empty, with no upstream request', () => {
  const { tracker, calls } = trackerOf(() => Promise.resolve(OK_USAGE))
  assert.deepEqual(tracker.quotaFor(MEMBER), {
    available: true,
    urgency: 0,
    fetchedAt: 0,
    observation: 'unread',
    cacheState: 'missing',
  })
  assert.equal(calls.count, 0)
})

test('quotaFor: an elapsed reset stops constraining routing without any refresh', async () => {
  const clock = clockAt()
  const { tracker, calls } = trackerOf(async () => ({ supported: true,
    windows: [{ kind: 'weekly', usedPercent: 50, resetsAt: clock.at + 1_000 }] }), { clock })
  await tracker.refreshSnapshot('claude', 'a1')
  assert.equal(tracker.quotaFor(MEMBER).windows?.length, 1)
  clock.at += 1_001
  for (let index = 0; index < 5; index++) {
    const result = tracker.quotaFor(MEMBER)
    assert.equal(result.urgency, 0)
    assert.deepEqual(result.windows, [], 'an elapsed window asserts nothing about the current period')
  }
  assert.equal(calls.count, 1, 'an elapsed window must not trigger a refresh loop')
})

test('quotaFor: another Claude model family does not affect availability or reset preferences', async () => {
  const clock = clockAt()
  const { tracker } = trackerOf(async () => ({ supported: true, windows: [
    { kind: 'weekly', scope: 'Sonnet', usedPercent: 100, resetsAt: clock.at + 1_000 },
    { kind: 'weekly', scope: 'Opus', usedPercent: 50, resetsAt: clock.at + 86_400_000 },
  ] }), { clock })
  await tracker.refreshSnapshot('claude', 'a1')
  const result = tracker.quotaFor(MEMBER)
  assert.equal(result.available, true)
  assert.equal(result.windows?.length, 1)
  assert.equal(result.windows?.[0].scope, 'Opus')
})

test('ensureForUse: a cold candidate is read once, and concurrent callers share that read', async () => {
  const pending = Promise.withResolvers<ProviderUsage>()
  let calls = 0
  const tracker = new PoolUsageTracker(
    () => () => { calls += 1; return pending.promise },
    { now: clockAt().now },
  )
  const first = tracker.ensureForUse(MEMBER)
  const second = tracker.ensureForUse(MEMBER)
  assert.equal(calls, 1, 'the second caller joins the in-flight read')
  pending.resolve(OK_USAGE)
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.windows?.[0].usedPercent, 10)
  assert.equal(b.windows?.[0].usedPercent, 10)
  assert.equal(calls, 1)
  await tracker.ensureForUse(MEMBER)
  assert.equal(calls, 1, 'a fresh reading serves the next candidate for free')
})

test('ensureForUse: a cooling-down endpoint is answered from cache, not retried', async () => {
  const clock = clockAt()
  const { tracker, calls } = trackerOf(() => Promise.reject(rateLimited(60_000)), { clock })
  const first = await tracker.ensureForUse(MEMBER)
  assert.equal(first.available, true, 'an unreadable usage endpoint must not block service')
  await tracker.ensureForUse(MEMBER)
  assert.equal(calls.count, 1)
})

// ---------------------------------------------------------------------------
// Partial observations.
// ---------------------------------------------------------------------------

test('observe: a partial observation does not make an omitted window look current', async () => {
  const clock = clockAt()
  const { tracker, calls } = trackerOf(async () => ({ supported: true, windows: [
    { kind: 'session', usedPercent: 10 },
    { kind: 'weekly', usedPercent: 20 },
  ] }), { clock, freshMs: 300_000 })
  await tracker.refreshSnapshot('claude', 'a1')
  clock.at += 400_000
  assert.equal(tracker.snapshotFor('claude', 'a1').cache?.state, 'stale')
  tracker.observe('claude', 'a1', { windows: [{ kind: 'session', usedPercent: 12 }], observedAt: clock.at })
  const partial = tracker.snapshotFor('claude', 'a1')
  assert.deepEqual(partial.windows, [
    { kind: 'session', usedPercent: 12 },
    { kind: 'weekly', usedPercent: 20 },
  ], 'only the lane the account reported is restamped')
  assert.equal(partial.cache?.state, 'stale', 'the omitted weekly window is as old as it was')
  assert.equal(calls.count, 1, 'an observation is local state, never an upstream read')
  await tracker.ensureForUse(MEMBER)
  assert.equal(calls.count, 2, 'the incomplete reading is completed by exactly one demand read')
  assert.equal(tracker.snapshotFor('claude', 'a1').cache?.state, 'fresh')
})

test('observe: an observation naming no window changes no reading', async () => {
  const clock = clockAt()
  const { tracker } = trackerOf(() => Promise.resolve(OK_USAGE), { clock })
  await tracker.refreshSnapshot('claude', 'a1')
  tracker.invalidate('claude', 'a1')
  tracker.observe('claude', 'a1', { observedAt: clock.at })
  assert.equal(tracker.snapshotFor('claude', 'a1').cache?.state, 'stale',
    'an empty observation cannot clear an invalidation')
})

test('observe: a reading older than the one on record is discarded', () => {
  const clock = clockAt(5_000)
  const tracker = new PoolUsageTracker(() => () => Promise.resolve(OK_USAGE), { now: clock.now })
  tracker.observe('claude', 'a1', { windows: [{ kind: 'session', usedPercent: 30 }], observedAt: 5_000 })
  tracker.observe('claude', 'a1', { windows: [{ kind: 'session', usedPercent: 90 }], observedAt: 1_000 })
  assert.deepEqual(tracker.snapshotFor('claude', 'a1').windows, [{ kind: 'session', usedPercent: 30 }])
})

test('observe: a reading that omits the reset keeps the one still ahead', () => {
  const clock = clockAt(1_000)
  const tracker = new PoolUsageTracker(() => () => Promise.resolve(OK_USAGE), { now: clock.now })
  tracker.observe('claude', 'a1', {
    windows: [{ kind: 'session', usedPercent: 10, resetsAt: 9_000 }],
    observedAt: 1_000,
  })
  tracker.observe('claude', 'a1', { windows: [{ kind: 'session', usedPercent: 20 }], observedAt: 2_000 })
  assert.deepEqual(tracker.snapshotFor('claude', 'a1').windows, [
    { kind: 'session', usedPercent: 20, resetsAt: 9_000 },
  ])
  clock.at = 9_001
  tracker.observe('claude', 'a1', { windows: [{ kind: 'session', usedPercent: 5 }], observedAt: 9_001 })
  assert.deepEqual(tracker.snapshotFor('claude', 'a1').windows, [{ kind: 'session', usedPercent: 5 }],
    'an elapsed reset is not inherited into the next period')
})

test('a partial or empty endpoint answer cannot erase a window that breached a floor', async () => {
  const clock = clockAt()
  const scheduling = resolvePoolScheduling()
  let answer: ProviderUsage = { supported: true, windows: [
    { kind: 'session', usedPercent: 92 },
    { kind: 'weekly', usedPercent: 96 },
  ] }
  const { tracker, calls } = trackerOf(() => Promise.resolve(answer), { clock, freshMs: 300_000 })
  await tracker.refreshSnapshot('claude', 'a1')
  const breaches = (): number => usageFloorBreaches('claude', tracker.quotaFor(MEMBER), scheduling).length
  assert.equal(breaches(), 2, 'both windows breach a Claude floor')

  clock.at += 400_000
  answer = { supported: true, windows: [{ kind: 'session', usedPercent: 92 }] }
  await tracker.refreshSnapshot('claude', 'a1', true)
  assert.equal(breaches(), 2, 'an omitted lane keeps the reading and the floor it established')
  assert.deepEqual(tracker.quotaFor(MEMBER).windows, [
    { kind: 'session', usedPercent: 92 },
    { kind: 'weekly', usedPercent: 96 },
  ])
  assert.equal(tracker.snapshotFor('claude', 'a1').cache?.state, 'stale',
    'the retained lane is reported at its own age, not as current')

  answer = { supported: true }
  await tracker.refreshSnapshot('claude', 'a1', true)
  assert.equal(breaches(), 2, 'an empty answer is not evidence that the allowance came back')
  assert.equal(calls.count, 3)
})

test('observe: a window the response omitted keeps its own reading', () => {
  const clock = clockAt()
  const { tracker, calls } = trackerOf(() => Promise.resolve(OK_USAGE), { clock })
  tracker.observe('claude', 'a1', { windows: [{ kind: 'session', usedPercent: 40 }], observedAt: clock.at })
  tracker.observe('claude', 'a1', { windows: [{ kind: 'weekly', usedPercent: 10 }], observedAt: clock.at })
  assert.deepEqual(tracker.snapshotFor('claude', 'a1').windows, [
    { kind: 'session', usedPercent: 40 },
    { kind: 'weekly', usedPercent: 10 },
  ])
  tracker.observe('claude', 'a1', { windows: [{ kind: 'session', usedPercent: 55 }], observedAt: clock.at })
  assert.deepEqual(tracker.snapshotFor('claude', 'a1').windows, [
    { kind: 'session', usedPercent: 55 },
    { kind: 'weekly', usedPercent: 10 },
  ])
  assert.equal(calls.count, 0, 'an observation is local state, never an upstream read')
})

test('observe: a later observation supersedes an older in-flight read', async () => {
  const clock = clockAt(1_000)
  const pending = Promise.withResolvers<ProviderUsage>()
  const tracker = new PoolUsageTracker(() => () => pending.promise, { now: clock.now })
  const refresh = tracker.refreshSnapshot('claude', 'a1')
  clock.at = 2_000
  // The account's own response states a refusal the usage read cannot overwrite.
  tracker.observeUnified('claude', 'a1', {
    status: 'rejected',
    windows: [{ window: '5h', utilization: 1, resetsAt: 9_000 }],
    observedAt: 2_000,
  })
  pending.resolve({ supported: true, windows: [{ kind: 'session', usedPercent: 12 }] })
  await refresh
  assert.deepEqual(tracker.snapshotFor('claude', 'a1').windows, [
    { kind: 'session', usedPercent: 100, resetsAt: 9_000 },
  ], 'the newer refusal is not overwritten by a read that started before it')
})

test('observeUnified: the account-level report becomes session and weekly readings', () => {
  const clock = clockAt(5_000)
  const tracker = new PoolUsageTracker(() => () => Promise.resolve(OK_USAGE), { now: clock.now })
  tracker.observeUnified('claude', 'a1', {
    status: 'allowed_warning',
    windows: [
      { window: '5h', utilization: 0.82, resetsAt: 20_000 },
      { window: '7d', utilization: 0.4, resetsAt: 900_000 },
      { window: '7d_oi', utilization: 0.6, resetsAt: 900_000 },
      { window: 'overage', utilization: 0.1 },
      { window: '5h', surpassedThreshold: 0.75 },
    ],
    observedAt: 5_000,
  })
  assert.deepEqual(tracker.snapshotFor('claude', 'a1').windows, [
    { kind: 'session', usedPercent: 82, resetsAt: 20_000 },
    { kind: 'weekly', usedPercent: 40, resetsAt: 900_000 },
    { kind: 'other', usedPercent: 10 },
  ], 'the overage-included lane is a second reading of the same week and is not merged')
})

test('observe: header absence is not a zero reading', () => {
  const clock = clockAt()
  const tracker = new PoolUsageTracker(() => () => Promise.resolve(OK_USAGE), { now: clock.now })
  tracker.observeUnified('claude', 'a1', { status: 'allowed', windows: [], observedAt: clock.at })
  const snapshot = tracker.snapshotFor('claude', 'a1')
  assert.equal(snapshot.cache?.state, 'missing')
  assert.equal(snapshot.windows, undefined, 'a report with no reading states no window')
  assert.equal(tracker.quotaFor(MEMBER).observation, 'unread')
})

// ---------------------------------------------------------------------------
// Removal, invalidation and durability.
// ---------------------------------------------------------------------------

test('forget: a read that lands after credential removal cannot resurrect the account', async () => {
  const pending = Promise.withResolvers<ProviderUsage>()
  const clock = clockAt()
  const { tracker, calls } = trackerOf(() => pending.promise, { clock })
  const refresh = tracker.refreshSnapshot('claude', 'a1')
  tracker.forget('claude', 'a1')
  pending.resolve(OK_USAGE)
  await refresh
  assert.equal(calls.count, 1)
  assert.deepEqual(tracker.snapshotFor('claude', 'a1'), {
    supported: true,
    cache: { state: 'missing' },
  }, 'the late read is discarded')
})

test('captureUnifiedObserver: a response captured before a logout cannot resurrect the account', async () => {
  const clock = clockAt(1_000)
  const tracker = new PoolUsageTracker(() => () => Promise.resolve(OK_USAGE), { now: clock.now })
  tracker.observeUnified('claude', 'a1', {
    status: 'allowed',
    windows: [{ window: '5h', utilization: 0.5, resetsAt: 9_000 }],
    observedAt: 1_000,
  })
  assert.equal(tracker.quotaFor(MEMBER).windows?.length, 1, 'a live observer still records its request')

  const late = tracker.captureUnifiedObserver('claude', 'a1')
  tracker.forget('claude', 'a1')
  // The request this sink belongs to answers after its credentials were removed.
  late({
    status: 'rejected',
    windows: [{ window: '5h', utilization: 1, resetsAt: 9_000 }],
    observedAt: 2_000,
  })
  assert.deepEqual(tracker.snapshotFor('claude', 'a1'), {
    supported: true,
    cache: { state: 'missing' },
  })
})

test('captureUnifiedObserver: a fresh response survives a concurrent invalidation', () => {
  const clock = clockAt(1_000)
  const tracker = new PoolUsageTracker(() => () => Promise.resolve(OK_USAGE), { now: clock.now })
  tracker.observeUnified('claude', 'a1', {
    status: 'allowed',
    windows: [{ window: '5h', utilization: 0.5 }],
    observedAt: 1_000,
  })
  // Another request's refusal distrusted the reading while this one was in flight.
  const observer = tracker.captureUnifiedObserver('claude', 'a1')
  tracker.invalidate('claude', 'a1')
  clock.at = 2_000
  observer({ status: 'allowed_warning', windows: [{ window: '5h', utilization: 0.75 }], observedAt: 2_000 })
  assert.deepEqual(tracker.snapshotFor('claude', 'a1').windows, [{ kind: 'session', usedPercent: 75 }],
    'a response taken after the invalidation is new evidence, not the distrusted reading')
})

test('captureUnifiedObserver: a response older than the reading on record changes nothing', () => {
  const clock = clockAt(5_000)
  const tracker = new PoolUsageTracker(() => () => Promise.resolve(OK_USAGE), { now: clock.now })
  tracker.observeUnified('claude', 'a1', {
    status: 'allowed',
    windows: [{ window: '5h', utilization: 0.5 }],
    observedAt: 5_000,
  })
  const observer = tracker.captureUnifiedObserver('claude', 'a1')
  observer({ status: 'rejected', windows: [{ window: '5h', utilization: 0.9 }], observedAt: 1_000 })
  assert.deepEqual(tracker.snapshotFor('claude', 'a1').windows, [{ kind: 'session', usedPercent: 50 }],
    'an older response cannot overwrite the newer reading')
  assert.equal(tracker.snapshotFor('claude', 'a1').cache?.state, 'fresh')
})

test('invalidate: the reading is marked stale and kept, so the floors still see it', async () => {
  const clock = clockAt()
  const { tracker } = trackerOf(async () => ({ supported: true,
    windows: [{ kind: 'session', usedPercent: 60 }] }), { clock })
  await tracker.refreshSnapshot('claude', 'a1')
  tracker.invalidate('claude', 'a1')
  const snapshot = tracker.snapshotFor('claude', 'a1')
  assert.deepEqual(snapshot.windows, [{ kind: 'session', usedPercent: 60 }])
  assert.equal(snapshot.cache?.state, 'stale')
  assert.deepEqual(tracker.quotaFor(MEMBER).windows, [{ kind: 'session', usedPercent: 60 }])
})

test('forget: a new demand does not join the previous session\'s outstanding read', async () => {
  const stale = Promise.withResolvers<ProviderUsage>()
  const fresh = Promise.withResolvers<ProviderUsage>()
  let calls = 0
  const tracker = new PoolUsageTracker(() => () => {
    calls += 1
    return calls === 1 ? stale.promise : fresh.promise
  }, { now: clockAt().now })
  const old = tracker.refreshSnapshot('claude', 'a1')
  tracker.forget('claude', 'a1')
  const next = tracker.ensureForUse(MEMBER)
  assert.equal(calls, 2, 'the new session starts its own read instead of joining the old one')
  fresh.resolve({ supported: true, windows: [{ kind: 'session', usedPercent: 3 }] })
  await next
  assert.equal(tracker.quotaFor(MEMBER).windows?.[0].usedPercent, 3)
  stale.resolve(OK_USAGE)
  await old
  assert.equal(tracker.quotaFor(MEMBER).windows?.[0].usedPercent, 3,
    'the earlier session\'s read cannot overwrite the new one')
})

test('dispose: an outstanding read settles and writes nothing afterwards', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-usage-store-'))
  const file = join(directory, 'usage.json')
  try {
    const clock = clockAt()
    const pending = Promise.withResolvers<ProviderUsage>()
    const tracker = new PoolUsageTracker(
      () => (signal) => {
        signal?.addEventListener('abort', () => pending.resolve(OK_USAGE))
        return pending.promise
      },
      { now: clock.now, store: createFileUsageStore({ file }) },
    )
    const read = tracker.refreshSnapshot('claude', 'a1')
    await tracker.dispose()
    await read
    assert.deepEqual(createFileUsageStore({ file }).records(), [],
      'a read that lands after disposal writes nothing')
    await tracker.flush()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a persisted reading keeps its recorded age across a restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-usage-store-'))
  const cached = join(directory, 'usage.json')
  const cooling = join(directory, 'cooldown.json')
  try {
    const clock = clockAt()
    const first = trackerOf(() => Promise.resolve(OK_USAGE), { clock, store: createFileUsageStore({ file: cached }) })
    await first.tracker.refreshSnapshot('claude', 'a1')
    await first.tracker.flush()

    let secondCalls = 0
    const second = new PoolUsageTracker(
      () => () => { secondCalls += 1; return Promise.resolve(OK_USAGE) },
      { now: clock.now, store: createFileUsageStore({ file: cached }) },
    )
    const restored = second.snapshotFor('claude', 'a1')
    assert.deepEqual(restored.windows, [{ kind: 'session', usedPercent: 10 }])
    assert.equal(restored.cache?.state, 'fresh', 'a restart reuses the reading under its recorded age')
    await second.ensureForUse(MEMBER)
    assert.equal(secondCalls, 0, 'a current reading needs no query after a restart')

    clock.at += 400_000
    assert.equal(second.snapshotFor('claude', 'a1').cache?.state, 'stale')
    await second.ensureForUse(MEMBER)
    assert.equal(secondCalls, 1, 'once it ages out, the next demand re-reads it')

    await second.forget('claude', 'a1')
    await second.flush()
    const third = new PoolUsageTracker(() => () => Promise.resolve(OK_USAGE), {
      now: clock.now,
      store: createFileUsageStore({ file: cached }),
    })
    assert.deepEqual(third.snapshotFor('claude', 'a1'), { supported: true, cache: { state: 'missing' } })

    // A persisted cooldown still gates the endpoint after a restart.
    const failing = trackerOf(() => Promise.reject(rateLimited(60_000)), {
      clock,
      store: createFileUsageStore({ file: cooling }),
    })
    await failing.tracker.refreshSnapshot('claude', 'a1')
    await failing.tracker.flush()
    let retryCalls = 0
    const restarted = new PoolUsageTracker(
      () => () => { retryCalls += 1; return Promise.resolve(OK_USAGE) },
      { now: clock.now, store: createFileUsageStore({ file: cooling }) },
    )
    await restarted.refreshSnapshot('claude', 'a1')
    assert.equal(retryCalls, 0, 'the persisted retry-after still suppresses the read')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Safe classification and the durable store's own contract.
// ---------------------------------------------------------------------------

test('usage store: two independently created stores preserve each other\'s records', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-usage-store-'))
  const file = join(directory, 'usage.json')
  try {
    // Each store loads the file once and then writes its own accounts: a write
    // must merge with what is on disk, not republish a stale whole snapshot.
    const alice = createFileUsageStore({ file })
    const bob = createFileUsageStore({ file })
    alice.save(storeRecord('a1', 10))
    await alice.flush()
    bob.save(storeRecord('a2', 20))
    await bob.flush()
    alice.save(storeRecord('a1', 11))
    await alice.flush()

    const onDisk = createFileUsageStore({ file }).records()
    assert.deepEqual(onDisk.map(record => record.account).sort(), ['a1', 'a2'])
    assert.equal(onDisk.find(record => record.account === 'a1')?.windows[0]?.usedPercent, 11,
      "alice's update lands without erasing bob's account")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('usage store: overlapping writers keep both records', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-usage-store-'))
  const file = join(directory, 'usage.json')
  try {
    const alice = createFileUsageStore({ file })
    const bob = createFileUsageStore({ file })
    alice.save(storeRecord('a1', 10))
    bob.save(storeRecord('a2', 20))
    await Promise.all([alice.flush(), bob.flush()])
    assert.deepEqual(
      createFileUsageStore({ file }).records().map(record => record.account).sort(),
      ['a1', 'a2'],
      'the shared lock serialized the two read-modify-write passes',
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('usage store: a deletion lands and is not resurrected by another store\'s write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-usage-store-'))
  const file = join(directory, 'usage.json')
  try {
    const alice = createFileUsageStore({ file })
    alice.save(storeRecord('a1', 10))
    alice.save(storeRecord('a2', 20))
    await alice.flush()

    const bob = createFileUsageStore({ file })
    bob.remove('claude', 'a1')
    await bob.flush()
    assert.deepEqual(createFileUsageStore({ file }).records().map(record => record.account), ['a2'])

    // Alice still holds the deleted account in her construction-time snapshot,
    // but her writes carry only the keys she changed.
    alice.save(storeRecord('a2', 21))
    await alice.flush()
    assert.deepEqual(createFileUsageStore({ file }).records().map(record => record.account), ['a2'],
      'a stale in-memory snapshot cannot republish a deleted account')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('usage store: a failed write leaves the previous file valid', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-usage-store-'))
  const file = join(directory, 'usage.json')
  // The write goes through this exact temporary path, so a directory there makes
  // the write fail the way a full disk would.
  const temporary = `${file}.${String(process.pid)}.tmp`
  const warnings: string[] = []
  try {
    const store = createFileUsageStore({ file, onWarn: message => { warnings.push(message) } })
    store.save(storeRecord('a1', 10))
    await store.flush()
    const before = readFileSync(file, 'utf8')

    mkdirSync(temporary, { recursive: true })
    store.save(storeRecord('a2', 20))
    await store.flush()
    assert.equal(readFileSync(file, 'utf8'), before, 'the previous file is untouched')
    assert.equal(warnings.some(message => message.includes('cannot write')), true)
    assert.deepEqual(createFileUsageStore({ file }).records().map(record => record.account), ['a1'])

    // Once the obstacle is gone, the queued write still lands rather than wedging.
    rmSync(temporary, { recursive: true, force: true })
    store.save(storeRecord('a3', 30))
    await store.flush()
    assert.deepEqual(createFileUsageStore({ file }).records().map(record => record.account).sort(), ['a1', 'a2', 'a3'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('classifyUsageFailure: names a safe reason and never the provider message', () => {
  assert.equal(classifyUsageFailure(rateLimited(1_000)), 'rate_limited')
  assert.equal(classifyUsageFailure(new OAuthEndpointError('nope', 401)), 'unauthorized')
  assert.equal(classifyUsageFailure(new OAuthEndpointError('down', 503)), 'unreachable')
  assert.equal(classifyUsageFailure(new LlmError('logged out', 'INVALID_CREDENTIAL')), 'unauthorized')
  assert.equal(classifyUsageFailure(new LlmError('token refresh failed', 'AUTH')), 'unknown')
  assert.equal(classifyUsageFailure(new LlmError('token refresh failed', 'AUTH', {
    cause: new OAuthEndpointError('raw-secret-body', 401, 'invalid_grant'),
  })), 'unauthorized')
  assert.equal(classifyUsageFailure(new Error('socket hang up')), 'unknown')
})

test('usageFailureFacts: reads only a safe status and OAuth code, including through a cause', () => {
  assert.deepEqual(
    usageFailureFacts(new OAuthEndpointError('raw-secret-body', 401, 'invalid_grant')),
    { cause: 'endpoint', status: 401, code: 'invalid_grant' },
  )
  assert.deepEqual(
    usageFailureFacts(new Error('wrapper', { cause: new OAuthEndpointError('raw-secret-body', 403, '<raw>') })),
    { cause: 'endpoint', status: 403 },
    'an unsafe or free-form code is omitted, while the status remains',
  )
  assert.deepEqual(usageFailureFacts(new Error('plain failure')), { cause: 'unknown' })
  const cyclic = new Error('cyclic failure')
  cyclic.cause = cyclic
  assert.deepEqual(usageFailureFacts(cyclic), { cause: 'unknown' })
})

test('refreshSnapshot: a wrapped token-refresh failure keeps safe endpoint facts in its cache entry', async () => {
  const clock = clockAt()
  const wrapped = new LlmError('token refresh failed', 'AUTH', {
    cause: new OAuthEndpointError('raw-secret-body', 401, 'invalid_client'),
  })
  const { tracker } = trackerOf(() => Promise.reject(wrapped), { clock })
  const failed = await tracker.refreshSnapshot('claude', 'a1')
  assert.deepEqual(failed.cache, {
    state: 'error',
    retryAt: clock.at,
    error: 'unauthorized',
    errorCode: 'AUTH',
    cause: 'endpoint',
    status: 401,
    code: 'invalid_client',
  })
})

test('usage store: an unreadable file or record is discarded rather than read as current', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-usage-store-'))
  try {
    const corrupt = join(directory, 'corrupt.json')
    writeFileSync(corrupt, '{"version":1,"accounts":[')
    assert.deepEqual(createFileUsageStore({ file: corrupt }).records(), [])

    const partial = join(directory, 'partial.json')
    writeFileSync(partial, JSON.stringify({
      version: 1,
      accounts: [{ provider: 'claude', account: 'a1', windows: [{ kind: 'session', usedPercent: 'lots' }] }],
    }))
    assert.deepEqual(createFileUsageStore({ file: partial }).records(), [],
      'a window with no usable reading is dropped with its record, never partly trusted')

    const restorable = join(directory, 'restorable.json')
    writeFileSync(restorable, JSON.stringify({
      version: 1,
      accounts: [
        { provider: 'claude', account: 'a1', windows: [{ kind: 'session', usedPercent: 10, observedAt: 5 }] },
        { provider: 'claude', account: 'a2', windows: [{ kind: 'session', usedPercent: 90, observedAt: 5 }] },
      ],
    }))
    assert.deepEqual(createFileUsageStore({ file: restorable }).records().map(record => record.account), ['a1', 'a2'])

    const future = join(directory, 'future.json')
    writeFileSync(future, JSON.stringify({ version: 99, accounts: [{ provider: 'claude', account: 'a1', windows: [] }] }))
    assert.deepEqual(createFileUsageStore({ file: future }).records(), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('usage store: safe endpoint facts survive a durable roundtrip', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-usage-store-'))
  const file = join(directory, 'usage.json')
  try {
    const store = createFileUsageStore({ file })
    store.save({
      provider: 'claude',
      account: 'a1',
      windows: [],
      failure: { at: 1_000, retryAt: 2_000, reason: 'unknown', status: 401, code: 'invalid_grant' },
    })
    await store.dispose()
    const restored = createFileUsageStore({ file }).records()[0]
    assert.deepEqual(restored?.failure, {
      at: 1_000,
      retryAt: 2_000,
      reason: 'unknown',
      status: 401,
      code: 'invalid_grant',
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('usage store: dispose lands the scheduled write and refuses later ones', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-usage-store-'))
  const file = join(directory, 'usage.json')
  try {
    const store = createFileUsageStore({ file })
    store.save({
      provider: 'claude',
      account: 'a1',
      observedAt: 1_000,
      windows: [{ kind: 'session', usedPercent: 10, observedAt: 1_000 }],
    })
    await store.dispose()
    const written = readFileSync(file, 'utf8')
    assert.equal(written.includes('a1'), true, 'dispose flushed the scheduled write')
    store.save({
      provider: 'claude',
      account: 'a2',
      windows: [{ kind: 'session', usedPercent: 1, observedAt: 2 }],
    })
    await store.flush()
    assert.equal(readFileSync(file, 'utf8'), written, 'a write after dispose is refused, not pending')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
