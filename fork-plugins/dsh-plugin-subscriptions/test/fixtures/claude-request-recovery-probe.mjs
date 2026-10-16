/**
 * Observe the Claude request-recovery contracts as sanitized counts and booleans.
 *
 * The probe drives the shipped `ClaudeAdapter` over the real `AccountTokenManager`, an
 * in-memory account store and an injected `fetchFn`, with synthetic credentials. No global
 * fetch, harness home, durable auth store or provider endpoint is touched, and the
 * observation carries booleans, counts and failure codes only — never a token, an
 * `Authorization` value or an account id, not even a synthetic one.
 *
 * Each turn also declares the session and the durable route facts the shipped adapter requires.
 * The shared `ownedClaudeRequest` fixture mints that session in a private composition of the Host's
 * real `SessionStore` and `SessionRequestRecordProvider`, and establishes the account with the real
 * `ClaudeContinuationState` over a temporary directory it removes when the observation ends. The
 * recording gate is therefore answered by a real append and flush into that private session, and
 * nothing enters the application's own session log.
 *
 * Three recoveries of one rejected Messages request are observed:
 *  - the rejected body is discarded, unread, before the forced refresh; the replay then
 *    streams normally on a signal that was not aborted;
 *  - the account is logged out while the refresh runs, so the refused store write leaves
 *    nothing to replay and the turn reports the provider-neutral logged-out code with no
 *    second Messages request;
 *  - another writer replaced the stored session while the refresh ran, so the persisted
 *    winner — not the grant the refused write would have stored — is what the replay
 *    carries.
 *
 * A snapshot driver applies this module as a plugin, which registers
 * `claude_request_recovery_probe` and records the one JSON observation it returns;
 * `probeClaudeRequestRecovery` stays importable on its own for direct inspection.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { AccountTokenManager } from '../../src/providers/accounts.ts'
import { ClaudeAdapter, deriveClaudeDeviceId } from '../../src/providers/claude.ts'
import { ownedClaudeRequest } from './claude-adapter-state.mjs'

export const name = 'claude-request-recovery-probe'
export const inject = ['tools']

/** Synthetic credentials and identity; module-local so no caller can observe them. */
const BASE_ACCESS = 'synthetic-base-access'
const BASE_REFRESH = 'synthetic-base-refresh'
const GRANT_ACCESS = 'synthetic-grant-access'
const GRANT_REFRESH = 'synthetic-grant-refresh'
const WINNER_ACCESS = 'synthetic-winner-access'
const WINNER_REFRESH = 'synthetic-winner-refresh'
const ACCOUNT = 'synthetic-account'
const ACCOUNT_UUID = 'synthetic-account-uuid'
const DEVICE_FINGERPRINT = 'f'.repeat(64)
const DEVICE_ID = deriveClaudeDeviceId(`uuid:${ACCOUNT_UUID}`, DEVICE_FINGERPRINT)
const EMAIL = 'synthetic@example.invalid'

/** Path fragments that separate the Messages request from the identity profile read. */
const MESSAGES_PATH = '/v1/messages'
const PROFILE_PATH = '/api/oauth/profile'

/** One completed text answer, which is all these recoveries need back. */
const RESPONSE_SSE = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"recovered"}}\n\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'data: {"type":"message_stop"}\n\n',
].join('')

/** The request these recoveries send; the session each one declares is added per recovery. */
const REQUEST = {
  provider: 'claude',
  model: 'claude-opus-4-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}

/**
 * One synthetic stored session, complete enough that no identity backfill runs.
 * @param accessToken - the synthetic access credential.
 * @param refreshToken - the synthetic refresh credential.
 * @returns the stored session.
 */
function storedSession(accessToken, refreshToken) {
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    emailAddress: EMAIL,
    subscriptionType: 'max',
    accountUuid: ACCOUNT_UUID,
    deviceId: DEVICE_ID,
  }
}

/**
 * The bearer an injected fetch received, under whichever header casing the builder chose.
 * Read only to compare; never returned from this module.
 * @param init - the request init the adapter passed.
 * @returns the bearer, or the empty string when the request carried none.
 */
function authorizationOf(init) {
  const headers = init?.headers ?? {}
  const key = Object.keys(headers).find(name => name.toLowerCase() === 'authorization')
  return key === undefined ? '' : String(headers[key])
}

/**
 * An in-memory account store whose conditional write is an explicit gate.
 *
 * The store's own compare-and-set is proven where it lives; this probe observes how the
 * token manager answers a refused write, so a refusal is a flag the scenario raises and
 * the stored session is whatever the scenario left behind.
 * @param initial - the session the store starts with.
 * @returns the `io` seam, the stored session, and the moves the scenarios drive.
 */
function memoryStore(initial) {
  let stored = initial
  let refusing = false
  let refusals = 0
  return {
    io: {
      list: async () => (stored === undefined ? [] : [{ key: ACCOUNT, session: stored }]),
      get: async () => stored,
      save: async (_account, next) => {
        if (refusing) {
          refusals += 1
          return
        }
        stored = next
      },
      remove: async () => { stored = undefined },
    },
    held: () => stored,
    refuse: () => { refusing = true },
    logout: () => { stored = undefined },
    replace: next => { stored = next },
    refusals: () => refusals,
  }
}

/**
 * The body of a rejected response, observable only through whether it was read or released.
 *
 * The zero high-water mark keeps the stream from being pulled eagerly at construction, so a
 * pull means a reader actually asked for the body rather than the queue wanting to fill.
 * @param seen - the scenario's observation record.
 * @returns the stream the rejected response carries.
 */
function rejectedBody(seen) {
  return new ReadableStream({
    pull() { seen.read = true },
    cancel() {
      seen.released = true
      seen.order.push('discard')
    },
  }, { highWaterMark: 0 })
}

/**
 * Drive one rejected-and-recovered Messages turn through the shipped adapter.
 * @param recovery - which recovery the forced refresh performs.
 * @param wire - the session and durable route facts every turn declares.
 * @returns the sanitized counts and booleans of that turn.
 */
async function recover(recovery, wire) {
  const seen = { read: false, released: false, order: [] }
  const store = memoryStore(storedSession(BASE_ACCESS, BASE_REFRESH))
  let messages = 0
  let grants = 0
  let secondBearer = ''
  let secondAborted
  let finish = 'none'
  let textDeltas = 0
  let code = 'none'

  const tokens = new AccountTokenManager({
    provider: 'claude',
    displayName: 'Claude request recovery probe',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: async (current) => {
        seen.order.push('refresh')
        grants += 1
        if (recovery === 'logout') {
          // A logout landed while the grant was in flight: nothing is stored for the account.
          store.refuse()
          store.logout()
        }
        if (recovery === 'replacement') {
          // Another writer stored its own rotation: the refused grant is never the authority.
          store.refuse()
          store.replace(storedSession(WINNER_ACCESS, WINNER_REFRESH))
        }
        return { ...current, accessToken: GRANT_ACCESS, refreshToken: GRANT_REFRESH, expiresAt: Date.now() + 3_600_000 }
      },
      isPermanent: () => false,
    }),
    io: store.io,
  })

  let rejected
  const fetchFn = async (url, init) => {
    const target = String(url)
    if (target.includes(PROFILE_PATH)) return Response.json({ account: { uuid: ACCOUNT_UUID } })
    if (!target.includes(MESSAGES_PATH)) throw new Error('the Claude adapter requested an unexpected endpoint')
    messages += 1
    if (messages === 1) {
      rejected = rejectedBody(seen)
      return new Response(rejected, { status: 401, headers: { 'content-type': 'application/json' } })
    }
    secondAborted = init?.signal?.aborted === true
    secondBearer = authorizationOf(init)
    return new Response(RESPONSE_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  const adapter = new ClaudeAdapter({
    deviceFingerprint: () => DEVICE_FINGERPRINT,
    models: [],
    discovery: false,
    streamIdleTimeoutMs: 60_000,
    tokens,
    fetchFn,
    continuation: wire.continuation,
    requestRecord: wire.requestRecord,
  })
  const caller = new AbortController()
  try {
    for await (const chunk of adapter.stream({ ...REQUEST, sessionId: wire.sessionId, signal: caller.signal })) {
      if (chunk.type === 'text-delta') textDeltas += 1
      if (chunk.type === 'finish') finish = chunk.reason.kind
    }
  } catch (error) {
    code = typeof error?.code === 'string' ? error.code : 'unknown'
  } finally {
    // The adapter releases the rejected body itself on every path that reaches the replay;
    // a turn that failed earlier still leaves nothing open behind it.
    if (rejected !== undefined && !seen.released) {
      try {
        await rejected.cancel()
      } catch (_settledBody) {
        // A body that already ended or failed has nothing left to release.
      }
    }
  }

  return {
    messages,
    grants,
    saveRefusals: store.refusals(),
    accountAbsent: store.held() === undefined,
    rejectedBodyRead: seen.read,
    rejectedBodyReleased: seen.released,
    discardedBeforeRefresh: seen.order.indexOf('discard') !== -1
      && seen.order.indexOf('discard') < seen.order.indexOf('refresh'),
    secondBearer: secondBearer === `Bearer ${WINNER_ACCESS}`
      ? 'winner'
      : secondBearer === `Bearer ${GRANT_ACCESS}` ? 'grant' : secondBearer === '' ? 'none' : 'other',
    secondAborted: secondAborted === true,
    callerAborted: caller.signal.aborted,
    finish,
    textDeltas,
    code,
  }
}

/**
 * The first recovery: a rejected request is discarded before the forced refresh and the
 * replay streams normally under the grant the store accepted.
 * @param wire - the session and durable route facts every turn declares.
 * @returns the sanitized observation of that turn.
 */
async function recoverRejected(wire) {
  const observed = await recover('grant', wire)
  return {
    rejected401CancelledBeforeRefresh: observed.discardedBeforeRefresh,
    requests: observed.messages,
    firstUnread: observed.rejectedBodyRead === false,
    secondNormal: observed.finish === 'stop' && observed.textDeltas > 0,
    secondSignalNotAborted: observed.secondAborted === false && observed.callerAborted === false,
    secondCarriedStoredGrant: observed.secondBearer === 'grant',
  }
}

/**
 * The logout recovery: the account disappears while the refresh runs, so the refused write
 * leaves no credential to replay.
 * @param wire - the session and durable route facts every turn declares.
 * @returns the sanitized observation of that turn.
 */
async function recoverAfterLogout(wire) {
  const observed = await recover('logout', wire)
  return {
    requests: observed.messages,
    noMessagesAfterRefresh: observed.messages === 1,
    code: observed.code,
    accountAbsent: observed.accountAbsent,
    rejectedBodyReleased: observed.rejectedBodyReleased,
    grants: observed.grants,
    saveRefusals: observed.saveRefusals,
  }
}

/**
 * The replacement recovery: another writer's rotation wins the store, so the replay carries
 * the persisted winner rather than the grant this refresh minted.
 * @param wire - the session and durable route facts every turn declares.
 * @returns the sanitized observation of that turn.
 */
async function recoverAfterReplacement(wire) {
  const observed = await recover('replacement', wire)
  return {
    requests: observed.messages,
    servesPersistedWinner: observed.secondBearer === 'winner',
    servesUncommittedGrant: observed.secondBearer === 'grant',
    saveRefusals: observed.saveRefusals,
    secondSignalNotAborted: observed.secondAborted === false,
  }
}

/**
 * Run every request-recovery proof over the shipped adapter.
 * @returns the compact observation the session log records.
 */
export async function probeClaudeRequestRecovery() {
  const wire = await ownedClaudeRequest('claude-request-recovery-', [ACCOUNT])
  try {
    return {
      scenario: 'claude-request-recovery',
      rejected401: await recoverRejected(wire),
      logoutDuringRefresh: await recoverAfterLogout(wire),
      casReplacement: await recoverAfterReplacement(wire),
    }
  } finally {
    await wire.close()
  }
}

/** Register the deterministic request-recovery probe with recorded output. */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'claude_request_recovery_probe',
    description: 'Prove the Claude request-recovery path through the shipped adapter and token manager: a rejected Messages body is released unread before the forced refresh and the replay streams normally under the credential the store accepted, an account removed while the refresh ran fails MISSING_CREDENTIAL with no further request and nothing stored, and another writer\'s rotation wins the store so the replay never carries the grant its refused write would have stored.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return JSON.stringify(await probeClaudeRequestRecovery())
    },
    presentCall: args => ({ card: 'generic', title: 'Inspect Claude request recovery', kind: 'other', rawInput: args }),
  })))
}
