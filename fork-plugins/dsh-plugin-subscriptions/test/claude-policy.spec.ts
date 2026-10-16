/**
 * Managed-settings policy: the fixed envelope and cache semantics, the projection of an
 * accepted document, the fail-closed treatment of restrictions no consumer owns, and the
 * capability reach that keeps a narrow check from bypassing a wider restriction.
 *
 * Every provider answer is a synthetic `Response`; no endpoint, credential or network is
 * involved, and the controller cases reuse the shipped token manager over the private test
 * store with the injected click and scheduler.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_POLICY_BODY_LIMIT,
  claudeIfNoneMatch,
  claudePermissionConsumer,
  claudePolicyConsumers,
  claudeScopesFor,
  decideClaudePolicy,
  parseClaudePolicyEnvelope,
  projectClaudePolicy,
  readClaudeManagedSettings,
} from '../src/providers/claude-managed-settings.js'
import type {
  ClaudePolicyConsumer,
  ClaudePolicyFetchFn,
  ClaudePolicySnapshot,
} from '../src/providers/claude-managed-settings.js'
import { claudeIdentityKey, claudePolicyEligibility, classifyClaudeSubscription } from '../src/providers/claude-account-state.js'
import { ClaudeMaintenanceController } from '../src/providers/claude-maintenance.js'
import type { ClaudeMaintenanceOptions, ClaudeRequestDecision } from '../src/providers/claude-maintenance.js'
import { FileClaudeMaintenancePersistence } from '../src/providers/claude-maintenance-state.js'
import {
  ManualClock,
  ManualScheduler,
  claudeSession,
  claudeTokens,
  deferred,
  seedClaudeSession,
  settle,
  uniqueAccount,
  waitFor,
} from './claude-maintenance-fixtures.js'

const ACCOUNT = 'policy@example.invalid'
const HOUR = 3_600_000
const IDENTITY = {
  account: ACCOUNT,
  origin: 'https://api.anthropic.com',
  protocolFingerprint: 'fp-1',
}

/** A JSON response carrying one envelope. */
function envelopeResponse(settings: Record<string, unknown>, checksum = 'sum-1', uuid = 'uuid-1'): Response {
  return new Response(JSON.stringify({ uuid, checksum, settings }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Read one response through the module under test. */
async function read(
  response: Response | ClaudePolicyFetchFn,
  options: {
    cached?: ClaudePolicySnapshot
    identity?: ClaudePolicySnapshot['identity']
    consumers?: readonly ClaudePolicyConsumer[]
    classifyHttpFailure?: Parameters<typeof readClaudeManagedSettings>[0]['classifyHttpFailure']
  } = {},
) {
  const fetchSettings: ClaudePolicyFetchFn = typeof response === 'function' ? response : async () => response
  return readClaudeManagedSettings({
    identity: options.identity ?? IDENTITY,
    account: ACCOUNT,
    accessToken: 'at-policy',
    now: 1_000,
    consumers: claudePolicyConsumers(options.consumers ?? []),
    fetchSettings,
    ...options.cached === undefined ? {} : { cached: options.cached },
    ...options.classifyHttpFailure === undefined ? {} : { classifyHttpFailure: options.classifyHttpFailure },
  })
}

test('the envelope accepts exactly uuid, checksum and settings', () => {
  assert.deepEqual(parseClaudePolicyEnvelope('{"uuid":"u","checksum":"c","settings":{}}'), {
    uuid: 'u',
    checksum: 'c',
    settings: {},
  })
  assert.equal(parseClaudePolicyEnvelope('{"uuid":"u","settings":{}}'), undefined, 'a missing checksum is not an envelope')
  assert.equal(parseClaudePolicyEnvelope('{"uuid":"u","checksum":"c","settings":null}'), undefined)
  assert.equal(parseClaudePolicyEnvelope('not json'), undefined)
  assert.equal(parseClaudePolicyEnvelope('[]'), undefined)
})

test('a 200 envelope is accepted with the server checksum and its document kept', async () => {
  const outcome = await read(envelopeResponse({ outputStyle: 'text' }))
  assert.equal(outcome.outcome, 'accepted')
  if (outcome.outcome !== 'accepted') return
  assert.equal(outcome.snapshot.checksum, 'sum-1')
  assert.equal(outcome.snapshot.revision, 'uuid-1')
  assert.deepEqual(outcome.snapshot.settings, { outputStyle: 'text' })
})

test('the next conditional read sends the cached checksum as an entity tag', async () => {
  const first = await read(envelopeResponse({}))
  assert.equal(first.outcome, 'accepted')
  if (first.outcome !== 'accepted') return
  let seen: string | undefined
  const outcome = await read(async (request) => {
    seen = request.ifNoneMatch
    return new Response(null, { status: 304 })
  }, { cached: first.snapshot })
  assert.equal(seen, '"sum-1"', 'the server checksum is quoted, not hashed locally')
  assert.equal(outcome.outcome, 'unchanged')
  assert.equal(claudeIfNoneMatch('"already-quoted"'), '"already-quoted"')
})

test('a 304 with no cached checksum is an error, not an empty policy', async () => {
  const outcome = await read(new Response(null, { status: 304 }))
  assert.equal(outcome.outcome, 'invalid')
  if (outcome.outcome !== 'invalid') return
  assert.equal(outcome.failure.reason, 'unexpected_304')
  assert.equal(outcome.blocker?.scope, 'unknown', 'an unreadable validator blocks the affected scope')
})

test('an empty sentinel sends no validator, so a later 304 is an error', async () => {
  const empty = await read(new Response(null, { status: 204 }))
  assert.equal(empty.outcome, 'empty')
  if (empty.outcome !== 'empty') return
  assert.equal(empty.snapshot.checksum, '')
  let seen: string | undefined = 'not-set'
  const outcome = await read(async (request) => {
    seen = request.ifNoneMatch
    return new Response(null, { status: 304 })
  }, { cached: empty.snapshot })
  assert.equal(seen, undefined, 'an empty sentinel has no checksum to send')
  assert.equal(outcome.outcome, 'invalid', 'and a 304 cannot revalidate it')
  if (outcome.outcome !== 'invalid') return
  assert.equal(outcome.failure.reason, 'unexpected_304')
})

test('a snapshot of another organization contributes no validator', async () => {
  const first = await read(envelopeResponse({}), { identity: { ...IDENTITY, organization: 'org-a' } })
  assert.equal(first.outcome, 'accepted')
  if (first.outcome !== 'accepted') return
  let seen: string | undefined = 'not-set'
  const outcome = await read(async (request) => {
    seen = request.ifNoneMatch
    return new Response(null, { status: 304 })
  }, { cached: first.snapshot, identity: { ...IDENTITY, organization: 'org-b' } })
  assert.equal(seen, undefined, 'another organization\'s cache is not this identity\'s validator')
  assert.equal(outcome.outcome, 'invalid')
})

test('the response body reader is released on every path', async () => {
  const ok = envelopeResponse({ outputStyle: 'text' })
  const accepted = await read(ok)
  assert.equal(accepted.outcome, 'accepted')
  assert.equal(ok.body?.locked, false, 'a completed read releases the reader')

  const oversize = new Response('x'.repeat(CLAUDE_POLICY_BODY_LIMIT + 1), { status: 200 })
  const refused = await read(oversize)
  assert.equal(refused.outcome, 'invalid')
  assert.equal(oversize.body?.locked, false, 'an oversized read releases the reader')

  const failing = new Response('{"uuid":"u"}', { status: 200 })
  const malformed = await read(failing)
  assert.equal(malformed.outcome, 'invalid')
  assert.equal(failing.body?.locked, false, 'a malformed envelope releases the reader')

  const empty = new Response('ignored', { status: 404 })
  await read(empty)
  assert.equal(empty.body?.locked, false, 'a discarded body is not left locked')
})

test('204 and 404 are the endpoint empty-success statuses', async () => {
  for (const status of [204, 404]) {
    const outcome = await read(new Response(null, { status }))
    assert.equal(outcome.outcome, 'empty')
    if (outcome.outcome !== 'empty') return
    assert.deepEqual(outcome.snapshot.restrictions, [])
    assert.equal(outcome.snapshot.checksum, '', 'an empty snapshot carries no validator')
  }
})

test('a redirected response is never read as the pinned endpoint', async () => {
  const redirected = new Response(JSON.stringify({ uuid: 'u', checksum: 'c', settings: {} }), { status: 200 })
  Object.defineProperty(redirected, 'redirected', { value: true })
  const outcome = await read(redirected)
  assert.equal(outcome.outcome, 'invalid')
  if (outcome.outcome !== 'invalid') return
  assert.equal(outcome.failure.reason, 'redirected')
})

test('a malformed envelope keeps the cached snapshot and blocks its scope', async () => {
  const first = await read(envelopeResponse({}))
  if (first.outcome !== 'accepted') assert.fail('the first read must be accepted')
  const outcome = await read(new Response('{"uuid":"u"}', { status: 200 }), { cached: first.snapshot })
  assert.equal(outcome.outcome, 'invalid')
  if (outcome.outcome !== 'invalid') return
  assert.equal(outcome.failure.reason, 'parse_error')
  assert.equal(outcome.blocker?.code, 'POLICY_UNSUPPORTED')
})

test('a body over the accepted bound is refused before it is parsed', async () => {
  const huge = new Response('x'.repeat(CLAUDE_POLICY_BODY_LIMIT + 1), { status: 200 })
  const outcome = await read(huge)
  assert.equal(outcome.outcome, 'invalid')
  if (outcome.outcome !== 'invalid') return
  assert.equal(outcome.failure.reason, 'body_over_limit')
})

test('a 403 is a refusal, and the injected classifier owns its decision', async () => {
  const outcome = await read(new Response('{}', { status: 403 }), {
    classifyHttpFailure: async () => ({
      reason: 'CLIENT_VERSION_UNSUPPORTED',
      serverCode: 'claude_code_version_too_old',
      stage: 'http',
      scope: 'protocol',
      retryDisposition: 'forbid',
      outputDelivered: false,
      origin: IDENTITY.origin,
      protocolFingerprint: IDENTITY.protocolFingerprint,
    }),
  })
  assert.equal(outcome.outcome, 'refused')
  if (outcome.outcome !== 'refused') return
  assert.equal(outcome.failure.retryDisposition, 'forbid')
})

test('a 401 asks for the one controlled credential recovery', async () => {
  const outcome = await read(new Response(null, { status: 401 }))
  assert.equal(outcome.outcome, 'unauthorized')
})

test('a transport failure keeps the accepted snapshot', async () => {
  const outcome = await read(async () => { throw new Error('offline') })
  assert.equal(outcome.outcome, 'transient')
})

test('an unknown key blocks, a preference key does not, and a removed rule is inert', () => {
  const unknown = projectClaudePolicy({ mysteryFlag: true }, new Map())
  assert.equal(unknown.blockers.length, 1)
  assert.equal(unknown.blockers[0].code, 'POLICY_UNSUPPORTED')
  assert.equal(unknown.blockers[0].scope, 'unknown')

  const preference = projectClaudePolicy({ model: 'claude-opus-4-5' }, new Map())
  assert.deepEqual(preference.blockers, [], 'a preferred default model denies nothing')
  assert.equal(preference.keys[0].disposition, 'preference')

  const removed = projectClaudePolicy({ permissions: null }, new Map())
  assert.deepEqual(removed.blockers, [], 'an explicit null removes a remote rule')
})

test('a key with no consumer blocks its own scope, and the model check survives it', () => {
  const projection = projectClaudePolicy({ sandbox: { enabled: true } }, new Map())
  assert.equal(projection.blockers[0].scope, 'execution')
  const snapshot = snapshotOf(projection)
  assert.equal(
    decideClaudePolicy({ capabilities: claudeScopesFor('shell'), tool: 'bash' }, snapshot, new Map()).decision,
    'deny',
    'a shell-capable tool reaches the execution scope',
  )
  assert.equal(
    decideClaudePolicy({ capabilities: claudeScopesFor('model') }, snapshot, new Map()).decision,
    'allow',
    'a model request does not reach the execution scope',
  )
})

test('a check that cannot name its capabilities reaches every scope', () => {
  const projection = projectClaudePolicy({ managedMcpServers: { a: {} } }, new Map())
  const snapshot = snapshotOf(projection)
  const decision = decideClaudePolicy({ tool: 'bash' }, snapshot, new Map())
  assert.equal(decision.decision, 'deny', 'an unknown-reach operation is decided conservatively')
})

test('an accepted restriction whose consumer disappeared is refused, not ignored', () => {
  const consumer = claudePermissionConsumer({ toolAliases: { Bash: 'bash' } })
  const projection = projectClaudePolicy({ permissions: { deny: ['Bash'] } }, claudePolicyConsumers([consumer]))
  assert.deepEqual(projection.blockers, [])
  const snapshot = snapshotOf(projection)
  assert.equal(
    decideClaudePolicy({ capabilities: claudeScopesFor('shell'), tool: 'bash' }, snapshot, claudePolicyConsumers([])).decision,
    'deny',
    'a restriction with no consumer at decision time is not dropped',
  )
  assert.equal(
    decideClaudePolicy({ capabilities: claudeScopesFor('shell'), tool: 'edit' }, snapshot, claudePolicyConsumers([consumer])).decision,
    'allow',
  )
})

test('permission rules are enforced only where their meaning is exact', () => {
  const consumer = claudePermissionConsumer({ toolAliases: { Bash: 'bash', Read: 'read_file' } })
  const projected = projectClaudePolicy(
    { permissions: { deny: ['Bash(npm install:*)', 'Read'], ask: ['Write'] } },
    claudePolicyConsumers([consumer]),
  )
  assert.equal(projected.blockers.length, 2, 'the specifier rule and the unmapped Write rule are unsupported')
  const codes = projected.blockers.map(entry => entry.code)
  assert.deepEqual(codes, ['POLICY_UNSUPPORTED', 'POLICY_UNSUPPORTED'])
  const snapshot = snapshotOf(projected)
  assert.equal(
    decideClaudePolicy({ capabilities: claudeScopesFor('tool'), tool: 'read_file' }, snapshot, claudePolicyConsumers([consumer])).decision,
    'deny',
    'a bare mapped rule denies its tool exactly',
  )
  const denied = decideClaudePolicy({ capabilities: claudeScopesFor('tool'), tool: 'bash' }, snapshot, claudePolicyConsumers([consumer]))
  assert.equal(denied.decision, 'deny', 'the unsupported specifier rule blocks the tool scope rather than being guessed')
})

test('disableBypassPermissionsMode refuses bypass and nothing else', () => {
  const consumer = claudePermissionConsumer({ toolAliases: {} })
  const snapshot = snapshotOf(projectClaudePolicy(
    { permissions: { disableBypassPermissionsMode: 'disable' } },
    claudePolicyConsumers([consumer]),
  ))
  assert.equal(
    decideClaudePolicy({ capabilities: claudeScopesFor('tool'), bypassPermissions: true }, snapshot, claudePolicyConsumers([consumer])).decision,
    'deny',
  )
  assert.equal(
    decideClaudePolicy({ capabilities: claudeScopesFor('tool') }, snapshot, claudePolicyConsumers([consumer])).decision,
    'allow',
  )
})

test('a rule needing a recorded approval is reported rather than auto-approved', () => {
  const consumer = claudePermissionConsumer({ toolAliases: { Write: 'write_file' } })
  const snapshot = snapshotOf(projectClaudePolicy(
    { permissions: { ask: ['Write'] } },
    claudePolicyConsumers([consumer]),
  ))
  const decision = decideClaudePolicy(
    { capabilities: claudeScopesFor('tool'), tool: 'write_file' },
    snapshot,
    claudePolicyConsumers([consumer]),
  )
  assert.equal(decision.decision, 'deny')
  if (decision.decision !== 'deny') return
  assert.equal(decision.code, 'POLICY_CONSENT_REQUIRED')
})

test('eligibility separates a confirmed pro/max account from an unstated one', () => {
  assert.equal(classifyClaudeSubscription('Max'), 'pro-max')
  assert.equal(classifyClaudeSubscription(null), 'unknown')
  assert.notEqual(classifyClaudeSubscription('Claude Pro'), 'pro-max', 'a product name is never read as a plan')
  assert.notEqual(classifyClaudeSubscription(''), 'pro-max', 'an empty value is never read as a plan')
  assert.equal(claudePolicyEligibility({ subscriptionType: 'max', firstPartyOAuth: true, hasCredential: true }).kind, 'ineligible')
  assert.equal(claudePolicyEligibility({ subscriptionType: null, firstPartyOAuth: true, hasCredential: true }).kind, 'eligible')
  assert.equal(claudePolicyEligibility({ subscriptionType: 'team', firstPartyOAuth: true, hasCredential: true }).reason, 'organization-subscription')
  assert.equal(claudePolicyEligibility({ subscriptionType: 'free', firstPartyOAuth: true, hasCredential: true }).reason, 'unsupported-subscription-type')
  assert.equal(claudePolicyEligibility({ subscriptionType: null, firstPartyOAuth: true, hasCredential: false }).kind, 'no-credential')
})

/** A snapshot carrying one projection, for the decision cases. */
function snapshotOf(projection: ReturnType<typeof projectClaudePolicy>): ClaudePolicySnapshot {
  return {
    identity: IDENTITY,
    checksum: 'sum-1',
    revision: 'uuid-1',
    acceptedAt: 1_000,
    settings: {},
    keys: projection.keys,
    restrictions: projection.restrictions,
    blockers: projection.blockers,
  }
}

/** A controller over the shipped token manager with injected policy answers. */
async function policyHarness(
  account: string,
  session: ReturnType<typeof claudeSession>,
  fetchSettings: Parameters<typeof readClaudeManagedSettings>[0]['fetchSettings'],
  extra: Partial<ClaudeMaintenanceOptions> = {},
): Promise<{ controller: ClaudeMaintenanceController; clock: ManualClock; scheduler: ManualScheduler; requests: string[] }> {
  await seedClaudeSession(session)
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  const requests: string[] = []
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
    fetchSettings: (request) => {
      requests.push(request.account)
      return fetchSettings(request)
    },
    ...extra,
  })
  return { controller, clock, scheduler, requests }
}

test('a confirmed pro/max account never requests the settings endpoint', async () => {
  const account = uniqueAccount('policy-promax')
  const { controller, requests } = await policyHarness(
    account,
    claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR, subscriptionType: 'max' }),
    async () => envelopeResponse({}),
  )
  try {
    await controller.ensureReady({ account, sessionId: 'session-1' })
    await waitFor(() => controller.view()[0]?.policy.status === 'ineligible')
    assert.deepEqual(requests, [], 'no ineligible request is sent')
    assert.equal(controller.view()[0]?.policy.reason, 'confirmed-pro-max')
  } finally {
    await controller.dispose()
  }
})

test('an unstated subscription fetches once before the first request is judged', async () => {
  const account = uniqueAccount('policy-null')
  const { controller, requests } = await policyHarness(
    account,
    claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }),
    async () => envelopeResponse({}),
  )
  try {
    const decision = await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(decision.ok, true, `decision: ${JSON.stringify(decision)}`)
    assert.deepEqual(requests, [account], 'the bounded initialization ran before the request was allowed')
    assert.equal(controller.view()[0]?.policy.status, 'current')
    assert.equal(controller.view()[0]?.policy.checksum, 'sum-1')
  } finally {
    await controller.dispose()
  }
})

test('a restriction outside the request capabilities blocks the tool that reaches it', async () => {
  const account = uniqueAccount('policy-scope')
  const { controller } = await policyHarness(
    account,
    claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }),
    async () => envelopeResponse({ sandbox: { enabled: true } }),
  )
  try {
    const decision = await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(decision.ok, true, 'a sandbox restriction does not reach a model request')
    assert.equal(controller.view()[0]?.policy.status, 'blocked')
    assert.equal(controller.assertAllowed({ capabilities: claudeScopesFor('model'), account }).decision, 'allow')
    const shell = controller.assertAllowed({ capabilities: claudeScopesFor('shell'), tool: 'bash', account })
    assert.equal(shell.decision, 'deny', 'the shell-capable tool reaches the execution scope')
    if (shell.decision !== 'deny') return
    assert.equal(shell.code, 'POLICY_UNSUPPORTED')
    assert.equal(shell.blocker.scope, 'execution')
  } finally {
    await controller.dispose()
  }
})

test('the first request is refused when the policy reaches it', async () => {
  const account = uniqueAccount('policy-deny')
  const { controller } = await policyHarness(
    account,
    claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }),
    async () => envelopeResponse({ futureSecurityFlag: true }),
  )
  try {
    const decision = await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(decision.ok, false, 'an unenforceable remote restriction stops the request, not the next one')
    if (decision.ok) return
    assert.equal(decision.error.code, 'POLICY_UNSUPPORTED')
    assert.equal(decision.error.failure.retryDisposition, 'forbid', 'the refusal forbids every automatic resend')
    assert.equal(controller.assertAllowed({ capabilities: claudeScopesFor('model'), account }).decision, 'deny')
  } finally {
    await controller.dispose()
  }
})

test('a network failure keeps the accepted restrictions and reports the snapshot stale', async () => {
  const account = uniqueAccount('policy-stale')
  let call = 0
  const { controller, scheduler } = await policyHarness(
    account,
    claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }),
    async () => {
      call += 1
      if (call === 1) return envelopeResponse({ permissions: { deny: ['Bash'] } }, 'sum-1')
      throw new Error('offline')
    },
    { policyConsumers: [claudePermissionConsumer({ toolAliases: { Bash: 'bash' } })] },
  )
  try {
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(controller.view()[0]?.policy.status, 'current', 'the mapped deny rule is enforced exactly')
    const acceptedAt = controller.view()[0]?.policy.fetchedAt
    await scheduler.advance(HOUR)
    assert.equal(
      await waitFor(() => controller.view()[0]?.policy.status === 'stale'),
      true,
      'the failed poll keeps the accepted snapshot as stale',
    )
    assert.equal(controller.view()[0]?.policy.fetchedAt, acceptedAt, 'the accepted snapshot is kept')
    assert.equal(controller.assertAllowed({ capabilities: claudeScopesFor('model'), account }).decision, 'allow')
    assert.equal(
      controller.assertAllowed({ capabilities: claudeScopesFor('shell'), tool: 'bash', account }).decision,
      'deny',
      'the accepted deny rule still applies after a failed refresh',
    )
  } finally {
    await controller.dispose()
  }
})

test('an explicit refusal outranks the cached restrictions', async () => {
  const account = uniqueAccount('policy-refused')
  let call = 0
  const { controller, scheduler } = await policyHarness(
    account,
    claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }),
    async () => {
      call += 1
      if (call === 1) return envelopeResponse({}, 'sum-1')
      return new Response('{}', { status: 403 })
    },
  )
  try {
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(controller.view()[0]?.policy.status, 'current')
    await scheduler.advance(HOUR)
    await waitFor(() => controller.view()[0]?.policy.status === 'blocked')
    assert.equal(controller.view()[0]?.policy.reason, 'http_403')
    assert.equal(controller.assertAllowed({ capabilities: claudeScopesFor('model'), account }).decision, 'deny')
  } finally {
    await controller.dispose()
  }
})

test('an accepted policy snapshot survives a restart and needs re-verification before it enforces again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-maintenance-policy-'))
  const statePath = join(dir, 'claude-maintenance.json')
  const account = uniqueAccount('policy-restart')
  const session = claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR })
  await seedClaudeSession(session)
  let requests = 0
  const fetchSettings: ClaudePolicyFetchFn = async () => {
    requests += 1
    return envelopeResponse({ permissions: { deny: ['Bash'] } }, 'sum-1')
  }
  const build = (extra: Partial<ClaudeMaintenanceOptions>): ClaudeMaintenanceController => {
    const clock = new ManualClock()
    return new ClaudeMaintenanceController({
      tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
      config: { refreshLeadMs: 300_000 },
      clock,
      scheduler: new ManualScheduler(clock),
      fetchSettings,
      persistence: new FileClaudeMaintenancePersistence({ path: statePath }),
      ...extra,
    })
  }
  try {
    const first = build({ policyConsumers: [claudePermissionConsumer({ toolAliases: { Bash: 'bash' } })] })
    await first.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(requests, 1)
    assert.equal(first.view()[0]?.policy.status, 'current')
    await first.dispose()

    // The restriction's value is not stored, so the restored snapshot is enforced only
    // after a fresh read confirms it again; until then the account is blocked.
    const second = build({ policyConsumers: [claudePermissionConsumer({ toolAliases: { Bash: 'bash' } })] })
    await second.hydrate()
    assert.equal(second.view()[0]?.policy.checksum, 'sum-1', 'the accepted checksum is restored')
    assert.equal(second.view()[0]?.policy.status, 'blocked', 'an enforced policy needs re-verification')
    assert.equal(
      second.assertAllowed({ capabilities: claudeScopesFor('shell'), tool: 'bash', account }).decision,
      'deny',
      'nothing is allowed on the strength of an unrestored restriction',
    )
    await second.dispose()

    const third = build({ policyConsumers: [claudePermissionConsumer({ toolAliases: { Bash: 'bash' } })] })
    await third.hydrate()
    await third.ensureReady({ account, sessionId: 'session-2' })
    assert.equal(
      await waitFor(() => third.view()[0]?.policy.status === 'current'),
      true,
      'a fresh read re-establishes the restriction',
    )
    assert.equal(requests > 1, true, 'the re-verification is a real read')
    await third.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt policy state refuses the first request instead of reading as no policy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-maintenance-corrupt-'))
  const statePath = join(dir, 'claude-maintenance.json')
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    accounts: [{
      account: 'corrupt@example.invalid',
      origin: IDENTITY.origin,
      protocolFingerprint: IDENTITY.protocolFingerprint,
      policy: { checksum: 'sum-1', revision: 'u-1', acceptedAt: 1, keys: 'not-an-array', blockers: [] },
    }],
  }), { mode: 0o600 })
  const account = uniqueAccount('policy-corrupt')
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }))
  const clock = new ManualClock()
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler: new ManualScheduler(clock),
    fetchSettings: async () => envelopeResponse({}),
    persistence: new FileClaudeMaintenancePersistence({ path: statePath }),
  })
  try {
    await controller.hydrate()
    const decision = await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(decision.ok, false, 'an unreadable stored policy is not an absent policy')
    if (decision.ok) return
    assert.equal(decision.error.code, 'POLICY_STATE_UNAVAILABLE')
    assert.equal(decision.error.failure.retryDisposition, 'forbid')
  } finally {
    await controller.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the empty success sentinel round-trips through a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-maintenance-empty-'))
  const statePath = join(dir, 'claude-maintenance.json')
  const account = uniqueAccount('policy-empty')
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }))
  const build = (): ClaudeMaintenanceController => {
    const clock = new ManualClock()
    return new ClaudeMaintenanceController({
      tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
      config: { refreshLeadMs: 300_000 },
      clock,
      scheduler: new ManualScheduler(clock),
      fetchSettings: async () => new Response(null, { status: 204 }),
      persistence: new FileClaudeMaintenancePersistence({ path: statePath }),
    })
  }
  try {
    const first = build()
    await first.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(first.view()[0]?.policy.status, 'current', 'the empty sentinel is an accepted policy')
    assert.equal(await waitFor(() => first.view()[0]?.policy.fetchedAt !== undefined), true)
    await first.dispose()

    const second = build()
    await second.hydrate()
    const [view] = second.view()
    assert.equal(view?.policy.status, 'current', 'an empty policy restores as empty, not as unavailable')
    assert.deepEqual(view?.policy.blockers, [])
    await second.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the durable state never keeps the remote document or a value from it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-maintenance-secret-'))
  const statePath = join(dir, 'claude-maintenance.json')
  const account = uniqueAccount('policy-secret')
  const secret = 'super-secret-value'
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }))
  const clock = new ManualClock()
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler: new ManualScheduler(clock),
    fetchSettings: async () => envelopeResponse({ env: { API_KEY: secret }, permissions: { deny: ['Bash'] } }),
    policyConsumers: [claudePermissionConsumer({ toolAliases: { Bash: 'bash' } })],
    persistence: new FileClaudeMaintenancePersistence({ path: statePath }),
  })
  try {
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(
      await waitFor(() => controller.view()[0]?.policy.status === 'blocked'),
      true,
      'the unsupported key and the enforced rule settle the account',
    )
  } finally {
    await controller.dispose()
  }
  const stored = readFileSync(statePath, 'utf8')
  assert.equal(stored.includes(secret), false, 'no remote value reaches the durable state')
  assert.equal(stored.includes('"settings"'), false, 'the remote document itself is not stored')
  assert.equal(stored.includes('API_KEY'), false, 'a nested remote value name is not stored either')
  assert.equal(stored.includes('sum-1'), true, 'the server checksum is kept, because revalidation needs it')
  rmSync(dir, { recursive: true, force: true })
})

test('a request without a session id leaves no lasting owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-maintenance-transient-'))
  const statePath = join(dir, 'claude-maintenance.json')
  const account = uniqueAccount('policy-transient')
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }))
  let requests = 0
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
    fetchSettings: async () => {
      requests += 1
      return envelopeResponse({})
    },
    persistence: new FileClaudeMaintenancePersistence({ path: statePath }),
  })
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const decision = await controller.ensureReady({ account })
      assert.equal(decision.ok, true, 'a direct request is still judged against its policy')
    }
    assert.equal(requests, 3, 'each direct request performs its own bounded check')
    assert.deepEqual(controller.view(), [], 'no account state outlives a request that bound nothing')
    assert.equal(scheduler.pending, 0, 'and no timer is left behind')
    await controller.dispose()
    assert.deepEqual(controller.view(), [])
    // The determination is not lost: a later restart reads it back.
    const restored = new ClaudeMaintenanceController({
      tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
      config: { refreshLeadMs: 300_000 },
      clock,
      scheduler,
      persistence: new FileClaudeMaintenancePersistence({ path: statePath }),
    })
    await restored.hydrate()
    assert.equal(restored.view()[0]?.policy.status, 'current', 'the known policy survived the owner release')
    await restored.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a confirmed organization becomes the identity and is not inherited from an unconfirmed one', async () => {
  const account = uniqueAccount('policy-org')
  const organizations = ['org-a', 'org-b']
  let profileReads = 0
  let policyRequests = 0
  let organization: string | undefined = organizations[0]
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  await seedClaudeSession(claudeSession(account, {
    expiresAt: Date.now() + 7 * 24 * HOUR,
    accountUuid: 'uuid-1',
  }))
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
    readProfile: async () => {
      profileReads += 1
      return { outcome: 'ok', complete: true, fields: { accountUuid: 'uuid-1', organization: organization! } }
    },
    fetchSettings: async () => {
      policyRequests += 1
      return envelopeResponse({ permissions: { deny: ['Bash'] } }, `sum-${policyRequests}`)
    },
    policyConsumers: [claudePermissionConsumer({ toolAliases: { Bash: 'bash' } })],
  })
  try {
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(await waitFor(() => controller.view()[0]?.organization === 'org-a'), true, 'org A is adopted')
    assert.equal(organization, 'org-a')
    const afterA = policyRequests
    // A later response from another organization is an identity change, not an update.
    organization = 'org-b'
    clock.advanceTo(clock.now() + 25 * HOUR)
    await controller.ensureReady({ account, sessionId: 'session-1' })
    assert.equal(await waitFor(() => profileReads >= 2), true)
    assert.equal(
      await waitFor(() => controller.assertAllowed({ capabilities: claudeScopesFor('model'), account }).decision === 'deny'),
      true,
      'the conflicting organization stops the account instead of switching it silently',
    )
    assert.equal(controller.assertAllowed({ capabilities: claudeScopesFor('shell'), tool: 'bash', account }).decision, 'deny')
    assert.ok(policyRequests > afterA, 'the policy is re-determined under the confirmed organization instead of inherited')
  } finally {
    await controller.dispose()
  }
})

test('an untrusted state document is never replaced by an unrelated write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-maintenance-untrusted-'))
  const statePath = join(dir, 'claude-maintenance.json')
  const corrupt = JSON.stringify({
    version: 1,
    accounts: [{
      account: 'corrupt@example.invalid',
      origin: IDENTITY.origin,
      protocolFingerprint: IDENTITY.protocolFingerprint,
      policy: { checksum: 'sum-1', revision: 'u-1', acceptedAt: 1, keys: [], blockers: 'not-an-array' },
    }],
  })
  writeFileSync(statePath, corrupt, { mode: 0o600 })
  const persistence = new FileClaudeMaintenancePersistence({ path: statePath })
  try {
    assert.equal((await persistence.load()).status, 'unavailable')
    // Another account's ordinary profile save must not erase what the unreadable document
    // may still hold, so the write is refused rather than repairing the file by accident.
    await assert.rejects(
      persistence.save([{
        account: 'other@example.invalid',
        origin: IDENTITY.origin,
        protocolFingerprint: IDENTITY.protocolFingerprint,
        profile: { capturedAt: 5, credentialRevision: 1, complete: true },
      }]),
      /unavailable/,
    )
    assert.equal(readFileSync(statePath, 'utf8'), corrupt, 'the document is left exactly as it was')

    const account = uniqueAccount('policy-untrusted')
    await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }))
    const clock = new ManualClock()
    const controller = new ClaudeMaintenanceController({
      tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
      config: { refreshLeadMs: 300_000 },
      clock,
      scheduler: new ManualScheduler(clock),
      fetchSettings: async () => envelopeResponse({}),
      persistence,
    })
    try {
      await controller.hydrate()
      const decision = await controller.ensureReady({ account, sessionId: 'session-1' })
      assert.equal(decision.ok, false, 'the process keeps refusing on the strength of that state')
      if (decision.ok) return
      assert.equal(decision.error.code, 'POLICY_STATE_UNAVAILABLE')
    } finally {
      await controller.dispose()
    }
    assert.equal(readFileSync(statePath, 'utf8'), corrupt, 'no later write replaced it either')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a write that cannot own the state lock does not write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-maintenance-lock-'))
  const statePath = join(dir, 'claude-maintenance.json')
  // A live holder this process cannot wait out: the write must fail, not run unowned.
  mkdirSync(`${statePath}.lock`)
  const persistence = new FileClaudeMaintenancePersistence({
    path: statePath,
    timing: { retries: 1, minTimeoutMs: 1, maxTimeoutMs: 2, staleMs: 600_000 },
  })
  try {
    await assert.rejects(
      persistence.save([{
        account: 'locked@example.invalid',
        origin: IDENTITY.origin,
        protocolFingerprint: IDENTITY.protocolFingerprint,
        profile: { capturedAt: 5, credentialRevision: 1, complete: true },
      }]),
      /lock/,
    )
    assert.equal(existsSync(statePath), false, 'nothing was written without ownership')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a concurrent first request waits for the determination instead of bypassing it', async () => {
  const account = uniqueAccount('policy-concurrent')
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }))
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  const gate = deferred<void>()
  let reads = 0
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
    fetchSettings: async () => {
      reads += 1
      await gate.promise
      return envelopeResponse({ futureSecurityFlag: true }, 'sum-1')
    },
    policyConsumers: [claudePermissionConsumer({ toolAliases: { Bash: 'bash' } })],
  })
  try {
    const first = controller.ensureReady({ account, sessionId: 'session-a' })
    const second = controller.ensureReady({ account, sessionId: 'session-b' })
    let settled = 0
    void first.then(() => { settled += 1 }, () => { settled += 1 })
    void second.then(() => { settled += 1 }, () => { settled += 1 })
    assert.equal(await waitFor(() => reads === 1), true, 'the shared read started')
    assert.equal(settled, 0, 'a second session does not slip past an undecided policy')
    gate.resolve()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.ok, false, 'the first request is judged by the refusal')
    assert.equal(b.ok, false, 'and so is the concurrent one')
    if (a.ok || b.ok) return
    assert.equal(a.error.code, 'POLICY_UNSUPPORTED')
    assert.equal(b.error.code, 'POLICY_UNSUPPORTED')
    assert.equal(reads, 1, 'the determination was not repeated per caller')
  } finally {
    await controller.dispose()
  }
})

test('one caller cancelling does not cancel the determination another caller waits for', async () => {
  const account = uniqueAccount('policy-cancel')
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }))
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  const gate = deferred<void>()
  let reads = 0
  let sawAbort = false
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
    fetchSettings: async ({ signal }) => {
      reads += 1
      signal?.addEventListener('abort', () => { sawAbort = true }, { once: true })
      await gate.promise
      return envelopeResponse({}, 'sum-1')
    },
  })
  try {
    const leaving = new AbortController()
    const first = controller.ensureReady({ account, sessionId: 'session-a', signal: leaving.signal })
    const second = controller.ensureReady({ account, sessionId: 'session-b' })
    let firstOutcome: ClaudeRequestDecision | undefined
    void first.then(value => { firstOutcome = value }, () => { firstOutcome = undefined })
    assert.equal(await waitFor(() => reads === 1), true, 'the shared read started')
    leaving.abort()
    assert.equal(
      await waitFor(() => firstOutcome !== undefined),
      true,
      'the cancelling caller stops waiting while the shared read is still pending',
    )
    assert.equal(sawAbort, false, 'the shared read continues for the other caller')
    gate.resolve()
    const secondOutcome = await second
    assert.equal(secondOutcome.ok, true, 'the surviving caller is judged by the determination that completed')
    assert.equal(firstOutcome?.ok, false, 'the caller that stopped waiting is not judged by a determination it abandoned')
    if (firstOutcome !== undefined && !firstOutcome.ok) {
      assert.equal(firstOutcome.error.code, 'ABORTED', 'and it is cancelled rather than refused')
    }
    assert.equal(reads, 1)
    assert.equal(sawAbort, false, 'and the shared read was never cancelled')
    assert.equal(controller.view()[0]?.policy.checksum, 'sum-1')
  } finally {
    await controller.dispose()
  }
})

test('a determination cancelled by its timeout is not read as a refusal', async () => {
  const account = uniqueAccount('policy-timeout')
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }))
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  let started = false
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
    config: { refreshLeadMs: 300_000, readTimeoutMs: 5_000 },
    clock,
    scheduler,
    fetchSettings: ({ signal }) => new Promise<Response>((_resolve, reject) => {
      started = true
      const abort = (): void => { reject(new Error('aborted')) }
      if (signal?.aborted === true) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    }),
  })
  try {
    const pending = controller.ensureReady({ account, sessionId: 'session-a' })
    assert.equal(await waitFor(() => started), true, 'the bounded read started')
    await scheduler.advance(5_000)
    const decision = await pending
    assert.equal(decision.ok, true, 'a cancelled determination is not a refusal')
    const [view] = controller.view()
    assert.equal(view?.policy.status, 'unavailable')
    assert.notEqual(view?.policy.status, 'blocked', 'nothing was refused')
  } finally {
    await controller.dispose()
  }
})

test('a determination abandoned by a release is not settled as this identity\'s', async () => {
  const account = uniqueAccount('policy-release')
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }))
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  let reads = 0
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
    fetchSettings: ({ signal }) => {
      reads += 1
      const call = reads
      // The first read is abandoned by the release; the second answers normally.
      if (call > 1) return Promise.resolve(envelopeResponse({ futureSecurityFlag: true }, `sum-${String(call)}`))
      return new Promise<Response>((_resolve, reject) => {
        const answer = (): void => { reject(new Error('aborted')) }
        if (signal?.aborted === true) answer()
        else signal?.addEventListener('abort', answer, { once: true })
      })
    },
  })
  try {
    const held = controller.ensureReady({ account, sessionId: 'session-1' })
    void held.catch(() => undefined)
    assert.equal(await waitFor(() => reads === 1), true, 'the first read started')
    await controller.releaseSession('session-1')
    assert.equal(await waitFor(() => controller.view()[0]?.bindings === 0), true, 'the release completed')
    // Re-binding the same identity must issue a fresh read and judge the request by it: a
    // determination the release cancelled is not this identity's.
    const rebound = await controller.ensureReady({ account, sessionId: 'session-2' })
    assert.equal(reads, 2, 'the rebound request started its own determination')
    assert.equal(rebound.ok, false, 'and is judged by that determination')
    if (!rebound.ok) assert.equal(rebound.error.code, 'POLICY_UNSUPPORTED')
    assert.equal(controller.view()[0]?.policy.status, 'blocked')
  } finally {
    await controller.dispose()
  }
})

test('a profile written before the completeness contract restores incomplete while its policy survives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-maintenance-legacy-'))
  const statePath = join(dir, 'claude-maintenance.json')
  const account = uniqueAccount('policy-legacy')
  await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }))
  // A document written by the previous build: the profile carries no completeness evidence,
  // and the policy says a restriction was enforced.
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    accounts: [{
      account,
      origin: IDENTITY.origin,
      protocolFingerprint: 'claude-protocol',
      organization: 'org-1',
      profile: {
        accountUuid: 'uuid-1',
        emailAddress: account,
        subscriptionType: 'max',
        capturedAt: Date.now(),
        complete: true,
        credentialRevision: 3,
      },
      policy: {
        checksum: 'sum-1',
        revision: 'u-1',
        acceptedAt: Date.now(),
        keys: [{ key: 'permissions', scope: 'tool', disposition: 'enforced', detail: 'enforced by a registered consumer' }],
        blockers: [],
        enforced: true,
      },
    }],
  }), { mode: 0o600 })
  const clock = new ManualClock()
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler: new ManualScheduler(clock),
    fetchSettings: async () => envelopeResponse({}, 'sum-2'),
    persistence: new FileClaudeMaintenancePersistence({ path: statePath }),
  })
  try {
    await controller.hydrate()
    const [view] = controller.view()
    assert.equal(view?.profile.complete, false, 'the old profile is incomplete and will be read again')
    assert.deepEqual(view?.profile.missing, ['completeness'])
    assert.equal(view?.policy.checksum, 'sum-1', 'while the accepted policy is not lost')
    assert.equal(view?.policy.status, 'blocked', 'and its restriction protection stands until re-verified')
  } finally {
    await controller.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('policy records are isolated by organization, origin and protocol fingerprint', () => {
  const base = { account: ACCOUNT, origin: IDENTITY.origin, protocolFingerprint: IDENTITY.protocolFingerprint }
  assert.notEqual(
    claudeIdentityKey({ ...base, organization: 'org-1' }),
    claudeIdentityKey({ ...base, organization: 'org-2' }),
    'another organization is another cache key',
  )
  assert.notEqual(
    claudeIdentityKey(base),
    claudeIdentityKey({ ...base, origin: 'https://proxy.invalid' }),
    'another origin is another cache key',
  )
  assert.notEqual(
    claudeIdentityKey(base),
    claudeIdentityKey({ ...base, protocolFingerprint: 'fp-2' }),
    'another protocol configuration is another cache key',
  )
})

test('a version refusal blocks every account under the same protocol configuration', async () => {
  const first = uniqueAccount('version-a')
  const second = uniqueAccount('version-b')
  const blocks = new Set<string>()
  const asked: string[] = []
  let calls = 0
  let refreshes = 0
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  for (const account of [first, second]) {
    await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }))
  }
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({
      refresh: async (current) => {
        refreshes += 1
        return current
      },
      preemptMs: 0,
    }),
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
    fetchSettings: async (request) => {
      calls += 1
      asked.push(request.account)
      if (request.account === first && calls > 1) return new Response('{}', { status: 400 })
      return envelopeResponse({})
    },
    classifyHttpFailure: async () => ({
      reason: 'CLIENT_VERSION_UNSUPPORTED',
      serverCode: 'claude_code_version_too_old',
      stage: 'http',
      scope: 'protocol',
      retryDisposition: 'forbid',
      outputDelivered: false,
      origin: IDENTITY.origin,
      protocolFingerprint: 'claude-protocol',
    }),
    protocolBlocks: {
      isBlocked: request => blocks.has(request.fingerprint),
      block: (record) => { blocks.add(record.fingerprint) },
    },
  })
  try {
    await controller.ensureReady({ account: first, sessionId: 'session-a' })
    await waitFor(() => controller.view().find(view => view.account === first)?.policy.status === 'current')
    await scheduler.advance(HOUR)
    // A refusal nested in a 400 is classified as a refusal, not as an authentication
    // problem: nothing refreshes the credential and no request is replayed.
    assert.equal(refreshes, 0, 'a refusal triggers no credential refresh')
    assert.equal(await waitFor(() => blocks.size > 0), true, 'the refusal is recorded in the shared block store')
    assert.equal(
      await waitFor(() => controller.view().find(view => view.account === first)?.policy.status === 'blocked'),
      true,
    )
    // Another account under the same configuration is refused before it sends anything.
    const decision = await controller.ensureReady({ account: second, sessionId: 'session-b' })
    assert.equal(decision.ok, false)
    if (decision.ok) return
    assert.equal(decision.error.code, 'CLIENT_VERSION_UNSUPPORTED')
    assert.equal(asked.includes(second), false, 'the sibling account sent no request of its own')
    assert.equal(refreshes, 0, 'and no credential was refreshed for it either')
  } finally {
    await controller.dispose()
  }
})

test('a permission refusal stops its own account policy without expanding to the provider', async () => {
  const first = uniqueAccount('permission-a')
  const second = uniqueAccount('permission-b')
  const blocks = new Set<string>()
  let calls = 0
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  for (const account of [first, second]) {
    await seedClaudeSession(claudeSession(account, { expiresAt: Date.now() + 7 * 24 * HOUR }))
  }
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
    fetchSettings: async (request) => {
      if (request.account === first) {
        calls += 1
        if (calls > 1) return new Response('{}', { status: 403 })
      }
      return envelopeResponse({})
    },
    classifyHttpFailure: async () => ({
      reason: 'PERMISSION_DENIED',
      stage: 'http',
      scope: 'account',
      retryDisposition: 'forbid',
      outputDelivered: false,
      origin: IDENTITY.origin,
      protocolFingerprint: 'claude-protocol',
    }),
    protocolBlocks: {
      isBlocked: request => blocks.has(request.fingerprint),
      block: (record) => { blocks.add(record.fingerprint) },
    },
  })
  try {
    await controller.ensureReady({ account: first, sessionId: 'session-a' })
    await waitFor(() => controller.view().find(view => view.account === first)?.policy.status === 'current')
    await scheduler.advance(HOUR)
    assert.equal(
      await waitFor(() => controller.view().find(view => view.account === first)?.policy.status === 'blocked'),
      true,
    )
    assert.equal(blocks.size, 0, 'an account-scoped refusal records no protocol block')
    assert.equal(
      controller.assertAllowed({ capabilities: claudeScopesFor('model'), account: first }).decision,
      'deny',
      'the refused account is stopped',
    )
    const decision = await controller.ensureReady({ account: second, sessionId: 'session-b' })
    assert.equal(decision.ok, true, 'the sibling account keeps working')
  } finally {
    await controller.dispose()
  }
})
