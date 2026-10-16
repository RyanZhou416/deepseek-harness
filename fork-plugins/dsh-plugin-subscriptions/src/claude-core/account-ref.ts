/**
 * The account reference the continuation and ATIS state is keyed by.
 *
 * The reference is a digest, never the account key and never the salt it was derived from: the
 * chain, the wire identity and the pin state are all keyed by it, so the value has to be
 * stable across a restart and comparable without holding a credential. Two references match
 * only when their kind, version and digest all match, because a comparison that skipped the
 * digest would let every account pass every gate.
 *
 * This module is pure: it has no Node import, no DeepSeek Harness import and no store. The
 * continuation selector, the private stores and any future framework-independent helper take the
 * type, its shape check and the comparison from here, so one definition decides what a reference
 * is and when two of them name the same account.
 *
 * @module dsh-plugin-subscriptions/claude-core/account-ref
 */

/** A derivation of the reference rule; a future rule states a new version. */
export const CLAUDE_ACCOUNT_REF_VERSION = 1

/** An account named by material this installation still holds. */
export interface ClaudeAccountRef {
  /** What the reference was derived from; a future derivation changes this. */
  readonly kind: 'salt-sha256'
  /** Derivation version, so a reference states which rule produced it. */
  readonly version: typeof CLAUDE_ACCOUNT_REF_VERSION
  /** Lowercase hex digest; the salt and account key do not appear in it. */
  readonly ref: string
}

/** The digest a reference carries: 64 lowercase hex characters. */
const CLAUDE_ACCOUNT_REF_DIGEST = /^[0-9a-f]{64}$/

/**
 * Whether a value read from a log or a store carries a reference this build can compare.
 * @param value - the candidate reference.
 * @returns true when the reference states a derivation this build implements.
 */
export function isClaudeAccountRef(value: unknown): value is ClaudeAccountRef {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record['kind'] === 'salt-sha256'
    && record['version'] === CLAUDE_ACCOUNT_REF_VERSION
    && typeof record['ref'] === 'string' && CLAUDE_ACCOUNT_REF_DIGEST.test(record['ref'])
}

/**
 * Whether two references name the same derived account.
 *
 * All three fields decide it. A comparison that skipped the digest would let every account match
 * another account's gate, and one that skipped the derivation version would let a later rule's
 * reference stand for an earlier rule's.
 * @param left - the first reference.
 * @param right - the second reference.
 * @returns true when both state the same derivation and the same digest.
 */
export function sameClaudeAccountRef(left: ClaudeAccountRef, right: ClaudeAccountRef): boolean {
  return left.kind === right.kind && left.version === right.version && left.ref === right.ref
}
