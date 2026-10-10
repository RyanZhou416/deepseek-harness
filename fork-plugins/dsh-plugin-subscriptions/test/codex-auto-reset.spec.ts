/** All quota and credit operations are injected; these tests cannot spend live credits. */
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAutoReset } from '../src/providers/codex-auto-reset.js'
import type { CodexAutoResetOptions } from '../src/providers/codex-auto-reset.js'
import type { ProviderUsage, ResetCredit, ResetCreditList } from '../src/providers/common.js'
import { CodexAdapter } from '../src/providers/codex.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { CodexSession } from '../src/auth/store.js'

const signal = () => new AbortController().signal
const credit = (id: string, hours: number): ResetCredit => ({
  id, status: 'available', expiresAt: new Date(Date.now() + hours * 3_600_000).toISOString(), resetType: 'codex_rate_limits',
})
const usage = (usedPercent: number): ProviderUsage => ({
  supported: true, windows: [{ kind: 'weekly', usedPercent, resetsAt: Date.now() + 86_400_000 }],
})
const listed = (...credits: ResetCredit[]): ResetCreditList => ({ supported: true, credits, availableCount: credits.filter(card => card.status === 'available').length })

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-auto-reset-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const state = { enabled: true, used: 100, spends: [] as string[], lists: [] as string[], warnings: [] as string[], changed: 0 }
  const cards: Record<string, ResetCreditList> = { current: listed(credit('first', 1)), other: listed(credit('later', 2)) }
  const options: CodexAutoResetOptions = {
    confirmationTimeoutMs: 10_000,
    claimsDirectory: directory,
    enabled: () => state.enabled,
    accounts: async () => Object.keys(cards),
    usage: async account => usage(account === 'current' ? state.used : 10),
    list: async account => { state.lists.push(account); return cards[account] },
    consume: async (_account, id, requestId) => {
      assert.match(requestId, /^[0-9a-f-]{36}$/)
      state.spends.push(id)
      state.used = 0
      cards.current = listed(credit('next', 3))
      return { windowsReset: 2 }
    },
    changed: () => { state.changed++ },
    onWarn: message => { state.warnings.push(message) },
  }
  return { state, cards, options, create: () => new CodexAutoReset(options) }
}

test('disabled auto reset makes no quota or credit calls; current exhaustion can spend while another account has quota', async t => {
  const f = await fixture(t)
  f.state.enabled = false
  const manager = f.create()
  assert.equal(await manager.recover('current', signal()), false)
  assert.deepEqual(f.state.lists, [])
  f.state.enabled = true
  assert.equal(await manager.recover('current', signal()), true)
  assert.deepEqual(f.state.spends, ['first'])
  assert.deepEqual(f.state.lists, ['current', 'other'])
  assert.equal(f.state.changed, 1)
})

test('a sooner card on any connected account prevents spending, even outside the routing pool', async t => {
  const f = await fixture(t)
  f.cards.excluded = listed(credit('sooner', 0.5))
  assert.equal(await f.create().recover('current', signal()), false)
  assert.deepEqual(f.state.spends, [])
  assert.ok(f.state.lists.includes('excluded'))
})

test('equal expiry qualifies and the earliest current card wins over a later current card', async t => {
  const f = await fixture(t)
  const first = credit('equal-first', 1)
  f.cards.current = listed(credit('late', 4), first)
  f.cards.other = listed({ ...first, id: 'same-expiry' }, { ...credit('expired', -1), status: 'expired' })
  assert.equal(await f.create().recover('current', signal()), true)
  assert.deepEqual(f.state.spends, ['equal-first'])
})

for (const [name, list] of [
  ['missing expiry', listed({ id: 'unknown', status: 'available' })],
  ['invalid expiry', listed({ ...credit('invalid', 1), expiresAt: 'invalid' })],
  ['unsupported list', { supported: false }],
  ['incomplete list', { ...listed(), availableCount: 1 }],
] as const) {
  test(`uncertain global order keeps the card: ${name}`, async t => {
    const f = await fixture(t)
    f.cards.other = list
    assert.equal(await f.create().recover('current', signal()), false)
    assert.deepEqual(f.state.spends, [])
  })
}

test('expired cards are ignored and an unknown reset type cannot be spent automatically', async t => {
  const f = await fixture(t)
  f.cards.other = listed(credit('old', -1))
  f.cards.current = listed({ ...credit('unsupported', 1), resetType: 'unknown' })
  assert.equal(await f.create().recover('current', signal()), false)
  assert.deepEqual(f.state.spends, [])
  f.cards.current = listed(credit('supported', 1))
  assert.equal(await f.create().recover('current', signal()), true)
})

for (const [name, snapshot] of [
  ['no exhaustion', usage(99.9)],
  ['unsupported usage', { supported: false }],
  ['missing windows', { supported: true, windows: [] }],
  ['model-scoped quota', { supported: true, windows: [{ kind: 'weekly', scope: 'model', usedPercent: 100 }] }],
  ['unknown window', { supported: true, windows: [{ kind: 'other', usedPercent: 100 }] }],
  ['already reset', { supported: true, windows: [{ kind: 'weekly', usedPercent: 100, resetsAt: 1 }] }],
] satisfies [string, ProviderUsage][]) {
  test(`no card is spent for ${name}`, async t => {
    const f = await fixture(t)
    f.options.usage = async () => snapshot
    await f.create().recover('current', signal())
    assert.deepEqual(f.state.spends, [])
    assert.deepEqual(f.state.lists, [])
  })
}

test('usage or any account list failure preserves failover without spending', async t => {
  const f = await fixture(t)
  f.options.list = async () => { throw new Error('list unavailable') }
  assert.equal(await f.create().recover('current', signal()), false)
  f.options.usage = async () => { throw new Error('usage unavailable') }
  assert.equal(await f.create().recover('current', signal()), false)
  assert.deepEqual(f.state.spends, [])
  assert.equal(f.state.warnings.length, 2)
})

test('concurrent exhaustion and stale post-spend usage consume only one card, also after restarting', async t => {
  const f = await fixture(t)
  f.options.consume = async (_account, id) => { f.state.spends.push(id); f.cards.current = listed(credit('second', 1)); return {} }
  const manager = f.create()
  const recovered = await Promise.all(Array.from({ length: 8 }, () => manager.recover('current', signal())))
  assert.equal(recovered.filter(Boolean).length, 1)
  assert.deepEqual(f.state.spends, ['first'])
  assert.equal(await f.create().recover('current', signal()), false)
  assert.deepEqual(f.state.spends, ['first'])
  f.state.used = 10
  assert.equal(await manager.recover('current', signal()), true)
  f.state.used = 100
  assert.equal(await manager.recover('current', signal()), true)
  assert.deepEqual(f.state.spends, ['first', 'second'])
})

test('a lost consume response cannot cause another automatic spend until fresh recovery is observed', async t => {
  const f = await fixture(t)
  f.options.consume = async (_account, id) => { f.state.spends.push(id); throw new Error('response lost') }
  assert.equal(await f.create().recover('current', signal()), false)
  f.cards.current = listed(credit('second', 1))
  assert.equal(await f.create().recover('current', signal()), false)
  assert.deepEqual(f.state.spends, ['first'])
  assert.equal(f.state.changed, 1)
})

test('a previously claimed card cannot be sent again even if a later list wrongly reports it available', async t => {
  const f = await fixture(t)
  const manager = f.create()
  assert.equal(await manager.recover('current', signal()), true)
  f.state.used = 100
  f.cards.current = listed(credit('first', 1))
  assert.equal(await manager.recover('current', signal()), false)
  assert.deepEqual(f.state.spends, ['first'])
})

test('disabling or cancelling during the cross-account check prevents spending', async t => {
  for (const action of ['disable', 'abort'] as const) {
    const f = await fixture(t)
    const controller = new AbortController()
    f.options.list = async account => {
      if (action === 'disable') f.state.enabled = false
      else controller.abort()
      return f.cards[account]
    }
    const result = f.create().recover('current', controller.signal)
    if (action === 'abort') await assert.rejects(result)
    else assert.equal(await result, false)
    assert.deepEqual(f.state.spends, [])
  }
})

test('a newly connected account invalidates the global expiry comparison', async t => {
  const f = await fixture(t)
  let calls = 0
  f.options.accounts = async () => ++calls === 1 ? ['current', 'other'] : ['current', 'other', 'new']
  assert.equal(await f.create().recover('current', signal()), false)
  assert.deepEqual(f.state.spends, [])
})

test('quota naturally recovering while credit lists load avoids spending a card', async t => {
  const f = await fixture(t)
  let reads = 0
  f.options.usage = async () => usage(++reads === 1 ? 100 : 0)
  assert.equal(await f.create().recover('current', signal()), true)
  assert.deepEqual(f.state.spends, [])
})

test('manual and automatic consumption serialize and manual retries retain their UUID', async t => {
  const f = await fixture(t)
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const ids: string[] = []
  f.options.consume = async (_account, id, requestId) => {
    f.state.spends.push(id); ids.push(requestId); started.resolve()
    await release.promise
    f.state.used = 0
    return {}
  }
  const manager = f.create()
  const manual = manager.manual('current', 'manual', '11111111-1111-4111-8111-111111111111', signal())
  await started.promise
  const automatic = manager.recover('current', signal())
  release.resolve()
  await manual
  assert.equal(await automatic, true)
  assert.deepEqual(f.state.spends, ['manual'])
  assert.deepEqual(ids, ['11111111-1111-4111-8111-111111111111'])
})

test('manual consumption with lagging usage blocks an automatic follow-up card after restart', async t => {
  const f = await fixture(t)
  f.options.consume = async (_account, id) => {
    f.state.spends.push(id)
    f.cards.current = listed(credit('second', 1))
    return { windowsReset: 2 }
  }
  await f.create().manual('current', 'first', '11111111-1111-4111-8111-111111111111', signal())
  assert.equal(await f.create().recover('current', signal()), false)
  assert.deepEqual(f.state.spends, ['first'])
})

test('a fresh independent quota poll rearms after lag, but a pre-spend poll cannot clear the claim', async t => {
  const f = await fixture(t)
  f.options.consume = async (_account, id) => { f.state.spends.push(id); f.cards.current = listed(credit('second', 1)); return {} }
  const manager = f.create()
  await manager.recover('current', signal())
  await manager.observeUsage('current', usage(0), 1)
  assert.equal(await manager.recover('current', signal()), false)
  await manager.observeUsage('current', usage(0), Date.now() + 1)
  assert.equal(await manager.recover('current', signal()), true)
  assert.deepEqual(f.state.spends, ['first', 'second'])
})

test('Codex retries the same account once before output after recovery, but never retries other HTTP failures', async () => {
  for (const { status, rejectAgain } of [{ status: 429, rejectAgain: false }, { status: 429, rejectAgain: true },
    { status: 500, rejectAgain: false }, { status: 403, rejectAgain: false }]) {
    let requests = 0
    const recovered: string[] = []
    const session: CodexSession = { accessToken: 'fake', refreshToken: 'fake', accountId: 'current', expiresAt: Date.now() + 86_400_000 }
    const tokens = new AccountTokenManager<CodexSession>({
      provider: 'codex', displayName: 'test', makeOptions: () => ({ preemptMs: 0, refresh: async () => session, isPermanent: () => false }),
      io: { list: async () => [{ key: 'current', session }], get: async () => session, save: async () => {}, remove: async () => {} },
    })
    const adapter = new CodexAdapter({
      tokens, models: [], discovery: false, streamIdleTimeoutMs: 10_000,
      recoverQuota: async account => { recovered.push(account); return true },
      // The exhausted-window 429 this route recovers from discloses the seconds
      // it reopens in; a 429 stating no window at all is a refusal, not a window.
      fetchFn: async () => ++requests === 1 || rejectAgain
        ? new Response('{"error":{"message":"quota"},"resets_in_seconds":60}', { status })
        : new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\ndata: [DONE]\n\n'),
    })
    const run = async () => { for await (const _chunk of adapter.streamAccount({ provider: 'codex', model: 'm', messages: [] }, 'current')) { /* drain */ } }
    if (status === 429) {
      if (rejectAgain) await assert.rejects(run()); else await run()
      assert.deepEqual(recovered, ['current']); assert.equal(requests, 2)
    }
    else { await assert.rejects(run()); assert.deepEqual(recovered, []); assert.equal(requests, 1) }
  }
})
