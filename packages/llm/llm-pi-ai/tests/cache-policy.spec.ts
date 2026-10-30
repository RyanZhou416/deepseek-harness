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
import { assemble } from './assemble.ts'
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
