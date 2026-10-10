/**
 * Rate-limit window handling: the shared value/duration/date parsing, each
 * provider's reset reader against its own 429 shapes, the classification of a
 * 429 as RATE_LIMIT ahead of the quota-wording check, the refusals that
 * classify as ENFORCEMENT instead, and the retry policy whose delay ceiling
 * decides how long a route may hold a turn open.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ENFORCEMENT_CODE, httpLlmError } from '../src/providers/common.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import {
  DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
  DEFAULT_RETRY,
  durationMs,
  earliestReset,
  jsonBody,
  resetFromFields,
  resetInstantFromNumber,
  resetInstantFromValue,
  resolveRateLimitWait,
  retryAfterInstant,
  subscriptionRetryPolicy,
  waitFromReset,
} from '../src/providers/rate-limit.js'
import { claudeRateLimitReset, ClaudeAdapter } from '../src/providers/claude.js'
import { codexRateLimitReset, CodexAdapter } from '../src/providers/codex.js'
import { grokRateLimitReset, GrokAdapter } from '../src/providers/grok.js'
import { CopilotAdapter } from '../src/providers/copilot.js'
import type { ClaudeSession, CodexSession, CopilotSession, GrokSession } from '../src/auth/store.js'

/** A fixed clock, so every expectation is an exact number rather than a window. */
const NOW = 1_800_000_000_000

/** Builds a failed response with the given headers and body. */
function failure(status: number, headers: Record<string, string>, body = ''): Response {
  return new Response(body, { status, headers })
}

/** An AccountTokenManager over an in-memory session; these tests never refresh. */
function memoryTokens<S extends { accessToken: string; refreshToken: string; expiresAt: number }>(
  initial: S,
): AccountTokenManager<S> {
  let stored: S | undefined = initial
  return new AccountTokenManager<S>({
    provider: 'codex',
    displayName: 'Test',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: session => Promise.resolve(session),
      isPermanent: () => false,
    }),
    io: {
      list: () => Promise.resolve(stored === undefined ? [] : [{ key: 'acct', session: stored }]),
      get: () => Promise.resolve(stored),
      save: (_account, session) => {
        stored = session
        return Promise.resolve()
      },
      remove: () => {
        stored = undefined
        return Promise.resolve()
      },
    },
  })
}

const claudeSession: ClaudeSession = { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW, scopes: 's' }
const codexSession: CodexSession = { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW, accountId: 'a' }
const grokSession: GrokSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: NOW,
  tokenEndpoint: 'https://auth.x.ai/token',
}
const copilotSession: CopilotSession = { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW }

test('a bare number is read as epoch ms, epoch seconds, or a delay by magnitude', () => {
  assert.equal(resetInstantFromNumber(NOW + 5_000, NOW), NOW + 5_000)
  assert.equal(resetInstantFromNumber(1_800_000_300, NOW), 1_800_000_300_000)
  assert.equal(resetInstantFromNumber(300, NOW), NOW + 300_000)
  // A full week as a delay still stays below the epoch-seconds floor.
  assert.equal(resetInstantFromNumber(604_800, NOW), NOW + 604_800_000)
  assert.equal(resetInstantFromNumber(0, NOW), undefined)
  assert.equal(resetInstantFromNumber(-5, NOW), undefined)
  assert.equal(resetInstantFromNumber(Number.NaN, NOW), undefined)
})

test('durations parse in the Go form the OpenAI-compatible headers use', () => {
  assert.equal(durationMs('6m0s'), 360_000)
  assert.equal(durationMs('1h2m3s'), 3_723_000)
  assert.equal(durationMs('1.5s'), 1_500)
  assert.equal(durationMs('150ms'), 150)
  assert.equal(durationMs(' 2m '), 120_000)
  assert.equal(durationMs('6m0s later'), undefined)
  assert.equal(durationMs('soon'), undefined)
  assert.equal(durationMs(''), undefined)
  // A rolled-over bucket, not a disclosed reset; the numeric path rejects 0 too.
  assert.equal(durationMs('0s'), undefined)
  assert.equal(durationMs('0h0m0s'), undefined)
  // Components run strictly coarse to fine; anything else is not a duration.
  assert.equal(durationMs('1s2h'), undefined)
  assert.equal(durationMs('1s1s'), undefined)
  assert.equal(durationMs('1m1h'), undefined)
})

test('a single value is read in every shape a provider might encode it in', () => {
  assert.equal(resetInstantFromValue(300, NOW), NOW + 300_000)
  assert.equal(resetInstantFromValue('300', NOW), NOW + 300_000)
  assert.equal(resetInstantFromValue('6m0s', NOW), NOW + 360_000)
  assert.equal(resetInstantFromValue('2027-01-15T10:30:00Z', NOW), Date.parse('2027-01-15T10:30:00Z'))
  assert.equal(resetInstantFromValue(null, NOW), undefined)
  assert.equal(resetInstantFromValue({ nested: 1 }, NOW), undefined)
  assert.equal(resetInstantFromValue('whenever', NOW), undefined)
  // Zero reads the same through both paths, so neither short-circuits a reader.
  assert.equal(resetInstantFromValue('0s', NOW), undefined)
  assert.equal(resetInstantFromValue('0', NOW), undefined)
})

test('retry-after reads a delay in seconds or an HTTP-date, never an epoch stamp', () => {
  assert.equal(retryAfterInstant(failure(429, { 'retry-after': '120' }), NOW), NOW + 120_000)
  // A large number stays a delay here, unlike a bare rate-limit field.
  assert.equal(retryAfterInstant(failure(429, { 'retry-after': '1800000000' }), NOW), NOW + 1_800_000_000_000)
  const date = 'Wed, 21 Oct 2026 07:28:00 GMT'
  assert.equal(retryAfterInstant(failure(429, { 'retry-after': date }), NOW), Date.parse(date))
  assert.equal(retryAfterInstant(failure(429, {}), NOW), undefined)
  assert.equal(retryAfterInstant(failure(429, { 'retry-after': '0' }), NOW), undefined)
})

test('a reset instant becomes a wait with clock-skew grace and a floor', () => {
  assert.equal(waitFromReset(NOW + 300_000, NOW), 302_000)
  // Already past: still scheduled, at the floor.
  assert.equal(waitFromReset(NOW - 60_000, NOW), 1_000)
  // Never capped here: an over-ceiling wait must reach the policy to be refused.
  assert.equal(waitFromReset(NOW + 7 * 24 * 3_600_000, NOW), 7 * 24 * 3_600_000 + 2_000)
})

test('a body field is found wherever the provider nests it', () => {
  const body = jsonBody('{"detail":{"type":"usage_limit_reached","resets_in_seconds":9000}}')
  assert.equal(resetFromFields(body, ['resets_in_seconds'], NOW), NOW + 9_000_000)
  assert.equal(resetFromFields(jsonBody('{"resets_in_seconds":60}'), ['resets_in_seconds'], NOW), NOW + 60_000)
  // The earliest of several matches wins.
  const many = jsonBody('{"a":{"resets_at":1800000600},"b":{"resets_at":1800000300}}')
  assert.equal(resetFromFields(many, ['resets_at'], NOW), 1_800_000_300_000)
  assert.equal(resetFromFields(jsonBody('{"other":5}'), ['resets_at'], NOW), undefined)
  assert.equal(jsonBody('<html>502</html>'), undefined)
})

test('earliestReset ignores absent candidates', () => {
  assert.equal(earliestReset(undefined, NOW + 10, undefined, NOW + 5), NOW + 5)
  assert.equal(earliestReset(undefined, undefined), undefined)
})

test('claude: the unified subscription window wins over the per-bucket headers', () => {
  const response = failure(429, {
    'anthropic-ratelimit-unified-reset': '1800009000',
    'anthropic-ratelimit-requests-reset': '2027-01-15T10:30:00Z',
  })
  assert.equal(claudeRateLimitReset(response, '', NOW), 1_800_009_000_000)
})

test('claude: the per-bucket snapshot headers never park a turn', () => {
  // Rollover stamps present on every response: the earliest is the bucket that
  // still had room, so waiting for it lands straight back in the closed window.
  const response = failure(429, {
    'anthropic-ratelimit-requests-reset': '2026-09-01T00:00:00Z',
    'anthropic-ratelimit-input-tokens-reset': '2027-01-15T10:30:00Z',
  })
  assert.equal(claudeRateLimitReset(response, '', NOW), undefined)
})

test('claude: a header-less rejection falls back to a reset named in the body', () => {
  const body = '{"type":"error","error":{"type":"rate_limit_error","resets_at":1800003600}}'
  assert.equal(claudeRateLimitReset(failure(429, {}), body, NOW), 1_800_003_600_000)
  assert.equal(claudeRateLimitReset(failure(429, {}), '{"type":"error"}', NOW), undefined)
})

test('codex: the exhausted window in the body wins over the snapshot headers', () => {
  const response = failure(429, { 'x-codex-primary-reset-after-seconds': '30' })
  const body = '{"detail":{"type":"usage_limit_reached","resets_in_seconds":9000,"plan_type":"plus"}}'
  assert.equal(codexRateLimitReset(response, body, NOW), NOW + 9_000_000)
})

test('codex: the snapshot headers never park a turn', () => {
  // A burst 429 clearing in seconds still carries the primary window rollover
  // hours out; reading it would hold the turn for those hours.
  const response = failure(429, {
    'x-codex-primary-reset-after-seconds': '17000',
    'x-codex-secondary-reset-after-seconds': '90000',
  })
  assert.equal(codexRateLimitReset(response, '{"detail":"Too many requests"}', NOW), undefined)
})

test('grok: the body wins over the OpenAI-compatible snapshot headers', () => {
  // `x-ratelimit-reset-requests: 0s` is a bucket with room while the token
  // bucket is the one exhausted; reading it burns the retry budget in seconds.
  const response = failure(429, {
    'x-ratelimit-reset-requests': '0s',
    'x-ratelimit-reset-tokens': '6m0s',
  })
  assert.equal(grokRateLimitReset(response, '{"error":{"retry_after":60}}', NOW), NOW + 60_000)
  assert.equal(grokRateLimitReset(response, '', NOW), undefined)
})

test('grok: a body-named retry delay serves when no header carries one', () => {
  assert.equal(grokRateLimitReset(failure(429, {}), '{"error":{"retry_after":45}}', NOW), NOW + 45_000)
  assert.equal(grokRateLimitReset(failure(429, {}), '{"error":"rate limited"}', NOW), undefined)
})

test('a 429 classifies as RATE_LIMIT even when the wording reads as terminal quota', async () => {
  const body = '{"detail":{"type":"usage_limit_reached","resets_in_seconds":9000,"plan_type":"plus"}}'
  const error = await httpLlmError(failure(429, {}, body), 'codex API', {
    rateLimitReset: codexRateLimitReset,
  })
  assert.equal(error.code, 'RATE_LIMIT')
  assert.ok(error.failure.providerRetryAfterMs !== undefined)
  assert.ok(error.failure.providerRetryAfterMs > 8_990_000)
})

test('quota wording still classifies as QUOTA on any other status', async () => {
  const error = await httpLlmError(failure(402, {}, 'Weekly usage limit exceeded'), 'codex API')
  assert.equal(error.code, 'QUOTA')
})

// ---------------------------------------------------------------------------
// Enforcement-shaped refusals: the provider said this identity will not be
// served, so the refusal is terminal for the turn and for the pool
// ---------------------------------------------------------------------------

test('a 429 carrying the server stop-retry header is an enforcement refusal', async () => {
  const response = failure(429, {
    'x-should-retry': 'false',
    'retry-after': '37800',
    'anthropic-ratelimit-unified-status': 'allowed_warning',
  }, '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}')
  const error = await httpLlmError(response, 'claude API', { rateLimitReset: claudeRateLimitReset })
  // Nothing else here says final: the window is disclosed and the status is a warning.
  assert.equal(error.code, ENFORCEMENT_CODE)
  // The disclosed reset still rides the error: the pool parks the account for it.
  assert.ok(error.failure.providerRetryAfterMs !== undefined)
  assert.ok(error.failure.providerRetryAfterMs > 3_000_000)
})

test('the server stop-retry header alone is enough, whatever the status', async () => {
  const error = await httpLlmError(failure(500, { 'x-should-retry': 'false' }, 'boom'), 'copilot API')
  assert.equal(error.code, ENFORCEMENT_CODE)
  const retryable = await httpLlmError(failure(500, { 'x-should-retry': 'true' }, 'boom'), 'copilot API')
  assert.equal(retryable.code, 'SERVER', 'an explicit "true" leaves the ordinary classification')
})

test('a rejected unified status is an enforcement refusal', async () => {
  const response = failure(429, {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-reset': String(Math.floor(NOW / 1_000) + 9_000),
  }, '')
  const error = await httpLlmError(response, 'claude API', { rateLimitReset: claudeRateLimitReset })
  assert.equal(error.code, ENFORCEMENT_CODE)
})

test('a rejected overage status is an enforcement refusal on its own', async () => {
  const response = failure(429, {
    'anthropic-ratelimit-unified-status': 'allowed_warning',
    'anthropic-ratelimit-unified-overage-status': 'rejected',
    'anthropic-ratelimit-unified-reset': String(Math.floor(NOW / 1_000) + 9_000),
  }, '')
  const error = await httpLlmError(response, 'claude API', { rateLimitReset: claudeRateLimitReset })
  assert.equal(error.code, ENFORCEMENT_CODE)
})

test('a disabled organisation, seat or member reason is an enforcement refusal', async () => {
  for (const reason of [
    'org_spend_cap_reached',
    'org_level_disabled',
    'org_level_disabled_until',
    'org_service_level_disabled',
    'member_level_disabled',
    'seat_tier_level_disabled',
  ]) {
    const response = failure(429, {
      'retry-after': '600',
      'anthropic-ratelimit-unified-overage-disabled-reason': reason,
    }, '')
    const error = await httpLlmError(response, 'claude API', { rateLimitReset: claudeRateLimitReset })
    assert.equal(error.code, ENFORCEMENT_CODE, reason)
  }
  // `fetch_error` reports a gateway that could not read its own counter, not a
  // stated block, so the disclosed window still governs the ordinary reading.
  const readable = failure(429, {
    'retry-after': '600',
    'anthropic-ratelimit-unified-overage-disabled-reason': 'fetch_error',
  }, '')
  const error = await httpLlmError(readable, 'claude API', { rateLimitReset: claudeRateLimitReset })
  assert.equal(error.code, 'RATE_LIMIT')
})

test('billing and credit wording is an enforcement refusal', async () => {
  for (const body of [
    '{"type":"error","error":{"type":"billing_error","message":"spend limit reached"}}',
    '{"error":{"code":"credits_required"}}',
    '{"error":"out_of_credits"}',
    '{"message":"extra usage is required to continue"}',
  ]) {
    const error = await httpLlmError(failure(429, { 'retry-after': '600' }, body), 'claude API')
    assert.equal(error.code, ENFORCEMENT_CODE, body)
  }
})

test('a refusal that disclosed no reset is an enforcement refusal', async () => {
  for (const response of [
    failure(429, { 'content-type': 'application/json' }, '{"error":"slow down"}'),
    failure(429, { 'x-codex-primary-reset-after-seconds': '17000' }, '{"detail":"Too many requests"}'),
  ]) {
    const error = await httpLlmError(response, 'codex API', { rateLimitReset: codexRateLimitReset })
    assert.equal(error.code, ENFORCEMENT_CODE)
  }
})

test('an ordinary rate limit keeps its code: a disclosed reset with no stop signal', async () => {
  for (const headers of [
    { 'retry-after': '30' },
    { 'retry-after': '30', 'x-should-retry': 'true' },
    { 'retry-after': '30', 'anthropic-ratelimit-unified-status': 'allowed_warning' },
    { 'retry-after': '30', 'anthropic-ratelimit-unified-status': 'allowed' },
  ]) {
    const error = await httpLlmError(failure(429, headers, '{"error":"slow down"}'), 'grok API', {
      rateLimitReset: grokRateLimitReset,
    })
    assert.equal(error.code, 'RATE_LIMIT', JSON.stringify(headers))
    assert.ok(error.failure.providerRetryAfterMs !== undefined)
  }
})

test('an exhausted window with a disclosed reset stays a rate limit', async () => {
  // `usage_limit_reached` is how these providers announce a spent window, not a
  // refusal: the body names the reset, so the turn waits it out as before.
  const body = '{"detail":{"type":"usage_limit_reached","resets_in_seconds":9000,"plan_type":"plus"}}'
  const error = await httpLlmError(failure(429, {}, body), 'codex API', {
    rateLimitReset: codexRateLimitReset,
  })
  assert.equal(error.code, 'RATE_LIMIT')
})

test('a rate-limit reset survives a body longer than the truncated message', async () => {
  const padding = 'x'.repeat(2_000)
  const body = JSON.stringify({ note: padding, detail: { resets_in_seconds: 600 } })
  const error = await httpLlmError(failure(429, {}, body), 'codex API', {
    rateLimitReset: codexRateLimitReset,
  })
  assert.equal(error.code, 'RATE_LIMIT')
  assert.ok(error.failure.providerRetryAfterMs !== undefined)
  assert.ok(error.failure.providerRetryAfterMs > 590_000)
  // The message itself stays truncated.
  assert.ok(error.message.length < 600)
})

test("the provider's own field beats a short retry-after on the same response", async () => {
  const response = failure(429, {
    'retry-after': '60',
    'anthropic-ratelimit-unified-reset': String(Math.floor(NOW / 1_000) + 9_000),
  }, '')
  const error = await httpLlmError(response, 'claude API', { rateLimitReset: claudeRateLimitReset })
  assert.ok(error.failure.providerRetryAfterMs !== undefined)
  assert.ok(error.failure.providerRetryAfterMs > 8_000_000, 'the window reset, not the 60s backoff')
})

test('retry-after still serves a provider that disclosed nothing else', async () => {
  const error = await httpLlmError(failure(429, { 'retry-after': '30' }, ''), 'grok API', {
    rateLimitReset: grokRateLimitReset,
  })
  assert.ok(error.failure.providerRetryAfterMs !== undefined)
  assert.ok(error.failure.providerRetryAfterMs >= 30_000)
})

test('a 429 that disclosed no reset warns with the headers that would have carried one', async () => {
  const warnings: string[] = []
  const response = failure(429, {
    'x-ratelimit-remaining-requests': '0',
    'content-type': 'application/json',
  }, '{"error":"slow down"}')
  const error = await httpLlmError(response, 'grok API', {
    rateLimitReset: grokRateLimitReset,
    onWarn: message => warnings.push(message),
  })
  assert.equal(error.failure.providerRetryAfterMs, undefined)
  // A refusal with no window to wait out is terminal, and the diagnostic still
  // names the headers that would have carried one — it is read on live traffic,
  // not waited on.
  assert.equal(error.code, ENFORCEMENT_CODE)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /grok API: 429 disclosed no reset time/)
  assert.match(warnings[0], /x-ratelimit-remaining-requests: 0/)
  assert.match(warnings[0], /slow down/)
  // Headers that say nothing about rate limits stay out of the diagnostic.
  assert.doesNotMatch(warnings[0], /content-type/)
})

test('a non-429 failure never emits the rate-limit diagnostic', async () => {
  const warnings: string[] = []
  await httpLlmError(failure(500, {}, 'boom'), 'grok API', { onWarn: message => warnings.push(message) })
  assert.deepEqual(warnings, [])
})

test('a non-429 failure never inherits the current window as its retry delay', async () => {
  // The rate-limit headers ride every response, so a transient overload would
  // otherwise report the window rollover — hours out — as its backoff, and the
  // retry plugin honours providerRetryAfterMs for every retryable code.
  const response = failure(529, {
    'anthropic-ratelimit-unified-reset': String(Math.floor(NOW / 1_000) + 14_400),
  }, '{"type":"error","error":{"type":"overloaded_error"}}')
  const error = await httpLlmError(response, 'claude API', { rateLimitReset: claudeRateLimitReset })
  assert.equal(error.code, 'SERVER')
  assert.equal(error.failure.providerRetryAfterMs, undefined)
})

test('retry-after still serves a non-429 that asked for a backoff', async () => {
  // Unlike a window snapshot, retry-after on a 503 is a delay the provider
  // actually asked for, so it stays readable on any status.
  const error = await httpLlmError(failure(503, { 'retry-after': '30' }, 'shedding load'), 'grok API', {
    rateLimitReset: grokRateLimitReset,
  })
  assert.equal(error.code, 'SERVER')
  assert.ok(error.failure.providerRetryAfterMs !== undefined)
  assert.ok(error.failure.providerRetryAfterMs >= 30_000)
})

test('a 429 whose only signal is a snapshot header warns instead of waiting', async () => {
  const warnings: string[] = []
  const response = failure(429, {
    'x-codex-primary-reset-after-seconds': '17000',
  }, '{"detail":"Too many requests"}')
  const error = await httpLlmError(response, 'codex API', {
    rateLimitReset: codexRateLimitReset,
    onWarn: message => warnings.push(message),
  })
  // A snapshot header is not a disclosed window for this request, so the refusal
  // is terminal rather than retried against a reset hours out.
  assert.equal(error.code, ENFORCEMENT_CODE)
  assert.equal(error.failure.providerRetryAfterMs, undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /x-codex-primary-reset-after-seconds: 17000/)
})

test('copilot uses generic retry-after and diagnoses unrecognized reset signals', async () => {
  const warnings: string[] = []
  const error = await httpLlmError(failure(429, {
    'retry-after': '30',
    'x-ratelimit-reset': '2027-01-15T10:30:00Z',
  }, '{"message":"rate limited"}'), 'copilot API', {
    onWarn: message => warnings.push(message),
  })
  assert.equal(error.code, 'RATE_LIMIT')
  assert.ok(error.failure.providerRetryAfterMs !== undefined)
  assert.ok(error.failure.providerRetryAfterMs >= 30_000)
  assert.equal(warnings.length, 0)

  const noRetryAfter = await httpLlmError(failure(429, {
    'x-ratelimit-reset': '2027-01-15T10:30:00Z',
  }, '{"message":"rate limited"}'), 'copilot API', {
    onWarn: message => warnings.push(message),
  })
  assert.equal(noRetryAfter.failure.providerRetryAfterMs, undefined)
  // A date this reader cannot use is not a disclosed window, so the refusal is
  // terminal rather than retried on local backoff into the same block.
  assert.equal(noRetryAfter.code, ENFORCEMENT_CODE)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /copilot API: 429 disclosed no reset time/)
  assert.match(warnings[0], /x-ratelimit-reset: 2027-01-15T10:30:00Z/)
})

test('waiting raises the disclosed-wait ceiling, not the backoff ceiling', () => {
  const policy = subscriptionRetryPolicy(
    DEFAULT_RETRY,
    { wait: true, maxWaitMs: 6 * 3_600_000 },
    'test: retryPolicy',
  )
  assert.equal(policy.mode, 'normal')
  // A provider may ask for hours; the route's own backoff keeps its own ceiling, so a local
  // backoff can never grow into the wait it is willing to sit out.
  assert.equal(policy.providerWaitMaxMs, 6 * 3_600_000)
  assert.equal(policy.maxDelayMs, DEFAULT_RETRY.maxDelayMs)
  assert.equal(policy.initialDelayMs, DEFAULT_RETRY.initialDelayMs)
  assert.equal(policy.mode === 'normal' && policy.maxRetries, DEFAULT_RETRY.maxRetries)
  assert.ok(policy.mode === 'normal' && policy.retryableCodes.includes('RATE_LIMIT'))
})

test('subscription routes retry the harness transient codes plus MALFORMED_RESPONSE', () => {
  const policy = subscriptionRetryPolicy(
    DEFAULT_RETRY,
    { wait: true, maxWaitMs: DEFAULT_RATE_LIMIT_MAX_WAIT_MS },
    'test: retryPolicy',
  )
  // Eligibility is the harness's transient defaults plus MALFORMED_RESPONSE: a route that
  // reads back a stream payload it cannot parse would otherwise fail a turn the genuine
  // client retries without streaming. ENFORCEMENT is absent by contract: a refusal the
  // provider stated is final is not a transient failure to back off from.
  assert.deepEqual(
    policy.mode === 'normal' ? policy.retryableCodes : undefined,
    ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'MALFORMED_RESPONSE'],
  )
  assert.equal(policy.mode === 'normal' && policy.retryableCodes.includes(ENFORCEMENT_CODE), false)
})

test('opting out of waiting restores the route defaults exactly', () => {
  const policy = subscriptionRetryPolicy(
    DEFAULT_RETRY,
    { wait: false, maxWaitMs: 6 * 3_600_000 },
    'test: retryPolicy',
  )
  assert.equal(policy.maxDelayMs, DEFAULT_RETRY.maxDelayMs)
})

test('a wait ceiling below the local backoff ceiling never shortens local backoff', () => {
  const policy = subscriptionRetryPolicy(
    DEFAULT_RETRY,
    { wait: true, maxWaitMs: 5_000 },
    'test: retryPolicy',
  )
  assert.equal(policy.maxDelayMs, DEFAULT_RETRY.maxDelayMs)
})

test('the shared retry shape is Claude Code\'s, not the dsh-llm default', () => {
  assert.deepEqual(DEFAULT_RETRY, {
    maxRetries: 10,
    initialDelayMs: 1_000,
    maxDelayMs: 60_000,
    jitterRatio: 0.2,
  })
})

test('rate-limit waiting defaults to on with a six-hour ceiling', () => {
  assert.deepEqual(resolveRateLimitWait(undefined, 'config: rateLimit'), {
    wait: true,
    maxWaitMs: DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
  })
  assert.deepEqual(resolveRateLimitWait({ wait: false }, 'config: rateLimit'), {
    wait: false,
    maxWaitMs: DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
  })
  assert.throws(
    () => resolveRateLimitWait({ maxWaitMs: 0 }, 'config: rateLimit'),
    /rateLimit.maxWaitMs must be a positive finite number/,
  )
  assert.throws(
    () => resolveRateLimitWait({ maxWaitMs: 30 * 24 * 3_600_000 }, 'config: rateLimit'),
    /maximum schedulable delay/,
  )
})

test('every route reports a policy able to hold the configured wait', () => {
  const rateLimit = { wait: true, maxWaitMs: 4 * 3_600_000 }
  const claude = new ClaudeAdapter({
    models: [{ id: 'claude-opus-5' }],
    streamIdleTimeoutMs: 1_000,
    tokens: memoryTokens(claudeSession),
    discovery: false,
    rateLimit,
  })
  const codex = new CodexAdapter({
    models: [{ id: 'gpt-5.1-codex' }],
    streamIdleTimeoutMs: 1_000,
    tokens: memoryTokens(codexSession),
    discovery: false,
    rateLimit,
  })
  const grok = new GrokAdapter({
    models: [{ id: 'grok-4' }],
    streamIdleTimeoutMs: 1_000,
    tokens: memoryTokens(grokSession),
    discovery: false,
    rateLimit,
  })
  const copilot = new CopilotAdapter({
    models: [{ id: 'gpt-4.1' }],
    streamIdleTimeoutMs: 1_000,
    tokens: memoryTokens(copilotSession),
    discovery: false,
    rateLimit,
  })
  // Two ceilings, two questions: every route accepts the configured wait for a
  // provider-disclosed reset, and each keeps its own ceiling for its own backoff.
  for (const [route, adapter] of [['claude', claude], ['codex', codex], ['grok', grok], ['copilot', copilot]] as const) {
    const policy = adapter.providerRetryPolicy(route)
    assert.ok(policy !== undefined, `${route} reports a policy`)
    assert.equal(policy.providerWaitMaxMs, 4 * 3_600_000, `${route} accepts the configured wait`)
  }
  // The claude route carries the client's own backoff shape: 32 s. Its delay therefore never
  // exceeds the client's one-minute abandon line, which is why no code needs to implement it.
  const claudePolicy = claude.providerRetryPolicy('claude')
  assert.ok(claudePolicy !== undefined, 'claude reports a policy')
  assert.equal(claudePolicy.maxDelayMs, 32_000, 'the local backoff keeps the client ceiling')

  // With waiting off, nothing beyond the route's own backoff ceiling is accepted.
  const noWait = new ClaudeAdapter({
    models: [{ id: 'claude-opus-5' }],
    streamIdleTimeoutMs: 1_000,
    tokens: memoryTokens(claudeSession),
    discovery: false,
    rateLimit: { wait: false, maxWaitMs: 4 * 3_600_000 },
  })
  assert.equal(noWait.providerRetryPolicy('claude')?.providerWaitMaxMs, 32_000)

  // Every route carries Claude Code's retry budget, not just claude.
  for (const [route, adapter] of [['codex', codex], ['grok', grok], ['copilot', copilot]] as const) {
    const policy = adapter.providerRetryPolicy(route)
    assert.equal(policy?.mode === 'normal' && policy.maxRetries, DEFAULT_RETRY.maxRetries, route)
    assert.equal(policy?.initialDelayMs, DEFAULT_RETRY.initialDelayMs, route)
    assert.equal(policy?.jitterRatio, DEFAULT_RETRY.jitterRatio, route)
  }
  // The claude route departs from the shared shape on the two values the client's own
  // backoff helper carries, while keeping the same budget.
  assert.equal(claudePolicy?.mode === 'normal' && claudePolicy.maxRetries, DEFAULT_RETRY.maxRetries)
  assert.equal(claudePolicy?.initialDelayMs, 500)
  assert.equal(claudePolicy?.jitterRatio, 0.25)
})
