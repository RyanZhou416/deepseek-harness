/**
 * One single-account Messages turn: build nothing, decide everything.
 *
 * The caller supplies an already-built request and a transport; this engine issues it once,
 * frames the raw SSE bytes, tracks the three lifecycle facts separately, and reports a typed
 * terminal. It never retries across accounts or machines: the only recovery it can perform is
 * the one the caller's own hook promises, and the caller's own hook is the only thing that may
 * refuse a request before it is issued.
 *
 * The rejection vocabulary is the plugin's, imported rather than restated
 * (`claude-protocol.ts` owns the recognized Anthropic error types and the version-refusal
 * markers). The ordering below is this engine's, and is the Claude route's subset: the
 * harness-side enforcement wording table stays owned by the plugin's `common.ts` and is
 * deliberately not copied here.
 *
 * @module dsh-plugin-subscriptions/claude-engine/stream
 */

import {
  anthropicErrorEventRule,
  matchesClaudeVersionRejection,
} from './failure-rules.js'
import { createSseFramer } from './sse.js'
import type {
  ClaudeEngineEvent,
  ClaudeEngineFailure,
  ClaudeEngineHead,
  ClaudeEngineLifecycle,
  ClaudeEngineOutcome,
  ClaudeEngineRequest,
  ClaudeEngineRetryDisposition,
  ClaudeEngineScope,
  ClaudeEngineTransport,
  ClaudeEngineUsage,
} from './types.js'

/** The largest request id the engine will carry into a diagnostic. */
const REQUEST_ID_LIMIT = 200

/** The largest error body the engine will parse. */
const ERROR_BODY_LIMIT = 64 * 1024

/** What the caller must provide for one turn. */
export interface ClaudeEngineTurnHooks {
  /**
   * Decide whether this request may be issued, and with which credential.
   *
   * Required: the engine has no default that would let a request out unchecked. Returning
   * `{ ok: false }` refuses the request before any POST, and the turn ends with that refusal.
   * @param request - the request about to be issued.
   * @returns the verdict, with a replacement access token when the caller rotates one.
   */
  readonly beforeRequest: (request: ClaudeEngineRequest) => Promise<ClaudeEngineVerdict> | ClaudeEngineVerdict
  /**
   * Answer a 401 with at most one replacement credential.
   *
   * Absent means no recovery is attempted, which is the default: the engine never crosses
   * accounts, machines or vaults on its own.
   * @param context - the rejected status and the attempt ordinal.
   * @returns whether to replay once with a new token, or to stop.
   */
  readonly recoverUnauthorized?: (context: {
    readonly status: number
    readonly attempt: number
  }) => Promise<ClaudeEngineRecovery> | ClaudeEngineRecovery
  /**
   * Observe bounded usage once per turn.
   * @param usage - the totals the stream reported.
   */
  readonly onUsage?: (usage: ClaudeEngineUsage) => void
}

/** The pre-request verdict. */
export type ClaudeEngineVerdict =
  | { readonly ok: true; readonly accessToken?: string }
  | { readonly ok: false; readonly reason: string }

/** The answer to a rejected credential. */
export type ClaudeEngineRecovery =
  | { readonly retry: 'once'; readonly accessToken: string }
  | { readonly retry: 'stop'; readonly reason?: string }

/** One turn's inputs. */
export interface ClaudeEngineTurnInput {
  /** The request to issue, exactly as built. */
  readonly request: ClaudeEngineRequest
  /** The injected transport; there is no default. */
  readonly transport: ClaudeEngineTransport
  /** The caller's hooks; `beforeRequest` is mandatory. */
  readonly hooks: ClaudeEngineTurnHooks
  /** Caller cancellation. */
  readonly signal?: AbortSignal
}

/**
 * Run one Messages turn.
 *
 * The returned stream yields raw bytes as they arrive and ends with exactly one `terminal`
 * event. A failure is a value in that terminal, never a thrown harness error, so a caller
 * outside the harness can route on it.
 * @param input - the request, transport, hooks and cancellation.
 * @returns the turn's events.
 */
export async function* runClaudeEngineTurn(input: ClaudeEngineTurnInput): AsyncGenerator<ClaudeEngineEvent> {
  const lifecycle = { issued: false, responseReceived: false, terminalKnown: false }
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort(input.signal?.reason)
  if (input.signal?.aborted === true) controller.abort(input.signal.reason)
  else input.signal?.addEventListener('abort', forwardAbort, { once: true })
  // Set once a terminal has been emitted or the response has been fully consumed, so the
  // generator's own teardown can tell "the turn ended" from "the consumer walked away".
  let settled = false
  let release: (() => Promise<void>) | undefined
  try {
    if (controller.signal.aborted) {
      settled = true
      yield terminal('cancelled', lifecycle, { kind: 'cancelled', detail: 'the caller aborted before the request was issued' })
      return
    }
    let accessToken: string | undefined
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (controller.signal.aborted) {
        settled = true
        yield terminal('cancelled', lifecycle, { kind: 'cancelled', detail: 'the caller aborted before this attempt was issued' })
        return
      }
      const request = accessToken === undefined ? input.request : withToken(input.request, accessToken)
      // The pre-request policy runs for every attempt, including the recovered one: it may have
      // changed while the first attempt was in flight, and it is the caller's only gate.
      const verdict = await runBeforeRequest(request)
      if (verdict.kind === 'threw') {
        settled = true
        yield terminal('failed', lifecycle, verdict.failure)
        return
      }
      if (verdict.value.ok === false) {
        settled = true
        yield terminal('failed', lifecycle, { kind: 'refused-before-send', reason: verdict.value.reason })
        return
      }
      if (controller.signal.aborted) {
        settled = true
        yield terminal('cancelled', lifecycle, { kind: 'cancelled', detail: 'the caller aborted while the request was being prepared' })
        return
      }
      accessToken = verdict.value.accessToken ?? accessToken
      const result = await send(accessToken === undefined ? input.request : withToken(input.request, accessToken))
      if (result.kind === 'failed') {
        // The transport is the only layer that knows whether the request left the process, and a
        // cancellation does not make the submission unknown: the request may still have been sent.
        lifecycle.issued = result.issued
        settled = true
        yield terminal('failed', lifecycle, result.issued
          ? {
            kind: 'ambiguous-send',
            detail: 'the request was issued and no response head arrived, so its outcome is unknown',
          }
          : { kind: 'transport', detail: result.detail, retryDisposition: 'allow' })
        return
      }
      lifecycle.issued = true
      lifecycle.responseReceived = true
      release = result.release
      if (result.head.status >= 200 && result.head.status < 300) {
        // Exactly one head reaches the caller, and only for the response the turn actually reads.
        yield { type: 'head', head: result.head }
        yield* streamResponse(result.body, result.requestId, lifecycle, input.hooks, controller.signal)
        settled = true
        return
      }
      // A failed response is read boundedly and classified once, before any recovery decision: a
      // version or enforcement refusal outranks the authentication replay on any status.
      const classified = await classifyHttpFailure(result.head, result.body)
      const failure = classified.failure
      await releaseBody()
      const finalFailure = failure.kind === 'http' && failure.retryDisposition === 'forbid'
        ? failure
        : result.head.status === 401 && attempt > 1
          ? httpFailure('AUTH', 401, 'forbid', 'account')
          : failure
      const recoverable = attempt === 1 && finalFailure.kind === 'http' && finalFailure.reason === 'AUTH'
        && input.hooks.recoverUnauthorized !== undefined
      if (recoverable) {
        const recovery = await input.hooks.recoverUnauthorized?.({ status: result.head.status, attempt: 1 })
        if (recovery?.retry === 'once') {
          accessToken = recovery.accessToken
          continue
        }
        void recovery
      }
      // A refusal the engine read to its end is a known outcome, not an unknown one: the reason is
      // decided and no work is outstanding. It stays a failure, and a forbidding disposition still
      // forbids an automatic replay, so a caller's ledger records a decided failure rather than an
      // open unknown. A refusal whose body could not be read to its end stays unknown.
      lifecycle.terminalKnown = classified.readComplete
      settled = true
      yield terminal('failed', lifecycle, finalFailure)
      return
    }
    // Two attempts is the whole budget: the second one is the last.
    settled = true
    yield terminal('failed', lifecycle, { kind: 'ambiguous-send', detail: 'the authentication recovery budget is spent' })
  } finally {
    input.signal?.removeEventListener('abort', forwardAbort)
    if (!settled) {
      // The consumer stopped early: abandon this attempt's transport before releasing it, so
      // nothing is left reading after the caller walked away.
      controller.abort(new Error('claude engine turn closed by its consumer'))
    }
    // Every path releases the response this attempt held, whether the turn ended on its own or
    // the consumer walked away.
    await releaseBody()
  }

  /** Release the response this attempt holds, whichever path is leaving it. */
  async function releaseBody(): Promise<void> {
    const pending = release
    release = undefined
    if (pending === undefined) return
    try {
      await pending()
    } catch (error: unknown) {
      // A release failure must not replace the outcome the turn already decided.
      void error
    }
  }

  /**
   * Run the caller's pre-request hook, containing its failure.
   * @param request - the request about to be issued.
   * @returns the verdict, or the typed failure its throw produced.
   */
  async function runBeforeRequest(request: ClaudeEngineRequest): Promise<
    | { readonly kind: 'value'; readonly value: ClaudeEngineVerdict }
    | { readonly kind: 'threw'; readonly failure: ClaudeEngineFailure }
  > {
    try {
      return { kind: 'value', value: await input.hooks.beforeRequest(request) }
    } catch (error: unknown) {
      // The hook's own message may carry anything, including a credential; the engine reports the
      // failure by name and keeps no part of what it said.
      void error
      return { kind: 'threw', failure: { kind: 'hook-failed', hook: 'beforeRequest' } }
    }
  }

  /** Issue the request once, reporting cancellation as its own outcome. */
  async function send(request: ClaudeEngineRequest): ReturnType<ClaudeEngineTransport> {
    try {
      return await input.transport(request, controller.signal)
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return { kind: 'failed', detail: error instanceof Error ? error.message : 'aborted', issued: false }
      }
      // The transport threw after being handed the request without reporting whether it left:
      // the conservative answer is that it may have, which forbids an automatic replay.
      return { kind: 'failed', detail: error instanceof Error ? error.message : 'transport failed', issued: true }
    }
  }
}

/**
 * Consume a response body without keeping it, for a body that is being abandoned.
 * @param body - the bytes to drain.
 */
async function drain(body: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const _chunk of body) { /* the rejected response is released, never retained */ }
}

/** Stop reasons the V1 engine can present as a completed turn. */
const MODELED_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'refusal',
])

/** Assemble one stream failure record. */
function streamRejection(
  reason: string,
  retryDisposition: ClaudeEngineRetryDisposition,
  scope: ClaudeEngineScope,
): ClaudeEngineFailure {
  return { kind: 'stream', reason, retryDisposition, scope }
}

/**
 * Whether a tool call's accumulated arguments are a complete JSON object.
 * @param json - the accumulated text.
 * @returns true when it parses to an object.
 */
function isJsonObject(json: string): boolean {
  if (json.length === 0) return false
  try {
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/** The state one response's events build, and the verdict each event reaches. */
interface ClaudeTerminalState {
  /** Whether a valid business terminal was observed. */
  readonly sawTerminal: boolean
  /**
   * Whether the service itself stated an outcome, even a failing one.
   *
   * A message_stop or an in-band error event is the service's own statement, so the turn's outcome
   * is decided; a frame that could not be parsed, or a body that ended early, is not.
   */
  readonly statedOutcome: boolean
  /** The failure that ended the turn, when one did. */
  readonly failure: ClaudeEngineFailure | undefined
  /**
   * Observe one event.
   * @param event - the parsed event object.
   * @param delivered - whether output already reached the caller.
   * @returns whether to keep reading, stop at a terminal, or fall over.
   */
  observe(event: Record<string, unknown>, delivered: boolean): 'continue' | 'terminal' | 'failed'
}

/**
 * Create the validator one response's business terminal is judged by.
 *
 * A message_stop alone is not success: the turn must have opened with message_start, no content
 * block may still be open, a tool call must carry parseable arguments unless a generation limit
 * cut it short, a stop reason must be stated, and it must be one this engine can present.
 * Anything else ends the turn as a failure rather than as a completed answer.
 * @returns the state machine the framing loop drives.
 */
function createTerminalState(): ClaudeTerminalState {
  let started = false
  let stopReason: string | undefined
  let terminal = false
  let stated = false
  let failure: ClaudeEngineFailure | undefined
  const openBlocks = new Map<number, { type: string; json: string }>()
  const toolArguments = new Map<number, string>()
  return {
    get sawTerminal() { return terminal },
    get statedOutcome() { return stated },
    get failure() { return failure },
    observe(event, delivered) {
      const type = typeof event['type'] === 'string' ? event['type'] : ''
      if (type === 'error') {
        // The service named its own failure: the outcome is decided even though the turn failed.
        stated = true
        failure = classifySseFailure(event['error'], delivered)
        return 'failed'
      }
      if (type === 'message_start') {
        started = true
        return 'continue'
      }
      if (type === 'message_stop') {
        stated = true
        if (!started || openBlocks.size > 0 || stopReason === undefined) {
          failure = streamRejection('MALFORMED_RESPONSE', 'forbid', 'operation')
          return 'failed'
        }
        if (!MODELED_STOP_REASONS.has(stopReason)) {
          failure = streamRejection('UNSUPPORTED_RESPONSE', 'forbid', 'operation')
          return 'failed'
        }
        // A tool call cut short by a generation limit is dropped downstream; any other
        // unparseable arguments would be an executable call whose body nobody can read.
        if (stopReason !== 'max_tokens' && [...toolArguments.values()].some(json => !isJsonObject(json))) {
          failure = streamRejection('MALFORMED_RESPONSE', 'forbid', 'operation')
          return 'failed'
        }
        terminal = true
        return 'terminal'
      }
      if (!started) {
        if (type === 'ping' || type === '') return 'continue'
        // A content event before the message opened is not a stream this engine interprets.
        failure = streamRejection('MALFORMED_RESPONSE', 'forbid', 'operation')
        return 'failed'
      }
      if (type === 'content_block_start') {
        const index = typeof event['index'] === 'number' ? event['index'] : openBlocks.size
        const block = event['content_block']
        const blockType = typeof block === 'object' && block !== null
          ? String((block as Record<string, unknown>)['type'] ?? '')
          : ''
        openBlocks.set(index, { type: blockType, json: '' })
        return 'continue'
      }
      if (type === 'content_block_delta') {
        const index = typeof event['index'] === 'number' ? event['index'] : -1
        const delta = event['delta']
        const partial = typeof delta === 'object' && delta !== null
          ? (delta as Record<string, unknown>)['partial_json']
          : undefined
        const open = openBlocks.get(index)
        if (open !== undefined && typeof partial === 'string') open.json += partial
        return 'continue'
      }
      if (type === 'content_block_stop') {
        const index = typeof event['index'] === 'number' ? event['index'] : -1
        const open = openBlocks.get(index)
        if (open !== undefined) {
          if (open.type === 'tool_use') toolArguments.set(index, open.json)
          openBlocks.delete(index)
        }
        return 'continue'
      }
      if (type === 'message_delta') {
        const delta = event['delta']
        const reason = typeof delta === 'object' && delta !== null
          ? (delta as Record<string, unknown>)['stop_reason']
          : undefined
        if (typeof reason === 'string' && reason.length > 0) stopReason = reason
        return 'continue'
      }
      return 'continue'
    },
  }
}

/**
 * Frame one accepted response into events.
 * @param body - raw bytes as received.
 * @param requestId - the server's own request id, when the head carried one.
 * @param lifecycle - the mutable lifecycle record for this attempt.
 * @param hooks - the caller's hooks.
 * @returns the turn's remaining events.
 */
async function* streamResponse(
  body: AsyncIterable<Uint8Array>,
  requestId: string | undefined,
  lifecycle: ClaudeEngineLifecycle & { issued: boolean; responseReceived: boolean; terminalKnown: boolean },
  hooks: ClaudeEngineTurnHooks,
  signal: AbortSignal,
): AsyncGenerator<ClaudeEngineEvent> {
  const usage = usageChannel(requestId, hooks)
  const framer = createSseFramer()
  const decoder = new TextDecoder()
  const state = createTerminalState()
  let failure: ClaudeEngineFailure | undefined
  let delivered = false
  let readFailure: unknown
  let overflowed = false
  try {
    for await (const chunk of body) {
      // The chunk's own frames are interpreted before the caller sees them. A chunk that completes
      // a statement this engine rejects must not be delivered: forwarding it would let a caller act
      // on a message_stop that the turn then reports as failed. Prefix chunks already delivered stay
      // as they were; the chunk carrying the rejected statement is withheld whole.
      const pushed = framer.push(decoder.decode(chunk, { stream: true }))
      let chunkEndsTurn = false
      let chunkStatesError = false
      for (const event of pushed.events) {
        let parsed: unknown
        try {
          parsed = JSON.parse(event.data)
        } catch {
          failure = streamRejection('MALFORMED_RESPONSE', 'forbid', 'operation')
          break
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          // A frame that is valid JSON but not an event object cannot be interpreted.
          failure = streamRejection('MALFORMED_RESPONSE', 'forbid', 'operation')
          break
        }
        const event_ = parsed as Record<string, unknown>
        const type = typeof event_['type'] === 'string' ? event_['type'] : ''
        if (type === 'message_start' || type === 'message_delta') usage.observe(event_)
        const verdict = state.observe(event_, delivered)
        if (verdict === 'failed') {
          failure = state.failure ?? streamRejection('UNSUPPORTED_RESPONSE', 'forbid', 'operation')
          // A provider error frame is the service stating its own failure, so the caller may see it;
          // any other rejection is withheld.
          chunkStatesError = type === 'error'
          break
        }
        if (verdict === 'terminal') {
          chunkEndsTurn = true
          break
        }
      }
      if (pushed.overflowed === true) {
        // A frame past the framer's cap is not a stream this engine will interpret, and the
        // oversized bytes themselves are withheld so nothing unbounded reaches the caller.
        overflowed = true
        failure = streamRejection('MALFORMED_RESPONSE', 'forbid', 'operation')
        break
      }
      if (failure !== undefined && !chunkStatesError) break
      yield { type: 'bytes', bytes: chunk }
      delivered = true
      if (chunkEndsTurn || failure !== undefined) break
    }
  } catch (error: unknown) {
    // A read that fails is either the caller stopping it or the transport dropping it.
    readFailure = error
  }
  usage.flush()
  const sawStop = state.sawTerminal && state.failure === undefined
  if (signal.aborted) {
    yield terminal('cancelled', lifecycle, {
      kind: 'cancelled',
      detail: 'the caller aborted the response',
    })
    return
  }
  if (readFailure !== undefined && failure === undefined && !sawStop) {
    yield terminal('incomplete', lifecycle, {
      kind: 'stream',
      reason: 'STREAM_INCOMPLETE',
      retryDisposition: 'forbid',
      scope: 'operation',
    })
    return
  }
  if (failure !== undefined) {
    lifecycle.terminalKnown = state.statedOutcome
    yield terminal('failed', lifecycle, failure)
    return
  }
  if (!sawStop) {
    // The response was accepted, so the request was sent and its outcome is unknown: an
    // incomplete turn is not a safe replay, whatever was delivered before the body ended.
    yield terminal('incomplete', lifecycle, {
      kind: 'stream',
      reason: 'STREAM_INCOMPLETE',
      retryDisposition: 'forbid',
      scope: 'operation',
    })
    return
  }
  lifecycle.terminalKnown = true
  yield terminal('complete', lifecycle)
}

/**
 * Track bounded usage from a response's own events.
 * @param requestId - the head's request id, when it carried one.
 * @param hooks - the caller's observer.
 * @returns the accumulator the framing loop drives.
 */
function usageChannel(requestId: string | undefined, hooks: ClaudeEngineTurnHooks): {
  observe: (event: Record<string, unknown>) => void
  flush: () => void
} {
  const totals: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  } = {}
  let reported = false
  const numberAt = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  const merge = (source: unknown): void => {
    if (typeof source !== 'object' || source === null) return
    const record = source as Record<string, unknown>
    const input = numberAt(record['input_tokens'])
    const output = numberAt(record['output_tokens'])
    const cacheRead = numberAt(record['cache_read_input_tokens'])
    const cacheWrite = numberAt(record['cache_creation_input_tokens'])
    const reasoning = numberAt(record['thinking_tokens'])
    if (input !== undefined) totals.inputTokens = input
    if (output !== undefined) totals.outputTokens = output
    if (cacheRead !== undefined) totals.cacheReadTokens = cacheRead
    if (cacheWrite !== undefined) totals.cacheWriteTokens = cacheWrite
    if (reasoning !== undefined) totals.reasoningTokens = reasoning
    reported = true
  }
  return {
    observe(event) {
      if (event['type'] === 'message_start') {
        const message = event['message']
        if (typeof message === 'object' && message !== null) merge((message as Record<string, unknown>)['usage'])
      } else {
        merge(event['usage'])
      }
    },
    flush() {
      if (!reported) return
      const usage: ClaudeEngineUsage = {
        ...totals.inputTokens === undefined ? {} : { inputTokens: totals.inputTokens },
        ...totals.outputTokens === undefined ? {} : { outputTokens: totals.outputTokens },
        ...totals.cacheReadTokens === undefined ? {} : { cacheReadTokens: totals.cacheReadTokens },
        ...totals.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: totals.cacheWriteTokens },
        ...totals.reasoningTokens === undefined ? {} : { reasoningTokens: totals.reasoningTokens },
        ...requestId === undefined ? {} : { requestId },
      }
      hooks.onUsage?.(usage)
    },
  }
}

/**
 * Replace the credential on an already-built request.
 * @param request - the original request.
 * @param accessToken - the replacement token.
 * @returns the same request with its bearer authorization replaced.
 */
function withToken(request: ClaudeEngineRequest, accessToken: string): ClaudeEngineRequest {
  return {
    ...request,
    headers: request.headers.map(([name, value]) =>
      name.toLowerCase() === 'authorization' ? [name, `Bearer ${accessToken}`] as const : [name, value] as const),
  }
}

/**
 * Build the terminal event for one outcome.
 * @param outcome - the business outcome.
 * @param lifecycle - the lifecycle facts observed.
 * @param failure - the failure, when the outcome is not `complete`.
 * @returns the terminal event.
 */
function terminal(
  outcome: ClaudeEngineOutcome,
  lifecycle: { readonly issued: boolean; readonly responseReceived: boolean; readonly terminalKnown: boolean },
  failure?: ClaudeEngineFailure,
): ClaudeEngineEvent {
  return {
    type: 'terminal',
    outcome,
    state: {
      issued: lifecycle.issued,
      responseReceived: lifecycle.responseReceived,
      terminalKnown: lifecycle.terminalKnown,
    },
    ...failure === undefined ? {} : { failure },
  }
}

/**
 * Classify a failed response head.
 *
 * Version refusal first (it outranks every retry signal), then the provider's own explicit
 * stop-retry signals, then the status. A body the engine cannot classify ends the turn: an
 * unrecognized refusal is never reported as a replayable transient failure.
 * @param head - the response head.
 * @param body - the response body, read boundedly and dropped.
 * @returns the classified failure, and whether the refusal was read to its end.
 */
async function classifyHttpFailure(
  head: ClaudeEngineHead,
  body: AsyncIterable<Uint8Array>,
): Promise<{ readonly failure: ClaudeEngineFailure; readonly readComplete: boolean }> {
  const read = await readBounded(body)
  const text = read.text
  const version = matchesClaudeVersionRejection(text)
  if (version) return { failure: httpFailure('CLIENT_VERSION_UNSUPPORTED', head.status, 'forbid', 'provider-profile'), readComplete: read.complete }
  const stopRetry = head.headers['x-should-retry']?.trim().toLowerCase() === 'false'
  const rejected = head.headers['anthropic-ratelimit-unified-status']?.trim().toLowerCase() === 'rejected'
  if (stopRetry || rejected) return { failure: httpFailure('ENFORCEMENT', head.status, 'forbid', 'account'), readComplete: read.complete }
  if (head.status === 401) return { failure: httpFailure('AUTH', head.status, 'allow', 'account'), readComplete: read.complete }
  if (head.status === 403) return { failure: httpFailure('PERMISSION_DENIED', head.status, 'forbid', 'operation'), readComplete: read.complete }
  if (head.status === 429) return { failure: httpFailure('RATE_LIMIT', head.status, 'allow', 'account'), readComplete: read.complete }
  if (head.status === 408 || head.status === 504) return { failure: httpFailure('TIMEOUT', head.status, 'allow', 'operation'), readComplete: read.complete }
  if (head.status >= 500) return { failure: httpFailure('SERVER', head.status, 'allow', 'operation'), readComplete: read.complete }
  return { failure: httpFailure('UNCLASSIFIED_PROVIDER_ERROR', head.status, 'forbid', 'unknown'), readComplete: read.complete }
}

/** Assemble one HTTP failure record. */
function httpFailure(
  reason: string,
  status: number,
  retryDisposition: ClaudeEngineRetryDisposition,
  scope: ClaudeEngineScope,
): ClaudeEngineFailure {
  return { kind: 'http', reason, status, retryDisposition, scope }
}

/**
 * Classify one in-band error event.
 * @param error - the event's error object.
 * @param delivered - whether output already reached the caller.
 * @returns the classified failure.
 */
function classifySseFailure(error: unknown, delivered: boolean): ClaudeEngineFailure {
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  const type = typeof record['type'] === 'string' ? record['type'] : undefined
  const message = typeof record['message'] === 'string' ? record['message'] : undefined
  const details = typeof record['details'] === 'object' && record['details'] !== null
    ? record['details'] as Record<string, unknown>
    : undefined
  const code = typeof record['code'] === 'string'
    ? record['code']
    : typeof record['error_code'] === 'string'
      ? record['error_code']
      : typeof details?.['error_code'] === 'string' ? details['error_code'] as string : undefined
  if (matchesClaudeVersionRejection(code ?? '') || matchesClaudeVersionRejection(type ?? '')
    || matchesClaudeVersionRejection(message ?? '')) {
    return streamFailure('CLIENT_VERSION_UNSUPPORTED', 'forbid', 'provider-profile', delivered)
  }
  const rule = anthropicErrorEventRule(type, message)
  if (rule === undefined) return streamFailure('UNCLASSIFIED_PROVIDER_ERROR', 'forbid', 'unknown', delivered)
  const disposition: ClaudeEngineRetryDisposition =
    delivered || rule.retryDisposition === 'forbid' ? 'forbid' : 'allow'
  return streamFailure(rule.code, disposition, rule.scope, delivered)
}

/** Assemble one stream failure record, honouring the delivery boundary. */
function streamFailure(
  reason: string,
  retryDisposition: ClaudeEngineRetryDisposition,
  scope: ClaudeEngineScope,
  delivered: boolean,
): ClaudeEngineFailure {
  return {
    kind: 'stream',
    reason,
    retryDisposition: delivered ? 'forbid' : retryDisposition,
    // Delivery changes the disposition, not the evidence: a compatibility-profile refusal stays
    // scoped to the profile, so the block it requires is still recorded after output.
    scope: delivered && scope !== 'provider-profile' ? 'operation' : scope,
  }
}

/**
 * Read a response body under a byte cap.
 * @param body - the response bytes.
 * @returns the decoded text and whether the body was read to its end inside the cap. A read that
 * stops at the cap, or that throws, leaves the refusal only partly seen.
 */
async function readBounded(body: AsyncIterable<Uint8Array>): Promise<{ readonly text: string; readonly complete: boolean }> {
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    for await (const chunk of body) {
      bytes += chunk.byteLength
      if (bytes > ERROR_BODY_LIMIT) return { text, complete: false }
      text += decoder.decode(chunk, { stream: true })
    }
    return { text, complete: true }
  } catch (error: unknown) {
    void error
    return { text, complete: false }
  }
}
