import assert from 'node:assert/strict'
import test from 'node:test'

import { carryClaudeIdentity, fetchClaudeUsage } from '../src/providers/claude.js'
import type { FetchFn } from '../src/providers/common.js'
import type { ClaudeSession } from '../src/auth/store.js'

function session(accessToken: string): ClaudeSession {
  return {
    accessToken,
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    accountUuid: 'uuid-1',
    deviceId: 'dev-1',
  }
}

/** A fetch that answers with the given statuses in order and records each bearer seen. */
function scriptedFetch(statuses: readonly number[]): { fetch: FetchFn; tokens: string[] } {
  const tokens: string[] = []
  let call = 0
  const fetchFn = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    tokens.push(String(init?.headers?.['authorization'] ?? ''))
    const status = statuses[Math.min(call, statuses.length - 1)]
    call += 1
    return new Response(
      status === 200 ? JSON.stringify({ limits: [{ kind: 'session', percent: 12 }] }) : '{}',
      { status, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as FetchFn
  return { fetch: fetchFn, tokens }
}

test('usage replays once with a refreshed token after a rejection', async () => {
  const { fetch, tokens } = scriptedFetch([401, 200])
  let refreshes = 0
  const usage = await fetchClaudeUsage(session('expired-token'), fetch, undefined, async () => {
    refreshes += 1
    return 'fresh-token'
  })

  assert.equal(refreshes, 1, 'the token is refreshed exactly once')
  assert.deepEqual(tokens, ['Bearer expired-token', 'Bearer fresh-token'])
  assert.equal(usage.supported, true)
})

test('a rejection that survives the replay surfaces instead of retrying forever', async () => {
  const { fetch, tokens } = scriptedFetch([401, 401])
  let refreshes = 0
  await assert.rejects(
    fetchClaudeUsage(session('expired-token'), fetch, undefined, async () => {
      refreshes += 1
      return 'still-rejected'
    }),
  )
  assert.equal(refreshes, 1, 'no second refresh')
  assert.equal(tokens.length, 2, 'no third attempt')
})

test('without a refresh callback the first rejection is reported unchanged', async () => {
  const { fetch, tokens } = scriptedFetch([401, 200])
  await assert.rejects(fetchClaudeUsage(session('expired-token'), fetch))
  assert.deepEqual(tokens, ['Bearer expired-token'])
})

test('re-authorizing an account keeps the device it already presented', () => {
  const stored = { ...session('fresh-token'), deviceId: 'a'.repeat(64), accountUuid: 'uuid-old' }
  const authorized: ClaudeSession = {
    accessToken: 'new-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    deviceId: 'b'.repeat(64),
  }
  const kept = carryClaudeIdentity(authorized, stored)
  assert.equal(kept.deviceId, 'a'.repeat(64), 'the device id must not change')
  assert.equal(kept.accountUuid, 'uuid-old', 'a failed profile lookup keeps the correlation')
  assert.equal(kept.accessToken, 'new-token', 'the new tokens are the ones stored')
})

test('a first authorization keeps the identity it minted', () => {
  const authorized = { ...session('first-token'), deviceId: 'c'.repeat(64) }
  assert.equal(carryClaudeIdentity(authorized, undefined).deviceId, 'c'.repeat(64))
})
