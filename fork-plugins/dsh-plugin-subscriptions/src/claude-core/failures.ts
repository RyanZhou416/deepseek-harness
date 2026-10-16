/**
 * The core's own failure vocabulary.
 *
 * This module is deliberately independent of the harness: a `CoreFailure` is a plain value
 * with a fixed code and no provider body, no cause chain and no message text taken from a
 * response. Callers map it into their own error type; the core never imports one.
 */

/** The stable codes this core produces. */
export type CoreFailureCode =
  /** The response body did not satisfy the pinned envelope schema. */
  | 'parse_failed'
  /** The request failed at the transport or status level and is not an authentication result. */
  | 'request_failed'
  /** The credential was rejected; the caller may perform its one bounded replay. */
  | 'auth_failed'
  /** The operation named something this build does not implement. */
  | 'unsupported'
  /** The operation's own inputs were unusable before any request was sent. */
  | 'invalid_input'
  /** The organization validation returned no usable result. */
  | 'org_verify_failed'
  /** The organization validation returned an organization outside the pinned set. */
  | 'org_pin_mismatch'
  /** The caller cancelled. */
  | 'cancelled'

/** One failure, as a value rather than a thrown provider error. */
export interface CoreFailure {
  /** Stable machine code. */
  readonly code: CoreFailureCode
  /** Short fixed description; never response text. */
  readonly message: string
  /** HTTP status the failure was observed at, when there was one. */
  readonly status?: number
  /**
   * Whether the pinned retry policy forbids another attempt for this outcome
   * (`zGe(status)` or a parse failure under the injected flag).
   */
  readonly skipRetry?: boolean
  /** A fixed sub-reason the caller may switch on, for example `unexpected_304`. */
  readonly reason?: string
}

/** The fixed messages this core uses; they name the failure, never a response. */
const CORE_MESSAGES: Readonly<Record<CoreFailureCode, string>> = Object.freeze({
  parse_failed: 'the policy document did not satisfy the pinned schema',
  request_failed: 'the policy request failed',
  auth_failed: 'the credential was rejected',
  unsupported: 'the operation is not supported by this core',
  invalid_input: 'the operation inputs are not usable',
  org_verify_failed: 'the organization validation returned no usable result',
  org_pin_mismatch: 'the account organization is outside the pinned organization set',
  cancelled: 'the operation was cancelled',
})

/**
 * Build one failure value.
 * @param code - the stable code.
 * @param options - the observed status, the retry prohibition and a fixed sub-reason.
 * @returns the failure.
 */
export function coreFailure(
  code: CoreFailureCode,
  options: { status?: number; skipRetry?: boolean; reason?: string } = {},
): CoreFailure {
  return {
    code,
    message: CORE_MESSAGES[code],
    ...options.status === undefined ? {} : { status: options.status },
    ...options.skipRetry === undefined ? {} : { skipRetry: options.skipRetry },
    ...options.reason === undefined ? {} : { reason: options.reason },
  }
}

/**
 * The pinned retry prohibition for one HTTP status.
 *
 * A 4xx other than 408, 409 and 429 is a client-side refusal: the pinned client stops
 * rather than spending its budget on it.
 * @param status - the observed status, when there was one.
 * @returns true when another attempt is forbidden for that status.
 */
export function skipRetryForStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429
}
