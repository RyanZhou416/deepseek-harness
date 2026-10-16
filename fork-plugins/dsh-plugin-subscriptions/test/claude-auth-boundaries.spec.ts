/**
 * Claude auth boundaries: which credential ends up stored when two writers race, what the
 * refresh sync writes back to Claude Code's own blob, and what the identity profile read does
 * when it is refused or yields nothing.
 *
 * Every case drives the plugin's own adapter, account manager and credential-sync functions
 * with an injected fetch and synthetic tokens in a private temporary `CLAUDE_CONFIG_DIR`.
 * No real credential store, harness home or server endpoint is read. Environment overrides
 * are scoped to one test and restored in `finally`; the Files API id table is keyed by a
 * per-test account and cleared when the test ends.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import type { TestContext } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import './keep-alive.js'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { ClaudeAdapter, deriveClaudeDeviceId } from '../src/providers/claude.js'
import { classifyPoolFailure } from '../src/providers/pool-health.js'
import { DEFAULT_RETRY, subscriptionRetryPolicy } from '../src/providers/rate-limit.js'
import { readClaudeCodeCredentials, refreshClaudeSynced } from '../src/auth/claude-code-creds.js'
import type { FetchFn } from '../src/providers/common.js'
import type { ClaudeSession } from '../src/auth/store.js'
import { ownedClaudeContinuation } from './claude-maintenance-fixtures.js'
import { PermittingRecordPort } from './recording-port.js'

const TEMP_DIRS: string[] = []

/** A synthetic machine fingerprint; never this host's own identifier. */
const FINGERPRINT = 'a1'.repeat(32)

/** A temp directory removed when the file finishes. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.push(dir)
  return dir
}

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

/** Restore an environment variable, keeping "unset" distinct from "empty". */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** Run with `CLAUDE_CONFIG_DIR` pointing at one private credentials directory. */
async function withConfigDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  try {
    return await run()
  } finally {
    restoreEnv('CLAUDE_CONFIG_DIR', saved)
  }
}

/**
 * Whether this machine answers credential reads from the macOS Keychain. When it does, a
 * synthetic credentials file cannot be observed at all, so the file-backed cases are skipped
 * with that reason instead of reporting a pass they did not earn.
 */
const keychainAnswers = ((): boolean => {
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tempDir('claude-auth-probe-')
  try {
    return readClaudeCodeCredentials() !== undefined
  } finally {
    restoreEnv('CLAUDE_CONFIG_DIR', saved)
  }
})()

const needsFileStore: { skip?: string } = keychainAnswers
  ? { skip: 'a Claude Code Keychain entry shadows the credentials file on this machine' }
  : {}

/** One credentials-directory path with a single synthetic blob written into it. */
function credentialsDir(prefix: string, blob: string): { dir: string; file: string } {
  const dir = tempDir(prefix)
  const file = join(dir, '.credentials.json')
  writeFileSync(file, blob, { mode: 0o600 })
  return { dir, file }
}

/** A synthetic Claude Code blob in the wrapper shape the real file uses. */
function blob(session: Partial<ClaudeSession> & { accessToken: string; refreshToken: string; expiresAt: number }): string {
  return JSON.stringify({ claudeOauthAccount: { emailAddress: 'synthetic@example.test' }, claudeAiOauth: { ...session } })
}

// ---------------------------------------------------------------------------
// Two writers, one credential
// ---------------------------------------------------------------------------

interface BoundarySession {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/**
 * An account store whose first read answers the stale credential this manager loaded and
 * whose later reads answer the credential another process rotated in the meantime.
 */
function splitReadStore(): {
  tokens: AccountTokenManager<BoundarySession>
  refreshed: string[]
  saved: BoundarySession[]
} {
  const stale: BoundarySession = { accessToken: 'at-ours', refreshToken: 'rt-ours', expiresAt: Date.now() - 1_000 }
  const rotatedElsewhere: BoundarySession = {
    accessToken: 'at-other',
    refreshToken: 'rt-other',
    expiresAt: Date.now() + 3_600_000,
  }
  const refreshed: string[] = []
  const saved: BoundarySession[] = []
  let reads = 0
  const tokens = new AccountTokenManager<BoundarySession>({
    provider: 'claude',
    displayName: 'Boundary',
    makeOptions: () => ({
      preemptMs: 60_000,
      refresh: async (current) => {
        refreshed.push(current.accessToken)
        return { ...current, accessToken: 'at-second-rotation', expiresAt: Date.now() + 3_600_000 }
      },
      isPermanent: () => false,
    }),
    io: {
      list: async () => [{ key: 'acct', session: stale }],
      get: async () => {
        reads += 1
        return reads === 1 ? stale : rotatedElsewhere
      },
      save: async (_account, session) => { saved.push(session) },
      remove: async () => {},
    },
  })
  return { tokens, refreshed, saved }
}

test('a credential another writer already rotated is served instead of rotated a second time', async () => {
  const { tokens, refreshed, saved } = splitReadStore()
  const served = await tokens.session('acct')

  assert.equal(served.accessToken, 'at-other', 'the credential the store now holds is served')
  assert.deepEqual(refreshed, [], 'the refresh token is not spent again on a fresh credential')
  assert.deepEqual(saved, [], 'nothing is written back over the other writer rotation')
})

// ---------------------------------------------------------------------------
// Sync back to Claude Code's own credential blob
// ---------------------------------------------------------------------------

test('a session Claude Code already refreshed is adopted without a network refresh or rewrite', needsFileStore, async () => {
  // Same account on both sides, stated explicitly: adoption of a source rotation requires
  // provable same-account identity (or an unchanged lineage), so this fixture names the login.
  const source: ClaudeSession = {
    accessToken: 'at-source-fresh',
    refreshToken: 'rt-source',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    emailAddress: 'synthetic@example.test',
  }
  const { dir, file } = credentialsDir('claude-auth-source-', blob(source))
  const before = readFileSync(file, 'utf8')
  const refreshes: string[] = []

  const result = await withConfigDir(dir, () => refreshClaudeSynced(
    {
      accessToken: 'at-ours-stale',
      refreshToken: 'rt-ours',
      expiresAt: Date.now() - 1_000,
      scopes: 'user:inference',
      emailAddress: 'synthetic@example.test',
    },
    async (session) => {
      refreshes.push(session.accessToken)
      return { ...session, accessToken: 'at-network' }
    },
  ))

  assert.equal(result.accessToken, 'at-source-fresh', 'the fresher stored token is the one served')
  assert.deepEqual(refreshes, [], 'the OAuth refresh grant is not spent on a token the store already rotated')
  assert.equal(readFileSync(file, 'utf8'), before, 'the source blob is left exactly as it was')
})

test('a refresh writes back into the existing blob and preserves the fields it does not own', needsFileStore, async () => {
  const { dir, file } = credentialsDir('claude-auth-merge-', blob({
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    expiresAt: Date.now() - 1_000,
    subscriptionType: 'max',
    emailAddress: 'synthetic@example.test',
  }))

  const result = await withConfigDir(dir, () => refreshClaudeSynced(
    { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() - 1_000, scopes: 'user:inference' },
    async (session) => ({
      ...session,
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      expiresAt: Date.now() + 3_600_000,
    }),
  ))

  assert.equal(result.accessToken, 'at-new')
  const written = JSON.parse(readFileSync(file, 'utf8')) as {
    claudeOauthAccount?: { emailAddress?: string }
    claudeAiOauth?: Record<string, unknown>
  }
  assert.equal(written.claudeAiOauth?.accessToken, 'at-new', 'the rotated access token is persisted')
  assert.equal(written.claudeAiOauth?.refreshToken, 'rt-new', 'the rotated refresh token is persisted')
  assert.equal(written.claudeAiOauth?.subscriptionType, 'max', 'an unrelated token field survives the merge')
  assert.equal(written.claudeOauthAccount?.emailAddress, 'synthetic@example.test', 'the wrapper sibling survives')
})

test('a write-back whose blob changed mid-refresh does not clobber the other writer', needsFileStore, async () => {
  const { dir, file } = credentialsDir('claude-auth-cas-', blob({
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    expiresAt: Date.now() - 1_000,
  }))

  const result = await withConfigDir(dir, () => refreshClaudeSynced(
    { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() - 1_000, scopes: 'user:inference' },
    async (session) => {
      // Another process rotates the same account while this refresh is in flight.
      writeFileSync(file, blob({
        accessToken: 'at-other',
        refreshToken: 'rt-other',
        expiresAt: Date.now() + 3_600_000,
      }), { mode: 0o600 })
      return { ...session, accessToken: 'at-ours-new', refreshToken: 'rt-ours-new', expiresAt: Date.now() + 3_600_000 }
    },
  ))

  assert.equal(result.accessToken, 'at-ours-new', 'the caller still receives the session it refreshed')
  const written = JSON.parse(readFileSync(file, 'utf8')) as { claudeAiOauth?: Record<string, unknown> }
  assert.equal(written.claudeAiOauth?.accessToken, 'at-other', 'the compare-and-set refuses the stale write')
  assert.equal(written.claudeAiOauth?.refreshToken, 'rt-other', 'the other writer keeps its rotation')
})

// ---------------------------------------------------------------------------
// The identity profile read the first request issues
// ---------------------------------------------------------------------------

/** One SSE answer, enough to complete a stream through the adapter. */
const RESPONSE_SSE = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'data: {"type":"message_stop"}\n\n',
].join('')

/** The synthetic harness session every case's adapter request is recorded under. */
const SESSION = 'sess-auth-boundaries' as NonNullable<GenerateOptions['sessionId']>

const REQUEST = {
  provider: 'claude',
  model: 'claude-opus-4-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  sessionId: SESSION,
}

interface ProfileAnswer {
  status: number
  body?: unknown
}

/** The bearer an injected fetch saw, under whichever header casing the builder chose. */
function authorizationOf(init?: { headers?: Record<string, string> }): string {
  const headers = init?.headers ?? {}
  return Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? ''
}

/**
 * The durable store's own compare-and-set: a write that names a prior is refused unless
 * that prior is still the stored session. Modelling it here means a case that expects a
 * write to land also proves its caller named the session the update was derived from.
 */
function priorMatches(stored: ClaudeSession | undefined, expectedPrior: ClaudeSession | undefined): boolean {
  if (expectedPrior === undefined) return true
  return stored !== undefined
    && stored.accessToken === expectedPrior.accessToken
    && stored.refreshToken === expectedPrior.refreshToken
}

/**
 * A claude adapter over one pre-upgrade session (no account uuid or device id), with the
 * identity profile read scripted and the Messages request answered by a local SSE body.
 * @param t - the case that owns this adapter's continuation owner.
 * @param profileAnswers - the profile answers the read receives, in order.
 * @param initial - the stored session, when the case replaces the default one.
 * @returns the adapter and everything it did.
 */
async function identityHarness(
  t: Pick<TestContext, 'after'>,
  profileAnswers: readonly ProfileAnswer[],
  initial?: ClaudeSession,
): Promise<{
  adapter: ClaudeAdapter
  refreshes: string[]
  saves: ClaudeSession[]
  profileAuthorization: string[]
  messageAuthorization: string[]
  messageRequests: string[]
  stored(): ClaudeSession | undefined
}> {
  let stored: ClaudeSession | undefined = initial ?? {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    emailAddress: 'primary@example.test',
  }
  const refreshes: string[] = []
  const saves: ClaudeSession[] = []
  const profileAuthorization: string[] = []
  const messageAuthorization: string[] = []
  const messageRequests: string[] = []
  let profileCalls = 0

  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Boundary',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: async (current) => {
        refreshes.push(current.accessToken)
        return {
          ...current,
          accessToken: 'at-2',
          refreshToken: 'rt-2',
          expiresAt: Date.now() + 3_600_000,
          // `refreshClaude` mints a throwaway device id when the session it refreshed
          // carried none; the backfill must not adopt that as the account's device.
          deviceId: current.deviceId ?? 'f'.repeat(64),
        }
      },
      isPermanent: () => false,
    }),
    io: {
      list: async () => stored === undefined ? [] : [{ key: 'acct', session: stored }],
      get: async () => stored,
      save: async (_account, session, expectedPrior) => {
        saves.push(session)
        if (!priorMatches(stored, expectedPrior)) return
        stored = session
      },
      remove: async () => { stored = undefined },
    },
  })

  const fetchFn: FetchFn = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    const target = String(url)
    const authorization = authorizationOf(init)
    if (target.includes('/api/oauth/profile')) {
      profileAuthorization.push(authorization)
      const answer = profileAnswers[Math.min(profileCalls, profileAnswers.length - 1)]!
      profileCalls += 1
      return new Response(
        answer.body === undefined ? '{}' : JSON.stringify(answer.body),
        { status: answer.status, headers: { 'content-type': 'application/json' } },
      )
    }
    messageRequests.push(target)
    messageAuthorization.push(authorization)
    return new Response(RESPONSE_SSE, { headers: { 'content-type': 'text/event-stream' } })
  }) as FetchFn

  const adapter = new ClaudeAdapter({
    models: [],
    discovery: false,
    streamIdleTimeoutMs: 60_000,
    tokens,
    fetchFn,
    deviceFingerprint: () => FINGERPRINT,
    continuation: await ownedClaudeContinuation(t, ['acct']),
    requestRecord: new PermittingRecordPort(),
  })
  return {
    adapter, refreshes, saves, profileAuthorization, messageAuthorization, messageRequests,
    stored: () => stored,
  }
}

/**
 * A claude adapter whose profile read is held on a barrier, so a case can replace the stored
 * credential at exactly the point the backfill sits between its read and its guarded write.
 * @param t - the case that owns this adapter's continuation owner.
 * @param initial - the stored session the case starts from.
 * @param profileBody - the profile document the held read answers.
 * @returns the adapter, its barrier and everything it did.
 */
async function casRaceHarness(t: Pick<TestContext, 'after'>, initial: ClaudeSession, profileBody: unknown): Promise<{
  adapter: ClaudeAdapter
  profileStarted: Promise<void>
  releaseProfile(): void
  replaceStored(session: ClaudeSession): void
  messageAuthorization: string[]
  messageBodies: string[]
  saves: ClaudeSession[]
  stored(): ClaudeSession | undefined
}> {
  let stored: ClaudeSession | undefined = initial
  const saves: ClaudeSession[] = []
  const messageAuthorization: string[] = []
  const messageBodies: string[] = []
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const profileStarted = new Promise<void>((resolve) => { entered = resolve })

  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Boundary',
    makeOptions: () => ({ preemptMs: 0, refresh: async (current) => current, isPermanent: () => false }),
    io: {
      list: async () => stored === undefined ? [] : [{ key: 'acct', session: stored }],
      get: async () => stored,
      save: async (_account, session, expectedPrior) => {
        saves.push(session)
        if (!priorMatches(stored, expectedPrior)) return
        stored = session
      },
      remove: async () => { stored = undefined },
    },
  })

  const fetchFn: FetchFn = (async (url: unknown, init?: { headers?: Record<string, string>; body?: unknown }) => {
    const target = String(url)
    if (target.includes('/api/oauth/profile')) {
      entered()
      await gate
      return Response.json(profileBody)
    }
    messageAuthorization.push(authorizationOf(init))
    messageBodies.push(typeof init?.body === 'string' ? init.body : '')
    return new Response(RESPONSE_SSE, { headers: { 'content-type': 'text/event-stream' } })
  }) as FetchFn

  const adapter = new ClaudeAdapter({
    models: [],
    discovery: false,
    streamIdleTimeoutMs: 60_000,
    tokens,
    fetchFn,
    deviceFingerprint: () => FINGERPRINT,
    continuation: await ownedClaudeContinuation(t, ['acct']),
    requestRecord: new PermittingRecordPort(),
  })
  return {
    adapter,
    profileStarted,
    releaseProfile: () => { release() },
    replaceStored: (session) => { stored = session },
    messageAuthorization,
    messageBodies,
    saves,
    stored: () => stored,
  }
}

/** Drive one request to completion, returning the chunks it produced. */
async function drain(adapter: ClaudeAdapter): Promise<number> {
  let chunks = 0
  for await (const _chunk of adapter.stream(REQUEST as never)) chunks += 1
  return chunks
}

test('a rejected identity read refreshes once and replays with the refreshed token', async (t) => {
  const harness = await identityHarness(t, [
    { status: 401 },
    { status: 200, body: { account: { uuid: 'uuid-from-profile' } } },
  ])

  await drain(harness.adapter)

  assert.deepEqual(harness.refreshes, ['at-1'], 'the identity rejection costs exactly one refresh')
  assert.deepEqual(
    harness.profileAuthorization,
    ['Bearer at-1', 'Bearer at-2'],
    'the replay carries the refreshed token',
  )
  assert.equal(harness.messageRequests.length, 1, 'the request proceeds once the identity is read')
  assert.equal(harness.stored()?.accountUuid, 'uuid-from-profile', 'the backfilled identity is persisted')
})

test('an identity read that never yields an account uuid fails loudly instead of inventing one', async (t) => {
  const harness = await identityHarness(t, [{ status: 200, body: {} }])

  await assert.rejects(drain(harness.adapter), (error: unknown) => {
    assert.ok(error instanceof LlmError, 'the failure is a typed LlmError')
    assert.equal(error.code, 'INVALID_REQUEST')
    assert.match(error.message, /identity is unavailable/)
    return true
  })
  assert.deepEqual(harness.saves, [], 'no half-identified session is persisted')
  assert.deepEqual(harness.messageRequests, [], 'no request is sent under a fabricated identity')
  assert.deepEqual(harness.refreshes, [], 'a readable profile needs no refresh')
})

// The case the identity backfill exists to keep: the profile read's own 401 replay rotates
// the credential, and the backfill must continue from that rotation rather than write the
// session it started from back over it. Reproduced before the fix with
// phase18/auth-work/probe-identity-refresh.mts (final stored at-1/rt-1, request Bearer at-1).
test('the identity backfill keeps the credential the profile replay refreshed', async (t) => {
  const harness = await identityHarness(t, [
    { status: 401 },
    { status: 200, body: { account: { uuid: 'uuid-from-profile' } } },
  ])

  await drain(harness.adapter)

  assert.equal(harness.stored()?.accessToken, 'at-2', 'the refreshed access token survives the backfill')
  assert.equal(harness.stored()?.refreshToken, 'rt-2', 'the rotated refresh token is not restored to the spent one')
  assert.equal(harness.stored()?.accountUuid, 'uuid-from-profile', 'the identity lands on the refreshed session')
  assert.equal(
    harness.stored()?.deviceId,
    deriveClaudeDeviceId('uuid:uuid-from-profile', FINGERPRINT),
    'the device id is the uuid-and-machine derivation, not the throwaway one the refresh grant minted',
  )
  assert.deepEqual(harness.messageAuthorization, ['Bearer at-2'], 'the request carries the credential the replay refreshed')
})

test('a device id copied from another machine is replaced during the profile replay', async (t) => {
  const harness = await identityHarness(
    t,
    [
      { status: 401 },
      { status: 200, body: { account: { uuid: 'uuid-from-profile' } } },
    ],
    {
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: Date.now() + 3_600_000,
      scopes: 'user:inference',
      emailAddress: 'primary@example.test',
      deviceId: 'e'.repeat(64),
    },
  )

  await drain(harness.adapter)

  const expected = deriveClaudeDeviceId('uuid:uuid-from-profile', FINGERPRINT)
  assert.notEqual(expected, 'e'.repeat(64), 'the copied value is not this machine’s derivation')
  assert.equal(harness.stored()?.deviceId, expected, 'the copied device id is replaced by the local derivation')
  assert.equal(harness.stored()?.accountUuid, 'uuid-from-profile', 'the identity is still backfilled')
  assert.equal(harness.stored()?.accessToken, 'at-2', 'the rebind does not roll back the replayed credential')
  assert.equal(harness.saves.at(-1)?.deviceId, expected, 'the replacement is the write the backfill made')
})

test('a backfill that loses its compare-and-set never mixes another account identity in', async (t) => {
  let raced: LlmError | undefined
  const harness = await casRaceHarness(
    t,
    {
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: Date.now() + 3_600_000,
      scopes: 'user:inference',
      emailAddress: 'ours@example.test',
    },
    { account: { uuid: 'uuid-ours' } },
  )

  const pending = drain(harness.adapter)
  await harness.profileStarted
  // A re-login for a different person lands while the profile read is still open.
  harness.replaceStored({
    accessToken: 'at-other',
    refreshToken: 'rt-other',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    emailAddress: 'other@example.test',
    accountUuid: 'uuid-other',
    deviceId: 'o'.repeat(64),
  })
  harness.releaseProfile()

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof LlmError, 'the race surfaces as a typed error')
    assert.equal(error.code, 'CLAUDE_IDENTITY_CHANGED')
    assert.match(error.message, /account was replaced/)
    raced = error
    return true
  })
  assert.equal(harness.stored()?.accessToken, 'at-other', 'the winner credential is not overwritten')
  assert.equal(harness.stored()?.accountUuid, 'uuid-other', 'the earlier profile uuid never reaches the new account')
  assert.equal(harness.stored()?.deviceId, 'o'.repeat(64), 'the new account keeps the device it already presents')
  assert.deepEqual(harness.messageAuthorization, [], 'no request is sent under a mixed identity')
  assert.equal(harness.saves.length, 1, 'the refused write is the only write attempted')

  // The code is plugin-local on purpose: the credential is sound, so the pool must not park
  // the account and the route must not spend a retry on the same request.
  assert.deepEqual(classifyPoolFailure(raced, 'claude'), { action: 'throw' }, 'the pool does not park the account')
  const policy = subscriptionRetryPolicy(DEFAULT_RETRY, { wait: true, maxWaitMs: 21_600_000 }, 'claude')
  assert.equal(policy.mode, 'normal')
  if (policy.mode !== 'normal') throw new Error('the claude route is not a bounded-retry route')
  assert.equal(policy.retryableCodes.includes('CLAUDE_IDENTITY_CHANGED'), false, 'the route spends no retry on it')
})

test('a backfill that loses its compare-and-set serves the winner credential while the request keeps the local device', async (t) => {
  const shared = { scopes: 'user:inference', emailAddress: 'ours@example.test' }
  const harness = await casRaceHarness(
    t,
    { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000, ...shared },
    { account: { uuid: 'uuid-ours' } },
  )

  const pending = drain(harness.adapter)
  await harness.profileStarted
  // Another process rotates the same account while the profile read is open.
  harness.replaceStored({
    accessToken: 'at-2',
    refreshToken: 'rt-2',
    expiresAt: Date.now() + 3_600_000,
    ...shared,
    accountUuid: 'uuid-ours',
    deviceId: 'd'.repeat(64),
  })
  harness.releaseProfile()

  const chunks = await pending
  assert.ok(chunks > 0, 'the request completes on the winner credential')
  assert.deepEqual(harness.messageAuthorization, ['Bearer at-2'], 'the rotation is honored, not rolled back to at-1')
  assert.equal(harness.stored()?.accessToken, 'at-2', 'the winner stays stored')
  assert.equal(harness.stored()?.refreshToken, 'rt-2')
  assert.equal(harness.stored()?.deviceId, 'd'.repeat(64), 'the loser never writes its device id over the winner')
  assert.equal(harness.saves.length, 1, 'the refused write is the only write attempted')
  // The device the request presents is bound on this machine; the stored value is the
  // winner's own and is left as it stands.
  const metadata = JSON.parse(
    (JSON.parse(harness.messageBodies[0]!) as { metadata: { user_id: string } }).metadata.user_id,
  ) as { device_id: string; account_uuid: string }
  assert.equal(metadata.device_id, deriveClaudeDeviceId('uuid:uuid-ours', FINGERPRINT))
  assert.equal(metadata.account_uuid, 'uuid-ours')
})
