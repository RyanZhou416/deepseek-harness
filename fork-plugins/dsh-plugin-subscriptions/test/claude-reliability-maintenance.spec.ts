/**
 * The Claude route's maintenance seam and its read helpers: the structured profile reader
 * (a refusal keeps its ordered decision), the settings-role fetch, and the attempt hooks —
 * where a pre-request refusal stops the request while a diagnostic hook failure never
 * replaces the attempt's own outcome. Every fetch is synthetic.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { claudeProfileReader, claudeSettingsFetch, deriveClaudeDeviceId, fetchClaudeProfile } from '../src/providers/claude.js'
import { ClaudeAdapter } from '../src/providers/claude.js'
import type { ClaudeAccountAttempt, ClaudeAccountOutcome, ClaudeMaintenanceHooks } from '../src/providers/claude.js'
import { CLAUDE_PROTOCOL_PROFILE } from '../src/providers/claude-protocol.js'
import { ClaudeProtocolBlockStore } from '../src/providers/claude-protocol-state.js'
import { CLAUDE_ERROR_BODY_LIMIT, CLIENT_VERSION_UNSUPPORTED_CODE } from '../src/providers/claude-failure.js'
import { CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED } from '../src/providers/claude-wire-record.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { FetchFn } from '../src/providers/common.js'
import { ownedClaudeContinuation } from './claude-maintenance-fixtures.js'
import { PermittingRecordPort } from './recording-port.js'

const MODEL = 'claude-opus-4-5'
const ACCOUNT_UUID = '00000000-0000-4000-8000-000000000001'
const FINGERPRINT = 'a1'.repeat(32)
const SessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

/** A synthetic session already bound to this machine. */
function session(): ClaudeSession {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference user:profile',
    accountUuid: ACCOUNT_UUID,
    deviceId: deriveClaudeDeviceId(`uuid:${ACCOUNT_UUID}`, FINGERPRINT),
  }
}

/**
 * An adapter over one synthetic account.
 * @param t - the case that owns this adapter's continuation owner.
 * @param fetchFn - the synthetic egress.
 * @param maintenance - the hooks under test.
 * @returns the adapter and a cleanup for its store directory.
 */
async function adapter(
  t: Pick<TestContext, 'after'>,
  fetchFn: FetchFn,
  maintenance?: ClaudeMaintenanceHooks,
): Promise<{ adapter: ClaudeAdapter; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-maintenance-blocks-'))
  let stored = session()
  const manager = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'maintenance',
    // A forced refresh rotates the credential, the shape a rejected request produces.
    makeOptions: () => ({
      preemptMs: 0,
      isPermanent: () => false,
      refresh: async current => ({ ...current, accessToken: `${current.accessToken}-rotated` }),
    }),
    io: {
      list: async () => [{ key: 'a1', session: stored }],
      get: async () => stored,
      save: async (_key, value) => { stored = value },
      remove: async () => {},
    },
  })
  const adapter = new ClaudeAdapter({
    models: [],
    discovery: false,
    streamIdleTimeoutMs: 5_000,
    tokens: manager,
    fetchFn,
    deviceFingerprint: () => FINGERPRINT,
    protocolBlocks: new ClaudeProtocolBlockStore({ directory }),
    continuation: await ownedClaudeContinuation(t, ['a1']),
    requestRecord: new PermittingRecordPort(),
    ...maintenance === undefined ? {} : { maintenance },
  })
  return { adapter, directory }
}

/** A complete synthetic answer. */
const COMPLETE = [
  { type: 'message_start', message: { usage: { input_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')

test('the profile reader keeps a refusal structured instead of reporting missing data', async () => {
  const version = JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'update required', details: { error_code: 'claude_code_version_too_old' } },
  })
  const reader = (status: number, body: string): ReturnType<typeof claudeProfileReader> =>
    claudeProfileReader({ fetchFn: async () => new Response(body, { status }) })
  assert.deepEqual(
    await reader(200, JSON.stringify({
      account: { uuid: ACCOUNT_UUID, email: 'a@example.test', created_at: '2025-01-01T00:00:00Z' },
      organization: { uuid: 'org-1', billing_type: 'stripe', subscription_created_at: '2025-01-02T00:00:00Z' },
      subscriptionType: 'max',
    }))({ account: 'a1', accessToken: 'at-1', signal: new AbortController().signal }),
    {
      outcome: 'ok',
      complete: true,
      fields: { emailAddress: 'a@example.test', subscriptionType: 'max', accountUuid: ACCOUNT_UUID, organization: 'org-1' },
    },
  )
  const refused = await reader(400, version)({ account: 'a1', accessToken: 'at-1', signal: new AbortController().signal })
  assert.ok(refused.outcome === 'refused' && refused.failure !== undefined)
  assert.equal(refused.failure.reason, CLIENT_VERSION_UNSUPPORTED_CODE)
  assert.equal(refused.failure.retryDisposition, 'forbid')
  assert.equal(refused.failure.scope, 'provider-profile')

  const unauthorized = await reader(401, '{"error":"expired"}')({ account: 'a1', accessToken: 'at-1', signal: new AbortController().signal })
  assert.equal(unauthorized.outcome, 'unauthorized')
  // A document that carries neither of the two objects the endpoint serves is not adopted.
  const shapeless = await reader(200, '{}')({ account: 'a1', accessToken: 'at-1', signal: new AbortController().signal })
  assert.equal(shapeless.outcome, 'invalid')
  const unreachable = await claudeProfileReader({ fetchFn: async () => { throw new Error('dns') } })(
    { account: 'a1', accessToken: 'at-1', signal: new AbortController().signal },
  )
  assert.equal(unreachable.outcome, 'unreachable')
  const cancelled = new AbortController()
  cancelled.abort()
  const stopped = await claudeProfileReader({ fetchFn: async () => { throw cancelled.signal.reason } })(
    { account: 'a1', accessToken: 'at-1', signal: cancelled.signal },
  )
  assert.equal(stopped.outcome, 'cancelled')
})

test('the profile reader validates the wire shape and reports the client completeness verdict', async () => {
  const read = (payload: unknown): Promise<Awaited<ReturnType<typeof fetchClaudeProfile>>> =>
    fetchClaudeProfile({ accessToken: 'at-1', fetchFn: async () => Response.json(payload) })
  // The document the endpoint's own schema types: `account{uuid,email,...}` and
  // `organization{uuid,billing_type,...,subscription_created_at}`.
  const completeWire = {
    account: { uuid: ACCOUNT_UUID, email: 'wire@example.test', created_at: '2025-01-01T00:00:00Z' },
    organization: {
      uuid: 'org-wire-uuid',
      name: 'Wire Org',
      billing_type: 'stripe',
      subscription_created_at: '2025-01-02T00:00:00Z',
    },
    subscriptionType: null,
  }

  const wire = await read(completeWire)
  assert.ok(wire.outcome === 'ok')
  assert.deepEqual(wire.fields, {
    emailAddress: 'wire@example.test',
    // An explicit null is this account's stated subscription type, not an absent field.
    subscriptionType: null,
    accountUuid: ACCOUNT_UUID,
    organization: 'org-wire-uuid',
  })
  assert.equal(wire.complete, true, 'an organization billing type, account creation and subscription creation are complete')

  // An unknown or absent subscription type is not a completeness criterion: the plan is simply
  // not readable, and re-reading would never learn more.
  const unknownPlan = await read({ ...completeWire, subscriptionType: undefined })
  assert.ok(unknownPlan.outcome === 'ok')
  assert.equal('subscriptionType' in unknownPlan.fields, false, 'nothing invents a null')
  assert.equal(unknownPlan.complete, true, 'completeness never depends on the plan label')

  // Each missing criterion is reported, and none of them stops the read from being adopted.
  for (const [label, payload] of [
    ['organization billing type', { ...completeWire, organization: { ...completeWire.organization, billing_type: null } }],
    ['account creation', { ...completeWire, account: { ...completeWire.account, created_at: undefined } }],
    ['subscription creation', { ...completeWire, organization: { ...completeWire.organization, subscription_created_at: null } }],
  ] as const) {
    const partial = await read(payload)
    assert.ok(partial.outcome === 'ok', `${label}: the read is still adopted`)
    assert.equal(partial.complete, false, `${label}: the document is incomplete`)
    assert.equal(partial.fields.accountUuid, ACCOUNT_UUID, `${label}: the identity is still usable`)
  }

  // The billing type lives on the organization: a root-level copy is a different field and
  // cannot complete a document whose organization left it unstated.
  const rootBillingOnly = await read({
    ...completeWire,
    billing_type: 'stripe',
    organization: { ...completeWire.organization, billing_type: undefined },
  })
  assert.ok(rootBillingOnly.outcome === 'ok')
  assert.equal(rootBillingOnly.complete, false, 'a root billing_type is not the organization field')

  // And the organization's own field completes the document with no root-level copy at all.
  const organizationBillingOnly = await read({ ...completeWire, billing_type: undefined })
  assert.ok(organizationBillingOnly.outcome === 'ok')
  assert.equal(organizationBillingOnly.complete, true, 'the organization billing type is the criterion')

  // The two objects the endpoint serves are required, and so are the account's own uuid and
  // email: half an identity is never adopted, and the verdict is never computed for a document
  // the service did not send.
  const noOrganization = await read({ ...completeWire, organization: undefined })
  assert.equal(noOrganization.outcome, 'invalid')
  const noAccount = await read({ ...completeWire, account: undefined })
  assert.equal(noAccount.outcome, 'invalid')
  const missingUuid = await read({
    ...completeWire,
    organization: { ...completeWire.organization, uuid: undefined },
  })
  assert.equal(missingUuid.outcome, 'invalid')
  const missingAccountEmail = await read({
    ...completeWire,
    account: { ...completeWire.account, email: undefined },
  })
  assert.equal(missingAccountEmail.outcome, 'invalid', 'account.email is a required wire field')
  // An address under another key, or at the root, is not that field.
  const addressUnderAnotherKey = await read({
    ...completeWire,
    account: { ...completeWire.account, email: undefined, email_address: 'wire@example.test' },
    emailAddress: 'wire@example.test',
  })
  assert.equal(addressUnderAnotherKey.outcome, 'invalid', 'email_address cannot stand in for account.email')

  // The tolerant flat document stays available to the two legacy callers only.
  const flat = await read({ account: { uuid: ACCOUNT_UUID }, organization: 'legacy-org' })
  assert.equal(flat.outcome, 'invalid', 'the maintenance reader is strict about the wire shape')
  const legacy = await fetchClaudeProfile({
    accessToken: 'at-1',
    legacyFlatPayload: true,
    fetchFn: async () => Response.json({ account: { uuid: ACCOUNT_UUID }, organization: 'legacy-org' }),
  })
  assert.ok(legacy.outcome === 'ok')
  assert.equal(legacy.fields.organization, 'legacy-org')
  assert.equal(legacy.complete, false, 'a legacy document is not credited with fields it never stated')

  // A successful document larger than the byte cap is not accepted, and nothing raw is retained.
  const oversized = JSON.stringify({ ...completeWire, padding: 'x'.repeat(CLAUDE_ERROR_BODY_LIMIT + 1) })
  const over = await fetchClaudeProfile({ accessToken: 'at-1', fetchFn: async () => new Response(oversized) })
  assert.equal(over.outcome, 'invalid')
  assert.equal('cause' in over, false, 'an over-cap document is not attached as a cause')
})

test('a failed turn reported as a finish value is a failed attempt for the maintenance seam', async (t) => {
  // The translator reports an unsupported stop reason as a terminal value rather than a throw.
  // The attempt therefore ended on that failure, and the seam must not hear "completed".
  const stream = [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  const outcomes: ClaudeAccountOutcome[] = []
  const harness = await adapter(t, async () => new Response(stream), {
    onAttemptResult: outcome => { outcomes.push(outcome) },
  })
  try {
    const chunks: StreamChunk[] = []
    for await (const chunk of harness.adapter.streamAccount({ provider: 'claude', model: MODEL,
      sessionId: SessionId('session-failed-finish'), messages: [] }, 'a1')) {
      chunks.push(chunk)
    }
    const finish = chunks.at(-1)
    assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error', 'the turn failed as a value')
    assert.equal(finish.reason.failure.code, 'UNSUPPORTED_RESPONSE')
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0]?.status, 'failed', 'an error finish is not a completed attempt')
    assert.equal(outcomes[0]?.delivered, true)
    assert.equal(outcomes[0]?.error?.code, 'UNSUPPORTED_RESPONSE')
    assert.equal(outcomes[0]?.failure?.reason, 'UNSUPPORTED_RESPONSE')
    assert.equal(outcomes[0]?.failure?.scope, 'operation')
  } finally {
    await rm(harness.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('a profile 401 that names the version refusal never refreshes the credential', async () => {
  const nested = JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'update required',
      details: { error_code: 'claude_code_version_too_old' },
    },
  })
  let refreshes = 0
  const result = await fetchClaudeProfile({
    accessToken: 'at-1',
    fetchFn: async () => new Response(nested, { status: 401 }),
    reauthorize: async () => {
      refreshes += 1
      return 'at-2'
    },
  })
  assert.equal(refreshes, 0, "a structured refusal outranks the read's one replay")
  assert.ok(result.outcome === 'refused' && result.failure !== undefined)
  assert.equal(result.failure.reason, CLIENT_VERSION_UNSUPPORTED_CODE)
  assert.equal(result.failure.retryDisposition, 'forbid')

  // An ordinary 401 gets its one controlled replay, and succeeds when that replay does.
  let ordinary = 0
  let reads = 0
  const replayed = await fetchClaudeProfile({
    accessToken: 'at-1',
    fetchFn: async () => {
      reads += 1
      return reads === 1
        ? new Response('{"error":"expired"}', { status: 401 })
        : Response.json({ account: { uuid: ACCOUNT_UUID, email: 'a@example.test' }, organization: { uuid: 'org-1' } })
    },
    reauthorize: async () => {
      ordinary += 1
      return 'at-2'
    },
  })
  assert.equal(ordinary, 1, 'exactly one refresh for an ordinary rejection')
  assert.equal(reads, 2, 'the replay is issued once')
  assert.equal(replayed.outcome, 'ok')

  // A second rejection after that replay stops the read instead of cycling.
  let exhausted = 0
  const repeated = await fetchClaudeProfile({
    accessToken: 'at-1',
    fetchFn: async () => new Response('{"error":"expired"}', { status: 401 }),
    reauthorize: async () => {
      exhausted += 1
      return 'at-2'
    },
  })
  assert.equal(exhausted, 1, 'the refresh budget is spent once, not per rejection')
  assert.ok(repeated.outcome === 'unauthorized' && repeated.failure !== undefined)
  assert.equal(repeated.failure.retryDisposition, 'forbid')
})

test('the settings fetch carries the settings role headers and its own conditional request', async () => {
  const seen: { url: string; headers: Headers }[] = []
  const fetchSettings = claudeSettingsFetch({
    fetchFn: async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) })
      return new Response('{}', { status: 200 })
    },
  })
  await fetchSettings({ account: 'a1', accessToken: 'at-1', ifNoneMatch: 'W/"abc"', signal: new AbortController().signal })
  assert.equal(seen[0]?.url, CLAUDE_PROTOCOL_PROFILE.endpoints.settings)
  assert.equal(seen[0]?.headers.get('authorization'), 'Bearer at-1')
  assert.equal(seen[0]?.headers.get('if-none-match'), 'W/"abc"')
  assert.equal(seen[0]?.headers.get('user-agent'), CLAUDE_PROTOCOL_PROFILE.plainUserAgent)
  assert.equal(seen[0]?.headers.get('anthropic-beta'), 'oauth-2025-04-20')
  assert.equal(seen[0]?.headers.get('anthropic-client-version'), null, 'the settings role does not borrow the Messages plan')
  // The two cache directives the client sends unconditionally on this read, asserted on the
  // request the endpoint would actually receive rather than on the profile object alone.
  assert.equal(seen[0]?.headers.get('cache-control'), 'no-cache')
  assert.equal(seen[0]?.headers.get('pragma'), 'no-cache')
})

test('the before hook sees the live attempt and may refuse it hard', async (t) => {
  const attempts: ClaudeAccountAttempt[] = []
  const urls: string[] = []
  const observer = new AbortController()
  const harness = await adapter(t, async (url, init) => {
    urls.push(String(url))
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer at-1')
    return new Response(COMPLETE)
  }, {
    beforeAccountRequest: (attempt) => { attempts.push(attempt) },
  })
  try {
    for await (const _chunk of harness.adapter.streamAccount({ provider: 'claude', model: MODEL,
      sessionId: SessionId('session-1'), signal: observer.signal, messages: [] }, 'a1')) { /* drain */ }
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0]?.account, 'a1')
    assert.equal(attempts[0]?.sessionId, 'session-1')
    assert.equal(attempts[0]?.signal, observer.signal, 'the caller signal is offered, not the watchdog abort')
  } finally {
    await rm(harness.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }

  // A caller that supplied no session id gets no session id: the route refuses a request that
  // names no session before any attempt exists, so no consumer can bind one for it.
  const anonymous = await adapter(t, async () => new Response(COMPLETE), {
    beforeAccountRequest: (attempt) => { attempts.push(attempt) },
  })
  try {
    await assert.rejects(async () => {
      for await (const _chunk of anonymous.adapter.streamAccount({ provider: 'claude', model: MODEL, messages: [] }, 'a1')) { /* drain */ }
    }, (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED)
      assert.equal(error.failure.retryDisposition, 'forbid')
      return true
    })
    assert.equal(attempts.length, 1, 'the sessionless caller never entered the maintenance hook')
  } finally {
    await rm(anonymous.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }

  // A refusal from the hook stops the request before it is sent and carries the hard stop.
  const blocked = await adapter(t, async () => {
    urls.push('unexpected')
    return new Response(COMPLETE)
  }, {
    beforeAccountRequest: () => { throw new LlmError('policy blocked this session', 'POLICY_BLOCKED') },
  })
  try {
    await assert.rejects(async () => {
      for await (const _chunk of blocked.adapter.streamAccount({ provider: 'claude', model: MODEL,
        sessionId: SessionId('session-blocked'), messages: [] }, 'a1')) { /* drain */ }
    }, (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'POLICY_BLOCKED')
      assert.equal(error.failure.retryDisposition, 'forbid')
      return true
    })
    assert.deepEqual(urls.length, 1, 'the refused request never reached the wire')
  } finally {
    await rm(blocked.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('the pre-request hook runs again before the authentication replay', async (t) => {
  const attempts: ClaudeAccountAttempt[] = []
  const authorizations: string[] = []
  let requests = 0
  const harness = await adapter(t, async (_url, init) => {
    requests += 1
    authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
    // The first attempt is rejected; the replayed one is the request after the rotation.
    return requests === 1 ? new Response('{"error":"expired"}', { status: 401 }) : new Response(COMPLETE)
  }, {
    beforeAccountRequest: (attempt) => { attempts.push(attempt) },
  })
  try {
    for await (const _chunk of harness.adapter.streamAccount({ provider: 'claude', model: MODEL,
      sessionId: SessionId('session-1'), messages: [] }, 'a1')) { /* drain */ }
    assert.equal(attempts.length, 2, 'the hook also runs before the replayed wire request')
    assert.equal(attempts[1]?.session.accessToken, 'at-1-rotated',
      'the maintenance owner observes the credential this request replaced')
    assert.deepEqual(authorizations, ['Bearer at-1', 'Bearer at-1-rotated'])
  } finally {
    await rm(harness.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('attempt hooks observe the terminal shape and their own failures never replace it', async (t) => {
  const outcomes: ClaudeAccountOutcome[] = []
  const warnings: string[] = []
  const harness = await adapter(t, async () => new Response(COMPLETE), {
    onAttemptResult: (outcome) => { outcomes.push(outcome) },
    onAttemptEnd: () => { throw new Error('diagnostic sink unavailable') },
  })
  try {
    const chunks: StreamChunk[] = []
    for await (const chunk of harness.adapter.streamAccount({ provider: 'claude', model: MODEL,
      sessionId: SessionId('session-hooks'), messages: [] }, 'a1')) {
      chunks.push(chunk)
    }
    assert.equal(chunks.at(-1)?.type, 'finish', 'a hook failure never replaces the completed stream')
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0]?.status, 'completed')
    assert.equal(outcomes[0]?.delivered, true)
    // Attempt end means this attempt ended, not that the session was released: nothing in the
    // outcome claims a binding lifetime.
    assert.equal('released' in (outcomes[0] ?? {}), false)
    assert.deepEqual(warnings, [])
  } finally {
    await rm(harness.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }

  // A failing diagnostic hook is reported through onWarn and nothing else changes.
  const warned = await (async () => {
    const collected: string[] = []
    const directory = await mkdtemp(join(tmpdir(), 'claude-maintenance-warn-'))
    const stored = session()
    const manager = new AccountTokenManager<ClaudeSession>({
      provider: 'claude', displayName: 'maintenance',
      makeOptions: () => ({ preemptMs: 0, isPermanent: () => false, refresh: async current => current }),
      io: { list: async () => [{ key: 'a1', session: stored }], get: async () => stored, save: async () => {}, remove: async () => {} },
    })
    const instance = new ClaudeAdapter({
      models: [], discovery: false, streamIdleTimeoutMs: 5_000, tokens: manager,
      fetchFn: async () => new Response(COMPLETE),
      deviceFingerprint: () => FINGERPRINT,
      protocolBlocks: new ClaudeProtocolBlockStore({ directory }),
      continuation: await ownedClaudeContinuation(t, ['a1']),
      requestRecord: new PermittingRecordPort(),
      onWarn: message => { collected.push(message) },
      maintenance: {
        onAttemptResult: () => { throw new Error('first diagnostic failed') },
        onAttemptEnd: () => { throw new Error('second diagnostic failed') },
      },
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of instance.streamAccount({ provider: 'claude', model: MODEL,
      sessionId: SessionId('session-warn'), messages: [] }, 'a1')) chunks.push(chunk)
    assert.equal(chunks.at(-1)?.type, 'finish')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    return collected
  })()
  assert.equal(warned.length, 2)
  assert.ok(warned.every(message => message.includes('claude maintenance')))
  assert.deepEqual(warnings, [])
})
