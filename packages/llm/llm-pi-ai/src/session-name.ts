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
 * failing over a label.
 *
 * @module dsh-llm-pi-ai/session-name
 */

/** Longest encoded name header value in bytes; the encoded value is ASCII, so its characters and bytes coincide. */
export const MAX_SESSION_NAME_HEADER_LENGTH = 512

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
 * Whether a code point cannot travel in the name header, so the encoder drops
 * it instead of escaping it.
 *
 * The pool decodes the field and refuses a name carrying ASCII control
 * characters (C0, DEL, and C1) or the Unicode line and paragraph separators.
 * Percent-encoding such a code point would still present it after decoding and
 * turn a display label into a refused request, so it is skipped.
 * @param codePoint - one Unicode code point of the name.
 * @returns true for C0 controls, DEL, C1 controls, U+2028, and U+2029.
 */
function isDroppedCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || codePoint === 0x2028
    || codePoint === 0x2029
}

/**
 * Percent-encode a session display name for the pool's name header.
 *
 * Percent-encoding covers every byte outside the RFC 3986 unreserved set —
 * spaces included, unlike `encodeURIComponent` — so the value is printable
 * ASCII that a header field carries without further escaping. Control
 * characters and Unicode line separators are skipped rather than encoded: the
 * pool refuses a decoded name that carries one, and a display hint must never
 * fail the request. Values whose encoding does not fit
 * {@link MAX_SESSION_NAME_HEADER_LENGTH} are dropped whole rather than truncated
 * into a different name.
 * @param name - the session's display name.
 * @returns the ASCII header value, or undefined when the name is empty or too
 *   long to send.
 */
export function encodeSessionNameHeader(name: string): string | undefined {
  if (name.length === 0) return undefined
  let value = ''
  for (const character of name) {
    const codePoint = character.codePointAt(0)
    /* v8 ignore next -- standalone code points always carry one; the guard only satisfies noUncheckedIndexedAccess. */
    if (codePoint === undefined || isDroppedCodePoint(codePoint)) continue
    for (const byte of Buffer.from(character, 'utf8')) {
      if (isUnreserved(byte)) {
        value += String.fromCharCode(byte)
      } else {
        value += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
      }
      if (value.length > MAX_SESSION_NAME_HEADER_LENGTH) return undefined
    }
  }
  return value.length === 0 ? undefined : value
}
