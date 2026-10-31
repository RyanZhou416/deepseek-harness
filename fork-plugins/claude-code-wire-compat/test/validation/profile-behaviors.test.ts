// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import type { ClaudeCodeProtocolProfile } from "../../src/contracts.js";
import {
  CLAUDE_CODE_2_1_195_PROFILE,
  CLAUDE_CODE_2_1_233_PROFILE,
  CLAUDE_CODE_2_1_280_PROFILE,
  CLAUDE_CODE_2_1_288_PROFILE,
} from "../../src/index.js";
import {
  profileBehaviors,
  type ClaudeCodeProfileBehaviors,
} from "../../src/profile-behaviors.js";

/*
 * The behaviour table `src/profile-behaviors.ts` resolves, pinned per profile.
 *
 * Several modules consume these flags and each has its own suite asserting the
 * resulting wire bytes. What is pinned HERE is the dispatch itself: which
 * behaviour tier each profile lands on, and — the row that cannot be covered
 * anywhere else — which tier an unrecognised profile lands on. That default is
 * a decision, not an accident, and it is the reason this suite exists
 * separately from the behavioural ones.
 */

const LEGACY: ClaudeCodeProfileBehaviors = {
  requestDerivedTokenCeiling: false,
  billingChainSegments: false,
  billingTurnOriginSegment: false,
  billingTurnPositionSegments: false,
  opus45EffortException: true,
};

const MODERN_233: ClaudeCodeProfileBehaviors = {
  requestDerivedTokenCeiling: true,
  billingChainSegments: true,
  billingTurnOriginSegment: false,
  billingTurnPositionSegments: false,
  opus45EffortException: false,
};

const MODERN_280: ClaudeCodeProfileBehaviors = {
  requestDerivedTokenCeiling: true,
  billingChainSegments: true,
  billingTurnOriginSegment: true,
  billingTurnPositionSegments: false,
  opus45EffortException: false,
};

const CURRENT: ClaudeCodeProfileBehaviors = {
  requestDerivedTokenCeiling: true,
  billingChainSegments: true,
  billingTurnOriginSegment: true,
  billingTurnPositionSegments: true,
  opus45EffortException: false,
};

describe("profileBehaviors: the shipped profiles", () => {
  it("puts 2.1.195 on the legacy side", () => {
    expect(profileBehaviors(CLAUDE_CODE_2_1_195_PROFILE)).toEqual(LEGACY);
  });

  it("puts 2.1.233 on the 2.1.233 side", () => {
    expect(profileBehaviors(CLAUDE_CODE_2_1_233_PROFILE)).toEqual(MODERN_233);
  });

  it("puts 2.1.280 on the 2.1.280 side", () => {
    expect(profileBehaviors(CLAUDE_CODE_2_1_280_PROFILE)).toEqual(MODERN_280);
  });

  it("puts 2.1.288 on the current side", () => {
    expect(profileBehaviors(CLAUDE_CODE_2_1_288_PROFILE)).toEqual(CURRENT);
  });

  it("disagrees on every flag between the oldest and newest tiers, so no flag is vacuous", () => {
    const legacy = profileBehaviors(CLAUDE_CODE_2_1_195_PROFILE);
    const current = profileBehaviors(CLAUDE_CODE_2_1_288_PROFILE);
    const keys = Object.keys(legacy) as (keyof ClaudeCodeProfileBehaviors)[];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(legacy[key]).not.toBe(current[key]);
    }
  });

  it("gates each turn segment on the tier that has its builder parameter", () => {
    expect(profileBehaviors(CLAUDE_CODE_2_1_195_PROFILE).billingTurnOriginSegment).toBe(false);
    expect(profileBehaviors(CLAUDE_CODE_2_1_233_PROFILE).billingTurnOriginSegment).toBe(false);
    expect(profileBehaviors(CLAUDE_CODE_2_1_280_PROFILE).billingTurnOriginSegment).toBe(true);
    expect(profileBehaviors(CLAUDE_CODE_2_1_288_PROFILE).billingTurnOriginSegment).toBe(true);
    expect(profileBehaviors(CLAUDE_CODE_2_1_195_PROFILE).billingTurnPositionSegments).toBe(false);
    expect(profileBehaviors(CLAUDE_CODE_2_1_233_PROFILE).billingTurnPositionSegments).toBe(false);
    expect(profileBehaviors(CLAUDE_CODE_2_1_280_PROFILE).billingTurnPositionSegments).toBe(false);
    expect(profileBehaviors(CLAUDE_CODE_2_1_288_PROFILE).billingTurnPositionSegments).toBe(true);
  });

  it("names flags for behaviour, never for a version", () => {
    for (const key of Object.keys(
      profileBehaviors(CLAUDE_CODE_2_1_195_PROFILE),
    ))
      expect(key).not.toMatch(/\d+[._]\d+[._]\d+|^v?\d/);
  });
});

/*
 * An unrecognised profile inherits the CURRENT side. A profile ported from a
 * client newer than 2.1.288 must not silently regress to an older builder's
 * semantics just because nobody edited the dispatch module; only a profile
 * ported from a client OLDER than one of the named tiers needs an edit there.
 */
describe("profileBehaviors: an unrecognised profile", () => {
  const synthetic: ClaudeCodeProtocolProfile = {
    ...CLAUDE_CODE_2_1_233_PROFILE,
    id: "claude-code/9.9.9",
  };

  it("is genuinely unrecognised", () => {
    expect(synthetic.id).not.toBe(CLAUDE_CODE_2_1_195_PROFILE.id);
    expect(synthetic.id).not.toBe(CLAUDE_CODE_2_1_233_PROFILE.id);
    expect(synthetic.id).not.toBe(CLAUDE_CODE_2_1_280_PROFILE.id);
    expect(synthetic.id).not.toBe(CLAUDE_CODE_2_1_288_PROFILE.id);
  });

  it("inherits the current side", () => {
    expect(profileBehaviors(synthetic)).toEqual(CURRENT);
  });

  it("dispatches on the id alone, not on any other profile field", () => {
    // A profile carrying 2.1.195's id but every other field from 2.1.233 still
    // answers legacy: the id is the whole of the question.
    const spoofed: ClaudeCodeProtocolProfile = {
      ...CLAUDE_CODE_2_1_233_PROFILE,
      id: CLAUDE_CODE_2_1_195_PROFILE.id,
    };
    expect(profileBehaviors(spoofed)).toEqual(LEGACY);
  });
});

describe("profileBehaviors: purity", () => {
  it("returns a frozen object", () => {
    for (const profile of [
      CLAUDE_CODE_2_1_195_PROFILE,
      CLAUDE_CODE_2_1_233_PROFILE,
      CLAUDE_CODE_2_1_280_PROFILE,
      CLAUDE_CODE_2_1_288_PROFILE,
    ]) {
      expect(Object.isFrozen(profileBehaviors(profile))).toBe(true);
    }
  });

  it("returns a stable value for repeated calls", () => {
    expect(profileBehaviors(CLAUDE_CODE_2_1_233_PROFILE)).toBe(
      profileBehaviors(CLAUDE_CODE_2_1_233_PROFILE),
    );
  });

  it("cannot be mutated through the returned reference", () => {
    const behaviors = profileBehaviors(CLAUDE_CODE_2_1_195_PROFILE);
    expect(() => {
      (
        behaviors as { requestDerivedTokenCeiling: boolean }
      ).requestDerivedTokenCeiling = true;
    }).toThrow(TypeError);
    expect(profileBehaviors(CLAUDE_CODE_2_1_195_PROFILE)).toEqual(LEGACY);
  });
});
