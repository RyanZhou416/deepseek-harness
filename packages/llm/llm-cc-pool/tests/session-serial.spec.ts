/** The real LLM seam serializes same-session requests and leaves other sessions parallel. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { POOL_RATE_LIMITED_CODE } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmAdapter, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import * as CcPool from '../src/index.ts'
import { PROVIDER } from '../src/pool.ts'
import { anthropicSuccessResponse, assemble, user } from './harness.ts'

let context: Context | undefined
const tempRoots: string[] = []

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
 * Mount the real LLM service and the plugin under test.
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

/**
 * Mount the same composition while retaining the adapter the plugin registers,
 * for the adapter-level stream entry point the LLM service does not call.
 * @param config - loader configuration for the plugin.
 * @returns the isolated context and the registered adapter.
 */
async function mountWithAdapter(config: Record<string, unknown> = {}): Promise<{ ctx: Context; adapter: LlmAdapter }> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  const llm = ctx.llm
  const register = llm.registerAdapter.bind(llm)
  let captured: LlmAdapter | undefined
  llm.registerAdapter = (providers, adapter) => {
    captured = adapter
    return register(providers, adapter)
  }
  await ctx.plugin(CcPool, { requestLog: { enabled: false }, ...config })
  if (captured === undefined) throw new Error('the plugin registered no adapter')
  return { ctx, adapter: captured }
}

/**
 * Collect every chunk of one raw adapter stream.
 * @param stream - stream to consume.
 * @returns the chunks in order.
 */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** One captured member request. */
interface MemberCall {
  /** Session header the adapter sent, absent only for a sessionless caller. */
  readonly sessionId: string | undefined
  /** Attempt ledger id the adapter sent as `x-client-request-id`. */
  readonly requestId: string | undefined
  /** First user text in the request body, naming which request reached the pool. */
  readonly text: string
}

/** Answers one member request by its zero-based call index. */
type Responder = (call: number, sessionId: string | undefined) => Response | Promise<Response>

/** The request body fields this suite reads. */
interface MemberBody {
  readonly messages?: readonly { readonly content?: readonly { readonly text?: string }[] }[]
}

/**
 * Replace the transport's fetch with a scripted recorder that sends nothing.
 * @param respond - answers one call by index and session header.
 * @returns the captured calls and the fetch implementation to stub.
 */
function memberFetch(respond: Responder): {
  readonly calls: MemberCall[]
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
} {
  const calls: MemberCall[] = []
  return {
    calls,
    async fetch(input, init) {
      const request = input instanceof Request ? input : undefined
      const headers = new Headers(request?.headers ?? init?.headers)
      const raw = init?.body === undefined
        ? request === undefined ? undefined : await request.clone().text()
        : typeof init.body === 'string' ? init.body : undefined
      const body: MemberBody = raw === undefined || raw.length === 0
        ? {}
        : JSON.parse(raw) as MemberBody
      const sessionId = headers.get('x-claude-code-session-id') ?? undefined
      const requestId = headers.get('x-client-request-id') ?? undefined
      calls.push({ sessionId, requestId, text: body.messages?.[0]?.content?.[0]?.text ?? '' })
      return respond(calls.length - 1, sessionId)
    },
  }
}

/** One promise plus its resolver, for holding a member response open from the test. */
interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

/**
 * A promise the test settles when it wants the held response to arrive.
 * @returns the promise and its resolver.
 */
function deferred(): Deferred {
  let settle: () => void = () => {}
  const promise = new Promise<void>((resolve) => { settle = resolve })
  return { promise, resolve: () => { settle() } }
}

/**
 * One pool error envelope, the way the deployed gateway writes it.
 * @param status - HTTP status the route returns.
 * @param error - envelope fields below `error`.
 * @param headers - extra response headers, such as `Retry-After`.
 * @returns the JSON response.
 */
function poolError(status: number, error: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: 'error', error: { origin: 'pool', ...error } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/**
 * The refusal the pool sends while the session's previous request still holds its lease.
 * @returns the 409 response.
 */
function sessionBusy(): Response {
  return poolError(409, {
    type: 'cc_pool_session_busy',
    code: 'cc_pool_session_busy',
    scope: 'session',
    retryable: false,
    client_action: 'stop',
    message: 'this session already has an in-flight request',
  })
}

/**
 * The refusal the pool sends when its global slot limit is full.
 * @returns the 429 response carrying a long provider wait.
 */
function rateLimited(): Response {
  return poolError(429, {
    type: 'cc_pool_rate_limited',
    code: 'cc_pool_rate_limited',
    scope: 'session',
    retryable: true,
    client_action: 'retry_after',
    message: 'all pool session slots are in use',
  }, { 'retry-after': '30' })
}

it('settles a queued request when the plugin fiber is disposed', async () => {
  vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
  const ctx = await mount()
  const held = deferred()
  const stub = memberFetch(async (call) => {
    if (call === 0) await held.promise
    return anthropicSuccessResponse('served')
  })
  vi.stubGlobal('fetch', stub.fetch)

  const first = assemble(ctx, {
    model: 'claude-sonnet-5-5',
    messages: [user('first')],
    sessionId: 'session-a' as never,
  })
  await vi.waitFor(() => { expect(stub.calls).toHaveLength(1) })
  const second = assemble(ctx, {
    model: 'claude-sonnet-5-5',
    messages: [user('second')],
    sessionId: 'session-a' as never,
  })
  // One macrotask turn lets the queued request reach its wait before the route
  // is withdrawn; the queue must settle it instead of leaving it pending.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  await ctx.fiber.dispose()

  expect((await second).finish).toMatchObject({ kind: 'aborted', failure: { code: 'ABORTED' } })
  expect(stub.calls).toHaveLength(1)
  held.resolve()
  expect((await first).finish).toMatchObject({ kind: 'stop' })
})

it('queues a second same-session request while another session stays parallel', async () => {
  vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
  const ctx = await mount()
  const held = deferred()
  const stub = memberFetch(async (call, sessionId) => {
    if (call === 0 && sessionId === 'session-a') await held.promise
    return anthropicSuccessResponse('served')
  })
  vi.stubGlobal('fetch', stub.fetch)

  const first = assemble(ctx, {
    model: 'claude-sonnet-5-5',
    messages: [user('first')],
    sessionId: 'session-a' as never,
  })
  await vi.waitFor(() => { expect(stub.calls).toHaveLength(1) })

  let secondSettled = false
  const second = assemble(ctx, {
    model: 'claude-sonnet-5-5',
    messages: [user('second')],
    sessionId: 'session-a' as never,
  }).then((result) => { secondSettled = true; return result })
  const other = assemble(ctx, {
    model: 'claude-sonnet-5-5',
    messages: [user('other')],
    sessionId: 'session-b' as never,
  })

  // The different session reaches the pool while the first request is still in
  // flight, and the queued same-session request does not.
  await vi.waitFor(() => { expect(stub.calls).toHaveLength(2) })
  expect(stub.calls.map(call => call.sessionId)).toEqual(['session-a', 'session-b'])
  expect(stub.calls.map(call => call.text)).toEqual(['first', 'other'])
  expect((await other).finish).toEqual({ kind: 'stop' })
  expect(secondSettled).toBe(false)
  expect(stub.calls).toHaveLength(2)

  held.resolve()
  const [firstResult, secondResult] = await Promise.all([first, second])
  expect(firstResult.finish).toEqual({ kind: 'stop' })
  expect(secondResult.finish).toEqual({ kind: 'stop' })
  expect(stub.calls.map(call => call.text)).toEqual(['first', 'other', 'second'])
  expect(stub.calls[2]?.sessionId).toBe('session-a')
})

it('retries a session-busy refusal for the next request after the previous stream settled', async () => {
  vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
  const ctx = await mount()
  const stub = memberFetch((call) => {
    if (call === 1) return sessionBusy()
    return anthropicSuccessResponse(call === 0 ? 'first' : 'second')
  })
  vi.stubGlobal('fetch', stub.fetch)

  const first = await assemble(ctx, {
    model: 'claude-sonnet-5-5',
    messages: [user('first')],
    sessionId: 'session-a' as never,
  })
  expect(first.finish).toEqual({ kind: 'stop' })
  expect(stub.calls).toHaveLength(1)

  // The lane is idle, so this request never queues; the pool can still refuse
  // it once while the previous lease releases, and the gate must retry it.
  const second = await assemble(ctx, {
    model: 'claude-sonnet-5-5',
    messages: [user('second')],
    sessionId: 'session-a' as never,
  })
  expect(second.finish).toEqual({ kind: 'stop' })
  expect(second.message.content).toEqual([{ type: 'text', text: 'second' }])
  expect(stub.calls.map(call => call.text)).toEqual(['first', 'second', 'second'])
  // The refused attempt's ledger entry is terminal at the pool, so the retry
  // must present a fresh client request id instead of a replay of it.
  const [, refused, retried] = stub.calls
  expect(refused?.requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/))
  expect(retried?.requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/))
  expect(retried?.requestId).not.toBe(refused?.requestId)
})

it('keeps the request log for a queued session-busy retry as one logical request', async () => {
  vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
  const root = await mkdtemp(join(tmpdir(), 'dsh-cc-pool-serial-'))
  tempRoots.push(root)
  const logPath = join(root, 'requests.jsonl')
  const ctx = await mount({ requestLog: { path: logPath } })
  const held = deferred()
  const stub = memberFetch(async (call) => {
    if (call === 0) {
      await held.promise
      return anthropicSuccessResponse('first')
    }
    return call === 1 ? sessionBusy() : anthropicSuccessResponse('second')
  })
  vi.stubGlobal('fetch', stub.fetch)

  const first = assemble(ctx, {
    model: 'claude-sonnet-5-5',
    messages: [user('first')],
    sessionId: 'session-a' as never,
  })
  await vi.waitFor(() => { expect(stub.calls).toHaveLength(1) })
  const second = assemble(ctx, {
    model: 'claude-sonnet-5-5',
    messages: [user('second')],
    sessionId: 'session-a' as never,
  })

  held.resolve()
  const [firstResult, secondResult] = await Promise.all([first, second])
  expect(firstResult.finish).toEqual({ kind: 'stop' })
  expect(secondResult.finish).toEqual({ kind: 'stop' })
  expect(secondResult.message.content).toEqual([{ type: 'text', text: 'second' }])
  expect(stub.calls.map(call => call.text)).toEqual(['first', 'second', 'second'])

  await vi.waitFor(async () => {
    const records = (await readFile(logPath, 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const responses = records.filter(record => record['kind'] === 'response')
    expect(responses.map(record => record['status'])).toEqual([200, 409, 200])
    const requests = records.filter(record => record['kind'] === 'request')
    expect(requests.map(record => record['attempt'])).toEqual([1, 1, 2])
  }, { timeout: 5000 })
})

it('returns a rate-limit refusal instead of turning it into a retry loop', async () => {
  vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
  const ctx = await mount()
  const held = deferred()
  const stub = memberFetch(async (call) => {
    if (call === 0) {
      await held.promise
      return anthropicSuccessResponse('first')
    }
    return rateLimited()
  })
  vi.stubGlobal('fetch', stub.fetch)

  const first = assemble(ctx, {
    model: 'claude-sonnet-5-5',
    messages: [user('first')],
    sessionId: 'session-a' as never,
  })
  await vi.waitFor(() => { expect(stub.calls).toHaveLength(1) })
  const second = assemble(ctx, {
    model: 'claude-sonnet-5-5',
    messages: [user('second')],
    sessionId: 'session-a' as never,
  })

  const started = Date.now()
  held.resolve()
  expect((await first).finish).toEqual({ kind: 'stop' })
  const refusal = await second
  expect(refusal.finish).toMatchObject({
    kind: 'error',
    failure: {
      code: POOL_RATE_LIMITED_CODE,
      status: 429,
      providerRetryAfterMs: 30_000,
    },
  })
  // The refusal is delivered at once: the header's 30 s wait stays the retry
  // executor's business, and the queue never repeats the attempt itself.
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(stub.calls).toHaveLength(2)
})

it('orders streams dispatched directly through the adapter by session', async () => {
  vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
  const { adapter } = await mountWithAdapter()
  const held = deferred()
  const stub = memberFetch(async (call) => {
    if (call === 0) await held.promise
    return anthropicSuccessResponse(call === 0 ? 'first' : 'second')
  })
  vi.stubGlobal('fetch', stub.fetch)

  const options = (text: string): GenerateOptions => ({
    provider: PROVIDER,
    model: 'claude-sonnet-5-5',
    messages: [user(text)],
    sessionId: 'session-a' as never,
  })
  const first = collect(adapter.stream(options('first')))
  await vi.waitFor(() => { expect(stub.calls).toHaveLength(1) })
  let secondSettled = false
  const second = collect(adapter.stream(options('second'))).then((chunks) => {
    secondSettled = true
    return chunks
  })
  // The direct entry point enters the same per-session queue as a dispatch
  // prepared through the LLM service: the second same-session stream waits.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  expect(secondSettled).toBe(false)
  expect(stub.calls).toHaveLength(1)

  held.resolve()
  expect(await first).not.toHaveLength(0)
  expect(await second).not.toHaveLength(0)
  expect(stub.calls.map(call => call.text)).toEqual(['first', 'second'])
})
