/**
 * Ordered Claude failure classification: the priority order the reliability design fixes,
 * the bounded error-body read, and the durable protocol block. Everything here is
 * synthetic — no endpoint, credential store or network is touched.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LlmError, errorChain } from '@deepseek-ai/dsh-llm'
import {
  CLAUDE_ERROR_BODY_LIMIT,
  CLIENT_VERSION_UNSUPPORTED_CODE,
  PERMISSION_DENIED_CODE,
  UNCLASSIFIED_PROVIDER_ERROR_CODE,
  classifyClaudeHttpFailure,
  classifyClaudeSseFailure,
  claudeHttpLlmError,
  readClaudeErrorBody,
} from '../src/providers/claude-failure.js'
import { CLAUDE_PROTOCOL_PROFILE } from '../src/providers/claude-protocol.js'
import { ClaudeProtocolBlockStore } from '../src/providers/claude-protocol-state.js'
import { ENFORCEMENT_CODE } from '../src/providers/common.js'

/** The version refusal the service sends, in the nested form the design names. */
const VERSION_BODY = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'Your client version is no longer supported. Please update.',
    details: { error_code: 'claude_code_version_too_old' },
  },
})

/** Headers a recoverable-looking refusal carries: both would otherwise invite a retry. */
const RECOVERABLE_HEADERS = {
  'retry-after': '30',
  'x-should-retry': 'true',
  'anthropic-ratelimit-unified-status': 'allowed',
}

/**
 * Classify one synthetic response.
 * @param body - the response body.
 * @param init - status and headers.
 * @returns the ordered decision.
 */
function classify(body: string, init: { status: number; headers?: Record<string, string>; outputDelivered?: boolean }) {
  return classifyClaudeHttpFailure({
    response: new Response(body, { status: init.status, ...init.headers === undefined ? {} : { headers: init.headers } }),
    body,
    reset: undefined,
    now: Date.now(),
    rateLimited: init.status === 429,
    profile: CLAUDE_PROTOCOL_PROFILE,
    ...init.outputDelivered === undefined ? {} : { outputDelivered: init.outputDelivered },
  })
}

test('a version refusal outranks every retry signal on an HTTP 400', async () => {
  const decision = classify(VERSION_BODY, { status: 400, headers: { ...RECOVERABLE_HEADERS, 'clear-at': 'later' } })
  assert.equal(decision.reason, CLIENT_VERSION_UNSUPPORTED_CODE)
  assert.equal(decision.retryDisposition, 'forbid')
  assert.equal(decision.scope, 'provider-profile')
  assert.equal(decision.status, 400)
  // The same response through the route's own error builder keeps the stop on the failure.
  const error = await claudeHttpLlmError(
    new Response(VERSION_BODY, { status: 400, headers: { ...RECOVERABLE_HEADERS } }),
    { label: 'claude API', profile: CLAUDE_PROTOCOL_PROFILE },
  )
  assert.equal(error.code, CLIENT_VERSION_UNSUPPORTED_CODE)
  assert.equal(error.failure.retryDisposition, 'forbid')
  assert.equal(error.failure.status, 400)
})

test('the same version refusal inside a 200 is classified identically', () => {
  const decision = classifyClaudeSseFailure({
    error: { type: 'invalid_request_error', message: 'unsupported client (claude_code_version_too_old)' },
    profile: CLAUDE_PROTOCOL_PROFILE,
  })
  assert.equal(decision.reason, CLIENT_VERSION_UNSUPPORTED_CODE)
  assert.equal(decision.retryDisposition, 'forbid')
  // The nested form names the code rather than the wording.
  assert.equal(classifyClaudeSseFailure({
    error: { type: 'some_future_type', message: 'claude_code_version_too_old' },
    profile: CLAUDE_PROTOCOL_PROFILE,
  }).reason, CLIENT_VERSION_UNSUPPORTED_CODE)
  // A response that states a final refusal cannot outrank the version refusal.
  assert.equal(classifyClaudeSseFailure({
    error: { type: 'rate_limit_error', message: 'claude_code_version_too_old' },
    profile: CLAUDE_PROTOCOL_PROFILE,
    isRefusal: () => true,
  }).reason, CLIENT_VERSION_UNSUPPORTED_CODE)
})

test('a nested details.error_code names the version refusal, whatever the event type says', () => {
  const nested = classifyClaudeSseFailure({
    error: {
      type: 'overloaded_error',
      message: 'busy',
      details: { error_code: 'claude_code_version_too_old' },
    },
    profile: CLAUDE_PROTOCOL_PROFILE,
    // Even a response the caller reads as a stated-final refusal yields to the version code.
    isRefusal: () => true,
  })
  assert.equal(nested.reason, CLIENT_VERSION_UNSUPPORTED_CODE)
  assert.equal(nested.retryDisposition, 'forbid')
  assert.equal(nested.scope, 'provider-profile')
  // The HTTP form reads the same nesting, so the two halves cannot disagree.
  const http = classify(JSON.stringify({
    type: 'error',
    error: { type: 'overloaded_error', message: 'busy', details: { error_code: 'claude_code_version_too_old' } },
  }), { status: 529, headers: { 'x-should-retry': 'true' } })
  assert.equal(http.reason, CLIENT_VERSION_UNSUPPORTED_CODE)
})

test('a named request or model refusal is not resent, however the status reads', async () => {
  // A 400 that names a bad parameter, and a 404 that names a missing model: both are stated
  // refusals, so the Host's unconditional retry mode must not resend either.
  for (const [status, type] of [[400, 'invalid_request_error'], [404, 'not_found_error']] as const) {
    const body = JSON.stringify({ type: 'error', error: { type, message: 'the request cannot be served' } })
    const decision = classify(body, { status })
    assert.equal(decision.reason, 'INVALID_REQUEST', `HTTP ${String(status)} ${type}`)
    assert.equal(decision.retryDisposition, 'forbid', `HTTP ${String(status)} ${type}`)
    const error = await claudeHttpLlmError(new Response(body, { status }), {
      label: 'claude API',
      profile: CLAUDE_PROTOCOL_PROFILE,
    })
    assert.equal(error.failure.retryDisposition, 'forbid')
  }
  // A 404 that names nothing keeps the route's declared per-status rule.
  assert.equal(classify('not found', { status: 404 }).reason, 'HTTP_404')
})

test('a code this route has no rule for is never allowed by omission', () => {
  // The table is an allow-list: an unnamed status must not read as permission.
  const decision = classify('conflict', { status: 418 })
  assert.equal(decision.reason, 'HTTP_418')
  assert.equal(decision.retryDisposition, 'forbid')
  // A status the taxonomy names transient keeps its declared recovery: a 409 is the
  // provider failing to settle a target that changed, which the same account retries.
  const conflict = classify('conflict', { status: 409 })
  assert.equal(conflict.reason, 'CONFLICT')
  assert.equal(conflict.retryDisposition, 'allow')
  // A status with a declared rule keeps it.
  assert.equal(classify('', { status: 402 }).retryDisposition, 'allow')
})

test('a version refusal outranks a context-window message in the same body', () => {
  const body = JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'prompt is too long: 300000 tokens',
      details: { error_code: 'claude_code_version_too_old' },
    },
  })
  const decision = classify(body, { status: 400 })
  assert.equal(decision.reason, CLIENT_VERSION_UNSUPPORTED_CODE, 'the version refusal wins the overlap')
  assert.equal(decision.retryDisposition, 'forbid')
})

test('a plain context overflow keeps its declared specific recovery', () => {
  const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 202000 tokens > 200000 maximum' } })
  const decision = classify(body, { status: 400 })
  assert.equal(decision.reason, 'CONTEXT_WINDOW_EXCEEDED')
  // Compaction and image offload are declared consumers of this failure: forbidding the
  // resend would disable them rather than protect anything.
  assert.equal(decision.retryDisposition, 'allow')
  // Output already delivered still stops the replay.
  assert.equal(classify(body, { status: 400, outputDelivered: true }).retryDisposition, 'forbid')
})

test('a plain 403 is a permission refusal, not an expired credential', () => {
  const decision = classify(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'denied' } }), { status: 403 })
  assert.equal(decision.reason, PERMISSION_DENIED_CODE)
  assert.notEqual(decision.reason, 'AUTH')
  assert.equal(decision.retryDisposition, 'forbid')
  assert.equal(decision.scope, 'operation')
  // A 403 that names billing or a stop-retry signal keeps the account-scoped enforcement path.
  assert.equal(classify('out_of_credits', { status: 403 }).reason, ENFORCEMENT_CODE)
  assert.equal(classify('denied', { status: 403, headers: { 'x-should-retry': 'false' } }).reason, ENFORCEMENT_CODE)
})

test('an ordinary 401 stays an authentication failure with its one allowed replay', () => {
  const decision = classify('{"error":"expired"}', { status: 401 })
  assert.equal(decision.reason, 'AUTH')
  assert.equal(decision.retryDisposition, 'allow')
  assert.equal(decision.scope, 'account')
})

test('listed transient statuses stay transient while unmapped ones never become SERVER', () => {
  for (const status of [500, 502, 503, 529]) {
    const decision = classify('', { status })
    assert.equal(decision.reason, 'SERVER', `HTTP ${String(status)}`)
    assert.equal(decision.retryDisposition, 'allow')
  }
  for (const status of [408, 504]) {
    assert.equal(classify('', { status }).reason, 'TIMEOUT', `HTTP ${String(status)}`)
  }
  const unknown = classify(JSON.stringify({ type: 'error', error: { type: 'a_type_this_route_never_saw' } }), { status: 500 })
  assert.equal(unknown.reason, UNCLASSIFIED_PROVIDER_ERROR_CODE)
  assert.equal(unknown.retryDisposition, 'forbid')
  // A plain gateway 5xx body names no structured type, so the listed transient rule stands.
  assert.equal(classify('<html>gateway</html>', { status: 503 }).reason, 'SERVER')
})

test('an error body is read under a byte cap and never retained past it', async () => {
  let cancelled = 0
  const big = 'x'.repeat(4096)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // A body that keeps arriving: without a cap the read would never finish.
      for (let index = 0; index < 64; index++) controller.enqueue(new TextEncoder().encode(big))
    },
    cancel() { cancelled += 1 },
  })
  const read = await readClaudeErrorBody(new Response(stream, { status: 500 }), 128)
  assert.equal(read.overflowed, true)
  assert.ok(read.text.length <= 128, `decoded prefix stays inside the cap: ${String(read.text.length)}`)
  assert.equal(cancelled, 1, 'the overflow is cancelled rather than drained')

  const overCap = 'y'.repeat(CLAUDE_ERROR_BODY_LIMIT + 1)
  const error = await claudeHttpLlmError(new Response(overCap, { status: 500 }), {
    label: 'claude API',
    profile: CLAUDE_PROTOCOL_PROFILE,
  })
  // A body past the cap is unclassified, and its raw text is retained nowhere.
  assert.equal(error.code, UNCLASSIFIED_PROVIDER_ERROR_CODE)
  assert.equal(error.failure.retryDisposition, 'forbid')
  assert.equal(error.cause, undefined, 'an over-cap body is not attached as the cause')
  assert.ok(!error.message.includes('yyyy'), 'the body text does not reach the message')
})

test('a response body reaches no message, no cause, no chain and no warning', async () => {
  // Content a provider may echo back: a credential, the user's prompt, an address. The design
  // allows the body to be parsed in memory for classification and nothing else.
  const secrets = ['sk-secret-token', 'my private prompt', 'user@example.test']
  const body = JSON.stringify({
    type: 'error',
    error: {
      type: 'a_type_this_route_never_saw',
      message: `Authorization: Bearer ${secrets[0]} prompt=${secrets[1]} owner=${secrets[2]}`,
      details: { token: secrets[0], prompt: secrets[1], email: secrets[2] },
    },
  })
  for (const status of [429, 500]) {
    const warnings: string[] = []
    const error = await claudeHttpLlmError(new Response(body, { status }), {
      label: 'claude API',
      profile: CLAUDE_PROTOCOL_PROFILE,
      onWarn: message => { warnings.push(message) },
    })
    const rendered = [
      error.message,
      error.cause instanceof Error ? error.cause.message : String(error.cause ?? ''),
      errorChain(error),
      warnings.join(' | '),
    ]
    for (const secret of secrets) {
      for (const text of rendered) {
        assert.ok(!text.includes(secret), `"${secret}" must not appear in: ${text}`)
      }
    }
    // The classifier still sees the body: it is dropped after classification, not ignored.
    assert.equal(error.code, status === 429 ? ENFORCEMENT_CODE : UNCLASSIFIED_PROVIDER_ERROR_CODE)
  }
  // The SSE path builds its message the same way.
  const sse = classifyClaudeSseFailure({
    error: { type: 'some_future_type', message: `Bearer ${secrets[0]} ${secrets[1]} ${secrets[2]}` },
    profile: CLAUDE_PROTOCOL_PROFILE,
  })
  assert.equal(sse.reason, UNCLASSIFIED_PROVIDER_ERROR_CODE)
  assert.equal(sse.serverCode, undefined, 'an unrecognized provider string is not kept in the decision')
})

test('a protocol block is keyed by provider, origin and fingerprint and has no release path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-protocol-blocks-'))
  try {
    const store = new ClaudeProtocolBlockStore({ directory })
    const key = {
      provider: 'claude',
      origin: CLAUDE_PROTOCOL_PROFILE.origin,
      fingerprint: CLAUDE_PROTOCOL_PROFILE.fingerprint,
    }
    assert.equal(await store.state(key), 'absent')
    const write = await store.block({ ...key, reason: CLIENT_VERSION_UNSUPPORTED_CODE, serverCode: 'claude_code_version_too_old' })
    assert.equal(write.persisted, true)
    assert.equal(await store.state(key), 'blocked')
    // Another profile is a different identity: a trusted replacement stops matching.
    assert.equal(await store.state({ ...key, fingerprint: 'b'.repeat(64) }), 'absent')
    assert.equal(await store.state({ ...key, origin: 'https://elsewhere.invalid' }), 'absent')
    // A fresh process reads the same record back, and the same fingerprint is still refused.
    const reopened = new ClaudeProtocolBlockStore({ directory })
    assert.equal(await reopened.isBlocked(key), true)
    const listing = await reopened.list()
    assert.equal(listing.blocks.length, 1)
    assert.deepEqual(listing.unreadable, [])
    assert.equal(listing.blocks[0]?.reason, CLIENT_VERSION_UNSUPPORTED_CODE)
    assert.equal(listing.blocks[0]?.firstSeenAt, listing.blocks[0]?.lastSeenAt)
    const names = await readdir(directory)
    assert.equal(names.length, 1, 'one identity stores one record')
    const stored = await readFile(join(directory, names[0]!), 'utf8')
    assert.ok(!stored.includes('Bearer'), 'no credential is stored with a protocol block')
    assert.ok(!stored.includes('account'), 'no account key is stored with a protocol block')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a damaged record blocks its profile instead of releasing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-protocol-damaged-'))
  try {
    const key = {
      provider: 'claude',
      origin: CLAUDE_PROTOCOL_PROFILE.origin,
      fingerprint: CLAUDE_PROTOCOL_PROFILE.fingerprint,
    }
    const seeded = new ClaudeProtocolBlockStore({ directory })
    await seeded.block({ ...key, reason: CLIENT_VERSION_UNSUPPORTED_CODE })
    const names = await readdir(directory)
    const file = join(directory, names[0]!)
    for (const damaged of ['{"version":1,', '{"version":1,"provider":"claude"}', JSON.stringify({
      version: 1,
      provider: 'claude',
      origin: key.origin,
      fingerprint: 'c'.repeat(64),
      reason: CLIENT_VERSION_UNSUPPORTED_CODE,
      firstSeenAt: 'now',
      lastSeenAt: 'now',
    })]) {
      await writeFile(file, damaged)
      const store = new ClaudeProtocolBlockStore({ directory })
      assert.equal(await store.state(key), 'unreadable', damaged)
      assert.equal(await store.isBlocked(key), true, `a refused profile is never released: ${damaged}`)
    }
    // A record path occupied by something that is not a readable file is a denied read, not
    // an absence: the store cannot prove the profile was never refused.
    const occupied = new ClaudeProtocolBlockStore({ directory })
    await occupied.block({ ...key, reason: CLIENT_VERSION_UNSUPPORTED_CODE })
    const other = { ...key, fingerprint: 'd'.repeat(64) }
    const recordPath = join(directory, `${createHash('sha256')
      .update(`${other.provider}\n${other.origin}\n${other.fingerprint}\n`).digest('hex')}.json`)
    await mkdir(recordPath)
    const denied = new ClaudeProtocolBlockStore({ directory })
    assert.equal(await denied.state(other), 'unreadable')
    assert.equal(await denied.isBlocked(other), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a block whose write fails still stops this process and reports itself unpersisted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-protocol-readonly-'))
  const warnings: string[] = []
  try {
    // A directory path already occupied by a file makes the record unwritable.
    const occupied = join(directory, 'occupied')
    await writeFile(occupied, 'not a directory')
    const store = new ClaudeProtocolBlockStore({ directory: occupied, onWarn: message => { warnings.push(message) } })
    const key = {
      provider: 'claude',
      origin: CLAUDE_PROTOCOL_PROFILE.origin,
      fingerprint: CLAUDE_PROTOCOL_PROFILE.fingerprint,
    }
    const write = await store.block({ ...key, reason: CLIENT_VERSION_UNSUPPORTED_CODE })
    assert.equal(write.persisted, false, 'a failed write is not reported as a successful one')
    assert.ok(write.error !== undefined)
    assert.equal(await store.isBlocked(key), true, 'the in-memory block still stops the request')
    assert.ok(warnings.some(message => message.includes('could not be persisted')))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
