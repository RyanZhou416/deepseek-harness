/**
 * The request controls the pinned catalogue owns for the claude route: the effort that rides
 * `output_config.effort`, the thinking shape that rides `body.thinking`, and the fast tier that
 * rides `body.speed` with the beta declaring it. Each is decided from the profile rather than
 * from discovery, so these tests drive the adapter with discovery off and read the bytes it
 * sends. The transport is injected; no network.
 */

import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { BETA_REGISTRY_2_1_288 } from '@tormentalabs/claude-code-wire-compat'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { ClaudeAdapter, deriveClaudeDeviceId } from '../src/providers/claude.js'
import { claudeOneMillionModelId } from '../src/providers/claude-model-limits.js'
import type { FetchFn } from '../src/providers/common.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'
import { PermittingRecordPort } from './recording-port.js'
import { ownedClaudeContinuation } from './claude-maintenance-fixtures.js'

const ONE_MILLION_BETA = BETA_REGISTRY_2_1_288.LONG_CONTEXT.header
const SPEED_BETA = BETA_REGISTRY_2_1_288.SPEED.header
const CONTEXT_MANAGEMENT_BETA = BETA_REGISTRY_2_1_288.CONTEXT_MANAGEMENT.header
const MID_CONVERSATION_SYSTEM_BETA = BETA_REGISTRY_2_1_288.MID_CONVERSATION_SYSTEM.header
const MID_CONVERSATION_SYSTEM_CLEAR_AT_BETA = BETA_REGISTRY_2_1_288.MID_CONVERSATION_SYSTEM_CLEAR_AT.header

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

/** A completed text response, which is all these request-side tests need back. */
const RESPONSE_SSE = [
  frame({ type: 'message_start', message: { usage: { input_tokens: 3 } } }),
  frame({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
  frame({ type: 'content_block_stop', index: 0 }),
  frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  frame({ type: 'message_stop' }),
].join('')

function history(): TranslatableMessage[] {
  return [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
}

/** A turn, then mid-conversation context: what a capable model receives as a system message. */
function midConversationHistory(): TranslatableMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    { role: 'system', content: [{ type: 'text', text: 'mid-conversation context' }] },
    { role: 'user', content: [{ type: 'text', text: 'again' }] },
  ]
}

/** The composed beta identifiers of one sent request, trimmed as the header separates them. */
function betasOf(request: { headers: Map<string, string> }): string[] {
  return (request.headers.get('anthropic-beta') ?? '').split(',').map(value => value.trim())
}

/** An in-memory account store holding one claude session; refresh never fires here. */
function tokens(session: ClaudeSession = SESSION): AccountTokenManager<ClaudeSession> {
  return new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Test',
    makeOptions: () => ({ preemptMs: 0, refresh: async () => session, isPermanent: () => false }),
    io: {
      list: async () => [{ key: 'acct', session }],
      get: async () => session,
      save: async () => {},
      remove: async () => {},
    },
  })
}

/**
 * One adapter over the in-memory session; `fetchFn` absent means no request is issued.
 * `fast` stands in for the model's stored Speed tier: absent leaves the lookup unwired, which is
 * how a route with no control at all behaves. The construction is the shape the real route uses:
 * a durable continuation owner to commit the wire identity and a recorder for the prepared request.
 * @param t - the case that owns the continuation state.
 * @param fetchFn - the synthetic egress, when the case sends one.
 * @param fast - the model's stored Speed tier, when the test wires one.
 * @param session - the account session to serve, when the case needs one that differs.
 * @returns the adapter over this case's state.
 */
async function adapter(
  t: Pick<TestContext, 'after'>,
  fetchFn?: FetchFn,
  fast?: boolean,
  session: ClaudeSession = SESSION,
): Promise<ClaudeAdapter> {
  return new ClaudeAdapter({
    models: [], discovery: false, streamIdleTimeoutMs: 60_000, tokens: tokens(session),
    deviceFingerprint: () => FINGERPRINT,
    continuation: await ownedClaudeContinuation(t, ['acct']),
    requestRecord: new PermittingRecordPort(),
    ...fetchFn === undefined ? {} : { fetchFn },
    ...fast === undefined ? {} : { speedFor: () => fast },
  })
}

/**
 * Drive one generate call through the adapter and return the request it sent.
 *
 * The body is the builder's JSON, read field by field, so it is typed loosely rather than
 * re-declared here.
 * @param t - the case that owns the continuation state.
 * @param options - the generate request to send.
 * @param fast - the model's stored Speed tier, when the test wires one.
 * @returns the parsed body and the sent headers, lower-cased.
 */
async function sent(
  t: Pick<TestContext, 'after'>,
  options: Partial<GenerateOptions> & Pick<GenerateOptions, 'model'>,
  fast?: boolean,
): Promise<{
  chunks: StreamChunk[]
  body: Record<string, any>
  headers: Map<string, string>
}> {
  let body = ''
  let headers: Record<string, string> = {}
  const fetchFn: FetchFn = async (_url, init) => {
    body = String(init?.body ?? '')
    headers = Object.fromEntries(Object.entries(init?.headers ?? {}))
    return new Response(RESPONSE_SSE, { headers: { 'content-type': 'text/event-stream' } })
  }
  const instance = await adapter(t, fetchFn, fast)
  const chunks: StreamChunk[] = []
  const request: GenerateOptions = {
    provider: 'claude',
    messages: history() as never,
    sessionId: 'sess-controls' as NonNullable<GenerateOptions['sessionId']>,
    ...options,
  }
  for await (const chunk of instance.stream(request)) chunks.push(chunk)
  return {
    chunks,
    body: JSON.parse(body) as Record<string, any>,
    headers: new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
  }
}

test('a chosen effort reaches output_config.effort, and the catalogue shape rides the request', async t => {
  // Sonnet 5 advertises every level, so a chosen one is what the request carries; its
  // catalogue entry marks adaptive thinking.
  const sonnet = await sent(t, { model: 'claude-sonnet-5', reasoningEffort: ReasoningEffortId('xhigh') })
  assert.deepEqual(sonnet.body.output_config, { effort: 'xhigh' })
  assert.deepEqual(sonnet.body.thinking, { type: 'adaptive', display: 'updates' })

  // Opus 4.5 carries no effort flag, and its catalogue entry marks thinking without the
  // adaptive type, so the manual budget is the shape it gets.
  const opus = await sent(t, { model: 'claude-opus-4-5', reasoningEffort: ReasoningEffortId('high') })
  assert.equal('output_config' in opus.body, false)
  assert.deepEqual(opus.body.thinking, { budget_tokens: 16_000, type: 'enabled', display: 'updates' })

  // No effort asked for leaves the field off the request, which is the client's own default.
  const defaulted = await sent(t, { model: 'claude-sonnet-5' })
  assert.equal('output_config' in defaulted.body, false)
})

test('a level the model does not accept is dropped rather than sent', async t => {
  // Sonnet 4.6 can choose `max` but not `xhigh`: the level it accepts is what the request
  // carries, and the one it does not goes out as no effort at all rather than failing on the
  // builder's capability check.
  const accepted = await sent(t, { model: 'claude-sonnet-4-6', reasoningEffort: ReasoningEffortId('max') })
  assert.deepEqual(accepted.body.output_config, { effort: 'max' })

  const dropped = await sent(t, { model: 'claude-sonnet-4-6', reasoningEffort: ReasoningEffortId('xhigh') })
  assert.equal('output_config' in dropped.body, false)
  assert.equal(JSON.stringify(dropped.body).includes('xhigh'), false)
  assert.equal(dropped.chunks.at(-1)?.type, 'finish', 'the request still completes')
})

test('the 1M marker composes the long-context beta and leaves the model name alone', async t => {
  const marked = claudeOneMillionModelId('claude-sonnet-4-6')
  assert.equal(marked, 'claude-sonnet-4-6[1m]')
  if (marked === undefined) return

  const listed = await adapter(t)
  // The window the variant claims is the one the marker buys, and the plain id keeps the
  // catalogue window this route can reach without the beta.
  assert.equal((await listed.resolveModel('claude', marked)).context?.contextWindow, 1_000_000)
  assert.equal((await listed.resolveModel('claude', 'claude-sonnet-4-6')).context?.contextWindow, 200_000)

  const built = await sent(t, { model: marked })
  // The pinned builder strips the marker from the model it names and pushes the beta on top.
  assert.equal(built.body.model, 'claude-sonnet-4-6')
  assert.equal((built.headers.get('anthropic-beta') ?? '').split(',').includes(ONE_MILLION_BETA), true)

  const plain = await sent(t, { model: 'claude-sonnet-4-6' })
  assert.equal((plain.headers.get('anthropic-beta') ?? '').includes(ONE_MILLION_BETA), false)
})

test('the fast tier rides body.speed and composes its beta exactly once', async t => {
  const fast = await sent(t, { model: 'claude-opus-5' }, true)
  assert.equal(fast.body.speed, 'fast')
  // One field, one composition: the body value and the beta identifier come from the same
  // input, so the identifier is present exactly once however the composed list is ordered.
  const betas = (fast.headers.get('anthropic-beta') ?? '').split(',').map(value => value.trim())
  assert.deepEqual(betas.filter(value => value === SPEED_BETA), [SPEED_BETA])
  assert.equal(fast.chunks.at(-1)?.type, 'finish', 'the request still completes')

  // Standard routing is the field's absence: no `speed` key at all, and no beta declaring a
  // tier the request does not use. A lookup answering false and no lookup agree.
  const answered = await sent(t, { model: 'claude-opus-5' }, false)
  const unwired = await sent(t, { model: 'claude-opus-5' })
  for (const standard of [answered, unwired]) {
    assert.equal('speed' in standard.body, false)
    assert.equal((standard.headers.get('anthropic-beta') ?? '').includes(SPEED_BETA), false)
  }
})

test('a stored fast tier never reaches a model whose catalogue entry lacks fast_mode', async t => {
  // Fable 5 carries no `fast_mode`, so the stored tier cannot be honoured: the request keeps
  // standard routing rather than carrying a speed field and its beta the model would refuse.
  const refused = await sent(t, { model: 'claude-fable-5' }, true)
  assert.equal('speed' in refused.body, false)
  assert.equal((refused.headers.get('anthropic-beta') ?? '').includes(SPEED_BETA), false)
  assert.equal(refused.chunks.at(-1)?.type, 'finish', 'the request still completes')
})

test('two requests 65 idle minutes apart still carry no context-management field', async t => {
  // The removed planner decided a server-side clear from a per-session idle clock and latched
  // that decision for the rest of the conversation. The wall clock was the only input it read
  // here, so mocking Date is the whole reproduction: same adapter, same wire session, and a gap
  // wider than its idle window. Both requests must reach the transport with no field.
  const start = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now: start })
  // The fixture expiry is stated against the real clock; the mocked one starts there and only
  // moves forward, so the session must outlive the gap or a refresh would replace it mid-case.
  const account: ClaudeSession = { ...SESSION, expiresAt: start + 24 * 3_600_000 }
  const captured: { body: Record<string, any>; headers: Map<string, string> }[] = []
  const fetchFn: FetchFn = async (_url, init) => {
    captured.push({
      body: JSON.parse(String(init?.body ?? '')) as Record<string, any>,
      headers: new Map(Object.entries(init?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
    })
    return new Response(RESPONSE_SSE, { headers: { 'content-type': 'text/event-stream' } })
  }
  const instance = await adapter(t, fetchFn, undefined, account)
  const generate: GenerateOptions = {
    provider: 'claude',
    messages: history() as never,
    sessionId: 'sess-idle-gap' as NonNullable<GenerateOptions['sessionId']>,
    model: 'claude-opus-5',
  }
  for await (const _chunk of instance.stream(generate)) { /* drained: this is a request-side case */ }
  t.mock.timers.tick(66 * 60_000)
  for await (const _chunk of instance.stream(generate)) { /* drained: this is a request-side case */ }

  assert.equal(captured.length, 2, 'both requests reached the transport')
  assert.equal(Date.now(), start + 66 * 60_000, 'the second request is 66 minutes after the first')
  const sessionIds = captured.map(request => request.headers.get('x-claude-code-session-id'))
  assert.equal(sessionIds[0], sessionIds[1], 'both requests declare the same wire session')
  for (const [index, request] of captured.entries()) {
    const label = `request ${String(index + 1)}`
    assert.equal('context_management' in request.body, false, `${label} states no context-management field`)
    const text = JSON.stringify(request.body)
    assert.equal(text.includes('clear_tool_uses'), false, `${label} states no tool-use clear`)
    assert.equal(text.includes('clear_thinking'), false, `${label} states no thinking clear`)
    // Removing the edits removes the field, not the model's capability: the beta declaring the
    // feature still rides every request for a catalogued model.
    assert.equal(betasOf(request).includes(CONTEXT_MANAGEMENT_BETA), true, `${label} retains the capability beta`)
  }
})

test('a capable model and its marked ids decide the mid-conversation form the same way', async t => {
  // The capability now comes from the pinned catalogue rather than a duplicated local list, so
  // the loop asks the model the catalogue names (including Sonnet 5 and Opus 5.5, which the old
  // list missed) and reads the same answer off the adapter's model info and the sent request.
  const instance = await adapter(t)
  for (const model of ['claude-sonnet-5', 'claude-opus-5-5']) {
    assert.equal(
      (await instance.resolveModel('claude', model)).systemPromptUpdate,
      'in-history',
      `${model} tells the loop it accepts the in-history form`,
    )
    const request = await sent(t, { model, messages: midConversationHistory() as never })
    const messages = request.body.messages as { role: string; content: unknown }[]
    const system = messages.filter(message => message.role === 'system')
    assert.equal(system.length, 1, `${model} carries the mid-conversation system message`)
    assert.equal(system[0]?.content, 'mid-conversation context')
    // The form is the client's: the context rides a system-role message in place, ahead of
    // the turn that follows it, rather than merging into a neighbour.
    assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'system', 'user'])
    // The pinned builder's cache-control pass rebuilds every message from its role and
    // content, so the translated `clear_at` does not survive serialization; the field is not
    // what this case pins. What it pins is the capability decision: the form above and the
    // two betas that declare it, composed together from the catalogue entry.
    assert.equal(betasOf(request).includes(MID_CONVERSATION_SYSTEM_BETA), true, `${model} composes the beta`)
    assert.equal(betasOf(request).includes(MID_CONVERSATION_SYSTEM_CLEAR_AT_BETA), true)
  }

  // The marker exists only on the 200K catalogue entries, and none of them is capable: a
  // marked id must not become capable through the suffix, nor lose the capability it has.
  assert.equal(claudeOneMillionModelId('claude-opus-4-6'), 'claude-opus-4-6[1m]')
  for (const model of ['claude-opus-4-6', 'claude-opus-4-6[1m]', 'claude-sonnet-4-6[1m]']) {
    assert.equal((await instance.resolveModel('claude', model)).systemPromptUpdate, undefined, model)
    const request = await sent(t, { model, messages: midConversationHistory() as never })
    const system = (request.body.messages as { role: string }[])
      .filter(message => message.role === 'system')
    assert.equal(system.length, 0, `${model} keeps the reminder fallback`)
    assert.equal(betasOf(request).includes(MID_CONVERSATION_SYSTEM_BETA), false, `${model} composes no mid-conversation beta`)
    assert.equal(betasOf(request).includes(MID_CONVERSATION_SYSTEM_CLEAR_AT_BETA), false, `${model} composes no clear-at beta`)
  }
})
