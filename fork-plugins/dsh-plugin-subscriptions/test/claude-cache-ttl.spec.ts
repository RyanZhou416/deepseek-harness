/**
 * The Claude route's declared cache ttl, against the inputs the genuine 2.1.288 client
 * reads: the granted OAuth scope set, the call kind, and the account's own captured
 * unified rate-limit report. The builder is pure and the transport is never reached;
 * no network.
 *
 * The false friends this file exists for: a plan name (present, absent, or `free`) never
 * decides the ttl, `overage-in-use` is not the client's overage predicate, and one
 * account's report is never read for another account's request.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { IDENTITY_TEXT } from '@tormentalabs/claude-code-wire-compat'
import { buildClaudeWireRequest } from '../src/providers/claude-wire.js'
import {
  forgetUnifiedRateLimit,
  rememberUnifiedRateLimit,
} from '../src/providers/unified-rate-limit.js'
import type { UnifiedRateLimitState } from '../src/providers/unified-rate-limit.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

const SCOPED = 'user:profile user:inference'
const UNSCOPED = 'user:profile'

function session(overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    // Long synthetic token: the builder's token-isolation check rejects a request whose
    // access token is a substring of any other header value, and a realistic token never is.
    accessToken: 'synthetic-access-token-0123456789abcdef0123456789abcdef0123456789abcdef',
    refreshToken: 'ref',
    expiresAt: Date.now() + 3_600_000,
    scopes: SCOPED,
    accountUuid: 'uuid-1',
    deviceId: 'dev-1',
    subscriptionType: 'max',
    ...overrides,
  }
}

function history(): TranslatableMessage[] {
  return [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
}

function options(
  purpose?: GenerateOptions['purpose'],
  requestClass?: GenerateOptions['requestClass'],
): GenerateOptions {
  return {
    provider: 'claude',
    model: 'claude-opus-5',
    messages: history() as never,
    system: 'be terse',
    ...purpose === undefined ? {} : { purpose },
    ...requestClass === undefined ? {} : { requestClass },
  }
}

/** One captured unified report; every member a test does not state stays unset. */
function report(overrides: Partial<UnifiedRateLimitState> = {}): UnifiedRateLimitState {
  return { status: 'allowed', windows: [], observedAt: Date.now(), ...overrides }
}

/** The wire session id a named attempt declares: the client declares its session as a UUID. */
function wireSessionId(name: string): string {
  const bytes = Buffer.from(createHash('sha256').update(`cache-ttl:${name}`).digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Whether one built request declares the hour and carries the beta that states it.
 * @param account - the canonical account key the report is filed under.
 * @param accountSession - the account session the request is made under.
 * @param purpose - the call kind the caller classified, when it classified one.
 * @param requestClass - the caller's explicit call class, when it set one.
 * @returns whether the request declares the hour and its beta.
 */
async function declaresHour(
  account: string,
  accountSession: ClaudeSession,
  purpose?: GenerateOptions['purpose'],
  requestClass?: GenerateOptions['requestClass'],
): Promise<{ ttl: boolean; beta: boolean }> {
  const built = await buildClaudeWireRequest(
    options(purpose, requestClass), accountSession, history(), 32_000, undefined, undefined,
    { sessionId: wireSessionId(`${account}:${purpose ?? 'main'}:${requestClass ?? 'purpose'}:${accountSession.scopes}`),
      atisPin: undefined, previousRequestId: undefined }, account,
  )
  const beta = String(built.headers.find(([name]) => name.toLowerCase() === 'anthropic-beta')?.[1] ?? '')
  return {
    ttl: String(built.body).includes('"ttl":"1h"'),
    beta: beta.includes('extended-cache-ttl'),
  }
}

test('a scoped session with no captured report declares the hour', async () => {
  forgetUnifiedRateLimit()
  assert.deepEqual(await declaresHour('acct-none', session()), { ttl: true, beta: true })
})

test('the plan name never decides the ttl', async () => {
  forgetUnifiedRateLimit()
  // The profile read is not consulted at all: an undisclosed plan and a plan named `free`
  // both declare the hour, because the granted scope set is what the client reads.
  const { subscriptionType: undisclosed, ...noPlan } = session()
  void undisclosed
  assert.deepEqual(await declaresHour('acct-noplan', { ...noPlan, scopes: SCOPED }), { ttl: true, beta: true })
  assert.deepEqual(await declaresHour('acct-free', session({ subscriptionType: 'free' })), { ttl: true, beta: true })
})

test('a session granted no user:inference scope takes the server default', async () => {
  forgetUnifiedRateLimit()
  assert.deepEqual(await declaresHour('acct-unscoped', session({ scopes: UNSCOPED })), { ttl: false, beta: false })
  assert.deepEqual(await declaresHour('acct-empty', session({ scopes: '' })), { ttl: false, beta: false })
})

test('overage-in-use alone is not the client overage predicate', async () => {
  forgetUnifiedRateLimit()
  // The client derives its own term from the status and the overage route; the separate
  // `overage-in-use` member is a different statement and must not withdraw the hour.
  rememberUnifiedRateLimit('claude', 'acct-inuse', report({ overageInUse: true }))
  assert.deepEqual(await declaresHour('acct-inuse', session()), { ttl: true, beta: true })
})

test('a rejected status on an allowed overage route withdraws the hour', async () => {
  forgetUnifiedRateLimit()
  rememberUnifiedRateLimit('claude', 'acct-ov-allowed', report({ status: 'rejected', overageStatus: 'allowed' }))
  assert.deepEqual(await declaresHour('acct-ov-allowed', session()), { ttl: false, beta: false })

  rememberUnifiedRateLimit('claude', 'acct-ov-warning', report({ status: 'rejected', overageStatus: 'allowed_warning' }))
  assert.deepEqual(await declaresHour('acct-ov-warning', session()), { ttl: false, beta: false })

  // A rejected status whose overage route is itself refused is not the predicate.
  rememberUnifiedRateLimit('claude', 'acct-ov-rejected', report({ status: 'rejected', overageStatus: 'rejected' }))
  assert.deepEqual(await declaresHour('acct-ov-rejected', session()), { ttl: true, beta: true })

  // Nor is an overage route answering while the account itself stands fine.
  rememberUnifiedRateLimit('claude', 'acct-plain', report({ overageStatus: 'allowed' }))
  assert.deepEqual(await declaresHour('acct-plain', session()), { ttl: true, beta: true })
})

test('a helper call takes the server default even for a scoped session', async () => {
  forgetUnifiedRateLimit()
  // The client's long-ttl allowlist names its main-thread, sdk, auto-mode and
  // memory-relevance sources; `compact` and `generate_session_title` are not on it.
  assert.deepEqual(await declaresHour('acct-compact', session(), 'compaction'), { ttl: false, beta: false })
  assert.deepEqual(await declaresHour('acct-title', session(), 'session-title'), { ttl: false, beta: false })
  assert.deepEqual(await declaresHour('acct-main', session()), { ttl: true, beta: true })
})

test('an explicit class decides the hour the way the purpose it outranks would', async () => {
  forgetUnifiedRateLimit()
  // The three helper classes take the default lifetime however the purpose reads, and an
  // explicit main keeps the hour even when the purpose names a helper call.
  for (const requestClass of ['auxiliary', 'subagent', 'compaction'] as const) {
    assert.deepEqual(
      await declaresHour(`acct-class-${requestClass}`, session(), undefined, requestClass),
      { ttl: false, beta: false },
      `${requestClass} takes the default lifetime`,
    )
  }
  assert.deepEqual(await declaresHour('acct-class-main', session(), 'session-title', 'main'), { ttl: true, beta: true })

  // The explicit main class still answers to the scope grant and to the overage reading:
  // the class is one input, not an override of the client's own predicate.
  assert.deepEqual(
    await declaresHour('acct-class-main-unscoped', session({ scopes: UNSCOPED }), undefined, 'main'),
    { ttl: false, beta: false },
  )
  rememberUnifiedRateLimit('claude', 'acct-class-main-overage', report({ status: 'rejected', overageStatus: 'allowed' }))
  assert.deepEqual(
    await declaresHour('acct-class-main-overage', session(), undefined, 'main'),
    { ttl: false, beta: false },
  )
  forgetUnifiedRateLimit()
})

test('one account report is never read for another account', async () => {
  forgetUnifiedRateLimit()
  rememberUnifiedRateLimit('claude', 'acct-on-ov', report({ status: 'rejected', overageStatus: 'allowed' }))
  rememberUnifiedRateLimit('claude', 'acct-clean', report())
  assert.deepEqual(await declaresHour('acct-on-ov', session()), { ttl: false, beta: false })
  assert.deepEqual(await declaresHour('acct-clean', session()), { ttl: true, beta: true })
  // Reversed order, so neither result can come from the other's capture order.
  assert.deepEqual(await declaresHour('acct-clean', session()), { ttl: true, beta: true })
  assert.deepEqual(await declaresHour('acct-on-ov', session()), { ttl: false, beta: false })
  forgetUnifiedRateLimit()
})

test('a helper call carries the single documented identity, billing and 5m form', async () => {
  // The helper path is the same builder as the main path: one interactive identity line,
  // one billing block with the prompt-anchored turn segments, and only the server-default
  // (five-minute) ephemeral cache markers because a helper takes no hour. No extra helper
  // header is invented, and the header plan keeps the pinned transport user agent.
  forgetUnifiedRateLimit()
  const built = await buildClaudeWireRequest(
    options('session-title'), session(), history(), 32_000, undefined, undefined,
    { sessionId: wireSessionId('acct-helper-form'), atisPin: undefined, previousRequestId: undefined },
    'acct-helper-form',
  )
  const body = JSON.parse(built.body) as {
    system: { text: string; cache_control?: unknown }[]
    messages: { content: { cache_control?: unknown }[] }[]
  }
  const system = body.system
  assert.match(
    system[0].text,
    / cc_prompt_id=[0-9a-f-]{36}; cc_turn_origin=human; cc_prompt_index=1; cc_turn_index=1;$/,
  )
  assert.equal(system[1].text, IDENTITY_TEXT, 'the interactive identity line')
  assert.deepEqual(system[1].cache_control, { type: 'ephemeral' }, 'a five-minute identity marker')
  // Every marker this request carries is the plain ephemeral form; the hour marker and the
  // beta that declares it are both absent.
  const markers = [
    ...system.map((block) => block.cache_control),
    ...body.messages.flatMap((message) => message.content.map((block) => block.cache_control)),
  ].filter((marker) => marker !== undefined)
  assert.ok(markers.length > 0, 'the request carries its own markers')
  for (const marker of markers) {
    assert.deepEqual(marker, { type: 'ephemeral' })
  }
  assert.equal(String(built.body).includes('"ttl"'), false)
  const headers = new Map(built.headers.map(([name, value]) => [name.toLowerCase(), value]))
  assert.equal(headers.get('user-agent'), 'claude-cli/2.1.288 (external, claude-desktop)')
  assert.equal(headers.get('x-stainless-helper'), undefined, 'no helper header is invented')
  assert.equal((headers.get('anthropic-beta') ?? '').includes('extended-cache-ttl'), false)
})
