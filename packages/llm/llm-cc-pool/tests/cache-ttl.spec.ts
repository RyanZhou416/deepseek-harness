/**
 * Prompt-cache TTL policy: the `cache_control` markers the pool route asks for
 * with each `cacheTtl` choice, their exact placement, and the guarantee that no
 * other provider route changes.
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as CcPool from '../src/index.ts'
import type { CcPoolCacheTtl } from '../src/pool.ts'
import { assemble, capturePoolFetch, user } from './harness.ts'

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
 * Send the probe on a fresh mount and return the body the pool route built.
 * @param cacheTtl - the TTL choice to mount; omission leaves the key unset.
 * @returns the captured Anthropic Messages body.
 */
async function probeBody(cacheTtl: CcPoolCacheTtl | undefined): Promise<Record<string, unknown>> {
  const ctx = await mount(cacheTtl === undefined ? {} : { cacheTtl })
  const capture = capturePoolFetch()
  vi.stubGlobal('fetch', capture.fetch)
  await assemble(ctx, PROBE)
  const body = capture.calls[0]?.body
  if (body === undefined) throw new Error('the pool route sent no request')
  await ctx.fiber.dispose()
  context = undefined
  return body
}

describe('pool prompt-cache TTL', () => {
  it('sends the five-minute marker on the system prompt, last tool, and last user block by default', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const ctx = await mount()
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)
    await assemble(ctx, PROBE)

    expect(markersOf(capture.calls[0]?.body ?? {})).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral' }],
      ['.system[0].cache_control', { type: 'ephemeral' }],
      ['.tools[1].cache_control', { type: 'ephemeral' }],
    ])
    // 5 minutes is the API's default lifetime, so the marker carries no `ttl`.
    expect(JSON.stringify(capture.calls[0]?.body)).not.toContain('"ttl"')
  })

  it('sends one-hour markers at the same three places when configured', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const ctx = await mount({ cacheTtl: '1h' })
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)
    await assemble(ctx, PROBE)

    expect(markersOf(capture.calls[0]?.body ?? {})).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.system[0].cache_control', { type: 'ephemeral', ttl: '1h' }],
      ['.tools[1].cache_control', { type: 'ephemeral', ttl: '1h' }],
    ])
  })

  it('sends no marker at all when configured with none', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const ctx = await mount({ cacheTtl: 'none' })
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)
    await assemble(ctx, PROBE)

    const body = capture.calls[0]?.body ?? {}
    expect(markersOf(body)).toEqual([])
    expect(JSON.stringify(body)).not.toContain('cache_control')
  })

  it('changes nothing but the marker value across the TTL choices', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const unset = await probeBody(undefined)
    const fiveMinutes = await probeBody('5m')
    const oneHour = await probeBody('1h')
    const none = await probeBody('none')

    // The two marker-bearing lifetimes differ in the marker value alone.
    expect(withoutMarkers(fiveMinutes)).toEqual(withoutMarkers(oneHour))
    // Removing the markers is the whole of `none`: the remaining payload is the
    // same request, with pi-ai keeping the single-text message in its compact
    // string form because no block needs a marker.
    expect(markersOf(none)).toEqual([])
    expect(expandCompactMessages(withoutMarkers(none)))
      .toEqual(expandCompactMessages(withoutMarkers(fiveMinutes)))
    // An unset key is the route's pre-existing request, and the schema default
    // states that same lifetime explicitly: the two bodies are identical.
    expect(unset).toEqual(fiveMinutes)
  })

  it('keeps its configured lifetime when the ambient retention preference says otherwise', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    vi.stubEnv('PI_CACHE_RETENTION', 'long')
    const ctx = await mount()
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)
    await assemble(ctx, PROBE)

    // The route's policy is explicit: an ambient provider preference cannot
    // upgrade the declared 5-minute lifetime.
    expect(markersOf(capture.calls[0]?.body ?? {})).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral' }],
      ['.system[0].cache_control', { type: 'ephemeral' }],
      ['.tools[1].cache_control', { type: 'ephemeral' }],
    ])
  })

  it('leaves another provider route at its own marker policy', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    vi.stubEnv('OTHER_GATEWAY_KEY', 'other-key')
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CcPool, { requestLog: { enabled: false }, cacheTtl: '1h' })
    // A hand-declared route that configures no cache retention: pi-ai's own
    // default applies to it, and this plugin's choice must not reach it.
    await ctx.plugin(PiAi, {
      providers: {
        'other-gateway': {
          displayName: 'Other Gateway',
          apiKeyEnv: 'OTHER_GATEWAY_KEY',
          api: 'anthropic-messages',
          baseURL: 'https://other.example',
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
      ['.tools[1].cache_control', { type: 'ephemeral', ttl: '1h' }],
    ])
    expect(markersOf(capture.calls[1]?.body ?? {})).toEqual([
      ['.messages[0].content[0].cache_control', { type: 'ephemeral' }],
      ['.system[0].cache_control', { type: 'ephemeral' }],
      ['.tools[1].cache_control', { type: 'ephemeral' }],
    ])
    expect(JSON.stringify(capture.calls[1]?.body)).not.toContain('"ttl"')
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
