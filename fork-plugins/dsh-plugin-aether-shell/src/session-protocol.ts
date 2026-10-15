/**
 * Native session protocol for the optional AetherShell plugin.
 *
 * The persistent-session builtins — `sess_open`, `sess_eval`, `sess_close`,
 * `sess_usage` — exist in the running interpreter (12.0.2) but not in its
 * ontology, so nothing here is reachable through `aether_discover` and no tool
 * schema advertises them. They live in one long-lived `ae agent interactive`
 * process, which reads exactly one JSON request line at a time and answers with
 * a pretty-printed, multi-line JSON document preceded by a three-line banner.
 * That is not NDJSON, so {@link AetherSessionDecoder} owns the framing: it
 * scans the stdout byte stream for complete JSON documents instead of treating
 * a line as one.
 *
 * Two encodings protect the request channel. The outer request travels as JSON
 * and the interpreter converts that JSON back into AetherShell source, so every
 * string this module embeds into a generated program is first written as an
 * AetherShell string literal by {@link encodeAetherStringLiteral}. That literal
 * escapes the backslash, the double quote, and the three common control
 * characters, and rewrites each `$` as the interpolation `${'$'}` so a caller's
 * `${` cannot be re-parsed as code by the *outer* wrapper while the caller's
 * own interpolation inside the evaluated program keeps its meaning. The dollar
 * rewrite is an interpolation that evaluates to one constant `$`; the
 * single-quoted spelling is used because the interpreter rejects an unescaped
 * quote of either kind inside that interpolation. Every request also carries a
 * host-random nonce inside a `try`/`catch` record, so a response is correlated
 * by that nonce rather than by arrival order: stdout is shared with the
 * evaluated program's own `print` and any child it starts, and unrelated JSON
 * is collected as bounded diagnostics.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/session-protocol
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { AetherFailure } from './outcome.ts'
import { isJsonObject, numberFidelityProblem, recovery } from './outcome.ts'
import { AetherProtocolError, decodeFailure } from './protocol.ts'

/**
 * Opaque handle identity for one plugin-owned session.
 *
 * A native session id is process-local and reveals the interpreter's own
 * process and sequence numbers, so it is never handed to the model; callers
 * see only a host-generated opaque value carrying this brand.
 */
export type AetherSessionId = Branded<'AetherSessionId'>

/**
 * Brand one host-generated session identity.
 * @param value - the opaque value minted for a new handle.
 * @returns the same string with the session-id brand.
 */
export function aetherSessionId(value: string): AetherSessionId {
  return brandString<AetherSessionId>(value)
}

/** Longest failure message this module keeps from a captured interpreter value. */
const MAX_FAILURE_CHARS = 8_192

/**
 * Write one string as an AetherShell string literal, including its quotes.
 *
 * This literal is embedded in generated program text, so it must survive both
 * the JSON-to-source conversion and the interpreter's own lexer. The
 * interpreter recognizes exactly `\\`, `\"`, `\n`, `\r`, and `\t` inside a
 * double-quoted literal and drops the backslash of any other escape, so a
 * literal backslash is doubled here and every other character travels
 * unchanged. A `$` is rewritten as the interpolation `${'$'}`: emitting a bare
 * `$` would let a following `{` start an interpolation in the *outer* wrapper,
 * while the single-quoted form decodes to exactly one `$` and leaves the
 * caller's own program text unchanged. Iteration is by code point, so a
 * surrogate pair reaches the literal whole.
 * @param text - the exact text the generated program must receive.
 * @returns the quoted AetherShell literal for that text.
 */
export function encodeAetherStringLiteral(text: string): string {
  let literal = '"'
  for (const character of text) {
    switch (character) {
      case '\\': literal += '\\\\'; break
      case '"': literal += '\\"'; break
      case '\n': literal += '\\n'; break
      case '\r': literal += '\\r'; break
      case '\t': literal += '\\t'; break
      case '$': literal += "${'$'}"; break
      default: literal += character; break
    }
  }
  return `${literal}"`
}

/** The generated call that opens a native session. */
export function sessionOpenCall(): string {
  return 'sess_open()'
}

/**
 * The generated call that evaluates one program inside a native session.
 * @param nativeId - the interpreter's own session id, never the opaque handle.
 * @param code - the exact program text the caller supplied.
 * @returns the generated AetherShell call.
 */
export function sessionEvalCall(nativeId: string, code: string): string {
  return `sess_eval(${encodeAetherStringLiteral(nativeId)},${encodeAetherStringLiteral(code)})`
}

/**
 * The generated call that reads one native session's counters.
 * @param nativeId - the interpreter's own session id.
 * @returns the generated AetherShell call.
 */
export function sessionUsageCall(nativeId: string): string {
  return `sess_usage(${encodeAetherStringLiteral(nativeId)})`
}

/**
 * The generated call that closes one native session.
 * @param nativeId - the interpreter's own session id.
 * @returns the generated AetherShell call.
 */
export function sessionCloseCall(nativeId: string): string {
  return `sess_close(${encodeAetherStringLiteral(nativeId)})`
}

/**
 * Wrap one generated call so its outcome is correlated by nonce.
 *
 * The wrapper catches every error the interpreter raises while evaluating the
 * call and returns it as data, so the response is a successful envelope whose
 * inner record says whether the call itself succeeded. The interpreter's own
 * failure record for a nested call is what the caller asked for, not a
 * transport failure; only the interpreter failing to evaluate this wrapper at
 * all is a desynchronization.
 * @param nonce - the host-random correlation token for this request.
 * @param call - the generated AetherShell call to evaluate.
 * @returns the program text to send as one `eval` request.
 */
export function sessionNonceWrapper(nonce: string, call: string): string {
  const token = encodeAetherStringLiteral(nonce)
  return `try { {nonce:${token},ok:true,value:${call}} } catch e { {nonce:${token},ok:false,error:e} }`
}

/** What one complete stdout JSON document turned out to be. */
export type AetherSessionReply =
  | { readonly kind: 'reply'; readonly ok: true; readonly value: JsonValue }
  | { readonly kind: 'reply'; readonly ok: false; readonly error: AetherFailure }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'desync'; readonly detail: string }

/** Bound one kept failure message, marking the cut explicitly. */
function boundedMessage(text: string): string {
  return text.length > MAX_FAILURE_CHARS ? `${text.slice(0, MAX_FAILURE_CHARS)}…` : text
}

/**
 * Read the error the wrapper captured into a session failure.
 *
 * A native failure inside the evaluated call arrives as a record of the form
 * `{"error":{…}}`, which is exactly the document {@link decodeFailure} already
 * understands, so the structured code, builtin, hint, and retry advice survive.
 * A plain interpreter error is captured as a string, and anything else is
 * rendered as JSON text so the caller still sees what happened.
 * @param captured - the wrapper's `error` field, when the call failed.
 * @returns the failure to report for the evaluated call.
 */
function decodeCapturedError(captured: JsonValue | undefined): AetherFailure {
  if (captured === undefined) return { message: 'the session call failed without an error value' }
  if (typeof captured === 'string') return { message: boundedMessage(captured) }
  if (isJsonObject(captured) && isJsonObject(captured.error)) {
    return decodeFailure(JSON.stringify(captured))
  }
  return { message: boundedMessage(JSON.stringify(captured)) }
}

/**
 * Classify one complete stdout document against the request awaiting an answer.
 *
 * Only a document whose `result.nonce` equals the outstanding token is accepted
 * as that request's reply; everything else is foreign output the evaluated
 * program or a child wrote to the shared stdout, including a JSON object that
 * merely happens to carry `success: false`. A native-level failure is therefore
 * recognized only by positive evidence that the document answers this exact
 * request: the interpreter echoes the generated program as
 * `metadata.code_attempted` on the failure it produces when it cannot evaluate
 * that program at all. Treating every `success: false` document as fatal would
 * let a program that prints such an object destroy its own session, so an
 * unproven document stays foreign and the caller keeps it as a diagnostic.
 * @param document - one complete JSON document read from the interpreter's stdout.
 * @param expectedNonce - the token of the request awaiting an answer.
 * @param expectedCode - the exact generated program text sent for that request.
 * @returns the correlated reply, a foreign-output marker, or a desynchronization.
 */
export function classifySessionReply(document: JsonValue, expectedNonce: string, expectedCode: string): AetherSessionReply {
  if (!isJsonObject(document)) return { kind: 'foreign' }
  const result = document.result
  if (isJsonObject(result) && result.nonce === expectedNonce) {
    if (result.ok === true) return { kind: 'reply', ok: true, value: result.value ?? null }
    if (result.ok === false) return { kind: 'reply', ok: false, error: decodeCapturedError(result.error) }
    return { kind: 'desync', detail: 'the correlated response record carried no boolean "ok" field' }
  }
  const metadata = document.metadata
  if (document.success === false && isJsonObject(metadata) && metadata.code_attempted === expectedCode) {
    const detail = typeof document.error === 'string' ? boundedMessage(document.error) : 'the interpreter reported an unsuccessful request'
    return { kind: 'desync', detail }
  }
  return { kind: 'foreign' }
}

/**
 * Reject a native value this runtime cannot carry exactly.
 *
 * The interpreter's integers are 64-bit and this runtime stores every number as
 * an IEEE-754 double, so a value that would silently change on the way back is
 * refused instead of returned. The walk is iterative because a native value can
 * nest far deeper than the stack tolerates.
 * @param value - one decoded value from a session response.
 * @param spillPath - the spill file holding the interpreter's diagnostic stream, when one exists.
 * @throws AetherProtocolError when any number would be altered by the trip.
 */
export function assertSessionValueFidelity(value: JsonValue, spillPath: string | undefined): void {
  const pending: JsonValue[] = [value]
  while (true) {
    const current = pending.pop()
    if (current === undefined) return
    if (typeof current === 'number') {
      const problem = numberFidelityProblem(current)
      if (problem !== undefined) {
        throw new AetherProtocolError(`aether-shell [E_PROTOCOL_NUMBER]: the session returned ${problem}; ask for it as text instead of accepting a rounded value${recovery(spillPath)}`)
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

/** Bounds one decoder's buffers: the largest single document and the retained diagnostic tail. */
export interface AetherSessionDecoderLimits {
  /** Largest single UTF-8 JSON document accepted from stdout, in bytes. */
  readonly maxFrameBytes: number
  /** Largest diagnostic tail retained for the model, in UTF-8 bytes. */
  readonly maxDiagnosticBytes: number
}

/** The result of scanning one candidate JSON value out of a stream buffer. */
type AetherScanResult =
  | { readonly kind: 'complete'; readonly end: number }
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'not-json' }

/** How the text at one index relates to the header every native envelope opens with. */
type AetherHeaderMatch = 'header' | 'partial' | 'none'

/**
 * The first key of every response this plugin reads.
 *
 * Requiring it is what makes the scanner able to resynchronize. stdout is
 * shared with the evaluated program and any child it starts, so a bare brace, a
 * bracket, or a quoted string can appear at any point; only a document that
 * opens the interpreter's own envelope shape is treated as a candidate, and
 * everything else stays diagnostic text instead of swallowing the reply that
 * follows it.
 */
const ENVELOPE_HEADER = '"success"'

/** Whether one character is JSON whitespace, which may separate `{` from the header. */
function isJsonSpace(character: string | undefined): boolean {
  return character === ' ' || character === '\n' || character === '\r' || character === '\t'
}

/**
 * Keep the longest trailing part of one string that fits a UTF-8 byte budget.
 *
 * Whole code points are kept, so a cut never splits a surrogate pair. The scan
 * runs only when a buffer is already over budget.
 */
function tailWithinBytes(text: string, maxBytes: number): string {
  const points = [...text]
  let bytes = 0
  let kept = 0
  for (let index = points.length - 1; index >= 0; index--) {
    const size = Buffer.byteLength(points[index] ?? '', 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    kept++
  }
  return points.slice(points.length - kept).join('')
}

/** One read of the retained diagnostic tail. */
export interface AetherSessionDiagnosticRead {
  /** The diagnostic text read since the previous read. */
  readonly text: string
  /** True when the budget dropped earlier bytes, making `text` a tail rather than the whole run. */
  readonly truncated: boolean
}

/**
 * Incremental framing of the interpreter's stdout stream.
 *
 * The stream is not line-delimited: the banner precedes the first document, a
 * document spans many lines, and the evaluated program's own `print` and any
 * child it starts write to the same descriptor. This decoder therefore scans
 * for complete JSON documents, retains everything else as bounded diagnostics,
 * and reports a terminal failure rather than waiting forever when a candidate
 * document never completes inside its budget.
 *
 * Both budgets are measured in UTF-8 bytes, matching the byte budget the
 * deployment configures for a collected stream: a character count would let a
 * document of multi-byte characters exceed the configured byte budget by up to
 * four times.
 */
export class AetherSessionDecoder {
  private buffer = ''
  private bufferBytes = 0
  /** Index of a header the buffer currently ends inside, kept for the partial case. */
  private partialHeaderStart = 0
  private diagnostics = ''
  private diagnosticBytes = 0
  private readonly documents: JsonValue[] = []
  private trimmed = false
  private failureDetail: string | undefined

  /**
   * @param limits - the deployment's document and diagnostic bounds, in UTF-8 bytes.
   */
  constructor(private readonly limits: AetherSessionDecoderLimits) {}

  /** The terminal framing failure, set once the stream can no longer be read as documents. */
  get failure(): string | undefined {
    return this.failureDetail
  }

  /**
   * Feed one chunk of stdout.
   * @param chunk - decoded text from the interpreter's stdout stream.
   */
  push(chunk: string): void {
    if (this.failureDetail !== undefined) return
    this.buffer += chunk
    this.bufferBytes += Buffer.byteLength(chunk, 'utf8')
    this.consume()
  }

  /**
   * Take every complete document read since the previous call.
   * @returns the documents in arrival order.
   */
  takeDocuments(): JsonValue[] {
    return this.documents.splice(0, this.documents.length)
  }

  /**
   * Take everything that was not a correlated protocol document, plus foreign
   * JSON the caller did not correlate, as one bounded diagnostic tail.
   * @returns the retained diagnostic text and whether an earlier part was dropped.
   */
  takeDiagnostics(): AetherSessionDiagnosticRead {
    const read = { text: this.diagnostics, truncated: this.trimmed }
    this.diagnostics = ''
    this.diagnosticBytes = 0
    this.trimmed = false
    return read
  }

  /**
   * Retain text the caller classified as unrelated output — a foreign stdout
   * document, for example — in the same bounded diagnostic tail.
   * @param text - the text to append to the retained tail.
   */
  note(text: string): void {
    this.retain(text)
  }

  /** Remove `count` leading characters from the stream buffer, keeping its byte count exact. */
  private takeBuffer(count: number): string {
    const taken = this.buffer.slice(0, count)
    this.buffer = this.buffer.slice(count)
    this.bufferBytes -= Buffer.byteLength(taken, 'utf8')
    return taken
  }

  /** Retain text as diagnostics, keeping only the configured byte tail. */
  private retain(text: string): void {
    if (text.length === 0) return
    this.diagnostics += text
    this.diagnosticBytes += Buffer.byteLength(text, 'utf8')
    if (this.diagnosticBytes <= this.limits.maxDiagnosticBytes) return
    this.diagnostics = tailWithinBytes(this.diagnostics, this.limits.maxDiagnosticBytes)
    this.diagnosticBytes = Buffer.byteLength(this.diagnostics, 'utf8')
    this.trimmed = true
  }

  /** Consume as many complete documents as the buffer currently holds. */
  private consume(): void {
    while (this.failureDetail === undefined) {
      const found = this.nextHeader()
      if (found === 'partial') {
        // A header split across chunks: keep it, and demote everything before
        // it, which is this program's own output.
        this.retain(this.takeBuffer(this.partialHeaderStart))
        return
      }
      if (found === -1) {
        // Nothing here can become a document, so none of it is one.
        this.retain(this.buffer)
        this.buffer = ''
        this.bufferBytes = 0
        return
      }
      this.retain(this.takeBuffer(found))
      const scanned = this.scanValue(0)
      if (scanned.kind === 'incomplete') {
        if (this.bufferBytes > this.limits.maxFrameBytes) {
          this.failureDetail = `a JSON document on the interpreter's stdout exceeded the ${this.limits.maxFrameBytes}-byte session budget without completing`
        }
        return
      }
      if (scanned.kind === 'not-json') {
        // A header that cannot close as JSON was printed, not written by the
        // interpreter; drop one character so the scan resumes after it.
        this.retain(this.takeBuffer(1))
        continue
      }
      // The budget covers the complete document, not only a document still
      // arriving, so an oversized frame is refused before it is parsed.
      const frameBytes = Buffer.byteLength(this.buffer.slice(0, scanned.end), 'utf8')
      if (frameBytes > this.limits.maxFrameBytes) {
        this.failureDetail = `a JSON document on the interpreter's stdout is ${frameBytes} bytes, over the ${this.limits.maxFrameBytes}-byte session budget`
        return
      }
      const candidate = this.takeBuffer(scanned.end)
      const parsed = this.parse(candidate)
      // Only an object can be an envelope; any other complete JSON value on
      // this stream was printed by the program.
      if (parsed === undefined || !isJsonObject(parsed)) {
        this.retain(candidate)
        continue
      }
      this.documents.push(parsed)
    }
  }

  /**
   * Find the next native envelope header in the buffer.
   * @returns its index, `'partial'` when the buffer ends inside one, or -1 when it holds none.
   */
  private nextHeader(): number | 'partial' | -1 {
    let index = 0
    for (;;) {
      const at = this.buffer.indexOf('{', index)
      if (at === -1) return -1
      const match = this.headerAt(at)
      if (match === 'header') return at
      if (match === 'partial') {
        this.partialHeaderStart = at
        return 'partial'
      }
      index = at + 1
    }
  }

  /**
   * Classify what the text at one index opens.
   *
   * A candidate is `{`, optional whitespace, then the interpreter's own first
   * key. Native pretty output separates the brace from that key with a newline,
   * and a chunk may end anywhere inside the header, which is why a prefix of it
   * is reported rather than rejected.
   */
  private headerAt(from: number): AetherHeaderMatch {
    if (this.buffer[from] !== '{') return 'none'
    let index = from + 1
    while (index < this.buffer.length && isJsonSpace(this.buffer[index])) index++
    if (index >= this.buffer.length) return 'partial'
    const rest = this.buffer.slice(index, index + ENVELOPE_HEADER.length)
    if (!ENVELOPE_HEADER.startsWith(rest)) return 'none'
    return rest.length === ENVELOPE_HEADER.length ? 'header' : 'partial'
  }

  /**
   * Measure the JSON object starting at `from`.
   *
   * Container nesting and string state are tracked together so a brace inside a
   * string never changes depth. An object that has not closed yet is
   * `incomplete`, not malformed: the decoder waits for more bytes and enforces
   * its own bound in {@link consume}.
   */
  private scanValue(from: number): AetherScanResult {
    if (this.buffer[from] !== '{') return { kind: 'not-json' }
    const closers: string[] = []
    let inString = false
    let escaped = false
    for (let index = from; index < this.buffer.length; index++) {
      const character = this.buffer[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') { inString = true; continue }
      if (character === '{') { closers.push('}'); continue }
      if (character === '[') { closers.push(']'); continue }
      if (character === '}' || character === ']') {
        if (closers.pop() !== character) return { kind: 'not-json' }
        if (closers.length === 0) return { kind: 'complete', end: index + 1 }
      }
    }
    return { kind: 'incomplete' }
  }

  /** Parse one measured candidate, reporting failure instead of throwing. */
  private parse(candidate: string): JsonValue | undefined {
    try {
      return JSON.parse(candidate) as JsonValue
    } catch {
      // A measured candidate that does not parse is not a protocol document;
      // the caller keeps it as diagnostic text.
      return undefined
    }
  }
}
