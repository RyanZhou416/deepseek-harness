/**
 * The request controls the pinned catalogue owns for the claude route: the effort that rides
 * `output_config.effort`, the thinking shape that rides `body.thinking`, and the fast tier that
 * rides `body.speed` with the beta declaring it. Each is decided from the profile rather than
 * from discovery, so these tests drive the adapter with discovery off and read the bytes it
 * sends. The transport is injected; no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { BETA_REGISTRY_2_1_288 } from '@tormentalabs/claude-code-wire-compat'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { ClaudeAdapter } from '../src/providers/claude.js'
import { claudeOneMillionModelId } from '../src/providers/claude-model-limits.js'
import type { FetchFn } from '../src/providers/common.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

const ONE_MILLION_BETA = BETA_REGISTRY_2_1_288.LONG_CONTEXT.header
const SPEED_BETA = BETA_REGISTRY_2_1_288.SPEED.header

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
 * One adapter over the in-memory session; `fetchFn` absent means no request is issued.
 * `fast` stands in for the session's Speed choice: absent leaves the lookup unwired, which is
 * how a route with no control at all behaves.
 */
function adapter(fetchFn?: FetchFn, fast?: boolean): ClaudeAdapter {
  return new ClaudeAdapter({
    models: [], discovery: false, streamIdleTimeoutMs: 60_000, tokens: tokens(),
    ...fetchFn === undefined ? {} : { fetchFn },
    ...fast === undefined ? {} : { speedFor: () => fast },
  })
}

/**
 * Drive one generate call through the adapter and return the request it sent.
 *
 * The body is the builder's JSON, read field by field, so it is typed loosely rather than
 * re-declared here.
 * @param options - the generate request to send.
 * @param fast - the session's Speed choice, when the test wires one.
 * @returns the parsed body and the sent headers, lower-cased.
 */
async function sent(
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
  const instance = adapter(fetchFn, fast)
  const chunks: StreamChunk[] = []
  const request: GenerateOptions = {
    provider: 'claude',
    messages: history() as never,
    ...options,
  }
  for await (const chunk of instance.stream(request)) chunks.push(chunk)
  return {
    chunks,
    body: JSON.parse(body) as Record<string, any>,
    headers: new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
  }
}

test('a chosen effort reaches output_config.effort, and the catalogue shape rides the request', async () => {
  // Sonnet 5 advertises every level, so a chosen one is what the request carries; its
  // catalogue entry marks adaptive thinking.
  const sonnet = await sent({ model: 'claude-sonnet-5', reasoningEffort: ReasoningEffortId('xhigh') })
  assert.deepEqual(sonnet.body.output_config, { effort: 'xhigh' })
  assert.deepEqual(sonnet.body.thinking, { type: 'adaptive', display: 'updates' })

  // Opus 4.5 carries no effort flag, and its catalogue entry marks thinking without the
  // adaptive type, so the manual budget is the shape it gets.
  const opus = await sent({ model: 'claude-opus-4-5', reasoningEffort: ReasoningEffortId('high') })
  assert.equal('output_config' in opus.body, false)
  assert.deepEqual(opus.body.thinking, { budget_tokens: 16_000, type: 'enabled', display: 'updates' })

  // No effort asked for leaves the field off the request, which is the client's own default.
  const defaulted = await sent({ model: 'claude-sonnet-5' })
  assert.equal('output_config' in defaulted.body, false)
})

test('a level the model does not accept is dropped rather than sent', async () => {
  // Sonnet 4.6 can choose `max` but not `xhigh`: the level it accepts is what the request
  // carries, and the one it does not goes out as no effort at all rather than failing on the
  // builder's capability check.
  const accepted = await sent({ model: 'claude-sonnet-4-6', reasoningEffort: ReasoningEffortId('max') })
  assert.deepEqual(accepted.body.output_config, { effort: 'max' })

  const dropped = await sent({ model: 'claude-sonnet-4-6', reasoningEffort: ReasoningEffortId('xhigh') })
  assert.equal('output_config' in dropped.body, false)
  assert.equal(JSON.stringify(dropped.body).includes('xhigh'), false)
  assert.equal(dropped.chunks.at(-1)?.type, 'finish', 'the request still completes')
})

test('the 1M marker composes the long-context beta and leaves the model name alone', async () => {
  const marked = claudeOneMillionModelId('claude-sonnet-4-6')
  assert.equal(marked, 'claude-sonnet-4-6[1m]')
  if (marked === undefined) return

  const listed = adapter()
  // The window the variant claims is the one the marker buys, and the plain id keeps the
  // catalogue window this route can reach without the beta.
  assert.equal((await listed.resolveModel('claude', marked)).context?.contextWindow, 1_000_000)
  assert.equal((await listed.resolveModel('claude', 'claude-sonnet-4-6')).context?.contextWindow, 200_000)

  const built = await sent({ model: marked })
  // The pinned builder strips the marker from the model it names and pushes the beta on top.
  assert.equal(built.body.model, 'claude-sonnet-4-6')
  assert.equal((built.headers.get('anthropic-beta') ?? '').split(',').includes(ONE_MILLION_BETA), true)

  const plain = await sent({ model: 'claude-sonnet-4-6' })
  assert.equal((plain.headers.get('anthropic-beta') ?? '').includes(ONE_MILLION_BETA), false)
})

test('the fast tier rides body.speed and composes its beta exactly once', async () => {
  const fast = await sent({ model: 'claude-opus-5' }, true)
  assert.equal(fast.body.speed, 'fast')
  // One field, one composition: the body value and the beta identifier come from the same
  // input, so the identifier is present exactly once however the composed list is ordered.
  const betas = (fast.headers.get('anthropic-beta') ?? '').split(',').map(value => value.trim())
  assert.deepEqual(betas.filter(value => value === SPEED_BETA), [SPEED_BETA])
  assert.equal(fast.chunks.at(-1)?.type, 'finish', 'the request still completes')

  // Standard routing is the field's absence: no `speed` key at all, and no beta declaring a
  // tier the request does not use. A lookup answering false and no lookup agree.
  const answered = await sent({ model: 'claude-opus-5' }, false)
  const unwired = await sent({ model: 'claude-opus-5' })
  for (const standard of [answered, unwired]) {
    assert.equal('speed' in standard.body, false)
    assert.equal((standard.headers.get('anthropic-beta') ?? '').includes(SPEED_BETA), false)
  }
})
