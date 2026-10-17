/**
 * The control obligations one accepted `policy_limits` document carries, the classification that
 * keeps them out of the operation-permission namespace, and the persisted projection of both,
 * through the real production chain.
 *
 * Owner level: the plugin's own owner reads and adopts a synthetic document over its injected
 * transport (the seam `apply` injects), the real status projection turns the owner's own status
 * into the RPC dimension, and the real account line component renders it.
 *
 * Live level: the whole plugin composition is mounted over the real apply chain, so a committed
 * Claude request runs the real `restrictionKeys` -> `limitsKeysFor` -> operation-denial decision.
 * A document that states only the two known controls reaches the wire; one that also states a
 * truly unknown key is still refused conservatively; one where a registered key is denied still
 * refuses exactly the operation that key reaches.
 *
 * Durable level: the persisted projection and its restore run over an in-memory store, so a
 * restart is observed without a filesystem, and a stored count that cannot be attributed to a
 * key is never cleared.
 *
 * Everything is synthesized: no network and no credential. The owner-level and durable-level
 * cases also use no environment value and no timer. A live case installs its provider-fetch
 * stub, a private `DSH_HOME` and a pinned Bun path that does not exist for the duration of one
 * mount, and restores the exact previous values on disposal, so a request that passed every
 * policy gate fails locally instead of reaching a peer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LlmError, errorChain } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

import { POLICY_LIMITS_RETRIES } from '../src/claude-core/index.js'
import type { CoreHttpRequest, CoreHttpResponse, CoreTransport } from '../src/claude-core/index.js'
import { ClaudePolicyLimitsOwner } from '../src/providers/claude-policy-limits.js'
import type { PolicyLimitsIdentity } from '../src/providers/claude-policy-limits.js'
import type { ClaudePersistedPolicyLimitsRecord, ClaudePolicyLimitsStateStore } from '../src/providers/claude-policy-limits-state.js'
import { projectPolicyLimits } from '../src/auth/rpc.js'
import { AccountStateLines, accountStateLines } from '../src/client/SubscriptionsSection.js'
import type { AccountStatus, PolicyLimitsStatus } from '../src/client/SubscriptionsSection.js'
import { en, zh } from '../src/client/locales.js'
import type { Config, ModelEntry } from '../src/index.js'

const BASE_URL = 'https://api.anthropic.com'
const ACCOUNT = 'acct-controls'
const SESSION = 'session-controls'
const NOW = 1_786_000_000_000

/** The identity the account's state is established under. */
const IDENTITY: PolicyLimitsIdentity = { account: ACCOUNT, origin: BASE_URL, profileFingerprint: 'fp-controls' }

/** Dictionary-bound translator with `{name}` substitution, as the locale seat supplies it. */
function translateFrom(dictionary: Record<string, string>) {
  return (key: string, params?: Record<string, unknown>): string =>
    (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

const enT = translateFrom(en)
const zhT = translateFrom(zh)

/** The response body the core's own bounded reader consumes. */
function bodyOf(text: string): AsyncIterable<Uint8Array> {
  return (async function* generate(): AsyncGenerator<Uint8Array> {
    yield new TextEncoder().encode(text)
  })()
}

/**
 * Assigning the host projection to the client's own field is the compile-time mirror check: a
 * member added or changed on one side alone stops compiling here.
 * @param projected - the host-side projection for one account.
 * @returns the same value typed as the client's field.
 */
function asClientField(projected: PolicyLimitsStatus | undefined): AccountStatus['policyLimits'] {
  return projected
}

/** One account whose only reported dimension is the limits document under test. */
function accountWith(policyLimits: PolicyLimitsStatus | undefined, key: string = ACCOUNT): AccountStatus {
  return {
    key,
    isDefault: true,
    credential: { state: 'ready' },
    ...policyLimits === undefined ? {} : { policyLimits },
  }
}

// ---------------------------------------------------------------------------
// The owner: read, adopt, project, render
// ---------------------------------------------------------------------------

/** One owner read end to end, with the facts each case asserts on. */
interface Read {
  /** Every request the injected transport received. */
  readonly calls: readonly CoreHttpRequest[]
  /** The real RPC projection of the owner's status, as the `status` endpoint returns it. */
  readonly limits: PolicyLimitsStatus | undefined
  /** The real account lines the projection produces. */
  readonly lines: (t: ReturnType<typeof translateFrom>) => ReturnType<typeof accountStateLines>
  /** The real account line component over those lines, rendered to static markup. */
  readonly html: (t: ReturnType<typeof translateFrom>) => string
  /** The owner that performed the read; every case disposes it. */
  readonly owner: ClaudePolicyLimitsOwner
}

/** One owner over the injected transport and, when a case needs one, the store it persists to. */
function ownerOver(
  transport: CoreTransport,
  persistence?: ClaudePolicyLimitsStateStore,
): ClaudePolicyLimitsOwner {
  return new ClaudePolicyLimitsOwner({
    baseUrl: BASE_URL,
    userAgent: 'control-requirements-spec',
    transport,
    accessToken: async () => 'synthetic-token',
    // The retry budget is the core's; its wait is not what these cases assert, and a fixed
    // clock keeps the projected `fetchedAt` a fact this spec states.
    clock: { now: () => NOW },
    sleep: async () => {},
    random: () => 0,
    ...persistence === undefined ? {} : { persistence },
  })
}

/** A transport that answers the pinned policy endpoint with one synthesized body and nothing else. */
function policyTransport(body: unknown): { readonly calls: CoreHttpRequest[]; readonly transport: CoreTransport } {
  const calls: CoreHttpRequest[] = []
  return {
    calls,
    transport: async (request) => {
      calls.push(request)
      // Nothing else is reachable from here: a request for any other destination fails locally
      // rather than reaching for a peer or the process's own fetch.
      if (request.url !== `${BASE_URL}/api/claude_code/policy_limits`) {
        throw new Error(`this spec performs no request other than the policy_limits read (${request.url})`)
      }
      return { status: 200, headers: { get: () => null }, body: bodyOf(JSON.stringify(body)) }
    },
  }
}

/**
 * Adopt one synthetic document through the owner's real read, then project and render it.
 * @param body - the raw JSON body the transport answers with.
 * @param options - the store to persist into, and whether the read is forced past a restored one.
 * @returns the read, its projection, and its rendered rows.
 */
async function readPolicy(body: unknown, options: {
  persistence?: ClaudePolicyLimitsStateStore
  force?: boolean
} = {}): Promise<Read> {
  const wire = policyTransport(body)
  const owner = ownerOver(wire.transport, options.persistence)
  // Hydration is what a deployment runs before the first request: it installs the stored record
  // (when there is one) and it is what lets a later adoption persist.
  await owner.hydrate()
  owner.bind(ACCOUNT, SESSION, IDENTITY)
  await owner.ensure(ACCOUNT, options.force === true ? { force: true } : {})
  const limits = projectPolicyLimits(
    owner.status(ACCOUNT),
    owner.unsupported(ACCOUNT),
    owner.monitoringNotice(ACCOUNT),
  )
  const lines = (t: ReturnType<typeof translateFrom>): ReturnType<typeof accountStateLines> =>
    accountStateLines(accountWith(limits), t)
  return {
    calls: wire.calls,
    limits,
    owner,
    lines,
    html: t => renderToStaticMarkup(createElement(AccountStateLines, { t, lines: lines(t) })),
  }
}

test('both controls in force cross as one warning row that claims no enforcement', async () => {
  const read = await readPolicy({
    restrictions: {
      require_trusted_devices: { allowed: true },
      enforce_web_search_mcp_isolation: { allowed: true },
    },
  })
  try {
    assert.equal(read.calls.length, 1, 'the document is read once and adopted')
    assert.equal(read.calls[0]?.url, `${BASE_URL}/api/claude_code/policy_limits`)
    assert.equal(read.calls[0]?.method, 'GET')

    // The owner derived the field from the document this process adopted, and the RPC
    // projection carried exactly its closed key set.
    assert.deepEqual(read.limits?.controlRequirements, {
      trustedDevices: 'active',
      webSearchMcpIsolation: 'active',
      unsupportedActiveControls: ['trusted-devices', 'web-search-mcp-isolation'],
    })
    assert.deepEqual(
      Object.keys(read.limits?.controlRequirements ?? {}),
      ['trustedDevices', 'webSearchMcpIsolation', 'unsupportedActiveControls'],
    )
    assert.deepEqual(asClientField(read.limits), read.limits)

    // A control obligation is not a refusal state: the dimension stays current with no
    // blocker, so nothing here parks the account or stops an operation.
    assert.equal(read.limits?.state, 'current')
    assert.equal(read.limits?.fallback, 'live')
    assert.equal(read.limits?.fetchedAt, NOW)
    assert.equal(read.limits?.blockers, undefined)
    assert.equal(read.limits?.unsupportedScopeCount, undefined)

    // Both controls share one row, and the copy states the requirement is observed.
    assert.deepEqual(read.lines(enT), [
      { text: en.accountStatePolicyLimitsUnsupportedControl, tone: 'warn' },
    ])
    const english = read.html(enT)
    assert.ok(english.includes(en.accountStatePolicyLimitsUnsupportedControl))
    assert.equal(english.match(/<p /g)?.length, 1, 'the two controls add one row, not two')
    assert.ok(read.html(zhT).includes(zh.accountStatePolicyLimitsUnsupportedControl))

    // The server's key names never cross into the client's dimension.
    const serialized = JSON.stringify(read.limits)
    for (const key of ['require_trusted_devices', 'enforce_web_search_mcp_isolation']) {
      assert.equal(serialized.includes(key), false, `${key} must not cross`)
    }
  } finally {
    await read.owner.dispose()
  }
})

test('a control the document does not require, and one it never answers, add no row', async () => {
  const notEnforced = await readPolicy({
    restrictions: {
      require_trusted_devices: { allowed: false },
      enforce_web_search_mcp_isolation: { allowed: false },
    },
  })
  try {
    assert.deepEqual(notEnforced.limits?.controlRequirements, {
      trustedDevices: 'not-enforced',
      webSearchMcpIsolation: 'not-enforced',
      unsupportedActiveControls: [],
    })
    assert.deepEqual(notEnforced.lines(enT), [])
    assert.deepEqual(notEnforced.lines(zhT), [])
  } finally {
    await notEnforced.owner.dispose()
  }

  // A document that states neither control states no obligation at all: the field is absent
  // rather than reported as two unanswered controls.
  const unanswered = await readPolicy({ restrictions: { allow_web_fetch: { allowed: true } } })
  try {
    assert.equal(Object.hasOwn(unanswered.limits ?? {}, 'controlRequirements'), false)
    assert.deepEqual(unanswered.lines(enT), [])
  } finally {
    await unanswered.owner.dispose()
  }

  // One control in force and the other unanswered still reports the unanswered one as unknown.
  const mixed = await readPolicy({ restrictions: { require_trusted_devices: { allowed: true } } })
  try {
    assert.deepEqual(mixed.limits?.controlRequirements, {
      trustedDevices: 'active',
      webSearchMcpIsolation: 'unknown',
      unsupportedActiveControls: ['trusted-devices'],
    })
    assert.deepEqual(mixed.lines(enT), [
      { text: en.accountStatePolicyLimitsUnsupportedControl, tone: 'warn' },
    ])
  } finally {
    await mixed.owner.dispose()
  }
})

test('a control verdict that is not a boolean refuses the document instead of reading as unknown', async () => {
  const read = await readPolicy({ restrictions: { require_trusted_devices: { allowed: null } } })
  try {
    // The envelope's parser refuses the whole body, so the reader spends its own retry budget
    // and adopts nothing: no document, no requirement, no downgrade into `unknown`.
    assert.equal(read.calls.length, POLICY_LIMITS_RETRIES + 1)
    assert.equal(read.owner.restrictionKeys(ACCOUNT).length, 0, 'nothing was adopted')
    assert.equal(read.limits?.state, 'unavailable')
    assert.equal(read.limits?.code, 'PARSE_FAILED')
    assert.equal(Object.hasOwn(read.limits ?? {}, 'controlRequirements'), false)

    // The dimension states the read failure it already stated, and nothing about a control.
    const lines = read.lines(enT)
    assert.deepEqual(lines, [{
      text: `${en.accountStatePolicyLimitsUnavailable} · ${en.accountStatePolicyLimitsParseFailed}`,
      tone: 'info',
    }])
    assert.equal(read.html(enT).includes(en.accountStatePolicyLimitsUnsupportedControl), false)
  } finally {
    await read.owner.dispose()
  }
})

test('an in-force control stays a separate fact from a capability default', async () => {
  const read = await readPolicy({
    restrictions: { enforce_web_search_mcp_isolation: { allowed: true } },
    defaults: { remote_control_at_startup: true },
  })
  try {
    // The capability default a build cannot apply is reported beside the control, never merged
    // into it, and only the control produces a row.
    assert.equal(read.limits?.unsupportedScopeCount, 1)
    assert.deepEqual(read.limits?.controlRequirements, {
      trustedDevices: 'unknown',
      webSearchMcpIsolation: 'active',
      unsupportedActiveControls: ['web-search-mcp-isolation'],
    })
    assert.deepEqual(read.lines(enT), [
      { text: en.accountStatePolicyLimitsUnsupportedControl, tone: 'warn' },
    ])
    assert.equal(read.limits?.state, 'current')
    assert.equal(read.limits?.blockers, undefined)
  } finally {
    await read.owner.dispose()
  }
})

test('the classification is the operation-permission boundary the key set and the store share', async () => {
  const read = await readPolicy({
    restrictions: {
      require_trusted_devices: { allowed: true },
      enforce_web_search_mcp_isolation: { allowed: true },
      allow_something_new: { allowed: true },
    },
  })
  try {
    // The live key set a consumer maps onto its own operations holds the unknown key and never
    // the two controls.
    const keys = read.owner.restrictionKeys(ACCOUNT)
    assert.deepEqual([...keys], ['allow_something_new'])
    assert.equal(keys.includes('require_trusted_devices'), false)
    assert.equal(keys.includes('enforce_web_search_mcp_isolation'), false)
  } finally {
    await read.owner.dispose()
  }
})

// ---------------------------------------------------------------------------
// The durable projection: what a restart keeps, and what it must not clear
// ---------------------------------------------------------------------------

/**
 * An in-memory durable store, so a restart is observed without a filesystem.
 *
 * It implements the store's own merge contract: a save replaces only the accounts it names, and
 * a removal compares the revision the caller states.
 * @param initial - the records the store starts with, as a previous run would have left them.
 * @returns the store and the records it currently holds.
 */
function memoryStore(initial: readonly ClaudePersistedPolicyLimitsRecord[] = []): {
  readonly store: ClaudePolicyLimitsStateStore
  readonly records: () => readonly ClaudePersistedPolicyLimitsRecord[]
} {
  let records = [...initial]
  return {
    records: () => records,
    store: {
      load: async () => records.length === 0 ? { status: 'cold' } : { status: 'loaded', records },
      save: async (next) => {
        const merged = new Map(records.map(record => [record.identity.account, record]))
        for (const record of next) merged.set(record.identity.account, record)
        records = [...merged.values()]
      },
      remove: async (request) => {
        const found = records.find(record => record.identity.account === request.account)
        if (found === undefined) return { status: 'absent' }
        if (found.revision !== request.revision) return { status: 'superseded' }
        records = records.filter(record => record.identity.account !== request.account)
        return { status: 'removed' }
      },
    },
  }
}

/**
 * One record as an older run could have left it: a count of stated keys whose names the store
 * never kept.
 * @param unknownKeys - how many stated keys that projection could not re-state.
 * @returns the stored record.
 */
function storedRecord(unknownKeys: number): ClaudePersistedPolicyLimitsRecord {
  return {
    identity: { ...IDENTITY },
    revision: 1,
    validator: '',
    receivedAt: NOW,
    restrictions: [],
    taints: [],
    lossyTaints: false,
    noticePresent: false,
    defaults: [],
    unknownDefaults: 0,
    coreSkillsPresent: false,
    unknownKeys,
  }
}

/**
 * One owner restored from a store, over a transport that refuses every request.
 * @param store - the store to hydrate from.
 * @returns the owner and the RPC projection of its restored status.
 */
async function restored(store: ClaudePolicyLimitsStateStore): Promise<{
  readonly owner: ClaudePolicyLimitsOwner
  readonly limits: PolicyLimitsStatus | undefined
}> {
  const owner = ownerOver(async (request) => {
    throw new Error(`a restored snapshot performs no request (${request.url})`)
  }, store)
  await owner.hydrate()
  return {
    owner,
    limits: projectPolicyLimits(owner.status(ACCOUNT), owner.unsupported(ACCOUNT), owner.monitoringNotice(ACCOUNT)),
  }
}

test('a controls-only document persists no unknown operation key and reloads without a blocker', async () => {
  const memory = memoryStore()
  const first = await readPolicy({
    restrictions: {
      require_trusted_devices: { allowed: true },
      enforce_web_search_mcp_isolation: { allowed: true },
    },
  }, { persistence: memory.store })
  // Disposal awaits the persist step the adoption started.
  await first.owner.dispose()

  const stored = memory.records()
  assert.equal(stored.length, 1, 'the confirmed document is stored once')
  assert.equal(stored[0]?.unknownKeys, 0, 'a known control obligation is not an unknown operation key')
  assert.deepEqual(stored[0]?.restrictions, [], 'a control keeps no operation-permission verdict here')

  // The restart restores that record and reports no control requirement: the obligation is not
  // stored, so its absence stays unknown rather than becoming "not enforced".
  const restarted = await restored(memory.store)
  try {
    assert.equal(restarted.limits?.state, 'stale')
    assert.equal(restarted.limits?.fallback, 'stale')
    assert.equal(restarted.limits?.blockers, undefined, 'no unknown-key blocker survives the restart')
    assert.equal(Object.hasOwn(restarted.limits ?? {}, 'controlRequirements'), false)
    assert.deepEqual(accountStateLines(accountWith(restarted.limits), enT), [
      { text: en.accountStatePolicyLimitsStale, tone: 'info' },
    ])
  } finally {
    await restarted.owner.dispose()
  }
})

test('a stored unknown-key count that cannot be attributed is never cleared', async () => {
  // An older projection counted the two control keys as unknown operation keys. The count names
  // no key, so nothing here may read it as those controls and release what it blocks.
  const memory = memoryStore([storedRecord(2)])
  const before = await restored(memory.store)
  try {
    assert.equal(before.limits?.state, 'blocked')
    assert.deepEqual(before.limits?.blockers, ['policy_limits_unknown_keys'])
    assert.equal(memory.records()[0]?.unknownKeys, 2, 'the unattributable count is left exactly as it was')
  } finally {
    await before.owner.dispose()
  }

  // The conservative state ends the way every other one does: a confirmed read through the
  // owner's existing path adopts a real document and re-projects the record.
  const adopted = await readPolicy(
    { restrictions: { require_trusted_devices: { allowed: true } } },
    { persistence: memory.store, force: true },
  )
  try {
    assert.equal(adopted.limits?.state, 'current')
    assert.equal(adopted.limits?.blockers, undefined)
    assert.deepEqual(adopted.limits?.controlRequirements, {
      trustedDevices: 'active',
      webSearchMcpIsolation: 'unknown',
      unsupportedActiveControls: ['trusted-devices'],
    })
  } finally {
    await adopted.owner.dispose()
  }
  assert.equal(memory.records()[0]?.unknownKeys, 0, 'the re-projected record counts no control')
  assert.equal(memory.records()[0]?.revision, 2, 'the confirmed read is the newer record')
})

// ---------------------------------------------------------------------------
// The live operation chain, in the mounted composition
// ---------------------------------------------------------------------------

/** One recorded provider request, as the plugin's own fetch saw it. */
interface RecordedCall {
  readonly url: string
  readonly method: string
}

/** A committed request's session id, branded the way the llm service declares it. */
const llmSessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

/**
 * Install the globals one mounted composition reads, returning their exact restoration.
 *
 * Every other destination is a request this spec refuses to make: the plugin's own fetch answers
 * the managed-settings read and throws for anything else.
 * @returns the restoration to run on disposal.
 */
function installProviderStub(): () => void {
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/claude_code/settings')) {
      return Response.json({ uuid: 'settings-1', checksum: 'checksum-1', settings: {} })
    }
    throw new Error(`this spec performs no network request (${url})`)
  }) as typeof fetch
  return () => {
    if (previousFetch === undefined) Reflect.deleteProperty(globalThis, 'fetch')
    else Object.defineProperty(globalThis, 'fetch', previousFetch)
  }
}

/** A scripted transport: it records every request and answers with the case's own response. */
function scripted(handler: (call: RecordedCall, index: number) => Response): {
  readonly calls: RecordedCall[]
  readonly transport: CoreTransport
} {
  const calls: RecordedCall[] = []
  return {
    calls,
    transport: async (request: CoreHttpRequest): Promise<CoreHttpResponse> => {
      const call: RecordedCall = { url: request.url, method: request.method }
      calls.push(call)
      return handler(call, calls.length - 1)
    },
  }
}

/** The one catalog entry every case serves, so no discovery request is ever assembled. */
const MODEL: ModelEntry = {
  id: 'claude-opus-5',
  name: 'Claude Opus 5',
  contextWindow: 200_000,
  maxTokens: 8_192,
  inputModalities: ['text'],
  wire: 'responses',
}

/** Store one eligible Claude account, as a previous run of the plugin would have left it. */
function seedAccount(): void {
  const directory = join(process.env.DSH_HOME!, 'plugins', 'subscriptions')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'auth.json'), JSON.stringify({
    claude: {
      accounts: {
        'acct-1': {
          accessToken: 'access-acct-1',
          refreshToken: 'refresh-acct-1',
          expiresAt: Date.now() + 3_600_000,
          scopes: 'user:inference',
          accountUuid: 'uuid-1',
          emailAddress: 'acct-1@example.com',
          // An unstated subscription type is eligible, and the credential alone states nothing
          // about Pro/Max, so the policy read runs.
          subscriptionType: null,
        },
      },
    },
  }), { mode: 0o600 })
}

/** One mounted composition, with the facts each case asserts on. */
interface Composition {
  readonly policy: { readonly calls: RecordedCall[] }
  readonly org: { readonly calls: RecordedCall[] }
  /** Drive one committed Claude request; resolves with the failure it ended in, if any. */
  request: (sessionId: string) => Promise<unknown>
  status: () => Promise<Record<string, unknown>>
  dispose: () => Promise<void>
}

/**
 * Mount the plugin's real composition over scripted provider transports.
 * @param policy - the `policy_limits` answer.
 * @returns the mounted composition.
 */
async function mount(policy: (call: RecordedCall, index: number) => Response): Promise<Composition> {
  const restoreFetch = installProviderStub()
  const previousHome = process.env.DSH_HOME
  const previousBun = process.env.DSH_SUBSCRIPTIONS_BUN_PATH
  const home = mkdtempSync(join(tmpdir(), 'control-requirements-live-'))
  process.env.DSH_HOME = home
  // The Messages request is the one this plugin issues through its own Bun transport. Pinning
  // the runtime at a path that does not exist makes that request fail locally, before any
  // socket, so "the request continued past its policy gates" is observable without a peer.
  process.env.DSH_SUBSCRIPTIONS_BUN_PATH = join(home, 'no-such-bun-runtime')
  const restoreEnvironment = (): void => {
    restoreFetch()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousBun === undefined) delete process.env.DSH_SUBSCRIPTIONS_BUN_PATH
    else process.env.DSH_SUBSCRIPTIONS_BUN_PATH = previousBun
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // A handle this process still holds can refuse the removal on Windows; the temporary root
      // belongs to the operating system either way.
    }
  }
  try {
    seedAccount()
    const { Context } = await import('@deepseek-ai/cordis')
    const ToolRuntime = (await import('@deepseek-ai/dsh-tools')).default
    const { createFakeConnection } = await import('./fake-connection.js')
    const plugin = await import('../src/index.js')
    const ctx = new Context()
    ctx.provide('systemPrompt', { tools: () => () => {} })
    await ctx.plugin(ToolRuntime)
    const fake = createFakeConnection()
    ctx.provide('connection', fake.connection)
    let route: { stream: (options: unknown) => AsyncIterable<unknown> } | undefined
    // The Claude route mounts only while a Host provides the recording seam, and this spec
    // drives a real request through it, so the recorder must report a durable record.
    ctx.provide('llmRequestRecord', {
      recordPreparedRequest: async () => ({ ok: true, preparedId: 0 }),
    })
  ctx.provide('llm', {
      failureRecoveryVersion: 1,
      registerAdapter: (_providers: string[], adapter: { stream: (options: unknown) => AsyncIterable<unknown> }) => {
        route = adapter
        return Object.assign(() => {}, { replace: () => {} })
      },
    })
    const policyWire = scripted(policy)
    // No accepted settings document states an organization pin, so this transport must never be
    // reached; a request to it fails the case instead of quietly answering.
    const org = scripted(() => { throw new Error('this spec states no organization pin') })
    const config: Config = {
      providers: ['claude'],
      models: { claude: [MODEL] },
      pool: { enabled: false },
    }
    await ctx.plugin(Object.assign(
      (inner: import('@deepseek-ai/cordis').Context) => {
        plugin.apply(inner, config, { policyLimitsTransport: policyWire.transport, orgPinTransport: org.transport })
      },
      { inject: plugin.inject },
    ))
    return {
      policy: policyWire,
      org,
      request: async (sessionId) => {
        assert.ok(route !== undefined, 'the plugin registered its Claude route')
        const stream = route.stream({
          provider: 'claude',
          model: MODEL.id,
          messages: [],
          sessionId: llmSessionId(sessionId),
          signal: new AbortController().signal,
        })
        try {
          for await (const chunk of stream) void chunk
          return undefined
        } catch (error: unknown) {
          return error
        }
      },
      status: async () => {
        const result = await fake.handler('status', {}, new AbortController().signal)
        assert.ok(result.ok, 'the status call succeeds')
        const providers = (result.value as { providers: Record<string, Record<string, unknown>> }).providers
        return providers['claude']!
      },
      dispose: async () => {
        await ctx.fiber.dispose()
        restoreEnvironment()
      },
    }
  } catch (error: unknown) {
    restoreEnvironment()
    throw error
  }
}

/**
 * The failure a request ends in when it passed every policy gate and then reached the pinned
 * wire transport, which this spec refuses to let leave the process.
 * @param error - what the stream threw.
 */
function assertWireReached(error: unknown): void {
  assert.ok(error instanceof LlmError, `the request failed rather than completing: ${String(error)}`)
  assert.notEqual(error.code, 'CLIENT_VERSION_UNSUPPORTED', 'the request was not refused by policy')
  assert.match(errorChain(error), /BUN_PATH|Bun transport|Bun runtime|could not start/i,
    'the failure names the local transport, so the request reached it')
}

/** The failure a request ends in when a policy refused it before the wire. */
function assertRefusal(error: unknown, code: string): LlmError {
  assert.ok(error instanceof LlmError, `the request was refused: ${String(error)}`)
  assert.equal(error.code, code)
  assert.doesNotMatch(errorChain(error), /BUN_PATH|Bun transport/i, 'the refusal happened before the wire')
  return error
}

test('a controls-only document reaches the wire, and every other stated key keeps its verdict', async () => {
  // The two known controls are classified out of the operation-permission key set, so the
  // request passes every policy gate and fails only at the pinned local transport.
  const controlsOnly = await mount(() => Response.json({
    restrictions: {
      require_trusted_devices: { allowed: true },
      enforce_web_search_mcp_isolation: { allowed: true },
    },
  }))
  try {
    assertWireReached(await controlsOnly.request('session-controls'))
    assert.equal(controlsOnly.org.calls.length, 0, 'no organization pin was stated')
    // The same document reaches the client as the status dimension and one warning row.
    const claude = await controlsOnly.status()
    const accounts = claude['accounts'] as { key: string; policyLimits?: PolicyLimitsStatus }[]
    const limits = accounts[0]?.policyLimits
    assert.deepEqual(limits?.controlRequirements, {
      trustedDevices: 'active',
      webSearchMcpIsolation: 'active',
      unsupportedActiveControls: ['trusted-devices', 'web-search-mcp-isolation'],
    })
    assert.equal(limits?.state, 'current')
    assert.deepEqual(accountStateLines(accountWith(limits, 'acct-1'), enT), [
      { text: en.accountStatePolicyLimitsUnsupportedControl, tone: 'warn' },
    ])
  } finally {
    await controlsOnly.dispose()
  }

  // A truly unknown operation-permission key keeps its conservative refusal: the classification
  // is a closed list of two keys, never a prefix.
  const withUnknown = await mount(() => Response.json({
    restrictions: {
      require_trusted_devices: { allowed: true },
      allow_something_new: { allowed: true },
    },
  }))
  try {
    const refused = assertRefusal(await withUnknown.request('session-unknown'), 'POLICY_LIMITS_UNSUPPORTED')
    assert.equal(refused.failure?.retryDisposition, 'forbid', 'the unknown key still stops the resend')
  } finally {
    await withUnknown.dispose()
  }

  // A registered key this build maps onto another operation still refuses exactly that
  // operation, and the control beside it never widens the refusal into Messages.
  const knownDenied = await mount(() => Response.json({
    restrictions: {
      enforce_web_search_mcp_isolation: { allowed: true },
      allow_model_catalog: { allowed: false },
    },
  }))
  try {
    assertWireReached(await knownDenied.request('session-catalog'))
  } finally {
    await knownDenied.dispose()
  }
})
