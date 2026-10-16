/**
 * The strict profile reader: the real wire shape of the GET, the adopted fields and completeness
 * verdict, the identity pin, the client-version refusal that outranks the one replay, and the
 * release of a body that exceeds the product bound.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CLAUDE_ACCOUNT_CLIENT_PROFILE,
  CLAUDE_PLAIN_USER_AGENT,
  CLAUDE_PROFILE_BODY_LIMIT,
  CLAUDE_PROFILE_TIMEOUT_MS,
  CLAUDE_PROFILE_URL,
  claudeFailureDropsCredential,
  readClaudeStrictProfile,
} from '../src/claude-account-client/index.js'
import type {
  ClaudeAccountResponse,
  ClaudeAccountTimers,
  ClaudeAccountTransport,
  ClaudeProfileOutcome,
} from '../src/claude-account-client/index.js'

/** One request as the transport received it, copied so a later mutation cannot rewrite history. */
interface Wire {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string | null
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

/** A transport that records every request and answers it with the reply the test wrote. */
function wireTransport(reply: (wire: Wire) => ClaudeAccountResponse | Promise<ClaudeAccountResponse>): {
  readonly transport: ClaudeAccountTransport
  readonly wires: Wire[]
} {
  const wires: Wire[] = []
  return {
    wires,
    transport: async request => {
      const wire: Wire = {
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body: request.body,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      }
      wires.push(wire)
      return await reply(wire)
    },
  }
}

/** An injectable deadline scheduler: nothing expires unless the test fires it. */
class FakeTimers implements ClaudeAccountTimers {
  readonly armed: number[] = []
  private readonly pending: { run: () => void; live: boolean }[] = []

  arm(delayMs: number, onDeadline: () => void): () => void {
    this.armed.push(delayMs)
    const entry = { run: onDeadline, live: true }
    this.pending.push(entry)
    return () => {
      entry.live = false
    }
  }

  fire(): void {
    for (const entry of this.pending.splice(0)) {
      if (entry.live) entry.run()
    }
  }
}

/** A JSON response with the headers the profile endpoint sends. */
function jsonResponse(status: number, document: unknown): Response {
  return new Response(JSON.stringify(document), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** The complete document the endpoint serves for one account. */
function completeProfile(): Record<string, unknown> {
  return {
    account: {
      uuid: 'acct-1',
      email: 'member@example.com',
      created_at: '2024-01-01T00:00:00.000Z',
      display_name: 'Member',
    },
    organization: {
      uuid: 'org-1',
      billing_type: 'stripe_subscription',
      subscription_created_at: '2024-02-01T00:00:00.000Z',
      cc_onboarding_flags: { seen: true },
      seat_tier: 'pro',
    },
    subscriptionType: 'pro',
  }
}

/**
 * A body far larger than the product bound that reports how much of it was pulled and whether it
 * was cancelled: an early cancel stops at the bound, a whole read would pull every chunk.
 */
function oversizedBody(observed: { chunks: number; cancelled: boolean }): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(4_096).fill(0x61)
  let remaining = 1_024
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) {
        controller.close()
        return
      }
      remaining -= 1
      observed.chunks += 1
      controller.enqueue(chunk)
    },
    cancel() {
      observed.cancelled = true
    },
  })
}

test('the profile GET carries the pinned role headers and adopts only the safe projection', async () => {
  const { transport, wires } = wireTransport(() => jsonResponse(200, completeProfile()))
  const outcome = await readClaudeStrictProfile({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
  })
  assert.equal(wires.length, 1)
  const wire = wires[0]
  assert.equal(wire?.method, 'GET')
  assert.equal(wire?.url, CLAUDE_PROFILE_URL)
  assert.equal(wire?.body, null)
  assert.equal(wire?.headers['anthropic-beta'], undefined, 'the profile role does not carry the OAuth beta')
  assert.deepEqual(wire?.headers, {
    authorization: 'Bearer at-1',
    'user-agent': CLAUDE_PLAIN_USER_AGENT,
    'content-type': 'application/json',
    'cache-control': 'no-cache',
  })
  assert.equal(wire?.timeoutMs, CLAUDE_PROFILE_TIMEOUT_MS)
  assert.equal(outcome.kind, 'profile')
  if (outcome.kind !== 'profile') return
  assert.deepEqual(outcome.profile, {
    accountUuid: 'acct-1',
    email: 'member@example.com',
    organizationUuid: 'org-1',
    billingType: 'stripe_subscription',
    subscriptionType: 'pro',
    accountCreated: true,
    subscriptionCreated: true,
    onboardingFlags: true,
    complete: true,
  })
  const serialized = JSON.stringify(outcome.profile)
  assert.ok(!serialized.includes('2024-01-01'), 'the raw creation date does not leave the reader')
  assert.ok(!serialized.includes('seat_tier'), 'fields outside the projection do not leave the reader')
})

test('completeness reads the billing type from the organization and not from the root', async () => {
  const document = completeProfile()
  const organization = document['organization'] as Record<string, unknown>
  delete organization['billing_type']
  organization['subscription_created_at'] = null
  document['billing_type'] = 'root-level-is-not-this-field'
  const { transport } = wireTransport(() => jsonResponse(200, document))
  const outcome = await readClaudeStrictProfile({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
  })
  assert.equal(outcome.kind, 'profile')
  if (outcome.kind !== 'profile') return
  assert.equal(outcome.profile.billingType, undefined)
  assert.equal(outcome.profile.complete, false)
  assert.equal(outcome.profile.accountCreated, true)
})

test('a stated null subscription type stays null and never decides completeness', async () => {
  const document = completeProfile()
  document['subscriptionType'] = null
  const { transport } = wireTransport(() => jsonResponse(200, document))
  const outcome = await readClaudeStrictProfile({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
  })
  assert.equal(outcome.kind, 'profile')
  if (outcome.kind !== 'profile') return
  assert.equal(outcome.profile.subscriptionType, null)
  assert.equal(outcome.profile.complete, true)
})

test('a document missing the organization identity is invalid rather than adopted', async () => {
  const document = completeProfile()
  delete document['organization']
  const { transport } = wireTransport(() => jsonResponse(200, document))
  const outcome = await readClaudeStrictProfile({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
  })
  assert.equal(outcome.kind, 'invalid')
  if (outcome.kind !== 'invalid') return
  assert.equal(outcome.failure.reason, 'missing_identity')
})

test('a pinned identity the document contradicts is refused and never adopted as the newer account', async () => {
  const { transport } = wireTransport(() => jsonResponse(200, completeProfile()))
  const outcome = await readClaudeStrictProfile({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    expected: { accountUuid: 'acct-other', organizationUuid: 'org-1' },
  })
  assert.equal(outcome.kind, 'invalid')
  if (outcome.kind !== 'invalid') return
  assert.equal(outcome.failure.code, 'identity_mismatch')
  assert.equal(outcome.failure.reason, 'account_mismatch')
  assert.equal(claudeFailureDropsCredential(outcome.failure), false)
})

test('a client-version refusal on a 401 keeps its own outcome and spends no replay', async () => {
  let reauthorized = 0
  const refused = new Response(JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'claude_code_version_too_old' },
  }), { status: 401, headers: { 'content-type': 'application/json' } })
  const { transport, wires } = wireTransport(() => refused)
  const outcome = await readClaudeStrictProfile({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    reauthorize: async () => {
      reauthorized += 1
      return 'at-2'
    },
  })
  assert.equal(outcome.kind, 'refused')
  if (outcome.kind !== 'refused') return
  assert.equal(outcome.failure.code, 'client_version_unsupported')
  assert.equal(reauthorized, 0, 'a version refusal outranks the one authentication replay')
  assert.equal(wires.length, 1)
})

test('a plain 401 is replayable exactly once through the caller hook and never drops the credential', async () => {
  let reauthorized = 0
  const { transport, wires } = wireTransport(wire => wire.headers['authorization'] === 'Bearer at-1'
    ? jsonResponse(401, { error: { type: 'authentication_error', message: 'token expired' } })
    : jsonResponse(200, completeProfile()))
  const outcome = await readClaudeStrictProfile({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    expected: { accountUuid: 'acct-1', organizationUuid: 'org-1' },
    reauthorize: async () => {
      reauthorized += 1
      return 'at-2'
    },
  })
  assert.equal(outcome.kind, 'profile')
  if (outcome.kind !== 'profile') return
  assert.equal(reauthorized, 1)
  assert.deepEqual(wires.map(wire => wire.headers['authorization']), ['Bearer at-1', 'Bearer at-2'])
  assert.equal(wires[1]?.url, CLAUDE_PROFILE_URL)

  // A 401 with no reauthorizer wired, and with no permanent grant code, is `unauthorized`: the
  // worker must not delete the vault's active credential for it.
  const alone = wireTransport(() => jsonResponse(401, { error: { type: 'authentication_error' } }))
  const rejected = await readClaudeStrictProfile({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport: alone.transport,
  })
  assert.equal(rejected.kind, 'unauthorized')
  if (rejected.kind !== 'unauthorized') return
  assert.equal(rejected.failure.code, 'unauthorized')
  assert.equal(claudeFailureDropsCredential(rejected.failure), false)
})

test('the beforeRequest guard is re-judged before the replay', async () => {
  const attempts: number[] = []
  const { transport, wires } = wireTransport(() => jsonResponse(401, { error: { type: 'authentication_error' } }))
  const outcome = await readClaudeStrictProfile({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    reauthorize: async () => 'at-2',
    beforeRequest: attempt => {
      attempts.push(attempt)
      return attempt === 0
    },
  })
  assert.equal(outcome.kind, 'withheld')
  assert.deepEqual(attempts, [0, 1])
  assert.equal(wires.length, 1, 'the guard stopped the replay before it was sent')
})

test('a body over the product bound is cancelled at the bound, not read whole', async () => {
  const observed = { chunks: 0, cancelled: false }
  const { transport } = wireTransport(() => new Response(oversizedBody(observed), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  const outcome: ClaudeProfileOutcome = await readClaudeStrictProfile({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
  })
  assert.equal(outcome.kind, 'invalid')
  if (outcome.kind !== 'invalid') return
  assert.equal(outcome.failure.code, 'body_over_limit')
  assert.equal(observed.cancelled, true, 'the reader was cancelled at the bound')
  // The stream's own queue may pull one chunk ahead of the reader, so the allowance covers that
  // lookahead; a whole read would have pulled all 1024 chunks.
  assert.ok(
    observed.chunks <= CLAUDE_PROFILE_BODY_LIMIT / 4_096 + 8,
    `the read stopped at the bound, pulled ${String(observed.chunks)} chunks`,
  )
})

test('a redirected profile read is refused and a deadline is unreachable rather than a rejection', async () => {
  const redirected = wireTransport(() => ({
    status: 200,
    headers: new Headers(),
    body: null,
    redirected: true,
    url: 'https://elsewhere.example/api/oauth/profile',
  }))
  const refused = await readClaudeStrictProfile({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport: redirected.transport,
  })
  assert.equal(refused.kind, 'invalid')
  if (refused.kind !== 'invalid') return
  assert.equal(refused.failure.code, 'redirected')

  const timers = new FakeTimers()
  let started: () => void = () => undefined
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  const held = wireTransport(wire => {
    started()
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        wire.signal.addEventListener('abort', () => {
          controller.error(wire.signal.reason ?? new Error('aborted'))
        }, { once: true })
      },
    }), { status: 200 })
  })
  const pending = readClaudeStrictProfile({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport: held.transport,
    timers,
  })
  await startedPromise
  assert.deepEqual(timers.armed, [CLAUDE_PROFILE_TIMEOUT_MS])
  timers.fire()
  const timedOut = await pending
  assert.equal(timedOut.kind, 'unreachable')
  if (timedOut.kind !== 'unreachable') return
  assert.equal(timedOut.failure.code, 'timeout')
  assert.equal(claudeFailureDropsCredential(timedOut.failure), false)
  assert.equal(held.wires.length, 1)
})

test('an unneeded profile read sends nothing', async () => {
  const { transport, wires } = wireTransport(() => jsonResponse(200, completeProfile()))
  const outcome = await readClaudeStrictProfile({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    required: () => false,
  })
  assert.equal(outcome.kind, 'not-required')
  assert.equal(wires.length, 0)
})
