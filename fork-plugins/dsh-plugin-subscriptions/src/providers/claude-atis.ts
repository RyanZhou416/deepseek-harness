/**
 * The ATIS token shape: the one part of the pin protocol that is not durable state.
 *
 * Which token an account span froze, and the capture arbitration that decides it, belong to the
 * durable span store, which survives a restart and is the only owner of that state. What remains
 * here is the client's own token shape, so a caller validating a value a bootstrap read disclosed
 * checks the same rule the durable owner applies to it.
 *
 * @module dsh-plugin-subscriptions/providers/claude-atis
 */

/** The token shape the client accepts: non-empty printable ASCII. */
const PRINTABLE_ATIS = /^[\x21-\x7e]+$/

/**
 * Whether a disclosed value is a token the client would send as given.
 *
 * The token is used exactly as the read disclosed it, so only its shape is decided here: a value of
 * another type, or one carrying characters the header cannot hold, is not a pin.
 * @param value - the value a bootstrap read disclosed.
 * @returns true when it is a usable pin token.
 */
export function isClaudeAtisToken(value: unknown): value is string {
  return typeof value === 'string' && PRINTABLE_ATIS.test(value)
}
