/**
 * The shared subscription cache's contract, asserted without a DOM: one read
 * per account at a time, duplicate events folding into the read already
 * running, an explicit refresh riding on that read instead of starting a
 * second one, roster pruning, and last-known values surviving a failed or
 * stale revalidation. No path here runs on a timer, so nothing in this spec
 * advances a clock to prove that idle time issues no read.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
// The section module (imported for its wire types only) ships CSS modules; this
// spec needs only their empty class map, not a browser stylesheet loader.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css')
    ? { format: 'module', source: 'export default {}', shortCircuit: true }
    : nextLoad(url, context)
} })
const { createSubscriptionsCache } = await import('../src/client/subscriptions-cache.js')
css.deregister()
import type { SubscriptionsCache } from '../src/client/subscriptions-cache.js'
import type { ProviderStatus, ProviderUsage } from '../src/client/SubscriptionsSection.js'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'

/** One recorded `usage` call. */
interface UsageCall {
  provider: string
  account: string
  payload: Record<string, unknown>
}

/** A scripted `subscriptions-auth` face recording every usage read. */
function scripted(): {
  rpc: ConnectionHandle['rpc']
  calls: UsageCall[]
  statusCalls: () => number
  roster: (accounts: string[], provider?: string) => void
  answer: (usage: ProviderUsage) => void
  fail: (message: string) => void
  settle: () => Promise<void>
} {
  const calls: UsageCall[] = []
  let statusCalls = 0
  let roster: Record<string, ProviderStatus> = {}
  let pending: (() => void)[] = []
  let nextUsage: ProviderUsage = { supported: true, windows: [] }
  let failure: string | undefined
  const rpc: ConnectionHandle['rpc'] = {
    call: (_channel, endpoint, payload) => {
      if (endpoint === 'subscriptions-auth.status') {
        statusCalls += 1
        return Promise.resolve({ ok: true as const, value: { providers: roster } })
      }
      const body = payload as { provider: string; account: string }
      calls.push({ provider: body.provider, account: body.account, payload: payload as Record<string, unknown> })
      // Each read captures the answer scripted when it STARTED, so two reads in
      // flight at once can be told apart when they settle.
      const usage = nextUsage
      const failed = failure
      return new Promise((resolve, reject) => {
        pending.push(() => {
          if (failed === undefined) resolve({ ok: true as const, value: usage })
          else reject(new Error(failed))
        })
      })
    },
  }
  return {
    rpc,
    calls,
    statusCalls: () => statusCalls,
    roster: (accounts, provider = 'codex') => {
      roster = {
        [provider]: {
          busy: false,
          // The credential dimension is part of every account row; these fixtures are
          // logged in with nothing parked.
          accounts: accounts.map(key => ({ key, isDefault: key === accounts[0], credential: { state: 'ready' as const } })),
        },
      }
    },
    answer: (usage) => { nextUsage = usage; failure = undefined },
    fail: (message) => { failure = message },
    settle: async () => {
      const waiting = pending
      pending = []
      for (const release of waiting) release()
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}

/** A cache over the scripted face, with a roster of one codex account. */
function cacheOf(scriptedFace: ReturnType<typeof scripted>): SubscriptionsCache {
  scriptedFace.roster(['default'])
  return createSubscriptionsCache(scriptedFace.rpc)
}

test('a plain read sends no refresh flag; the explicit controls are the only ones that do', async () => {
  const face = scripted()
  const cache = cacheOf(face)
  face.answer({ supported: true, windows: [{ kind: 'session', usedPercent: 10 }], cache: { state: 'fresh' } })
  await cache.readStatus()
  assert.deepEqual(face.calls.map(call => call.payload), [
    { provider: 'codex', account: 'default' },
  ], 'mount reads the local snapshot with no refresh key')
  await face.settle()

  void cache.readUsage('codex', 'default', 'if-needed')
  await face.settle()
  void cache.readUsage('codex', 'default', 'force')
  await face.settle()
  assert.deepEqual(face.calls.slice(1).map(call => call.payload), [
    { provider: 'codex', account: 'default', refresh: true },
    { provider: 'codex', account: 'default', force: true },
  ])
})

test('duplicate events for one account fold into the read already running', async () => {
  const face = scripted()
  const cache = cacheOf(face)
  const first = cache.readUsage('codex', 'default', 'local')
  const second = cache.readUsage('codex', 'default', 'local')
  assert.equal(face.calls.length, 1, 'the second event starts nothing')
  await face.settle()
  await Promise.all([first, second])
  assert.equal(face.calls.length, 1)
})

test('an if-needed refresh requested mid-read is served once the local read settles', async () => {
  const face = scripted()
  const cache = cacheOf(face)
  void cache.readUsage('codex', 'default', 'local')
  void cache.readUsage('codex', 'default', 'if-needed')
  assert.equal(face.calls.length, 1, 'the refresh rides the read already running')
  await face.settle()
  // The fold re-issues exactly one read with the stronger mode, and never the weaker one again.
  await face.settle()
  assert.deepEqual(face.calls.map(call => call.payload), [
    { provider: 'codex', account: 'default' },
    { provider: 'codex', account: 'default', refresh: true },
  ])
})

test('a weaker request never downgrades the stronger one already queued', async () => {
  const face = scripted()
  const cache = cacheOf(face)
  // A local read is running, a manual Refresh queues a forced read, and a
  // details-open then asks for an if-needed one. Publishing the weaker request
  // would silently drop the refresh the user asked for.
  void cache.readUsage('codex', 'default', 'local')
  void cache.readUsage('codex', 'default', 'force')
  void cache.readUsage('codex', 'default', 'if-needed')
  assert.equal(face.calls.length, 1)
  await face.settle()
  await face.settle()
  assert.deepEqual(face.calls.map(call => call.payload), [
    { provider: 'codex', account: 'default' },
    { provider: 'codex', account: 'default', force: true },
  ], 'the queued forced read survives a later weaker request')
})

test('a failed read keeps the account\'s last known usage and records why it is not fresh', async () => {
  const face = scripted()
  const cache = cacheOf(face)
  face.answer({ supported: true, windows: [{ kind: 'session', usedPercent: 42 }], plan: 'pro' })
  await cache.readStatus()
  await face.settle()
  assert.equal(cache.source.getSnapshot().usage['codex:default']?.usage?.windows?.[0]?.usedPercent, 42)

  face.fail('offline')
  void cache.readUsage('codex', 'default', 'force')
  await face.settle()
  const entry = cache.source.getSnapshot().usage['codex:default']
  assert.equal(entry?.error, 'offline')
  assert.equal(entry?.usage?.windows?.[0]?.usedPercent, 42, 'the windows the user was reading stay')
  assert.equal(entry?.usage?.plan, 'pro')
})

test('a stale or failed revalidation that carries no windows keeps the last known ones', async () => {
  const face = scripted()
  const cache = cacheOf(face)
  face.answer({ supported: true, windows: [{ kind: 'weekly', usedPercent: 7 }] })
  await cache.readStatus()
  await face.settle()

  for (const state of ['stale', 'error'] as const) {
    face.answer({ supported: true, windows: [], cache: { state, observedAt: 1_700_000_000_000 } })
    void cache.readUsage('codex', 'default', 'if-needed')
    await face.settle()
    const usage = cache.source.getSnapshot().usage['codex:default']?.usage
    assert.equal(usage?.windows?.[0]?.usedPercent, 7, state)
    assert.equal(usage?.cache?.state, state)
  }
})

test('missing is stored as missing: no window is invented and none is zeroed', async () => {
  const face = scripted()
  const cache = cacheOf(face)
  face.answer({ supported: true, cache: { state: 'missing' } })
  await cache.readStatus()
  await face.settle()
  const usage = cache.source.getSnapshot().usage['codex:default']?.usage
  assert.equal(usage?.cache?.state, 'missing')
  assert.equal(usage?.windows, undefined)
})

test('the roster drops a logged-out account and leaves every other entry alone', async () => {
  const face = scripted()
  const cache = cacheOf(face)
  face.roster(['a', 'b'])
  await cache.readStatus()
  await face.settle()
  assert.deepEqual(Object.keys(cache.source.getSnapshot().usage).sort(), ['codex:a', 'codex:b'])

  face.roster(['b'])
  await cache.readStatus({ fresh: true })
  await face.settle()
  assert.deepEqual(Object.keys(cache.source.getSnapshot().usage), ['codex:b'])
  assert.deepEqual(cache.accountsOf('codex'), ['b'])
})

test('the roster is read once per duplicate event and never on idle time', async () => {
  const face = scripted()
  const cache = cacheOf(face)
  await Promise.all([cache.readStatus(), cache.readStatus(), cache.readStatus()])
  assert.equal(face.statusCalls(), 1, 'concurrent readers share one roster read')
  // An idle cache schedules nothing: only an event asks for another read.
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(face.statusCalls(), 1)
  await cache.readStatus({ fresh: true })
  assert.equal(face.statusCalls(), 2, 'a user action reads the roster again')
})

test('an idle cache issues no further read', async () => {
  const face = scripted()
  const cache = cacheOf(face)
  face.answer({ supported: true, windows: [{ kind: 'session', usedPercent: 1 }] })
  await cache.readStatus()
  await face.settle()
  const settled = face.calls.length
  // Nothing schedules work: an idle interval has to leave the read count alone.
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(face.calls.length, settled)
  assert.equal(cache.source.getSnapshot().loading['codex:default'], undefined)
})

test('a read that outlives its account does not resurrect the logged-out row', async () => {
  const face = scripted()
  const cache = cacheOf(face)
  face.roster(['a', 'b'])
  await cache.readStatus()
  // `a` logs out while its read is still running; the answer must not bring the row back.
  face.roster(['b'])
  await cache.readStatus({ fresh: true })
  await face.settle()
  await face.settle()
  assert.deepEqual(Object.keys(cache.source.getSnapshot().usage), ['codex:b'])
})

test('a logout and re-login of the same account discards the pre-logout answer', async () => {
  const face = scripted()
  const cache = cacheOf(face)
  const windows = (usedPercent: number): ProviderUsage => ({
    supported: true,
    windows: [{ kind: 'session', usedPercent }],
  })

  // An account logs out while its read is still running, then logs back in under
  // the same key before that answer lands. The old answer belongs to the previous
  // login: it must neither publish over the new one nor be joined by it.
  face.answer(windows(10))
  void cache.readUsage('codex', 'default', 'local')
  face.roster([], 'codex')
  await cache.readStatus({ fresh: true })
  assert.equal(cache.source.getSnapshot().loading['codex:default'], undefined, 'the dropped read released its slot')

  face.roster(['default'], 'codex')
  face.answer(windows(90))
  await cache.readStatus({ fresh: true })
  assert.equal(face.calls.length, 2, 'the re-login started its own read instead of joining the old one')
  await face.settle()

  const entry = cache.source.getSnapshot().usage['codex:default']
  assert.equal(entry?.usage?.windows?.[0]?.usedPercent, 90, 'the post-login answer is the one on screen')
})

test('reset forgets the roster and discards a read the previous Host generation started', async () => {
  const face = scripted()
  const cache = cacheOf(face)
  face.answer({ supported: true, windows: [{ kind: 'session', usedPercent: 33 }] })
  await cache.readStatus()
  await face.settle()
  assert.equal(Object.keys(cache.source.getSnapshot().usage).length, 1)

  // A reconnect: the old Host's answer is still in flight and must not repopulate the cache.
  void cache.readUsage('codex', 'default', 'local')
  cache.reset()
  assert.deepEqual(cache.source.getSnapshot(), { status: undefined, usage: {}, loading: {} })
  await face.settle()
  await face.settle()
  assert.deepEqual(cache.source.getSnapshot(), { status: undefined, usage: {}, loading: {} })
})

test('dispose stops publishing, and a later read is refused rather than served', async () => {
  const face = scripted()
  const cache = cacheOf(face)
  await cache.readStatus()
  cache.dispose()
  assert.deepEqual(cache.source.getSnapshot(), { status: undefined, usage: {}, loading: {} })
  const refused = await cache.readStatus()
  assert.equal(refused.ok, false)
  await face.settle()
  assert.deepEqual(cache.source.getSnapshot().usage, {}, 'a read after teardown publishes nothing')
})
