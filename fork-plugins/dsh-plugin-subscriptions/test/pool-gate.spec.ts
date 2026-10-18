/**
 * The account/session admission rules: session slots (two per account, the third
 * queues), one request per session, per-session backoff, the shared account
 * request limiter, account cooldowns, and the turn identity that makes a
 * turn-boundary rematch enforceable.
 *
 * These are unit tests of the gate itself; `pool.spec.ts` proves the same rules
 * through the pool adapter.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountKey, PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolGate, PoolGateError, SessionTurns, resolvePoolGatePolicy } from '../src/providers/pool-gate.js'
import type { PoolGateConfig } from '../src/providers/pool-gate.js'

/** A policy whose waits are short enough for tests and whose jitter is off. */
function testPolicy(overrides: PoolGateConfig = {}): ReturnType<typeof resolvePoolGatePolicy> {
  return resolvePoolGatePolicy({
    queueTimeoutMs: 200,
    sessionIdleMs: 60_000,
    // The production defaults rate-limit the account; a unit test that is not
    // about the limiter turns it off so scheduling assertions stay immediate.
    requestsPerMinute: 0,
    minGapMs: 0,
    burst: 1,
    backoff: { initialDelayMs: 10, maxDelayMs: 40, jitterRatio: 0, maxRetries: 10 },
    ...overrides,
  })
}

/** A gate over a fresh health registry. */
function makeGate(overrides: PoolGateConfig = {}): { gate: PoolGate; health: PoolHealthRegistry } {
  const health = new PoolHealthRegistry()
  return { gate: new PoolGate(testPolicy(overrides), health), health }
}

/** Wait a real, short interval (the gate schedules real timers). */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('the policy defaults match the confirmed subscription policy', () => {
  const policy = resolvePoolGatePolicy()
  assert.equal(policy.maxSessionsPerAccount, 2)
  // The shared account limiter is active by default.
  assert.equal(policy.requestsPerMinute, 20)
  assert.equal(policy.burst, 2)
  assert.equal(policy.minGapMs, 1_500)
  // Session backoff defaults, including the bounded retry budget.
  assert.equal(policy.backoff.initialDelayMs, 1_000)
  assert.equal(policy.backoff.maxDelayMs, 60_000)
  assert.equal(policy.backoff.jitterRatio, 0.2)
  assert.equal(policy.backoff.maxRetries, 10)
  assert.equal(policy.maxRefreshAttempts, 2)
  assert.equal(testPolicy({ maxSessionsPerAccount: 3 }).maxSessionsPerAccount, 3)
})

test('the concurrency schema rejects values that would disable a limit', () => {
  for (const invalid of [
    { maxSessionsPerAccount: 0 },
    { queueTimeoutMs: 0 },
    { sessionIdleMs: 0 },
    { minGapMs: -1 },
    { requestsPerMinute: -1 },
    { burst: 0 },
    { maxRefreshAttempts: -1 },
    { backoff: { initialDelayMs: 10, maxDelayMs: 5 } },
    { backoff: { maxRetries: -1 } },
  ]) {
    assert.throws(() => resolvePoolGatePolicy(invalid), Error, JSON.stringify(invalid))
  }
  const ctxPolicy = resolvePoolGatePolicy({ maxSessionsPerAccount: 2 })
  assert.equal(ctxPolicy.maxSessionsPerAccount, 2)
})

test('the third session of one account waits for a released slot', async () => {
  const { gate } = makeGate()
  await gate.acquireTurn('s1', 'codex', 'a1')
  await gate.acquireTurn('s2', 'codex', 'a1')
  assert.deepEqual(gate.snapshot('codex', 'a1'), {
    activeSessions: 2, queuedSessions: 0, inFlight: 0,
  })

  let granted = false
  const third = gate.acquireTurn('s3', 'codex', 'a1').then(() => { granted = true })
  await delay(20)
  assert.equal(granted, false, 'the third session is queued rather than admitted')
  assert.equal(gate.snapshot('codex', 'a1').queuedSessions, 1)

  gate.releaseTurn('s1')
  await third
  assert.equal(granted, true)
  assert.equal(gate.snapshot('codex', 'a1').activeSessions, 2)
})

test('a session keeps its slot across repeated requests and moves with its account', async () => {
  const { gate } = makeGate()
  await gate.acquireTurn('s1', 'codex', 'a1')
  await gate.acquireTurn('s1', 'codex', 'a1')
  assert.equal(gate.snapshot('codex', 'a1').activeSessions, 1)
  await gate.acquireTurn('s1', 'codex', 'a2')
  assert.equal(gate.snapshot('codex', 'a1').activeSessions, 0)
  assert.equal(gate.snapshot('codex', 'a2').activeSessions, 1)
})

test('one session sends one request at a time', async () => {
  const { gate } = makeGate()
  const releaseFirst = await gate.admit('s1', 'codex', 'a1')
  let secondGranted = false
  const second = gate.admit('s1', 'codex', 'a1').then((release) => {
    secondGranted = true
    return release
  })
  await delay(20)
  assert.equal(secondGranted, false, 'the second request queues behind the first')
  releaseFirst()
  const releaseSecond = await second
  assert.equal(secondGranted, true)
  releaseSecond()
})

test('an ordinary failure backs off one session and reports its retry wait', async () => {
  const { gate } = makeGate()
  gate.noteSessionFailure('s1', { reason: 'RATE_LIMIT', delayMs: 5_000 })
  await assert.rejects(gate.admit('s1', 'codex', 'a1'), error => {
    assert.ok(error instanceof PoolGateError)
    assert.equal(error.gateReason, 'rate_limited')
    const wait = error.failure.providerRetryAfterMs ?? 0
    assert.ok(wait > 0 && wait <= 5_000, `retry wait ${String(wait)}`)
    return true
  })
  // A different session is not held back by the first session's own backoff.
  const release = await gate.admit('s2', 'codex', 'a1')
  release()
})

test('a success clears the session backoff and its local delay', async () => {
  const { gate } = makeGate()
  gate.noteSessionFailure('s1', { reason: 'SERVER' })
  assert.equal(gate.snapshot('codex', 'a1').lastRateLimitedAt, undefined)
  gate.noteSuccess('s1')
  const release = await gate.admit('s1', 'codex', 'a1')
  release()
})

test('a local backoff grows and stays inside its configured ceiling', async () => {
  const { gate } = makeGate({ queueTimeoutMs: 10, backoff: { initialDelayMs: 40, maxDelayMs: 40, jitterRatio: 0 } })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    gate.noteSessionFailure('s1', { reason: 'SERVER' })
    await assert.rejects(gate.admit('s1', 'codex', 'a1'), error => {
      assert.ok(error instanceof PoolGateError)
      const wait = error.failure.providerRetryAfterMs ?? 0
      assert.ok(wait > 0 && wait <= 40, `wait ${String(wait)}`)
      return true
    })
  }
})

test('an account cooldown refuses every session until it expires', async () => {
  const { gate, health } = makeGate()
  gate.cooldown('codex', 'a1', 40, 'QUOTA')
  assert.deepEqual(health.accountCooling('codex', 'a1'), {
    unavailableUntil: Date.now() + 40, reason: 'QUOTA',
  })
  await assert.rejects(gate.admit('s1', 'codex', 'a1'), error => {
    assert.ok(error instanceof PoolGateError)
    assert.equal(error.gateReason, 'quota_exhausted')
    return true
  })
  await assert.rejects(gate.acquireTurn('s2', 'codex', 'a1'), error => {
    assert.ok(error instanceof PoolGateError)
    assert.equal(error.gateReason, 'quota_exhausted')
    return true
  })
  await delay(80)
  const release = await gate.admit('s1', 'codex', 'a1')
  release()
})

test('a credential cooldown reports account_unavailable', async () => {
  const { gate } = makeGate()
  gate.cooldown('claude', 'a1', 60_000, 'AUTH')
  await assert.rejects(gate.admit('s1', 'claude', 'a1'), error => {
    assert.ok(error instanceof PoolGateError)
    assert.equal(error.gateReason, 'account_unavailable')
    assert.equal(error.code, 'AUTH')
    return true
  })
})

test('the account request limiter spaces requests from different sessions', async () => {
  const { gate } = makeGate({ requestsPerMinute: 600, burst: 1, queueTimeoutMs: 2_000 })
  const first = await gate.admit('s1', 'codex', 'a1')
  first()
  const started = Date.now()
  const second = await gate.admit('s2', 'codex', 'a1')
  second()
  assert.ok(Date.now() - started >= 80, `second request started after ${String(Date.now() - started)}ms`)
})

test('a burst of requests passes at once and the next waits for a token', async () => {
  const { gate } = makeGate({ requestsPerMinute: 600, burst: 2, queueTimeoutMs: 2_000 })
  const started = Date.now()
  ;(await gate.admit('s1', 'codex', 'a1'))()
  ;(await gate.admit('s2', 'codex', 'a1'))()
  assert.ok(Date.now() - started < 40, 'the burst does not wait')
  ;(await gate.admit('s3', 'codex', 'a1'))()
  assert.ok(Date.now() - started >= 80, 'the request past the burst waits for its token')
})

test('a queued wait refuses after its budget instead of queueing forever', async () => {
  const { gate } = makeGate({ queueTimeoutMs: 20 })
  await gate.acquireTurn('s1', 'codex', 'a1')
  await gate.acquireTurn('s2', 'codex', 'a1')
  await assert.rejects(gate.acquireTurn('s3', 'codex', 'a1'), error => {
    assert.ok(error instanceof PoolGateError)
    assert.equal(error.gateReason, 'rate_limited')
    assert.ok((error.failure.providerRetryAfterMs ?? 0) > 0)
    return true
  })
})

test('cancellation releases a queued slot wait', async () => {
  const { gate } = makeGate({ queueTimeoutMs: 5_000 })
  await gate.acquireTurn('s1', 'codex', 'a1')
  await gate.acquireTurn('s2', 'codex', 'a1')
  const controller = new AbortController()
  const waiting = gate.acquireTurn('s3', 'codex', 'a1', controller.signal)
  controller.abort(new Error('user stopped the turn'))
  await assert.rejects(waiting, /user stopped the turn/)
  assert.equal(gate.snapshot('codex', 'a1').queuedSessions, 0)
})

test('an idle session releases its slot without a turn end', async () => {
  let now = 1_000
  const health = new PoolHealthRegistry()
  const gate = new PoolGate(testPolicy({ sessionIdleMs: 1_000 }), health, { now: () => now })
  await gate.acquireTurn('s1', 'codex', 'a1')
  await gate.acquireTurn('s2', 'codex', 'a1')
  let granted = false
  const third = gate.acquireTurn('s3', 'codex', 'a1').then(() => { granted = true })
  await delay(10)
  assert.equal(granted, false)
  now += 1_001
  // The next admission sweeps the idle sessions it finds.
  await gate.acquireTurn('s4', 'codex', 'a1')
  await third
  assert.equal(granted, true)
})

test('a disposed gate refuses queued waits and later admission', async () => {
  const { gate } = makeGate({ queueTimeoutMs: 5_000 })
  await gate.acquireTurn('s1', 'codex', 'a1')
  await gate.acquireTurn('s2', 'codex', 'a1')
  const waiting = gate.acquireTurn('s3', 'codex', 'a1')
  gate.dispose()
  await assert.rejects(waiting, /pool gate disposed/)
  await assert.rejects(gate.admit('s4', 'codex', 'a1'), /pool gate disposed/)
})

test('SessionTurns keys every turn afresh even when a resumed session reuses its number', () => {
  const turns = new SessionTurns()
  assert.equal(turns.current('s'), undefined)
  turns.noteTurnStart('s', 1)
  const first = turns.current('s')
  assert.ok(first !== undefined)
  // A resumed session restarts the log's turn counter; the key must still advance.
  turns.noteTurnStart('s', 1)
  const second = turns.current('s')
  assert.ok(second !== undefined)
  assert.notEqual(first.key, second.key, 'a repeated turn number is still a new turn')
  // An end naming a different turn does not close the open one.
  turns.noteTurnStart('s', 3)
  turns.noteTurnEnd('s', 2)
  assert.ok(turns.current('s') !== undefined)
  turns.noteTurnEnd('s', 3)
  assert.equal(turns.current('s'), undefined)
  turns.forget('s')
  assert.equal(turns.current('s'), undefined)
})

test('SessionTurns evicts the oldest session past its bound', () => {
  const turns = new SessionTurns(2)
  turns.noteTurnStart('a', 1)
  turns.noteTurnStart('b', 1)
  turns.noteTurnStart('c', 1)
  assert.equal(turns.current('a'), undefined)
  assert.ok(turns.current('b') !== undefined)
  assert.ok(turns.current('c') !== undefined)
})

test('the gate snapshot reports slots, waiting sessions and the last rate limit', async () => {
  const { gate } = makeGate({ queueTimeoutMs: 5_000 })
  await gate.acquireTurn('s1', 'codex', 'a1')
  await gate.acquireTurn('s2', 'codex', 'a1')
  void gate.acquireTurn('s3', 'codex', 'a1').catch(() => undefined)
  const release = await gate.admit('s1', 'codex', 'a1')
  gate.noteSessionFailure('s1', { reason: 'RATE_LIMIT', delayMs: 1 })
  const snapshot = gate.snapshot('codex', 'a1')
  assert.equal(snapshot.activeSessions, 2)
  assert.equal(snapshot.queuedSessions, 1)
  assert.equal(snapshot.inFlight, 1)
  assert.ok((snapshot.lastRateLimitedAt ?? 0) > 0)
  release()
  gate.releaseTurn('s1')
  gate.releaseTurn('s2')
  gate.dispose()
  await delay(5)
})

test('a health record from another pool does not answer for this account', async () => {
  const { gate, health } = makeGate()
  health.markUnavailable(accountKey('codex', 'a2'), 60_000, 'QUOTA')
  const release = await gate.admit('s1', 'codex', 'a1')
  release()
  assert.equal(health.isAvailable(accountKey('codex', 'a1')), true)
})

test('two credential refresh cycles are allowed before the account is parked', () => {
  const { gate } = makeGate({ maxRefreshAttempts: 2 })
  assert.deepEqual(gate.noteRefreshFailure('codex', 'a1'), { attempts: 1, exhausted: false })
  assert.equal(gate.snapshot('codex', 'a1').refreshAttempts, 1)
  assert.deepEqual(gate.noteRefreshFailure('codex', 'a1'), { attempts: 2, exhausted: false })
  // The third failure spends the budget and resets the counter for the next cycle.
  assert.deepEqual(gate.noteRefreshFailure('codex', 'a1'), { attempts: 3, exhausted: true })
  assert.equal(gate.snapshot('codex', 'a1').refreshAttempts, undefined)
})

test('a completed request resets the account refresh budget', async () => {
  const { gate } = makeGate({ maxRefreshAttempts: 2 })
  await gate.acquireTurn('s1', 'codex', 'a1')
  gate.noteRefreshFailure('codex', 'a1')
  const release = await gate.admit('s1', 'codex', 'a1')
  release()
  gate.noteSuccess('s1')
  assert.equal(gate.snapshot('codex', 'a1').refreshAttempts, undefined)
  assert.deepEqual(gate.noteRefreshFailure('codex', 'a1'), { attempts: 1, exhausted: false })
})

test('a session that spends its retry budget stops retrying until a new turn', async () => {
  const { gate } = makeGate({ backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, maxRetries: 2 } })
  for (let attempt = 0; attempt < 3; attempt += 1) gate.noteSessionFailure('s1', { reason: 'SERVER' })
  await assert.rejects(gate.admit('s1', 'codex', 'a1'), error => {
    assert.ok(error instanceof PoolGateError)
    assert.equal(error.gateReason, 'rate_limited')
    assert.equal(error.failure.retryDisposition, 'forbid', 'the spent budget is a hard stop')
    return true
  })
  // A new turn starts a fresh budget.
  gate.beginTurn('s1')
  await new Promise(resolve => setTimeout(resolve, 5))
  const release = await gate.admit('s1', 'codex', 'a1')
  release()
})
