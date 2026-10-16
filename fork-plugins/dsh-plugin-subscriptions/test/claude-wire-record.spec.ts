/**
 * The Claude Messages recording seam at the production producer: the adapter
 * records the ordered system text of the exact body it is about to POST, sends
 * nothing when the record is refused, and reaches no credential, upload or
 * endpoint at all when the request names no session.
 *
 * Every case builds a real `ClaudeAdapter` over synthetic credentials and a fixed
 * mock transport that rejects any path other than the Messages endpoint.
 *
 * A case that reaches a send wires the shipped durable continuation owner over a directory it owns,
 * because the adapter commits a wire identity before it may POST; the sessionless case wires none,
 * so its refusal stays the earliest one.
 */

import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { LlmRequestRecordOutcome, LlmRequestRecordPayload } from '@deepseek-ai/dsh-llm-request-record'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { ClaudeAdapter, deriveClaudeDeviceId } from '../src/providers/claude.js'
import { CLAUDE_PROTOCOL_PROFILE } from '../src/providers/claude-protocol.js'
import { ClaudeProtocolBlockStore } from '../src/providers/claude-protocol-state.js'
import {
  CLAUDE_WIRE_RECORD_LIBRARY,
  ClaudeRequestRecordPort,
  extractClaudeSystemBlocks,
} from '../src/providers/claude-wire-record.js'
import type { ClaudeRecordSessionId } from '../src/providers/claude-wire-record.js'
import type { ClaudeSession } from '../src/auth/store.js'
import { ownedClaudeContinuation } from './claude-maintenance-fixtures.js'

const MODEL = 'claude-opus-4-5'
const ACCOUNT_UUID = '00000000-0000-4000-8000-000000000009'
const FINGERPRINT = 'b2'.repeat(32)

/** A session id for this file's synthetic conversations, as the sibling specs declare one. */
const recordSession = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

/** A recorded log position for this file's stub recorder, branded the same way. */
const preparedSeq = (seq: number): SessionSeq => seq as SessionSeq

/** The one request body this file submits; the adapter owns everything else about it. */
const MESSAGES: GenerateOptions['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]

/** One accepted Messages response: start, one text delta, stop. */
const COMPLETE = [
  { type: 'message_start', message: { usage: { input_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')

/** A synthetic session already bound to this machine. */
function session(): ClaudeSession {
  return {
    accessToken: 'synthetic-access-token-0123456789abcdef0123456789abcdef0123456789abcdef',
    refreshToken: 'synthetic-refresh',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference user:profile',
    accountUuid: ACCOUNT_UUID,
    deviceId: deriveClaudeDeviceId(`uuid:${ACCOUNT_UUID}`, FINGERPRINT),
    subscriptionType: 'max',
  }
}

/** The account manager under test, counting the credential reads a case must not perform. */
class CountingTokens extends AccountTokenManager<ClaudeSession> {
  credentialReads = 0

  override async session(account?: string, forceRefresh = false): Promise<ClaudeSession> {
    this.credentialReads += 1
    return await super.session(account, forceRefresh)
  }
}

/** Synthetic stored credentials, with the one refresh a 401 replay performs. */
function tokens(): CountingTokens {
  let stored = session()
  return new CountingTokens({
    provider: 'claude',
    displayName: 'test',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: async current => ({ ...current, accessToken: `${current.accessToken}-refreshed` }),
      isPermanent: () => false,
    }),
    io: {
      list: async () => [{ key: 'account', session: stored }],
      get: async () => stored,
      save: async (_key, next) => { stored = next },
      remove: async () => {},
    },
  })
}

/**
 * A protocol-block store over a directory this case owns.
 *
 * The store is durable and keyed by the pinned profile alone, so a refusal one
 * case recorded would otherwise refuse that profile for every later case in this
 * process.
 * @param context - the case that owns the directory.
 * @returns the store to inject, and the directory removed when the case ends.
 */
async function ownedProtocolBlocks(
  context: TestContext,
): Promise<{ blocks: ClaudeProtocolBlockStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-wire-record-blocks-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return { blocks: new ClaudeProtocolBlockStore({ directory }), directory }
}

/** The port under test, scripted by the case that owns it. */
class StubRequestRecordPort extends ClaudeRequestRecordPort {
  readonly calls: { sessionId: ClaudeRecordSessionId | undefined; payload: LlmRequestRecordPayload }[] = []
  private readonly answer: () => Promise<LlmRequestRecordOutcome>

  constructor(answer: () => Promise<LlmRequestRecordOutcome>) {
    super()
    this.answer = answer
  }

  override record(
    sessionId: ClaudeRecordSessionId | undefined,
    payload: LlmRequestRecordPayload,
  ): Promise<LlmRequestRecordOutcome> {
    this.calls.push({ sessionId, payload })
    return this.answer()
  }
}

/** The system text one serialized body carries, read without the producer's own reader. */
function postedSystemTexts(body: string): readonly string[] {
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== 'object' || parsed === null || !('system' in parsed)) {
    throw new TypeError('the posted body carries no system list')
  }
  const system = parsed.system
  if (!Array.isArray(system)) throw new TypeError('the posted system value is not a list')
  return system.map((block) => {
    if (typeof block !== 'object' || block === null || !('text' in block) || typeof block.text !== 'string') {
      throw new TypeError('a posted system block carries no text')
    }
    return block.text
  })
}

/** The pinned library's own name and version, read from the manifest the resolver loads. */
function manifestNameVersion(value: unknown): { name: string; version: string } {
  if (typeof value !== 'object' || value === null) throw new TypeError('the installed manifest is not an object')
  const name = 'name' in value ? value.name : undefined
  const version = 'version' in value ? value.version : undefined
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw new TypeError('the installed manifest carries no name and version')
  }
  return { name, version }
}

/** Whether a caught value is the harness error this route fails with. */
function isLlmError(value: unknown): value is LlmError {
  return value instanceof LlmError
}

/** Drain one adapter stream, propagating whatever it rejects with. */
async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

test('the recorded wire library pin matches the installed manifest', async () => {
  const entry = import.meta.resolve('@tormentalabs/claude-code-wire-compat')
  const { name, version } = manifestNameVersion(
    JSON.parse(await readFile(join(dirname(fileURLToPath(entry)), '..', 'package.json'), 'utf8')),
  )
  assert.equal(CLAUDE_WIRE_RECORD_LIBRARY, `${name}@${version}`)
})

test('the adapter records the posted system text before it POSTs', async t => {
  const { blocks } = await ownedProtocolBlocks(t)
  const order: string[] = []
  const bodies: string[] = []
  const port = new StubRequestRecordPort(async () => {
    order.push('record')
    return { ok: true, preparedId: preparedSeq(1) }
  })
  const adapter = new ClaudeAdapter({
    models: [], discovery: false, streamIdleTimeoutMs: 60_000, tokens: tokens(),
    fetchFn: async (url, init) => {
      order.push('post')
      assert.equal(new URL(url instanceof Request ? url.url : url).pathname, '/v1/messages')
      bodies.push(String(init?.body))
      return new Response(COMPLETE)
    },
    deviceFingerprint: () => FINGERPRINT,
    protocolBlocks: blocks,
    protocolProfile: CLAUDE_PROTOCOL_PROFILE,
    continuation: await ownedClaudeContinuation(t, ['account']),
    requestRecord: port,
  })

  await drain(adapter.streamAccount({
    provider: 'claude', model: MODEL, sessionId: recordSession('sess-record'), messages: MESSAGES,
    system: 'be terse',
  }, 'account'))

  assert.deepEqual(order, ['record', 'post'])
  assert.equal(port.calls.length, 1)
  const payload = port.calls[0]!.payload
  assert.equal(payload.provider, 'claude')
  assert.equal(payload.model, MODEL)
  assert.equal(payload.purpose, 'conversation')
  assert.equal(payload.profile, CLAUDE_PROTOCOL_PROFILE.id)
  assert.equal(payload.wireLibrary, CLAUDE_WIRE_RECORD_LIBRARY)
  // The equality clause of the record contract, read back out of the bytes that went out.
  assert.deepEqual(payload.systemBlocks, postedSystemTexts(bodies[0]!))
  assert.deepEqual(extractClaudeSystemBlocks(bodies[0]!), payload.systemBlocks)
  // Ordered emitted text: the billing and identity blocks precede the caller's own prompt.
  assert.equal(payload.systemBlocks.at(-1), 'be terse')
  assert.ok(payload.systemBlocks.length >= 3, 'the pinned builder emits the billing and identity blocks too')
})

test('a refused record sends zero bytes', async t => {
  const { blocks } = await ownedProtocolBlocks(t)
  let posts = 0
  const port = new StubRequestRecordPort(async () => ({ ok: false, code: 'REQUEST_RECORD_UNAVAILABLE' }))
  const adapter = new ClaudeAdapter({
    models: [], discovery: false, streamIdleTimeoutMs: 60_000, tokens: tokens(),
    fetchFn: async () => { posts += 1; return new Response(COMPLETE) },
    deviceFingerprint: () => FINGERPRINT,
    protocolBlocks: blocks,
    protocolProfile: CLAUDE_PROTOCOL_PROFILE,
    continuation: await ownedClaudeContinuation(t, ['account']),
    requestRecord: port,
  })

  const failure = await drain(adapter.streamAccount({
    provider: 'claude', model: MODEL, sessionId: recordSession('sess-refused'), messages: MESSAGES,
  }, 'account')).then(() => undefined, (error: unknown) => error)

  assert.ok(isLlmError(failure), 'a refused record fails the request')
  assert.equal(failure.code, 'REQUEST_RECORD_UNAVAILABLE')
  assert.equal(failure.failure.retryDisposition, 'forbid')
  assert.equal(posts, 0)
  assert.equal(port.calls.length, 1)
})

test('an unbound port refuses the send without a recorder', async t => {
  const { blocks } = await ownedProtocolBlocks(t)
  let posts = 0
  const adapter = new ClaudeAdapter({
    models: [], discovery: false, streamIdleTimeoutMs: 60_000, tokens: tokens(),
    fetchFn: async () => { posts += 1; return new Response(COMPLETE) },
    deviceFingerprint: () => FINGERPRINT,
    protocolBlocks: blocks,
    protocolProfile: CLAUDE_PROTOCOL_PROFILE,
    continuation: await ownedClaudeContinuation(t, ['account']),
    requestRecord: new ClaudeRequestRecordPort(),
  })

  const failure = await drain(adapter.streamAccount({
    provider: 'claude', model: MODEL, sessionId: recordSession('sess-unbound'), messages: MESSAGES,
  }, 'account')).then(() => undefined, (error: unknown) => error)

  assert.ok(isLlmError(failure))
  assert.equal(failure.code, 'REQUEST_RECORD_UNAVAILABLE')
  assert.equal(posts, 0)
})

test('a request without a session refuses before any credential, upload or POST', async t => {
  const { blocks } = await ownedProtocolBlocks(t)
  const manager = tokens()
  let posts = 0
  const port = new StubRequestRecordPort(async () => {
    throw new Error('the recorder must not be reached without a session')
  })
  const adapter = new ClaudeAdapter({
    models: [], discovery: false, streamIdleTimeoutMs: 60_000, tokens: manager,
    fetchFn: async () => { posts += 1; return new Response(COMPLETE) },
    deviceFingerprint: () => FINGERPRINT,
    protocolBlocks: blocks,
    protocolProfile: CLAUDE_PROTOCOL_PROFILE,
    requestRecord: port,
  })

  const failure = await drain(adapter.streamAccount({
    provider: 'claude', model: MODEL, messages: MESSAGES,
  }, 'account')).then(() => undefined, (error: unknown) => error)

  assert.ok(isLlmError(failure))
  assert.equal(failure.code, 'CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED')
  assert.equal(failure.failure.retryDisposition, 'forbid')
  assert.equal(manager.credentialReads, 0, 'no credential was read')
  assert.equal(posts, 0, 'no profile, Files or Messages request was issued')
  assert.equal(port.calls.length, 0, 'the recorder saw no sessionless attempt')
})

test('each attempt that reaches the recorder produces its own record', async t => {
  const { blocks } = await ownedProtocolBlocks(t)
  let posts = 0
  const port = new StubRequestRecordPort(async () => ({ ok: true, preparedId: preparedSeq(posts) }))
  const adapter = new ClaudeAdapter({
    models: [], discovery: false, streamIdleTimeoutMs: 60_000, tokens: tokens(),
    fetchFn: async () => {
      posts += 1
      // One 401 answered by a replay: two POSTs for one answered request.
      return posts === 1 ? new Response('{"error":"expired"}', { status: 401 }) : new Response(COMPLETE)
    },
    deviceFingerprint: () => FINGERPRINT,
    protocolBlocks: blocks,
    protocolProfile: CLAUDE_PROTOCOL_PROFILE,
    continuation: await ownedClaudeContinuation(t, ['account']),
    requestRecord: port,
  })

  await drain(adapter.streamAccount({
    provider: 'claude', model: MODEL, sessionId: recordSession('sess-replay'), messages: MESSAGES,
  }, 'account'))

  assert.equal(posts, 2)
  assert.equal(port.calls.length, 2, 'the answered request and the replay are two recorded attempts')
  assert.deepEqual(port.calls.map(call => call.sessionId), ['sess-replay', 'sess-replay'])
})

test('extraction refuses a body that is not the built request', () => {
  assert.throws(() => extractClaudeSystemBlocks('not json'), SyntaxError)
  assert.throws(() => extractClaudeSystemBlocks('{}'), /system block list/)
  assert.throws(() => extractClaudeSystemBlocks('{"system":[{"type":"text"}]}'), /carries no text/)
  assert.deepEqual(extractClaudeSystemBlocks('{"system":[{"text":"a"},{"text":"b"}]}'), ['a', 'b'])
})
