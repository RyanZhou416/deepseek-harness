/**
 * The account client's own failure vocabulary.
 *
 * A `ClaudeAccountFailure` is a plain value: a fixed code, a fixed message and the status it was
 * observed at. It never carries response bytes, a cause chain or text the endpoint wrote, because
 * a token or profile response is the account's own credential and identity. Callers map the code
 * into their own error type; this module imports none and throws none.
 *
 * @module dsh-plugin-subscriptions/claude-account-client/failure
 */

import { matchesClaudeVersionRejection } from '../claude-engine/failure-rules.js'

/** The stable codes this client produces. */
export type ClaudeAccountFailureCode =
  /** The caller cancelled before or during the read. */
  | 'cancelled'
  /** This module's own deadline expired; this says nothing about the credential. */
  | 'timeout'
  /** No response arrived, or a 5xx, 429 or 408 answered. */
  | 'unreachable'
  /** The credential was rejected; its owner may replay exactly once and decides what that is. */
  | 'unauthorized'
  /** The service refused this operation; no retry and no switch to another account. */
  | 'refused'
  /** The operation's own inputs were unusable before any request was sent. */
  | 'invalid_input'
  /** A document this client cannot validate: a malformed envelope or an unreadable body. */
  | 'invalid'
  /** The grant is permanently gone (`invalid_grant` / `invalid_token`); re-login is the only fix. */
  | 'invalid_grant'
  /** The response body exceeded this build's own product bound. */
  | 'body_over_limit'
  /** The transport followed a redirect away from the pinned endpoint. */
  | 'redirected'
  /** The disclosed identity is not the account or organization the caller pinned. */
  | 'identity_mismatch'
  /** The service named one of the known client-version refusals. */
  | 'client_version_unsupported'

/** One failure, as a value rather than a thrown provider error. */
export interface ClaudeAccountFailure {
  /** Stable machine code. */
  readonly code: ClaudeAccountFailureCode
  /** Fixed description; never response text. */
  readonly message: string
  /** HTTP status the failure was observed at, when there was one. */
  readonly status?: number
  /** A fixed sub-reason the caller may switch on, for example `unexpected_304`. */
  readonly reason?: string
}

/** The fixed messages; they name the failure, never a response. */
const CLAUDE_ACCOUNT_MESSAGES: Readonly<Record<ClaudeAccountFailureCode, string>> = Object.freeze({
  cancelled: 'the operation was cancelled',
  timeout: 'the operation did not answer within its deadline',
  unreachable: 'the endpoint could not be reached',
  unauthorized: 'the credential was rejected',
  refused: 'the service refused the operation',
  invalid_input: 'the operation inputs are not usable',
  invalid: 'the response did not satisfy the pinned schema',
  invalid_grant: 'the grant is permanently unusable',
  body_over_limit: 'the response body exceeded this client\'s bound',
  redirected: 'the endpoint redirected away from its pinned target',
  identity_mismatch: 'the disclosed identity is not the pinned identity',
  client_version_unsupported: 'the service refuses this client version',
})

/**
 * Build one failure value.
 * @param code - the stable code.
 * @param options - the observed status and a fixed sub-reason.
 * @returns the failure.
 */
export function claudeAccountFailure(
  code: ClaudeAccountFailureCode,
  options: { status?: number; reason?: string } = {},
): ClaudeAccountFailure {
  return {
    code,
    message: CLAUDE_ACCOUNT_MESSAGES[code],
    ...options.status === undefined ? {} : { status: options.status },
    ...options.reason === undefined ? {} : { reason: options.reason },
  }
}

/**
 * Whether this failure means the stored credential is permanently unusable.
 *
 * Only an explicit permanent grant rejection says that. An `unauthorized` failure is an
 * authentication rejection whose owner may replay exactly once; a generic 401 is not evidence
 * that the grant is gone, so a caller that deleted its stored credential on one would destroy a
 * working login. A timeout, a cancellation and an unreachable endpoint say nothing about the
 * credential either, and this client never deletes one itself.
 * @param failure - the observed failure.
 * @returns true only when the endpoint named a permanently spent grant.
 */
export function claudeFailureDropsCredential(failure: ClaudeAccountFailure): boolean {
  return failure.code === 'invalid_grant'
}

/** One refusal's classified meaning. */
export interface ClaudeRefusal {
  /** The failure to report. */
  readonly failure: ClaudeAccountFailure
  /** Whether the credential itself was rejected; the one case whose owner may replay. */
  readonly unauthorized: boolean
}

/** The fields a token or profile error envelope names, bounded so one body cannot decide memory. */
function claudeRefusalText(body: string): string {
  const parts: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) parts.push(value.slice(0, 512))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = undefined
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const root = parsed as Record<string, unknown>
    push(root['error'])
    push(root['error_description'])
    push(root['message'])
    push(root['type'])
    const nested = root['error']
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
      const error = nested as Record<string, unknown>
      push(error['type'])
      push(error['code'])
      push(error['message'])
    }
  }
  // The bounded body slice is the last resort: an echoed request field cannot claim a refusal
  // the service never sent, but a refusal spelled only in the body still counts.
  parts.push(body.slice(0, 4_096))
  return parts.join('\n').slice(0, 8_192)
}

/**
 * Classify one non-success response into this client's vocabulary.
 *
 * The known client-version refusals outrank the authentication branch, so a version refusal
 * carried on a 401 never triggers the credential owner's replay. The body is read only to match
 * those fixed markers; no part of it reaches the returned failure.
 * @param status - the response status.
 * @param body - the bounded body text this client already consumed.
 * @returns the refusal the response named.
 */
export function classifyClaudeRefusal(status: number, body: string): ClaudeRefusal {
  if (matchesClaudeVersionRejection(claudeRefusalText(body))) {
    return {
      failure: claudeAccountFailure('client_version_unsupported', { status, reason: 'version_rejected' }),
      unauthorized: false,
    }
  }
  if (status === 401) {
    return { failure: claudeAccountFailure('unauthorized', { status, reason: 'auth_rejected' }), unauthorized: true }
  }
  if (status === 403) {
    return { failure: claudeAccountFailure('refused', { status, reason: 'permission_denied' }), unauthorized: false }
  }
  return { failure: claudeAccountFailure('refused', { status, reason: 'http_status' }), unauthorized: false }
}
