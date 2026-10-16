/**
 * Managed-policy enforcement through the Host's own tool registry, over the plugin's real
 * wiring: the durable maintenance state, the shared hydration every request awaits, and the
 * execution-stage guard.
 *
 * What this spec owns, and what it cannot:
 * - The real `ToolRuntime` runs a synthetic Host-owned tool whose body counts invocations,
 *   so "refused" is observed as the body never running, not as a returned code.
 * - A restriction a previous run stored in the plugin's own home refuses the tool on the
 *   next start, with no provider request anywhere in the composition.
 * - Reading status reports the hydrated state and does not fail, while the composition has
 *   no egress at all: any attempted provider call would surface as a failure instead of
 *   passing silently.
 * No network is involved by construction: catalog discovery is off, every account's
 * protocol configuration is blocked in the plugin's own store, and no server is started.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '../src/compat.js'
import type { Config, ModelEntry } from '../src/index.js'

// Private harness home before any plugin module is imported.
const home = mkdtempSync(join(tmpdir(), 'claude-executor-spec-'))
process.env.DSH_HOME = home

const { CLAUDE_DEFAULT_ORIGIN } = await import('../src/providers/claude-maintenance.js')
const { CLAUDE_PROTOCOL_PROFILE, claudeProtocolFingerprint } = await import('../src/providers/claude-protocol.js')
const { createFakeConnection } = await import('./fake-connection.js')

const FINGERPRINT = claudeProtocolFingerprint(CLAUDE_PROTOCOL_PROFILE)
const MODEL: ModelEntry = {
  id: 'claude-opus-5',
  name: 'Claude Opus 5',
  contextWindow: 200_000,
  maxTokens: 8_192,
  inputModalities: ['text'],
  wire: 'responses',
}
/** The agent identity one tool execution carries; the registry reads exactly these fields. */
type ExecutionAgent = NonNullable<ToolExecutionInput['agent']>
/** A committed request's session id, branded the way the llm service declares it. */
const llmSessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>
/** The execution identity for one session; the plugin's specs build these with a local cast. */
const executionAgent = (sessionId: string): ExecutionAgent =>
  ({ id: sessionId, session: { id: sessionId } }) as ExecutionAgent

/** One stored account. Nothing here reaches the provider: the accepted policy refuses first. */
function seedStore(): void {
  const directory = join(home, 'plugins', 'subscriptions')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'auth.json'), JSON.stringify({
    claude: {
      default: 'acct-1',
      accounts: {
        'acct-1': {
          accessToken: 'test-access-token',
          refreshToken: 'test-refresh-token',
          expiresAt: Date.now() + 3_600_000,
          accountUuid: 'uuid-1',
          emailAddress: 'user@example.com',
        },
      },
    },
  }), { mode: 0o600 })
}

/**
 * Store the maintenance state a previous run left behind: one account whose accepted remote
 * policy carries a tool restriction this build cannot enforce exactly, which must keep
 * refusing rather than disappear. The stored form is the plugin's own projected vocabulary —
 * the remote document itself is never persisted.
 */
function seedStoredPolicy(): void {
  const directory = join(home, 'plugins', 'subscriptions')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'claude-maintenance.json'), JSON.stringify({
    version: 1,
    accounts: [{
      account: 'acct-1',
      origin: CLAUDE_DEFAULT_ORIGIN,
      protocolFingerprint: FINGERPRINT,
      policy: {
        checksum: 'checksum-1',
        revision: 'revision-1',
        acceptedAt: 1,
        keys: [{ key: 'permissions', scope: 'tool', disposition: 'blocked', detail: 'tool permission rules' }],
        blockers: [{ key: 'permissions', scope: 'tool', code: 'POLICY_UNSUPPORTED', detail: 'tool permission rules' }],
        enforced: false,
      },
    }],
  }), { mode: 0o600 })
}

/** The mounted composition plus the facts the cases assert on. */
interface Composition {
  status: () => Promise<Record<string, unknown>>
  logout: () => Promise<void>
  attribute: (sessionId: string) => Promise<void>
  execute: (sessionId: string, callId: string) => Promise<{ isError: boolean }>
  /** Drive one committed model request through the registered `llm/stream` waterfall. */
  streamOtherProvider: (sessionId: string) => Promise<number>
  runs: () => number
  dispose: () => Promise<void>
}

/** One tool execution on behalf of a session; each call carries its own identity. */
let callSequence = 0
function call(app: Composition, sessionId: string): Promise<{ isError: boolean }> {
  callSequence += 1
  return app.execute(sessionId, `call-${String(callSequence)}`)
}

/**
 * Mount the real tool registry, the plugin, a fake host connection and one synthetic
 * Host-owned tool.
 * @param options - `policyDenies` installs the deterministic decision hook; omitted leaves
 *   the plugin reading the live accepted policy.
 */
async function mount(options: { policyDenies?: () => boolean } = {}): Promise<Composition> {
  const { Context } = await import('@deepseek-ai/cordis')
  const ToolRuntime = (await import('@deepseek-ai/dsh-tools')).default
  const plugin = await import('../src/index.js')
  const ctx = new Context()
  // The registry's only service dependency; the schema wiring is never invoked here.
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
  const deny = options.policyDenies
  const config: Config = {
    providers: ['claude'],
    models: { claude: [MODEL] },
    // The pool is not part of what this spec verifies, and a pool member's holdback check
    // may read usage state; the direct route needs neither.
    pool: { enabled: false },
  }
  const internals = deny === undefined ? {} : {
    toolPolicyDecision: () => deny()
      ? { decision: 'deny' as const, code: 'POLICY_UNSUPPORTED' }
      : { decision: 'allow' as const },
  }
  // The Loader calls `apply(ctx, config)`; a test supplies the deterministic hooks by
  // invoking it with them, as its sibling packages' specs do.
  await ctx.plugin(Object.assign(
    (inner: import('@deepseek-ai/cordis').Context) => { plugin.apply(inner, config, internals) },
    { inject: plugin.inject },
  ))
  let runs = 0
  ctx.tools.register({
    name: 'host_probe',
    description: 'a Host-owned tool the policy may refuse',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: () => { runs += 1; return Promise.resolve('ran') },
  })
  const signal = new AbortController().signal
  return {
    status: async () => {
      const result = await fake.handler('status', {}, signal)
      assert.ok(result.ok, 'the status call succeeds')
      const providers = (result.value as { providers: Record<string, Record<string, unknown>> }).providers
      return providers['claude']!
    },
    logout: async () => {
      const result = await fake.handler('logout', { provider: 'claude', account: 'acct-1' }, signal)
      assert.deepEqual(result, { ok: true, value: { ok: true } })
    },
    attribute: async (sessionId) => {
      assert.ok(route !== undefined, 'the plugin registered its Claude route')
      // The real bound route, driven once: readiness refuses on the stored protocol block,
      // and the session is attributed to the account before that decision.
      const stream = route.stream({
        provider: 'claude',
        model: MODEL.id,
        messages: [],
        sessionId: llmSessionId(sessionId),
        signal: new AbortController().signal,
      })
      // The stored accepted policy refuses inside the pre-request seam, before any profile
      // or settings read and before any request is assembled.
      await assert.rejects((async () => { for await (const chunk of stream) void chunk })())
    },
    execute: (sessionId, callId) => ctx.tools.execute({
      callId: ToolCallId(callId),
      name: 'host_probe',
      arguments: {},
      agent: executionAgent(sessionId),
      signal: new AbortController().signal,
    }) as Promise<{ isError: boolean }>,
    runs: () => runs,
    streamOtherProvider: async (sessionId) => {
      // The same dispatch the llm service performs for a committed request: the registered
      // `llm/stream` waterfall runs the plugin's listener before the terminal stream.
      const chunks = ctx.waterfall('llm/stream', {
        provider: 'codex',
        model: 'gpt-5.1',
        messages: [],
        sessionId: llmSessionId(sessionId),
        signal: new AbortController().signal,
      }, (): AsyncIterable<StreamChunk> => (async function* () {
        const terminal: StreamChunk[] = [
          { type: 'text-delta', index: 0, text: 'hello' },
          { type: 'finish', reason: { kind: 'stop' } },
        ]
        for (const chunk of terminal) yield chunk
      })())
      let seen = 0
      for await (const chunk of chunks) { void chunk; seen += 1 }
      return seen
    },
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

test('the Host tool body does not run while the policy refuses, and runs once it is empty', async () => {
  seedStore()
  seedStoredPolicy()
  let denies = true
  const app = await mount({ policyDenies: () => denies })
  await app.attribute('session-a')

  const refused = await call(app, 'session-a')
  assert.equal(refused.isError, true, 'the registry refused the call')
  assert.equal(app.runs(), 0, 'the tool body never ran')

  // The policy the account is judged by no longer carries a restriction.
  denies = false
  const ran = await call(app, 'session-a')
  assert.equal(ran.isError, false)
  assert.equal(app.runs(), 1, 'the same call runs once the policy is empty')

  // Another session never routed to the account, so it is untouched while the policy refuses.
  denies = true
  const other = await call(app, 'session-b')
  assert.equal(other.isError, false)
  assert.equal(app.runs(), 2, 'only the bound session is affected')
  await app.dispose()
})

test('a committed request on another provider releases that session\'s Claude account, and no other', async () => {
  seedStore()
  seedStoredPolicy()
  const app = await mount()
  await app.attribute('session-a')
  await app.attribute('session-b')

  // Both sessions are judged by the account's stored restriction.
  assert.equal((await call(app, 'session-a')).isError, true)
  assert.equal((await call(app, 'session-b')).isError, true)
  assert.equal(app.runs(), 0)

  // The waterfall delegates the stream unchanged and releases session-a only. The release
  // effect is what this composition can observe: a served binding needs a Claude request
  // that reaches the provider, which this offline composition never sends.
  assert.equal(await app.streamOtherProvider('session-a'), 2, 'the terminal stream still arrives')

  assert.equal((await call(app, 'session-a')).isError, false, 'the released session runs its tools again')
  assert.equal(app.runs(), 1)
  assert.equal((await call(app, 'session-b')).isError, true, 'the other session keeps its account policy')
  assert.equal(app.runs(), 1)
  await app.dispose()
})

test('a restriction the previous run stored still refuses, with no provider request', async () => {
  seedStore()
  seedStoredPolicy()
  // No decision hook: this is the real accepted policy, hydrated from disk.
  const app = await mount()
  await app.attribute('session-a')

  const refused = await call(app, 'session-a')
  assert.equal(refused.isError, true, 'the stored restriction still refuses')
  assert.equal(app.runs(), 0, 'the tool body never ran')
  // The restored snapshot was used as it was: the refusal did not come from a fresh read.
  const claude = await app.status()
  const accounts = claude['accounts'] as { policy?: { state: string; fetchedAt?: number } }[]
  assert.equal(accounts[0]?.policy?.fetchedAt, 1, 'the accepted policy was not re-fetched')
  await app.dispose()
})

test('reading status reports the hydrated restriction and starts no upstream work', async () => {
  seedStore()
  seedStoredPolicy()
  const app = await mount()
  // The account is known to the store; the status read must report the restriction the
  // previous run stored instead of an empty projection.
  const claude = await app.status()
  const accounts = claude['accounts'] as { key: string; policy?: { state: string; code?: string } }[]
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0]?.policy?.state, 'blocked')
  assert.equal(accounts[0]?.policy?.code, 'POLICY_UNSUPPORTED')

  // Logging out drops that account's maintenance state: the retired restriction is not
  // restored for the next account or session.
  await app.logout()
  const after = await app.status()
  assert.deepEqual(after['accounts'], [])
  await app.dispose()
})
