/**
 * The no-live-policy verdict table (G1–G10) and the live-policy evaluator.
 *
 * Every input is injected, so the fixtures state exactly which remote value each branch
 * reads. Nothing here executes a tool or performs a request.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_POLICY_VERDICT_INPUTS,
  evaluateLivePolicy,
  evaluateWithoutLivePolicy,
  isPolicySettled,
  latchedDeny,
  policyDenyKind,
  registryCacheMiss,
} from '../src/claude-core/no-live-policy.js'
import type { PolicyVerdictInputs } from '../src/claude-core/no-live-policy.js'
import { POLICY_KEYS, POLICY_KEY_REGISTRY } from '../src/claude-core/policy-registry.js'
import { parsePolicyLimitsDocument } from '../src/claude-core/policy-limits.js'

/** The default inputs, with the named overrides applied. */
function inputs(overrides: Partial<PolicyVerdictInputs> = {}): PolicyVerdictInputs {
  return { ...DEFAULT_POLICY_VERDICT_INPUTS, ...overrides }
}

/** The parsed document of one fixture body. */
function document(body: Record<string, unknown>) {
  const parsed = parsePolicyLimitsDocument({ restrictions: {}, ...body })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) throw new Error('fixture body must parse')
  return parsed.document
}

test('the frozen registry carries the 34 pinned keys with their declared inputs', () => {
  assert.equal(POLICY_KEYS.length, 34)
  assert.equal(POLICY_KEY_REGISTRY['allow_projects_tool']?.onCacheMiss, 'hold')
  assert.deepEqual([...POLICY_KEY_REGISTRY['allow_memory_sync']?.hardBlockUnder ?? []], ['hipaa'])
  assert.deepEqual([...POLICY_KEY_REGISTRY['allow_product_feedback']?.deniedUnder ?? []], ['hipaa', 'zdr'])
  assert.equal(registryCacheMiss('not_a_key'), undefined)
})

test('G1: a key the registry lets through on a cache miss is allowed', () => {
  assert.equal(evaluateWithoutLivePolicy('allow_model_catalog', inputs()).verdict, 'allow')
})

test('G2: a key the registry defaults to deny is denied', () => {
  const answer = evaluateWithoutLivePolicy('allow_send_file', inputs())
  assert.equal(answer.verdict, 'deny')
  assert.equal(answer.reason, 'registry_cache_miss')
})

test('G3: a hold key bypasses the registry deny once a verdict was settled', () => {
  assert.equal(
    evaluateWithoutLivePolicy('allow_projects_tool', inputs({ settledWithoutVerdict: true })).verdict,
    'allow',
  )
})

test('G4: the same hold key is denied while the HIPAA evidence applies', () => {
  const answer = evaluateWithoutLivePolicy('allow_projects_tool', inputs({
    settledWithoutVerdict: true,
    hipaaEvidenceApplies: true,
  }))
  assert.equal(answer.verdict, 'deny')
  assert.equal(answer.reason, 'registry_cache_miss')
})

test('G5: an ambient taint denies a key that declares it', () => {
  // The contract fixture names a registry-denied key, which step 2 already denies; the
  // ambient step is exercised with a key the registry allows under the same taint.
  assert.equal(evaluateWithoutLivePolicy('allow_send_file', inputs({ ambientTaints: ['hipaa'] })).verdict, 'deny')
  const ambient = evaluateWithoutLivePolicy('allow_memory_sync', inputs({ ambientTaints: ['hipaa'] }))
  assert.equal(ambient.verdict, 'deny')
  assert.equal(ambient.reason, 'ambient_taint')
})

test('G6: the HIPAA evidence path denies a key the registry would allow', () => {
  const answer = evaluateWithoutLivePolicy('allow_web_fetch', inputs({
    hipaaEvidenceApplies: true,
    ueEvidenceDenies: true,
  }))
  assert.equal(answer.verdict, 'deny')
  assert.equal(answer.reason, 'ue_evidence_denied')
})

test('G7: with no hint and no taint the registry-allowed key is allowed', () => {
  const answer = evaluateWithoutLivePolicy('allow_model_catalog', inputs({ hintedDeniedKeys: [], hintedTaints: [] }))
  assert.equal(answer.verdict, 'allow')
  assert.equal(answer.reason, 'no_deny_evidence')
})

test('G8: a hinted key is denied', () => {
  // The contract fixture names a registry-deny key, which step 2 already denies; the hinted
  // step itself is exercised with a key whose registry default allows.
  assert.equal(
    evaluateWithoutLivePolicy('allow_send_file', inputs({ hintedDeniedKeys: ['allow_send_file'] })).verdict,
    'deny',
  )
  const hinted = evaluateWithoutLivePolicy('allow_model_catalog', inputs({
    hintedDeniedKeys: ['allow_model_catalog'],
  }))
  assert.equal(hinted.verdict, 'deny')
  assert.equal(hinted.reason, 'hinted_denied')
})

test('G9: a hinted taint denies through the key denial list', () => {
  // `allow_error_reporting` is registry-denied first; the merged-taint step is exercised
  // with a key the registry allows and whose denial list contains the hinted taint.
  assert.equal(
    evaluateWithoutLivePolicy('allow_error_reporting', inputs({ hintedTaints: ['zdr'] })).verdict,
    'deny',
  )
  const merged = evaluateWithoutLivePolicy('allow_memory_sync', inputs({ hintedTaints: ['zdr'] }))
  assert.equal(merged.verdict, 'deny')
  assert.equal(merged.reason, 'merged_taint_denied')
})

test('G10: a hard-block taint releases the latched deny', () => {
  const latched = inputs({ ambientTaints: ['hipaa'] })
  assert.equal(latchedDeny('allow_memory_sync', latched), true)
  assert.equal(policyDenyKind('allow_memory_sync', latched), 'latched')
  const released = inputs({ ambientTaints: ['hipaa'], hardBlockTaints: ['hipaa'] })
  assert.equal(latchedDeny('allow_memory_sync', released), false)
  assert.equal(policyDenyKind('allow_memory_sync', released), 'cache_miss')
  assert.equal(
    policyDenyKind('allow_memory_sync', { ...released, lastOutcomeWas404: true }),
    'route_missing',
  )
})

test('an unregistered key is refused rather than allowed', () => {
  const answer = evaluateWithoutLivePolicy('some_future_key', inputs())
  assert.equal(answer.verdict, 'unsupported')
  assert.equal(answer.reason, 'unregistered_key')
})

test('the transcript scan owns the answer and honours its hint list', () => {
  const owned = inputs({ transcriptScan: true })
  assert.equal(evaluateWithoutLivePolicy('allow_send_file', owned).verdict, 'allow')
  const denied = inputs({ transcriptScan: true, hintedDeniedKeys: ['allow_send_file'] })
  assert.equal(evaluateWithoutLivePolicy('allow_send_file', denied).verdict, 'deny')
  // With the registry back in charge (C5o), the scan no longer owns the answer.
  const ignored = inputs({ transcriptScan: true, transcriptScanIgnoresRegistry: true })
  assert.equal(evaluateWithoutLivePolicy('allow_send_file', ignored).verdict, 'deny')
})

test('the live evaluator follows the pinned order: hard block, explicit verdict, taints', () => {
  const policy = document({
    restrictions: { allow_web_fetch: { allowed: true }, allow_send_file: { allowed: false } },
  })
  assert.equal(evaluateLivePolicy('allow_web_fetch', policy, []).verdict, 'allow')
  assert.equal(evaluateLivePolicy('allow_send_file', policy, []).verdict, 'deny')
  assert.equal(
    evaluateLivePolicy('allow_web_fetch', policy, ['hipaa']).verdict,
    'allow',
    'an explicit verdict outranks the taint check, which is the last step of the pinned order',
  )
  assert.equal(
    evaluateLivePolicy('allow_web_fetch', document({ restrictions: {} }), ['hipaa']).verdict,
    'deny',
    'with no explicit verdict the taint denial decides',
  )
  assert.equal(
    evaluateLivePolicy('allow_memory_sync', document({ restrictions: { allow_memory_sync: { allowed: true } } }), ['hipaa']).reason,
    'hard_block_taint',
    'a hard-block taint outranks the explicit verdict',
  )
  assert.equal(evaluateLivePolicy('unregistered_key', policy, []).verdict, 'unsupported')
})

test('a live document is unsettled while it carries any general gate input', () => {
  assert.equal(isPolicySettled(document({ restrictions: { enforce_a: { allowed: true } } })), true)
  assert.equal(isPolicySettled(document({ restrictions: { allow_a: { allowed: true } } })), false, 'a non-enforce key must be denied to be settled')
  assert.equal(isPolicySettled(document({ restrictions: {}, defaults: { a: 1 } })), false)
  assert.equal(isPolicySettled(document({ restrictions: {}, monitoring_notice: { text: 'x', url: null } })), false)
  assert.equal(isPolicySettled(document({ restrictions: {}, compliance_taints: ['hipaa'] })), false)
})

test('the live evaluator keeps the pinned order in both directions: hard block, explicit, x4o, taint', () => {
  const scan = inputs({ transcriptScan: true })
  const tainted = ['hipaa']

  // 1. A hard-block taint outranks the explicit verdict and the scan.
  assert.equal(
    evaluateLivePolicy('allow_memory_sync', document({ restrictions: { allow_memory_sync: { allowed: true } } }), tainted, scan).reason,
    'hard_block_taint',
  )
  // 2. An explicit verdict outranks the scan, in both directions.
  assert.equal(
    evaluateLivePolicy('allow_send_file', document({ restrictions: { allow_send_file: { allowed: false } } }), [], scan).reason,
    'explicit_deny',
  )
  assert.equal(
    evaluateLivePolicy('allow_send_file', document({ restrictions: { allow_send_file: { allowed: true } } }), [], scan).reason,
    'explicit_allow',
  )
  // 3. The scan outranks the taint answer, and answers from its own hint list.
  assert.equal(
    evaluateLivePolicy('allow_product_feedback', document({ restrictions: {} }), tainted).reason,
    'taint_denied',
    'without the scan the taint denial is the last step',
  )
  assert.equal(
    evaluateLivePolicy('allow_product_feedback', document({ restrictions: {} }), tainted, scan).reason,
    'transcript_scan_own',
    'with the scan active the taint never runs',
  )
  // The reverse: with the registry back in charge the scan owns nothing, and the deployment
  // default states no scan at all — both fall back to the taint answer.
  assert.equal(
    evaluateLivePolicy('allow_product_feedback', document({ restrictions: {} }), tainted, inputs({
      transcriptScan: true,
      transcriptScanIgnoresRegistry: true,
    })).reason,
    'taint_denied',
  )
  assert.equal(
    evaluateLivePolicy('allow_product_feedback', document({ restrictions: {} }), tainted, DEFAULT_POLICY_VERDICT_INPUTS).reason,
    'taint_denied',
  )
  // A caller that passes no inputs at all keeps the three-argument answer.
  assert.equal(evaluateLivePolicy('allow_product_feedback', document({ restrictions: {} }), tainted).reason, 'taint_denied')
})
