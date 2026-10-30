/**
 * Prompt-cache policy: the route's default three-marker one-hour layout, the
 * identity block it forwards, its exact placement and field order, the loud
 * refusal of impossible combinations at load, and the guarantee that no other
 * provider route changes.
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { CAPABILITIES_URL } from '../src/discovery.ts'
import * as CcPool from '../src/index.ts'
import { PROVIDER, resolvePoolProfiles } from '../src/pool.ts'
import { anthropicSuccessResponse, assemble, capturePoolFetch, user } from './harness.ts'
import type { CapturedRequest } from './harness.ts'

/** The Anthropic beta a one-hour prompt-cache lifetime declares. */
const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11'

/** The beta that selects a cache scope; this route never declares one. */
const CACHE_SCOPE_BETA = 'prompt-caching-scope-2026-01-05'

/** The pinned Claude Code identity line the route forwards ahead of the harness prompt. */
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/**
 * Mount the real LLM service and the pool plugin under test, with the durable
 * sink off so a case writes nothing below the ambient harness home.
 * @param config - loader configuration for the plugin.
 * @returns the isolated context.
 */
async function mount(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CcPool, { requestLog: { enabled: false }, ...config })
  return ctx
}

/** One tool declaration, so the body carries the tool-list marker. */
const ECHO: ToolSchema = {
  name: 'echo',
  description: 'Echo text back.',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
}

/** A second tool declaration, so the marker has a last entry to sit on. */
const LOOKUP: ToolSchema = {
  name: 'lookup',
  description: 'Look up a value.',
  parameters: { type: 'object', properties: { key: { type: 'string' } } },
}

/**
 * The request every case sends: a system prompt, two tools, and one user turn,
 * the three slots a request without an assistant turn has.
 */
const PROBE = {
  model: 'claude-sonnet-5-5',
  system: 'You are the pool test assistant.',
  tools: [ECHO, LOOKUP],
  messages: [user('hello')],
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

/**
 * The betas a captured request declares, split from its `anthropic-beta` header.
 * @param request - the captured request.
 * @returns the declared beta names, empty when the header is absent.
 */
function betasOf(request: CapturedRequest): string[] {
  const header = request.headers.get('anthropic-beta')
  return header === null ? [] : header.split(',').map(beta => beta.trim()).filter(beta => beta.length > 0)
}

/**
 * Send the probe through a fresh mount and return the captured request.
 *
 * The fetch stand-in is installed before mount because a route configured for
 * wire parity probes the capability endpoint at load; the captured model request
 * is the first request that is not that probe.
 * @param config - loader configuration for the pool plugin.
 * @param options - request fields overriding the default probe.
 * @param respond - produces the response for one recorded request; defaults to
 *   the minimal success SSE.
 * @returns the request the pool route built.
 */
async function probe(
  config: Record<string, unknown> = {},
  options: Partial<typeof PROBE> = {},
  respond?: (request: CapturedRequest) => Response,
): Promise<CapturedRequest> {
  vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
  const capture = capturePoolFetch(respond)
  vi.stubGlobal('fetch', capture.fetch)
  const ctx = await mount(config)
  await assemble(ctx, { ...PROBE, ...options })
  const call = capture.calls.find(request => request.url !== CAPABILITIES_URL)
  if (call === undefined) throw new Error('the pool route sent no request')
  await ctx.fiber.dispose()
  context = undefined
  return call
}

/**
 * Whether one captured request declares the wire parity member headers.
 * @param request - the captured provider request.
 * @returns whether its member header set is present.
 */
function declaresWireParity(request: CapturedRequest): boolean {
  return request.headers.has('x-cc-request-class')
}

/** An assistant turn whose content is plain text, so a request carries an assistant block. */
function assistant(text: string) {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'cc-pool', model: 'claude-sonnet-5-5' },
  })
}

describe('pool prompt-cache policy', () => {
  it('enables the three-marker one-hour policy by default', async () => {
    const request = await probe()

    // PROBE has a system prompt, two tools, and one user turn, so the policy
    // marks the identity block, the harness system block, and the last-user
    // block; no tool declaration is marked.
    expect(request.body['system']).toEqual([
      {
        type: 'text',
        text: IDENTITY,
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      {
        type: 'text',
        text: 'You are the pool test assistant.',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ])
    expect(markersOf(request.body)).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[1].cache_control', { type: 'ephemeral', ttl: '1h' }],
    ])
    expect(JSON.stringify(request.body).match(/"cache_control"/gu)).toHaveLength(3)
    const tools = request.body['tools'] as Record<string, unknown>[]
    expect(tools.every(tool => !('cache_control' in tool))).toBe(true)
    expect(betasOf(request)).toEqual([EXTENDED_CACHE_TTL_BETA])
    expect(betasOf(request)).not.toContain(CACHE_SCOPE_BETA)
    expect(JSON.stringify(request.body)).not.toContain('"scope"')
    expect(JSON.stringify(request.body)).not.toContain(CACHE_SCOPE_BETA)
  })

  it('writes the pinned client field order with metadata in its canonical slot', async () => {
    const request = await probe()

    // The payload follows the pinned client's order rather than pi-ai's
    // construction order, with `stream` last.
    expect(Object.keys(request.body)).toEqual([
      'model',
      'messages',
      'system',
      'tools',
      'metadata',
      'max_tokens',
      'thinking',
      'output_config',
      'stream',
    ])
    // The empty placeholder is what keeps the pool's spliced `metadata.user_id`
    // in the canonical slot: its forward-body editor writes the member into an
    // existing metadata object instead of appending a second top-level one.
    expect(request.body['metadata']).toEqual({})
  })

  it('does not mark the message before the last user turn', async () => {
    const request = await probe({}, {
      messages: [
        user('hello'),
        assistant('hi'),
        user('continue'),
      ],
    })

    // The assistant turn is not a slot: the policy marks only the identity and
    // harness system blocks and the last user block.
    expect(markersOf(request.body)).toEqual([
      ['.messages[2].content[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[1].cache_control', { type: 'ephemeral', ttl: '1h' }],
    ])
    expect(JSON.stringify(request.body).match(/"cache_control"/gu)).toHaveLength(3)
  })

  it('no longer declares a tool-cache switch or a tool marker', async () => {
    const request = await probe()

    // The policy owns placement and marks no tool declaration, so the route
    // profile states no `supportsCacheControlOnTools` compat override at all.
    const model = resolvePoolProfiles().get(PROVIDER)
    expect(model?.compat).toBeUndefined()
    // The removed field is not part of the schema any more.
    expect('toolCacheBreakpoint' in Config({})).toBe(false)
    const tools = request.body['tools'] as Record<string, unknown>[]
    expect(tools).toHaveLength(2)
    expect(tools.every(tool => !('cache_control' in tool))).toBe(true)
  })

  it('leaves another provider route at its own placement and betas', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    vi.stubEnv('OTHER_GATEWAY_KEY', 'other-key')
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    // The pool route is mounted without cache configuration: its new defaults
    // must enable the three-marker policy without reaching any other route.
    await ctx.plugin(CcPool, { requestLog: { enabled: false } })
    // A second Anthropic Messages route states its own retention explicitly, as
    // every non-pool route must, and opts into no beta.
    await ctx.plugin(PiAi, {
      providers: {
        'other-gateway': {
          displayName: 'Other Gateway',
          apiKeyEnv: 'OTHER_GATEWAY_KEY',
          api: 'anthropic-messages',
          baseURL: 'https://other.example',
          cacheRetention: 'short',
          models: [{ id: 'other-model', name: 'Other Model', contextWindow: 200_000, maxTokens: 1_024 }],
        },
      },
    })
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)

    await assemble(ctx, PROBE)
    await assemble(ctx, { ...PROBE, model: 'other-model' }, 'other-gateway')

    expect(capture.calls).toHaveLength(2)
    expect(capture.calls[0]?.url.startsWith('https://ccpool.tiancegames.com')).toBe(true)
    expect(capture.calls[1]?.url.startsWith('https://other.example')).toBe(true)
    expect(markersOf(capture.calls[0]?.body ?? {})).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[1].cache_control', { type: 'ephemeral', ttl: '1h' }],
    ])
    expect(markersOf(capture.calls[1]?.body ?? {})).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral' }],
      ['.system[0].cache_control', { type: 'ephemeral' }],
      ['.tools[1].cache_control', { type: 'ephemeral' }],
    ])
    const other = capture.calls[1]
    if (other === undefined) throw new Error('the second route sent no request')
    // The other route keeps pi-ai's construction order and gains no metadata
    // placeholder.
    expect(Object.keys(other.body)).toEqual(['model', 'messages', 'max_tokens', 'stream', 'system', 'tools'])
    expect(other.body['metadata']).toBeUndefined()
    expect(JSON.stringify(other.body)).not.toContain('"ttl"')
    expect(JSON.stringify(other.body)).not.toContain(IDENTITY)
    expect(betasOf(other)).toEqual([])
    // The pool route's beta, marker policy, and field order reached only the pool
    // route.
    const pool = capture.calls[0]
    if (pool === undefined) throw new Error('the pool route sent no request')
    expect(Object.keys(pool.body).at(-1)).toBe('stream')
    expect(JSON.stringify(pool.body)).toContain(IDENTITY)
    expect(betasOf(pool)).toEqual([EXTENDED_CACHE_TTL_BETA])
  })

  it('refuses an impossible cache policy at load, before registering the route', async () => {
    const cases: readonly [label: string, config: Record<string, unknown>, error: RegExp][] = [
      ['five-minute lifetime', { cacheTtl: '5m' }, /cacheMarkerPolicy "cc3" requires cacheTtl "1h"/],
      ['one hour without the beta', { cacheTtl: '1h', extendedCacheBeta: false }, /cacheMarkerPolicy "cc3" requires extendedCacheBeta: true/],
    ]
    for (const [label, config, error] of cases) {
      const ctx = new Context()
      context = ctx
      await ctx.plugin(LlmRuntime)
      await expect(ctx.plugin(CcPool, { requestLog: { enabled: false }, ...config }), label).rejects.toThrow(error)
      expect(ctx.llm.listProviders()).toEqual([])
      await ctx.fiber.dispose()
      context = undefined
    }
  })

  it('accepts the caching-disabled lifetime and drops the marker policy', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CcPool, { requestLog: { enabled: false }, cacheTtl: 'none' })
    expect(ctx.llm.listProviders()).toContainEqual(expect.objectContaining({ id: 'cc-pool' }))
    await ctx.fiber.dispose()
    context = undefined
  })

  it('refuses a lifetime the route does not offer before it registers', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(CcPool, { requestLog: { enabled: false }, cacheTtl: '24h' } as never))
      .rejects.toThrow(/cacheTtl/)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('keeps the three-marker bytes when the wire parity probe answers no proof', async () => {
    const baseline = await probe()
    const unproven = await probe({ ccWireParity: true }, {}, (request) => {
      if (request.url !== CAPABILITIES_URL) return anthropicSuccessResponse()
      // The endpoint answered with the pair, but no build identity binds it.
      return new Response(JSON.stringify({ protocol: 2, ccWireParity: 1 }), { status: 200 })
    })

    // A route that asked for the wire and did not get proof for a build is
    // byte-identical to a route that never asked: the probe cannot alter the
    // wire-parity-off request.
    expect(declaresWireParity(unproven)).toBe(false)
    expect(unproven.body).toEqual(baseline.body)
    expect(markersOf(unproven.body)).toEqual(markersOf(baseline.body))
    expect(markersOf(unproven.body)).toHaveLength(3)
    expect(betasOf(unproven)).toEqual([EXTENDED_CACHE_TTL_BETA])
  })
})
