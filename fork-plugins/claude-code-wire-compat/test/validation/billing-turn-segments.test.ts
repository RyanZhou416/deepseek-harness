// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Behaviour of the turn segments the 2.1.280 and 2.1.288 builders add to the
 * canonical billing block: `cc_turn_origin`, then `cc_prompt_index` and
 * `cc_turn_index` as one pair.
 *
 * The values are the only caller-controlled bytes in the block, so the
 * malformed cases here are a security property, not a tidiness one: every
 * rejected value must be absent from the emitted line ENTIRELY, not merely
 * unrecognised. They assert on the whole line, byte for byte, and additionally
 * that the offending substring appears nowhere in it.
 *
 * The 2.1.288 fingerprint is computed here from the transcribed salt and
 * sampling indices with `node:crypto`, independently of the code under test, so
 * a changed fingerprint cannot make a structural assertion pass by agreement.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  BuiltClaudeCodeRequest,
  ClaudeCodeRequestInput,
  ClaudeCodeTurnPosition,
} from "../../src/index.js";
import {
  buildClaudeCodeRequest,
  CLAUDE_CODE_2_1_195_PROFILE,
  CLAUDE_CODE_2_1_233_PROFILE,
  CLAUDE_CODE_2_1_280_PROFILE,
  CLAUDE_CODE_2_1_288_PROFILE,
  parseBuiltClaudeCodeRequest,
} from "../../src/index.js";
import { createBillingBlock } from "../../src/fingerprint.js";

const TOKEN = "sentinel-token-turn-segments-51c8da";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_REQUEST_ID = "00000000-0000-4000-8000-000000000002";
const FIRST_USER_TEXT = "hello wire compat";

/** `hello wire compat` under the 2.1.288 version, computed independently. */
function fingerprint288(): string {
  const salt = "59cf53e54c78";
  const material = `${salt}${FIRST_USER_TEXT[4] ?? "0"}${FIRST_USER_TEXT[7] ?? "0"}${FIRST_USER_TEXT[20] ?? "0"}2.1.288`;
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 3);
}

const BASE_288 =
  `x-anthropic-billing-header: cc_version=2.1.288.${fingerprint288()}; cc_entrypoint=claude-desktop; cch=00000;`;
const BASE_280 =
  "x-anthropic-billing-header: cc_version=2.1.280.de6; cc_entrypoint=unknown; cch=00000;";
const BASE_233 =
  "x-anthropic-billing-header: cc_version=2.1.233.413; cc_entrypoint=unknown; cch=00000;";
const BASE_195 =
  "x-anthropic-billing-header: cc_version=2.1.195.0f6; cc_entrypoint=unknown; cch=00000;";

const VALID_PREVIOUS_REQUEST_ID = "req_abc123";
const VALID_PROMPT_ID = "0f6e2a71-9d4c-4b8a-8f3d-1c2b3a4d5e6f";
const VALID_POSITION: ClaudeCodeTurnPosition = { promptIndex: 2, turnIndex: 2 };

function validInput(
  overrides: Partial<ClaudeCodeRequestInput> = {},
): ClaudeCodeRequestInput {
  return {
    accessToken: TOKEN,
    model: "claude-sonnet-4-5",
    maxTokens: 128,
    messages: [{ role: "user", content: FIRST_USER_TEXT }],
    system: ["synthetic system prompt"],
    runtime: {
      sessionId: SESSION_ID,
      deviceId:
        "0000000000000000000000000000000000000000000000000000000000000002",
      accountUuid: "00000000-0000-4000-8000-000000000000",
      runtime: "node",
      runtimeVersion: "v24.15.0",
      os: "Windows",
      arch: "x64",
    },
    clientRequestId: CLIENT_REQUEST_ID,
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function systemTexts(built: BuiltClaudeCodeRequest): readonly string[] {
  const raw: unknown = built.body;
  const body: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!isRecord(body)) throw new Error("built request has no body object");
  const system: unknown = body["system"];
  if (!Array.isArray(system)) throw new Error("built request has no system");
  return system.map((block: unknown) => {
    if (!isRecord(block)) throw new Error("system block is not an object");
    const text: unknown = block["text"];
    return typeof text === "string" ? text : "";
  });
}

function billingLine(built: BuiltClaudeCodeRequest): string {
  return systemTexts(built)[0] ?? "";
}

async function buildLine(
  overrides: Partial<ClaudeCodeRequestInput>,
  profile = CLAUDE_CODE_2_1_288_PROFILE,
): Promise<string> {
  return billingLine(
    await buildClaudeCodeRequest(validInput(overrides), profile),
  );
}

describe("billing turn segments at the module seam", () => {
  it("emits nothing when the caller states no turn state", async () => {
    const block = await createBillingBlock(
      FIRST_USER_TEXT,
      CLAUDE_CODE_2_1_288_PROFILE,
    );
    expect(block.text).toBe(BASE_288);
  });

  it("emits the two groups in the client's order", async () => {
    const block = await createBillingBlock(
      FIRST_USER_TEXT,
      CLAUDE_CODE_2_1_288_PROFILE,
      undefined,
      {
        previousRequestId: VALID_PREVIOUS_REQUEST_ID,
        promptId: VALID_PROMPT_ID,
        turnOrigin: "human",
        turnPosition: VALID_POSITION,
      },
    );
    expect(block.text).toBe(
      `${BASE_288} cc_prev_req=${VALID_PREVIOUS_REQUEST_ID}; cc_prompt_id=${VALID_PROMPT_ID}; cc_turn_origin=human; cc_prompt_index=2; cc_turn_index=2;`,
    );
  });

  it("emits each group independently", async () => {
    const originOnly = await createBillingBlock(
      FIRST_USER_TEXT,
      CLAUDE_CODE_2_1_288_PROFILE,
      undefined,
      { turnOrigin: "peer" },
    );
    expect(originOnly.text).toBe(`${BASE_288} cc_turn_origin=peer;`);

    const positionOnly = await createBillingBlock(
      FIRST_USER_TEXT,
      CLAUDE_CODE_2_1_288_PROFILE,
      undefined,
      { turnPosition: { promptIndex: 1, turnIndex: 3 } },
    );
    expect(positionOnly.text).toBe(
      `${BASE_288} cc_prompt_index=1; cc_turn_index=3;`,
    );
  });

  it.each([
    "human",
    "sdk",
    "scheduled",
    "task_notification",
    "auto_continuation",
    "peer",
    "host_synthetic",
    "system",
    "unknown",
  ])("accepts the client's own origin %s", async (turnOrigin) => {
    const block = await createBillingBlock(
      FIRST_USER_TEXT,
      CLAUDE_CODE_2_1_288_PROFILE,
      undefined,
      { turnOrigin },
    );
    expect(block.text).toBe(`${BASE_288} cc_turn_origin=${turnOrigin};`);
  });

  it.each([
    ["empty", ""],
    ["an upper-case letter", "Human"],
    ["a space", "scheduled task"],
    ["a digit first", "1human"],
    ["a hyphen", "host-synthetic"],
    ["thirty-three characters", "a".repeat(33)],
  ])("drops a turn origin with %s", async (_label, turnOrigin) => {
    const block = await createBillingBlock(
      FIRST_USER_TEXT,
      CLAUDE_CODE_2_1_288_PROFILE,
      undefined,
      { turnOrigin },
    );

    expect(block.text).toBe(BASE_288);
    expect(block.text).not.toMatch(/cc_turn_origin/u);
    if (turnOrigin.length > 0) {
      expect(block.text).not.toContain(turnOrigin);
    }
  });

  it("accepts the guard's boundaries", async () => {
    const first = await createBillingBlock(
      FIRST_USER_TEXT,
      CLAUDE_CODE_2_1_288_PROFILE,
      undefined,
      { turnPosition: { promptIndex: 0, turnIndex: 1 } },
    );
    expect(first.text).toBe(`${BASE_288} cc_prompt_index=0; cc_turn_index=1;`);

    const ceiling = await createBillingBlock(
      FIRST_USER_TEXT,
      CLAUDE_CODE_2_1_288_PROFILE,
      undefined,
      { turnPosition: { promptIndex: 1e7, turnIndex: 1e7 } },
    );
    expect(ceiling.text).toBe(
      `${BASE_288} cc_prompt_index=10000000; cc_turn_index=10000000;`,
    );
  });

  it.each([
    ["a negative prompt index", { promptIndex: -1, turnIndex: 1 }],
    ["a fractional index", { promptIndex: 1.5, turnIndex: 2 }],
    ["a zero turn index", { promptIndex: 0, turnIndex: 0 }],
    ["an index above the ceiling", { promptIndex: 0, turnIndex: 1e7 + 1 }],
    ["a prompt index above the turn index", { promptIndex: 2, turnIndex: 1 }],
  ])("drops the pair on %s", async (_label, turnPosition) => {
    const block = await createBillingBlock(
      FIRST_USER_TEXT,
      CLAUDE_CODE_2_1_288_PROFILE,
      undefined,
      { turnPosition },
    );

    expect(block.text).toBe(BASE_288);
    expect(block.text).not.toMatch(/cc_prompt_index|cc_turn_index/u);
  });

  it("emits the origin on 2.1.280 but not the index pair", async () => {
    const block = await createBillingBlock(
      FIRST_USER_TEXT,
      CLAUDE_CODE_2_1_280_PROFILE,
      undefined,
      { turnOrigin: "human", turnPosition: VALID_POSITION },
    );
    expect(block.text).toBe(`${BASE_280} cc_turn_origin=human;`);
  });

  it("emits neither group on 2.1.233 or 2.1.195", async () => {
    for (const [profile, base] of [
      [CLAUDE_CODE_2_1_233_PROFILE, BASE_233],
      [CLAUDE_CODE_2_1_195_PROFILE, BASE_195],
    ] as const) {
      const block = await createBillingBlock(
        FIRST_USER_TEXT,
        profile,
        undefined,
        { turnOrigin: "human", turnPosition: VALID_POSITION },
      );
      expect(block.text).toBe(base);
      expect(block.text).not.toMatch(
        /cc_turn_origin|cc_prompt_index|cc_turn_index/u,
      );
    }
  });
});

describe("billing turn segments through the public builder", () => {
  it("carries all five caller segments in upstream order", async () => {
    await expect(
      buildLine({
        previousRequestId: VALID_PREVIOUS_REQUEST_ID,
        promptId: VALID_PROMPT_ID,
        turnOrigin: "human",
        turnPosition: VALID_POSITION,
      }),
    ).resolves.toBe(
      `${BASE_288} cc_prev_req=${VALID_PREVIOUS_REQUEST_ID}; cc_prompt_id=${VALID_PROMPT_ID}; cc_turn_origin=human; cc_prompt_index=2; cc_turn_index=2;`,
    );
  });

  it("keeps a turn-only request otherwise byte-identical", async () => {
    await expect(buildLine({})).resolves.toBe(BASE_288);
    await expect(buildLine({ turnOrigin: "human" })).resolves.toBe(
      `${BASE_288} cc_turn_origin=human;`,
    );
    await expect(buildLine({ turnPosition: VALID_POSITION })).resolves.toBe(
      `${BASE_288} cc_prompt_index=2; cc_turn_index=2;`,
    );
  });

  it("round-trips a built request carrying the turn segments", async () => {
    const built = await buildClaudeCodeRequest(
      validInput({
        turnOrigin: "human",
        turnPosition: VALID_POSITION,
      }),
      CLAUDE_CODE_2_1_288_PROFILE,
    );
    const reparsed = parseBuiltClaudeCodeRequest(built, CLAUDE_CODE_2_1_288_PROFILE);
    expect(reparsed.body).toBe(built.body);
    expect(billingLine(reparsed)).toBe(billingLine(built));
  });

  it("never interpolates a malformed origin", async () => {
    const line = await buildLine({ turnOrigin: "Human;cc_workload=x" });
    expect(line).toBe(BASE_288);
    expect(line).not.toContain("cc_workload");
  });

  it("rejects a non-string origin with INVALID_INPUT", async () => {
    const input = {
      ...validInput(),
      turnOrigin: 7,
    } as unknown as ClaudeCodeRequestInput;
    await expect(
      buildClaudeCodeRequest(input, CLAUDE_CODE_2_1_288_PROFILE),
    ).rejects.toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it.each([
    ["a non-object", 2],
    ["an array", [1, 2]],
    ["an unknown key", { promptIndex: 1, turnIndex: 1, extra: true }],
    ["a missing key", { promptIndex: 1 }],
    ["a string index", { promptIndex: "1", turnIndex: 1 }],
    ["a null", null],
  ])("rejects turnPosition %s with INVALID_INPUT", async (_label, turnPosition) => {
    const input = {
      ...validInput(),
      turnPosition,
    } as unknown as ClaudeCodeRequestInput;
    await expect(
      buildClaudeCodeRequest(input, CLAUDE_CODE_2_1_288_PROFILE),
    ).rejects.toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("rejects an explicitly undefined turn field, as it does every other field", async () => {
    await expect(
      buildClaudeCodeRequest(
        validInput({ turnOrigin: undefined, turnPosition: undefined }),
        CLAUDE_CODE_2_1_288_PROFILE,
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("omits the segments with the whole block when billing is suppressed", async () => {
    const built = await buildClaudeCodeRequest(
      validInput({
        suppressBillingBlock: true,
        turnOrigin: "human",
        turnPosition: VALID_POSITION,
      }),
      CLAUDE_CODE_2_1_288_PROFILE,
    );
    for (const text of systemTexts(built)) {
      expect(text).not.toContain("x-anthropic-billing-header");
      expect(text).not.toContain("cc_turn_origin");
      expect(text).not.toContain("cc_prompt_index");
      expect(text).not.toContain("cc_turn_index");
    }
  });

  it("leaves the 2.1.195 request byte-identical with every segment supplied", async () => {
    await expect(
      buildLine(
        {
          previousRequestId: VALID_PREVIOUS_REQUEST_ID,
          promptId: VALID_PROMPT_ID,
          turnOrigin: "human",
          turnPosition: VALID_POSITION,
        },
        CLAUDE_CODE_2_1_195_PROFILE,
      ),
    ).resolves.toBe(BASE_195);
  });
});
