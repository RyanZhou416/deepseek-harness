/**
 * The Claude authorization-code exchange and the machine identity.
 *
 * A completed exchange must not depend on this machine's identifier: the device id is
 * derived later, when the first Messages request resolves the account's identity, so a host
 * whose identifier is unreadable cannot cost the user a credential the service already
 * issued. Every case drives the shipped `exchangeClaudeCode` with the token and profile
 * endpoints mocked at the global fetch the plugin's own `proxiedFetch` calls, from a private
 * proxy state in the isolated home this suite runs under; no real endpoint, credential store
 * or host identifier is read.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { resetProxyForTests } from '../src/http.js'
import { CLAUDE_TOKEN_URL, exchangeClaudeCode } from '../src/providers/claude.js'

/** The values one synthetic authorization-code callback carried. */
const CODE = 'synthetic-authorization-code'
const VERIFIER = 'synthetic-pkce-verifier'
const REDIRECT_URI = 'http://127.0.0.1:53682/callback'
const STATE = 'synthetic-state'

/** The credential the mocked token endpoint issued. */
const ACCESS_TOKEN = 'at-login-synthetic'
const REFRESH_TOKEN = 'rt-login-synthetic'
const SCOPE = 'user:inference user:profile'

/** The account the mocked profile disclosed. */
const ACCOUNT_UUID = '3f1c8a52-0d47-4b90-8e21-77c9a4f10b6d'
const EMAIL = 'synthetic@example.test'

/** The token response body, in the grant shape the endpoint returns. */
const TOKEN_RESPONSE = {
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN,
  expires_in: 3_600,
  scope: SCOPE,
}

/** The fetch this process had before any case replaced it. */
const REAL_FETCH = globalThis.fetch

/** One request the mocked egress saw. */
interface SeenRequest {
  readonly url: string
  readonly method: string
  readonly body: string
  readonly authorization: string
  readonly redirect: string | undefined
}

/**
 * The mocked token and profile endpoints.
 * @param profile - the status and body the profile endpoint answers.
 * @returns the replacement fetch and every request it saw.
 */
function loginEgress(profile: { status: number; body?: unknown }): {
  fetch: typeof fetch
  seen: SeenRequest[]
} {
  const seen: SeenRequest[] = []
  const mocked = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    seen.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
      authorization: headers.get('authorization') ?? '',
      redirect: typeof init?.redirect === 'string' ? init.redirect : undefined,
    })
    if (url.includes('/oauth/profile')) {
      return new Response(profile.body === undefined ? '{}' : JSON.stringify(profile.body), {
        status: profile.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return Response.json(TOKEN_RESPONSE)
  }) as typeof fetch
  return { fetch: mocked, seen }
}

/**
 * Run one check with the process fetch replaced.
 * @param mocked - the replacement.
 * @param check - the body to run.
 * @returns the body's own result.
 */
async function withMockedEgress<T>(mocked: typeof fetch, check: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch
  globalThis.fetch = mocked
  try {
    return await check()
  } finally {
    globalThis.fetch = previous
  }
}

/**
 * Run one exchange over the mocked endpoints.
 * @param profile - the status and body the profile endpoint answers.
 * @returns the session and every request the exchange made.
 */
async function exchange(profile: { status: number; body?: unknown }): Promise<{
  session: Awaited<ReturnType<typeof exchangeClaudeCode>>
  seen: SeenRequest[]
  startedAt: number
  finishedAt: number
}> {
  const egress = loginEgress(profile)
  const startedAt = Date.now()
  const session = await withMockedEgress(egress.fetch, () =>
    exchangeClaudeCode(CODE, VERIFIER, REDIRECT_URI, STATE))
  return { session, seen: egress.seen, startedAt, finishedAt: Date.now() }
}

// The plugin's proxy state is process-global; every case starts from disabled and the
// process fetch is restored even if a case fails before its own `finally` runs.
before(async () => { await resetProxyForTests() })
after(async () => {
  globalThis.fetch = REAL_FETCH
  await resetProxyForTests()
})

test('a completed exchange stores no device id, even with the profile uuid in hand', async () => {
  const { session, seen, startedAt, finishedAt } = await exchange({
    status: 200,
    body: { account: { uuid: ACCOUNT_UUID }, emailAddress: EMAIL, subscriptionType: 'max' },
  })

  // The login-time derivation this replaces would have added this key here, and would have
  // failed the whole exchange on a host whose identifier could not be read.
  assert.equal('deviceId' in session, false, 'the credential record carries no device identity')
  assert.equal(session.accountUuid, ACCOUNT_UUID, 'the profile uuid still reaches the session')
  assert.equal(session.accessToken, ACCESS_TOKEN)
  assert.equal(session.refreshToken, REFRESH_TOKEN)
  assert.equal(session.scopes, SCOPE)
  assert.equal(session.emailAddress, EMAIL)
  assert.equal(session.subscriptionType, 'max')
  assert.ok(
    session.expiresAt >= startedAt + 3_600_000 && session.expiresAt <= finishedAt + 3_600_000,
    'the expiry is the issued lifetime measured from this exchange',
  )

  assert.equal(seen.length, 2, 'a login reads the token endpoint and then the profile')
  assert.equal(seen[0]?.url, CLAUDE_TOKEN_URL)
  assert.match(seen[1]?.url ?? '', /\/api\/oauth\/profile$/u)
  assert.equal(seen[0]?.method, 'POST')
  assert.equal(seen[0]?.redirect, 'error', 'the token request refuses a redirect')
  const grant = JSON.parse(seen[0]?.body ?? '{}') as Record<string, unknown>
  assert.equal(grant.grant_type, 'authorization_code')
  assert.equal(grant.code, CODE)
  assert.equal(grant.code_verifier, VERIFIER)
  assert.equal(grant.redirect_uri, REDIRECT_URI)
  assert.equal(grant.state, STATE)
  assert.equal(seen[1]?.authorization, `Bearer ${ACCESS_TOKEN}`, 'the profile is read with the credential just issued')
})

test('a refused profile still returns the issued credential with no device id', async () => {
  const { session, seen } = await exchange({ status: 401 })

  assert.equal('deviceId' in session, false)
  assert.equal(session.accessToken, ACCESS_TOKEN, 'a decorative profile read cannot cost the credential')
  assert.equal(session.refreshToken, REFRESH_TOKEN)
  assert.equal(session.scopes, SCOPE)
  assert.equal(session.accountUuid, undefined, 'no uuid is invented when the profile is unreadable')
  assert.equal(seen.length, 2, 'the profile is read once and not replayed without a reauthorizer')
})
