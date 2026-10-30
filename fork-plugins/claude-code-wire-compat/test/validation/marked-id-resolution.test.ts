// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { composeBetas } from "../../src/betas.js";
import type { ClaudeCodeProtocolProfile } from "../../src/contracts.js";
import {
  modelCapability,
  normalizeModelId,
  supportsMidConversationSystem,
} from "../../src/index.js";
import { resolveModel } from "../../src/models.js";
import { BETA_REGISTRY_2_1_288 } from "../../src/profiles/beta-registry-2.1.288.js";
import { CLAUDE_CODE_2_1_288_PROFILE } from "../../src/profiles/claude-code-2.1.288.js";

/*
 * The mid-conversation system form is one decision with two wire
 * consequences: the beta composer pushes `mid-conversation-system-2026-04-07`,
 * and a request builder puts the later system text on the wire as a
 * `system`-role message instead of a user-role `<system-reminder>`. If the
 * header and the body ask different questions they disagree, and the request
 * carries a beta nothing in the body uses (or a body form no beta covers).
 *
 * Two regressions are pinned here:
 *
 *   1. `normalizeModelId` used to test the request-time `[1m]` marker as part
 *      of the id, so `claude-sonnet-4-0[1m]` came back marked. `resolveModel`
 *      then resolved through the uncatalogued-permissive fallback while
 *      `modelCapability` found no catalogue entry.
 *   2. An id no profile catalogues (`claude-sonnet-6`, or a discovery-appended
 *      option) was admitted by the composer's ported fallback and denied by
 *      the catalogue-only `modelCapability`.
 *
 * Both are closed by `supportsMidConversationSystem` being the single answer:
 * it strips the marker, normalizes the id, reads the catalogue first and falls
 * back to the predicate only for ids the catalogue omits.
 *
 * `CLAUDE_CODE_2_1_288_PROFILE` is the profile the subscriptions route pins,
 * and the one the marked-1M catalogue rows are drawn from.
 */
const PROFILE: ClaudeCodeProtocolProfile = CLAUDE_CODE_2_1_288_PROFILE;
const REGISTRY = BETA_REGISTRY_2_1_288;

/** The four marked ids the subscriptions route lists as 1M rows. */
const LISTED_PLAIN_IDS = [
  "claude-sonnet-4-0",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
] as const;

/** An id no pinned catalogue names, of the kind model discovery appends. */
const DISCOVERED_MARKED_ID = "claude-sonnet-6[1m]";

function betasFor(model: string): readonly string[] {
  const resolved = resolveModel(model, PROFILE);
  return composeBetas(
    {
      rawModel: model,
      normalizedId: resolved.id,
      capabilities: resolved.capabilities,
      thinkingDisplayActive: false,
      thinkingActive: false,
    },
    PROFILE,
  );
}

/**
 * `betasFor` minus the one beta the marker itself is allowed to add.
 *
 * The `[1m]` marker is the request-time context-size control, so it composing
 * `context-1m-2025-08-07` is the intended difference between a marked id and
 * its plain spelling. Everything else must be identical.
 */
function betasWithoutLongContext(model: string): readonly string[] {
  return betasFor(model).filter(
    (beta) => beta !== REGISTRY.LONG_CONTEXT.header,
  );
}

describe("marked model ids resolve like their plain spelling", () => {
  it.each(LISTED_PLAIN_IDS)(
    "gives %s[1m] the plain id, wire id, family and capabilities",
    (plain) => {
      expect(normalizeModelId(`${plain}[1m]`)).toBe(plain);
      expect(resolveModel(`${plain}[1m]`, PROFILE)).toEqual(
        resolveModel(plain, PROFILE),
      );
    },
  );

  it("strips the [2m] marker too", () => {
    expect(normalizeModelId("claude-sonnet-4-0[2m]")).toBe("claude-sonnet-4-0");
    expect(resolveModel("claude-sonnet-4-0[2m]", PROFILE)).toEqual(
      resolveModel("claude-sonnet-4-0", PROFILE),
    );
  });

  it.each(LISTED_PLAIN_IDS)(
    "composes the same betas for %s[1m] as for the plain id, apart from the 1M beta",
    (plain) => {
      expect(betasWithoutLongContext(`${plain}[1m]`)).toEqual(betasFor(plain));
    },
  );
});

describe("one predicate owns the mid-conversation decision", () => {
  const MID_CONVERSATION_SYSTEM = REGISTRY.MID_CONVERSATION_SYSTEM.header;
  const MID_CONVERSATION_CLEAR_AT =
    REGISTRY.MID_CONVERSATION_SYSTEM_CLEAR_AT.header;

  it.each(LISTED_PLAIN_IDS)(
    "denies the marked 1M row %s[1m] on both surfaces",
    (plain) => {
      const marked = `${plain}[1m]`;
      expect(PROFILE.supportedModels[plain]?.capabilities).not.toContain(
        "mid_conv_system",
      );
      expect(supportsMidConversationSystem(marked, PROFILE)).toBe(false);

      const betas = betasFor(marked);
      expect(betas).not.toContain(MID_CONVERSATION_SYSTEM);
      expect(betas).not.toContain(MID_CONVERSATION_CLEAR_AT);
    },
  );

  it("admits a capable marked id on both surfaces", () => {
    expect(supportsMidConversationSystem("claude-opus-5[1m]", PROFILE)).toBe(
      true,
    );

    const betas = betasFor("claude-opus-5[1m]");
    expect(betas).toContain(MID_CONVERSATION_SYSTEM);
    expect(betas).toContain(MID_CONVERSATION_CLEAR_AT);
    expect(betasWithoutLongContext("claude-opus-5[1m]")).toEqual(
      betasFor("claude-opus-5"),
    );
  });

  it("admits an id no catalogue names, rather than splitting on it", () => {
    // The composer's ported fallback is authoritative for such an id, and the
    // catalogue-only query is not a second opinion on the body form.
    expect(Object.hasOwn(PROFILE.supportedModels, "claude-sonnet-6")).toBe(
      false,
    );
    expect(
      modelCapability(DISCOVERED_MARKED_ID, "mid_conv_system", PROFILE),
    ).toBe(false);
    expect(supportsMidConversationSystem(DISCOVERED_MARKED_ID, PROFILE)).toBe(
      true,
    );
    expect(supportsMidConversationSystem("claude-sonnet-6", PROFILE)).toBe(true);
    expect(betasFor(DISCOVERED_MARKED_ID)).toContain(MID_CONVERSATION_SYSTEM);
  });

  it("keeps the header and the body gate on one answer for every catalogue id", () => {
    for (const plain of Object.keys(PROFILE.supportedModels)) {
      const capable = PROFILE.supportedModels[plain]?.capabilities.includes(
        "mid_conv_system",
      );

      expect(normalizeModelId(plain)).toBe(plain);
      expect(resolveModel(`${plain}[1m]`, PROFILE)).toEqual(
        resolveModel(plain, PROFILE),
      );
      // Header side (the composer) and body side (the caller's gate) are the
      // same function, so they cannot answer differently about a marked id.
      expect(supportsMidConversationSystem(plain, PROFILE)).toBe(capable);
      expect(supportsMidConversationSystem(`${plain}[1m]`, PROFILE)).toBe(
        capable,
      );
      expect(betasFor(`${plain}[1m]`).includes(MID_CONVERSATION_SYSTEM)).toBe(
        capable,
      );
      expect(betasFor(`${plain}[1m]`).includes(MID_CONVERSATION_CLEAR_AT)).toBe(
        capable,
      );
    }
  });
});
