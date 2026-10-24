/**
 * The Claude account lifecycle over the plugin's real composition.
 *
 * A permanently refused grant no longer deletes the account: it parks the credential as needing
 * re-authentication, and only the explicit logout runs an identity change for the account. These
 * cases cover both, plus the identity gate every credential mutation runs behind.
 *
 * Fixture contract. Every case mounts the real apply chain over a private home: the real
 * `SessionStore` and `SessionRequestRecordProvider` the Claude route registers under, the real
 * account token manager, maintenance owner, continuation state and RPC endpoints. Only the
 * network-shaped inputs a deployment injects are stated — the Messages transport, the two read
 * transports, and the reader of Claude Code's own credential store, which answers nothing so no
 * external source is ever consulted. Root disposal is driven by the real fiber. The observers are
 * public too: the plugin's own auth file, the continuation identity-generation document, the fake
 * connection's RPC results, and whether disposal returns.
 *
 * The token endpoint's one answer is supplied by an in-memory stub: the process global `fetch` is
 * replaced for the case and answers exactly `CLAUDE_TOKEN_URL` with a synthetic `invalid_grant`,
 * refusing every other URL. The real grant code path runs against that stub, and no request leaves
 * the process.
 *
 * Not covered here, and not claimed: the pending window inside the gate. Nothing injectable holds
 * a change's release and publication open, so no case observes `pending: { kind: 'active' }`.
 * One negative case states the request's own refusal when its span state cannot be read, and
 * another states the refusal of a request cancelled while another holder keeps that state's lock;
 * a held lock itself is waited out rather than refused, and that wait is a case below.
 * The gate's remaining refusal branches are not reachable from public state deterministically, and
 * no case fakes one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RpcResult } from '../src/compat.js'
import type { Config, ModelEntry } from '../src/index.js'
import type { ClaudeSession } from '../src/auth/store.js'
import { getAccountCredential, saveAccountSession } from '../src/auth/store.js'
import { CLAUDE_TOKEN_URL, deriveClaudeDeviceId } from '../src/providers/claude.js'
import { LOCAL_CONTINUATION_STATE_UNAVAILABLE } from '../src/providers/claude-continuation-io.js'
import { CLAUDE_PROTOCOL_PROFILE } from '../src/providers/claude-protocol.js'

/** The account this file stores: its own key and the identity the provider reports for it. */
const ACCOUNT = 'continuation-integration@example.invalid'
/** The UUID the stored credential confirms, so the route's identity backfill never runs. */
const ACCOUNT_UUID = '00000000-0000-4000-8000-0000000000c2'
/** The credential the seeded account holds. Synthetic, and never sent anywhere. */
const ACCESS_TOKEN = 'synthetic-continuation-access'
/** The refresh token the one controlled grant carries. Synthetic, and never printed. */
const REFRESH_TOKEN = 'synthetic-continuation-refresh'
/** The credential a concurrent re-login stores while the grant is in flight. */
const WINNER_ACCESS_TOKEN = 'synthetic-continuation-winner'

/**
 * The credential timer's lead and floor, stated so the first request arms the floor.
 *
 * The lead is far beyond the seeded credential's life, so `expiresAt - refreshLeadMs` is already
 * past and the delay is `minRefreshDelayMs`; the floor is well inside the case timeout, so the
 * real timer is bounded by configuration rather than by a wait the test invents.
 */
const REFRESH_LEAD_MS = 7_200_000
const MIN_REFRESH_DELAY_MS = 1_000

/** The one catalog entry every case serves, so no discovery request is ever assembled. */
const MODEL: ModelEntry = {
  id: 'claude-opus-5',
  name: 'Claude Opus 5',
  contextWindow: 200_000,
  maxTokens: 8_192,
  inputModalities: ['text'],
  wire: 'responses',
}

/** The user turn every committed request carries; text only, so no attachment service is needed. */
const MESSAGES = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]

/** The pinned Messages endpoint, so the transport answers exactly this origin and pathname. */
const MESSAGES_ENDPOINT = new URL(CLAUDE_PROTOCOL_PROFILE.endpoints.messages)

/** One completed text turn, the shape the adapter's translator accepts. */
const RESPONSE_SSE = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"recorded"}}\n\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'data: {"type":"message_stop"}\n\n',
].join('')

/** A committed request's session id, branded the way the llm service declares it. */
const llmSessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

/** One request a transport saw. Only the URL and method are kept: a grant body carries a token. */
interface WireCall {
  readonly url: string
  readonly method: string
}

/**
 * The process-global transport one case owns while it is mounted.
 *
 * The counters are this file's own and hold no provider text. `reached` is the readiness signal
 * for the one controlled token answer: it resolves when the endpoint is called, never after a wait.
 */
interface Wire {
  /** The token-endpoint requests the stub answered, in order. */
  readonly tokenCalls: WireCall[]
  /** The requests the stated transports refused, in order; must stay empty. */
  readonly refused: WireCall[]
  /** Managed-settings or organization reads the refusing transports were asked for; must stay 0. */
  policyReads: number
  /** Resolves the moment the token endpoint is reached. */
  reached: Promise<void>
  /** Whether the token answer waits for {@link Wire.release} instead of answering at once. */
  holdToken: boolean
  /** Release a held token answer. Idempotent, so cleanup may call it whether or not it was held. */
  release: () => void
  /** Put the process global back exactly as it was. */
  restore: () => void
}

/** One account's persisted identity-generation record, as this plugin writes it. */
interface GenerationEntry {
  readonly generation: number
  readonly baseline: boolean
  readonly reason: string
  readonly pending: { readonly kind: string; readonly change?: string } | null
  readonly advancedAt: string
}

/** One mounted composition, with the facts each case asserts on. */
interface Composition {
  /** The global transport this case owns. */
  readonly wire: Wire
  /** The Messages requests the injected transport answered, in order. */
  readonly messages: () => readonly WireCall[]
  /**
   * Drive one committed Claude request through the registered route and return its chunks.
   * @param sessionId - the harness session the request belongs to.
   * @param signal - the caller's own cancellation, when the case exercises one.
   * @returns the chunks the route produced.
   */
  request: (sessionId: string, signal?: AbortSignal) => Promise<StreamChunk[]>
  /** Drive the real `logout` endpoint for this account. */
  logout: () => Promise<RpcResult<unknown>>
  /** Drive the real `status` endpoint for the claude provider. */
  status: () => Promise<Record<string, unknown>>
  /** The account records the plugin's own store holds, read from disk. */
  accounts: () => readonly Record<string, unknown>[]
  /** The persisted identity-generation records, read from the document the plugin wrote. */
  generation: () => readonly GenerationEntry[]
  /** Move the stored credential into the past, as the test arranges an expiry. */
  expire: () => Promise<void>
  /** Store a same-account replacement credential, as a concurrent re-login would. */
  rotate: () => Promise<void>
  /** Dispose the composition; a gate that never settled would hang here. */
  dispose: () => Promise<void>
}

/**
 * Replace the process global `fetch` for one case.
 *
 * Exactly `CLAUDE_TOKEN_URL` is answered, with a synthetic permanent refusal; every other URL
 * throws, so no other provider request can leave unnoticed. The request body is never read and
 * never printed: it carries the grant. The descriptor is captured before the replacement and
 * returned as one restoration.
 * @returns the wire the case owns, whose `release` is idempotent.
 */
function installFetchGuard(): Wire {
  let announce!: () => void
  let release!: () => void
  const reached = new Promise<void>(resolve => { announce = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  const wire: Wire = {
    tokenCalls: [],
    refused: [],
    policyReads: 0,
    reached,
    holdToken: false,
    release: () => { release() },
    restore: () => {
      if (previous === undefined) Reflect.deleteProperty(globalThis, 'fetch')
      else Object.defineProperty(globalThis, 'fetch', previous)
    },
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    if (url === CLAUDE_TOKEN_URL) {
      wire.tokenCalls.push({ url, method })
      announce()
      if (wire.holdToken) await held
      return new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'synthetic: the refresh grant was revoked',
      }), { status: 400, headers: { 'content-type': 'application/json' } })
    }
    wire.refused.push({ url, method })
    throw new Error(`this case performs no request other than the token endpoint (${method} ${url})`)
  }) as typeof fetch
  return wire
}

/** The identity-generation document's path under one private home. */
function generationPath(home: string): string {
  return join(home, 'plugins', 'subscriptions', 'claude-continuation', 'identity-generation.json')
}

/**
 * Parse the identity-generation document.
 *
 * A document this build does not write is refused rather than read as an empty one: a caller
 * waiting for a baseline must never mistake a damaged record for "nothing established yet".
 * @param text - the document's own text.
 * @returns the records it holds.
 * @throws Error when the text is not one of this build's documents.
 */
function parseGeneration(text: string): readonly GenerationEntry[] {
  const document: unknown = JSON.parse(text)
  if (typeof document !== 'object' || document === null) {
    throw new Error('the identity-generation document is not one this build writes')
  }
  const accounts = (document as { accounts?: unknown }).accounts
  if (!Array.isArray(accounts)) {
    throw new Error('the identity-generation document states no account list')
  }
  return accounts as readonly GenerationEntry[]
}

/** The persisted identity-generation records, read from the document the plugin wrote. */
function generationOf(home: string): readonly GenerationEntry[] {
  const path = generationPath(home)
  if (!existsSync(path)) return []
  return parseGeneration(readFileSync(path, 'utf8'))
}

/**
 * Wait until the account's own baseline record is durable.
 *
 * The startup hydration is background work the mount does not await, so the document appears at
 * its own pace: this reads the public file until it states the baseline row (generation 0, marked
 * baseline, no pending statement). A file absent for one read is the write path's atomic rename,
 * so it is re-read; every other failure, including text this build does not write, is reported
 * rather than waited on.
 * @param home - the private harness home this composition reads and writes.
 * @returns the durable baseline record.
 */
async function waitForBaseline(home: string): Promise<GenerationEntry> {
  const bound = Date.now() + 20_000
  while (true) {
    const path = generationPath(home)
    let text: string | undefined
    try {
      text = existsSync(path) ? readFileSync(path, 'utf8') : undefined
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      text = undefined
    }
    if (text !== undefined && text !== '') {
      const baseline = parseGeneration(text)
        .find(entry => entry.baseline === true && entry.generation === 0 && entry.pending === null)
      if (baseline !== undefined) return baseline
    }
    assert.ok(Date.now() <= bound, 'the account baseline was never established')
    await new Promise<void>(resolve => { setTimeout(resolve, 5) })
  }
}

/** The account records the plugin's own store holds, read from its file. */
function storedAccounts(home: string): readonly Record<string, unknown>[] {
  const path = join(home, 'plugins', 'subscriptions', 'auth.json')
  if (!existsSync(path)) return []
  const store = JSON.parse(readFileSync(path, 'utf8')) as {
    claude?: { accounts?: Record<string, Record<string, unknown>> }
  }
  return Object.values(store.claude?.accounts ?? {})
}

/**
 * Mount the plugin's real composition over one private home.
 *
 * A mount that fails after its context exists disposes that context before reporting the failure,
 * so no partially mounted composition outlives the call; a disposal failure is reported beside
 * the primary one rather than replacing it.
 * @param home - the private harness home this composition reads and writes.
 * @param wire - the global transport this case owns.
 * @returns the mounted composition.
 */
async function mount(home: string, wire: Wire): Promise<Composition> {
  process.env.DSH_HOME = home
  const { Context } = await import('@deepseek-ai/cordis')
  const SessionStore = (await import('@deepseek-ai/dsh-session')).default
  const SessionRequestRecordProvider = (await import('@deepseek-ai/dsh-llm-request-record')).default
  const { createFakeConnection } = await import('./fake-connection.js')
  const plugin = await import('../src/index.js')
  const ctx = new Context()
  const fake = createFakeConnection()
  const messageCalls: WireCall[] = []
  let route: { stream: (options: unknown) => AsyncIterable<unknown> } | undefined
  const config: Config = {
    providers: ['claude'],
    models: { claude: [MODEL] },
    pool: { enabled: false },
    claudeMaintenance: { refreshLeadMs: REFRESH_LEAD_MS, minRefreshDelayMs: MIN_REFRESH_DELAY_MS },
  }
  try {
    // `SessionStore.flush` reports a durable checkpoint only when a listener participates, and the
    // record itself is not what this file is about: its own in-memory listener is that participant.
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionRequestRecordProvider, { flushTimeoutMs: 2_000 })
    ctx.on('session/flush', () => {})
    ctx.provide('connection', fake.connection)
    ctx.provide('llm', {
      failureRecoveryVersion: 1,
      registerAdapter: (_providers: string[], adapter: { stream: (options: unknown) => AsyncIterable<unknown> }) => {
        route = adapter
        return Object.assign(() => {}, { replace: () => {} })
      },
    })
    await ctx.plugin(Object.assign(
      (inner: import('@deepseek-ai/cordis').Context) => {
        plugin.apply(inner, config, {
          // Claude Code's own credential store is never read: this installation serves the account
          // from its own store alone, so no keychain or credential file is consulted anywhere.
          claudeCredentialSource: () => undefined,
          // The one Messages transport: the pinned endpoint is answered from an in-memory body, and
          // any other request through it is refused rather than answered under this count.
          claudeMessagesFetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
            const method = init?.method ?? 'GET'
            const parsed = new URL(url)
            if (parsed.origin === MESSAGES_ENDPOINT.origin && parsed.pathname === MESSAGES_ENDPOINT.pathname) {
              messageCalls.push({ url, method })
              return new Response(RESPONSE_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
            }
            wire.refused.push({ url, method })
            throw new Error(`this case answers no other Messages endpoint (${method} ${url})`)
          },
          // The account states `max` and no profile scope, so the maintenance owner reads neither
          // managed settings nor the profile; these transports refuse rather than answering, and the
          // cases assert they were never asked.
          policyLimitsTransport: async () => {
            wire.policyReads += 1
            throw new Error('this case performs no policy_limits read')
          },
          orgPinTransport: async () => {
            wire.policyReads += 1
            throw new Error('this case performs no organization read')
          },
        })
      },
      { inject: plugin.inject },
    ))
  } catch (failure) {
    const cleanup: unknown[] = []
    try {
      await ctx.fiber.dispose()
    } catch (error: unknown) {
      cleanup.push(error)
    }
    if (cleanup.length > 0) {
      throw new AggregateError([failure, ...cleanup], 'the composition failed to mount and its disposal also failed')
    }
    throw failure
  }
  return {
    wire,
    messages: () => messageCalls,
    request: async (sessionId, signal) => {
      assert.ok(route !== undefined, 'the plugin registered its Claude route')
      const requested = llmSessionId(sessionId)
      // A case may drive the route after disposal to observe the refusal a late request produces;
      // the session service is gone then, and the state owner is what must refuse it.
      if (ctx.sessions !== undefined && ctx.sessions.get(requested) === undefined) ctx.sessions.create(requested)
      const stream = route.stream({
        provider: 'claude',
        model: MODEL.id,
        messages: MESSAGES,
        sessionId: requested,
        // Every request carries a signal: the case's own when it exercises cancellation, and an
        // un-aborted one otherwise.
        signal: signal ?? new AbortController().signal,
      })
      const chunks: StreamChunk[] = []
      for await (const chunk of stream as AsyncIterable<StreamChunk>) chunks.push(chunk)
      return chunks
    },
    logout: async () => await fake.handler('logout', { provider: 'claude', account: ACCOUNT }, new AbortController().signal),
    status: async () => {
      const result = await fake.handler('status', {}, new AbortController().signal)
      assert.ok(result.ok, 'the status call succeeds')
      const providers = (result.value as { providers: Record<string, Record<string, unknown>> }).providers
      return providers['claude']!
    },
    accounts: () => storedAccounts(home),
    generation: () => generationOf(home),
    expire: async () => {
      const current = await getAccountCredential('claude', ACCOUNT)
      assert.ok(current !== undefined, 'the account is stored before its expiry is arranged')
      const moved = await saveAccountSession('claude', ACCOUNT, {
        ...current.session,
        expiresAt: Date.now() - 1_000,
      })
      assert.equal(moved, true, 'the arranged expiry was stored')
    },
    rotate: async () => {
      const current = await getAccountCredential('claude', ACCOUNT)
      assert.ok(current !== undefined, 'the account is stored while its grant is in flight')
      const moved = await saveAccountSession('claude', ACCOUNT, {
        ...current.session,
        accessToken: WINNER_ACCESS_TOKEN,
        expiresAt: Date.now() + 36_000_000,
      })
      assert.equal(moved, true, 'the concurrent credential was stored')
    },
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

/**
 * Run one case over a private home.
 *
 * A held token answer is released first, so a case that failed before its own release still lets
 * the mount settle; the composition is then disposed, and only afterwards are the process global,
 * the environment and the private root restored. Every step runs on the failure path too.
 * @param body - the case, given the mounted composition and its private home.
 */
async function withComposition(body: (app: Composition, home: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'claude-continuation-integration-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const previousHome = process.env.DSH_HOME
  const wire = installFetchGuard()
  let app: Composition | undefined
  try {
    process.env.DSH_HOME = home
    await saveAccountSession('claude', ACCOUNT, {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: Date.now() + 3_600_000,
      scopes: 'user:inference',
      // A confirmed pro/max subscription is the maintenance owner's ineligible branch, and the
      // absent profile scope is its scope-missing branch: neither read starts.
      subscriptionType: 'max',
      accountUuid: ACCOUNT_UUID,
      // The device id this host derives for that UUID satisfies the route's identity gate, so no
      // profile backfill and no identity write happen either.
      deviceId: deriveClaudeDeviceId(`uuid:${ACCOUNT_UUID}`),
      emailAddress: ACCOUNT,
    } satisfies ClaudeSession)
    app = await mount(home, wire)
    await body(app, home)
  } finally {
    wire.release()
    try {
      await app?.dispose()
    } finally {
      wire.restore()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** The terminal reason one driven stream reached, or undefined when it never finished. */
function finishKind(chunks: readonly StreamChunk[]): string | undefined {
  const finish = chunks.find(chunk => chunk.type === 'finish')
  return finish?.type === 'finish' ? finish.reason.kind : undefined
}

/** The account's public credential dimension, as the status endpoint reports it. */
async function credentialState(app: Composition): Promise<string | undefined> {
  const claude = await app.status()
  const accounts = claude['accounts'] as { credential?: { state?: string } }[] | undefined
  return accounts?.[0]?.credential?.state
}

/**
 * Wait until an account's credential timer settles the refresh cycle to one state.
 *
 * The status endpoint is the public projection of the owner's own state, so this waits for the
 * state the cycle really reached rather than for a delay that guesses it. The bound turns a cycle
 * that never settled into a failure.
 * @param app - the mounted composition.
 * @param expected - the credential state the cycle must reach.
 */
async function waitForCredentialState(app: Composition, expected: string): Promise<void> {
  const bound = Date.now() + 20_000
  while (await credentialState(app) !== expected) {
    assert.ok(Date.now() <= bound, `the credential never settled as ${expected}`)
    await new Promise<void>(resolve => { setTimeout(resolve, 5) })
  }
}

test('a permanent refresh failure parks the account and starts no identity change', { timeout: 30_000 }, async () => {
  await withComposition(async (app, home) => {
    const baseline = await waitForBaseline(home)

    // One real send: the credential is fresh, so it completes, binds the session to the account
    // and arms the credential timer without spending the grant.
    const chunks = await app.request('session-cycle')
    assert.equal(finishKind(chunks), 'stop', 'the first send ended as an ordinary stop')
    assert.equal(app.messages().length, 1, 'exactly one Messages request was issued')
    assert.equal(app.wire.tokenCalls.length, 0, 'a fresh credential spends no grant on its own send')
    assert.equal(app.accounts().length, 1)

    // The test arranges the expiry the timer was already armed for. This is not an identity
    // event: it moves the same synthetic session the store holds.
    await app.expire()

    // The maintenance cycle — not a second user request — is what reaches the token endpoint.
    await app.wire.reached
    await waitForCredentialState(app, 'reauth_required')

    // Disposal drains the cycle's own release and publication.
    await app.dispose()

    const kept = app.accounts()
    assert.equal(kept.length, 1, 'the refused credential stays in the plugin store')
    assert.equal(kept[0]?.['accessToken'], ACCESS_TOKEN, 'its tokens are unchanged')
    assert.equal(kept[0]?.['refreshToken'], REFRESH_TOKEN, 'including the refresh token the grant spent')
    assert.equal(app.wire.tokenCalls.length, 1, 'the maintenance cycle spent exactly one grant')
    assert.equal(app.messages().length, 1, 'no second user request was issued')
    const published = app.generation().find(entry => entry.reason === 'removal')
    assert.equal(published, undefined, 'no removal identity change ran')
    assert.equal(app.generation()[0]?.generation, baseline.generation, 'the generation did not advance')
    assert.deepEqual(app.wire.refused, [], 'nothing outside the stated endpoints was reached')
    assert.equal(app.wire.policyReads, 0, 'the ineligible account asked for no managed settings')
  })
})

test('a credential that moved while the grant was in flight survives, and an explicit logout still removes it', { timeout: 30_000 }, async () => {
  await withComposition(async (app, home) => {
    const baseline = await waitForBaseline(home)
    assert.equal(finishKind(await app.request('session-race')), 'stop', 'the first send ended as an ordinary stop')

    // The grant is held open by the case, and the cycle states `refreshing` before it reaches the
    // token endpoint: the public status proves the cycle is running on this credential.
    app.wire.holdToken = true
    await app.expire()
    await app.wire.reached
    assert.equal(await credentialState(app), 'refreshing', 'the cycle is running on the stored credential')

    // The concurrent write lands inside the window the refresh already read. The refused grant
    // must not delete or roll back the credential the winner holds.
    await app.rotate()
    app.wire.release()
    await waitForCredentialState(app, 'ready')

    const kept = app.accounts()
    assert.equal(kept.length, 1, 'the credential that won the store is kept')
    assert.equal(kept[0]?.['accessToken'], WINNER_ACCESS_TOKEN)
    assert.equal(app.generation()[0]?.generation, baseline.generation, 'the refusal published nothing')

    // The only removal is the explicit one; it still runs the identity change.
    const result = await app.logout()
    assert.equal(result.ok, true, `the explicit logout removed the account: ${JSON.stringify(result)}`)
    assert.equal(app.accounts().length, 0, 'the explicit logout removed the winning credential')
    const published = app.generation()[0]
    assert.ok(published !== undefined)
    assert.equal(published.reason, 'logout', 'the logout is the change that published')
    assert.equal(published.pending, null, 'the removal states nothing in flight')
    assert.equal(published.generation, baseline.generation + 1, 'the logout advanced the generation')
    assert.equal(app.wire.tokenCalls.length, 1, 'the recovery attempted no further grant')
    assert.equal(app.messages().length, 1, 'the recovery issued no Messages request')
    assert.deepEqual(app.wire.refused, [], 'nothing outside the stated endpoints was reached')
    assert.equal(app.wire.policyReads, 0, 'the ineligible account asked for no managed settings')

    await app.dispose()
  })
})

test('an active logout runs the same identity change through the public RPC', { timeout: 30_000 }, async () => {
  await withComposition(async (app, home) => {
    const baseline = await waitForBaseline(home)

    const result = await app.logout()
    assert.equal(result.ok, true, JSON.stringify(result))
    const claude = await app.status()
    assert.deepEqual(claude['accounts'], [], 'the status read reports the account gone')

    await app.dispose()

    assert.equal(app.accounts().length, 0, 'the logout left no account in the plugin store')
    // The removal is the credential's absence, not the absence of every naming of the account:
    // the store keeps the retired credential's revision as its own high-water mark, so the account
    // map is what must no longer hold the account.
    const authText = readFileSync(join(home, 'plugins', 'subscriptions', 'auth.json'), 'utf8')
    const store = JSON.parse(authText) as {
      claude?: { accounts?: Record<string, unknown> }
      revisions?: { claude?: Record<string, number> }
    }
    assert.equal(
      Object.hasOwn(store.claude?.accounts ?? {}, ACCOUNT),
      false,
      'the provider account map no longer holds the removed account',
    )
    assert.equal(authText.includes(ACCESS_TOKEN), false, 'the retired access token is not retained')
    assert.equal(authText.includes(REFRESH_TOKEN), false, 'the retired refresh token is not retained')
    const revision = store.revisions?.claude?.[ACCOUNT]
    assert.ok(
      typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0,
      'the retired credential keeps its revision as the store-owned high-water mark',
    )
    const published = app.generation().find(entry => entry.reason === 'logout')
    assert.ok(published !== undefined, 'the logout published a generation')
    assert.equal(published.pending, null, 'no transition is left in flight')
    assert.ok(published.generation > baseline.generation, 'the generation advanced')
    assert.equal(app.wire.tokenCalls.length, 0, 'a logout spends no grant')
    assert.deepEqual(app.wire.refused, [], 'a logout reaches no provider')
    assert.equal(app.wire.policyReads, 0, 'a logout reads no managed settings')
  })
})

test('a Claude request is refused, with nothing sent, when its span state cannot be read', { timeout: 30_000 }, async () => {
  await withComposition(async (app, home) => {
    const baseline = await waitForBaseline(home)
    // The span document every request is prepared under: a directory where that document belongs
    // is an I/O failure the real prepare must report rather than skip.
    mkdirSync(join(home, 'plugins', 'subscriptions', 'claude-continuation', 'spans.json'))
    // The credential is inside its timer's window, so a request that got past the state gate would
    // reach the token endpoint, and the untouched counter below is what proves it did not.
    await app.expire()

    await assert.rejects(
      app.request('session-state'),
      (error: unknown) => {
        assert.ok(error instanceof LlmError, `the request was refused: ${String(error)}`)
        assert.equal(error.code, LOCAL_CONTINUATION_STATE_UNAVAILABLE,
          'the state owner refused it, not a missing service or a record')
        assert.equal(error.failure.retryDisposition, 'forbid', 'nothing may resend it as it stands')
        assert.match(error.message, /continuation state/)
        return true
      },
    )

    assert.equal(app.wire.tokenCalls.length, 0, 'the refusal spent no grant')
    assert.equal(app.messages().length, 0, 'no Messages request was issued')
    assert.equal(app.wire.policyReads, 0, 'no managed settings were read')
    assert.deepEqual(app.wire.refused, [], 'nothing outside the stated endpoints was reached')
    assert.equal(app.generation()[0]?.generation, baseline.generation, 'no identity change ran')
    await app.dispose()
  })
})

test('a Claude request waits out another holder\'s live state lock and is then answered', { timeout: 30_000 }, async () => {
  await withComposition(async (app, home) => {
    await waitForBaseline(home)
    // Another cooperating holder's live lease: the lock directory carries a fresh owner, so the real
    // acquire waits for it instead of taking it over. The lock and its owner live in this case's own
    // home and are removed with that root.
    const lock = join(home, 'plugins', 'subscriptions', 'claude-continuation', 'spans.json.lock')
    mkdirSync(lock)
    writeFileSync(join(lock, 'owner'), 'synthetic-other-holder', { mode: 0o600 })

    const request = app.request('session-lock')
    let answered = false
    void request.then(() => { answered = true }, () => { answered = true })
    // Held past the whole retry budget the bounded acquire this replaced allowed at the shipped lock
    // setting, so a bounded implementation would already have refused. A queued request waits for
    // the holder itself, and the credential stays untouched while it does.
    await new Promise<void>((resolve) => { setTimeout(resolve, 1_800) })
    assert.equal(answered, false, 'the request waits for the other holder instead of being refused')

    rmSync(lock, { recursive: true, force: true })
    const chunks = await request
    assert.equal(finishKind(chunks), 'stop', 'the waited-out request was answered normally')
    assert.equal(app.messages().length, 1, 'exactly one Messages request was issued')
    assert.equal(app.wire.tokenCalls.length, 0, 'the fresh credential spent no grant')
    assert.equal(app.wire.policyReads, 0, 'no managed settings were read')
    assert.deepEqual(app.wire.refused, [], 'nothing outside the stated endpoints was reached')
    await app.dispose()
  })
})

test('a Claude request cancelled while its state lock is held is refused promptly, with nothing sent', { timeout: 30_000 }, async () => {
  await withComposition(async (app, home) => {
    const baseline = await waitForBaseline(home)
    const lock = join(home, 'plugins', 'subscriptions', 'claude-continuation', 'spans.json.lock')
    mkdirSync(lock)
    writeFileSync(join(lock, 'owner'), 'synthetic-other-holder', { mode: 0o600 })
    // An expired credential makes the counterexample sharp: a request that got past the state gate
    // would spend the grant the assertions below find untouched.
    await app.expire()

    const controller = new AbortController()
    const request = app.request('session-lock-cancel', controller.signal)
    // Give the request its first turns, then stop it while the lock is still held: cancellation is
    // the only thing besides disposal that ends a state wait.
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    controller.abort()

    await assert.rejects(
      request,
      (error: unknown) => {
        assert.ok(error instanceof LlmError, `the request was refused: ${String(error)}`)
        // The route classifies a stopped caller as ABORTED and leaves its disposition to the Host, so
        // that classification outranks the state's internal cancellation reason. What must hold is
        // that the wait ended, and that nothing was sent under it.
        assert.equal(error.code, 'ABORTED', 'the stopped caller is classified by the route')
        assert.match(error.message, /aborted by caller/)
        assert.equal(error.failure.retryDisposition, undefined,
          'a caller stop is not a retry-forbidden state failure')
        return true
      },
    )

    assert.equal(existsSync(lock), true, 'the other holder\'s lock was not taken over')
    assert.equal(app.wire.tokenCalls.length, 0, 'the cancelled request spent no grant')
    assert.equal(app.messages().length, 0, 'no Messages request was issued')
    assert.equal(app.wire.policyReads, 0, 'no managed settings were read')
    assert.deepEqual(app.wire.refused, [], 'nothing outside the stated endpoints was reached')
    assert.equal(app.generation()[0]?.generation, baseline.generation, 'no identity change ran')
    await app.dispose()
  })
})

test('a request after the state\'s disposal is refused before any provider read or state commit', { timeout: 30_000 }, async () => {
  await withComposition(async (app, home) => {
    const baseline = await waitForBaseline(home)
    // The owner every request is prepared under is gone, so a later request must fail closed rather
    // than bind policy state without an identity epoch and reach a provider.
    await app.dispose()

    await assert.rejects(
      app.request('session-after-dispose'),
      (error: unknown) => {
        assert.ok(error instanceof LlmError, `the request was refused: ${String(error)}`)
        assert.equal(error.code, LOCAL_CONTINUATION_STATE_UNAVAILABLE, 'the disposed state refuses it')
        assert.equal(error.failure.retryDisposition, 'forbid', 'nothing may resend it as it stands')
        assert.match(error.message, /continuation state/)
        return true
      },
    )

    assert.equal(app.wire.tokenCalls.length, 0, 'the refused request spent no grant')
    assert.equal(app.messages().length, 0, 'no Messages request was issued')
    assert.equal(app.wire.policyReads, 0, 'no managed settings were read after disposal')
    assert.deepEqual(app.wire.refused, [], 'nothing outside the stated endpoints was reached')
    assert.equal(app.generation()[0]?.generation, baseline.generation, 'no identity change was committed')
  })
})
