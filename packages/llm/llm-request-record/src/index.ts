/**
 * Service Definition AND provider for the prepared-request recording seam
 * (`ctx.llmRequestRecord`): the one place a model route publishes what it is
 * about to send into the session log that owns the request, and the one place
 * that waits for that record to reach durable storage before the route may send
 * anything.
 *
 * The Definition is {@link LlmRequestRecordService}; the provider in this same
 * package is {@link SessionRequestRecordProvider}, the default export, because
 * both roles are owned by this capability and evolve together. The provider
 * appends through the live `SessionStore` and flushes per session; a producer
 * never appends on its own.
 *
 * A record is not an outcome: `phase` is always `'prepared'`, the record's own
 * log `seq` is its identity, and a failed or timed-out flush still leaves the
 * prepared record in the log while forbidding the send.
 *
 * @module @deepseek-ai/dsh-llm-request-record
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  LlmRequestRecordContext,
  LlmRequestRecordData,
  LlmRequestRecordFailureCode,
  LlmRequestRecordPayload,
} from './types.ts'
import { validateRequestRecord } from './record-data.ts'

export { reconstructRequestSystem, requestRecordDigest, validateRequestRecord } from './record-data.ts'
export type {
  LlmRequestRecordContext,
  LlmRequestRecordData,
  LlmRequestRecordFailureCode,
  LlmRequestRecordPayload,
  LlmRequestRecordPurpose,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    llmRequestRecord: LlmRequestRecordService
  }
}

/** No live session log can carry this request, so its producer must not send. */
export const REQUEST_RECORD_UNAVAILABLE = 'REQUEST_RECORD_UNAVAILABLE' satisfies LlmRequestRecordFailureCode

/** The request named no session, so no log can carry its record and nothing may be sent. */
export const CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED = 'CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED' satisfies LlmRequestRecordFailureCode

/**
 * What one recording attempt produced.
 *
 * `ok: true` carries the recorded event's own sequence number — the only
 * identity a prepared record has. `ok: false` forbids the send: no durable
 * record carries the request, and the caller's retry disposition is `forbid`.
 *
 * The union is the capability's whole failure vocabulary, so a caller routes on
 * one set of codes. `REQUEST_RECORD_UNAVAILABLE` is what this service reports;
 * `CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED` is reported by a producer that
 * reaches the seam with no session at all, before there is a service call to
 * make, and it is declared here so that both sides name the same code.
 */
export type LlmRequestRecordOutcome =
  | { readonly ok: true; readonly preparedId: SessionSeq }
  | { readonly ok: false; readonly code: LlmRequestRecordFailureCode }

/** Reason code stamped on the deadline that bounds one durability wait. */
const FLUSH_TIMEOUT_CODE = 'REQUEST_RECORD_FLUSH_TIMEOUT'

/** Loader configuration of the recording service. */
export interface Config {
  /**
   * Milliseconds a prepared record may wait for `SessionStore.flush` before its
   * producer is told the record is not durable.
   *
   * Required, never defaulted: the bound is what keeps a stalled durability
   * listener from holding a model request open indefinitely, so a deployment
   * states it instead of inheriting a compiled-in number.
   */
  readonly flushTimeoutMs: number
}

/**
 * Abstract recording service: the capability a model route depends on to publish
 * a prepared request.
 *
 * One implementation per context; a consumer reaches it through
 * `ctx.inject(['llmRequestRecord'], …)` (a scoped dependency) or `ctx.get`, never
 * by appending to a session itself.
 */
export abstract class LlmRequestRecordService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llmRequestRecord')
  }

  /**
   * Append one prepared request to its session's log and wait for that log to
   * reach durable storage, bounded by the configured deadline.
   * @param context - the live session that owns the request.
   * @param payload - the producer's observation of the request it is about to submit.
   * @returns the recorded event's sequence number, or the fixed reason the
   *   producer must not send. Every condition a producer acts on arrives here as
   *   a result; this method does not reject for one.
   */
  abstract recordPreparedRequest(
    context: LlmRequestRecordContext,
    payload: LlmRequestRecordPayload,
  ): Promise<LlmRequestRecordOutcome>
}

/**
 * Session-log recording provider.
 *
 * It owns the whole record path — validation, append, and the per-session
 * durability wait — so no consumer can append a record that was never flushed.
 * Every flush it starts stays owned by this provider until it settles, and
 * disposal stops admission, then waits for those flushes up to one more
 * deadline. A durability listener's disk write is never cancelled by that
 * deadline: the provider stops waiting, and the write remains the listener's.
 */
export class SessionRequestRecordProvider extends LlmRequestRecordService {
  static inject = ['sessions']

  /** Loader validation for the required durability bound. */
  static Config: z<Config> = z.object({
    flushTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  })

  /** Validated durability bound, fixed at construction. */
  private readonly flushTimeoutMs: number

  /** Flushes this provider started and has not observed settle. */
  private readonly pending = new Set<Promise<boolean>>()

  /** False once disposal began; no later call may append. */
  private admissionOpen = true

  /**
   * @param ctx - context carrying the live `sessions` store.
   * @param config - required durability bound.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (!Number.isSafeInteger(config.flushTimeoutMs) || config.flushTimeoutMs < 1) {
      throw new TypeError('llm-request-record: flushTimeoutMs must be a positive safe integer')
    }
    this.flushTimeoutMs = config.flushTimeoutMs
  }

  protected [Service.init](): void {
    this.ctx.effect(() => async () => {
      this.admissionOpen = false
      await this.drain()
    }, 'llm-request-record.drain')
  }

  async recordPreparedRequest(
    context: LlmRequestRecordContext,
    payload: LlmRequestRecordPayload,
  ): Promise<LlmRequestRecordOutcome> {
    if (!this.admissionOpen) return { ok: false, code: REQUEST_RECORD_UNAVAILABLE }
    let data: LlmRequestRecordData
    try {
      data = validateRequestRecord(payload)
    } catch (error: unknown) {
      this.warn('refused a malformed payload', error)
      return { ok: false, code: REQUEST_RECORD_UNAVAILABLE }
    }
    // A record belongs to a live session's log. A detached or unknown session has
    // none, and a flush of it would reject instead of reporting durability.
    const session = this.ctx.sessions.get(context.sessionId)
    if (session === undefined) return { ok: false, code: REQUEST_RECORD_UNAVAILABLE }
    let event: SessionEvent<'llm/request-record'>
    try {
      event = session.append('llm/request-record', data)
    } catch (error: unknown) {
      this.warn(`session "${String(session.id)}" rejected the record`, error)
      return { ok: false, code: REQUEST_RECORD_UNAVAILABLE }
    }
    // The append is committed in the log; from here the deadline covers durability only.
    const durable = this.awaitFlush(session)
    using recordDeadline = deadline(undefined, this.flushTimeoutMs, FLUSH_TIMEOUT_CODE)
    const settled = await bounded(durable, recordDeadline.signal)
    if (!settled) return { ok: false, code: REQUEST_RECORD_UNAVAILABLE }
    return { ok: true, preparedId: event.seq }
  }

  /** Start one flush and keep it owned until it settles, so disposal can wait for it. */
  private awaitFlush(session: Session): Promise<boolean> {
    const flush = this.flushQuietly(session)
    this.pending.add(flush)
    void flush.then(() => { this.pending.delete(flush) })
    return flush
  }

  /** Report one durability checkpoint as a result, naming a listener failure in the log. */
  private async flushQuietly(session: Session): Promise<boolean> {
    try {
      return await this.ctx.sessions.flush(session)
    } catch (error: unknown) {
      this.warn(`session "${String(session.id)}" did not reach durable storage`, error)
      return false
    }
  }

  /** Wait for every flush already started, bounded by one more configured deadline. */
  private async drain(): Promise<void> {
    if (this.pending.size === 0) return
    using drainDeadline = deadline(undefined, this.flushTimeoutMs, FLUSH_TIMEOUT_CODE)
    await bounded(Promise.all([...this.pending]).then(() => true), drainDeadline.signal)
  }

  /** Report one contained failure, naming what the rejected value said. */
  private warn(subject: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    this.ctx.logger.warn(`llm-request-record: ${subject}: ${detail}`)
  }
}

/**
 * Await `write` until `signal` aborts.
 *
 * The deadline bounds the WAIT, never the write: a stalled durability listener
 * keeps its own disk write, and the caller learns only that the record is not
 * yet durable.
 *
 * @param write - the durability result being awaited.
 * @param signal - the deadline signal.
 * @returns true when the write settled, false when the deadline fired first.
 */
async function bounded(write: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  let onAbort: (() => void) | undefined
  const expired = new Promise<boolean>((resolve) => {
    onAbort = () => { resolve(false) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([write, expired])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

export default SessionRequestRecordProvider
