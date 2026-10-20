/**
 * The plugin-side `policy_limits` owner: eligibility, the organization pin it consumes from
 * adopted settings, the DSH-operation mapping, and one account's read/adopt/stale lifecycle.
 *
 * The protocol itself (parse, validator, retry budget, verdict order) is the shared core's
 * and is covered by its own specs; this spec owns what the plugin adds — which accounts are
 * eligible, which operations a key reaches here, what happens to an adopted document when a
 * later read fails, that a read is single-flight per account, that an identity never reuses
 * another's state, and what the durable projection restores.
 *
 * No network and no timer: every response is synthesized and handed to the owner through its
 * injected transport, whose body is a plain async iterable, and every wait is an explicit
 * gate or an observable state change.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Private harness home before any plugin module is imported.
const home = mkdtempSync(join(tmpdir(), 'claude-policy-limits-spec-'))
process.env.DSH_HOME = home
// The durable store is given its own private directory; no real home is read.
const stateRoot = mkdtempSync(join(tmpdir(), 'claude-policy-limits-state-'))
process.on('exit', () => {
  rmSync(home, { recursive: true, force: true })
  rmSync(stateRoot, { recursive: true, force: true })
})

const {
  orgPinFromSettings,
  policyKeyMapping,
  policyLimitsEligibilityFor,
  POLICY_MAPPING_GAPS,
  ClaudePolicyLimitsOwner,
  ClaudeOrgPinChecker,
} = await import('../src/providers/claude-policy-limits.js')
const { POLICY_KEYS } = await import('../src/claude-core/policy-registry.js')
const { parseOrgPin } = await import('../src/claude-core/org-pin.js')
const { coreFailure } = await import('../src/claude-core/failures.js')
const { FileClaudePolicyLimitsState, ClaudePolicyLimitsStateFailure } = await import('../src/providers/claude-policy-limits-state.js')
import type { ClaudePolicyLimitsOptions, ClaudePolicyLimitsOwner as PolicyLimitsOwner, PolicyLimitsIdentity } from '../src/providers/claude-policy-limits.js'
import type { ClaudePolicyLimitsScheduler } from '../src/providers/claude-policy-limits.js'
import type { CoreTransport, CoreHttpResponse } from '../src/claude-core/policy-limits-client.js'
import type { CoreFailure } from '../src/claude-core/failures.js'

/** One recorded request. */
interface RecordedCall {
  url: string
  method: string
  headers: Readonly<Record<string, string>>
}

/** A transport whose responses are scripted and, when asked, held until a test opens a gate. */
interface Wire {
  readonly calls: RecordedCall[]
  /** The answer every request from now on receives. */
  set(next: { status: number; body: string; signature?: string }): void
  /** Resolves once the transport has been entered at least `count` times. */
  entered(count: number): Promise<void>
  /** Let the response of the request at `index` through; a no-op on a transport that never holds one. */
  release(index: number): void
  /** Whether the request at `index` observed an aborted signal. */
  aborted(index: number): boolean
  readonly transport: CoreTransport
}

/**
 * The response body the core reads.
 *
 * A plain async iterable rather than a `Response` stream: the core's own body reader takes
 * this branch, and every step of the read then settles on the microtask queue, so a test
 * never has to guess how many timer turns a body needs.
 */
function bodyOf(text: string): AsyncIterable<Uint8Array> {
  return (async function* generate(): AsyncGenerator<Uint8Array> {
    yield new TextEncoder().encode(text)
  })()
}

/**
 * A scripted transport with one gate per request.
 *
 * `hold` makes every response wait for the test's explicit release, which is how a case
 * observes a request while it is genuinely in flight; without it the answer is immediate.
 */
function wire(options: { hold?: boolean } = {}): Wire {
  const hold = options.hold === true
  const calls: RecordedCall[] = []
  const gates: { open: () => void; aborted: boolean }[] = []
  const waiters: { count: number; resolve: () => void }[] = []
  let script: { status: number; body: string; signature?: string | undefined } = { status: 200, body: '{}', signature: 'sig-1' }

  const announce = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]
      if (waiter !== undefined && calls.length >= waiter.count) {
        waiters.splice(index, 1)
        waiter.resolve()
      }
    }
  }

  return {
    calls,
    set: (next) => { script = next },
    entered: (count) => {
      if (calls.length >= count) return Promise.resolve()
      return new Promise<void>((resolve) => { waiters.push({ count, resolve }) })
    },
    release: (index) => { gates[index]?.open() },
    aborted: (index) => gates[index]?.aborted === true,
    transport: async (request) => {
      calls.push({ url: request.url, method: request.method, headers: request.headers })
      let open!: () => void
      const opened = new Promise<void>((resolve) => { open = resolve })
      const gate = { open, aborted: false }
      gates.push(gate)
      // An aborted request still answers: the late body is exactly the case a superseded
      // read must not adopt from.
      request.signal.addEventListener('abort', () => { gate.aborted = true; open() }, { once: true })
      announce()
      if (hold) await opened
      const response: CoreHttpResponse = {
        status: script.status,
        headers: {
          get: (name: string) => name.toLowerCase() === 'signature' && script.signature !== undefined ? script.signature : null,
        },
        body: script.status === 304 || script.body.length === 0 ? null : bodyOf(script.body),
      }
      return response
    },
  }
}

/** A scheduler whose timers fire only when a test says so. */
function manualScheduler(): { after: ClaudePolicyLimitsScheduler['after']; armed: (() => void)[] } {
  const armed: (() => void)[] = []
  return {
    armed,
    after: (_ms, run) => {
      const fire = (): void => {
        const at = armed.indexOf(fire)
        if (at < 0) return
        armed.splice(at, 1)
        run()
      }
      armed.push(fire)
      return () => {
        const at = armed.indexOf(fire)
        if (at >= 0) armed.splice(at, 1)
      }
    },
  }
}

/** The identity the spec's bindings are established under. */
const TEST_IDENTITY: PolicyLimitsIdentity = { account: 'acct', origin: 'https://api.anthropic.com', profileFingerprint: 'fp' }

/** One adopted document with a refusal, an allowance and a compliance taint. */
const ADOPTED_DOCUMENT = JSON.stringify({
  restrictions: { allow_model_catalog: { allowed: false }, allow_web_fetch: { allowed: true } },
  compliance_taints: ['hipaa'],
})

/**
 * One owner over a scripted transport, with the retry wait collapsed for the tests.
 *
 * A case binds its own sessions unless it asks for the spec's default binding: a policy state
 * belongs to an identity, so a read without one is a no-op by design.
 */
function owner(transport: Wire, overrides: Partial<ClaudePolicyLimitsOptions> = {}, autoBind = true): PolicyLimitsOwner {
  const limits = new ClaudePolicyLimitsOwner({
    baseUrl: 'https://api.anthropic.com',
    userAgent: 'test-agent',
    transport: transport.transport,
    accessToken: async () => 'test-token',
    // The retry budget is the core's; its wait is not what these cases assert, so the sleep
    // is collapsed rather than spending the real backoff in a test process.
    sleep: async () => {},
    random: () => 0.5,
    ...overrides,
  })
  if (autoBind) {
    limits.bind('acct', 'default', TEST_IDENTITY)
    limits.bind('other', 'default', TEST_IDENTITY)
  }
  return limits
}

/** Wait until a condition holds, draining turns; a condition that never holds fails loudly. */
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    if (condition()) return
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
  assert.fail(`condition never held: ${label}`)
}

test('eligibility is the core rule, built from the plugin own credential facts', () => {
  const base = {
    firstPartyOAuth: true,
    defaultBaseUrl: true,
    scopes: 'user:inference user:profile',
    accessToken: 'token',
  }
  assert.deepEqual(policyLimitsEligibilityFor({ ...base, subscriptionType: null }),
    { kind: 'eligible', reason: 'unstated_subscription' })
  assert.deepEqual(policyLimitsEligibilityFor(base), { kind: 'eligible', reason: 'unstated_subscription' })
  assert.deepEqual(policyLimitsEligibilityFor({ ...base, subscriptionType: 'team' }),
    { kind: 'eligible', reason: 'organization_subscription' })
  assert.deepEqual(policyLimitsEligibilityFor({ ...base, subscriptionType: 'enterprise' }),
    { kind: 'eligible', reason: 'organization_subscription' })
  // A stated value this build does not recognize is never trimmed into "unknown".
  for (const subscriptionType of ['', 'pro', 'max', 'something-new']) {
    assert.deepEqual(policyLimitsEligibilityFor({ ...base, subscriptionType }),
      { kind: 'ineligible', reason: 'unsupported_subscription_type' }, subscriptionType)
  }
  assert.deepEqual(policyLimitsEligibilityFor({ ...base, scopes: 'user:profile' }),
    { kind: 'ineligible', reason: 'no_inference_scope' })
  assert.deepEqual(policyLimitsEligibilityFor({ ...base, defaultBaseUrl: false }),
    { kind: 'ineligible', reason: 'custom_base_url' })
  assert.deepEqual(policyLimitsEligibilityFor({ ...base, firstPartyOAuth: false }),
    { kind: 'ineligible', reason: 'not_first_party_oauth' })
  assert.deepEqual(policyLimitsEligibilityFor({ ...base, accessToken: undefined }),
    { kind: 'ineligible', reason: 'no_access_token' })
})

test('the pin parser keeps a present-but-unusable value a refusal, never an absence', () => {
  assert.deepEqual(orgPinFromSettings({}), { kind: 'none' })
  assert.deepEqual(orgPinFromSettings(undefined), { kind: 'none' })
  assert.deepEqual(orgPinFromSettings({ forceLoginOrgUUID: 'org-1' }), { kind: 'pin', organizations: ['org-1'] })
  assert.deepEqual(orgPinFromSettings({ forceLoginOrgUUID: ['org-1', 'org-2'] }), { kind: 'pin', organizations: ['org-1', 'org-2'] })
  // The pinned preprocessing deletes a null member, so a null reads as absent rather than
  // turning a valid session into a refusal.
  assert.deepEqual(orgPinFromSettings({ forceLoginOrgUUID: null }), { kind: 'none' })
  // Every other present-but-unusable value is refused, not read as "no pin held".
  for (const value of ['', '   ', [], ['org-1', ''], [''], [1], 42, { org: 'x' }]) {
    const parsed = orgPinFromSettings({ forceLoginOrgUUID: value })
    assert.equal(parsed.kind, 'invalid', JSON.stringify(value))
  }
})

test('every registered key is classified, and nothing maps by name', () => {
  assert.deepEqual([...POLICY_MAPPING_GAPS], [], 'each pinned key has a declared disposition')
  assert.equal(POLICY_KEYS.length, 34)
  // The catalogue FETCH this plugin performs. Inference is another operation, and listing
  // already-known local models is not an operation at all.
  assert.deepEqual(policyKeyMapping('allow_model_catalog'), { enforcement: 'enforced', operations: ['provider.catalog_fetch'] })
  // A cross-session send-file capability is not this plugin's attachment transfer, and a
  // web-fetch refusal is not this plugin's egress: both stay typed unsupported until a
  // verified consumer or tool identity exists.
  assert.deepEqual(policyKeyMapping('allow_send_file'), {
    enforcement: 'unsupported', operations: ['file_transfer'], reason: 'no verified consumer for the send-file capability in this provider',
  })
  assert.deepEqual(policyKeyMapping('allow_web_fetch'), {
    enforcement: 'unsupported', operations: ['web_fetch'], reason: 'no verified web-fetch tool identity in this composition',
  })
  // A capability this build does not have is declared, with its reason.
  const heap = policyKeyMapping('allow_heap_dump')
  assert.equal(heap.enforcement, 'inapplicable')
  // The client-only surfaces are declared inapplicable, never a refusal of this provider's own
  // operations: the three local transcript scans the client/analytics views own, the insights
  // command (whose model queries belong to the tool surface), the conversation pointer, which
  // is a transcript meta message rather than the cc_prev_req billing field, and the repository
  // visibility HTTP probe this provider never performs.
  for (const key of [
    'allow_skill_doctor_transcript_scan',
    'allow_stats_transcript_scan',
    'allow_usage_transcript_scan',
    'allow_insights',
    'allow_previous_conversation_pointer',
    'allow_repo_visibility_probe',
  ]) {
    const mapping = policyKeyMapping(key)
    assert.equal(mapping.enforcement, 'inapplicable', key)
    assert.ok(mapping.enforcement === 'inapplicable' && mapping.reason.length > 0, `${key} states its reason`)
  }
  // A capability this provider does not perform reaches no operation at all: denying the
  // repository-probe key must not refuse an ordinary Host tool, while a real web-fetch
  // refusal still reaches exactly web_fetch.
  assert.equal(Object.hasOwn(policyKeyMapping('allow_repo_visibility_probe'), 'operations'), false)
  const webFetch = policyKeyMapping('allow_web_fetch')
  assert.ok(webFetch.enforcement === 'unsupported' && webFetch.operations.includes('web_fetch'))
  for (const key of POLICY_KEYS) {
    const mapping = policyKeyMapping(key)
    if (mapping.enforcement !== 'unsupported') continue
    assert.equal(mapping.operations.includes('host.tools'), false, `${key} never refuses a Host tool`)
  }
  // An unregistered key is refused conservatively over the attributed operations.
  const unknown = policyKeyMapping('allow_something_new')
  assert.equal(unknown.enforcement, 'unsupported')
  assert.deepEqual(unknown.enforcement === 'unsupported' ? unknown.operations : [], [
    'provider.messages', 'provider.catalog_fetch', 'provider.network', 'web_fetch', 'file_transfer', 'host.tools',
  ])
})

test('one account adopts a document, answers verdicts from it, and reads single-flight', async () => {
  const transport = wire({ hold: true })
  const limits = owner(transport, {}, false)

  // A status read starts nothing, and an account this owner does not know has none.
  assert.equal(limits.status('nobody'), undefined)
  limits.bind('acct', 's1', TEST_IDENTITY)
  assert.deepEqual(limits.status('acct'),
    { state: 'unavailable', reason: 'never-read', fallback: 'none', blockers: [], verified: false })
  assert.equal(transport.calls.length, 0)

  transport.set({ status: 200, body: ADOPTED_DOCUMENT })
  const first = limits.ensure('acct', { force: true })
  const second = limits.ensure('acct', { force: true })
  await transport.entered(1)
  assert.equal(transport.calls.length, 1, 'concurrent callers join one read')
  assert.equal(transport.calls[0]?.url, 'https://api.anthropic.com/api/claude_code/policy_limits')
  assert.equal(transport.calls[0]?.method, 'GET')
  assert.equal(transport.calls[0]?.headers['authorization'], 'Bearer test-token')
  // The request really is on the wire before either caller can observe a result.
  let settled = false
  void Promise.all([first, second]).then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'no caller settles while the only request is still held')

  transport.release(0)
  assert.equal((await first).outcome, 'current')
  assert.equal((await second).outcome, 'current')
  assert.equal(transport.calls.length, 1)
  assert.equal(limits.status('acct')?.state, 'current')
  assert.equal(limits.status('acct')?.verified, true)
  assert.deepEqual(limits.status('acct')?.deniedKeys, ['allow_model_catalog'])

  // The live document answers: an explicit deny, an explicit allow, and a taint-denied key.
  assert.equal(limits.verdict('acct', 'allow_model_catalog').verdict, 'deny')
  assert.equal(limits.verdict('acct', 'allow_web_fetch').verdict, 'allow')
  assert.equal(limits.verdict('acct', 'allow_product_feedback').verdict, 'deny')
  assert.equal(limits.verdict('acct', 'allow_something_new').verdict, 'unsupported')
})

test('the organization check sends nothing without a pin, and is keyed by the pin revision', async () => {
  const transport = wire()
  const checker = new ClaudeOrgPinChecker({
    url: 'https://api.anthropic.com/api/oauth/validate',
    userAgent: 'test-agent',
    transport: transport.transport,
  })
  const check = (pin: unknown, revision: string) => checker.check({
    account: 'acct',
    projected: pin === undefined
      ? undefined
      : { kind: 'stated', pin: parseOrgPin(pin), revision },
    accessToken: async () => 'test-token',
  })

  // No policy at all, and a policy that states no pin: nothing is sent.
  assert.deepEqual(await check(undefined, 'r1'), { kind: 'no-pin' })
  assert.deepEqual(await check(undefined, 'r1'), { kind: 'no-pin' })
  assert.deepEqual(await checker.check({
    account: 'acct', projected: { kind: 'stated', pin: { kind: 'none' }, revision: 'r1' }, accessToken: async () => 'token',
  }), { kind: 'no-pin' })
  assert.equal(transport.calls.length, 0, 'a session without a pin sends no validation request')

  // A restored snapshot states no pin: unverified, never "no pin held".
  assert.deepEqual(await checker.check({
    account: 'acct',
    projected: { kind: 'unknown', revision: 'r1', reason: 'restored' },
    accessToken: async () => 'token',
  }), { kind: 'denied', code: 'pin_unverified' })
  assert.equal(transport.calls.length, 0)

  // A pin is validated; the account inside it is allowed.
  transport.set({ status: 200, body: JSON.stringify({ organization_uuid: 'org-1' }) })
  const allowed = check('org-1', 'r2')
  await transport.entered(1)
  transport.release(0)
  assert.deepEqual(await allowed, { kind: 'allowed' })
  assert.equal(transport.calls.length, 1)
  assert.equal(transport.calls[0]?.method, 'POST')
  assert.equal(transport.calls[0]?.url, 'https://api.anthropic.com/api/oauth/validate')

  // The same pin revision on the same identity is remembered: a rotated credential does not
  // re-send.
  assert.deepEqual(await check('org-1', 'r2'), { kind: 'allowed' })
  assert.equal(transport.calls.length, 1, 'an ordinary credential rotation is not a new login')

  // A different lease on the same account is a different identity: it must not reuse the
  // judgment made for the previous one.
  const leased = checker.check({
    account: 'acct',
    projected: { kind: 'stated', pin: parseOrgPin('org-1'), revision: 'r2' },
    identity: { accountUuid: 'uuid-b', leaseEpoch: '2' },
    accessToken: async () => 'token-2',
  })
  await transport.entered(2)
  transport.release(1)
  assert.deepEqual(await leased, { kind: 'allowed' })
  assert.equal(transport.calls.length, 2, 'a new lease is verified again')

  // A new policy revision is checked at the next actual check, and answers for the new set.
  transport.set({ status: 200, body: JSON.stringify({ organization_uuid: 'org-9' }) })
  const mismatched = check(['org-1', 'org-2'], 'r3')
  await transport.entered(3)
  transport.release(2)
  assert.deepEqual(await mismatched, { kind: 'denied', code: 'org_pin_mismatch' })
  assert.equal(transport.calls.length, 3)

  // A present-but-unusable pin denies without a request, and a missing result denies too.
  const before = transport.calls.length
  assert.deepEqual(await check([], 'r4'), { kind: 'denied', code: 'invalid_input' })
  assert.equal(transport.calls.length, before, 'an unusable pin needs no request to be refused')
  transport.set({ status: 200, body: JSON.stringify({}) })
  const missing = check('org-1', 'r5')
  await transport.entered(4)
  transport.release(3)
  assert.deepEqual(await missing, { kind: 'denied', code: 'org_verify_failed' })
})

test('a failed read keeps the adopted document, its fixed reason, and reports stale', async () => {
  const transport = wire()
  const limits = owner(transport, {}, false)
  limits.bind('acct', 's1', TEST_IDENTITY)
  transport.set({ status: 200, body: JSON.stringify({ restrictions: { allow_model_catalog: { allowed: false } } }) })
  await limits.ensure('acct', { force: true })
  assert.equal(limits.verdict('acct', 'allow_model_catalog').verdict, 'deny')

  // The next read fails at the transport; the known restriction must survive it.
  transport.set({ status: 500, body: '{}' })
  const again = await limits.ensure('acct', { force: true })
  assert.equal(again.outcome, 'stale')
  assert.equal(again.reason, 'request_failed')
  assert.equal(again.failure?.code, 'request_failed')
  assert.equal(again.failure?.status, 500)
  assert.equal(limits.status('acct')?.state, 'stale')
  assert.equal(limits.status('acct')?.failure?.status, 500, 'the status carries the pure failure, never a body')
  assert.equal(limits.verdict('acct', 'allow_model_catalog').verdict, 'deny', 'the adopted restriction is retained')

  // A readiness check that is not forced answers from the confirmed state: no second request.
  // The failing read spent the core's whole retry budget, so the check is compared against
  // the count it left behind rather than against a fixed number of requests.
  const before = transport.calls.length
  const cached = await limits.ensure('acct')
  assert.equal(cached.outcome, 'stale')
  assert.equal(transport.calls.length, before, 'a plain readiness check performs no request')

  // Recovery after a stale read must be unconditional: a retained validator may not turn
  // the next request into a conditional one whose 304 the core classifies as unsolicited.
  transport.set({ status: 200, body: JSON.stringify({ restrictions: { allow_model_catalog: { allowed: false } } }) })
  const recovered = await limits.ensure('acct', { force: true })
  assert.equal(recovered.outcome, 'current')
  assert.equal(transport.calls.at(-1)?.headers['if-none-match'], undefined)

  // An account that never adopted anything reports unavailable instead.
  const empty = owner(transport, {}, false)
  empty.bind('other', 's1', TEST_IDENTITY)
  transport.set({ status: 500, body: '{}' })
  const miss = await empty.ensure('other', { force: true })
  assert.equal(miss.outcome, 'unavailable')
  assert.equal(miss.failure?.code, 'request_failed')
  assert.equal(empty.status('other')?.state, 'unavailable')
})

test('a 304 revalidates the live document, and a missing route follows the pinned fail-open', async () => {
  const transport = wire()
  const limits = owner(transport, {}, false)
  limits.bind('acct', 's1', TEST_IDENTITY)
  transport.set({ status: 200, body: JSON.stringify({ restrictions: { allow_model_catalog: { allowed: false } } }) })
  await limits.ensure('acct', { force: true })

  transport.set({ status: 304, body: '' })
  const revalidated = await limits.ensure('acct', { force: true })
  assert.equal(revalidated.outcome, 'current', JSON.stringify(limits.status('acct')))
  assert.equal(limits.status('acct')?.reason, 'revalidated')
  assert.equal(limits.verdict('acct', 'allow_model_catalog').verdict, 'deny', 'the document is unchanged')
  assert.ok((transport.calls[1]?.headers['if-none-match'] ?? '').startsWith('"sha256:'), 'the conditional request carries the adopted validator')

  // No live policy: the pinned fail-open keeps the no-live-policy order in charge.
  const fresh = owner(transport, {}, false)
  fresh.bind('acct', 's1', TEST_IDENTITY)
  transport.set({ status: 404, body: '' })
  assert.equal((await fresh.ensure('acct', { force: true })).outcome, 'current')
  assert.equal(fresh.status('acct')?.reason, 'route_missing_fail_open')
  assert.equal(fresh.verdict('acct', 'allow_heap_dump').verdict, 'allow', 'the no-live-policy order answers, not a fake document')

  // A missing route never clears a rule that is already in force: with a live prior the
  // reader reports the failed read, the accepted document stays, and the denial holds.
  const held = owner(transport, {}, false)
  held.bind('acct', 's1', TEST_IDENTITY)
  transport.set({ status: 200, body: JSON.stringify({ restrictions: { allow_model_catalog: { allowed: false } } }) })
  await held.ensure('acct', { force: true })
  transport.set({ status: 404, body: '' })
  const afterMiss = await held.ensure('acct', { force: true })
  assert.equal(afterMiss.outcome, 'stale', 'the read failed rather than answering an empty policy')
  assert.equal(held.status('acct')?.fallback, 'stale')
  assert.equal(held.verdict('acct', 'allow_model_catalog').verdict, 'deny', 'the accepted restriction survives a missing route')
})

test('the cadence belongs to one operation, and a stop cannot arm a second timer', async () => {
  const transport = wire({ hold: true })
  const scheduler = manualScheduler()
  const limits = owner(transport, { scheduler }, false)
  transport.set({ status: 200, body: JSON.stringify({ restrictions: {} }) })

  // A binding is registered first; arming it starts no request of its own, because the
  // binding's first read belongs to the readiness that established it.
  assert.equal(limits.bind('acct', 's1', TEST_IDENTITY), true)
  limits.arm('acct')
  assert.equal(transport.calls.length, 0)
  assert.equal(scheduler.armed.length, 1)
  // Arming is idempotent for one operation.
  limits.arm('acct')
  assert.equal(scheduler.armed.length, 1)

  // The armed refresh reads once.
  scheduler.armed[0]?.()
  await transport.entered(1)
  assert.equal(scheduler.armed.length, 0, 'the fired operation released its own slot')
  // A readiness check that lands while that read is in flight arms the next cadence itself.
  limits.arm('acct')
  assert.equal(scheduler.armed.length, 1)

  transport.release(0)
  await until(() => limits.status('acct')?.state === 'current', 'the cadence read adopted')
  assert.equal(transport.calls.length, 1)
  assert.equal(scheduler.armed.length, 1, 'the replaced operation never arms a second timer')

  // The next refresh fires and re-arms exactly one.
  scheduler.armed[0]?.()
  await transport.entered(2)
  transport.release(1)
  await until(() => limits.status('acct')?.state === 'current' && scheduler.armed.length === 1, 'the next refresh re-armed')
  assert.equal(transport.calls.length, 2)

  // A released last binding suspends the account: its cadence is cancelled, nothing re-arms,
  // and the adopted document is kept because the identity has not ended.
  await limits.releaseSession('acct', 's1')
  assert.equal(scheduler.armed.length, 0)
  assert.equal(limits.status('acct')?.state, 'current', 'a paused account keeps its document')

  // Disposal cancels whatever is left.
  limits.bind('acct', 's2', TEST_IDENTITY)
  limits.arm('acct')
  assert.equal(scheduler.armed.length, 1)
  await limits.dispose()
  assert.equal(scheduler.armed.length, 0)
})

test('a cancelled waiter does not cancel the shared read, and the last binding release aborts it', async () => {
  const transport = wire({ hold: true })
  const limits = owner(transport, {}, false)
  limits.bind('acct', 's1', TEST_IDENTITY)
  limits.bind('acct', 's2', TEST_IDENTITY)
  transport.set({ status: 200, body: ADOPTED_DOCUMENT })

  // Two callers share one read; the first one's own cancellation ends only its wait.
  const firstAbort = new AbortController()
  const secondAbort = new AbortController()
  const first = limits.ensure('acct', { force: true, signal: firstAbort.signal })
  const second = limits.ensure('acct', { force: true, signal: secondAbort.signal })
  firstAbort.abort()
  assert.equal((await first).reason, 'waiter-cancelled')
  await transport.entered(1)
  assert.equal(transport.calls.length, 1, 'the shared read is still the only request')
  assert.equal(transport.aborted(0), false, 'a waiter cancels its own wait, never the shared I/O')
  transport.release(0)
  assert.equal((await second).outcome, 'current', 'the other waiter still gets the result')
  assert.equal(limits.verdict('acct', 'allow_model_catalog').verdict, 'deny')

  // Releasing a binding that is not the last one keeps the account live and its read running.
  const held = limits.ensure('acct', { force: true })
  await transport.entered(2)
  await limits.releaseSession('acct', 's2')
  assert.equal(transport.aborted(1), false, 'a release that leaves another binding keeps the read')
  transport.release(1)
  assert.equal((await held).outcome, 'current')

  // The last binding release aborts the owner's own I/O and waits for it to settle; a body
  // that arrives after the abort adopts nothing.
  const pending = limits.ensure('acct', { force: true })
  await transport.entered(3)
  const suspended = limits.releaseSession('acct', 's1')
  assert.equal(transport.aborted(2), true, 'the owner aborts its own I/O on suspension')
  transport.release(2)
  await suspended
  const late = await pending
  assert.equal(late.outcome, 'unavailable', 'the superseded read adopts nothing')
  assert.equal(limits.status('acct')?.fallback, 'live', 'the confirmed document is untouched')
  assert.equal(limits.verdict('acct', 'allow_model_catalog').verdict, 'deny', 'and its refusal still holds')
})

test('a different identity never reuses the state, and its read waits for the old one', async () => {
  const transport = wire({ hold: true })
  const limits = owner(transport, {}, false)
  const leaseOne: PolicyLimitsIdentity = { ...TEST_IDENTITY, accountUuid: 'uuid-a', epoch: 'lease-1' }
  const leaseTwo: PolicyLimitsIdentity = { ...TEST_IDENTITY, accountUuid: 'uuid-b', epoch: 'lease-2' }
  limits.bind('acct', 's1', leaseOne)
  transport.set({ status: 200, body: ADOPTED_DOCUMENT })

  const old = limits.ensure('acct', { force: true })
  await transport.entered(1)
  // A new login keeps the account key and changes the identity: the earlier document is
  // dropped rather than reused for the new lease.
  assert.equal(limits.bind('acct', 's2', leaseTwo), true)
  assert.equal(limits.status('acct')?.state, 'unavailable')
  assert.equal(limits.status('acct')?.reason, 'never-read')

  // The replacement's first read waits for the identity it replaced to settle: two identities
  // never read for one account at once.
  const next = limits.ensure('acct', { force: true })
  assert.equal(transport.calls.length, 1, 'nothing is sent while the previous identity still owns I/O')
  transport.release(0)
  assert.equal((await old).outcome, 'unavailable', 'the superseded identity adopts nothing')
  await transport.entered(2)
  assert.equal(transport.calls.length, 2)
  transport.release(1)
  assert.equal((await next).outcome, 'current')
  assert.equal(limits.status('acct')?.verified, true)
  assert.equal(limits.verdict('acct', 'allow_model_catalog').verdict, 'deny')
})

test('a failed read reports the classifier reason and awaits the caller failure handler', async () => {
  const transport = wire()
  const failures: { account: string; identity: PolicyLimitsIdentity; failure: CoreFailure }[] = []
  let enterHandler!: () => void
  const handlerEntered = new Promise<void>((resolve) => { enterHandler = resolve })
  let releaseHandler!: () => void
  const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve })
  const scheduler = manualScheduler()
  const limits = owner(transport, {
    scheduler,
    // The unified classifier is the caller's: this stub stands in for the shared one that
    // maps a version refusal to a terminal `unsupported` failure.
    classifyFailure: async () => coreFailure('unsupported', { status: 400, reason: 'CLIENT_VERSION_UNSUPPORTED', skipRetry: true }),
    readFailure: async (event) => {
      failures.push(event)
      enterHandler()
      await handlerGate
    },
  }, false)
  limits.bind('acct', 's1', TEST_IDENTITY)
  limits.arm('acct')
  assert.equal(scheduler.armed.length, 1)
  transport.set({ status: 400, body: '{}' })

  let terminal = false
  const result = limits.ensure('acct', { force: true }).then((value) => { terminal = true; return value })
  await handlerEntered
  assert.equal(failures.length, 1)
  assert.equal(failures[0]?.account, 'acct')
  assert.deepEqual(failures[0]?.identity, TEST_IDENTITY)
  assert.equal(failures[0]?.failure.reason, 'CLIENT_VERSION_UNSUPPORTED')
  assert.equal(terminal, false, 'the terminal result is observed only after the handler settled')

  releaseHandler()
  const settled = await result
  assert.equal(settled.outcome, 'unavailable')
  assert.equal(settled.reason, 'unsupported', 'the stable outcome code stays the consumer vocabulary')
  assert.equal(settled.failure?.code, 'unsupported')
  assert.equal(settled.failure?.reason, 'CLIENT_VERSION_UNSUPPORTED', 'the fixed sub-reason is preserved beside it')
  assert.equal(settled.failure?.skipRetry, true)
  assert.equal(limits.status('acct')?.reason, 'unsupported')
  assert.equal(limits.status('acct')?.failure?.reason, 'CLIENT_VERSION_UNSUPPORTED')
  assert.equal(scheduler.armed.length, 0, 'a refusal another poll cannot change stops this account own polling')

  // A transient failure leaves the cadence armed, and the caller can stop it synchronously
  // from its own handler without awaiting the read that called it.
  const transientScheduler = manualScheduler()
  const transient = owner(transport, {
    scheduler: transientScheduler,
    readFailure: (event) => { transient.stopCadence(event.account) },
  }, false)
  transient.bind('acct', 's1', TEST_IDENTITY)
  transient.arm('acct')
  transport.set({ status: 500, body: '{}' })
  const failed = await transient.ensure('acct', { force: true })
  assert.equal(failed.failure?.code, 'request_failed')
  assert.notEqual(failed.failure?.skipRetry, true, 'a retryable status is not a refusal')
  assert.equal(transientScheduler.armed.length, 0, 'the handler fenced its own account synchronously')
  // The document already adopted is kept, and the account is not suspended by a fence alone.
  assert.equal(transient.status('acct')?.state, 'unavailable')
  transient.arm('acct')
  assert.equal(transientScheduler.armed.length, 1, 'a fenced generation is armed again by the next readiness check')
})

test('a failure handler that fences its accounts hides neither the current failure nor a settled status', async () => {
  const transport = wire({ hold: true })
  const limits = owner(transport, {
    classifyFailure: async () => coreFailure('unsupported', { status: 400, reason: 'CLIENT_VERSION_UNSUPPORTED', skipRetry: true }),
    // The plugin's global fence: one refusal stops polling for every account it serves,
    // synchronously, and intentionally includes the account whose read reported it.
    readFailure: () => {
      for (const account of limits.accounts()) limits.stopCadence(account)
    },
  }, false)
  const otherIdentity: PolicyLimitsIdentity = { ...TEST_IDENTITY, account: 'other' }
  limits.bind('acct', 's1', TEST_IDENTITY)
  limits.bind('other', 's1', otherIdentity)
  const document = JSON.stringify({ restrictions: { allow_model_catalog: { allowed: false } } })

  // One account confirms a document first, so it has a settled fact to preserve.
  transport.set({ status: 200, body: document })
  const confirmed = limits.ensure('other', { force: true })
  await transport.entered(1)
  transport.release(0)
  assert.equal((await confirmed).outcome, 'current')
  assert.equal(limits.status('other')?.state, 'current')

  // Its next read is on the wire when another account's read fails.
  const inFlight = limits.ensure('other', { force: true })
  await transport.entered(2)
  transport.set({ status: 400, body: '{}' })
  const failing = limits.ensure('acct', { force: true })
  await transport.entered(3)
  transport.release(2)
  const failed = await failing

  // The fence stopped the account whose read reported the failure, and that read still
  // reports its own failure: it is never downgraded to a superseded result.
  assert.equal(failed.outcome, 'unavailable')
  assert.equal(failed.reason, 'unsupported')
  assert.equal(failed.failure?.reason, 'CLIENT_VERSION_UNSUPPORTED')
  assert.equal(limits.status('acct')?.failure?.reason, 'CLIENT_VERSION_UNSUPPORTED', 'the recorded failure survives its own fence')
  assert.equal(limits.status('acct')?.state, 'unavailable', 'and it is the settled fact, never a stuck loading state')

  // The fenced account's in-flight read adopts nothing, and the last settled projection is
  // what the status still reports rather than the reading state that read had entered.
  assert.equal(limits.status('other')?.state, 'current')
  transport.release(1)
  assert.equal((await inFlight).outcome, 'unavailable', 'a read fenced from elsewhere adopts nothing')
  assert.equal(limits.status('other')?.state, 'current', 'and it never erases the settled fact before it')
  assert.equal(limits.verdict('other', 'allow_model_catalog').verdict, 'deny')
})

test('loading is reported only while an account has nothing settled to report', async () => {
  const transport = wire({ hold: true })
  const limits = owner(transport, {}, false)
  limits.bind('acct', 's1', TEST_IDENTITY)
  transport.set({ status: 200, body: JSON.stringify({ restrictions: { allow_model_catalog: { allowed: false } } }) })

  // The first read of an account is the one case with nothing to report but the read itself.
  const first = limits.ensure('acct', { force: true })
  await transport.entered(1)
  assert.equal(limits.status('acct')?.state, 'loading')
  assert.equal(limits.status('acct')?.reason, 'reading')
  transport.release(0)
  await first
  assert.equal(limits.status('acct')?.state, 'current')

  // A later refresh in flight keeps the settled fact, and the recorded failure of a later
  // failed read is not hidden behind it either.
  const refresh = limits.ensure('acct', { force: true })
  await transport.entered(2)
  assert.equal(limits.status('acct')?.state, 'current', 'a refresh never hides what the account settled on')
  assert.deepEqual(limits.status('acct')?.deniedKeys, ['allow_model_catalog'])
  transport.release(1)
  await refresh

  transport.set({ status: 400, body: '{}' })
  const failing = limits.ensure('acct', { force: true })
  await transport.entered(3)
  transport.release(2)
  assert.equal((await failing).outcome, 'stale')
  assert.equal(limits.status('acct')?.failure?.status, 400)
  const after = limits.ensure('acct', { force: true })
  await transport.entered(4)
  assert.equal(limits.status('acct')?.state, 'stale', 'the last failure is still what the status reports')
  assert.equal(limits.status('acct')?.failure?.status, 400, 'and its failure survives the read in flight')
  transport.release(3)
  await after
})

test('a restored snapshot keeps its refusals, sends no conditional request and cannot fail open', async () => {
  const path = join(stateRoot, 'restore.json')
  const firstTransport = wire()
  const first = owner(firstTransport, { persistence: new FileClaudePolicyLimitsState({ path }) }, false)
  assert.deepEqual(first.storageStatus(), { status: 'pending' })
  await first.hydrate()
  assert.deepEqual(first.storageStatus(), { status: 'cold' })
  first.bind('acct', 's1', TEST_IDENTITY)
  firstTransport.set({ status: 200, body: JSON.stringify({ restrictions: { allow_model_catalog: { allowed: false } } }) })
  await first.ensure('acct', { force: true })
  // Disposal owns the persist step it started: the record is on disk when it settles.
  await first.dispose()

  const transport = wire()
  const second = owner(transport, { persistence: new FileClaudePolicyLimitsState({ path }) }, false)
  await second.hydrate()
  assert.deepEqual(second.storageStatus(), { status: 'loaded', accounts: 1 })
  assert.equal(second.status('acct')?.state, 'stale')
  assert.equal(second.status('acct')?.verified, false, 'a restored snapshot is not confirmed evidence')
  assert.deepEqual(second.status('acct')?.blockers, [])
  assert.equal(second.verdict('acct', 'allow_model_catalog').verdict, 'deny', 'the restored refusal holds')

  // A missing route cannot fail open over a restored prior, and the restored snapshot never
  // contributes the validator a conditional request would need.
  second.bind('acct', 's1', TEST_IDENTITY)
  transport.set({ status: 404, body: '' })
  const afterMiss = await second.ensure('acct', { force: true })
  assert.equal(afterMiss.outcome, 'stale')
  assert.equal(transport.calls[0]?.headers['if-none-match'], undefined)
  assert.equal(second.verdict('acct', 'allow_model_catalog').verdict, 'deny', 'a failed read never clears a known restriction')

  // A confirmed read verifies the identity, and only then does a conditional request go out.
  transport.set({ status: 200, body: JSON.stringify({ restrictions: { allow_model_catalog: { allowed: false } } }) })
  assert.equal((await second.ensure('acct', { force: true })).outcome, 'current')
  assert.equal(second.status('acct')?.verified, true)
  transport.set({ status: 304, body: '' })
  assert.equal((await second.ensure('acct', { force: true })).outcome, 'current')
  assert.ok((transport.calls[2]?.headers['if-none-match'] ?? '').startsWith('"sha256:'), 'the confirmed validator is sent')
})

test('an incomplete stored projection blocks the account, and the file carries no raw value', async () => {
  const path = join(stateRoot, 'blocked.json')
  const firstTransport = wire()
  const first = owner(firstTransport, { persistence: new FileClaudePolicyLimitsState({ path }) }, false)
  await first.hydrate()
  first.bind('acct', 's1', TEST_IDENTITY)
  firstTransport.set({
    status: 200,
    body: JSON.stringify({
      restrictions: { allow_model_catalog: { allowed: false }, allow_something_private: { allowed: true } },
      compliance_taints: ['hipaa'],
      defaults: { secret_default: 'prompt text with ops@example.com' },
      core_skills: ['private-skill'],
      monitoring_notice: { text: 'contact ops@example.com for review', url: 'https://example.test/notice' },
    }),
  })
  await first.ensure('acct', { force: true })
  // In memory the notice is a safe DTO the caller renders; its url is text, never followed.
  assert.deepEqual(first.monitoringNotice('acct'), {
    text: 'contact ops@example.com for review',
    url: 'https://example.test/notice',
  })
  await first.dispose()

  // The projection keeps facts, never the remote values that carried them.
  const stored = readFileSync(path, 'utf8')
  for (const raw of ['ops@example.com', 'prompt text', 'secret_default', 'private-skill', 'allow_something_private', 'contact ops', 'example.test']) {
    assert.equal(stored.includes(raw), false, `the store must not carry ${raw}`)
  }
  assert.ok(stored.includes('"noticePresent":true'), 'the notice survives as an existence fact')
  assert.ok(stored.includes('"unknownKeys":1'), 'the unregistered key survives as a count')
  assert.ok(stored.includes('"unknownDefaults":1'), 'an untypable capability default survives as a count')

  const transport = wire()
  const second = owner(transport, { persistence: new FileClaudePolicyLimitsState({ path }) }, false)
  await second.hydrate()
  // A notice whose text was not stored is a display fact, not a permission: it is reported as
  // a pending scope and refuses nothing, while the genuinely unprovable facts stay blockers.
  assert.deepEqual(second.status('acct')?.blockers, [
    'policy_limits_unknown_keys', 'policy_limits_core_skills_unstored',
  ])
  assert.equal(second.status('acct')?.state, 'blocked')
  assert.equal(second.status('acct')?.notice, true)
  assert.equal(second.monitoringNotice('acct'), undefined, 'the stored record kept no notice text')
  assert.deepEqual(second.status('acct')?.unsupportedScopes, [
    {
      scope: 'policy-defaults',
      reason: 'the accepted policy stated a capability default this build cannot type; it is counted and never applied',
    },
    {
      scope: 'policy-notice',
      reason: 'a monitoring notice is in force; its text was not stored, so it is shown after the next confirmed read',
    },
  ], 'what this build cannot apply is reported as a scope, never enforced')
  assert.equal(second.verdict('acct', 'allow_model_catalog').verdict, 'deny', 'a blind spot refuses rather than relaxes')
  assert.equal(second.verdict('acct', 'allow_model_catalog').reason, 'policy_limits_unknown_keys')

  // A confirmed read is the only thing that clears the blockers, and it restores the notice.
  second.bind('acct', 's1', TEST_IDENTITY)
  transport.set({
    status: 200,
    body: JSON.stringify({
      restrictions: { allow_model_catalog: { allowed: false } },
      monitoring_notice: { text: 'contact ops@example.com for review', url: 'https://example.test/notice' },
    }),
  })
  assert.equal((await second.ensure('acct', { force: true })).outcome, 'current')
  assert.deepEqual(second.status('acct')?.blockers, [])
  assert.deepEqual(second.monitoringNotice('acct'), {
    text: 'contact ops@example.com for review',
    url: 'https://example.test/notice',
  })
  assert.equal(second.status('acct')?.unsupportedScopes, undefined)
  assert.equal(second.verdict('acct', 'allow_model_catalog').verdict, 'deny')
  assert.equal(second.verdict('acct', 'allow_web_fetch').verdict, 'allow')
})

test('a capability default is recorded and reported, and never refuses a verdict', async () => {
  const path = join(stateRoot, 'defaults.json')
  const firstTransport = wire()
  const first = owner(firstTransport, { persistence: new FileClaudePolicyLimitsState({ path }) }, false)
  await first.hydrate()
  first.bind('acct', 's1', TEST_IDENTITY)
  // A document whose only content is a typed capability default: the pinned typed reader
  // resolves it per capability, so it is not a restriction on any policy key.
  firstTransport.set({ status: 200, body: JSON.stringify({ restrictions: {}, defaults: { remote_control_at_startup: true } }) })
  assert.equal((await first.ensure('acct', { force: true })).outcome, 'current')
  assert.deepEqual(first.status('acct')?.blockers, [], 'a capability default is not a policy blocker')
  assert.deepEqual(first.status('acct')?.unsupportedScopes, [{
    scope: 'remote_control_at_startup',
    reason: 'the accepted policy configures a capability this build does not provide; its default is recorded and never applied',
  }])
  assert.equal(first.verdict('acct', 'allow_model_catalog').verdict, 'allow', 'a default never refuses an unrelated operation')
  await first.dispose()

  // The known default survives a restart with its type and value, and its capability scope is
  // reported again; the unknown ones stay a count.
  const stored = readFileSync(path, 'utf8')
  assert.ok(stored.includes('"key":"remote_control_at_startup","value":true'), 'a known typed default round-trips')
  const transport = wire()
  const second = owner(transport, { persistence: new FileClaudePolicyLimitsState({ path }) }, false)
  await second.hydrate()
  assert.deepEqual(second.status('acct')?.blockers, [], 'a restored capability default is not a blocker')
  assert.deepEqual(second.status('acct')?.unsupportedScopes, [{
    scope: 'remote_control_at_startup',
    reason: 'the accepted policy configures a capability this build does not provide; its default is recorded and never applied',
  }])
  assert.equal(second.verdict('acct', 'allow_model_catalog').verdict, 'allow')
  assert.equal(second.verdict('acct', 'allow_web_fetch').verdict, 'allow')
})

test('a pending notice restores as a display fact, and grants no permission', async () => {
  const path = join(stateRoot, 'notice-pending.json')
  const firstTransport = wire()
  const first = owner(firstTransport, { persistence: new FileClaudePolicyLimitsState({ path }) }, false)
  await first.hydrate()
  first.bind('acct', 's1', TEST_IDENTITY)
  firstTransport.set({
    status: 200,
    body: JSON.stringify({
      restrictions: { allow_model_catalog: { allowed: false }, allow_web_fetch: { allowed: true } },
      monitoring_notice: { text: 'a notice', url: null },
    }),
  })
  await first.ensure('acct', { force: true })
  await first.dispose()

  const transport = wire()
  const second = owner(transport, { persistence: new FileClaudePolicyLimitsState({ path }) }, false)
  await second.hydrate()
  // The missing text is a display fact: no blocker, so the notice refuses no operation and the
  // account is not held back until the next read.
  assert.deepEqual(second.status('acct')?.blockers, [])
  assert.equal(second.status('acct')?.state, 'stale')
  assert.equal(second.status('acct')?.notice, true)
  assert.equal(second.monitoringNotice('acct'), undefined, 'an unread text is never guessed as empty')
  assert.deepEqual(second.status('acct')?.unsupportedScopes, [{
    scope: 'policy-notice',
    reason: 'a monitoring notice is in force; its text was not stored, so it is shown after the next confirmed read',
  }])
  // The stored refusal still refuses and the stored allow is not turned into a refusal; the
  // notice itself neither denies nor grants anything.
  assert.equal(second.verdict('acct', 'allow_model_catalog').verdict, 'deny')
  assert.equal(second.verdict('acct', 'allow_web_fetch').verdict, 'allow')

  // A confirmed read states the text and clears the pending scope.
  second.bind('acct', 's1', TEST_IDENTITY)
  transport.set({
    status: 200,
    body: JSON.stringify({
      restrictions: { allow_model_catalog: { allowed: false } },
      monitoring_notice: { text: 'a notice', url: null },
    }),
  })
  assert.equal((await second.ensure('acct', { force: true })).outcome, 'current')
  assert.deepEqual(second.monitoringNotice('acct'), { text: 'a notice', url: null })
  assert.equal(second.status('acct')?.unsupportedScopes, undefined)
  assert.equal(second.verdict('acct', 'allow_model_catalog').verdict, 'deny')
})

test('a contained failure warns with a fixed code, never with the failed hook text', async () => {
  const secret = 'synthetic TOKEN=sk-live-abc123 PROMPT=do-not-log'
  const warns: string[] = []
  const onWarn = (message: string): void => { warns.push(message) }
  const secretError = (): Error => new Error(secret)

  // The store's load itself rejects: the typed result names the store's closed code.
  const failingLoad = owner(wire(), {
    onWarn,
    persistence: {
      load: async () => { throw secretError() },
      save: async () => {},
      remove: async () => ({ status: 'absent' }),
    },
  }, false)
  await failingLoad.hydrate()
  assert.equal(failingLoad.storageStatus().status, 'unavailable')

  // A listener that throws on the warning itself is still contained, and the wrapper around
  // the load reports its own fixed stage code.
  let warnCalls = 0
  const flaky = owner(wire(), {
    onWarn: (message) => {
      warnCalls += 1
      if (warnCalls === 1) throw secretError()
      warns.push(message)
    },
    persistence: {
      load: async () => { throw secretError() },
      save: async () => {},
      remove: async () => ({ status: 'absent' }),
    },
  }, false)
  await flaky.hydrate()

  // The store's write rejects, and both caller hooks throw.
  const transport = wire()
  const failingSave = owner(transport, {
    onWarn,
    onChanged: () => { throw secretError() },
    readFailure: () => { throw secretError() },
    classifyFailure: async () => coreFailure('unsupported', { status: 400, reason: 'CLIENT_VERSION_UNSUPPORTED', skipRetry: true }),
    persistence: {
      load: async () => ({ status: 'cold' }),
      save: async () => { throw secretError() },
      remove: async () => ({ status: 'absent' }),
    },
  }, false)
  await failingSave.hydrate()
  failingSave.bind('acct', 's1', TEST_IDENTITY)
  transport.set({ status: 200, body: JSON.stringify({ restrictions: {} }) })
  assert.equal((await failingSave.ensure('acct', { force: true })).outcome, 'current')
  transport.set({ status: 400, body: '{}' })
  assert.equal((await failingSave.ensure('acct', { force: true })).outcome, 'stale', 'a confirmed document is kept through the failure')
  await failingSave.dispose()

  // A store failure reports the store's own closed code instead of the stage word.
  const lockedTransport = wire()
  const lockedOwner = owner(lockedTransport, {
    onWarn,
    persistence: {
      load: async () => ({ status: 'cold' }),
      save: async () => { throw new ClaudePolicyLimitsStateFailure('state_locked', 'the lock is held elsewhere') },
      remove: async () => ({ status: 'absent' }),
    },
  }, false)
  await lockedOwner.hydrate()
  lockedOwner.bind('acct', 's1', TEST_IDENTITY)
  lockedTransport.set({ status: 200, body: JSON.stringify({ restrictions: {} }) })
  assert.equal((await lockedOwner.ensure('acct', { force: true })).outcome, 'current')
  await lockedOwner.dispose()

  // The organization check cannot read a credential.
  const checker = new ClaudeOrgPinChecker({
    url: 'https://api.anthropic.com/api/oauth/validate',
    userAgent: 'test-agent',
    transport: transport.transport,
    onWarn,
  })
  assert.deepEqual(await checker.check({
    account: 'acct',
    projected: { kind: 'stated', pin: parseOrgPin('org-1'), revision: 'r1' },
    accessToken: async () => { throw secretError() },
  }), { kind: 'denied', code: 'org_verify_failed' })

  for (const code of [
    'state_unreadable', 'hydration_failed', 'owned_work_failed', 'read_failure_handler_failed', 'status_listener_failed', 'credential_read_failed', 'state_locked',
  ]) {
    assert.ok(warns.some(warning => warning.includes(code)), `a warning names ${code}`)
  }
  assert.equal(
    warns.some(warning => warning.includes(secret) || warning.includes('sk-live') || warning.includes('PROMPT')),
    false,
    'no warning carries the failed hook text',
  )
})

test('an untrusted store fails closed and a confirmed read clears the blocker', async () => {
  const path = join(stateRoot, 'corrupt.json')
  const corrupt = '{"version":1,"accounts":[{'
  writeFileSync(path, corrupt)

  const transport = wire()
  const limits = owner(transport, { persistence: new FileClaudePolicyLimitsState({ path }) }, false)
  await limits.hydrate()
  const storage = limits.storageStatus()
  assert.equal(storage.status, 'unavailable')
  assert.equal(storage.status === 'unavailable' ? storage.error.code : '', 'state_corrupt')

  limits.bind('acct', 's1', TEST_IDENTITY)
  assert.deepEqual(limits.status('acct')?.blockers, ['policy_limits_state_unavailable'])
  assert.equal(limits.verdict('acct', 'allow_model_catalog').verdict, 'deny')
  assert.equal(limits.verdict('acct', 'allow_model_catalog').reason, 'policy_limits_state_unavailable')

  // A confirmed read is fresh evidence, so it clears the blocker and the document answers
  // again; durability is NOT restored — the untrusted file is never replaced by the write
  // that would have followed, so a restart blocks on the same file again.
  transport.set({ status: 200, body: JSON.stringify({ restrictions: {} }) })
  assert.equal((await limits.ensure('acct', { force: true })).outcome, 'current')
  assert.deepEqual(limits.status('acct')?.blockers, [])
  assert.equal(limits.status('acct')?.verified, true)
  assert.equal(limits.verdict('acct', 'allow_model_catalog').verdict, 'allow')
  assert.equal(readFileSync(path, 'utf8'), corrupt, 'the refused write left the file exactly as it was')
  await limits.dispose()
  assert.equal(readFileSync(path, 'utf8'), corrupt)
  // The store still reports itself untrustworthy: the operator has to repair or remove it.
  assert.equal(limits.storageStatus().status, 'unavailable')
})

test('a state change is reported to the status projection, and a failing listener is contained', async () => {
  const transport = wire()
  const seen: string[] = []
  const limits = owner(transport, {
    onChanged: (account) => {
      seen.push(account)
      throw new Error('listener')
    },
  }, false)
  limits.bind('acct', 's1', TEST_IDENTITY)
  transport.set({ status: 200, body: JSON.stringify({ restrictions: {} }) })
  assert.equal((await limits.ensure('acct', { force: true })).outcome, 'current')
  assert.deepEqual(seen, ['acct'], 'the adoption is reported once, and the throw changes nothing')
  assert.equal(limits.status('acct')?.state, 'current')
})
