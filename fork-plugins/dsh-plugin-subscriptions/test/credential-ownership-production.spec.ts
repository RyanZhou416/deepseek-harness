/**
 * The production wiring of Claude credential ownership.
 *
 * Every case mounts the plugin's real apply chain — `Context`, the registered Claude route, the
 * real `SessionStore` with the recording provider the route needs, the real `AccountTokenManager`
 * over the durable store, the real maintenance owner, the real RPC endpoints — with each
 * network-shaped input injected exactly where a deployment injects it: an
 * independent transport for the `policy_limits` read and the organization validation, the
 * plugin's own fetch stubbed for the managed-settings and usage endpoints (and failing loudly on
 * anything else, so a credential grant cannot happen unnoticed), and a Messages transport
 * (`SubscriptionInternals.claudeMessagesFetch`) that answers the identity backfill's profile read
 * with the real nested wire document and records every request the route issued.
 *
 * Claude Code's own credential store is never touched: the plugin reads it through an injected
 * reader (`SubscriptionInternals.claudeCredentialSource`), which is the one place a deployment
 * would read it for the import and read-only paths, and `CLAUDE_CONFIG_DIR` points at an empty
 * private directory so the pre-existing legacy write-back path — which this spec never drives —
 * could not reach the user's own file even by accident. The rendered ownership switch is driven
 * in jsdom over the real card and the real cache, so the confirmation gate is observed as
 * behaviour rather than assumed from copy.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Config, ModelEntry } from '../src/index.js'
import { refreshForClaudeOwnership } from '../src/index.js'
import type { RpcResult } from '../src/compat.js'
import type { ClaudeSession } from '../src/auth/store.js'
import { deleteAccountSession, getAccountCredential, saveAccountSession } from '../src/auth/store.js'
import { resolveClaudeReadOnlyCredential } from '../src/auth/claude-code-creds.js'
import type { ClaudeSourceCredential } from '../src/auth/claude-code-creds.js'
import { claudeCredentialModeOf } from '../src/auth/claude-credential-ownership.js'
import type { FetchFn } from '../src/providers/common.js'
import type { SubscriptionsCacheState } from '../src/client/subscriptions-cache.js'
import { en, zh } from '../src/client/locales.js'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { ClaudeAdapter, deriveClaudeDeviceId, isClaudePermanentRefreshError } from '../src/providers/claude.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { PermittingRecordPort } from './recording-port.js'
import { ownedClaudeContinuation } from './claude-maintenance-fixtures.js'

const root = mkdtempSync(join(tmpdir(), 'credential-ownership-production-'))
// The Messages transport is injected below, so no request leaves this process; the Bun path is
// still pinned at a path that does not exist so a path that bypassed the injection would fail
// locally rather than start a real runtime.
process.env.DSH_SUBSCRIPTIONS_BUN_PATH = join(root, 'no-such-bun-runtime')
// An empty private credentials directory for the pre-existing legacy path this spec never
// drives; it keeps that path away from the user's own Claude Code credentials everywhere.
const privateClaudeConfig = join(root, 'claude-config')
mkdirSync(privateClaudeConfig, { recursive: true })
const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = privateClaudeConfig
after(() => {
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
})

/** One recorded provider request, as the plugin's own fetch saw it. */
interface RecordedCall {
  readonly url: string
  readonly method: string
  readonly authorization: string
}

/** Requests to the two endpoints this spec answers: managed settings and usage. */
const providerCalls: RecordedCall[] = []
/** Requests to a token endpoint: a credential grant this spec must never see. */
const grantCalls: RecordedCall[] = []
/** Requests to anything else, so an unexpected path is reported rather than answered. */
const otherCalls: RecordedCall[] = []
/** Requests the Claude route issued through its own Messages transport. */
const messagesCalls: RecordedCall[] = []

/** The usage answer the current case scripted, by zero-based usage-request index. */
let usageAnswer: ((call: RecordedCall, index: number) => Response) | undefined = undefined

/**
 * The identity-backfill profile read one case holds open, so a concurrent write can land while
 * the identity is still being read. A case awaits `started` and then releases it by hand; no
 * case bets on a timer.
 */
let profileHold: { readonly announce: () => void; readonly gate: Promise<void> } | undefined = undefined

/**
 * Hold the next identity-backfill profile read open until the returned release is called.
 * @returns the promise that resolves once the read is in flight, and the release to call.
 */
function holdProfile(): { readonly started: Promise<void>; readonly release: () => void } {
  let announce!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { announce = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  profileHold = { announce, gate }
  return {
    started,
    release: () => {
      profileHold = undefined
      release()
    },
  }
}

function resetCalls(): void {
  providerCalls.length = 0
  grantCalls.length = 0
  otherCalls.length = 0
  messagesCalls.length = 0
  usageAnswer = undefined
  profileHold = undefined
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const method = init?.method ?? 'GET'
  const call: RecordedCall = {
    url,
    method,
    authorization: new Headers(init?.headers as HeadersInit | undefined).get('authorization') ?? '',
  }
  if (url.includes('/oauth/token')) {
    grantCalls.push(call)
    throw new Error(`this spec spends no credential grant (${method} ${url})`)
  }
  if (url.includes('/api/claude_code/settings')) {
    providerCalls.push(call)
    return Response.json({ uuid: 'settings-1', checksum: 'checksum-1', settings: {} })
  }
  if (url.includes('/api/oauth/usage')) {
    providerCalls.push(call)
    const index = providerCalls.filter(entry => entry.url.includes('/api/oauth/usage')).length - 1
    if (usageAnswer === undefined) throw new Error('no usage answer was scripted for this case')
    return usageAnswer(call, index)
  }
  otherCalls.push(call)
  throw new Error(`this spec performs no other provider request (${method} ${url})`)
}) as typeof fetch

/** The profile document the injected Messages transport answers with; the wire nests both. */
const PROFILE_DOCUMENT = {
  account: { uuid: 'uuid-1', email: 'imported@example.invalid', created_at: '2024-01-01T00:00:00Z' },
  organization: { uuid: 'org-1', billing_type: 'stripe', subscription_created_at: '2024-01-01T00:00:00Z' },
}

/**
 * The transport one Claude Messages request is issued through, injected exactly where a
 * deployment injects the Bun child.
 *
 * It records every request, answers the identity backfill's profile read with the real nested
 * wire document, and refuses the Messages POST itself with a stated request error — the request
 * provably left, and its refusal is terminal rather than retried, so one logged turn is one
 * recorded call.
 */
const claudeMessagesFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const call: RecordedCall = {
    url,
    method: init?.method ?? 'GET',
    authorization: new Headers(init?.headers as HeadersInit | undefined).get('authorization') ?? '',
  }
  messagesCalls.push(call)
  if (url.includes('/api/oauth/profile')) {
    const held = profileHold
    if (held !== undefined) {
      held.announce()
      await held.gate
    }
    return Response.json(PROFILE_DOCUMENT)
  }
  return new Response(JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'synthetic request refusal' },
  }), { status: 400, headers: { 'content-type': 'application/json' } })
}) as FetchFn

/** One fresh harness home per mount, so no durable record crosses a case boundary. */
let mounts = 0
function freshHome(): void {
  mounts += 1
  process.env.DSH_HOME = join(root, `home-${String(mounts)}`)
  mkdirSync(process.env.DSH_HOME, { recursive: true })
  resetCalls()
}

/** The one catalog entry every case serves, so no discovery request is ever assembled. */
const MODEL: ModelEntry = {
  id: 'claude-opus-5',
  name: 'Claude Opus 5',
  contextWindow: 200_000,
  maxTokens: 8_192,
  inputModalities: ['text'],
  wire: 'responses',
}

/** The committed request's session id, branded the way the llm service declares it. */
const llmSessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

/**
 * A synthetic Claude Code credential for one account.
 *
 * No `user:profile` scope, so the maintenance owner skips its own profile read and the profile
 * request this spec observes is the identity backfill's.
 */
function sourceSession(overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    accessToken: 'at-source-1',
    refreshToken: 'rt-source-1',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    emailAddress: 'imported@example.invalid',
    ...overrides,
  }
}

/** The account key the synthetic source is stored under. */
const ACCOUNT = 'imported@example.invalid'

/** One mounted composition, with the facts each case asserts on. */
interface Composition {
  /** Drive the real `login` endpoint; the plugin has no method, so it imports. */
  login: () => Promise<RpcResult<unknown>>
  /** Drive the real `status` endpoint for the claude provider. */
  status: () => Promise<Record<string, unknown>>
  /** Drive the real `setCredentialOwnership` endpoint. */
  setOwnership: (mode: string, riskAcknowledged?: boolean) => Promise<RpcResult<unknown>>
  /** Drive the real `usage` endpoint with an explicit forced refresh. */
  usage: (force: boolean) => Promise<RpcResult<unknown>>
  /** Drive one committed Claude request through the registered route. */
  request: (sessionId?: string) => Promise<unknown>
  /**
   * Replace the synthetic Claude Code credential the injected reader answers with.
   * @param session - the credential, or `undefined` for a source that holds none.
   * @param declaredScopes - what the source itself declares; defaults to the session's scopes.
   */
  setSource: (session: ClaudeSession | undefined, declaredScopes?: string) => void
  /** The stored Claude record, read from the durable store as a restart would read it. */
  stored: () => Record<string, unknown>
  /** The stored Claude record's raw text, for asserting whether a write happened at all. */
  storedText: () => string
  /** The stored credential's revision, read through the store's own reader. */
  revision: () => Promise<number>
  dispose: () => Promise<void>
}

/**
 * Mount the plugin's real composition with a synthetic Claude Code credential source.
 *
 * The Host side is real too: the composition mounts the `SessionStore` and the
 * `SessionRequestRecordProvider`, because the Claude route is registered only while a recorder is
 * provided, and each committed request's session is created for the id it names.
 * @param initialSource - the credential the injected reader answers with; `undefined` models an
 *   external store that holds nothing for this account.
 * @param options - `newHome: false` mounts over the home the previous mount used, which is how a
 *   restart is modelled.
 * @returns the mounted composition.
 */
async function mount(
  initialSource: ClaudeSession | undefined,
  options: { newHome?: boolean } = {},
): Promise<Composition> {
  if (options.newHome !== false) freshHome()
  else resetCalls()
  let source = initialSource
  let sourceScopes: string | undefined = initialSource?.scopes
  const { Context } = await import('@deepseek-ai/cordis')
  const SessionStore = (await import('@deepseek-ai/dsh-session')).default
  const SessionRequestRecordProvider = (await import('@deepseek-ai/dsh-llm-request-record')).default
  const { createFakeConnection } = await import('./fake-connection.js')
  const plugin = await import('../src/index.js')
  const ctx = new Context()
  // `SessionStore.flush` reports a durable checkpoint only when a listener participates, and this
  // composition keeps its session log in memory: its own listener is that participant.
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionRequestRecordProvider, { flushTimeoutMs: 2_000 })
  ctx.on('session/flush', () => {})
  const fake = createFakeConnection()
  ctx.provide('connection', fake.connection)
  let route: { stream: (options: unknown) => AsyncIterable<unknown> } | undefined
  ctx.provide('llm', {
    failureRecoveryVersion: 1,
    registerAdapter: (_providers: string[], adapter: { stream: (options: unknown) => AsyncIterable<unknown> }) => {
      route = adapter
      return Object.assign(() => {}, { replace: () => {} })
    },
  })
  const config: Config = {
    providers: ['claude'],
    models: { claude: [MODEL] },
    pool: { enabled: false },
  }
  await ctx.plugin(Object.assign(
    (inner: import('@deepseek-ai/cordis').Context) => {
      plugin.apply(inner, config, {
        // The source reports the session shape this plugin records and, separately, what the
        // credential document itself declared.
        claudeCredentialSource: () => source === undefined
          ? undefined
          : {
            session: source,
            ...sourceScopes === undefined ? {} : { declaredScopes: sourceScopes },
          },
        // The independent policy_limits read and the organization validation are injected here
        // exactly as a deployment injects its transport, so no case performs a request for them
        // and the only provider request observed is the one the case itself produces.
        policyLimitsTransport: async () => Response.json({ restrictions: {} }),
        orgPinTransport: async () => Response.json({ organization_uuid: 'org-1' }),
        // The Messages transport is injected the same way, so a successful request can be
        // observed without a real Bun runtime.
        claudeMessagesFetch,
      })
    },
    { inject: plugin.inject },
  ))
  const storeFile = join(process.env.DSH_HOME!, 'plugins', 'subscriptions', 'auth.json')
  const stored = (): Record<string, unknown> => {
    const store = JSON.parse(readFileSync(storeFile, 'utf8')) as { claude?: { accounts?: Record<string, Record<string, unknown>> } }
    const accounts = store.claude?.accounts ?? {}
    const first = Object.values(accounts)[0]
    assert.ok(first !== undefined, 'the store holds a Claude record')
    return first
  }
  return {
    login: async () => await fake.handler('login', { provider: 'claude' }, new AbortController().signal),
    status: async () => {
      const result = await fake.handler('status', {}, new AbortController().signal)
      assert.ok(result.ok, 'the status call succeeds')
      const providers = (result.value as { providers: Record<string, Record<string, unknown>> }).providers
      return providers['claude']!
    },
    setOwnership: async (mode, riskAcknowledged) => await fake.handler(
      'setCredentialOwnership',
      {
        provider: 'claude',
        account: ACCOUNT,
        mode,
        ...riskAcknowledged === undefined ? {} : { riskAcknowledged },
      },
      new AbortController().signal,
    ),
    usage: async force => await fake.handler(
      'usage',
      { provider: 'claude', account: ACCOUNT, force },
      new AbortController().signal,
    ),
    request: async (sessionId) => {
      assert.ok(route !== undefined, 'the plugin registered its Claude route')
      const requested = sessionId === undefined ? undefined : llmSessionId(sessionId)
      // The recording service resolves the session the request names, so that session must be live
      // before the adapter publishes its prepared record.
      if (requested !== undefined && ctx.sessions.get(requested) === undefined) ctx.sessions.create(requested)
      const stream = route.stream({
        provider: 'claude',
        model: MODEL.id,
        messages: [],
        ...requested === undefined ? {} : { sessionId: requested },
        signal: new AbortController().signal,
      })
      try {
        for await (const chunk of stream) void chunk
        return undefined
      } catch (error: unknown) {
        return error
      }
    },
    setSource: (session, declaredScopes) => {
      source = session
      sourceScopes = declaredScopes ?? session?.scopes
    },
    stored,
    storedText: () => readFileSync(storeFile, 'utf8'),
    revision: async () => (await getAccountCredential('claude', ACCOUNT))?.revision ?? 0,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

/** The bearer one recorded call presented. */
function bearer(call: RecordedCall | undefined): string {
  return call?.authorization ?? '<no call>'
}

/** The Messages POSTs the injected transport recorded, in order. */
function messagePosts(): RecordedCall[] {
  return messagesCalls.filter(call => call.method === 'POST')
}

/** The identity-backfill profile reads the injected transport recorded, in order. */
function profileReads(): RecordedCall[] {
  return messagesCalls.filter(call => call.url.includes('/api/oauth/profile'))
}

// ---------------------------------------------------------------------------
// The real import path stamps read-only-import
// ---------------------------------------------------------------------------

test('a real RPC import stamps read-only-import, and the status reports it', async () => {
  const app = await mount(sourceSession())
  const result = await app.login()
  assert.equal(result.ok, true, JSON.stringify(result))
  const record = app.stored()
  assert.equal(record['credentialOwnershipMode'], 'read-only-import', 'the import path stamps the mode, not a test')
  assert.equal(record['keychainBound'], true, 'the imported fact is recorded as before')
  assert.equal(record['accessToken'], 'at-source-1')

  const claude = await app.status()
  const accounts = claude['accounts'] as { key: string; credentialOwnership?: unknown }[]
  assert.equal(accounts.length, 1)
  assert.deepEqual(accounts[0]?.credentialOwnership, { mode: 'read-only-import', external: true })
  assert.equal(providerCalls.length, 0, 'a status read contacts no provider and reads no external source')
  await app.dispose()
})

test('a restart keeps the stamped mode instead of re-deriving it from keychainBound', async () => {
  const app = await mount(sourceSession())
  assert.equal((await app.login()).ok, true)
  // A fresh composition over the same home is the restart: the durable record is the only input.
  const restarted = await mount(sourceSession(), { newHome: false })
  const claude = await restarted.status()
  const accounts = claude['accounts'] as { credentialOwnership?: { mode?: string } }[]
  assert.equal(accounts[0]?.credentialOwnership?.mode, 'read-only-import',
    'the stored value outranks the legacy inference a keychainBound record would otherwise take')
  await restarted.dispose()
  await app.dispose()
})

// ---------------------------------------------------------------------------
// The real request and usage paths read the source on every use
// ---------------------------------------------------------------------------

test('a first import with no identity is served from the external winner, never the stored copy', async () => {
  const app = await mount(sourceSession())
  // The import path stores the source's own shape, which states no account UUID: this request
  // must therefore complete the identity backfill before it can be built.
  assert.equal((await app.login()).ok, true)
  assert.equal(app.stored()['accountUuid'], undefined, 'the imported record starts without an identity')

  const failure = await app.request('session-1')
  assert.ok(failure instanceof LlmError, `the request was built and refused by the provider: ${String(failure)}`)
  assert.notEqual(failure.code, 'INVALID_CREDENTIAL', 'the credential path did not refuse this request')

  const profiles = profileReads()
  assert.equal(profiles.length, 1, 'the identity backfill read the profile through the real transport')
  assert.equal(bearer(profiles[0]), 'Bearer at-source-1', 'the profile read used the external winner')
  const posts = messagePosts()
  assert.equal(posts.length, 1, 'exactly one Messages POST was issued')
  assert.equal(bearer(posts[0]), 'Bearer at-source-1', 'the request presented the external winner, not at-stored')
  assert.deepEqual(grantCalls, [], 'no credential grant was spent')
  assert.deepEqual(otherCalls, [], 'no other provider request was made')

  // The backfill landed on the record the read-only use path serves from, and the mode survived
  // the write: a consumer that persists identity must not turn the account into an inferred one.
  const record = app.stored()
  assert.equal(record['credentialOwnershipMode'], 'read-only-import')
  assert.equal(record['keychainBound'], true)
  assert.equal(record['accountUuid'], 'uuid-1', 'the confirmed identity was persisted')
  assert.equal(record['deviceId'], deriveClaudeDeviceId('uuid:uuid-1'))
  await app.dispose()
})

test('a source that rotated before the first request is still served, not the seeded record', async () => {
  const app = await mount(sourceSession({ accessToken: 'at-import-time', refreshToken: 'rt-import-time' }))
  assert.equal((await app.login()).ok, true)
  // The external holder rotated after the import and before the first use.
  app.setSource(sourceSession({ accessToken: 'at-rotated', refreshToken: 'rt-rotated' }))
  await app.request('session-1')
  assert.equal(bearer(messagePosts()[0]), 'Bearer at-rotated',
    'the rotated external winner is served, and the stored import-time token is never sent')
  assert.deepEqual(grantCalls, [])
  await app.dispose()
})

test('a second rotation is served next, and the backfill is not repeated', async () => {
  const app = await mount(sourceSession())
  assert.equal((await app.login()).ok, true)
  await app.request('session-1')
  assert.equal(profileReads().length, 1, 'the identity backfill ran once')
  app.setSource(sourceSession({ accessToken: 'at-source-2', refreshToken: 'rt-source-2' }))
  await app.request('session-2')
  const posts = messagePosts()
  assert.equal(posts.length, 2)
  assert.equal(bearer(posts[1]), 'Bearer at-source-2', 'the newest external winner is served next')
  assert.equal(profileReads().length, 1, 'the confirmed identity is reused rather than re-read')
  assert.deepEqual(grantCalls, [])
  await app.dispose()
})

test('each use re-reads the source and serves the current winner', async () => {
  const app = await mount(sourceSession())
  assert.equal((await app.login()).ok, true)
  usageAnswer = () => Response.json({ five_hour: { utilization: 1, resets_at: null } })
  const first = await app.usage(true)
  assert.equal(first.ok, true, JSON.stringify(first))
  app.setSource(sourceSession({ accessToken: 'at-source-2', refreshToken: 'rt-source-2' }))
  const second = await app.usage(true)
  assert.equal(second.ok, true, JSON.stringify(second))

  const usage = providerCalls.filter(call => call.url.includes('/api/oauth/usage'))
  assert.equal(usage.length, 2)
  assert.equal(bearer(usage[0]), 'Bearer at-source-1')
  assert.equal(bearer(usage[1]), 'Bearer at-source-2', 'the rotation the external holder made is served next')
  assert.equal(app.stored()['accessToken'], 'at-source-1', 'nothing was written back into the stored record')
  assert.deepEqual(grantCalls, [], 'neither use spent a grant')
  await app.dispose()
})

test('a forced refresh after a 401 re-reads the source and never touches the grant', async () => {
  const app = await mount(sourceSession())
  assert.equal((await app.login()).ok, true)
  // The usage read is issued exactly as the client issues it: a 401 spends the one allowed
  // authentication replay, which is this plugin's forced-refresh path.
  usageAnswer = (_call, index) => {
    if (index === 0) {
      // The external holder rotates between the first attempt and the replay: the replay must
      // carry the winner the forced refresh read, not the token the first attempt used.
      app.setSource(sourceSession({ accessToken: 'at-source-2', refreshToken: 'rt-source-2' }))
      return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'expired' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }
    return Response.json({ five_hour: { utilization: 2, resets_at: null } })
  }
  const result = await app.usage(true)
  assert.equal(result.ok, true, JSON.stringify(result))
  const usage = providerCalls.filter(call => call.url.includes('/api/oauth/usage'))
  assert.equal(usage.length, 2, 'the 401 spent exactly one replay')
  assert.equal(bearer(usage[0]), 'Bearer at-source-1')
  assert.equal(bearer(usage[1]), 'Bearer at-source-2', 'the forced refresh served the source, not the stored copy')
  assert.deepEqual(grantCalls, [], 'a read-only credential never reaches the shared refresh grant')
  await app.dispose()
})

// ---------------------------------------------------------------------------
// A source that cannot serve stops the use, without a fallback and without deleting anything
// ---------------------------------------------------------------------------

test('a missing source stops the request before any provider call and keeps the stored record', async () => {
  const app = await mount(sourceSession())
  assert.equal((await app.login()).ok, true)
  const before = app.stored()
  app.setSource(undefined)

  const failure = await app.request('session-1')
  assert.ok(failure instanceof LlmError, `the request was refused: ${String(failure)}`)
  assert.equal(failure.code, 'INVALID_CREDENTIAL')
  assert.match(failure.message, /no longer holds a credential/)
  assert.equal(providerCalls.length, 0, 'the stored cached token was not served instead')
  assert.deepEqual(messagesCalls, [], 'no Messages POST and no profile read were attempted')
  assert.deepEqual(grantCalls, [], 'no grant was spent')
  assert.deepEqual(app.stored(), before, 'the stored authorization is retained, not deleted or rewritten')
  await app.dispose()
})

test('a source that declares no scopes is refused rather than served on the recorded default', async () => {
  const app = await mount(sourceSession())
  assert.equal((await app.login()).ok, true)
  const before = app.storedText()
  // The session shape still carries scopes (the record writes the pinned default set), but the
  // source itself declared none: the read-only gate reads the declaration, not the record.
  app.setSource(sourceSession(), '')
  const failure = await app.request('session-1')
  assert.ok(failure instanceof LlmError, `the request was refused: ${String(failure)}`)
  assert.equal(failure.code, 'INVALID_CREDENTIAL')
  assert.match(failure.message, /user:inference/)
  assert.deepEqual(messagePosts(), [], 'nothing was sent under an undeclared scope set')
  assert.deepEqual(grantCalls, [])
  assert.equal(app.storedText(), before, 'the refused use wrote nothing')
  await app.dispose()
})

test('a source for another account fails closed without a grant or a write', async () => {
  const app = await mount(sourceSession())
  assert.equal((await app.login()).ok, true)
  const before = app.stored()
  app.setSource(sourceSession({ emailAddress: 'someone-else@example.invalid' }))

  const failure = await app.request('session-1')
  assert.ok(failure instanceof LlmError, `the request was refused: ${String(failure)}`)
  assert.equal(failure.code, 'CLAUDE_CREDENTIAL_SOURCE_CHANGED')
  assert.equal(providerCalls.length, 0)
  assert.deepEqual(messagesCalls, [], 'no request was issued for a foreign source')
  assert.deepEqual(grantCalls, [])
  assert.deepEqual(app.stored(), before, 'the retired authorization is kept')
  await app.dispose()
})

// ---------------------------------------------------------------------------
// A concurrent write while the identity is read
//
// The identity backfill is a write to the account's own record, and a mode change or a re-login
// can land while its profile read is in flight. Each case holds that read open, lands the
// concurrent write through the real endpoint, and only then releases it — never a timer.
// ---------------------------------------------------------------------------

test('a mode change during the identity read stops the request and keeps the user\'s choice', async () => {
  const app = await mount(sourceSession({ accessToken: 'at-import-time', refreshToken: 'rt-import-time' }))
  assert.equal((await app.login()).ok, true)
  // The external holder rotated after the import, so the served winner and the stored record are
  // distinguishable tokens: a request that fell back to the record would be visible.
  app.setSource(sourceSession({ accessToken: 'at-source-winner', refreshToken: 'rt-winner' }))

  const hold = holdProfile()
  const request = app.request('session-1')
  assert.equal(
    await Promise.race([hold.started.then(() => 'profile'), request.then(() => 'settled')]),
    'profile',
    'the identity backfill reached its profile read before the concurrent write lands',
  )
  // The user moves the account onto the legacy path while that request is mid-backfill.
  const converted = await app.setOwnership('legacy-writeback', true)
  assert.equal(converted.ok, true, JSON.stringify(converted))
  const revisionAfterChoice = await app.revision()
  assert.equal(app.stored()['credentialOwnershipMode'], 'legacy-writeback')

  hold.release()
  const failure = await request
  assert.ok(failure instanceof LlmError, `the request stopped: ${String(failure)}`)
  assert.equal(failure.code, 'CLAUDE_IDENTITY_CHANGED', 'the mode moved under this request')
  assert.equal(failure.failure.retryDisposition, 'forbid', 'and nothing may resend it as it stands')

  const record = app.stored()
  assert.equal(record['credentialOwnershipMode'], 'legacy-writeback', 'the concurrent choice was not rolled back')
  assert.equal(await app.revision(), revisionAfterChoice, 'the stopped backfill did not advance the revision')
  assert.equal(record['accountUuid'], undefined, 'and it stored no identity under the mode it started from')
  assert.deepEqual(messagePosts(), [], 'no Messages POST was sent across the mode change')
  assert.deepEqual(grantCalls, [], 'no shared grant was spent')
  assert.deepEqual(otherCalls, [], 'no external store was written')

  // The next request prepares from the mode the account now states.
  await app.request('session-2')
  const posts = messagePosts()
  assert.equal(posts.length, 1, 'the next request is served under the current mode')
  assert.equal(bearer(posts[0]), 'Bearer at-import-time', 'it presents the credential that mode serves')
  assert.equal(app.stored()['credentialOwnershipMode'], 'legacy-writeback', 'and the mode is unchanged by it')
  await app.dispose()
})

test('a mode change to read-only during the identity read stops the request and is preserved', async () => {
  const app = await mount(sourceSession())
  assert.equal((await app.login()).ok, true)
  // Start from the legacy path, so this request is served from the plugin's own record and its
  // identity is what the held profile read fills in.
  assert.equal((await app.setOwnership('legacy-writeback', true)).ok, true)

  const hold = holdProfile()
  const request = app.request('session-1')
  assert.equal(
    await Promise.race([hold.started.then(() => 'profile'), request.then(() => 'settled')]),
    'profile',
    'the identity backfill reached its profile read before the concurrent write lands',
  )
  const converted = await app.setOwnership('read-only-import')
  assert.equal(converted.ok, true, JSON.stringify(converted))
  const revisionAfterChoice = await app.revision()

  hold.release()
  const failure = await request
  assert.ok(failure instanceof LlmError, `the request stopped: ${String(failure)}`)
  assert.equal(failure.code, 'CLAUDE_IDENTITY_CHANGED')
  assert.equal(failure.failure.retryDisposition, 'forbid')
  assert.equal(app.stored()['credentialOwnershipMode'], 'read-only-import', 'the user\'s choice is preserved')
  assert.equal(await app.revision(), revisionAfterChoice, 'the stopped backfill did not advance the revision')
  assert.equal(app.stored()['accountUuid'], undefined, 'and stored no identity under the legacy mode')
  assert.deepEqual(messagePosts(), [], 'no Messages POST was sent across the mode change')
  assert.deepEqual(grantCalls, [], 'no shared grant was spent')

  // The next request prepares from the read-only mode, and the external winner is what it sends.
  app.setSource(sourceSession({ accessToken: 'at-source-winner', refreshToken: 'rt-winner' }))
  await app.request('session-2')
  const posts = messagePosts()
  assert.equal(posts.length, 1)
  assert.equal(bearer(posts[0]), 'Bearer at-source-winner', 'the read-only mode is served from its source')
  assert.equal(app.stored()['credentialOwnershipMode'], 'read-only-import')
  await app.dispose()
})

test('a logout and same-token re-login during the identity read stop it without touching the record', async () => {
  const app = await mount(sourceSession({ accessToken: 'at-import-time', refreshToken: 'rt-import-time' }))
  assert.equal((await app.login()).ok, true)
  app.setSource(sourceSession({ accessToken: 'at-source-winner', refreshToken: 'rt-winner' }))

  const hold = holdProfile()
  const request = app.request('session-1')
  assert.equal(
    await Promise.race([hold.started.then(() => 'profile'), request.then(() => 'settled')]),
    'profile',
    'the identity backfill reached its profile read before the concurrent write lands',
  )
  // A logout and a re-login with the same token pair land inside that window. The token pair is
  // deliberately identical, so only the record's revision distinguishes it from the record the
  // held request was served under.
  assert.equal(await deleteAccountSession('claude', ACCOUNT), true)
  await saveAccountSession('claude', ACCOUNT, {
    accessToken: 'at-import-time',
    refreshToken: 'rt-import-time',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    emailAddress: ACCOUNT,
  })
  const revisionAfterRelogin = await app.revision()
  const relogged = app.stored()

  hold.release()
  const failure = await request
  assert.ok(failure instanceof LlmError, `the request stopped: ${String(failure)}`)
  assert.equal(failure.code, 'CLAUDE_IDENTITY_CHANGED')
  assert.equal(failure.failure.retryDisposition, 'forbid')

  const record = app.stored()
  assert.equal(record['accessToken'], relogged['accessToken'], 'the re-login is still the stored credential')
  assert.equal(record['credentialOwnershipMode'], undefined, 'the held backfill wrote no mode over it')
  assert.equal(record['accountUuid'], undefined, 'nor an identity under the retired record')
  assert.equal(await app.revision(), revisionAfterRelogin, 'the held write did not advance the revision')
  assert.deepEqual(messagePosts(), [], 'no Messages POST was sent for the retired record')
  assert.deepEqual(grantCalls, [], 'no shared grant was spent')

  // The next request prepares again, and this time its own backfill lands.
  await app.request('session-2')
  const posts = messagePosts()
  assert.equal(posts.length, 1)
  assert.equal(bearer(posts[0]), 'Bearer at-import-time', 'the request continues under the record the account holds')
  assert.equal(app.stored()['accountUuid'], 'uuid-1', 'and the identity is bound by that request')
  await app.dispose()
})

/** One refresh-window case: what Claude Code's own store answers when the record has moved on. */
interface RefreshWindowCase {
  readonly what: string
  readonly source: () => ClaudeSourceCredential | undefined
}

/**
 * Drive the production refresh routing over a store whose first read is a legacy record and whose
 * combined credential read has moved on to read-only — the window a user's mode change opens
 * between the production hook and the manager's own load. The reference is still valid but inside
 * the preempt window, so the manager refreshes and a non-permanent failure would be answered with
 * that stored reference.
 * @param readSource - what Claude Code's own store answers for this refresh.
 * @returns what the manager did: what it served, how it failed, what it wrote, and whether the
 *   account's record and Claude Code's own store survived unchanged.
 */
async function runRefreshWindow(readSource: () => ClaudeSourceCredential | undefined): Promise<{
  served?: ClaudeSession
  failure?: unknown
  saves: ClaudeSession[]
  removes: number
  externalStoreUnchanged: boolean
}> {
  freshHome()
  const legacy: ClaudeSession = {
    accessToken: 'at-same',
    refreshToken: 'rt-same',
    expiresAt: Date.now() + 60_000,
    scopes: 'user:inference',
    emailAddress: ACCOUNT,
    keychainBound: true,
  }
  const readOnly: ClaudeSession = { ...legacy, credentialOwnershipMode: 'read-only-import' }
  let record: ClaudeSession | undefined = legacy
  let removes = 0
  const saves: ClaudeSession[] = []
  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Claude (refresh-window test)',
    makeOptions: () => ({
      preemptMs: 3_600_000,
      // The production routing index.ts wires into makeOptions.refresh.
      refresh: session => refreshForClaudeOwnership(session, {
        syncClaudeCodeCredentials: true,
        readSource,
      }),
      isPermanent: isClaudePermanentRefreshError,
    }),
    // The production hook's contract over this store: it reads the record and answers only when
    // that record is read-only.
    prepareSession: async () => {
      const stored = record
      return stored !== undefined && claudeCredentialModeOf(stored) === 'read-only-import'
        ? resolveClaudeReadOnlyCredential(stored, readSource())
        : undefined
    },
    io: {
      list: async () => record === undefined ? [] : [{ key: ACCOUNT, session: record }],
      get: async () => record,
      // The one combined read the refresh cycle performs: it has moved on to read-only.
      credential: async () => ({ key: ACCOUNT, session: readOnly, revision: 4 }),
      save: async (_account, session) => { saves.push(session); record = session },
      remove: async () => { removes += 1; record = undefined },
    },
  })
  // The legacy path's write-back target: these cases assert the routing never reaches it.
  const credentialsFile = join(privateClaudeConfig, '.credentials.json')
  const externalBefore = existsSync(credentialsFile) ? readFileSync(credentialsFile, 'utf8') : undefined
  let served: ClaudeSession | undefined
  let failure: unknown
  try {
    served = await tokens.session(ACCOUNT)
  } catch (error: unknown) {
    failure = error
  }
  const externalAfter = existsSync(credentialsFile) ? readFileSync(credentialsFile, 'utf8') : undefined
  return {
    ...served === undefined ? {} : { served },
    ...failure === undefined ? {} : { failure },
    saves,
    removes,
    externalStoreUnchanged: externalAfter === externalBefore,
  }
}

test('a mode change inside the refresh window is served from the source, never a grant', async () => {
  const sourceWinner: ClaudeSession = {
    accessToken: 'at-source-winner',
    refreshToken: 'rt-source-winner',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    emailAddress: ACCOUNT,
  }
  const run = await runRefreshWindow(() => ({ session: sourceWinner, declaredScopes: 'user:inference' }))

  assert.equal(run.served?.accessToken, 'at-source-winner',
    'the read-only record is served from its external source inside the refresh window')
  assert.equal(run.served?.credentialOwnershipMode, 'read-only-import', 'with the record\'s ownership carried')
  assert.equal(run.removes, 0, 'the record is not deleted')
  assert.deepEqual(grantCalls, [], 'no token endpoint was called: a read-only record never reaches a grant')
  assert.deepEqual(otherCalls, [], 'no other provider request was made')
  assert.equal(run.externalStoreUnchanged, true, 'and nothing was written back to Claude Code\'s own store')
  assert.equal(run.saves.length, 1)
  assert.equal(run.saves[0]?.credentialOwnershipMode, 'read-only-import', 'the stored record keeps its mode')
})

/** A source session for this account, with the fields each stop case varies. */
function sourceForAccount(overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    accessToken: 'at-source-winner',
    refreshToken: 'rt-source-winner',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    emailAddress: ACCOUNT,
    ...overrides,
  }
}

for (const stop of [
  { what: 'the source is gone', source: () => undefined },
  { what: 'the source has expired', source: () => ({ session: sourceForAccount({ expiresAt: Date.now() - 1_000 }), declaredScopes: 'user:inference' }) },
  {
    what: 'the source belongs to another account',
    source: () => ({
      session: sourceForAccount({ emailAddress: 'someone-else@example.invalid' }),
      declaredScopes: 'user:inference',
    }),
  },
  {
    what: 'the source grants no inference scope',
    source: () => ({ session: sourceForAccount(), declaredScopes: 'user:profile' }),
  },
  {
    what: 'the source read itself fails',
    // A synthetic I/O failure: the translation must not depend on the reader being total today.
    source: (): ClaudeSourceCredential | undefined => {
      throw new Error('synthetic: the credential store could not be read')
    },
  },
] satisfies readonly RefreshWindowCase[]) {
  test(`a read-only refresh whose ${stop.what} stops without the stored reference`, async () => {
    const run = await runRefreshWindow(stop.source)
    const failure = run.failure

    assert.equal(run.served, undefined, 'the stored reference is never served as a fallback')
    assert.ok(failure instanceof LlmError, `the refresh stopped: ${String(failure)}`)
    assert.equal(failure.code, 'MISSING_CREDENTIAL',
      'the manager propagates the stop instead of answering with the copy it loaded')
    assert.equal(failure.failure.retryDisposition, 'forbid')
    assert.equal(run.removes, 0, 'and the record is not deleted')
    assert.deepEqual(run.saves, [], 'nothing was stored')
    assert.deepEqual(grantCalls, [], 'no token endpoint was called')
    assert.deepEqual(otherCalls, [], 'no other provider request was made')
    assert.equal(run.externalStoreUnchanged, true, 'and Claude Code\'s own store was not written')
  })
}

test('a credential backend that reports no revision refuses the read-only identity write', async t => {
  freshHome()
  // An in-memory store with no credential reader: it holds a session but cannot report the
  // revision a conditional identity write needs. Only the read-only path requires one.
  const record: ClaudeSession = {
    accessToken: 'at-stored',
    refreshToken: 'rt-stored',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    emailAddress: ACCOUNT,
    keychainBound: true,
    credentialOwnershipMode: 'read-only-import',
  }
  let stored: ClaudeSession | undefined = record
  const saves: ClaudeSession[] = []
  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Claude (revision-less backend test)',
    makeOptions: () => ({ preemptMs: 0, refresh: async current => current, isPermanent: () => false }),
    io: {
      list: async () => stored === undefined ? [] : [{ key: ACCOUNT, session: stored }],
      get: async () => stored,
      save: async (_account, session) => { saves.push(session); stored = session },
      remove: async () => { stored = undefined },
    },
  })
  const fetchFn = (async (url: unknown) => String(url).includes('/api/oauth/profile')
    ? Response.json(PROFILE_DOCUMENT)
    : new Response('', { status: 400 })) as FetchFn
  const adapter = new ClaudeAdapter({
    models: [MODEL],
    discovery: false,
    streamIdleTimeoutMs: 60_000,
    tokens,
    fetchFn,
    deviceFingerprint: () => 'synthetic-fingerprint',
    // The adapter refuses a request before it reads anything unless the route supplies what the
    // real one does: this session, the durable owner that commits its wire identity, and the
    // recorder that permits the send.
    continuation: await ownedClaudeContinuation(t, [ACCOUNT]),
    requestRecord: new PermittingRecordPort(),
  })
  await assert.rejects(
    (async () => {
      for await (const chunk of adapter.stream({
        provider: 'claude',
        model: MODEL.id,
        messages: [],
        sessionId: llmSessionId('session-identity-write'),
        signal: new AbortController().signal,
      } as never)) void chunk
    })(),
    (error: unknown) => {
      assert.ok(error instanceof LlmError, `the identity write was refused: ${String(error)}`)
      assert.equal(error.code, 'CLAUDE_IDENTITY_UNVERIFIABLE',
        'a backend that cannot express the condition refuses the write rather than comparing tokens')
      assert.equal(error.failure.retryDisposition, 'forbid')
      return true
    },
  )
  assert.deepEqual(saves, [], 'nothing was written')
  assert.equal(stored, record, 'and the record is untouched')
})

// ---------------------------------------------------------------------------
// Mode selection and conversion through the real RPC
// ---------------------------------------------------------------------------

test('an RPC conversion to legacy-writeback writes the store and states the unproven coordination', async () => {
  const app = await mount(sourceSession())
  assert.equal((await app.login()).ok, true)
  const before = app.storedText()
  const revisionBefore = (await getAccountCredential('claude', ACCOUNT))?.revision
  assert.ok(revisionBefore !== undefined, 'the logged-in record is stored under a revision')
  const converted = await app.setOwnership('legacy-writeback', true)
  assert.equal(converted.ok, true, JSON.stringify(converted))
  // The write really landed: the durable bytes changed, the record states the mode, and the
  // credential revision moved — not merely a read that re-derived something.
  assert.notEqual(app.storedText(), before, 'the conversion wrote the store')
  assert.equal(app.stored()['credentialOwnershipMode'], 'legacy-writeback')
  const revisionAfter = (await getAccountCredential('claude', ACCOUNT))?.revision
  assert.ok(revisionAfter !== undefined, 'the converted record is still stored under a revision')
  assert.ok(revisionAfter > revisionBefore, 'the accepted write bumped the credential revision')
  assert.equal(app.stored()['accessToken'], 'at-source-1', 'the credential itself is unchanged')

  const claude = await app.status()
  const accounts = claude['accounts'] as {
    credentialOwnership?: { mode?: string; external?: boolean; coordinationUnproven?: boolean }
    credential?: { state?: string }
  }[]
  assert.deepEqual(accounts[0]?.credentialOwnership, {
    mode: 'legacy-writeback',
    external: true,
    coordinationUnproven: true,
  })
  assert.equal(accounts[0]?.credential?.state, 'ready', 'the credential itself is untouched')
  // And the mode survives a restart rather than being re-derived.
  const restarted = await mount(sourceSession(), { newHome: false })
  const reread = await restarted.status()
  assert.equal(
    (reread['accounts'] as { credentialOwnership?: { mode?: string } }[])[0]?.credentialOwnership?.mode,
    'legacy-writeback',
  )
  await restarted.dispose()
  await app.dispose()
})

test('a conversion onto legacy-writeback without the risk acknowledgement is refused before any write', async () => {
  const app = await mount(sourceSession())
  assert.equal((await app.login()).ok, true)
  const before = app.storedText()

  // Absent and explicitly false are the same refusal, and neither writes anything.
  const absent = await app.setOwnership('legacy-writeback')
  assert.equal(absent.ok, false, 'the server refuses an unacknowledged conversion')
  if (!absent.ok) {
    assert.equal(absent.error.code, 'bad-request')
    assert.match(absent.error.message, /riskAcknowledged/)
  }
  assert.equal(app.storedText(), before, 'the refused conversion replaced nothing')
  assert.equal(app.stored()['credentialOwnershipMode'], 'read-only-import')

  const denied = await app.setOwnership('legacy-writeback', false)
  assert.equal(denied.ok, false)
  assert.equal(app.storedText(), before)

  // A non-boolean value is a payload error rather than a silent false.
  const malformed = await app.setOwnership('legacy-writeback', 'yes' as never)
  assert.equal(malformed.ok, false)
  if (!malformed.ok) assert.match(malformed.error.message, /payload\.riskAcknowledged/)
  assert.equal(app.storedText(), before)

  // The acknowledgement only gates a real conversion: re-requesting the current mode is an
  // exact no-op that needs none, and it still mutates nothing.
  const noop = await app.setOwnership('read-only-import')
  assert.equal(noop.ok, true, JSON.stringify(noop))
  assert.equal(app.storedText(), before, 'a no-op conversion wrote nothing at all')
  await app.dispose()
})

test('an imported token cannot be renamed into an independent authorization through the RPC', async () => {
  const app = await mount(sourceSession())
  assert.equal((await app.login()).ok, true)
  const refused = await app.setOwnership('independent-oauth')
  assert.equal(refused.ok, false)
  if (refused.ok) return
  assert.equal(refused.error.code, 'bad-request')
  assert.match(refused.error.message, /sign-in flow/)
  assert.equal(app.stored()['credentialOwnershipMode'], 'read-only-import', 'the refused change persisted nothing')

  const unknown = await app.setOwnership('shared-grant')
  assert.equal(unknown.ok, false, 'an unknown mode is refused at the endpoint')
  if (!unknown.ok) assert.match(unknown.error.message, /payload\.mode/)
  await app.dispose()
})

test('converting back to read-only-import is a setting, and an unchanged request is a no-op', async () => {
  const app = await mount(sourceSession())
  assert.equal((await app.login()).ok, true)
  assert.equal((await app.setOwnership('read-only-import')).ok, true, 're-requesting the current mode succeeds')
  assert.equal(app.stored()['credentialOwnershipMode'], 'read-only-import')
  assert.equal((await app.setOwnership('legacy-writeback', true)).ok, true)
  assert.equal((await app.setOwnership('read-only-import')).ok, true)
  assert.equal(app.stored()['credentialOwnershipMode'], 'read-only-import')
  await app.dispose()
})

test('the RPC refuses to move an account this plugin authorized itself onto an external store', async () => {
  // A browser-authorized account: the store holds its own credential and no imported fact. The
  // plugin reads the store on demand, so seeding it after the mount is a restart's own record.
  const app = await mount(sourceSession())
  const directory = join(process.env.DSH_HOME!, 'plugins', 'subscriptions')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'auth.json'), JSON.stringify({
    claude: {
      default: ACCOUNT,
      accounts: {
        [ACCOUNT]: {
          accessToken: 'at-own',
          refreshToken: 'rt-own',
          expiresAt: Date.now() + 3_600_000,
          scopes: 'user:inference',
          emailAddress: ACCOUNT,
        },
      },
    },
  }), { mode: 0o600 })

  // Acknowledged, so the real-conversion gate is passed and the refusal this case is about — an
  // account this plugin authorized itself has no Claude Code credential to move onto — is the one
  // that answers. The unacknowledged, false and non-boolean refusals keep their own case above.
  const refused = await app.setOwnership('legacy-writeback', true)
  assert.equal(refused.ok, false)
  if (!refused.ok) {
    assert.equal(refused.error.code, 'bad-request')
    assert.match(refused.error.message, /no Claude Code credential/)
  }
  assert.equal(app.stored()['accessToken'], 'at-own', 'the refused change rewrote nothing')
  assert.equal(app.stored()['credentialOwnershipMode'], undefined)
  await app.dispose()
})

// ---------------------------------------------------------------------------
// The Settings card's ownership copy is locale-owned
// ---------------------------------------------------------------------------

/** Dictionary-bound translator with `{name}` substitution, as the locale seat supplies it. */
function translateFrom(dictionary: Record<string, string>) {
  return (key: string, params?: Record<string, unknown>): string =>
    (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

test('the unproven-coordination line and the conversion copy come from both dictionaries', async () => {
  const { accountStateLines } = await import('../src/client/SubscriptionsSection.js')
  const account = {
    key: ACCOUNT,
    isDefault: true,
    credential: { state: 'external-coordination-unproven' as const },
  }
  const english = accountStateLines(account, translateFrom(en))
  assert.equal(english.length, 1, 'the legacy mode states its risk and nothing else')
  assert.equal(english[0]?.tone, 'warn', 'the coordination premise is a warning, never neutral copy')
  assert.match(english[0]?.text ?? '', /coordination with Claude Code is not proven/)
  assert.match(accountStateLines(account, translateFrom(zh))[0]?.text ?? '', /并未得到证明/)
  // The conversion that shares the grant is confirmed in the user's own language, and the
  // confirmation names the account it applies to.
  for (const dictionary of [en, zh]) {
    assert.match(dictionary.ownershipLegacyConfirm, /\{account\}/)
    assert.ok(dictionary.ownershipLegacyConfirm.length > 0)
  }
  assert.match(en.ownershipLegacyConfirm, /may be spent twice/)
})

// ---------------------------------------------------------------------------
// The ownership switch on the rendered card
// ---------------------------------------------------------------------------

/** Install the jsdom globals React and the components reach for. */
function installDom(JSDOMClass: typeof JSDOM): () => void {
  const { window: jsdomWindow } = new JSDOMClass('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const names = [
    'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent',
    'KeyboardEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ]
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const name of names) {
    const raw: unknown = jsdomWindow[name]
    if (raw === undefined) continue
    const value = typeof raw === 'function' ? (raw as (...args: never[]) => unknown).bind(jsdomWindow) : raw
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
      else Object.defineProperty(globalThis, name, descriptor)
    }
  }
}

/** A turn of the event loop plus a React flush, so a mount's reads and their render settle. */
async function settleDom(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  flushSync(() => {})
}

/** One recorded `subscriptions-auth` call the rendered card made. */
interface SectionCall {
  readonly endpoint: string
  readonly payload: Record<string, unknown>
}

/**
 * A scripted `subscriptions-auth` face whose one claude account is read-only.
 * @returns the face and the calls it recorded, excluding the roster reads.
 */
function scriptedSection(): { rpc: ConnectionHandle['rpc']; calls: SectionCall[] } {
  const calls: SectionCall[] = []
  const rpc: ConnectionHandle['rpc'] = {
    call: (_channel, endpoint, payload) => {
      if (endpoint === 'subscriptions-auth.status') {
        return Promise.resolve({
          ok: true as const,
          value: {
            providers: {
              claude: {
                busy: false,
                accounts: [{
                  key: ACCOUNT,
                  isDefault: true,
                  credential: { state: 'ready' },
                  credentialOwnership: { mode: 'read-only-import', external: true },
                }],
              },
            },
          },
        })
      }
      calls.push({ endpoint, payload: payload as Record<string, unknown> })
      return Promise.resolve({ ok: true as const, value: { ok: true } })
    },
  }
  return { rpc, calls }
}

/** The ownership switches the rendered card offers. */
function ownershipCalls(calls: readonly SectionCall[]): SectionCall[] {
  return calls.filter(call => call.endpoint === 'subscriptions-auth.setCredentialOwnership')
}

test('the ownership switch confirms before it spends the shared grant, and a cancelled dialog sends nothing', async () => {
  const dom = installDom(JSDOM)
  const originalConfirm = window.confirm
  try {
    const css = registerHooks({
      load(url, context, nextLoad) {
        return url.endsWith('.css')
          ? { format: 'module', source: 'export default {}', shortCircuit: true }
          : nextLoad(url, context)
      },
    })
    const { SubscriptionsSection } = await import('../src/client/SubscriptionsSection.js')
    const { createSubscriptionsCache } = await import('../src/client/subscriptions-cache.js')
    css.deregister()

    const { rpc, calls } = scriptedSection()
    const cache = createSubscriptionsCache(rpc)
    const asked: string[] = []
    let answer = false
    window.confirm = (message?: string) => { asked.push(message ?? ''); return answer }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    flushSync(() => {
      root.render(createElement(SubscriptionsSection, {
        rpc,
        t: translateFrom(en),
        readStatus: cache.readStatus,
        readUsage: cache.readUsage,
        useUsage: <Selected,>(selector: (state: SubscriptionsCacheState) => Selected): Selected =>
          selector(useSyncExternalStore(cache.source.subscribe, cache.source.getSnapshot, cache.source.getSnapshot)),
      }))
    })
    try {
      await settleDom()
      const button = [...document.querySelectorAll('button')]
        .find(candidate => candidate.textContent === en.ownershipUseLegacy)
      assert.ok(button !== undefined, 'the read-only account offers the switch onto legacy-writeback')

      // The user declines: the card must not reach the channel at all.
      flushSync(() => { button.click() })
      await settleDom()
      assert.equal(asked.length, 1, 'the switch asks first')
      assert.ok(asked[0]?.includes(ACCOUNT), 'the confirmation names the account it changes')
      assert.equal(ownershipCalls(calls).length, 0, 'a cancelled dialog sends no request')

      // The user accepts: exactly one request, carrying the acknowledgement the server demands.
      answer = true
      flushSync(() => { button.click() })
      await settleDom()
      assert.equal(asked.length, 2)
      const sent = ownershipCalls(calls)
      assert.equal(sent.length, 1, 'a confirmed switch sends exactly one request')
      assert.deepEqual(sent[0]?.payload, {
        provider: 'claude',
        account: ACCOUNT,
        mode: 'legacy-writeback',
        riskAcknowledged: true,
      })
    } finally {
      flushSync(() => { root.unmount() })
      container.remove()
      window.confirm = originalConfirm
    }
  } finally {
    dom()
  }
})

// ---------------------------------------------------------------------------
// Another provider with no hook behaves exactly as before
// ---------------------------------------------------------------------------

test('a provider without the use-path hook keeps the manager path', async () => {
  // The hook is wired for the Claude route alone; a Codex account resolves through the stored
  // session with no external read. The composition here mounts Codex in the same home, so the
  // status read proves the other route is served and no source reader is consulted for it.
  freshHome()
  let reads = 0
  const { Context } = await import('@deepseek-ai/cordis')
  const { createFakeConnection } = await import('./fake-connection.js')
  const plugin = await import('../src/index.js')
  const ctx = new Context()
  const fake = createFakeConnection()
  ctx.provide('connection', fake.connection)
  ctx.provide('llm', {
    failureRecoveryVersion: 1,
    registerAdapter: () => Object.assign(() => {}, { replace: () => {} }),
  })
  const directory = join(process.env.DSH_HOME!, 'plugins', 'subscriptions')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'auth.json'), JSON.stringify({
    claude: { accounts: { [ACCOUNT]: { ...sourceSession(), credentialOwnershipMode: 'read-only-import' } } },
    codex: {
      accounts: {
        'codex@example.invalid': {
          accessToken: 'at-codex',
          refreshToken: 'rt-codex',
          expiresAt: Date.now() + 3_600_000,
          accountId: 'workspace',
          emailAddress: 'codex@example.invalid',
        },
      },
    },
  }), { mode: 0o600 })
  await ctx.plugin(Object.assign(
    (inner: import('@deepseek-ai/cordis').Context) => {
      plugin.apply(inner, { providers: ['claude', 'codex'], models: { claude: [MODEL] }, pool: { enabled: false } }, {
        // A status read must never consult this reader, so the value only has to satisfy the
        // seam: the source reports the scopes its own credential declares.
        claudeCredentialSource: () => {
          reads += 1
          const session = sourceSession()
          return { session, declaredScopes: session.scopes }
        },
        policyLimitsTransport: async () => Response.json({ restrictions: {} }),
        orgPinTransport: async () => Response.json({ organization_uuid: 'org-1' }),
      })
    },
    { inject: plugin.inject },
  ))
  const result = await fake.handler('status', {}, new AbortController().signal)
  assert.ok(result.ok)
  const providers = (result.value as { providers: Record<string, { accounts: { credentialOwnership?: unknown }[] }> }).providers
  assert.equal(providers['codex']?.accounts.length, 1, 'the other route is served from the store')
  assert.equal(providers['codex']?.accounts[0]?.credentialOwnership, undefined, 'it has no ownership mode')
  assert.equal(reads, 0, 'a status read consults no external source')
  assert.equal(providerCalls.length, 0)
  await ctx.fiber.dispose()
})
