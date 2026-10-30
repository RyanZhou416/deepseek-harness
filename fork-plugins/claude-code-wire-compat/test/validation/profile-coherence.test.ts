import { describe, expect, it } from "vitest";

import {
  BETA_INTRODUCED_IN,
  BETA_REMOVED_IN,
  CLAUDE_CODE_2_1_195_PROFILE,
  CLAUDE_CODE_2_1_233_PROFILE,
  CLAUDE_CODE_2_1_280_PROFILE,
  CLAUDE_CODE_2_1_288_PROFILE,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  buildCanonicalSystem,
  checkBetaVintage,
  checkProfileCoherence,
  compareVersions,
  composeUserAgent,
  describeStaleness,
  IDENTITY_TEXTS,
  splitSystemAtBoundary,
} from "../../src/index.js";

const PINNED = [
  ["2.1.195", CLAUDE_CODE_2_1_195_PROFILE],
  ["2.1.233", CLAUDE_CODE_2_1_233_PROFILE],
  ["2.1.280", CLAUDE_CODE_2_1_280_PROFILE],
  ["2.1.288", CLAUDE_CODE_2_1_288_PROFILE],
] as const;

describe("version coherence of pinned profiles", () => {
  it.each(PINNED)("keeps every version-bearing field of %s in agreement", (_label, profile) => {
    expect(checkProfileCoherence(profile)).toEqual([]);
  });

  it("states the user agent as a function of the client version and entrypoint", () => {
    expect(composeUserAgent("2.1.280", "cli")).toBe("claude-cli/2.1.280 (external, cli)");
    expect(composeUserAgent("2.1.296", "claude-desktop")).toBe(
      "claude-cli/2.1.296 (external, claude-desktop)",
    );
  });

  it("rejects a user agent that names a different version than the profile claims", () => {
    const problems = checkProfileCoherence({
      ...CLAUDE_CODE_2_1_280_PROFILE,
      userAgent: "claude-cli/2.1.296 (external, cli)",
    });
    expect(problems.join(" ")).toContain("does not name the claimed client");
  });

  it("rejects a user agent that names a different entrypoint than the profile claims", () => {
    const problems = checkProfileCoherence({
      ...CLAUDE_CODE_2_1_280_PROFILE,
      userAgent: "claude-cli/2.1.280 (external, claude-desktop)",
    });
    expect(problems.join(" ")).toContain("does not name the claimed client");
  });

  it("rejects a beta introduced after the claimed client version", () => {
    const [beta, introduced] = [...BETA_INTRODUCED_IN.entries()][0] ?? ["", ""];
    expect(beta).not.toBe("");
    const problems = checkBetaVintage("2.1.280", [beta]);
    expect(problems.join(" ")).toContain(`introduced at ${introduced}`);
  });

  it("rejects a beta withdrawn at or before the claimed client version", () => {
    const [beta, removed] = [...BETA_REMOVED_IN.entries()][0] ?? ["", ""];
    expect(beta).not.toBe("");
    const problems = checkBetaVintage(removed, [beta]);
    expect(problems.join(" ")).toContain(`withdrawn at ${removed}`);
  });

  it("rejects an identifier that omits either version it is built from", () => {
    const problems = checkProfileCoherence({
      ...CLAUDE_CODE_2_1_280_PROFILE,
      id: "claude-code-unknown",
    });
    expect(problems).toHaveLength(2);
  });

  it("orders versions numerically rather than lexically", () => {
    expect(compareVersions("2.1.9", "2.1.10")).toBeLessThan(0);
    expect(compareVersions("2.1.296", "2.1.280")).toBeGreaterThan(0);
    expect(compareVersions("2.1.280", "2.1.280")).toBe(0);
  });

  it("reports staleness against an observed newer version without performing a request", () => {
    expect(describeStaleness(CLAUDE_CODE_2_1_280_PROFILE, "2.1.296")).toBe(
      "profile claims 2.1.280 while 2.1.296 has been observed",
    );
    expect(describeStaleness(CLAUDE_CODE_2_1_280_PROFILE, "2.1.280")).toBeNull();
    expect(describeStaleness(CLAUDE_CODE_2_1_280_PROFILE, "2.1.233")).toBeNull();
  });
});

describe("prompt boundary separator", () => {
  it("splits prompt entries at the separator and removes it", () => {
    const split = splitSystemAtBoundary(["static-a", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "dynamic-a", "dynamic-b"]);
    expect(split.separated).toBe(true);
    expect(split.staticPart).toEqual(["static-a"]);
    expect(split.dynamicPart).toEqual(["dynamic-a", "dynamic-b"]);
  });

  it("reports no separation when the separator is absent, rather than splitting at the end", () => {
    const split = splitSystemAtBoundary(["only-static"]);
    expect(split.separated).toBe(false);
    expect(split.staticPart).toEqual([]);
    expect(split.dynamicPart).toEqual([]);
  });

  it("splits at the first separator only", () => {
    const split = splitSystemAtBoundary([SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "a", SYSTEM_PROMPT_DYNAMIC_BOUNDARY]);
    expect(split.staticPart).toEqual([]);
    expect(split.dynamicPart).toEqual(["a", SYSTEM_PROMPT_DYNAMIC_BOUNDARY]);
  });
});

describe("system array layout at the dynamic boundary", () => {
  const identity = {
    invocation: { isNonInteractive: true, hasAppendSystemPrompt: false },
  } as never;
  const billing = { type: "text" as const, text: "x-anthropic-billing-header: cc_version=2.1.280.abc;" };

  it("leaves the identity block unmarked and marks the two sides differently", () => {
    const blocks = buildCanonicalSystem(
      ["static part", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "dynamic part"],
      billing,
      identity,
    );
    const texts = blocks.map((block) => String(block.text));
    expect(texts).toContain("static part");
    expect(texts).toContain("dynamic part");
    expect(texts.join("\n")).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    const identityBlock = blocks.find((block) => IDENTITY_TEXTS.includes(String(block.text)));
    expect(identityBlock?.cache_control).toBeUndefined();
    const staticBlock = blocks.find((block) => block.text === "static part");
    expect(staticBlock?.cache_control).toEqual({ type: "ephemeral", scope: "global" });
    const dynamicBlock = blocks.find((block) => block.text === "dynamic part");
    expect(dynamicBlock?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("keeps the marker on the identity block when no separator is present", () => {
    const blocks = buildCanonicalSystem(["only part"], billing, identity);
    const identityBlock = blocks.find((block) => IDENTITY_TEXTS.includes(String(block.text)));
    expect(identityBlock?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("joins each side into a single block", () => {
    const blocks = buildCanonicalSystem(
      ["a", "b", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "c", "d"],
      billing,
      identity,
    );
    const texts = blocks.map((block) => String(block.text));
    // Each side of the separator is one cache-control run, joined with the
    // client's blank-line separator.
    expect(texts).toContain("a\n\nb");
    expect(texts).toContain("c\n\nd");
    expect(texts).not.toContain("a");
    expect(texts).not.toContain("d");
  });
});
