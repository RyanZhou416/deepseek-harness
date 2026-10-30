/**
 * CC wire parity keeps the request features that are not cache policy: eager
 * tool streaming, the pinned thinking display, and non-cache betas survive
 * while a cache beta is removed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
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
})
