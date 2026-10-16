/**
 * The Claude route's request identity, end to end: the billing block's derived
 * `cc_prompt_id` rides the real request bytes, and the response's own `request-id`
 * comes back out of the assistant message's replay envelope, so the request the
 * model read and the response it produced are both checkable from the session log.
 * The transport is injected; no network.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GenerateOptions, MessageSource, ReplayEnvelope, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { ClaudeAdapter, deriveClaudeDeviceId } from '../src/providers/claude.js'
import { ClaudeContinuationState } from '../src/providers/claude-continuation-state.js'
import { continuationBudget } from '../src/providers/claude-continuation-io.js'
import { claudePromptId } from '../src/providers/claude-wire.js'
import { PermittingRecordPort } from './recording-port.js'
import { toAnthropicMessages } from '../src/translate/anthropic.js'
import type { FetchFn } from '../src/providers/common.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

const HARNESS_SESSION_ID = 'sess-request-id'
/** The response header the API attaches to this stream. */
const REQUEST_ID = 'req_0123456789abcdef'

/** A synthetic machine fingerprint; never this host's own identifier. */
const FINGERPRINT = 'f'.repeat(64)

const SESSION: ClaudeSession = {
  accessToken: 'synthetic-access-token-0123456789abcdef0123456789abcdef0123456789abcdef',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 3_600_000,
  scopes: 'user:inference',
  accountUuid: 'uuid-1',
  // Already bound to this machine, so a request presents it without a rebind write.
  deviceId: deriveClaudeDeviceId('uuid:uuid-1', FINGERPRINT),
  subscriptionType: 'max',
}

/** One SSE frame. */
function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/**
 * A completed response whose thinking the next request has to replay, so the
 * envelope carries its per-block entry beside the response-level request id.
 */
const RESPONSE_SSE = [
  frame({ type: 'message_start', message: { usage: { input_tokens: 12 } } }),
  frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } }),
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-9' } }),
  frame({ type: 'content_block_stop', index: 0 }),
  frame({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
  frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } }),
  frame({ type: 'content_block_stop', index: 1 }),
  frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  frame({ type: 'message_stop' }),
].join('')

function history(): TranslatableMessage[] {
  return [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
}

/** An in-memory account store holding one claude session; refresh never fires here. */
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
 * The real continuation owner over this test's own private root.
 *
 * The route is only served under the span identity this state commits, so the wire facts the
 * assertions compare are the ones a real request would carry, not an id the test minted.
 */
const ROOT = await mkdtemp(join(tmpdir(), 'claude-request-id-'))
const STATE = new ClaudeContinuationState({ deadlineMs: 1_000, lockTimeoutMs: 2_000, root: ROOT })
// Registered the moment the state exists, so an early failure or a cancelled case still releases the
// owner and removes the root; the suite does not rely on a final case to run.
after(async () => {
  try {
    await STATE.close()
  } finally {
    await rm(ROOT, { recursive: true, force: true })
  }
})
const ESTABLISHED = await STATE.initialize('acct')
assert.equal(ESTABLISHED.kind, 'advanced', 'the account baseline is established before any request')

/** Drive one generate call through the adapter, capturing the request it sent. */
async function streamOnce(requestId?: string): Promise<{
  chunks: StreamChunk[]
  body: string
  headers: Record<string, string>
}> {
  let body = ''
  let headers: Record<string, string> = {}
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    body = String(init?.body ?? '')
    headers = Object.fromEntries(Object.entries(init?.headers ?? {}))
    return new Response(RESPONSE_SSE, {
      headers: {
        'content-type': 'text/event-stream',
        ...requestId === undefined ? {} : { 'request-id': requestId },
      },
    })
  }) as unknown as FetchFn
  const adapter = new ClaudeAdapter({
    models: [], discovery: false, streamIdleTimeoutMs: 60_000, tokens: tokens(), fetchFn,
    deviceFingerprint: () => FINGERPRINT, continuation: STATE, requestRecord: new PermittingRecordPort(),
  })
  const options = {
    provider: 'claude',
    model: 'claude-opus-5',
    messages: history() as never,
    sessionId: HARNESS_SESSION_ID as NonNullable<GenerateOptions['sessionId']>,
  }
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return { chunks, body, headers }
}

/** The `cc_prompt_id` of a built request body. */
function promptIdOf(body: string): string {
  return /cc_prompt_id=([0-9a-f-]{36});/.exec(JSON.parse(body).system[0].text)?.[1] ?? ''
}

test('the response request id is recorded on the assistant message replay envelope', async () => {
  const { chunks, body, headers } = await streamOnce(REQUEST_ID)

  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type !== 'finish') return
  const envelope = finish.replayState
  assert.ok(envelope !== undefined, 'a response carrying a request id produces an envelope')
  const response = envelope.response as { kind?: unknown; version?: unknown; requestId?: unknown }
  assert.equal(response.kind, 'claude', 'the envelope keeps its kind')
  assert.equal(response.version, 1, 'and its version')
  assert.equal(response.requestId, REQUEST_ID, 'the response request id is recorded')

  // The wire session identity is the span the durable owner committed, observed through two
  // preparations of the same account and session: neither preparation mints a new one, and the
  // harness session id is the key it is stored under rather than a value the client sends.
  const identity = JSON.parse(JSON.parse(body).metadata.user_id as string) as { session_id: string }
  assert.equal(headers['X-Claude-Code-Session-Id'], identity.session_id, 'header and correlation triple agree')
  assert.notEqual(identity.session_id, HARNESS_SESSION_ID, 'the harness session id is not the wire one')
  assert.match(identity.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  const first = await STATE.prepareRequest({
    account: 'acct',
    harnessSessionId: HARNESS_SESSION_ID,
    origin: STATE.originFor(STATE.requestHeaderReason(HARNESS_SESSION_ID)),
    deadline: continuationBudget(1_000),
  })
  assert.equal(first.kind, 'ready', 'the same span is prepared again')
  if (first.kind !== 'ready') return
  assert.equal(first.prepared.wireSessionId, identity.session_id, 'the request carried the committed span id')
  const second = await STATE.prepareRequest({
    account: 'acct',
    harnessSessionId: HARNESS_SESSION_ID,
    origin: STATE.originFor(STATE.requestHeaderReason(HARNESS_SESSION_ID)),
    deadline: continuationBudget(1_000),
  })
  assert.equal(second.kind, 'ready')
  if (second.kind !== 'ready') return
  assert.equal(second.prepared.wireSessionId, identity.session_id, 'and it is not minted fresh per request')

  // The id the request carried and the id the response reported are the two halves the
  // envelope makes checkable; the request's half is derived from the wire session
  // identity, so it is reproducible here.
  assert.equal(
    promptIdOf(body),
    claudePromptId(identity.session_id, 1),
    'the request carries the id derived from its wire session identity',
  )

  // The envelope goes back onto the next request as the assistant message's replay state, so
  // the recorded id has to come back out of it without disturbing what the reader already does.
  const stored: TranslatableMessage = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'plan' },
      { type: 'text', text: 'hi' },
    ],
    source: {
      kind: 'model',
      provider: 'claude',
      model: 'claude-opus-5',
      replayState: envelope,
    } satisfies MessageSource,
  }
  const replayed = toAnthropicMessages([stored], 'claude-opus-5')
  assert.deepEqual(replayed[0]?.content, [
    { type: 'thinking', thinking: 'plan', signature: 'sig-9' },
    { type: 'text', text: 'hi' },
  ])
})

test('a response with no request-id header records no such field', async () => {
  const { chunks } = await streamOnce()
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type !== 'finish') return
  const response = finish.replayState?.response as { requestId?: unknown } | undefined
  assert.equal(response?.requestId, undefined, 'an absent header leaves the field out')
})

/**
 * Drive one generate call over one core root and session, through the real adapter.
 *
 * The state belongs to the root, so a caller that keeps the root keeps the salt and the identity
 * baseline while dropping only the span record it means to lose.
 */
async function sendOverRoot(root: string, harnessSessionId: string, messages: TranslatableMessage[]): Promise<{
  body: string
  envelope: ReplayEnvelope | undefined
  identity: Awaited<ReturnType<ClaudeContinuationState['resolveIdentity']>>
}> {
  const state = new ClaudeContinuationState({ deadlineMs: 1_000, lockTimeoutMs: 2_000, root })
  try {
    const established = await state.initialize('acct')
    assert.equal(established.kind, 'advanced', 'this case owns an established baseline')
    let body = ''
    let envelope: ReplayEnvelope | undefined
    const fetchFn: FetchFn = async (_url, init) => {
      body = String(init?.body ?? '')
      return new Response(RESPONSE_SSE, { headers: { 'content-type': 'text/event-stream' } })
    }
    const adapter = new ClaudeAdapter({
      models: [], discovery: false, streamIdleTimeoutMs: 60_000, tokens: tokens(), fetchFn,
      deviceFingerprint: () => FINGERPRINT, continuation: state, requestRecord: new PermittingRecordPort(),
    })
    for await (const chunk of adapter.stream({
      provider: 'claude',
      model: 'claude-opus-5',
      messages: messages as never,
      sessionId: harnessSessionId as NonNullable<GenerateOptions['sessionId']>,
    })) {
      if (chunk.type === 'finish') envelope = chunk.replayState
    }
    // The identity this root serves the account under, read after the request, so a case that
    // reopens its root can state that both requests ran under the same salt and generation.
    const identity = await state.resolveIdentity('acct', continuationBudget(1_000))
    return { body, envelope, identity }
  } finally {
    await state.close()
  }
}

/**
 * Run one restore case over its own private core root.
 *
 * The first request records this account's span; the same root is then reopened with only this
 * case's span record removed, which is what a log-only restart looks like — the salt and the
 * baseline survive, so the wire identity exists nowhere but the retained row. The read-back either
 * adopts that recorded identity or commits a new one, on the facts the row states.
 * @param input - the source session, the read-back session and the row's block count.
 * @returns the recorded id, the read-back's own id and whether both ran under one identity.
 */
async function restoreCase(input: {
  sourceSessionId: string
  readSessionId: string
  contentBlocks: number
}): Promise<{ recorded: string; observed: string; sameIdentity: boolean }> {
  const root = await mkdtemp(join(tmpdir(), 'claude-request-id-restore-'))
  try {
    const source = await sendOverRoot(root, input.sourceSessionId, history())
    const sourceContinuation = continuationOf(source.envelope)
    assert.ok(sourceContinuation !== undefined, 'the source request recorded its own span')
    const sourceIdentity = source.identity
    assert.ok('accountRef' in sourceIdentity, 'the source was served under this account')
    // Only this case's own span record is removed: the salt and the identity baseline stay in place.
    await rm(join(root, 'spans.json'), { force: true })
    assert.ok(source.envelope !== undefined, 'the recorded row is the one this case replays')
    const read = await sendOverRoot(root, input.readSessionId, [
      ...history(),
      replayRow(source.envelope, input.contentBlocks),
    ])
    const readIdentity = read.identity
    assert.ok('accountRef' in readIdentity, 'the read-back was served under this account')
    return {
      recorded: sourceContinuation.wireSessionId,
      observed: declaredSessionId(read.body),
      sameIdentity: readIdentity.accountRef.ref === sourceIdentity.accountRef.ref
        && readIdentity.spanEpoch === sourceIdentity.spanEpoch,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** The continuation one recorded envelope states, when it is this route's own. */
function continuationOf(envelope: ReplayEnvelope | undefined): { wireSessionId: string } | undefined {
  const response = envelope?.response as { kind?: unknown; continuation?: { wireSessionId?: string } } | undefined
  if (response?.kind !== 'claude' || response.continuation?.wireSessionId === undefined) return undefined
  return { wireSessionId: response.continuation.wireSessionId }
}

/** The wire session id one request declared, read from its own bytes. */
function declaredSessionId(body: string): string {
  return (JSON.parse(JSON.parse(body).metadata.user_id as string) as { session_id: string }).session_id
}

/** One assistant row that carries a genuine recorded envelope, as a session log would hold it. */
function replayRow(envelope: ReplayEnvelope, contentBlocks: number): TranslatableMessage {
  return {
    role: 'assistant',
    content: Array.from({ length: contentBlocks }, () => ({ type: 'text' as const, text: 'hi' })),
    source: {
      kind: 'model',
      provider: 'claude',
      model: 'claude-opus-5',
      replayState: envelope,
    },
  }
}

test('an aligned row restores the wire identity its store no longer holds', async () => {
  const aligned = await restoreCase({
    sourceSessionId: 'sess-restore-aligned',
    readSessionId: 'sess-restore-aligned',
    contentBlocks: 2,
  })
  assert.ok(aligned.sameIdentity, 'both requests ran under one salt and identity generation')
  assert.equal(aligned.observed, aligned.recorded, 'the retained row restores the span record that was lost')
})

test('a row whose envelope does not account for its blocks commits a new identity', async () => {
  // The row holds one block while the envelope it carries recorded two: not evidence about any span.
  const misaligned = await restoreCase({
    sourceSessionId: 'sess-restore-misaligned',
    readSessionId: 'sess-restore-misaligned',
    contentBlocks: 1,
  })
  assert.ok(misaligned.sameIdentity, 'both requests ran under one salt and identity generation')
  assert.notEqual(misaligned.observed, misaligned.recorded, 'a misaligned row lends no wire identity')
})

test('a row recorded under another harness session commits a new identity', async () => {
  // The same account and generation, a different session: the recorded identity is not this span's.
  const foreign = await restoreCase({
    sourceSessionId: 'sess-restore-foreign-source',
    readSessionId: 'sess-restore-foreign-target',
    contentBlocks: 2,
  })
  assert.ok(foreign.sameIdentity, 'both requests ran under one salt and identity generation')
  assert.notEqual(foreign.observed, foreign.recorded, 'another session\'s recorded identity is not adopted')
})
