/**
 * The `status` projection: one independent dimension per account state, fixed
 * failure codes instead of provider text, and no provider request on a read.
 *
 * The spec drives the real controller and the real status handler over a
 * private harness home. It owns the facts a classifier-only test cannot see:
 * which dimension a pool cooldown lands in, what a re-login is reported as, and
 * that neither the stored credential nor the provider's own message reaches the
 * wire.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { DeviceFlowManager } from '../src/auth/device-flow.js'
import { OAuthFlowManager } from '../src/auth/oauth-flow.js'
import { OAuthEndpointError } from '../src/providers/common.js'
import type { AccountStateReport } from '../src/index.js'

// The store resolves `$DSH_HOME` per call, but the controller and the
// projection are process-wide singletons: pin a private home before importing
// the plugin so no spec can write to the real one.
const home = mkdtempSync(join(tmpdir(), 'claude-status-spec-'))
process.env.DSH_HOME = home

const { SubscriptionsAuthController, cooldownDimensions, providerFailure, claudeSettingsFailureClassifier,
  ownedReleases } = await import('../src/index.js')

const TOKEN = 'access-token-value-that-must-not-travel'
const REFRESH = 'refresh-token-value-that-must-not-travel'

/** One provider's stored accounts, keyed by the canonical account key. */
type StoredAccounts = Record<string, Record<string, { accessToken: string; refreshToken: string; expiresAt: number }>>

/** Write each provider's stored accounts into the private home's auth store. */
function store(accounts: StoredAccounts): void {
  mkdirSync(join(home, 'plugins', 'subscriptions'), { recursive: true })
  const providers: Record<string, unknown> = {}
  for (const [provider, entries] of Object.entries(accounts)) {
    providers[provider] = { default: Object.keys(entries)[0], accounts: entries }
  }
  writeFileSync(join(home, 'plugins', 'subscriptions', 'auth.json'), JSON.stringify(providers), { mode: 0o600 })
}

/** A controller over the private home, with the projection's injected state owner. */
function controller(
  accountState?: (provider: string, account: string) => AccountStateReport | undefined,
): InstanceType<typeof SubscriptionsAuthController> {
  return new SubscriptionsAuthController(
    new OAuthFlowManager(),
    new DeviceFlowManager(),
    () => {},
    () => undefined,
    // A status read must not consult a usage endpoint; failing loudly here is
    // how this spec observes that it never does.
    { claude: () => Promise.reject(new Error('a status read must not fetch usage')) },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {},
    accountState,
  )
}

test('one account reports each dimension its own owner supplied', async () => {
  store({ claude: { acct: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000 } } })
  const status = await controller(() => ({
    credential: { state: 'reauth_required', code: 'REAUTH_REQUIRED', until: 1_700_000_000_000 },
    availability: { state: 'cooling', code: 'QUOTA_EXHAUSTED', until: 1_700_000_600_000 },
    protocol: { state: 'upgrade_required', code: 'CLIENT_VERSION_UNSUPPORTED', profileId: 'cc-2.1.288', since: 1 },
    profile: { state: 'stale', capturedAt: 2, complete: false },
    policy: { state: 'blocked', code: 'POLICY_UNSUPPORTED', scope: 'tool' },
  })).status('claude')
  assert.equal(status.accounts.length, 1)
  const account = status.accounts[0]!
  assert.deepEqual(account.credential, { state: 'reauth_required', code: 'REAUTH_REQUIRED', until: 1_700_000_000_000 })
  assert.deepEqual(account.availability, { state: 'cooling', code: 'QUOTA_EXHAUSTED', until: 1_700_000_600_000 })
  assert.deepEqual(account.protocol, {
    state: 'upgrade_required', code: 'CLIENT_VERSION_UNSUPPORTED', profileId: 'cc-2.1.288', since: 1,
  })
  assert.deepEqual(account.profile, { state: 'stale', capturedAt: 2, complete: false })
  assert.deepEqual(account.policy, { state: 'blocked', code: 'POLICY_UNSUPPORTED', scope: 'tool' })
})

test('a dimension no owner reports is absent, never defaulted to healthy', async () => {
  store({ claude: { acct: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000 } } })
  const status = await controller().status('claude')
  const account = status.accounts[0]!
  // The credential dimension is the one the roster itself proves.
  assert.deepEqual(account.credential, { state: 'ready' })
  assert.equal('availability' in account, false)
  assert.equal('protocol' in account, false)
  assert.equal('profile' in account, false)
  assert.equal('policy' in account, false)
})

test('a parked dead credential is a re-login, not a quota cooldown', () => {
  const dimensions = cooldownDimensions({ unavailableUntil: 1_700_000_000_000, reason: 'INVALID_CREDENTIAL' })
  assert.deepEqual(dimensions, {
    credential: { state: 'reauth_required', code: 'REAUTH_REQUIRED', until: 1_700_000_000_000 },
  })
})

test('a stated refusal is neither a cooldown nor a credential problem', () => {
  const dimensions = cooldownDimensions({ unavailableUntil: 1_700_000_000_000, reason: 'ENFORCEMENT' })
  assert.deepEqual(dimensions, {
    availability: { state: 'refused', code: 'ENFORCEMENT_REFUSAL', until: 1_700_000_000_000 },
  })
})

test('quota, timeout, model and server parks keep their own availability codes', () => {
  const until = 1_700_000_000_000
  const cases: [string, 'cooling' | 'transient', string][] = [
    ['QUOTA', 'cooling', 'QUOTA_EXHAUSTED'],
    ['RATE_LIMIT', 'cooling', 'RATE_LIMITED'],
    ['TIMEOUT', 'transient', 'REQUEST_TIMEOUT'],
    ['HTTP_404', 'transient', 'MODEL_UNAVAILABLE'],
    ['SERVER', 'transient', 'PROVIDER_UNAVAILABLE'],
    ['EMPTY_RESPONSE', 'transient', 'PROVIDER_UNAVAILABLE'],
    ['something-new', 'transient', 'PROVIDER_ERROR'],
  ]
  for (const [reason, state, code] of cases) {
    const dimensions = cooldownDimensions({ unavailableUntil: until, reason })
    assert.deepEqual(dimensions?.availability, { state, code, until })
  }
  assert.equal(cooldownDimensions(undefined), undefined)
})

test('provider failures are reported as fixed codes with allowlisted fields only', () => {
  const at = 1_700_000_000_000
  const rejected = providerFailure(new OAuthEndpointError('invalid_grant: refresh token revoked by the user', 400, 'invalid_grant'), 'login', at)
  assert.deepEqual(rejected, { operation: 'login', at, status: 400, providerCode: 'invalid_grant', code: 'CREDENTIALS_REJECTED' })
  assert.equal(JSON.stringify(rejected).includes('revoked'), false, 'the provider message does not travel')

  const refused = providerFailure(new OAuthEndpointError('slow down', 429, undefined, 30_000), 'login', at)
  assert.deepEqual(refused, { operation: 'login', at, status: 429, retryAt: at + 30_000, code: 'PROVIDER_REJECTED' })

  const transient = providerFailure(new LlmError('transport', 'TRANSPORT'), 'login', at)
  assert.deepEqual(transient, { operation: 'login', at, code: 'NETWORK' })
  const missing = providerFailure(new LlmError('no account', 'MISSING_CREDENTIAL'), 'login', at)
  assert.deepEqual(missing, { operation: 'login', at, code: 'CREDENTIALS_UNAVAILABLE' })

  const aborted = new Error('aborted'); aborted.name = 'AbortError'
  assert.deepEqual(providerFailure(aborted, 'login', at), { operation: 'login', at, code: 'CANCELLED' })
  const timedOut = new Error('slow'); timedOut.name = 'TimeoutError'
  assert.deepEqual(providerFailure(timedOut, 'login', at), { operation: 'login', at, code: 'TIMEOUT' })
  assert.deepEqual(providerFailure(new Error(`boom ${TOKEN}`), 'login', at), { operation: 'login', at, code: 'UNKNOWN' })
})

test('a status read is a read: no provider request, no credential material, no legacy detail field', async () => {
  store({ claude: { acct: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000 } } })
  const status = await controller().status('claude')
  const wire = JSON.stringify(status)
  assert.equal(wire.includes(TOKEN), false)
  assert.equal(wire.includes(REFRESH), false)
  assert.equal('detail' in status, false, 'provider text has no field to travel in')
  assert.equal(status.busy, false)
})

test('the RPC status endpoint answers every provider and degrades one alone', async () => {
  const { createFakeConnection } = await import('./fake-connection.js')
  const { Context } = await import('@deepseek-ai/cordis')
  const plugin = await import('../src/index.js')
  store({ claude: { acct: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000 } } })
  const ctx = new Context()
  ctx.provide('llm', { registerAdapter: () => Object.assign(() => {}, { replace: () => {} }) })
  const fake = createFakeConnection()
  ctx.provide('connection', fake.connection)
  ctx.plugin(plugin, { providers: ['claude'] })
  await new Promise(resolve => setTimeout(resolve, 50))
  const result = await fake.handler('status', {}, new AbortController().signal)
  assert.ok(result.ok)
  if (!result.ok) return
  const providers = (result.value as { providers: Record<string, { accounts: unknown[] }> }).providers
  assert.deepEqual(Object.keys(providers).sort(), ['antigravity', 'claude', 'codex', 'copilot', 'cursor', 'grok'])
  assert.equal(providers.claude.accounts.length, 1)
})

/** Mount the plugin over a fake Host `llm` and return the routes it registered. */
async function mountHost(capability: number | undefined): Promise<{
  registered: string[]
  status: (provider: string) => Promise<Record<string, unknown>>
}> {
  const { createFakeConnection } = await import('./fake-connection.js')
  const { Context } = await import('@deepseek-ai/cordis')
  const plugin = await import('../src/index.js')
  const registered: string[] = []
  const ctx = new Context()
  // The Claude route also mounts only while a Host provides the recording seam; the
  // capability below is what this spec varies.
  ctx.provide('llmRequestRecord', {
    recordPreparedRequest: async () => ({ ok: true, preparedId: 0 }),
  })
  ctx.provide('llm', {
    // A status read must not register anything beyond the adapters themselves.
    registerAdapter: (providers: string[]) => {
      registered.push(...providers)
      return Object.assign(() => {}, { replace: () => {} })
    },
    ...capability === undefined ? {} : { failureRecoveryVersion: capability },
  })
  const fake = createFakeConnection()
  ctx.provide('connection', fake.connection)
  ctx.plugin(plugin, { providers: ['claude', 'codex'] })
  await new Promise(resolve => setTimeout(resolve, 50))
  return {
    registered,
    status: async (provider) => {
      const result = await fake.handler('status', {}, new AbortController().signal)
      assert.ok(result.ok)
      const providers = (result.value as { providers: Record<string, Record<string, unknown>> }).providers
      assert.ok(providers[provider] !== undefined, provider)
      return providers[provider]!
    },
  }
}

test('a Host without the declared contract loses the Claude route and keeps the others', async () => {
  store({ claude: { acct: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000 } } })
  const host = await mountHost(undefined)
  assert.deepEqual(host.registered, ['codex'], 'no Claude adapter is registered')
  const claude = await host.status('claude')
  assert.equal(claude.unavailable, 'CLAUDE_HOST_INCOMPATIBLE')
  // The stored login is retained — refusing the route is not a logout — but the
  // card states why the route cannot serve it.
  assert.equal((claude.accounts as unknown[]).length, 1)
  const codex = await host.status('codex')
  assert.equal('unavailable' in codex, false, 'the other providers keep working')
})

test('a Host that declares the contract registers the Claude route', async () => {
  store({ claude: { acct: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000 } } })
  const host = await mountHost(1)
  // Registration order follows each provider's own injection, so only the set is the contract.
  assert.deepEqual([...host.registered].sort(), ['claude', 'codex'])
  const claude = await host.status('claude')
  assert.equal('unavailable' in claude, false)
  assert.equal((claude.accounts as unknown[]).length, 1)
})

test('a maintenance bound that would disable a capability fails the load instead of defaulting', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const plugin = await import('../src/index.js')
  // `apply` validates the maintenance bounds before it registers anything, so a zero or
  // negative value is a load failure rather than a silently different default.
  const mount = (claudeMaintenance: Record<string, number>): void => {
    const ctx = new Context()
    ctx.provide('llm', { failureRecoveryVersion: 1, registerAdapter: () => Object.assign(() => {}, { replace: () => {} }) })
    plugin.apply(ctx, { providers: [], claudeMaintenance })
  }
  for (const value of [0, -1]) {
    assert.throws(() => { mount({ minRefreshDelayMs: value }) }, /minRefreshDelayMs/, `minRefreshDelayMs ${value} is rejected`)
  }
  // A positive value is accepted, which is the whole point of exposing the field.
  assert.doesNotThrow(() => { mount({ minRefreshDelayMs: 1_000 }) })
})

test('the settings read is classified by the reliability classifier', async () => {
  const { CLAUDE_DEFAULT_ORIGIN } = await import('../src/providers/claude-maintenance.js')
  const { CLAUDE_PROTOCOL_PROFILE, claudeProtocolFingerprint } = await import('../src/providers/claude-protocol.js')

  // Classification only: the account-maintenance owner records the shared block for a
  // refusal it accepts, so nothing here asserts a store side effect.
  const classify = claudeSettingsFailureClassifier()
  const origin = CLAUDE_DEFAULT_ORIGIN
  const fingerprint = claudeProtocolFingerprint(CLAUDE_PROTOCOL_PROFILE)
  const context = { account: 'acct', origin, protocolFingerprint: fingerprint }

  // A 400 that names the client-version refusal nested in its body is the same hard stop the
  // Messages path produces, not a generic transient status.
  const refused = await classify(new Response(JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'client version too old' },
    details: { code: 'claude_code_version_too_old' },
  }), { status: 400 }), context)
  assert.equal(refused?.reason, 'CLIENT_VERSION_UNSUPPORTED')
  assert.equal(refused?.retryDisposition, 'forbid', 'no automatic recovery may follow')
  assert.equal(refused?.status, 400)
  assert.equal(refused?.origin, origin, 'the identity comes from the read, not a recomputation')
  assert.equal(refused?.protocolFingerprint, fingerprint)

  // An ordinary 401 is a credential failure, not a hard stop: the caller keeps its one
  // controlled refresh and replay.
  const unauthorized = await classify(new Response(JSON.stringify({
    type: 'error',
    error: { type: 'authentication_error', message: 'invalid bearer token' },
  }), { status: 401 }), context)
  assert.notEqual(unauthorized?.retryDisposition, 'forbid')
  assert.equal(unauthorized?.status, 401)
})

test('a failing account cleanup is contained by its warning sink, and disposal waits for it', async () => {
  const warnings: string[] = []
  const releases = ownedReleases(message => warnings.push(message))

  // A logout's account cleanup can reject: it must be reported, not become an unhandled
  // rejection, and the caller must be able to await it.
  let threw = false
  const failing = releases.track((async () => {
    await new Promise(resolve => setTimeout(resolve, 5))
    threw = true
    throw new Error('the store refused the removal')
  })(), 'claude maintenance account release failed')
  await failing
  assert.equal(threw, true, 'the cleanup ran to completion before it failed')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /account release failed/)
  assert.match(warnings[0]!, /the store refused the removal/)

  // Disposal waits for cleanup still running, and a successful one reports nothing.
  let finished = false
  releases.track((async () => {
    await new Promise(resolve => setTimeout(resolve, 5))
    finished = true
  })(), 'claude maintenance session release failed')
  await releases.drain()
  assert.equal(finished, true, 'drain waited for the cleanup it started')
  assert.equal(warnings.length, 1, 'a successful cleanup stays quiet')
})
