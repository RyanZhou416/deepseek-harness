/**
 * AccountTokenManager: one lazily-built TokenManager per account, so refresh
 * coalescing and permanent-failure removal stay scoped to a single account.
 * All tests run over an in-memory store backend (the `io` seam).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { AccountEntry, ProviderId } from '../src/auth/store.js'

interface TestSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

function session(accessToken: string, expiresInMs = 3_600_000): TestSession {
  return { accessToken, refreshToken: `${accessToken}-rt`, expiresAt: Date.now() + expiresInMs }
}

/** An in-memory multi-account store; `refresh` counts calls per account. */
function harness(options: {
  accounts?: Record<string, TestSession>
  refresh?: (account: string, session: TestSession) => Promise<TestSession>
  permanent?: (account: string, error: unknown) => boolean
} = {}) {
  const stored = new Map<string, TestSession>(Object.entries(options.accounts ?? {}))
  const removed: string[] = []
  const notified: string[] = []
  const refreshes: string[] = []
  const renames: [string, string][] = []
  const tokens = new AccountTokenManager<TestSession>({
    provider: 'codex' as ProviderId,
    displayName: 'Test',
    makeOptions: account => ({
      preemptMs: 60_000,
      refresh: async (current) => {
        refreshes.push(account)
        const next = await (options.refresh ?? (() => Promise.resolve(current)))(account, current)
        return next
      },
      isPermanent: error => options.permanent?.(account, error) ?? false,
    }),
    onAccountRemoved: (account) => {
      notified.push(account)
    },
    onAccountRenamed: (from, to) => {
      renames.push([from, to])
      return Promise.resolve()
    },
    io: {
      list: () => Promise.resolve([...stored.entries()].map(([key, s]) => ({ key, session: s }) as AccountEntry<TestSession>)),
      get: account => Promise.resolve(account === undefined ? stored.values().next().value : stored.get(account)),
      save: (account, s) => {
        stored.set(account, s)
        return Promise.resolve()
      },
      remove: (account, expectedPrior) => {
        // Mirror the durable store: a named prior removes only that session, so
        // a re-login that landed while the refresh was failing survives.
        const current = stored.get(account)
        if (expectedPrior !== undefined
          && (current === undefined
            || current.accessToken !== expectedPrior.accessToken
            || current.refreshToken !== expectedPrior.refreshToken)) {
          return Promise.resolve(false)
        }
        stored.delete(account)
        removed.push(account)
        return Promise.resolve(true)
      },
    },
  })
  return { tokens, stored, removed, notified, refreshes, renames }
}

/**
 * An in-memory store that models the store's own rekey: saving under `legacy`
 * moves that entry to `canonical` and records the alias, so `resolve` answers
 * the retired key with the canonical one only after that save. `events` records
 * the save and, from the caller's hook, the move.
 */
function renamingStore(initial: TestSession) {
  const stored = new Map<string, TestSession>([['legacy', initial]])
  const events: string[] = []
  let renamed = false
  const target = (key: string | undefined): string => renamed && key === 'legacy' ? 'canonical' : key ?? 'canonical'
  return {
    stored,
    events,
    io: {
      list: () => Promise.resolve([...stored.entries()].map(([key, s]) => ({ key, session: s }) as AccountEntry<TestSession>)),
      get: (key?: string) => Promise.resolve(stored.get(target(key)) ?? stored.get('legacy')),
      save: (key: string, value: TestSession) => {
        events.push('save')
        if (key === 'legacy') renamed = true
        const to = target(key)
        if (to !== key) stored.delete(key)
        stored.set(to, value)
        return Promise.resolve()
      },
      remove: (key: string) => { stored.delete(key); return Promise.resolve() },
      resolve: (key: string) => Promise.resolve(target(key)),
    },
  }
}

test('session() without an account serves the default (first) account', async () => {
  const { tokens } = harness({ accounts: { a1: session('at-1'), a2: session('at-2') } })
  assert.equal((await tokens.session()).accessToken, 'at-1')
  assert.equal((await tokens.session('a2')).accessToken, 'at-2')
})

test('session() with no accounts throws MISSING_CREDENTIAL', async () => {
  const { tokens } = harness()
  await assert.rejects(
    tokens.session(),
    (error: unknown) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL',
  )
})

test('concurrent refreshes of one account coalesce; accounts refresh independently', async () => {
  let calls = 0
  const { tokens, refreshes } = harness({
    accounts: {
      a1: session('at-1', 1000), // inside the preempt window → refreshes
      a2: session('at-2', 1000),
    },
    refresh: async (_account, current) => {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, 10))
      return { ...current, accessToken: `${current.accessToken}-new`, expiresAt: Date.now() + 3_600_000 }
    },
  })
  const [s1, s2, s3] = await Promise.all([tokens.session('a1'), tokens.session('a1'), tokens.session('a2')])
  assert.equal(s1.accessToken, 'at-1-new')
  assert.equal(s2.accessToken, 'at-1-new')
  assert.equal(s3.accessToken, 'at-2-new')
  assert.equal(calls, 2, 'one refresh per account, not per call')
  assert.deepEqual(refreshes.sort(), ['a1', 'a2'])
})

test('legacy and canonical keys share one in-flight refresh', async () => {
  const expired = session('old', 1000)
  const stored = new Map<string, TestSession>([['canonical', expired]])
  let calls = 0
  const tokens = new AccountTokenManager<TestSession>({
    provider: 'codex', displayName: 'Test',
    makeOptions: () => ({ preemptMs: 60_000, refresh: async current => {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, 10))
      return { ...current, accessToken: 'new', expiresAt: Date.now() + 3_600_000 }
    }, isPermanent: () => true }),
    io: {
      list: () => Promise.resolve([{ key: 'canonical', session: stored.get('canonical')! }]),
      get: key => Promise.resolve(stored.get(key === 'legacy' ? 'canonical' : key ?? 'canonical')),
      save: (_key, value) => { stored.set('canonical', value); return Promise.resolve() },
      remove: () => { stored.delete('canonical'); return Promise.resolve() },
      resolve: key => Promise.resolve(key === 'legacy' ? 'canonical' : key),
    },
  })
  const [legacy, canonical, defaultSession] = await Promise.all([
    tokens.session('legacy'), tokens.session('canonical'), tokens.session(),
  ])
  assert.equal(calls, 1)
  assert.deepEqual([legacy.accessToken, canonical.accessToken, defaultSession.accessToken], ['new', 'new', 'new'])
  assert.equal(stored.has('canonical'), true)
})

test('a refresh that renames the account key moves that account before the manager re-binds', async () => {
  const created: string[] = []
  const renames: [string, string][] = []
  const refreshes: string[] = []
  const store = renamingStore(session('legacy', 1000))
  let creationsWhileRenaming = -1
  const tokens = new AccountTokenManager<TestSession>({
    provider: 'codex',
    displayName: 'Test',
    makeOptions: account => {
      created.push(account)
      return {
        preemptMs: 60_000,
        refresh: async (current) => {
          refreshes.push(account)
          return { ...current, accessToken: `${current.accessToken}-new`, expiresAt: Date.now() + 3_600_000 }
        },
        isPermanent: () => false,
      }
    },
    onAccountRenamed: async (from, to) => {
      store.events.push('rename')
      renames.push([from, to])
      // Reading the old key here must reuse the installed manager: the move
      // runs before the binding changes.
      tokens.tokensFor(from)
      creationsWhileRenaming = created.length
    },
    io: store.io,
  })
  const refreshed = await tokens.session('legacy')
  assert.equal(refreshed.accessToken, 'legacy-new')
  assert.deepEqual(store.events, ['save', 'rename'], 'the durable save lands before the move')
  assert.deepEqual(renames, [['legacy', 'canonical']])
  assert.equal(creationsWhileRenaming, 1, 'the move ran while the old binding was still installed')
  assert.deepEqual(refreshes, ['legacy'], 'one refresh served the account')
  assert.deepEqual(created, ['legacy'])
  // The binding moved: both keys now serve through the one renamed manager, and
  // the retired key reaches it through the alias the store recorded.
  assert.equal((await tokens.session('canonical')).accessToken, 'legacy-new')
  assert.equal((await tokens.session('legacy')).accessToken, 'legacy-new')
  assert.deepEqual(created, ['legacy'], 'neither key minted a second manager')
  assert.deepEqual(refreshes, ['legacy'], 'a stored session needs no further refresh')
})

test('a rename move that rejects does not fail the refresh that stored the session', async () => {
  const store = renamingStore(session('legacy', 1000))
  const renames: [string, string][] = []
  const tokens = new AccountTokenManager<TestSession>({
    provider: 'codex',
    displayName: 'Test',
    makeOptions: () => ({
      preemptMs: 60_000,
      refresh: async current => ({ ...current, accessToken: 'legacy-new', expiresAt: Date.now() + 3_600_000 }),
      isPermanent: () => false,
    }),
    onAccountRenamed: async (from, to) => {
      renames.push([from, to])
      throw new Error('cache move failed')
    },
    io: store.io,
  })
  const served = await tokens.session('legacy')
  assert.equal(served.accessToken, 'legacy-new', 'the refreshed session is served, not reported as an auth failure')
  assert.deepEqual(renames, [['legacy', 'canonical']])
  assert.equal(store.stored.has('canonical'), true, 'the store kept the session the refresh wrote')
})

test('a rename move that rejects is reported through the warn sink', async () => {
  const store = renamingStore(session('legacy', 1000))
  const warnings: string[] = []
  const tokens = new AccountTokenManager<TestSession>({
    provider: 'codex',
    displayName: 'Test',
    makeOptions: () => ({
      preemptMs: 60_000,
      refresh: async current => ({ ...current, accessToken: 'legacy-new', expiresAt: Date.now() + 3_600_000 }),
      isPermanent: () => false,
    }),
    onAccountRenamed: async () => { throw new Error('cache move failed') },
    onWarn: message => { warnings.push(message) },
    io: store.io,
  })
  await tokens.session('legacy')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /"legacy" -> "canonical"/, 'the warning names the move that did not complete')
  assert.match(warnings[0]!, /cache move failed/)
})

test('an ordinary per-account refresh reports no rename', async () => {
  const { tokens, renames } = harness({
    accounts: { a1: session('at-1', 1000), a2: session('at-2') },
    refresh: async (_account, current) => ({ ...current, accessToken: `${current.accessToken}-new`, expiresAt: Date.now() + 3_600_000 }),
  })
  await tokens.session('a1')
  await tokens.session('a2')
  assert.deepEqual(renames, [])
})

test('a permanent refresh failure removes only that account and notifies once', async () => {
  const { tokens, stored, removed, notified } = harness({
    accounts: { a1: session('at-1', 1000), a2: session('at-2') },
    refresh: () => Promise.reject(new Error('invalid_grant')),
    permanent: () => true,
  })
  await assert.rejects(
    tokens.session('a1'),
    (error: unknown) => error instanceof LlmError && error.code === 'INVALID_CREDENTIAL',
  )
  assert.deepEqual(removed, ['a1'])
  assert.deepEqual(notified, ['a1'])
  assert.equal(stored.has('a1'), false)
  assert.equal(stored.has('a2'), true, 'the sibling account is untouched')
  // The survivor still serves.
  assert.equal((await tokens.session('a2')).accessToken, 'at-2')
})

test('makeOptions receives the account key (per-account refresh wiring)', async () => {
  const seen: string[] = []
  const stored = new Map<string, TestSession>([['a1', session('at-1', 1000)]])
  const tokens = new AccountTokenManager<TestSession>({
    provider: 'claude',
    displayName: 'Test',
    makeOptions: (account) => {
      seen.push(account)
      return {
        preemptMs: 60_000,
        refresh: current => Promise.resolve({ ...current, expiresAt: Date.now() + 3_600_000 }),
        isPermanent: () => false,
      }
    },
    io: {
      list: () => Promise.resolve([...stored.entries()].map(([key, s]) => ({ key, session: s }))),
      get: account => Promise.resolve(account === undefined ? undefined : stored.get(account)),
      save: (account, s) => {
        stored.set(account, s)
        return Promise.resolve()
      },
      remove: () => Promise.resolve(),
    },
  })
  await tokens.session('a1')
  assert.deepEqual(seen, ['a1'])
})

test('peek and hasSession read without refreshing', async () => {
  const { tokens, refreshes } = harness({ accounts: { a1: session('at-1', 1000) } })
  assert.equal((await tokens.peek('a1'))?.accessToken, 'at-1')
  assert.equal(await tokens.hasSession('a1'), true)
  assert.equal(await tokens.hasSession('nobody'), false)
  assert.deepEqual(refreshes, [])
})

test('a permanent refresh failure keeps a session that a concurrent re-login just saved', async () => {
  let reject!: (error: Error) => void
  const gate = new Promise<TestSession>((_, fail) => { reject = fail })
  const { tokens, stored, removed, notified } = harness({
    accounts: { a1: session('stale', -1) },
    refresh: () => gate,
    permanent: (_account, error) => error instanceof Error && error.message === 'invalid_grant',
  })
  const pending = tokens.session('a1')
  await new Promise(resolve => setTimeout(resolve, 10))
  stored.set('a1', session('fresh-login'))
  reject(new Error('invalid_grant'))
  assert.equal((await pending).accessToken, 'fresh-login', 'the re-login is served, not deleted')
  assert.deepEqual(removed, [])
  assert.deepEqual(notified, [])
  assert.equal(stored.get('a1')?.accessToken, 'fresh-login')
})

test('a permanent refresh failure still removes the account when nothing replaced it', async () => {
  const { tokens, stored, removed, notified } = harness({
    accounts: { a1: session('stale', -1) },
    refresh: () => Promise.reject(new Error('invalid_grant')),
    permanent: (_account, error) => error instanceof Error && error.message === 'invalid_grant',
  })
  await assert.rejects(tokens.session('a1'), (error: unknown) => error instanceof LlmError && error.code === 'INVALID_CREDENTIAL')
  assert.deepEqual(removed, ['a1'])
  assert.deepEqual(notified, ['a1'])
  assert.equal(stored.has('a1'), false)
})

// ---------------------------------------------------------------------------
// The optional use-path preparation hook
// ---------------------------------------------------------------------------

/** A manager over one in-memory session, recording what the hook and the store saw. */
function preparedHarness(prepare?: (account: string, forceRefresh: boolean) => Promise<TestSession | undefined>) {
  const stored = new Map<string, TestSession>([['a1', session('at-stored')]])
  const hookCalls: string[] = []
  const loads: string[] = []
  const refreshes: string[] = []
  const tokens = new AccountTokenManager<TestSession>({
    provider: 'codex' as ProviderId,
    displayName: 'Test',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: (current) => { refreshes.push(current.accessToken); return Promise.resolve(current) },
      isPermanent: () => false,
    }),
    ...prepare === undefined ? {} : {
      prepareSession: async (account: string, forceRefresh: boolean) => {
        hookCalls.push(`${account}:${String(forceRefresh)}`)
        return await prepare!(account, forceRefresh)
      },
    },
    io: {
      list: () => Promise.resolve([...stored.entries()].map(([key, s]) => ({ key, session: s }) as AccountEntry<TestSession>)),
      get: (account) => {
        loads.push(account ?? 'default')
        return Promise.resolve(account === undefined ? stored.values().next().value : stored.get(account))
      },
      save: (account, s) => { stored.set(account, s); return Promise.resolve() },
      remove: (account) => { stored.delete(account); return Promise.resolve(true) },
    },
  })
  return { tokens, stored, hookCalls, loads, refreshes }
}

test('the use-path hook is consulted by session() alone', async () => {
  const h = preparedHarness(() => Promise.resolve(undefined))
  await h.tokens.session('a1')
  await h.tokens.session('a1', true)
  assert.deepEqual(h.hookCalls, ['a1:false', 'a1:true'], 'the use path passes the account and the forced-refresh request')
  assert.equal(h.loads.length > 0, true, 'a hook that declines leaves the manager its own path')

  h.hookCalls.length = 0
  h.loads.length = 0
  await h.tokens.list()
  await h.tokens.peek('a1')
  await h.tokens.snapshot('a1')
  await h.tokens.revisionOf('a1')
  await h.tokens.hasSession('a1')
  assert.deepEqual(h.hookCalls, [], 'a status, list or snapshot read never consults the hook')
})

test('a hook that answers takes over the use without loading or refreshing', async () => {
  const h = preparedHarness(() => Promise.resolve(session('at-prepared')))
  assert.equal((await h.tokens.session('a1')).accessToken, 'at-prepared')
  assert.deepEqual(h.loads, [], 'the stored credential is never loaded for this use')
  assert.deepEqual(h.refreshes, [], 'and no grant is spent')
  // The manager's own scope is untouched: a use the hook declines still serves the store.
  const plain = preparedHarness(() => Promise.resolve(undefined))
  assert.equal((await plain.tokens.session('a1')).accessToken, 'at-stored')
})

test('a manager without the hook is unchanged', async () => {
  const h = preparedHarness()
  assert.equal((await h.tokens.session('a1')).accessToken, 'at-stored')
  assert.deepEqual(h.hookCalls, [])
  assert.deepEqual(h.refreshes, [], 'a fresh credential is served without a refresh, exactly as before')
})

// ---------------------------------------------------------------------------
// The conditional identity write's revision
// ---------------------------------------------------------------------------

test('persist forwards the revision a caller decided on, and none when it decided on none', async () => {
  const stored = new Map<string, TestSession>([['a1', session('at-1')]])
  const saves: { prior?: TestSession; revision?: number }[] = []
  const tokens = new AccountTokenManager<TestSession>({
    provider: 'codex' as ProviderId,
    displayName: 'Test',
    makeOptions: () => ({ preemptMs: 0, refresh: async current => current, isPermanent: () => false }),
    io: {
      list: () => Promise.resolve([...stored.entries()].map(([key, s]) => ({ key, session: s }) as AccountEntry<TestSession>)),
      get: account => Promise.resolve(account === undefined ? stored.values().next().value : stored.get(account)),
      save: (account, value, expectedPrior, expectedRevision) => {
        saves.push({
          ...expectedPrior === undefined ? {} : { prior: expectedPrior },
          ...expectedRevision === undefined ? {} : { revision: expectedRevision },
        })
        stored.set(account, value)
        return Promise.resolve()
      },
      remove: account => { stored.delete(account); return Promise.resolve(true) },
    },
  })
  const prior = stored.get('a1')!
  const next = { ...prior, accessToken: 'at-2' }
  await tokens.persist('a1', next, prior, 7)
  await tokens.persist('a1', next, prior)
  assert.deepEqual(
    saves.map(entry => entry.revision),
    [7, undefined],
    'the revision rides along only when the caller decided on one, so every other route keeps its own guard',
  )
  assert.equal(saves[0]?.prior?.accessToken, 'at-1', 'and the session it was read under still rides along')
})
