/**
 * Route-scoped Anthropic prompt-cache policy: the explicit extended-beta
 * opt-in, its independence from the retention tier, the opt-in Claude Code
 * three-marker layout, its pinned field order, and the guarantee that a second
 * pi-ai route and the DeepSeek route stay as they were.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { resolveProfiles } from '../src/config.ts'
import { assemble } from './assemble.ts'
import { memoryAuth } from './auth-double.ts'
import { anthropicTextEvents, closeMockServers, mockServer } from './mock-server.ts'

/** The Anthropic beta a one-hour prompt-cache lifetime declares. */
const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11'

/** The beta that selects a cache scope; no route here declares one. */
const CACHE_SCOPE_BETA = 'prompt-caching-scope-2026-01-05'

const ECHO: ToolSchema = {
  name: 'echo',
  description: 'Echo text back.',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
}

const LOOKUP: ToolSchema = {
  name: 'lookup',
  description: 'Look up a value.',
  parameters: { type: 'object', properties: { key: { type: 'string' } } },
}

const PROBE = {
  model: 'model',
  system: 'You are the cache isolation assistant.',
  tools: [ECHO, LOOKUP],
  messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
  vi.unstubAllEnvs()
})

/**
 * The betas a captured request declares, split from its `anthropic-beta` header.
 * @param headers - one recorded mock-server request's headers.
 * @returns the beta names, empty when the header is absent.
 */
function betasOf(headers: Record<string, string | string[] | undefined>): string[] {
  const header = headers['anthropic-beta']
  if (header === undefined) return []
  const value = Array.isArray(header) ? header.join(',') : header
  return value.split(',').map(beta => beta.trim()).filter(beta => beta.length > 0)
}

/** One `cache_control` value and the JSON path it occupies in the request body. */
type Marker = readonly [path: string, value: unknown]

/**
 * Every `cache_control` marker in a request body, by path.
 * @param body - the captured Anthropic Messages body.
 * @returns the markers sorted by path.
 */
function markersOf(body: Record<string, unknown>): Marker[] {
  const found: Marker[] = []
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => { walk(item, `${path}[${String(index)}]`) })
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'cache_control') found.push([`${path}.cache_control`, child])
      else walk(child, `${path}.${key}`)
    }
  }
  walk(body, '')
  return found.sort(([left], [right]) => left.localeCompare(right))
}

/** A user turn whose content is plain text. */
function userText(text: string) {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

/** An assistant turn whose content is plain text, so a request carries an assistant block. */
function assistantText(text: string, provider: string) {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider, model: 'model' },
  })
}

/** The three-message conversation that gives a request a user and an assistant slot. */
const CONVERSATION = {
  ...PROBE,
  messages: [
    userText('hello'),
    assistantText('hi', 'cache-cc3'),
    userText('continue'),
  ],
}

describe('Anthropic extended cache TTL beta', () => {
  it('declares the beta only on the route that opts in, not from the retention tier', async () => {
    vi.stubEnv('CACHE_POLICY_KEY', 'test-key')
    const [extendedServer, plainServer, noneServer] = await Promise.all([
      mockServer([{ events: anthropicTextEvents }]),
      mockServer([{ events: anthropicTextEvents }]),
      mockServer([{ events: anthropicTextEvents }]),
    ])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'cache-extended': {
          api: 'anthropic-messages',
          baseURL: extendedServer.url,
          apiKeyEnv: 'CACHE_POLICY_KEY',
          cacheRetention: 'long',
          extendedCacheBeta: true,
          models: [{ id: 'model' }],
        },
        // The same one-hour retention without the opt-in: the beta must not be
        // inferred from the retention tier, and the markers stay as before.
        'cache-plain': {
          api: 'anthropic-messages',
          baseURL: plainServer.url,
          apiKeyEnv: 'CACHE_POLICY_KEY',
          cacheRetention: 'long',
          models: [{ id: 'model' }],
        },
        'cache-none': {
          api: 'anthropic-messages',
          baseURL: noneServer.url,
          apiKeyEnv: 'CACHE_POLICY_KEY',
          cacheRetention: 'none',
          models: [{ id: 'model' }],
        },
      },
    })

    await assemble(ctx, { ...PROBE, provider: 'cache-extended' })
    await assemble(ctx, { ...PROBE, provider: 'cache-plain' })
    await assemble(ctx, { ...PROBE, provider: 'cache-none' })

    const extended = extendedServer.requests[0] as Record<string, unknown>
    const plain = plainServer.requests[0] as Record<string, unknown>
    const none = noneServer.requests[0] as Record<string, unknown>

    expect(extendedServer.requests).toHaveLength(1)
    expect(plainServer.requests).toHaveLength(1)
    expect(noneServer.requests).toHaveLength(1)

    // The opted route declares the beta, writes the one-hour value on the two
    // markers it keeps, and adds no scope field.
    expect(betasOf(extendedServer.headers[0] ?? {})).toEqual([EXTENDED_CACHE_TTL_BETA])
    expect(betasOf(extendedServer.headers[0] ?? {})).not.toContain(CACHE_SCOPE_BETA)
    expect(JSON.stringify(extended)).not.toContain('"scope"')
    expect(JSON.stringify(extended).match(/"ttl":"1h"/gu)).toHaveLength(3)

    // The second route keeps its own retention and betas: one-hour markers and
    // no extended beta.
    expect(betasOf(plainServer.headers[0] ?? {})).toEqual([])
    expect(JSON.stringify(plain).match(/"ttl":"1h"/gu)).toHaveLength(3)
    expect(JSON.stringify(plain)).not.toContain('"scope"')

    // A retention of none sends no marker at all and no beta.
    expect(betasOf(noneServer.headers[0] ?? {})).toEqual([])
    expect(JSON.stringify(none)).not.toContain('cache_control')
  })

  it('keeps a payload that already declares the extended beta byte-identical', async () => {
    vi.stubEnv('CACHE_POLICY_KEY', 'test-key')
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'cache-extended': {
          api: 'anthropic-messages',
          baseURL: server.url,
          apiKeyEnv: 'CACHE_POLICY_KEY',
          cacheRetention: 'long',
          extendedCacheBeta: true,
          // The transport derives the request's betas from this header, so the
          // payload already carries the beta the policy would append.
          headers: { 'anthropic-beta': EXTENDED_CACHE_TTL_BETA },
          models: [{ id: 'model' }],
        },
      },
    })

    await assemble(ctx, { ...PROBE, provider: 'cache-extended' })

    // The policy finds its beta and leaves the payload as pi-ai built it: no
    // duplicate member and no second ordering pass.
    expect(betasOf(server.headers[0] ?? {})).toEqual([EXTENDED_CACHE_TTL_BETA])
    expect(JSON.stringify(server.requests[0]).match(/"ttl":"1h"/gu)).toHaveLength(3)
  })

  it('leaves the DeepSeek route without cache_control markers and cache betas', async () => {
    vi.stubEnv('CACHE_POLICY_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_ROUTE_KEY', 'deepseek-key')
    const [anthropicServer, deepseekServer] = await Promise.all([
      mockServer([{ events: anthropicTextEvents }]),
      mockServer([{ events: anthropicTextEvents }]),
    ])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'cache-extended': {
          api: 'anthropic-messages',
          baseURL: anthropicServer.url,
          apiKeyEnv: 'CACHE_POLICY_KEY',
          cacheRetention: 'long',
          extendedCacheBeta: true,
          models: [{ id: 'model' }],
        },
      },
    })
    await ctx.plugin(DeepSeek, {
      baseURL: deepseekServer.url,
      apiKeyEnv: 'DEEPSEEK_ROUTE_KEY',
      models: [{ id: 'deepseek-model' }],
      thinking: 'disabled',
    })

    await assemble(ctx, { ...PROBE, provider: 'cache-extended' })
    await assemble(ctx, {
      ...PROBE,
      provider: 'deepseek-official',
      model: 'deepseek-model',
    })

    expect(anthropicServer.requests).toHaveLength(1)
    expect(deepseekServer.requests).toHaveLength(1)
    expect(betasOf(anthropicServer.headers[0] ?? {})).toEqual([EXTENDED_CACHE_TTL_BETA])

    const deepseek = deepseekServer.requests[0] as Record<string, unknown>
    expect(JSON.stringify(deepseek)).not.toContain('cache_control')
    expect(betasOf(deepseekServer.headers[0] ?? {})).toEqual([])
    expect(JSON.stringify(deepseek)).not.toContain('scope')
  })

  it('refuses the opt-in on a route with no Anthropic Messages model', () => {
    vi.stubEnv('CACHE_POLICY_KEY', 'test-key')
    expect(() => LlmPiAi.resolvePiAiProfiles({
      'openai-route': {
        api: 'openai-completions',
        baseURL: 'https://openai.example',
        apiKeyEnv: 'CACHE_POLICY_KEY',
        extendedCacheBeta: true,
        models: [{ id: 'model' }],
      },
    })).toThrow(/extendedCacheBeta.*anthropic-messages/)
  })
})

/** An assistant turn whose only content is a tool call, so it is a tool-only message. */
function assistantToolCall(provider: string) {
  return createAssistantMessage({
    content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'echo', arguments: '{}' }],
    source: { provider, model: 'model' },
  })
}

/** An assistant turn whose trailing block is reasoning, so it cannot carry a marker. */
function assistantThinking(provider: string) {
  // Replay metadata restores the native thinking signature, so the assistant
  // turn reaches the wire with a trailing thinking block.
  return createAssistantMessage({
    content: [{ type: 'text', text: 'hi' }, { type: 'reasoning', text: 'hmm' }],
    source: {
      provider,
      model: 'model',
      replayState: {
        response: {
          kind: 'pi-ai',
          version: 2,
          api: 'anthropic-messages',
          provider,
          model: 'model',
          stopReason: 'stop',
        },
        blocks: [
          { type: 'text' },
          { type: 'reasoning', thinkingSignature: 'sig' },
        ],
      },
    },
  })
}

/** The pinned Claude Code identity line a `cc3` route forwards. */
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

describe('Anthropic cc3 marker policy', () => {
  it('places the identity block and exactly the three one-hour markers on the route that configures it', async () => {
    vi.stubEnv('CACHE_POLICY_KEY', 'test-key')
    const [cc3Server, plainServer] = await Promise.all([
      mockServer([{ events: anthropicTextEvents }]),
      mockServer([{ events: anthropicTextEvents }]),
    ])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'cache-cc3': {
          api: 'anthropic-messages',
          baseURL: cc3Server.url,
          apiKeyEnv: 'CACHE_POLICY_KEY',
          extendedCacheBeta: true,
          cacheMarkerPolicy: 'cc3',
          models: [{ id: 'model' }],
        },
        // The same conversation without the opt-in keeps pi-ai's own placement.
        'cache-plain': {
          api: 'anthropic-messages',
          baseURL: plainServer.url,
          apiKeyEnv: 'CACHE_POLICY_KEY',
          cacheRetention: 'short',
          models: [{ id: 'model' }],
        },
      },
    })

    await assemble(ctx, { ...CONVERSATION, provider: 'cache-cc3' })
    await assemble(ctx, { ...CONVERSATION, provider: 'cache-plain' })

    const cc3 = cc3Server.requests[0] as Record<string, unknown>
    const plain = plainServer.requests[0] as Record<string, unknown>

    // The system array opens with the byte-exact Claude Code identity line and
    // then the harness prompt; both carry the one-hour marker.
    expect(cc3['system']).toEqual([
      { type: 'text', text: IDENTITY, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: PROBE.system, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ])
    // Exactly three slots: the identity block, the harness system block, and the
    // last user block. The assistant turn before it is not marked, and no tool
    // declaration is marked.
    expect(markersOf(cc3)).toEqual([
      ['.messages[2].content[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[1].cache_control', { type: 'ephemeral', ttl: '1h' }],
    ])
    expect(JSON.stringify(cc3).match(/"cache_control"/gu)).toHaveLength(3)
    const tools = cc3['tools'] as Record<string, unknown>[]
    expect(tools.every(tool => !('cache_control' in tool))).toBe(true)
    expect(JSON.stringify(cc3)).not.toContain('"scope"')
    expect(JSON.stringify(cc3)).not.toContain(CACHE_SCOPE_BETA)
    expect(betasOf(cc3Server.headers[0] ?? {})).toEqual([EXTENDED_CACHE_TTL_BETA])
    expect(betasOf(cc3Server.headers[0] ?? {})).not.toContain(CACHE_SCOPE_BETA)

    // The cc3 route writes the pinned client's top-level key order, with the
    // empty metadata placeholder the pool's user_id splice fills in place, and
    // stream last.
    expect(Object.keys(cc3)).toEqual(['model', 'messages', 'system', 'tools', 'metadata', 'max_tokens', 'stream'])
    expect(cc3['metadata']).toEqual({})

    // The unconfigured route is untouched: pi-ai's own key order, three default
    // markers, no identity block, no one-hour value, no metadata placeholder,
    // and no beta.
    expect(Object.keys(plain)).toEqual(['model', 'messages', 'max_tokens', 'stream', 'system', 'tools'])
    expect(markersOf(plain)).toEqual([
      ['.messages[2].content[0].cache_control', { type: 'ephemeral' }],
      ['.system[0].cache_control', { type: 'ephemeral' }],
      ['.tools[1].cache_control', { type: 'ephemeral' }],
    ])
    expect(JSON.stringify(plain)).not.toContain(IDENTITY)
    expect(JSON.stringify(plain)).not.toContain('"ttl"')
    expect(plain['metadata']).toBeUndefined()
    expect(betasOf(plainServer.headers[0] ?? {})).toEqual([])
  })

  it('keeps a helper request at the default five-minute lifetime without the extended beta', async () => {
    vi.stubEnv('CACHE_POLICY_KEY', 'test-key')
    const server = await mockServer([{ events: anthropicTextEvents }, { events: anthropicTextEvents }])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'cache-cc3': {
          api: 'anthropic-messages',
          baseURL: server.url,
          apiKeyEnv: 'CACHE_POLICY_KEY',
          extendedCacheBeta: true,
          cacheMarkerPolicy: 'cc3',
          models: [{ id: 'model' }],
        },
      },
    })

    await assemble(ctx, { ...PROBE, provider: 'cache-cc3', requestClass: 'main' })
    await assemble(ctx, { ...PROBE, provider: 'cache-cc3', purpose: 'compaction' })

    const main = server.requests[0] as Record<string, unknown>
    const helper = server.requests[1] as Record<string, unknown>

    // The one-hour lifetime belongs to the main request; a helper keeps the
    // API's default five-minute lifetime, so its markers carry no ttl and its
    // request declares no cache beta.
    expect(markersOf(main)).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[1].cache_control', { type: 'ephemeral', ttl: '1h' }],
    ])
    expect(betasOf(server.headers[0] ?? {})).toEqual([EXTENDED_CACHE_TTL_BETA])
    expect(helper['system']).toEqual([
      { type: 'text', text: IDENTITY, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: PROBE.system, cache_control: { type: 'ephemeral' } },
    ])
    expect(markersOf(helper)).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral' }],
      ['.system[0].cache_control', { type: 'ephemeral' }],
      ['.system[1].cache_control', { type: 'ephemeral' }],
    ])
    expect(JSON.stringify(helper)).not.toContain('"ttl"')
    expect(betasOf(server.headers[1] ?? {})).toEqual([])
    // Only the lifetime differs: the helper keeps the pinned field order and
    // the metadata placeholder a pool splice fills.
    expect(Object.keys(helper)).toEqual(Object.keys(main))
    expect(helper['metadata']).toEqual({})
  })

  it('leaves the assistant turn before the last user block unmarked', async () => {
    vi.stubEnv('CACHE_POLICY_KEY', 'test-key')
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'cache-cc3': {
          api: 'anthropic-messages',
          baseURL: server.url,
          apiKeyEnv: 'CACHE_POLICY_KEY',
          cacheMarkerPolicy: 'cc3',
          models: [{ id: 'model' }],
        },
      },
    })

    await assemble(ctx, {
      ...PROBE,
      provider: 'cache-cc3',
      messages: [userText('hello'), assistantToolCall('cache-cc3'), userText('continue')],
    })

    const body = server.requests[0] as Record<string, unknown>
    const messages = body['messages'] as { role: string; content: { type: string }[] }[]
    // The setup is real: the tool call has no result, so the transport follows it
    // with a tool-result user turn, and the assistant turn is a tool-use block
    // and nothing else.
    expect(messages[1]?.content.map(block => block.type)).toEqual(['tool_use'])
    expect(messages[2]?.content.map(block => block.type)).toEqual(['tool_result'])
    // The policy marks only the last user turn, which is the continue prompt;
    // the tool-only messages stay unmarked along with every other earlier turn.
    expect(markersOf(body)).toEqual([
      ['.messages[3].content[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[1].cache_control', { type: 'ephemeral', ttl: '1h' }],
    ])
    expect(JSON.stringify(body).match(/"cache_control"/gu)).toHaveLength(3)
  })

  it('leaves a thinking-tailed assistant turn unmarked', async () => {
    vi.stubEnv('CACHE_POLICY_KEY', 'test-key')
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'cache-cc3': {
          api: 'anthropic-messages',
          baseURL: server.url,
          apiKeyEnv: 'CACHE_POLICY_KEY',
          cacheMarkerPolicy: 'cc3',
          models: [{ id: 'model' }],
        },
      },
    })

    await assemble(ctx, {
      ...PROBE,
      provider: 'cache-cc3',
      messages: [userText('hello'), assistantThinking('cache-cc3'), userText('continue')],
    })

    const body = server.requests[0] as Record<string, unknown>
    const messages = body['messages'] as { role: string; content: { type: string }[] }[]
    // The setup is real: the assistant message ends with the thinking block.
    expect(messages[1]?.content.at(-1)?.type).toBe('thinking')
    // The policy marks only the last user turn, so the thinking-tailed assistant
    // turn stays unmarked; the identity, harness, and continue turn carry the
    // markers.
    expect(markersOf(body)).toEqual([
      ['.messages[2].content[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[1].cache_control', { type: 'ephemeral', ttl: '1h' }],
    ])
    expect(JSON.stringify(body).match(/"cache_control"/gu)).toHaveLength(3)
  })

  it('marks the identity, harness, and last-user slots when the request has a single message', async () => {
    vi.stubEnv('CACHE_POLICY_KEY', 'test-key')
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'cache-cc3': {
          api: 'anthropic-messages',
          baseURL: server.url,
          apiKeyEnv: 'CACHE_POLICY_KEY',
          cacheMarkerPolicy: 'cc3',
          models: [{ id: 'model' }],
        },
      },
    })

    await assemble(ctx, {
      model: 'model',
      system: 'You are the three-marker assistant.',
      messages: [userText('hello')],
      provider: 'cache-cc3',
    })

    const body = server.requests[0] as Record<string, unknown>
    expect(body['system']).toEqual([
      { type: 'text', text: IDENTITY, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'You are the three-marker assistant.', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ])
    // One message still carries the identity, harness, and last-user slots, and
    // no tool was sent.
    expect(markersOf(body)).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[1].cache_control', { type: 'ephemeral', ttl: '1h' }],
    ])
    expect(JSON.stringify(body).match(/"cache_control"/gu)).toHaveLength(3)
    expect(body['tools']).toBeUndefined()
  })

  it('marks the identity and last-user slots when the request has no system prompt', async () => {
    vi.stubEnv('CACHE_POLICY_KEY', 'test-key')
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'cache-cc3': {
          api: 'anthropic-messages',
          baseURL: server.url,
          apiKeyEnv: 'CACHE_POLICY_KEY',
          cacheMarkerPolicy: 'cc3',
          models: [{ id: 'model' }],
        },
      },
    })

    await assemble(ctx, {
      model: 'model',
      messages: [userText('hello'), assistantText('hi', 'cache-cc3'), userText('continue')],
      provider: 'cache-cc3',
    })

    const body = server.requests[0] as Record<string, unknown>
    // The identity block is the only system block, so it is the whole system
    // slot; the last user turn is the message slot.
    expect(body['system']).toEqual([
      { type: 'text', text: IDENTITY, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ])
    expect(markersOf(body)).toEqual([
      ['.messages[2].content[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
    ])
    expect(JSON.stringify(body).match(/"cache_control"/gu)).toHaveLength(2)
  })

  it('drops a caller system block equal to the pinned identity line', async () => {
    vi.stubEnv('CACHE_POLICY_KEY', 'test-key')
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'cache-cc3': {
          api: 'anthropic-messages',
          baseURL: server.url,
          apiKeyEnv: 'CACHE_POLICY_KEY',
          cacheMarkerPolicy: 'cc3',
          models: [{ id: 'model' }],
        },
      },
    })

    await assemble(ctx, {
      model: 'model',
      system: IDENTITY,
      messages: [userText('hello')],
      provider: 'cache-cc3',
    })

    const body = server.requests[0] as Record<string, unknown>
    // The caller's block is the pinned line, which the policy emits itself; the
    // duplicate is dropped rather than sent as a second system block.
    expect(body['system']).toEqual([
      { type: 'text', text: IDENTITY, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ])
    expect(markersOf(body)).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
    ])
    expect(JSON.stringify(body).match(/"cache_control"/gu)).toHaveLength(2)
  })

  it('leaves another Anthropic route and the DeepSeek route unchanged', async () => {
    vi.stubEnv('CACHE_POLICY_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_ROUTE_KEY', 'deepseek-key')
    const [cc3Server, plainServer, deepseekServer] = await Promise.all([
      mockServer([{ events: anthropicTextEvents }]),
      mockServer([{ events: anthropicTextEvents }]),
      mockServer([{ events: anthropicTextEvents }]),
    ])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'cache-cc3': {
          api: 'anthropic-messages',
          baseURL: cc3Server.url,
          apiKeyEnv: 'CACHE_POLICY_KEY',
          cacheMarkerPolicy: 'cc3',
          models: [{ id: 'model' }],
        },
        'cache-plain': {
          api: 'anthropic-messages',
          baseURL: plainServer.url,
          apiKeyEnv: 'CACHE_POLICY_KEY',
          cacheRetention: 'short',
          models: [{ id: 'model' }],
        },
      },
    })
    await ctx.plugin(DeepSeek, {
      baseURL: deepseekServer.url,
      apiKeyEnv: 'DEEPSEEK_ROUTE_KEY',
      models: [{ id: 'deepseek-model' }],
      thinking: 'disabled',
    })

    await assemble(ctx, { ...PROBE, provider: 'cache-cc3' })
    await assemble(ctx, { ...PROBE, provider: 'cache-plain' })
    await assemble(ctx, { ...PROBE, provider: 'deepseek-official', model: 'deepseek-model' })

    // The cc3 route marks the three slots this request has, while the other
    // routes keep their own placement and declare no beta.
    expect(markersOf(cc3Server.requests[0] as Record<string, unknown>)).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[1].cache_control', { type: 'ephemeral', ttl: '1h' }],
    ])
    expect(markersOf(plainServer.requests[0] as Record<string, unknown>)).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral' }],
      ['.system[0].cache_control', { type: 'ephemeral' }],
      ['.tools[1].cache_control', { type: 'ephemeral' }],
    ])
    const deepseek = deepseekServer.requests[0] as Record<string, unknown>
    expect(JSON.stringify(deepseek)).not.toContain('cache_control')
    expect(JSON.stringify(deepseek)).not.toContain(IDENTITY)
    expect(betasOf(deepseekServer.headers[0] ?? {})).toEqual([])
  })

  it('refuses cc3 on a route with no Anthropic Messages model', () => {
    vi.stubEnv('CACHE_POLICY_KEY', 'test-key')
    expect(() => LlmPiAi.resolvePiAiProfiles({
      'openai-route': {
        api: 'openai-completions',
        baseURL: 'https://openai.example',
        apiKeyEnv: 'CACHE_POLICY_KEY',
        cacheMarkerPolicy: 'cc3',
        models: [{ id: 'model' }],
      },
    })).toThrow(/cacheMarkerPolicy.*anthropic-messages/)
  })
})

/** The stable and session-specific prompt text a parity A boundary splits. */
const WIRE_PARITY_SECTIONS = [
  { name: 'app:instructions', text: 'Stable route instructions.', stable: true },
  { name: 'session:state', text: 'Current session state.', stable: false },
]

/** A main-class request whose sections state the boundary the adapter sends. */
const WIRE_PARITY_PROBE = {
  ...PROBE,
  system: WIRE_PARITY_SECTIONS.map(section => section.text).join('\n\n'),
  systemSections: WIRE_PARITY_SECTIONS,
  requestClass: 'main' as const,
}

describe('CC wire parity cache intent', () => {
  it('declares the route cache intent in the headers and sends one A body', async () => {
    const [mainServer, offServer] = await Promise.all([
      mockServer([{ events: anthropicTextEvents }]),
      // The off route answers its main request and its helper request.
      mockServer([{ events: anthropicTextEvents }, { events: anthropicTextEvents }]),
    ])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    // The wire is reachable only through a capability proof, which the generic
    // plugin's loader configuration cannot supply. This composition stands in
    // for the fixed-route plugin that probed these two endpoints, so the body
    // and headers still go through the shipped adapter.
    const proofOf = (url: string) => ({ endpoint: `${url}/v1/capabilities`, buildId: 'test-build' })
    const profiles = resolveProfiles({
      'parity-main': {
        api: 'anthropic-messages',
        baseURL: mainServer.url,
        ccWireParity: true,
        models: [{ id: 'model' }],
      },
      'parity-off': {
        api: 'anthropic-messages',
        baseURL: offServer.url,
        ccWireParity: true,
        ccWireParityCache: 'off',
        // The route also declares the extended beta; an A request must send
        // no cache beta even so.
        extendedCacheBeta: true,
        models: [{ id: 'model' }],
      },
    }, 'strict', new Map([
      ['parity-main', proofOf(mainServer.url)],
      ['parity-off', proofOf(offServer.url)],
    ]))
    ctx.llm.registerAdapter(['parity-main', 'parity-off'], new LlmPiAi.PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => 'test-key',
      auth: memoryAuth(),
    }))

    await assemble(ctx, { ...WIRE_PARITY_PROBE, provider: 'parity-main' })
    await assemble(ctx, { ...WIRE_PARITY_PROBE, provider: 'parity-off' })
    await assemble(ctx, { ...PROBE, provider: 'parity-off', purpose: 'compaction' })

    const main = mainServer.requests[0] as Record<string, unknown>
    const off = offServer.requests[0] as Record<string, unknown>
    const helper = offServer.requests[1] as Record<string, unknown>

    // The class and layout are the same either way; the cache intent is the one
    // decision the route's profile makes.
    expect(mainServer.headers[0]?.['x-cc-request-class']).toBe('main')
    expect(mainServer.headers[0]?.['x-cc-system-layout']).toBe('boundary:1')
    expect(mainServer.headers[0]?.['x-cc-cache-intent']).toBe('main')
    expect(offServer.headers[0]?.['x-cc-request-class']).toBe('main')
    expect(offServer.headers[0]?.['x-cc-system-layout']).toBe('boundary:1')
    expect(offServer.headers[0]?.['x-cc-cache-intent']).toBe('off')

    // `off` withholds the worker's cache plan only: the member body is the same
    // body, with no marker, no TTL, and no cache beta on either route.
    expect(off).toEqual(main)
    expect(off['system']).toEqual([
      { type: 'text', text: IDENTITY },
      { type: 'text', text: 'Stable route instructions.' },
      { type: 'text', text: 'Current session state.' },
    ])
    expect(markersOf(off)).toEqual([])
    expect(JSON.stringify(off)).not.toContain('"ttl"')
    // No cache beta survives, including the extended beta this route declares.
    const offBetas = betasOf(offServer.headers[0] ?? {})
    expect(offBetas).not.toContain(EXTENDED_CACHE_TTL_BETA)
    expect(offBetas).not.toContain(CACHE_SCOPE_BETA)
    expect(offBetas.filter(beta => beta.startsWith('cache-diagnosis-'))).toEqual([])
    // The pinned field order keeps the pool's `metadata` splice slot.
    expect(off['metadata']).toEqual({})

    // A helper keeps its own intent and its caller's system; helpers are
    // marker-free in both route modes.
    expect(offServer.headers[1]?.['x-cc-request-class']).toBe('compaction')
    expect(offServer.headers[1]?.['x-cc-system-layout']).toBe('none')
    expect(offServer.headers[1]?.['x-cc-cache-intent']).toBe('helper')
    expect(markersOf(helper)).toEqual([])
    expect(JSON.stringify(helper)).not.toContain('"ttl"')
    // The pool splices `metadata.user_id` into every forwarded request, helpers
    // included, so the canonical slot is part of the helper body too.
    expect(helper['metadata']).toEqual({})
  })
})

describe('CC wire parity body', () => {
  it('declares a subagent request and expands only its final user text turn', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    const profiles = resolveProfiles({
      'parity-main': {
        api: 'anthropic-messages',
        baseURL: server.url,
        ccWireParity: true,
        models: [{ id: 'model' }],
      },
    }, 'strict', new Map([['parity-main', { endpoint: `${server.url}/v1/capabilities`, buildId: 'test-build' }]]))
    ctx.llm.registerAdapter(['parity-main'], new LlmPiAi.PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => 'test-key',
      auth: memoryAuth(),
    }))

    await assemble(ctx, {
      ...WIRE_PARITY_PROBE,
      provider: 'parity-main',
      requestClass: 'subagent',
      messages: [
        userText('first turn'),
        assistantText('hi', 'parity-main'),
        userText('last turn'),
      ],
    })

    const headers = server.headers[0] ?? {}
    const body = server.requests[0] as Record<string, unknown>
    expect(headers['x-cc-request-class']).toBe('subagent')
    expect(headers['x-cc-system-layout']).toBe('boundary:1')
    expect(headers['x-cc-cache-intent']).toBe('main')
    expect(body['system']).toEqual([
      { type: 'text', text: IDENTITY },
      { type: 'text', text: 'Stable route instructions.' },
      { type: 'text', text: 'Current session state.' },
    ])
    // The pinned client wraps a string user message only for the message that
    // carries the cache marker, so earlier text-only turns stay bare strings.
    const messages = body['messages'] as Record<string, unknown>[]
    expect(messages[0]?.['content']).toBe('first turn')
    expect(messages[1]?.['content']).toEqual([{ type: 'text', text: 'hi' }])
    expect(messages[2]?.['content']).toEqual([{ type: 'text', text: 'last turn' }])
    expect(markersOf(body)).toEqual([])
  })

  it('forwards a helper without a system prompt and without a boundary', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    const profiles = resolveProfiles({
      'parity-main': {
        api: 'anthropic-messages',
        baseURL: server.url,
        ccWireParity: true,
        models: [{ id: 'model' }],
      },
    }, 'strict', new Map([['parity-main', { endpoint: `${server.url}/v1/capabilities`, buildId: 'test-build' }]]))
    ctx.llm.registerAdapter(['parity-main'], new LlmPiAi.PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => 'test-key',
      auth: memoryAuth(),
    }))

    await assemble(ctx, {
      model: 'model',
      provider: 'parity-main',
      purpose: 'compaction',
      messages: [userText('compact this')],
    })

    const headers = server.headers[0] ?? {}
    const body = server.requests[0] as Record<string, unknown>
    expect(headers['x-cc-request-class']).toBe('compaction')
    expect(headers['x-cc-system-layout']).toBe('none')
    expect(headers['x-cc-cache-intent']).toBe('helper')
    // The helper carries the caller's (absent) system untouched: no identity
    // block replaces a prompt it does not have.
    expect(body['system']).toBeUndefined()
    expect(markersOf(body)).toEqual([])
  })
})
