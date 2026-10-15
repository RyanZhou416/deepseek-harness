/**
 * Decoding of native interpreter output into the canonical outcome vocabulary.
 *
 * Two native protocols reach this module. The Agent API writes one JSON
 * envelope to stdout for every request, including requests it reports as
 * failed, and exits 0 either way; the command line writes the bare canonical
 * value to stdout and reports failures as text on stderr with a non-zero exit.
 * Both are decoded here so the tools share one outcome type, and neither path
 * treats a non-zero process exit as success.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/protocol
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  AetherDiagnostics,
  AetherFailure,
  AetherOutcome,
  AetherProcessFacts,
  AetherSandboxFacts,
} from './outcome.ts'
import { isJsonObject, jsonKindOf, numberFidelityProblem, recovery, stripRequestEcho } from './outcome.ts'

/** How many stdout characters a protocol failure quotes back. */
const EXCERPT_CHARS = 200

/** Upper bound on one failure message kept from interpreter text. */
const MAX_FAILURE_CHARS = 8_192

/** One decoded Agent API response envelope. */
export interface AetherNativeEnvelope {
  /** The interpreter's own success flag; independent of the process exit code. */
  success: boolean
  /** The interpreter's result, present when it reported success. */
  result?: JsonValue
  /** The interpreter's `result_type` name for `result`. */
  resultType?: string
  /** The interpreter's failure text, present when it reported failure. */
  error?: string
  /** Interpreter metadata with request-echoing keys removed. */
  metadata?: JsonValue
}

/** The interpreter's stdout was not exactly one native response document. */
export class AetherProtocolError extends Error {
  /**
   * @param message - what was wrong with the stream, including a bounded excerpt.
   */
  constructor(message: string) {
    super(message)
    this.name = 'AetherProtocolError'
  }
}

/** Name the JSON kind of a decoded stream value for a diagnostic. */
function describeJsonKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/** One bounded, single-line excerpt of a stream for a failure message. */
function excerpt(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ')
  return JSON.stringify(oneLine.length > EXCERPT_CHARS ? `${oneLine.slice(0, EXCERPT_CHARS)}…` : oneLine)
}

/** Bound one kept failure message, marking the cut explicitly. */
function boundedMessage(text: string): string {
  return text.length > MAX_FAILURE_CHARS ? `${text.slice(0, MAX_FAILURE_CHARS)}…` : text
}

/**
 * Reject a native number this runtime cannot carry exactly.
 *
 * The interpreter's integers are 64-bit; this runtime stores every number as an
 * IEEE-754 double, so a large integer would be returned rounded. Refusing it
 * keeps the model from acting on a silently altered value; the value must be
 * read as text instead. The walk is iterative because a native result can nest
 * thousands deep. Only the interpreter's own result is inspected, never a
 * successful value's contents as a failure signal.
 * @param value - a decoded native value.
 * @param spillPath - the spill file holding the response, when one exists.
 * @throws AetherProtocolError when any number would be altered by the trip.
 */
function assertNativeNumbers(value: JsonValue, spillPath: string | undefined): void {
  const pending: JsonValue[] = [value]
  while (true) {
    const current = pending.pop()
    if (current === undefined) return
    if (typeof current === 'number') {
      const problem = numberFidelityProblem(current)
      if (problem !== undefined) {
        throw new AetherProtocolError(`aether-shell [E_PROTOCOL_NUMBER]: the interpreter returned ${problem}; ask for it as text instead of accepting a rounded value${recovery(spillPath)}`)
      }
      continue
    }
    if (Array.isArray(current)) {
      current.forEach(entry => pending.push(entry))
      continue
    }
    if (isJsonObject(current)) {
      for (const entry of Object.values(current)) pending.push(entry)
    }
  }
}

/**
 * Decode the one Agent API envelope a request produced.
 * @param stdout - the interpreter's complete stdout.
 * @param spillPath - the spill file holding that stream, when the provider created one.
 * @returns the decoded envelope.
 * @throws AetherProtocolError when stdout is not exactly one envelope document.
 */
export function decodeEnvelope(stdout: string, spillPath?: string): AetherNativeEnvelope {
  const text = stdout.trim()
  if (text.length === 0) {
    throw new AetherProtocolError(`aether-shell [E_PROTOCOL_OUTPUT]: the interpreter wrote no response to stdout${recovery(spillPath)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A builtin that prints writes ahead of the envelope, so a stream that is
    // not exactly one document is a protocol failure, never a reply.
    throw new AetherProtocolError(`aether-shell [E_PROTOCOL_OUTPUT]: stdout was not one JSON response document, so the reply cannot be read. First ${EXCERPT_CHARS} characters: ${excerpt(text)}${recovery(spillPath)}`)
  }
  if (!isJsonObject(parsed)) {
    throw new AetherProtocolError(`aether-shell [E_PROTOCOL_OUTPUT]: the response was ${describeJsonKind(parsed)}, not an envelope object${recovery(spillPath)}`)
  }
  const success = parsed.success
  if (typeof success !== 'boolean') {
    throw new AetherProtocolError(`aether-shell [E_PROTOCOL_OUTPUT]: the response envelope has no boolean "success" field${recovery(spillPath)}`)
  }
  const resultType = parsed.result_type
  if (resultType !== undefined && typeof resultType !== 'string') {
    throw new AetherProtocolError(`aether-shell [E_PROTOCOL_OUTPUT]: "result_type" is ${describeJsonKind(resultType)}, not a string${recovery(spillPath)}`)
  }
  const error = parsed.error
  if (error !== undefined && typeof error !== 'string') {
    throw new AetherProtocolError(`aether-shell [E_PROTOCOL_OUTPUT]: "error" is ${describeJsonKind(error)}, not a string${recovery(spillPath)}`)
  }
  const metadata = stripRequestEcho(parsed.metadata)
  if (parsed.result !== undefined) assertNativeNumbers(parsed.result, spillPath)
  if (metadata !== undefined) assertNativeNumbers(metadata, spillPath)
  return {
    success,
    ...parsed.result !== undefined ? { result: parsed.result } : {},
    ...resultType !== undefined ? { resultType } : {},
    ...error !== undefined ? { error } : {},
    ...metadata !== undefined ? { metadata } : {},
  }
}

/**
 * Decode the interpreter's structured failure text.
 *
 * The Agent API wraps a failure as `{"error":{…}}`; text that does not carry
 * that form is the whole message.
 * @param error - the interpreter's failure text.
 * @returns the failure, with the code, builtin, suggested names, hint, and retry advice split out when present.
 */
export function decodeFailure(error: string): AetherFailure {
  let parsed: unknown
  try {
    parsed = JSON.parse(error)
  } catch {
    // Not every native failure carries the structured JSON form; the text is the whole failure.
    return { message: boundedMessage(error) }
  }
  if (!isJsonObject(parsed)) return { message: boundedMessage(error) }
  const inner = parsed.error
  if (!isJsonObject(inner)) return { message: boundedMessage(error) }
  const message = inner.message
  if (typeof message !== 'string') return { message: boundedMessage(error) }
  const suggested = inner.did_you_mean
  const didYouMean = Array.isArray(suggested)
    ? suggested.filter((name): name is string => typeof name === 'string').map(name => boundedMessage(name))
    : undefined
  return {
    message: boundedMessage(message),
    ...typeof inner.code === 'string' ? { code: inner.code } : {},
    ...typeof inner.builtin === 'string' ? { builtin: inner.builtin } : {},
    ...didYouMean === undefined || didYouMean.length === 0 ? {} : { didYouMean },
    ...typeof inner.hint === 'string' ? { hint: boundedMessage(inner.hint) } : {},
    ...typeof inner.retryable === 'boolean' ? { retryable: inner.retryable } : {},
  }
}

/**
 * Project one decoded envelope onto the canonical outcome, keeping the process
 * facts separate from what the interpreter reported.
 *
 * A non-zero exit outranks a success envelope: an interpreter that failed after
 * writing a reply produced a reply this plugin does not trust, so the process
 * fact is reported instead of a value.
 * @param envelope - the decoded envelope.
 * @param process - exit facts of the interpreter process.
 * @param stderr - the interpreter's collected diagnostic stream.
 * @param sandbox - the file-effect decision this call ran under.
 * @returns the canonical outcome.
 */
export function toOutcome(
  envelope: AetherNativeEnvelope,
  process: AetherProcessFacts,
  stderr: AetherDiagnostics,
  sandbox: AetherSandboxFacts,
): AetherOutcome {
  const shared = { sandbox, process, stderr }
  if (envelope.success) {
    if (process.exitCode !== null && process.exitCode !== 0) {
      return {
        kind: 'error',
        error: {
          code: 'E_PROCESS_EXIT',
          message: `the interpreter reported success and then exited with code ${process.exitCode}, so its response is not trustworthy`,
          retryable: false,
        },
        ...shared,
      }
    }
    return {
      kind: 'value',
      value: envelope.result ?? null,
      ...envelope.resultType === undefined ? {} : { resultType: envelope.resultType },
      ...envelope.metadata === undefined ? {} : { metadata: envelope.metadata },
      ...shared,
    }
  }
  return {
    kind: 'error',
    error: decodeFailure(envelope.error ?? 'the interpreter reported an unsuccessful request without an error message'),
    ...envelope.resultType === undefined ? {} : { resultType: envelope.resultType },
    ...envelope.metadata === undefined ? {} : { metadata: envelope.metadata },
    ...shared,
  }
}

/**
 * Decode one command-line evaluation.
 *
 * The exit code is the success fact: a non-zero exit means the interpreter
 * reported the program failed, and stdout carries no value. A successful run
 * that printed nothing reports `null` with `resultType: 'none'`, which is how
 * the interpreter distinguishes "no result" from a printed null.
 * @param process - exit facts of the interpreter process.
 * @param stdout - the interpreter's collected standard output.
 * @param stderr - the interpreter's collected diagnostic stream.
 * @param sandbox - the file-effect decision this call ran under.
 * @returns the canonical outcome.
 * @throws AetherProtocolError when a successful exit wrote something other than one JSON value, or produced a number this runtime cannot carry exactly.
 */
export function decodeEvalOutcome(
  process: AetherProcessFacts,
  stdout: AetherDiagnostics,
  stderr: AetherDiagnostics,
  sandbox: AetherSandboxFacts,
): AetherOutcome {
  if (process.exitCode !== 0) {
    return { kind: 'error', error: decodeInterpreterFailure(stderr.text, process), sandbox, process, stderr }
  }
  const text = stdout.text.trim()
  if (text.length === 0) {
    return { kind: 'value', value: null, resultType: 'none', sandbox, process, stderr }
  }
  let value: JsonValue
  try {
    value = JSON.parse(text)
  } catch {
    throw new AetherProtocolError(`aether-shell [E_PROTOCOL_OUTPUT]: the interpreter exited successfully but stdout was not one JSON value. First ${EXCERPT_CHARS} characters: ${excerpt(text)}${recovery(stdout.spillPath)}`)
  }
  assertNativeNumbers(value, stdout.spillPath)
  return { kind: 'value', value, resultType: jsonKindOf(value), sandbox, process, stderr }
}

/**
 * Decode the interpreter's command-line failure text, falling back to the
 * process facts when it wrote none.
 * @param stderrText - the interpreter's collected diagnostic text.
 * @param process - exit facts of the interpreter process.
 * @returns the failure to report.
 */
function decodeInterpreterFailure(stderrText: string, process: AetherProcessFacts): AetherFailure {
  const text = stderrText.trim()
  if (text.length === 0) {
    return {
      message: process.exitCode === null
        ? `the interpreter was terminated by ${process.signal ?? 'a signal'} without reporting a failure`
        : `the interpreter exited with code ${process.exitCode} without reporting a failure`,
    }
  }
  const lines = text.split(/\r?\n/)
  const head = /^error(?:\[(?<code>[^\]]+)\])?:\s*(?<message>.*)$/.exec(lines[0] ?? '')
  const hintIndex = lines.findIndex(line => /^\s*hint:\s*\S/.test(line))
  const messageLines = hintIndex === -1 ? lines : lines.slice(0, hintIndex)
  const message = head === null
    ? messageLines.join('\n').trim()
    : [head.groups?.message ?? '', ...messageLines.slice(1)].join('\n').trim()
  const hint = hintIndex === -1
    ? undefined
    : lines.slice(hintIndex).join('\n').replace(/^\s*hint:\s*/, '').trim()
  const code = head?.groups?.code
  return {
    message: boundedMessage(message.length > 0 ? message : text),
    ...code !== undefined ? { code } : {},
    ...hint !== undefined && hint.length > 0 ? { hint: boundedMessage(hint) } : {},
  }
}
