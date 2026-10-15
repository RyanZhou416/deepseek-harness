/**
 * The canonical JSON value every AetherShell tool returns, plus the shared
 * readings it is built from.
 *
 * One value transports four independent facts: what the interpreter's own
 * protocol reported, what the operating-system process did, what the sandbox
 * decided, and what the interpreter wrote to its diagnostic stream. They are
 * reported side by side rather than nested, because a process can exit 0 while
 * reporting a failed request (the Agent API reports native failures inside a
 * successful process), a deadlined process can have written a complete reply,
 * and a confining backend can refuse the operation before the interpreter ever
 * runs.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/outcome
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Exit facts of the interpreter process, independent of anything it reported. */
export interface AetherProcessFacts {
  /** Interpreter exit code; `null` when a signal ended it. */
  exitCode: number | null
  /** Terminating signal name; `null` on a normal exit. */
  signal: string | null
  /** The call's deadline elapsed. */
  timedOut: boolean
  /** The plugin stopped the range from outside the call, such as on plugin teardown. */
  aborted: boolean
  /** The deadline actually applied to this call, in milliseconds. */
  timeoutMs: number
  /**
   * The managed process range did not reach quiescence within the grace period
   * after termination, so an interpreter descendant may still be running.
   */
  cleanupFailed: boolean
}

/** The file-effect decision one call ran under. */
export interface AetherSandboxFacts {
  /** The file-effect mode the call's policy resolved to. */
  mode: string
  /** How completely the selected backend enforces that mode; absent when nothing wrapped the argv. */
  enforcement?: string
  /** Whether the backend's own diagnostic dialect identified a denied file effect. */
  denied: boolean
}

/** One collected interpreter stream, retained for diagnostics. */
export interface AetherDiagnostics {
  /** The retained stream text; the tail when `truncated`. */
  text: string
  /** True when the budget dropped bytes, making the in-memory text a tail rather than the whole stream. */
  truncated: boolean
  /** Path of the file holding the complete stream, when one was created and remains intact. */
  spillPath?: string
}

/** A failure the interpreter reported. */
export interface AetherFailure {
  /** Failure text, complete enough to act on. */
  message: string
  /** Interpreter error code, when it named one (for example `E_UNKNOWN_BUILTIN`). */
  code?: string
  /** Builtin the interpreter attributed the failure to, when it named one. */
  builtin?: string
  /** Interpreter guidance for the next attempt, when it offered any. */
  hint?: string
  /** Names the interpreter suggested instead, when it reported any. */
  didYouMean?: string[]
  /** Whether the interpreter considers the same request worth repeating. */
  retryable?: boolean
}

/** An exchange that produced a value. */
export interface AetherValueOutcome {
  kind: 'value'
  /** The interpreter's result. `null` means the interpreter produced no value. */
  value: JsonValue
  /**
   * The interpreter's own `result_type` for the Agent API tools. `aether_eval`
   * reports the JSON kind inferred from `value` (`'null'`, `'boolean'`,
   * `'number'`, `'string'`, `'array'`, `'record'`) and `'none'` when the
   * program printed nothing, because the command-line protocol returns the
   * bare canonical value without a type tag.
   */
  resultType?: string
  /** Interpreter metadata with request-echoing keys removed; absent for `aether_eval`. */
  metadata?: JsonValue
  sandbox: AetherSandboxFacts
  process: AetherProcessFacts
  stderr: AetherDiagnostics
}

/** An exchange the interpreter itself reported as failed. */
export interface AetherErrorOutcome {
  kind: 'error'
  error: AetherFailure
  /** The interpreter's `result_type` when the failure envelope still carried one. */
  resultType?: string
  metadata?: JsonValue
  sandbox: AetherSandboxFacts
  process: AetherProcessFacts
  stderr: AetherDiagnostics
}

/**
 * An exchange the sandbox refused. The operation never ran, so this is not a
 * failure the interpreter reported and not a protocol problem: the recorded
 * denial evidence names the mode that refused it.
 */
export interface AetherDeniedOutcome {
  kind: 'denied'
  /** Confinement facts; `denied` is true by construction. */
  sandbox: AetherSandboxFacts
  process: AetherProcessFacts
  stderr: AetherDiagnostics
}

/** An exchange that produced no result because this plugin stopped the interpreter. */
export interface AetherInterruptedOutcome {
  kind: 'interrupted'
  /** The deadline elapsed. */
  timedOut: boolean
  /** The plugin terminated the managed range from outside the call. */
  aborted: boolean
  sandbox: AetherSandboxFacts
  process: AetherProcessFacts
  stderr: AetherDiagnostics
}

/** Canonical outcome of one AetherShell tool call. */
export type AetherOutcome = AetherValueOutcome | AetherErrorOutcome | AetherDeniedOutcome | AetherInterruptedOutcome

/**
 * Whether a decoded value is a JSON object.
 * @param value - any decoded value, including one that arrived from a child process.
 * @returns true for a non-null, non-array object.
 */
export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Name the JSON kind of a canonical value.
 * @param value - the canonical value decoded from the interpreter's stdout.
 * @returns the JSON type name, using `record` for objects.
 */
export function jsonKindOf(value: JsonValue): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'boolean': return 'boolean'
    case 'number': return 'number'
    case 'string': return 'string'
    default: return 'record'
  }
}

/**
 * Describe why one JSON number cannot round-trip exactly through this runtime.
 *
 * JSON carries integers of unbounded width, but this runtime stores every
 * number as an IEEE-754 double: an integer beyond the exact range is silently
 * rounded, and `-0` is written back as `0`. Both boundaries call this so a
 * value that would be silently altered is refused instead.
 * @param value - one decoded number.
 * @returns the described problem, or undefined when the number round-trips exactly.
 */
export function numberFidelityProblem(value: number): string | undefined {
  if (!Number.isFinite(value)) return `the non-finite number ${String(value)}`
  if (Object.is(value, -0)) return 'negative zero, which JSON writes back as 0'
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return `the integer ${String(value)}, which lies outside the exact integer range this runtime compares and rounds`
  }
  return undefined
}

/**
 * Remove the metadata entries that only restate the request. The interpreter
 * echoes the generated call as `code_executed` on success and `code_attempted`
 * on failure; both duplicate what the caller already sent, and the failure form
 * echoes model-supplied source back into the transcript.
 * @param metadata - the envelope's metadata, when it carried any.
 * @returns the remaining metadata, or undefined when nothing remains.
 */
export function stripRequestEcho(metadata: JsonValue | undefined): JsonValue | undefined {
  if (metadata === undefined || !isJsonObject(metadata)) return metadata
  const kept: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (key !== 'code_executed' && key !== 'code_attempted') kept[key] = value
  }
  return Object.keys(kept).length === 0 ? undefined : kept
}

/**
 * Render the pointer to a spilled stream for a failure message.
 * @param spillPath - the spill file path, when the provider created one.
 * @returns a message suffix, empty without a spill file.
 */
export function recovery(spillPath: string | undefined): string {
  return spillPath === undefined ? '' : `; complete stream: ${spillPath}`
}
