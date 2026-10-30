/**
 * Claude Messages recording seam.
 *
 * Two things live here and nothing else: the pure extraction of the ordered
 * system text from one serialized Messages body, and the port the adapter holds
 * to publish that body's request into the Host's session log before the POST.
 *
 * The Host package is imported for types only. This plugin must still load on a
 * Host that mounts no recording service, so a runtime import of
 * `@deepseek-ai/dsh-llm-request-record` would take every other provider down with
 * it; the fixed failure codes are therefore declared here and pinned to the
 * Host's published union by `satisfies`.
 */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {
  LlmRequestRecordContext,
  LlmRequestRecordFailureCode,
  LlmRequestRecordOutcome,
  LlmRequestRecordPayload,
} from '@deepseek-ai/dsh-llm-request-record'

/** The session id a recorded request is keyed by. */
export type ClaudeRecordSessionId = NonNullable<GenerateOptions['sessionId']>

/**
 * The Host's fixed code for a request that named no session.
 *
 * Its literal is pinned to the Host package's failure-code union, so renaming it
 * on either side fails compilation instead of drifting at runtime.
 */
export const CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED = 'CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED' satisfies LlmRequestRecordFailureCode

/** The Host's fixed code for a request no durable record could carry. */
export const REQUEST_RECORD_UNAVAILABLE = 'REQUEST_RECORD_UNAVAILABLE' satisfies LlmRequestRecordFailureCode

/**
 * The pinned wire library every recorded body was built by, as `name@version`.
 *
 * The library's `exports` map publishes no `./package.json`, so the installed
 * manifest cannot be imported; this literal is pinned beside the builder that
 * uses it, and `test/claude-wire-record.spec.ts` asserts it against the manifest
 * the resolver actually loads.
 */
export const CLAUDE_WIRE_RECORD_LIBRARY = '@tormentalabs/claude-code-wire-compat@0.7.2-dsh15'

/** Whether one parsed JSON value is a plain object rather than an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the ordered system text out of one serialized Messages body.
 *
 * The body is parsed exactly once and its `system` list is mapped in order, so a
 * record states the text this exact request carries rather than what an earlier
 * assembly intended. Only per-block text is returned: a `cache_control` marker
 * and the serialization whitespace between blocks are not part of the record.
 *
 * @param body - the exact serialized Messages body built for this attempt.
 * @returns one entry per emitted system block, in wire order.
 * @throws Error when the body is not the JSON object this route builds.
 */
export function extractClaudeSystemBlocks(body: string): readonly string[] {
  const parsed: unknown = JSON.parse(body)
  if (!isRecord(parsed)) {
    throw new Error('dsh-plugin-subscriptions: the Claude request body is not a JSON object')
  }
  const system = parsed.system
  if (!Array.isArray(system)) {
    throw new Error('dsh-plugin-subscriptions: the Claude request body carries no system block list')
  }
  return system.map((block, index) => {
    if (!isRecord(block) || typeof block.text !== 'string') {
      throw new Error(`dsh-plugin-subscriptions: Claude system block ${index} carries no text`)
    }
    return block.text
  })
}

/**
 * The one operation the port needs from the Host's recording service.
 *
 * Declared structurally so the port depends on the call it makes rather than on
 * the service's own base class: the real service satisfies it, and a caller or a
 * test can state what a recorder answers without constructing a Cordis Context.
 */
export interface ClaudeRequestRecorder {
  /**
   * Append one prepared request and report whether it reached durable storage.
   * @param context - the live session whose log receives the record.
   * @param payload - the observed fields of the request about to be submitted.
   * @returns the Host's outcome; `ok: false` forbids the send.
   */
  recordPreparedRequest(
    context: LlmRequestRecordContext,
    payload: LlmRequestRecordPayload,
  ): Promise<LlmRequestRecordOutcome>
}

/**
 * The recording port the Claude adapter holds for the route's whole life.
 *
 * The bound recorder is the Host's `llmRequestRecord` service, present exactly
 * while the scoped injection that registers this route is active. An unbound port
 * refuses rather than sending unrecorded: the same disposition as an unflushed
 * record, so a route never reaches the wire without a durable record of what it
 * sent.
 */
export class ClaudeRequestRecordPort {
  /** The recorder bound by the route's scoped injection; undefined while the Host provides none. */
  private recorder: ClaudeRequestRecorder | undefined

  /**
   * Bind the Host recorder for as long as the injection that registered the route lives.
   * @param recorder - the Host's request-recording service.
   */
  bind(recorder: ClaudeRequestRecorder): void {
    this.recorder = recorder
  }

  /** Drop the binding; every later record through this port is refused. */
  unbind(): void {
    this.recorder = undefined
  }

  /**
   * Publish one prepared request, or refuse the send.
   * @param sessionId - the harness session the request belongs to; absent names no log.
   * @param payload - the observed fields of the request about to be submitted.
   * @returns the Host's outcome; `ok: false` forbids the send.
   */
  record(
    sessionId: ClaudeRecordSessionId | undefined,
    payload: LlmRequestRecordPayload,
  ): Promise<LlmRequestRecordOutcome> {
    if (sessionId === undefined) {
      return Promise.resolve({ ok: false, code: CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED })
    }
    const recorder = this.recorder
    if (recorder === undefined) {
      return Promise.resolve({ ok: false, code: REQUEST_RECORD_UNAVAILABLE })
    }
    const context: LlmRequestRecordContext = { sessionId }
    return recorder.recordPreparedRequest(context, payload)
  }
}
