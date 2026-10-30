/**
 * CC wire parity keeps the request features that are not cache policy: eager
 * tool streaming, the pinned thinking display, and non-cache betas survive
 * while a cache beta is removed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId, AttachmentStore, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { assemble } from './assemble.ts'
import { memoryAuth } from './auth-double.ts'
import { anthropicTextEvents, closeMockServers, mockServer } from './mock-server.ts'

/** A beta that selects a context window; wire parity must not remove it. */
const CONTEXT_WINDOW_BETA = 'context-1m-2025-01-01'

/** A beta whose behaviour the pool's worker owns; wire parity removes it. */
const CACHE_DIAGNOSIS_BETA = 'cache-diagnosis-2025-01-01'

/** The extended prompt-cache beta the worker plans; wire parity removes it from the header too. */
const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11'

/** One stable and one session-specific system section, so the boundary is defined. */
const SECTIONS = [
  { name: 'app:instructions', text: 'Stable route instructions.', stable: true },
  { name: 'session:state', text: 'Current session state.', stable: false },
]

const ECHO: ToolSchema = {
  name: 'echo',
  description: 'Echo text back.',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
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

describe('CC wire parity body keeps non-cache request features', () => {
  it('keeps eager tool streaming, the pinned thinking display, and the non-cache beta', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    const profiles = resolveProfiles({
      'parity-main': {
        api: 'anthropic-messages',
        baseURL: server.url,
        ccWireParity: true,
        reasoning: 'high',
        // The transport derives the request's betas from this header, so the
        // cache beta arrives through the same path the parity body filters.
        headers: { 'anthropic-beta': `${CONTEXT_WINDOW_BETA},${CACHE_DIAGNOSIS_BETA}` },
        models: [{
          id: 'model',
          reasoningEfforts: { low: 'low', high: 'high' },
          compat: { supportsEagerToolInputStreaming: true },
        }],
      },
    }, 'strict', new Map([['parity-main', { endpoint: `${server.url}/v1/capabilities`, buildId: 'test-build' }]]))
    ctx.llm.registerAdapter(['parity-main'], new LlmPiAi.PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => 'test-key',
      auth: memoryAuth(),
    }))

    await assemble(ctx, {
      provider: 'parity-main',
      model: 'model',
      system: SECTIONS.map(section => section.text).join('\n\n'),
      systemSections: SECTIONS,
      requestClass: 'main',
      tools: [ECHO],
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
    })

    const body = server.requests[0] as Record<string, unknown>
    const headers = server.headers[0] ?? {}

    // Tool streaming is unrelated to cache ownership: the parity body strips
    // the caller's marker from a declaration but keeps the transport's flag.
    const tools = body['tools'] as Record<string, unknown>[]
    expect(tools[0]?.['eager_input_streaming']).toBe(true)
    expect(tools[0]).not.toHaveProperty('cache_control')

    // The pinned client asks for `display: "updates"` on the thinking it enables.
    expect(body['thinking']).toMatchObject({ type: 'enabled', display: 'updates' })

    // The cache beta the worker plans is removed; the non-cache beta stays.
    const betas = betasOf(headers)
    expect(betas).toContain(CONTEXT_WINDOW_BETA)
    expect(betas).not.toContain(CACHE_DIAGNOSIS_BETA)
  })

  it('removes cache betas from a profile beta header on a parity request only', async () => {
    const server = await mockServer([
      { events: anthropicTextEvents },
      { events: anthropicTextEvents },
      { events: anthropicTextEvents },
    ])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    // The two parity headers differ: the first declares a cache beta the worker
    // owns beside a non-cache beta wire parity must keep, and the second only
    // the non-cache beta.
    const headers = { 'anthropic-beta': `${EXTENDED_CACHE_TTL_BETA},${CONTEXT_WINDOW_BETA}` }
    const profiles = resolveProfiles({
      'parity-main': {
        api: 'anthropic-messages',
        baseURL: server.url,
        ccWireParity: true,
        headers,
        models: [{ id: 'model' }],
      },
      'parity-kept': {
        api: 'anthropic-messages',
        baseURL: server.url,
        ccWireParity: true,
        headers: { 'anthropic-beta': CONTEXT_WINDOW_BETA },
        models: [{ id: 'model' }],
      },
      'plain-main': {
        api: 'anthropic-messages',
        baseURL: server.url,
        headers,
        models: [{ id: 'model' }],
      },
    }, 'strict', new Map([
      ['parity-main', { endpoint: `${server.url}/v1/capabilities`, buildId: 'test-build' }],
      ['parity-kept', { endpoint: `${server.url}/v1/capabilities`, buildId: 'test-build' }],
    ]))
    ctx.llm.registerAdapter(['parity-main', 'parity-kept', 'plain-main'], new LlmPiAi.PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => 'test-key',
      auth: memoryAuth(),
    }))

    await assemble(ctx, {
      provider: 'parity-main',
      model: 'model',
      system: SECTIONS.map(section => section.text).join('\n\n'),
      systemSections: SECTIONS,
      requestClass: 'main',
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
    })
    await assemble(ctx, {
      provider: 'parity-kept',
      model: 'model',
      system: SECTIONS.map(section => section.text).join('\n\n'),
      systemSections: SECTIONS,
      requestClass: 'main',
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
    })
    await assemble(ctx, {
      provider: 'plain-main',
      model: 'model',
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
    })

    const parity = betasOf(server.headers[0] ?? {})
    const kept = betasOf(server.headers[1] ?? {})
    const plain = betasOf(server.headers[2] ?? {})
    // The parity request sends only the non-cache beta, a header already free of
    // cache betas is untouched, and the same profile header reaches a non-parity
    // request unchanged.
    expect(parity).toContain(CONTEXT_WINDOW_BETA)
    expect(parity).not.toContain(EXTENDED_CACHE_TTL_BETA)
    expect(kept).toEqual([CONTEXT_WINDOW_BETA])
    expect(plain).toEqual([EXTENDED_CACHE_TTL_BETA, CONTEXT_WINDOW_BETA])
  })

  it('strips adapter-owned member headers from a programmatic profile on a non-parity route', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    const resolved = resolveProfiles({
      route: {
        api: 'anthropic-messages',
        baseURL: server.url,
        models: [{ id: 'model' }],
        headers: { 'x-route-header': 'kept' },
      },
    }, 'strict').get('route')
    if (resolved === undefined) throw new Error('the route did not resolve')
    // Resolution refuses these headers, so only a programmatic profile can carry
    // them; the adapter still strips them on a route that never enables parity.
    const profiles = new Map([['route', {
      ...resolved,
      headers: { ...resolved.headers, 'x-route-header': 'kept', 'x-cc-cache-intent': 'main', 'X-CC-Request-Class': 'main' },
    }]])
    ctx.llm.registerAdapter(['route'], new LlmPiAi.PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => 'test-key',
      auth: memoryAuth(),
    }))

    await assemble(ctx, {
      provider: 'route',
      model: 'model',
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
    })

    const headers = server.headers[0] ?? {}
    expect(headers['x-route-header']).toBe('kept')
    expect(headers['x-cc-cache-intent']).toBeUndefined()
    expect(headers['x-cc-request-class']).toBeUndefined()
  })

  it('deletes a parity request beta set that holds only cache betas', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    const profiles = resolveProfiles({
      'parity-main': {
        api: 'anthropic-messages',
        baseURL: server.url,
        ccWireParity: true,
        // The transport derives the request's betas from this header, so the
        // payload arrives with one beta whose behaviour the worker owns.
        headers: { 'anthropic-beta': CACHE_DIAGNOSIS_BETA },
        models: [{ id: 'model' }],
      },
    }, 'strict', new Map([['parity-main', { endpoint: `${server.url}/v1/capabilities`, buildId: 'test-build' }]]))
    ctx.llm.registerAdapter(['parity-main'], new LlmPiAi.PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => 'test-key',
      auth: memoryAuth(),
    }))

    await assemble(ctx, {
      provider: 'parity-main',
      model: 'model',
      system: SECTIONS.map(section => section.text).join('\n\n'),
      systemSections: SECTIONS,
      requestClass: 'main',
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
    })

    const body = server.requests[0] as Record<string, unknown>
    // The member body carries no beta member and no beta name: every beta this
    // payload declared belonged to the worker's cache plan.
    expect(body).not.toHaveProperty('betas')
    expect(JSON.stringify(body)).not.toContain(CACHE_DIAGNOSIS_BETA)
    // The profile header is stripped before the transport derives the request's
    // betas, so the fallback cannot put the cache beta back on the wire.
    expect(betasOf(server.headers[0] ?? {})).not.toContain(CACHE_DIAGNOSIS_BETA)
  })

  it('strips markers from a final user turn whose content is a block array', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    const image: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const readImageRequest = async (ref: ImageAttachmentRef, target: ImageRequestTarget): Promise<RequestImageAttachment> => ({
      attachment: ref,
      variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
      data: Uint8Array.of(1),
      mediaType: ref.mediaType,
      bytes: 1,
      width: target.width,
      height: target.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
    })
    const store: Pick<AttachmentStore, 'readImageRequest'> = { readImageRequest }
    const profiles = resolveProfiles({
      'parity-main': {
        api: 'anthropic-messages',
        baseURL: server.url,
        ccWireParity: true,
        models: [{ id: 'model', input: ['text', 'image'] }],
      },
    }, 'strict', new Map([['parity-main', { endpoint: `${server.url}/v1/capabilities`, buildId: 'test-build' }]]))
    ctx.llm.registerAdapter(['parity-main'], new LlmPiAi.PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => 'test-key',
      auth: memoryAuth(),
      resolveAttachments: () => store as AttachmentStore,
    }))

    await assemble(ctx, {
      provider: 'parity-main',
      model: 'model',
      system: SECTIONS.map(section => section.text).join('\n\n'),
      systemSections: SECTIONS,
      requestClass: 'main',
      messages: [createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: image }, { type: 'text', text: 'look' }],
      })],
    })

    const messages = (server.requests[0] as Record<string, unknown>)['messages'] as Record<string, unknown>[]
    const content = messages[0]?.['content'] as Record<string, unknown>[]
    // A block-array turn (an image beside text) is stripped of any marker and
    // keeps its blocks; only a bare string needs the expansion the adapter
    // performs for a text-only final turn.
    expect(content.map(block => block['type'])).toEqual(['text', 'image', 'text'])
    expect(content.some(block => block['type'] === 'image')).toBe(true)
    expect(JSON.stringify(messages)).not.toContain('cache_control')
  })
})
