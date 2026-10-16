/**
 * The account-maintenance owner's lifecycle: which sessions bind an account, when the
 * credential timer runs, what happens when the last binding is released, and which
 * failures stop maintenance.
 *
 * The credential plumbing is the shipped `AccountTokenManager` over the shipped store in
 * the private test home; the clock and scheduler are injected, so nothing here sleeps.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  authFilePath,
  deleteAccountSession,
  getAccountCredential,
  getAccountSession,
  saveAccountSession,
} from '../src/auth/store.js'
import type { ClaudeSession } from '../src/auth/store.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { REFRESH_BUSY_CODE } from '../src/providers/common.js'
import { claudeReadOnlyUse } from '../src/auth/claude-code-creds.js'
import type { ClaudeSourceCredential } from '../src/auth/claude-code-creds.js'
import { isClaudePermanentRefreshError, refreshClaude } from '../src/providers/claude.js'
import { ClaudeMaintenanceController } from '../src/providers/claude-maintenance.js'
import type { ClaudeMaintenanceOptions } from '../src/providers/claude-maintenance.js'
import {
  ManualClock,
  ManualScheduler,
  TEST_NOW,
  claudeSession,
  claudeTokens,
  deferred,
  seedClaudeSession,
  settle,
  uniqueAccount,
  waitFor,
} from './claude-maintenance-fixtures.js'

after(async () => { await settle(4) })

/** A controller over the shipped token manager, with the manual clock and scheduler. */
interface Harness {
  controller: ClaudeMaintenanceController
  clock: ManualClock
  scheduler: ManualScheduler
  refreshes: string[]
  current(): ClaudeSession | undefined
}

/**
 * Build one controller.
 * @param account - the account key to seed and drive.
 * @param session - the credential to store for it.
 * @param overrides - maintenance options to merge over the harness defaults.
 */
async function harness(
  account: string,
  session: ClaudeSession,
  overrides: Partial<ClaudeMaintenanceOptions> = {},
): Promise<Harness> {
  await seedClaudeSession(session)
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  const refreshes: string[] = []
  const tokens = claudeTokens({
    // The preempt window is the whole test horizon, so `session()` refreshes an expiring
    // credential while a far-out one is served from cache without a grant.
    preemptMs: 3_600_000,
    refresh: async (current) => {
      refreshes.push(current.refreshToken)
      return { ...current, accessToken: `at-${current.refreshToken}-new`, expiresAt: clock.now() + 3_600_000 }
    },
  })
  const controller = new ClaudeMaintenanceController({
    tokens,
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
    ...overrides,
  })
  return {
    controller,
    clock,
    scheduler,
    refreshes,
    current: () => undefined,
  }
}

test('a status read with no binding starts no work and arms no timer', async () => {
  const account = uniqueAccount('idle')
  const h = await harness(account, claudeSession(account))
  try {
    const view = h.controller.view()
    assert.deepEqual(view, [], 'no account is maintained before a real request')
    assert.equal(h.scheduler.pending, 0, 'a status read arms nothing')
    assert.deepEqual(h.refreshes, [], 'a status read spends no grant')
  } finally {
    await h.controller.dispose()
  }
})

test('a real request binds its session and serves the stored credential', async () => {
  const account = uniqueAccount('bind')
  const session = claudeSession(account, { expiresAt: Date.now() + 7_200_000 })
  const h = await harness(account, session)
  try {
    const decision = await h.controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(decision.ok, true)
    if (!decision.ok) return
    assert.equal(decision.session.accessToken, session.accessToken, 'the stored credential is served')
    const [view] = h.controller.view()
    assert.equal(view?.bindings, 1, 'the request bound its session')
    assert.deepEqual(h.refreshes, [], 'a credential outside the preempt window is not refreshed')
  } finally {
    await h.controller.dispose()
  }
})

test('a request without a harness session id is checked but binds nothing', async () => {
  const account = uniqueAccount('nobind')
  const h = await harness(account, claudeSession(account, { expiresAt: Date.now() + 7_200_000 }))
  try {
    const decision = await h.controller.ensureReady({ account })
    assert.equal(decision.ok, true)
    const [view] = h.controller.view()
    assert.equal(view?.bindings, 0, 'a direct request creates no lasting maintenance ownership')
    assert.equal(h.scheduler.pending, 0, 'and arms no timer')
  } finally {
    await h.controller.dispose()
  }
})

test('two live sessions of one account share a single refresh cycle', async () => {
  const account = uniqueAccount('share')
  // Inside the preempt window, so the first read starts a refresh and the second joins it.
  const h = await harness(account, claudeSession(account, { expiresAt: Date.now() + 60_000 }))
  try {
    const first = h.controller.ensureReady({ account, sessionId: 'session-a' })
    const second = h.controller.ensureReady({ account, sessionId: 'session-b' })
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.equal(h.refreshes.length, 1, 'both live sessions shared one grant')
    const [view] = h.controller.view()
    assert.equal(view?.bindings, 2, 'both sessions stay bound to the one account state')
  } finally {
    await h.controller.dispose()
  }
})

test('a still-fresh credential is served when the maintenance timer runs', async () => {
  const account = uniqueAccount('fresh')
  // Far outside the preempt window: the timer runs, re-reads the store, and must not spend
  // a grant on a credential another writer already refreshed.
  const h = await harness(account, claudeSession(account, { expiresAt: Date.now() + 7_200_000 }))
  try {
    await h.controller.ensureReady({ account, sessionId: 'session-1' })
    await h.scheduler.advance(3_600_000)
    assert.deepEqual(h.refreshes, [], 'a fresh stored credential is never re-requested')
    const [view] = h.controller.view()
    assert.equal(view?.credential.status, 'ready')
  } finally {
    await h.controller.dispose()
  }
})

test('releasing one of two sessions keeps the account maintained', async () => {
  const account = uniqueAccount('partial')
  const h = await harness(account, claudeSession(account, { expiresAt: Date.now() + 60_000 }))
  try {
    await h.controller.ensureReady({ account, sessionId: 'session-a' })
    await h.controller.ensureReady({ account, sessionId: 'session-b' })
    h.controller.releaseSession('session-a')
    const [view] = h.controller.view()
    assert.equal(view?.bindings, 1, 'the surviving session keeps its binding')
    assert.equal(h.scheduler.pending > 0, true, 'the credential timer stays armed')
  } finally {
    await h.controller.dispose()
  }
})

test('releasing the last binding stops the timers and no further work runs', async () => {
  const account = uniqueAccount('last')
  const h = await harness(account, claudeSession(account, { expiresAt: Date.now() + 60_000 }))
  try {
    await h.controller.ensureReady({ account, sessionId: 'session-a' })
    await h.controller.ensureReady({ account, sessionId: 'session-b' })
    const before = h.refreshes.length
    h.controller.releaseSession('session-a')
    h.controller.releaseSession('session-b')
    assert.equal(h.scheduler.pending, 0, 'the last release clears every timer')
    await h.scheduler.advance(7 * 24 * 3_600_000)
    assert.equal(h.refreshes.length, before, 'no cycle runs after the last binding is gone')
    const [view] = h.controller.view()
    assert.equal(view?.bindings, 0, 'the data is kept while the network work is not')
  } finally {
    await h.controller.dispose()
  }
})

test('a permanent credential failure stops scheduling and reports re-authentication', async () => {
  const account = uniqueAccount('permanent')
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() - 1_000 }))
  const tokens = claudeTokens({
    preemptMs: 0,
    refresh: () => Promise.reject(new LlmError('invalid_grant', 'INVALID_CREDENTIAL')),
    isPermanent: () => true,
  })
  const controller = new ClaudeMaintenanceController({
    tokens,
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
  })
  try {
    await controller.ensureReady({ account, sessionId: 'session-1' })
    const [view] = controller.view()
    assert.equal(view?.credential.status, 'reauth_required', 'a dead credential is reported as such')
    assert.equal(scheduler.pending, 0, 'and no further check is scheduled')
    assert.equal(await getAccountSession('claude', account), undefined, 'the store removed the dead login')
  } finally {
    await controller.dispose()
  }
})

test('an unknown expiry is reported and schedules nothing', async () => {
  const account = uniqueAccount('unknown-expiry')
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  const session = claudeSession(account, { expiresAt: Number.NaN })
  const controller = new ClaudeMaintenanceController({
    tokens: {
      list: async () => [],
      session: async () => session,
      peek: async () => session,
      resolveAccount: async key => key,
      snapshot: async () => ({ key: account, session, revision: 1 }),
    },
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
  })
  try {
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(scheduler.pending, 0, 'an unknown expiry fabricates no deadline')
    const [view] = controller.view()
    assert.equal(view?.credential.status, 'unknown-expiry')
  } finally {
    await controller.dispose()
  }
})

test('a blocked protocol configuration refuses the request before any credential is used', async () => {
  const account = uniqueAccount('protocol-block')
  const h = await harness(account, claudeSession(account, { expiresAt: Date.now() + 3_000_000 }), {
    protocolBlocks: { isBlocked: () => true },
  })
  try {
    await assert.rejects(
      h.controller.beforeAccountRequest({ account, sessionId: 'session-1' }),
      (error: unknown) => error instanceof LlmError
        && error.code === 'CLIENT_VERSION_UNSUPPORTED'
        && error.failure.retryDisposition === 'forbid',
    )
  } finally {
    await h.controller.dispose()
  }
})

test('disposal aborts the reads in flight and clears every state', async () => {
  const account = uniqueAccount('dispose')
  const h = await harness(account, claudeSession(account, { expiresAt: Date.now() + 3_600_000 }), {
    // A real fetch rejects on the caller's abort; this stands in for that contract.
    fetchSettings: ({ signal }) => new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }),
  })
  try {
    const ready = h.controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(await waitFor(() => h.controller.view().length === 1), true, 'the request bound its account')
    await h.controller.dispose()
    await ready
    assert.deepEqual(h.controller.view(), [], 'disposal drops the maintained state')
    assert.equal(h.scheduler.pending, 0, 'and every timer with it')
  } finally {
    await h.controller.dispose()
  }
})

test('a settings answer that arrives with the release is not adopted', async () => {
  const account = uniqueAccount('late')
  let aborted = false
  let started = false
  const h = await harness(account, claudeSession(account, { expiresAt: Date.now() + 3_600_000 }), {
    // The answer lands exactly as the caller aborts: it is a cancelled read, not a
    // snapshot that may be adopted after its binding is gone.
    fetchSettings: ({ signal }) => new Promise<Response>((resolve) => {
      started = true
      const answer = (): void => {
        aborted = true
        resolve(new Response(JSON.stringify({ uuid: 'u-1', checksum: 'c-1', settings: {} }), { status: 200 }))
      }
      if (signal?.aborted === true) answer()
      else signal?.addEventListener('abort', answer, { once: true })
    }),
  })
  try {
    const ready = h.controller.ensureReady({ account, sessionId: 'session-1' })
    let failure: unknown
    let decision: unknown
    void ready.then((value) => { decision = value }, (error: unknown) => { failure = error })
    assert.equal(
      await waitFor(() => started || failure !== undefined || decision !== undefined),
      true,
      `the request started its bounded policy read (failure: ${String(failure)}; decision: ${JSON.stringify(decision)}; view: ${JSON.stringify(h.controller.view())})`,
    )
    await h.controller.releaseSession('session-1')
    await ready
    await settle(4)
    const [view] = h.controller.view()
    assert.equal(aborted, true, 'the release cancelled the read')
    assert.equal(view?.policy.status, 'unavailable', 'the cancelled answer is not adopted as policy')
    assert.equal(view?.policy.fetchedAt, undefined, 'and no snapshot was accepted')
    assert.equal(h.scheduler.pending, 0, 'the released account schedules nothing further')
  } finally {
    await h.controller.dispose()
  }
})

test('the credential revision is persistent, monotonic across a removal and compared on write', async () => {
  const account = uniqueAccount('revision')
  const first = claudeSession(account, { expiresAt: Date.now() + 7_200_000 })
  await saveAccountSession('claude', account, first)
  const initial = await getAccountCredential('claude', account)
  assert.equal(initial?.revision, 1, 'the first accepted write starts the revision')

  const second = claudeSession(account, { accessToken: 'at-second', refreshToken: 'rt-second' })
  assert.equal(
    await saveAccountSession('claude', account, second, undefined, { expectedRevision: 99 }),
    false,
    'a decision taken on another revision cannot land',
  )
  assert.equal(
    await saveAccountSession('claude', account, second, undefined, { expectedRevision: 1 }),
    true,
    'the revision the caller read still writes',
  )
  assert.equal((await getAccountCredential('claude', account))?.revision, 2)

  // Removing the account is itself a change, and its high-water mark outlives the entry.
  assert.equal(await deleteAccountSession('claude', account), true)
  const third = claudeSession(account, { accessToken: 'at-third', refreshToken: 'rt-third' })
  await saveAccountSession('claude', account, third)
  const relogged = await getAccountCredential('claude', account)
  assert.equal(relogged?.revision, 4, 'the re-login lands above the retired revision')
  assert.ok((relogged?.revision ?? 0) > (initial?.revision ?? 0))
})

test('an unreadable persisted revision is dropped instead of trusted', async () => {
  const account = uniqueAccount('revision-corrupt')
  const session = claudeSession(account, { expiresAt: Date.now() + 7_200_000 })
  await saveAccountSession('claude', account, session)
  const store = JSON.parse(readFileSync(authFilePath(), 'utf8')) as Record<string, unknown>
  const corrupted = { [account]: -5, other: 'nope' }
  store.revisions = { claude: corrupted }
  const claude = store.claude as Record<string, unknown>
  claude.revisions = corrupted
  writeFileSync(authFilePath(), JSON.stringify(store), { mode: 0o600 })
  const read = await getAccountCredential('claude', account)
  assert.equal(read?.revision, 0, 'a negative revision reads as the unset value')
  await saveAccountSession('claude', account, { ...session, accessToken: 'at-next' })
  const next = await getAccountCredential('claude', account)
  assert.ok((next?.revision ?? 0) > 0, 'the next accepted write mints a fresh revision')
})

test('a server answering with an already-expiring credential cannot spin the timer', async () => {
  const account = uniqueAccount('spin')
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 60_000 }))
  let refreshes = 0
  const tokens = claudeTokens({
    preemptMs: 3_600_000,
    refresh: async (current) => {
      refreshes += 1
      // Every answer is already inside the lead window: without a floor the next check
      // would be scheduled at zero delay, forever.
      return { ...current, accessToken: `at-spin-${refreshes}`, expiresAt: Date.now() + 1_000 }
    },
  })
  const controller = new ClaudeMaintenanceController({
    tokens,
    config: { refreshLeadMs: 300_000, minRefreshDelayMs: 30_000 },
    clock,
    scheduler,
  })
  try {
    await controller.ensureReady({ account, sessionId: 'session-1' })
    const afterFirst = refreshes
    const fired = await scheduler.drain(600_000)
    // Ten minutes at a thirty-second floor is at most twenty renewals; a zero-delay loop
    // would spend the whole round budget instead.
    assert.ok(fired > 0, 'the timer ran during the window')
    assert.ok(refreshes > afterFirst, 'the account is still maintained')
    assert.ok(
      refreshes <= afterFirst + 21,
      `renewals stay bounded by the floor (refreshes: ${refreshes}, first: ${afterFirst}, fired: ${fired})`,
    )
  } finally {
    await controller.dispose()
  }
})

test('an imported record with no stated mode keeps the legacy path and arms no timer', async () => {
  const account = uniqueAccount('legacy')
  const h = await harness(account, claudeSession(account, {
    expiresAt: Date.now() + 60_000,
    keychainBound: true,
  }))
  try {
    await h.controller.ensureReady({ account, sessionId: 'session-1' })
    const [view] = h.controller.view()
    assert.equal(view?.credential.status, 'external-coordination-unproven',
      'the coordination premise is reported as unproven, never as a safe single writer')
    assert.equal(h.scheduler.pending, 0, 'the compatibility path is not this plugin\'s proactive timer')
  } finally {
    await h.controller.dispose()
  }
})

test('a read-only import is never rotated on this plugin\'s timer', async () => {
  const account = uniqueAccount('read-only')
  const h = await harness(account, claudeSession(account, {
    expiresAt: Date.now() + 60_000,
    keychainBound: true,
    credentialOwnershipMode: 'read-only-import',
  }))
  try {
    await h.controller.ensureReady({ account, sessionId: 'session-1' })
    const [view] = h.controller.view()
    assert.equal(view?.credential.status, 'maintenance-unsupported')
    assert.equal(h.scheduler.pending, 0, 'a credential this plugin only reads is never renewed on a timer')
  } finally {
    await h.controller.dispose()
  }
})

test('an explicit independent mode outranks the imported fact for scheduling', async () => {
  const account = uniqueAccount('independent')
  const h = await harness(account, claudeSession(account, {
    expiresAt: Date.now() + 60_000,
    keychainBound: true,
    credentialOwnershipMode: 'independent-oauth',
  }))
  try {
    await h.controller.ensureReady({ account, sessionId: 'session-1' })
    const [view] = h.controller.view()
    assert.equal(h.refreshes.length, 1, 'the explicitly independent credential refreshes through its own grant')
    assert.equal(view?.credential.status, 'ready')
    assert.equal(h.scheduler.pending > 0, true, 'and it is the one mode this plugin maintains on a timer')
  } finally {
    await h.controller.dispose()
  }
})

test('a legacy account stays legacy across a real refresh and arms no timer', async () => {
  const account = uniqueAccount('legacy-refresh')
  await seedClaudeSession(claudeSession(account, {
    expiresAt: Date.now() + 60_000,
    keychainBound: true,
    credentialOwnershipMode: 'legacy-writeback',
  }))
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  let grants = 0
  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Claude (legacy refresh test)',
    makeOptions: () => ({
      // Inside the preempt window, so the cycle really renews the credential.
      preemptMs: 3_600_000,
      // The production refresh for this mode, over a synthetic token endpoint: the token
      // document states no ownership, so only the stored record can carry the mode across it.
      refresh: async (session) => {
        grants += 1
        return await refreshClaude(session, {
          fetchFn: async () => Response.json({ access_token: 'at-refreshed', expires_in: 3_600 }),
        })
      },
      isPermanent: isClaudePermanentRefreshError,
    }),
  })
  const controller = new ClaudeMaintenanceController({
    tokens,
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
  })
  try {
    const decision = await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(decision.ok, true)
    if (decision.ok) assert.equal(decision.session.accessToken, 'at-refreshed', 'the renewed credential is served')
    assert.equal(grants, 1, 'the credential was renewed once')
    const [view] = controller.view()
    assert.equal(view?.credential.status, 'external-coordination-unproven',
      'the renewed credential is still externally owned, never re-inferred as this plugin\'s own')
    assert.equal(scheduler.pending, 0, 'so this plugin never arms its own renewal timer for it')
    const stored = await getAccountSession('claude', account)
    assert.equal(stored?.credentialOwnershipMode, 'legacy-writeback', 'and the durable record still states the mode')
    assert.equal(stored?.keychainBound, true, 'with the imported fact intact')
  } finally {
    await controller.dispose()
  }
})

test('a read-only maintenance read resolves its credential through the use path', async () => {
  const account = uniqueAccount('read-only-read')
  await seedClaudeSession(claudeSession(account, {
    expiresAt: TEST_NOW + 3_600_000,
    keychainBound: true,
    credentialOwnershipMode: 'read-only-import',
    scopes: 'user:profile user:inference',
  }))
  let source: ClaudeSourceCredential | undefined = {
    session: {
      ...claudeSession(account, { scopes: 'user:profile user:inference' }),
      accessToken: 'at-source-1',
      refreshToken: 'rt-source-1',
    },
    declaredScopes: 'user:profile user:inference',
  }
  let grants = 0
  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Claude (read-only maintenance test)',
    makeOptions: () => ({
      preemptMs: 0,
      // A read-only account must never reach this: the use path answers first.
      refresh: async (current) => { grants += 1; return current },
      isPermanent: () => false,
    }),
    prepareSession: account => claudeReadOnlyUse(account, () => source),
  })
  const profileTokens: string[] = []
  const settingsTokens: string[] = []
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  const controller = new ClaudeMaintenanceController({
    tokens,
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
    readProfile: async (request) => {
      profileTokens.push(request.accessToken)
      return {
        outcome: 'ok',
        fields: { accountUuid: `uuid-${account}`, organization: 'org-1', emailAddress: account },
        complete: true,
      }
    },
    fetchSettings: async (request) => {
      settingsTokens.push(request.accessToken)
      return Response.json({ uuid: 'settings-1', checksum: 'checksum-1', settings: {} })
    },
  })
  try {
    const decision = await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(decision.ok, true)
    if (decision.ok) assert.equal(decision.session.accessToken, 'at-source-1', 'the request serves the external winner')
    // The managed-settings read is the bounded policy determination this request waits for, so it
    // has already run and authenticated with that winner. The profile read is best-effort
    // maintenance the request starts for the binding and does not wait for, so this case waits for
    // the read's own completion before asserting the credential it carried.
    assert.deepEqual(settingsTokens, ['at-source-1'], 'the managed-settings read authenticated with the external winner')
    assert.equal(await waitFor(() => profileTokens.length > 0), true, 'the profile read ran for this account')
    assert.deepEqual(profileTokens, ['at-source-1'], 'the profile read authenticated with the external winner')
    assert.equal(grants, 0, 'no maintenance read spent a grant')

    // The external source goes away: the next use stops instead of sending the stored copy.
    await controller.releaseSession('session-1')
    source = undefined
    const refused = await controller.ensureReady({ account, sessionId: 'session-2' })
    assert.equal(refused.ok, false)
    if (!refused.ok) {
      assert.equal(refused.error.code, 'INVALID_CREDENTIAL')
      assert.equal(refused.error.failure.retryDisposition, 'forbid', 'no sibling account may be asked instead')
    }
    assert.equal(grants, 0, 'a missing source never becomes a refresh')
    assert.deepEqual(profileTokens, ['at-source-1'], 'no further read was attempted')
    assert.deepEqual(settingsTokens, ['at-source-1'])
    const [view] = controller.view()
    assert.equal(view?.credential.status, 'reauth_required')
    assert.ok((await tokens.peek(account)) !== undefined, 'the stored authorization is retained, not deleted')
  } finally {
    await controller.dispose()
  }
})

test('a refresh that started before a logout and a same-token re-login cannot overwrite it', async () => {
  const account = uniqueAccount('aba')
  const original = claudeSession(account, { expiresAt: Date.now() + 60_000 })
  await seedClaudeSession(original)
  const started = deferred<void>()
  const gate = deferred<void>()
  // The shipped manager over the shipped store: the guard under test is the production
  // refresh path, not a direct store call.
  const tokens = claudeTokens({
    preemptMs: 3_600_000,
    refresh: async (current) => {
      started.resolve()
      await gate.promise
      return {
        ...current,
        accessToken: 'at-rotated',
        refreshToken: 'rt-rotated',
        expiresAt: Date.now() + 3_600_000,
      }
    },
  })
  const pending = tokens.session(account)
  await started.promise

  // Logout, then log the SAME token pair back in: the token comparison alone would let the
  // pending grant's result land, and only the revision records that the account moved on.
  assert.equal(await deleteAccountSession('claude', account), true)
  await saveAccountSession('claude', account, original)
  gate.resolve()

  const served = await pending
  assert.equal(served.accessToken, original.accessToken, 'the stored winner is served')
  const stored = await getAccountSession('claude', account)
  assert.equal(stored?.accessToken, original.accessToken, 'the stale grant did not overwrite the re-login')
  assert.equal(stored?.refreshToken, original.refreshToken)
  const credential = await getAccountCredential('claude', account)
  assert.ok((credential?.revision ?? 0) >= 3, `the persisted counter kept counting (${String(credential?.revision)})`)
})

test('the refresh spends the session and revision from one read', async () => {
  const account = uniqueAccount('atomic')
  const spent = claudeSession(account, { expiresAt: Date.now() + 60_000 })
  const winner = claudeSession(account, {
    accessToken: 'at-winner',
    refreshToken: 'rt-winner',
    expiresAt: Date.now() - 1_000,
  })
  let seenPrior: ClaudeSession | undefined
  let seenRevision: number | undefined
  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'atomic',
    makeOptions: () => ({
      preemptMs: 3_600_000,
      refresh: async current => ({ ...current, accessToken: 'at-rotated' }),
      isPermanent: () => false,
    }),
    io: {
      list: async () => [{ key: account, session: winner }],
      // The plain read already sees the other writer's login, which is what a two-call
      // shape would have paired with a newer revision.
      get: async () => winner,
      credential: async () => ({ key: account, session: spent, revision: 7 }),
      save: async (_account, _session, expectedPrior, expectedRevision) => {
        seenPrior = expectedPrior
        seenRevision = expectedRevision
        throw new Error('the conditional write is refused for this test')
      },
      remove: async () => undefined,
      resolve: async key => key,
    },
  })
  await assert.rejects(tokens.session(account))
  assert.equal(seenRevision, 7, 'the revision comes from the same read as the session it guards')
  assert.equal(seenPrior?.accessToken, spent.accessToken, 'and so does the session')
  assert.notEqual(seenPrior?.accessToken, winner.accessToken, 'the later login is not the pair that was spent')
})

test('an empty combined read is logged out, not a reason to re-read through get', async () => {
  const account = uniqueAccount('empty-read')
  const login = claudeSession(account, { accessToken: 'at-relogin', expiresAt: Date.now() - 1_000 })
  let gets = 0
  let refreshes = 0
  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'empty-read',
    makeOptions: () => ({
      preemptMs: 3_600_000,
      refresh: async (current) => {
        refreshes += 1
        return current
      },
      isPermanent: () => false,
    }),
    io: {
      list: async () => [],
      // A login lands after the combined read observed an empty store: the refresh must not
      // discover it through a second `get`, which would spend a grant with no revision.
      get: async () => {
        gets += 1
        return login
      },
      credential: async () => undefined,
      save: async () => { throw new Error('nothing may be written') },
      remove: async () => undefined,
      resolve: async key => key,
    },
  })
  await assert.rejects(
    tokens.session(account),
    (error: unknown) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL',
  )
  assert.equal(gets, 1, 'only the caller\'s initial read ran; the empty combined read is not re-read')
  assert.equal(refreshes, 0, 'no grant was sent for an account the store reports as logged out')
})

test('a backend without the combined read still refreshes from one read', async () => {
  const account = uniqueAccount('legacy-read')
  let current = claudeSession(account, { expiresAt: Date.now() + 60_000 })
  let refreshes = 0
  const tokens = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'legacy-read',
    makeOptions: () => ({
      preemptMs: 3_600_000,
      refresh: async (session) => {
        refreshes += 1
        return { ...session, accessToken: 'at-legacy-rotated', expiresAt: Date.now() + 3_600_000 }
      },
      isPermanent: () => false,
    }),
    io: {
      list: async () => [{ key: account, session: current }],
      get: async () => current,
      save: async (_account, session) => { current = session },
      remove: async () => undefined,
      resolve: async key => key,
    },
  })
  const served = await tokens.session(account)
  assert.equal(served.accessToken, 'at-legacy-rotated', 'the rotation is served')
  assert.equal(refreshes, 1)
})

test('a session that switches accounts releases its old binding and keeps other sessions', async () => {
  const first = uniqueAccount('rebind-a')
  const second = uniqueAccount('rebind-b')
  const other = 'rebind-other-session'
  await seedClaudeSession(claudeSession(first, { expiresAt: Date.now() + 7_200_000 }))
  await seedClaudeSession(claudeSession(second, { expiresAt: Date.now() + 7_200_000 }))
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  const tokens = claudeTokens({ refresh: async current => current, preemptMs: 0 })
  const controller = new ClaudeMaintenanceController({
    tokens,
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
  })
  try {
    await controller.ensureReady({ account: first, sessionId: 'switching' })
    await controller.ensureReady({ account: first, sessionId: other })
    // The same harness session now runs on the other account.
    await controller.ensureReady({ account: second, sessionId: 'switching' })
    const views = controller.view()
    assert.equal(views.find(view => view.account === first)?.bindings, 1, 'the other session still holds the first account')
    assert.equal(views.find(view => view.account === second)?.bindings, 1, 'the switched session bound the second account')

    // Releasing the other session leaves the switched one alone.
    await controller.releaseSession(other)
    assert.equal(
      controller.view().find(view => view.account === first)?.bindings,
      0,
      'the first account is released once nothing holds it',
    )
    assert.equal(controller.view().find(view => view.account === second)?.bindings, 1)
    await controller.dispose()
    assert.deepEqual(controller.view(), [], 'disposal reaches quiescence')
  } finally {
    await controller.dispose()
  }
})

test('a re-login on the same key with another account UUID starts a clean identity', async () => {
  const account = uniqueAccount('uuid-swap')
  await seedClaudeSession(claudeSession(account, {
    expiresAt: Date.now() + 7_200_000,
    accountUuid: 'uuid-a',
  }))
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  let accountUuid = 'uuid-a'
  let organization: string | undefined = 'org-a'
  let policyCalls = 0
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
    readProfile: async () => ({
      outcome: 'ok',
      complete: true,
      fields: { accountUuid, ...organization === undefined ? {} : { organization } },
    }),
    fetchSettings: async () => {
      policyCalls += 1
      return new Response(JSON.stringify({
        uuid: `u-${policyCalls}`,
        checksum: `sum-${policyCalls}`,
        settings: {},
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  try {
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(
      await waitFor(() => controller.view()[0]?.organization === 'org-a'),
      true,
      'the first identity confirmed its organization',
    )
    // Confirming the organization re-keys the state, so its policy is determined again.
    assert.equal(
      await waitFor(() => controller.view()[0]?.policy.checksum !== undefined),
      true,
      'the first identity accepted a policy snapshot',
    )
    const firstChecksum = controller.view()[0]?.policy.checksum

    // The same canonical key now holds another account UUID, and the response states no
    // organization at all.
    accountUuid = 'uuid-b'
    organization = undefined
    await saveAccountSession('claude', account, claudeSession(account, {
      accessToken: 'at-uuid-b',
      refreshToken: 'rt-uuid-b',
      expiresAt: Date.now() + 7_200_000,
      accountUuid: 'uuid-b',
    }))
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(await waitFor(() => controller.view().length === 1), true)
    const after = controller.view()[0]
    assert.equal(after?.organization, undefined, 'the new identity does not inherit the old organization')
    assert.equal(after?.profile.subscriptionType, undefined, 'nor the old profile record')
    assert.notEqual(after?.policy.checksum, firstChecksum, 'nor the old policy snapshot')
    assert.notEqual(after?.policy.checksum, undefined, 'the new identity reads its own policy')
  } finally {
    await controller.dispose()
  }
})

test('a lost refresh ownership spends no grant on an already-expired credential', async () => {
  const account = uniqueAccount('busy')
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() - 1_000 }))
  const refreshes: string[] = []
  const tokens = claudeTokens({
    preemptMs: 3_600_000,
    refresh: async (current) => {
      refreshes.push(current.refreshToken)
      return current
    },
    refreshOwnership: () => async <T>(cycle: () => Promise<T>) => {
      void cycle
      return { acquired: false as const }
    },
  })
  await assert.rejects(
    tokens.session(account),
    (error: unknown) => error instanceof LlmError && error.code === REFRESH_BUSY_CODE,
  )
  assert.deepEqual(refreshes, [], 'the grant is not spent without ownership')
  assert.equal(
    (await getAccountSession('claude', account))?.accessToken,
    `at-${account}`,
    'the unspent credential stays exactly as stored',
  )
})

test('a lost refresh ownership serves a credential that outlives the one held', async () => {
  const account = uniqueAccount('busy-fresh')
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 60_000 }))
  const refreshes: string[] = []
  const tokens = claudeTokens({
    preemptMs: 3_600_000,
    refresh: async (current) => {
      refreshes.push(current.refreshToken)
      return current
    },
    refreshOwnership: () => async <T>(cycle: () => Promise<T>) => {
      void cycle
      return { acquired: false as const }
    },
  })
  const served = await tokens.session(account)
  assert.equal(served.accessToken, `at-${account}`, 'the still-valid stored credential serves the caller')
  assert.deepEqual(refreshes, [], 'and no grant was spent')
})

test('a refresh that lost ownership is answered with the winner another process stored', async () => {
  const account = uniqueAccount('winner')
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 60_000 }))
  const winner = claudeSession(account, {
    accessToken: 'at-winner',
    refreshToken: 'rt-winner',
    expiresAt: Date.now() + 7_200_000,
  })
  const refreshes: string[] = []
  const tokens = claudeTokens({
    preemptMs: 3_600_000,
    refresh: async (current) => {
      refreshes.push(current.refreshToken)
      return current
    },
    refreshOwnership: () => async <T>(cycle: () => Promise<T>) => {
      void cycle
      await saveAccountSession('claude', winner.emailAddress ?? account, winner)
      return { acquired: false as const }
    },
  })
  const served = await tokens.session(account)
  assert.equal(served.accessToken, 'at-winner', 'the stored winner is served, not the credential it replaced')
  assert.deepEqual(refreshes, [], 'no grant was spent')
})
