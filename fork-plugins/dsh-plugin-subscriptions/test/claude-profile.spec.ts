/**
 * Profile maintenance: when the account profile is read, what a response may update, and
 * what a failure means.
 *
 * The pure decisions are exercised directly, and the controller-level cases drive the
 * shipped token manager and store in the private test home with an injected reader, so no
 * provider endpoint, credential or wall-clock sleep is involved.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeMaintenanceController } from '../src/providers/claude-maintenance.js'
import { FileClaudeMaintenancePersistence } from '../src/providers/claude-maintenance-state.js'
import {
  claudeHasProfileScope,
  claudeProfileReadDecision,
  readClaudeProfile,
} from '../src/providers/claude-profile.js'
import type { ClaudeProfileReader } from '../src/providers/claude-profile.js'
import { claudeProfileCompleteness, claudeProfileFreshness, mergeClaudeProfile } from '../src/providers/claude-account-state.js'
import type { ClaudeAccountIdentity, ClaudeProfileRecord } from '../src/providers/claude-account-state.js'
import {
  ManualClock,
  ManualScheduler,
  claudeSession,
  claudeTokens,
  seedClaudeSession,
  uniqueAccount,
  waitFor,
} from './claude-maintenance-fixtures.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** The identity one test works under. */
function identity(account: string, organization?: string): ClaudeAccountIdentity {
  return {
    account,
    origin: 'https://api.anthropic.com',
    protocolFingerprint: 'fp-1',
    ...organization === undefined ? {} : { organization },
  }
}

/** A complete record for one identity, under the current completeness contract. */
function record(account: string, overrides: Partial<ClaudeProfileRecord> = {}): ClaudeProfileRecord {
  return {
    identity: identity(account, 'org-1'),
    accountUuid: 'uuid-1',
    emailAddress: account,
    subscriptionType: 'max',
    capturedAt: 1_000,
    complete: true,
    completenessVersion: 1,
    credentialRevision: 1,
    ...overrides,
  }
}

/** The base decision input for one identity. */
function decisionInput(account: string, overrides: Partial<Parameters<typeof claudeProfileReadDecision>[0]> = {}) {
  return {
    identity: identity(account),
    hasCredential: true,
    hasProfileScope: true,
    now: 10_000,
    maxAgeMs: DAY,
    ...overrides,
  }
}

test('a complete, fresh record is not re-read', () => {
  const decision = claudeProfileReadDecision(decisionInput('a@example.invalid', { record: record('a@example.invalid') }))
  assert.equal(decision.needed, false)
  assert.equal(decision.reason, 'fresh')
})

test('an explicit null subscription type is a complete answer, not a stale one', () => {
  const stored = record('a@example.invalid', { subscriptionType: null })
  assert.deepEqual(claudeProfileCompleteness(stored), { complete: true, missing: [] })
  const decision = claudeProfileReadDecision(decisionInput('a@example.invalid', { record: stored }))
  assert.equal(decision.needed, false, 'an unknown plan is not a reason to read again')
  assert.equal(decision.reason, 'fresh')
})

test('a record missing the account identity is read again', () => {
  const { accountUuid: _dropped, ...withoutUuid } = record('a@example.invalid')
  assert.deepEqual(claudeProfileCompleteness(withoutUuid), { complete: false, missing: ['accountUuid'] })
  assert.equal(claudeProfileReadDecision(decisionInput('a@example.invalid', { record: withoutUuid })).reason, 'incomplete')
})

test('a record written under the old field-based completeness is read again once', () => {
  const { completenessVersion: _dropped, ...legacy } = record('a@example.invalid')
  assert.deepEqual(
    claudeProfileCompleteness(legacy),
    { complete: false, missing: ['completeness'] },
    'the old simplification is not trusted as complete',
  )
  assert.equal(claudeProfileReadDecision(decisionInput('a@example.invalid', { record: legacy })).reason, 'incomplete')
})

test('an incomplete record is read again even while it is fresh', () => {
  const now = 10_000
  const incomplete = record('a@example.invalid', { capturedAt: now - 1, complete: false })
  const decision = claudeProfileReadDecision(decisionInput('a@example.invalid', { record: incomplete, now }))
  assert.equal(decision.reason, 'incomplete', 'freshness never stands in for the completeness verdict')
  assert.equal(decision.needed, true)
})

test('a response that discloses no organization is not a complete record', () => {
  const withoutOrganization = record('a@example.invalid', { identity: identity('a@example.invalid') })
  assert.deepEqual(
    claudeProfileCompleteness(withoutOrganization),
    { complete: false, missing: ['organization'] },
  )
  assert.equal(
    claudeProfileReadDecision(decisionInput('a@example.invalid', { record: withoutOrganization })).reason,
    'incomplete',
  )
})

test('the freshness deadline itself is stale, one millisecond before it is not', () => {
  const capturedAt = 1_000
  const atDeadline = record('a@example.invalid', { capturedAt })
  assert.equal(
    claudeProfileFreshness(atDeadline, capturedAt + DAY, DAY),
    'stale',
    'the pinned client skips only while the age is strictly below its TTL',
  )
  assert.equal(
    claudeProfileFreshness(atDeadline, capturedAt + DAY - 1, DAY),
    'fresh',
    'one millisecond earlier is still inside the window',
  )
  assert.equal(claudeProfileFreshness(undefined, capturedAt, DAY), 'missing')
})

test('a record past the freshness baseline is read again, and a null subscription type alone is not', () => {
  const now = 100 * DAY
  const stale = record('a@example.invalid', { capturedAt: 1 })
  assert.equal(claudeProfileReadDecision(decisionInput('a@example.invalid', { record: stale, now })).reason, 'stale')
  const freshNull = record('a@example.invalid', { capturedAt: now - HOUR, subscriptionType: null })
  assert.equal(
    claudeProfileReadDecision(decisionInput('a@example.invalid', { record: freshNull, now })).reason,
    'fresh',
    'the unknown plan is not itself a freshness reason',
  )
})

test('a record for another organization is read again', () => {
  const stored = record('a@example.invalid', { identity: identity('a@example.invalid', 'org-1') })
  const decision = claudeProfileReadDecision(decisionInput('a@example.invalid', {
    record: stored,
    identity: identity('a@example.invalid', 'org-2'),
  }))
  assert.equal(decision.needed, true)
  assert.equal(decision.reason, 'identity-changed')
})

test('a missing scope or credential never starts a read', () => {
  assert.equal(claudeProfileReadDecision(decisionInput('a@example.invalid', { hasProfileScope: false })).reason, 'scope-missing')
  assert.equal(claudeProfileReadDecision(decisionInput('a@example.invalid', { hasCredential: false })).reason, 'no-credential')
})

test('a cooling failure is not retried before its backoff', () => {
  const decision = claudeProfileReadDecision(decisionInput('a@example.invalid', { now: 10_000, retryAfter: 20_000 }))
  assert.equal(decision.needed, false)
  assert.equal(decision.reason, 'cooling')
})

test('a merged response keeps known fields it does not address and honours an explicit null', () => {
  const previous = record('a@example.invalid')
  const kept = mergeClaudeProfile(previous, {
    identity: previous.identity,
    fields: { accountUuid: 'uuid-1' },
    capturedAt: 20_000,
    credentialRevision: 2,
  })
  assert.equal(kept.subscriptionType, 'max', 'an absent field does not erase the confirmed plan')
  assert.equal(kept.emailAddress, 'a@example.invalid')
  const cleared = mergeClaudeProfile(previous, {
    identity: previous.identity,
    fields: { subscriptionType: null },
    capturedAt: 20_000,
    credentialRevision: 3,
  })
  assert.equal(cleared.subscriptionType, null, 'a validated response can move the plan to unknown')
})

test('the profile scope is read from the granted scopes', () => {
  assert.equal(claudeHasProfileScope(claudeSession('a@example.invalid')), true)
  assert.equal(
    claudeHasProfileScope(claudeSession('a@example.invalid', { scopes: 'user:inference' })),
    false,
  )
})

test('a response naming another account is refused rather than merged', async () => {
  const controller = new AbortController()
  const outcome = await readClaudeProfile({
    identity: identity('a@example.invalid'),
    account: 'a@example.invalid',
    accessToken: 'at-a',
    credentialRevision: 1,
    knownAccountUuid: 'uuid-1',
    previous: record('a@example.invalid'),
    now: 20_000,
    reader: async () => ({ outcome: 'ok', fields: { accountUuid: 'uuid-other' } }),
    signal: controller.signal,
  })
  assert.equal(outcome.outcome, 'identity-changed')
})

test('a refused profile read stops automatic attempts and keeps the known plan', async () => {
  const controller = new AbortController()
  const outcome = await readClaudeProfile({
    identity: identity('a@example.invalid'),
    account: 'a@example.invalid',
    accessToken: 'at-a',
    credentialRevision: 1,
    previous: record('a@example.invalid'),
    now: 20_000,
    reader: async () => ({
      outcome: 'refused',
      failure: { reason: 'permission_denied', retryDisposition: 'forbid', scope: 'account' },
    }),
    signal: controller.signal,
  })
  assert.equal(outcome.outcome, 'failed')
  if (outcome.outcome !== 'failed') return
  assert.equal(outcome.stop, true, 'a forbidden failure schedules nothing further')
  assert.equal(outcome.retryable, false)
})

test('a transport failure stays retryable and adopts nothing', async () => {
  const controller = new AbortController()
  const outcome = await readClaudeProfile({
    identity: identity('a@example.invalid'),
    account: 'a@example.invalid',
    accessToken: 'at-a',
    credentialRevision: 1,
    previous: record('a@example.invalid'),
    now: 20_000,
    reader: async () => ({ outcome: 'unreachable' }),
    signal: controller.signal,
  })
  assert.equal(outcome.outcome, 'failed')
  if (outcome.outcome !== 'failed') return
  assert.equal(outcome.retryable, true)
  assert.equal(outcome.stop, false)
})

/**
 * Build a controller whose profile reader is injected.
 * @param account - the account to seed.
 * @param session - the credential to store for it.
 * @param reader - the profile reader to inject.
 */
async function controllerHarness(
  account: string,
  session: ReturnType<typeof claudeSession>,
  reader?: ClaudeProfileReader,
): Promise<{ controller: ClaudeMaintenanceController; clock: ManualClock; scheduler: ManualScheduler }> {
  await seedClaudeSession(session)
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
    ...reader === undefined ? {} : { readProfile: reader },
  })
  return { controller, clock, scheduler }
}

test('a bound account reads its profile once and reports it fresh', async () => {
  const account = uniqueAccount('profile-ok')
  let reads = 0
  const { controller } = await controllerHarness(account, claudeSession(account, { expiresAt: Date.now() + DAY }), async () => {
    reads += 1
    return { outcome: 'ok', complete: true, fields: { accountUuid: 'uuid-1', subscriptionType: 'max', organization: 'org-1' } }
  })
  try {
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(await waitFor(() => reads === 1), true, 'the bound account read its profile once')
    await waitFor(() => controller.view()[0]?.profile.status === 'fresh')
    const [view] = controller.view()
    assert.equal(view?.profile.complete, true)
    assert.equal(view?.profile.subscriptionType, 'max')
    assert.equal(view?.profile.capturedAt !== undefined, true, 'the acceptance instant is recorded')
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(reads, 1, 'a fresh record starts no second read')
  } finally {
    await controller.dispose()
  }
})

test('a deployment without a profile reader reports that instead of failing silently', async () => {
  const account = uniqueAccount('profile-none')
  const { controller } = await controllerHarness(account, claudeSession(account, { expiresAt: Date.now() + DAY }))
  try {
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(await waitFor(() => controller.view()[0]?.profile.reason === 'reader-unavailable'), true)
    assert.equal(controller.view()[0]?.profile.status, 'missing')
  } finally {
    await controller.dispose()
  }
})

test('a profile record is reused after a restart instead of being read again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-maintenance-profile-'))
  const statePath = join(dir, 'claude-maintenance.json')
  const account = uniqueAccount('profile-restart')
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 7 * DAY }))
  let reads = 0
  const reader: ClaudeProfileReader = async () => {
    reads += 1
    return { outcome: 'ok', complete: true, fields: { accountUuid: 'uuid-1', subscriptionType: 'max', organization: 'org-1' } }
  }
  const build = (): ClaudeMaintenanceController => {
    const clock = new ManualClock()
    return new ClaudeMaintenanceController({
      tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
      config: { refreshLeadMs: 300_000 },
      clock,
      scheduler: new ManualScheduler(clock),
      readProfile: reader,
      persistence: new FileClaudeMaintenancePersistence({ path: statePath }),
    })
  }
  const first = build()
  try {
    await first.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(await waitFor(() => reads === 1), true, 'the bound account read its profile once')
    assert.equal(
      await waitFor(() => first.view()[0]?.profile.complete === true),
      true,
      'the accepted record is the observable state before disposal',
    )
  } finally {
    await first.dispose()
  }
  const second = build()
  try {
    await second.hydrate()
    const [view] = second.view()
    assert.equal(view?.profile.complete, true, 'the stored record is installed without a read')
    assert.equal(view?.profile.subscriptionType, 'max')
    assert.equal(view?.bindings, 0, 'hydration creates no binding')
    await second.ensureReady({ account, sessionId: 'session-2' })
    assert.equal(reads, 1, 'a fresh stored record starts no second read')
  } finally {
    await second.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a thrown reader failure exposes a fixed code, never the error text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-maintenance-redaction-'))
  const statePath = join(dir, 'claude-maintenance.json')
  const account = uniqueAccount('profile-redaction')
  const secret = 'sk-ant-secret-token'
  const prompt = 'user prompt text'
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 7 * DAY }))
  const clock = new ManualClock()
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler: new ManualScheduler(clock),
    readProfile: async () => { throw new Error(`refresh failed for ${secret} while sending "${prompt}"`) },
    persistence: new FileClaudeMaintenancePersistence({ path: statePath }),
  })
  try {
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(
      await waitFor(() => controller.view()[0]?.profile.failure !== undefined),
      true,
      'the thrown failure is reported',
    )
    assert.equal(controller.view()[0]?.profile.failure?.reason, 'UNEXPECTED_PROFILE_READ', 'a fixed code reaches the view')
    const viewText = JSON.stringify(controller.view())
    assert.equal(viewText.includes(secret), false, 'no token reaches the status view')
    assert.equal(viewText.includes(prompt), false, 'no prompt text reaches the status view')
  } finally {
    await controller.dispose()
  }
  // The same rule holds for what a restart would read back.
  const stored = JSON.stringify(await new FileClaudeMaintenancePersistence({ path: statePath }).load())
  assert.equal(stored.includes(secret), false, 'no token reaches the durable state')
  assert.equal(stored.includes(prompt), false, 'no prompt text reaches the durable state')
  rmSync(dir, { recursive: true, force: true })
})

test('a reader that reports no completeness leaves the record incomplete', async () => {
  const account = uniqueAccount('profile-nocomplete')
  let reads = 0
  const { controller } = await controllerHarness(
    account,
    claudeSession(account, { expiresAt: Date.now() + DAY }),
    async () => {
      reads += 1
      // The fields are complete-looking, but this reader computed no verdict.
      return { outcome: 'ok', fields: { accountUuid: 'uuid-1', organization: 'org-1' } }
    },
  )
  try {
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(await waitFor(() => reads === 1), true)
    assert.equal(
      await waitFor(() => controller.view()[0]?.profile.complete === false),
      true,
      'an unreported verdict is never guessed as complete',
    )
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(
      await waitFor(() => reads === 2),
      true,
      'so the next bounded trigger reads again instead of trusting the fields',
    )
  } finally {
    await controller.dispose()
  }
})

test('a transient profile failure keeps the known plan and does not touch the credential', async () => {
  const account = uniqueAccount('profile-fail')
  let reads = 0
  const reader: ClaudeProfileReader = async () => {
    reads += 1
    return reads === 1
      ? { outcome: 'ok', complete: true, fields: { accountUuid: 'uuid-1', subscriptionType: 'max', organization: 'org-1' } }
      : { outcome: 'unreachable' }
  }
  const { controller, clock } = await controllerHarness(
    account,
    claudeSession(account, { expiresAt: Date.now() + 7 * DAY, subscriptionType: 'max' }),
    reader,
  )
  try {
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(await waitFor(() => controller.view()[0]?.profile.complete === true), true)
    // Past the freshness baseline: the next real use re-reads, and this time it fails.
    clock.advanceTo(clock.now() + 25 * HOUR)
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(await waitFor(() => reads === 2), true, 'the stale record was read again')
    assert.equal(
      await waitFor(() => controller.view()[0]?.profile.failure !== undefined),
      true,
      'the failed read is reported with a reason',
    )
    const after = controller.view()[0]
    assert.equal(after?.profile.failure?.reason, 'PROFILE_UNREACHABLE')
    assert.equal(after?.profile.subscriptionType, 'max', 'a failed read does not erase the confirmed plan')
    assert.notEqual(after?.profile.status, 'missing')
    assert.equal(after?.credential.status, 'ready', 'a profile failure is not a credential failure')
  } finally {
    await controller.dispose()
  }
})
