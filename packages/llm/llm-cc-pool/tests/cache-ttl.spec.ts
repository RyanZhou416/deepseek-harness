/**
 * Prompt-cache policy: the `cache_control` markers and `anthropic-beta` header
 * the pool route asks for under each policy, their exact placement, and the
 * guarantee that no other provider route changes.
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as CcPool from '../src/index.ts'
import { assemble, capturePoolFetch, user } from './harness.ts'
import type { CapturedRequest } from './harness.ts'

/** The Anthropic beta a one-hour prompt-cache lifetime declares. */
const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11'

/** The beta that selects a cache scope; this route never declares one. */
const CACHE_SCOPE_BETA = 'prompt-caching-scope-2026-01-05'

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
 * the three places a marker can appear.
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
 * A deep copy of a request body with every `cache_control` marker removed.
 * @param value - any JSON value from the captured body.
 * @returns the same value without cache markers.
 */
function stripMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMarkers)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'cache_control')
      .map(([key, child]) => [key, stripMarkers(child)]),
  )
}

/**
 * A request body without cache markers.
 * @param body - the captured Anthropic Messages body.
 * @returns the body with every `cache_control` key removed.
 */
function withoutMarkers(body: Record<string, unknown>): Record<string, unknown> {
  return stripMarkers(body) as Record<string, unknown>
}

/**
 * Expand pi-ai's compact rendering of a single-text message.
 *
 * A message with one text block is sent as a bare string when no block of it
 * needs a marker, and as one text block when it does. Both are the same
 * payload, so a comparison between a marked and an unmarked body expands the
 * compact form first.
 * @param body - a request body.
 * @returns the body whose message contents are all block arrays.
 */
function expandCompactMessages(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body['messages']
  if (!Array.isArray(messages)) return body
  return {
    ...body,
    messages: messages.map((message: unknown) => {
      if (message === null || typeof message !== 'object') return message
      const entry = message as Record<string, unknown>
      return typeof entry['content'] === 'string'
        ? { ...entry, content: [{ type: 'text', text: entry['content'] }] }
        : entry
    }),
  }
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
 * @param config - loader configuration for the pool plugin.
 * @returns the request the pool route built.
 */
async function probe(config: Record<string, unknown> = {}): Promise<CapturedRequest> {
  vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
  const ctx = await mount(config)
  const capture = capturePoolFetch()
  vi.stubGlobal('fetch', capture.fetch)
  await assemble(ctx, PROBE)
  const call = capture.calls[0]
  if (call === undefined) throw new Error('the pool route sent no request')
  await ctx.fiber.dispose()
  context = undefined
  return call
}

describe('pool prompt-cache policy', () => {
  it('sends the five-minute marker on the system prompt, last tool, and last user block by default', async () => {
    const request = await probe()
    expect(markersOf(request.body)).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral' }],
      ['.system[0].cache_control', { type: 'ephemeral' }],
      ['.tools[1].cache_control', { type: 'ephemeral' }],
    ])
    // 5 minutes is the API's default lifetime, so the marker carries no `ttl`,
    // and the default policy declares no beta.
    expect(JSON.stringify(request.body)).not.toContain('"ttl"')
    expect(betasOf(request)).toEqual([])
  })

  it('sends one-hour markers at the same three places without adding the beta', async () => {
    const request = await probe({ cacheTtl: '1h' })
    expect(markersOf(request.body)).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.tools[1].cache_control', { type: 'ephemeral', ttl: '1h' }],
    ])
    // The one-hour tier writes `ttl` but does not declare the beta that permits
    // it: only the explicit route opt-in does.
    expect(betasOf(request)).toEqual([])
  })

  it('sends the CC 2.1.288 one-hour layout when both opt-ins are set', async () => {
    const request = await probe({ cacheTtl: '1h', extendedCacheBeta: true, toolCacheBreakpoint: false })
    const body = request.body

    // Exactly the two blocks CC's main loop marks: the system prompt and the
    // final user content block, with the one-hour value on each.
    expect(markersOf(body)).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
    ])
    expect(body['system']).toEqual([{
      type: 'text',
      text: 'You are the pool test assistant.',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    }])
    expect(body['messages']).toEqual([{
      role: 'user',
      content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    }])
    // CC 2.1.288 does not mark a tool definition, so neither tool carries one.
    const tools = body['tools']
    expect(Array.isArray(tools)).toBe(true)
    for (const tool of tools as Record<string, unknown>[]) expect(tool).not.toHaveProperty('cache_control')

    // The beta is a header fact; the body declares no beta field, no scope, and
    // no scope beta.
    expect(betasOf(request)).toEqual([EXTENDED_CACHE_TTL_BETA])
    expect(betasOf(request)).not.toContain(CACHE_SCOPE_BETA)
    expect(JSON.stringify(body)).not.toContain('"scope"')
    expect(JSON.stringify(body)).not.toContain('betas')
    expect(JSON.stringify(body)).not.toContain(CACHE_SCOPE_BETA)
  })

  it('changes nothing but the markers and the declared beta across the policy opt-ins', async () => {
    const marked = await probe({ cacheTtl: '1h' })
    const cc = await probe({ cacheTtl: '1h', extendedCacheBeta: true, toolCacheBreakpoint: false })

    // Removing the markers from both requests leaves the same payload: the CC
    // layout differs only in which blocks carry a marker, and the beta travels
    // in the header rather than the body.
    expect(withoutMarkers(cc.body)).toEqual(withoutMarkers(marked.body))
    expect(markersOf(cc.body)).toHaveLength(2)
    expect(markersOf(marked.body)).toHaveLength(3)
  })

  it('sends no marker and no beta when configured with none', async () => {
    const request = await probe({ cacheTtl: 'none' })
    expect(markersOf(request.body)).toEqual([])
    expect(JSON.stringify(request.body)).not.toContain('cache_control')
    expect(betasOf(request)).toEqual([])
  })

  it('changes nothing but the marker value across the TTL choices', async () => {
    const unset = await probe()
    const fiveMinutes = await probe({ cacheTtl: '5m' })
    const oneHour = await probe({ cacheTtl: '1h' })
    const none = await probe({ cacheTtl: 'none' })

    // The two marker-bearing lifetimes differ in the marker value alone.
    expect(withoutMarkers(fiveMinutes.body)).toEqual(withoutMarkers(oneHour.body))
    // Removing the markers is the whole of `none`: the remaining payload is the
    // same request, with pi-ai keeping the single-text message in its compact
    // string form because no block needs a marker.
    expect(markersOf(none.body)).toEqual([])
    expect(expandCompactMessages(withoutMarkers(none.body)))
      .toEqual(expandCompactMessages(withoutMarkers(fiveMinutes.body)))
    // An unset key is the route's pre-existing request, and the schema default
    // states that same lifetime explicitly: the two bodies are identical.
    expect(unset.body).toEqual(fiveMinutes.body)
    expect(betasOf(unset)).toEqual(betasOf(fiveMinutes))
  })

  it('keeps its configured policy when the ambient retention preference says otherwise', async () => {
    vi.stubEnv('PI_CACHE_RETENTION', 'long')
    const request = await probe({ cacheTtl: '5m' })

    // The route's policy is explicit: an ambient provider preference cannot
    // upgrade the declared 5-minute lifetime or add the extended beta.
    expect(markersOf(request.body)).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral' }],
      ['.system[0].cache_control', { type: 'ephemeral' }],
      ['.tools[1].cache_control', { type: 'ephemeral' }],
    ])
    expect(betasOf(request)).toEqual([])
  })

  it('leaves another provider route at its own explicit retention and betas', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    vi.stubEnv('OTHER_GATEWAY_KEY', 'other-key')
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CcPool, {
      requestLog: { enabled: false },
      cacheTtl: '1h',
      extendedCacheBeta: true,
      toolCacheBreakpoint: false,
    })
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
    ])
    expect(markersOf(capture.calls[1]?.body ?? {})).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral' }],
      ['.system[0].cache_control', { type: 'ephemeral' }],
      ['.tools[1].cache_control', { type: 'ephemeral' }],
    ])
    const other = capture.calls[1]
    if (other === undefined) throw new Error('the second route sent no request')
    expect(JSON.stringify(other.body)).not.toContain('"ttl"')
    expect(betasOf(other)).toEqual([])
    // The pool route's beta and marker policy reached only the pool route.
    const pool = capture.calls[0]
    if (pool === undefined) throw new Error('the pool route sent no request')
    expect(betasOf(pool)).toEqual([EXTENDED_CACHE_TTL_BETA])
  })

  it('refuses a lifetime the route does not offer before it registers', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(CcPool, { requestLog: { enabled: false }, cacheTtl: '24h' } as never))
      .rejects.toThrow(/cacheTtl/)
    expect(ctx.llm.listProviders()).toEqual([])
  })
})
