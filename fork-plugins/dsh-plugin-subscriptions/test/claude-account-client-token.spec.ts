/**
 * The token client: the pinned authorize URL, the real wire shape of both grants, the one bounded
 * POST per call, and the difference between a spent grant and a deadline.
 *
 * Every transport is synthetic, every deadline is driven by an injected timer and every response
 * is a real `Response` object, so the assertions are about the bytes this client would put on the
 * wire rather than about an abstraction over them.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CLAUDE_ACCOUNT_CLIENT_ID,
  CLAUDE_ACCOUNT_CLIENT_PROFILE,
  CLAUDE_ACCOUNT_SCOPES,
  CLAUDE_SYSTEM_TIMERS,
  CLAUDE_TOKEN_TIMEOUT_MS,
  CLAUDE_TOKEN_URL,
  buildOAuthAuthorization,
  claudeFailureDropsCredential,
  exchangeAuthorizationCode,
  pkceCodeChallenge,
  refreshTokenGrant,
} from '../src/claude-account-client/index.js'
import type {
  ClaudeAccountResponse,
  ClaudeAccountTimers,
  ClaudeAccountTransport,
  ClaudeTokenOutcome,
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

/** An injectable deadline scheduler: it arms nothing until the test fires it. */
class FakeTimers implements ClaudeAccountTimers {
  readonly armed: number[] = []
  disarmed = 0
  private readonly pending: { run: () => void; live: boolean }[] = []

  arm(delayMs: number, onDeadline: () => void): () => void {
    this.armed.push(delayMs)
    const entry = { run: onDeadline, live: true }
    this.pending.push(entry)
    return () => {
      if (!entry.live) return
      entry.live = false
      this.disarmed += 1
    }
  }

  /** Run every deadline armed so far, as the expiry of that bound would. */
  fire(): void {
    for (const entry of this.pending.splice(0)) {
      if (entry.live) entry.run()
    }
  }
}

/** A 200 whose headers arrive at once and whose body never does until the signal aborts. */
function heldBodyResponse(signal: AbortSignal): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal.aborted) {
        controller.error(signal.reason ?? new Error('aborted'))
        return
      }
      signal.addEventListener('abort', () => {
        controller.error(signal.reason ?? new Error('aborted'))
      }, { once: true })
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

/**
 * A stream plus a count of how many readers were taken from it.
 *
 * The count is read back through the patched method rather than inferred, so a second
 * `getReader()` on one body is a test failure and not an interpretation.
 */
function countedStream(source: UnderlyingSource<Uint8Array>): {
  readonly stream: ReadableStream<Uint8Array>
  readonly readers: () => number
} {
  const stream = new ReadableStream<Uint8Array>(source)
  let count = 0
  const original = stream.getReader.bind(stream)
  Object.defineProperty(stream, 'getReader', {
    value: (): ReadableStreamDefaultReader<Uint8Array> => {
      count += 1
      return original()
    },
  })
  return { stream, readers: () => count }
}

/**
 * A body that hands out exactly one chunk and then never settles a read.
 *
 * It registers no abort listener of its own, so only this client's own cancellation can settle
 * the pending read — which is what makes the release the module's responsibility.
 */
function heldStream(observed: { cancelled: boolean; chunks: number }): {
  readonly stream: ReadableStream<Uint8Array>
  readonly readers: () => number
} {
  return countedStream({
    start(controller) {
      observed.chunks += 1
      controller.enqueue(new Uint8Array(8).fill(0x61))
    },
    pull() {
      // Never enqueue and never close: the next read stays pending until someone cancels it.
    },
    cancel() {
      observed.cancelled = true
    },
  })
}

/** Wait, on the microtask/check queue only, until a condition holds. */
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    if (condition()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail(label)
}

/** A JSON response with the headers the token endpoint sends. */
function jsonResponse(status: number, document: unknown): Response {
  return new Response(JSON.stringify(document), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('the authorize URL carries the pinned profile, the caller PKCE challenge and the caller state', () => {
  // RFC 7636 Appendix B fixes this verifier/challenge pair, so the digest is checked against a
  // published vector rather than against this module's own arithmetic.
  assert.equal(
    pkceCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  )
  const authorization = buildOAuthAuthorization({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    redirectUri: 'http://localhost:54545/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    state: 'state-1',
  })
  const url = new URL(authorization.url)
  assert.equal(`${url.origin}${url.pathname}`, 'https://claude.com/cai/oauth/authorize')
  assert.deepEqual([...url.searchParams.keys()], [
    'code', 'client_id', 'response_type', 'redirect_uri', 'scope',
    'code_challenge', 'code_challenge_method', 'state',
  ])
  assert.equal(url.searchParams.get('code'), 'true')
  assert.equal(url.searchParams.get('client_id'), CLAUDE_ACCOUNT_CLIENT_ID)
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:54545/callback')
  assert.equal(url.searchParams.get('scope'), CLAUDE_ACCOUNT_SCOPES)
  assert.equal(url.searchParams.get('code_challenge'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('state'), 'state-1')
  assert.equal(authorization.state, 'state-1')
})

test('an unpinned profile never becomes a grant target', () => {
  assert.throws(() => buildOAuthAuthorization({
    profile: { ...CLAUDE_ACCOUNT_CLIENT_PROFILE, tokenUrl: 'https://collector.example/v1/oauth/token' },
    redirectUri: 'http://localhost:54545/callback',
    codeChallenge: 'challenge-1',
    state: 'state-1',
  }), /not pinned: unpinned_tokenUrl/)
  assert.throws(() => buildOAuthAuthorization({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    redirectUri: 'http://localhost:54545/callback',
    codeChallenge: 'challenge-1',
    state: '',
  }), /caller-provided state/)
})

test('the code exchange POSTs the client grant and validates the answer into a typed grant', async () => {
  const { transport, wires } = wireTransport(() => jsonResponse(200, {
    access_token: 'at-1',
    refresh_token: 'rt-1',
    expires_in: 3_600,
    scope: 'user:inference user:profile',
  }))
  const outcome = await exchangeAuthorizationCode({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    code: 'code-1',
    codeVerifier: 'verifier-1',
    redirectUri: 'http://localhost:54545/callback',
    state: 'state-1',
  })
  assert.equal(wires.length, 1)
  const wire = wires[0]
  assert.equal(wire?.method, 'POST')
  assert.equal(wire?.url, CLAUDE_TOKEN_URL)
  assert.deepEqual(wire?.headers, { 'content-type': 'application/json' })
  assert.equal(wire?.timeoutMs, CLAUDE_TOKEN_TIMEOUT_MS, 'the pinned 30s bound reaches the transport')
  assert.deepEqual(JSON.parse(wire?.body ?? '{}'), {
    grant_type: 'authorization_code',
    code: 'code-1',
    redirect_uri: 'http://localhost:54545/callback',
    client_id: CLAUDE_ACCOUNT_CLIENT_ID,
    code_verifier: 'verifier-1',
    state: 'state-1',
  })
  assert.equal(outcome.kind, 'grant')
  if (outcome.kind !== 'grant') return
  assert.deepEqual(outcome.grant, {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresInSeconds: 3_600,
    scopes: ['user:inference', 'user:profile'],
  })
})

test('the refresh grant drops the authorize-only scope and commits nothing', async () => {
  const stored = { accessToken: 'at-old', refreshToken: 'rt-old', scopes: 'org:create_api_key user:inference' }
  const before = JSON.stringify(stored)
  const { transport, wires } = wireTransport(() => jsonResponse(200, {
    access_token: 'at-2',
    refresh_token: 'rt-2',
    expires_in: 3_600,
    scope: 'user:inference',
  }))
  const outcome = await refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    refreshToken: stored.refreshToken,
    scopes: stored.scopes,
  })
  assert.deepEqual(JSON.parse(wires[0]?.body ?? '{}'), {
    grant_type: 'refresh_token',
    refresh_token: 'rt-old',
    client_id: CLAUDE_ACCOUNT_CLIENT_ID,
    // `org:create_api_key` belongs to the authorize request, and everything else stays intact.
    scope: 'user:inference',
  })
  assert.equal(wires[0]?.url, CLAUDE_TOKEN_URL)
  assert.equal(outcome.kind, 'grant')
  if (outcome.kind !== 'grant') return
  assert.equal(outcome.grant.accessToken, 'at-2')
  assert.equal(outcome.grant.refreshToken, 'rt-2')
  // The credential owner is the only committer: this call wrote nothing anywhere.
  assert.equal(JSON.stringify(stored), before)
})

test('a refresh answer without a refresh token leaves the caller keeping its own', async () => {
  const { transport } = wireTransport(() => jsonResponse(200, { access_token: 'at-3', expires_in: 60 }))
  const outcome = await refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    refreshToken: 'rt-keep',
    scopes: 'user:inference',
  })
  assert.equal(outcome.kind, 'grant')
  if (outcome.kind !== 'grant') return
  assert.equal(outcome.grant.refreshToken, undefined)
  // The requested scopes stand in when the answer states none, as the analyzed client does.
  assert.deepEqual(outcome.grant.scopes, ['user:inference'])
})

test('a body held past the 30s bound times out after exactly one POST and leaves the credential alone', async () => {
  const timers = new FakeTimers()
  const stored = { accessToken: 'at-old', refreshToken: 'rt-old' }
  const before = JSON.stringify(stored)
  let started: () => void = () => undefined
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  const { transport, wires } = wireTransport(wire => {
    started()
    return heldBodyResponse(wire.signal)
  })
  const pending = refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    refreshToken: stored.refreshToken,
    scopes: 'user:inference',
    timers,
  })
  await startedPromise
  assert.deepEqual(timers.armed, [CLAUDE_TOKEN_TIMEOUT_MS], 'this module owns the deadline it schedules')
  timers.fire()
  const outcome = await pending
  assert.equal(outcome.kind, 'timeout')
  if (outcome.kind !== 'timeout') return
  assert.equal(wires.length, 1, 'a stalled body causes no second POST')
  assert.equal(wires[0]?.signal.aborted, true, 'the in-flight request was aborted')
  assert.equal(claudeFailureDropsCredential(outcome.failure), false, 'a deadline is not a revoked login')
  assert.equal(outcome.failure.message, 'the operation did not answer within its deadline')
  assert.equal(JSON.stringify(stored), before)
})

test('a spent grant is permanent and a server failure is not, and neither carries the body', async () => {
  const spent = wireTransport(() => jsonResponse(400, {
    error: 'invalid_grant',
    error_description: 'refresh token is no longer valid',
  }))
  const spentOutcome = await refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport: spent.transport,
    refreshToken: 'rt-old',
    scopes: 'user:inference',
  })
  assert.equal(spentOutcome.kind, 'invalid_grant')
  if (spentOutcome.kind !== 'invalid_grant') return
  assert.equal(claudeFailureDropsCredential(spentOutcome.failure), true)
  const serialized = JSON.stringify(spentOutcome.failure)
  assert.ok(!serialized.includes('no longer valid'), 'no response text rides the failure')
  assert.ok(!serialized.includes('error_description'))
  assert.deepEqual(Object.keys(spentOutcome.failure).sort(), ['code', 'message', 'reason'])

  const failing = wireTransport(() => jsonResponse(500, { error: 'api_error' }))
  const failingOutcome = await refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport: failing.transport,
    refreshToken: 'rt-old',
    scopes: 'user:inference',
  })
  assert.equal(failingOutcome.kind, 'unreachable')
  if (failingOutcome.kind !== 'unreachable') return
  assert.equal(claudeFailureDropsCredential(failingOutcome.failure), false)

  // A generic refusal names no permanent grant code, so it never authorizes deleting a credential.
  const generic = wireTransport(() => jsonResponse(400, { error: 'invalid_request' }))
  const genericOutcome = await refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport: generic.transport,
    refreshToken: 'rt-old',
    scopes: 'user:inference',
  })
  assert.equal(genericOutcome.kind, 'refused')
  if (genericOutcome.kind !== 'refused') return
  assert.equal(claudeFailureDropsCredential(genericOutcome.failure), false)
})

test('a redirect away from the pinned token endpoint is refused, never followed', async () => {
  const { transport, wires } = wireTransport(() => ({
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
    redirected: true,
    url: 'https://collector.example/v1/oauth/token',
  }))
  const outcome: ClaudeTokenOutcome = await refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    refreshToken: 'rt-old',
    scopes: 'user:inference',
  })
  assert.equal(outcome.kind, 'invalid')
  if (outcome.kind !== 'invalid') return
  assert.equal(outcome.failure.code, 'redirected')
  assert.equal(wires.length, 1)
})

test('an unneeded refresh sends nothing, and an unusable one is refused before the wire', async () => {
  const { transport, wires } = wireTransport(() => jsonResponse(200, { access_token: 'at-1', expires_in: 60 }))
  assert.deepEqual(
    await refreshTokenGrant({
      profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
      transport,
      refreshToken: 'rt-old',
      scopes: 'user:inference',
      required: () => false,
    }),
    { kind: 'not-required' },
  )
  assert.equal(wires.length, 0)
  assert.equal((await refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    refreshToken: '',
    scopes: 'user:inference',
  })).kind, 'invalid')
  assert.equal(wires.length, 0)
})

test('a transport failure is unreachable and a caller abort is cancelled', async () => {
  const failing = wireTransport(() => {
    throw new Error('socket closed')
  })
  const failed = await refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport: failing.transport,
    refreshToken: 'rt-old',
    scopes: 'user:inference',
  })
  assert.equal(failed.kind, 'unreachable')

  const controller = new AbortController()
  const aborted = wireTransport(() => jsonResponse(200, { access_token: 'at-1', expires_in: 60 }))
  controller.abort()
  const cancelled = await refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport: aborted.transport,
    refreshToken: 'rt-old',
    scopes: 'user:inference',
    signal: controller.signal,
  })
  assert.equal(cancelled.kind, 'cancelled')
  assert.equal(aborted.wires.length, 0, 'an already-cancelled call sends nothing')
})

test('only the parsed grant code decides permanence, never the surrounding description', async () => {
  // The description names the permanent code, but the parsed `error` field does not: the code
  // this client reports comes from a fixed allowlist read out of `error`, never from body text.
  const described = wireTransport(() => jsonResponse(400, {
    error: 'invalid_request',
    error_description: 'the previous invalid_grant was already consumed',
  }))
  const describedOutcome = await refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport: described.transport,
    refreshToken: 'rt-old',
    scopes: 'user:inference',
  })
  assert.equal(describedOutcome.kind, 'refused')
  if (describedOutcome.kind !== 'refused') return
  assert.equal(claudeFailureDropsCredential(describedOutcome.failure), false)

  // The nested spelling names it in the code field, which is a fixed field, so it is permanent.
  const nested = wireTransport(() => jsonResponse(400, { error: { code: 'invalid_token' } }))
  const nestedOutcome = await refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport: nested.transport,
    refreshToken: 'rt-old',
    scopes: 'user:inference',
  })
  assert.equal(nestedOutcome.kind, 'invalid_grant')
  if (nestedOutcome.kind !== 'invalid_grant') return
  assert.equal(nestedOutcome.failure.reason, 'invalid_token')
  assert.equal(claudeFailureDropsCredential(nestedOutcome.failure), true)
})

test('the default scheduler is a real process timer, so a caller may inject none', () => {
  assert.equal(typeof CLAUDE_SYSTEM_TIMERS.arm, 'function')
  const cancel = CLAUDE_SYSTEM_TIMERS.arm(60_000, () => undefined)
  cancel()
})

test('a deadline that wins a held body read releases the locked reader itself', { timeout: 10_000 }, async () => {
  const observed = { cancelled: false, chunks: 0 }
  const held = heldStream(observed)
  let started: () => void = () => undefined
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  const { transport, wires } = wireTransport(() => {
    started()
    return new Response(held.stream, { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const timers = new FakeTimers()
  const pending = refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    refreshToken: 'rt-old',
    scopes: 'user:inference',
    timers,
  })
  await startedPromise
  // The read is genuinely in flight: the stream is locked because the module took its reader.
  await until(() => held.stream.locked, 'the module never took the response body reader')
  assert.equal(held.readers(), 1)
  timers.fire()
  // Asserted before awaiting the outcome, so an unreleased reader fails here rather than hanging.
  await until(() => observed.cancelled, 'the module never cancelled the reader it held')
  await until(() => !held.stream.locked, 'the pending read never released its reader')
  const outcome = await pending
  assert.equal(outcome.kind, 'timeout')
  assert.equal(wires.length, 1)
  // The stream registered no abort listener of its own, so these two facts can only come from
  // this client cancelling the reader it held: the underlying cancel ran, and the lock — which
  // only the read's own release can drop — is gone.
  assert.equal(observed.cancelled, true, 'the module cancelled the reader it held')
  assert.equal(held.stream.locked, false, 'the pending read settled and released its reader')
  assert.equal(held.readers(), 1, 'one body, one reader')
})

test('a caller abort settles a held body read at once instead of waiting for the deadline', { timeout: 10_000 }, async () => {
  const observed = { cancelled: false, chunks: 0 }
  const held = heldStream(observed)
  let started: () => void = () => undefined
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  const { transport } = wireTransport(() => {
    started()
    return new Response(held.stream, { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const timers = new FakeTimers()
  const controller = new AbortController()
  const pending = refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    refreshToken: 'rt-old',
    scopes: 'user:inference',
    timers,
    signal: controller.signal,
  })
  await startedPromise
  await until(() => held.stream.locked, 'the module never took the response body reader')
  controller.abort()
  // The deadline is never fired: resolving at all is the evidence that the caller's own
  // cancellation settled the race rather than the 30s bound.
  await until(() => observed.cancelled, 'the module never cancelled the reader it held')
  await until(() => !held.stream.locked, 'the pending read never released its reader')
  const outcome = await pending
  assert.equal(outcome.kind, 'cancelled')
  assert.equal(observed.cancelled, true)
  assert.equal(held.stream.locked, false)
  assert.deepEqual(timers.armed, [CLAUDE_TOKEN_TIMEOUT_MS])
})

test('a response that arrives after the race was lost is cancelled instead of leaking', { timeout: 10_000 }, async () => {
  const observed = { cancelled: false, chunks: 0 }
  const late = heldStream(observed)
  let deliver: (response: ClaudeAccountResponse) => void = () => undefined
  const gate = new Promise<ClaudeAccountResponse>(resolve => { deliver = resolve })
  const { transport, wires } = wireTransport(async () => await gate)
  const timers = new FakeTimers()
  const pending = refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    refreshToken: 'rt-old',
    scopes: 'user:inference',
    timers,
  })
  await until(() => wires.length === 1, 'the transport was never called')
  timers.fire()
  // The outcome resolves while the transport is still pending: the race is the module's own.
  assert.equal((await pending).kind, 'timeout')
  deliver(new Response(late.stream, { status: 200, headers: { 'content-type': 'application/json' } }))
  await until(() => observed.cancelled, 'the late response body was never cancelled')
  assert.equal(late.stream.locked, false)
  assert.equal(late.readers(), 0, 'a late response is never handed to the response handler')
})

test('a caller abort cancels a response that only arrives afterwards', { timeout: 10_000 }, async () => {
  const observed = { cancelled: false, chunks: 0 }
  const late = heldStream(observed)
  let deliver: (response: ClaudeAccountResponse) => void = () => undefined
  const gate = new Promise<ClaudeAccountResponse>(resolve => { deliver = resolve })
  const { transport, wires } = wireTransport(async () => await gate)
  const timers = new FakeTimers()
  const controller = new AbortController()
  const pending = refreshTokenGrant({
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    refreshToken: 'rt-old',
    scopes: 'user:inference',
    timers,
    signal: controller.signal,
  })
  await until(() => wires.length === 1, 'the transport was never called')
  controller.abort()
  assert.equal((await pending).kind, 'cancelled')
  deliver(new Response(late.stream, { status: 200, headers: { 'content-type': 'application/json' } }))
  await until(() => observed.cancelled, 'the late response body was never cancelled')
  assert.equal(late.stream.locked, false)
  assert.equal(late.readers(), 0)
})
