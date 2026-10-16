import assert from 'node:assert/strict'
import test from 'node:test'
import { httpLlmError } from '../src/providers/common.js'
import { claudeRateLimitReset, claudeRetryHeaderReset } from '../src/providers/claude.js'

const options = { rateLimitReset: claudeRateLimitReset, retryHeaderReset: claudeRetryHeaderReset }
const response = (status: number, headers: Record<string, string>) => new Response('{"error":{"type":"api_error","message":"temporary"}}', { status, headers })

test('Claude preserves a millisecond-only 503 delay and leaves other providers unchanged', async () => {
  const error = await httpLlmError(response(503, { 'retry-after-ms': '60000' }), 'claude', options)
  assert.equal(error.code, 'SERVER')
  assert.equal(error.failure.providerRetryAfterMs, 62000)
  const other = await httpLlmError(response(503, { 'retry-after-ms': '60000' }), 'other')
  assert.equal(other.failure.providerRetryAfterMs, undefined)
})

test('a millisecond window makes 429 waitable but cannot override a refusal', async () => {
  for (const status of [429, 503]) {
    const allowed = await httpLlmError(response(status, { 'retry-after-ms': '60000' }), 'claude', options)
    assert.equal(allowed.code, status === 429 ? 'RATE_LIMIT' : 'SERVER')
    assert.equal(allowed.failure.providerRetryAfterMs, 62000)
    for (const refused of [{ 'x-should-retry': 'false' }, { 'anthropic-ratelimit-unified-status': 'rejected' }]) {
      const error = await httpLlmError(response(status, { 'retry-after-ms': '60000', ...refused }), 'claude', options)
      assert.equal(error.code, 'ENFORCEMENT')
    }
  }
})

test('Claude follows millisecond precedence, fallback, date parsing and timer bounds', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  for (const [ms, seconds, expected] of [
    ['60000', '1', 60000], ['bad', '2', 2000], ['0', '2', 2000],
    ['-1', '2', undefined], ['Infinity', '2', undefined], ['2147483648', '2', undefined],
    ['2147483647', '2', 2147483647], ['', 'Thu, 01 Jan 2026 00:01:00 GMT', 60000],
  ] as const) {
    assert.equal(claudeRetryHeaderReset(response(503, { 'retry-after-ms': ms, 'retry-after': seconds }), now), expected === undefined ? undefined : now + expected)
  }
})

test('the account rate-limit reset still wins over a short retry header', async () => {
  const reset = Math.ceil(Date.now() / 1000) + 120
  const error = await httpLlmError(response(429, { 'retry-after-ms': '1000', 'anthropic-ratelimit-unified-reset': String(reset) }), 'claude', options)
  assert.equal(error.code, 'RATE_LIMIT')
  assert.ok((error.failure.providerRetryAfterMs ?? 0) > 100_000)
  assert.equal((await httpLlmError(response(429, { 'retry-after-ms': 'bad' }), 'claude', options)).code, 'ENFORCEMENT')
})
