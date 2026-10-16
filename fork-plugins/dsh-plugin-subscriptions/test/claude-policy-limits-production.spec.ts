/**
 * The production wiring of the independent `policy_limits` owner: the hard refusal it records,
 * the shared protocol block that stops a refused configuration, the execution guard that
 * enforces the verdicts it adopted, the organization pin it consumes, the request-scoped
 * judgment of a session-less request, and the disposal that waits for a read still holding its
 * response.
 *
 * Every case runs the plugin's real apply chain — `Context`, the real tool registry, the
 * registered Claude route, the shared block store, the durable stores — with the transports
 * injected exactly where production injects the network. Nothing leaves this process: the
 * plugin's own fetch is replaced by a stub that answers only the managed-settings endpoint and
 * fails everything else, and the Claude wire transport is pinned to a Bun runtime that does not
 * exist, so a request that passes every policy gate fails locally.
 *
 * One composition detail was repaired while writing this spec and is asserted here as fixed:
 * `ClaudeMaintenanceController`'s internal `raceWithSignal` resolved only on the caller's
 * abort, so a signal-bearing caller waited in `ensureReady` until it cancelled even after the
 * shared policy read had finished — every real Claude request carries a signal. The same file's
 * `adoptedOrganizationPin` looked the account up in the identity-keyed state map, so the
 * organization pin was never projected and the validation below was unreachable. Both are
 * defects in `src/providers/claude-maintenance.ts`, outside this spec's owned files, and are
 * reported with the exact evidence.
 *
 * What this spec owns, and what it cannot:
 * - The block a version refusal writes is the shared store's, written before the read result
 *   settles, and the next request observes it without a second provider call.
 * - The guard's decision comes from the Host's own registry: a similarly named tool is not the
 *   capability a policy key names, and the keys whose consumers live outside this provider
 *   (`allow_repo_visibility_probe`, the transcript scans, the send-file capability, the
 *   catalogue fetch) stop no Host tool at all.
 * - The organization pin is judged from the owner's projection, never from a raw settings
 *   document, and a refusal carries the hard stop that keeps the pool on this account.
 * - Disposal waits for a held response, cancels it, and the refused document is never adopted.
 * It does not claim provider behaviour: every response here is synthesized.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError, errorChain } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '../src/compat.js'
import type { Config, ModelEntry } from '../src/index.js'
import type { CoreHttpRequest, CoreHttpResponse, CoreTransport } from '../src/claude-core/index.js'

const root = mkdtempSync(join(tmpdir(), 'claude-limits-production-'))
// The Messages request is the one this plugin issues through its own Bun transport. Pinning the
// runtime at a path that does not exist makes that request fail locally, before any socket, so
// "the request continued past its policy gates" is observable without a peer.
process.env.DSH_SUBSCRIPTIONS_BUN_PATH = join(root, 'no-such-bun-runtime')

/** One recorded provider request, as the plugin's own fetch saw it. */
interface RecordedCall {
  readonly url: string
  readonly method: string
  readonly signal: AbortSignal
}

const providerCalls: RecordedCall[] = []
let settingsAnswer: (call: RecordedCall) => Response = () =>
  Response.json({ uuid: 'settings-1', checksum: 'checksum-1', settings: {} })

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const call: RecordedCall = { url, method: init?.method ?? 'GET', signal: init?.signal ?? new AbortController().signal }
  providerCalls.push(call)
  if (url.includes('/api/claude_code/settings')) return settingsAnswer(call)
  // Every other destination — a token refresh, a profile read, a usage lookup — is a request
  // this spec refuses to make. The plugin contains the failure; the count is what is asserted.
  throw new Error(`this spec performs no network request (${url})`)
}) as typeof fetch

/** One fresh harness home per mount, so no durable record crosses a case boundary. */
let mounts = 0
function freshHome(): void {
  mounts += 1
  process.env.DSH_HOME = join(root, `home-${mounts}`)
  mkdirSync(process.env.DSH_HOME, { recursive: true })
  providerCalls.length = 0
}

/** One stored Claude account; the maintenance and limits owners both read the sign-in. */
interface SeedAccount {
  readonly key: string
  readonly accessToken?: string
  readonly accountUuid?: string
  /** `null` is the provider's explicit "not stated"; a string is a confirmed type. */
  readonly subscriptionType?: string | null
  readonly scopes?: string
}

/** Store one Claude account roster, as a previous run of the plugin would have left it. */
function seedStore(accounts: readonly SeedAccount[]): void {
  const directory = join(process.env.DSH_HOME!, 'plugins', 'subscriptions')
  mkdirSync(directory, { recursive: true })
  const stored: Record<string, unknown> = {}
  for (const account of accounts) {
    stored[account.key] = {
      accessToken: account.accessToken ?? `access-${account.key}`,
      refreshToken: `refresh-${account.key}`,
      expiresAt: Date.now() + 3_600_000,
      scopes: account.scopes ?? 'user:inference',
      accountUuid: account.accountUuid ?? `uuid-${account.key}`,
      emailAddress: `${account.key}@example.com`,
      ...account.subscriptionType === undefined ? {} : { subscriptionType: account.subscriptionType },
    }
  }
  writeFileSync(join(directory, 'auth.json'), JSON.stringify({ claude: { accounts: stored } }), { mode: 0o600 })
}

/**
 * Store the confirmed profile a previous run accepted, so a case that must not read the
 * provider profile still starts from confirmed metadata.
 */
function seedProfile(account: string, subscriptionType: string | null, accountUuid: string): void {
  const directory = join(process.env.DSH_HOME!, 'plugins', 'subscriptions')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'claude-maintenance.json'), JSON.stringify({
    version: 1,
    accounts: [{
      account,
      origin: 'https://api.anthropic.com',
      protocolFingerprint: FINGERPRINT,
      organization: 'org-1',
      profile: {
        accountUuid,
        emailAddress: `${account}@example.com`,
        subscriptionType,
        capturedAt: Date.now(),
        complete: true,
        completenessVersion: 1,
        credentialRevision: 0,
      },
    }],
  }), { mode: 0o600 })
}

/**
 * Store an accepted policy a previous run left behind.
 *
 * The record keeps this plugin's own projected vocabulary only, and a restored snapshot carries
 * no settings — so its organization pin is unknown rather than absent, which is exactly the
 * state the pin checker must refuse instead of reading as "no pin in force".
 */
function seedRestoredPolicy(account: string): void {
  const directory = join(process.env.DSH_HOME!, 'plugins', 'subscriptions')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'claude-maintenance.json'), JSON.stringify({
    version: 1,
    accounts: [{
      account,
      origin: 'https://api.anthropic.com',
      protocolFingerprint: FINGERPRINT,
      organization: 'org-1',
      policy: {
        checksum: 'checksum-restored',
        revision: 'revision-restored',
        acceptedAt: 1,
        keys: [],
        blockers: [],
        enforced: false,
      },
    }],
  }), { mode: 0o600 })
}

/** A scripted transport: it records every request and answers with the case's own response. */function scripted(handler: (call: RecordedCall, index: number) => Response | Promise<Response>): {
  readonly calls: RecordedCall[]
  readonly transport: CoreTransport
} {
  const calls: RecordedCall[] = []
  return {
    calls,
    transport: async (request: CoreHttpRequest): Promise<CoreHttpResponse> => {
      const call: RecordedCall = { url: request.url, method: request.method, signal: request.signal }
      calls.push(call)
      return await handler(call, calls.length - 1)
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

/** The protocol fingerprint the plugin's own route is built from. */
const FINGERPRINT = (await import('../src/providers/claude-protocol.js'))
  .claudeProtocolFingerprint((await import('../src/providers/claude-protocol.js')).CLAUDE_PROTOCOL_PROFILE)

/** The body a service refusal the shared classifier reads as a client-version refusal carries. */
const VERSION_REFUSAL = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'update required',
    details: { error_code: 'claude_code_version_too_old' },
  },
})

/** A committed request's session id, branded the way the llm service declares it. */
const llmSessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

/** The agent identity one tool execution carries; the registry reads exactly these fields. */
type ExecutionAgent = NonNullable<ToolExecutionInput['agent']>
const executionAgent = (sessionId: string): ExecutionAgent =>
  ({ id: sessionId, session: { id: sessionId } }) as ExecutionAgent

/** One mounted composition, with the facts each case asserts on. */
interface Composition {
  readonly policy: { readonly calls: RecordedCall[] }
  readonly org: { readonly calls: RecordedCall[] }
  readonly providerCalls: readonly RecordedCall[]
  /** Drive one committed Claude request; resolves with the failure it ended in, if any. */
  request: (sessionId?: string) => Promise<unknown>
  /** Drive one committed request served by another provider, through the `llm/stream` seam. */
  requestOtherProvider: (sessionId: string) => Promise<void>
  execute: (sessionId: string, tool: string) => Promise<{ isError: boolean }>
  executeMessage: (sessionId: string, tool: string) => Promise<string | undefined>
  runs: (tool: string) => number
  status: () => Promise<Record<string, unknown>>
  dispose: () => Promise<void>
}

/**
 * Mount the plugin's real composition over scripted provider transports.
 * @param options - the policy_limits answers, the organization answers, the settings body, the
 *   pool configuration, and the records this run starts from (written before the plugin loads
 *   them, exactly as a previous run would have left them).
 * @returns the mounted composition.
 */
async function mount(options: {
  policy: (call: RecordedCall, index: number) => Response | Promise<Response>
  org?: (call: RecordedCall, index: number) => Response | Promise<Response>
  settings?: (call: RecordedCall) => Response
  pool?: Config['pool']
  seed?: () => void
}): Promise<Composition> {
  freshHome()
  options.seed?.()
  settingsAnswer = options.settings ?? (() => Response.json({ uuid: 'settings-1', checksum: 'checksum-1', settings: {} }))
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
  ctx.provide('llm', {
    failureRecoveryVersion: 1,
    registerAdapter: (_providers: string[], adapter: { stream: (options: unknown) => AsyncIterable<unknown> }) => {
      route = adapter
      return Object.assign(() => {}, { replace: () => {} })
    },
  })
  const policy = scripted(options.policy)
  const org = scripted(options.org ?? (() => Response.json({ organization_uuid: 'org-1' })))
  const config: Config = {
    providers: ['claude'],
    models: { claude: [MODEL] },
    pool: options.pool ?? { enabled: false },
  }
  await ctx.plugin(Object.assign(
    (inner: import('@deepseek-ai/cordis').Context) => {
      plugin.apply(inner, config, { policyLimitsTransport: policy.transport, orgPinTransport: org.transport })
    },
    { inject: plugin.inject },
  ))
  const runs = new Map<string, number>()
  for (const name of ['host_probe', 'web_fetch', 'fetch_web']) {
    ctx.tools.register({
      name,
      description: `a Host-owned ${name} probe`,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [] },
      execute: () => { runs.set(name, (runs.get(name) ?? 0) + 1); return Promise.resolve('ran') },
    })
  }
  const execute = (sessionId: string, tool: string) => ctx.tools.execute({
    callId: ToolCallId(`${tool}-${sessionId}-${String(runs.get('calls') ?? 0)}`),
    name: tool,
    arguments: {},
    agent: executionAgent(sessionId),
    signal: new AbortController().signal,
  }) as Promise<{ isError: boolean; error?: { message?: string } }>
  return {
    policy,
    org,
    get providerCalls() { return providerCalls },
    request: async (sessionId) => {
      assert.ok(route !== undefined, 'the plugin registered its Claude route')
      const stream = route.stream({
        provider: 'claude',
        model: MODEL.id,
        messages: [],
        ...sessionId === undefined ? {} : { sessionId: llmSessionId(sessionId) },
        signal: new AbortController().signal,
      })
      try {
        for await (const chunk of stream) void chunk
        return undefined
      } catch (error: unknown) {
        return error
      }
    },
    requestOtherProvider: async (sessionId) => {
      // The same dispatch the llm service performs for a committed request: the registered
      // `llm/stream` waterfall runs the plugin's listener before the terminal stream.
      const chunks = ctx.waterfall('llm/stream', {
        provider: 'codex',
        model: 'gpt-5.1',
        messages: [],
        sessionId: llmSessionId(sessionId),
        signal: new AbortController().signal,
      }, (): AsyncIterable<StreamChunk> => (async function* () {
        yield { type: 'text-delta', index: 0, text: 'hello' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })())
      for await (const chunk of chunks) void chunk
    },
    execute: async (sessionId, tool) => await execute(sessionId, tool),
    executeMessage: async (sessionId, tool) => {
      const result = await execute(sessionId, tool)
      return result.isError === true ? result.error?.message : undefined
    },
    runs: tool => runs.get(tool) ?? 0,
    status: async () => {
      const result = await fake.handler('status', {}, new AbortController().signal)
      assert.ok(result.ok, 'the status call succeeds')
      const providers = (result.value as { providers: Record<string, Record<string, unknown>> }).providers
      return providers['claude']!
    },
    dispose: async () => { await ctx.fiber.dispose() },
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

test('a known Pro/Max account reads neither settings nor limits and still reaches the wire', async () => {
  const app = await mount({
    // The entitlement excludes this account, so neither independent read may be attempted.
    policy: () => { throw new Error('no policy_limits read is allowed for an ineligible account') },
  })
  seedStore([{ key: 'acct-max', subscriptionType: 'max', accountUuid: 'uuid-max' }])

  assertWireReached(await app.request('session-max'))
  assert.equal(app.policy.calls.length, 0, 'no policy_limits request was sent')
  assert.equal(app.org.calls.length, 0, 'no organization validation was sent')
  assert.equal(providerCalls.length, 0, 'neither the settings nor the profile read was attempted')

  // The status projection reports the ineligibility its own owner decided, not a failure.
  const claude = await app.status()
  const accounts = claude['accounts'] as { key: string; policy?: { state: string }; policyLimits?: unknown }[]
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0]?.policy?.state, 'ineligible')
  assert.equal(accounts[0]?.policyLimits, undefined, 'an account with no limits state reports no dimension')
  await app.dispose()
})

test('the confirmed profile metadata decides eligibility, and an explicit null is a statement', async () => {
  // The stored credential says Pro/Max, which on its own excludes the settings read; the
  // confirmed profile states the provider exposed no subscription type. The profile wins.
  const fromProfile = await mount({
    policy: () => Response.json({ restrictions: {} }),
    seed: () => {
      seedStore([{ key: 'acct-1', subscriptionType: 'max', accountUuid: 'uuid-1' }])
      seedProfile('acct-1', null, 'uuid-1')
    },
  })
  assertWireReached(await fromProfile.request('session-1'))
  assert.equal(fromProfile.policy.calls.length, 1, 'the confirmed null made this account eligible')
  await fromProfile.dispose()

  // The other direction: the credential states nothing, the confirmed profile states Pro/Max.
  const fromSession = await mount({
    policy: () => { throw new Error('a confirmed Pro/Max profile is ineligible for this read') },
    seed: () => {
      seedStore([{ key: 'acct-1', accountUuid: 'uuid-1' }])
      seedProfile('acct-1', 'max', 'uuid-1')
    },
  })
  assertWireReached(await fromSession.request('session-1'))
  assert.equal(fromSession.policy.calls.length, 0, 'the confirmed profile excluded the read')
  await fromSession.dispose()
})

test('a version refusal in a 401 is recorded once, refreshes nothing, and blocks the next account offline', async () => {
  const app = await mount({
    policy: () => new Response(VERSION_REFUSAL, { status: 401, headers: { 'content-type': 'application/json' } }),
  })
  seedStore([
    { key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' },
    { key: 'acct-2', subscriptionType: null, accountUuid: 'uuid-2' },
  ])

  const first = assertRefusal(await app.request('session-1'), 'CLIENT_VERSION_UNSUPPORTED')
  assert.equal(first.failure?.retryDisposition, 'forbid', 'the refusal carries the hard stop')
  assert.equal(app.policy.calls.length, 1, 'the refusal is terminal: no retry and no authentication replay')
  assert.equal(app.org.calls.length, 0, 'the refused configuration is never validated')
  // The forced-refresh path is a token request, and the stub records every one of them.
  assert.equal(providerCalls.length, 1, 'only the settings read happened; no credential was refreshed')
  assert.ok(providerCalls[0]?.url.includes('/api/claude_code/settings'), 'the one call is the settings read')

  // The refusal belongs to the configuration, not the account: another account is refused from
  // the shared record before it reads a credential, a policy document or a settings envelope.
  assertRefusal(await app.request('session-2'), 'CLIENT_VERSION_UNSUPPORTED')
  assert.equal(app.policy.calls.length, 1, 'the blocked configuration is not read again')
  assert.equal(providerCalls.length, 1, 'no second provider call is made for the refused configuration')
  await app.dispose()
})

test('an oversized policy body is refused after one request and its stream is cancelled early', async () => {
  let pulls = 0
  let cancels = 0
  const chunk = new Uint8Array(16 * 1024).fill(0x61)
  const app = await mount({
    policy: () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        // Far more than the reader's own bound: an unbounded pull loop would exhaust this.
        controller.enqueue(chunk)
        if (pulls >= 100) controller.close()
      },
      cancel() { cancels += 1 },
    }), { status: 200 }),
  })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])

  const failure = assertRefusal(await app.request('session-1'), 'POLICY_LIMITS_UNAVAILABLE')
  assert.equal(failure.failure?.retryDisposition, 'forbid',
    'the over-bound body is a product guard, and the prohibition keeps the Host from re-pulling it')
  // The read is single-flight and terminal: the body bound is a product guard, not a schema
  // failure another attempt could repair.
  assert.equal(app.policy.calls.length, 1, 'an over-bound body is not re-pulled')
  assert.equal(cancels, 1, 'the reader cancels the stream the moment the bound is reached')
  assert.ok(pulls < 20, `the reader stopped early instead of draining the stream (${String(pulls)} chunks)`)
  // Nothing was adopted: the projection states the bound that stopped the read.
  const claude = await app.status()
  const accounts = claude['accounts'] as { policyLimits?: { state: string; code?: string } }[]
  assert.equal(accounts[0]?.policyLimits?.state, 'unavailable')
  assert.equal(accounts[0]?.policyLimits?.code, 'RESPONSE_OVER_LIMIT')
  await app.dispose()
})

test('a failed read refuses the request instead of sending it under an unknown policy', async () => {
  // A 4xx the shared classifier does not recognize is terminal for the reader: one attempt,
  // and the prohibition travels with the refusal.
  const app = await mount({ policy: () => new Response('{}', { status: 400 }) })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])

  const failure = assertRefusal(await app.request('session-1'), 'POLICY_LIMITS_UNAVAILABLE')
  assert.equal(failure.failure?.retryDisposition, 'forbid', 'the terminal read keeps its prohibition')
  assert.equal(app.policy.calls.length, 1, 'a terminal status is not retried')
  await app.dispose()
})

test('the organization pin validates only when the accepted policy states one, and a mismatch is a hard stop', async () => {
  const noPin = await mount({ policy: () => Response.json({ restrictions: {} }) })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
  assertWireReached(await noPin.request('session-1'))
  assert.equal(noPin.org.calls.length, 0, 'a policy that states no pin sends no validation')
  await noPin.dispose()

  const matched = await mount({
    policy: () => Response.json({ restrictions: {} }),
    settings: () => Response.json({ uuid: 'settings-2', checksum: 'checksum-2', settings: { forceLoginOrgUUID: 'org-1' } }),
  })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
  assertWireReached(await matched.request('session-1'))
  assert.equal(matched.org.calls.length, 1, 'a stated pin is validated before the first wire request')
  assert.equal(matched.org.calls[0]?.method, 'POST')
  // The judgment is remembered by the pin's own revision and the account's identity: a second
  // request of the same session does not re-send it.
  assertWireReached(await matched.request('session-1'))
  assert.equal(matched.org.calls.length, 1, 'an unchanged pin and identity are not re-validated')
  await matched.dispose()

  const mismatched = await mount({
    policy: () => Response.json({ restrictions: {} }),
    org: () => Response.json({ organization_uuid: 'org-9' }),
    settings: () => Response.json({ uuid: 'settings-3', checksum: 'checksum-3', settings: { forceLoginOrgUUID: 'org-1' } }),
  })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
  const refused = assertRefusal(await mismatched.request('session-1'), 'POLICY_ORG_PIN_REFUSED')
  // The hard stop is what keeps the Host from retrying the turn and the pool from moving the
  // request onto an account that cannot satisfy the organization this one's policy pinned.
  assert.equal(refused.failure?.retryDisposition, 'forbid')
  assert.equal(mismatched.org.calls.length, 1, 'the mismatch is a stated answer, not a missing one')
  await mismatched.dispose()

  const invalid = await mount({
    policy: () => Response.json({ restrictions: {} }),
    settings: () => Response.json({ uuid: 'settings-4', checksum: 'checksum-4', settings: { forceLoginOrgUUID: [] } }),
  })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
  // A present-but-unusable pin is refused before the validation: the settings document that
  // states it cannot be applied, so the account is not served and no request is sent.
  assertRefusal(await invalid.request('session-1'), 'POLICY_INVALID_VALUE')
  assert.equal(invalid.org.calls.length, 0, 'a present-but-unusable pin is refused without a request')
  await invalid.dispose()

  // A restored policy states no pin at all, which is not the same fact as "no pin in force":
  // the account is refused until a fresh read states it again, and nothing is validated.
  const restored = await mount({
    policy: () => Response.json({ restrictions: {} }),
    seed: () => {
      seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
      seedRestoredPolicy('acct-1')
    },
  })
  const unverified = assertRefusal(await restored.request('session-1'), 'POLICY_ORG_PIN_REFUSED')
  assert.equal(unverified.failure?.retryDisposition, 'forbid')
  assert.equal(restored.org.calls.length, 0, 'an unknown pin sends no validation')
  await restored.dispose()
})

test('the guard enforces the verdicts through the Host registry, and a similar name is not the capability', async () => {
  // An adopted empty document constrains nothing at all.
  const empty = await mount({ policy: () => Response.json({ restrictions: {} }) })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
  assertWireReached(await empty.request('session-a'))
  assert.equal((await empty.execute('session-never', 'host_probe')).isError, false, 'an unattributed session is untouched')
  assert.equal((await empty.execute('session-a', 'host_probe')).isError, false)
  assert.equal(empty.runs('host_probe'), 2)
  // The document the owner adopted reached the store this plugin injected for it, so a
  // restart starts from the same projection instead of an empty one.
  const { readFileSync } = await import('node:fs')
  const persisted = readFileSync(join(process.env.DSH_HOME!, 'plugins', 'subscriptions', 'claude-policy-limits.json'), 'utf8')
  assert.ok(persisted.includes('acct-1'), 'the adopted document is stored under the plugin\'s own home')
  await empty.dispose()

  // A web-fetch refusal reaches exactly the capability the Host registered under that name.
  // The catalogue fetch, the send-file capability, the repository probe and the transcript
  // scans have consumers outside this provider, so their refusals stop no Host tool here.
  const webFetch = await mount({
    policy: () => Response.json({
      restrictions: {
        allow_web_fetch: { allowed: false },
        allow_model_catalog: { allowed: false },
        allow_send_file: { allowed: false },
        allow_repo_visibility_probe: { allowed: false },
        allow_stats_transcript_scan: { allowed: false },
      },
    }),
  })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
  assertWireReached(await webFetch.request('session-a'))
  const webRefusal = await webFetch.executeMessage('session-a', 'web_fetch')
  assert.ok(webRefusal?.includes('POLICY_LIMITS_UNSUPPORTED'), `the refusal names its code: ${String(webRefusal)}`)
  assert.ok(webRefusal?.includes('allow_web_fetch'))
  assert.equal(webFetch.runs('web_fetch'), 0, 'the web-fetch capability is refused')
  assert.equal((await webFetch.execute('session-a', 'fetch_web')).isError, false,
    'a tool with a similar name is not the web-fetch capability')
  assert.equal((await webFetch.execute('session-a', 'host_probe')).isError, false,
    'the keys whose consumers live outside this provider stop no Host tool')
  assert.equal(webFetch.runs('fetch_web') + webFetch.runs('host_probe'), 2)
  await webFetch.dispose()

  // An unknown key the provider stated is refused conservatively over the operations this
  // build cannot place — a deliberate difference from the pinned client's own consumer set,
  // which has no way to state that reach.
  const unknown = await mount({
    policy: () => Response.json({ restrictions: { allow_something_new: { allowed: false } } }),
  })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
  // The same conservative answer refuses this plugin's own model request when it is sent
  // under that document: an unknown restriction is never read as permission. The key the
  // provider stated is remote text, so the refusal names the fixed placeholder instead.
  assertRefusal(await unknown.request('session-a'), 'POLICY_LIMITS_UNSUPPORTED')
  const unknownRefusal = await unknown.executeMessage('session-a', 'host_probe')
  assert.ok(unknownRefusal?.includes('unsupported_policy_key'), `the refusal names the placeholder: ${String(unknownRefusal)}`)
  assert.equal(unknown.runs('host_probe'), 0, 'the tool body never ran')
  await unknown.dispose()

  // A non-empty `defaults` map is a provider answer this build does not translate into a
  // blanket refusal: it neither stops the document nor blocks an ordinary Host tool.
  const defaults = await mount({
    policy: () => Response.json({ restrictions: {}, defaults: { remote_control_at_startup: true } }),
  })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
  assertWireReached(await defaults.request('session-a'))
  assert.equal((await defaults.execute('session-a', 'host_probe')).isError, false)
  assert.equal(defaults.runs('host_probe'), 1)
  await defaults.dispose()

  // An accepted settings document this build cannot apply blocks every operation of the
  // attributed session, because the guard refuses what it cannot prove unaffected.
  const unsupportedSettings = await mount({
    policy: () => Response.json({ restrictions: {} }),
    settings: () => Response.json({ uuid: 's', checksum: 'c', settings: { somethingNew: true } }),
  })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
  assert.ok((await unsupportedSettings.request('session-a')) instanceof Error, 'the readiness seam refused the request')
  const settingsRefusal = await unsupportedSettings.executeMessage('session-a', 'host_probe')
  assert.ok(settingsRefusal?.includes('POLICY_UNSUPPORTED'), `the refusal names the blocker: ${String(settingsRefusal)}`)
  assert.equal(unsupportedSettings.runs('host_probe'), 0, 'the tool body never ran under an unappliable policy')
  await unsupportedSettings.dispose()

  // A committed request on another provider retires this session's Claude attribution.
  const other = await mount({ policy: () => Response.json({ restrictions: {} }) })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
  assertWireReached(await other.request('session-a'))
  await other.requestOtherProvider('session-a')
  assert.equal((await other.execute('session-a', 'host_probe')).isError, false, 'the retired session keeps its tools')
  await other.dispose()
})

test('a request that names no session is judged and starts no background owner', async () => {
  const app = await mount({ policy: () => Response.json({ restrictions: {} }) })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])

  // The session-less request still reads the document it must be judged by.
  assertWireReached(await app.request())
  assert.equal(app.policy.calls.length, 1, 'a session-less request performs the bounded read')
  // Its binding is request-scoped: the next session-less request reads again rather than
  // inheriting a background owner that would keep a cadence alive for nobody.
  assertWireReached(await app.request())
  assert.equal(app.policy.calls.length, 2, 'the request-scoped binding was released, so no state was reused')

  // A document that states an unknown key refuses this plugin's own model request too: the
  // conservative answer is never read as permission, and the failure text stays silent.
  const denied = await mount({ policy: () => Response.json({ restrictions: { allow_something_new: { allowed: true } } }) })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
  assertRefusal(await denied.request(), 'POLICY_LIMITS_UNSUPPORTED')
  await denied.dispose()
  await app.dispose()
})

test('a two-account pool does not move a refused request onto the other account', async () => {
  const app = await mount({
    policy: () => Response.json({ restrictions: {} }),
    org: () => Response.json({ organization_uuid: 'org-9' }),
    settings: () => Response.json({ uuid: 'settings-p', checksum: 'checksum-p', settings: { forceLoginOrgUUID: 'org-1' } }),
    pool: {
      enabled: true,
      strategy: 'priority',
      families: {
        [MODEL.id]: [
          { provider: 'claude', account: 'acct-1', model: MODEL.id },
          { provider: 'claude', account: 'acct-2', model: MODEL.id },
        ],
      },
    },
  })
  seedStore([
    { key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' },
    { key: 'acct-2', subscriptionType: null, accountUuid: 'uuid-2' },
  ])
  const failure = await app.request('session-1')
  const refused = assertRefusal(failure, 'POLICY_ORG_PIN_REFUSED')
  assert.equal(refused.failure?.retryDisposition, 'forbid')
  assert.equal(app.org.calls.length, 1, 'the refused account is not replaced by another one')
  assert.equal(app.policy.calls.length, 1, 'the other account was never read')
  await app.dispose()
})

test('an unknown policy key is refused without letting its text reach a model, a log or the status', async () => {
  // A provider-stated key is remote text: it could echo a credential, a prompt fragment or an
  // instruction. The denial must survive, and the text must not cross any boundary this
  // plugin owns — the model-facing tool error, the request failure or the status projection.
  const secret = 'synthetic TOKEN=do-not-echo'
  const app = await mount({ policy: () => Response.json({ restrictions: { [secret]: { allowed: false } } }) })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
  // The request itself is refused by the same conservative answer; the attribution its
  // readiness recorded before that decision still judges this session's tool calls.
  assertRefusal(await app.request('session-a'), 'POLICY_LIMITS_UNSUPPORTED')

  const refusal = await app.executeMessage('session-a', 'host_probe')
  assert.ok(refusal?.includes('unsupported_policy_key'), `the refusal names the placeholder: ${String(refusal)}`)
  assert.ok(!refusal?.includes(secret), 'the model-facing refusal never quotes the provider key')
  assert.equal(app.runs('host_probe'), 0, 'the unknown key still refused the call')
  const status = JSON.stringify(await app.status())
  assert.ok(!status.includes(secret), 'the status projection reports a count, never the key')
  await app.dispose()

  // Under a document that states it as allowed, this plugin's own model request is refused by
  // the same conservative answer, and the failure text is equally silent about the key.
  const model = await mount({ policy: () => Response.json({ restrictions: { [secret]: { allowed: true } } }) })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
  const failure: unknown = await model.request('session-a')
  assert.ok(failure instanceof LlmError, `the request was refused: ${String(failure)}`)
  assert.equal(failure.code, 'POLICY_LIMITS_UNSUPPORTED')
  const text = `${failure.message}\n${errorChain(failure)}`
  assert.ok(!text.includes(secret), 'the request refusal never quotes the provider key')
  assert.ok(text.includes('unsupported_policy_key'), `the refusal names the placeholder: ${text}`)
  await model.dispose()
})

test('a confirmed HIPAA taint supplies the engine policy without blocking the profile', async () => {
  // The callback's source is the account's own adopted document, and nothing about it is a
  // server statement: the taint-bearing document is adopted, the ordinary request it governs is
  // still built and sent, no shared protocol block is written, and the next top-level-system
  // request is sent too. The beta-withholding decision itself and the local mid-role refusal are
  // the adapter's own covered cases, so they are not duplicated here.
  const app = await mount({
    policy: () => Response.json({ restrictions: {}, compliance_taints: ['hipaa'] }),
  })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
  assertWireReached(await app.request('session-hips'))
  const claude = await app.status()
  const accounts = claude['accounts'] as { policyLimits?: { state: string } }[]
  assert.equal(accounts[0]?.policyLimits?.state, 'current', 'the taint-carrying document was adopted')

  // A local policy decision never reaches the shared protocol-block store: the profile stays
  // usable for every account, and the next request is still sent.
  const blockDirectory = join(process.env.DSH_HOME!, 'plugins', 'subscriptions', 'claude-protocol-blocks')
  const records = existsSync(blockDirectory)
    ? readdirSync(blockDirectory).filter(name => name.endsWith('.json'))
    : []
  assert.deepEqual(records, [], 'a local policy writes no shared protocol block')
  assertWireReached(await app.request('session-hips'))
  assert.equal(app.policy.calls.length, 1, 'the confirmed state is reused, not re-read')
  await app.dispose()
})

test('the owner\'s normalized notice reaches the status dimension, and nothing raw does', async () => {
  // The notice is the third projection input: index passes the owner's own fresh, normalized
  // DTO, so the client renders text the provider stated without this plugin ever handing over
  // the adopted document, a taint value or a key name.
  const app = await mount({
    policy: () => Response.json({
      restrictions: {},
      compliance_taints: ['hipaa'],
      defaults: { remote_control_at_startup: true },
      monitoring_notice: { text: 'synthetic notice text', url: 'https://example.com/notice' },
    }),
  })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])
  assertWireReached(await app.request('session-notice'))
  const claude = await app.status()
  const accounts = claude['accounts'] as {
    policyLimits?: { notice?: boolean; noticeContent?: { text: string; url?: string }; taints?: unknown }
  }[]
  const limits = accounts[0]?.policyLimits
  assert.equal(limits?.notice, true, 'the notice presence is reported')
  assert.equal(limits?.noticeContent?.text, 'synthetic notice text')
  assert.equal(limits?.noticeContent?.url, 'https://example.com/notice')
  // The taint list and the defaults map stay on the host: only counts and the notice cross.
  assert.equal(limits?.taints, undefined)
  assert.ok(limits !== undefined && !Object.hasOwn(limits, 'defaults'), 'no document member crosses')
  await app.dispose()
})

test('disposal waits for a held policy response, cancels it, and adopts nothing behind it', async () => {
  let aborted = false
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  const reached = new Promise<void>((resolve) => { entered = resolve })
  const events: string[] = []
  const app = await mount({
    policy: (call) => new Promise<Response>((resolve) => {
      // The response is built only once the case releases it, so the read is held across
      // disposal. Nothing here resolves on the abort: disposal must wait for the release.
      events.push('requested')
      entered?.()
      call.signal.addEventListener('abort', () => { aborted = true; events.push('aborted') }, { once: true })
      release = () => {
        events.push('released')
        resolve(Response.json({ restrictions: {} }))
      }
    }),
  })
  seedStore([{ key: 'acct-1', subscriptionType: null, accountUuid: 'uuid-1' }])

  const pending = app.request('session-1')
  // Wait for the request to reach the held read before disposal starts: the readiness before it
  // is local but asynchronous. Nothing here waits on a timer or a fixed number of turns.
  await reached
  assert.deepEqual(events, ['requested'], 'the request is reading its policy document')

  const disposal = app.dispose().then(() => { events.push('disposed') })
  // Disposal cannot report completion while the read it started still holds its response: it
  // aborts the read, and the read settles before disposal does.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(aborted, true, 'disposal cancelled the held read')
  release?.()
  await disposal
  await pending
  assert.deepEqual(events, ['requested', 'aborted', 'released', 'disposed'],
    'the abort precedes the release, and disposal settles after both')

  // Nothing was adopted behind the cancellation: the durable limits store holds no record.
  const state = join(process.env.DSH_HOME!, 'plugins', 'subscriptions', 'claude-policy-limits.json')
  let text: string | undefined
  try {
    const { readFileSync } = await import('node:fs')
    text = readFileSync(state, 'utf8')
  } catch {
    text = undefined
  }
  assert.ok(text === undefined || !text.includes('acct-1'), 'a superseded read persists no record')
})
