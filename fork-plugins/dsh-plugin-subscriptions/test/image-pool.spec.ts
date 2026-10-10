import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { ImageAccountPool } from '../src/providers/image-pool.js'
import { codexRateLimitReset } from '../src/providers/codex.js'
import { ENFORCEMENT_CODE } from '../src/providers/common.js'
import { DEFAULT_QUOTA_COOLDOWN_MS, TRANSIENT_COOLDOWN_MS } from '../src/providers/pool-health.js'

function fixture() {
  const entries = ['first', 'second'].map(key => ({ key, session: { accessToken: key, refreshToken: key, expiresAt: Date.now() + 3600000 } }))
  let refreshes = 0
  const tokens = new AccountTokenManager({ provider: 'codex', displayName: 'Test',
    makeOptions: () => ({ preemptMs: 0, refresh: async session => { refreshes++; return { ...session, accessToken: session.accessToken + '-fresh' } }, isPermanent: () => false }),
    io: { list: async () => entries, get: async key => entries.find(e => e.key === (key ?? entries[0]?.key))?.session,
      save: async (key, session) => { const entry = entries.find(e => e.key === key); if (entry) entry.session = session },
      remove: async key => { const index = entries.findIndex(e => e.key === key); if (index >= 0) entries.splice(index, 1) } } })
  return { tokens, entries, refreshes: () => refreshes }
}
const signal = new AbortController().signal
const quota = () => new Response(JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: 3600 } }), { status: 429 })

test('image pool: 429 switches accounts; generate/edit share affinity and cooldown; auth clears health', async () => {
  const { tokens } = fixture()
  const warnings: string[] = []
  const pool = new ImageAccountPool({ onWarn: message => warnings.push(message) })
  const attempts: string[] = []
  const owner = {}
  const options = { provider: 'codex' as const, tokens, owner, signal, rateLimitReset: codexRateLimitReset,
    send: async (session: { accessToken: string }) => { attempts.push(session.accessToken); return session.accessToken === 'first' ? quota() : new Response('ok') } }
  assert.equal(await (await pool.request(options)).text(), 'ok')
  assert.deepEqual(attempts, ['first', 'second'])
  assert.equal(warnings.length, 1)
  assert.ok(!warnings[0].includes('first'), 'logs do not expose account keys or tokens')
  await pool.request(options)
  await pool.request({ ...options, owner: {} })
  assert.deepEqual(attempts, ['first', 'second', 'second', 'second'])
  pool.clear('codex', 'first')
  await pool.request(options)
  assert.deepEqual(attempts.slice(-2), ['first', 'second'])
})

test('image pool: all accounts exhausted is bounded and later calls respect provider reset', async () => {
  const { tokens } = fixture()
  const pool = new ImageAccountPool()
  let attempts = 0
  const options = { provider: 'codex' as const, tokens, signal, rateLimitReset: codexRateLimitReset,
    send: async () => { attempts++; return quota() } }
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => pool.request(options), (e: unknown) => e instanceof LlmError && e.code === 'RATE_LIMIT' && (e.failure.providerRetryAfterMs ?? 0) > 3500000)
  }
  assert.equal(attempts, 2)
})

test('image pool: a 401 refreshes once, then ends the attempt if the account stays unauthorized', async () => {
  const { tokens, refreshes } = fixture()
  const attempts: string[] = []
  const pool = new ImageAccountPool()
  await assert.rejects(
    () => pool.request({ provider: 'codex', tokens, signal, rateLimitReset: codexRateLimitReset,
      send: async session => { attempts.push(session.accessToken); return new Response('', { status: session.accessToken.startsWith('first') ? 401 : 200 }) } }),
    // An auth refusal is aimed at the account, not at the request: the sibling is
    // never asked, and the one forced refresh above is the only retry it gets.
    (error: unknown) => error instanceof LlmError && error.code === 'AUTH',
  )
  assert.deepEqual(attempts, ['first', 'first-fresh'])
  assert.equal(refreshes(), 1)
})

test('image pool: recovered 401 uses refreshed credentials without another account', async () => {
  const { tokens, refreshes } = fixture()
  const attempts: string[] = []
  await new ImageAccountPool().request({ provider: 'codex', tokens, signal, rateLimitReset: codexRateLimitReset,
    send: async session => { attempts.push(session.accessToken); return new Response('', { status: session.accessToken === 'first' ? 401 : 200 }) } })
  assert.deepEqual(attempts, ['first', 'first-fresh'])
  assert.equal(refreshes(), 1)
})

for (const status of [400, 408, 500, 504]) {
  test(`image pool: HTTP ${status} does not risk duplicate image generation`, async () => {
    const { tokens } = fixture()
    let attempts = 0
    await assert.rejects(() => new ImageAccountPool().request({ provider: 'codex', tokens, signal, rateLimitReset: codexRateLimitReset,
      send: async () => { attempts++; return new Response('failure', { status }) } }))
    assert.equal(attempts, 1)
  })
}

test('image pool: transport failures and cancellation do not switch accounts', async () => {
  const { tokens } = fixture()
  let attempts = 0
  const options = { provider: 'codex' as const, tokens, signal, rateLimitReset: codexRateLimitReset,
    send: async () => { attempts++; throw new TypeError('connection lost') } }
  await assert.rejects(() => new ImageAccountPool().request(options), /connection lost/)
  await assert.rejects(() => new ImageAccountPool().request({ ...options, signal: AbortSignal.abort() }))
  assert.equal(attempts, 1)
})

test('image pool: an enforcement refusal parks the account and ends the attempt', async () => {
  const { tokens } = fixture()
  const pool = new ImageAccountPool()
  const attempts: string[] = []
  const options = { provider: 'codex' as const, tokens, signal, rateLimitReset: codexRateLimitReset,
    send: async (session: { accessToken: string }) => {
      attempts.push(session.accessToken)
      return session.accessToken === 'first'
        // The window is disclosed; the stop-retry header alone makes it final.
        ? new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
          status: 429,
          headers: { 'retry-after': '600', 'x-should-retry': 'false' },
        })
        : new Response('ok')
    } }
  await assert.rejects(
    () => pool.request(options),
    (error: unknown) => error instanceof LlmError && error.code === ENFORCEMENT_CODE,
  )
  assert.deepEqual(attempts, ['first'], 'the sibling image account is never asked')
  // The refusal parked the account for its own reset, so the next attempt skips it.
  assert.equal(await (await pool.request(options)).text(), 'ok')
  assert.deepEqual(attempts, ['first', 'second'])
})

test('image pool: a refusal outranks a sibling rate limit when the pool is exhausted', async () => {
  const { tokens } = fixture()
  const pool = new ImageAccountPool()
  const attempts: string[] = []
  const base = { provider: 'codex' as const, tokens, signal, rateLimitReset: codexRateLimitReset }
  // The default account is refused, which ends that attempt.
  await assert.rejects(
    () => pool.request({ ...base, send: async (session: { accessToken: string }) => {
      attempts.push(session.accessToken)
      return new Response('{"type":"error","error":{"type":"permission_error"}}', { status: 403 })
    } }),
    (error: unknown) => error instanceof LlmError && error.code === 'AUTH',
  )
  assert.deepEqual(attempts, ['first'])
  // Only the sibling is left, and it rate-limits with a disclosed reset.
  await assert.rejects(
    () => pool.request({ ...base, send: async (session: { accessToken: string }) => {
      attempts.push(session.accessToken)
      return quota()
    } }),
    (error: unknown) => error instanceof LlmError && error.code === 'RATE_LIMIT',
  )
  assert.deepEqual(attempts, ['first', 'second'])
  // Every account is parked now: the pool names the refusal, not the rate limit,
  // so a refused pool is not handed back to the retry loop.
  await assert.rejects(
    () => pool.request({ ...base, send: async () => { throw new Error('unreachable') } }),
    (error: unknown) => error instanceof LlmError && error.code === 'AUTH',
  )
})

test('image pool: a refusal with no disclosed reset parks the account for the quota cooldown', async () => {
  const { tokens } = fixture()
  const pool = new ImageAccountPool()
  const base = { provider: 'codex' as const, tokens, signal, rateLimitReset: codexRateLimitReset }
  const refuse = () => new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
    status: 429,
    headers: { 'x-should-retry': 'false' },
  })
  for (const _ of ['first', 'second']) {
    await assert.rejects(
      () => pool.request({ ...base, send: async () => refuse() }),
      (error: unknown) => error instanceof LlmError && error.code === ENFORCEMENT_CODE,
    )
  }
  await assert.rejects(
    () => pool.request({ ...base, send: async () => new Response('ok') }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, ENFORCEMENT_CODE)
      // No window was disclosed, so the account sits out the quota cooldown: not the
      // shorter transient one, and not the day-long credential one.
      const retryAfter = error.failure.providerRetryAfterMs ?? 0
      assert.ok(
        retryAfter > TRANSIENT_COOLDOWN_MS && retryAfter <= DEFAULT_QUOTA_COOLDOWN_MS,
        `retry hint ${String(retryAfter)}`,
      )
      return true
    },
  )
})

test('image pool: disabled pooling uses only default; removed sticky accounts are not reused', async () => {
  const { tokens, entries } = fixture()
  let attempts = 0
  await assert.rejects(() => new ImageAccountPool({ enabled: false }).request({ provider: 'codex', tokens, signal, rateLimitReset: codexRateLimitReset,
    send: async () => { attempts++; return quota() } }))
  assert.equal(attempts, 1)
  const pool = new ImageAccountPool()
  const owner = {}
  const tried: string[] = []
  const options = { provider: 'codex' as const, tokens, owner, signal, rateLimitReset: codexRateLimitReset,
    send: async (session: { accessToken: string }) => { tried.push(session.accessToken); return new Response('ok') } }
  await pool.request(options)
  entries.shift()
  await pool.request(options)
  assert.deepEqual(tried, ['first', 'second'])
})

test('image pool: independent provider cooldowns; empty account list has login hint', async () => {
  const { tokens, entries } = fixture()
  const pool = new ImageAccountPool()
  await assert.rejects(() => pool.request({ provider: 'codex', tokens, signal, rateLimitReset: codexRateLimitReset, send: async () => quota() }))
  assert.equal((await pool.request({ provider: 'grok', tokens, signal, rateLimitReset: codexRateLimitReset, send: async () => new Response('ok') })).ok, true)
  entries.splice(0)
  await assert.rejects(() => pool.request({ provider: 'codex', tokens, signal, rateLimitReset: codexRateLimitReset, send: async () => { throw new Error('unreachable') } }), /not logged in/)
})
