/**
 * Codex reasoning replay: the backend returns an encrypted reasoning item
 * only because the request asked for it, and a reasoning model continuing a
 * tool chain must get that item back on the next request or it restarts from
 * scratch every round trip. Requests are answered by an injected fetch, so
 * these specs observe the assembled body directly; the OAuth grants are driven
 * the same way and assert their redirect policy. No network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError, MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '../src/compat.js'
import { CodexAdapter, CODEX_API_URL, exchangeCodexCode, refreshCodex } from '../src/providers/codex.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { FetchFn } from '../src/providers/common.js'
import { ENFORCEMENT_CODE } from '../src/providers/common.js'
import type { CodexSession } from '../src/auth/store.js'

const codexSession: CodexSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  accountId: 'acct-1',
}

/** An AccountTokenManager over several in-memory sessions (insertion order = default first). */
function memoryAccounts(accounts: Record<string, CodexSession>): AccountTokenManager<CodexSession> {
  const stored = new Map(Object.entries(accounts))
  return new AccountTokenManager<CodexSession>({
    provider: 'codex',
    displayName: 'Test',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: session => Promise.resolve(session),
      isPermanent: () => false,
    }),
    io: {
      list: () => Promise.resolve([...stored.entries()].map(([key, session]) => ({ key, session }))),
      get: account => Promise.resolve(
        account === undefined ? stored.values().next().value : stored.get(account),
      ),
      save: (account, session) => {
        stored.set(account, session)
        return Promise.resolve()
      },
      remove: account => {
        stored.delete(account)
        return Promise.resolve()
      },
    },
  })
}

/**
 * Record-and-replay fetch: each queued SSE payload answers one request in call
 * order; the request url and parsed body are recorded.
 */
function queuedFetch(queuedResponses: string[]): {
  fetchFn: FetchFn
  calls: { url: string; body: Record<string, unknown> }[]
} {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    const payload = queuedResponses.shift()
    if (payload === undefined) return Promise.reject(new Error(`unexpected fetch to ${String(input)}`))
    return Promise.resolve(new Response(payload))
  }) as FetchFn
  return { fetchFn, calls }
}

/** Encode Responses events as one SSE payload string. */
function sseBody(events: Record<string, unknown>[]): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
}

/**
 * SSE payload for a response that reasons and issues one tool call: the
 * reasoning done carries the COMPLETE item (id, summary, status, encrypted
 * blob) when `encrypted` is given, and the call's arguments arrive whole on
 * done.
 */
function reasoningToolCallSse(encrypted: string | undefined, callId = 'call_A'): string {
  return sseBody([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'r1' } },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: encrypted === undefined
        ? { type: 'reasoning', id: 'r2' }
        : {
            type: 'reasoning',
            id: 'rs_done_1',
            summary: [{ type: 'summary_text', text: 'planned the ls call' }],
            status: 'completed',
            encrypted_content: encrypted,
          },
    },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'f1', call_id: callId, name: 'bash' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'f1', delta: '' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'f1', call_id: callId, name: 'bash', arguments: '{"cmd":"ls"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 4 } } },
  ])
}

/** A minimal completed Responses SSE payload (one text item, then finish). */
const COMPLETED_SSE = sseBody([
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'ok' }] } },
  { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
])

/** Brand a string as a GenerateOptions sessionId (the loop-stamped session identity). */
const SessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

/** Minimal generate options for adapter.stream() calls. */
const STREAM_OPTIONS: GenerateOptions = {
  provider: 'codex',
  model: 'gpt-5.6-sol',
  messages: [{
    id: MessageId('m-stream'),
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }],
}

/** The conversation handed back for the second request after the call ran. */
function toolRoundTripHistory(callId = 'call_A'): GenerateOptions['messages'] {
  return [
    {
      id: MessageId('m-a'),
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'tool-call', id: ToolCallId(callId), name: 'bash', arguments: '{"cmd":"ls"}' },
      ],
      source: { kind: 'model', provider: 'codex', model: 'gpt-5.6-sol' },
    },
    {
      id: MessageId('m-b'),
      role: 'tool',
      toolCallId: ToolCallId(callId),
      content: [{ type: 'text', text: 'file-a' }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  ]
}

function codexAdapter(
  fetchFn: FetchFn,
  accounts: Record<string, CodexSession> = { acct: codexSession },
  recoverQuota?: (account: string, signal: AbortSignal) => Promise<boolean>,
): CodexAdapter {
  return new CodexAdapter({
    models: [{ id: 'gpt-5.6-sol' }],
    streamIdleTimeoutMs: 1000,
    tokens: memoryAccounts(accounts),
    discovery: false,
    fetchFn,
    ...recoverQuota === undefined ? {} : { recoverQuota },
  })
}

/** The input items of one recorded request body. */
function inputOf(calls: { url: string; body: Record<string, unknown> }[], index: number): Record<string, unknown>[] {
  return calls[index]?.body.input as Record<string, unknown>[]
}

async function drain(adapter: CodexAdapter, options: GenerateOptions): Promise<void> {
  for await (const chunk of adapter.stream(options)) void chunk
}

test('codex asks for encrypted reasoning on every request', async () => {
  const { fetchFn, calls } = queuedFetch([COMPLETED_SSE])
  await drain(codexAdapter(fetchFn), STREAM_OPTIONS)
  assert.equal(calls[0]?.url, CODEX_API_URL)
  assert.deepEqual(calls[0]?.body.include, ['reasoning.encrypted_content'])
})

test('codex replays the COMPLETE captured reasoning item immediately before its tool call', async () => {
  // Two phases through ONE adapter: the first response reasons and calls
  // call_A; the second request (tool result in hand) must replay the captured
  // COMPLETED reasoning item — original id, summary, status, and the
  // encrypted payload — directly ahead of the replayed function_call.
  const { fetchFn, calls } = queuedFetch([reasoningToolCallSse('ENC1'), COMPLETED_SSE])
  const adapter = codexAdapter(fetchFn)
  await drain(adapter, { ...STREAM_OPTIONS, sessionId: SessionId('sess-1') })
  await drain(adapter, {
    ...STREAM_OPTIONS,
    sessionId: SessionId('sess-1'),
    messages: toolRoundTripHistory(),
  })
  const input = inputOf(calls, 1)
  const reasoningIndex = input.findIndex(item => item.type === 'reasoning')
  assert.ok(reasoningIndex >= 0, 'the completed reasoning item is replayed')
  const callIndex = input.findIndex(item => item.type === 'function_call' && item.call_id === 'call_A')
  assert.equal(callIndex, reasoningIndex + 1)
  assert.deepEqual(input[reasoningIndex], {
    type: 'reasoning',
    id: 'rs_done_1',
    summary: [{ type: 'summary_text', text: 'planned the ls call' }],
    status: 'completed',
    encrypted_content: 'ENC1',
  })
})

test('a codex response without encrypted reasoning captures nothing to replay', async () => {
  // Degradation: the reasoning item arrives without encrypted_content (the
  // backend stripped the blob) — the follow-up request carries no reasoning
  // items at all.
  const { fetchFn, calls } = queuedFetch([reasoningToolCallSse(undefined), COMPLETED_SSE])
  const adapter = codexAdapter(fetchFn)
  await drain(adapter, { ...STREAM_OPTIONS, sessionId: SessionId('sess-1') })
  await drain(adapter, {
    ...STREAM_OPTIONS,
    sessionId: SessionId('sess-1'),
    messages: toolRoundTripHistory(),
  })
  assert.equal(inputOf(calls, 1).some(item => item.type === 'reasoning'), false)
})

test('codex replay state is isolated per conversation', async () => {
  // Conversation 1 captures `call-shared`; a DIFFERENT conversation reusing
  // the same call id (same account, same model) must not see its reasoning.
  const { fetchFn, calls } = queuedFetch([reasoningToolCallSse('ENC_SESSION_1', 'call-shared'), COMPLETED_SSE])
  const adapter = codexAdapter(fetchFn)
  await drain(adapter, { ...STREAM_OPTIONS, sessionId: SessionId('sess-1') })
  await drain(adapter, {
    ...STREAM_OPTIONS,
    sessionId: SessionId('sess-2'),
    messages: toolRoundTripHistory('call-shared'),
  })
  assert.equal(inputOf(calls, 1).some(item => item.type === 'reasoning'), false)
})

test('codex replay state never crosses accounts', async () => {
  // The scope rides the ChatGPT account id, so a second account's
  // continuation reusing the call id cannot see the first account's blob.
  const accountA: CodexSession = { ...codexSession, accountId: 'acct-a' }
  const accountB: CodexSession = { ...codexSession, accountId: 'acct-b' }
  const { fetchFn, calls } = queuedFetch([reasoningToolCallSse('ENC_ACCOUNT_A', 'call-shared'), COMPLETED_SSE])
  const adapter = codexAdapter(fetchFn, { a: accountA, b: accountB })
  await drain(adapter, { ...STREAM_OPTIONS, sessionId: SessionId('sess-1') })
  for await (const chunk of adapter.streamAccount({
    ...STREAM_OPTIONS,
    sessionId: SessionId('sess-1'),
    messages: toolRoundTripHistory('call-shared'),
  }, 'b')) void chunk
  assert.equal(
    inputOf(calls, 1).some(item => item.type === 'reasoning'),
    false,
    "account B's request must not carry account A's reasoning",
  )
})

test('clearReplayState drops captured entries (the auth-transition hook)', async () => {
  const { fetchFn, calls } = queuedFetch([reasoningToolCallSse('ENC1'), COMPLETED_SSE])
  const adapter = codexAdapter(fetchFn)
  await drain(adapter, { ...STREAM_OPTIONS, sessionId: SessionId('sess-1') })
  adapter.clearReplayState()
  await drain(adapter, {
    ...STREAM_OPTIONS,
    sessionId: SessionId('sess-1'),
    messages: toolRoundTripHistory(),
  })
  assert.equal(inputOf(calls, 1).some(item => item.type === 'reasoning'), false)
})

test('codex spends no reset credit and resends nothing after a refusal it stated is final', async () => {
  for (const [label, headers, body] of [
    ['the provider said to stop retrying', { 'x-should-retry': 'false' }, '{"error":{"message":"usage_limit_reached"}}'],
    ['the refusal names credits', undefined, '{"error":{"message":"You have insufficient credits for this request"}}'],
  ] as const) {
    const recovered: string[] = []
    let requests = 0
    const adapter = codexAdapter(
      (async () => {
        requests += 1
        return new Response(body, { status: 429, ...headers === undefined ? {} : { headers } })
      }) as FetchFn,
      { acct: codexSession },
      async account => { recovered.push(account); return true },
    )
    let failure: unknown
    try {
      await drain(adapter, STREAM_OPTIONS)
    } catch (error: unknown) {
      failure = error
    }
    // A refused request has no window to poll for and cannot be answered by
    // resending it, so recovery never runs and the turn ends on the refusal.
    assert.deepEqual(recovered, [], `${label}: no reset credit was polled or spent`)
    assert.equal(requests, 1, `${label}: the refused request was not resent`)
    assert.ok(failure instanceof LlmError, `${label}: the failure reached the caller`)
    assert.equal((failure as LlmError).code, ENFORCEMENT_CODE, `${label}: it is terminal`)
  }
})

test('codex still recovers an ordinary 429 that disclosed its window', async () => {
  const recovered: string[] = []
  let requests = 0
  const adapter = codexAdapter(
    (async () => {
      requests += 1
      return requests === 1
        ? new Response('{"error":{"message":"usage_limit_reached"},"resets_in_seconds":30}', { status: 429 })
        : new Response(COMPLETED_SSE)
    }) as FetchFn,
    { acct: codexSession },
    async account => { recovered.push(account); return true },
  )
  await drain(adapter, STREAM_OPTIONS)
  assert.deepEqual(recovered, ['acct'], 'a spent window is still worth a reset credit')
  assert.equal(requests, 2, 'the recovered account was asked once more')
})

/** An unsigned id token carrying the ChatGPT account claim a login needs. */
function idToken(): string {
  const payload = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } }
  return `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`
}

test('codex token grants refuse redirects', async () => {
  // A 307/308 would replay the code or refresh token to another origin, so
  // both grants answer with a redirect error instead of following it.
  const real = globalThis.fetch
  const seen: RequestInit[] = []
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(init ?? {})
    return Promise.resolve(Response.json({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      id_token: idToken(),
    }))
  }) as typeof globalThis.fetch
  try {
    await exchangeCodexCode('code', 'verifier', 'http://localhost:1455/auth/callback')
    await refreshCodex(codexSession)
  } finally {
    globalThis.fetch = real
  }
  assert.equal(seen.length, 2)
  assert.deepEqual(seen.map(init => init.redirect), ['error', 'error'])
})
