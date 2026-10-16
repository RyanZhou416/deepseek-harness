/**
 * The shared pure single-account protocol core.
 *
 * It implements the pinned `policy_limits` request and verdict table, the organization pin
 * validation, and the quota observation of one raw source, and nothing else. It has no
 * harness dependency and holds no credential, no account pool, no proxy and no timer:
 * callers inject the transport, the clock, the sleep, the access token, the reset resolver
 * and every remote input, and they own scheduling, recovery and enforcement.
 */

export { coreFailure, skipRetryForStatus } from './failures.js'
export type { CoreFailure, CoreFailureCode } from './failures.js'

export {
  canonicalPolicyJson,
  parsePolicyLimitsDocument,
  policyValidator,
  sha256Hex,
  PolicyLimitsCache,
} from './policy-limits.js'
export type {
  PolicyDocumentParse,
  PolicyLimitsDocument,
  PolicyRestriction,
  PolicySnapshot,
} from './policy-limits.js'

export {
  DEFAULT_POLICY_VERDICT_INPUTS,
  deniedUnder,
  evaluateLivePolicy,
  evaluateWithoutLivePolicy,
  isPolicySettled,
  latchedDeny,
  policyDenyKind,
  registryCacheMiss,
  transcriptScanOwns,
} from './no-live-policy.js'
export type {
  PolicyAnswer,
  PolicyDenyKind,
  PolicyVerdict,
  PolicyVerdictInputs,
} from './no-live-policy.js'

export {
  HIPAA_TAINT,
  POLICY_KEYS,
  POLICY_KEY_REGISTRY,
  policyRegistration,
} from './policy-registry.js'
export type { PolicyCacheMiss, PolicyKey, PolicyKeyRegistration } from './policy-registry.js'

export { policyLimitsEligibility } from './eligibility.js'
export type { PolicyLimitsEligibility, PolicyLimitsEligibilityInput } from './eligibility.js'

export { controlRequirements, isKnownControlKey, KNOWN_CONTROL_KEYS } from './control-requirements.js'
export type { ControlRequirement, ControlRequirements, UnsupportedActiveControl } from './control-requirements.js'

export {
  POLICY_LIMITS_BACKOFF_BASE_MS,
  POLICY_LIMITS_BACKOFF_CAP_MS,
  POLICY_LIMITS_BACKOFF_JITTER,
  POLICY_LIMITS_BODY_LIMIT,
  POLICY_LIMITS_RETRIES,
  POLICY_LIMITS_TIMEOUT_MS,
  policyBackoffMs,
  readPolicyLimits,
  snapshotFromOutcome,
} from './policy-limits-client.js'
export type {
  CoreClock,
  CoreHttpRequest,
  CoreHttpResponse,
  CoreSleep,
  CoreTransport,
  PolicyLimitsOutcome,
  PolicyLimitsReadOperation,
  PolicyPriorContext,
} from './policy-limits-client.js'

export { ORG_PIN_TIMEOUT_MS, parseOrgPin, validateOrgPin } from './org-pin.js'
export type { OrgPinOutcome, OrgPinParse, OrgPinValidationRequest } from './org-pin.js'

export {
  CLAUDE_UNIFIED_HEADER_PREFIX,
  CLAUDE_UNIFIED_MEMBER_SUFFIXES,
  CLAUDE_UNIFIED_WINDOW_PREFIXES,
  CLAUDE_UNIFIED_WINDOW_SUFFIXES,
  CLAUDE_USAGE_TOP_LEVEL_KEYS,
  CLAUDE_USAGE_WINDOW_KEYS,
  parseRawFacts,
  parseUsageJson,
  projectLegacy,
  projectStrict,
} from './quota-observation.js'
export type {
  ClaudeQuotaDocument,
  ClaudeQuotaFamily,
  ClaudeQuotaObservation,
  ClaudeQuotaResetFormat,
  ClaudeQuotaScopeKind,
  ClaudeQuotaSource,
  ClaudeQuotaStatus,
  ClaudeQuotaWindowKind,
  LegacyResetResolver,
  QuotaHeaderSource,
  QuotaLegacyState,
  QuotaLegacyWindowReading,
  QuotaParseIssueCode,
  QuotaParseIssues,
  QuotaWindowSpec,
  RawFactMember,
  RawFacts,
  RawFactWindow,
} from './quota-observation.js'
