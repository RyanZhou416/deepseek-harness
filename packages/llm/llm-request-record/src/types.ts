/**
 * Durable vocabulary for the `llm/request-record` event: the prepared-request
 * facts one model route publishes into its own session log before the provider
 * sees any bytes.
 *
 * Types only — the Service Definition and the provider are in `./index.ts`, the
 * pure functions in `./record-data.ts`.
 *
 * The recorded text may contain a secret the deployment itself configured into a
 * system prompt, so this event carries the confidentiality level of
 * `system/message`; nothing here claims otherwise.
 *
 * The event is required-on-read: it sets no `ignorable`, so a build that does not
 * know the type refuses the whole log rather than skipping the record. The write
 * path therefore ships after a build that declares the type.
 *
 * @module @deepseek-ai/dsh-llm-request-record/types
 */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Closed classification of one recorded request. `'conversation'` is an ordinary
 * Messages request; the other two members are the auxiliary purposes
 * {@link GenerateOptions.purpose} declares.
 */
export type LlmRequestRecordPurpose = NonNullable<GenerateOptions['purpose']> | 'conversation'

/**
 * One prepared model request, as its producer observed it after building the
 * exact bytes it is about to submit.
 *
 * The record states what was emitted, never what the provider answered and never
 * that anything reached durable storage or the network: `phase` is always
 * `'prepared'`, and the record's own log position is its only identity.
 */
export interface LlmRequestRecordData {
  /** Schema version of this payload; a structural change adds a version, never edits one. */
  readonly v: 1
  /** Construction state of this request: assembled and appended, send not yet observed. */
  readonly phase: 'prepared'
  /** Producer discriminant; `'claude'` is the only route that publishes records today. */
  readonly provider: 'claude'
  /** Model id the request names. */
  readonly model: string
  /** Closed request classification. */
  readonly purpose: LlmRequestRecordPurpose
  /**
   * The emitted system text, one entry per system block, in wire order.
   *
   * Per-block text only: a `cache_control` marker and any serialization
   * whitespace between blocks are outside this record.
   */
  readonly systemBlocks: readonly string[]
  /** `sha256` of `JSON.stringify(systemBlocks)`; a comparison aid, never a secret. */
  readonly systemDigest: string
  /** The pinned wire library that built the recorded body, as `name@version`. */
  readonly wireLibrary: string
  /** The compatibility profile the builder reported for the recorded body. */
  readonly profile: string
}

/**
 * What a producer observed, which the recording service completes into
 * {@link LlmRequestRecordData}.
 *
 * The version, the phase and the system digest are deliberately not caller
 * input: the service derives them, so every record of one build states the same
 * schema and the digest always describes exactly
 * {@link LlmRequestRecordData.systemBlocks}.
 */
export interface LlmRequestRecordPayload {
  /** Producer discriminant of the route that built the request. */
  readonly provider: 'claude'
  /** Model id the request names. */
  readonly model: string
  /** Closed request classification. */
  readonly purpose: LlmRequestRecordPurpose
  /** The emitted system text, one entry per system block, in wire order. */
  readonly systemBlocks: readonly string[]
  /** The pinned wire library that built the recorded body, as `name@version`. */
  readonly wireLibrary: string
  /** The compatibility profile the builder reported for the recorded body. */
  readonly profile: string
}

/**
 * Fixed reasons a prepared record could not be published.
 *
 * Both forbid the send: the producer holds no durable record of the request it
 * was about to submit, and resending would repeat that condition. The service
 * states them as `ok: false` results; the producer's own local constants carry
 * the same literals, checked against this union at compile time.
 */
export type LlmRequestRecordFailureCode =
  | 'REQUEST_RECORD_UNAVAILABLE'
  | 'CLAUDE_REQUEST_RECORD_CONTEXT_REQUIRED'

/** The session whose log receives one prepared-request record. */
export interface LlmRequestRecordContext {
  /** Live session that owns the request being recorded. */
  readonly sessionId: SessionId
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One model request recorded immediately before it is submitted: the ordered
     * system text the producer emitted, and the facts that identify the build.
     *
     * The record carries no outcome — no sent flag and no provider status — and
     * its own `seq` is its identity. The text may carry a caller-configured
     * secret, so this event has the confidentiality level of `system/message`.
     */
    'llm/request-record': LlmRequestRecordData
  }
}
