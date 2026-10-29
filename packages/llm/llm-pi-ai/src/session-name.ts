/**
 * The encoded session display name a session-aware pool endpoint receives.
 *
 * A conversation-aware endpoint shows the requests of one conversation under
 * the session's name, so the name travels as one header beside the session
 * identity header. That header is a local hop between the harness and the
 * pool: the pool decodes it for display and never forwards it to a provider.
 * RFC 3986 percent-encoding over UTF-8 keeps the field ASCII, so a name in any
 * language travels unchanged; only the unreserved characters stay literal.
 *
 * A name is a display hint, never an identity: an empty, absent, or oversized
 * name is not sent, and the request then carries no name header instead of
 * failing over a label. The pool refuses a decoded name in three classes, and
 * this module keeps such a name from reaching it:
 *
 * 1. display-unsafe scalars: C0 and C1 controls (DEL included) and U+2028/U+2029;
 * 2. bidi and zero-width formatting scalars, which are invisible yet can
 *    reverse or rewrite how the rest of a name reads;
 * 3. the display placeholders the pool reserves for "no fact" (空闲, 未知),
 *    compared after trimming surrounding whitespace.
 *
 * {@link sanitizeSessionName} drops the scalars of the first two classes so a
 * ZWJ emoji or a stray BOM cannot turn a whole model request into a 400, and
 * omits the header entirely when the cleaned name is blank or a reserved
 * placeholder. {@link encodeSessionNameHeader} stays mechanical: it only
 * percent-encodes what the caller already sanitized.
 *
 * @module dsh-llm-pi-ai/session-name
 */

/** Longest encoded name header value in bytes; the encoded value is ASCII, so its characters and bytes coincide. */
export const MAX_SESSION_NAME_HEADER_LENGTH = 512

/** Display placeholders the pool refuses because they already mean "no fact". */
const RESERVED_DISPLAY_NAMES: ReadonlySet<string> = Object.freeze(new Set(['空闲', '未知']))

/**
 * Whether a UTF-8 byte is an RFC 3986 §2.3 unreserved character.
 * @param byte - one byte of the name's UTF-8 encoding.
 * @returns true for `A-Z`, `a-z`, `0-9`, `-`, `.`, `_`, and `~`.
 */
function isUnreserved(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a)
    || (byte >= 0x61 && byte <= 0x7a)
    || (byte >= 0x30 && byte <= 0x39)
    || byte === 0x2d
    || byte === 0x2e
    || byte === 0x5f
    || byte === 0x7e
}

/**
 * Whether a scalar breaks a single-line display: C0/C1 controls, DEL, and the
 * Unicode line and paragraph separators.
 * @param codePoint - one Unicode code point of the name.
 * @returns true when the pool refuses it as a display-unsafe scalar.
 */
function isDisplayUnsafe(codePoint: number): boolean {
  return codePoint <= 0x1f
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || codePoint === 0x2028
    || codePoint === 0x2029
}

/**
 * Whether a scalar is a bidi control or an invisible formatting character that
 * the pool refuses in a display name.
 * @param codePoint - one Unicode code point of the name.
 * @returns true for the pool's bidi/zero-width set.
 */
function isBidiOrZeroWidth(codePoint: number): boolean {
  return codePoint === 0x061c
    || (codePoint >= 0x200b && codePoint <= 0x200f)
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2060 && codePoint <= 0x2064)
    || (codePoint >= 0x2066 && codePoint <= 0x2069)
    || codePoint === 0xfeff
}

/**
 * Remove every scalar the pool refuses to display and drop names that would
 * carry no usable label.
 *
 * The pool rejects the whole request when a decoded name contains a control,
 * line/paragraph separator, bidi control, zero-width, or other invisible
 * formatting scalar. Dropping those scalars keeps the request alive; a ZWJ
 * emoji therefore arrives as its adjacent emoji, and a stray BOM disappears.
 * A name left blank by that removal is not sent, and neither is one whose
 * trimmed form is a reserved placeholder, because a header carrying either
 * could not be told apart from "no name" at the endpoint. The returned value is
 * otherwise the input unchanged: surrounding whitespace is the caller's label,
 * and the pool trims only to compare reserved placeholders.
 * @param name - the session's display name.
 * @returns the displayable name, or undefined when it must not be sent.
 */
export function sanitizeSessionName(name: string): string | undefined {
  if (name.length === 0) return undefined
  let sanitized = ''
  for (const character of name) {
    const codePoint = character.codePointAt(0)
    /* v8 ignore next -- standalone code points always carry one; the guard only satisfies noUncheckedIndexedAccess. */
    if (codePoint === undefined || isDisplayUnsafe(codePoint) || isBidiOrZeroWidth(codePoint)) continue
    sanitized += character
  }
  const trimmed = sanitized.trim()
  if (trimmed.length === 0 || RESERVED_DISPLAY_NAMES.has(trimmed)) return undefined
  return sanitized
}

/**
 * Percent-encode an already-sanitized session display name for the pool's name
 * header.
 *
 * Percent-encoding covers every byte outside the RFC 3986 unreserved set —
 * spaces included, unlike `encodeURIComponent` — so the value is printable
 * ASCII that a header field carries without further escaping. This function
 * filters nothing: pass the name through {@link sanitizeSessionName} first, or a
 * scalar the pool refuses reaches the field and fails the request. Values whose
 * encoding does not fit {@link MAX_SESSION_NAME_HEADER_LENGTH} are dropped whole
 * rather than truncated into a different name.
 * @param name - the sanitized session display name.
 * @returns the ASCII header value, or undefined when the name is empty or too
 *   long to send.
 */
export function encodeSessionNameHeader(name: string): string | undefined {
  if (name.length === 0) return undefined
  let value = ''
  for (const byte of Buffer.from(name, 'utf8')) {
    if (isUnreserved(byte)) {
      value += String.fromCharCode(byte)
    } else {
      value += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
    if (value.length > MAX_SESSION_NAME_HEADER_LENGTH) return undefined
  }
  return value
}
