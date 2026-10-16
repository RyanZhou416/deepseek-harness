/**
 * The real plugin adapter under a HIPAA policy: what reaches the wire, and what is refused before
 * anything does.
 *
 * Every case drives `ClaudeAdapter` through its injected `fetchFn` with a synthetic session, so the
 * headers asserted here are the ones production would send. No network, no real account and no
 * credential: the profile, device fingerprint and protocol store are all this file's own.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ClaudeAdapter, deriveClaudeDeviceId } from '../src/providers/claude.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { ClaudeProtocolBlockStore } from '../src/providers/claude-protocol-state.js'
import { CLAUDE_PROTOCOL_PROFILE } from '../src/providers/claude-protocol.js'
import type { FetchFn } from '../src/providers/common.js'
import type { ClaudeEnginePolicy } from '../src/claude-engine/request-policy.js'
import { ownedClaudeContinuation } from './claude-maintenance-fixtures.js'
import { PermittingRecordPort } from './recording-port.js'

/** The account uuid this file's synthetic session carries. */
const ACCOUNT_UUID = '00000000-0000-4000-8000-000000000001'

/** A synthetic machine fingerprint; never this host's own identifier. */
const FINGERPRINT = 'a1'.repeat(32)

/** A capable model whose catalogue entry binds the mid-conversation betas. */
const MODEL = 'claude-sonnet-5-5'

/** The synthetic harness session each case's Messages request is recorded under. */
const SESSION = 'sess-policy-request' as NonNullable<GenerateOptions['sessionId']>

/** A complete SSE response, so an accepted turn reaches its terminal event. */
const COMPLETE_SSE = [
  { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')

/** A session already bound to this machine, the shape a login stores. */
function syntheticSession(): {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string
  accountUuid: string
  deviceId: string
} {
  return {
    accessToken: 'synthetic-access',
    refreshToken: 'synthetic-refresh',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    accountUuid: ACCOUNT_UUID,
    deviceId: deriveClaudeDeviceId(`uuid:${ACCOUNT_UUID}`, FINGERPRINT),
  }
}

/**
 * Tokens over one in-memory session.
 * @returns the manager the adapter reads its credential from.
 */
function tokens(): AccountTokenManager<ReturnType<typeof syntheticSession>> {
  const stored = syntheticSession()
  return new AccountTokenManager<ReturnType<typeof syntheticSession>>({
    provider: 'claude',
    displayName: 'test',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: async (current: ReturnType<typeof syntheticSession>) => current,
      isPermanent: () => false,
    }),
    io: {
      list: async () => [{ key: 'account', session: stored }],
      get: async () => stored,
      save: async () => {},
      remove: async () => {},
    },
  })
}

/** A captured request this file can assert on. */
interface Captured {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

/**
 * Build one adapter whose transport records what the production path sent.
 * @param t - the case that owns the protocol-store directory and the continuation owner.
 * @param policy - the trusted policy the host would project, when it projects one.
 * @returns the adapter, its captures, and readers for the request counts.
 */
async function adapterUnder(
  t: Pick<TestContext, 'after'>,
  policy: ((input: { account: string; sessionId?: string }) => ClaudeEnginePolicy) | undefined,
): Promise<{
  adapter: ClaudeAdapter
  captured: readonly Captured[]
  messages: () => number
  files: () => number
}> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-policy-request-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const captured: Captured[] = []
  const fetchFn: FetchFn = async (url, init) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>)
        .map(([name, value]) => [name.toLowerCase(), value]),
    )
    captured.push({ url: String(url), headers, body: String(init?.body ?? '') })
    return new Response(COMPLETE_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const adapter = new ClaudeAdapter({
    models: [],
    discovery: false,
    streamIdleTimeoutMs: 60_000,
    tokens: tokens() as never,
    fetchFn,
    deviceFingerprint: () => FINGERPRINT,
    protocolBlocks: new ClaudeProtocolBlockStore({ directory }),
    protocolProfile: CLAUDE_PROTOCOL_PROFILE,
    continuation: await ownedClaudeContinuation(t, ['account']),
    requestRecord: new PermittingRecordPort(),
    ...policy === undefined ? {} : { requestPolicy: policy },
  } as never)
  return {
    adapter,
    captured,
    messages: () => captured.filter(record => record.url.includes('/v1/messages')).length,
    files: () => captured.filter(record => record.url.includes('/v1/files')).length,
  }
}

/**
 * Run one account-scoped turn, the path the harness drives.
 * @param adapter - the adapter under test.
 * @param messages - the conversation the loop hands over.
 * @returns how many events the turn produced.
 */
async function turn(
  adapter: ClaudeAdapter,
  messages: readonly { role: 'user' | 'assistant' | 'system'; content: readonly { type: string; text: string }[] }[],
): Promise<number> {
  let count = 0
  for await (const _event of adapter.streamAccount({
    provider: 'claude', model: MODEL, maxTokens: 512, system: 'top level', messages: messages as never,
    sessionId: SESSION,
  }, 'account')) count += 1
  return count
}

test('a HIPAA policy withholds the betas on a real request and leaves the turn working', async (context) => {
  const built = await adapterUnder(context, () => ({ suppressMidConversationSystem: true }))
  const events = await turn(built.adapter, [
    { role: 'user', content: [{ type: 'text', text: 'You are a coding agent.' }, { type: 'text', text: 'hello there' }] },
  ])
  assert.ok(events > 0, 'the accepted turn produced events')
  assert.equal(built.messages(), 1, 'exactly one Messages request was sent')

  const request = built.captured[0]
  assert.ok(request !== undefined)
  const betaHeader = request.headers['anthropic-beta'] ?? ''
  const surface = `${betaHeader}\n${request.body}`
  for (const beta of [
    'mid-conversation-system-2026-04-07',
    'mid-conversation-tool-changes-2026-07-01',
    'mid-conversation-system-clear-at-2026-08-21',
  ]) {
    assert.equal(surface.includes(beta), false, beta)
  }
  assert.match(betaHeader, /oauth-/, 'the beta the account authenticates with is preserved')
  assert.ok(request.body.includes('top level'), 'the top-level system prompt is preserved')
  assert.ok(request.body.includes('You are a coding agent.'), 'the caller text is preserved')
  assert.ok(request.body.includes('hello there'), 'the user message is preserved')
  assert.ok(request.body.includes(ACCOUNT_UUID), 'the request carries the canonical account identity')
})

test('a mid-conversation system message is refused locally and blocks nothing', async (context) => {
  const built = await adapterUnder(context, () => ({ suppressMidConversationSystem: true }))
  let refusal: unknown
  try {
    await turn(built.adapter, [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'system', content: [{ type: 'text', text: 'be terse' }] },
    ])
  } catch (error: unknown) {
    refusal = error
  }
  assert.ok(refusal !== undefined, 'the shape is refused')
  const failure = (refusal as { failure?: { code?: string; retryDisposition?: string } }).failure
  assert.equal(failure?.code, 'POLICY_UNSUPPORTED', 'a local policy code, never a version refusal')
  assert.equal(failure?.retryDisposition, 'forbid')
  assert.equal(built.messages(), 0, 'no Messages request was sent')
  assert.equal(built.files(), 0, 'no Files request was sent')
  assert.ok(!String((refusal as Error).message).includes('be terse'), 'the message carries no conversation text')

  // A later request that opens with a system prompt still goes out: the local refusal recorded no
  // provider-profile block, so it cannot masquerade as a version upgrade the user must perform.
  const accepted = await turn(built.adapter, [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  ])
  assert.ok(accepted > 0)
  assert.equal(built.messages(), 1, 'the next valid request was sent')
})

test('without a policy the same capable model still carries its mid-conversation beta', async (context) => {
  const built = await adapterUnder(context, undefined)
  await turn(built.adapter, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
  assert.equal(built.messages(), 1)
  const request = built.captured[0]
  assert.ok(request !== undefined)
  const surface = `${request.headers['anthropic-beta'] ?? ''}\n${request.body}`
  assert.ok(surface.includes('mid-conversation-system-2026-04-07'), 'the ordinary build is unchanged')
})
