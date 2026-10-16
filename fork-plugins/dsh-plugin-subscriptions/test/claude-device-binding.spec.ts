/**
 * Device binding for the Claude provider: what the adapter derives, writes and sends when one
 * account's device id is bound to this machine's operating-system identity.
 *
 * Every case drives the real {@link ClaudeAdapter} and {@link AccountTokenManager} over a
 * synthetic account store, an injected 64-hex fingerprint and a mocked fetch. No case reads
 * this host's machine identifier, a credential file or a network endpoint, so the suite runs
 * unchanged on a host whose own identifier is unreadable.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

import { AccountTokenManager } from '../src/providers/accounts.js'
import { DEVICE_IDENTITY_UNAVAILABLE, DeviceIdentityError } from '../src/providers/claude-device.js'
import { ClaudeAdapter, deriveClaudeDeviceId } from '../src/providers/claude.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { FetchFn } from '../src/providers/common.js'
import { ownedClaudeContinuation } from './claude-maintenance-fixtures.js'
import { PermittingRecordPort } from './recording-port.js'

/** The account uuid Messages binds a device to, as the OAuth profile discloses it. */
const UUID_A = '3f1c8a52-0d47-4b90-8e21-77c9a4f10b6d'

/** A second account, on the same machine. */
const UUID_B = '9a0e5b74-2c31-4f68-b1dd-40e7f2a83c59'

/** Synthetic machine fingerprints; neither is this host's own identifier. */
const FINGERPRINT_A = 'a1'.repeat(32)
const FINGERPRINT_B = 'b2'.repeat(32)

/** A device id an older release stored from the account alone. */
const LEGACY_DEVICE = 'c3'.repeat(32)

/** The key every synthetic store lists its account under. */
const ACCOUNT = 'acct'

/** The canonical account key one disclosed uuid is bound under. */
function accountKey(uuid: string): string {
  return `uuid:${uuid}`
}

/** The device id one account presents on one machine. */
function deviceFor(uuid: string, fingerprint: string): string {
  return deriveClaudeDeviceId(accountKey(uuid), fingerprint)
}

/** One SSE answer, enough to complete a stream through the adapter. */
const RESPONSE_SSE = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'data: {"type":"message_stop"}\n\n',
].join('')

/** The synthetic harness session every case's Messages request is recorded under. */
const SESSION = 'sess-device-binding' as NonNullable<GenerateOptions['sessionId']>

/** The generate request every case sends. */
const REQUEST = {
  provider: 'claude',
  model: 'claude-opus-4-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  sessionId: SESSION,
}

/**
 * One stored session with a current credential.
 * @param overrides - the identity fields the case varies.
 * @returns the session.
 */
function storedSession(overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    ...overrides,
  }
}

/**
 * The bearer an injected fetch saw, under whichever header casing the builder chose.
 * @param init - the request's init.
 * @returns the authorization header, or an empty string.
 */
function authorizationOf(init?: { headers?: Record<string, string> }): string {
  const headers = init?.headers ?? {}
  return Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? ''
}

/**
 * One field of a built Messages body's correlation metadata.
 * @param body - the serialized request body.
 * @param field - the metadata field to read.
 * @returns the field's value.
 */
function correlationField(body: string, field: 'device_id' | 'account_uuid'): string {
  const parsed = JSON.parse(body) as { metadata?: { user_id?: string } }
  const correlation = parsed.metadata?.user_id
  if (typeof correlation !== 'string') throw new Error('the request carried no correlation metadata')
  const identity = JSON.parse(correlation) as Record<string, unknown>
  const value = identity[field]
  if (typeof value !== 'string') throw new Error(`the correlation metadata carried no ${field}`)
  return value
}

/**
 * The device id one built Messages body presents.
 * @param body - the serialized request body.
 * @returns the device id.
 */
function deviceIdOf(body: string): string {
  return correlationField(body, 'device_id')
}

/**
 * The account uuid one built Messages body presents.
 * @param body - the serialized request body.
 * @returns the account uuid.
 */
function accountUuidOf(body: string): string {
  return correlationField(body, 'account_uuid')
}

/**
 * The durable store's own compare-and-set: a write naming a prior is refused unless that
 * prior is still the stored session.
 * @param stored - the session the store holds.
 * @param expectedPrior - the session the write was derived from.
 * @returns whether the write lands.
 */
function priorMatches(stored: ClaudeSession | undefined, expectedPrior: ClaudeSession | undefined): boolean {
  if (expectedPrior === undefined) return true
  return stored !== undefined
    && stored.accessToken === expectedPrior.accessToken
    && stored.refreshToken === expectedPrior.refreshToken
}

/** One profile answer the mocked fetch serves. */
interface ProfileAnswer {
  readonly status: number
  readonly body?: unknown
}

/** One adapter over one synthetic store, with everything it did recorded. */
interface BindingHarness {
  readonly adapter: ClaudeAdapter
  /** Every session handed to the store's save, in order. */
  readonly saves: ClaudeSession[]
  /** The prior each save named, in order. */
  readonly savePriors: (ClaudeSession | undefined)[]
  /** Every profile read, with the bearer it carried. */
  readonly profileAuthorizations: string[]
  /** Every Messages request, with the bearer it carried and the body it sent. */
  readonly messageAuthorizations: string[]
  readonly messageBodies: string[]
  /** Every URL the mocked fetch was asked for, in order. */
  readonly fetchedUrls: string[]
  /** Resolves once the first profile read is in flight. */
  readonly profileStarted: Promise<void>
  /** Lets a held profile read answer. */
  releaseProfile(): void
  stored(): ClaudeSession | undefined
  replaceStored(session: ClaudeSession | undefined): void
}

/**
 * Build one adapter over a synthetic store whose save models the durable compare-and-set.
 * @param t - the case that owns this adapter's continuation owner.
 * @param spec - the stored session, the fingerprint supplier, and the profile answers.
 * @returns the adapter and everything it did.
 */
async function bindingHarness(t: Pick<TestContext, 'after'>, spec: {
  initial: ClaudeSession
  fingerprint: () => string
  profile?: readonly ProfileAnswer[]
  holdProfile?: boolean
}): Promise<BindingHarness> {
  const profileAnswers = spec.profile ?? [{ status: 200, body: { account: { uuid: UUID_A } } }]
  let stored: ClaudeSession | undefined = spec.initial
  const saves: ClaudeSession[] = []
  const savePriors: (ClaudeSession | undefined)[] = []
  const profileAuthorizations: string[] = []
  const messageAuthorizations: string[] = []
  const messageBodies: string[] = []
  const fetchedUrls: string[] = []
  let profileCalls = 0
  let enterProfile!: () => void
  let release!: () => void
  const profileStarted = new Promise<void>((resolve) => { enterProfile = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })

  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Binding',
    makeOptions: () => ({
      preemptMs: 0,
      // Every case stores a current credential, so the refresh grant is never spent; the
      // identity write is the only writer this store sees.
      refresh: async current => current,
      isPermanent: () => false,
    }),
    io: {
      list: async () => stored === undefined ? [] : [{ key: ACCOUNT, session: stored }],
      get: async () => stored,
      save: async (_account, session, expectedPrior) => {
        saves.push(session)
        savePriors.push(expectedPrior)
        if (!priorMatches(stored, expectedPrior)) return
        stored = session
      },
      remove: async () => { stored = undefined },
    },
  })

  const fetchFn = (async (url: unknown, init?: { headers?: Record<string, string>; body?: unknown }) => {
    const target = String(url)
    fetchedUrls.push(target)
    if (target.includes('/api/oauth/profile')) {
      profileAuthorizations.push(authorizationOf(init))
      if (spec.holdProfile === true) {
        enterProfile()
        await gate
      }
      const answer = profileAnswers[Math.min(profileCalls, profileAnswers.length - 1)]!
      profileCalls += 1
      return new Response(
        answer.body === undefined ? '{}' : JSON.stringify(answer.body),
        { status: answer.status, headers: { 'content-type': 'application/json' } },
      )
    }
    messageAuthorizations.push(authorizationOf(init))
    messageBodies.push(typeof init?.body === 'string' ? init.body : '')
    return new Response(RESPONSE_SSE, { headers: { 'content-type': 'text/event-stream' } })
  }) as FetchFn

  const adapter = new ClaudeAdapter({
    models: [],
    discovery: false,
    streamIdleTimeoutMs: 60_000,
    tokens,
    fetchFn,
    deviceFingerprint: spec.fingerprint,
    continuation: await ownedClaudeContinuation(t, [ACCOUNT]),
    requestRecord: new PermittingRecordPort(),
  })

  return {
    adapter,
    saves,
    savePriors,
    profileAuthorizations,
    messageAuthorizations,
    messageBodies,
    fetchedUrls,
    profileStarted,
    releaseProfile: () => { release() },
    stored: () => stored,
    replaceStored: (session) => { stored = session },
  }
}

/**
 * Drive one Messages request to completion.
 * @param adapter - the adapter to drain.
 * @returns the chunks it produced.
 */
async function drain(adapter: ClaudeAdapter): Promise<number> {
  let chunks = 0
  for await (const _chunk of adapter.stream(REQUEST as never)) chunks += 1
  return chunks
}

test('a cache that lost the device id rebuilds the account-and-machine id with exactly one write', async (t) => {
  const harness = await bindingHarness(t, {
    initial: storedSession({ accountUuid: UUID_A }),
    fingerprint: () => FINGERPRINT_A,
  })

  await drain(harness.adapter)
  await drain(harness.adapter)

  const expected = deviceFor(UUID_A, FINGERPRINT_A)
  assert.equal(harness.stored()?.deviceId, expected, 'the id is the account-and-machine derivation')
  assert.equal(harness.saves.length, 1, 'the second request takes the already-bound fast path')
  assert.equal(harness.stored()?.accessToken, 'at-1', 'binding writes no credential')
  assert.equal(harness.profileAuthorizations.length, 0, 'a disclosed uuid needs no profile read')
  assert.deepEqual(
    harness.messageBodies.map(deviceIdOf),
    [expected, expected],
    'both requests present the same device',
  )
})

test('the same account on a second machine binds to that machine with one write', async (t) => {
  const harness = await bindingHarness(t, {
    initial: storedSession({ accountUuid: UUID_A, deviceId: deviceFor(UUID_A, FINGERPRINT_A) }),
    fingerprint: () => FINGERPRINT_B,
  })

  await drain(harness.adapter)

  const expected = deviceFor(UUID_A, FINGERPRINT_B)
  assert.notEqual(expected, deviceFor(UUID_A, FINGERPRINT_A), 'two machines are two devices')
  assert.equal(harness.stored()?.deviceId, expected)
  assert.equal(harness.saves.length, 1)
  assert.equal(harness.stored()?.accessToken, 'at-1')
  assert.equal(deviceIdOf(harness.messageBodies[0]!), expected)
})

test('a second account on one machine gets its own device, not the first account’s', async (t) => {
  const harness = await bindingHarness(t, {
    initial: storedSession({ accountUuid: UUID_B, deviceId: deviceFor(UUID_A, FINGERPRINT_A) }),
    fingerprint: () => FINGERPRINT_A,
  })

  await drain(harness.adapter)

  const expected = deviceFor(UUID_B, FINGERPRINT_A)
  assert.notEqual(expected, deviceFor(UUID_A, FINGERPRINT_A), 'two accounts are two devices')
  assert.equal(harness.stored()?.deviceId, expected)
  assert.equal(harness.saves.length, 1)
  assert.equal(deviceIdOf(harness.messageBodies[0]!), expected)
})

test('an email change under the same account uuid leaves the bound device alone', async (t) => {
  const harness = await bindingHarness(t, {
    initial: storedSession({ accountUuid: UUID_A, deviceId: deviceFor(UUID_A, FINGERPRINT_A) }),
    fingerprint: () => FINGERPRINT_A,
  })
  const expected = deviceFor(UUID_A, FINGERPRINT_A)

  await drain(harness.adapter)
  harness.replaceStored(storedSession({
    accountUuid: UUID_A,
    deviceId: expected,
    emailAddress: 'after@example.test',
  }))
  await drain(harness.adapter)
  // The profile read is best-effort at login, so a session that disclosed no address still
  // carries the uuid the device is bound to.
  harness.replaceStored(storedSession({ accountUuid: UUID_A, deviceId: expected }))
  await drain(harness.adapter)

  assert.equal(harness.saves.length, 0, 'no request rewrites the identity')
  assert.equal(harness.profileAuthorizations.length, 0, 'a known uuid never needs the profile read')
  assert.deepEqual(harness.messageBodies.map(deviceIdOf), [expected, expected, expected])
})

test('a legacy account-only device id is migrated with one write and no credential change', async (t) => {
  const harness = await bindingHarness(t, {
    initial: storedSession({
      accountUuid: UUID_A,
      deviceId: LEGACY_DEVICE,
      emailAddress: 'primary@example.test',
    }),
    fingerprint: () => FINGERPRINT_A,
  })

  await drain(harness.adapter)
  await drain(harness.adapter)

  const expected = deviceFor(UUID_A, FINGERPRINT_A)
  assert.notEqual(expected, LEGACY_DEVICE, 'the account-only value is not this machine’s derivation')
  assert.equal(harness.saves.length, 1, 'the migration is one conditional write')
  assert.equal(harness.saves[0]?.deviceId, expected)
  assert.equal(harness.savePriors[0]?.deviceId, LEGACY_DEVICE, 'the write names the session it replaces')
  assert.equal(harness.stored()?.deviceId, expected)
  assert.equal(harness.stored()?.accessToken, 'at-1')
  assert.equal(harness.stored()?.refreshToken, 'rt-1')
  assert.equal(harness.stored()?.accountUuid, UUID_A)
  assert.equal(harness.profileAuthorizations.length, 0, 'a known uuid needs no profile read')
  assert.deepEqual(
    harness.messageAuthorizations,
    ['Bearer at-1', 'Bearer at-1'],
    'the request authorization does not move with the device',
  )
  assert.equal(deviceIdOf(harness.messageBodies[0]!), expected)
})

test('a session copied from another machine rebinds, and a device-less copy rebuilds the same id', async (t) => {
  const harness = await bindingHarness(t, {
    initial: storedSession({ accountUuid: UUID_A, deviceId: deviceFor(UUID_A, FINGERPRINT_A) }),
    fingerprint: () => FINGERPRINT_B,
  })

  await drain(harness.adapter)
  const rebound = harness.stored()?.deviceId
  // The same copy losing its credential record leaves no device id to read back.
  harness.replaceStored(storedSession({ accountUuid: UUID_A }))
  await drain(harness.adapter)

  assert.equal(rebound, deviceFor(UUID_A, FINGERPRINT_B))
  assert.equal(harness.stored()?.deviceId, rebound, 'the device-less copy rebuilds the same id')
  assert.equal(harness.saves.length, 2)
  assert.deepEqual(harness.messageBodies.map(deviceIdOf), [rebound, rebound])
})

test('a session freshly bound at login to the profile uuid is served with no profile read or write', async (t) => {
  const expected = deviceFor(UUID_A, FINGERPRINT_A)
  const harness = await bindingHarness(t, {
    initial: storedSession({
      accountUuid: UUID_A,
      deviceId: expected,
      subscriptionType: 'max',
    }),
    fingerprint: () => FINGERPRINT_A,
  })

  await drain(harness.adapter)

  assert.equal(harness.saves.length, 0)
  assert.equal(harness.profileAuthorizations.length, 0)
  assert.deepEqual(harness.messageAuthorizations, ['Bearer at-1'])
  assert.equal(deviceIdOf(harness.messageBodies[0]!), expected)
  assert.equal(accountUuidOf(harness.messageBodies[0]!), UUID_A)
})

test('an unreadable local identity fails typed before any request or store write', async (t) => {
  const harness = await bindingHarness(t, {
    initial: storedSession({ accountUuid: UUID_A }),
    fingerprint: () => { throw new DeviceIdentityError('synthetic: no usable machine identifier') },
  })

  await assert.rejects(drain(harness.adapter), (error: unknown) => {
    assert.ok(error instanceof DeviceIdentityError, 'the failure keeps its own type')
    assert.ok(error instanceof LlmError, 'a classifier must return it unchanged')
    assert.equal(error.code, DEVICE_IDENTITY_UNAVAILABLE)
    return true
  })
  assert.deepEqual(harness.fetchedUrls, [], 'no request reaches the network')
  assert.deepEqual(harness.saves, [], 'no session is written')
})

test('a lost compare-and-set serves the winner credential while storage keeps the winner device', async (t) => {
  const winner = storedSession({
    accessToken: 'at-2',
    refreshToken: 'rt-2',
    accountUuid: UUID_A,
    deviceId: 'd'.repeat(64),
    emailAddress: 'primary@example.test',
  })
  const harness = await bindingHarness(t, {
    initial: storedSession({ emailAddress: 'primary@example.test' }),
    fingerprint: () => FINGERPRINT_A,
    profile: [{ status: 200, body: { account: { uuid: UUID_A } } }],
    holdProfile: true,
  })

  const pending = drain(harness.adapter)
  await harness.profileStarted
  // Another process rotates the same account's credential while the profile read is open.
  harness.replaceStored(winner)
  harness.releaseProfile()
  await pending

  assert.equal(harness.saves.length, 1, 'the refused write is the only write attempted')
  assert.equal(harness.savePriors[0]?.accessToken, 'at-1', 'the refused write named the credential the request started from')
  assert.equal(harness.stored()?.accessToken, 'at-2', 'the winner credential stays stored')
  assert.equal(harness.stored()?.refreshToken, 'rt-2')
  assert.equal(harness.stored()?.deviceId, 'd'.repeat(64), 'storage keeps the device the winner wrote')
  assert.deepEqual(harness.messageAuthorizations, ['Bearer at-2'], 'the request runs on the winner credential')
  assert.equal(
    deviceIdOf(harness.messageBodies[0]!),
    deviceFor(UUID_A, FINGERPRINT_A),
    'the outgoing request presents this machine rather than the stored device',
  )
})
