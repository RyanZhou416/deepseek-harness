// SPDX-License-Identifier: GPL-3.0-or-later

import type {
  ClaudeCodeProtocolProfile,
  ClaudeCodeTurnPosition,
  TextBlock,
} from "./contracts.js";
import { ClaudeCodeWireError } from "./contracts.js";
import { profileBehaviors } from "./profile-behaviors.js";

const FINGERPRINT_PREFIX = "59cf53e54c78";

/**
 * Upstream guard on `cc_prev_req`, transcribed verbatim from the 2.1.233
 * billing-header builder: the segment is emitted only when the value is
 * defined AND matches this pattern AND the request is first-party.
 */
const PREVIOUS_REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]{1,36}$/;

/**
 * Upstream guard on `cc_prompt_id`, transcribed verbatim from the same builder.
 * The `i` flag is upstream's, not a relaxation: an upper-case UUID IS emitted.
 */
const PROMPT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Upstream guard on `cc_turn_origin`, transcribed verbatim from the 2.1.280
 * billing-header builder (`m4r` in the 2.1.288 carve at `seg_3379.js@2285`).
 *
 * Upstream matches only this shape, so the package does too: a value outside
 * the client's own origin enum but inside the shape is a caller-supplied
 * origin the builder would emit, and this package does not narrow that seam.
 */
const TURN_ORIGIN_PATTERN = /^[a-z][a-z_]{0,31}$/;

/** The client's inclusive ceiling for both turn-position indices. */
const MAX_TURN_POSITION = 1e7;

/**
 * Reports whether a turn-position value is one the client accepts.
 *
 * @param value - the caller-supplied index.
 * @param minimum - the lowest value the client accepts for this index.
 * @returns whether the value is an integer in `[minimum, 1e7]`.
 */
function isTurnPositionValue(value: number, minimum: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= minimum &&
    value <= MAX_TURN_POSITION
  );
}

/**
 * Reports whether a value is the UUID shape both `cc_prompt_id` and the
 * `x-claude-code-prompt-id` header are emitted for.
 *
 * One predicate for both carriers: the client derives the header from the same
 * value it writes into the billing segment, under the same guard, so a value
 * the block drops must not reach the wire through the header either.
 *
 * @param value - the caller-supplied prompt id.
 * @returns whether the value carries the canonical UUID shape.
 */
export function isPromptId(value: string): boolean {
  return PROMPT_ID_PATTERN.test(value);
}

/**
 * The conversation-chaining and turn inputs of the canonical billing block.
 *
 * `previousRequestId` and `promptId` are the 2.1.233 conversation-chaining
 * segments; `turnOrigin` and `turnPosition` are the turn segments the 2.1.280
 * and 2.1.288 builders add. Each is the caller's to supply; see the matching
 * `ClaudeCodeRequestInput` fields.
 */
export interface BillingChain {
  readonly previousRequestId?: string;
  readonly promptId?: string;
  readonly turnOrigin?: string;
  readonly turnPosition?: ClaudeCodeTurnPosition;
}

function isCryptoProvider(value: unknown): value is Pick<Crypto, "subtle"> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const subtle: unknown = Reflect.get(value, "subtle");
  return (
    typeof subtle === "object" &&
    subtle !== null &&
    typeof Reflect.get(subtle, "digest") === "function"
  );
}

function getDefaultCrypto(): Pick<Crypto, "subtle"> {
  const value: unknown = Reflect.get(globalThis, "crypto");
  if (!isCryptoProvider(value)) {
    throw new ClaudeCodeWireError("CRYPTO_UNAVAILABLE");
  }
  return value;
}

export async function createBillingFingerprint(
  firstUserText: string,
  cliVersion: string,
  crypto?: Pick<Crypto, "subtle">,
): Promise<string> {
  const cryptoProvider = crypto ?? getDefaultCrypto();
  // The upstream transcription in the analysis doc writes `||` here; `??` is a
  // deliberate, safe difference, not a divergence to "fix" in either
  // direction. A string subscript yields either a one-unit string, which is
  // always truthy, or `undefined`, so no value makes the two operators
  // disagree (and no test can tell them apart).
  const material = `${FINGERPRINT_PREFIX}${firstUserText[4] ?? "0"}${firstUserText[7] ?? "0"}${firstUserText[20] ?? "0"}${cliVersion}`;
  const bytes = new TextEncoder().encode(material);

  let digest: unknown;
  // Keep this try deliberately narrow so our validation errors are not self-masked.
  try {
    digest = await cryptoProvider.subtle.digest("SHA-256", bytes);
  } catch {
    throw new ClaudeCodeWireError("CRYPTO_UNAVAILABLE");
  }

  let digestBytes: Uint8Array;
  if (digest instanceof ArrayBuffer) {
    digestBytes = new Uint8Array(digest);
  } else if (ArrayBuffer.isView(digest)) {
    digestBytes = new Uint8Array(
      digest.buffer,
      digest.byteOffset,
      digest.byteLength,
    );
  } else {
    // Unvalidated digests silently corrupt billing fingerprints as "" or "000".
    throw new ClaudeCodeWireError("CRYPTO_UNAVAILABLE");
  }
  if (digestBytes.byteLength !== 32) {
    throw new ClaudeCodeWireError("CRYPTO_UNAVAILABLE");
  }

  return Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 3);
}

/**
 * Builds the canonical billing block (system index 0).
 *
 * The upstream builder assembles a fixed prefix followed by optional segments,
 * each one space-prefixed and semicolon-terminated, in this order: `cch`,
 * `cc_workload`, `cc_is_subagent`, `cc_prev_req`, `cc_prompt_id`,
 * `cc_turn_origin`, then `cc_prompt_index` and `cc_turn_index`.
 *
 * Which optional segments a profile's builder can carry is structural: the
 * 2.1.195 builder has none, 2.1.233 gains the two chaining ids, 2.1.280 gains
 * `cc_turn_origin`, and 2.1.288 gains the index pair. `profile-behaviors.ts`
 * owns that split; this module emits the segments in the client's order.
 *
 * `cch=00000;` is always present. Its gate is the first-party predicate, which
 * is true for the Anthropic provider this package targets, and its value is
 * static — the upstream hashed-cache path is dead code. `cc_workload` and
 * `cc_is_subagent` are never emitted: they describe a background workload and
 * a sub-agent session respectively, and this package models the CLI's main
 * session, which has neither.
 *
 * Every remaining segment is conversation state the caller supplies. A value
 * failing its upstream guard is dropped silently, and never interpolated:
 * these are the only caller-controlled bytes in the block, so a value the
 * client cannot vouch for must not reach the wire in any form.
 */
export async function createBillingBlock(
  firstUserText: string,
  profile: ClaudeCodeProtocolProfile,
  crypto?: Pick<Crypto, "subtle">,
  chain?: BillingChain,
): Promise<TextBlock> {
  const { cliVersion, entrypoint } = profile;
  const fingerprint = await createBillingFingerprint(
    firstUserText,
    cliVersion,
    crypto,
  );
  const behaviors = profileBehaviors(profile);

  // The segment reads the environment directly upstream and carries no
  // compiled-in default: an unset `CLAUDE_CODE_ENTRYPOINT` reaches the wire as
  // `unknown`, which the user agent spells `cli` instead.
  let text = `x-anthropic-billing-header: cc_version=${cliVersion}.${fingerprint}; cc_entrypoint=${entrypoint ?? "unknown"}; cch=00000;`;

  /*
   * ---- Demarcated: conversation chaining, upstream 2.1.233. ----
   *
   * The gate is STRUCTURAL, not a capability flag: the 2.1.233 builder takes
   * these two values, the 2.1.195 builder has no parameter for them, so the
   * 195 profile must never emit either segment even when a caller supplies
   * both. They are dropped silently there, exactly as a client without the
   * feature would drop them.
   */
  if (behaviors.billingChainSegments) {
    const previousRequestId = chain?.previousRequestId;
    if (
      previousRequestId !== undefined &&
      PREVIOUS_REQUEST_ID_PATTERN.test(previousRequestId)
    ) {
      text += ` cc_prev_req=${previousRequestId};`;
    }
    const promptId = chain?.promptId;
    if (promptId !== undefined && PROMPT_ID_PATTERN.test(promptId)) {
      text += ` cc_prompt_id=${promptId};`;
    }
  }

  /*
   * ---- Demarcated: turn origin, upstream 2.1.280. ----
   *
   * The 2.1.280 builder gained the origin parameter; the 2.1.233 and 2.1.195
   * builders have none, so those profiles drop the value silently.
   */
  if (behaviors.billingTurnOriginSegment) {
    const turnOrigin = chain?.turnOrigin;
    if (turnOrigin !== undefined && TURN_ORIGIN_PATTERN.test(turnOrigin)) {
      text += ` cc_turn_origin=${turnOrigin};`;
    }
  }

  /*
   * ---- Demarcated: turn position, upstream 2.1.288. ----
   *
   * A seventh builder parameter at 2.1.288 carries the transcript's prompt
   * and turn indices. Upstream emits the two segments TOGETHER, and only while
   * each index is an integer in its own range and the prompt index does not
   * exceed the turn index; otherwise it drops both silently. The 2.1.280 and
   * earlier builders have no such parameter.
   */
  if (behaviors.billingTurnPositionSegments) {
    const turnPosition = chain?.turnPosition;
    if (
      turnPosition !== undefined &&
      isTurnPositionValue(turnPosition.promptIndex, 0) &&
      isTurnPositionValue(turnPosition.turnIndex, 1) &&
      turnPosition.promptIndex <= turnPosition.turnIndex
    ) {
      const promptIndex = String(turnPosition.promptIndex);
      const turnIndex = String(turnPosition.turnIndex);
      text += ` cc_prompt_index=${promptIndex}; cc_turn_index=${turnIndex};`;
    }
  }

  return { type: "text", text };
}
