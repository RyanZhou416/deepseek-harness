/**
 * Validated deployment configuration for the AetherShell tools.
 *
 * Every deployment-varying choice — the interpreter, the native runtime mode,
 * the arbitrary-shell switch, the request and output byte budgets, and the
 * process deadlines — is a `Config` field, so a deployment changes it from
 * `cordis.yml` rather than from a constant. {@link resolveConfig} applies the
 * defaults and rejects a value the plugin could not run with before any
 * process starts; {@link callTimeout} resolves one call's deadline the same
 * way.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/config
 */

import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS, clampTimeout } from '@deepseek-ai/dsh-timeout'

/** Default deadline for one native request, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 120_000
/** Default upper bound for a per-call `timeoutMs` hint, in milliseconds. */
const DEFAULT_MAX_TIMEOUT_MS = 600_000
/** Default cap on one encoded request or eval source, in bytes. */
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576
/** Default in-memory cap for each collected interpreter stream, in bytes. */
const DEFAULT_MAX_OUTPUT_BYTES = 262_144
/** Default whole-stream cap for each spill file, in bytes. */
const DEFAULT_MAX_SPILL_BYTES = 8_388_608
/** Default terminate-and-drain grace period for one managed process range, in milliseconds. */
const DEFAULT_GRACE_MS = 3_000
/** Default cap on the complete result one call may hand back, in bytes. */
const DEFAULT_MAX_RESULT_BYTES = 65_536
/** Smallest complete-result budget a deployment may configure, in bytes. */
const MIN_RESULT_BYTES = 1_024
/** Default cap on ontology entries returned by one discovery call. */
const DEFAULT_MAX_MANIFEST_ENTRIES = 64
/** Default cap on one `predicate` expression fragment, in characters. */
const DEFAULT_MAX_EXPRESSION_CHARS = 4_096
/** Default native runtime mode: the non-agent rendering the JSON API is verified against. */
const DEFAULT_MODE = 'human'

/**
 * Native runtime modes this plugin accepts, spelled exactly as the interpreter
 * spells them. An unrecognized value is rejected rather than forwarded, because
 * the interpreter would silently fall back to its own default — and `AGENT`
 * written in uppercase would select nothing, leaving the deployment believing
 * it had opted into agent mode.
 */
export const AETHER_MODES = ['human', 'agent'] as const

/** One accepted native runtime mode. */
export type AetherMode = (typeof AETHER_MODES)[number]

/** Default interpreter: the bare name the AetherShell installer puts on `PATH`. */
const DEFAULT_EXECUTABLE = 'ae'

/** Plugin configuration; every field is optional and resolved by {@link resolveConfig}. */
export interface Config {
  /**
   * AetherShell interpreter: an absolute path or a bare name resolved through
   * the execution world's `PATH` (default `ae`). A relative path containing a
   * separator is rejected because the subprocess seam has no resolution base.
   */
  executable?: string
  /**
   * Trusted deployment argv inserted between the interpreter and its
   * subcommand (default `[]`). This exists for offline protocol fixtures that
   * stand in for the interpreter on a host without AetherShell; it is never
   * model-controlled and never receives per-call arguments.
   */
  executableArgs?: string[]
  /**
   * Value of the child's `AETHER_MODE` (default `human`).
   *
   * `human` is the mode this plugin's decoders are verified against for typed
   * JSON results. `agent` is an explicit opt-in: the interpreter then applies
   * its own agent rendering and gate, and whatever that produces — an
   * AECON-encoded value, a gated or refused builtin — arrives as the native
   * result without normalization. Either way the DSH file policy governs the
   * call, so agent mode never widens what the child may write or delete. Only
   * the two exact lowercase names are accepted; an unrecognized value is
   * rejected instead of falling back to the interpreter's own default.
   */
  mode?: AetherMode
  /**
   * Startup value of the interpreter's own `sh()` switch, passed as
   * `AETHER_ALLOW_SH` (default `false`). This is a convenience default, not a
   * permission boundary: an interpreted program can change its own environment
   * and reach `sh`, `proc_spawn`, and the other process builtins whatever this
   * value is. The calling session's DSH file policy still governs writes and
   * deletes. No tool argument can change the startup value.
   */
  allowShell?: boolean
  /** Default deadline for one call, in milliseconds (default 120000). */
  timeoutMs?: number
  /** Upper bound for a per-call `timeoutMs` hint; at least `timeoutMs` (default 600000). */
  maxTimeoutMs?: number
  /** Cap on one encoded request or eval source, in bytes (default 1048576). */
  maxRequestBytes?: number
  /** In-memory cap for each collected interpreter stream, in bytes (default 262144). */
  maxOutputBytes?: number
  /** Whole-stream cap for each spill file, in bytes (default 8388608). */
  maxSpillBytes?: number
  /**
   * Cap on the complete result one call hands back, in bytes, measured after
   * projection on both the canonical value and its rendered text (default
   * 65536, at least 1024). A result over it becomes a concise failure naming
   * the narrowing remedy instead of a partially delivered value.
   */
  maxResultBytes?: number
  /** Terminate-and-drain grace period for one managed process range (default 3000). */
  graceMs?: number
  /** Cap on ontology entries returned by one discovery call (default 64). */
  maxManifestEntries?: number
  /** Cap on one `predicate` expression fragment, in characters (default 4096). */
  maxExpressionChars?: number
  /** Maximum live interpreter sessions per exact Agent owner (default 4). */
  maxSessionsPerOwner?: number
  /** Idle-session expiry in milliseconds; zero disables expiry (default 1800000). */
  sessionIdleTimeoutMs?: number
  /** Deadline for creating and handshaking one persistent interpreter (default 30000). */
  sessionStartupTimeoutMs?: number
  /** Maximum background-job runtime; zero imposes no ceiling (default 0). */
  maxBackgroundRuntimeMs?: number
}

/** Runtime configuration schema for the AetherShell tools. */
export const Config: z<Config> = z.object({
  executable: z.string().default(DEFAULT_EXECUTABLE),
  executableArgs: z.array(z.string()).default([]),
  mode: z.union([...AETHER_MODES]).default(DEFAULT_MODE),
  allowShell: z.boolean().default(false),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  maxTimeoutMs: z.number().default(DEFAULT_MAX_TIMEOUT_MS),
  maxRequestBytes: z.number().default(DEFAULT_MAX_REQUEST_BYTES),
  maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES),
  maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
  graceMs: z.number().default(DEFAULT_GRACE_MS),
  maxResultBytes: z.number().default(DEFAULT_MAX_RESULT_BYTES),
  maxManifestEntries: z.number().default(DEFAULT_MAX_MANIFEST_ENTRIES),
  maxExpressionChars: z.number().default(DEFAULT_MAX_EXPRESSION_CHARS),
  maxSessionsPerOwner: z.number().step(1).min(1).default(4),
  sessionIdleTimeoutMs: z.number().step(1).min(0).default(1_800_000),
  sessionStartupTimeoutMs: z.number().step(1).min(1).default(30_000),
  maxBackgroundRuntimeMs: z.number().step(1).min(0).default(0),
})

/** Every configuration value one run reads, with no optional field left. */
export interface ResolvedConfig {
  readonly executable: string
  readonly executableArgs: readonly string[]
  readonly mode: AetherMode
  readonly allowShell: boolean
  readonly timeoutMs: number
  readonly maxTimeoutMs: number
  readonly maxRequestBytes: number
  readonly maxOutputBytes: number
  readonly maxSpillBytes: number
  readonly graceMs: number
  readonly maxResultBytes: number
  readonly maxManifestEntries: number
  readonly maxExpressionChars: number
  readonly maxSessionsPerOwner: number
  readonly sessionIdleTimeoutMs: number
  readonly sessionStartupTimeoutMs: number
  readonly maxBackgroundRuntimeMs: number
}

/** Reject a budget the plugin could not run with, at load rather than at the first call. */
function readPositive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`aether-shell: ${name} must be a positive finite number, got ${JSON.stringify(value)}`)
  }
  return value
}

/** The subprocess seam owns the timer bound, so `graceMs` must fit inside it. */
function readGraceMs(value: number): number {
  const graceMs = readPositive('graceMs', value)
  if (graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`aether-shell: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return graceMs
}

/** A complete-result budget below the floor could not carry one usable value. */
function readResultBytes(value: number): number {
  const bytes = readPositive('maxResultBytes', value)
  if (bytes < MIN_RESULT_BYTES) {
    throw new Error(`aether-shell: maxResultBytes must be at least ${MIN_RESULT_BYTES}`)
  }
  return bytes
}

/** Reject a blank or NUL-bearing string setting before it reaches an argv. */
function readText(name: string, value: string): string {
  if (value.trim().length === 0) {
    throw new Error(`aether-shell: ${name} must be a non-empty string`)
  }
  if (value.includes('\0')) {
    throw new Error(`aether-shell: ${name} must not contain a null byte`)
  }
  return value
}

/** Accept an absolute path or a bare name, matching what `resolveExecutable` can look up. */
function readExecutable(value: string): string {
  const executable = readText('executable', value)
  if (!isAbsolute(executable) && /[\\/]/.test(executable)) {
    throw new Error(`aether-shell: executable ${JSON.stringify(executable)} must be an absolute path or a bare name`)
  }
  return executable
}

/** Validate one millisecond setting against the host timer's exact range. */
function readMilliseconds(name: string, value: number, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`aether-shell: ${name} must be an integer between ${allowZero ? 0 : 1} and ${MAX_TIMER_DELAY_MS}`)
  }
  return value
}

/** Validate the per-owner live-session admission limit. */
function readSessionLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('aether-shell: maxSessionsPerOwner must be a positive safe integer')
  }
  return value
}

/** Reject an unusable fixture argv entry at load; an empty element would shift the interpreter's own argv. */
function readExecutableArgs(values: readonly string[]): readonly string[] {
  return values.map((value, index) => readText(`executableArgs[${index}]`, value))
}

/**
 * Accept only the interpreter's own mode spellings. A value it does not
 * recognize selects no mode, so forwarding one would leave the deployment
 * believing it had opted in while the interpreter used its own default.
 */
function readMode(value: string): AetherMode {
  if (value === 'human' || value === 'agent') return value
  throw new Error(`aether-shell: mode must be "human" or "agent", got ${JSON.stringify(value)}; the interpreter accepts only those exact lowercase names and would otherwise fall back to its own default`)
}

/**
 * Apply the deployment defaults and reject values this plugin could not run with.
 * @param config - the loader-validated plugin configuration, possibly empty in a direct call.
 * @returns the complete configuration every run reads.
 * @throws Error naming the first unusable field.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const timeoutMs = readPositive('timeoutMs', config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const maxTimeoutMs = readPositive('maxTimeoutMs', config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS)
  if (maxTimeoutMs < timeoutMs) {
    throw new Error(`aether-shell: maxTimeoutMs (${maxTimeoutMs}) must be at least timeoutMs (${timeoutMs})`)
  }
  return {
    executable: readExecutable(config.executable ?? DEFAULT_EXECUTABLE),
    executableArgs: readExecutableArgs(config.executableArgs ?? []),
    mode: readMode(config.mode ?? DEFAULT_MODE),
    allowShell: config.allowShell ?? false,
    timeoutMs,
    maxTimeoutMs,
    maxRequestBytes: readPositive('maxRequestBytes', config.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES),
    maxOutputBytes: readPositive('maxOutputBytes', config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES),
    maxSpillBytes: readPositive('maxSpillBytes', config.maxSpillBytes ?? DEFAULT_MAX_SPILL_BYTES),
    graceMs: readGraceMs(config.graceMs ?? DEFAULT_GRACE_MS),
    maxResultBytes: readResultBytes(config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES),
    maxManifestEntries: readPositive('maxManifestEntries', config.maxManifestEntries ?? DEFAULT_MAX_MANIFEST_ENTRIES),
    maxExpressionChars: readPositive('maxExpressionChars', config.maxExpressionChars ?? DEFAULT_MAX_EXPRESSION_CHARS),
    maxSessionsPerOwner: readSessionLimit(config.maxSessionsPerOwner ?? 4),
    sessionIdleTimeoutMs: readMilliseconds('sessionIdleTimeoutMs', config.sessionIdleTimeoutMs ?? 1_800_000, true),
    sessionStartupTimeoutMs: readMilliseconds('sessionStartupTimeoutMs', config.sessionStartupTimeoutMs ?? 30_000, false),
    maxBackgroundRuntimeMs: readMilliseconds('maxBackgroundRuntimeMs', config.maxBackgroundRuntimeMs ?? 0, true),
  }
}

/**
 * Resolve one call's deadline: the model's hint, else the configured default,
 * capped by `maxTimeoutMs`.
 * @param requested - the model-supplied hint, validated when present.
 * @param resolved - the resolved deployment configuration.
 * @returns the effective timeout in milliseconds.
 * @throws Error when the hint is not a positive finite number.
 */
export function callTimeout(requested: number | undefined, resolved: ResolvedConfig): number {
  return clampTimeout(requested, resolved.timeoutMs, resolved.maxTimeoutMs, 'aether-shell: timeoutMs')
}
