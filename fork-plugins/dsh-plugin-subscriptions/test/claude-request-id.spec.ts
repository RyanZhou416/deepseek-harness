/**
 * The Claude route's request identity, end to end: the billing block's derived
 * `cc_prompt_id` rides the real request bytes, and the response's own `request-id`
 * comes back out of the assistant message's replay envelope, so the request the
 * model read and the response it produced are both checkable from the session log.
 * The transport is injected; no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { GenerateOptions, MessageSource, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { ClaudeAdapter } from '../src/providers/claude.js'
import { claudePromptId, claudeWireSessionId } from '../src/providers/claude-wire.js'
import { toAnthropicMessages } from '../src/translate/anthropic.js'
import type { FetchFn } from '../src/providers/common.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

const HARNESS_SESSION_ID = 'sess-request-id'
/** The response header the API attaches to this stream. */
const REQUEST_ID = 'req_0123456789abcdef'

const SESSION: ClaudeSession = {
  accessToken: 'synthetic-access-token-0123456789abcdef0123456789abcdef0123456789abcdef',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 3_600_000,
  scopes: 'user:inference',
  accountUuid: 'uuid-1',
  deviceId: 'd'.repeat(64),
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

  // The session identity the request declares is a UUID minted for this account span;
  // the harness session id is the key it is stored under, not a value the client sends.
  const identity = JSON.parse(JSON.parse(body).metadata.user_id as string) as { session_id: string }
  assert.equal(headers['X-Claude-Code-Session-Id'], identity.session_id, 'header and correlation triple agree')
  assert.notEqual(identity.session_id, HARNESS_SESSION_ID, 'the harness session id is not the wire one')
  assert.equal(identity.session_id, claudeWireSessionId('acct', HARNESS_SESSION_ID), 'nor is it minted fresh per request')
  assert.match(identity.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

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
