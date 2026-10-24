/**
 * The token endpoint's own deadline: one bounded POST, no replay, and a timeout that leaves the
 * stored credential alone. Every fetch is synthetic and the deadline is driven by the test clock.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { CLAUDE_TOKEN_URL, exchangeClaudeCode, isClaudePermanentRefreshError, refreshClaude } from '../src/providers/claude.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { FetchFn } from '../src/providers/common.js'

/** A synthetic session, mid-life so nothing refreshes on its own. */
function session(): ClaudeSession {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference user:profile',
  }
}

/**
 * A fetch that answers only when its signal aborts.
 * @param seen - collects each request's signal and body.
 * @returns the injectable fetch.
 */
function pendingFetch(seen: { signals: AbortSignal[]; bodies: string[] }): FetchFn {
  return async (_url, init) => {
    const signal = init?.signal
    assert.ok(signal instanceof AbortSignal, 'the token POST carries a cancellation signal')
    seen.signals.push(signal)
    seen.bodies.push(String(init?.body ?? ''))
    return await new Promise<Response>((_resolve, reject) => {
      // The deadline may already have fired before this fetch was reached; never wait for an
      // event that has been missed.
      if (signal.aborted) {
        reject(signal.reason ?? new Error('aborted'))
        return
      }
      signal.addEventListener('abort', () => {
        reject(signal.reason ?? new Error('aborted'))
      }, { once: true })
    })
  }
}

test('a refresh response without a scope keeps the granted scopes', async () => {
  const fetchFn: FetchFn = async () => new Response(JSON.stringify({
    access_token: 'at-2',
    refresh_token: 'rt-2',
    expires_in: 3_600,
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  const next = await refreshClaude(session(), { fetchFn })

  assert.equal(next.accessToken, 'at-2')
  assert.equal(next.refreshToken, 'rt-2')
  assert.equal(next.scopes, 'user:inference user:profile',
    'an omitted scope field does not replace the scopes the account was granted')
})

test('a refresh response with an empty scope keeps the granted scopes', async () => {
  const fetchFn: FetchFn = async () => new Response(JSON.stringify({
    access_token: 'at-2',
    refresh_token: 'rt-2',
    expires_in: 3_600,
    scope: '   ',
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  const next = await refreshClaude(session(), { fetchFn })

  assert.equal(next.scopes, 'user:inference user:profile',
    'a blank scope field does not erase the scopes the account was granted')
})

test('a refresh response that states a scope stores the stated one', async () => {
  const fetchFn: FetchFn = async () => new Response(JSON.stringify({
    access_token: 'at-2',
    refresh_token: 'rt-2',
    expires_in: 3_600,
    scope: 'user:inference',
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  const next = await refreshClaude(session(), { fetchFn })

  assert.equal(next.scopes, 'user:inference', 'a response that states the grant is authoritative')
})

test('a refresh POST is bounded at the client deadline and is never replayed', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const seen = { signals: [] as AbortSignal[], bodies: [] as string[] }
  try {
    const pending = refreshClaude(session(), { fetchFn: pendingFetch(seen) })
    // The POST is in flight before the deadline fires: this is the case the bound exists for.
    await Promise.resolve()
    context.mock.timers.tick(30_000)
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'TIMEOUT')
      assert.match(error.message, /deadline/)
      assert.equal(isClaudePermanentRefreshError(error), false,
        'a timeout says nothing about the credential, so it is not a permanent failure')
      return true
    })
    assert.equal(seen.signals.length, 1, 'the deadline does not cause a second POST')
    assert.equal(seen.signals[0]?.aborted, true, 'the in-flight request was cancelled')
    // The grant itself is unchanged: the refresh token, client id and echoed scopes as before.
    const grant = JSON.parse(seen.bodies[0] ?? '{}') as Record<string, unknown>
    assert.equal(grant.grant_type, 'refresh_token')
    assert.equal(grant.refresh_token, 'rt-1')
    assert.equal(grant.scope, 'user:inference user:profile')
  } finally {
    context.mock.timers.reset()
  }
})

test('the token endpoint is the client endpoint and the bound is injectable for a fast case', async () => {
  const seen = { signals: [] as AbortSignal[], bodies: [] as string[] }
  let url = ''
  const fetchFn: FetchFn = async (target, init) => {
    url = String(target)
    return await pendingFetch(seen)(target, init)
  }
  await assert.rejects(refreshClaude(session(), { fetchFn, timeoutMs: 5 }), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'TIMEOUT')
    return true
  })
  assert.equal(url, CLAUDE_TOKEN_URL, 'the grant still goes to the pinned token endpoint')
  assert.equal(seen.signals.length, 1)
})

test('a timeout leaves the credential usable rather than reporting it revoked', async () => {
  const seen = { signals: [] as AbortSignal[], bodies: [] as string[] }
  const timeoutError = await refreshClaude(session(), { fetchFn: pendingFetch(seen), timeoutMs: 5 })
    .then(() => undefined, (error: unknown) => error)
  assert.ok(timeoutError instanceof LlmError)
  // The refresh rejection a timeout produces is not one of the permanent cases, so the stored
  // credential is kept and the account is not signed out.
  assert.equal(isClaudePermanentRefreshError(timeoutError), false)
  assert.equal(seen.bodies.length, 1, 'no automatic replay of a grant that may already be spent')
})

test('a token POST whose body never finishes is bounded by the same deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const seen = { signals: [] as AbortSignal[], bodies: [] as string[] }
  const fetchFn: FetchFn = async (_url, init) => {
    const signal = init?.signal
    assert.ok(signal instanceof AbortSignal)
    seen.signals.push(signal)
    seen.bodies.push(String(init?.body ?? ''))
    // Headers arrive at once; the body never does. The bound must cover the body too, or the
    // caller's own read of this response would hang after the helper had already returned.
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener('abort', () => {
          controller.error(signal.reason ?? new Error('aborted'))
        }, { once: true })
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const pending = refreshClaude(session(), { fetchFn })
    await Promise.resolve()
    context.mock.timers.tick(30_000)
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'TIMEOUT')
      // The failure states our own deadline; no part of the token response rides the cause.
      assert.equal(
        error.cause instanceof Error ? error.cause.message : '',
        'claude token request timed out after 30000ms',
      )
      assert.equal(isClaudePermanentRefreshError(error), false, 'a stalled body is not a revoked login')
      return true
    })
    assert.equal(seen.signals.length, 1, 'a stalled body causes no second POST')
    assert.equal(seen.signals[0]?.aborted, true)
  } finally {
    context.mock.timers.reset()
  }
})

test('an injected bound must be positive and finite, and a rejected bound sends nothing', async () => {
  const seen = { signals: [] as AbortSignal[], bodies: [] as string[] }
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      refreshClaude(session(), { fetchFn: pendingFetch(seen), timeoutMs }),
      /timeoutMs must be a positive finite number/,
      String(timeoutMs),
    )
  }
  assert.deepEqual(seen.signals, [], 'a misconfigured bound never reaches the wire')
})

test('the authorization-code exchange shares the same bounded POST', async () => {
  const seen = { signals: [] as AbortSignal[], bodies: [] as string[] }
  const pending = exchangeClaudeCode('code-1', 'verifier-1', 'https://localhost/callback', 'state-1', {
    fetchFn: pendingFetch(seen),
    timeoutMs: 5,
  })
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'TIMEOUT')
    return true
  })
  assert.equal(seen.signals.length, 1, 'one exchange, one POST')
  const grant = JSON.parse(seen.bodies[0] ?? '{}') as Record<string, unknown>
  assert.equal(grant.grant_type, 'authorization_code')
  assert.equal(grant.code, 'code-1')
  assert.equal(grant.code_verifier, 'verifier-1')
  assert.equal(grant.state, 'state-1')
})
