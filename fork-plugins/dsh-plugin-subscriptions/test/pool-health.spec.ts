/**
 * Pool health bookkeeping: failure classification (which failures back one
 * session off, which park the account until a disclosed reset, and which
 * rethrow) and the cooldown registry (expiry, longest-cooldown-wins,
 * per-provider and per-account clear). Records are account-granular: one
 * account's cooldown never parks another account of the same provider.
 *
 * No classified effect switches accounts: the concurrency policy keeps a turn on
 * the account it started on, so the classifier only states what the failure is
 * evidence about.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { ENFORCEMENT_CODE } from '../src/providers/common.js'
import {
  accountKey,
  AUTH_COOLDOWN_MS,
  classifyPoolFailure,
  DEFAULT_QUOTA_COOLDOWN_MS,
  exhaustionCode,
  isAuthCooldownReason,
  isRefusalCode,
  memberKey,
  PoolHealthRegistry,
  TRANSIENT_COOLDOWN_MS,
} from '../src/providers/pool-health.js'

test('classifyPoolFailure: quota parks the account until its reset', () => {
  assert.deepEqual(classifyPoolFailure(new LlmError('quota', 'QUOTA'), 'codex'), {
    action: 'account-cooldown',
    cooldownMs: DEFAULT_QUOTA_COOLDOWN_MS,
    reason: 'QUOTA',
  })
  // The account-level policy does not split a provider's model lanes: one closed
  // window parks the account, and the next turn rematches.
  assert.deepEqual(classifyPoolFailure(new LlmError('quota', 'QUOTA'), 'claude'), {
    action: 'account-cooldown',
    cooldownMs: DEFAULT_QUOTA_COOLDOWN_MS,
    reason: 'QUOTA',
  })
})

test('classifyPoolFailure: an ordinary rate limit backs off only its session', () => {
  assert.deepEqual(classifyPoolFailure(new LlmError('limited', 'RATE_LIMIT'), 'grok'), {
    action: 'session-backoff',
    reason: 'RATE_LIMIT',
  })
  // The provider's disclosed wait is carried into the session's own backoff.
  const withWait = new LlmError('slow down', 'RATE_LIMIT', { providerRetryAfterMs: 42_000 })
  assert.deepEqual(classifyPoolFailure(withWait, 'codex'), {
    action: 'session-backoff',
    reason: 'RATE_LIMIT',
    delayMs: 42_000,
  })
})

test('classifyPoolFailure: 401 and revoked 403 refresh before they park', () => {
  // Both arrive as AUTH; the gate bounds the refresh cycles and parks afterwards.
  for (const status of [401, 403]) {
    assert.deepEqual(classifyPoolFailure(new LlmError('denied', 'AUTH', { status }), 'claude'), {
      action: 'refresh',
      reason: 'AUTH',
    }, `HTTP ${String(status)}`)
  }
  // A dead login cannot be refreshed, so it parks immediately.
  for (const code of ['INVALID_CREDENTIAL', 'MISSING_CREDENTIAL']) {
    assert.deepEqual(classifyPoolFailure(new LlmError('dead login', code), 'claude'), {
      action: 'account-cooldown',
      cooldownMs: AUTH_COOLDOWN_MS,
      reason: code,
    })
  }
})

test('classifyPoolFailure: a window/quota 429 parks the account; other stated refusals are terminal', () => {
  // A disclosed window: an ENFORCEMENT-shaped 429 parks until its reset.
  assert.deepEqual(classifyPoolFailure(
    new LlmError('refused', ENFORCEMENT_CODE, { status: 429, providerRetryAfterMs: 3_600_000 }), 'claude'), {
    action: 'account-cooldown',
    cooldownMs: 3_600_000,
    reason: ENFORCEMENT_CODE,
  })
  assert.deepEqual(classifyPoolFailure(
    new LlmError('refused', ENFORCEMENT_CODE, { status: 429 }), 'codex'), {
    action: 'account-cooldown',
    cooldownMs: DEFAULT_QUOTA_COOLDOWN_MS,
    reason: ENFORCEMENT_CODE,
  })
  // x-should-retry:false on a non-429 status is terminal, not a parked account.
  assert.deepEqual(classifyPoolFailure(
    new LlmError('refused', ENFORCEMENT_CODE, { status: 500, retryDisposition: 'forbid' }), 'codex'), {
    action: 'throw',
  })
})

test('classifyPoolFailure: transient statuses, 409 and a pre-delivery malformed stream back off', () => {
  for (const code of ['SERVER', 'TIMEOUT', 'EMPTY_RESPONSE', 'TRANSPORT', 'MALFORMED_RESPONSE', 'CONFLICT']) {
    assert.deepEqual(classifyPoolFailure(new LlmError('oops', code), 'codex'), {
      action: 'session-backoff',
      reason: code,
    }, code)
  }
})

test('classifyPoolFailure: a model-scoped refusal parks no account', () => {
  assert.deepEqual(classifyPoolFailure(new LlmError('denied', 'MODEL_DENIED'), 'claude'), {
    action: 'model-scoped',
    reason: 'MODEL_DENIED',
  })
  assert.deepEqual(classifyPoolFailure(new LlmError('no model', 'HTTP_404'), 'codex'), {
    action: 'model-scoped',
    reason: 'HTTP_404',
  })
})

test('classifyPoolFailure: plan availability parks the account briefly', () => {
  assert.deepEqual(classifyPoolFailure(new LlmError('payment', 'HTTP_402'), 'codex'), {
    action: 'account-cooldown',
    cooldownMs: TRANSIENT_COOLDOWN_MS,
    reason: 'HTTP_402',
  })
})

test('classifyPoolFailure: a locally excluded member sent no request and may yield', () => {
  assert.deepEqual(classifyPoolFailure(new LlmError('excluded', 'NO_ADAPTER'), 'codex'), {
    action: 'member-ineligible',
    reason: 'NO_ADAPTER',
  })
})

test('classifyPoolFailure: request faults, refusals and aborts are terminal', () => {
  for (const code of [
    'CONTEXT_WINDOW_EXCEEDED', 'ABORTED', 'HTTP_400', 'HTTP_413',
    'INVALID_REQUEST', 'PERMISSION_DENIED', 'CLIENT_VERSION_UNSUPPORTED',
    'UNCLASSIFIED_PROVIDER_ERROR', 'STREAM_INCOMPLETE',
  ]) {
    assert.deepEqual(classifyPoolFailure(new LlmError('bad request', code), 'codex'), { action: 'throw' }, code)
  }
  assert.deepEqual(classifyPoolFailure(new Error('plain'), 'codex'), { action: 'throw' })
  assert.deepEqual(classifyPoolFailure('string failure', 'codex'), { action: 'throw' })
})

test('classifyPoolFailure: a hard stop is decided before its code, including a transient one', () => {
  for (const code of ['SERVER', 'TIMEOUT', 'PERMISSION_DENIED', 'MALFORMED_RESPONSE']) {
    const error = new LlmError(code, code, { retryDisposition: 'forbid' })
    assert.deepEqual(classifyPoolFailure(error, 'claude'), { action: 'throw' }, code)
  }
  // A forbidden 429 still names the window the account must sit out.
  assert.deepEqual(classifyPoolFailure(
    new LlmError('refused', ENFORCEMENT_CODE, { status: 429, retryDisposition: 'forbid' }), 'claude'), {
    action: 'account-cooldown',
    cooldownMs: DEFAULT_QUOTA_COOLDOWN_MS,
    reason: ENFORCEMENT_CODE,
  })
})

test('isRefusalCode names the codes a refusal is aimed at one identity by', () => {
  for (const code of [ENFORCEMENT_CODE, 'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL']) {
    assert.equal(isRefusalCode(code), true, code)
  }
  for (const code of ['RATE_LIMIT', 'QUOTA', 'SERVER', 'TRANSPORT', 'HTTP_402', 'HTTP_404']) {
    assert.equal(isRefusalCode(code), false, code)
  }
})

test('exhaustionCode reports a refusal over a sibling reason and shares a lone reason', () => {
  assert.equal(exhaustionCode(new Set([ENFORCEMENT_CODE, 'RATE_LIMIT'])), ENFORCEMENT_CODE)
  assert.equal(exhaustionCode(new Set(['AUTH', 'RATE_LIMIT'])), 'AUTH')
  assert.equal(exhaustionCode(new Set(['MISSING_CREDENTIAL', 'SERVER'])), 'MISSING_CREDENTIAL')
  assert.equal(exhaustionCode(new Set(['SERVER'])), 'SERVER')
  // Nothing recognizable to name: the cooling-down state they have in common.
  assert.equal(exhaustionCode(new Set(['SERVER', 'TIMEOUT'])), 'RATE_LIMIT')
  assert.equal(exhaustionCode(new Set()), 'RATE_LIMIT')
})

test('PoolHealthRegistry: members cool down and recover on expiry', () => {
  const registry = new PoolHealthRegistry()
  const key = memberKey('codex', 'a1', 'gpt-5.4')
  assert.equal(registry.isAvailable(key, 1000), true)
  registry.markUnavailable(key, 5000, 'QUOTA', 1000)
  assert.equal(registry.isAvailable(key, 5999), false)
  assert.equal(registry.isAvailable(key, 6000), true)
})

test('PoolHealthRegistry: a longer existing cooldown wins', () => {
  const registry = new PoolHealthRegistry()
  const key = memberKey('claude', 'a1', 'claude-sonnet-5')
  registry.markUnavailable(key, 10_000, 'QUOTA', 0)
  registry.markUnavailable(key, 1000, 'SERVER', 0)
  assert.equal(registry.isAvailable(key, 5000), false)
  assert.equal(registry.isAvailable(key, 10_000), true)
})

test('PoolHealthRegistry: an account-wide record parks every member of the account only', () => {
  const registry = new PoolHealthRegistry()
  registry.markUnavailable(accountKey('codex', 'a1'), 60_000, 'RATE_LIMIT', 0)
  assert.equal(registry.isMemberAvailable('codex', 'a1', 'gpt-5.4', 1000), false)
  assert.equal(registry.isMemberAvailable('codex', 'a1', 'gpt-5.4-mini', 1000), false)
  // Another account of the same provider and other providers are untouched.
  assert.equal(registry.isMemberAvailable('codex', 'a2', 'gpt-5.4', 1000), true)
  assert.equal(registry.isMemberAvailable('claude', 'a1', 'claude-sonnet-5', 1000), true)
  assert.equal(registry.isMemberAvailable('codex', 'a1', 'gpt-5.4', 60_000), true)
})

test('PoolHealthRegistry: earliestRecovery reports the soonest expiry among the given keys', () => {
  const registry = new PoolHealthRegistry()
  const keys = new Set([memberKey('codex', 'a1', 'a'), memberKey('claude', 'a1', 'b')])
  assert.equal(registry.earliestRecovery(keys, 0), undefined)
  registry.markUnavailable(memberKey('codex', 'a1', 'a'), 9000, 'QUOTA', 0)
  registry.markUnavailable(memberKey('claude', 'a1', 'b'), 3000, 'QUOTA', 0)
  assert.equal(registry.earliestRecovery(keys, 0), 3000)
  // Expired records are dropped, not reported.
  assert.equal(registry.earliestRecovery(keys, 5000), 9000)
})

test('PoolHealthRegistry: earliestRecovery ignores records outside the given keys', () => {
  const registry = new PoolHealthRegistry()
  registry.markUnavailable(memberKey('grok', 'a1', 'other-pool-member'), 1000, 'QUOTA', 0)
  registry.markUnavailable(memberKey('codex', 'a1', 'a'), 9000, 'QUOTA', 0)
  const keys = new Set([memberKey('codex', 'a1', 'a'), accountKey('codex', 'a1')])
  // The unrelated pool's sooner recovery must not shape this pool's hint.
  assert.equal(registry.earliestRecovery(keys, 0), 9000)
})

test('PoolHealthRegistry: clear drops one account, or the whole provider when no account is given', () => {
  const registry = new PoolHealthRegistry()
  registry.markUnavailable(memberKey('codex', 'a1', 'a'), 60_000, 'AUTH', 0)
  registry.markUnavailable(accountKey('codex', 'a1'), 60_000, 'AUTH', 0)
  registry.markUnavailable(memberKey('codex', 'a2', 'a'), 60_000, 'AUTH', 0)
  registry.markUnavailable(memberKey('claude', 'a1', 'c'), 60_000, 'AUTH', 0)
  registry.clear('codex', 'a1')
  assert.equal(registry.isMemberAvailable('codex', 'a1', 'a', 0), true)
  assert.equal(registry.isMemberAvailable('codex', 'a2', 'a', 0), false)
  registry.clear('codex')
  assert.equal(registry.isMemberAvailable('codex', 'a2', 'a', 0), true)
  assert.equal(registry.isMemberAvailable('claude', 'a1', 'c', 0), false)
})

test('PoolHealthRegistry: accountCooling reports the longest unexpired record of one account', () => {
  const registry = new PoolHealthRegistry()
  assert.equal(registry.accountCooling('codex', 'a1', 0), undefined)
  // Another account's record must not answer for this one.
  registry.markUnavailable(memberKey('codex', 'a2', 'gpt-5.4'), 9000, 'QUOTA', 0)
  assert.equal(registry.accountCooling('codex', 'a1', 0), undefined)
  registry.markUnavailable(memberKey('codex', 'a1', 'gpt-5.4'), 4000, 'QUOTA', 0)
  registry.markUnavailable(accountKey('codex', 'a1'), 9000, 'AUTH', 0)
  assert.deepEqual(registry.accountCooling('codex', 'a1', 1000), { unavailableUntil: 9000, reason: 'AUTH' })
  // An expired record is dropped rather than reported.
  assert.deepEqual(registry.accountCooling('codex', 'a1', 5000), { unavailableUntil: 9000, reason: 'AUTH' })
  assert.equal(registry.accountCooling('codex', 'a1', 9000), undefined)
})

test('isAuthCooldownReason separates a dead login from a spent allowance', () => {
  assert.equal(isAuthCooldownReason('AUTH'), true)
  assert.equal(isAuthCooldownReason('INVALID_CREDENTIAL'), true)
  assert.equal(isAuthCooldownReason('MISSING_CREDENTIAL'), true)
  assert.equal(isAuthCooldownReason('QUOTA'), false)
  assert.equal(isAuthCooldownReason('RATE_LIMIT'), false)
  assert.equal(isAuthCooldownReason('SERVER'), false)
})
