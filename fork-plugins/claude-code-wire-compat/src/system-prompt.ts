// SPDX-License-Identifier: GPL-3.0-or-later

import { MAX_INPUT_SIZE } from "./limits.js";

import type {
  ClaudeCodeInvocationMode,
  ClaudeCodeRuntimeIdentity,
  SystemInput,
  TextBlock,
} from "./contracts.js";
import { ClaudeCodeWireError } from "./contracts.js";
import { inspectText, TEXT_POLICY_PROSE } from "./unicode.js";
import { violationDetails, type ViolationPathSegment } from "./violation.js";

/**
 * The pinned interactive-CLI identity text, byte-exact.
 *
 * It is exported because it is the byte-exact probe the parser uses to CONFIRM
 * the canonical system prefix. A caller block equal to ANY pinned identity text
 * (see `IDENTITY_TEXTS`) is dropped by `buildCanonicalSystem` — unconditionally,
 * even when `suppressIdentityBlock` removed the canonical one — so an identity
 * line appears at most once in a built body.
 *
 * The parser no longer INFERS the prefix length from this text's position: the
 * root seams `suppressBillingBlock` and `suppressIdentityBlock` are recorded in
 * `evidence.billingBlockSuppressed` / `evidence.identityBlockSuppressed`, which
 * state which canonical blocks were emitted. This text is what the parser then
 * checks the identity slot against, so evidence is verified structurally rather
 * than trusted.
 */
export const IDENTITY_TEXT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/** The identity line a non-interactive run sends when an appended system prompt is present. */
export const IDENTITY_TEXT_AGENT_SDK =
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";

/** The identity line a non-interactive run sends with no appended system prompt. */
export const IDENTITY_TEXT_AGENT =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/**
 * Every pinned identity line, in the order the upstream client declares them.
 *
 * The set exists because identity matching must not be limited to the CLI form:
 * a non-interactive run sends a different line, and a caller block equal to
 * either of the others must be dropped exactly as the CLI form is.
 */
export const IDENTITY_TEXTS: readonly string[] = Object.freeze([
  IDENTITY_TEXT,
  IDENTITY_TEXT_AGENT_SDK,
  IDENTITY_TEXT_AGENT,
]);

/**
 * Reports whether `text` is one of the pinned identity lines.
 *
 * Accepts `unknown` because callers probe parsed JSON, where a system block's
 * text is not statically known to be a string.
 */
export function isIdentityText(text: unknown): boolean {
  return typeof text === "string" && IDENTITY_TEXTS.includes(text);
}

/**
 * The reporting-outcomes block, byte-exact.
 *
 * The upstream client carries this text inside its standard prompt bundle and
 * its system-block assembler gives it a dedicated slot: immediately after the
 * identity block, before all remaining content, and without a cache marker. A
 * body that carries the attribution and identity blocks without this one is
 * structurally distinguishable from a genuine request.
 */
export const REPORTING_TEXT = `# Reporting outcomes

Report what actually happened, not what you intended. When you say something is done, sent, saved, fixed, or verified, that claim must rest on a result you observed in this session — tool output, the file as it now reads, the page as it now loads — not on what the step should have produced. If you did not check, say you did not check. If any step failed, was skipped, or came back different from what you expected, say so in the first sentence of your report, before anything else, even when the rest of the work succeeded. Never quietly work around a failure in a way that makes it look resolved; a problem the user can see is recoverable, one your summary hides is not. When you stop before the task is complete, your first line says so plainly and names what is left. Do not describe partial work as done, and do not let a summary read as more certain than the evidence behind it.`;

/**
 * Selects the pinned identity line for an invocation mode.
 *
 * @param mode - Invocation inputs; omitted values describe an interactive CLI run.
 * @returns The byte-exact identity line the upstream client would send.
 */
export function selectIdentityText(
  mode: ClaudeCodeInvocationMode | undefined,
): string {
  if (mode?.recordedIdentity !== undefined) return mode.recordedIdentity;
  if (mode?.isNonInteractive === true) {
    return mode.hasAppendSystemPrompt === true
      ? IDENTITY_TEXT_AGENT_SDK
      : IDENTITY_TEXT_AGENT;
  }
  return IDENTITY_TEXT;
}

const MAX_INPUT_DEPTH = 64;
type UnknownRecord = Readonly<Record<PropertyKey, unknown>>;

function fail(
  code:
    | "INVALID_INPUT"
    | "INVALID_UNICODE"
    | "INPUT_TOO_DEEP"
    | "INPUT_TOO_LARGE"
    | "CYCLIC_INPUT",
  safeDetails: Readonly<Record<string, string | number | boolean>> = {},
): never {
  throw new ClaudeCodeWireError(code, safeDetails);
}

function validateText(
  text: string,
  path: readonly ViolationPathSegment[],
  inKey: boolean,
): void {
  // Body prose policy (P1.T1): the system field follows the same rule as
  // every other body lane — only lone surrogates are rejected.
  const violation = inspectText(text, TEXT_POLICY_PROSE);
  if (violation !== null) {
    fail(
      "INVALID_UNICODE",
      violationDetails(violation, path, text.length, inKey),
    );
  }
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object";
}
function validateStructure(value: unknown): void {
  const ancestors = new WeakSet();
  let size = 0;
  const path: ViolationPathSegment[] = ["system"];

  function visit(current: unknown, depth: number): void {
    if (depth > MAX_INPUT_DEPTH) fail("INPUT_TOO_DEEP");

    if (typeof current === "string") {
      size += current.length;
      if (size > MAX_INPUT_SIZE) {
        fail("INPUT_TOO_LARGE", { maximumSize: MAX_INPUT_SIZE });
      }
      validateText(current, path, false);
      return;
    }

    if (!isUnknownRecord(current)) return;
    if (ancestors.has(current)) fail("CYCLIC_INPUT");

    ancestors.add(current);
    for (const key of Reflect.ownKeys(current)) {
      // Only ARRAY indices become numeric segments (QA F1/F4); object keys
      // stay strings and digits inside them render as `*`.
      const segment: ViolationPathSegment =
        typeof key !== "string"
          ? "*"
          : Array.isArray(current) && /^(?:0|[1-9]\d{0,5})$/u.test(key)
            ? Number(key)
            : key;
      path.push(segment);
      if (typeof key === "string") {
        size += key.length;
        if (size > MAX_INPUT_SIZE) {
          fail("INPUT_TOO_LARGE", { maximumSize: MAX_INPUT_SIZE });
        }
        validateText(key, path, true);
      }
      visit(current[key], depth + 1);
      path.pop();
    }
    ancestors.delete(current);
  }

  visit(value, 0);
}

function cloneTextBlock(value: unknown): TextBlock {
  if (!isUnknownRecord(value)) fail("INVALID_INPUT");

  const type = value["type"];
  const text = value["text"];
  if (type !== "text" || typeof text !== "string") fail("INVALID_INPUT");

  const cacheControl = value["cache_control"];
  if (cacheControl === undefined) return Object.freeze({ type: "text", text });
  if (!isUnknownRecord(cacheControl)) fail("INVALID_INPUT");

  const cacheType = cacheControl["type"];
  const ttl = cacheControl["ttl"];
  const scope = cacheControl["scope"];
  if (
    cacheType !== "ephemeral" ||
    (ttl !== undefined && ttl !== "5m" && ttl !== "1h") ||
    (scope !== undefined && scope !== "global")
  ) {
    fail("INVALID_INPUT");
  }

  const clonedCacheControl: {
    type: "ephemeral";
    ttl?: "5m" | "1h";
    scope?: "global";
  } = { type: "ephemeral" };
  if (ttl !== undefined) clonedCacheControl.ttl = ttl;
  if (scope !== undefined) clonedCacheControl.scope = scope;

  return Object.freeze({
    type: "text",
    text,
    cache_control: Object.freeze(clonedCacheControl),
  });
}

function equalCacheControl(
  left: TextBlock["cache_control"],
  right: TextBlock["cache_control"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left === null || right === null) return left === right;
  return left.ttl === right.ttl && left.scope === right.scope;
}

/**
 * Joins two blocks of one cache-control run into a single block.
 *
 * The separator is two newlines, not one: the assembler joins each side of the
 * prompt with `join("\n\n")`, so a body built with a single newline is
 * byte-different from every genuine request carrying more than one caller block.
 */
function joinTextBlocks(left: TextBlock, right: TextBlock): TextBlock {
  return Object.freeze({
    type: "text",
    text: `${left.text}\n\n${right.text}`,
    ...(left.cache_control === undefined
      ? {}
      : { cache_control: left.cache_control }),
  });
}

/** Builds the pinned Claude Code system block sequence without changing caller data. */
export function buildCanonicalSystem(
  input: readonly SystemInput[] | undefined,
  billingBlock: TextBlock,
  identity: ClaudeCodeRuntimeIdentity,
  suppressBillingBlock = false,
  suppressIdentityBlock = false,
): readonly TextBlock[] {
  validateStructure(input);
  if (input !== undefined && !Array.isArray(input)) fail("INVALID_INPUT");
  if (billingBlock.cache_control !== undefined) fail("INVALID_INPUT");

  const clonedBilling = cloneTextBlock(billingBlock);
  const canonicalBilling = Object.isFrozen(billingBlock)
    ? billingBlock
    : clonedBilling;

  // The invocation mode selects the pinned identity line; the text itself
  // intentionally contains no per-request identifiers.
  const identityText = selectIdentityText(identity.invocation);

  // The reporting block is caller-supplied prompt content — the upstream client
  // carries it in its own bundle — but the assembler gives it a dedicated slot
  // whenever the attribution and identity blocks are both present. Its absence
  // from a body that carries those two is structurally distinguishable, which is
  // why the slot is reproduced here rather than left to the caller's ordering.
  const reportingPresent =
    input?.some((entry) =>
      typeof entry === "string"
        ? entry === REPORTING_TEXT
        : isUnknownRecord(entry) && entry["text"] === REPORTING_TEXT,
    ) ?? false;
  const hoistReporting =
    reportingPresent && !suppressBillingBlock && !suppressIdentityBlock;

  // Package extension: `suppressBillingBlock` and `suppressIdentityBlock` are
  // the only ways to omit a canonical block. Both default to `false`, which
  // keeps the canonical prefix the genuine client always emits. With both active
  // the canonical prefix is empty and the emitted `system` array holds caller
  // blocks only.
  const blocks: TextBlock[] = suppressBillingBlock ? [] : [canonicalBilling];
  if (!suppressIdentityBlock) {
    const carrySeparator =
      input?.some((entry) => entry === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) ?? false;
    blocks.push(
      carrySeparator
        ? Object.freeze({ type: "text", text: identityText })
        : Object.freeze({
            type: "text",
            text: identityText,
            cache_control: Object.freeze({ type: "ephemeral", ttl: "1h" }),
          }),
    );
  }
  if (hoistReporting) {
    // No cache marker: the upstream assembler emits this slot without one.
    blocks.push(Object.freeze({ type: "text", text: REPORTING_TEXT }));
  }

  let separated = false
  if (input !== undefined) {
    // The separator splits the caller's prompt into a cache-stable part and a
    // session-varying one, and the two are marked differently. It is a separator, not
    // content: each side is joined into a single block and the entry itself is dropped.
    let run: TextBlock | undefined;
    for (const entry of input) {
      if (entry === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) {
        separated = true;
        if (run !== undefined) {
          // The cache-stable side carries a global scope, which is also the signal the
          // cache step uses to leave the pinned identity block unmarked.
          blocks.push(
            Object.freeze({
              ...run,
              cache_control: Object.freeze({ type: "ephemeral" as const, scope: "global" as const }),
            }),
          );
          run = undefined;
        }
        continue;
      }
      const block: TextBlock =
        typeof entry === "string"
          ? Object.freeze({ type: "text" as const, text: entry })
          : cloneTextBlock(entry);

      // Upstream recognizes only the byte-for-byte identity constants. Similar
      // caller text remains ordinary prompt content.
      //
      // The drop stays UNCONDITIONAL under `suppressIdentityBlock`: the genuine
      // client drops it too, and a caller block equal to an identity text
      // landing at the front of a suppressed prefix would defeat the parser's
      // structural check of the canonical prefix.
      if (isIdentityText(block.text)) continue;
      if (hoistReporting && block.text === REPORTING_TEXT) continue;
      if (run === undefined) {
        run = block;
      } else if (equalCacheControl(run.cache_control, block.cache_control)) {
        run = joinTextBlocks(run, block);
      } else {
        blocks.push(run);
        run = block;
      }
    }
    if (run !== undefined) {
      blocks.push(
        separated
          ? Object.freeze({ ...run, cache_control: Object.freeze({ type: "ephemeral" as const }) })
          : run,
      );
    }
  }

  return Object.freeze(blocks);
}

/**
 * Separator the client inserts between the static and dynamic parts of its prompt.
 *
 * The assembler recognizes it inside the system array, splits there, and marks the two
 * sides differently: the static side carries a global cache scope and the dynamic side a
 * plain ephemeral marker, while the pinned identity block carries none. It is a separator
 * in the prompt bundle, not a block of its own, so it never reaches the wire.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

/** A prompt split at the dynamic boundary. */
export interface BoundarySplit<T> {
  /** Content before the separator, empty when the separator was not present. */
  readonly staticPart: readonly T[];
  /** Content after the separator, empty when the separator was not present. */
  readonly dynamicPart: readonly T[];
  /** Whether the separator appeared; when false both parts are empty. */
  readonly separated: boolean;
}

/**
 * Splits prompt entries at the first dynamic-boundary separator.
 *
 * @param entries - Prompt entries, which may contain the separator as their own entry.
 * @returns Both sides of the separator, with the separator itself removed.
 */
export function splitSystemAtBoundary<T>(
  entries: readonly T[],
): BoundarySplit<T> {
  const index = entries.findIndex((entry) => entry === SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  if (index < 0) return { staticPart: [], dynamicPart: [], separated: false };
  return {
    staticPart: entries.slice(0, index),
    dynamicPart: entries.slice(index + 1),
    separated: true,
  };
}
