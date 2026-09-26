/**
 * ChatGPT reset credits. Every HTTP call in this file uses an injected fetch
 * that never opens a socket. Nothing here can spend a live reset credit.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createFakeConnection } from './fake-connection.js'
import type { FakeRpcHandler } from './fake-connection.js'

process.env.DSH_HOME ??= mkdtempSync(join(tmpdir(), 'router-reset-credits-test-'))

const {
  CODEX_RESET_CREDITS_CONSUME_URL,
  CODEX_RESET_CREDITS_URL,
  consumeCodexResetCredit,
  fetchCodexPoolUsage,
  fetchCodexResetCredits,
  fetchCodexUsage,
} = await import('../src/providers/codex.js')
const plugin = await import('../src/index.js')
const { SubscriptionsAuthController } = plugin
const { OAuthFlowManager } = await import('../src/auth/oauth-flow.js')
const { DeviceFlowManager } = await import('../src/auth/device-flow.js')
const { PoolUsageTracker } = await import('../src/providers/pool-usage.js')
const { OAuthEndpointError } = await import('../src/providers/common.js')

import type { FetchFn, ProviderUsage } from '../src/providers/common.js'
import type { CodexSession } from '../src/auth/store.js'

const session: CodexSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  accountId: 'acct-1',
}

const CREDIT_ID = 'RateLimitResetCredit_test'
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'

interface Captured {
  url: string
  method: string
  body: string
  headers: Record<string, string>
}

/** A fetch that answers JSON and records the request. It does not use the URL. */
function fakeFetch(payload: unknown, status = 200, bodyText?: string): { fetchFn: FetchFn; requests: Captured[] } {
  const requests: Captured[] = []
  const fetchFn: FetchFn = ((url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value })
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
      headers,
    })
    const text = bodyText ?? JSON.stringify(payload)
    return Promise.resolve(new Response(text, { status, headers: { 'content-type': 'application/json' } }))
  }) as FetchFn
  return { fetchFn, requests }
}

function controller(ops?: {
  list: (account: string, signal: AbortSignal) => Promise<import('../src/providers/common.js').ResetCreditList>
  consume: (
    account: string,
    creditId: string,
    redeemRequestId: string,
    signal: AbortSignal,
  ) => Promise<import('../src/providers/common.js').ResetCreditConsumeResult>
}, poolUsage?: InstanceType<typeof PoolUsageTracker>) {
  return new SubscriptionsAuthController(
    new OAuthFlowManager(),
    new DeviceFlowManager(),
    () => {},
    () => undefined,
    { codex: () => Promise.reject(new Error('raw usage fetcher must not run when reset-credit tests attach a pool')) },
    undefined,
    poolUsage,
    {},
    ops,
  )
}

test('fetchCodexUsage copies a disclosed reset-credit count and omits a missing one', async () => {
  const withCount = fakeFetch({
    plan_type: 'plus',
    rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } },
    rate_limit_reset_credits: { available_count: 2 },
  })
  const usage = await fetchCodexUsage(session, withCount.fetchFn)
  assert.deepEqual(usage.resetCredits, { availableCount: 2 })
  assert.equal(withCount.requests[0]?.method, 'GET')
  assert.match(withCount.requests[0]?.url ?? '', /\/wham\/usage$/)

  const missing = fakeFetch({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } })
  const plain = await fetchCodexUsage(session, missing.fetchFn)
  assert.equal(plain.resetCredits, undefined)

  const junk = fakeFetch({ rate_limit_reset_credits: { available_count: -1 } })
  const ignored = await fetchCodexUsage(session, junk.fetchFn)
  assert.equal(ignored.resetCredits, undefined)
})

test('fetchCodexPoolUsage keeps the earliest available expiry and does not list credits when none are banked', async () => {
  const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
  const later = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString()
  const requests: string[] = []
  const fetchFn: FetchFn = (async (url: string | URL | Request) => {
    const href = String(url)
    requests.push(href)
    if (href.endsWith('/wham/usage')) {
      return new Response(JSON.stringify({
        rate_limit_reset_credits: { available_count: 1 },
        rate_limit: { primary_window: { used_percent: 4, limit_window_seconds: 604800 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.endsWith('/wham/rate-limit-reset-credits')) {
      return new Response(JSON.stringify({
        available_count: 1,
        credits: [
          { id: 'RateLimitResetCredit_later', status: 'available', expires_at: later },
          { id: CREDIT_ID, status: 'available', expires_at: soon },
          { id: 'RateLimitResetCredit_used', status: 'redeemed', expires_at: soon },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected url ${href}`)
  }) as FetchFn
  const usage = await fetchCodexPoolUsage(session, fetchFn)
  assert.deepEqual(requests.map(url => url.endsWith('/consume')), [false, false])
  assert.equal(usage.resetCredits?.soonestExpiresAt, Date.parse(soon))
  const empty = fakeFetch({
    rate_limit: { primary_window: { used_percent: 4, limit_window_seconds: 18000 } },
  })
  const plain = await fetchCodexPoolUsage(session, empty.fetchFn)
  assert.equal(empty.requests.length, 1)
  assert.equal(plain.resetCredits, undefined)
})

test('fetchCodexResetCredits maps rows and drops entries without an id', async () => {
  const { fetchFn, requests } = fakeFetch({
    available_count: 1,
    credits: [
      {
        id: CREDIT_ID,
        status: 'available',
        title: 'Full reset (Weekly + 5 hr)',
        reset_type: 'codex_rate_limits',
        granted_at: '2026-06-12T01:33:14Z',
        expires_at: '2026-07-12T01:33:14Z',
      },
      { status: 'available' },
      { id: 'RateLimitResetCredit_old', status: 'mystery' },
    ],
  })
  const list = await fetchCodexResetCredits(session, fetchFn)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.method, 'GET')
  assert.equal(requests[0]?.url, CODEX_RESET_CREDITS_URL)
  assert.equal(requests[0]?.headers.authorization, 'Bearer at')
  assert.equal(requests[0]?.headers['chatgpt-account-id'], 'acct-1')
  assert.deepEqual(list, {
    supported: true,
    availableCount: 1,
    credits: [
      {
        id: CREDIT_ID,
        status: 'available',
        title: 'Full reset (Weekly + 5 hr)',
        resetType: 'codex_rate_limits',
        grantedAt: '2026-06-12T01:33:14Z',
        expiresAt: '2026-07-12T01:33:14Z',
      },
      { id: 'RateLimitResetCredit_old', status: 'other' },
    ],
  })
})

test('consumeCodexResetCredit posts the caller key once and does not mint another', async () => {
  const { fetchFn, requests } = fakeFetch({
    code: 'reset',
    windows_reset: 1,
    credit: { id: CREDIT_ID, status: 'redeemed' },
  })
  const result = await consumeCodexResetCredit(session, CREDIT_ID, REQUEST_ID, fetchFn)
  assert.deepEqual(result, { code: 'reset', windowsReset: 1 })
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.method, 'POST')
  assert.equal(requests[0]?.url, CODEX_RESET_CREDITS_CONSUME_URL)
  assert.deepEqual(JSON.parse(requests[0]?.body ?? ''), {
    credit_id: CREDIT_ID,
    redeem_request_id: REQUEST_ID,
  })
})

test('consumeCodexResetCredit treats HTTP 200 with a partial body as spent, and refuses a bad id before any request', async () => {
  const partial = fakeFetch(null, 200, 'not-json')
  assert.deepEqual(await consumeCodexResetCredit(session, CREDIT_ID, REQUEST_ID, partial.fetchFn), {})
  assert.equal(partial.requests.length, 1)

  const blocked = fakeFetch({}, 200)
  await assert.rejects(
    consumeCodexResetCredit(session, 'not a credit', REQUEST_ID, blocked.fetchFn),
    /not usable/,
  )
  await assert.rejects(
    consumeCodexResetCredit(session, CREDIT_ID, 'not-a-uuid', blocked.fetchFn),
    /UUID/,
  )
  assert.equal(blocked.requests.length, 0)

  const failed = fakeFetch({ error: 'nope' }, 500)
  await assert.rejects(consumeCodexResetCredit(session, CREDIT_ID, REQUEST_ID, failed.fetchFn), /codex reset credit/)
  assert.equal(failed.requests.length, 1)
})

test('listResetCredits caches for five minutes, and a 429 cooldown ignores force', async () => {
  let calls = 0
  const listController = controller({
    list: async () => {
      calls += 1
      return { supported: true, availableCount: 1, credits: [] }
    },
    consume: async () => { throw new Error('consume must not run') },
  })
  const signal = new AbortController().signal
  await listController.listResetCredits('codex', 'a1', signal)
  await listController.listResetCredits('codex', 'a1', signal)
  assert.equal(calls, 1)
  await listController.listResetCredits('codex', 'a1', signal, true)
  assert.equal(calls, 2)

  const error = new OAuthEndpointError('codex reset credits (HTTP 429)', 429, undefined, 60_000)
  let limited = 0
  const cooling = controller({
    list: async () => {
      limited += 1
      throw error
    },
    consume: async () => { throw new Error('consume must not run') },
  })
  await assert.rejects(cooling.listResetCredits('codex', 'a1', signal), error)
  await assert.rejects(cooling.listResetCredits('codex', 'a1', signal, true), error)
  assert.equal(limited, 1)
})

test('consumeResetCredit invalidates the list cache and a usage read that was already in flight', async () => {
  let lists = 0
  let usageCalls = 0
  let releaseFirst: (usage: ProviderUsage) => void = () => {}
  const firstUsage = new Promise<ProviderUsage>((resolve) => { releaseFirst = resolve })
  const poolUsage = new PoolUsageTracker((provider, account) => {
    if (provider !== 'codex' || account !== 'a1') return undefined
    return async () => {
      usageCalls += 1
      if (usageCalls === 1) return firstUsage
      return { supported: true, windows: [{ kind: 'session', usedPercent: 0 }] }
    }
  })
  const auth = controller({
    list: async () => {
      lists += 1
      return { supported: true, availableCount: 1, credits: [{ id: CREDIT_ID, status: 'available' }] }
    },
    consume: async (_account, creditId, redeemRequestId) => {
      assert.equal(creditId, CREDIT_ID)
      assert.equal(redeemRequestId, REQUEST_ID)
      return { code: 'reset', windowsReset: 1 }
    },
  }, poolUsage)
  const signal = new AbortController().signal
  await auth.listResetCredits('codex', 'a1', signal)
  assert.equal(lists, 1)
  const staleUsage = auth.usage('codex', 'a1', signal)
  await auth.consumeResetCredit('codex', 'a1', CREDIT_ID, REQUEST_ID, signal)
  const fresh = await auth.usage('codex', 'a1', signal)
  assert.equal(fresh.windows?.[0]?.usedPercent, 0)
  releaseFirst({ supported: true, windows: [{ kind: 'session', usedPercent: 100 }] })
  assert.equal((await staleUsage).windows?.[0]?.usedPercent, 100)
  const kept = await auth.usage('codex', 'a1', signal)
  assert.equal(kept.windows?.[0]?.usedPercent, 0, 'the older usage response must not replace the post-spend snapshot')
  await auth.listResetCredits('codex', 'a1', signal)
  assert.equal(lists, 2)
})

test('reset credits are unavailable for other providers and do not call the ChatGPT operations', async () => {
  let calls = 0
  const auth = controller({
    list: async () => {
      calls += 1
      return { supported: true, availableCount: 0, credits: [] }
    },
    consume: async () => {
      calls += 1
      return {}
    },
  })
  assert.deepEqual(await auth.listResetCredits('claude', 'a1', new AbortController().signal), { supported: false })
  await assert.rejects(auth.consumeResetCredit('claude', 'a1', CREDIT_ID, REQUEST_ID, new AbortController().signal), /unavailable/)
  assert.equal(calls, 0)
})

async function mount(): Promise<FakeRpcHandler> {
  const ctx = new Context()
  ctx.provide('llm', { registerAdapter: () => Object.assign(() => {}, { replace: () => {} }) })
  const fake = createFakeConnection()
  ctx.provide('connection', fake.connection)
  ctx.plugin(plugin, { providers: ['codex'] })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(fake.registered(), 'the subscriptions-auth routes were registered')
  return fake.handler
}

test('consumeResetCredit rejects a non-UUID before looking up an account', async () => {
  const handler = await mount()
  const result = await handler('consumeResetCredit', {
    provider: 'codex',
    account: 'a1',
    creditId: CREDIT_ID,
    redeemRequestId: 'same-key-again',
  }, new AbortController().signal)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'bad-request')
    assert.match(result.error.message, /UUID/)
  }
})

test('resetCredits for a non-ChatGPT provider answers supported:false', async () => {
  const handler = await mount()
  const result = await handler('resetCredits', { provider: 'grok', account: 'a1' }, new AbortController().signal)
  assert.deepEqual(result, { ok: true, value: { supported: false } })
})
