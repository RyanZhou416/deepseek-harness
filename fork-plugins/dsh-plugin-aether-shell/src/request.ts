/**
 * Construction and validation of every request this plugin sends to the
 * AetherShell interpreter.
 *
 * Two argument channels exist, selected by the deployment's trusted
 * `structuredDataMode`. The `legacy` channel converts a request's JSON arguments
 * into AetherShell source before evaluating them, and two verified conversions
 * make otherwise inert data executable: a string containing `${` is interpolated
 * as an expression, and an object key is emitted unquoted. {@link assertSafeData}
 * therefore rejects those shapes, plus an explicit null pipeline seed that the
 * native request reads as "no seed", instead of forwarding data the interpreter
 * would re-parse as code or silently reshape. The `typed-v1` channel carries the
 * same values as data, so those three shapes are legitimate there; the
 * interpreter's capability reply is what makes that channel real, and
 * `capabilities.ts` verifies it before any argument travels this way.
 *
 * Builtin names, `select` paths, and `predicate` fragments travel outside the
 * data channel and each carry their own syntax check. A `predicate` is
 * AetherShell source on both channels, so only its envelope is bounded. A
 * `select` is a field path the interpreter expands; on the converting channel it
 * must be a plain dotted identifier path, and on the typed channel it is read as
 * data, so only empty segments are meaningless there.
 *
 * Arguments are also held to JSON fidelity on both channels: this runtime stores
 * numbers as IEEE-754 doubles, so an integer beyond the exact range — including
 * an integral float such as `1e300` — and `-0` are refused rather than silently
 * rounded. A value that needs that range must travel as a string or be built
 * inside `aether_eval`.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/request
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ResolvedConfig, StructuredDataMode } from './config.ts'
import { isJsonObject, numberFidelityProblem } from './outcome.ts'

/** A flat builtin name. Dotted names parse as field access and evaluate to Null. */
const FLAT_BUILTIN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** A dotted field path for `select`, which the interpreter expands to `x.<path>`. */
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/
/** A record key the interpreter's unquoted object emission can represent. */
const RECORD_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
/** The one sequence the native JSON-to-source conversion re-parses inside string data. */
const INTERPOLATION = '${'

/**
 * Windows `CreateProcess` caps the complete command line at 32767 UTF-16
 * units. One eval source travels as a single argv element, so it is bounded by
 * this fixed external limit as well as the deployment's byte budget.
 */
export const MAX_ARGV_CHARS = 30_000

/** The interpreter argv tail serving one Agent API request, after the executable and fixture argv. */
export const AGENT_API_ARGV: readonly string[] = ['agent', 'execute']

/** One pipeline step of a native `pipeline` request. */
export interface AetherPipelineStep {
  /** Flat builtin name this step calls. */
  readonly builtin: string
  /** Positional arguments, in the order the builtin's signature declares them. */
  readonly args?: readonly JsonValue[]
  /**
   * Field path appended to the item the interpreter maps each result element
   * through (`ls(".")` with `select: "name"` becomes
   * `ls(".") | map(fn(x) => x.name)`).
   */
  readonly select?: string
  /**
   * AetherShell expression handed to this step's builtin as a lambda first
   * argument (`fn(x) => <predicate>`); when present it replaces the step's
   * `args`.
   */
  readonly predicate?: string
}

/** A native Agent API request body. */
export type AetherRequest =
  | { readonly action: 'call'; readonly builtin: string; readonly args?: readonly JsonValue[] }
  | { readonly action: 'pipeline'; readonly steps: readonly AetherPipelineStep[]; readonly input?: JsonValue }
  | { readonly action: 'eval'; readonly code: string }
  | { readonly action: 'capabilities' }

/**
 * Longest model-supplied value a validation message quotes back. A thrown
 * message is not covered by the complete-result budget, so every diagnostic
 * this module builds must be bounded by construction.
 */
const MAX_QUOTED_CHARS = 120

/** Quote one model-supplied value for a diagnostic, eliding it at the cap. */
function quote(value: string): string {
  const text = value.length > MAX_QUOTED_CHARS ? `${value.slice(0, MAX_QUOTED_CHARS)}…` : value
  return JSON.stringify(text)
}

/**
 * Reject a builtin name the interpreter would re-parse as something other than
 * a name. A dotted name parses as field access (`crypto.hash` evaluates to
 * Null), so only a flat identifier is accepted.
 * @param name - the model-supplied builtin name.
 * @param path - the argument path used in the thrown message.
 * @throws Error naming the offending path.
 */
export function assertFlatBuiltin(name: string, path: string): void {
  if (!FLAT_BUILTIN.test(name)) {
    throw new Error(`aether-shell [E_INPUT_BUILTIN]: ${path} ${quote(name)} is not a builtin name; pass one flat native name from aether_discover (letters, digits, and underscores).`)
  }
}

/**
 * Reject a `select` value this deployment's channel cannot deliver.
 *
 * On the converting channel the interpreter expands `select` into `x.<select>`
 * inside `map(fn(x) => …)`, so anything beyond a plain dotted path would be
 * re-parsed as source rather than read as a field. On the typed channel the path
 * is read as data, so any non-empty dot-separated segment is a field name —
 * spaces and reserved characters included — and only an empty path, an empty
 * segment, or a null byte is meaningless. A segment is not quoted, so a field
 * name that itself contains a `.` is indistinguishable from nesting and cannot
 * be selected here.
 * @param select - the model-supplied field path.
 * @param path - the argument path used in the thrown message.
 * @param mode - the deployment's argument channel; omitting it checks the converting channel's stricter grammar.
 * @throws Error naming the offending path.
 */
export function assertSelectPath(select: string, path: string, mode: StructuredDataMode = 'legacy'): void {
  if (mode === 'typed-v1') {
    const segments = select.split('.')
    if (select.length === 0 || select.includes('\0') || segments.some(segment => segment.length === 0)) {
      throw new Error(`aether-shell [E_INPUT_SELECT]: ${path} ${quote(select)} is not a field path; the typed channel reads one or more non-empty dot-separated segments, so the path, every segment, and any null byte must be non-empty.`)
    }
    return
  }
  if (!FIELD_PATH.test(select)) {
    throw new Error(`aether-shell [E_INPUT_SELECT]: ${path} ${quote(select)} is not a field path; select reads a dotted record path (for example "name" or "meta.size") and cannot contain source syntax.`)
  }
}

/**
 * Reject a `predicate` fragment the interpreter could not place as an
 * expression. The fragment is intentionally AetherShell source evaluated under
 * this host's confinement, so only its syntax envelope is bounded here.
 * @param predicate - the model-supplied expression fragment.
 * @param path - the argument path used in the thrown message.
 * @param resolved - the resolved deployment configuration supplying the length budget.
 * @throws Error naming the offending path.
 */
export function assertPredicate(predicate: string, path: string, resolved: ResolvedConfig): void {
  if (predicate.trim().length === 0) {
    throw new Error(`aether-shell [E_INPUT_PREDICATE]: ${path} must be a non-empty expression`)
  }
  if (predicate.includes('\0')) {
    throw new Error(`aether-shell [E_INPUT_PREDICATE]: ${path} must not contain a null byte`)
  }
  if (predicate.length > resolved.maxExpressionChars) {
    throw new Error(`aether-shell [E_INPUT_PREDICATE]: ${path} is ${predicate.length} characters, over the ${resolved.maxExpressionChars}-character budget for one expression fragment`)
  }
}

/**
 * Reject model-supplied data that would not survive the trip to the interpreter
 * unchanged.
 *
 * On the converting channel two verified conversions make otherwise inert data
 * executable: a string containing `${` is interpolated as an expression (`echo`
 * of `"a${1 + 2}b"` returns `a3b`), and an object key is emitted unquoted, so a
 * key outside the identifier syntax either fails to parse (`{"a-b": 1}`) or
 * silently changes the record (`{"a:1,extra": 1}` becomes two fields). Both are
 * refused there. The typed channel carries the same values as data, so neither
 * shape is code on it, and both are accepted; `capabilities.ts` verifies that
 * channel before a caller can reach this function with `typed-v1`.
 *
 * A number outside the exact integer range, including an integral float such as
 * `1e300`, is refused on every channel because this runtime would round it
 * before the interpreter ever saw it.
 *
 * The walk is iterative: a model can nest an array thousands deep inside the
 * request budget, and a recursive walk would overflow the stack instead of
 * reporting which argument is unusable.
 * @param value - the decoded JSON value about to be sent as builtin data.
 * @param path - the argument path used in the thrown message.
 * @param mode - the deployment's argument channel; omitting it applies the converting channel's checks, which is the stricter of the two.
 * @throws Error naming the offending path and the required correction.
 */
export function assertSafeData(value: JsonValue, path: string, mode: StructuredDataMode = 'legacy'): void {
  const converting = mode === 'legacy'
  const pending: { readonly value: JsonValue; readonly path: string }[] = [{ value, path }]
  while (true) {
    const item = pending.pop()
    if (item === undefined) return
    const current = item.value
    if (typeof current === 'string') {
      if (converting && current.includes(INTERPOLATION)) {
        throw new Error(`aether-shell [E_INPUT_LITERAL]: ${item.path} contains "${INTERPOLATION}"; the interpreter interpolates that sequence inside string data as executable code. Remove it, or build the value with aether_eval.`)
      }
      continue
    }
    if (typeof current === 'number') {
      const problem = numberFidelityProblem(current)
      if (problem !== undefined) {
        throw new Error(`aether-shell [E_INPUT_NUMBER]: ${item.path} is ${problem}. This runtime cannot send it unchanged; pass it as a string, or build it inside aether_eval.`)
      }
      continue
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => { pending.push({ value: entry, path: childPath(item.path, `[${index}]`) }) })
      continue
    }
    if (isJsonObject(current)) {
      for (const [key, entry] of Object.entries(current)) {
        if (converting && !RECORD_KEY.test(key)) {
          throw new Error(`aether-shell [E_INPUT_KEY]: ${item.path} has the key ${quote(key)}, which is not a plain identifier; the interpreter writes object keys unquoted, so a non-identifier key is re-parsed as source. Rename it (for example "bad_key"), or build the record with aether_eval using quoted keys.`)
        }
        pending.push({ value: entry, path: childPath(item.path, `.${key}`) })
      }
    }
  }
}

/** Longest argument path a diagnostic names, so a deeply nested value cannot grow the message without bound. */
const MAX_PATH_CHARS = 200

/** Extend one diagnostic path, eliding it at the cap instead of growing with nesting depth. */
function childPath(parent: string, suffix: string): string {
  const next = `${parent}${suffix}`
  return next.length > MAX_PATH_CHARS ? `${parent}…` : next
}

/**
 * Bound one encoded request or eval source before it reaches a process.
 * @param payload - the request JSON or eval source about to be sent.
 * @param resolved - the resolved deployment configuration supplying the budget.
 * @throws Error naming the actual and permitted sizes.
 */
export function assertRequestBytes(payload: string, resolved: ResolvedConfig): void {
  const bytes = Buffer.byteLength(payload, 'utf8')
  if (bytes > resolved.maxRequestBytes) {
    throw new Error(`aether-shell [E_INPUT_SIZE]: the request is ${bytes} bytes, over the maxRequestBytes budget of ${resolved.maxRequestBytes}; send smaller data or raise that deployment budget.`)
  }
}

/**
 * Bound one eval source for the argv channel it travels on.
 * @param code - the model-supplied program text.
 * @param resolved - the resolved deployment configuration supplying the byte budget.
 * @throws Error naming the actual and permitted sizes.
 */
export function assertEvalCode(code: string, resolved: ResolvedConfig): void {
  if (code.trim().length === 0) {
    throw new Error('aether-shell [E_INPUT_CODE]: code must be a non-empty program')
  }
  assertRequestBytes(code, resolved)
  if (code.length > MAX_ARGV_CHARS) {
    throw new Error(`aether-shell [E_INPUT_SIZE]: code is ${code.length} characters; a program passed as one argv element must stay within ${MAX_ARGV_CHARS} characters.`)
  }
}

/**
 * Build one native `call` request.
 * @param builtin - the flat native builtin name.
 * @param args - positional arguments, or undefined for a call with none.
 * @param mode - the deployment's argument channel; omitting it applies the converting channel's checks.
 * @returns the request body, with absent arguments omitted rather than sent as null.
 * @throws Error when the name or any argument value is unusable as data.
 */
export function callRequest(builtin: string, args: readonly JsonValue[] | undefined, mode: StructuredDataMode = 'legacy'): AetherRequest {
  assertFlatBuiltin(builtin, 'builtin')
  args?.forEach((arg, index) => { assertSafeData(arg, `args[${index}]`, mode) })
  return { action: 'call', builtin, ...args === undefined ? {} : { args } }
}

/**
 * Build one native `pipeline` request.
 *
 * An explicit null seed is refused on the converting channel, where it arrives
 * as "no seed" and the pipeline silently starts from its first step instead of
 * receiving None. On the typed channel the seed is carried as data, and
 * `explicit_null_pipeline_input_v1` is the capability that makes it arrive as
 * None, so the seed is sent as written.
 * @param steps - the ordered steps; at least one is required.
 * @param input - the starting value, or undefined to start from the first call.
 * @param resolved - the resolved deployment configuration supplying the expression budget.
 * @param mode - the deployment's argument channel; omitting it applies the converting channel's checks.
 * @returns the request body, with absent fields omitted rather than sent as null.
 * @throws Error when a step name, argument, `select` path, or `predicate` fragment is unusable, or when the converting channel is given an explicit null seed.
 */
export function pipelineRequest(
  steps: readonly AetherPipelineStep[],
  input: JsonValue | undefined,
  resolved: ResolvedConfig,
  mode: StructuredDataMode = 'legacy',
): AetherRequest {
  if (steps.length === 0) {
    throw new Error('aether-shell [E_INPUT_STEPS]: steps must contain at least one step; the interpreter rejects an empty pipeline')
  }
  if (input === null && mode === 'legacy') {
    throw new Error('aether-shell [E_INPUT_PIPELINE_NULL]: input is null, which the native request reads as "no input" rather than the None value; seed None with aether_eval instead, for example `None | <first step>`. A null nested inside args or inside a record value is unaffected.')
  }
  const checked = steps.map((step, index) => {
    assertFlatBuiltin(step.builtin, `steps[${index}].builtin`)
    step.args?.forEach((arg, argIndex) => { assertSafeData(arg, `steps[${index}].args[${argIndex}]`, mode) })
    if (step.select !== undefined) assertSelectPath(step.select, `steps[${index}].select`, mode)
    if (step.predicate !== undefined) assertPredicate(step.predicate, `steps[${index}].predicate`, resolved)
    return {
      builtin: step.builtin,
      ...step.args === undefined ? {} : { args: step.args },
      ...step.select === undefined ? {} : { select: step.select },
      ...step.predicate === undefined ? {} : { predicate: step.predicate },
    }
  })
  if (input !== undefined) assertSafeData(input, 'input', mode)
  return { action: 'pipeline', steps: checked, ...input === undefined ? {} : { input } }
}

/**
 * Build the `call` request that reads the ontology manifest.
 * @returns the request body listing every category with its builtin count and effects.
 */
export function ontologyManifestRequest(): AetherRequest {
  return { action: 'call', builtin: 'ontology_manifest', args: [] }
}

/**
 * Build the `call` request that describes one ontology category or builtin.
 * @param query - the category or builtin name to describe.
 * @param mode - the deployment's argument channel; omitting it applies the converting channel's checks.
 * @returns the request body.
 * @throws Error when the query contains a sequence the converting channel would re-parse as code.
 */
export function ontologyDescribeRequest(query: string, mode: StructuredDataMode = 'legacy'): AetherRequest {
  assertSafeData(query, 'query', mode)
  return { action: 'call', builtin: 'ontology_describe', args: [query] }
}

/**
 * Build the `capabilities` request this plugin sends to an interpreter before it
 * trusts that interpreter's typed argument channel.
 * @returns the request body, which carries no data because it asks only what the interpreter implements.
 */
export function capabilitiesRequest(): AetherRequest {
  return { action: 'capabilities' }
}

/**
 * Encode a request body for the child's stdin.
 *
 * The validation walk is iterative, but the encoder itself is not: a value
 * nested deeply enough to exhaust the encoder's stack is reported as an
 * argument failure rather than escaping as a bare engine error.
 * @param request - the request body.
 * @returns the JSON document to write, which is exactly one document so a polluted stream is detectable.
 * @throws Error when the value nests too deeply to encode.
 */
export function encodeRequest(request: AetherRequest): string {
  try {
    return JSON.stringify(request)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`aether-shell [E_INPUT_DEPTH]: the request could not be encoded as one JSON document (${detail}); reduce how deeply the value nests.`)
  }
}

/**
 * The interpreter argv tail that evaluates one program, after the executable
 * and fixture argv. `--deterministic` is what makes stdout the canonical JSON
 * value: without it the interpreter prints its own source form.
 * @param code - the program text.
 * @returns the argv tail.
 */
export function evalArgv(code: string): string[] {
  return ['--deterministic', '-c', code]
}
