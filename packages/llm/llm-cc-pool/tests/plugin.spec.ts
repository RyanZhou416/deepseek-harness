/** The mac-pool plugin registers one fixed route and sends the pool wire contract. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createMessage,
  createUserMessage,
  POOL_REQUEST_CLOSED_CODE,
  ReasoningEffortId,
  userAgent,
} from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as CcPool from '../src/index.ts'
import { BASE_URL, MODELS, PROVIDER } from '../src/pool.ts'
import {
  assemble,
  capturePoolFetch,
  MappedTestFileSystem,
  TestAttachmentStore,
  TEST_IMAGE_REF,
  TEST_MODEL_IMAGE_PATH,
  user,
} from './harness.ts'

let context: Context | undefined
const tempRoots: string[] = []

/** One deployment catalogue the built-in four do not describe. */
const CONFIGURED_MODELS = [
  { id: 'claude-haiku-5', name: 'Claude Haiku 5', contextWindow: 200_000, maxTokens: 32_000, defaultReasoning: 'low' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (pool)', contextWindow: 1_000_000, maxTokens: 96_000, defaultReasoning: 'max' },
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
 * Mount the real LLM service and the plugin under test. The durable sink is
 * disabled by default so a case that does not exercise persistence writes
 * nothing below the ambient harness home.
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-cc-pool-'))
  tempRoots.push(root)
  return root
}

/**
 * Assert that neither this plugin's durable file nor the pi-ai default exists
 * below a case's harness home.
 * @param home - the case's `DSH_HOME`.
 */
async function expectNoRequestLog(home: string): Promise<void> {
  for (const name of ['llm-cc-pool-requests.jsonl', 'llm-pi-ai-requests.jsonl']) {
    await expect(readFile(join(home, 'logs', name), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }
}

describe('mac-pool plugin registration', () => {
  it('registers exactly one cc-pool provider and nothing else', async () => {
    const ctx = await mount()
    expect(ctx.llm.listProviders()).toEqual([{ id: PROVIDER, name: 'CC 订阅池' }])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('offers the fixed pool discovery and no configurable-provider directory entry', async () => {
    vi.stubEnv('CC_POOL_API_KEY', '')
    const ctx = await mount()
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)
    // The registered reading surface answers for this plugin's namespace only,
    // and it fails on the deployment's missing credential instead of returning
    // the configured catalogue.
    await expect(ctx.llm.discoverModels('llm-cc-pool', { provider: PROVIDER }))
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: PROVIDER }))
      .rejects.toMatchObject({ code: 'NO_DISCOVERY' })
    expect(capture.calls).toHaveLength(0)
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('captures the fixed retry policy at registration', async () => {
    const ctx = await mount()
    expect(ctx.llm.providerRetryPolicy(PROVIDER)).toMatchObject({
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['RATE_LIMIT', 'SERVER', POOL_REQUEST_CLOSED_CODE],
    })
  })

  it('lists the fixed catalogue before any credential is stored', async () => {
    vi.stubEnv('CC_POOL_API_KEY', '')
    const ctx = await mount()
    expect(await ctx.llm.listModels(PROVIDER)).toEqual(MODELS.map(model => ({
      provider: PROVIDER,
      id: model.id,
      name: model.name,
      inputModalities: ['text', 'image'],
    })))
  })

  it('lists the configured catalogue instead of the built-in one, before any credential is stored', async () => {
    vi.stubEnv('CC_POOL_API_KEY', '')
    const ctx = await mount({ models: CONFIGURED_MODELS })
    expect(await ctx.llm.listModels(PROVIDER)).toEqual([
      { provider: PROVIDER, id: 'claude-haiku-5', name: 'Claude Haiku 5', inputModalities: ['text', 'image'] },
      { provider: PROVIDER, id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (pool)', inputModalities: ['text', 'image'] },
    ])
    await expect(ctx.llm.resolveModelInfo(PROVIDER, 'claude-opus-5-5'))
      .rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
  })

  it('describes a configured model with its capacities and default effort', async () => {
    const ctx = await mount({ models: CONFIGURED_MODELS })
    expect(await ctx.llm.resolveModelInfo(PROVIDER, 'claude-haiku-5')).toMatchObject({
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 32_000,
      reasoning: { defaultEffort: ReasoningEffortId('low') },
    })
    expect(await ctx.llm.resolveModelInfo(PROVIDER, 'claude-sonnet-5-5')).toMatchObject({
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 96_000,
      reasoning: { defaultEffort: ReasoningEffortId('max') },
    })
  })

  it('describes each model with its capacities, efforts, and default effort', async () => {
    const ctx = await mount()
    const sonnet = await ctx.llm.resolveModelInfo(PROVIDER, 'claude-sonnet-5-5')
    expect(sonnet.id).toBe('claude-sonnet-5-5')
    expect(sonnet.context).toEqual({ contextWindow: 1_000_000 })
    expect(sonnet.defaultMaxTokens).toBe(128_000)
    expect(sonnet.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(sonnet.reasoning?.defaultEffort).toBe(ReasoningEffortId('medium'))
    expect(await ctx.llm.resolveModelInfo(PROVIDER, 'claude-mythos-5-1')).toMatchObject({
      defaultMaxTokens: 64_000,
      reasoning: { defaultEffort: 'high' },
    })
  })

  it('leaves no route or discovery behind when its fiber is disposed', async () => {
    vi.stubEnv('CC_POOL_API_KEY', '')
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    const fiber = ctx.plugin(CcPool, {})
    await fiber
    expect(ctx.llm.listProviders()).toHaveLength(1)
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    await expect(ctx.llm.discoverModels('llm-cc-pool', { provider: PROVIDER }))
      .rejects.toMatchObject({ code: 'NO_DISCOVERY' })
    expect(capture.calls).toHaveLength(0)
  })
})

describe('mac-pool catalogue validation', () => {
  /**
   * Mount the plugin with a configuration the Loader or the catalogue resolver
   * must refuse.
   * @param config - raw loader configuration for the plugin.
   * @returns the mount promise.
   */
  async function mountRejected(config: Record<string, unknown>): Promise<unknown> {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    return ctx.plugin(CcPool, { requestLog: { enabled: false }, ...config })
  }

  it('refuses to mount a catalogue with a duplicate model id', async () => {
    const duplicate = { id: 'duplicate', name: 'Duplicate', contextWindow: 1_000, maxTokens: 100, defaultReasoning: 'low' }
    await expect(mountRejected({ models: [duplicate, { ...duplicate, name: 'Duplicate again' }] }))
      .rejects.toThrow(/"duplicate" more than once/)
    expect(context?.llm.listProviders()).toEqual([])
  })

  it('refuses to mount an explicitly empty catalogue', async () => {
    await expect(mountRejected({ models: [] })).rejects.toThrow(/at least one model/)
    expect(context?.llm.listProviders()).toEqual([])
  })

  it('refuses to mount a positive-integer capacity violation', async () => {
    await expect(mountRejected({
      models: [{ id: 'model', name: 'Model', contextWindow: 0, maxTokens: 100, defaultReasoning: 'low' }],
    })).rejects.toThrow(/contextWindow/)
    expect(context?.llm.listProviders()).toEqual([])
  })

  it('refuses to mount an effort level the pool does not offer', async () => {
    await expect(mountRejected({
      models: [{ id: 'model', name: 'Model', contextWindow: 1_000, maxTokens: 100, defaultReasoning: 'speed' }],
    })).rejects.toThrow(/defaultReasoning/)
    expect(context?.llm.listProviders()).toEqual([])
  })
})

describe('mac-pool wire contract', () => {
  it('sends the fixed endpoint, credential, pool, session, and attribution headers', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const ctx = await mount()
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)

    const result = await assemble(ctx, {
      model: 'claude-sonnet-5-5',
      messages: [user('hello')],
      sessionId: 'session-cc-pool-fixed' as never,
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])

    expect(capture.calls).toHaveLength(1)
    const call = capture.calls[0]
    const endpoint = new URL(call?.url ?? '')
    expect(`${endpoint.origin}${endpoint.pathname}`).toBe(`${BASE_URL}/v1/messages`)
    expect(call?.headers.get('x-api-key')).toBe('pool-member-key')
    expect(call?.headers.get('x-cc-backend')).toBe('direct')
    expect(call?.headers.get('x-claude-code-session-id')).toBe('session-cc-pool-fixed')
    expect(call?.headers.get('x-client-request-id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(call?.headers.get('user-agent')).toBe(userAgent())
    expect(call?.headers.get('anthropic-version')).toBeTruthy()

    expect(call?.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 128_000,
      stream: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
    })
    expect(call?.body['speed']).toBeUndefined()
    expect(call?.body['context_management']).toBeUndefined()
  })

  it('sends each model its own default effort and output cap', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const ctx = await mount()
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)

    await assemble(ctx, { model: 'claude-fable-5-1', messages: [user('fable')] })
    await assemble(ctx, { model: 'claude-sonnet-5-5', messages: [user('explicit')], reasoningEffort: ReasoningEffortId('max') })

    expect(capture.calls[0]?.body).toMatchObject({
      model: 'claude-fable-5-1',
      max_tokens: 64_000,
      output_config: { effort: 'high' },
    })
    expect(capture.calls[1]?.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      output_config: { effort: 'max' },
    })
  })

  it('sends a configured model its capacities and default effort', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const ctx = await mount({ models: CONFIGURED_MODELS })
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)

    await assemble(ctx, { model: 'claude-haiku-5', messages: [user('configured')] })
    expect(capture.calls[0]?.body).toMatchObject({
      model: 'claude-haiku-5',
      max_tokens: 32_000,
      stream: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
    })
    expect(capture.calls[0]?.body['speed']).toBeUndefined()
    expect(capture.calls[0]?.body['context_management']).toBeUndefined()
  })

  it('rejects an effort the pool catalogue does not offer', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const ctx = await mount()
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)
    await expect(ctx.llm.resolveCallConfig({
      provider: PROVIDER,
      model: 'claude-sonnet-5-5',
      reasoningEffort: ReasoningEffortId('off'),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    expect(capture.calls).toHaveLength(0)
  })

  it('fails a missing member credential before opening a request', async () => {
    vi.stubEnv('CC_POOL_API_KEY', '')
    const ctx = await mount()
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)

    const result = await assemble(ctx, { model: 'claude-sonnet-5-5', messages: [user('no key')] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(capture.calls).toHaveLength(0)
  })

  it('loads with wire parity off when the member credential is missing', async () => {
    vi.stubEnv('CC_POOL_API_KEY', '')
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)
    const ctx = await mount({ ccWireParity: true })
    // The load probe waits for the member credential; the route still loads and
    // sends no capability request instead of failing.
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(capture.calls).toHaveLength(0)
    expect(ctx.llm.listProviders()).toContainEqual(expect.objectContaining({ id: PROVIDER }))

    const result = await assemble(ctx, { model: 'claude-sonnet-5-5', messages: [user('no key')] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    // Even a request that would have carried the wire stays wire-parity off.
    expect(capture.calls).toHaveLength(0)
  })

  it('persists pool request diagnostics to the configured durable sink', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const root = await temporaryDirectory()
    const logPath = join(root, 'requests.jsonl')
    const ctx = await mount({ requestLog: { path: logPath } })
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)

    await assemble(ctx, {
      model: 'claude-sonnet-5-5',
      messages: [user('durable evidence')],
      sessionId: 'session-cc-pool-log' as never,
    })

    await vi.waitFor(async () => {
      const records = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      expect(records.map(record => record['kind'])).toEqual(['request', 'response'])
      expect(records[0]).toMatchObject({
        provider: PROVIDER,
        model: 'claude-sonnet-5-5',
        endpoint: BASE_URL,
        sessionId: 'session-cc-pool-log',
        attempt: 1,
        stream: true,
      })
      expect(records[1]).toMatchObject({ status: 200 })
      expect(JSON.stringify(records)).not.toContain('durable evidence')
    }, { timeout: 5000 })
  })

  it.each<[string, Record<string, unknown>]>([
    ['a loader-materialized empty profile', {}],
    ['a configuration without the field', { models: CONFIGURED_MODELS }],
  ])('writes no request log for %s', async (_case, config) => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const home = await temporaryDirectory()
    vi.stubEnv('DSH_HOME', home)
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    const fiber = ctx.plugin(CcPool, config)
    await fiber
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)

    await assemble(ctx, {
      model: 'claude-sonnet-5-5',
      messages: [user('no default sink')],
      sessionId: 'session-cc-pool-no-default' as never,
    })
    expect(capture.calls).toHaveLength(1)

    // The pool route carries session headers, but that is not an implicit
    // request to persist anything. Disposal drains the sink's write queue, so
    // absence is observed after a mounted sink would have created the file.
    await fiber.dispose()
    await expectNoRequestLog(home)
  })

  it('persists below its own file name when requestLog is explicitly enabled', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const home = await temporaryDirectory()
    vi.stubEnv('DSH_HOME', home)
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CcPool, { requestLog: { enabled: true } })
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)

    await assemble(ctx, {
      model: 'claude-sonnet-5-5',
      messages: [user('explicit sink')],
      sessionId: 'session-cc-pool-explicit' as never,
    })

    const logPath = join(home, 'logs', 'llm-cc-pool-requests.jsonl')
    await vi.waitFor(async () => {
      const records = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      expect(records.map(record => record['kind'])).toEqual(['request', 'response'])
      expect(records[0]).toMatchObject({ sessionId: 'session-cc-pool-explicit' })
    }, { timeout: 5000 })
    // The pi-ai default file stays untouched, so one path never has two writers.
    await expect(readFile(join(home, 'logs', 'llm-pi-ai-requests.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('resolves the member credential through the mounted credentials service', async () => {
    const root = await temporaryDirectory()
    const credentialsPath = join(root, '.credentials.yaml')
    await writeFile(credentialsPath, 'version: 1\nrefs:\n  CC_POOL_API_KEY: key-from-store\n', { mode: 0o600 })
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalCredentialProvider, { path: credentialsPath, debounceMs: 10 })
    await ctx.plugin(CcPool, { requestLog: { enabled: false } })
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)

    await assemble(ctx, { model: 'claude-sonnet-5-5', messages: [user('stored key')] })
    expect(capture.calls[0]?.headers.get('x-api-key')).toBe('key-from-store')
  })

  it('serves requests with the durable sink explicitly disabled', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const root = await temporaryDirectory()
    const logPath = join(root, 'requests.jsonl')
    const ctx = await mount({ requestLog: { enabled: false, path: logPath } })
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)

    const result = await assemble(ctx, { model: 'claude-sonnet-5-5', messages: [user('no sink')] })
    expect(result.finish).toEqual({ kind: 'stop' })
    await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps serving when the durable sink cannot be written, warning once', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const root = await temporaryDirectory()
    // A regular file where the log's directory should be makes every write fail.
    const blocked = join(root, 'blocked')
    await writeFile(blocked, 'not a directory')
    const ctx = await mount({ requestLog: { path: join(blocked, 'requests.jsonl') } })
    const warnings: unknown[][] = []
    ctx.logger.exporter({
      levels: { default: 3 },
      export: (message) => { warnings.push(message.args) },
    })
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)

    const result = await assemble(ctx, { model: 'claude-sonnet-5-5', messages: [user('write anyway')] })
    await vi.waitFor(() => {
      expect(warnings.filter(args => String(args[0]).includes('request log'))).toHaveLength(1)
    }, { timeout: 5000 })
    expect(result.finish).toEqual({ kind: 'stop' })
  })

  it('degrades unusable stored replay metadata instead of failing the step', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const ctx = await mount()
    const warnings: unknown[][] = []
    ctx.logger.exporter({
      levels: { default: 3 },
      export: (message) => { warnings.push(message.args) },
    })
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)
    const poisoned = createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      source: {
        kind: 'model',
        provider: PROVIDER,
        model: 'claude-sonnet-5-5',
        // An unsupported envelope version is the adapter's degrade path.
        replayState: { response: { kind: 'pi-ai', version: 1 }, blocks: [] },
      },
    })

    const result = await assemble(ctx, {
      model: 'claude-sonnet-5-5',
      messages: [poisoned, user('continue')],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(warnings.some(args => String(args[0]).includes('unusable replay state'))).toBe(true)
  })

  it('sends a request image through the mounted attachment service', async () => {
    vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
    const ctx = await mount()
    await ctx.plugin(TestAttachmentStore)
    const fsFiber = ctx.plugin(MappedTestFileSystem)
    await fsFiber
    const capture = capturePoolFetch()
    vi.stubGlobal('fetch', capture.fetch)
    const imageMessage = createUserMessage({
      content: [{ type: 'image', attachment: TEST_IMAGE_REF }],
      source: { kind: 'model', provider: PROVIDER, model: 'claude-sonnet-5-5' },
    })

    const mapped = await assemble(ctx, { model: 'claude-sonnet-5-5', messages: [imageMessage] })
    expect(mapped.finish).toEqual({ kind: 'stop' })
    expect(JSON.stringify(capture.calls[0]?.body)).toContain(TEST_MODEL_IMAGE_PATH)

    await fsFiber.dispose()
    const unmapped = await assemble(ctx, { model: 'claude-sonnet-5-5', messages: [imageMessage] })
    expect(unmapped.finish).toEqual({ kind: 'stop' })
    expect(JSON.stringify(capture.calls[1]?.body)).not.toContain(TEST_MODEL_IMAGE_PATH)
  })
})
