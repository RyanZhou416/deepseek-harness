/**
 * Route-scoped Anthropic prompt-cache policy: the explicit extended-beta
 * opt-in, its independence from the retention tier, and the guarantee that a
 * second pi-ai route and the DeepSeek route stay as they were.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
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
