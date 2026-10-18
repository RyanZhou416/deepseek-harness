/**
 * Table-driven coverage of the subscription error taxonomy and the gate effect
 * every class resolves to.
 *
 * The producers are exercised, not restated: `httpLlmError` and
 * `claudeHttpLlmError` classify synthetic responses, `mapFetchFailure`
 * classifies transport outcomes, and `anthropicErrorEventRule` classifies an
 * in-band `error` event's `error.type`. Each produced error is then fed to the
 * pool's classifier, so a producer that changes its code without its scheduling
 * effect fails here.
 *
 * No endpoint, credential store or network is touched.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ProviderId } from '../src/auth/store.js'
import {
  CONFLICT_CODE,
  ENFORCEMENT_CODE,
  MODEL_DENIED_CODE,
  httpLlmError,
  idleWatchdog,
  mapFetchFailure,
} from '../src/providers/common.js'
import { CLAUDE_PROTOCOL_PROFILE } from '../src/providers/claude-protocol.js'
import { claudeHttpLlmError } from '../src/providers/claude-failure.js'
import { classifyPoolFailure } from '../src/providers/pool-health.js'
import type { PoolFailureAction } from '../src/providers/pool-health.js'
import { anthropicErrorEventRule } from '../src/claude-engine/failure-rules.js'

/** One produced failure and the effect it must map to. */
interface Case {
  readonly name: string
  readonly code: string
  readonly action: PoolFailureAction['action']
}

/** Assert one produced error's code and scheduling effect. */
function expect(error: LlmError, testCase: Case): void {
  assert.equal(error.code, testCase.code, `${testCase.name}: code`)
  assert.equal(classifyPoolFailure(error, 'claude').action, testCase.action, `${testCase.name}: effect`)
}

/** A JSON body whose provider error object carries one message and type. */
function errorBody(message: string, type = 'invalid_request_error'): string {
  return JSON.stringify({ type: 'error', error: { type, message } })
}

/** One synthetic HTTP response classified by the shared (non-Claude) route. */
async function sharedResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<LlmError> {
  return await httpLlmError(new Response(body, { status, headers }), 'codex API')
}

test('HTTP statuses produce the taxonomy classes and their gate effects', async () => {
  const cases: readonly (Case & { status: number; body?: string; headers?: Record<string, string> })[] = [
    { name: '408 request timeout', status: 408, code: 'TIMEOUT', action: 'session-backoff' },
    { name: '409 conflict', status: 409, code: CONFLICT_CODE, action: 'session-backoff' },
    { name: 'ordinary 429', status: 429, body: errorBody('slow down', 'rate_limit_error'),
      headers: { 'retry-after': '30' }, code: 'RATE_LIMIT', action: 'session-backoff' },
    { name: '429 window rejected', status: 429, body: errorBody('usage limit reached', 'rate_limit_error'),
      headers: { 'x-should-retry': 'false', 'retry-after': '600' }, code: ENFORCEMENT_CODE, action: 'account-cooldown' },
    { name: '429 retry allowed', status: 429, headers: { 'x-should-retry': 'true', 'retry-after': '30' },
      code: 'RATE_LIMIT', action: 'session-backoff' },
    { name: '500', status: 500, code: 'SERVER', action: 'session-backoff' },
    { name: '502', status: 502, code: 'SERVER', action: 'session-backoff' },
    { name: '503', status: 503, code: 'SERVER', action: 'session-backoff' },
    { name: '504', status: 504, code: 'TIMEOUT', action: 'session-backoff' },
    { name: '529 overloaded', status: 529, code: 'SERVER', action: 'session-backoff' },
    { name: '500 stated final', status: 500, headers: { 'x-should-retry': 'false' },
      code: ENFORCEMENT_CODE, action: 'throw' },
    { name: '400 invalid request', status: 400, body: errorBody('bad parameter'),
      code: 'HTTP_400', action: 'throw' },
    { name: '400 context overflow', status: 400, body: errorBody('context length exceeded: 300000 tokens > 200000'),
      code: 'CONTEXT_WINDOW_EXCEEDED', action: 'throw' },
    { name: '413 too large', status: 413, code: 'HTTP_413', action: 'throw' },
    { name: '401 expired', status: 401, body: '{"error":"expired"}', code: 'AUTH', action: 'refresh' },
    { name: '403 revoked', status: 403, body: errorBody('the account has been revoked', 'permission_error'),
      code: 'AUTH', action: 'refresh' },
    { name: '403 plain permission', status: 403, body: errorBody('denied', 'permission_error'),
      code: 'AUTH', action: 'refresh' },
    { name: '403 stated final', status: 403, body: errorBody('denied', 'permission_error'),
      headers: { 'x-should-retry': 'false' }, code: ENFORCEMENT_CODE, action: 'account-cooldown' },
    { name: '403 out of credits', status: 403, body: '{"error":{"message":"out_of_credits"}}',
      code: ENFORCEMENT_CODE, action: 'account-cooldown' },
    { name: '403 model permission', status: 403,
      body: errorBody('you do not have access to the model gpt-5.4', 'permission_error'),
      code: MODEL_DENIED_CODE, action: 'model-scoped' },
    { name: '404 model not found', status: 404,
      body: errorBody('the model gpt-5.4 does not exist', 'not_found_error'),
      code: MODEL_DENIED_CODE, action: 'model-scoped' },
    { name: '404 unnamed', status: 404, code: 'HTTP_404', action: 'model-scoped' },
    { name: '402 payment', status: 402, code: 'HTTP_402', action: 'account-cooldown' },
  ]
  for (const testCase of cases) {
    const error = await sharedResponse(testCase.status, testCase.body ?? '', testCase.headers)
    expect(error, testCase)
  }
})

test('the Claude route produces the same classes from its own envelope rules', async () => {
  const cases: readonly (Case & { status: number; body?: string; headers?: Record<string, string> })[] = [
    { name: 'claude 400 invalid request', status: 400, body: errorBody('temperature must be <= 1'),
      code: 'INVALID_REQUEST', action: 'throw' },
    { name: 'claude 400 context overflow', status: 400, body: errorBody('prompt is too long: 300000 tokens'),
      code: 'CONTEXT_WINDOW_EXCEEDED', action: 'throw' },
    { name: 'claude 404 not_found', status: 404, body: errorBody('the request cannot be served', 'not_found_error'),
      code: 'INVALID_REQUEST', action: 'throw' },
    { name: 'claude 404 model', status: 404,
      body: errorBody('the model claude-x does not exist for this account', 'not_found_error'),
      code: MODEL_DENIED_CODE, action: 'model-scoped' },
    { name: 'claude 403 permission', status: 403, body: errorBody('denied', 'permission_error'),
      code: 'PERMISSION_DENIED', action: 'throw' },
    { name: 'claude 403 model', status: 403,
      body: errorBody('you do not have access to the model claude-x', 'permission_error'),
      code: MODEL_DENIED_CODE, action: 'model-scoped' },
    { name: 'claude 403 revoked', status: 403,
      body: errorBody('the oauth token has been revoked', 'permission_error'),
      code: 'AUTH', action: 'refresh' },
    { name: 'claude 401', status: 401, body: '{"error":"expired"}', code: 'AUTH', action: 'refresh' },
    { name: 'claude 409 conflict', status: 409, code: CONFLICT_CODE, action: 'session-backoff' },
    { name: 'claude 429 rejected', status: 429, body: errorBody('usage limit reached', 'rate_limit_error'),
      headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': '600' },
      code: ENFORCEMENT_CODE, action: 'account-cooldown' },
    { name: 'claude 429 ordinary', status: 429, body: errorBody('slow down', 'rate_limit_error'),
      headers: { 'retry-after': '30' }, code: 'RATE_LIMIT', action: 'session-backoff' },
    { name: 'claude 529', status: 529, code: 'SERVER', action: 'session-backoff' },
    { name: 'claude 500 stated final', status: 500, headers: { 'x-should-retry': 'false' },
      code: ENFORCEMENT_CODE, action: 'throw' },
    { name: 'claude 403 stated final', status: 403,
      body: errorBody('access denied', 'permission_error'),
      headers: { 'x-should-retry': 'false' }, code: ENFORCEMENT_CODE, action: 'account-cooldown' },
    { name: 'claude version refusal', status: 400,
      body: JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'update required', details: { error_code: 'claude_code_version_too_old' } },
      }),
      code: 'CLIENT_VERSION_UNSUPPORTED', action: 'throw' },
  ]
  for (const testCase of cases) {
    const error = await claudeHttpLlmError(new Response(testCase.body ?? '', {
      status: testCase.status,
      ...testCase.headers === undefined ? {} : { headers: testCase.headers },
    }), { label: 'claude API', profile: CLAUDE_PROTOCOL_PROFILE })
    expect(error, testCase)
  }
})

test('in-band error types produce the same classes without switching accounts', () => {
  const cases: readonly (Case & { type: string; message: string })[] = [
    { name: 'authentication_error', type: 'authentication_error', message: 'bad token', code: 'AUTH', action: 'refresh' },
    { name: 'permission_error', type: 'permission_error', message: 'denied', code: 'PERMISSION_DENIED', action: 'throw' },
    { name: 'policy_blocked', type: 'policy_blocked', message: 'blocked', code: 'PERMISSION_DENIED', action: 'throw' },
    { name: 'not_found_error', type: 'not_found_error', message: 'the request cannot be served', code: 'INVALID_REQUEST', action: 'throw' },
    { name: 'invalid_request_error', type: 'invalid_request_error', message: 'bad parameter', code: 'INVALID_REQUEST', action: 'throw' },
    { name: 'rate_limit_error', type: 'rate_limit_error', message: 'slow down', code: 'RATE_LIMIT', action: 'session-backoff' },
    { name: 'overloaded_error', type: 'overloaded_error', message: 'busy', code: 'SERVER', action: 'session-backoff' },
    { name: 'api_error', type: 'api_error', message: 'busy', code: 'SERVER', action: 'session-backoff' },
    { name: 'timeout_error', type: 'timeout_error', message: 'slow', code: 'TIMEOUT', action: 'session-backoff' },
    { name: 'content blocked', type: 'policy_blocked', message: 'content filter', code: 'PERMISSION_DENIED', action: 'throw' },
  ]
  for (const testCase of cases) {
    const rule = anthropicErrorEventRule(testCase.type, testCase.message)
    assert.ok(rule !== undefined, `${testCase.name}: the vocabulary maps this type`)
    const error = new LlmError(testCase.message, rule.code, {
      ...rule.retryDisposition === 'forbid' ? { retryDisposition: 'forbid' as const } : {},
    })
    expect(error, testCase)
  }
  // An in-band type this route does not map is terminal, never transient.
  assert.equal(anthropicErrorEventRule('not_a_real_type', 'x'), undefined)
  expect(new LlmError('unmapped', 'UNCLASSIFIED_PROVIDER_ERROR', { retryDisposition: 'forbid' }),
    { name: 'unmapped in-band type', code: 'UNCLASSIFIED_PROVIDER_ERROR', action: 'throw' })
})

test('network, TLS, timeout and abort failures map to their classes', async () => {
  const transport = mapFetchFailure('codex API', new Error('tls handshake failed'),
    idleWatchdog(undefined, 10_000), undefined)
  expect(transport, { name: 'TLS/network', code: 'TRANSPORT', action: 'session-backoff' })

  const timeoutWatchdog = idleWatchdog(undefined, 1)
  await new Promise(resolve => setTimeout(resolve, 10))
  const timedOut = mapFetchFailure('codex API', new Error('idle'), timeoutWatchdog, undefined)
  timeoutWatchdog.stop()
  expect(timedOut, { name: 'timeout', code: 'TIMEOUT', action: 'session-backoff' })

  const controller = new AbortController()
  const abortedWatchdog = idleWatchdog(controller.signal, 10_000)
  controller.abort(new Error('user stopped the turn'))
  const aborted = mapFetchFailure('codex API', new Error('stopped'), abortedWatchdog, controller.signal)
  abortedWatchdog.stop()
  expect(aborted, { name: 'user abort', code: 'ABORTED', action: 'throw' })
})

test('a malformed stream after delivery is terminal, before delivery it is retryable', () => {
  expect(new LlmError('malformed after output', 'MALFORMED_RESPONSE', { retryDisposition: 'forbid' }),
    { name: 'malformed after delivery', code: 'MALFORMED_RESPONSE', action: 'throw' })
  expect(new LlmError('malformed before output', 'MALFORMED_RESPONSE'),
    { name: 'malformed before delivery', code: 'MALFORMED_RESPONSE', action: 'session-backoff' })
  expect(new LlmError('incomplete stream', 'STREAM_INCOMPLETE', { retryDisposition: 'forbid' }),
    { name: 'incomplete stream after delivery', code: 'STREAM_INCOMPLETE', action: 'throw' })
})

test('no taxonomy class can switch accounts: every effect is one of the account-preserving ones', () => {
  const allowed = new Set(['session-backoff', 'account-cooldown', 'refresh', 'model-scoped', 'member-ineligible', 'throw'])
  const samples: LlmError[] = [
    new LlmError('rate', 'RATE_LIMIT'),
    new LlmError('quota', 'QUOTA'),
    new LlmError('auth', 'AUTH', { status: 401 }),
    new LlmError('model', MODEL_DENIED_CODE),
    new LlmError('conflict', CONFLICT_CODE),
    new LlmError('refused', ENFORCEMENT_CODE, { status: 500, retryDisposition: 'forbid' }),
    new LlmError('fault', 'INVALID_REQUEST', { retryDisposition: 'forbid' }),
    new LlmError('plain', 'HTTP_400'),
  ]
  for (const error of samples) {
    const effect = classifyPoolFailure(error, 'claude' as ProviderId).action
    assert.ok(allowed.has(effect), `${error.code}: unexpected effect ${effect}`)
  }
})
