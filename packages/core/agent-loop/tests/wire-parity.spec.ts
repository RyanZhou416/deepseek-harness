/**
 * The real loop's assembled sections drive the shipped parity adapter: a
 * request whose leading system text equals the current assembly takes the
 * parity body, while committed in-history prompt versions make it fall back to
 * the route's ordinary wire.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAuthInjection } from '@deepseek-ai/dsh-llm-pi-ai/src/adapter.ts'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai/src/config.ts'
import { leadingSystemText } from '@deepseek-ai/dsh-llm-pi-ai/src/context.ts'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/** The pinned identity line the parity body opens with. */
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

/** The stable and session-specific text this composition assembles. */
const STABLE = 'Stable rules for the parity integration.'

/** The route the loop calls; it admits prompt versions in history. */
const LOOP_ROUTE = 'loop-route'

/** The route the shipped parity adapter serves. */
const PARITY_ROUTE = 'parity-route'

/** One captured member request: everything the adapter put on the wire. */
interface WireRequest {
  readonly headers: Headers
  readonly body: Record<string, unknown>
}

/** The fetch stand-in plus the requests it answered. */
interface WireCapture {
  readonly calls: WireRequest[]
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
})

/**
 * A minimal complete Anthropic Messages text generation.
 * @returns the SSE response the transport parses.
 */
function anthropicSuccess(): Response {
  const frames: [string, Record<string, unknown>][] = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  const body = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * Replace the transport's fetch with a recorder that answers every request.
 * @returns the captured requests and the fetch implementation to stub.
 */
function captureWire(): WireCapture {
  const calls: WireRequest[] = []
  return {
    calls,
    async fetch(input, init) {
      const request = input instanceof Request ? input : undefined
      const raw = init?.body === undefined
        ? request === undefined ? undefined : await request.clone().text()
        : typeof init.body === 'string' ? init.body : undefined
      calls.push({
        headers: new Headers(request?.headers ?? init?.headers),
        body: raw === undefined || raw.length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>,
      })
      return anthropicSuccess()
    },
  }
}

/**
 * The auth injectables the adapter needs for streaming: an empty credential
 * store and no ambient login.
 * @returns the injection.
 */
function memoryAuth(): PiAiAuthInjection {
  return {
    credentials: {
      read: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
      async modify(_id, mutate) { return await mutate(undefined) },
      delete: () => Promise.resolve(),
    },
    authContext: {
      env: () => Promise.resolve(undefined),
      fileExists: () => Promise.resolve(false),
    },
  }
}

/**
 * Boot the real loop over a mock route and the shipped parity adapter over the
 * scripted wire.
 * @returns the context, the agent, the loop's requests, the captured wire
 *   requests, and a setter for the session-specific prompt text.
 */
async function mount(): Promise<{
  ctx: Context
  agent: Agent
  loopRequests: GenerateOptions[]
  capture: WireCapture
  setState: (text: string) => void
}> {
  const capture = captureWire()
  vi.stubGlobal('fetch', capture.fetch)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })

  ctx.systemPrompt.section({ name: 'rules', text: STABLE, order: 100, stable: true })
  let state = 'State one.'
  ctx.systemPrompt.section({ name: 'session:state', text: () => state, order: 200 })
  const profiles = resolveProfiles({
    [PARITY_ROUTE]: {
      api: 'anthropic-messages',
      baseURL: 'https://parity.test',
      apiKeyEnv: 'PARITY_TEST_KEY',
      ccWireParity: true,
      models: [{ id: 'model' }],
    },
  }, 'strict', new Map([[PARITY_ROUTE, { endpoint: 'https://parity.test/v1/capabilities', buildId: 'test-build' }]]))
  ctx.llm.registerAdapter([PARITY_ROUTE], new LlmPiAi.PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => 'test-key',
    auth: memoryAuth(),
  }))
  const loop = new MockAdapter([textResponse('first'), textResponse('second')])
  loop.systemPromptUpdate = 'in-history'
  ctx.llm.registerAdapter([LOOP_ROUTE], loop)

  const agent = await ctx.agentLoop.create(SessionId('wire-parity'), { provider: LOOP_ROUTE, model: 'model' })
  return {
    ctx,
    agent,
    loopRequests: loop.requests,
    capture,
    setState(text) {
      state = text
    },
  }
}

/**
 * Send one user turn and wait for the loop to finish it.
 * @param agent - the running agent.
 * @param text - user text.
 */
async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/**
 * Replay one loop request through the parity route and drain its stream.
 * @param ctx - context carrying both routes.
 * @param request - the request the loop assembled.
 * @returns the request the parity route served.
 */
async function replay(ctx: Context, request: GenerateOptions): Promise<void> {
  const { signal: _signal, ...replayable } = request
  for await (const _chunk of ctx.llm.stream({ ...replayable, provider: PARITY_ROUTE, model: 'model' })) {
    // The stand-in answers with a complete SSE stream; the adapter needs the
    // stream consumed for its payload policy to run.
  }
}

describe('agent loop parity integration', () => {
  it('sends the real assembled sections as the parity boundary and falls back on in-history prompts', async () => {
    const { ctx, agent, loopRequests, capture, setState } = await mount()

    await send(agent, 'first')
    expect(loopRequests).toHaveLength(1)
    const first = loopRequests[0] as GenerateOptions
    const sections = first.systemSections ?? []
    expect(sections.map(section => section.name)).toEqual(['harness:identity', 'rules', 'session:state'])
    // The committed leading system text is the assembly the adapter receives,
    // which is what lets it state a boundary instead of guessing one.
    expect(sections.map(section => section.text).join('\n\n')).toBe(leadingSystemText(first).text)
    await replay(ctx, first)
    expect(capture.calls).toHaveLength(1)
    const wire = capture.calls[0] as WireRequest
    expect(wire.headers.get('x-cc-request-class')).toBe('main')
    expect(wire.headers.get('x-cc-system-layout')).toBe('boundary:1')
    expect(wire.headers.get('x-cc-cache-intent')).toBe('main')
    // The identity section is replaced by the pinned line; the stable rules and
    // the session-specific text are the two blocks the boundary splits.
    expect(wire.body['system']).toEqual([
      { type: 'text', text: IDENTITY },
      { type: 'text', text: STABLE },
      { type: 'text', text: 'State one.' },
    ])

    setState('State two.')
    await send(agent, 'second')
    expect(loopRequests).toHaveLength(2)
    const second = loopRequests[1] as GenerateOptions
    const committed = second.systemSections ?? []
    // The in-history route keeps the earlier prompt version in history, so the
    // leading system text now differs from the current assembly.
    expect(committed.map(section => section.text).join('\n\n')).not.toBe(leadingSystemText(second).text)
    expect(leadingSystemText(second).text).toContain('State one.')
    await replay(ctx, second)
    const fallback = capture.calls[1] as WireRequest
    expect(fallback.headers.has('x-cc-request-class')).toBe(false)
    expect(fallback.headers.has('x-cc-system-layout')).toBe(false)
    const system = JSON.stringify(fallback.body['system'])
    expect(system).toContain('State one.')
    expect(system).toContain('State two.')
    expect(system).not.toContain(IDENTITY)
  })
})
