/**
 * The Claude engine's request side: a raw Anthropic DTO becomes one wire request built by the
 * maintained compat package, under a caller-supplied identity. No harness, no environment, no
 * network: every case is synthetic.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildClaudeEngineRequest, validateAnthropicBody } from '../src/claude-engine/request.js'
import type { ClaudeEngineIdentity } from '../src/claude-engine/types.js'

/** A complete identity, as a Mac caller would state it. */
function identity(overrides: Partial<ClaudeEngineIdentity> = {}): ClaudeEngineIdentity {
  return {
    accountUuid: '00000000-0000-4000-8000-000000000001',
    deviceUuid: 'b'.repeat(64),
    sessionUuid: '11111111-1111-4111-8111-111111111111',
    os: 'darwin',
    arch: 'arm64',
    runtime: 'node',
    runtimeVersion: 'v22.19.0',
    ...overrides,
  }
}

/** The V1 conversation vocabulary, as a caller's body states it. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    stream: true,
    system: [{ type: 'text', text: 'You are a coding agent.' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'working' },
          { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.ts' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    ],
    tools: [{ name: 'read', description: 'read a file', input_schema: { type: 'object', properties: {} } }],
    thinking: { type: 'enabled', budget_tokens: 2048 },
    temperature: 0.2,
    stop_sequences: ['STOP'],
    metadata: { note: 'synthetic' },
    ...overrides,
  }
}

test('a supported DTO builds one wire request under the caller identity', async () => {
  const built = await buildClaudeEngineRequest({
    body: body(),
    accessToken: 'at-synthetic',
    identity: identity(),
    clientRequestId: 'client-request-1',
  })
  assert.ok(built.ok, JSON.stringify(built))
  const request = built.request
  assert.equal(request.method, 'POST')
  assert.match(request.url, /\/v1\/messages\?beta=true$/)
  const headers = new Map(request.headers.map(([name, value]) => [name.toLowerCase(), value]))
  assert.equal(headers.get('authorization'), 'Bearer at-synthetic', 'the caller credential is sent as given')
  // The maintained package owns which client version it claims; the engine neither overrides nor
  // restates it.
  // The pinned 2.1.288 profile is passed to the builder explicitly, so the request a Mac caller
  // sends is the profile this engine reports rather than the package's own default release.
  assert.match(headers.get('user-agent') ?? '', /2\.1\.288/, 'the pinned profile is the one built')
  assert.equal(request.evidence.profileId, 'claude-code-2.1.288-sdk-0.128.0')
  const payload = JSON.parse(request.body) as Record<string, unknown>
  assert.equal(payload['model'], 'claude-opus-4-5')
  assert.equal(payload['max_tokens'], 1024)
  assert.equal(payload['stream'], true)
  // The identity is the caller's, and the request is built for the platform it stated: the
  // caller's darwin identity is presented as the pin's macOS runtime, with no Windows default.
  const runtime = JSON.parse(String((payload['metadata'] as Record<string, unknown>)['user_id'] ?? '{}')) as Record<string, unknown>
  assert.equal(runtime['account_uuid'], identity().accountUuid)
  assert.equal(runtime['device_id'], identity().deviceUuid)
  assert.equal(runtime['session_id'], identity().sessionUuid)
  // Evidence carries the shape of what was sent and never a secret.
  assert.deepEqual(request.evidence.headerNames, request.headers.map(([name]) => name.toLowerCase()))
  assert.ok(!JSON.stringify(request.evidence).includes('at-synthetic'), 'evidence never carries the token')
  assert.equal(request.evidence.bodySha256.length, 64)
})

test('a tool choice and a continuation chain reach the wire instead of being dropped', async () => {
  // The pinned builder composes tool_choice itself, so the one directive it can express is the
  // default; any other is refused rather than replaced with a value the caller did not ask for.
  const withChoice = await buildClaudeEngineRequest({
    body: body({ tool_choice: { type: 'tool', name: 'read' } }),
    accessToken: 'at-synthetic',
    identity: identity(),
    clientRequestId: 'client-request-1',
  })
  assert.equal(withChoice.ok, false, 'an inexpressible tool choice is not silently replaced')
  assert.equal(withChoice.ok === false ? withChoice.failure.kind : undefined, 'unsupported')
  const defaultChoice = await buildClaudeEngineRequest({
    body: body({ tool_choice: { type: 'auto' } }),
    accessToken: 'at-synthetic',
    identity: identity(),
    clientRequestId: 'client-request-1',
  })
  assert.ok(defaultChoice.ok)
  assert.deepEqual(
    (JSON.parse(defaultChoice.request.body) as Record<string, unknown>)['tool_choice'],
    { type: 'auto' },
    'the expressible default reaches the wire',
  )
})

test('the selected continuation reaches the billing text, not a body field', async () => {
  const build = async (chain?: { previousRequestId?: string; atis?: string }) => {
    const built = await buildClaudeEngineRequest({
      body: body(), accessToken: 'at-synthetic', identity: identity(), clientRequestId: 'client-request-1',
      ...chain === undefined ? {} : { chain },
    })
    assert.ok(built.ok, JSON.stringify(built))
    const payload = JSON.parse(built.request.body) as Record<string, unknown>
    const headers = new Map(built.request.headers.map(([name, value]) => [name.toLowerCase(), value]))
    const systemText = (payload['system'] as readonly { text?: string }[]).map(block => block.text ?? '').join('\n')
    return { payload, headers, systemText }
  }

  const chained = await build({ previousRequestId: 'req_synthetic1' })
  assert.ok(
    chained.systemText.includes('cc_prev_req=req_synthetic1'),
    'the continuation is spliced into the billing text',
  )
  assert.equal(
    Object.hasOwn(chained.payload, 'previous_request_id'),
    false,
    'the continuation is never an independent body field',
  )

  // The id grammar the client emits, and only that.
  for (const invalid of ['synthetic1', 'req_', 'req_bad.dot', `req_${'a'.repeat(37)}`, 'req_bad\nvalue', 'req_ok\r\nX-Evil: 1']) {
    const refused = await buildClaudeEngineRequest({
      body: body(), accessToken: 'at-synthetic', identity: identity(), clientRequestId: 'client-request-1',
      chain: { previousRequestId: invalid },
    })
    assert.equal(refused.ok, false, invalid)
    assert.equal(refused.ok === false ? refused.failure.kind : undefined, 'invalid-request', invalid)
    assert.equal(
      refused.ok === false && refused.failure.kind === 'invalid-request' ? refused.failure.field : undefined,
      'chain.previousRequestId',
    )
  }
})

test('the ATIS pin is forwarded verbatim, omitted when absent or empty, and never sanitized', async () => {
  const build = async (chain: { previousRequestId?: string; atis?: string }) => {
    const built = await buildClaudeEngineRequest({
      body: body(), accessToken: 'at-synthetic', identity: identity(), clientRequestId: 'client-request-1', chain,
    })
    assert.ok(built.ok, JSON.stringify(built))
    const headers = new Map(built.request.headers.map(([name, value]) => [name.toLowerCase(), value]))
    return headers
  }

  const pinned = await build({ atis: 'synthetic-atis' })
  assert.equal(pinned.get('x-cc-atis'), 'synthetic-atis', 'the value travels exactly as the caller selected it')

  // An explicit empty pin is the client's frozen no-header state: no header, and no invented value.
  const empty = await build({ atis: '' })
  assert.equal(empty.has('x-cc-atis'), false, 'an empty pin produces no header')
  const absent = await build({})
  assert.equal(absent.has('x-cc-atis'), false, 'an absent pin produces no header')

  // Anything that could restructure or terminate the header line is refused before any build.
  for (const invalid of ['atis value', 'atis\ttab', 'atis\r\nX-Evil: 1', `atis\u0000nul`, `at\u00efs-non-ascii`]) {
    const refused = await buildClaudeEngineRequest({
      body: body(), accessToken: 'at-synthetic', identity: identity(), clientRequestId: 'client-request-1',
      chain: { atis: invalid },
    })
    assert.equal(refused.ok, false, JSON.stringify(invalid))
    assert.equal(refused.ok === false ? refused.failure.kind : undefined, 'invalid-request', JSON.stringify(invalid))
  }
})

test('both continuation members travel together without a header the caller never chose', async () => {
  const built = await buildClaudeEngineRequest({
    body: body(), accessToken: 'at-synthetic', identity: identity(), clientRequestId: 'client-request-1',
    chain: { previousRequestId: 'req_both1', atis: 'synthetic-atis' },
  })
  assert.ok(built.ok, JSON.stringify(built))
  const payload = JSON.parse(built.request.body) as Record<string, unknown>
  const headers = new Map(built.request.headers.map(([name, value]) => [name.toLowerCase(), value]))
  const systemText = (payload['system'] as readonly { text?: string }[]).map(block => block.text ?? '').join('\n')
  assert.ok(systemText.includes('cc_prev_req=req_both1'))
  assert.equal(headers.get('x-cc-atis'), 'synthetic-atis')
  assert.equal(Object.hasOwn(payload, 'previous_request_id'), false)
  // The raw DTO carries no header seam at all: a caller cannot inject one through the body.
  const injected = await buildClaudeEngineRequest({
    body: body({ extra_headers: [['x-cc-atis', 'forged']], headers: { authorization: 'Bearer forged' } }),
    accessToken: 'at-synthetic', identity: identity(), clientRequestId: 'client-request-1',
  })
  assert.equal(injected.ok, false, 'a body-supplied header field is not a seam')
  assert.equal(injected.ok === false ? injected.failure.kind : undefined, 'invalid-request')
})

test('external URLs and foreign files are refused, and a proved upload is built', async () => {
  const build = (bodyOverride: Record<string, unknown>, files?: { ownsFile: (id: string) => boolean }) =>
    buildClaudeEngineRequest({
      body: body(bodyOverride),
      accessToken: 'at-synthetic',
      identity: identity(),
      clientRequestId: 'client-request-1',
      ...files === undefined ? {} : { files },
    })

  // An arbitrary external URL is not this engine's to fetch: typed unsupported, and no request is
  // built for the caller to send.
  const externalUrl = await build({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }] }],
  })
  assert.equal(externalUrl.ok, false)
  assert.equal(externalUrl.ok === false ? externalUrl.failure.kind : undefined, 'unsupported')
  assert.match(
    String(externalUrl.ok === false && externalUrl.failure.kind === 'unsupported' ? externalUrl.failure.feature : ''),
    /source\.url$/,
  )

  // A file id with no proof of ownership is refused rather than attributed to this account.
  const foreignFile = await build({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'file-foreign' } }] }],
  })
  assert.equal(foreignFile.ok, false)
  assert.equal(foreignFile.ok === false ? foreignFile.failure.kind : undefined, 'unsupported')

  // The same body with an explicit proof that this pool uploaded that id is buildable.
  const ownedFile = await build(
    { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'file-owned' } }] }] },
    { ownsFile: (id: string) => id === 'file-owned' },
  )
  assert.ok(ownedFile.ok, JSON.stringify(ownedFile))
  assert.ok(ownedFile.request.body.includes('file-owned'))

  // A proof that does not cover this id is not a proof.
  const unproved = await build(
    { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'file-other' } }] }] },
    { ownsFile: (id: string) => id === 'file-owned' },
  )
  assert.equal(unproved.ok, false)
  assert.equal(unproved.ok === false ? unproved.failure.kind : undefined, 'unsupported')
})

test('a tool result carries only validated text and inline images, bounded by depth and size', async () => {
  const build = (content: unknown) =>
    buildClaudeEngineRequest({
      // The result answers a call the assistant made, as the wire requires.
      body: body({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'read it' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.ts' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] },
        ],
      }),
      accessToken: 'at-synthetic',
      identity: identity(),
      clientRequestId: 'client-request-1',
    })

  // A legal raw result is preserved as the caller wrote it.
  const legal = await build([
    { type: 'text', text: 'ok' },
    { type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } },
  ])
  assert.ok(legal.ok, JSON.stringify(legal))
  assert.ok(legal.request.body.includes('"tool_result"'))

  // A number or a boolean is not content this engine forwards, and it is refused before a build.
  for (const [label, content] of [
    ['number', 42],
    ['boolean', true],
    ['null member', [null]],
    ['object member', [{ type: 'json', value: 1 }]],
    ['unknown block', [{ type: 'document', source: {} }]],
    ['external url member', [{ type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }]],
  ] as const) {
    const refused = await build(content)
    assert.equal(refused.ok, false, label)
    assert.ok(
      refused.ok === false && (refused.failure.kind === 'invalid-request' || refused.failure.kind === 'unsupported'),
      label,
    )
  }

  // Deeper than the limit, and larger than the budget, are both refused.
  let deep: unknown = { type: 'text', text: 'x' }
  for (let level = 0; level < 12; level++) deep = [deep]
  const tooDeep = await build(deep)
  assert.equal(tooDeep.ok, false)
  assert.equal(tooDeep.ok === false ? tooDeep.failure.kind : undefined, 'invalid-request')

  const tooLarge = await build('x'.repeat(1_048_577))
  assert.equal(tooLarge.ok, false)
  assert.equal(tooLarge.ok === false ? tooLarge.failure.kind : undefined, 'invalid-request')
})

test('nested content and tool members are validated rather than cast through', () => {
  const cases: readonly (readonly [string, unknown, string])[] = [
    ['image source', body({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'x' } }] }] }), 'invalid-request'],
    ['unknown block', body({ messages: [{ role: 'user', content: [{ type: 'document', source: {} }] }] }), 'unsupported'],
    ['tool_use id', body({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1' }] }] }), 'invalid-request'],
    ['tool_result id', body({ messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }] }), 'invalid-request'],
    ['tool name', body({ tools: [{ description: 'no name', input_schema: {} }] }), 'invalid-request'],
    ['tool choice', body({ tool_choice: { type: 'tool' } }), 'invalid-request'],
  ]
  for (const [label, payload, kind] of cases) {
    const result = validateAnthropicBody(payload)
    assert.equal(result.ok, false, label)
    assert.equal(result.ok === false ? result.failure.kind : undefined, kind, label)
  }
  // A plain string system prompt is normalized into the block form the builder takes.
  const stringSystem = validateAnthropicBody(body({ system: 'plain prompt' }))
  assert.equal(stringSystem.ok, true)
  assert.deepEqual(stringSystem.ok ? stringSystem.body.system : undefined, [{ type: 'text', text: 'plain prompt' }])
})

test('a HIPAA policy withholds the mid-conversation betas without touching content', async () => {
  const model = 'claude-sonnet-5-5'
  const build = (policy: { suppressMidConversationSystem?: boolean } | undefined, extra: Record<string, unknown> = {}) =>
    buildClaudeEngineRequest({
      body: body({ model, ...extra }),
      accessToken: 'at-synthetic',
      identity: identity(),
      clientRequestId: 'client-request-1',
      ...policy === undefined ? {} : { policy },
    })
  const surface = (request: { headers: readonly (readonly [string, string])[]; body: string }): string =>
    request.headers.map(([name, value]) => name + ': ' + value).join('\n') + '\n' + request.body

  // The capability beta is part of an ordinary build for this model.
  const ordinary = await build(undefined)
  assert.ok(ordinary.ok, JSON.stringify(ordinary))
  const ordinarySurface = surface(ordinary.request)
  assert.ok(
    ordinarySurface.includes('mid-conversation-system-2026-04-07'),
    'a capable model carries the main beta without a policy',
  )

  // The taint comes from the policy, not from a top-level system prompt: this body states one and
  // the beta is still there.
  assert.ok(ordinarySurface.includes('You are a coding agent.'), 'the top-level system block is present')

  const suppressed = await build({ suppressMidConversationSystem: true })
  assert.ok(suppressed.ok, JSON.stringify(suppressed))
  const suppressedSurface = surface(suppressed.request)
  for (const beta of [
    'mid-conversation-system-2026-04-07',
    'mid-conversation-tool-changes-2026-07-01',
    'mid-conversation-system-clear-at-2026-08-21',
  ]) {
    assert.equal(suppressedSurface.includes(beta), false, beta)
  }
  // Everything else the profile binds is still there, and the content is untouched.
  assert.match(suppressedSurface, /oauth-/, 'other betas are unaffected')
  const before = JSON.parse(ordinary.request.body) as Record<string, unknown>
  const after = JSON.parse(suppressed.request.body) as Record<string, unknown>
  assert.deepEqual(after['messages'], before['messages'], 'no message is dropped or rewritten')
  const texts = (payload: Record<string, unknown>): readonly string[] =>
    (payload['system'] as readonly { text?: string }[]).map(block => block.text ?? '')
  assert.equal(
    texts(after).filter(text => text.includes('You are a coding agent.')).length,
    1,
    'the user\'s system text survives exactly once',
  )
  assert.ok(texts(after).length === texts(before).length, 'no system block is dropped')

  // A role system message stays a V1 refusal: it is never silently flattened into the top level.
  const roleSystem = await build({ suppressMidConversationSystem: true }, {
    messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  assert.equal(roleSystem.ok, false)
  assert.equal(roleSystem.ok === false ? roleSystem.failure.kind : undefined, 'invalid-request')

  // The policy is not a body field: a DTO that tries to state it has no seam.
  const bodyStated = await buildClaudeEngineRequest({
    body: body({ model, suppressBetas: ['mid-conversation-system-2026-04-07'] }),
    accessToken: 'at-synthetic',
    identity: identity(),
    clientRequestId: 'client-request-1',
  })
  assert.equal(bodyStated.ok, false, 'the raw DTO cannot suppress betas')
  assert.equal(bodyStated.ok === false ? bodyStated.failure.kind : undefined, 'invalid-request')
})

test('an unknown or unsupported body field is refused by name, never dropped', () => {
  const unknown = validateAnthropicBody(body({ something_new: 1 }))
  assert.equal(unknown.ok, false)
  assert.equal(unknown.ok === false ? unknown.failure.kind : undefined, 'invalid-request')
  assert.equal(unknown.ok === false && unknown.failure.kind === 'invalid-request' ? unknown.failure.field : undefined, 'something_new')

  const unsupported = validateAnthropicBody(body({ mcp_servers: [] }))
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.ok === false ? unsupported.failure.kind : undefined, 'unsupported')
})

test('a non-streaming V1 request is refused explicitly', () => {
  const refusal = validateAnthropicBody(body({ stream: false }))
  assert.equal(refusal.ok, false)
  assert.equal(refusal.ok === false ? refusal.failure.kind : undefined, 'unsupported')
  assert.equal(refusal.ok === false && refusal.failure.kind === 'unsupported' ? refusal.failure.feature : undefined, 'stream')
})

test('malformed core fields are refused with their own name', () => {
  for (const [field, payload] of [
    ['model', body({ model: '' })],
    ['max_tokens', body({ max_tokens: 0 })],
    ['messages', body({ messages: [] })],
    ['messages[0].role', body({ messages: [{ role: 'system', content: 'x' }] })],
    ['thinking.type', body({ thinking: { type: 'sometimes' } })],
    ['temperature', body({ temperature: 'hot' })],
  ] as const) {
    const result = validateAnthropicBody(payload)
    assert.equal(result.ok, false, field)
    assert.equal(result.ok === false && result.failure.kind === 'invalid-request' ? result.failure.field : undefined, field)
  }
})

test('a caller identity that cannot be stated completely is refused before any build', async () => {
  for (const [field, overrides] of [
    ['accountUuid', { accountUuid: '' }],
    ['deviceUuid', { deviceUuid: '' }],
    ['sessionUuid', { sessionUuid: '' }],
    ['arch', { arch: '' }],
    ['runtimeVersion', { runtimeVersion: '' }],
    ['os', { os: 'plan9' as unknown as ClaudeEngineIdentity['os'] }],
  ] as const) {
    const built = await buildClaudeEngineRequest({
      body: body(),
      accessToken: 'at-synthetic',
      identity: identity(overrides),
      clientRequestId: 'client-request-1',
    })
    assert.equal(built.ok, false, field)
    assert.equal(built.ok === false ? built.failure.kind : undefined, 'incoherent-profile', field)
  }
  const noToken = await buildClaudeEngineRequest({
    body: body(),
    accessToken: '',
    identity: identity(),
    clientRequestId: 'client-request-1',
  })
  assert.equal(noToken.ok, false)
  assert.equal(noToken.ok === false ? noToken.failure.kind : undefined, 'incoherent-profile')
})
