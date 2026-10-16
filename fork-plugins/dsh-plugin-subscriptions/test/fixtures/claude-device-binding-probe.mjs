/**
 * Observe the Claude device-binding contracts as sanitized booleans and counts.
 *
 * `probeClaudeDeviceBinding` drives the shipped `ClaudeAdapter` over the real
 * `AccountTokenManager`, an in-memory account store and an injected `fetchFn`, with synthetic
 * account UUIDs and synthetic 64-character fingerprints supplied through the adapter's
 * `deviceFingerprint` seam. No global fetch, harness home, credential store or provider
 * endpoint is touched, and no machine identifier is read from this host: the observation
 * carries booleans and counts only — never a derived device id, a fingerprint or a credential
 * value, not even a synthetic one.
 *
 * Each request also declares the session and the durable route facts the shipped adapter requires.
 * The shared `ownedClaudeRequest` fixture mints that session in a private composition of the Host's
 * real `SessionStore` and `SessionRequestRecordProvider`, and establishes the accounts with the
 * real `ClaudeContinuationState` over a temporary directory it removes when the observation ends.
 * The recording gate is therefore answered by a real append and flush into that private session,
 * and nothing enters the application's own session log.
 *
 * One reused fixture observes four requests: a stored legacy device id is migrated by the
 * first, losing only the cached device field rebuilds the same id, a session copied onto
 * another fingerprint is rebound to it, and a second account on the first fingerprint derives
 * a different id. Each `device_id` is read from the correlation metadata the pinned client
 * library actually built into the wire body.
 *
 * A snapshot driver applies this module as a plugin, which registers
 * `claude_device_binding_probe` and records the one JSON observation it returns;
 * `probeClaudeDeviceBinding` stays importable on its own for direct inspection.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { AccountTokenManager } from '../../src/providers/accounts.ts'
import { ClaudeAdapter } from '../../src/providers/claude.ts'
import { ownedClaudeRequest } from './claude-adapter-state.mjs'

export const name = 'claude-device-binding-probe'
export const inject = ['tools']

/** Synthetic identity; module-local so no caller can observe it. */
const ACCOUNT_A = 'synthetic-account-a'
const ACCOUNT_B = 'synthetic-account-b'
const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const FINGERPRINT_A = 'a1'.repeat(32)
const FINGERPRINT_B = 'b2'.repeat(32)
/** A device id an earlier release stored under the account; the shape this build no longer derives. */
const LEGACY_DEVICE = 'legacy-account-device-id'

/** Path fragments separating the Messages request from the identity profile read. */
const MESSAGES_PATH = '/v1/messages'
const PROFILE_PATH = '/api/oauth/profile'

/** The 64-character lowercase hex form every derived device id has. */
const DERIVED_ID = /^[0-9a-f]{64}$/u

/** One completed text answer, which is all these requests need back. */
const RESPONSE_SSE = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"bound"}}\n\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'data: {"type":"message_stop"}\n\n',
].join('')

/** The request these observations send; the session each one declares is added per observation. */
const REQUEST = {
  provider: 'claude',
  model: 'claude-opus-4-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}

/**
 * One synthetic stored session.
 * @param uuid - the account uuid the profile already disclosed.
 * @param deviceId - the cached device id, or undefined for a cache that lost only that field.
 * @returns the stored session.
 */
function sessionOf(uuid, deviceId) {
  return {
    accessToken: 'synthetic-access',
    refreshToken: 'synthetic-refresh',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    accountUuid: uuid,
    ...deviceId === undefined ? {} : { deviceId },
  }
}

/**
 * An in-memory account store whose conditional write is the durable store's compare-and-set.
 * @param account - the one account key this store holds.
 * @param session - the session it starts with.
 * @returns the `io` seam and a read of what is currently stored.
 */
function memoryStore(account, session) {
  let held = session
  return {
    io: {
      list: async () => [{ key: account, session: held }],
      get: async () => held,
      save: async (_account, next, expectedPrior) => {
        if (expectedPrior === undefined || held === expectedPrior) held = next
      },
      remove: async () => { held = undefined },
    },
    held: () => held,
  }
}

/**
 * The `device_id` the pinned client library put in a built Messages request.
 * @param body - the serialized request body the adapter passed to fetch.
 * @returns the device id, or the empty string when the body carried none.
 */
function correlationDeviceId(body) {
  const metadata = JSON.parse(String(body))?.metadata
  const userId = metadata === null || typeof metadata !== 'object' ? undefined : metadata.user_id
  const correlation = typeof userId === 'string' ? JSON.parse(userId) : undefined
  return typeof correlation?.device_id === 'string' ? correlation.device_id : ''
}

/**
 * Drive one Messages request for one account through the shipped adapter.
 * @param account - the account key the store holds.
 * @param session - the stored session the request starts from.
 * @param fingerprint - the machine fingerprint this adapter reads through its own seam.
 * @param wire - the session and durable route facts every request declares.
 * @returns the observed device id, the request counts, and whether the credential rotated.
 */
async function observe(account, session, fingerprint, wire) {
  const store = memoryStore(account, session)
  let messages = 0
  let profileReads = 0
  let deviceId = ''
  const fetchFn = async (url, init) => {
    const target = String(url)
    if (target.includes(PROFILE_PATH)) {
      profileReads += 1
      return Response.json({ account: { uuid: session.accountUuid ?? UUID_A } })
    }
    if (!target.includes(MESSAGES_PATH)) throw new Error('the Claude adapter requested an unexpected endpoint')
    messages += 1
    deviceId = correlationDeviceId(init?.body)
    return new Response(RESPONSE_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const tokens = new AccountTokenManager({
    provider: 'claude',
    displayName: 'Claude device binding probe',
    makeOptions: () => ({
      preemptMs: 0,
      // A grant that rotates the credential, so `credentialRotated` observes a real refresh
      // rather than comparing a session with itself.
      refresh: async current => ({
        ...current,
        accessToken: 'synthetic-rotated-access',
        refreshToken: 'synthetic-rotated-refresh',
      }),
      isPermanent: () => false,
    }),
    io: store.io,
  })
  const adapter = new ClaudeAdapter({
    models: [],
    discovery: false,
    streamIdleTimeoutMs: 60_000,
    tokens,
    fetchFn,
    deviceFingerprint: () => fingerprint,
    continuation: wire.continuation,
    requestRecord: wire.requestRecord,
  })
  for await (const _chunk of adapter.stream({ ...REQUEST, sessionId: wire.sessionId })) void _chunk
  const stored = store.held()
  return {
    deviceId,
    messages,
    profileReads,
    credentialRotated: stored === undefined
      || stored.accessToken !== session.accessToken
      || stored.refreshToken !== session.refreshToken,
  }
}

/**
 * Run the four device-binding observations over the shipped adapter.
 * @returns the compact sanitized observation the session log records.
 */
export async function probeClaudeDeviceBinding() {
  const wire = await ownedClaudeRequest('claude-device-binding-', [ACCOUNT_A, ACCOUNT_B])
  try {
    // A legacy account-only device id is migrated on the first request this build answers.
    const first = await observe(ACCOUNT_A, sessionOf(UUID_A, LEGACY_DEVICE), FINGERPRINT_A, wire)
    // Only the device field left the cache; the account uuid and the credential are unchanged.
    const second = await observe(ACCOUNT_A, sessionOf(UUID_A, undefined), FINGERPRINT_A, wire)
    // Device A's cached id, copied onto device B under the same account.
    const third = await observe(ACCOUNT_A, sessionOf(UUID_A, first.deviceId), FINGERPRINT_B, wire)
    // A second account on device A, carrying the same copied cache.
    const fourth = await observe(ACCOUNT_B, sessionOf(UUID_B, first.deviceId), FINGERPRINT_A, wire)
    const runs = [first, second, third, fourth]
    const derived = run => DERIVED_ID.test(run.deviceId)
    return {
      legacyMigrated: derived(first) && first.deviceId !== LEGACY_DEVICE,
      sameDeviceAfterCacheLoss: derived(second) && second.deviceId === first.deviceId,
      differentDeviceDifferentId: derived(third) && third.deviceId !== first.deviceId,
      differentAccountDifferentId: derived(fourth) && fourth.deviceId !== first.deviceId,
      tokensUnchanged: runs.every(run => !run.credentialRotated),
      noUnexpectedProfileFetch: runs.every(run => run.profileReads === 0),
      messages: runs.reduce((total, run) => total + run.messages, 0),
    }
  } finally {
    await wire.close()
  }
}

/** Register the deterministic device-binding probe with recorded output. */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'claude_device_binding_probe',
    description: 'Prove the Claude device-identity binding through the shipped adapter and token manager: a stored legacy device id is migrated without changing the credential, losing only the cached device field rebuilds the same id, the same account rebound to another machine fingerprint derives a different id, and a second account on the first fingerprint derives a different id again.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return JSON.stringify(await probeClaudeDeviceBinding())
    },
    presentCall: args => ({ card: 'generic', title: 'Inspect Claude device binding', kind: 'other', rawInput: args }),
  })))
}
