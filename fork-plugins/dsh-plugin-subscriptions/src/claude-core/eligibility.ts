/**
 * Eligibility for the `policy_limits` read.
 *
 * This is deliberately a separate question from managed settings: the pinned client reaches
 * `policy_limits` on the first-party OAuth path with an inference-capable token, and the
 * subscription type only has to be *unstated* (null or absent) or an organization plan. A
 * non-null value this build does not recognize is not eligible — an unrecognized string is
 * never trimmed into "unknown" and never probed.
 *
 * The caller supplies the observed credential facts; this module reads no credential store
 * and performs no request.
 */

/** The credential and subscription facts the decision reads. */
export interface PolicyLimitsEligibilityInput {
  /** Whether the account is served by the plugin's own first-party OAuth path. */
  readonly firstPartyOAuth: boolean
  /** Whether the base URL is the pinned default one (`custom base URL` disqualifies). */
  readonly defaultBaseUrl: boolean
  /** Whether a usable access token is stored right now. */
  readonly hasAccessToken: boolean
  /** Whether the granted scopes include the inference capability. */
  readonly hasInferenceScope: boolean
  /** The confirmed subscription type, exactly as the credential or profile stated it. */
  readonly subscriptionType: string | null | undefined
}

/** Why the read is or is not admitted. */
export type PolicyLimitsEligibility =
  /** The read runs. */
  | { readonly kind: 'eligible'; readonly reason: 'unstated_subscription' | 'organization_subscription' }
  /** The read never runs, for the stated reason. */
  | {
    readonly kind: 'ineligible'
    readonly reason:
      | 'not_first_party_oauth'
      | 'custom_base_url'
      | 'no_access_token'
      | 'no_inference_scope'
      | 'unsupported_subscription_type'
  }

/** The organization plans the pinned client reaches this endpoint for. */
const ORGANIZATION_SUBSCRIPTIONS: ReadonlySet<string> = new Set(['team', 'enterprise'])

/**
 * Decide whether the account may read `policy_limits`.
 *
 * Null and absent subscription types are the pinned unknown-metadata branch. Values are
 * compared as stated, without trimming or case folding: a value this build does not
 * recognize is `unsupported_subscription_type` rather than being retried as unknown.
 * @param input - the observed credential and subscription facts.
 * @returns the eligibility and the reason.
 */
export function policyLimitsEligibility(input: PolicyLimitsEligibilityInput): PolicyLimitsEligibility {
  if (!input.firstPartyOAuth) return { kind: 'ineligible', reason: 'not_first_party_oauth' }
  if (!input.defaultBaseUrl) return { kind: 'ineligible', reason: 'custom_base_url' }
  if (!input.hasAccessToken) return { kind: 'ineligible', reason: 'no_access_token' }
  if (!input.hasInferenceScope) return { kind: 'ineligible', reason: 'no_inference_scope' }
  if (input.subscriptionType === null || input.subscriptionType === undefined) {
    return { kind: 'eligible', reason: 'unstated_subscription' }
  }
  return ORGANIZATION_SUBSCRIPTIONS.has(input.subscriptionType)
    ? { kind: 'eligible', reason: 'organization_subscription' }
    : { kind: 'ineligible', reason: 'unsupported_subscription_type' }
}
