/**
 * The organization pin across a restart: what one process may state about a policy record it
 * did not read itself, and what it must read before it states a pin.
 *
 * The owner under test is the shipped `ClaudeMaintenanceController` over the shipped durable
 * record, the shipped credential store in the private test home, and the shipped
 * `ClaudeOrgPinChecker` over an injected transport. Nothing here composes the plugin, opens a
 * socket or starts a runtime: each case supplies its own settings endpoint, the organization
 * validation is one synthetic transport, and the clock and scheduler are manual.
 *
 * The facts these cases separate, because collapsing them is the defect this file exists for:
 *  - "this process holds the accepted policy's document" is not "a determination was attempted",
 *    and neither is "the stored record enforced no key";
 *  - the one restored record whose own projection is its whole document is the endpoint's
 *    empty-success status, and only an empty checksum, an empty revision, no key, no blocker
 *    and nothing enforced states it;
 *  - every other restored record states no pin, so the shipped checker refuses the account
 *    until the next real request's bounded, unconditional full read supplies a document again.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeOrgPinChecker } from '../src/providers/claude-policy-limits.js'
import { CLAUDE_DEFAULT_ORIGIN, ClaudeMaintenanceController } from '../src/providers/claude-maintenance.js'
import type { AdoptedOrganizationPin } from '../src/providers/claude-maintenance.js'
import type { ClaudePolicyConsumer, ClaudePolicyFetchFn } from '../src/providers/claude-managed-settings.js'
import { FileClaudeMaintenancePersistence } from '../src/providers/claude-maintenance-state.js'
import { CLAUDE_PROTOCOL_PROFILE, claudeProtocolFingerprint } from '../src/providers/claude-protocol.js'
import type { CoreTransport } from '../src/claude-core/index.js'
import { parseOrgPin } from '../src/claude-core/org-pin.js'
import type { ClaudeSession } from '../src/auth/store.js'
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

/** The protocol fingerprint the shipped route describes itself with. */
const FINGERPRINT = claudeProtocolFingerprint(CLAUDE_PROTOCOL_PROFILE)

/** The pinned validation endpoint the production composition states. */
const ORG_PIN_URL = `${CLAUDE_DEFAULT_ORIGIN}/api/oauth/validate`

/**
 * The organization this account belongs to, as its own validation endpoint reports it and as
 * a policy that admits this account pins it.
 */
const ORGANIZATION_UUID = '00000000-0000-4000-8000-0000000000a1'

/** How far a case moves its own clock to leave a recorded read failure behind. */
const PAST_BACKOFF_MS = 5 * 60_000

/** The interval a bound account's policy poller is armed with. */
const POLICY_POLL_MS = 60 * 60_000

/**
 * The narrow fixture consumer for the pinned-organization key.
 *
 * The shipped route registers its own consumer for `forceLoginOrgUUID` (index.ts): the key has
 * no schema entry here, so without a consumer a document that states it is reported as an
 * unhandled remote setting and blocks every operation, and no pin ever reaches the checker.
 * This mirrors that one entry and nothing else — an unusable value is refused exactly as the
 * shipped consumer refuses it — so this file observes the pin path the shipped route has. It
 * is a fixture, not the shipped registration: that consumer's own route is covered elsewhere.
 * @returns the consumer for the pinned organization key.
 */
function fixtureOrganizationPinConsumer(): ClaudePolicyConsumer {
  return {
    key: 'forceLoginOrgUUID',
    scope: 'unknown',
    parse(value: unknown) {
      const pin = parseOrgPin(value)
      if (pin.kind === 'invalid') {
        return {
          restrictions: [],
          unsupported: [{
            key: 'forceLoginOrgUUID',
            scope: 'unknown',
            code: 'POLICY_INVALID_VALUE',
            detail: 'the pinned organization value is not usable',
          }],
        }
      }
      return { restrictions: [], unsupported: [] }
    },
    decide: () => ({ decision: 'allow', reason: 'the organization check enforces this pin before the wire' }),
  }
}

/** The only key this file's documents state, so this is the only consumer its owners register. */
const POLICY_CONSUMERS: readonly ClaudePolicyConsumer[] = [fixtureOrganizationPinConsumer()]

/** The pin judgment one case's own projection receives from the shipped checker. */
interface CheckResult {
  readonly kind: string
  readonly code?: string
}

/** One case's owner: the shipped controller over a private record file and the case's endpoint. */
interface Owner {
  readonly account: string
  /** The private durable record this case's state lives in. */
  readonly path: string
  readonly controller: ClaudeMaintenanceController
  readonly clock: ManualClock
  readonly scheduler: ManualScheduler
  /** Every settings read this owner sent, in order. */
  readonly reads: { readonly ifNoneMatch: string | undefined }[]
  /**
   * Run the shipped checker over the pin this owner's projection states.
   * @param organizationUuid - the organization the synthetic endpoint reports as this
   *   account's own; defaulting to the one a policy admits this account with.
   * @returns the checker's outcome, with the denial code when it refused.
   */
  check(organizationUuid?: string): Promise<CheckResult>
}

/**
 * Build one case's owner over its own private record file and register its teardown.
 *
 * Each case supplies only the settings endpoint it answers with; when it holds an answer it
 * also supplies the release for that hold, and it pushes the work it started. Teardown runs in
 * the one order every case needs: release the held answer, wait for the work the case started,
 * dispose the owner, remove the private directory.
 * @param t - the case that owns everything built here.
 * @param options - the case's endpoint, optional stored-session fields, and its own hold.
 * @returns the owner, with the facts the case asserts on.
 */
async function owner(t: TestContext, options: {
  label: string
  /** The case's settings endpoint; absent is a deployment that injects no settings fetch. */
  fetchSettings?: ClaudePolicyFetchFn
  session?: Partial<ClaudeSession>
  /** Release an answer this case is holding, called before the owner is disposed. */
  release?: () => void
  /** Work this case started, awaited before the owner is disposed. */
  owned?: readonly Promise<unknown>[]
}): Promise<Owner> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-org-pin-'))
  const path = join(directory, 'claude-maintenance.json')
  const account = uniqueAccount(options.label)
  await seedClaudeSession(claudeSession(account, { accountUuid: 'uuid-1', ...options.session }))
  const clock = new ManualClock()
  const scheduler = new ManualScheduler(clock)
  const reads: { ifNoneMatch: string | undefined }[] = []
  const answerSettings = options.fetchSettings
  const controller = new ClaudeMaintenanceController({
    tokens: claudeTokens({ refresh: async current => current, preemptMs: 0 }),
    config: { refreshLeadMs: 300_000 },
    clock,
    scheduler,
    protocolFingerprint: () => FINGERPRINT,
    policyConsumers: POLICY_CONSUMERS,
    // The endpoint is the case's; this only records what the owner asked it for.
    ...answerSettings === undefined ? {} : {
      fetchSettings: async request => {
        reads.push({ ifNoneMatch: request.ifNoneMatch })
        return await answerSettings(request)
      },
    },
    persistence: new FileClaudeMaintenancePersistence({ path }),
    protocolBlocks: { isBlocked: () => false },
  })
  t.after(async () => {
    options.release?.()
    await Promise.allSettled(options.owned ?? [])
    await controller.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    account,
    path,
    controller,
    clock,
    scheduler,
    reads,
    async check(organizationUuid = ORGANIZATION_UUID): Promise<CheckResult> {
      const projected: AdoptedOrganizationPin | undefined = controller.adoptedOrganizationPin(account)
      // A real `Response` is a `CoreHttpResponse`: the shipped adapter hands the core exactly
      // this value, with its own `headers.get` and its readable body stream.
      const transport: CoreTransport = async () => Response.json({ organization_uuid: organizationUuid })
      const outcome = await new ClaudeOrgPinChecker({
        url: ORG_PIN_URL,
        userAgent: 'synthetic-maintenance-spec',
        transport,
      }).check({
        account,
        projected,
        identity: {
          accountUuid: 'uuid-1',
          organization: ORGANIZATION_UUID,
          origin: CLAUDE_DEFAULT_ORIGIN,
          profileFingerprint: FINGERPRINT,
        },
        accessToken: async () => 'synthetic-access',
      })
      return outcome.kind === 'denied' ? { kind: outcome.kind, code: outcome.code } : { kind: outcome.kind }
    },
  }
}

/** The accepted-policy projection a previous run stored for one account. */
interface StoredPolicy {
  readonly checksum: string
  readonly revision: string
  readonly keys?: readonly { key: string; scope: string; disposition: string; detail: string }[]
  readonly blockers?: readonly { key: string; scope: string; code: string; detail: string }[]
  readonly enforced?: boolean
}

/**
 * Store the record a previous run left behind, then hydrate it.
 *
 * The record is this plugin's own projection — the accepted checksum and revision, the key
 * dispositions and no settings body — which is exactly what its own writer stores.
 * @param o - the case's owner.
 * @param policy - the stored policy projection.
 */
async function restore(o: Owner, policy: StoredPolicy): Promise<void> {
  await writeFile(o.path, JSON.stringify({
    version: 1,
    accounts: [{
      account: o.account,
      origin: CLAUDE_DEFAULT_ORIGIN,
      protocolFingerprint: FINGERPRINT,
      organization: ORGANIZATION_UUID,
      policy: {
        checksum: policy.checksum,
        revision: policy.revision,
        acceptedAt: 1,
        keys: policy.keys ?? [],
        blockers: policy.blockers ?? [],
        enforced: policy.enforced ?? false,
      },
    }],
  }), { mode: 0o600 })
  await o.controller.hydrate()
}

/** One synthetic settings envelope, the shape the pinned endpoint answers with. */
function envelope(settings: Record<string, unknown>, checksum: string): Response {
  return Response.json({ uuid: 'settings-1', checksum, settings })
}

/** One stored key, so a record can look projected while carrying no document. */
const STORED_KEY = { key: 'permissions', scope: 'tool', disposition: 'enforced', detail: 'tool permission rules' }

/** One stored blocker, so a record can carry a decision that needed the document it lost. */
const STORED_BLOCKER = {
  key: '(envelope)',
  scope: 'unknown',
  code: 'POLICY_UNSUPPORTED',
  detail: 'the settings response could not be validated',
}

/**
 * The records that look like the empty-success sentinel while carrying something else.
 *
 * Each has the empty checksum and revision of that sentinel, and each states one more fact the
 * sentinel never states: a projected key, an enforced restriction, or a blocker. None of them
 * is the whole empty document, so none may be restored as one.
 */
const NEAR_MISS: readonly { readonly row: string; readonly policy: StoredPolicy }[] = [
  { row: 'a stored key under an empty digest', policy: { checksum: '', revision: '', keys: [STORED_KEY] } },
  { row: 'a non-empty checksum', policy: { checksum: 'checksum-restored', revision: '' } },
  { row: 'a non-empty revision', policy: { checksum: '', revision: 'revision-restored' } },
  { row: 'an enforced restriction under an empty digest', policy: { checksum: '', revision: '', enforced: true } },
  { row: 'a stored blocker under an empty digest', policy: { checksum: '', revision: '', blockers: [STORED_BLOCKER] } },
]

test('the exact empty-success record restores its whole empty body and sends no read', async (t) => {
  const o = await owner(t, {
    label: 'org-pin-empty',
    // A far expiry keeps the credential timer out of the poll interval this case fires.
    session: { expiresAt: TEST_NOW + 30 * 24 * 3_600_000 },
    fetchSettings: async () => envelope({}, 'checksum-polled'),
  })
  await restore(o, { checksum: '', revision: '' })

  assert.deepEqual(o.controller.adoptedOrganizationPin(o.account), {
    kind: 'stated',
    pin: { kind: 'none' },
    revision: '',
  }, 'the record itself states the whole body: no pin is in force')
  assert.deepEqual(await o.check(), { kind: 'no-pin' }, 'an empty body sends no validation')
  assert.equal(o.reads.length, 0, 'hydration itself sends nothing')

  const decision = await o.controller.ensureReady({ account: o.account, sessionId: 'session-1' })
  assert.equal(decision.ok, true, 'a policy that restricts nothing admits the request')
  assert.equal(o.reads.length, 0, 'the restored empty body is the document this process holds')

  // The ordinary cadence is unchanged: the bound account still polls, and that poll reads.
  assert.equal(o.scheduler.pending > 0, true, 'the bound account armed its timers')
  await o.scheduler.advance(POLICY_POLL_MS)
  assert.equal(await waitFor(() => o.reads.length === 1), true, 'the poll reads on its own schedule')
})

test('a record that only looks empty is read in full before its pin is claimed', async (t) => {
  for (const { row, policy } of NEAR_MISS) {
    const o = await owner(t, {
      label: 'org-pin-near-miss',
      fetchSettings: async () => envelope({ forceLoginOrgUUID: ORGANIZATION_UUID }, 'checksum-fresh'),
    })
    await restore(o, policy)
    assert.equal(o.controller.adoptedOrganizationPin(o.account)?.kind, 'unknown', row)
    assert.deepEqual(await o.check(), { kind: 'denied', code: 'pin_unverified' }, row)
    assert.equal(o.reads.length, 0, `${row}: the restored record is not a document`)

    const decision = await o.controller.ensureReady({ account: o.account, sessionId: 'session-1' })
    assert.equal(decision.ok, true, row)
    assert.equal(o.reads.length, 1, `${row}: the first request reads in full`)
    assert.equal(o.reads[0]?.ifNoneMatch, undefined, `${row}: no stored body contributes a validator`)
    assert.equal(o.controller.adoptedOrganizationPin(o.account)?.kind, 'stated', row)
  }
})

test('a restored summary is read in full once, without a validator, and its fresh pin validates', async (t) => {
  const o = await owner(t, {
    label: 'org-pin-restored',
    fetchSettings: async () => envelope({ forceLoginOrgUUID: ORGANIZATION_UUID }, 'checksum-restored'),
  })
  await restore(o, { checksum: 'checksum-restored', revision: 'revision-restored' })

  assert.equal(o.controller.adoptedOrganizationPin(o.account)?.kind, 'unknown', 'a restored summary states no pin')
  assert.deepEqual(await o.check(), { kind: 'denied', code: 'pin_unverified' })
  assert.equal(o.reads.length, 0, 'hydration itself sends nothing')

  const decision = await o.controller.ensureReady({ account: o.account, sessionId: 'session-1' })
  assert.equal(decision.ok, true, 'the request is admitted')
  assert.equal(o.reads.length, 1, 'the first bound request performs exactly one read')
  assert.equal(o.reads[0]?.ifNoneMatch, undefined, 'a restored record contributes no validator, so the read is unconditional')
  assert.equal(o.controller.adoptedOrganizationPin(o.account)?.kind, 'stated')
  assert.deepEqual(await o.check(), { kind: 'allowed' }, 'the fresh pin is validated against its own organization')
})

test('a fresh pin this account is not inside is refused rather than bypassed', async (t) => {
  const o = await owner(t, {
    label: 'org-pin-mismatch',
    fetchSettings: async () => envelope({ forceLoginOrgUUID: ORGANIZATION_UUID }, 'checksum-mismatch'),
  })
  await restore(o, { checksum: 'checksum-mismatch', revision: 'revision-mismatch' })

  const decision = await o.controller.ensureReady({ account: o.account, sessionId: 'session-1' })
  assert.equal(decision.ok, true, 'the maintenance seam admits; the pin judgment is the checker\'s')
  assert.equal(o.controller.adoptedOrganizationPin(o.account)?.kind, 'stated')
  assert.deepEqual(await o.check('org-9'), { kind: 'denied', code: 'org_pin_mismatch' },
    'a stated pin this account is not inside is an explicit refusal')
  assert.deepEqual(await o.check(), { kind: 'allowed' }, 'the same pin inside its own organization is allowed')
})

test('a failed read leaves the pin unknown behind its backoff, and the next request retries it', async (t) => {
  let failing = true
  const o = await owner(t, {
    label: 'org-pin-failure',
    fetchSettings: async () => {
      if (failing) throw new Error('synthetic transport failure')
      return envelope({}, 'checksum-recovered')
    },
  })
  await restore(o, { checksum: 'checksum-transient', revision: 'revision-transient' })

  const decision = await o.controller.ensureReady({ account: o.account, sessionId: 'session-1' })
  assert.equal(decision.ok, true, 'the maintenance seam is not the pin gate: this request is admitted')
  assert.equal(o.reads.length, 1, 'the failed read is still one bounded attempt')
  assert.equal(o.controller.adoptedOrganizationPin(o.account)?.kind, 'unknown', 'a failed read states no pin')
  assert.deepEqual(await o.check(), { kind: 'denied', code: 'pin_unverified' },
    'the independent checker is what refuses the unverified pin')

  const early = await o.controller.ensureReady({ account: o.account, sessionId: 'session-2' })
  assert.equal(early.ok, true)
  assert.equal(o.reads.length, 1, 'a request inside the backoff sends nothing')

  failing = false
  o.clock.advanceTo(o.clock.now() + PAST_BACKOFF_MS)
  const recovered = await o.controller.ensureReady({ account: o.account, sessionId: 'session-3' })
  assert.equal(recovered.ok, true, 'the recovered read admits the request')
  assert.equal(o.reads.length, 2, 'the retry is the next request\'s own bounded read')
  assert.equal(o.controller.adoptedOrganizationPin(o.account)?.kind, 'stated')
  assert.deepEqual(await o.check(), { kind: 'no-pin' }, 'a fresh document that states no pin is not a pin')
})

test('an unrequested 304 denies its scope, and a fresh accepted document replaces the blocker', async (t) => {
  let answer = (): Response => new Response(null, { status: 304 })
  const o = await owner(t, { label: 'org-pin-304', fetchSettings: async () => answer() })
  await restore(o, { checksum: 'checksum-304', revision: 'revision-304' })

  const decision = await o.controller.ensureReady({ account: o.account, sessionId: 'session-1' })
  assert.equal(decision.ok, false, 'a response that could not be validated denies the scope it covers')
  if (decision.ok) return
  assert.equal(decision.error.code, 'POLICY_UNSUPPORTED')
  assert.equal(o.reads[0]?.ifNoneMatch, undefined, 'a restored record sent no validator to revalidate')
  assert.equal(o.controller.adoptedOrganizationPin(o.account)?.kind, 'unknown')

  const early = await o.controller.ensureReady({ account: o.account, sessionId: 'session-2' })
  assert.equal(early.ok, false, 'the backoff window keeps the blocker and sends nothing')
  assert.equal(o.reads.length, 1)

  answer = () => envelope({ forceLoginOrgUUID: ORGANIZATION_UUID }, 'checksum-304-ok')
  o.clock.advanceTo(o.clock.now() + PAST_BACKOFF_MS)
  const recovered = await o.controller.ensureReady({ account: o.account, sessionId: 'session-3' })
  assert.equal(recovered.ok, true, 'a fresh accepted document replaces the blocker')
  assert.equal(o.reads.length, 2, 'the recovery is one more bounded read')
  assert.deepEqual(await o.check(), { kind: 'allowed' })
})

test('an ineligible account keeps a restored restriction unknown and sends no read', async (t) => {
  const o = await owner(t, {
    label: 'org-pin-ineligible',
    session: { subscriptionType: 'max' },
    fetchSettings: async () => { throw new Error('an ineligible account sends no settings read') },
  })
  await restore(o, {
    checksum: 'checksum-ineligible',
    revision: 'revision-ineligible',
    keys: [STORED_KEY],
    enforced: true,
  })

  const decision = await o.controller.ensureReady({ account: o.account, sessionId: 'session-1' })
  assert.equal(decision.ok, false, 'an unrestored restriction denies until a read can re-establish it')
  if (decision.ok) return
  assert.equal(decision.error.code, 'POLICY_UNSUPPORTED')
  assert.equal(o.reads.length, 0, 'the entitlement admits no settings read')
  // The refusal does not erase what the account already carried: the restored record and the
  // restriction that still needs a fresh read stay exactly as the restore left them.
  const [view] = o.controller.view()
  assert.equal(view?.policy.checksum, 'checksum-ineligible', 'the restored projection is kept, not erased')
  assert.equal(view?.policy.blockers.some(blocker => blocker.key === '(restore)'), true,
    'the restriction that still needs a fresh read stays recorded')
  assert.equal(o.controller.adoptedOrganizationPin(o.account)?.kind, 'unknown',
    'a record whose restrictions were enforced stays unknown rather than being erased')
  assert.deepEqual(await o.check(), { kind: 'denied', code: 'pin_unverified' })
})

test('an ineligible account with no record states no pin and adds no read', async (t) => {
  const o = await owner(t, {
    label: 'org-pin-none',
    session: { subscriptionType: 'max' },
    fetchSettings: async () => { throw new Error('an ineligible account sends no settings read') },
  })
  await o.controller.hydrate()

  const decision = await o.controller.ensureReady({ account: o.account, sessionId: 'session-1' })
  assert.equal(decision.ok, true)
  assert.equal(o.controller.adoptedOrganizationPin(o.account), undefined, 'an account with no accepted policy states no pin')
  assert.deepEqual(await o.check(), { kind: 'no-pin' })
  assert.equal(o.reads.length, 0, 'the entitlement admits no settings read')

  const again = await o.controller.ensureReady({ account: o.account, sessionId: 'session-2' })
  assert.equal(again.ok, true)
  assert.equal(o.reads.length, 0, 'a second request adds no read either')
})

test('a deployment with no settings fetch records the miss once and reads nothing', async (t) => {
  // No settings fetch is injected at all: the determination has nothing to call, and it must
  // keep its original report instead of reading or looping.
  const o = await owner(t, { label: 'org-pin-nofetch' })
  await o.controller.hydrate()

  const decision = await o.controller.ensureReady({ account: o.account, sessionId: 'session-1' })
  assert.equal(decision.ok, true, 'no cached restriction reaches this request')
  assert.equal(o.reads.length, 0, 'there is no settings fetch to call')
  assert.equal(o.controller.view()[0]?.policy.status, 'unavailable')
  assert.equal(o.controller.view()[0]?.policy.reason, 'settings-fetch-unavailable')
  assert.equal(o.controller.adoptedOrganizationPin(o.account), undefined, 'no document states any pin')
  assert.deepEqual(await o.check(), { kind: 'no-pin' })

  const again = await o.controller.ensureReady({ account: o.account, sessionId: 'session-2' })
  assert.equal(again.ok, true)
  assert.equal(o.reads.length, 0, 'the recorded miss is not asked again')
})

test('concurrent first requests share the one read this identity starts', async (t) => {
  const held = deferred<void>()
  const entered = deferred<void>()
  const owned: Promise<unknown>[] = []
  const o = await owner(t, {
    label: 'org-pin-shared',
    release: () => held.resolve(),
    owned,
    fetchSettings: async () => {
      entered.resolve()
      await held.promise
      return envelope({ forceLoginOrgUUID: ORGANIZATION_UUID }, 'checksum-shared')
    },
  })
  await restore(o, { checksum: 'checksum-shared', revision: 'revision-shared' })

  const first = o.controller.ensureReady({ account: o.account, sessionId: 'session-1' })
  const second = o.controller.ensureReady({ account: o.account, sessionId: 'session-2' })
  owned.push(first, second)
  await entered.promise
  assert.equal(o.reads.length, 1, 'the second caller waits for the read the first one started')
  let settled = false
  void Promise.allSettled([first, second]).then(() => { settled = true })
  await settle()
  assert.equal(settled, false, 'no caller settles while the shared read is still held')

  held.resolve()
  const [left, right] = await Promise.all([first, second])
  assert.equal(left.ok, true)
  assert.equal(right.ok, true)
  assert.equal(o.reads.length, 1, 'both callers were judged by the one read')
  assert.deepEqual(await o.check(), { kind: 'allowed' })
})

test('a request never revalidates by itself: the poller revalidates and its 304 keeps the body', async (t) => {
  const held = deferred<void>()
  const entered = deferred<void>()
  let polled = false
  const o = await owner(t, {
    label: 'org-pin-poll',
    session: { expiresAt: TEST_NOW + 30 * 24 * 3_600_000 },
    release: () => held.resolve(),
    fetchSettings: async () => {
      if (!polled) {
        polled = true
        return envelope({ forceLoginOrgUUID: ORGANIZATION_UUID }, 'checksum-owned')
      }
      entered.resolve()
      await held.promise
      return new Response(null, { status: 304 })
    },
  })
  await restore(o, { checksum: 'checksum-owned', revision: 'revision-owned' })

  const accepted = await o.controller.ensureReady({ account: o.account, sessionId: 'session-1' })
  assert.equal(accepted.ok, true, 'the controller admits the request')
  assert.equal(o.reads.length, 1)
  assert.equal(o.reads[0]?.ifNoneMatch, undefined, 'the first read had no body to revalidate')
  assert.deepEqual(await o.check(), { kind: 'allowed' }, 'and the independent checker admits its pin')
  const fetchedAt = o.controller.view()[0]?.policy.fetchedAt

  // The poller's own check: the manual scheduler fires the timer this bound account armed.
  const polling = o.scheduler.advance(POLICY_POLL_MS)
  await entered.promise
  assert.equal(o.reads.length, 2)
  assert.equal(o.reads[1]?.ifNoneMatch, '"checksum-owned"', 'the poller revalidates the body this process holds')

  // A request that arrives while the poll runs waits for that read: it never revalidates on its
  // own, and it is judged by the answer the read lands rather than by the body it may replace.
  let settled = false
  const second = o.controller.ensureReady({ account: o.account, sessionId: 'session-2' })
  void second.then(() => { settled = true }, () => { settled = true })
  await settle()
  assert.equal(settled, false, 'the request waits for the poll instead of judging itself')
  assert.equal(o.reads.length, 2, 'the waiting request sent no read of its own')

  held.resolve()
  await polling
  const admitted = await second
  assert.equal(admitted.ok, true, 'the poll\'s 304 leaves the accepted document in force')
  assert.equal(await waitFor(() => o.controller.view()[0]?.policy.fetchedAt !== fetchedAt), true,
    'the 304 was folded into the accepted snapshot')
  assert.equal(o.controller.adoptedOrganizationPin(o.account)?.kind, 'stated', 'a 304 keeps the body and its pin')
  assert.deepEqual(await o.check(), { kind: 'allowed' })
  assert.equal(o.reads.length, 2, 'that one revalidation is the only read either request observed')
})

test('a request that waits for the poll is refused by the poll\'s own refusal', async (t) => {
  const held = deferred<void>()
  const entered = deferred<void>()
  let polled = false
  const o = await owner(t, {
    label: 'org-pin-poll-refused',
    session: { expiresAt: TEST_NOW + 30 * 24 * 3_600_000 },
    release: () => held.resolve(),
    fetchSettings: async () => {
      if (!polled) {
        polled = true
        return envelope({ forceLoginOrgUUID: ORGANIZATION_UUID }, 'checksum-owned')
      }
      entered.resolve()
      await held.promise
      return new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } })
    },
  })
  await restore(o, { checksum: 'checksum-owned', revision: 'revision-owned' })

  const accepted = await o.controller.ensureReady({ account: o.account, sessionId: 'session-1' })
  assert.equal(accepted.ok, true, 'the controller admits the request')
  assert.deepEqual(await o.check(), { kind: 'allowed' }, 'and the independent checker admits its pin')

  const polling = o.scheduler.advance(POLICY_POLL_MS)
  await entered.promise
  assert.equal(o.reads.length, 2)

  // The refusal the poll has not produced yet must not be bypassed by the document already
  // accepted: this request is judged by the read it joined, and that read denies the account.
  let settled = false
  const waiting = o.controller.ensureReady({ account: o.account, sessionId: 'session-2' })
  void waiting.then(() => { settled = true }, () => { settled = true })
  await settle()
  assert.equal(settled, false, 'the request is still waiting for the poll\'s answer')

  held.resolve()
  await polling
  const refused = await waiting
  assert.equal(refused.ok, false, 'the poll\'s explicit refusal denies the request that waited for it')
  if (refused.ok) return
  assert.equal(refused.error.code, 'POLICY_REFUSED')
  assert.equal(refused.error.failure.retryDisposition, 'forbid')

  // A terminal refusal is not re-asked: the next request reads nothing more.
  const after = await o.controller.ensureReady({ account: o.account, sessionId: 'session-3' })
  assert.equal(after.ok, false)
  assert.equal(o.reads.length, 2, 'the refused identity is not read again')
})

test('a caller that cancels its own wait leaves the pin unknown', async (t) => {
  const held = deferred<void>()
  const entered = deferred<void>()
  const owned: Promise<unknown>[] = []
  const o = await owner(t, {
    label: 'org-pin-cancelled',
    release: () => held.resolve(),
    owned,
    fetchSettings: async () => {
      entered.resolve()
      await held.promise
      return envelope({}, 'checksum-cancelled')
    },
  })
  await restore(o, { checksum: 'checksum-cancelled', revision: 'revision-cancelled' })

  const aborter = new AbortController()
  const pending = o.controller.ensureReady({ account: o.account, sessionId: 'session-1', signal: aborter.signal })
  owned.push(pending)
  await entered.promise
  aborter.abort()
  const decision = await pending
  assert.equal(decision.ok, false, 'a cancelled caller is not admitted')
  if (decision.ok) return
  assert.equal(decision.error.code, 'ABORTED')
  // The shared read is still held: nothing it has not stated may be read as a pin.
  assert.equal(o.controller.adoptedOrganizationPin(o.account)?.kind, 'unknown')
  assert.equal(o.reads.length, 1, 'the caller\'s own bound is the read\'s, not a second request')
  assert.deepEqual(await o.check(), { kind: 'denied', code: 'pin_unverified' })
  held.resolve()
})

test('a determination that lost its binding states nothing for the state that replaced it', async (t) => {
  const held = deferred<void>()
  const entered = deferred<void>()
  const owned: Promise<unknown>[] = []
  const o = await owner(t, {
    label: 'org-pin-superseded',
    release: () => held.resolve(),
    owned,
    fetchSettings: async () => {
      entered.resolve()
      await held.promise
      return envelope({ forceLoginOrgUUID: ORGANIZATION_UUID }, 'checksum-superseded')
    },
  })
  await restore(o, { checksum: 'checksum-superseded', revision: 'revision-superseded' })

  const pending = o.controller.ensureReady({ account: o.account, sessionId: 'session-1' })
  owned.push(pending)
  await entered.promise
  // Capture the release, then let the held answer land: awaiting the release first would wait
  // on the answer this case is still holding.
  const releasing = o.controller.releaseSession('session-1')
  held.resolve()
  await releasing
  await pending
  assert.equal(o.controller.adoptedOrganizationPin(o.account)?.kind, 'unknown',
    'a determination that no longer owns its state states nothing')
})
