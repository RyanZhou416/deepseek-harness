// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The 2.1.288 profile presents the Windows desktop application, and the
 * desktop runs the interactive client: its prompt is typed by a person, its
 * user agent carries the `claude-desktop` entrypoint clause, and its billing
 * header names the same entrypoint. The identity system block must agree with
 * those carriers, so a request built from this profile without an explicit
 * invocation mode carries the interactive CLI line. The headless Agent SDK
 * lines belong to a `sdk-cli` run, which this profile does not describe.
 */

import { describe, expect, it } from "vitest";

import type {
  BuiltClaudeCodeRequest,
  ClaudeCodeRequestInput,
} from "../../src/index.js";
import {
  buildClaudeCodeRequest,
  CLAUDE_CODE_2_1_288_PROFILE,
  checkProfileCoherence,
  IDENTITY_TEXT,
  IDENTITY_TEXT_AGENT,
  IDENTITY_TEXT_AGENT_SDK,
} from "../../src/index.js";

const TOKEN = "sentinel-token-desktop-identity-7a01ce";
const FIRST_USER_TEXT = "hello wire compat";

function input(): ClaudeCodeRequestInput {
  return {
    accessToken: TOKEN,
    model: "claude-sonnet-4-5",
    maxTokens: 128,
    messages: [{ role: "user", content: FIRST_USER_TEXT }],
    system: ["synthetic system prompt"],
    runtime: {
      sessionId: "00000000-0000-4000-8000-000000000001",
      deviceId:
        "0000000000000000000000000000000000000000000000000000000000000002",
      accountUuid: "00000000-0000-4000-8000-000000000000",
      runtime: "node",
      runtimeVersion: "v22.19.0",
      os: "Windows",
      arch: "x64",
    },
    clientRequestId: "00000000-0000-4000-8000-000000000002",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function bodyOf(built: BuiltClaudeCodeRequest): Record<string, unknown> {
  const parsed: unknown = JSON.parse(built.body);
  if (!isRecord(parsed)) throw new Error("built request has no body object");
  return parsed;
}

function systemTexts(built: BuiltClaudeCodeRequest): readonly string[] {
  const system = bodyOf(built)["system"];
  if (!Array.isArray(system)) throw new Error("built request has no system");
  return system.map((block: unknown) => {
    if (!isRecord(block)) throw new Error("system block is not an object");
    const text: unknown = block["text"];
    return typeof text === "string" ? text : "";
  });
}

function headerOf(built: BuiltClaudeCodeRequest, name: string): string {
  return (
    built.headers.find(([candidate]) => candidate.toLowerCase() === name)?.[1] ??
    ""
  );
}

describe("the 2.1.288 desktop presentation is coherent", () => {
  it("declares a profile whose version-bearing fields agree", () => {
    expect(checkProfileCoherence(CLAUDE_CODE_2_1_288_PROFILE)).toEqual([]);
  });

  it("sends the interactive identity line beside the desktop carriers", async () => {
    const built = await buildClaudeCodeRequest(
      input(),
      CLAUDE_CODE_2_1_288_PROFILE,
    );
    const system = systemTexts(built);

    // The body's identity line.
    expect(system[1]).toBe(IDENTITY_TEXT);
    expect(system[1]).not.toBe(IDENTITY_TEXT_AGENT);
    expect(system[1]).not.toBe(IDENTITY_TEXT_AGENT_SDK);

    // The same presentation on the header and billing carriers.
    expect(headerOf(built, "user-agent")).toBe(
      "claude-cli/2.1.288 (external, claude-desktop)",
    );
    expect(headerOf(built, "x-app")).toBe("cli");
    expect(system[0]).toContain(
      "x-anthropic-billing-header: cc_version=2.1.288.",
    );
    expect(system[0]).toContain("; cc_entrypoint=claude-desktop;");
  });

  it("keeps the interactive line when a caller records it", async () => {
    const built = await buildClaudeCodeRequest(
      {
        ...input(),
        runtime: {
          ...input().runtime,
          invocation: { recordedIdentity: IDENTITY_TEXT },
        },
      },
      CLAUDE_CODE_2_1_288_PROFILE,
    );
    expect(systemTexts(built)[1]).toBe(IDENTITY_TEXT);
  });

  it("sends a headless line only when the caller states a headless run", async () => {
    // The seam still reproduces the headless shapes, but a caller that asks
    // for one is asking for a run whose entrypoint is `sdk-cli`, not the
    // desktop this profile describes. The plugin route deliberately omits it.
    const built = await buildClaudeCodeRequest(
      {
        ...input(),
        runtime: {
          ...input().runtime,
          invocation: { isNonInteractive: true, hasAppendSystemPrompt: false },
        },
      },
      CLAUDE_CODE_2_1_288_PROFILE,
    );
    expect(systemTexts(built)[1]).toBe(IDENTITY_TEXT_AGENT);
  });
});
