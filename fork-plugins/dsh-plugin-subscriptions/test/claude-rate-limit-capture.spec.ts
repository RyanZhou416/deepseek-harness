/**
 * The Claude route's unified rate-limit capture, end to end: the headers the
 * provider attaches to an answered Messages response — the 429 included — land
 * in the plugin's per-account record under the canonical account key that the
 * Settings page also addresses. The transport is injected; no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { ClaudeAdapter } from '../src/providers/claude.js'
import { forgetUnifiedRateLimit, unifiedRateLimitFor } from '../src/providers/unified-rate-limit.js'
import type { FetchFn } from '../src/providers/common.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

const SESSION: ClaudeSession = {
  accessToken: 'synthetic-access-token-0123456789abcdef0123456789abcdef0123456789abcdef',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 3_600_000,
  scopes: 'user:inference',
  accountUuid: 'uuid-1',
  deviceId: 'd'.repeat(64),
  subscriptionType: 'max',
}

const RESPONSE_SSE = [
  `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 3 } } })}\n\n`,
  `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })}\n\n`,
  `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
].join('')

function history(): TranslatableMessage[] {
  return [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
}

function tokens(): AccountTokenManager<ClaudeSession> {
  return new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Test',
    makeOptions: () => ({ preemptMs: 0, refresh: async () => SESSION, isPermanent: () => false }),
    io: {
      list: async () => [{ key: 'acct', session: SESSION }],
      get: async () => SESSION,
      save: async () => {},
      remove: async () => {},
    },
  })
}

/** Drive one generate call through the adapter with the given response headers. */
async function streamOnce(headers: Record<string, string>, status = 200): Promise<void> {
  const fetchFn = (async () => new Response(status === 200 ? RESPONSE_SSE : '{"type":"error"}', {
    status,
    headers: status === 200
      ? { 'content-type': 'text/event-stream', ...headers }
      : { 'content-type': 'application/json', ...headers },
  })) as unknown as FetchFn
  const adapter = new ClaudeAdapter({
    models: [], discovery: false, streamIdleTimeoutMs: 60_000, tokens: tokens(), fetchFn,
  })
  const options = {
    provider: 'claude',
    model: 'claude-opus-5',
    messages: history() as never,
    sessionId: 'sess-capture' as NonNullable<GenerateOptions['sessionId']>,
  }
  // Drain the stream so the adapter reaches its response handling.
  for await (const _chunk of adapter.stream(options) as AsyncIterable<StreamChunk>) continue
}

test('the unified headers of an answered response are captured for its account', async () => {
  forgetUnifiedRateLimit()
  await streamOnce({
    'anthropic-ratelimit-unified-status': 'allowed_warning',
    'anthropic-ratelimit-unified-reset': '1786147200',
    'anthropic-ratelimit-unified-representative-claim': 'seven_day',
    'anthropic-ratelimit-unified-7d-utilization': '0.97',
  })
  const state = unifiedRateLimitFor('claude', 'acct')
  assert.equal(state?.status, 'allowed_warning')
  assert.equal(state?.claim, 'seven_day')
  assert.equal(state?.resetsAt, 1_786_147_200_000)
  assert.deepEqual(state?.windows, [{ window: '7d', utilization: 0.97 }])
})

test('a rejected 429 is captured before the failure is reported', async () => {
  forgetUnifiedRateLimit()
  await assert.rejects(streamOnce({
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-overage-status': 'rejected',
    'anthropic-ratelimit-unified-overage-disabled-reason': 'org_spend_cap_reached',
    'retry-after': '3600',
  }, 429))
  const state = unifiedRateLimitFor('claude', 'acct')
  assert.equal(state?.status, 'rejected')
  assert.equal(state?.overageStatus, 'rejected')
  assert.equal(state?.overageDisabledReason, 'org_spend_cap_reached')
})

test('a response carrying no unified header leaves the account without a report', async () => {
  forgetUnifiedRateLimit()
  await streamOnce({ 'request-id': 'req_1' })
  assert.equal(unifiedRateLimitFor('claude', 'acct'), undefined)
})
