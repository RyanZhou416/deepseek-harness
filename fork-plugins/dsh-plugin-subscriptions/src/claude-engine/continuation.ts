/**
 * The continuation selector: the only authority for which earlier Claude turn a request may
 * chain to.
 *
 * The authority is the final retained message history the request was built from, and nothing
 * else. A reply's `request-id` is remembered by the response envelope the adapter already
 * writes into `assistant/message`, so the earlier turn's own durable record is the fact a
 * later request reads. No process-local scalar, no second store and no cache stands beside
 * this rule: two authorities would disagree after a restart, and the disagreement would be
 * invisible in the model-visible bytes.
 *
 * This module is pure. It reads the messages it is handed and derives nothing from a store, a
 * clock, an environment or a credential, so the same trusted span and the same retained
 * messages always produce the same selection. The account reference it compares comes from the
 * zero-dependency `claude-core/account-ref` module, which is the single definition of the type,
 * its shape check and its comparison: this module has no second copy of any of them.
 *
 * The walk is backward and each row is gated before it can be selected. A row that names
 * another provider, another response version, another account, another identity generation or
 * another wire session is skipped rather than trusted, and a row whose recorded `request-id` is
 * not truthy — absent or empty — is skipped so the walk continues to an earlier turn. A truthy
 * `request-id` that is not the shape the client emits is omitted outright: backtracking to an
 * older id after rejecting a newer one would chain a turn the client itself refused.
 *
 * @module dsh-plugin-subscriptions/claude-engine/continuation
 */

import type { ClaudeAccountRef } from '../claude-core/account-ref.js'
import { isClaudeAccountRef, sameClaudeAccountRef } from '../claude-core/account-ref.js'

/** The response-envelope version this module reads; the envelope contract is unchanged. */
export const CLAUDE_CONTINUATION_RESPONSE_VERSION = 1

/** The continuation member's own version, fixed for the lifetime of this reader. */
export const CLAUDE_CONTINUATION_VERSION = 1

/**
 * The `request-id` shape the client emits and the builder admits.
 *
 * The billing text carries the value as `cc_prev_req=`, so a value outside this grammar could
 * restructure that field rather than name a turn.
 */
const CLAUDE_REQUEST_ID = /^req_[A-Za-z0-9_-]{1,36}$/

/**
 * The account reference one recorded continuation carries.
 *
 * The reference is a digest, not an account key: the `ref` is what distinguishes one account
 * from another, so comparing two references without it would pass every account. The type and
 * its shape check come from the pure `claude-core/account-ref` module, which this selector may
 * import because that module has no store, no Node and no harness dependency.
 */
export type ClaudeContinuationAccountRef = ClaudeAccountRef

/** The durable continuation facts one Claude response records beside its blocks. */
export interface ClaudeContinuationV1 {
  /** The continuation member's own version. */
  readonly v: typeof CLAUDE_CONTINUATION_VERSION
  /** The account this turn was served for, as a verifiable reference. */
  readonly accountRef: ClaudeContinuationAccountRef
  /** The identity generation in force when the turn was served. */
  readonly spanEpoch: number
  /** The harness session the turn belongs to. */
  readonly harnessSessionId: string
  /** The wire session the turn was served under. */
  readonly wireSessionId: string
  /** The response's own `request-id`, when the response carried one. */
  readonly requestId?: string
}

/**
 * The span a request belongs to, with the facts every candidate row must match.
 *
 * Every field is derived from this installation's own state: `accountRef` is a reference the
 * salt derives, and the session and wire identities are the span's prepared ones. A candidate
 * row is eligible only when all of them match, so a row from another account, another
 * generation or another wire session cannot be selected by coincidence.
 */
export interface ContinuationGate {
  /** The account the request is served for. */
  readonly accountRef: ClaudeContinuationAccountRef
  /** The identity generation in force for the request. */
  readonly spanEpoch: number
  /** The harness session the request belongs to. */
  readonly harnessSessionId: string
  /** The wire session the request will declare. */
  readonly wireSessionId: string
}

/**
 * One message the selector reads.
 *
 * Only the members this rule consults are declared, so a caller passes the retained history it
 * already has. `content` is read because the response envelope's `blocks` must line up with the
 * assembled blocks the row actually carries.
 */
export interface ContinuationMessage {
  readonly role?: string
  readonly content?: readonly unknown[]
  readonly source?: {
    readonly kind?: string
    readonly provider?: string
    readonly model?: string
    readonly replayState?: unknown
  }
}

/** What the backward walk selected. */
export type ContinuationSelection =
  /** A usable earlier `request-id`; the request chains to it. */
  | { readonly kind: 'selected'; readonly requestId: string; readonly index: number }
  /** An eligible row carried an unusable id; the request sends no chain. */
  | { readonly kind: 'omitted'; readonly reason: 'invalid-request-id' }
  /** No eligible row carried an id; the request sends no chain. */
  | { readonly kind: 'none' }

/** Whether a value is the `request-id` shape the client emits. */
export function isClaudeRequestId(value: unknown): value is string {
  return typeof value === 'string' && CLAUDE_REQUEST_ID.test(value)
}

/**
 * Whether a value carries an account reference this build can compare.
 *
 * The check is the shared pure one; this module owns no second implementation of it.
 * @param value - the candidate reference.
 * @returns true when the reference states a derivation this build implements.
 */
export function isContinuationAccountRef(value: unknown): value is ClaudeAccountRef {
  return isClaudeAccountRef(value)
}

/**
 * Read the continuation member out of a response envelope, if it is one this build wrote.
 * @param envelope - the `source.replayState` value.
 * @returns the continuation, or undefined when the envelope is absent, foreign or older.
 */
export function readClaudeContinuation(envelope: unknown): ClaudeContinuationV1 | undefined {
  if (typeof envelope !== 'object' || envelope === null) return undefined
  const response = (envelope as Record<string, unknown>)['response']
  if (typeof response !== 'object' || response === null) return undefined
  const record = response as Record<string, unknown>
  if (record['kind'] !== 'claude' || record['version'] !== CLAUDE_CONTINUATION_RESPONSE_VERSION) return undefined
  return isClaudeContinuation(record['continuation']) ? record['continuation'] : undefined
}

/**
 * Select the turn this request may chain to.
 *
 * The walk is backward over the retained history. A row is eligible only when it is an
 * assistant Claude model message whose envelope is this build's response version, whose
 * recorded blocks line up with the blocks the row actually carries, and whose continuation
 * matches every gate field. An eligible row whose recorded id is not truthy is skipped so an
 * earlier turn may still answer; an eligible row whose id is truthy but not the shape the client
 * emits ends the walk with `omitted`, because the newest eligible turn is the one the client
 * would have chained to and backtracking to an older id would chain a turn the client refused.
 * @param messages - the retained history the request was built from, in order.
 * @param gate - the span the request belongs to.
 * @returns the selection, and the index it was read from.
 */
export function selectClaudeContinuation(
  messages: readonly ContinuationMessage[],
  gate: ContinuationGate,
): ContinuationSelection {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (message.role !== 'assistant') continue
    const source = message.source
    if (source?.kind !== 'model' || source.provider !== 'claude') continue
    const continuation = readClaudeContinuation(source.replayState)
    if (continuation === undefined) continue
    if (!blocksAlign(message, source.replayState)) continue
    if (!matchesGate(continuation, gate)) continue
    const requestId = continuation.requestId
    // The selection gate is truthiness: an absent id and an empty one are the same fact, and both
    // let an earlier turn answer.
    if (requestId === undefined || requestId.length === 0) continue
    if (!isClaudeRequestId(requestId)) return { kind: 'omitted', reason: 'invalid-request-id' }
    return { kind: 'selected', requestId, index }
  }
  return { kind: 'none' }
}

/**
 * Whether a row's recorded blocks line up with the blocks it carries.
 *
 * A response whose block list does not match the assembled message is one the durable
 * pipeline discards whole, so selecting its id would chain to a turn the session no longer
 * carries in the same form.
 * @param message - the retained row.
 * @param envelope - its `source.replayState`.
 * @returns true when the envelope's block list matches the row's content length.
 */
function blocksAlign(message: ContinuationMessage, envelope: unknown): boolean {
  if (typeof envelope !== 'object' || envelope === null) return false
  const blocks = (envelope as Record<string, unknown>)['blocks']
  if (!Array.isArray(blocks)) return false
  return Array.isArray(message.content) && message.content.length === blocks.length
}

/**
 * Whether one recorded continuation belongs to the span the request is served for.
 * @param continuation - the recorded facts.
 * @param gate - the span the request belongs to.
 * @returns true when every identity field matches.
 */
function matchesGate(continuation: ClaudeContinuationV1, gate: ContinuationGate): boolean {
  return sameClaudeAccountRef(continuation.accountRef, gate.accountRef)
    && continuation.spanEpoch === gate.spanEpoch
    && continuation.harnessSessionId === gate.harnessSessionId
    && continuation.wireSessionId === gate.wireSessionId
}

/**
 * Validate a continuation member read out of an envelope.
 * @param value - the candidate member.
 * @returns true when every field this build compares is present and well typed.
 */
function isClaudeContinuation(value: unknown): value is ClaudeContinuationV1 {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const requestId = record['requestId']
  return record['v'] === CLAUDE_CONTINUATION_VERSION
    && isContinuationAccountRef(record['accountRef'])
    && typeof record['spanEpoch'] === 'number' && Number.isSafeInteger(record['spanEpoch']) && record['spanEpoch'] >= 0
    && typeof record['harnessSessionId'] === 'string' && record['harnessSessionId'].length > 0
    && typeof record['wireSessionId'] === 'string' && record['wireSessionId'].length > 0
    && (requestId === undefined || typeof requestId === 'string')
}
