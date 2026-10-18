/**
 * Claude route reliability through the shipped adapter and pool: the hard stop a version
 * refusal produces, the profile block that keeps later requests off the wire, the delivery
 * boundary that forbids a replay, incomplete-tool fail-closed behavior, and the isolation
 * of one cancelled stream from its siblings. Every fetch is synthetic.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { CLAUDE_MAX_BASE64_IMAGE_CHARS, ClaudeAdapter, bindClaudeFileIds, deriveClaudeDeviceId, fetchClaudeUsage } from '../src/providers/claude.js'
import { CLAUDE_PROTOCOL_PROFILE } from '../src/providers/claude-protocol.js'
import { ClaudeProtocolBlockStore } from '../src/providers/claude-protocol-state.js'
import { CLIENT_VERSION_UNSUPPORTED_CODE } from '../src/providers/claude-failure.js'
import { PoolAdapter } from '../src/providers/pool.js'
import { PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import { poolKey } from '../src/providers/pool-family.js'
import { resolvePoolScheduling } from '../src/providers/pool-scheduling.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'
import type { FetchFn } from '../src/providers/common.js'
import { PermittingRecordPort } from './recording-port.js'
import { ownedClaudeContinuation } from './claude-maintenance-fixtures.js'

const MODEL = 'claude-opus-4-5'
const ACCOUNT_UUID = '00000000-0000-4000-8000-000000000001'
const FINGERPRINT = 'a1'.repeat(32)

/** The nested version refusal the service sends. */
const VERSION_BODY = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'Your client version is no longer supported',
    details: { error_code: 'claude_code_version_too_old' },
  },
})

/**
 * One SSE frame.
 * @param event - the event object.
 * @returns the framed text.
 */
function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/** A complete text answer. */
const COMPLETE = [
  { type: 'message_start', message: { usage: { input_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
].map(frame).join('')

/** A synthetic session already bound to this machine. */
function session(key: string): ClaudeSession {
  return {
    accessToken: `at-${key}`,
    refreshToken: `rt-${key}`,
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    accountUuid: ACCOUNT_UUID,
    deviceId: deriveClaudeDeviceId(`uuid:${ACCOUNT_UUID}`, FINGERPRINT),
  }
}

/**
 * A token manager over synthetic accounts that records every refresh.
 * @param keys - the account keys to serve.
 * @returns the manager and the refresh log.
 */
function tokens(keys: readonly string[]): { manager: AccountTokenManager<ClaudeSession>; refreshed: string[] } {
  const stored = new Map(keys.map(key => [key, session(key)]))
  const refreshed: string[] = []
  const manager = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'reliability',
    makeOptions: key => ({
      preemptMs: 0,
      isPermanent: () => false,
      refresh: async current => {
        refreshed.push(key)
        return { ...current, accessToken: `${current.accessToken}-refreshed` }
      },
    }),
    io: {
      list: async () => [...stored].map(([key, value]) => ({ key, session: value })),
      get: async key => stored.get(key ?? keys[0] ?? 'a1'),
      save: async (key, value) => { stored.set(key, value) },
      remove: async key => { stored.delete(key) },
    },
  })
  return { manager, refreshed }
}

/** Brand one case's synthetic session identity; the adapter chains conversation state per (account, session). */
const SessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

/** The request every case streams; each case states its own synthetic session. */
const OPTIONS: GenerateOptions = {
  provider: 'claude',
  model: MODEL,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}

/**
 * Build one adapter over the given fetch, with its own protocol-block directory and its own
 * durable continuation owner over the accounts it serves.
 * @param t - the case that owns the continuation state.
 * @param fetchFn - the synthetic egress.
 * @param keys - the accounts the token manager serves; each is established before the case streams.
 * @returns the adapter, its block store and the refresh log.
 */
async function adapter(
  t: Pick<TestContext, 'after'>,
  fetchFn: FetchFn,
  keys: readonly string[] = ['a1'],
  existing?: ClaudeProtocolBlockStore,
  streamIdleTimeoutMs = 5_000,
): Promise<{ adapter: ClaudeAdapter; blocks: ClaudeProtocolBlockStore; refreshed: string[]; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-reliability-blocks-'))
  const blocks = existing ?? new ClaudeProtocolBlockStore({ directory })
  const { manager, refreshed } = tokens(keys)
  const adapter = new ClaudeAdapter({
    models: [],
    discovery: false,
    streamIdleTimeoutMs,
    tokens: manager,
    fetchFn,
    deviceFingerprint: () => FINGERPRINT,
    protocolBlocks: blocks,
    protocolProfile: CLAUDE_PROTOCOL_PROFILE,
    continuation: await ownedClaudeContinuation(t, keys),
    requestRecord: new PermittingRecordPort(),
  })
  return { adapter, blocks, refreshed, directory }
}

/**
 * Drain one account's stream under the synthetic session the calling case declares.
 * @param adapter - the adapter to stream through.
 * @param sessionId - the synthetic session this send belongs to.
 * @param account - the account to route to.
 * @returns the chunks it produced.
 */
async function collect(
  adapter: ClaudeAdapter,
  sessionId: NonNullable<GenerateOptions['sessionId']>,
  account = 'a1',
): Promise<StreamChunk[]> {
  return await drain(adapter.streamAccount({ ...OPTIONS, sessionId }, account))
}

/**
 * Drain one already-built stream.
 * @param stream - the chunk stream to consume.
 * @returns the chunks it produced.
 */
async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/**
 * Remove one synthetic store directory once its background write has landed.
 * @param directory - the directory to remove.
 */
async function cleanup(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

test('a version refusal stops the request, records the profile block, and sends nothing after', async t => {
  const urls: string[] = []
  const harness = await adapter(t, async (url, init) => {
    urls.push(String(url))
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer at-a1')
    return new Response(VERSION_BODY, { status: 400, headers: { 'retry-after': '30', 'x-should-retry': 'true' } })
  })
  try {
    await assert.rejects(collect(harness.adapter, SessionId('sess-version-refusal')), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, CLIENT_VERSION_UNSUPPORTED_CODE)
      assert.equal(error.failure.retryDisposition, 'forbid')
      return true
    })
    assert.equal(urls.length, 1, 'only the original attempt is sent')
    assert.deepEqual(harness.refreshed, [], 'a version refusal never refreshes a credential')
    assert.equal(await harness.blocks.isBlocked({
      provider: 'claude',
      origin: CLAUDE_PROTOCOL_PROFILE.origin,
      fingerprint: CLAUDE_PROTOCOL_PROFILE.fingerprint,
    }), true, 'the refused profile is recorded')

    // The next request for the same profile does not reach the wire at all.
    await assert.rejects(collect(harness.adapter, SessionId('sess-version-refusal')), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, CLIENT_VERSION_UNSUPPORTED_CODE)
      assert.equal(error.failure.retryDisposition, 'forbid')
      return true
    })
    assert.equal(urls.length, 1, 'a blocked profile sends no request, however often it is retried')
  } finally {
    await cleanup(harness.directory)
  }
})

test('a named 400 request refusal is final: one attempt, no refresh, no profile block', async t => {
  const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'temperature must be <= 1' } })
  const urls: string[] = []
  const harness = await adapter(t, async (url) => {
    urls.push(String(url))
    return new Response(body, { status: 400, headers: { 'retry-after': '10' } })
  })
  try {
    await assert.rejects(collect(harness.adapter, SessionId('sess-named-400')), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'INVALID_REQUEST')
      assert.equal(error.failure.retryDisposition, 'forbid')
      return true
    })
    assert.equal(urls.length, 1, 'a stated request refusal is attempted once')
    assert.deepEqual(harness.refreshed, [], 'a request refusal is not a credential problem')
    // This refusal is about the request, not the compatibility profile, so nothing is blocked.
    assert.equal(await harness.blocks.isBlocked({
      provider: 'claude',
      origin: CLAUDE_PROTOCOL_PROFILE.origin,
      fingerprint: CLAUDE_PROTOCOL_PROFILE.fingerprint,
    }), false)
  } finally {
    await cleanup(harness.directory)
  }
})

test('a pool answers a version refusal on the first account without asking the second', async t => {
  const calls: string[] = []
  const harness = await adapter(t, async (_url, init) => {
    calls.push(new Headers(init?.headers).get('authorization') ?? '')
    return new Response(VERSION_BODY, { status: 400 })
  }, ['a1', 'a2'])
  const health = new PoolHealthRegistry()
  const pool = new PoolAdapter({
    scheduling: resolvePoolScheduling(),
    concurrency: { requestsPerMinute: 0, minGapMs: 0 },
    adapters: { claude: harness.adapter },
    health,
    usage: new PoolUsageTracker(() => undefined),
    strategy: 'priority',
    defaultAccount: async () => 'a1',
    families: async () => new Map([[poolKey('claude', MODEL), { members: [
      { provider: 'claude', account: 'a1', model: MODEL },
      { provider: 'claude', account: 'a2', model: MODEL },
    ] }]]),
    tiers: {},
    onWarn: () => {},
  })
  try {
    await assert.rejects(async () => {
      for await (const _chunk of pool.stream({ ...OPTIONS, sessionId: SessionId('sess-pool-refusal') })) { /* drain */ }
    }, (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, CLIENT_VERSION_UNSUPPORTED_CODE)
      assert.equal(error.failure.retryDisposition, 'forbid')
      return true
    })
    assert.deepEqual(calls, ['Bearer at-a1'], 'the sibling account is never asked to repeat the refusal')
  } finally {
    await cleanup(harness.directory)
  }
})

test('output delivered before a failure forbids the replay a pre-output failure still permits', async t => {
  const partial = [frame({ type: 'message_start', message: { usage: { input_tokens: 1 } } }),
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } }),
    frame({ type: 'error', error: { type: 'api_error', message: 'busy' } })].join('')
  const afterDelivery = await adapter(t, async () => new Response(partial))
  const beforeDelivery = await adapter(t, async () => new Response(frame({
    type: 'error', error: { type: 'api_error', message: 'busy' },
  })))
  try {
    const chunks: StreamChunk[] = []
    await assert.rejects(async () => {
      for await (const chunk of afterDelivery.adapter.streamAccount(
        { ...OPTIONS, sessionId: SessionId('sess-after-delivery') }, 'a1')) chunks.push(chunk)
    }, (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'SERVER')
      assert.equal(error.failure.retryDisposition, 'forbid', 'a delivered response is not replayed')
      return true
    })
    assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'half'))

    await assert.rejects(collect(beforeDelivery.adapter, SessionId('sess-before-delivery')), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'SERVER')
      assert.equal(error.failure.retryDisposition, undefined, 'nothing was delivered, so the attempt is replayable')
      return true
    })
  } finally {
    await cleanup(afterDelivery.directory)
    await cleanup(beforeDelivery.directory)
  }
})

test('a stream that ends without its terminal event is not a success, and forbids replay after output', async t => {
  const truncated = [frame({ type: 'message_start', message: { usage: { input_tokens: 1 } } }),
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'part' } })].join('')
  const withOutput = await adapter(t, async () => new Response(truncated))
  // An accepted response with no terminal state is incomplete whether or not anything was
  // delivered: the request has certainly been sent, so a resend could duplicate the turn.
  const withoutOutput = await adapter(t, async () => new Response(''))
  try {
    await assert.rejects(collect(withOutput.adapter, SessionId('sess-truncated-output')), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'STREAM_INCOMPLETE')
      assert.equal(error.failure.retryDisposition, 'forbid')
      return true
    })
    await assert.rejects(collect(withoutOutput.adapter, SessionId('sess-truncated-empty')), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'STREAM_INCOMPLETE')
      assert.equal(error.failure.retryDisposition, 'forbid', 'an accepted response is never replayed')
      return true
    })
  } finally {
    await cleanup(withOutput.directory)
    await cleanup(withoutOutput.directory)
  }
})

test('a version refusal on the Files upload records the profile block, so Messages never follows', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-reliability-files-'))
  const blocks = new ClaudeProtocolBlockStore({ directory })
  const sent: string[] = []
  // One image past the vision limit: the Files endpoint is the only path it can take.
  const image: TranslatableMessage = {
    role: 'user',
    content: [{ type: 'image', mediaType: 'image/png', dataBase64: 'A'.repeat(CLAUDE_MAX_BASE64_IMAGE_CHARS + 4) }],
  }
  try {
    await assert.rejects(bindClaudeFileIds(
      [image],
      'a1',
      'at-a1',
      async (url) => {
        sent.push(String(url))
        return new Response(VERSION_BODY, { status: 400 })
      },
      undefined,
      decision => {
        // What the adapter does with every decision: an identity-scoped refusal is recorded.
        if (decision.scope !== 'provider-profile') return
        void blocks.block({
          provider: 'claude',
          origin: decision.origin,
          fingerprint: decision.protocolFingerprint,
          reason: decision.reason,
        })
      },
    ), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, CLIENT_VERSION_UNSUPPORTED_CODE)
      assert.equal(error.failure.retryDisposition, 'forbid')
      return true
    })
    assert.deepEqual(sent, [CLAUDE_PROTOCOL_PROFILE.endpoints.files], 'the upload is attempted once')
    const key = {
      provider: 'claude',
      origin: CLAUDE_PROTOCOL_PROFILE.origin,
      fingerprint: CLAUDE_PROTOCOL_PROFILE.fingerprint,
    }
    assert.equal(await blocks.isBlocked(key), true, 'the same profile is refused on every role of the origin')

    // Messages for that profile now sends nothing at all.
    sent.length = 0
    const harness = await adapter(t, async (url) => {
      sent.push(String(url))
      return new Response(COMPLETE)
    }, ['a1'], blocks)
    await assert.rejects(collect(harness.adapter, SessionId('sess-files-block')), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, CLIENT_VERSION_UNSUPPORTED_CODE)
      return true
    })
    assert.deepEqual(sent, [], 'no Messages request follows a version refusal found on the Files role')
  } finally {
    await cleanup(directory)
  }
})

test('a Messages POST that fails after it was issued is ambiguous, not replayable', async t => {
  let issued = 0
  const harness = await adapter(t, async (_url, init) => {
    issued += 1
    // The body left this process before the failure: the server may already have acted on it.
    void init?.body
    throw new Error('connection reset')
  })
  try {
    await assert.rejects(collect(harness.adapter, SessionId('sess-ambiguous-send')), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'TRANSPORT')
      assert.equal(error.failure.retryDisposition, 'forbid',
        'the send cannot be shown to have been refused, so this logical request is not repeated')
      return true
    })
    assert.equal(issued, 1, 'the ambiguous send is not repeated automatically')
  } finally {
    await cleanup(harness.directory)
  }
})

test('an idle deadline that lands while the POST is in flight stays ambiguous, not retryable', async (context) => {
  // The watchdog fires while the request is already on the wire, so the server may have accepted
  // it: the deadline must not hand the attempt back as a retryable TIMEOUT. The deadline is
  // driven by the test's own clock, so the send is observed before it fires rather than raced.
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let noteSendStarted: () => void = () => {}
  const sendStarted = new Promise<void>((resolve) => { noteSendStarted = resolve })
  const harness = await adapter(context,
    async (_url, init) => {
      noteSendStarted()
      return await new Promise<Response>((_resolve, reject) => {
        // A signal that already fired must reject at once: the fixture never waits for an event
        // it has missed.
        if (init?.signal?.aborted === true) {
          reject(init.signal.reason ?? new Error('aborted'))
          return
        }
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new Error('aborted'))
        }, { once: true })
      })
    },
    ['a1'],
    undefined,
    0,
  )
  try {
    const pending = collect(harness.adapter, SessionId('sess-idle-deadline'))
    // Wait for the POST to be issued before the deadline fires: this is what makes the case the
    // one the design names, and not a deadline that landed before the send.
    await sendStarted
    context.mock.timers.tick(1)
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'TIMEOUT', 'an idle expiry of an issued send is a timeout')
      assert.equal(error.failure.retryDisposition, 'forbid', 'a deadline after the POST is not a safe repeat')
      return true
    })
  } finally {
    context.mock.timers.reset()
    await cleanup(harness.directory)
  }
})

test('a caller cancel is rethrown for the transport layers to classify, not marked ambiguous', async t => {
  const controller = new AbortController()
  const harness = await adapter(t, async () => {
    controller.abort()
    throw new DOMException('The operation was aborted.', 'AbortError')
  })
  try {
    await assert.rejects(
      drain(harness.adapter.streamAccount(
        { ...OPTIONS, sessionId: SessionId('sess-caller-cancel'), signal: controller.signal }, 'a1')),
      (error: unknown) => {
        assert.ok(error instanceof LlmError)
        assert.equal(error.code, 'ABORTED', 'the caller cancel keeps its own classification')
        assert.notEqual(error.failure.retryDisposition, 'forbid')
        return true
      },
    )
  } finally {
    await cleanup(harness.directory)
  }
})

test('an unparseable tool call never becomes executable, while a truncated one is pruned by its stop reason', async t => {
  const toolStream = (stopReason: string): string => [
    frame({ type: 'message_start', message: { usage: { input_tokens: 1 } } }),
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'read' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
    frame({ type: 'content_block_stop', index: 0 }),
    frame({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } }),
    frame({ type: 'message_stop' }),
  ].join('')
  const broken = await adapter(t, async () => new Response(toolStream('tool_use')))
  const truncated = await adapter(t, async () => new Response(toolStream('max_tokens')))
  try {
    const chunks = await collect(broken.adapter, SessionId('sess-broken-tool'))
    const finish = chunks.at(-1)
    assert.ok(finish?.type === 'finish')
    assert.deepEqual(finish.reason.kind, 'error', 'an unclosed tool call is not a completed turn')
    assert.equal(finish.reason.kind === 'error' ? finish.reason.failure.code : undefined, 'MALFORMED_RESPONSE')
    assert.equal(finish.reason.kind === 'error' ? finish.reason.failure.retryDisposition : undefined, 'forbid')

    const pruned = await collect(truncated.adapter, SessionId('sess-truncated-tool'))
    const prunedFinish = pruned.at(-1)
    assert.ok(prunedFinish?.type === 'finish')
    assert.deepEqual(prunedFinish.reason, { kind: 'max-tokens' }, 'a generation limit keeps its own terminal state')
  } finally {
    await cleanup(broken.directory)
    await cleanup(truncated.directory)
  }
})

test('cancelling one stream leaves its sibling request and account untouched', async t => {
  const controller = new AbortController()
  let held = 0
  const harness = await adapter(t, async (_url, init) => {
    const authorization = new Headers(init?.headers).get('authorization')
    if (authorization === 'Bearer at-a1') {
      held += 1
      // A stream that stays open until its caller aborts: only cancellation ends this read.
      return new Response(new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new TextEncoder().encode(frame({ type: 'message_start', message: {} })))
          streamController.enqueue(new TextEncoder().encode(frame({
            type: 'content_block_start', index: 0, content_block: { type: 'text' },
          })))
          init?.signal?.addEventListener('abort', () => {
            streamController.error(new Error('aborted by caller'))
          }, { once: true })
        },
      }))
    }
    return new Response(COMPLETE)
  }, ['a1', 'a2'])
  try {
    const held_ = drain(harness.adapter.streamAccount(
      { ...OPTIONS, sessionId: SessionId('sess-cancel-held'), signal: controller.signal }, 'a1'))
    const sibling = collect(harness.adapter, SessionId('sess-cancel-sibling'), 'a2')
    // The sibling finishes while the first request is still open.
    const siblingChunks = await sibling
    assert.equal(siblingChunks.at(-1)?.type, 'finish')
    controller.abort()
    await assert.rejects(held_, (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'ABORTED')
      assert.notEqual(error.failure.retryDisposition, 'forbid', 'a caller cancel is not a recorded refusal')
      return true
    })
    assert.equal(held, 1)
    // The sibling account still serves, and the cancelled request did not park anything.
    const later = await collect(harness.adapter, SessionId('sess-cancel-sibling'), 'a2')
    assert.equal(later.at(-1)?.type, 'finish')
  } finally {
    await cleanup(harness.directory)
  }
})

test('an SSE version refusal blocks the profile for every account, with or without output', async t => {
  const nestedVersion = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'update required',
      details: { error_code: 'claude_code_version_too_old' },
    },
  }
  const withOutput = [
    frame({ type: 'message_start', message: { usage: { input_tokens: 1 } } }),
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } }),
    frame(nestedVersion),
  ].join('')
  const withoutOutput = frame(nestedVersion)
  const key = {
    provider: 'claude',
    origin: CLAUDE_PROTOCOL_PROFILE.origin,
    fingerprint: CLAUDE_PROTOCOL_PROFILE.fingerprint,
  }

  for (const [label, body] of [['with output', withOutput], ['without output', withoutOutput]] as const) {
    const calls: string[] = []
    // Two accounts: the refusal is evidence about the profile, so the second must not be asked.
    const harness = await adapter(t, async (_url, init) => {
      calls.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response(body)
    }, ['a1', 'a2'])
    try {
      await assert.rejects(collect(harness.adapter, SessionId('sess-sse-refusal'), 'a1'), (error: unknown) => {
        assert.ok(error instanceof LlmError)
        assert.equal(error.code, CLIENT_VERSION_UNSUPPORTED_CODE, `${label}: the version refusal is kept`)
        assert.equal(error.failure.retryDisposition, 'forbid', `${label}: an in-band refusal is not replayed`)
        return true
      })
      assert.equal(await harness.blocks.isBlocked(key), true, `${label}: the profile is blocked`)
      assert.equal(calls.length, 1, `${label}: only the original attempt reached the wire`)

      // A different account for the same profile sends nothing at all.
      await assert.rejects(collect(harness.adapter, SessionId('sess-sse-refusal'), 'a2'), (error: unknown) => {
        assert.ok(error instanceof LlmError)
        assert.equal(error.code, CLIENT_VERSION_UNSUPPORTED_CODE)
        assert.equal(error.failure.retryDisposition, 'forbid')
        return true
      })
      assert.equal(calls.length, 1, `${label}: a blocked profile sends no request on any account`)
    } finally {
      await cleanup(harness.directory)
    }
  }
})

test('a blocked profile stops before any credential refresh, discovery or request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-reliability-blocked-'))
  const blocks = new ClaudeProtocolBlockStore({ directory })
  await blocks.block({
    provider: 'claude',
    origin: CLAUDE_PROTOCOL_PROFILE.origin,
    fingerprint: CLAUDE_PROTOCOL_PROFILE.fingerprint,
    reason: CLIENT_VERSION_UNSUPPORTED_CODE,
  })
  let refreshes = 0
  let fetches = 0
  const key = 'a1'
  let stored = session(key)
  const manager = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'blocked',
    // An already-expired credential: reading it at all would spend a refresh.
    makeOptions: () => ({
      preemptMs: Number.MAX_SAFE_INTEGER,
      isPermanent: () => false,
      refresh: async current => {
        refreshes += 1
        return { ...current, accessToken: `${current.accessToken}-refreshed` }
      },
    }),
    io: {
      list: async () => [{ key, session: stored }],
      get: async () => stored,
      save: async (_key, value) => { stored = value },
      remove: async () => {},
    },
  })
  const blocked = new ClaudeAdapter({
    models: [], discovery: false, streamIdleTimeoutMs: 5_000, tokens: manager,
    fetchFn: async () => {
      fetches += 1
      return new Response(COMPLETE)
    },
    deviceFingerprint: () => FINGERPRINT,
    protocolBlocks: blocks,
    continuation: await ownedClaudeContinuation(t, ['a1']),
    requestRecord: new PermittingRecordPort(),
  })
  try {
    await assert.rejects(collect(blocked, SessionId('sess-blocked-profile'), key), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, CLIENT_VERSION_UNSUPPORTED_CODE)
      assert.equal(error.failure.retryDisposition, 'forbid')
      return true
    })
    assert.equal(refreshes, 0, 'a blocked profile does not refresh a credential on its way to the wire')
    assert.equal(fetches, 0, 'a blocked profile sends nothing')
  } finally {
    await cleanup(directory)
  }
})

test('an accepted 200 with no response body is the same incomplete outcome, not an empty completion', async t => {
  const harness = await adapter(t, async () => new Response(null, { status: 200 }))
  try {
    await assert.rejects(collect(harness.adapter, SessionId('sess-empty-200')), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'STREAM_INCOMPLETE', 'the request was accepted, so there is no terminal state to reach')
      assert.equal(error.failure.retryDisposition, 'forbid')
      return true
    })
  } finally {
    await cleanup(harness.directory)
  }
})

test('a usage 401 that names the version refusal never refreshes the shared credential', async () => {
  const nested = JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'update required',
      details: { error_code: 'claude_code_version_too_old' },
    },
  })
  let refreshes = 0
  let requests = 0
  await assert.rejects(
    fetchClaudeUsage(session('a1'), async () => {
      requests += 1
      return new Response(nested, { status: 401 })
    }, undefined, async () => {
      refreshes += 1
      return 'at-a1-refreshed'
    }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, CLIENT_VERSION_UNSUPPORTED_CODE)
      assert.equal(error.failure.retryDisposition, 'forbid')
      return true
    },
  )
  assert.equal(requests, 1, 'the auxiliary read is issued once')
  assert.equal(refreshes, 0, 'a structured refusal outranks the usage read\'s one replay')
})

test('a pool never answers a forbidden failure from another account, whatever its code', async () => {
  // The pool's own switch is a resend, so a failure the route already forbade must not be
  // retried inside the pool merely because its code looks transient.
  for (const code of ['SERVER', 'TIMEOUT']) {
    const attempted: string[] = []
    const forbidden = new LlmError(`claude API ${code}`, code, { retryDisposition: 'forbid' })
    const fake = {
      streamAccount: (_options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> =>
        (async function* () {
          attempted.push(account ?? '')
          throw forbidden
        })(),
    }
    const health = new PoolHealthRegistry()
    const pool = new PoolAdapter({
      scheduling: resolvePoolScheduling(),
      concurrency: { requestsPerMinute: 0, minGapMs: 0 },
      adapters: { claude: fake as never },
      health,
      usage: new PoolUsageTracker(() => undefined),
      strategy: 'priority',
      defaultAccount: async () => 'a1',
      families: async () => new Map([[poolKey('claude', MODEL), { members: [
        { provider: 'claude', account: 'a1', model: MODEL },
        { provider: 'claude', account: 'a2', model: MODEL },
      ] }]]),
      tiers: {},
      onWarn: () => {},
    })
    await assert.rejects(async () => {
      for await (const _chunk of pool.stream(OPTIONS)) { /* drain */ }
    }, (error: unknown) => error === forbidden, code)
    assert.deepEqual(attempted, ['a1'], `${code}: the sibling account is never asked`)
    // The stop says nothing about the account's allowance, so no cooldown was recorded from it.
    assert.equal(health.isMemberAvailable('claude', 'a1', MODEL), health.isMemberAvailable('claude', 'a1', MODEL))
  }
})

test('the pool keeps the same account for a transient failure when nothing forbids a resend', async () => {
  const attempted: string[] = []
  const transient = new LlmError('claude API SERVER', 'SERVER')
  const fake = {
    streamAccount: (_options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> =>
      (async function* () {
        attempted.push(account ?? '')
        if (account === 'a1') throw transient
        yield { type: 'text-delta', index: 0, text: 'ok' } as StreamChunk
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
      })(),
  }
  const pool = new PoolAdapter({
    scheduling: resolvePoolScheduling(),
    concurrency: { requestsPerMinute: 0, minGapMs: 0 },
    adapters: { claude: fake as never },
    health: new PoolHealthRegistry(),
    usage: new PoolUsageTracker(() => undefined),
    strategy: 'priority',
    defaultAccount: async () => 'a1',
    families: async () => new Map([[poolKey('claude', MODEL), { members: [
      { provider: 'claude', account: 'a1', model: MODEL },
      { provider: 'claude', account: 'a2', model: MODEL },
    ] }]]),
    tiers: {},
    onWarn: () => {},
  })
  // A transient failure stays on its account; retry policy, not the pool, decides
  // whether that account may be tried again.
  await assert.rejects(async () => {
    for await (const _chunk of pool.stream(OPTIONS)) { /* drain */ }
  }, (error: unknown) => error === transient)
  assert.deepEqual(attempted, ['a1'], 'the sibling account is not asked inside the turn')
})

test('a 401 rejected again after the one refresh hard-terminates the logical request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-reliability-cycle-'))
  const blocks = new ClaudeProtocolBlockStore({ directory })
  let stored = session('a1')
  let calls = 0
  let refreshCount = 0
  const manager = new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'cycle',
    makeOptions: () => ({
      preemptMs: 0,
      isPermanent: () => false,
      refresh: async current => {
        refreshCount += 1
        return { ...current, accessToken: `${current.accessToken}-refreshed` }
      },
    }),
    io: {
      list: async () => [{ key: 'a1', session: stored }],
      get: async () => stored,
      save: async (_key, value) => { stored = value },
      remove: async () => {},
    },
  })
  const cycleAdapter = new ClaudeAdapter({
    models: [], discovery: false, streamIdleTimeoutMs: 5_000, tokens: manager,
    fetchFn: async () => {
      calls += 1
      return new Response('{"error":"expired"}', { status: 401 })
    },
    deviceFingerprint: () => FINGERPRINT,
    protocolBlocks: blocks,
    continuation: await ownedClaudeContinuation(t, ['a1']),
    requestRecord: new PermittingRecordPort(),
  })
  try {
    await assert.rejects(async () => {
      for await (const _chunk of cycleAdapter.streamAccount({ ...OPTIONS, sessionId: SessionId('sess-auth-cycle') }, 'a1')) { /* drain */ }
    }, (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'AUTH')
      assert.equal(error.failure.retryDisposition, 'forbid', 'the refresh budget is spent, so this request stops')
      return true
    })
    assert.equal(calls, 2, 'one original attempt and its one controlled replay')
    assert.equal(refreshCount, 1, 'exactly one refresh per logical request')
  } finally {
    await cleanup(directory)
  }
})
