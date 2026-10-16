/**
 * The quota readings through the real adapter entry points, both of them: the OAuth usage
 * document that `fetchClaudeUsage` parses, and the unified rate-limit headers the adapter
 * captures off an answered Messages response. The transport is injected and scripted, so
 * every byte is synthetic and no request leaves the process.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { ClaudeAdapter, deriveClaudeDeviceId, fetchClaudeUsage } from '../src/providers/claude.js'
import { CLAUDE_PROTOCOL_PROFILE } from '../src/providers/claude-protocol.js'
import { forgetUnifiedRateLimit, unifiedRateLimitFor } from '../src/providers/unified-rate-limit.js'
import type { FetchFn } from '../src/providers/common.js'
import type { ClaudeSession } from '../src/auth/store.js'
import { PermittingRecordPort } from './recording-port.js'
import { ownedClaudeContinuation } from './claude-maintenance-fixtures.js'

const USAGE_URL = CLAUDE_PROTOCOL_PROFILE.endpoints.usage
const UNIFIED_PREFIX = 'anthropic-ratelimit-unified-'
/** A synthetic machine fingerprint; never this host's own identifier. */
const FINGERPRINT = 'f'.repeat(64)
const TOKEN = 'synthetic-access-token-0123456789abcdef0123456789abcdef0123456789abcdef'

const SESSION: ClaudeSession = {
  accessToken: TOKEN,
  refreshToken: 'refresh-token',
  expiresAt: 1_786_003_600_000,
  scopes: 'user:inference',
  accountUuid: 'uuid-1',
  // Already bound to this machine, so a request presents it without a rebind write.
  deviceId: deriveClaudeDeviceId('uuid:uuid-1', FINGERPRINT),
  subscriptionType: 'max',
}

/** One scripted read of the usage endpoint, plus the requests it answered. */
interface UsageWire {
  /** The fetch function to hand `fetchClaudeUsage`. */
  fetch: FetchFn
  /** Every requested URL, in order; an unexpected path is recorded rather than answered. */
  requested: string[]
}

/**
 * Answer the usage endpoint from one synthetic document, and record what was asked for.
 *
 * A path other than the usage endpoint answers an error response so the assertion that
 * follows names the unexpected request instead of a parse failure, and the recorded list
 * proves the collection helper reached no other route.
 * @param body - the usage document to answer with.
 * @param status - the HTTP status to answer with.
 * @returns the scripted transport and its request log.
 */
function usageWire(body: unknown, status = 200): UsageWire {
  const requested: string[] = []
  const fetch = ((url: string | URL | Request): Promise<Response> => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    requested.push(href)
    if (href !== USAGE_URL) {
      return Promise.resolve(new Response('{"type":"error"}', { status: 404 }))
    }
    return Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }))
  }) as FetchFn
  return { fetch, requested }
}

/** The stored session the adapter resolves for the scripted account. */
function session(): ClaudeSession {
  return SESSION
}

test('fetchClaudeUsage reads the usage document through the shared core', async () => {
  const wire = usageWire({
    five_hour: { utilization: 6, resets_at: '2026-04-08T18:59:59Z' },
    seven_day: { utilization: 35, resets_at: '2026-04-14T16:59:59Z' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 21, resets_at: null },
  })
  const usage = await fetchClaudeUsage(session(), wire.fetch, undefined, undefined, 5_000)
  assert.deepEqual(usage, {
    supported: true,
    windows: [
      { kind: 'session', usedPercent: 6, resetsAt: Date.parse('2026-04-08T18:59:59Z') },
      { kind: 'weekly', usedPercent: 35, resetsAt: Date.parse('2026-04-14T16:59:59Z') },
      { kind: 'weekly', scope: 'Sonnet', usedPercent: 21 },
    ],
  })
  assert.deepEqual(wire.requested, [USAGE_URL], 'the collection helper asks the usage endpoint only')
})

test('the usage request keeps the headers the endpoint is documented to receive', async () => {
  let seen: Record<string, string> = {}
  const fetch = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    assert.equal(href, USAGE_URL)
    seen = init?.headers as Record<string, string>
    return Promise.resolve(new Response('{"five_hour":{"utilization":1}}', {
      headers: { 'content-type': 'application/json' },
    }))
  }) as FetchFn
  await fetchClaudeUsage(session(), fetch, undefined, undefined, 5_000)
  assert.equal(seen['authorization'], `Bearer ${TOKEN}`)
  assert.equal(seen['anthropic-beta'], 'oauth-2025-04-20')
  assert.equal(seen['content-type'], 'application/json')
  assert.equal(seen['accept'], 'application/json')
})

test('a strict reading of the usage document separates percent, ISO and missing resets', async () => {
  const wire = usageWire({ limits: [
    { kind: 'session', percent: 0, resets_at: '2026-04-08T18:59:59Z' },
    { kind: 'weekly_all', percent: 100 },
    { kind: 'weekly_scoped', percent: 7, scope: { model: { display_name: 'Opus' } } },
  ] })
  const usage = await fetchClaudeUsage(session(), wire.fetch, undefined, undefined, 5_000)
  assert.deepEqual(usage.windows, [
    { kind: 'session', usedPercent: 0, resetsAt: Date.parse('2026-04-08T18:59:59Z') },
    { kind: 'weekly', usedPercent: 100 },
    { kind: 'weekly', scope: 'Opus', usedPercent: 7 },
  ])
})

test('the nested limits array wins over the flat buckets in one body', async () => {
  const wire = usageWire({
    five_hour: { utilization: 99, resets_at: '2026-04-08T18:59:59Z' },
    limits: [{ kind: 'weekly_all', percent: 40, resets_at: '2026-04-14T16:59:59Z' }],
  })
  const usage = await fetchClaudeUsage(session(), wire.fetch, undefined, undefined, 5_000)
  assert.deepEqual(usage.windows, [
    { kind: 'weekly', usedPercent: 40, resetsAt: Date.parse('2026-04-14T16:59:59Z') },
  ])
})

test('a malformed or numeric reset keeps the window without inventing an instant', async () => {
  const numeric = usageWire({ five_hour: { utilization: 12, resets_at: 1786100000 } })
  const usage = await fetchClaudeUsage(session(), numeric.fetch, undefined, undefined, 5_000)
  assert.deepEqual(usage.windows, [{ kind: 'session', usedPercent: 12 }], 'a number is not read as epoch seconds')

  const malformed = usageWire({ five_hour: { utilization: 12, resets_at: 'not-a-date' } })
  const second = await fetchClaudeUsage(session(), malformed.fetch, undefined, undefined, 5_000)
  assert.deepEqual(second.windows, [{ kind: 'session', usedPercent: 12 }])
})

test('an out-of-range percent keeps its legacy window on the real path', async () => {
  // The application's range check decides what a strict reading may call known. The usage
  // surfaces have only ever required a finite number, so the window they render stays.
  const nested = usageWire({ limits: [
    { kind: 'session', percent: 140 },
    { kind: 'weekly_all', percent: -3 },
  ] })
  const usage = await fetchClaudeUsage(session(), nested.fetch, undefined, undefined, 5_000)
  assert.deepEqual(usage.windows, [
    { kind: 'session', usedPercent: 140 },
    { kind: 'weekly', usedPercent: -3 },
  ])
  // The flat buckets are held to the legacy rule too: the range has never been their
  // requirement either, and a real entry point must not narrow them. The strict side of the
  // same bodies is pinned in the core spec, which reads both projections from one call.
  const flat = usageWire({
    five_hour: { utilization: 140 },
    seven_day: { utilization: -3 },
  })
  const flatUsage = await fetchClaudeUsage(session(), flat.fetch, undefined, undefined, 5_000)
  assert.deepEqual(flatUsage.windows, [
    { kind: 'session', usedPercent: 140 },
    { kind: 'weekly', usedPercent: -3 },
  ])
})

test('a real response may state a reset the legacy surfaces already read', async () => {
  // The document declares ISO, and the legacy list has always accepted whatever `Date.parse`
  // reads. A response using another parseable form still reaches the usage surfaces.
  const wire = usageWire({ five_hour: { utilization: 12, resets_at: 'Fri, 15 Jan 2027 10:30:00 GMT' } })
  const usage = await fetchClaudeUsage(session(), wire.fetch, undefined, undefined, 5_000)
  assert.deepEqual(usage.windows, [
    { kind: 'session', usedPercent: 12, resetsAt: Date.parse('Fri, 15 Jan 2027 10:30:00 GMT') },
  ])
})

test('an unrecognized document key never reaches the reported windows', async () => {
  const wire = usageWire({
    five_hour: { utilization: 6 },
    secret_canary_window: { utilization: 6 },
  })
  const usage = await fetchClaudeUsage(session(), wire.fetch, undefined, undefined, 5_000)
  assert.deepEqual(usage.windows, [{ kind: 'session', usedPercent: 6 }])
  assert.ok(
    !JSON.stringify(usage).includes('secret_canary_window'),
    'the provider key name does not appear in the reported payload',
  )
})

test('the adapter captures the unified headers of an answered response for its account', async t => {
  forgetUnifiedRateLimit()
  const adapter = new ClaudeAdapter({
    models: [], discovery: false, streamIdleTimeoutMs: 60_000, tokens: tokens(), fetchFn: messagesFetch({
      [`${UNIFIED_PREFIX}status`]: 'allowed_warning',
      [`${UNIFIED_PREFIX}reset`]: '1786147200',
      [`${UNIFIED_PREFIX}7d-utilization`]: '0.97',
    }),
    deviceFingerprint: () => FINGERPRINT,
    // The adapter publishes every prepared request before it POSTs, so a construction that drives
    // a real stream states what its recorder answers.
    continuation: await ownedClaudeContinuation(t, ['acct']),
    requestRecord: new PermittingRecordPort(),
  })
  await drain(adapter)
  const state = unifiedRateLimitFor('claude', 'acct')
  assert.equal(state?.status, 'allowed_warning')
  assert.equal(state?.resetsAt, 1_786_147_200_000)
  assert.deepEqual(state?.windows, [{ window: '7d', utilization: 0.97 }])
})

test('a response carrying no unified header leaves the account without a report', async t => {
  forgetUnifiedRateLimit()
  const adapter = new ClaudeAdapter({
    models: [], discovery: false, streamIdleTimeoutMs: 60_000, tokens: tokens(),
    fetchFn: messagesFetch({ 'request-id': 'req_1' }),
    deviceFingerprint: () => FINGERPRINT,
    continuation: await ownedClaudeContinuation(t, ['acct']),
    requestRecord: new PermittingRecordPort(),
  })
  await drain(adapter)
  assert.equal(unifiedRateLimitFor('claude', 'acct'), undefined)
})

/** The answered Messages stream every adapter case drains. */
const RESPONSE_SSE = [
  `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 3 } } })}\n\n`,
  `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })}\n\n`,
  `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
].join('')

/** An account manager over one synthetic stored session. */
function tokens(): AccountTokenManager<ClaudeSession> {
  return new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Test',
    makeOptions: () => ({ preemptMs: 0, refresh: async () => SESSION, isPermanent: () => false }),
    io: {
      list: async () => [{ key: 'acct', session: SESSION }],
      get: async () => SESSION,
      save: async () => {},
      remove: async () => {},
    },
  })
}

/**
 * Answer one Messages request with the given response headers.
 * @param headers - the response headers to attach.
 * @returns the scripted transport.
 */
function messagesFetch(headers: Record<string, string>): FetchFn {
  return ((url: string | URL | Request): Promise<Response> => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    if (href !== CLAUDE_PROTOCOL_PROFILE.endpoints.messages) {
      return Promise.resolve(new Response('{"type":"error"}', { status: 404 }))
    }
    return Promise.resolve(new Response(RESPONSE_SSE, {
      headers: { 'content-type': 'text/event-stream', ...headers },
    }))
  }) as FetchFn
}

/**
 * Drive one generate call through the adapter and drain its stream.
 * @param adapter - the adapter to stream through.
 * @returns nothing, once the stream reached its terminal chunk.
 */
async function drain(adapter: ClaudeAdapter): Promise<void> {
  const options = {
    provider: 'claude',
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] as never,
    sessionId: 'sess-quota' as NonNullable<GenerateOptions['sessionId']>,
  }
  for await (const _chunk of adapter.stream(options) as AsyncIterable<StreamChunk>) continue
}
