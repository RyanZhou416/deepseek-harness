/**
 * Wire-contract tests for the pinned Claude Code request builder: the profile
 * pin, the mapping from resolved harness requests, the runtime identity, the
 * per-account/per-session conversation chain, the per-account Files API upload
 * cache, the oversize → offload mapping, and the wire-error mapping. No
 * network beyond an injected fetch; the builder is pure.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  CLAUDE_CODE_2_1_288_PROFILE,
  ClaudeCodeWireError,
} from '@tormentalabs/claude-code-wire-compat'
import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  boundedTwoLevelMap,
  buildClaudeWireRequest as buildClaudeWireRequestWithContinuation,
  CLAUDE_USER_AGENT,
  claudeRequestClass,
  mapClaudeWireError,
} from '../src/providers/claude-wire.js'

/**
 * The builder in this file's positional shape, with the continuation facts stated explicitly.
 *
 * The builder no longer mints a wire session id or remembers a chain: the durable span store commits
 * the identity and the retained history's selector states the id to chain. Every ordinary request
 * therefore passes the empty facts, and the cases that need a pin or a chained id state them.
 */
function buildClaudeWireRequest(
  options: GenerateOptions,
  session: ClaudeSession,
  messages: readonly TranslatableMessage[],
  maxTokens: number,
  thinking: Parameters<typeof buildClaudeWireRequestWithContinuation>[4],
  effort: Parameters<typeof buildClaudeWireRequestWithContinuation>[5],
  sessionId: string,
  account: string,
  continuation: { readonly atisPin?: string; readonly previousRequestId?: string } = {},
  identityLine?: Parameters<typeof buildClaudeWireRequestWithContinuation>[8],
  fast = false,
  policy?: Parameters<typeof buildClaudeWireRequestWithContinuation>[10],
): ReturnType<typeof buildClaudeWireRequestWithContinuation> {
  return buildClaudeWireRequestWithContinuation(options, session, messages, maxTokens, thinking, effort, {
    sessionId,
    atisPin: continuation.atisPin,
    previousRequestId: continuation.previousRequestId,
  }, account, identityLine, fast, policy)
}
import { oversizeWireError } from '../src/providers/claude-images.js'
import {
  bindClaudeFileIds,
  CLAUDE_FILE_ID_LIMIT,
  CLAUDE_MAX_BASE64_IMAGE_CHARS,
  clearClaudeFileIds,
  rememberClaudeFileId,
  uploadedClaudeFileId,
} from '../src/providers/claude.js'
import type { FetchFn } from '../src/providers/common.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

const ACCOUNT = 'acct-a'

function session(): ClaudeSession {
  return {
    // Long synthetic token: the builder's token-isolation check rejects a
    // request whose access token is a substring of any other header value,
    // and a realistic token never is.
    accessToken: 'synthetic-access-token-0123456789abcdef0123456789abcdef0123456789abcdef',
    refreshToken: 'ref',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:profile user:inference',
    accountUuid: 'uuid-1',
    deviceId: 'dev-1',
    // The cache ttl and the beta that declares it follow the granted scope set, so the
    // session these tests build is a subscriber's, as the pooled accounts are.
    subscriptionType: 'max',
  }
}

function history(): TranslatableMessage[] {
  return [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
}

/** One turn that ended in tool results: the next request is a tool continuation. */
function toolStep(): TranslatableMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'bash', arguments: '{}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text: 'ok' }] }] },
  ]
}

/** The same conversation one user prompt later: the first request of a second prompt turn. */
function secondTurn(): TranslatableMessage[] {
  return [
    ...history(),
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    { role: 'user', content: [{ type: 'text', text: 'next turn' }] },
  ]
}

function promptIdOf(built: { body: string }): string {
  return /cc_prompt_id=([0-9a-f-]{36});/.exec(JSON.parse(built.body).system[0].text)?.[1] ?? ''
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'claude',
    model: 'claude-opus-5',
    messages: history() as never,
    system: 'be terse',
    ...overrides,
  }
}

function headerMap(built: { headers: readonly (readonly [string, string])[] }): Map<string, string> {
  return new Map(built.headers.map(([name, value]) => [name.toLowerCase(), value]))
}

/**
 * The wire session id a named test conversation declares.
 *
 * The client declares its session as a UUID, so a request built with anything
 * else is refused before it is built. Deriving the id from the name keeps each
 * test's conversation readable while giving the builder the shape it requires.
 */
function wireSessionId(name: string): string {
  const bytes = Buffer.from(createHash('sha256').update(`test-wire-session:${name}`).digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function parseBody(built: { body: string }): Record<string, any> {
  return JSON.parse(built.body) as Record<string, any>
}

test('the pinned profile is the Claude Code 2.1.288 desktop identity', () => {
  assert.equal(CLAUDE_CODE_2_1_288_PROFILE.cliVersion, '2.1.288')
  assert.equal(CLAUDE_CODE_2_1_288_PROFILE.sdkVersion, '0.128.0')
  assert.equal(CLAUDE_USER_AGENT, 'claude-cli/2.1.288 (external, claude-desktop)')
})

test('buildClaudeWireRequest emits the billing and identity blocks and the correlation triple', async () => {
  const built = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-1'), ACCOUNT)
  assert.equal(built.url, 'https://api.anthropic.com/v1/messages?beta=true')
  const body = parseBody(built)
  const system = body.system as { type: string; text: string; cache_control?: unknown }[]
  assert.match(system[0].text, /^x-anthropic-billing-header: cc_version=2\.1\.288\.[0-9a-f]{3}; cc_entrypoint=claude-desktop; cch=00000;/)
  // A non-interactive run with no appended system prompt sends the agent line,
  // not the interactive CLI one; the user agent and attribution entrypoint stay
  // `cli`, which is what `claude --print` reports.
  assert.equal(system[1].text, 'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.')
  // The genuine client defines the reporting text but never pushes it into a
  // request, so a request that carries it would be distinguishable.
  assert.ok(!system.some((block) => block.text.startsWith('# Reporting outcomes')), 'no reporting block is injected')
  assert.deepEqual(JSON.parse(body.metadata.user_id as string), {
    device_id: 'dev-1',
    account_uuid: 'uuid-1',
    session_id: wireSessionId('sess-1'),
  })
})

test('headers carry the pinned plan and the session identity', async () => {
  const account = session()
  const built = await buildClaudeWireRequest(options(), account, history(), 32_000, undefined, undefined, wireSessionId('sess-1'), ACCOUNT)
  const headers = headerMap(built)
  assert.equal(headers.get('authorization'), `Bearer ${account.accessToken}`)
  assert.equal(headers.get('x-app'), 'cli')
  assert.equal(headers.get('user-agent'), 'claude-cli/2.1.288 (external, claude-desktop)')
  assert.equal(headers.get('anthropic-version'), '2023-06-01')
  assert.equal(headers.get('anthropic-dangerous-direct-browser-access'), 'true')
  assert.equal(headers.get('x-claude-code-session-id'), wireSessionId('sess-1'))
  assert.ok((headers.get('anthropic-beta') ?? '').length > 0, 'beta header is composed by the builder')
  assert.match(headers.get('x-client-request-id') ?? '', /^[0-9a-f-]{36}$/)
  assert.equal(headers.get('x-stainless-runtime'), 'node')
  // The version of the runtime that issues the request, which on this path is the
  // process building it. A compiled-in value would name a runtime that sent nothing:
  // the Bun transport replaces this field with its own `process.version`.
  assert.equal(headers.get('x-stainless-runtime-version'), process.version)
  // The SDK sets this on every request. The plugin asserted the opposite until the carve showed otherwise.
  assert.equal(headers.get('accept'), 'application/json')
})

test('the plan carries each field name in the casing the client sends', async () => {
  const built = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-case'), ACCOUNT)
  const names = built.headers.map(([name]) => name)
  for (const name of [
    'Accept',
    'Authorization',
    'User-Agent',
    'X-Claude-Code-Session-Id',
    'X-Stainless-Arch',
    'X-Stainless-Lang',
    'X-Stainless-OS',
    'X-Stainless-Package-Version',
    'X-Stainless-Retry-Count',
    'X-Stainless-Runtime',
    'X-Stainless-Runtime-Version',
    'X-Stainless-Timeout',
  ]) {
    assert.ok(names.includes(name), `${name} is spelled the way the client spells it`)
  }
  // Not a uniformly title-cased set: the client's own block mixes the two.
  for (const name of [
    'anthropic-beta',
    'anthropic-version',
    'content-type',
    'x-app',
    'x-client-request-id',
  ]) {
    assert.ok(names.includes(name), `${name} keeps its lower-case spelling`)
  }
  // The client's own request-shape headers keep their lower-case spelling too.
  assert.ok(names.includes('x-claude-code-prompt-id'))
  assert.ok(names.includes('x-claude-code-request-class'))
})

test('the prompt id and request class ride the headers the client sends them on', async () => {
  const built = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-prompt-id'), ACCOUNT)
  const headers = headerMap(built)
  const promptId = promptIdOf(built)
  assert.match(promptId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  // One value, two carriers: the header and the billing segment agree.
  assert.equal(headers.get('x-claude-code-prompt-id'), promptId)
  assert.equal(headers.get('x-claude-code-request-class'), 'main')
})

test('the request class follows the call kind the caller stated', async () => {
  const account = session()
  const compaction = await buildClaudeWireRequest(
    { ...options(), purpose: 'compaction' },
    account, history(), 32_000, undefined, undefined, wireSessionId('sess-class-compaction'), ACCOUNT,
  )
  assert.equal(headerMap(compaction).get('x-claude-code-request-class'), 'compaction')
  const title = await buildClaudeWireRequest(
    { ...options(), purpose: 'session-title' },
    account, history(), 32_000, undefined, undefined, wireSessionId('sess-class-title'), ACCOUNT,
  )
  assert.equal(headerMap(title).get('x-claude-code-request-class'), 'auxiliary')
  // An unstated purpose is the conversation's own Messages request; explicit classes win.
  assert.equal(claudeRequestClass(undefined, undefined), 'main')
  assert.equal(claudeRequestClass(undefined, 'auxiliary'), 'auxiliary')
  assert.equal(claudeRequestClass(undefined, 'subagent'), 'subagent')
  assert.equal(claudeRequestClass('session-title', 'main'), 'main')
})

test('the body states no context-management field on any model', async () => {
  // The route applies no server-side context edits: it states no clear_tool_uses and no
  // clear_thinking policy. The beta that declares the feature may still ride with the model's
  // capabilities, but the body field the caller would have to supply must never appear.
  for (const model of ['claude-opus-5', 'claude-sonnet-4-5']) {
    const built = await buildClaudeWireRequest(
      options({ model }), session(), history(), 32_000, undefined, undefined,
      wireSessionId(`sess-no-context-management-${model}`), ACCOUNT,
    )
    assert.equal('context_management' in parseBody(built), false, `${model} states no context-management policy`)
    assert.equal(String(built.body).includes('clear_tool_uses'), false)
    assert.equal(String(built.body).includes('clear_thinking'), false)
  }
})

test('thinking and a long tool-result history state no context-management field', async () => {
  // The two conditions a context-edit planner would react to: thinking on the request, and a
  // run of tool results large enough to be worth clearing. Neither states the field, and
  // neither do both together.
  const messages: TranslatableMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
  for (let index = 0; index < 30; index += 1) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId(`c${String(index)}`), name: 'bash', arguments: '{}' }],
    })
    messages.push({
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId(`c${String(index)}`),
        content: [{ type: 'text', text: 'x'.repeat(400) }],
      }],
    })
  }
  for (const thinking of [undefined, { type: 'adaptive' } as const]) {
    const built = await buildClaudeWireRequest(
      options({ messages: messages as never }), session(), messages, 32_000,
      thinking, 'high', wireSessionId(`sess-no-context-management-${thinking === undefined ? 'plain' : 'thinking'}`), ACCOUNT,
    )
    assert.equal('context_management' in parseBody(built), false)
    assert.equal(String(built.body).includes('clear_tool_uses'), false)
    assert.equal(String(built.body).includes('clear_thinking'), false)
  }
})

test('body carries stream, cache breakpoints, name-ordered tools, thinking and effort', async () => {
  const built = await buildClaudeWireRequest(
    options({
      tools: [
        { name: 'write', description: 'write a file', parameters: { type: 'object' } },
        { name: 'bash', description: 'run', parameters: { type: 'object' } },
      ],
    }),
    session(),
    history(),
    32_000,
    { type: 'adaptive' },
    'high',
    wireSessionId('sess-1'),
    ACCOUNT,
  )
  const body = parseBody(built)
  assert.equal(body.stream, true)
  assert.equal(body.model, 'claude-opus-5')
  assert.equal(body.max_tokens, 32_000)
  assert.deepEqual((body.tools as { name: string }[]).map(tool => tool.name), ['bash', 'write'])
  // No tool carries a marker: the client's only tool-marker seam is an option its
  // main-loop tool builder never passes, so a genuine request marks only the system
  // blocks and the newest message.
  assert.equal(body.tools.some((tool: { cache_control?: unknown }) => tool.cache_control !== undefined), false)
  const system = body.system as { text: string; cache_control?: unknown }[]
  assert.deepEqual(system[system.length - 1].cache_control, { type: 'ephemeral', ttl: '1h' }, 'the caller system block carries the system breakpoint')
  assert.deepEqual(system[1].cache_control, { type: 'ephemeral', ttl: '1h' }, 'the identity block keeps its unconditional marker')
  assert.deepEqual((body.messages as { content: { cache_control?: unknown }[] }[])[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'updates' })
  assert.deepEqual(body.output_config, { effort: 'high' })
})

test('an enabled thinking request carries the manual budget and display', async () => {
  // The pinned catalogue marks Opus 4.5 thinking-enabled without the adaptive
  // type, so a manual budget survives on the wire.
  const built = await buildClaudeWireRequest(options({ model: 'claude-opus-4-5' }), session(), history(), 32_000, { type: 'enabled', budgetTokens: 16_000 }, undefined, wireSessionId('sess-1'), ACCOUNT)
  const body = parseBody(built)
  assert.deepEqual(body.thinking, { budget_tokens: 16_000, type: 'enabled', display: 'updates' })
})

test('tool-less, effort-less requests omit tools, thinking and output_config', async () => {
  const bare: GenerateOptions = { provider: 'claude', model: 'claude-opus-5', messages: history() as never }
  const built = await buildClaudeWireRequest(bare, session(), history(), 32_000, undefined, undefined, wireSessionId('sess-1'), ACCOUNT)
  const body = parseBody(built)
  assert.equal('tools' in body, false)
  assert.equal('thinking' in body, false)
  assert.equal('output_config' in body, false)
})

test('the caller temperature reaches the models the pinned profile gives it', async () => {
  // The client sends its caller's own temperature, and its compiled-in 1 when the
  // caller states none, on the model the profile carries the parameter for. The
  // pinned builder owns that capability gate; this route only supplies the value.
  const model = 'claude-sonnet-4-5'
  const defaulted = await buildClaudeWireRequest(options({ model }), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-temp'), ACCOUNT)
  assert.equal(parseBody(defaulted).temperature, 1, 'the client default when the caller states none')

  const asked = await buildClaudeWireRequest(options({ model, temperature: 0.2 }), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-temp'), ACCOUNT)
  assert.equal(parseBody(asked).temperature, 0.2, 'the caller value reaches the wire')

  // A model outside the profile's allowlist carries no temperature at all, whether
  // or not the caller asked for one, exactly as the client's own gate behaves.
  const gated = await buildClaudeWireRequest(options({ model: 'claude-opus-5', temperature: 0.2 }), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-temp'), ACCOUNT)
  assert.equal('temperature' in parseBody(gated), false)
})

test('a caller stop sequence is refused instead of silently dropped', async () => {
  await assert.rejects(
    () => buildClaudeWireRequest(options({ stop: ['</done>'] }), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-stop'), ACCOUNT),
    (error: unknown) => error instanceof LlmError
      && error.code === 'INVALID_REQUEST'
      && error.message.includes('no stop-sequence field'),
    'a non-empty stop list fails the request',
  )

  // An empty list states nothing about the option and passes through as absence.
  const empty = await buildClaudeWireRequest(options({ stop: [] }), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-stop'), ACCOUNT)
  assert.equal('stop_sequences' in parseBody(empty), false)
})

test('the selected previous request id chains into the billing block', async () => {
  // The selection is the retained history's own fact (see the continuation selector's cases); this
  // asserts the builder maps exactly what its caller selected.
  const chained = await buildClaudeWireRequest(
    options(), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-2'), ACCOUNT,
    { previousRequestId: 'req_abc123' },
  )
  assert.match(parseBody(chained).system[0].text, / cc_prev_req=req_abc123;/)

  // A request whose history selected no id chains nothing.
  const fresh = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-3'), ACCOUNT)
  assert.ok(!parseBody(fresh).system[0].text.includes('cc_prev_req='))
})

test('the chained id is the caller\'s selection, never a process-local memory', async () => {
  const first = await buildClaudeWireRequest(
    options(), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-x'), 'acct-a',
    { previousRequestId: 'req_aaa111' },
  )
  assert.match(parseBody(first).system[0].text, / cc_prev_req=req_aaa111;/)

  // A later request that selected nothing does not inherit the earlier one's id: no map remembers it.
  const second = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-x'), 'acct-a')
  assert.ok(!parseBody(second).system[0].text.includes('cc_prev_req='))

  // Another account's request carries its own selection and cannot reach the first account's id.
  const other = await buildClaudeWireRequest(
    options(), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-x'), 'acct-b',
    { previousRequestId: 'req_bbb222' },
  )
  assert.match(parseBody(other).system[0].text, / cc_prev_req=req_bbb222;/)
  assert.ok(!parseBody(other).system[0].text.includes('req_aaa111'))
})

test('the builder declares the wire identity it is given, pin and chain included', async () => {
  const spanId = '11111111-1111-4111-8111-111111111111'
  const built = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, spanId, ACCOUNT)
  const body = parseBody(built)
  assert.equal(headerMap(built).get('x-claude-code-session-id'), spanId)
  assert.equal(JSON.parse(body.metadata.user_id as string).session_id, spanId)
  // The identity is the caller's committed fact, not something minted per build.
  const again = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, spanId, ACCOUNT)
  assert.equal(headerMap(again).get('x-claude-code-session-id'), spanId)

  const withFacts = await buildClaudeWireRequest(
    options(), session(), history(), 32_000, undefined, undefined, spanId, ACCOUNT,
    { atisPin: 'atis-token-1', previousRequestId: 'req_orig111' },
  )
  assert.equal(headerMap(withFacts).get('x-cc-atis'), 'atis-token-1')
  assert.match(parseBody(withFacts).system[0].text, / cc_prev_req=req_orig111;/)
  // The pin is not carried by a request that states none: the header is absent.
  assert.equal(headerMap(built).get('x-cc-atis'), undefined)
})

test('a non-UUID wire session id is refused before the request is built', async () => {
  await assert.rejects(
    () => buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, 'sess-1', ACCOUNT),
    (error: unknown) => error instanceof LlmError
      && error.code === 'INVALID_REQUEST'
      && error.message.includes('is not a UUID'),
    'the client declares its session as a UUID and nothing else',
  )
})

test('cc_prompt_id is derived from the session and the turn, and reused across tool continuations', async () => {
  const first = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-9'), ACCOUNT)
  const firstId = promptIdOf(first)
  assert.match(firstId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'a UUIDv4-shaped id')

  const rebuilt = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-9'), ACCOUNT)
  assert.equal(promptIdOf(rebuilt), firstId, 'the same session and turn render the same id')
  assert.equal(rebuilt.body, first.body, 'and the same request bytes')

  const continuation = await buildClaudeWireRequest(options(), session(), toolStep(), 32_000, undefined, undefined, wireSessionId('sess-9'), ACCOUNT)
  assert.equal(promptIdOf(continuation), firstId, 'tool continuations reuse the turn prompt id')

  const nextTurn = await buildClaudeWireRequest(options(), session(), secondTurn(), 32_000, undefined, undefined, wireSessionId('sess-9'), ACCOUNT)
  assert.notEqual(promptIdOf(nextTurn), firstId, 'a new user turn renders its own id')
  assert.match(promptIdOf(nextTurn), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

  const otherSession = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-10'), ACCOUNT)
  assert.notEqual(promptIdOf(otherSession), firstId, 'another session never renders the same id')
  assert.notEqual(otherSession.body, first.body, 'so the request bytes differ with it')
})

test('the wire builder fails without a backfilled identity', async () => {
  const { deviceId: _dropped, ...incomplete } = session()
  await assert.rejects(
    () => buildClaudeWireRequest(options(), incomplete, history(), 32_000, undefined, undefined, wireSessionId('sess-1'), ACCOUNT),
    /wire identity is missing/,
  )
})

test('oversizeWireError requests an image offload or a compact', () => {
  const withImage: TranslatableMessage[] = [{
    role: 'user',
    content: [{ type: 'image', mediaType: 'image/png', dataBase64: 'aGk=' }],
  }]
  const offload = oversizeWireError(withImage)
  assert.ok(offload instanceof LlmError)
  assert.equal(offload.code, IMAGE_OFFLOAD_REQUIRED_CODE)
  assert.equal((offload as LlmError & { failure?: { offloadImages?: number } }).failure?.offloadImages, 1)

  const textOnly = oversizeWireError(history())
  assert.ok(textOnly instanceof LlmError)
  assert.equal(textOnly.code, 'INVALID_REQUEST')
})

test('mapClaudeWireError maps every wire code to a diagnosable INVALID_REQUEST', () => {
  const withImage: TranslatableMessage[] = [{
    role: 'user',
    content: [{ type: 'image', mediaType: 'image/png', dataBase64: 'aGk=' }],
  }]

  const oversize = mapClaudeWireError(new ClaudeCodeWireError('INPUT_TOO_LARGE'), withImage)
  assert.ok(oversize instanceof LlmError)
  assert.equal(oversize.code, IMAGE_OFFLOAD_REQUIRED_CODE)

  for (const [code, hint] of [
    ['INVALID_EFFORT', 'reasoning effort'],
    ['INVALID_THINKING', 'thinking configuration'],
    ['UNSUPPORTED_CAPABILITY', 'pinned wire profile'],
    ['CRYPTO_UNAVAILABLE', 'WebCrypto'],
    ['INVALID_IDENTITY', 'log in again'],
    ['INVALID_UNICODE', 'wire rejects'],
  ] as const) {
    const mapped = mapClaudeWireError(new ClaudeCodeWireError(code), history())
    assert.ok(mapped instanceof LlmError, `${code} maps to a LlmError`)
    assert.equal(mapped.code, 'INVALID_REQUEST')
    assert.ok(mapped.message.includes(code), `${code} names itself in the message`)
    assert.ok(mapped.message.includes(hint), `${code} carries its explanation`)
  }

  const details = mapClaudeWireError(new ClaudeCodeWireError('INVALID_INPUT', { field: 'model' }), history())
  assert.ok(details?.message.includes('"field":"model"'), 'safe details ride in the message')

  assert.equal(mapClaudeWireError(new Error('boom'), history()), undefined, 'non-wire errors pass through')
})

test('the cache ttl and its beta follow the granted scope', async () => {
  // The client resolves one ttl per request and pushes the beta that declares the longer one
  // only when that ttl is used. The deciding input is the `user:inference` scope, so a session
  // granted no such scope gets the server's own default, expressed by leaving the field out.
  const subscriber = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, wireSessionId('sess-ttl'), ACCOUNT)
  assert.match(String(subscriber.body), /"ttl":"1h"/)
  const subscriberBeta = String(subscriber.headers.find(([name]) => name.toLowerCase() === 'anthropic-beta')?.[1] ?? '')
  assert.match(subscriberBeta, /extended-cache-ttl/)

  // The field is absent rather than undefined: the option type forbids an explicit undefined.
  const plain = await buildClaudeWireRequest(
    options(), { ...session(), scopes: 'user:profile' }, history(), 32_000, undefined, undefined, wireSessionId('sess-ttl-plain'), ACCOUNT,
  )
  assert.equal(String(plain.body).includes('"ttl"'), false, 'no ttl key at all')
  const plainBeta = String(plain.headers.find(([name]) => name.toLowerCase() === 'anthropic-beta')?.[1] ?? '')
  assert.equal(plainBeta.includes('extended-cache-ttl'), false, 'and no beta declaring one')

  // An explicit helper/subagent class outranks purpose for both the header and the ttl.
  for (const requestClass of ['auxiliary', 'subagent'] as const) {
    const helper = await buildClaudeWireRequest(
      { ...options(), requestClass }, session(), history(), 32_000, undefined, undefined,
      wireSessionId(`sess-ttl-${requestClass}`), ACCOUNT,
    )
    assert.equal(headerMap(helper).get('x-claude-code-request-class'), requestClass)
    assert.equal(String(helper.body).includes('"ttl"'), false, `${requestClass} takes the default ttl`)
    const helperBeta = String(helper.headers.find(([name]) => name.toLowerCase() === 'anthropic-beta')?.[1] ?? '')
    assert.equal(helperBeta.includes('extended-cache-ttl'), false, `${requestClass} omits the extended beta`)
  }

  // An explicit main class outranks a helper purpose for both the header and the ttl.
  const explicitMain = await buildClaudeWireRequest(
    { ...options(), purpose: 'session-title', requestClass: 'main' }, session(), history(), 32_000,
    undefined, undefined, wireSessionId('sess-ttl-explicit-main'), ACCOUNT,
  )
  assert.equal(headerMap(explicitMain).get('x-claude-code-request-class'), 'main')
  assert.match(String(explicitMain.body), /"ttl":"1h"/)
})

test('grouping shared sections first reproduces the client cache layout', async () => {
  // Shared text goes ahead of session text so more of the request can be a cache prefix,
  // and the wire builder marks the two sides the way the genuine client does: the identity
  // block unmarked, the shared side globally scoped, the session side plainly marked.
  const built = await buildClaudeWireRequest(
    options({
      systemSections: [
        { name: 'tool:bash', text: 'SHARED-ONE', stable: true },
        { name: 'deployment:persona-prefix', text: 'SESSION-ONE', stable: false },
        { name: 'tool:read', text: 'SHARED-TWO', stable: true },
      ],
    }),
    session(), history(), 32_000, undefined, undefined, wireSessionId('sess-sections'), ACCOUNT,
  )
  const system = parseBody(built).system as { text: string; cache_control?: { scope?: string } }[]
  assert.equal(system[1].cache_control, undefined, 'the identity block carries no marker')
  assert.match(system[2].text, /SHARED-ONE[\s\S]*SHARED-TWO/, 'both shared sections lead')
  assert.deepEqual(system[2].cache_control, { type: 'ephemeral', ttl: '1h', scope: 'global' })
  assert.match(system[3].text, /SESSION-ONE/, 'session text follows the shared run')
  assert.deepEqual(system[3].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(system.some(block => block.text.includes('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')), false, 'the marker is a separator, not content')
})

test('a machine-local harness section is not sent', async () => {
  // `harness:identity` states a second identity beside the client's own, and `harness:source`
  // names a machine-local checkout path; a client-shaped request carries neither.
  const built = await buildClaudeWireRequest(
    options({
      systemSections: [
        { name: 'harness:identity', text: 'You are an AI coding agent in a local harness.', stable: true },
        { name: 'tool:bash', text: 'SHARED-TOOL-DOCS', stable: true },
        { name: 'harness:source', text: 'The DeepSeek Harness implementation checkout is at C:\\somewhere.', stable: false },
      ],
    }),
    session(), history(), 32_000, undefined, undefined, wireSessionId('sess-harness-only'), ACCOUNT,
  )
  const text = String(built.body)
  assert.equal(text.includes('checkout is at'), false, 'no machine-local path')
  // The harness identity section is replaced by this route's own line.
  assert.match(text, /local agent harness/, 'the route identity is carried')
  const system = parseBody(built).system as { text: string }[]
  assert.equal(system.filter(block => block.text.includes('You are a')).length, 2, 'the client block plus the deployment line')
})

/**
 * The section a `dsh web` session registers for its own GUI, as the live request under
 * `C:\Project\deepseek-harness-data\sessions` carried it.
 */
const WEB_SURFACE_SECTION = 'You are interacting with the user through the DeepSeek Harness Web GUI at http://127.0.0.1:3080. '
  + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
  + 'The browser provides no implicit DOM, route, or screenshot context. '
  + 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while `pnpm run dev:web` '
  + 'is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
  + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
  + 'Starting another server does not update this GUI. '
  + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
  + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'

test('a Web surface section does not name this harness to the client', async () => {
  // The live request's own section set: the harness's identity and source lines, the Web
  // surface line for the GUI the session was created through, and the deployment persona the
  // `web` profile supplies. Only the client's own identity belongs in a client-shaped request.
  const built = await buildClaudeWireRequest(
    options({
      systemSections: [
        { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.', stable: true },
        { name: 'tool:read', text: 'Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.', stable: true },
        { name: 'tool:pwsh', text: 'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on.', stable: true },
        { name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the claude-opus-5-5 model.', stable: false },
        { name: 'agent-teams:usage', text: 'AgentTeams (Agent Teams) provides multi-agent team collaboration. Apply these rules when the user requests it (including /agent-teams) or when continuing an existing team.', stable: false },
        { name: 'harness:source', text: 'The DeepSeek Harness implementation checkout is at C:\\Project\\deepseek-harness\\. The checkout location and current working directory are separate values and may differ; never infer the working directory from this path.', stable: false },
        { name: 'app:web-surface', text: WEB_SURFACE_SECTION, stable: false },
        { name: 'deployment:persona-suffix', text: 'Your working directory is D:\\Ryan416_DESKTOP-LETT6RL_TheSunNeverSets.', stable: false },
      ],
    }),
    session(), history(), 32_000, undefined, undefined, wireSessionId('sess-web-surface'), ACCOUNT,
  )
  const system = parseBody(built).system as { text: string }[]
  const systemText = system.map(block => block.text).join('\n\n')

  // No passage identifies the harness: not the product, its GUI, its loopback endpoint, its
  // CLI surface, or the checkout path.
  assert.equal(systemText.includes('DeepSeek Harness'), false, 'no harness product name')
  assert.equal(systemText.includes('Web GUI'), false, 'no harness GUI')
  assert.equal(systemText.includes('127.0.0.1'), false, 'no loopback endpoint')
  assert.equal(systemText.includes('dsh web'), false, 'no harness CLI surface')
  assert.equal(systemText.includes('C:\\Project\\deepseek-harness'), false, 'no checkout path')

  // The instructions and the real environment facts the model works from survive.
  assert.match(systemText, /Use the read tool/, 'the read-tool guidance is carried')
  assert.match(systemText, /Non-zero exits are reported/, 'the shell guidance is carried')
  assert.match(systemText, /AgentTeams \(Agent Teams\) provides/, 'the team guidance is carried')
  assert.match(systemText, /You are a coding agent powered by the claude-opus-5-5 model\./, 'the deployment persona is carried')
  assert.match(systemText, /Your working directory is D:\\Ryan416_DESKTOP-LETT6RL_TheSunNeverSets\./, 'the workspace is carried')
  assert.match(systemText, /authoritative set available to you/, 'the route own identity line is carried')
})

test('a loop-shaped request carries the prompt once, with no harness identity or local path', async () => {
  // The loop renders the prompt, hands it over as its sections, and leaves the same
  // rendered text as the derived history's leading system message. The sections are the
  // prompt's only carrier, so that message must not be lifted into the system array as
  // well: the copy would both duplicate the prompt and carry the unfiltered harness
  // identity and machine-local checkout path this route exists to keep off the wire.
  const rendered = [
    'You are an AI agent powered by DeepSeek Harness.',
    'The DeepSeek Harness implementation checkout is at C:\\Project\\deepseek-harness.',
    'BE-TERSE-MARKER',
  ].join('\n\n')
  const loopHistory: TranslatableMessage[] = [
    { role: 'system', content: [{ type: 'text', text: rendered }] },
    ...history(),
  ]
  const built = await buildClaudeWireRequest(
    options({
      systemSections: [
        { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.', stable: true },
        { name: 'harness:source', text: 'The DeepSeek Harness implementation checkout is at C:\\Project\\deepseek-harness.', stable: true },
        { name: 'deployment:persona', text: 'BE-TERSE-MARKER', stable: false },
      ],
    }),
    session(), loopHistory, 32_000, undefined, undefined, wireSessionId('sess-loop'), ACCOUNT,
  )
  const system = parseBody(built).system as { text: string }[]
  assert.equal(
    system.filter(block => block.text.includes('BE-TERSE-MARKER')).length,
    1,
    'the prompt reaches the wire exactly once',
  )
  assert.equal(
    system.some(block => block.text === rendered),
    false,
    'the raw history copy is not a second carrier',
  )
  assert.equal(built.body.includes('DeepSeek Harness'), false, 'the harness identity is not on the wire')
  assert.equal(built.body.includes('deepseek-harness'), false, 'nor the machine-local checkout path')
  assert.match(built.body, /local agent harness/, 'the route own identity line is carried instead')
})

test('the identity line is this route own and never names the harness', async () => {
  const sections = [
    { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.', stable: true },
    { name: 'tool:bash', text: 'TOOL-DOCS', stable: true },
  ]
  const build = async (identityLine?: string): Promise<{ body: string; system: { text: string }[] }> => {
    const built = await buildClaudeWireRequest(
      options({ systemSections: sections }), session(), history(), 32_000,
      undefined, undefined, wireSessionId('sess-identity'), ACCOUNT, {}, identityLine,
    )
    return { body: String(built.body), system: parseBody(built).system as { text: string }[] }
  }
  // The compiled-in default describes the environment without naming a product.
  const fallback = await build()
  assert.equal(fallback.body.includes('DeepSeek Harness'), false)
  assert.match(fallback.body, /authoritative set available to you/)
  // A configured line replaces it.
  const configured = await build('CONFIGURED-ROUTE-IDENTITY')
  assert.match(configured.body, /CONFIGURED-ROUTE-IDENTITY/)
  assert.equal(configured.body.includes('DeepSeek Harness'), false)
})

/** The Files API id one oversized image in a request was bound to. */
function imageFileId(messages: readonly TranslatableMessage[]): string | undefined {
  for (const block of messages[0]?.content ?? []) {
    if (block.type === 'image' && 'dataBase64' in block) return block.fileId
  }
  return undefined
}

/** One request message carrying an image over the inline vision limit. */
function oversizedImage(): TranslatableMessage[] {
  return [{
    role: 'user',
    content: [{ type: 'image', mediaType: 'image/png', dataBase64: 'A'.repeat(CLAUDE_MAX_BASE64_IMAGE_CHARS + 1) }],
  }]
}

test('an uploaded file id is cached under the account that uploaded it', async () => {
  clearClaudeFileIds()
  const tokens: string[] = []
  const fetchFn = ((_input: RequestInfo | URL, init?: RequestInit) => {
    tokens.push(String((init?.headers as Record<string, string>).authorization))
    return Promise.resolve(Response.json({ id: `file_${tokens.length}`, type: 'file' }))
  }) as FetchFn
  const messages = oversizedImage()

  const onA = await bindClaudeFileIds(messages, 'acct-a', 'token-a', fetchFn)
  const againOnA = await bindClaudeFileIds(messages, 'acct-a', 'token-a', fetchFn)
  assert.equal(imageFileId(onA), 'file_1')
  assert.equal(imageFileId(againOnA), 'file_1', 'the same account reuses its own upload')

  // A pooled failover must upload its own copy: a file id belongs to the token
  // that created it, so another account cannot present it.
  const onB = await bindClaudeFileIds(messages, 'acct-b', 'token-b', fetchFn)
  assert.equal(imageFileId(onB), 'file_2')
  assert.deepEqual(tokens, ['Bearer token-a', 'Bearer token-b'])

  // An auth change drops only that account's entries.
  clearClaudeFileIds('acct-a')
  assert.equal(imageFileId(await bindClaudeFileIds(messages, 'acct-a', 'token-a', fetchFn)), 'file_3')
  assert.equal(imageFileId(await bindClaudeFileIds(messages, 'acct-b', 'token-b', fetchFn)), 'file_2')
  assert.deepEqual(tokens, ['Bearer token-a', 'Bearer token-b', 'Bearer token-a'])
})

test('the uploaded file id table is bounded and evicts the oldest entry', () => {
  clearClaudeFileIds()
  for (let index = 0; index < CLAUDE_FILE_ID_LIMIT; index += 1) {
    rememberClaudeFileId('acct-bound', `hash-${index}`, `file-${index}`)
  }
  assert.equal(uploadedClaudeFileId('acct-bound', 'hash-0'), 'file-0')

  rememberClaudeFileId('acct-bound', `hash-${CLAUDE_FILE_ID_LIMIT}`, 'file-last')
  assert.equal(uploadedClaudeFileId('acct-bound', 'hash-0'), undefined, 'the oldest entry makes room')
  assert.equal(uploadedClaudeFileId('acct-bound', `hash-${CLAUDE_FILE_ID_LIMIT}`), 'file-last')
  assert.equal(uploadedClaudeFileId('acct-bound', 'hash-1'), 'file-1', 'the rest of the table survives')

  // Re-remembering a known entry replaces its id without growing the table.
  rememberClaudeFileId('acct-bound', 'hash-1', 'file-1b')
  assert.equal(uploadedClaudeFileId('acct-bound', 'hash-1'), 'file-1b')
  assert.equal(uploadedClaudeFileId('acct-bound', 'hash-2'), 'file-2')

  clearClaudeFileIds()
  assert.equal(uploadedClaudeFileId('acct-bound', 'hash-1'), undefined)
})

test('the bounded two-level table evicts the oldest leaf across both levels', () => {
  const table = boundedTwoLevelMap<string>(3)
  table.set('a', '1', 'a1')
  table.set('a', '2', 'a2')
  table.set('b', '1', 'b1')
  assert.equal(table.get('a', '1'), 'a1')
  assert.equal(table.isEmpty('a'), false)
  assert.equal(table.isEmpty('c'), true, 'an absent entry holds no leaf')

  // A new leaf at the limit evicts the oldest leaf: the first leaf of the
  // first entry that still has one.
  table.set('b', '2', 'b2')
  assert.equal(table.get('a', '1'), undefined)
  assert.equal(table.get('a', '2'), 'a2', 'the rest of the entry survives')
  assert.equal(table.get('b', '2'), 'b2')

  // Replacing an existing leaf is not growth, so nothing is evicted.
  table.set('a', '2', 'a2b')
  assert.equal(table.get('a', '2'), 'a2b')
  assert.equal(table.get('b', '1'), 'b1')

  // The last leaf of an entry takes the entry with it.
  table.deleteOuter('a')
  assert.equal(table.isEmpty('a'), true)
  table.set('c', '1', 'c1')
  assert.equal(table.get('c', '1'), 'c1', 'the freed slot is usable')

  table.clear()
  assert.equal(table.get('c', '1'), undefined)
  assert.equal(table.isEmpty('c'), true)
})
