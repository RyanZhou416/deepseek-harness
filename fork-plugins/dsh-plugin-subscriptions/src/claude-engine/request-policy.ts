/**
 * The trusted policy inputs a build may carry.
 *
 * These are not request-body fields: a caller states them out of band, from a policy adapter it
 * trusts, and the engine translates them into the pinned builder's own switches. The raw DTO never
 * reaches these, so a request cannot suppress a beta by putting a field in the body.
 *
 * @module dsh-plugin-subscriptions/claude-engine/request-policy
 */

/**
 * The three mid-conversation betas one HIPAA taint withholds.
 *
 * The pin binds them as a set: the main capability beta and the two it directly depends on are
 * withheld together, while every other beta and the top-level system, user and assistant content
 * are untouched.
 */
export const MID_CONVERSATION_SUPPRESSED_BETAS: readonly string[] = Object.freeze([
  'mid-conversation-system-2026-04-07',
  'mid-conversation-tool-changes-2026-07-01',
  'mid-conversation-system-clear-at-2026-08-21',
])

/**
 * Policy a caller may state for one build.
 *
 * Every member is optional and defaults to the builder's ordinary behaviour, so a caller that
 * states nothing gets exactly the request it would have got before this input existed.
 */
export interface ClaudeEnginePolicy {
  /**
   * Withhold the mid-conversation betas for this build.
   *
   * A trusted policy adapter sets this when the account's data-handling terms require it. The
   * trigger is that policy, never the presence of a top-level system prompt, which the ordinary
   * client sends with the capability beta enabled.
   */
  readonly suppressMidConversationSystem?: boolean
}

/**
 * Resolve the builder's `suppressBetas` switch from the caller's policy.
 * @param policy - the caller's trusted policy, when it stated one.
 * @returns the beta list to withhold, or undefined when nothing is suppressed.
 */
export function resolveSuppressBetas(policy: ClaudeEnginePolicy | undefined): readonly string[] | undefined {
  if (policy?.suppressMidConversationSystem !== true) return undefined
  return MID_CONVERSATION_SUPPRESSED_BETAS
}
