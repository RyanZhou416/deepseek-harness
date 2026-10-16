/**
 * Observe the Claude identity-refresh fix as four sanitized facts.
 *
 * `probeClaudeIdentityRefresh` drives the shipped `ClaudeAdapter` over a synthetic
 * pre-upgrade session whose profile read is rejected once, through an injected
 * `fetchFn` and an in-memory `AccountTokenManager` IO seam. No global fetch is
 * called, no harness home, auth store, credential or provider endpoint is touched,
 * and the observation carries booleans and counts only — never a token value, not
 * even a synthetic one.
 *
 * The request also declares the session and the durable route facts the shipped adapter
 * requires. The shared `ownedClaudeRequest` fixture mints that session in a private composition of
 * the Host's real `SessionStore` and `SessionRequestRecordProvider`, and establishes the account
 * with the real `ClaudeContinuationState` over a temporary directory it removes when the
 * observation ends. The recording gate is therefore answered by a real append and flush into that
 * private session, and nothing enters the application's own session log.
 *
 * A snapshot driver imports the helper and records what it returns; this module
 * registers nothing on its own.
 */

import { AccountTokenManager } from '../../src/providers/accounts.ts'
import { ClaudeAdapter } from '../../src/providers/claude.ts'
import { ownedClaudeRequest } from './claude-adapter-state.mjs'

/** Synthetic credentials; module-local so no caller can observe them. */
const INITIAL_ACCESS = 'synthetic-initial-access'
const INITIAL_REFRESH = 'synthetic-initial-refresh'
const ROTATED_ACCESS = 'synthetic-rotated-access'
const ROTATED_REFRESH = 'synthetic-rotated-refresh'
const ACCOUNT_UUID = 'synthetic-account-uuid'

/** The account key the synthetic store holds and the continuation owner is established for. */
const ACCOUNT = 'synthetic-account'

/** One completed text answer, which is all this probe needs back. */
const RESPONSE_SSE = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'data: {"type":"message_stop"}\n\n',
].join('')

/** The request the probe sends; the session it declares is added when the request is driven. */
const REQUEST = {
  provider: 'claude',
  model: 'claude-opus-4-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}

/**
 * The bearer an injected fetch saw, under whichever header casing the builder chose.
 * @param init - the request init the adapter passed.
 * @returns the bearer, or the empty string when the request carried none.
 */
function authorizationOf(init) {
  const headers = init?.headers ?? {}
  const key = Object.keys(headers).find(name => name.toLowerCase() === 'authorization')
  return key === undefined ? '' : String(headers[key])
}

/**
 * Drive one request through the shipped adapter over synthetic credentials and report
 * whether the identity backfill kept the credential its own profile replay rotated.
 *
 * @returns the sanitized observation: how many refresh grants and profile reads the
 *   request cost, whether the Messages request carried the refreshed credential, and
 *   whether the stored session kept both the rotation and the backfilled identity.
 */
export async function probeClaudeIdentityRefresh() {
  const wire = await ownedClaudeRequest('claude-identity-refresh-', [ACCOUNT])
  try {
    let stored = {
      accessToken: INITIAL_ACCESS,
      refreshToken: INITIAL_REFRESH,
      expiresAt: Date.now() + 3_600_000,
      scopes: 'user:inference',
    }
    let refreshCount = 0
    let profileAttempts = 0
    let messageUsedRefreshedCredential = false

    const tokens = new AccountTokenManager({
      provider: 'claude',
      displayName: 'Identity refresh probe',
      makeOptions: () => ({
        preemptMs: 0,
        // The one grant the rejected profile read is allowed to cost. Like `refreshClaude`, it
        // mints a throwaway device id when the session it refreshed carried none.
        refresh: async (current) => {
          refreshCount += 1
          return {
            ...current,
            accessToken: ROTATED_ACCESS,
            refreshToken: ROTATED_REFRESH,
            expiresAt: Date.now() + 3_600_000,
            deviceId: current.deviceId ?? 'synthetic-throwaway-device',
          }
        },
        isPermanent: () => false,
      }),
      io: {
        list: async () => [{ key: ACCOUNT, session: stored }],
        get: async () => stored,
        save: async (_account, session, expectedPrior) => {
          // The durable store's compare-and-set, in memory: a write that names a prior
          // lands only while that prior is still the stored session.
          if (expectedPrior !== undefined
            && (stored.accessToken !== expectedPrior.accessToken || stored.refreshToken !== expectedPrior.refreshToken)) {
            return
          }
          stored = session
        },
        remove: async () => { stored = undefined },
      },
    })

    const fetchFn = async (url, init) => {
      const target = String(url)
      if (target.includes('/api/oauth/profile')) {
        profileAttempts += 1
        if (profileAttempts === 1) return new Response('{}', { status: 401 })
        return Response.json({ account: { uuid: ACCOUNT_UUID } })
      }
      messageUsedRefreshedCredential = authorizationOf(init) === `Bearer ${ROTATED_ACCESS}`
      return new Response(RESPONSE_SSE, { headers: { 'content-type': 'text/event-stream' } })
    }

    const adapter = new ClaudeAdapter({
      deviceFingerprint: () => 'f'.repeat(64),
      models: [],
      discovery: false,
      streamIdleTimeoutMs: 60_000,
      tokens,
      fetchFn,
      continuation: wire.continuation,
      requestRecord: wire.requestRecord,
    })
    for await (const _chunk of adapter.stream({ ...REQUEST, sessionId: wire.sessionId })) void _chunk

    const tokensRefreshed = stored.accessToken === ROTATED_ACCESS && stored.refreshToken === ROTATED_REFRESH
    return {
      refreshCount,
      profileAttempts,
      messageUsedRefreshedCredential,
      storedRotationPreserved: tokensRefreshed && stored.accountUuid === ACCOUNT_UUID && stored.deviceId !== undefined,
    }
  } finally {
    await wire.close()
  }
}
