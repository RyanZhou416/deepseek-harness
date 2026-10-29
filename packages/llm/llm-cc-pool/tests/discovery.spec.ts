/**
 * The pool listing read surface: candidates only, typed failures, and no
 * fallback to the configured catalogue.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as CcPool from '../src/index.ts'
import { DISCOVERY_NAMESPACE, MODELS_URL, discoverPoolModels } from '../src/discovery.ts'
import { BASE_URL, MODELS, PROVIDER } from '../src/pool.ts'
import { capturePoolFetch } from './harness.ts'

let context: Context | undefined
const tempRoots: string[] = []

/** One deployment catalogue the built-in four do not describe. */
const CONFIGURED_MODELS = [
  { id: 'claude-haiku-5', name: 'Claude Haiku 5', contextWindow: 200_000, maxTokens: 32_000, defaultReasoning: 'low' },
]

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  for (const root of tempRoots.splice(0)) {
    const temporary = tmpdir()
    if (!root.startsWith(temporary)) throw new Error(`refusing to remove ${root}: outside ${temporary}`)
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * Mount the real LLM service and the plugin under test with the durable sink
 * disabled, so a case writes nothing below the ambient harness home.
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

/** One fresh temporary directory owned by the case that requested it. */
async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cc-pool-discovery-'))
  tempRoots.push(root)
  return root
}

/**
 * A listing reply in the pool's `{ data: [{ id, display_name }] }` format.
 * @param data - the records the pool advertises.
 * @returns the HTTP reply the reader parses.
 */
function poolListing(data: readonly unknown[]): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * A 2xx reply whose body stream fails, as a dropped connection would.
 * @returns the response whose `text()` read rejects.
 */
function unreadableReply(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('connection reset'))
    },
  }), { status: 200 })
}

describe('pool model listing read', () => {
  it('reads the fixed listing URL with the member credential as a bearer token', async () => {
    const capture = capturePoolFetch(() => poolListing([
      { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
      { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
    ]))
    vi.stubGlobal('fetch', capture.fetch)

    const models = await discoverPoolModels('pool-member-key')
    expect(models).toEqual([
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    ])

    expect(capture.calls).toHaveLength(1)
    const call = capture.calls[0]
    expect(call?.url).toBe(`${BASE_URL}/v1/models`)
    expect(call?.url).toBe(MODELS_URL)
    expect(call?.method).toBe('GET')
    expect(call?.headers.get('authorization')).toBe('Bearer pool-member-key')
    expect(call?.headers.get('accept')).toBe('application/json')
  })

  it('reports only an id and a name, never invented capacities or efforts', async () => {
    const capture = capturePoolFetch(() => poolListing([
      { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
      { id: 'claude-fable-5-1' },
    ]))
    vi.stubGlobal('fetch', capture.fetch)

    const models = await discoverPoolModels('pool-member-key')
    // The pool discloses no context window, output cap, effort default, or
    // modality: a candidate that invented one would seed a wrong route.
    expect(models).toEqual([
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      { id: 'claude-fable-5-1', name: 'claude-fable-5-1' },
    ])
    for (const model of models) expect(Object.keys(model).sort()).toEqual(['id', 'name'])
  })

  it('skips rows without a usable id instead of failing the whole listing', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({
      data: [
        null,
        'claude-as-string',
        { display_name: 'No id' },
        { id: '', display_name: 'Empty id' },
        { id: 42, display_name: 'Numeric id' },
        { id: 'claude-opus-5-5', display_name: 7 },
        { id: 'claude-sonnet-5-5', display_name: '' },
        { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' },
      ],
    }), { status: 200 })))

    expect(await discoverPoolModels('pool-member-key')).toEqual([
      { id: 'claude-opus-5-5', name: 'claude-opus-5-5' },
      { id: 'claude-sonnet-5-5', name: 'claude-sonnet-5-5' },
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
    ])
  })

  it('returns no candidates for an empty listing instead of the built-in catalogue', async () => {
    const capture = capturePoolFetch(() => poolListing([]))
    vi.stubGlobal('fetch', capture.fetch)
    expect(await discoverPoolModels('pool-member-key')).toEqual([])
    expect(await discoverPoolModels('pool-member-key')).not.toEqual(
      MODELS.map(model => ({ id: model.id, name: model.name })),
    )
    expect(capture.calls).toHaveLength(2)
  })

  it('fails typed when the reply is not a model listing', async () => {
    for (const body of [null, { models: [] }, { data: { id: 'claude-sonnet-5-5' } }, 'text']) {
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })))
      await expect(discoverPoolModels('pool-member-key')).rejects.toMatchObject({
        code: 'DISCOVERY_FAILED',
        message: `${MODELS_URL} did not answer with a "data" array of models`,
      })
    }
  })

  it('fails typed when the reply is not JSON', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('not json', { status: 200 })))
    await expect(discoverPoolModels('pool-member-key')).rejects.toMatchObject({
      code: 'DISCOVERY_FAILED',
      message: `${MODELS_URL} did not answer with JSON`,
    })
  })

  it('fails typed on a refused status and names the credential for an authentication refusal', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 401 })))
    await expect(discoverPoolModels('pool-member-key')).rejects.toMatchObject({
      code: 'DISCOVERY_FAILED',
      message: `${MODELS_URL} answered 401; check the CC_POOL_API_KEY credential`,
    })

    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 503 })))
    await expect(discoverPoolModels('pool-member-key')).rejects.toMatchObject({
      code: 'DISCOVERY_FAILED',
      message: `${MODELS_URL} answered 503`,
    })
  })

  it('fails typed when the endpoint cannot be reached', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('getaddrinfo ENOTFOUND')))
    await expect(discoverPoolModels('pool-member-key')).rejects.toMatchObject({
      code: 'DISCOVERY_FAILED',
      message: `could not reach ${MODELS_URL}`,
    })
  })

  it('fails typed when the reply body cannot be read', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(unreadableReply()))
    await expect(discoverPoolModels('pool-member-key')).rejects.toMatchObject({
      code: 'DISCOVERY_FAILED',
      message: `${MODELS_URL} did not answer with a readable body`,
    })
  })

  it('forwards caller cancellation and reports it as an aborted read', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchStub = vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError')))
    vi.stubGlobal('fetch', fetchStub)
    await expect(discoverPoolModels('pool-member-key', controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    expect(fetchStub).toHaveBeenCalledWith(MODELS_URL, expect.objectContaining({
      method: 'GET',
      signal: controller.signal,
    }))
  })

  it('reports cancellation during the body read as an aborted read', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', () => Promise.resolve(unreadableReply()))
    const read = discoverPoolModels('pool-member-key', controller.signal)
    controller.abort()
    await expect(read).rejects.toMatchObject({ code: 'ABORTED' })
  })
})

describe('registered pool discovery', () => {
  it('serves the pool listing through the plugin namespace without a model request', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const ctx = await mount()
    const capture = capturePoolFetch(() => poolListing([
      { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
    ]))
    vi.stubGlobal('fetch', capture.fetch)

    expect(await ctx.llm.discoverModels(DISCOVERY_NAMESPACE, { provider: PROVIDER })).toEqual([
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    ])
    expect(capture.calls).toHaveLength(1)
    expect(capture.calls[0]?.url).toBe(`${BASE_URL}/v1/models`)
    expect(capture.calls[0]?.method).toBe('GET')
    expect(capture.calls[0]?.headers.get('authorization')).toBe('Bearer pool-member-key')
    // Reading the catalogue must not register a provider, a directory entry,
    // or a route: only the fixed route exists before and after the read.
    expect(ctx.llm.listProviders()).toEqual([{ id: PROVIDER, name: 'CC 订阅池' }])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('fails typed without a stored credential and opens no request', async () => {
    vi.stubEnv('CC_POOL_API_KEY', '')
    const ctx = await mount()
    const capture = capturePoolFetch(() => poolListing([{ id: 'claude-sonnet-5-5' }]))
    vi.stubGlobal('fetch', capture.fetch)

    await expect(ctx.llm.discoverModels(DISCOVERY_NAMESPACE, { provider: PROVIDER }))
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(capture.calls).toHaveLength(0)
  })

  it('does not borrow a draft credential when no credential is stored', async () => {
    vi.stubEnv('CC_POOL_API_KEY', '')
    const ctx = await mount()
    const capture = capturePoolFetch(() => poolListing([{ id: 'claude-sonnet-5-5' }]))
    vi.stubGlobal('fetch', capture.fetch)

    await expect(ctx.llm.discoverModels(DISCOVERY_NAMESPACE, {
      provider: PROVIDER,
      baseURL: 'https://elsewhere.example',
      api: 'openai-completions',
      apiKey: 'draft-key',
    })).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(capture.calls).toHaveLength(0)
  })

  it('uses the stored credential and the fixed pool endpoint, ignoring the draft fields', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'stored-key')
    const ctx = await mount()
    const capture = capturePoolFetch(() => poolListing([{ id: 'claude-sonnet-5-5' }]))
    vi.stubGlobal('fetch', capture.fetch)

    await ctx.llm.discoverModels(DISCOVERY_NAMESPACE, {
      provider: PROVIDER,
      baseURL: 'https://elsewhere.example',
      api: 'openai-completions',
      apiKey: 'draft-key',
    })
    expect(capture.calls).toHaveLength(1)
    expect(capture.calls[0]?.url).toBe(`${BASE_URL}/v1/models`)
    expect(capture.calls[0]?.headers.get('authorization')).toBe('Bearer stored-key')
    expect(capture.calls[0]?.headers.get('x-api-key')).toBeNull()
  })

  it('fails typed when the pool refuses the read, without replacing the built-in catalogue', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const ctx = await mount()
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 500 })))

    await expect(ctx.llm.discoverModels(DISCOVERY_NAMESPACE, { provider: PROVIDER }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(await ctx.llm.listModels(PROVIDER)).toEqual(MODELS.map(model => ({
      provider: PROVIDER,
      id: model.id,
      name: model.name,
      inputModalities: ['text', 'image'],
    })))
  })

  it('returns no candidates for an empty pool listing and keeps the configured catalogue', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const ctx = await mount({ models: CONFIGURED_MODELS })
    vi.stubGlobal('fetch', () => Promise.resolve(poolListing([])))

    expect(await ctx.llm.discoverModels(DISCOVERY_NAMESPACE, { provider: PROVIDER })).toEqual([])
    expect(await ctx.llm.listModels(PROVIDER)).toEqual([{
      provider: PROVIDER,
      id: 'claude-haiku-5',
      name: 'Claude Haiku 5',
      inputModalities: ['text', 'image'],
    }])
  })

  it('reports the pool models even when they are not in the configured catalogue', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const ctx = await mount({ models: CONFIGURED_MODELS })
    vi.stubGlobal('fetch', () => Promise.resolve(poolListing([
      { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
    ])))

    expect(await ctx.llm.discoverModels(DISCOVERY_NAMESPACE, { provider: PROVIDER })).toEqual([
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    ])
    // A read never adopts: the configured catalogue still serves requests.
    expect((await ctx.llm.listModels(PROVIDER)).map(model => model.id)).toEqual(['claude-haiku-5'])
  })

  it('deduplicates ids the pool lists twice, keeping the first entry', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const ctx = await mount()
    vi.stubGlobal('fetch', () => Promise.resolve(poolListing([
      { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
      { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5 (duplicate)' },
    ])))

    expect(await ctx.llm.discoverModels(DISCOVERY_NAMESPACE, { provider: PROVIDER })).toEqual([
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    ])
  })

  it('resolves the credential through the mounted credentials service', async () => {
    vi.stubEnv('CC_POOL_API_KEY', '')
    const root = await temporaryDirectory()
    const credentialsPath = join(root, '.credentials.yaml')
    await writeFile(credentialsPath, 'version: 1\nrefs:\n  CC_POOL_API_KEY: key-from-store\n', { mode: 0o600 })
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalCredentialProvider, { path: credentialsPath, debounceMs: 10 })
    await ctx.plugin(CcPool, { requestLog: { enabled: false } })
    const capture = capturePoolFetch(() => poolListing([{ id: 'claude-sonnet-5-5' }]))
    vi.stubGlobal('fetch', capture.fetch)

    expect(await ctx.llm.discoverModels(DISCOVERY_NAMESPACE, { provider: PROVIDER })).toEqual([
      { id: 'claude-sonnet-5-5', name: 'claude-sonnet-5-5' },
    ])
    expect(capture.calls[0]?.headers.get('authorization')).toBe('Bearer key-from-store')
  })
})
