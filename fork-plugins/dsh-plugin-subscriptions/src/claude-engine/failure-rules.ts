/**
 * The Claude rejection vocabulary, standalone.
 *
 * This module is the single home of the client-version refusal markers, the known Anthropic
 * error-event types and their classification. It imports nothing from the harness or from the
 * plugin's provider modules, so a caller outside the harness (the Mac worker today) can depend on
 * it without pulling in a desktop-shaped compatibility profile or a platform assumption.
 *
 * The plugin's `providers/claude-protocol.ts` re-exports these names for its own consumers, and
 * its profile machinery stays there; only the vocabulary lives here.
 *
 * @module dsh-plugin-subscriptions/claude-engine/failure-rules
 */

/** What a rejection is evidence about. */
export type ClaudeRuleScope = 'operation' | 'account' | 'provider-profile' | 'model' | 'unknown'

/** Whether automatic recovery may still run for a decided rejection. */
export type ClaudeRuleDisposition = 'forbid' | 'allow'

/**
 * Error codes and wording the service uses when it refuses a client version.
 *
 * Matched against a bounded, parsed error envelope and against bounded body text, so an echoed
 * request field cannot claim a version rejection the service never sent.
 */
export const CLAUDE_VERSION_REJECTION_MARKERS: readonly string[] = Object.freeze([
  'claude_code_version_too_old',
  'client_version_unsupported',
])

/** Known Anthropic error-event types that mean a version refusal rather than a failure. */
const VERSION_ERROR_TYPES: ReadonlySet<string> = new Set(CLAUDE_VERSION_REJECTION_MARKERS)

/**
 * Whether a bounded text contains a marker naming a client-version refusal.
 * @param text - bounded error text (structured fields and a capped body slice).
 * @returns true when the text names a known version-refusal code.
 */
export function matchesClaudeVersionRejection(text: string): boolean {
  if (text.length === 0) return false
  const lowered = text.toLowerCase()
  return CLAUDE_VERSION_REJECTION_MARKERS.some(marker => lowered.includes(marker))
}

/** The classification one Anthropic error event's own fields name. */
export interface ClaudeErrorEventRule {
  /** Stable reason code. */
  readonly code: string
  /** Whether automatic recovery may still run for this event's own fields. */
  readonly retryDisposition: ClaudeRuleDisposition
  /** What the event, read alone, is evidence about. */
  readonly scope: ClaudeRuleScope
  /** Whether the provider itself describes this event as a passing condition. */
  readonly transient: boolean
}

/**
 * Known Anthropic `error` event types this route maps explicitly.
 *
 * A type absent from this table is unclassified: reporting an unknown structured error type as a
 * transient server failure would hand an unmapped refusal back to the retry loop.
 */
const ANTHROPIC_ERROR_RULES: Readonly<Record<string, ClaudeErrorEventRule>> = Object.freeze({
  authentication_error: { code: 'AUTH', retryDisposition: 'allow', scope: 'account', transient: false },
  permission_error: { code: 'PERMISSION_DENIED', retryDisposition: 'forbid', scope: 'operation', transient: false },
  policy_blocked: { code: 'PERMISSION_DENIED', retryDisposition: 'forbid', scope: 'operation', transient: false },
  not_found_error: { code: 'INVALID_REQUEST', retryDisposition: 'forbid', scope: 'model', transient: false },
  invalid_request_error: { code: 'INVALID_REQUEST', retryDisposition: 'forbid', scope: 'operation', transient: false },
  rate_limit_error: { code: 'RATE_LIMIT', retryDisposition: 'allow', scope: 'account', transient: true },
  overloaded_error: { code: 'SERVER', retryDisposition: 'allow', scope: 'operation', transient: true },
  api_error: { code: 'SERVER', retryDisposition: 'allow', scope: 'operation', transient: true },
  timeout_error: { code: 'TIMEOUT', retryDisposition: 'allow', scope: 'operation', transient: true },
})

/**
 * Classify one Anthropic `error` event from its own fields.
 *
 * The response an event arrived on can still make a classified-as-retryable event final; that
 * decision belongs to the caller that holds the response. This function answers only what the
 * event's own type, code and message support, and answers `undefined` for a type it has no
 * mapping for.
 * @param type - the event's `error.type` (or its code), when present.
 * @param message - the event's `error.message`, when present.
 * @returns the rule the event's own fields name, or undefined for an unknown type.
 */
export function anthropicErrorEventRule(type: string | undefined, message: string | undefined): ClaudeErrorEventRule | undefined {
  const text = message ?? ''
  if (matchesClaudeVersionRejection(type ?? '') || matchesClaudeVersionRejection(text)) {
    return { code: 'CLIENT_VERSION_UNSUPPORTED', retryDisposition: 'forbid', scope: 'provider-profile', transient: false }
  }
  if (type === 'invalid_request_error' && /prompt is too long/i.test(text)) {
    return { code: 'CONTEXT_WINDOW_EXCEEDED', retryDisposition: 'forbid', scope: 'operation', transient: false }
  }
  if (type === undefined || VERSION_ERROR_TYPES.has(type)) return undefined
  return ANTHROPIC_ERROR_RULES[type]
}

/**
 * Whether a code is a provider error type this vocabulary already maps.
 * @param code - the code or type a response named.
 * @returns true when this module recognizes it.
 */
export function isKnownAnthropicErrorCode(code: string): boolean {
  return code === 'error' || anthropicErrorEventRule(code, undefined) !== undefined
}
