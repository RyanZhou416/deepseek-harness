// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  buildClaudeCodeRequest,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from "../../src/index.js";

const base = {
  accessToken: "sentinel-token-public-surface-91f2",
  model: "claude-opus-4-6",
  maxTokens: 1024,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  runtime: {
    sessionId: "00000000-0000-4000-8000-000000000001",
    deviceId:
      "0000000000000000000000000000000000000000000000000000000000000002",
    accountUuid: "00000000-0000-4000-8000-000000000000",
    runtime: "node",
    runtimeVersion: "22.0.0",
    os: "Linux",
    arch: "x64",
  },
  clientRequestId: "request",
} as const;

function callerSystem(body: string): readonly unknown[] {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Expected request body object.");
  }
  const system: unknown = Object.fromEntries(Object.entries(parsed))["system"];
  if (!Array.isArray(system)) throw new TypeError("Expected system array.");
  return system.slice(2);
}

/**
 * The assembler joins the blocks of one cache-control run with a BLANK line —
 * `join("\n\n")` — on both sides of the prompt boundary. The separator is wire
 * content: a single newline produces a body no genuine client sends.
 */
describe("caller system joining", () => {
  it("joins consecutive blocks without cache_control with a blank line", async () => {
    const result = await buildClaudeCodeRequest({
      ...base,
      system: ["static", { type: "text", text: "dynamic" }],
    });

    expect(callerSystem(result.body)).toEqual([
      { type: "text", text: "static\n\ndynamic" },
    ]);
  });

  it("joins consecutive blocks with structurally equal cache_control with a blank line", async () => {
    const result = await buildClaudeCodeRequest({
      ...base,
      system: [
        {
          type: "text",
          text: "static one",
          cache_control: { type: "ephemeral", ttl: "5m", scope: "global" },
        },
        {
          type: "text",
          text: "static two",
          cache_control: { type: "ephemeral", ttl: "5m", scope: "global" },
        },
      ],
    });

    expect(callerSystem(result.body)).toEqual([
      {
        type: "text",
        text: "static one\n\nstatic two",
        cache_control: { type: "ephemeral", ttl: "5m", scope: "global" },
      },
    ]);
  });

  it("keeps a single caller block byte-identical", async () => {
    const result = await buildClaudeCodeRequest({
      ...base,
      system: [
        {
          type: "text",
          text: "single",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    });

    expect(callerSystem(result.body)).toEqual([
      {
        type: "text",
        text: "single",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });
});

/**
 * The dynamic-boundary layout goes through the cache-control pass, not only the
 * assembler: the static side keeps its global scope, the dynamic side stays
 * plain, and the caller's ttl is refreshed onto both without moving a marker.
 */
describe("dynamic-boundary layout through the cache-control pass", () => {
  it("refreshes both sides and leaves the identity block unmarked", async () => {
    const result = await buildClaudeCodeRequest({
      ...base,
      cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: false, messageBreakpoint: false },
      system: [
        "STATIC-SIDE",
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
        "DYNAMIC-SIDE",
      ],
    });
    const system = JSON.parse(result.body)["system"] as {
      text: string;
      cache_control?: { type: string; ttl?: string; scope?: string };
    }[];
    const identity = system.find((block) => block.text.includes("You are Claude Code"));
    expect(identity?.cache_control).toBeUndefined();
    expect(system.find((block) => block.text === "STATIC-SIDE")?.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
      scope: "global",
    });
    expect(system.find((block) => block.text === "DYNAMIC-SIDE")?.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(result.body).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  });
});
