/**
 * A token refresh returns the session the store holds afterwards, never a grant
 * whose conditional write the store refused.
 *
 * Every case drives the shipped `AccountTokenManager` and `ClaudeAdapter` over
 * the shipped `saveAccountSession` compare-and-set in a private temporary store
 * file, so the refusal under test is the real conditional write rather than an
 * in-memory stand-in. Credentials are synthetic labels; no real store,
 * credential file, harness home or provider endpoint is read.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { ClaudeAdapter } from '../src/providers/claude.js'
import {
  deleteAccountSession,
  getAccountSession,
  listAccounts,
  resolveAccountKey,
  saveAccountSession,
} from '../src/auth/store.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { FetchFn } from '../src/providers/common.js'
import { OAuthEndpointError } from '../src/providers/common.js'
import { ownedClaudeContinuation } from './claude-maintenance-fixtures.js'
import { PermittingRecordPort } from './recording-port.js'

/** A synthetic machine fingerprint; never this host's own identifier. */
const FINGERPRINT = 'f'.repeat(64)

/** Temporary store directories, removed when this file finishes. */
const TEMP_DIRS: string[] = []

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

/** A private directory the shipped store functions write `auth.json` inside. */
function storeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-token-commit-'))
  TEMP_DIRS.push(dir)
  return dir
}

const ACCOUNT = 'commit-a@example.invalid'
const OTHER = 'commit-b@example.invalid'
const HOUR = 3_600_000

/** A synthetic session; a negative `expiresInMs` is already expired. */
function session(accessToken: string, expiresInMs = HOUR, overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    accessToken,
    refreshToken: `${accessToken}-rt`,
    expiresAt: Date.now() + expiresInMs,
    scopes: 'user:inference',
    emailAddress: ACCOUNT,
    ...overrides,
  }
}

/** One write the real compare-and-set considered, and whether the store kept it. */
interface ObservedWrite {
  key: string
  landed: boolean
}

interface Harness {
  /** The store file this manager reads and writes. */
  path: string
  writes: ObservedWrite[]
  refreshes: string[]
  removed: string[]
  tokens: AccountTokenManager<ClaudeSession>
}

/**
 * An `AccountTokenManager` over the shipped store. `save` mirrors the durable
 * adapter — the store's boolean is discarded — and records whether the entry
 * held exactly the written session afterwards. `remove` mirrors the durable
 * adapter's conditional removal and records only the removals that deleted;
 * token management never calls it, so those records stay explicit-logout only.
 */
function harness(options: {
  dir: string
  refresh: (account: string, current: ClaudeSession, path: string) => Promise<ClaudeSession>
  preemptMs?: number
  permanent?: boolean
}): Harness {
  const path = join(options.dir, 'auth.json')
  const writes: ObservedWrite[] = []
  const refreshes: string[] = []
  const removed: string[] = []
  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Commit test',
    makeOptions: account => ({
      preemptMs: options.preemptMs ?? 0,
      refresh: async (current) => {
        refreshes.push(account)
        return options.refresh(account, current, path)
      },
      isPermanent: () => options.permanent ?? false,
    }),
    io: {
      list: () => listAccounts('claude', path),
      get: account => getAccountSession('claude', account, path),
      save: async (account, written, expectedPrior) => {
        await saveAccountSession('claude', account, written, path,
          expectedPrior === undefined ? {} : { expectedPrior })
        const after = await getAccountSession('claude', account, path)
        writes.push({
          key: account,
          landed: after !== undefined
            && after.accessToken === written.accessToken
            && after.refreshToken === written.refreshToken,
        })
      },
      remove: async (account, expectedPrior) => {
        const deleted = await deleteAccountSession('claude', account, path,
          expectedPrior === undefined ? {} : { expectedPrior })
        if (deleted) removed.push(account)
        return deleted
      },
      resolve: account => resolveAccountKey('claude', account, path),
    },
  })
  return { path, writes, refreshes, removed, tokens }
}

/** Assert that one settled caller rejected with the given LlmError code. */
function assertRejectedWithCode(result: PromiseSettledResult<ClaudeSession>, code: string): void {
  assert.equal(result.status, 'rejected', `the caller resolved instead of failing with ${code}`)
  if (result.status !== 'rejected') return
  const reason: unknown = result.reason
  if (!(reason instanceof LlmError)) assert.fail(`the failure is not an LlmError: ${code}`)
  assert.equal(reason.code, code)
}

/** Consume a stream so its generator reaches completion or failure. */
async function drain(chunks: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of chunks) void chunk
}

test('a successful refresh returns the session stored after the write', async () => {
  const dir = storeDir()
  const h = harness({
    dir,
    refresh: () => Promise.resolve(session('at-a-new', HOUR, { refreshToken: 'rt-a-new' })),
  })
  await saveAccountSession('claude', ACCOUNT, session('at-a', -1_000), h.path)

  const served = await h.tokens.session(ACCOUNT)

  assert.equal(served.accessToken, 'at-a-new')
  assert.deepEqual(h.refreshes, [ACCOUNT], 'one grant spent the expired stored credential')
  assert.deepEqual(h.writes, [{ key: ACCOUNT, landed: true }], 'the store accepted the refreshed session')
  assert.deepEqual(served, await getAccountSession('claude', ACCOUNT, h.path), 'the served session is the stored one')
})

test('a logout during the refresh grant fails MISSING_CREDENTIAL and revives nothing', async () => {
  const dir = storeDir()
  const h = harness({
    dir,
    refresh: async (account, _current, path) => {
      await deleteAccountSession('claude', account, path)
      return session('at-a-refreshed', HOUR, { refreshToken: 'rt-a-refreshed' })
    },
  })
  await saveAccountSession('claude', ACCOUNT, session('at-a', -1_000), h.path)

  const settled = await Promise.allSettled([h.tokens.session(ACCOUNT), h.tokens.session(ACCOUNT)])

  for (const result of settled) assertRejectedWithCode(result, 'MISSING_CREDENTIAL')
  assert.deepEqual(h.refreshes, [ACCOUNT], 'both waiters shared one grant')
  assert.deepEqual(h.writes, [{ key: ACCOUNT, landed: false }], 'the real compare-and-set refused the write')
  assert.equal(await getAccountSession('claude', ACCOUNT, h.path), undefined, 'the logged-out account is not resurrected')
  assert.deepEqual(h.removed, [], 'an account that is already gone is not removed again')
  await assert.rejects(
    h.tokens.session(ACCOUNT),
    (error: unknown) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL',
  )
})

test('a re-login that wins the compare-and-set is served instead of the refused grant', async () => {
  const dir = storeDir()
  const h = harness({
    dir,
    refresh: async (account, _current, path) => {
      await saveAccountSession('claude', account, session('at-relogin', HOUR, { refreshToken: 'rt-relogin' }), path)
      return session('at-a-refreshed', HOUR, { refreshToken: 'rt-a-refreshed' })
    },
  })
  await saveAccountSession('claude', ACCOUNT, session('at-a', -1_000), h.path)

  const served = await h.tokens.session(ACCOUNT)

  assert.equal(served.accessToken, 'at-relogin', 'the stored winner is served, not the grant the store refused')
  assert.deepEqual(h.writes, [{ key: ACCOUNT, landed: false }])
  assert.deepEqual(served, await getAccountSession('claude', ACCOUNT, h.path))
})

test('waiters coalesce per account and each account serves its own stored session', async () => {
  const dir = storeDir()
  const label = (account: string): string => account === ACCOUNT ? 'a' : 'b'
  const h = harness({
    dir,
    refresh: async account => session(`at-${label(account)}-new`, HOUR, { refreshToken: `rt-${label(account)}-new` }),
  })
  await saveAccountSession('claude', ACCOUNT, session('at-a', -1_000), h.path)
  await saveAccountSession('claude', OTHER, session('at-b', -1_000, { emailAddress: OTHER }), h.path)

  const served = await Promise.all([
    h.tokens.session(ACCOUNT),
    h.tokens.session(ACCOUNT),
    h.tokens.session(OTHER),
  ])

  assert.deepEqual(served.map(one => one.accessToken), ['at-a-new', 'at-a-new', 'at-b-new'])
  assert.deepEqual([...h.refreshes].sort(), [ACCOUNT, OTHER], 'one grant per account, not one per caller')
  // The two accounts refresh concurrently, so their writes settle in either order.
  assert.deepEqual(
    [...h.writes].sort((left, right) => left.key.localeCompare(right.key)),
    [{ key: ACCOUNT, landed: true }, { key: OTHER, landed: true }],
  )
  assert.deepEqual(served[0], await getAccountSession('claude', ACCOUNT, h.path))
  assert.deepEqual(served[2], await getAccountSession('claude', OTHER, h.path))
})

test('a transient refresh failure still falls back to a still-valid stored token', async () => {
  const dir = storeDir()
  const h = harness({
    dir,
    preemptMs: 60_000,
    refresh: () => Promise.reject(new Error('network down')),
  })
  await saveAccountSession('claude', ACCOUNT, session('at-a', 30_000), h.path)

  const served = await h.tokens.session(ACCOUNT)

  assert.equal(served.accessToken, 'at-a', 'the still-valid credential serves the turn')
  assert.deepEqual(h.writes, [], 'nothing was written for a grant that never arrived')
  assert.deepEqual(h.removed, [])
})

test('a failed refresh reports only safe status and error-code facts', async () => {
  const cases = [
    {
      name: 'OAuth error with retry-after',
      error: new OAuthEndpointError('claude token endpoint error (HTTP 401): raw-secret-body', 401, 'invalid_client', 30_000),
      expected: 'HTTP 401 invalid_client, retry-after 30s',
    },
    {
      name: 'OAuth error without an error code',
      error: new OAuthEndpointError('claude token endpoint error (HTTP 500): raw-secret-body', 500),
      expected: 'HTTP 500',
    },
    {
      name: 'transport error with a platform code',
      error: Object.assign(new Error('network down: raw-secret-body'), { code: 'ECONNRESET' }),
      expected: 'Error (ECONNRESET)',
    },
    {
      name: 'generic error',
      error: new Error('raw-secret-body'),
      expected: 'Error',
    },
    {
      name: 'non-error rejection',
      error: 'raw-secret-body',
      expected: 'unknown failure',
    },
  ] as const

  for (const entry of cases) {
    const dir = storeDir()
    const h = harness({
      dir,
      refresh: () => Promise.reject(entry.error),
    })
    await saveAccountSession('claude', ACCOUNT, session('at-a', -1_000), h.path)

    await assert.rejects(h.tokens.session(ACCOUNT), (error: unknown) => {
      assert.ok(error instanceof LlmError, entry.name)
      assert.equal(error.code, 'AUTH', entry.name)
      assert.match(error.message, new RegExp(entry.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), entry.name)
      assert.doesNotMatch(error.message, /raw-secret-body|at-a/, `${entry.name} omits provider text and credentials`)
      return true
    })
  }
})

test('a permanent refresh refusal reports safe facts', async () => {
  const dir = storeDir()
  const h = harness({
    dir,
    permanent: true,
    refresh: () => Promise.reject(new OAuthEndpointError('raw-secret-body', 400, 'invalid_grant')),
  })
  const stored = session('at-a', -1_000)
  await saveAccountSession('claude', ACCOUNT, stored, h.path)

  await assert.rejects(h.tokens.session(ACCOUNT), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'INVALID_CREDENTIAL')
    assert.match(error.message, /HTTP 400 invalid_grant/)
    assert.doesNotMatch(error.message, /raw-secret-body|at-a/)
    return true
  })
  assert.deepEqual(await getAccountSession('claude', ACCOUNT, h.path), stored,
    'the refused credential is still stored, unchanged, for an explicit logout')
})

test('a logout during the refresh grant fails the Claude request before any Messages call', async (t) => {
  const dir = storeDir()
  const fetched: string[] = []
  const fetchFn = (async (url: unknown) => {
    fetched.push(String(url))
    return new Response('data: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }) as FetchFn
  const h = harness({
    dir,
    refresh: async (account, _current, path) => {
      await deleteAccountSession('claude', account, path)
      return session('at-a-refreshed', HOUR, { refreshToken: 'rt-a-refreshed' })
    },
  })
  await saveAccountSession('claude', ACCOUNT, session('at-a', -1_000, {
    deviceId: 'a'.repeat(64),
    accountUuid: '00000000-0000-4000-8000-00000000000a',
  }), h.path)
  const adapter = new ClaudeAdapter({
    models: [],
    discovery: false,
    streamIdleTimeoutMs: 60_000,
    tokens: h.tokens,
    fetchFn,
    deviceFingerprint: () => FINGERPRINT,
    continuation: await ownedClaudeContinuation(t, [ACCOUNT]),
    requestRecord: new PermittingRecordPort(),
  })
  const request: GenerateOptions = {
    provider: 'claude',
    model: 'claude-opus-4-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    sessionId: 'sess-token-commit' as NonNullable<GenerateOptions['sessionId']>,
  }

  await assert.rejects(
    drain(adapter.streamAccount(request, ACCOUNT)),
    (error: unknown) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL',
  )
  assert.deepEqual(fetched, [], 'a logged-out credential starts no provider request')
})

test('a login that lands during a permanent failure is retained and served', async () => {
  const dir = storeDir()
  const h = harness({
    dir,
    permanent: true,
    // The login lands while the failing refresh is still spending the old grant, so the
    // permanent branch must serve the stored winner instead of reporting the dead credential.
    refresh: async (account, _current, path) => {
      await saveAccountSession('claude', account, session('at-relogin', HOUR, { refreshToken: 'rt-relogin' }), path)
      throw new Error('invalid_grant')
    },
  })
  await saveAccountSession('claude', ACCOUNT, session('at-a', -1_000, { refreshToken: 'rt-a' }), h.path)

  const served = await h.tokens.session(ACCOUNT)

  assert.equal(served.accessToken, 'at-relogin', 'the credential a login stored during the failure is served')
  assert.deepEqual(served, await getAccountSession('claude', ACCOUNT, h.path), 'and it is still the stored session')
  assert.deepEqual(h.removed, [], 'nothing was deleted')
})

test('the conditional removal deletes only the session it was given', async () => {
  const dir = storeDir()
  const path = join(dir, 'auth.json')
  const prior = session('at-a', -1_000, { refreshToken: 'rt-a' })
  const winner = session('at-relogin', HOUR, { refreshToken: 'rt-relogin' })
  await saveAccountSession('claude', ACCOUNT, prior, path)
  await saveAccountSession('claude', ACCOUNT, winner, path)

  assert.equal(
    await deleteAccountSession('claude', ACCOUNT, path, { expectedPrior: prior }),
    false,
    'a session another writer replaced is not deleted',
  )
  assert.deepEqual(await getAccountSession('claude', ACCOUNT, path), winner, 'the winner survives')
  assert.equal(
    await deleteAccountSession('claude', ACCOUNT, path, { expectedPrior: winner }),
    true,
    'the session the caller holds is deleted',
  )
  assert.equal(await getAccountSession('claude', ACCOUNT, path), undefined)
  assert.equal(await deleteAccountSession('claude', ACCOUNT, path), false, 'an absent account reports no deletion')
})

test('concurrent permanent failures keep the credential and report INVALID_CREDENTIAL', async () => {
  const dir = storeDir()
  const h = harness({
    dir,
    permanent: true,
    refresh: () => Promise.reject(new Error('invalid_grant')),
  })
  const stored = session('at-a', -1_000, { refreshToken: 'rt-a' })
  await saveAccountSession('claude', ACCOUNT, stored, h.path)

  const settled = await Promise.allSettled([h.tokens.session(ACCOUNT), h.tokens.session(ACCOUNT)])

  for (const result of settled) assertRejectedWithCode(result, 'INVALID_CREDENTIAL')
  assert.deepEqual(h.refreshes, [ACCOUNT], 'both waiters shared one grant')
  assert.deepEqual(h.removed, [], 'no waiter deletes the credential')
  assert.deepEqual(await getAccountSession('claude', ACCOUNT, h.path), stored,
    'the stored credential survives the refused grant')
})
