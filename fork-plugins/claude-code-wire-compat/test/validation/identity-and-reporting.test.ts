// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import type {
  ClaudeCodeRuntimeIdentity,
  SystemInput,
  TextBlock,
} from "../../src/index.js";
import {
  buildCanonicalSystem,
  IDENTITY_TEXT,
  IDENTITY_TEXT_AGENT,
  IDENTITY_TEXT_AGENT_SDK,
  isIdentityText,
  REPORTING_TEXT,
  selectIdentityText,
} from "../../src/index.js";

const BILLING: TextBlock = Object.freeze({
  type: "text",
  text: "x-anthropic-billing-header: synthetic",
});

function identity(
  invocation?: ClaudeCodeRuntimeIdentity["invocation"],
): ClaudeCodeRuntimeIdentity {
  return Object.freeze({
    sessionId: "00000000-0000-4000-8000-000000000001",
    deviceId: "device-synthetic",
    accountUuid: "00000000-0000-4000-8000-000000000000",
    runtime: "node",
    runtimeVersion: "v0.0.0-synthetic",
    os: "Windows",
    arch: "x64",
    ...(invocation === undefined ? {} : { invocation }),
  });
}

const CALLER: readonly SystemInput[] = Object.freeze([
  "caller one",
  "caller two",
]);

describe("selectIdentityText", () => {
  it("defaults to the interactive CLI line", () => {
    expect(selectIdentityText(undefined)).toBe(IDENTITY_TEXT);
    expect(selectIdentityText({})).toBe(IDENTITY_TEXT);
  });

  it("selects the agent line for a non-interactive run without an appended prompt", () => {
    expect(selectIdentityText({ isNonInteractive: true })).toBe(
      IDENTITY_TEXT_AGENT,
    );
  });

  it("selects the Agent SDK line for a non-interactive run with an appended prompt", () => {
    expect(
      selectIdentityText({
        isNonInteractive: true,
        hasAppendSystemPrompt: true,
      }),
    ).toBe(IDENTITY_TEXT_AGENT_SDK);
  });

  it("sends a recorded value verbatim, for any provider pinning its own text", () => {
    expect(selectIdentityText({ recordedIdentity: "recorded line" })).toBe(
      "recorded line",
    );
    expect(selectIdentityText({ recordedIdentity: IDENTITY_TEXT })).toBe(
      IDENTITY_TEXT,
    );
  });

  it("recognizes every pinned line", () => {
    for (const text of [
      IDENTITY_TEXT,
      IDENTITY_TEXT_AGENT_SDK,
      IDENTITY_TEXT_AGENT,
    ]) {
      expect(isIdentityText(text)).toBe(true);
    }
    expect(isIdentityText("You are Claude Code, almost.")).toBe(false);
    expect(isIdentityText(undefined)).toBe(false);
  });
});

describe("buildCanonicalSystem identity selection", () => {
  it("emits the CLI line by default", () => {
    const blocks = buildCanonicalSystem(CALLER, BILLING, identity());
    expect(blocks[1]?.text).toBe(IDENTITY_TEXT);
  });

  it("emits the agent line when the run is non-interactive", () => {
    const blocks = buildCanonicalSystem(
      CALLER,
      BILLING,
      identity({ isNonInteractive: true }),
    );
    expect(blocks[1]?.text).toBe(IDENTITY_TEXT_AGENT);
    expect(blocks[1]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("drops a caller block equal to ANY pinned identity line", () => {
    const blocks = buildCanonicalSystem(
      [IDENTITY_TEXT_AGENT, "kept"],
      BILLING,
      identity(),
    );
    expect(blocks.map((block) => block.text)).toEqual([
      BILLING.text,
      IDENTITY_TEXT,
      "kept",
    ]);
  });
});

describe("buildCanonicalSystem reporting block", () => {
  it("hoists the reporting block into its own slot without a cache marker", () => {
    const blocks = buildCanonicalSystem(
      [REPORTING_TEXT, ...CALLER],
      BILLING,
      identity(),
    );
    expect(blocks.map((block) => block.text)).toEqual([
      BILLING.text,
      IDENTITY_TEXT,
      REPORTING_TEXT,
      // The two caller entries are one cache-control run: the client joins them
      // with a blank line.
      "caller one\n\ncaller two",
    ]);
    expect(blocks[2]?.cache_control).toBeUndefined();
    expect(blocks[3]?.cache_control).toBeUndefined();
  });

  it("leaves the reporting block in caller order when the identity block is suppressed", () => {
    const blocks = buildCanonicalSystem(
      [REPORTING_TEXT, ...CALLER],
      BILLING,
      identity(),
      false,
      true,
    );
    expect(blocks.map((block) => block.text)).toEqual([
      BILLING.text,
      `${REPORTING_TEXT}\n\ncaller one\n\ncaller two`,
    ]);
  });

  it("adds no reporting slot when the caller supplied none", () => {
    const blocks = buildCanonicalSystem(CALLER, BILLING, identity());
    expect(blocks.map((block) => block.text)).toEqual([
      BILLING.text,
      IDENTITY_TEXT,
      "caller one\n\ncaller two",
    ]);
  });

  it("does not duplicate a reporting block already present once", () => {
    const blocks = buildCanonicalSystem([REPORTING_TEXT], BILLING, identity());
    expect(
      blocks.filter((block) => block.text === REPORTING_TEXT),
    ).toHaveLength(1);
  });
});
