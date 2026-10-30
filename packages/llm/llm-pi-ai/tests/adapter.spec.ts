import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createAssistantMessage, createToolResultMessage, createUserMessage, CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, POOL_CAPACITY_CODE, POOL_ERROR_CODE, POOL_REQUEST_CLOSED_CODE, ReasoningEffortId, userAgent } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { DEFAULT_MAX_REQUEST_IMAGE_BYTES, resolveProfiles, resolveRequestLog } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { anthropicTextEvents, closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await closeMockServers()
})

const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
}
const HOST_IMAGE_PATH = '/host/.dsh/attachments/objects/aa/object'
const MODEL_IMAGE_PATH = '/model/.dsh/attachments/objects/aa/object'

class MappedFileSystem extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  processPathFromHostPath(hostPath: string): string | undefined {
    return hostPath === HOST_IMAGE_PATH ? MODEL_IMAGE_PATH : undefined
  }
}

/** One plain user message over the given text. */
function user(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

async function harness(baseURL: string, overrides: Record<string, unknown> = {}): Promise<Context> {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: { deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL, ...overrides } },
  })
  return ctx
}

/** Direct adapter over the real profile resolver, with a fixed key per call. */
function adapterOf(
  providers: Record<string, LlmPiAi.PiAiProviderProfile>,
  apiKey: string | undefined = 'test-key',
): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles(providers),
    resolveApiKey: () => Promise.resolve(apiKey),
    auth: memoryAuth(),
  })
}

beforeEach(() => {
  // Configuration carries only the reference; these mounts resolve it from
  // the environment, which is the whole credential plane without a seam.
  vi.stubEnv('PI_TEST_KEY', 'test-key')
})

describe('PiAiAdapter provider routing', () => {
  it('uses the current protocol and retained occurrence count after switching image routes', async () => {
    const rejection = { status: 400, body: JSON.stringify({ error: { message: 'test request captured' } }) }
    const server = await mockServer([rejection, rejection, rejection])
    const common = {
      baseURL: server.url, requestImagePixelBudget: 8_000_000,
      models: [{ id: 'vision', contextWindow: 200_000, input: ['text', 'image'] as ('text' | 'image')[] }],
    }
    const profiles = resolveProfiles({
      claude: { ...common, api: 'anthropic-messages' }, other: { ...common, api: 'openai-completions' },
    })
    const readImageRequest = vi.fn(async (ref: ImageAttachmentRef, target: ImageRequestTarget): Promise<RequestImageAttachment> => ({
      attachment: ref, variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`), data: Uint8Array.of(1),
      mediaType: ref.mediaType, bytes: 1, width: target.width, height: target.height, depth: 'uchar', space: 'srgb', hasAlpha: false,
    }))
    const store: Pick<AttachmentStore, 'readImageRequest'> = { readImageRequest }
    const adapter = new PiAiAdapter({
      profiles: () => profiles, auth: memoryAuth(), resolveApiKey: async () => 'test-only', resolveAttachments: () => store as AttachmentStore,
    })
    for (const [provider, count] of [['claude', 21], ['other', 21], ['claude', 20]] as const) {
      for await (const chunk of adapter.stream({ provider, model: 'vision', messages: [{ role: 'user', content:
        Array.from({ length: count }, () => ({ type: 'image', attachment: { ...IMAGE_REF, width: 2800, height: 1400 } })),
      }] })) void chunk
    }
    const bodies = server.requests.map(body => JSON.stringify(body))
    expect(bodies).toHaveLength(3)
    expect(bodies[0]).toContain('request preview 2000x1000px')
    expect(bodies[1]).toContain('request preview 2800x1400px')
    expect(bodies[2]).toContain('request preview 2800x1400px')
    await expect(async () => {
      for await (const chunk of adapter.stream({ provider: 'claude', model: 'vision', messages: [{ role: 'user', content:
        Array.from({ length: 101 }, () => ({ type: 'image', attachment: IMAGE_REF })),
      }] })) void chunk
    }).rejects.toMatchObject({ code: 'IMAGE_OFFLOAD_REQUIRED' })
    expect(server.requests).toHaveLength(3)
  })

  it('resolves a catalog model dynamically and uses a private endpoint', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'deepseek-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      })],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
    expect(server.paths).toEqual(['/chat/completions'])
  })

  it('keeps prepared model metadata and dispatch on one profile snapshot', async () => {
    const first = await mockServer([{ events: textEvents }])
    const second = await mockServer([])
    let providers: Record<string, LlmPiAi.PiAiProviderProfile> = {
      deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: first.url },
    }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['deepseek'], new PiAiAdapter({
      profiles: () => resolveProfiles(providers),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
    }))

    const prepared = await ctx.llm.prepareCall({ provider: 'deepseek', model: 'deepseek-flash' })
    providers = { deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: second.url } }
    const chunks: unknown[] = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)

    expect(chunks.length).toBeGreaterThan(0)
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(0)
  })

  it('merges profile headers with Harness attribution winning', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, {
      headers: { 'x-company': 'private', 'User-Agent': 'wrong' },
    })
    await assemble(ctx, { model: 'deepseek-flash', messages: [] })
    expect(server.headers[0]?.['x-company']).toBe('private')
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
  })

  it('forwards common stream options and profile reasoning', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, {
      reasoning: 'max',
      cacheRetention: 'none',
      transport: 'sse',
      timeoutMs: 5000,
      websocketConnectTimeoutMs: 3000,
      streamIdleTimeoutMs: 10_000,
      thinkingBudgets: { high: 2048 },
    })
    await assemble(ctx, {
      model: 'deepseek-v4-pro',
      messages: [],
      temperature: 0.2,
      maxTokens: 77,
      sessionId: 'session-for-pi' as never,
    })
    expect(server.requests[0]).toMatchObject({
      model: 'deepseek-v4-pro',
      temperature: 0.2,
      max_tokens: 77,
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })
    expect(server.requests[0]).not.toHaveProperty('dsh_session_log')
    expect(server.requests[0]).not.toHaveProperty('dsh_plugin_packages')
  })

  it('uses a dynamic request effort and reports unsupported efforts before network I/O', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await harness(server.url, { reasoning: 'max' })

    await assemble(ctx, {
      model: 'deepseek-flash',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [],
    })
    expect(server.requests[0]).toMatchObject({ reasoning_effort: 'high' })

    await assemble(ctx, {
      model: 'deepseek-flash',
      reasoningEffort: ReasoningEffortId('off'),
      messages: [],
    })
    expect(server.requests[1]).toMatchObject({ thinking: { type: 'disabled' } })
    expect(server.requests[1]).not.toHaveProperty('reasoning_effort')

    const unsupported = await assemble(ctx, {
      model: 'deepseek-flash',
      reasoningEffort: ReasoningEffortId('xhigh'),
      messages: [],
    })
    expect(unsupported.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'UNSUPPORTED_REASONING_EFFORT' },
    })
    expect(server.requests).toHaveLength(2)
  })

  it('preserves omitted profile options when constructing the adapter directly', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['deepseek'], adapterOf({
      deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url },
    }))

    const result = await assemble(ctx, { model: 'deepseek-flash', messages: [] })

    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('names a route by its displayName, and by its own key once the profiles drop it', () => {
    const adapter = adapterOf({ 'acme-gateway': {
      displayName: 'Acme Gateway',
      api: 'openai-completions',
      baseURL: 'https://acme.test/v1',
      models: [{ id: 'acme-large' }],
    } })
    expect(adapter.providerInfo('acme-gateway')).toEqual({ id: 'acme-gateway', name: 'Acme Gateway' })

    // The registry and the profiles can disagree for a moment: a refused
    // registration swap leaves the previous routes serving while resolution
    // has already moved on, so a selector may ask about a route the current
    // profiles no longer describe. It gets the key rather than nothing.
    expect(adapter.providerInfo('departed')).toEqual({ id: 'departed', name: 'departed' })
  })

  it('reports unsupported stop sequences rather than silently ignoring them', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'deepseek-flash', messages: [], stop: ['END'] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'UNSUPPORTED_OPTION' } })
    expect(server.requests).toEqual([])
  })

  it('reports unknown catalog models before network I/O', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'not-in-the-catalog', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'UNKNOWN_MODEL' } })
    expect(server.requests).toEqual([])
  })

  it('uses the catalog API implementation, including OpenAI Responses', async () => {
    const server = await mockServer([{ status: 401, body: JSON.stringify({ error: { message: 'expected mock failure' } }) }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: { openai: { apiKeyEnv: 'PI_TEST_KEY', baseURL: `${server.url}/v1` } },
    })
    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(result.finish.kind).toBe('error')
    expect(server.paths).toEqual(['/v1/responses'])
  })

  it('resolves attachment and filesystem services mounted after the adapter when dispatching an image', async () => {
    const server = await mockServer([{ status: 401, body: JSON.stringify({ error: { message: 'expected mock failure' } }) }])
    const attachmentId = AttachmentId(`sha256:${'a'.repeat(64)}`)
    const ref: ImageAttachmentRef = {
      attachmentId,
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const readImage = vi.fn((_ref: ImageAttachmentRef): Promise<StoredImageAttachment> =>
      Promise.resolve({ ref, data: Uint8Array.of(1) }))
    const readImageRequest = vi.fn((
      value: ImageAttachmentRef,
      _target: ImageRequestTarget,
      _signal?: AbortSignal,
    ): Promise<RequestImageAttachment> => (
      Promise.resolve({
        variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
        attachment: value,
        data: Uint8Array.of(1),
        mediaType: value.mediaType,
        bytes: 1,
        width: value.width,
        height: value.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: true,
      })
    ))

    class LateAttachmentStore extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = {
        maxImageBytes: 1,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1,
        maxImagePixels: 1,
        maxImageDimension: 2000,
        mediaTypes: ['image/png'],
      }

      validateImage(_input: SaveImageAttachment): Promise<void> {
        return Promise.reject(new Error('not used'))
      }

      saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        return Promise.reject(new Error('not used'))
      }

      readImage(value: ImageAttachmentRef): Promise<StoredImageAttachment> {
        return readImage(value)
      }

      override imageHostPath(_ref: ImageAttachmentRef): string {
        return HOST_IMAGE_PATH
      }

      override readImageRequest(
        value: ImageAttachmentRef,
        policy: ImageRequestTarget,
        signal?: AbortSignal,
      ): Promise<RequestImageAttachment> {
        return readImageRequest(value, policy, signal)
      }
    }

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: { openai: { apiKeyEnv: 'PI_TEST_KEY', baseURL: `${server.url}/v1` } },
    })
    await ctx.plugin(LateAttachmentStore)
    await ctx.plugin(MappedFileSystem)

    const result = await assemble(ctx, {
      provider: 'openai',
      model: 'gpt-4.1',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: ref }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      })],
    })

    expect(result.finish.kind).toBe('error')
    expect(readImageRequest).toHaveBeenCalledWith(ref, {
      width: 1,
      height: 1,
      maxBytes: 1024 * 1024,
    }, expect.any(AbortSignal))
    expect(JSON.stringify(server.requests[0])).toContain(MODEL_IMAGE_PATH)
    expect(server.paths).toEqual(['/v1/responses'])
  })

  it('forces one wire request for an SDK-retryable provider failure', async () => {
    const server = await mockServer([
      {
        status: 429,
        headers: { 'retry-after-ms': '1' },
        body: JSON.stringify({ error: { message: 'retryable provider failure' } }),
      },
      { status: 500, body: JSON.stringify({ error: { message: 'hidden SDK retry' } }) },
      { status: 500, body: JSON.stringify({ error: { message: 'second hidden SDK retry' } }) },
    ])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: { openai: { apiKeyEnv: 'PI_TEST_KEY', baseURL: `${server.url}/v1` } },
    })

    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error' })
    expect(server.paths).toEqual(['/v1/responses'])
  })

  it('uses OpenAI Responses against an Azure project v1 path with its API key header', async () => {
    const server = await mockServer([{ status: 401, body: JSON.stringify({ error: { message: 'expected mock failure' } }) }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        openai: {
          apiKeyEnv: 'PI_TEST_KEY',
          baseURL: `${server.url}/api/projects/openai/openai/v1`,
          headers: { 'api-key': 'test-key', Authorization: '' },
        },
      },
    })
    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-5.5', messages: [] })
    expect(result.finish.kind).toBe('error')
    expect(server.paths).toEqual(['/api/projects/openai/openai/v1/responses'])
    expect(server.headers[0]?.['api-key']).toBe('test-key')
    expect(server.headers[0]?.authorization).toBe('')
  })

  it.each([
    [401, 'AUTH'],
    [400, 'INVALID_REQUEST'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
    [503, 'SERVER'],
  ] as const)('maps HTTP %s failures to %s', async (status, code) => {
    const server = await mockServer([{ status, body: JSON.stringify({ error: { message: `provider ${status}` } }) }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'deepseek-flash', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code } })
    expect(server.paths).toEqual(['/chat/completions'])
  })

  it('classifies a pool refusal by its envelope and keeps the disclosed Retry-After', async () => {
    const server = await mockServer([{
      status: 429,
      headers: { 'retry-after': '7' },
      body: JSON.stringify({
        type: 'error',
        error: {
          type: 'cc_pool_capacity_exhausted',
          origin: 'pool',
          scope: 'pool',
          retryable: true,
          message: 'all accounts are at their 2-session limit',
        },
      }),
    }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'cc-pool': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'anthropic-messages',
          baseURL: server.url,
          models: [{ id: 'claude-sonnet-4-6' }],
        },
      },
    })

    const result = await assemble(ctx, { provider: 'cc-pool', model: 'claude-sonnet-4-6', messages: [] })

    expect(server.paths).toHaveLength(1)
    expect(server.paths[0]).toMatch(/^\/v1\/messages(?:\?|$)/)
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: POOL_CAPACITY_CODE, status: 429, providerRetryAfterMs: 7_000 },
    })
    expect(result.finish.kind === 'error' ? result.finish.failure.message : '')
      .toBe('all accounts are at their 2-session limit')
  })

  it('stops on a pool readiness refusal instead of resending its ledger id', async () => {
    const readinessDetail = 'the egress path is not verified for this lease; worker detail:'
      + ' capability_not_ready: the lease maintenance is not ready'
    const server = await mockServer([
      {
        status: 503,
        body: JSON.stringify({
          pool_request_id: 'pool-request-readiness',
          type: 'error',
          error: { message: readinessDetail, type: 'api_error', retryable: false },
        }),
      },
      // A resend would repeat the ledger id, and the pool's replay guard would
      // answer with this 409 instead of the request's outcome.
      {
        status: 409,
        body: JSON.stringify({
          type: 'error',
          error: { type: 'cc_pool_request_closed', retryable: true, terminal: true, client_action: 'retry_same', message: 'request already recorded' },
        }),
      },
    ])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'cc-pool': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'anthropic-messages',
          baseURL: server.url,
          models: [{ id: 'claude-sonnet-4-6' }],
        },
      },
    })

    const result = await assemble(ctx, { provider: 'cc-pool', model: 'claude-sonnet-4-6', messages: [] })

    expect(server.paths).toHaveLength(1)
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: POOL_ERROR_CODE, status: 503, retryDisposition: 'forbid' },
    })
    expect(result.finish.kind === 'error' ? result.finish.failure.message : '')
      .toBe(readinessDetail)
  })

  it('classifies the real closed-request envelope as retryable under a fresh attempt id', async () => {
    const server = await mockServer([{
      status: 409,
      body: JSON.stringify({
        type: 'error',
        pool_request_id: 'pool-request-closed',
        error: {
          type: 'cc_pool_request_closed',
          code: 'cc_pool_request_closed',
          origin: 'pool',
          scope: 'request',
          retryable: true,
          terminal: true,
          client_action: 'retry_same',
          kind: 'request',
          status: 409,
          message: 'this client request id is already closed',
        },
      }),
    }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'cc-pool': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'anthropic-messages',
          baseURL: server.url,
          models: [{ id: 'claude-sonnet-4-6' }],
        },
      },
    })

    const result = await assemble(ctx, { provider: 'cc-pool', model: 'claude-sonnet-4-6', messages: [] })

    expect(server.paths).toHaveLength(1)
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: POOL_REQUEST_CLOSED_CODE, status: 409 },
    })
    // `terminal` refuses a replay of the closed id; the retry stamps a fresh
    // attemptNonce and x-client-request-id, so no forbid may be attached.
    const failure = result.finish.kind === 'error' ? result.finish.failure : undefined
    expect(failure?.retryDisposition).toBeUndefined()
    expect(failure?.message).toBe('this client request id is already closed')
  })

  it('forbids a pool-withdrawn native provider 5xx instead of retrying it', async () => {
    const server = await mockServer([{
      status: 503,
      body: JSON.stringify({
        pool_request_id: 'pool-request-native',
        type: 'error',
        error: { type: 'api_error', message: 'Anthropic API is temporarily overloaded', retryable: false },
      }),
    }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'cc-pool': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'anthropic-messages',
          baseURL: server.url,
          models: [{ id: 'claude-sonnet-4-6' }],
        },
      },
    })

    const result = await assemble(ctx, { provider: 'cc-pool', model: 'claude-sonnet-4-6', messages: [] })

    // The pool echoes its request id on native failures and withdrew the retry
    // there; the text classifier's retryable 5xx default must not override it.
    expect(server.paths).toHaveLength(1)
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'POOL_ERROR', retryDisposition: 'forbid' },
    })
  })

  it('keeps text classification on a protocol that rejects a custom fetch', async () => {
    const server = await mockServer([{
      status: 429,
      headers: { 'retry-after': '5' },
      body: JSON.stringify({ error: { message: 'slow down' } }),
    }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        mistral: {
          apiKeyEnv: 'PI_TEST_KEY',
          baseURL: server.url,
          models: [{ id: 'mistral-small-latest' }],
        },
      },
    })

    const result = await assemble(ctx, { provider: 'mistral', model: 'mistral-small-latest', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'RATE_LIMIT' } })
    expect(result.finish.kind === 'error' ? result.finish.failure.providerRetryAfterMs : undefined)
      .toBeUndefined()
  })

  it('uses the resolved catalog context window for usage-based overflow detection', async () => {
    const model = getBuiltinModels('deepseek').find(candidate => candidate.id === 'deepseek-flash')
    if (model === undefined) throw new Error('deepseek-flash missing from pi-ai test catalog')
    const events = [
      '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
      JSON.stringify({
        choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
        usage: { prompt_tokens: model.contextWindow + 1, completion_tokens: 0 },
      }),
      '[DONE]',
    ]
    const server = await mockServer([{ events }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, { model: model.id, messages: [] })

    expect(result.finish).toEqual({
      kind: 'error',
      failure: {
        message: `pi-ai detected context overflow for model "${model.id}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    })
  })

  it('stops the SDK request when the adapter idle watchdog expires', async () => {
    const server = await mockServer([{ holdOpen: true }])
    const ctx = await harness(server.url, { streamIdleTimeoutMs: 20 })
    const controller = new AbortController()
    onTestFinished(async () => {
      controller.abort()
      await ctx.fiber.dispose()
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const pending = assemble(ctx, { model: 'deepseek-flash', messages: [], signal: controller.signal })
    await server.requestReceived
    expect(server.closedResponses).toBe(0)
    await vi.advanceTimersByTimeAsync(20)
    vi.useRealTimers()

    const result = await pending
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'TIMEOUT' } })
    await server.responseClosed

    expect(server.paths).toEqual(['/chat/completions'])
    expect(server.closedResponses).toBe(1)
  })
})

describe('Claude Code session identity headers', () => {
  const MODEL = 'claude-sonnet-4-6'
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  /** One conversation-aware route and one plain route over the same endpoint. */
  async function sessionHarness(
    baseURL: string,
    sessionHeaders: string | string[],
    overrides: Record<string, unknown> = {},
  ): Promise<Context> {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      sessionHeaders,
      // These cases assert headers only. Persistence has its own cases over a
      // temporary path, so the default harness-home sink must stay off.
      requestLog: { enabled: false },
      providers: {
        'cc-pool': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'anthropic-messages',
          baseURL,
          models: [{ id: MODEL }],
          ...overrides,
        },
        anthropic: {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'anthropic-messages',
          baseURL,
          models: [{ id: MODEL }],
        },
      },
    })
    return ctx
  }

  const prompt = (text: string) => createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'cc-pool', model: MODEL },
  })

  it('stamps an opted-in route with the stable session id and a per-request ledger id', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }, { events: anthropicTextEvents }])
    const ctx = await sessionHarness(server.url, 'cc-pool')
    const sessionId = 'session-cc-pool-stable' as never

    await assemble(ctx, { provider: 'cc-pool', model: MODEL, messages: [prompt('first')], sessionId })
    await assemble(ctx, { provider: 'cc-pool', model: MODEL, messages: [prompt('second')], sessionId })

    expect(server.headers[0]?.['x-claude-code-session-id']).toBe('session-cc-pool-stable')
    expect(server.headers[1]?.['x-claude-code-session-id']).toBe('session-cc-pool-stable')
    expect(server.headers[0]?.['x-client-request-id']).toMatch(UUID_PATTERN)
    expect(server.headers[1]?.['x-client-request-id']).toMatch(UUID_PATTERN)
    expect(server.headers[1]?.['x-client-request-id']).not.toBe(server.headers[0]?.['x-client-request-id'])
  })

  it('sends the percent-encoded session display name beside the unchanged session id', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await sessionHarness(server.url, 'cc-pool')

    await assemble(ctx, {
      provider: 'cc-pool',
      model: MODEL,
      messages: [prompt('named')],
      sessionId: 'session-cc-pool-named' as never,
      sessionName: 'Fix café / 100%',
    })

    expect(server.headers[0]?.['x-cc-session-name']).toBe('Fix%20caf%C3%A9%20%2F%20100%25')
    expect(server.headers[0]?.['x-claude-code-session-id']).toBe('session-cc-pool-named')
    expect(server.headers[0]?.['x-client-request-id']).toMatch(UUID_PATTERN)
  })

  it('sends no name header when the request carries no session name', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await sessionHarness(server.url, 'cc-pool')

    await assemble(ctx, { provider: 'cc-pool', model: MODEL, messages: [prompt('unnamed')], sessionId: 'session-unnamed' as never })

    expect(server.headers[0]?.['x-cc-session-name']).toBeUndefined()
    expect(server.headers[0]?.['x-claude-code-session-id']).toBe('session-unnamed')
  })

  it('drops an oversized session name without failing the request', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await sessionHarness(server.url, 'cc-pool')

    const result = await assemble(ctx, {
      provider: 'cc-pool',
      model: MODEL,
      messages: [prompt('long name')],
      sessionId: 'session-cc-pool-long' as never,
      sessionName: '山'.repeat(57),
    })

    expect(result.finish).toMatchObject({ kind: 'stop' })
    expect(server.headers[0]?.['x-cc-session-name']).toBeUndefined()
    expect(server.headers[0]?.['x-claude-code-session-id']).toBe('session-cc-pool-long')
  })

  it('sanitizes the bidi and zero-width scalars the pool refuses instead of failing the request', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await sessionHarness(server.url, 'cc-pool')

    const result = await assemble(ctx, {
      provider: 'cc-pool',
      model: MODEL,
      messages: [prompt('zwj emoji')],
      sessionId: 'session-cc-pool-zwj' as never,
      sessionName: '👨‍💻',
    })

    expect(result.finish).toMatchObject({ kind: 'stop' })
    // The joiner is dropped; the adjacent emoji still travel percent-encoded.
    expect(server.headers[0]?.['x-cc-session-name']).toBe('%F0%9F%91%A8%F0%9F%92%BB')
    expect(server.headers[0]?.['x-claude-code-session-id']).toBe('session-cc-pool-zwj')
  })

  it('sends no name header when sanitation leaves nothing usable', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }, { events: anthropicTextEvents }])
    const ctx = await sessionHarness(server.url, 'cc-pool')

    await assemble(ctx, {
      provider: 'cc-pool',
      model: MODEL,
      messages: [prompt('reserved name')],
      sessionId: 'session-cc-pool-reserved' as never,
      sessionName: '空闲',
    })
    await assemble(ctx, {
      provider: 'cc-pool',
      model: MODEL,
      messages: [prompt('blank name')],
      sessionId: 'session-cc-pool-blank' as never,
      sessionName: ' \u200B ',
    })

    expect(server.headers[0]?.['x-cc-session-name']).toBeUndefined()
    expect(server.headers[1]?.['x-cc-session-name']).toBeUndefined()
    expect(server.headers[1]?.['x-claude-code-session-id']).toBe('session-cc-pool-blank')
  })

  it('leaves the request body identical when a name is present', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }, { events: anthropicTextEvents }])
    const ctx = await sessionHarness(server.url, 'cc-pool')
    const messages = [prompt('body parity')]

    await assemble(ctx, { provider: 'cc-pool', model: MODEL, messages, sessionId: 'session-nameless' as never })
    await assemble(ctx, {
      provider: 'cc-pool',
      model: MODEL,
      messages,
      sessionId: 'session-nameless' as never,
      sessionName: 'A display name',
    })

    expect(server.requests[1]).toEqual(server.requests[0])
  })

  it('replaces lowercase profile session headers instead of sending two values for one field', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await sessionHarness(server.url, 'cc-pool', {
      headers: {
        // Header names are case-insensitive, so these collide with the
        // adapter-owned names the pool route always sends.
        'x-claude-code-session-id': 'profile-session',
        'x-cc-session-name': 'profile-name',
        'x-client-request-id': 'profile-ledger-id',
      },
    })

    await assemble(ctx, {
      provider: 'cc-pool',
      model: MODEL,
      messages: [prompt('collision')],
      sessionId: 'session-cc-pool-collision' as never,
      sessionName: 'Adapter name',
    })

    expect(server.headers[0]?.['x-claude-code-session-id']).toBe('session-cc-pool-collision')
    expect(server.headers[0]?.['x-cc-session-name']).toBe('Adapter%20name')
    expect(server.headers[0]?.['x-client-request-id']).toMatch(UUID_PATTERN)
    expect(server.headers[0]?.['x-client-request-id']).not.toBe('profile-ledger-id')
  })

  it('keeps one ledger id within an attempt and sends a new one for every deliberate retry', async () => {
    const server = await mockServer([
      { events: anthropicTextEvents },
      { events: anthropicTextEvents },
      { events: anthropicTextEvents },
      { events: anthropicTextEvents },
    ])
    const ctx = await sessionHarness(server.url, 'cc-pool')
    const sessionId = 'session-cc-pool-retry' as never
    const first = prompt('retry the same request')
    const options = { provider: 'cc-pool', model: MODEL, messages: [first], sessionId }

    await assemble(ctx, options)
    await assemble(ctx, options)
    await assemble(ctx, { ...options, attemptNonce: 'retry-1' })
    await assemble(ctx, { ...options, attemptNonce: 'retry-2' })

    // Dispatches of one attempt share the id; each retry stamps a new attempt
    // id, so the pool's ledger never answers a retry as a replay.
    const ids = server.headers.map(headers => headers['x-client-request-id'])
    expect(ids[0]).toMatch(UUID_PATTERN)
    expect(ids).toEqual([ids[0], ids[0], expect.any(String), expect.any(String)])
    expect(new Set(ids).size).toBe(3)
    expect(server.headers[1]?.['x-claude-code-session-id']).toBe('session-cc-pool-retry')
    expect(server.headers[3]?.['x-claude-code-session-id']).toBe('session-cc-pool-retry')
  })

  it('keeps one conversation identity across a tool continuation', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }, { events: anthropicTextEvents }])
    const ctx = await sessionHarness(server.url, ['cc-pool'])
    const sessionId = 'session-cc-pool-continuation' as never
    const first = prompt('read the file')
    const callId = 'call-read-1' as never

    await assemble(ctx, { provider: 'cc-pool', model: MODEL, messages: [first], sessionId })
    await assemble(ctx, {
      provider: 'cc-pool',
      model: MODEL,
      sessionId,
      messages: [
        first,
        createAssistantMessage({
          content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"a.txt"}' }],
          source: { provider: 'cc-pool', model: MODEL },
        }),
        createToolResultMessage({ callId, content: [{ type: 'text', text: 'contents' }], isError: false }),
      ],
    })

    // The endpoint keys its persistent conversation and prompt identity by this
    // header; the continuation must present the same identity while remaining a
    // separate logical attempt.
    expect(server.headers[1]?.['x-claude-code-session-id']).toBe('session-cc-pool-continuation')
    expect(server.headers[1]?.['x-client-request-id']).not.toBe(server.headers[0]?.['x-client-request-id'])
    const continuation = server.requests[1] as { messages: { role: string; content: { type: string }[] }[] }
    expect(continuation.messages.at(-1)?.content.some(block => block.type === 'tool_result')).toBe(true)
  })

  it('leaves a route outside the switch without Claude Code identity headers', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await sessionHarness(server.url, 'cc-pool')

    await assemble(ctx, {
      provider: 'anthropic',
      model: MODEL,
      messages: [prompt('plain')],
      sessionId: 'session-plain' as never,
      sessionName: 'Not a pool route',
    })

    expect(server.headers[0]?.['x-claude-code-session-id']).toBeUndefined()
    expect(server.headers[0]?.['x-client-request-id']).toBeUndefined()
    expect(server.headers[0]?.['x-cc-session-name']).toBeUndefined()
  })

  it('sends the request id but no session header when the request has no session id', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await sessionHarness(server.url, 'cc-pool')

    await assemble(ctx, { provider: 'cc-pool', model: MODEL, messages: [prompt('title request')] })

    expect(server.headers[0]?.['x-claude-code-session-id']).toBeUndefined()
    expect(server.headers[0]?.['x-client-request-id']).toMatch(UUID_PATTERN)
  })

  it('keeps an adapter-owned session header over a static profile header of the same name', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await sessionHarness(server.url, 'cc-pool', {
      headers: { 'X-Claude-Code-Session-Id': 'profile-claims-this', 'x-company': 'private' },
    })

    await assemble(ctx, { provider: 'cc-pool', model: MODEL, messages: [prompt('hi')], sessionId: 'session-owned' as never })

    expect(server.headers[0]?.['x-claude-code-session-id']).toBe('session-owned')
    expect(server.headers[0]?.['x-company']).toBe('private')
  })

  it.each([
    ['a non-ASCII value', 'session-café'],
    ['an over-long value', 's'.repeat(257)],
  ])('refuses %s before any network I/O', async (_case, sessionId) => {
    const server = await mockServer([])
    const ctx = await sessionHarness(server.url, 'cc-pool')

    const result = await assemble(
      ctx,
      { provider: 'cc-pool', model: MODEL, messages: [prompt('hi')], sessionId: sessionId as never },
    )

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'INVALID_REQUEST' } })
    expect(server.requests).toHaveLength(0)
  })

  it('writes no default request log below the harness home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-pi-request-log-'))
    onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
    vi.stubEnv('DSH_HOME', home)
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await sessionHarness(server.url, 'cc-pool')

    // The unconfigured production default is unchanged: a session-header route
    // still resolves its file below the harness home.
    expect(resolveRequestLog(undefined, new Set(['cc-pool']))?.path)
      .toBe(join(home, 'logs', 'llm-pi-ai-requests.jsonl'))
    await assemble(ctx, {
      provider: 'cc-pool', model: MODEL, messages: [prompt('no log')], sessionId: 'session-no-log' as never,
    })
    await ctx.fiber.dispose()

    // This harness disables the sink, so that default stays unwritten.
    await expect(readFile(join(home, 'logs', 'llm-pi-ai-requests.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('request diagnostics', () => {
  const MODEL = 'claude-sonnet-4-6'
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const REQUEST_KEYS = ['attempt', 'clientRequestId', 'endpoint', 'kind', 'model', 'provider', 'sessionId', 'stream'].sort()
  const RESPONSE_KEYS = [...REQUEST_KEYS, 'status'].sort()

  /** The diagnostic event at one index, failing loudly when the adapter emitted fewer. */
  function eventAt(events: readonly LlmPiAi.PiAiRequestDiagnostic[], index: number): LlmPiAi.PiAiRequestDiagnostic {
    const event = events[index]
    if (event === undefined) throw new Error(`missing diagnostic event ${index}`)
    return event
  }

  /** Direct adapter over the real profile resolver, recording every diagnostic event. */
  function diagnosticAdapter(
    baseURL: string,
    events: LlmPiAi.PiAiRequestDiagnostic[],
    extras: {
      input?: readonly ('text' | 'image')[]
      streamIdleTimeoutMs?: number
      attachments?: AttachmentStore
      ledgerRoutes?: (provider: string) => boolean
    } = {},
  ): PiAiAdapter {
    return new PiAiAdapter({
      profiles: () => resolveProfiles({
        'cc-pool': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'anthropic-messages',
          baseURL,
          ...extras.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: extras.streamIdleTimeoutMs },
          models: [{ id: MODEL, ...extras.input === undefined ? {} : { input: [...extras.input] } }],
        },
        anthropic: { apiKeyEnv: 'PI_TEST_KEY', api: 'anthropic-messages', baseURL, models: [{ id: MODEL }] },
      }),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
      sessionHeaders: new Set(['cc-pool']),
      ...extras.ledgerRoutes === undefined ? {} : { ledgerRoutes: extras.ledgerRoutes },
      onRequestDiagnostic: (event) => { events.push(event) },
      ...extras.attachments === undefined ? {} : { resolveAttachments: () => extras.attachments },
    })
  }

  async function drain(adapter: PiAiAdapter, options: GenerateOptions): Promise<void> {
    for await (const _chunk of adapter.stream(options)) { /* drain */ }
  }

  /** One conversation-aware route and one plain route over the same endpoint. */
  async function poolHarness(baseURL: string): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      sessionHeaders: 'cc-pool',
      // This case asserts logger records only, so the default durable sink
      // stays off instead of writing below the harness home.
      requestLog: { enabled: false },
      providers: {
        'cc-pool': { apiKeyEnv: 'PI_TEST_KEY', api: 'anthropic-messages', baseURL, models: [{ id: MODEL }] },
        anthropic: { apiKeyEnv: 'PI_TEST_KEY', api: 'anthropic-messages', baseURL, models: [{ id: MODEL }] },
      },
    })
    return ctx
  }

  it('reports one structured request/response pair per attempt, with a distinct id per retry', async () => {
    const server = await mockServer([
      { events: anthropicTextEvents },
      { events: anthropicTextEvents },
      { events: anthropicTextEvents },
    ])
    const events: LlmPiAi.PiAiRequestDiagnostic[] = []
    const adapter = diagnosticAdapter(server.url, events)
    const sessionId = 'session-diagnostics' as never
    const first = user('first')
    const options: GenerateOptions = { provider: 'cc-pool', model: MODEL, messages: [first], sessionId }

    await drain(adapter, options)
    await drain(adapter, { ...options, attemptNonce: 'retry-1' })
    await drain(adapter, { ...options, messages: [first, user('second')] })

    expect(events).toHaveLength(6)
    const request = eventAt(events, 0)
    expect(request.clientRequestId).toMatch(UUID_PATTERN)
    expect(request).toEqual({
      kind: 'request',
      provider: 'cc-pool',
      model: MODEL,
      endpoint: server.url,
      sessionId: 'session-diagnostics',
      clientRequestId: request.clientRequestId,
      stream: true,
      attempt: 1,
    })
    // The settled response repeats the attempt's identity.
    expect(eventAt(events, 1)).toEqual({
      kind: 'response',
      provider: 'cc-pool',
      model: MODEL,
      endpoint: server.url,
      sessionId: 'session-diagnostics',
      clientRequestId: request.clientRequestId,
      stream: true,
      attempt: 1,
      status: 200,
    })
    // The retry is the second attempt of the same logical request, but the
    // endpoint receives a new ledger id so it cannot read it as a replay.
    const retried = eventAt(events, 2)
    expect(retried).toMatchObject({ kind: 'request', attempt: 2 })
    expect(retried.clientRequestId).not.toBe(request.clientRequestId)
    expect(eventAt(events, 3)).toMatchObject({
      kind: 'response',
      attempt: 2,
      status: 200,
      clientRequestId: retried.clientRequestId,
    })
    const next = eventAt(events, 4)
    expect(next).toMatchObject({ kind: 'request', attempt: 1 })
    expect(next.clientRequestId).not.toBe(request.clientRequestId)
    // Identity and outcome only: no messages, request body, credentials, or tokens.
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(
        event.kind === 'response' ? RESPONSE_KEYS : REQUEST_KEYS,
      )
    }
  })

  it('reports a refusal with its status, pool request id, code, and message', async () => {
    const server = await mockServer([{
      status: 429,
      headers: { 'retry-after': '7', 'x-cc-pool-request-id': 'pool-request-9' },
      body: JSON.stringify({
        type: 'error',
        error: {
          type: 'cc_pool_capacity_exhausted',
          origin: 'pool',
          scope: 'pool',
          retryable: true,
          message: 'all accounts are at their session limit',
        },
      }),
    }])
    const events: LlmPiAi.PiAiRequestDiagnostic[] = []
    const adapter = diagnosticAdapter(server.url, events)

    await drain(adapter, {
      provider: 'cc-pool', model: MODEL, messages: [user('hello')], sessionId: 'session-refusal' as never,
    })

    const response = eventAt(events, 1)
    expect(response).toMatchObject({
      kind: 'response',
      attempt: 1,
      status: 429,
      poolRequestId: 'pool-request-9',
      code: POOL_CAPACITY_CODE,
    })
    expect(response).toHaveProperty('message', expect.stringContaining('all accounts are at their session limit'))
    expect(Object.keys(response).sort()).toEqual([...RESPONSE_KEYS, 'code', 'message', 'poolRequestId'].sort())
  })

  it('reports the pool A-unavailable marker on the refusal that carries it', async () => {
    const server = await mockServer([{
      status: 503,
      headers: { 'x-cc-wire-parity-unavailable': '1' },
      body: JSON.stringify({
        type: 'error',
        error: { type: 'cc_wire_parity_unavailable', message: 'the selected worker does not advertise ccWireParity' },
      }),
    }])
    const events: LlmPiAi.PiAiRequestDiagnostic[] = []
    const adapter = diagnosticAdapter(server.url, events)

    await drain(adapter, {
      provider: 'cc-pool', model: MODEL, messages: [user('hello')], sessionId: 'session-parity-a' as never,
    })

    const response = eventAt(events, 1)
    expect(response).toMatchObject({ kind: 'response', attempt: 1, status: 503, wireParityUnavailable: true })
    expect(Object.keys(response).sort()).toEqual([...RESPONSE_KEYS, 'code', 'message', 'wireParityUnavailable'].sort())
  })

  it('reports a failed attempt with the response it observed and the thrown cause', async () => {
    const server = await mockServer([{ holdOpen: true }])
    const events: LlmPiAi.PiAiRequestDiagnostic[] = []
    const adapter = diagnosticAdapter(server.url, events, { streamIdleTimeoutMs: 20 })

    const failure = await drain(adapter, {
      provider: 'cc-pool', model: MODEL, messages: [user('hang')], sessionId: 'session-timeout' as never,
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'TIMEOUT' })
    const response = eventAt(events, 1)
    expect(response).toMatchObject({ kind: 'response', status: 200, code: 'TIMEOUT', attempt: 1 })
    expect(response).toHaveProperty('cause', expect.any(String))
  })

  it('reports a failure that never opened a provider request', async () => {
    const server = await mockServer([])
    const events: LlmPiAi.PiAiRequestDiagnostic[] = []
    const attachments: Pick<AttachmentStore, 'readImageRequest'> = {
      readImageRequest: () => Promise.reject(new Error('attachment store offline')),
    }
    const adapter = diagnosticAdapter(server.url, events, {
      input: ['text', 'image'],
      attachments: attachments as AttachmentStore,
    })
    const image = createUserMessage({ content: [{ type: 'image', attachment: IMAGE_REF }], source: { kind: 'user' } })

    await expect(drain(adapter, {
      provider: 'cc-pool', model: MODEL, messages: [image], sessionId: 'session-image' as never,
    })).rejects.toThrow('attachment store offline')

    expect(server.requests).toHaveLength(0)
    const response = eventAt(events, 1)
    expect(response).toMatchObject({ kind: 'response', attempt: 1 })
    expect(response).not.toHaveProperty('status')
    expect(response).not.toHaveProperty('code')
    expect(response).toHaveProperty('cause', expect.stringContaining('attachment store offline'))
  })

  it('reports a network failure with the transport cause chain', async () => {
    const events: LlmPiAi.PiAiRequestDiagnostic[] = []
    const adapter = diagnosticAdapter('http://127.0.0.1:1', events)

    await drain(adapter, {
      provider: 'cc-pool', model: MODEL, messages: [user('unreachable')], sessionId: 'session-offline' as never,
    })

    const response = eventAt(events, 1)
    expect(response).toMatchObject({ kind: 'response', attempt: 1, code: 'TRANSPORT' })
    expect(response).not.toHaveProperty('status')
    expect(response).toHaveProperty('cause', expect.stringContaining('fetch failed'))
  })

  it('reports a refused request that never reached the provider', async () => {
    const server = await mockServer([])
    const events: LlmPiAi.PiAiRequestDiagnostic[] = []
    const adapter = diagnosticAdapter(server.url, events)

    await expect(drain(adapter, {
      provider: 'cc-pool', model: MODEL, messages: [user('hi')], sessionId: 'session-café' as never,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    expect(server.requests).toHaveLength(0)
    expect(eventAt(events, 0)).toMatchObject({ kind: 'request', attempt: 1 })
    const response = eventAt(events, 1)
    expect(response).toMatchObject({ kind: 'response', code: 'INVALID_REQUEST' })
    expect(response).not.toHaveProperty('status')
  })

  it('derives a different ledger id for a different purpose over the same messages', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }, { events: anthropicTextEvents }])
    const events: LlmPiAi.PiAiRequestDiagnostic[] = []
    const adapter = diagnosticAdapter(server.url, events)
    const sessionId = 'session-purpose' as never
    const messages = [user('summarize')]

    await drain(adapter, { provider: 'cc-pool', model: MODEL, messages, sessionId })
    await drain(adapter, { provider: 'cc-pool', model: MODEL, messages, sessionId, purpose: 'compaction' })

    expect(eventAt(events, 2).clientRequestId).not.toBe(eventAt(events, 0).clientRequestId)
  })

  it('distinguishes one-shot message content that carries no durable id', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }, { events: anthropicTextEvents }])
    const events: LlmPiAi.PiAiRequestDiagnostic[] = []
    const adapter = diagnosticAdapter(server.url, events)
    const oneShot = (text: string): GenerateOptions => ({
      provider: 'cc-pool',
      model: MODEL,
      sessionId: 'session-one-shot' as never,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })

    await drain(adapter, oneShot('first one-shot'))
    await drain(adapter, oneShot('second one-shot'))

    // A request-only input has no durable identity, so its content is hashed
    // into the conversation position and two different inputs cannot collide.
    expect(eventAt(events, 0).clientRequestId).toMatch(UUID_PATTERN)
    expect(eventAt(events, 2).clientRequestId).not.toBe(eventAt(events, 0).clientRequestId)
  })

  it('derives no ledger identity for a route outside the gates', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const events: LlmPiAi.PiAiRequestDiagnostic[] = []
    const adapter = diagnosticAdapter(server.url, events)

    await drain(adapter, {
      provider: 'anthropic',
      model: MODEL,
      messages: [user('plain route')],
      sessionId: 'session-plain' as never,
    })

    // A route with no session headers and no persisted record never reads the
    // derived identity, so it is absent rather than copied onto the event.
    expect(eventAt(events, 0)).toEqual({
      kind: 'request',
      provider: 'anthropic',
      model: MODEL,
      endpoint: server.url,
      sessionId: 'session-plain',
      stream: true,
    })
    for (const event of events) {
      expect(event).not.toHaveProperty('clientRequestId')
      expect(event).not.toHaveProperty('attempt')
    }
  })

  it('derives the ledger identity for a route a persistent log covers', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const events: LlmPiAi.PiAiRequestDiagnostic[] = []
    const adapter = diagnosticAdapter(server.url, events, { ledgerRoutes: provider => provider === 'anthropic' })

    await drain(adapter, {
      provider: 'anthropic',
      model: MODEL,
      messages: [user('persisted plain route')],
      sessionId: 'session-persisted' as never,
    })

    const request = eventAt(events, 0)
    expect(request).toMatchObject({ kind: 'request', attempt: 1 })
    expect(request.clientRequestId).toMatch(UUID_PATTERN)
    expect(eventAt(events, 1)).toMatchObject({
      kind: 'response',
      attempt: 1,
      clientRequestId: request.clientRequestId,
    })
  })

  it('bounds the attempt counters it retains', async () => {
    const server = await mockServer(Array.from({ length: 67 }, () => ({ events: anthropicTextEvents })))
    const events: LlmPiAi.PiAiRequestDiagnostic[] = []
    const adapter = diagnosticAdapter(server.url, events)
    const options = (index: number): GenerateOptions => ({
      provider: 'cc-pool',
      model: MODEL,
      messages: [user(`message ${index}`)],
      sessionId: `session-${index}` as never,
    })

    for (let index = 0; index < 65; index += 1) await drain(adapter, options(index))
    // The bounded cache dropped the oldest session; retrying it numbers its
    // attempts from one again, where an unbounded cache would report 2 and 3.
    const retried = options(0)
    await drain(adapter, retried)
    await drain(adapter, retried)

    expect(events).toHaveLength(134)
    expect(eventAt(events, 130)).toMatchObject({ kind: 'request', attempt: 1 })
    expect(eventAt(events, 132)).toMatchObject({
      kind: 'request',
      attempt: 2,
      clientRequestId: eventAt(events, 130).clientRequestId,
    })
  })

  it('logs the correlation fields through the plugin logger', async () => {
    const server = await mockServer([
      { events: anthropicTextEvents },
      { status: 429, body: JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }) },
      { events: anthropicTextEvents },
    ])
    const ctx = await poolHarness(server.url)
    const logged: { type: string; args: unknown[] }[] = []
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logged.push({ type: message.type, args: message.args }) } })
    const sessionId = 'session-logged' as never

    await assemble(ctx, { provider: 'cc-pool', model: MODEL, messages: [user('first')], sessionId })
    await assemble(ctx, { provider: 'cc-pool', model: MODEL, messages: [user('second')], sessionId })
    await assemble(ctx, { provider: 'anthropic', model: MODEL, messages: [user('plain')], sessionId })

    // A pool route logs at INFO, where a deployment's default sink retains it;
    // other routes stay at DEBUG.
    const requests = logged.filter(entry => entry.args[0] === 'llm-pi-ai: model request %o')
    expect(requests.map(entry => entry.type)).toEqual(['info', 'info', 'debug'])
    const request = requests[0]?.args[1]
    expect(request).toMatchObject({
      provider: 'cc-pool',
      model: MODEL,
      endpoint: server.url,
      sessionId: 'session-logged',
      stream: true,
      attempt: 1,
    })
    expect(request).toHaveProperty('clientRequestId', expect.stringMatching(UUID_PATTERN))
    expect(request).not.toHaveProperty('messages')
    expect(request).not.toHaveProperty('body')

    const responses = logged.filter(entry => entry.args[0] === 'llm-pi-ai: model request response %o')
    expect(responses.map(entry => entry.type)).toEqual(['info', 'debug'])
    expect(responses[1]?.args[1]).toMatchObject({ status: 200, provider: 'anthropic' })

    const failures = logged.filter(entry => entry.args[0] === 'llm-pi-ai: model request failed %o')
    expect(failures.map(entry => entry.type)).toEqual(['warn'])
    expect(failures[0]?.args[1]).toMatchObject({ provider: 'cc-pool', status: 429, code: 'RATE_LIMIT', attempt: 1 })
    // The retained route's process line carries the facts, not the provider text
    // or the endpoint's secrets: the durable sink records the same route.
    expect(failures[0]?.args[1]).not.toHaveProperty('message')
    expect(failures[0]?.args[1]).not.toHaveProperty('cause')
  })
})

describe('persistent request log', () => {
  const MODEL = 'claude-sonnet-4-6'
  const REQUEST_KEYS = ['attempt', 'clientRequestId', 'endpoint', 'kind', 'model', 'provider', 'sessionId', 'stream', 'ts'].sort()
  const RESPONSE_KEYS = [...REQUEST_KEYS, 'status'].sort()

  /** One pool route and one plain route over the same endpoint, both persisted from the same file. */
  async function logHarness(baseURL: string, requestLog: LlmPiAi.PiAiRequestLogProfile): Promise<{ ctx: Context; path: string }> {
    const home = await mkdtemp(join(tmpdir(), 'dsh-pi-request-log-'))
    onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
    const path = requestLog.path ?? join(home, 'logs', 'requests.jsonl')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      sessionHeaders: 'cc-pool',
      requestLog: { ...requestLog, path },
      providers: {
        'cc-pool': { apiKeyEnv: 'PI_TEST_KEY', api: 'anthropic-messages', baseURL, models: [{ id: MODEL }] },
        anthropic: { apiKeyEnv: 'PI_TEST_KEY', api: 'anthropic-messages', baseURL, models: [{ id: MODEL }] },
      },
    })
    return { ctx, path }
  }

  /** Parsed NDJSON records of one request log, read after the plugin flushed on dispose. */
  async function records(path: string): Promise<Record<string, unknown>[]> {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  }

  it('persists one request/response pair for the pool route and leaves other routes out', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }, { events: anthropicTextEvents }])
    const { ctx, path } = await logHarness(server.url, {})
    const sessionId = 'session-persisted' as never

    await assemble(ctx, { provider: 'cc-pool', model: MODEL, messages: [user('persist this')], sessionId })
    await assemble(ctx, { provider: 'anthropic', model: MODEL, messages: [user('plain route')], sessionId })
    let written: Record<string, unknown>[] = []
    await vi.waitFor(async () => {
      written = await records(path)
      expect(written).toHaveLength(2)
    })
    await ctx.fiber.dispose()

    expect(written[0]).toMatchObject({
      kind: 'request',
      provider: 'cc-pool',
      model: MODEL,
      endpoint: server.url,
      sessionId: 'session-persisted',
      stream: true,
      attempt: 1,
    })
    expect(Object.keys(written[0] ?? {}).sort()).toEqual(REQUEST_KEYS)
    expect(written[1]).toMatchObject({ kind: 'response', provider: 'cc-pool', attempt: 1, status: 200 })
    expect(Object.keys(written[1] ?? {}).sort()).toEqual(RESPONSE_KEYS)
    // Identity and outcome only: no messages, request body, credential, token, or title.
    const text = JSON.stringify(written)
    for (const absent of ['persist this', 'plain route', 'messages', 'body', 'token', 'cookie', 'proxyPassword', 'title']) {
      expect(text).not.toContain(absent)
    }
  })

  it('persists every route when the log is explicitly enabled', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }, { events: anthropicTextEvents }])
    const { ctx, path } = await logHarness(server.url, { enabled: true })

    await assemble(ctx, { provider: 'cc-pool', model: MODEL, messages: [user('pool')] })
    await assemble(ctx, { provider: 'anthropic', model: MODEL, messages: [user('plain')] })
    await vi.waitFor(async () => {
      expect((await records(path)).map(record => record['provider']))
        .toEqual(['cc-pool', 'cc-pool', 'anthropic', 'anthropic'])
    })
    await ctx.fiber.dispose()
  })

  it('writes nothing when the log is explicitly disabled', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const { ctx, path } = await logHarness(server.url, { enabled: false })

    await assemble(ctx, { provider: 'cc-pool', model: MODEL, messages: [user('still served')] })
    await ctx.fiber.dispose()

    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a request working when the log cannot be written, warning once', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }, { events: anthropicTextEvents }])
    const { ctx, path } = await logHarness(server.url, { enabled: true })
    const logged: { type: string; args: unknown[] }[] = []
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logged.push({ type: message.type, args: message.args }) } })
    // A regular file where the log's directory should be makes every write fail.
    await writeFile(dirname(path), 'not a directory')

    const result = await assemble(ctx, { provider: 'anthropic', model: MODEL, messages: [user('write anyway')] })
    await vi.waitFor(() => {
      expect(logged.filter(entry => entry.type === 'warn' && String(entry.args[0]).includes('request log'))).toHaveLength(1)
    })
    await ctx.fiber.dispose()

    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
  })
})

describe('provider profile lifecycle', () => {
  it('keeps adapter helpers off the package root', () => {
    for (const helper of [
      'resolveProfiles',
      'toPiContext',
      'toPiReplayState',
      'toPiAssistant',
      'mapStopReason',
      'mapUsage',
      'toStreamChunks',
    ]) expect(LlmPiAi).not.toHaveProperty(helper)
  })

  it('registers every profile atomically and unregisters on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(LlmPiAi, {
      providers: {
        openai: {
          retryPolicy: {
            mode: 'always',
            backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 },
          },
        },
        anthropic: {},
      },
    })
    expect(ctx.llm.listProviders()).toEqual([
      { id: 'openai', name: 'openai' },
      { id: 'anthropic', name: 'anthropic' },
    ])
    expect(ctx.llm.providerRetryPolicy('openai')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
      providerWaitMaxMs: 100,
    })
    expect(ctx.llm.providerRetryPolicy('anthropic')).toMatchObject({
      mode: 'normal',
      maxRetries: 5,
    })
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('exposes the installed pi-ai model catalog through provider-neutral metadata', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { openai: {} } })
    const models = await ctx.llm.listModels('openai')
    expect(models.find(model => model.id === 'gpt-4.1')).toEqual({
      provider: 'openai', id: 'gpt-4.1', name: 'GPT-4.1',
      inputModalities: ['text', 'image'],
    })
    expect(models.every(model => model.provider === 'openai')).toBe(true)
    const info = await ctx.llm.resolveModelInfo('openai', 'gpt-4.1')
    expect(typeof info.context?.contextWindow).toBe('number')
  })

  it('exposes pi-ai model thinking levels verbatim without inventing a provider default', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: { deepseek: {}, openai: {} },
    })

    await expect(ctx.llm.resolveModelInfo('deepseek', 'deepseek-flash'))
      .resolves.toMatchObject({
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('off'), name: 'Off' },
            { id: ReasoningEffortId('low'), name: 'Low' },
            { id: ReasoningEffortId('high'), name: 'High' },
            { id: ReasoningEffortId('max'), name: 'Max' },
          ],
        },
      })
    const extended = await ctx.llm.resolveModelInfo('openai', 'gpt-5.6-sol')
    expect(extended.reasoning?.efforts.map(effort => effort.id)).toEqual([
      ReasoningEffortId('off'),
      ReasoningEffortId('low'),
      ReasoningEffortId('medium'),
      ReasoningEffortId('high'),
      ReasoningEffortId('xhigh'),
      ReasoningEffortId('max'),
    ])
    // A catalog model without reasoning is the same case as a hand-declared
    // one: pi-ai reports the single level `off`, which translates to omitting
    // the reasoning option — exactly what naming no effort already does. The
    // capability is reported unavailable rather than offering that control.
    expect((await ctx.llm.resolveModelInfo('openai', 'gpt-4.1')).reasoning).toBeUndefined()
  })

  it('uses a supported profile reasoning value as the model default and rejects an unsupported one', async () => {
    const supported = new Context()
    await supported.plugin(LlmRuntime)
    await supported.plugin(LlmPiAi, {
      providers: { deepseek: { reasoning: 'max' } },
    })
    await expect(supported.llm.resolveModelInfo('deepseek', 'deepseek-flash'))
      .resolves.toMatchObject({ reasoning: { defaultEffort: ReasoningEffortId('max') } })

    // A profile level this model cannot take DESCRIBES as no default rather
    // than failing: resolveModelInfo builds the model catalog, and a catalog
    // that throws takes its whole provider out of every picker — one mis-set
    // field would hide every model on the route, including the ones that do
    // support the level. The request path below is where it is refused.
    const unsupported = new Context()
    await unsupported.plugin(LlmRuntime)
    await unsupported.plugin(LlmPiAi, {
      providers: { deepseek: { reasoning: 'medium' } },
    })
    const described = await unsupported.llm.resolveModelInfo('deepseek', 'deepseek-flash')
    expect(described.reasoning?.defaultEffort).toBeUndefined()
    expect(described.reasoning?.efforts.length).toBeGreaterThan(0)
    await expect(assemble(unsupported, {
      provider: 'deepseek', model: 'deepseek-flash', messages: [],
    })).resolves.toMatchObject({
      finish: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } },
    })

    const disabled = new Context()
    await disabled.plugin(LlmRuntime)
    await disabled.plugin(LlmPiAi, {
      providers: { deepseek: { reasoning: 'off' } },
    })
    await expect(disabled.llm.resolveModelInfo('deepseek', 'deepseek-flash'))
      .resolves.toMatchObject({ reasoning: { defaultEffort: ReasoningEffortId('off') } })
  })

  it('serves declared reasoning efforts to selectors and honours the profile default', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: 'https://acme.test/v1',
          reasoning: 'high',
          models: [{
            id: 'acme-think',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: null, low: 'low', high: 'high' },
          }],
        },
      },
    })

    // Declared levels reach the same seam catalog metadata does, so the
    // effort picker works for a model pi-ai has never heard of.
    await expect(ctx.llm.resolveModelInfo('acme-gateway', 'acme-think')).resolves.toMatchObject({
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('off'), name: 'Off' },
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    })
  })

  it('describes a per-model default effort over the route fallback', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: 'https://acme.test/v1',
          reasoning: 'low',
          models: [
            {
              id: 'acme-named',
              contextWindow: 65_536,
              maxTokens: 4096,
              reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
              reasoning: 'medium',
            },
            {
              id: 'acme-fallback',
              contextWindow: 65_536,
              maxTokens: 4096,
              reasoningEfforts: { off: null, low: 'low', high: 'high' },
            },
          ],
        },
      },
    })

    // What the UI's `resolveModel` reads: the model's own level wins over the
    // route's …
    await expect(ctx.llm.resolveModelInfo('acme-gateway', 'acme-named'))
      .resolves.toMatchObject({ reasoning: { defaultEffort: ReasoningEffortId('medium') } })
    // … and a model naming none keeps taking the route's level.
    await expect(ctx.llm.resolveModelInfo('acme-gateway', 'acme-fallback'))
      .resolves.toMatchObject({ reasoning: { defaultEffort: ReasoningEffortId('low') } })
  })

  it('sends the declared wire spelling and refuses undeclared levels before network I/O', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [{
            id: 'acme-think',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: null, high: 'ultra' },
          }],
        },
      },
    })

    await assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [],
    })
    // The declared value, not the canonical level name, goes on the wire.
    expect(server.requests[0]).toMatchObject({ reasoning_effort: 'ultra' })

    const undeclared = await assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId('max'),
      messages: [],
    })
    expect(undeclared.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'UNSUPPORTED_REASONING_EFFORT' },
    })
    expect(server.requests).toHaveLength(1)
  })

  it('dispatches the compat-switched dialect on a declared route', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          // Without the switch pi-ai guesses the dialect from the endpoint
          // URL, and a private gateway's URL says nothing.
          compat: { thinkingFormat: 'deepseek' },
          models: [{
            id: 'acme-think',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: null, high: 'high' },
          }],
        },
      },
    })
    const prompt = (effort: string): Promise<unknown> => assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId(effort),
      messages: [],
    })

    await prompt('high')
    expect(server.requests[0]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })

    await prompt('off')
    expect(server.requests[1]).toMatchObject({ thinking: { type: 'disabled' } })
    expect(server.requests[1]).not.toHaveProperty('reasoning_effort')
  })

  it('keeps the system role on a declared route whose gateway rejects the developer one', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [
            // pi-ai sends the system prompt as `developer` to a reasoning
            // model whenever its URL detection says the endpoint is OpenAI —
            // which is what an unrecognized private URL resolves to. Most
            // OpenAI-compatible gateways reject that role.
            { id: 'acme-think', reasoningEfforts: { off: null, high: 'high' }, compat: { supportsDeveloperRole: false } },
            { id: 'acme-guess', reasoningEfforts: { off: null, high: 'high' } },
          ],
        },
      },
    })
    const roles = async (model: string): Promise<string[]> => {
      await assemble(ctx, {
        provider: 'acme-gateway',
        model,
        reasoningEffort: ReasoningEffortId('high'),
        system: 'you are a harness',
        messages: [],
      })
      const request = server.requests.at(-1) as { messages: { role: string }[] }
      return request.messages.map(message => message.role)
    }

    expect(await roles('acme-think')).toEqual(['system'])
    // The switch is the only thing that changes it: the same route, same
    // endpoint, same reasoning declaration still gets pi-ai's guess.
    expect(await roles('acme-guess')).toEqual(['developer'])
  })

  it('sends a declared off value as the effort parameter instead of omitting it', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [{
            id: 'acme-think',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: 'none', high: 'high' },
          }],
        },
      },
    })

    // The adapter strips a selected Off to "no reasoning option", and pi-ai's
    // dispatch reads thinkingLevelMap.off exactly then — so the declared value
    // still reaches the wire, which is the README's promise for `off: none`.
    await assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId('off'),
      messages: [],
    })
    expect(server.requests[0]).toMatchObject({ reasoning_effort: 'none' })
  })

  it('holds back reasoning_effort when the endpoint cannot take it', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          compat: { supportsReasoningEffort: false },
          models: [{
            id: 'acme-think',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: null, high: 'high' },
          }],
        },
      },
    })

    await assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [],
    })
    expect(server.requests[0]).not.toHaveProperty('reasoning_effort')
  })

  it('reports efforts in ascending order and dispatches the level a caller selects', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([
      { events: anthropicTextEvents },
      { events: anthropicTextEvents },
      { events: anthropicTextEvents },
    ])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'adaptive-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'anthropic-messages',
          baseURL: server.url,
          reasoning: 'max',
          compat: { forceAdaptiveThinking: true },
          models: [
            // Declaring no `off` level means the model cannot stop reasoning.
            { id: 'always-thinks', reasoningEfforts: { low: 'low', high: 'high', max: 'max' } },
            { id: 'may-think', reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
          ],
        },
      },
    })
    const request = (model: string, effort: string): Promise<unknown> => assemble(ctx, {
      provider: 'adaptive-gateway',
      model,
      reasoningEffort: ReasoningEffortId(effort),
      maxTokens: 64,
      messages: [],
    })

    await expect(ctx.llm.resolveModelInfo('adaptive-gateway', 'always-thinks'))
      .resolves.toMatchObject({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } })
    await expect(ctx.llm.resolveModelInfo('adaptive-gateway', 'may-think'))
      .resolves.toMatchObject({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } })

    await request('always-thinks', 'max')
    await request('always-thinks', 'low')
    await request('may-think', 'off')

    expect(server.requests[0]).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'max' } })
    expect(server.requests[1]).toMatchObject({
      max_tokens: 64,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    })
    expect(server.requests[2]).toMatchObject({ max_tokens: 64, thinking: { type: 'disabled' } })
    expect(server.requests[2]).not.toHaveProperty('output_config')
  })

  it('accepts absent credentials for pi-ai ambient authentication', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'ambient-key')
    const server = await mockServer([{ events: textEvents }])
    // A profile that names no reference at all is the one case that defers to
    // pi-ai's own provider-native discovery.
    const ctx = await harness(server.url, { apiKeyEnv: undefined })
    await assemble(ctx, { model: 'deepseek-flash', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer ambient-key')
  })

  it('falls back to the ambient environment for apiKeyEnv without the credentials seam', async () => {
    vi.stubEnv('PI_CUSTOM_REF_KEY', 'custom-ref-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, { apiKey: undefined, apiKeyEnv: 'PI_CUSTOM_REF_KEY' })
    await assemble(ctx, { model: 'deepseek-flash', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer custom-ref-key')
  })

  it('fails a named-but-missing apiKeyEnv instead of using another ambient key', async () => {
    // The exact confusion this guards: the named reference is empty while an
    // unrelated provider key sits in the environment. Deferring to pi-ai's own
    // discovery here would authenticate as another tenant.
    vi.stubEnv('PI_CUSTOM_REF_KEY', '')
    vi.stubEnv('DEEPSEEK_API_KEY', 'ambient-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, { apiKey: undefined, apiKeyEnv: 'PI_CUSTOM_REF_KEY' })
    const first = await assemble(ctx, { model: 'deepseek-flash', messages: [] })
    expect(first.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    const second = await assemble(ctx, { model: 'deepseek-flash', messages: [] })
    expect(second.finish.kind).toBe('error')
    if (second.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(second.finish.failure.message).toMatch(/provider route "deepseek".*PI_CUSTOM_REF_KEY/s)
    expect(server.requests).toHaveLength(0)
  })

  it('validates empty, underspecified, legacy-shaped, and explicitly blank profiles', () => {
    expect(DEFAULT_MAX_REQUEST_IMAGE_BYTES).toBe(20 * 1024 * 1024)
    // Empty and omitted dicts are the dormant zero-route posture, not errors.
    expect(resolveProfiles({}).size).toBe(0)
    expect(resolveProfiles(undefined).size).toBe(0)
    expect(() => resolveProfiles({ '': {} })).toThrow(/non-empty/)
    // A route the installed catalog does not ship is allowed, but it has no
    // defaults to fall back on: it must describe its own models.
    expect(() => resolveProfiles({ 'not-real': {} })).toThrow(/resolves no models/)
    // The pre-release array shape and its per-profile provider field fail
    // loud with migration directions instead of half-working.
    expect(() => resolveProfiles([{ provider: 'openai' }] as never)).toThrow(/dict keyed by provider/)
    expect(() => resolveProfiles({ openai: { provider: 'openai' } as never })).toThrow(/moved to the providers dict key/)
    expect(() => resolveProfiles({ openai: { baseURL: '' } })).toThrow(/empty baseURL/)
    expect(() => resolveProfiles({ openai: { apiKeyEnv: 'not-a-var!' } })).toThrow(/must match/)
    expect(() => resolveProfiles({ openai: { maxRequestImageBytes: 0 } })).toThrow(/maxRequestImageBytes/)
    expect(resolveProfiles({ openai: {} }).get('openai')?.maxRequestImageBytes)
      .toBe(DEFAULT_MAX_REQUEST_IMAGE_BYTES)
    expect(resolveProfiles({ openai: { maxRequestImageBytes: 1024 } }).get('openai')?.maxRequestImageBytes)
      .toBe(1024)
  })

  it.each([
    ['bad header name', 'value'],
    ['x-company', 'line\nbreak'],
    ['x-company', '部署'],
  ])('rejects provider header %j when Fetch cannot represent the entry', (name, value) => {
    expect(() => resolveProfiles({ openai: { headers: { [name]: value } } }))
      .toThrow(`provider "openai" header "${name}" is not valid for Fetch`)
  })

  it.each(['maxRetries', 'maxRetryDelayMs'] as const)(
    'rejects removed profile field %s instead of silently restoring hidden SDK retries',
    async (field) => {
      const legacy = { [field]: 2 }
      expect(() => resolveProfiles({ openai: legacy })).toThrow(/removed.*agent recovery/i)
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await expect(ctx.plugin(LlmPiAi, { providers: { openai: legacy } }))
        .rejects.toThrow(/removed.*agent recovery/i)
    },
  )

  it('rejects invalid stream tunables at plugin load', async () => {
    const invalid = [
      { timeoutMs: -1 },
      { websocketConnectTimeoutMs: -1 },
      { streamIdleTimeoutMs: 0 },
      { streamIdleTimeoutMs: Number.NaN },
      { streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 },
      { maxRequestImageBytes: 0 },
      { maxRequestImageBytes: 1.5 },
      { maxRequestImageBytes: Number.NaN },
    ]
    for (const entry of invalid) {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await expect(ctx.plugin(LlmPiAi, { providers: { openai: { ...entry } } }))
        .rejects.toThrow()
    }
  })

  it('rejects invalid nested retryPolicy at the provider-profile boundary', async () => {
    expect(() => resolveProfiles({
      openai: { retryPolicy: { mode: 'always', backoff: { jitterRatio: -1 } } },
    })).toThrow(/retryPolicy\.backoff\.jitterRatio/)

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmPiAi, {
      providers: { openai: { retryPolicy: { mode: 'normal', maxRetries: -1 } } },
    })).rejects.toThrow(/retryPolicy/)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('constructs the adapter directly and rejects routes it does not own', async () => {
    const adapter = adapterOf({ openai: {} })
    await expect(adapter.listModels('anthropic')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expect(adapter.resolveModel('anthropic', 'claude-sonnet-4'))
      .rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expect(adapter.resolveModel('openai', 'not-a-catalog-model'))
      .rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    await expect((async () => {
      for await (const _chunk of adapter.stream({ provider: 'anthropic', model: 'claude-sonnet-4', messages: [] })) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect(new LlmError('x', 'X')).toBeInstanceOf(Error)
  })

  it('rejects unsupported or unresolved image input before provider I/O', async () => {
    const adapter = adapterOf({ openai: {}, deepseek: {} })
    const drain = async (options: Parameters<PiAiAdapter['stream']>[0]): Promise<void> => {
      for await (const _chunk of adapter.stream(options)) { /* drain */ }
    }

    await expect(drain({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: IMAGE_REF }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      })],
    })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      message: 'pi-ai model "deepseek-v4-pro" does not support image input',
    })
    await expect(drain({
      provider: 'openai',
      model: 'gpt-4.1',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: IMAGE_REF }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      })],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(drain({
      provider: 'openai',
      model: 'gpt-4.1',
      messages: [createToolResultMessage({
        callId: 'call-outer' as never,
        content: [{ type: 'image', attachment: IMAGE_REF }],
        isError: false,
      })],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('validates profiles at the shared resolver boundary', () => {
    expect(() => resolveProfiles({
      openai: { streamIdleTimeoutMs: 0 },
    })).toThrow(/streamIdleTimeoutMs.*positive finite/)
    expect(() => resolveProfiles({
      openai: { streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 },
    })).toThrow(/streamIdleTimeoutMs.*no greater/)
  })
})

describe('abort wiring', () => {
  it('preserves an unknown pre-dispatch adapter Error exactly', async () => {
    const original = new Error('SDK context conversion exploded')
    const message = Object.defineProperty({}, 'content', {
      get() { throw original },
    })
    const adapter = adapterOf({ deepseek: {} })
    const drain = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({
        provider: 'deepseek',
        model: 'deepseek-flash',
        messages: [message as never],
      })) { /* drain */ }
    }

    await expect(drain()).rejects.toBe(original)
  })

  it('lets a concurrent caller abort classify a pre-dispatch adapter failure', async () => {
    const controller = new AbortController()
    const original = new Error('conversion lost its caller')
    const message = Object.defineProperty({}, 'content', {
      get() {
        controller.abort('caller cancelled during conversion')
        throw original
      },
    })
    const adapter = adapterOf({ deepseek: {} })
    const drain = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({
        provider: 'deepseek',
        model: 'deepseek-flash',
        messages: [message as never],
        signal: controller.signal,
      })) { /* drain */ }
    }

    await expect(drain()).rejects.toMatchObject({ code: 'ABORTED', cause: original })
  })

  it('resolves catalog endpoints without an override before honoring pre-abort', async () => {
    const adapter = adapterOf({ deepseek: {} })
    const controller = new AbortController()
    controller.abort('already stopped')
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'deepseek',
      model: 'deepseek-flash',
      messages: [],
      signal: controller.signal,
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'aborted', failure: { code: 'ABORTED' } },
    })
  })

  it('honors a pre-aborted caller signal', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 20 }])
    const ctx = await harness(server.url)
    const controller = new AbortController()
    controller.abort('already stopped')
    const result = await assemble(ctx, { model: 'deepseek-flash', messages: [], signal: controller.signal })
    expect(result.finish.kind).toBe('aborted')
  })

  it('forwards an abort that arrives while provider streaming is active', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 30 }])
    const ctx = await harness(server.url)
    const controller = new AbortController()
    const resultPromise = assemble(ctx, {
      model: 'deepseek-flash', messages: [], signal: controller.signal,
    })
    setTimeout(() => { controller.abort('stopped during stream') }, 10)
    const result = await resultPromise
    expect(result.finish.kind).toBe('aborted')
  })

  it('aborts upstream when a consumer stops early', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 30 }])
    const ctx = await harness(server.url)
    for await (const chunk of ctx.llm.stream({ provider: 'deepseek', model: 'deepseek-flash', messages: [] })) {
      if (chunk.type === 'block-start') break
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(server.requests).toHaveLength(1)
  })
})

it.each([
  new LlmError('missing credential', 'MISSING_CREDENTIAL'),
  new LlmError('invalid credential', 'INVALID_CREDENTIAL'),
  new Error('credential storage failed'),
])('distinguishes missing credentials from catalog failures: $message', async (error) => {
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ deepseek: { apiKeyEnv: 'PI_TEST_KEY' } }),
    resolveApiKey: () => Promise.reject(error),
    auth: memoryAuth(),
  })
  if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') {
    expect(await adapter.listModels('deepseek')).toEqual([])
  } else await expect(adapter.listModels('deepseek')).rejects.toBe(error)
})

it('resolves the exact pi-ai image budget for screenshot coordinates', () => {
  const adapter = adapterOf({ deepseek: { apiKeyEnv: 'PI_TEST_KEY', requestImagePixelBudget: 10_000, requestImageMaxBytes: 50_000 } })
  expect(adapter.imageRequestTarget('deepseek', 'deepseek-flash', { ...IMAGE_REF, width: 1000, height: 1000 }))
    .toEqual({ width: 100, height: 100, maxBytes: 50_000 })
  expect(() => adapter.imageRequestTarget('missing', 'deepseek-flash', IMAGE_REF)).toThrow('does not own provider')
})
