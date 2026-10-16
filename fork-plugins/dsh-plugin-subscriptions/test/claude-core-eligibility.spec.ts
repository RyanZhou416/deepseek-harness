/**
 * `policy_limits` eligibility: the pinned admission branches, kept separate from managed
 * settings because the two endpoints do not share an admission rule.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { policyLimitsEligibility } from '../src/claude-core/eligibility.js'
import type { PolicyLimitsEligibilityInput } from '../src/claude-core/eligibility.js'

/** The admitted baseline, with the named overrides applied. */
function input(overrides: Partial<PolicyLimitsEligibilityInput> = {}): PolicyLimitsEligibilityInput {
  return {
    firstPartyOAuth: true,
    defaultBaseUrl: true,
    hasAccessToken: true,
    hasInferenceScope: true,
    subscriptionType: null,
    ...overrides,
  }
}

test('the first-party default-base inference path is admitted whether the plan is unstated or an organization plan', () => {
  assert.deepEqual(policyLimitsEligibility(input()), { kind: 'eligible', reason: 'unstated_subscription' })
  assert.deepEqual(policyLimitsEligibility(input({ subscriptionType: undefined })), {
    kind: 'eligible',
    reason: 'unstated_subscription',
  })
  assert.deepEqual(policyLimitsEligibility(input({ subscriptionType: 'team' })), {
    kind: 'eligible',
    reason: 'organization_subscription',
  })
  assert.deepEqual(policyLimitsEligibility(input({ subscriptionType: 'enterprise' })), {
    kind: 'eligible',
    reason: 'organization_subscription',
  })
})

test('a non-null subscription type this build does not recognize is not eligible', () => {
  for (const subscriptionType of ['max', 'pro', 'free', 'Team', ' team ', '', 'unknown']) {
    const decision = policyLimitsEligibility(input({ subscriptionType }))
    assert.equal(decision.kind, 'ineligible', `expected ${JSON.stringify(subscriptionType)} to be refused`)
    if (decision.kind === 'ineligible') assert.equal(decision.reason, 'unsupported_subscription_type')
  }
})

test('the credential and transport facts each disqualify on their own', () => {
  assert.deepEqual(policyLimitsEligibility(input({ firstPartyOAuth: false })), {
    kind: 'ineligible',
    reason: 'not_first_party_oauth',
  })
  assert.deepEqual(policyLimitsEligibility(input({ defaultBaseUrl: false })), {
    kind: 'ineligible',
    reason: 'custom_base_url',
  })
  assert.deepEqual(policyLimitsEligibility(input({ hasAccessToken: false })), {
    kind: 'ineligible',
    reason: 'no_access_token',
  })
  assert.deepEqual(policyLimitsEligibility(input({ hasInferenceScope: false })), {
    kind: 'ineligible',
    reason: 'no_inference_scope',
  })
})

test('a missing credential is refused before the subscription branch is reached', () => {
  const decision = policyLimitsEligibility(input({ hasAccessToken: false, subscriptionType: 'team' }))
  assert.equal(decision.kind, 'ineligible')
  if (decision.kind === 'ineligible') assert.equal(decision.reason, 'no_access_token')
})
