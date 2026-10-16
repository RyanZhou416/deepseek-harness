/**
 * Drive the shipped headless agent loop through the real Claude subscription route and observe
 * one continuation chain across two OS processes.
 *
 * This fixture is a composition entry, not a driver. The headless app's own runner creates the
 * Agent and runs the turn, so the loop — not this file — dispatches `ctx.llm.stream`, and the
 * route that answers is the one the real plugin module registered. The fixture supplies only the
 * non-serializable internals no Loader can supply, through the recording assembly's factory, and
 * states its own Messages transport; it never creates an Agent, appends a message or writes the
 * session.
 *
 * Every POST is checked against the Host's own durable facts before it is answered:
 *  - the session's persisted `llm/request-record` carries exactly the system text of this body;
 *  - `spans.json` under the plugin's private continuation root already holds this request's
 *    `X-Claude-Code-Session-Id` for this harness session, so the wire identity was durable
 *    BEFORE the send, and `salt.json` exists;
 *  - the billing block's `cc_prompt_id` and `cc_prev_req` are read from the request bytes, and
 *    `x-cc-atis` is recorded as the pinned header (absent while this account has no ATIS fact).
 * A destination outside the pinned Messages endpoint, or any process-global fetch, is refused and
 * fails the composition rather than reaching a peer.
 *
 * Each wake prints one marker line carrying the observed facts (synthetic account reference only,
 * never an account key, token or e-mail) so the test can compare the wakes, together with the
 * product-module plane this child loaded and the entry URL it loaded it from. The answer a
 * wake receives comes from a closed set this file serves — a plain completed text turn, the same
 * turn with signed thinking, or accepted text followed by an in-band failure — and a wake may
 * state its own synthetic response id, so a failure's id can be told apart from a success's.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { sameClaudeAccountRef, CLAUDE_PROTOCOL_PROFILE, productModuleObservation, subscriptions } from './subscription-test-modules.mjs'
import { createRecordingAssembly } from './claude-request-recording-probe.mjs'

export const name = 'claude-continuation-probe'

/** The plugin's services, plus the persistence the POST-time log check reads through. */
export const inject = ['llm', 'sessionPersistence']

/** The real plugin's config schema: this entry's config is the subscription composition's own. */
export const Config = subscriptions.Config

/** Model the static catalogue states and the agent loop is configured for. */
const MODEL = 'claude-opus-4-5'

/** Where the composing test states this wake's inputs, inside the private process cwd. */
const EXPECT_FILE = '.claude-continuation-expect.json'

/** Prefix of the one line this fixture writes per POST. */
const MARKER = 'CLAUDE_CONTINUATION_WAKE'

/** The pinned Messages endpoint; every other destination is refused. */
const MESSAGES_ENDPOINT = new URL(CLAUDE_PROTOCOL_PROFILE.endpoints.messages)

/** The closed set of answers one wake may state; the default is the plain completed text turn. */
const RESPONSE_KINDS = ['success', 'thinking-success', 'partial-error']

/** One SSE frame. */
function frame(event) {
  return `data: ${JSON.stringify(event)}\n\n`
}

/**
 * The frames of one scripted answer over the pinned Messages stream.
 * @param kind - the answer this wake stated.
 * @param messageId - the synthetic message id the answer opens with.
 * @returns the framed stream.
 */
function responseSse(kind, messageId) {
  const start = frame({ type: 'message_start', message: { id: messageId, usage: { input_tokens: 3 } } })
  if (kind === 'thinking-success') {
    // The signed thinking a later request of the same model would have to replay.
    return [
      start,
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } }),
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-9' } }),
      frame({ type: 'content_block_stop', index: 0 }),
      frame({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
      frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'continuation observed' } }),
      frame({ type: 'content_block_stop', index: 1 }),
      frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      frame({ type: 'message_stop' }),
    ].join('')
  }
  if (kind === 'partial-error') {
    // Text the translator already accepted, then the in-band failure the service sends.
    return [
      start,
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial before the failure' } }),
      frame({ type: 'content_block_stop', index: 0 }),
      frame({ type: 'error', error: { type: 'api_error', message: 'busy' } }),
    ].join('')
  }
  return [
    start,
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'continuation observed' } }),
    frame({ type: 'content_block_stop', index: 0 }),
    frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
    frame({ type: 'message_stop' }),
  ].join('')
}

/**
 * The thinking facts the incoming request carries, as counts and a signature digest.
 *
 * The observation must state whether a signed thinking block rode this request without
 * disclosing what it says, so only the counts and a digest of the signature values are kept.
 * @param messages - the request body's message array.
 * @returns the thinking block counts and the digest of the signatures they carried.
 */
function thinkingFacts(messages) {
  const signatures = []
  let blocks = 0
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type !== 'thinking') continue
      blocks += 1
      if (typeof block.signature === 'string' && block.signature.length > 0) signatures.push(block.signature)
    }
  }
  return {
    thinkingBlocks: blocks,
    signedThinkingBlocks: signatures.length,
    signedThinkingDigest: signatures.length === 0
      ? null
      : createHash('sha256').update(signatures.join('\u0000')).digest('hex').slice(0, 16),
  }
}

/**
 * This wake's own inputs, stated by the composing test in the private cwd.
 * @returns the parsed expectation document.
 */
async function readExpectation() {
  const text = await readFile(join(process.cwd(), EXPECT_FILE), 'utf8')
  return JSON.parse(text)
}

/**
 * The billing block's continuation facts, read from the request bytes.
 *
 * The pinned builder carries both segments in the first system block, so they are read there and
 * never from an invented body field or an HTTP header.
 * @param systemTexts - the ordered system text of the serialized body.
 * @returns the turn's own prompt id and the chained previous request id.
 */
function billingFacts(systemTexts) {
  const billing = systemTexts[0] ?? ''
  return {
    promptId: /cc_prompt_id=([^;]+);/.exec(billing)?.[1],
    previousRequestId: / cc_prev_req=([^;]+);/.exec(billing)?.[1],
  }
}

/**
 * The durable identity facts this POST depends on, read from the plugin's private root.
 *
 * The generation record is the accepted schema this build writes (`version`, `accounts[]` rows
 * carrying `accountRef`, `generation`, `reason`, `pending`, `advancedAt`), and the row is the one
 * the real comparator matches to the span's own account. A missing, unreadable, unmatched or
 * still-pending record is a failure of this composition, never an absent fact.
 * @param harnessSessionId - the harness session the request named.
 * @param wireSessionId - the wire identity the request carried.
 * @returns the matched span's epoch and account reference, the account's durable generation, and
 *   whether the salt document is in place.
 * @throws Error when the span, the salt or the generation record does not state what the send needs.
 */
async function durableIdentity(harnessSessionId, wireSessionId) {
  const root = dshHomePath('plugins', 'subscriptions', 'claude-continuation')
  const spans = JSON.parse(await readFile(join(root, 'spans.json'), 'utf8'))
  let matched
  for (const account of spans.accounts ?? []) {
    for (const span of account.spans ?? []) {
      if (span.wireSessionId === wireSessionId) matched = { span, account }
    }
  }
  if (matched === undefined) {
    throw new Error('claude-continuation-probe: no stored span carries this request\'s wire session id')
  }
  if (matched.span.harnessSessionId !== harnessSessionId) {
    throw new Error('claude-continuation-probe: the stored span belongs to another harness session')
  }
  let saltPresent = false
  try {
    saltPresent = (await readFile(join(root, 'salt.json'), 'utf8')).length > 0
  } catch (error) {
    throw new Error(`claude-continuation-probe: the salt document is unreadable (${String(error)})`)
  }
  let document
  try {
    document = JSON.parse(await readFile(join(root, 'identity-generation.json'), 'utf8'))
  } catch (error) {
    throw new Error(`claude-continuation-probe: the identity generation is unreadable (${String(error)})`)
  }
  if (document?.version !== 1 || !Array.isArray(document.accounts)) {
    throw new Error('claude-continuation-probe: the identity generation document is not one this build writes')
  }
  const rows = document.accounts.filter(row => sameClaudeAccountRef(row?.accountRef, matched.account.accountRef))
  if (rows.length !== 1) {
    throw new Error(`claude-continuation-probe: ${rows.length} generation rows state this account reference`)
  }
  const row = rows[0]
  if (!Number.isSafeInteger(row.generation) || row.generation < 0) {
    throw new Error('claude-continuation-probe: the identity generation row states no generation')
  }
  if (row.generation !== matched.span.spanEpoch) {
    throw new Error('claude-continuation-probe: the generation row and the stored span disagree')
  }
  if (row.pending !== null) {
    throw new Error('claude-continuation-probe: an identity transition is still pending for this account')
  }
  return {
    spanEpoch: matched.span.spanEpoch,
    accountRef: matched.account.accountRef,
    generation: row.generation,
    saltPresent,
  }
}

/**
 * The capture this composition mounts: one scripted Messages transport, the two refusing read
 * transports, and the harness session the loop named.
 * @param ctx - the composition context, used for the POST-time session log read.
 * @returns the capture, with the facts of every answered POST.
 */
function createContinuationCapture(ctx) {
  const posts = []
  const refused = []
  const seen = { sessionId: undefined }
  const refuse = (label) => {
    refused.push(label)
    throw new Error(`claude-continuation-probe: this composition reaches no ${label}`)
  }
  const capture = {
    posts,
    refused,
    seen,
    proxy: undefined,
    productionFiber: undefined,
    attach() {},
    detach() {},
    policyLimitsTransport: async () => refuse('policy_limits read'),
    orgPinTransport: async () => refuse('organization validation'),
  }
  capture.transport = async (url, init) => {
    let target
    try {
      target = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
    } catch (error) {
      throw new Error(`claude-continuation-probe: the route requested an unparseable URL (${String(error)})`)
    }
    if (target.origin !== MESSAGES_ENDPOINT.origin || target.pathname !== MESSAGES_ENDPOINT.pathname) {
      refuse(`${target.origin}${target.pathname}`)
    }
    const expect = await readExpectation()
    const sessionId = seen.sessionId
    if (sessionId === undefined) throw new Error('claude-continuation-probe: the POST arrived before any dispatch named a session')
    const headers = new Headers(init?.headers)
    const wireSessionId = headers.get('x-claude-code-session-id')
    if (wireSessionId === null || wireSessionId.length === 0) {
      throw new Error('claude-continuation-probe: the request carried no wire session id')
    }
    const atis = headers.get('x-cc-atis')
    if (atis !== null && atis.length > 0) {
      throw new Error('claude-continuation-probe: this account has no ATIS fact, so the request must carry no ATIS header')
    }
    const parsed = JSON.parse(String(init?.body))
    const systemTexts = (parsed.system ?? []).map(block => block.text)
    // The Host's own durable record for this exact body, read at send time.
    const handle = await ctx.sessionPersistence.open(sessionId, 'read')
    let recorded
    try {
      const { events } = await handle.read()
      const records = events.filter(event => event.type === 'llm/request-record')
      recorded = records[records.length - 1]
    } finally {
      await handle.close()
    }
    if (recorded === undefined) throw new Error('claude-continuation-probe: the session log holds no prepared record for this send')
    if (JSON.stringify(recorded.data.systemBlocks) !== JSON.stringify(systemTexts)) {
      throw new Error('claude-continuation-probe: the prepared record does not carry this body\'s system text')
    }
    const identity = await durableIdentity(sessionId, wireSessionId)
    const billing = billingFacts(systemTexts)
    if (billing.promptId === undefined) throw new Error('claude-continuation-probe: the billing block carries no cc_prompt_id')
    const expectedPrevious = expect.expectedPreviousRequestId ?? null
    const previous = billing.previousRequestId ?? null
    if (previous !== expectedPrevious) {
      throw new Error(`claude-continuation-probe: the chained cc_prev_req is ${String(previous)}, the caller expected ${String(expectedPrevious)}`)
    }
    // Two wakes answer under distinct synthetic ids, so a chain that carried its own response id
    // by accident would be visible; the request-side chain is still the first wake's id. A wake
    // that states its own id answers under that one, as a failure's id must differ from a success.
    const kind = expect.responseKind ?? 'success'
    if (!RESPONSE_KINDS.includes(kind)) {
      throw new Error(`claude-continuation-probe: the caller stated no answer kind this fixture serves ("${String(kind)}")`)
    }
    const thinking = thinkingFacts(parsed.messages)
    const wake = expect.seed === false ? 'resume' : 'first'
    const requestId = expect.responseRequestId
      ?? `req_synthetic_${wake}_${String(posts.length + 1).padStart(4, '0')}`
    const messageId = `msg_synthetic_${wake}_${String(posts.length + 1).padStart(4, '0')}`
    posts.push({ wireSessionId, systemTexts, recorded, identity, thinking, responseKind: kind, ...billing, requestId })
    process.stdout.write(`${MARKER} ${JSON.stringify({
      pid: process.pid,
      post: posts.length,
      mode: productModuleObservation.mode,
      entryUrl: productModuleObservation.entryUrl,
      sessionId,
      wireSessionId,
      spanEpoch: identity.spanEpoch,
      accountRef: identity.accountRef,
      saltPresent: identity.saltPresent,
      generation: identity.generation,
      atis,
      promptId: billing.promptId,
      previousRequestId: previous,
      requestId,
      model: parsed.model,
      responseKind: kind,
      ...thinking,
    })}\n`)
    return new Response(responseSse(kind, messageId), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'request-id': requestId },
    })
  }
  return capture
}

/**
 * Mount the real plugin under this wake's expectation, with the loop driving it.
 *
 * The dispatch listener records the harness session the loop names; it never short-circuits the
 * waterfall, so the registered route still serves the request. Seeding happens only when this
 * wake's expectation asks for it, so a resume wake reads the identity an earlier process stored
 * instead of manufacturing a login.
 * @param ctx - composition context.
 * @param config - the real subscription config, validated by the Loader against {@link Config}.
 */
export async function apply(ctx, config) {
  const expect = await readExpectation()
  const capture = createContinuationCapture(ctx)
  ctx.on('llm/stream', async function* (options, next) {
    if (options.sessionId !== undefined) capture.seen.sessionId = options.sessionId
    yield* next()
  })
  await createRecordingAssembly(capture, { seed: expect.seed !== false }).apply(ctx, config)
}
