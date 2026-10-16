/**
 * The no-live-policy verdict table and the live-policy evaluator.
 *
 * Both are pure functions over the frozen registry plus inputs the caller injects. The
 * module never fetches a flag, never reads GrowthBook, never starts a timer and never
 * executes a tool: it answers `allow` / `deny` / `unsupported` with a fixed reason, and the
 * consumer decides what that means for the operation it owns.
 */

import { coreFailure } from './failures.js'
import type { CoreFailure } from './failures.js'
import { policyRegistration } from './policy-registry.js'
import type { PolicyCacheMiss } from './policy-registry.js'
import type { PolicyLimitsDocument } from './policy-limits.js'

/**
 * The remote inputs the pinned client reads from elsewhere.
 *
 * Every field is injected: this module reads no flag store and holds no production value.
 * The compiled defaults are the deployment's own configuration behaviour, and the two
 * booleans below state exactly what running with them means.
 */
export interface PolicyVerdictInputs {
  /**
   * `shimmyingStardust`. `true`: a parse failure is not retried and the failure fallback is
   * disabled. `false` (the default): a parse failure may be retried and the fallback runs.
   */
  readonly parseFailureIsTerminal: boolean
  /** `rustlingOrbit`. `true`: a 404/304 with no cache is answered `null` instead of fail-open. */
  readonly refuseFailOpenOnMissingRoute: boolean
  /** `ambientTaints` (`Zrr()`): taints that deny the keys declaring them. */
  readonly ambientTaints: readonly string[]
  /** `hardBlockTaints` (`Kse()`): taints that release a latched deny. */
  readonly hardBlockTaints: readonly string[]
  /** `hintedDeniedKeys`: keys the server hinted as denied. */
  readonly hintedDeniedKeys: readonly string[]
  /** `hintedTaints`: taints the server hinted. */
  readonly hintedTaints: readonly string[]
  /** Whether the transcript scan is active for this session. */
  readonly transcriptScan: boolean
  /** Whether the HIPAA evidence path is closed (`C5o`): the scan then ignores the registry. */
  readonly transcriptScanIgnoresRegistry: boolean
  /** Whether the HIPAA evidence is unreadable, unloaded, or the principal is under HIPAA. */
  readonly hipaaEvidenceUnavailable: boolean
  /** Whether a verdict was settled for a principal without a live policy (`cwe()`). */
  readonly settledWithoutVerdict: boolean
  /** Whether the HIPAA evidence path applies to this principal (`wIe()`). */
  readonly hipaaEvidenceApplies: boolean
  /** Whether the Ue evidence path holds (`Tss`/`wn`), which denies the two Ue keys. */
  readonly ueEvidenceDenies: boolean
  /** Whether a 404 was the last observed fetch outcome (`J()`). */
  readonly lastOutcomeWas404: boolean
}

/** The deployment defaults this core documents as its own configuration behaviour. */
export const DEFAULT_POLICY_VERDICT_INPUTS: PolicyVerdictInputs = Object.freeze({
  parseFailureIsTerminal: false,
  refuseFailOpenOnMissingRoute: false,
  ambientTaints: Object.freeze([]),
  hardBlockTaints: Object.freeze([]),
  hintedDeniedKeys: Object.freeze([]),
  hintedTaints: Object.freeze([]),
  transcriptScan: false,
  transcriptScanIgnoresRegistry: false,
  hipaaEvidenceUnavailable: false,
  settledWithoutVerdict: false,
  hipaaEvidenceApplies: false,
  ueEvidenceDenies: false,
  lastOutcomeWas404: false,
})

/** What a policy question resolves to. */
export type PolicyVerdict = 'allow' | 'deny' | 'unsupported'

/** One answer, with the fixed reason it was produced for. */
export interface PolicyAnswer {
  readonly verdict: PolicyVerdict
  /** Stable reason code, for logs and status only; never used to execute anything. */
  readonly reason: string
  /** The failure a `deny`/`unsupported` answer carries, for callers that surface one. */
  readonly failure?: CoreFailure
}

/** The pinned `I4r` set: keys whose registry deny is bypassed once a verdict was settled. */
const HOLD_KEYS: ReadonlySet<string> = new Set(['allow_projects_tool', 'allow_repo_visibility_probe', 'allow_team_onboarding'])

/** The pinned `Ue` set: keys the HIPAA evidence path denies outright. */
const UE_KEYS: ReadonlySet<string> = new Set(['allow_web_fetch', 'allow_design_sync'])

/** Whether a taint set contains any taint of the given list. */
function taintHit(taints: readonly string[], declared: readonly string[]): boolean {
  return declared.some(taint => taints.includes(taint))
}

/**
 * `x4o(key)`: whether the transcript scan answers for this key instead of the registry.
 * @param key - the policy key.
 * @param inputs - the injected inputs.
 * @returns true when the scan branch owns the answer.
 */
export function transcriptScanOwns(key: string, inputs: PolicyVerdictInputs): boolean {
  return inputs.transcriptScan && !inputs.transcriptScanIgnoresRegistry
}

/**
 * `H(key, taints)`: whether any of these taints appears in the key's `deniedUnder` list.
 * @param key - the policy key.
 * @param taints - the taints to test.
 * @returns true when the key is denied under them.
 */
export function deniedUnder(key: string, taints: readonly string[]): boolean {
  const registration = policyRegistration(key)
  if (registration === undefined) return false
  return taintHit(taints, registration.deniedUnder)
}

/**
 * `Fzt`: the live-policy evaluator for one key.
 *
 * Order is the pinned one: an unregistered key is refused, a `hardBlockUnder` taint blocks
 * ahead of everything, then the explicit `restrictions[key].allowed` verdict, then the
 * transcript scan (`x4o`), then the taint answer.
 * @param key - the policy key.
 * @param document - the live policy document (`cb()`).
 * @param taints - the taints in force, already merged by the caller.
 * @param inputs - the injected inputs the transcript-scan step reads. Omitted, the scan owns
 * nothing and the taint answer decides, which is the same answer the deployment default
 * (`transcriptScan: false`) produces.
 * @returns the answer.
 */
export function evaluateLivePolicy(
  key: string,
  document: PolicyLimitsDocument,
  taints: readonly string[],
  inputs?: PolicyVerdictInputs,
): PolicyAnswer {
  const registration = policyRegistration(key)
  if (registration === undefined) {
    return {
      verdict: 'unsupported',
      reason: 'unregistered_key',
      failure: coreFailure('unsupported', { reason: 'unregistered_key' }),
    }
  }
  if (taintHit(taints, registration.hardBlockUnder)) {
    return { verdict: 'deny', reason: 'hard_block_taint', failure: coreFailure('request_failed', { reason: 'hard_block_taint' }) }
  }
  const explicit = document.restrictions[key]
  if (explicit !== undefined) {
    return explicit.allowed
      ? { verdict: 'allow', reason: 'explicit_allow' }
      : { verdict: 'deny', reason: 'explicit_deny', failure: coreFailure('request_failed', { reason: 'explicit_deny' }) }
  }
  // The scan answers before the taints do, and it answers from its own hint list rather than
  // from the document, so a taint can never overrule it here.
  if (inputs !== undefined && transcriptScanOwns(key, inputs)) {
    return { verdict: 'allow', reason: 'transcript_scan_own' }
  }
  if (deniedUnder(key, taints)) {
    return { verdict: 'deny', reason: 'taint_denied', failure: coreFailure('request_failed', { reason: 'taint_denied' }) }
  }
  return { verdict: 'allow', reason: 'no_deny_evidence' }
}

/**
 * `sn(key)`: the no-live-policy verdict, in the pinned order.
 *
 * The order is: the transcript scan, the registry's `onCacheMiss` default (with the `I4r`
 * hold set bypassing a registry deny once a verdict was settled), the ambient-taint hit,
 * the `Ue` evidence path, the empty-hint allowance, the hinted key, and finally the merged
 * taint answer. An unregistered key is refused.
 * @param key - the policy key.
 * @param inputs - the injected inputs.
 * @returns the answer.
 */
export function evaluateWithoutLivePolicy(key: string, inputs: PolicyVerdictInputs): PolicyAnswer {
  const registration = policyRegistration(key)
  if (registration === undefined) {
    return {
      verdict: 'unsupported',
      reason: 'unregistered_key',
      failure: coreFailure('unsupported', { reason: 'unregistered_key' }),
    }
  }
  // 1. The transcript scan answers from its own hint list.
  if (transcriptScanOwns(key, inputs)) {
    if (inputs.hintedDeniedKeys.length === 0 && inputs.hintedTaints.length === 0) {
      return { verdict: 'allow', reason: 'transcript_scan_own' }
    }
    return inputs.hintedDeniedKeys.includes(key)
      ? { verdict: 'deny', reason: 'transcript_scan_denied', failure: coreFailure('request_failed', { reason: 'transcript_scan_denied' }) }
      : { verdict: 'allow', reason: 'transcript_scan_own' }
  }
  // 2. The registry's own default, with the hold set bypassing it once a verdict settled.
  if (registration.onCacheMiss !== 'allow') {
    const held = HOLD_KEYS.has(key) && inputs.settledWithoutVerdict && !inputs.hipaaEvidenceApplies
    if (!held) {
      return { verdict: 'deny', reason: 'registry_cache_miss', failure: coreFailure('request_failed', { reason: 'registry_cache_miss' }) }
    }
  }
  // 3. Ambient taints.
  if (deniedUnder(key, inputs.ambientTaints)) {
    return { verdict: 'deny', reason: 'ambient_taint', failure: coreFailure('request_failed', { reason: 'ambient_taint' }) }
  }
  // 4. The HIPAA evidence path for the two `Ue` keys.
  if (UE_KEYS.has(key) && inputs.hipaaEvidenceApplies && inputs.ueEvidenceDenies) {
    return { verdict: 'deny', reason: 'ue_evidence_denied', failure: coreFailure('request_failed', { reason: 'ue_evidence_denied' }) }
  }
  // 5. Empty hints allow.
  if (inputs.hintedDeniedKeys.length === 0 && inputs.hintedTaints.length === 0) {
    return { verdict: 'allow', reason: 'no_deny_evidence' }
  }
  // 6. A hinted key denies.
  if (inputs.hintedDeniedKeys.includes(key)) {
    return { verdict: 'deny', reason: 'hinted_denied', failure: coreFailure('request_failed', { reason: 'hinted_denied' }) }
  }
  // 7. Otherwise the merged taint answer decides.
  const merged = [...inputs.ambientTaints, ...inputs.hintedTaints]
  if (taintHit(merged, registration.hardBlockUnder)) {
    return { verdict: 'deny', reason: 'hard_block_taint', failure: coreFailure('request_failed', { reason: 'hard_block_taint' }) }
  }
  if (deniedUnder(key, merged)) {
    return { verdict: 'deny', reason: 'merged_taint_denied', failure: coreFailure('request_failed', { reason: 'merged_taint_denied' }) }
  }
  return { verdict: 'allow', reason: 'no_deny_evidence' }
}

/**
 * `pwn(key)`: whether the key's deny is latched by ambient taints.
 * @param key - the policy key.
 * @param inputs - the injected inputs.
 * @returns true when ambient taints deny the key and the hard-block taints do not release it.
 */
export function latchedDeny(key: string, inputs: PolicyVerdictInputs): boolean {
  if (!deniedUnder(key, inputs.ambientTaints)) return false
  const released = policyRegistration(key) !== undefined
    && taintHit(inputs.hardBlockTaints, policyRegistration(key)!.hardBlockUnder)
  return !released
}

/** The kind of deny behind a no-live-policy `deny` answer. */
export type PolicyDenyKind = 'latched' | 'route_missing' | 'cache_miss'

/**
 * `Ch(key)`: classify a no-live-policy deny.
 * @param key - the policy key.
 * @param inputs - the injected inputs.
 * @returns the deny kind, or `null` when the key is not denied by the no-live-policy table.
 */
export function policyDenyKind(key: string, inputs: PolicyVerdictInputs): PolicyDenyKind | null {
  if (evaluateWithoutLivePolicy(key, inputs).verdict !== 'deny') return null
  if (latchedDeny(key, inputs)) return 'latched'
  const routeMissing = inputs.lastOutcomeWas404
  return routeMissing ? 'route_missing' : 'cache_miss'
}

/**
 * `O4r(document)`: whether every verdict in this document is settled.
 *
 * Any compliance taint, a non-empty `defaults` map or a monitoring notice leaves the
 * document unsettled; otherwise each key must state the verdict its prefix requires
 * (`enforce_`/`require_` keys must be allowed, every other key denied).
 * @param document - the policy document.
 * @returns true when the document carries a settled verdict for every key it states.
 */
export function isPolicySettled(document: PolicyLimitsDocument): boolean {
  if (document.complianceTaints.length > 0) return false
  if (Object.keys(document.defaults).length > 0) return false
  if (document.monitoringNotice !== null) return false
  for (const [key, restriction] of Object.entries(document.restrictions)) {
    const mustAllow = key.startsWith('enforce_') || key.startsWith('require_')
    if (restriction.allowed !== mustAllow) return false
  }
  return true
}

/**
 * The registry default for one key, for callers that only need the `onCacheMiss` value.
 * @param key - the policy key.
 * @returns the default, or `undefined` when the key is unregistered.
 */
export function registryCacheMiss(key: string): PolicyCacheMiss | undefined {
  return policyRegistration(key)?.onCacheMiss
}
