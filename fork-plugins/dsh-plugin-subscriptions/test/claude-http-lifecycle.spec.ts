/**
 * Rejected Claude HTTP responses are released without aborting their replacement requests.
 *
 * Every case that builds an adapter injects a protocol-block store over a directory it owns:
 * the store is durable and keyed by the pinned profile alone, so a refusal one case records
 * would otherwise refuse that profile for every later case in this process.
 */
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { ClaudeAdapter, deriveClaudeDeviceId, fetchClaudeUsage } from '../src/providers/claude.js'
import { CLAUDE_ERROR_BODY_LIMIT, UNCLASSIFIED_PROVIDER_ERROR_CODE } from '../src/providers/claude-failure.js'
import { CLAUDE_PROTOCOL_PROFILE } from '../src/providers/claude-protocol.js'
import { ClaudeProtocolBlockStore } from '../src/providers/claude-protocol-state.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { FetchFn } from '../src/providers/common.js'
import { PermittingRecordPort } from './recording-port.js'
import { ownedClaudeContinuation } from './claude-maintenance-fixtures.js'

const COMPLETE = [
  { type: 'message_start', message: { usage: { input_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')

/** The account uuid this file's synthetic sessions carry. */
const ACCOUNT_UUID = '00000000-0000-4000-8000-000000000001'

/** A synthetic machine fingerprint; never this host's own identifier. */
const FINGERPRINT = 'a1'.repeat(32)

/**
 * A profile document in the shape the endpoint's own schema spells it: `account` and
 * `organization` as two objects with their own identities, so an adopted uuid is one the
 * service stated rather than one this file inferred.
 */
const WIRE_PROFILE = {
  account: { uuid: ACCOUNT_UUID, email: 'wire@example.invalid', created_at: '2024-01-01T00:00:00.000Z' },
  organization: {
    uuid: '00000000-0000-4000-8000-000000000002',
    billing_type: 'subscription',
    subscription_created_at: '2024-01-01T00:00:00.000Z',
  },
}

/** A session already bound to this machine, the shape a login or an earlier request stores. */
function session(): ClaudeSession {
  return { accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference', accountUuid: ACCOUNT_UUID,
    deviceId: deriveClaudeDeviceId(`uuid:${ACCOUNT_UUID}`, FINGERPRINT) }
}

function tokens(initial: ClaudeSession, refresh: (s: ClaudeSession) => Promise<ClaudeSession>) {
  let stored = initial
  return new AccountTokenManager<ClaudeSession>({
    provider: 'claude', displayName: 'test', makeOptions: () => ({ preemptMs: 0, refresh, isPermanent: () => false }),
    io: { list: async () => [{ key: 'account', session: stored }], get: async () => stored,
      save: async (_key, next) => { stored = next }, remove: async () => {} },
  })
}

/**
 * A protocol-block store over a directory the calling case owns.
 *
 * The store is durable state keyed by provider, origin and profile fingerprint alone, so a
 * refusal one case records would refuse the pinned profile for every later case sharing the
 * default directory. The directory is removed when the case that owns it ends, after the
 * write it observed.
 * @param context - the case that owns the directory.
 * @returns the store, and the directory it writes under.
 */
async function ownedProtocolBlocks(
  context: TestContext,
): Promise<{ blocks: ClaudeProtocolBlockStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-http-lifecycle-blocks-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return { blocks: new ClaudeProtocolBlockStore({ directory }), directory }
}

/**
 * A rejected response whose body ends under the byte cap, the shape a real refusal has.
 *
 * Every path that decides on a 401 reads the body under the cap before it classifies, so a
 * body that never ends could not be classified at all: the refusals here close.
 * @param payload - the body the refusal carries.
 * @returns the response carrying it.
 */
function rejectedBody(payload = '{"error":"expired"}'): Response {
  return new Response(payload, { status: 401 })
}

/**
 * A refusal past the byte cap whose own cancellation rejects.
 *
 * The cap stops the read while the stream is still readable, which is the only state that
 * reaches the reader's cancellation of its source — so this is the branch that observes a
 * rejected cancellation.
 * @returns the response, and how often its source was asked to cancel.
 */
function oversizedRejectedBody() {
  let cancellations = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`{"error":"${'x'.repeat(CLAUDE_ERROR_BODY_LIMIT)}"}`))
    },
    cancel() { cancellations += 1; throw new Error('cancel failed') },
  })
  return { response: new Response(body, { status: 401 }), cancellations: () => cancellations }
}

/** Brand one case's synthetic session identity; the adapter chains conversation state per (account, session). */
const SessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

/**
 * One Messages send under the synthetic session its case declares.
 * @param t - the case that owns the continuation state the adapter commits under.
 * @param manager - the token manager serving the account.
 * @param fetchFn - the synthetic egress.
 * @param blocks - the protocol-block store the case owns.
 * @param sessionId - the synthetic session the send declares.
 * @returns the chunks the stream produced.
 */
async function consume(
  t: Pick<TestContext, 'after'>,
  manager: AccountTokenManager<ClaudeSession>,
  fetchFn: FetchFn,
  blocks: ClaudeProtocolBlockStore,
  sessionId: NonNullable<GenerateOptions['sessionId']>,
) {
  const adapter = new ClaudeAdapter({ models: [], discovery: false, streamIdleTimeoutMs: 60_000, tokens: manager,
    fetchFn, deviceFingerprint: () => FINGERPRINT, protocolBlocks: blocks, protocolProfile: CLAUDE_PROTOCOL_PROFILE,
    continuation: await ownedClaudeContinuation(t, ['account']), requestRecord: new PermittingRecordPort() })
  const chunks = []
  for await (const chunk of adapter.streamAccount({ provider: 'claude', model: 'claude-opus-4-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], sessionId }, 'account')) chunks.push(chunk)
  return chunks
}

test('Messages consumes and releases its rejected 401 body before the one refresh', async t => {
  const { blocks } = await ownedProtocolBlocks(t)
  const rejected = rejectedBody()
  let requests = 0
  const manager = tokens(session(), async current => {
    // The body was read and released before any refresh was attempted.
    assert.equal(rejected.bodyUsed, true, 'the refusal was parsed under the byte cap')
    assert.equal(rejected.body?.locked, false, 'no reader is left holding the body')
    return { ...current, accessToken: 'test-refreshed' }
  })
  const chunks = await consume(t, manager, async (_url, init) => {
    requests += 1
    assert.equal(init?.signal?.aborted, false)
    return requests === 1 ? rejected : new Response(COMPLETE)
  }, blocks, SessionId('sess-http-401-refresh'))
  assert.equal(requests, 2)
  assert.equal(chunks.at(-1)?.type, 'finish')
})

test('a 401 that names the client-version refusal blocks its profile without a refresh', async t => {
  const nested = JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'update required', details: { error_code: 'claude_code_version_too_old' } },
  })
  const { blocks, directory } = await ownedProtocolBlocks(t)
  let requests = 0
  let refreshed = 0
  const manager = tokens(session(), async current => {
    refreshed += 1
    return { ...current, accessToken: 'test-refreshed' }
  })
  await assert.rejects(consume(t, manager, async () => {
    requests += 1
    return rejectedBody(nested)
  }, blocks, SessionId('sess-http-version-block')), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'CLIENT_VERSION_UNSUPPORTED')
    assert.equal(error.failure.retryDisposition, 'forbid')
    assert.equal(error.failure.status, 401)
    return true
  })
  assert.equal(requests, 1, 'a structured refusal outranks the authentication replay, whatever its status')
  assert.equal(refreshed, 0, 'no credential is refreshed for a version refusal')
  const key = { provider: 'claude', origin: CLAUDE_PROTOCOL_PROFILE.origin, fingerprint: CLAUDE_PROTOCOL_PROFILE.fingerprint }
  assert.equal(await blocks.isBlocked(key), true, 'the refusal is recorded against the profile that produced it')
  // The record is durable: a store reopened over the same directory refuses the same profile,
  // so a later process starts from the same stop.
  assert.equal(await new ClaudeProtocolBlockStore({ directory }).isBlocked(key), true, 'the block outlives its writer')
  // The route refuses the blocked profile before the wire, so a retry costs no request.
  await assert.rejects(consume(t, manager, async () => {
    requests += 1
    return new Response(COMPLETE)
  }, blocks, SessionId('sess-http-version-block')), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'CLIENT_VERSION_UNSUPPORTED')
    return true
  })
  assert.equal(requests, 1, 'a blocked profile never reaches the wire')
  assert.equal(refreshed, 0)
  // Isolation: a directory this case never wrote to reports the profile clear, so the record
  // cannot refuse another case's adapter.
  const elsewhere = await ownedProtocolBlocks(t)
  assert.equal(await elsewhere.blocks.isBlocked(key), false, 'the refusal stays in the directory that recorded it')
})

test('a failed refresh leaves no unread rejected Messages body behind', async t => {
  const { blocks } = await ownedProtocolBlocks(t)
  const rejected = rejectedBody()
  const manager = tokens(session(), async () => { throw new Error('refresh failed') })
  await assert.rejects(consume(t, manager, async () => rejected, blocks, SessionId('sess-http-failed-refresh')),
    /refresh failed/)
  assert.equal(rejected.bodyUsed, true, 'the refusal was consumed before the refresh was attempted')
  assert.equal(rejected.body?.locked, false, 'the rejected body is released, not left open')
})

test('profile replay releases its rejected 401 body before requesting a refreshed identity', async t => {
  const { blocks } = await ownedProtocolBlocks(t)
  // A complete, bounded refusal: the profile read decides on its one replay only after the
  // body is read under the byte cap, which an open body could never reach.
  const rejected = rejectedBody()
  const initial = session()
  delete initial.accountUuid
  let profileReads = 0
  const manager = tokens(initial, async current => {
    assert.equal(rejected.bodyUsed, true, 'the refusal was parsed under the byte cap before the reauthorization')
    assert.equal(rejected.body?.locked, false, 'no reader is left holding the body')
    return { ...current, accessToken: 'test-refreshed' }
  })
  const chunks = await consume(t, manager, async url => {
    if (String(url).includes('/api/oauth/profile')) {
      profileReads += 1
      return profileReads === 1 ? rejected : Response.json(WIRE_PROFILE)
    }
    return new Response(COMPLETE)
  }, blocks, SessionId('sess-http-profile-replay'))
  assert.equal(profileReads, 2, 'the rejected read is replayed once under the refreshed credential')
  assert.equal(chunks.at(-1)?.type, 'finish')
})

test('usage replay releases its rejected 401 body before refreshing the shared read', async () => {
  const rejected = rejectedBody()
  let requests = 0
  const usage = await fetchClaudeUsage(session(), async (_url, init) => {
    requests += 1
    assert.equal(init?.signal?.aborted, false)
    return requests === 1 ? rejected : Response.json({ five_hour: { utilization: 20 } })
  }, undefined, async () => {
    assert.equal(rejected.bodyUsed, true, 'the refusal was parsed under the byte cap before the reauthorization')
    assert.equal(rejected.body?.locked, false, 'no reader is left holding the body')
    return 'test-refreshed'
  })
  assert.equal(requests, 2, 'the rejected read is replayed once under the refreshed credential')
  assert.equal(usage.supported, true)
})

test('an oversized rejection whose cancellation rejects is still classified and released', async t => {
  const { blocks } = await ownedProtocolBlocks(t)
  const rejected = oversizedRejectedBody()
  let requests = 0
  let refreshed = 0
  const manager = tokens(session(), async current => {
    refreshed += 1
    return current
  })
  await assert.rejects(consume(t, manager, async () => {
    requests += 1
    return rejected.response
  }, blocks, SessionId('sess-http-oversized-reject')), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, UNCLASSIFIED_PROVIDER_ERROR_CODE)
    assert.equal(error.failure.status, 401)
    return true
  })
  assert.equal(rejected.cancellations(), 1, 'the cap stops the read while the stream is open, so the reader cancels its source')
  assert.equal(rejected.response.bodyUsed, true, 'the bounded prefix was read')
  assert.equal(rejected.response.body?.locked, false, 'a rejected cancellation still leaves the reader released')
  assert.equal(requests, 1, 'an oversized envelope is not the credential rejection that replays')
  assert.equal(refreshed, 0)
})

test('a default-account change cannot move identity refresh or request attribution to another account', async t => {
  const { blocks } = await ownedProtocolBlocks(t)
  const first: ClaudeSession = { ...session(), emailAddress: 'a@example.invalid' }
  delete first.deviceId
  delete first.accountUuid
  const second = { ...session(), accessToken: 'second-access', refreshToken: 'second-refresh',
    emailAddress: 'b@example.invalid', deviceId: 'b'.repeat(64) }
  const stored = new Map<string, ClaudeSession>([['first', first], ['second', second]])
  let defaultKey = 'first'
  const refreshed: string[] = []
  const observed: string[] = []
  const manager = new AccountTokenManager<ClaudeSession>({ provider: 'claude', displayName: 'test',
    makeOptions: key => ({ preemptMs: 0, isPermanent: () => false, refresh: async current => {
      refreshed.push(key)
      return { ...current, accessToken: 'refreshed-first', refreshToken: 'rotated-first' }
    } }),
    io: {
      list: async () => [defaultKey, ...[...stored.keys()].filter(key => key !== defaultKey)]
        .map(key => ({ key, session: stored.get(key)! })),
      get: async key => {
        const value = stored.get(key ?? defaultKey)
        defaultKey = 'second'
        return value
      },
      save: async (key, value) => { stored.set(key, value) },
      remove: async key => { stored.delete(key) },
    },
  })
  let profileReads = 0
  let body = ''
  let auth = ''
  const adapter = new ClaudeAdapter({ models: [], discovery: false, streamIdleTimeoutMs: 60_000, tokens: manager,
    usageObserverFor: key => { observed.push(key); return () => {} },
    deviceFingerprint: () => FINGERPRINT,
    protocolBlocks: blocks, protocolProfile: CLAUDE_PROTOCOL_PROFILE,
    continuation: await ownedClaudeContinuation(t, ['first']),
    requestRecord: new PermittingRecordPort(),
    fetchFn: async (url, init) => {
      if (String(url).includes('/api/oauth/profile')) {
        profileReads += 1
        return profileReads === 1 ? new Response('{}', { status: 401 })
          : Response.json({ account: { uuid: ACCOUNT_UUID } })
      }
      auth = new Headers(init?.headers).get('authorization') ?? ''
      body = String(init?.body)
      return new Response(COMPLETE)
    },
  })
  for await (const chunk of adapter.stream({ provider: 'claude', model: 'claude-opus-4-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    sessionId: SessionId('sess-http-default-account') })) void chunk
  assert.deepEqual(refreshed, ['first'])
  assert.deepEqual(observed, ['first'])
  assert.equal(auth, 'Bearer refreshed-first')
  // The device is the local binding of the uuid the profile disclosed, not the login email
  // and not the account-only id the session started without.
  const metadata = JSON.parse((JSON.parse(body) as { metadata: { user_id: string } }).metadata.user_id) as {
    device_id: string
    account_uuid: string
  }
  assert.equal(metadata.account_uuid, ACCOUNT_UUID)
  assert.equal(metadata.device_id, deriveClaudeDeviceId(`uuid:${ACCOUNT_UUID}`, FINGERPRINT))
  assert.equal(stored.get('first')?.deviceId, metadata.device_id, 'the bound identity is stored for the first account')
  assert.equal(stored.get('second'), second, 'the other account is never read or written for this request')
})

test('an account lookup failure releases the caller abort listener', async t => {
  const { blocks } = await ownedProtocolBlocks(t)
  const signal = new AbortController().signal
  const manager = new AccountTokenManager<ClaudeSession>({ provider: 'claude', displayName: 'test',
    makeOptions: () => ({ preemptMs: 0, refresh: async value => value, isPermanent: () => false }),
    io: { list: async () => { throw new Error('store failed') }, get: async () => undefined,
      save: async () => {}, remove: async () => {} },
  })
  const adapter = new ClaudeAdapter({ models: [], discovery: false, streamIdleTimeoutMs: 60_000, tokens: manager,
    fetchFn: async () => { throw new Error('unexpected fetch') },
    deviceFingerprint: () => FINGERPRINT,
    protocolBlocks: blocks, protocolProfile: CLAUDE_PROTOCOL_PROFILE,
    requestRecord: new PermittingRecordPort(),
  })
  await assert.rejects(async () => {
    for await (const chunk of adapter.stream({ provider: 'claude', model: 'claude-opus-4-5', signal, messages: [],
      sessionId: SessionId('sess-http-lookup-failure') })) void chunk
  }, /store failed|request failed/)
  assert.equal(getEventListeners(signal, 'abort').length, 0)
})
