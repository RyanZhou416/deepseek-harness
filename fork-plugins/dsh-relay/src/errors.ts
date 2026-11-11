/**
 * Typed relay failures.
 *
 * A failure carries a stable code the settings page localizes and an optional
 * detail that is safe to show: neither the password nor the client key may
 * reach a detail string, an error message, or a log line.
 *
 * @module dsh-relay/errors
 */
import { RELAY_ERROR_CODES } from './shared.ts'
import type { RelayErrorCode } from './shared.ts'

export { RELAY_ERROR_CODES }
export type { RelayErrorCode }

/** Codes the relay protocol itself returns, as opposed to codes this client adds. */
const PROTOCOL_ERROR_CODES: ReadonlySet<string> = new Set([
  'client-key-invalid',
  'client-key-mismatch',
  'credentials-invalid',
  'username-invalid',
  'password-too-short',
  'password-unchanged',
  'dsh-invalid',
  'port-pool-exhausted',
  'bad-request',
  'internal',
])

/** Whether a wire value names a protocol error code this client understands. */
export function isProtocolErrorCode(value: string): boolean {
  return PROTOCOL_ERROR_CODES.has(value)
}

/**
 * Typed failure with a user-safe detail.
 */
export class RelayError extends Error {
  /** Stable code the settings page maps to localized copy. */
  readonly code: RelayErrorCode

  /** Safe context appended to the localized message; never a secret. */
  readonly detail: string | undefined

  /**
   * Minimum password length the relay reported with a `password-too-short`
   * failure. The relay owns this policy, so the settings page shows the
   * reported number instead of hardcoding one.
   */
  readonly minPassword: number | undefined

  /**
   * @param code - stable failure code.
   * @param detail - safe context, or undefined.
   * @param cause - underlying failure for logging.
   * @param minPassword - minimum password length reported by the relay, if any.
   */
  constructor(code: RelayErrorCode, detail?: string, cause?: unknown, minPassword?: number) {
    super(detail === undefined ? code : `${code}: ${detail}`, cause === undefined ? undefined : { cause })
    this.name = 'RelayError'
    this.code = code
    this.detail = detail
    this.minPassword = minPassword
  }
}

/**
 * Build a relay failure.
 * @param code - stable failure code.
 * @param detail - safe context, or undefined.
 * @param cause - underlying failure for logging.
 * @param minPassword - minimum password length reported by the relay, if any.
 * @returns the failure.
 */
export function relayError(code: RelayErrorCode, detail?: string, cause?: unknown, minPassword?: number): RelayError {
  return new RelayError(code, detail, cause, minPassword)
}

/**
 * Normalize any caught value into a relay failure.
 * @param error - caught value.
 * @returns the value itself when it is already a {@link RelayError}, otherwise an `internal` failure.
 */
export function asRelayError(error: unknown): RelayError {
  if (error instanceof RelayError) return error
  return relayError('internal', 'unexpected relay failure', error)
}

/**
 * Whether an error names an aborted request rather than a transport failure.
 * @param error - caught fetch value.
 * @returns true for an abort or timeout signal.
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.name === 'TimeoutError'
}
