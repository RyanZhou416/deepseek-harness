// SPDX-License-Identifier: GPL-3.0-or-later

import { ClaudeCodeWireError } from "./contracts.js";
import type {
  ClaudeCodeInvocationMode,
  ClaudeCodeMetadataOverrides,
  ClaudeCodeRuntimeIdentity,
  JsonValue,
} from "./contracts.js";
import { inspectJsonInputs, validatedJson } from "./request-body.js";
import { classifySurrogateAt } from "./unicode.js";

const MAX_TEXT_LENGTH = 8_192;
/**
 * Ceiling the client applies to the serialized `user_id`.
 *
 * The client measures its own composed object and falls back to the
 * correlation triple when extra metadata pushes it past this many characters.
 * It applies to the derived object only: a caller-supplied replacement
 * (`metadataOverrides.userId`) is this package's seam and is not resized.
 */
const MAX_USER_ID_LENGTH = 512;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CORRELATION_KEYS = new Set([
  "user_id",
  "device_id",
  "account_uuid",
  "session_id",
]);
/**
 * The members of the derived `user_id` JSON object.
 *
 * `metadataOverrides.userIdFields` may not carry these keys: the package writes
 * them last so correlation always wins, and a silently overwritten caller value
 * would look honoured while being discarded.
 */
const IDENTITY_KEYS = new Set(["device_id", "account_uuid", "session_id"]);

function hasInvalidUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const classification = classifySurrogateAt(value, index);
    if (classification === "loneSurrogate") return true;
    if (classification === "surrogatePair") index += 1;
  }
  return false;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor === undefined || !("value" in descriptor)
    ? undefined
    : descriptor.value;
}

function validateIdentityText(
  value: unknown,
  field: keyof ClaudeCodeRuntimeIdentity,
): string {
  if (typeof value !== "string") {
    throw new ClaudeCodeWireError("INVALID_IDENTITY", { field });
  }
  if (hasInvalidUtf16(value)) {
    throw new ClaudeCodeWireError("INVALID_UNICODE", { field });
  }
  if (
    value.length === 0 ||
    value.length > MAX_TEXT_LENGTH ||
    value.trim().length === 0 ||
    hasControlCharacter(value)
  ) {
    throw new ClaudeCodeWireError("INVALID_IDENTITY", { field });
  }
  return value;
}

function validateIdentityObject(identity: unknown): object {
  if (
    typeof identity !== "object" ||
    identity === null ||
    Array.isArray(identity)
  ) {
    throw new ClaudeCodeWireError("INVALID_IDENTITY");
  }
  for (const key of Reflect.ownKeys(identity)) {
    if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) {
      throw new ClaudeCodeWireError("INVALID_IDENTITY");
    }
  }
  return identity;
}

/**
 * Validates the optional invocation-mode object that selects the pinned identity
 * line. An absent value describes an interactive CLI run, which is the upstream
 * default, so callers that do not emulate a specific mode stay valid.
 */
function validateInvocationMode(
  value: unknown,
): ClaudeCodeInvocationMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClaudeCodeWireError("INVALID_IDENTITY", { field: "invocation" });
  }
  const source = value as Record<string, unknown>;
  const isNonInteractive = source["isNonInteractive"];
  const hasAppendSystemPrompt = source["hasAppendSystemPrompt"];
  const recordedIdentity = source["recordedIdentity"];
  if (isNonInteractive !== undefined && typeof isNonInteractive !== "boolean") {
    throw new ClaudeCodeWireError("INVALID_IDENTITY", {
      field: "isNonInteractive",
    });
  }
  if (
    hasAppendSystemPrompt !== undefined &&
    typeof hasAppendSystemPrompt !== "boolean"
  ) {
    throw new ClaudeCodeWireError("INVALID_IDENTITY", {
      field: "hasAppendSystemPrompt",
    });
  }
  const recorded =
    recordedIdentity === undefined
      ? undefined
      : validateIdentityText(recordedIdentity, "invocation");
  return Object.freeze({
    ...(isNonInteractive === undefined ? {} : { isNonInteractive }),
    ...(hasAppendSystemPrompt === undefined ? {} : { hasAppendSystemPrompt }),
    ...(recorded === undefined ? {} : { recordedIdentity: recorded }),
  });
}

export function validateRuntimeIdentity(
  identity: unknown,
): ClaudeCodeRuntimeIdentity {
  const source = validateIdentityObject(identity);
  const sessionId = validateIdentityText(
    ownDataValue(source, "sessionId"),
    "sessionId",
  );
  const deviceId = validateIdentityText(
    ownDataValue(source, "deviceId"),
    "deviceId",
  );
  const accountUuid = validateIdentityText(
    ownDataValue(source, "accountUuid"),
    "accountUuid",
  );
  const runtime = validateIdentityText(
    ownDataValue(source, "runtime"),
    "runtime",
  );
  const runtimeVersion = validateIdentityText(
    ownDataValue(source, "runtimeVersion"),
    "runtimeVersion",
  );
  const os = validateIdentityText(ownDataValue(source, "os"), "os");
  const arch = validateIdentityText(ownDataValue(source, "arch"), "arch");
  const invocation = validateInvocationMode(
    ownDataValue(source, "invocation"),
  );

  if (runtime !== "node" && runtime !== "bun" && runtime !== "workerd") {
    throw new ClaudeCodeWireError("INVALID_IDENTITY", { field: "runtime" });
  }
  if (os !== "Windows" && os !== "Linux" && os !== "macOS") {
    throw new ClaudeCodeWireError("INVALID_IDENTITY", { field: "os" });
  }

  return Object.freeze({
    sessionId,
    deviceId,
    accountUuid,
    runtime,
    runtimeVersion,
    os,
    arch,
    ...(invocation === undefined ? {} : { invocation }),
  });
}

function validateMetadataKey(key: PropertyKey): string {
  if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) {
    throw new ClaudeCodeWireError("INVALID_INPUT");
  }
  if (hasInvalidUtf16(key)) {
    throw new ClaudeCodeWireError("INVALID_UNICODE", { field: "metadataKey" });
  }
  if (key.length > MAX_TEXT_LENGTH) {
    throw new ClaudeCodeWireError("INPUT_TOO_LARGE", {
      field: "metadataKey",
    });
  }
  if (key.length === 0 || hasControlCharacter(key)) {
    throw new ClaudeCodeWireError("INVALID_INPUT", { field: "metadataKey" });
  }
  return key;
}

function validateMetadataValue(value: unknown, key: string): JsonValue {
  if (typeof value === "string") {
    if (hasInvalidUtf16(value)) {
      throw new ClaudeCodeWireError("INVALID_UNICODE", { field: key });
    }
    if (value.length > MAX_TEXT_LENGTH) {
      throw new ClaudeCodeWireError("INPUT_TOO_LARGE", { field: key });
    }
    if (hasControlCharacter(value)) {
      throw new ClaudeCodeWireError("INVALID_UNICODE", { field: key });
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ClaudeCodeWireError("INVALID_INPUT", { field: key });
    }
    return value;
  }
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value !== "object") {
    throw new ClaudeCodeWireError("INVALID_INPUT", { field: key });
  }
  inspectJsonInputs([value], (nestedString) => {
    if (hasInvalidUtf16(nestedString)) {
      throw new ClaudeCodeWireError("INVALID_UNICODE", { field: key });
    }
    if (nestedString.length > MAX_TEXT_LENGTH) {
      throw new ClaudeCodeWireError("INPUT_TOO_LARGE", { field: key });
    }
    if (hasControlCharacter(nestedString)) {
      throw new ClaudeCodeWireError("INVALID_UNICODE", { field: key });
    }
  });
  return validatedJson(value);
}

function expectedCorrelationValue(
  key: string,
  identity: ClaudeCodeRuntimeIdentity,
  userId: string,
): string | undefined {
  switch (key) {
    case "user_id":
      return userId;
    case "device_id":
      return identity.deviceId;
    case "account_uuid":
      return identity.accountUuid;
    case "session_id":
      return identity.sessionId;
    default:
      return undefined;
  }
}

function validateMetadataObject(metadata: unknown): object {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new ClaudeCodeWireError("INVALID_INPUT", { field: "metadata" });
  }
  return metadata;
}

/**
 * Validates a package-extension `user_id` replacement.
 *
 * PACKAGE EXTENSION, not observed Claude Code behaviour. The value is opaque to
 * this package, so it is checked only for wire-safety, never for correlation.
 */
function validateOverrideUserId(value: unknown): string {
  if (typeof value !== "string") {
    throw new ClaudeCodeWireError("INVALID_INPUT", { field: "userId" });
  }
  if (hasInvalidUtf16(value)) {
    throw new ClaudeCodeWireError("INVALID_UNICODE", { field: "userId" });
  }
  if (value.length > MAX_TEXT_LENGTH) {
    throw new ClaudeCodeWireError("INPUT_TOO_LARGE", { field: "userId" });
  }
  if (hasControlCharacter(value)) {
    throw new ClaudeCodeWireError("INVALID_UNICODE", { field: "userId" });
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new ClaudeCodeWireError("INVALID_INPUT", { field: "userId" });
  }
  return value;
}

/** Validates the package-extension members merged into the `user_id` object. */
function validateUserIdFields(value: unknown): [string, JsonValue][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClaudeCodeWireError("INVALID_INPUT", { field: "userIdFields" });
  }
  const entries: [string, JsonValue][] = [];
  for (const rawKey of Reflect.ownKeys(value)) {
    const key = validateMetadataKey(rawKey);
    if (IDENTITY_KEYS.has(key)) {
      throw new ClaudeCodeWireError("INVALID_INPUT", { field: key });
    }
    entries.push([key, validateMetadataValue(ownDataValue(value, key), key)]);
  }
  return entries;
}

/**
 * Resolves the emitted `user_id`, applying the package-extension seam.
 *
 * With no overrides this is the derived correlation triple, byte for byte as
 * before the seam existed. The two override members are mutually exclusive
 * because they express opposite intents: one abandons the derived value, the
 * other extends it.
 *
 * Extended members are subject to the client's size ladder. The client drops
 * extra metadata before it drops the correlation triple, and keeps the triple
 * even when it alone exceeds the ceiling, so callers never see `user_id` shrink
 * below `{device_id, account_uuid, session_id}`.
 */
function resolveUserId(
  identity: ClaudeCodeRuntimeIdentity,
  overrides: unknown,
): string {
  const correlation = {
    device_id: identity.deviceId,
    account_uuid: identity.accountUuid,
    session_id: identity.sessionId,
  };
  const base = JSON.stringify(correlation);
  if (overrides === undefined) return base;
  if (
    typeof overrides !== "object" ||
    overrides === null ||
    Array.isArray(overrides)
  ) {
    throw new ClaudeCodeWireError("INVALID_INPUT", {
      field: "metadataOverrides",
    });
  }
  const hasUserId = Object.hasOwn(overrides, "userId");
  const hasUserIdFields = Object.hasOwn(overrides, "userIdFields");
  if (hasUserId && hasUserIdFields) {
    throw new ClaudeCodeWireError("INVALID_INPUT", {
      field: "metadataOverrides",
    });
  }
  if (hasUserId) {
    return validateOverrideUserId(ownDataValue(overrides, "userId"));
  }
  if (!hasUserIdFields) return base;
  const fields = validateUserIdFields(ownDataValue(overrides, "userIdFields"));
  // Caller members first, correlation last: the triple always wins, which
  // mirrors how the consumer composes the same object.
  const extended = JSON.stringify({
    ...Object.fromEntries(fields),
    ...correlation,
  });
  return extended.length > MAX_USER_ID_LENGTH ? base : extended;
}

export function buildCorrelatedMetadata(
  identity: ClaudeCodeRuntimeIdentity,
  suppliedMetadata?: Readonly<Record<string, JsonValue>>,
  overrides?: ClaudeCodeMetadataOverrides,
): Readonly<Record<string, JsonValue>> {
  const validatedIdentity = validateRuntimeIdentity(identity);
  const userId = resolveUserId(validatedIdentity, overrides);
  const entries: [string, JsonValue][] = [["user_id", userId]];

  if (suppliedMetadata === undefined) return Object.freeze({ user_id: userId });
  const metadataObject = validateMetadataObject(suppliedMetadata);

  for (const rawKey of Reflect.ownKeys(metadataObject)) {
    const key = validateMetadataKey(rawKey);
    const value = validateMetadataValue(ownDataValue(metadataObject, key), key);
    if (CORRELATION_KEYS.has(key)) {
      const expected = expectedCorrelationValue(key, validatedIdentity, userId);
      if (value !== expected) {
        throw new ClaudeCodeWireError("INVALID_INPUT", { field: key });
      }
      if (key === "user_id") continue;
    }
    entries.push([key, value]);
  }

  return Object.freeze(Object.fromEntries(entries));
}
