// SPDX-License-Identifier: GPL-3.0-or-later

import type { ClaudeCodeProtocolProfile } from "./contracts.js";
import { CLAUDE_CODE_2_1_195_PROFILE } from "./profiles/claude-code-2.1.195.js";
import { CLAUDE_CODE_2_1_233_PROFILE } from "./profiles/claude-code-2.1.233.js";
import { CLAUDE_CODE_2_1_280_PROFILE } from "./profiles/claude-code-2.1.280.js";

/**
 * Per-profile behaviour dispatch.
 *
 * Three modules — `thinking.ts`, `fingerprint.ts` and `model-capabilities.ts` —
 * each need to know whether the profile they were handed behaves like upstream
 * 2.1.195 or like upstream 2.1.222+. Each grew its own
 * `profile.id === CLAUDE_CODE_2_1_195_PROFILE.id` comparison as its feature
 * landed, and three copies of one question is three places to forget when a
 * fourth profile arrives. This module is the single place that asks it.
 *
 * The flags are named for the BEHAVIOUR they gate, never for a version. A call
 * site reading `profileBehaviors(profile).billingChainSegments` says what it is
 * deciding; a call site reading `profile.id !== …195….id` says only which
 * client it is not, and leaves the reader to reconstruct why that matters.
 * `test/governance/version-dispatch.test.ts` fails the build if a fourth copy
 * of the comparison appears in `src/`.
 *
 * `ClaudeCodeProfileBehaviors` deliberately stays here rather than moving to
 * `contracts.ts`. It is not part of the wire contract and is not exported from
 * `index.ts`: it is an internal derivation over a profile, and putting it in
 * the contract module would imply consumers can supply one, which they cannot.
 * Behaviour is derived from the profile, never declared alongside it.
 */
export interface ClaudeCodeProfileBehaviors {
  /**
   * Whether a caller's own `max_tokens` of 4096 or more raises the model's
   * `upperLimit` and lowers its `default` to fit under it.
   *
   * Consumed by `modelOutputTokenLimits` in `thinking.ts`, whose one
   * wire-visible effect is the seed of the default thinking budget.
   */
  readonly requestDerivedTokenCeiling: boolean;

  /**
   * Whether the billing block may carry the `cc_prev_req` and `cc_prompt_id`
   * conversation-chaining segments.
   *
   * Consumed by `createBillingBlock` in `fingerprint.ts`. False means the
   * segments are dropped silently even when the caller supplies both, which is
   * what a client with no parameter for them does. True for 2.1.233 and later.
   */
  readonly billingChainSegments: boolean;

  /**
   * Whether the billing block may carry the `cc_turn_origin` segment.
   *
   * Consumed by `createBillingBlock` in `fingerprint.ts`. A 2.1.280 addition:
   * the 2.1.233 builder has no parameter for it, so that profile drops the
   * value silently. True for 2.1.280 and later.
   */
  readonly billingTurnOriginSegment: boolean;

  /**
   * Whether the billing block may carry the `cc_prompt_index` and
   * `cc_turn_index` segment pair.
   *
   * Consumed by `createBillingBlock` in `fingerprint.ts`. A 2.1.288 addition:
   * the 2.1.280 builder has no parameter for the pair, so that profile drops
   * the value silently. True for 2.1.288 and later.
   */
  readonly billingTurnPositionSegments: boolean;

  /**
   * Whether `claude-opus-4-5` takes its `effort` capability from the predicate
   * rather than from the catalogue.
   *
   * Consumed by `deriveCapabilities` in `model-capabilities.ts`. See
   * `docs/plans/BLOCKERS.md`, finding C1: this is the one cell where the
   * 2.1.195 catalogue disagrees with the binary that shipped it, and the
   * predicate is wire-authoritative for that profile alone.
   */
  readonly opus45EffortException: boolean;
}

/**
 * Upstream 2.1.195: derivation is predicate-driven, the request builder has no
 * request-derived token ceiling, and the billing block has no parameter for
 * conversation chaining or turn segments.
 */
const LEGACY_BEHAVIORS: ClaudeCodeProfileBehaviors = Object.freeze({
  requestDerivedTokenCeiling: false,
  billingChainSegments: false,
  billingTurnOriginSegment: false,
  billingTurnPositionSegments: false,
  opus45EffortException: true,
});

/**
 * Upstream 2.1.233: catalogue-first derivation and the two conversation-chaining
 * segments, but no turn-origin or turn-position parameter yet.
 */
const MODERN_233_BEHAVIORS: ClaudeCodeProfileBehaviors = Object.freeze({
  requestDerivedTokenCeiling: true,
  billingChainSegments: true,
  billingTurnOriginSegment: false,
  billingTurnPositionSegments: false,
  opus45EffortException: false,
});

/**
 * Upstream 2.1.280: the turn-origin parameter exists; the prompt/turn index
 * pair does not.
 */
const MODERN_280_BEHAVIORS: ClaudeCodeProfileBehaviors = Object.freeze({
  requestDerivedTokenCeiling: true,
  billingChainSegments: true,
  billingTurnOriginSegment: true,
  billingTurnPositionSegments: false,
  opus45EffortException: false,
});

/**
 * Upstream 2.1.288 and later: catalogue-first derivation, conversation
 * chaining, and both turn segment groups.
 */
const CURRENT_BEHAVIORS: ClaudeCodeProfileBehaviors = Object.freeze({
  requestDerivedTokenCeiling: true,
  billingChainSegments: true,
  billingTurnOriginSegment: true,
  billingTurnPositionSegments: true,
  opus45EffortException: false,
});

/**
 * Resolves the behaviour set a profile follows.
 *
 * Pure and total: every profile answers, and the answer depends on nothing but
 * the profile's identity.
 */
export function profileBehaviors(
  profile: ClaudeCodeProtocolProfile,
): ClaudeCodeProfileBehaviors {
  /*
   * ---- Demarcated: the ONLY per-version identity comparisons in `src/`. ----
   *
   * Each comparison is structural rather than a capability flag: these are
   * differences in what the upstream builder is written to do, not values it
   * reads from a catalogue. The named profiles are the ones whose builder
   * differs from the next tier, so a profile ported from a client newer than
   * 2.1.288 inherits the current behaviour and needs no edit here.
   *
   * `test/governance/version-dispatch.test.ts` asserts these comparisons are
   * here, and that they are nowhere else.
   */
  if (profile.id === CLAUDE_CODE_2_1_195_PROFILE.id) {
    return LEGACY_BEHAVIORS;
  }
  if (profile.id === CLAUDE_CODE_2_1_233_PROFILE.id) {
    return MODERN_233_BEHAVIORS;
  }
  if (profile.id === CLAUDE_CODE_2_1_280_PROFILE.id) {
    return MODERN_280_BEHAVIORS;
  }
  return CURRENT_BEHAVIORS;
}
