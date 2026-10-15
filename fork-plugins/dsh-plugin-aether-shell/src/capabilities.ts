/**
 * The interpreter capability reply this plugin verifies before it sends argument
 * data on the typed channel.
 *
 * `structuredDataMode: 'typed-v1'` states which channel the deployment intends;
 * it cannot state what the executable behind `executable` implements, and
 * reported version text is not that contract. Every native call therefore asks
 * the interpreter through the `capabilities` action and sends argument data only
 * when the reply satisfies every field below; a missing, differently versioned,
 * or incomplete reply fails that call closed, with no fallback to the converting
 * channel. Nothing is cached across calls, so a replaced interpreter is verified
 * again instead of trusted from an earlier result.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/capabilities
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { AetherExecDeps } from './exec.ts'
import { runAether } from './exec.ts'
import type { AetherDeniedOutcome, AetherInterruptedOutcome, AetherOutcome } from './outcome.ts'
import { isJsonObject, jsonKindOf } from './outcome.ts'
import { assertRequestBytes, capabilitiesRequest, encodeRequest } from './request.ts'

/** Protocol name a capability reply carries when it comes from the Agent API this plugin drives. */
export const CAPABILITY_PROTOCOL = 'aethershell-agent-api'

/** Capability-reply version the typed channel below is written against. */
export const CAPABILITY_PROTOCOL_VERSION = 1

/**
 * Every feature the typed channel requires, each reported as exactly `true`:
 * argument data and the pipeline seed carried without re-parsing, and an explicit
 * null seed delivered as the None value rather than as "no seed".
 */
export const REQUIRED_TYPED_FEATURES = [
  'typed_arguments_v1',
  'typed_pipeline_input_v1',
  'explicit_null_pipeline_input_v1',
] as const

/** One capability feature the typed channel requires. */
export type AetherTypedFeature = (typeof REQUIRED_TYPED_FEATURES)[number]

/** A capability reply that satisfies every field the typed channel depends on. */
export interface AetherTypedCapabilities {
  /** Protocol the interpreter named, already checked against {@link CAPABILITY_PROTOCOL}. */
  readonly protocol: string
  /** Reply version the interpreter named, already checked against {@link CAPABILITY_PROTOCOL_VERSION}. */
  readonly protocolVersion: number
  /** The required features, all reported true. */
  readonly features: readonly AetherTypedFeature[]
}

/** Longest interpreter text one capability diagnostic quotes back. */
const MAX_DETAIL_CHARS = 300

/** Bound one quoted diagnostic, marking the cut explicitly. */
function bounded(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text
}

/** Quote one answered field for a diagnostic, bounded by {@link MAX_DETAIL_CHARS}. */
function quoted(value: JsonValue | undefined): string {
  return value === undefined ? 'nothing' : bounded(JSON.stringify(value) ?? 'nothing')
}

/**
 * One failure stating what the interpreter answered and what the typed channel
 * needs.
 * @param detail - what went wrong, already bounded.
 * @returns the failure to throw.
 */
function capabilityFailure(detail: string): Error {
  return new Error(`aether-shell [E_CAPABILITY]: ${detail} structuredDataMode "typed-v1" sends argument data only to an interpreter that answers the capabilities action with ${CAPABILITY_PROTOCOL} version ${CAPABILITY_PROTOCOL_VERSION} and ${REQUIRED_TYPED_FEATURES.join(', ')} all true; set structuredDataMode to "legacy" for this interpreter.`)
}

/**
 * Validate one capability reply against every field the typed channel requires.
 * Each field is checked for its exact expected value, never for mere presence.
 * @param value - the interpreter's decoded `capabilities` result.
 * @returns the verified capabilities.
 * @throws Error naming the field that failed and the correction.
 */
export function parseTypedCapabilities(value: JsonValue): AetherTypedCapabilities {
  if (!isJsonObject(value)) {
    throw capabilityFailure(`the interpreter answered the capabilities action with ${jsonKindOf(value)}, not a record.`)
  }
  const { protocol } = value
  if (protocol !== CAPABILITY_PROTOCOL) {
    throw capabilityFailure(`the interpreter named the protocol ${quoted(protocol)}, not ${JSON.stringify(CAPABILITY_PROTOCOL)}.`)
  }
  const protocolVersion = value['protocol_version']
  if (protocolVersion !== CAPABILITY_PROTOCOL_VERSION) {
    throw capabilityFailure(`the interpreter named protocol version ${quoted(protocolVersion)}, not ${CAPABILITY_PROTOCOL_VERSION}.`)
  }
  const features = value['features']
  if (features === undefined) {
    throw capabilityFailure('the reply carries no "features" record.')
  }
  if (!isJsonObject(features)) {
    throw capabilityFailure(`the reply carries ${jsonKindOf(features)} in "features", not a record.`)
  }
  const missing = REQUIRED_TYPED_FEATURES.filter(name => features[name] !== true)
  if (missing.length > 0) {
    throw capabilityFailure(`the reply does not report ${missing.join(', ')} as true.`)
  }
  return { protocol: CAPABILITY_PROTOCOL, protocolVersion: CAPABILITY_PROTOCOL_VERSION, features: [...REQUIRED_TYPED_FEATURES] }
}

/**
 * The result of asking one interpreter whether its typed channel is usable.
 * `stopped` carries the exchange's own canonical outcome unchanged: a file-effect
 * refusal and a spent deadline are orthogonal to a capability mismatch, so their
 * sandbox, process, and diagnostic facts reach the caller intact. No argument
 * data was sent in either arm.
 */
export type AetherCapabilityProbe =
  | { readonly kind: 'verified'; readonly capabilities: AetherTypedCapabilities }
  | { readonly kind: 'stopped'; readonly outcome: AetherDeniedOutcome | AetherInterruptedOutcome }

/** One capability probe: the directory to ask from, the budget left, and the call's own cancellation. */
export interface AetherCapabilityProbeOptions {
  /** Absolute working directory, the same one the argument request would use. */
  readonly cwd: string
  /** The part of this call's overall deadline still unspent, in milliseconds; must be positive. */
  readonly timeoutMs: number
  /** Cancellation owned by the calling tool execution. */
  readonly signal: AbortSignal
}

/**
 * Ask the configured interpreter whether its typed argument channel satisfies
 * {@link parseTypedCapabilities}, under the same capability services, sandbox
 * policy, environment, and working directory the argument request itself uses —
 * so the probe exercises the executable and confinement this call would really
 * get, not a weaker substitute.
 * @param deps - capability services, resolved configuration, and plugin-owned state.
 * @param options - the working directory, the unspent budget, and the call's cancellation.
 * @returns the verified capabilities, or the refused or interrupted exchange unchanged.
 * @throws Error when the interpreter answered and the reply does not satisfy the contract.
 * @throws the structured abort when the caller cancelled the call.
 */
export async function probeTypedCapabilities(
  deps: AetherExecDeps,
  options: AetherCapabilityProbeOptions,
): Promise<AetherCapabilityProbe> {
  const requestText = encodeRequest(capabilitiesRequest())
  assertRequestBytes(requestText, deps.config)
  const outcome: AetherOutcome = await runAether(deps, {
    invocation: { transport: 'agent-api', requestText },
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })
  switch (outcome.kind) {
    case 'value':
      return { kind: 'verified', capabilities: parseTypedCapabilities(outcome.value) }
    case 'error': {
      const code = outcome.error.code
      throw capabilityFailure(`the interpreter refused the capabilities action${code === undefined ? '' : ` (${code})`}: ${bounded(outcome.error.message)}`)
    }
    case 'denied':
    case 'interrupted':
      return { kind: 'stopped', outcome }
  }
}
