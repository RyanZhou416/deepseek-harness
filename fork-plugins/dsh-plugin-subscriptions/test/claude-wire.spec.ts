/**
 * Wire-contract tests for the pinned Claude Code request builder: the profile
 * pin, the mapping from resolved harness requests, the runtime identity, the
 * per-account/per-session conversation chain, the oversize → offload mapping,
 * and the wire-error mapping. No network; the builder is pure and the fetch
 * boundary is not exercised.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLAUDE_CODE_2_1_280_PROFILE,
  ClaudeCodeWireError,
} from '@tormentalabs/claude-code-wire-compat'
import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  buildClaudeWireRequest,
  CLAUDE_USER_AGENT,
  claudeWireSessionId,
  mapClaudeWireError,
  rememberClaudeRequestId,
} from '../src/providers/claude-wire.js'
import { oversizeWireError } from '../src/providers/claude-images.js'
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
    scopes: 'scopes',
    accountUuid: 'uuid-1',
    deviceId: 'dev-1',
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

function parseBody(built: { body: string }): Record<string, any> {
  return JSON.parse(built.body) as Record<string, any>
}

test('the pinned profile is the Claude Code 2.1.280 CLI identity', () => {
  assert.equal(CLAUDE_CODE_2_1_280_PROFILE.cliVersion, '2.1.280')
  assert.equal(CLAUDE_CODE_2_1_280_PROFILE.sdkVersion, '0.112.1')
  assert.equal(CLAUDE_USER_AGENT, 'claude-cli/2.1.280 (external, cli)')
})

test('buildClaudeWireRequest emits the billing and identity blocks and the correlation triple', async () => {
  const built = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, 'sess-1', ACCOUNT)
  assert.equal(built.url, 'https://api.anthropic.com/v1/messages?beta=true')
  const body = parseBody(built)
  const system = body.system as { type: string; text: string }[]
  assert.match(system[0].text, /^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=cli; cch=00000;/)
  assert.equal(system[1].text, 'You are Claude Code, Anthropic\'s official CLI for Claude.')
  assert.deepEqual(JSON.parse(body.metadata.user_id as string), {
    device_id: 'dev-1',
    account_uuid: 'uuid-1',
    session_id: 'sess-1',
  })
})

test('headers carry the pinned plan and the session identity', async () => {
  const account = session()
  const built = await buildClaudeWireRequest(options(), account, history(), 32_000, undefined, undefined, 'sess-1', ACCOUNT)
  const headers = headerMap(built)
  assert.equal(headers.get('authorization'), `Bearer ${account.accessToken}`)
  assert.equal(headers.get('x-app'), 'cli')
  assert.equal(headers.get('user-agent'), 'claude-cli/2.1.280 (external, cli)')
  assert.equal(headers.get('anthropic-version'), '2023-06-01')
  assert.equal(headers.get('anthropic-dangerous-direct-browser-access'), 'true')
  assert.equal(headers.get('x-claude-code-session-id'), 'sess-1')
  assert.ok((headers.get('anthropic-beta') ?? '').length > 0, 'beta header is composed by the builder')
  assert.match(headers.get('x-client-request-id') ?? '', /^[0-9a-f-]{36}$/)
  assert.equal(headers.get('x-stainless-runtime'), 'node')
  assert.equal(headers.get('x-stainless-runtime-version'), process.versions.node)
  assert.equal(headers.has('accept'), false, 'the genuine client sends no accept header')
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
    'sess-1',
    ACCOUNT,
  )
  const body = parseBody(built)
  assert.equal(body.stream, true)
  assert.equal(body.model, 'claude-opus-5')
  assert.equal(body.max_tokens, 32_000)
  assert.deepEqual((body.tools as { name: string }[]).map(tool => tool.name), ['bash', 'write'])
  assert.deepEqual(body.tools[1].cache_control, { type: 'ephemeral', ttl: '1h' }, 'the last tool carries the tool breakpoint')
  const system = body.system as { text: string; cache_control?: unknown }[]
  assert.deepEqual(system[system.length - 1].cache_control, { type: 'ephemeral', ttl: '1h' }, 'the caller system block carries the system breakpoint')
  assert.deepEqual(system[1].cache_control, { type: 'ephemeral', ttl: '1h' }, 'the identity block keeps its unconditional marker')
  assert.deepEqual((body.messages as { content: { cache_control?: unknown }[] }[])[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(body.output_config, { effort: 'high' })
})

test('an enabled thinking request carries the manual budget and display', async () => {
  // The pinned catalogue marks Opus 4.5 thinking-enabled without the adaptive
  // type, so a manual budget survives on the wire.
  const built = await buildClaudeWireRequest(options({ model: 'claude-opus-4-5' }), session(), history(), 32_000, { type: 'enabled', budgetTokens: 16_000 }, undefined, 'sess-1', ACCOUNT)
  const body = parseBody(built)
  assert.deepEqual(body.thinking, { budget_tokens: 16_000, type: 'enabled', display: 'summarized' })
})

test('tool-less, effort-less requests omit tools, thinking and output_config', async () => {
  const bare: GenerateOptions = { provider: 'claude', model: 'claude-opus-5', messages: history() as never }
  const built = await buildClaudeWireRequest(bare, session(), history(), 32_000, undefined, undefined, 'sess-1', ACCOUNT)
  const body = parseBody(built)
  assert.equal('tools' in body, false)
  assert.equal('thinking' in body, false)
  assert.equal('output_config' in body, false)
})

test('the previous request id chains into the billing block per session', async () => {
  rememberClaudeRequestId(ACCOUNT, 'sess-2', 'req_abc123')
  const chained = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, 'sess-2', ACCOUNT)
  assert.match(parseBody(chained).system[0].text, / cc_prev_req=req_abc123;/)

  const fresh = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, 'sess-3', ACCOUNT)
  assert.ok(!parseBody(fresh).system[0].text.includes('cc_prev_req='))

  // A response without a request-id header clears the chain, matching the
  // genuine client's continuity commit.
  rememberClaudeRequestId(ACCOUNT, 'sess-2', null)
  const cleared = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, 'sess-2', ACCOUNT)
  assert.ok(!parseBody(cleared).system[0].text.includes('cc_prev_req='))
})

test('conversation chains are isolated per account', async () => {
  rememberClaudeRequestId('acct-a', 'sess-x', 'req_aaa111')
  const onA = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, 'sess-x', 'acct-a')
  assert.match(parseBody(onA).system[0].text, / cc_prev_req=req_aaa111;/)

  // A pool failover to another account in the same session starts a fresh
  // chain: no foreign request id, and its own prompt id.
  const onB = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, 'sess-x', 'acct-b')
  assert.ok(!parseBody(onB).system[0].text.includes('cc_prev_req='))

  const backOnA = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, 'sess-x', 'acct-a')
  assert.match(parseBody(backOnA).system[0].text, / cc_prev_req=req_aaa111;/)
})

test('the wire session id rolls when a second account serves the same harness session', async () => {
  // The first account span reuses the harness id verbatim, so single-account
  // sessions keep today's bytes.
  assert.equal(claudeWireSessionId('acct-a', 'ds-1'), 'ds-1')
  assert.equal(claudeWireSessionId('acct-a', 'ds-1'), 'ds-1', 'the id is stable per account span')

  const rolled = claudeWireSessionId('acct-b', 'ds-1')
  assert.notEqual(rolled, 'ds-1', 'a failover account gets a fresh wire session id')
  assert.match(rolled, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.equal(claudeWireSessionId('acct-b', 'ds-1'), rolled, 'the rolled id stays stable for its span')

  // Switching back resumes the original id, and its chain.
  assert.equal(claudeWireSessionId('acct-a', 'ds-1'), 'ds-1')
  rememberClaudeRequestId('acct-a', 'ds-1', 'req_orig111')
  const back = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, 'ds-1', 'acct-a')
  assert.match(parseBody(back).system[0].text, / cc_prev_req=req_orig111;/)

  // A rolled span builds under its own identity: its session id rides the
  // header and the correlation triple, and it starts with no foreign chain.
  const span = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, rolled, 'acct-b')
  const body = parseBody(span)
  assert.equal(JSON.parse(body.metadata.user_id as string).session_id, rolled)
  assert.equal(headerMap(span).get('x-claude-code-session-id'), rolled)
  assert.ok(!body.system[0].text.includes('cc_prev_req='))

  // Different harness sessions stay independent even on the same account.
  assert.equal(claudeWireSessionId('acct-a', 'ds-2'), 'ds-2')
})

test('cc_prompt_id is a UUIDv4 minted per user turn and reused across tool continuations', async () => {
  const first = await buildClaudeWireRequest(options(), session(), history(), 32_000, undefined, undefined, 'sess-9', ACCOUNT)
  const firstId = promptIdOf(first)
  assert.match(firstId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'a UUIDv4 per turn')

  const continuation = await buildClaudeWireRequest(options(), session(), toolStep(), 32_000, undefined, undefined, 'sess-9', ACCOUNT)
  assert.equal(promptIdOf(continuation), firstId, 'tool continuations reuse the turn prompt id')

  const nextTurn = await buildClaudeWireRequest(options(), session(), [{ role: 'user', content: [{ type: 'text', text: 'next turn' }] }], 32_000, undefined, undefined, 'sess-9', ACCOUNT)
  assert.notEqual(promptIdOf(nextTurn), firstId, 'a new user turn mints a fresh prompt id')
  assert.match(promptIdOf(nextTurn), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
})

test('the wire builder fails without a backfilled identity', async () => {
  const { deviceId: _dropped, ...incomplete } = session()
  await assert.rejects(
    () => buildClaudeWireRequest(options(), incomplete, history(), 32_000, undefined, undefined, 'sess-1', ACCOUNT),
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
