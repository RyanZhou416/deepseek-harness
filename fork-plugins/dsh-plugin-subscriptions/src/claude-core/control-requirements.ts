/**
 * The control obligations one adopted `policy_limits` document states.
 *
 * The server's `enforce_`/`require_` control family is not a member of the pinned policy-key
 * registry: a control states an obligation the client must satisfy, never a verdict about one
 * operation. This module answers only whether such an obligation is in force. A statement that
 * is not a boolean refuses the whole document inside the envelope's own parser, so an unusable
 * verdict cannot arrive here as an absent one and be read as "nothing was required".
 *
 * This build performs no device enrollment, cloud-create or link operation, and no
 * descriptor-marked web-search or MCP-connector executor is established here, so an in-force
 * requirement is reported as unsupported and refuses nothing.
 *
 * TODO(P6-host): bind the real executors and state per control whether a verified consumer can
 * satisfy it; until then no control may be reported as enforced.
 *
 * Nothing here performs I/O, reads a credential or reaches a registry, a transport or an HTTP
 * client: the caller injects a document the envelope's parser already accepted.
 */

import type { PolicyLimitsDocument } from './policy-limits.js'

/**
 * Whether one control obligation is in force for the document in hand.
 *
 * `active` states that the document requires the control; it is not a statement that this build
 * can satisfy it, still less that an operation was allowed. `not-enforced` states that the
 * document does not require it. `unknown` states that the document answered nothing for that
 * control, which is never a refusal.
 */
export type ControlRequirement = 'active' | 'not-enforced' | 'unknown'

/** One observed control, in this module's own vocabulary rather than the server's key. */
export type UnsupportedActiveControl = 'trusted-devices' | 'web-search-mcp-isolation'

/** The control obligations one adopted document states, plus the active ones this build cannot serve. */
export interface ControlRequirements {
  /** `require_trusted_devices`. */
  readonly trustedDevices: ControlRequirement
  /** `enforce_web_search_mcp_isolation`. */
  readonly webSearchMcpIsolation: ControlRequirement
  /**
   * The controls in force that this build provides no capability for, distinct and in the fixed
   * order below. It carries no operation: a member here refuses nothing.
   */
  readonly unsupportedActiveControls: readonly UnsupportedActiveControl[]
}

/** The control keys, in the order their requirement is reported. */
const CONTROL_KEYS = {
  trustedDevices: 'require_trusted_devices',
  webSearchMcpIsolation: 'enforce_web_search_mcp_isolation',
} as const

/**
 * The restriction keys this build classifies as known control obligations.
 *
 * Each names an obligation rather than an operation this provider performs, so a consumer that
 * maps restriction keys onto its own operations excludes exactly these keys instead of treating
 * them as unknown operation-permission keys. The prefix is deliberately not the test: an
 * `enforce_`/`require_` key this build holds no evidence for stays an unknown policy key.
 */
export const KNOWN_CONTROL_KEYS: readonly string[] = Object.freeze([
  CONTROL_KEYS.trustedDevices,
  CONTROL_KEYS.webSearchMcpIsolation,
])

/**
 * Whether one restriction key is a known control obligation rather than an operation-permission
 * key.
 * @param key - the restriction key a document stated.
 * @returns true only for the two control keys this build holds evidence for.
 */
export function isKnownControlKey(key: string): boolean {
  return KNOWN_CONTROL_KEYS.includes(key)
}

/**
 * The requirement one control key stands at in an accepted document.
 * @param document - the accepted document.
 * @param key - the control key.
 * @returns the requirement the document states, or `unknown` when it states none.
 */
function requirementOf(document: PolicyLimitsDocument, key: string): ControlRequirement {
  const restriction = document.restrictions[key]
  if (restriction === undefined) return 'unknown'
  return restriction.allowed ? 'active' : 'not-enforced'
}

/**
 * The control obligations one adopted document states.
 *
 * A document that answers neither control states no obligation this build can report, and
 * answers `undefined` so a caller shows nothing rather than a state derived from a requirement
 * the server never made. A document that answers one of them reports the other as `unknown`,
 * which is an absence of a verdict and never `not-enforced`.
 * @param document - the accepted document, as the envelope's parser produced it.
 * @returns the requirements, or `undefined` when the document states neither control key.
 */
export function controlRequirements(document: PolicyLimitsDocument): ControlRequirements | undefined {
  const trustedDevices = requirementOf(document, CONTROL_KEYS.trustedDevices)
  const webSearchMcpIsolation = requirementOf(document, CONTROL_KEYS.webSearchMcpIsolation)
  if (trustedDevices === 'unknown' && webSearchMcpIsolation === 'unknown') return undefined
  // Each control is pushed at most once, so the list is distinct by construction. A control this
  // build gains a verified consumer for is dropped from it where that binding is declared.
  const unsupportedActiveControls: UnsupportedActiveControl[] = []
  if (trustedDevices === 'active') unsupportedActiveControls.push('trusted-devices')
  if (webSearchMcpIsolation === 'active') unsupportedActiveControls.push('web-search-mcp-isolation')
  return { trustedDevices, webSearchMcpIsolation, unsupportedActiveControls }
}
