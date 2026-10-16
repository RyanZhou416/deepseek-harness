/**
 * The managed-settings reader: the settings role's own headers and quoted conditional checksum,
 * the envelope that keeps unknown keys, the 304 that is valid only against a sent validator, the
 * endpoint's empty-success statuses, and the redirect that is never read as the pinned endpoint.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CLAUDE_ACCOUNT_CLIENT_PROFILE,
  CLAUDE_OAUTH_BETA,
  CLAUDE_PLAIN_USER_AGENT,
  CLAUDE_SETTINGS_BODY_LIMIT,
  CLAUDE_SETTINGS_TIMEOUT_MS,
  CLAUDE_SETTINGS_URL,
  claudeIfNoneMatch,
  parseClaudeManagedSettingsEnvelope,
  readClaudeManagedSettings,
} from '../src/claude-account-client/index.js'
import type {
  ClaudeAccountResponse,
  ClaudeAccountTransport,
  ClaudeManagedSettingsOutcome,
} from '../src/claude-account-client/index.js'

/** One request as the transport received it, copied so a later mutation cannot rewrite history. */
interface Wire {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string | null
  readonly timeoutMs: number
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
      }
      wires.push(wire)
      return await reply(wire)
    },
  }
}

/** A JSON response with the headers the settings endpoint sends. */
function jsonResponse(status: number, document?: unknown): Response {
  return new Response(document === undefined ? null : JSON.stringify(document), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('the settings GET carries its own role headers plus a quoted conditional checksum', async () => {
  const document = {
    uuid: 'rev-2',
    checksum: 'sum-2',
    settings: { permissions: { deny: ['Bash'] }, unknownFutureKey: { nested: [1, 2] } },
  }
  const { transport, wires } = wireTransport(() => jsonResponse(200, document))
  const outcome = await readClaudeManagedSettings({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    cached: { uuid: 'rev-1', checksum: 'sum-1' },
  })
  assert.equal(wires.length, 1)
  const wire = wires[0]
  assert.equal(wire?.method, 'GET')
  assert.equal(wire?.url, CLAUDE_SETTINGS_URL)
  assert.equal(wire?.body, null)
  assert.equal(wire?.timeoutMs, CLAUDE_SETTINGS_TIMEOUT_MS)
  assert.deepEqual(wire?.headers, {
    authorization: 'Bearer at-1',
    'user-agent': CLAUDE_PLAIN_USER_AGENT,
    'anthropic-beta': CLAUDE_OAUTH_BETA,
    'accept': 'application/json',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'if-none-match': '"sum-1"',
  })
  assert.equal(outcome.kind, 'accepted')
  if (outcome.kind !== 'accepted') return
  // The syntax-only parser keeps every key the service stated, including one this build has no
  // meaning for, and this reader declares nothing enforced about any of them.
  assert.deepEqual(outcome.envelope, { uuid: 'rev-2', checksum: 'sum-2', settings: document.settings })
  assert.equal(claudeIfNoneMatch('sum-1'), '"sum-1"')
  assert.equal(claudeIfNoneMatch('"already"'), '"already"')
})

test('an unconditional read sends no validator and a 304 without one is refused', async () => {
  const { transport, wires } = wireTransport(() => jsonResponse(304))
  const outcome = await readClaudeManagedSettings({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
  })
  assert.equal(wires[0]?.headers['if-none-match'], undefined)
  assert.equal(outcome.kind, 'invalid')
  if (outcome.kind !== 'invalid') return
  assert.equal(outcome.failure.reason, 'unexpected_304')
})

test('a 304 answers only for the checksum that was actually sent', async () => {
  const { transport, wires } = wireTransport(() => jsonResponse(304))
  const outcome = await readClaudeManagedSettings({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    cached: { uuid: 'rev-1', checksum: 'sum-1' },
  })
  assert.equal(wires[0]?.headers['if-none-match'], '"sum-1"')
  assert.equal(outcome.kind, 'unchanged')
  if (outcome.kind !== 'unchanged') return
  assert.deepEqual(outcome.cache, { uuid: 'rev-1', checksum: 'sum-1' })
})

test('an empty cache checksum sends no validator and cannot revalidate', async () => {
  const { transport, wires } = wireTransport(() => jsonResponse(304))
  const outcome = await readClaudeManagedSettings({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    cached: { uuid: 'sentinel', checksum: '' },
  })
  assert.equal(wires[0]?.headers['if-none-match'], undefined)
  assert.equal(outcome.kind, 'invalid')
})

test('204 and 404 are the endpoint own empty sentinels', async () => {
  for (const status of [204, 404]) {
    const { transport, wires } = wireTransport(() => jsonResponse(status))
    const outcome: ClaudeManagedSettingsOutcome = await readClaudeManagedSettings({
      accessToken: 'at-1',
      profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
      transport,
      cached: { uuid: 'rev-1', checksum: 'sum-1' },
    })
    assert.equal(outcome.kind, 'empty', String(status))
    assert.equal(wires.length, 1)
  }
})

test('a redirected settings read is refused and never read as the pinned endpoint', async () => {
  const { transport } = wireTransport(() => new Response(null, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  const withoutFlag = await readClaudeManagedSettings({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
  })
  assert.equal(withoutFlag.kind, 'invalid')
  if (withoutFlag.kind !== 'invalid') return
  assert.equal(withoutFlag.failure.reason, 'malformed_envelope')

  const redirected = wireTransport(() => ({
    status: 200,
    headers: new Headers(),
    body: null,
    redirected: true,
    url: 'https://settings-mirror.example/api/claude_code/settings',
  }))
  const outcome = await readClaudeManagedSettings({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport: redirected.transport,
  })
  assert.equal(outcome.kind, 'invalid')
  if (outcome.kind !== 'invalid') return
  assert.equal(outcome.failure.code, 'redirected')
})

test('the envelope requires all three members and every failure stays a fixed code', async () => {
  assert.equal(parseClaudeManagedSettingsEnvelope('{"uuid":"r","settings":{}}'), undefined)
  assert.equal(parseClaudeManagedSettingsEnvelope('{"uuid":"","checksum":"c","settings":{}}'), undefined)
  assert.equal(parseClaudeManagedSettingsEnvelope('{"uuid":"r","checksum":"c","settings":[]}'), undefined)
  assert.equal(parseClaudeManagedSettingsEnvelope('not json'), undefined)
  assert.deepEqual(
    parseClaudeManagedSettingsEnvelope('{"uuid":"r","checksum":"c","settings":{}}'),
    { uuid: 'r', checksum: 'c', settings: {} },
  )

  const { transport } = wireTransport(() => jsonResponse(200, { uuid: 'r', checksum: 'c' }))
  const outcome = await readClaudeManagedSettings({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
  })
  assert.equal(outcome.kind, 'invalid')
  if (outcome.kind !== 'invalid') return
  assert.equal(outcome.failure.reason, 'malformed_envelope')
  assert.equal(outcome.failure.code, 'invalid')
})

test('a server failure leaves the caller snapshot alone and an unneeded read sends nothing', async () => {
  const { transport, wires } = wireTransport(() => jsonResponse(500, { error: 'api_error' }))
  const outcome = await readClaudeManagedSettings({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    cached: { uuid: 'rev-1', checksum: 'sum-1' },
  })
  assert.equal(outcome.kind, 'unreachable')
  if (outcome.kind !== 'unreachable') return
  assert.equal(outcome.failure.code, 'unreachable')
  assert.equal(wires.length, 1)

  const skipped = await readClaudeManagedSettings({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    required: () => false,
  })
  assert.equal(skipped.kind, 'not-required')
  assert.equal(wires.length, 1, 'nothing was sent for the unneeded read')
})

test('a settings body over the product bound is cancelled at the bound, not read whole', async () => {
  const observed = { chunks: 0, cancelled: false }
  let remaining = 1_024
  const chunk = new Uint8Array(4_096).fill(0x61)
  const { transport } = wireTransport(() => new Response(new ReadableStream<Uint8Array>({
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
  }), { status: 200 }))
  const outcome = await readClaudeManagedSettings({
    accessToken: 'at-1',
    profile: CLAUDE_ACCOUNT_CLIENT_PROFILE,
    transport,
    timeoutMs: 5_000,
  })
  assert.equal(outcome.kind, 'invalid')
  if (outcome.kind !== 'invalid') return
  assert.equal(outcome.failure.code, 'body_over_limit')
  assert.equal(observed.cancelled, true)
  // The stream's own queue may pull one chunk ahead of the reader; a whole read would pull 1024.
  assert.ok(
    observed.chunks <= CLAUDE_SETTINGS_BODY_LIMIT / 4_096 + 8,
    `the read stopped at the bound, pulled ${String(observed.chunks)} chunks`,
  )
})
