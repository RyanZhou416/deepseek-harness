/**
 * Cursor provider: session shape, browser-login handoff, and one local agent
 * turn. The SDK is replaced with a fake so the suite never opens a browser
 * or contacts Cursor.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SubscriptionsAuthController } from '../src/index.js'
import { OAuthFlowManager } from '../src/auth/oauth-flow.js'
import { DeviceFlowManager } from '../src/auth/device-flow.js'
import { accountKeyOf, authFilePath, listAccounts } from '../src/auth/store.js'
import {
  CursorAdapter,
  beginCursorLogin,
  closeCursorProse,
  cursorContextAttempt,
  cursorContextChoice,
  eventChunks,
  cursorDiscoveredModel,
  cursorRequestParams,
  cursorSession,
  fetchCursorUsage,
  isCursorPermanentRefreshError,
  loadCursorAccountUsage,
  refreshCursor,
  renderCursorTurn,
  setCursorLoginFetch,
  setCursorSdkLoader,
} from '../src/providers/cursor.js'
import type { AccountTokenManager } from '../src/providers/accounts.js'
import type { CursorSession } from '../src/auth/store.js'

const TEMP_DIRS: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.push(dir)
  return dir
}

async function withEnv<T>(name: string, value: string, run: () => Promise<T>): Promise<T> {
  const saved = process.env[name]
  process.env[name] = value
  try {
    return await run()
  } finally {
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  }
}

async function inIsolatedHome<T>(run: () => Promise<T>): Promise<T> {
  return withEnv('DSH_HOME', tempDir('cursor-spec-dsh-'), async () => {
    assert.ok(authFilePath().startsWith(process.env.DSH_HOME ?? '\0'))
    return run()
  })
}

test.after(() => {
  setCursorSdkLoader(undefined)
  setCursorLoginFetch(undefined)
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

function installCursorLoginFetch(): void {
  let polls = 0
  setCursorLoginFetch(async (url, init) => {
    const target = String(url)
    if (target.includes('/auth/poll')) {
      polls += 1
      if (polls === 1) return new Response('Not found', { status: 404 })
      return Response.json({ accessToken: 'dash-access', refreshToken: 'dash-refresh' })
    }
    if (target.endsWith('CreateUserApiKey')) {
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), 'Bearer dash-access')
      return Response.json({ apiKey: 'key-1' })
    }
    if (target.endsWith('GetMe')) return Response.json({ email: 'a@example.com' })
    return new Response('unexpected', { status: 500 })
  })
}

test('cursor session keeps the API key and keys accounts by email', () => {
  const session = cursorSession('key-1', 1_700_000_000_000, 'a@example.com')
  assert.equal(session.accessToken, 'key-1')
  assert.equal(session.refreshToken, 'key-1')
  assert.equal(accountKeyOf('cursor', session), 'a@example.com')
  // Without an email the account takes a random id, not one derived from the API key.
  assert.match(accountKeyOf('cursor', cursorSession('key-2', 1)), /^account-[0-9a-f]{16}$/)
})

test('refreshCursor keeps a live key and rejects an expired one', async () => {
  const live = cursorSession('key-1', Date.now() + 60_000, 'a@example.com')
  assert.equal(await refreshCursor(live), live)
  const expired = cursorSession('key-1', Date.now() - 1, 'a@example.com')
  await assert.rejects(refreshCursor(expired), (error: unknown) => {
    assert.equal(isCursorPermanentRefreshError(error), true)
    return true
  })
})

test('renderCursorTurn keeps the transcript and refuses developer messages', () => {
  const turn = renderCursorTurn([
    { role: 'system', content: [{ type: 'text', text: 'Be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'Hi' }, { type: 'reasoning', text: 'hidden' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-1', name: 'echo', arguments: '{"text":"hi"}' }],
      source: { kind: 'model', provider: 'cursor', model: 'composer-2.5' },
    },
    {
      role: 'tool',
      toolCallId: 'call-1' as never,
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'tool', provider: 'cursor', name: 'echo' },
    },
    {
      role: 'user',
      content: [{ type: 'image', mediaType: 'image/png', dataBase64: 'aaaa' }],
    },
  ] as never, 'extra')
  assert.equal(turn.system, 'extra\n\nBe brief')
  assert.match(turn.prompt, /\[user\]\nHi/)
  assert.equal(turn.prompt.includes('hidden'), false)
  assert.match(turn.prompt, /tool echo \(call-1\): \{"text":"hi"\}/)
  assert.match(turn.prompt, /tool_result call-1: hi/)
  assert.deepEqual(turn.images, [{ data: 'aaaa', mimeType: 'image/png' }])
  assert.throws(
    () => renderCursorTurn([{ role: 'developer', content: [] }] as never, undefined),
    { message: /developer messages are not supported/ },
  )
})

test('beginCursorLogin returns the browser URL and stores the minted key', async () => {
  installCursorLoginFetch()
  const handle = beginCursorLogin()
  const authorizeUrl = await handle.authorizeUrl
  assert.match(authorizeUrl, /^https:\/\/cursor\.com\/loginDeepControl\?/)
  const session = await handle.done
  assert.equal(session.accessToken, 'key-1')
  assert.equal(session.refreshToken, 'key-1')
  assert.equal(session.dashboardAccessToken, 'dash-access')
  assert.equal(session.dashboardRefreshToken, 'dash-refresh')
  assert.equal(session.email, 'a@example.com')
  assert.ok(session.expiresAt > Date.now())
})

test('login(cursor) persists the account and does not start another provider flow', async () => {
  await inIsolatedHome(async () => {
    installCursorLoginFetch()
    const controller = new SubscriptionsAuthController(
      new OAuthFlowManager(),
      new DeviceFlowManager(),
      () => undefined,
      () => undefined,
    )
    const { authorizeUrl } = await controller.login('cursor')
    assert.match(authorizeUrl, /^https:\/\/cursor\.com\/loginDeepControl\?/)
    assert.equal((await controller.status('cursor')).busy, true)
    assert.equal((await controller.status('codex')).busy, false)
    await controller.settled('cursor')
    const accounts = await listAccounts('cursor')
    assert.equal(accounts.length, 1)
    assert.equal(accounts[0]?.session.accessToken, 'key-1')
    assert.equal(accounts[0]?.session.dashboardAccessToken, 'dash-access')
    assert.equal((await controller.status('cursor')).busy, false)
  })
})

test('cursor catalog parameters become reasoning, context, and fast', () => {
  const model = cursorDiscoveredModel({
    id: 'claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    parameters: [
      {
        id: 'context',
        values: [{ value: '300k', displayName: '300K' }, { value: '1m', displayName: '1M' }],
      },
      {
        id: 'effort',
        values: [{ value: 'low', displayName: 'Low' }, { value: 'high', displayName: 'High' }],
      },
      { id: 'fast', values: [{ value: 'false' }, { value: 'true', displayName: 'Fast' }] },
    ],
    variants: [{
      isDefault: true,
      params: [
        { id: 'context', value: '1m' },
        { id: 'effort', value: 'high' },
        { id: 'fast', value: 'false' },
      ],
    }],
  })
  assert.ok(model)
  assert.equal(model.contextWindow, 1_000_000)
  assert.equal(model.maxContextWindow, 1_000_000)
  assert.equal(model.fastTier, true)
  assert.deepEqual(model.reasoning?.efforts.map(effort => String(effort.id)), ['low', 'high'])
  assert.equal(model.reasoning?.defaultEffort, 'high')
  assert.deepEqual(cursorRequestParams(model, 'low', true), [
    { id: 'context', value: '1m' },
    { id: 'effort', value: 'low' },
    { id: 'fast', value: 'true' },
  ])
  assert.equal(cursorContextChoice(model, 200_000), '300k')
  assert.equal(cursorContextAttempt(model, 1_000_000, new Set()), '1m')
  assert.equal(cursorContextAttempt(model, 1_000_000, new Set(['1m'])), '300k')
  assert.equal(cursorContextAttempt(model, 1_000_000, new Set(['1m', '300k'])), undefined)
  assert.deepEqual(cursorRequestParams(model, undefined, undefined, '300k'), [
    { id: 'context', value: '300k' },
    { id: 'effort', value: 'high' },
    { id: 'fast', value: 'false' },
  ])
})

test('a Cursor turn disables built-in tools and hands the first custom tool back', async () => {
  const created: { apiKey?: string; tools?: unknown; cwd?: string; prompt?: string; params?: unknown } = {}
  let disposed = false
  setCursorSdkLoader(async () => ({
    Cursor: {
      auth: { login: async () => { throw new Error('not used') } },
      models: {
        async list(options: { apiKey: string }) {
          assert.equal(options.apiKey, 'key-1')
          return [{
            id: 'composer-2.5',
            displayName: 'Composer 2.5',
            description: 'coding',
            parameters: [
              { id: 'effort', values: [{ value: 'low', displayName: 'Low' }, { value: 'high', displayName: 'High' }] },
              { id: 'fast', values: [{ value: 'false' }, { value: 'true', displayName: 'Fast' }] },
            ],
            variants: [{
              isDefault: true,
              params: [{ id: 'effort', value: 'high' }, { id: 'fast', value: 'false' }],
            }],
          }]
        },
      },
    },
    Agent: {
      async create(options: {
        apiKey: string
        tools: unknown
        model: { params?: unknown }
        local: {
          cwd: string
          customTools?: Record<string, {
            execute: (args: Record<string, unknown>, context: { toolCallId?: string }) => string
          }>
        }
      }) {
        created.apiKey = options.apiKey
        created.tools = options.tools
        created.cwd = options.local.cwd
        created.params = options.model.params
        return {
          async send(input: string | { text: string }) {
            created.prompt = typeof input === 'string' ? input : input.text
            return {
              usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 7 },
              async *stream() {
                yield { type: 'thinking', text: 'hmm' }
                yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }
                options.local.customTools?.echo?.execute({ text: 'hi' }, { toolCallId: 'call-1' })
                yield { type: 'tool_call', name: 'echo', status: 'running' }
              },
              async cancel() { return undefined },
            }
          },
          async [Symbol.asyncDispose]() { disposed = true },
        }
      },
    },
    JsonlLocalAgentStore: class { constructor(readonly dir: string) {} },
  }))
  const session = cursorSession('key-1', Date.now() + 60_000, 'a@example.com')
  const tokens = {
    session: async () => session,
    list: async () => [{ key: 'a@example.com', session }],
    hasSession: async () => true,
    defaultAccount: async () => 'a@example.com',
  } as AccountTokenManager<CursorSession>
  const adapter = new CursorAdapter({
    models: [{ id: 'composer-2.5', name: 'Composer 2.5' }],
    streamIdleTimeoutMs: 5_000,
    tokens,
    discovery: true,
  })
  const models = await adapter.listOwnModels('cursor', 'a@example.com')
  assert.deepEqual(models.map(model => model.id), ['composer-2.5'])
  const chunks: StreamChunk[] = []
  const options = {
    provider: 'cursor',
    model: 'composer-2.5',
    system: 'Be brief',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    tools: [{ name: 'echo', description: 'Echo text', parameters: { type: 'object' } }],
  } as GenerateOptions
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  assert.equal(created.apiKey, 'key-1')
  assert.deepEqual(created.tools, ['mcp'])
  assert.match(created.cwd ?? '', /dsh-cursor/)
  assert.match(created.prompt ?? '', /Be brief/)
  assert.deepEqual(created.params, [
    { id: 'effort', value: 'high' },
    { id: 'fast', value: 'false' },
  ])
  assert.equal(disposed, true)
  const text = chunks.find(chunk => chunk.type === 'text-delta')
  assert.equal(text?.type === 'text-delta' ? text.text : '', 'hello')
  const reasoning = chunks.find(chunk => chunk.type === 'reasoning-delta')
  assert.equal(reasoning?.type === 'reasoning-delta' ? reasoning.text : '', 'hmm')
  const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.equal(call?.type === 'block-end' && call.block.type === 'tool-call' ? call.block.name : '', 'echo')
  assert.equal(call?.type === 'block-end' && call.block.type === 'tool-call' ? call.block.arguments : '', '{"text":"hi"}')
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.deepEqual(finish?.type === 'finish' ? finish.reason : undefined, { kind: 'tool-calls' })
})

test('cursor assistant tokens stay in one text block', () => {
  const cursor = { index: 0 }
  const prose = { block: undefined }
  const chunks: StreamChunk[] = []
  for (const text of ['我', '是', '**', 'G', 'rok']) {
    chunks.push(...eventChunks({ type: 'assistant', message: { content: [{ type: 'text', text }] } }, cursor, prose))
  }
  chunks.push(...closeCursorProse(prose))
  const starts = chunks.filter(chunk => chunk.type === 'block-start')
  const end = chunks.find(chunk => chunk.type === 'block-end')
  assert.equal(starts.length, 1)
  assert.equal(end?.type === 'block-end' && end.block.type === 'text' ? end.block.text : '', '我是**Grok')
})

test('cursor usage maps the dashboard snapshot and skips accounts without dashboard tokens', async () => {
  const session = cursorSession('key-1', Date.now() + 60_000, 'a@example.com', {
    accessToken: 'dash-access',
    refreshToken: 'dash-refresh',
  })
  let calls = 0
  const usage = await fetchCursorUsage(session, async (url) => {
    calls += 1
    const target = String(url)
    if (target.endsWith('GetCurrentPeriodUsage')) {
      return Response.json({
        billingCycleEnd: '1792955297000',
        planUsage: { apiPercentUsed: 46.4, autoPercentUsed: 10 },
      })
    }
    if (target.endsWith('GetPlanInfo')) return Response.json({ planInfo: { planName: 'Ultra' } })
    return new Response('unexpected', { status: 500 })
  })
  assert.equal(calls, 2)
  assert.equal(usage.supported, true)
  assert.equal(usage.plan, 'Ultra')
  assert.equal(usage.windows?.[0]?.scope, 'API')
  assert.equal(usage.windows?.[0]?.usedPercent, 46.4)
  assert.equal(usage.windows?.[0]?.resetsAt, 1_792_955_297_000)
  assert.equal(usage.windows?.[1]?.scope, 'Auto')
  await assert.rejects(
    fetchCursorUsage(cursorSession('key-1', Date.now() + 60_000, 'a@example.com'), async () => {
      throw new Error('should not fetch')
    }),
    { message: /new login/ },
  )
})

test('cursor usage refreshes a rejected dashboard token once and persists it', async () => {
  const session = cursorSession('key-1', Date.now() + 60_000, 'a@example.com', {
    accessToken: 'dash-old',
    refreshToken: 'dash-refresh',
  })
  let usageCalls = 0
  const saved: unknown[] = []
  const usage = await loadCursorAccountUsage(session, async (url) => {
    const target = String(url)
    if (target.endsWith('/oauth/token')) {
      return Response.json({ access_token: 'dash-new', refresh_token: 'dash-refresh-2' })
    }
    if (target.endsWith('GetCurrentPeriodUsage')) {
      usageCalls += 1
      if (usageCalls === 1) return Response.json({ error: 'invalid_token' }, { status: 401 })
      return Response.json({ planUsage: { totalPercentUsed: 12 } })
    }
    if (target.endsWith('GetPlanInfo')) return Response.json({ planInfo: { planName: 'Pro' } })
    return new Response('unexpected', { status: 500 })
  }, undefined, async (next) => { saved.push(next) })
  assert.equal(usage.windows?.[0]?.usedPercent, 12)
  assert.equal(saved.length, 1)
  assert.equal((saved[0] as { dashboardAccessToken: string }).dashboardAccessToken, 'dash-new')
  assert.equal((saved[0] as { accessToken: string }).accessToken, 'key-1')
})
