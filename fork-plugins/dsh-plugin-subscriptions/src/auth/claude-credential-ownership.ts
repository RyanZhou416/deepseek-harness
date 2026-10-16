/**
 * How one stored Claude credential is owned, and who may rotate it.
 *
 * This module is the single authority for the persisted `credentialOwnershipMode` value and for
 * every decision that reads it: the durable field's validation, the mode a record without the
 * field implies, the behavior each mode grants, and which conversions between modes are
 * allowed. Keeping those rules here is what stops the import path, the refresh selector, the
 * maintenance scheduler, the sweep and the RPC surface from each inferring ownership for
 * itself.
 *
 * The three modes describe provenance and write authority, never which OAuth client issued the
 * credential:
 *
 * - `independent-oauth`: this plugin authorized the credential itself. Its refresh grant is the
 *   plugin's own, and it is the only mode whose live sessions may run this plugin's proactive
 *   renewal timer.
 * - `legacy-writeback`: the credential lives in Claude Code's own store and this plugin keeps
 *   the pre-existing behavior on that path — it may adopt the external rotation, spend the
 *   shared refresh grant and write its own rotation back. Coordination with that external
 *   holder is NOT established, so the same grant may be spent twice.
 * - `read-only-import`: the credential lives in Claude Code's own store and this plugin only
 *   reads it. Every use re-reads that source and adopts its current winner; the plugin never
 *   spends a grant on it and never writes to that store.
 *
 * `legacy-writeback` and `read-only-import` both have an external source. Only
 * `legacy-writeback` may spend the shared grant or write back, so a shared credential is never
 * treated as source-free.
 *
 * A record that states no mode is not migrated: it reads as `legacy-writeback` when
 * `keychainBound === true` (the only writer of that fact is the import path) and as
 * `independent-oauth` otherwise. A stated value outranks that inference and is validated where
 * the record crosses the file boundary; an unknown value fails the read instead of silently
 * falling back to the inferred mode.
 *
 * This module performs no I/O and reads no credential store.
 */

import type { ClaudeSession } from './store.js'

/**
 * The ownership mode of one stored Claude credential.
 *
 * A closed set: a value outside it is a durable-format failure, not a fourth behavior.
 */
export type ClaudeCredentialMode = 'legacy-writeback' | 'read-only-import' | 'independent-oauth'

/** Every mode, in the order the Settings surface offers them. */
export const CLAUDE_CREDENTIAL_MODES: readonly ClaudeCredentialMode[] = [
  'legacy-writeback',
  'read-only-import',
  'independent-oauth',
]

/**
 * Whether a value is one of the three modes.
 * @param value - the value to test.
 * @returns true when the value is a mode name.
 */
export function isClaudeCredentialMode(value: unknown): value is ClaudeCredentialMode {
  return typeof value === 'string' && (CLAUDE_CREDENTIAL_MODES as readonly string[]).includes(value)
}

/** The record facts the mode inference reads. */
export interface ClaudeCredentialOwnershipFacts {
  /**
   * The mode the record states explicitly, when it states one. This is the durable session
   * field's own name, so a stored record is that fact directly rather than a renamed copy.
   */
  readonly credentialOwnershipMode?: ClaudeCredentialMode | undefined
  /** Whether the record came from Claude Code's own credential store. */
  readonly keychainBound?: boolean | undefined
}

/**
 * The mode a record is served under.
 *
 * A stated value wins outright. Without one, only a record that came from Claude Code's own
 * store is `legacy-writeback`: `keychainBound` is written by the import path alone, so an
 * ordinary browser-authorized account is never downgraded to external write-back.
 * @param facts - the record's stated mode and its imported-from-Claude-Code fact.
 * @returns the resolved mode.
 */
export function resolveClaudeCredentialMode(facts: ClaudeCredentialOwnershipFacts): ClaudeCredentialMode {
  if (facts.credentialOwnershipMode !== undefined) return facts.credentialOwnershipMode
  return facts.keychainBound === true ? 'legacy-writeback' : 'independent-oauth'
}

/**
 * The mode one stored session is served under.
 *
 * The stored record already crossed the durable boundary, where an unknown value fails the
 * read, so the session's own fields are the whole input here.
 * @param session - the stored session record.
 * @returns the resolved mode.
 */
export function claudeCredentialModeOf(session: ClaudeSession): ClaudeCredentialMode {
  return resolveClaudeCredentialMode(session)
}

/**
 * The reference fields a stored record owns and a credential from elsewhere must not erase.
 *
 * They describe provenance and this installation's binding rather than the token: which mode
 * owns the credential, whether it came from Claude Code's own store, the account's confirmed
 * UUID and its local device id. A refresh, an identity backfill, an adopted external rotation
 * or a read-only use all produce a session from somewhere other than the record, and every one
 * of them keeps these. Dropping the mode would silently re-infer ownership — a legacy-writeback
 * account would start rotating the shared grant on this plugin's own timer — and dropping the
 * device binding would re-run the identity backfill on every request.
 * @param reference - the stored record whose reference fields are authoritative.
 * @param credential - the session produced elsewhere.
 * @returns the credential carrying the reference fields the record states.
 */
export function withClaudeCredentialReference(
  reference: ClaudeSession,
  credential: ClaudeSession,
): ClaudeSession {
  return {
    ...credential,
    ...reference.credentialOwnershipMode === undefined
      ? {}
      : { credentialOwnershipMode: reference.credentialOwnershipMode },
    ...reference.keychainBound === undefined ? {} : { keychainBound: reference.keychainBound },
    ...reference.accountUuid === undefined ? {} : { accountUuid: reference.accountUuid },
    ...reference.deviceId === undefined ? {} : { deviceId: reference.deviceId },
  }
}

/**
 * Whether the credential is held in a store outside this plugin.
 *
 * Both external modes re-read that source; only {@link claudeCredentialWritesBack} may change
 * it.
 * @param mode - the resolved mode.
 * @returns true when the credential has an external source.
 */
export function claudeCredentialIsExternal(mode: ClaudeCredentialMode): boolean {
  return mode !== 'independent-oauth'
}

/**
 * Whether this mode may spend the shared refresh grant and write the rotation back to the
 * external store. Exactly one mode does.
 * @param mode - the resolved mode.
 * @returns true only for `legacy-writeback`.
 */
export function claudeCredentialWritesBack(mode: ClaudeCredentialMode): boolean {
  return mode === 'legacy-writeback'
}

/**
 * Whether this mode may run the plugin's proactive credential-renewal timer for a live session.
 * A credential this plugin does not own is never rotated on its own schedule.
 * @param mode - the resolved mode.
 * @returns true only for `independent-oauth`.
 */
export function claudeCredentialArmsOwnTimer(mode: ClaudeCredentialMode): boolean {
  return mode === 'independent-oauth'
}

/**
 * Whether this mode's coordination with the external credential holder is unproven.
 *
 * True for `legacy-writeback`, whose remaining five-minute synchronization is compatibility
 * behavior: it may spend the same grant the external holder spends, and no contract with that
 * holder exists. The status must state this rather than claim a safe single writer.
 * @param mode - the resolved mode.
 * @returns true only for `legacy-writeback`.
 */
export function claudeCredentialCoordinationUnproven(mode: ClaudeCredentialMode): boolean {
  return mode === 'legacy-writeback'
}

/**
 * Why a between-mode conversion was refused.
 *
 * The two refusals exist for different corrections: one needs the browser OAuth flow, the other
 * names an account that has no external store to share.
 */
export type ClaudeCredentialConversionRefusal =
  /** Only the pinned OAuth flow may produce an independently authorized credential. */
  | 'independent-requires-login'
  /** The account's credential is this plugin's own; there is no external store to read or write. */
  | 'account-is-not-external'

/** The verdict on one requested mode conversion. */
export type ClaudeCredentialConversion =
  | { readonly kind: 'ok' }
  | { readonly kind: 'refused'; readonly reason: ClaudeCredentialConversionRefusal; readonly message: string }

/** What one conversion request states. */
export interface ClaudeCredentialConversionRequest {
  /** The mode the account is served under now. */
  readonly from: ClaudeCredentialMode
  /** The mode the caller wants persisted. */
  readonly to: ClaudeCredentialMode
  /** Whether the stored record came from Claude Code's own credential store. */
  readonly externallySourced: boolean
}

/**
 * Decide whether one requested ownership change may be persisted.
 *
 * `read-only-import` and `legacy-writeback` are two ways of using the same external credential,
 * so moving between them is a setting. `independent-oauth` is not a label: it means this plugin
 * holds its own authorization, which only the pinned browser OAuth flow can produce. An
 * imported token therefore cannot be renamed into it, and an account this plugin authorized
 * itself has no external store to move to.
 * @param request - the current mode, the requested mode and the account's provenance.
 * @returns whether the change may be persisted, and why it may not.
 */
export function planClaudeCredentialConversion(
  request: ClaudeCredentialConversionRequest,
): ClaudeCredentialConversion {
  if (request.from === request.to) return { kind: 'ok' }
  if (request.to === 'independent-oauth') {
    return {
      kind: 'refused',
      reason: 'independent-requires-login',
      message: 'an independently authorized credential comes from the browser sign-in flow; '
        + 'sign in again to change this account to independent-oauth',
    }
  }
  if (!request.externallySourced || request.from === 'independent-oauth') {
    return {
      kind: 'refused',
      reason: 'account-is-not-external',
      message: 'this account\'s credential is this plugin\'s own; it has no Claude Code credential '
        + 'store to read or write',
    }
  }
  return { kind: 'ok' }
}

/**
 * Whether this plugin's Claude route serves a first-party OAuth credential.
 *
 * Constant by construction, and deliberately independent of the ownership mode: this plugin
 * serves exactly one pinned Claude origin and stores credentials from exactly two sources — its
 * own browser flow, which is the pinned client's own OAuth flow, and Claude Code's own
 * credential store, which authorizes against that same client. `keychainBound` and the mode
 * state where a credential came from and who may rotate it, which is not evidence about the
 * OAuth client that issued it, so neither may excuse an account from an applicable
 * organization policy. What the credential actually grants is decided separately, from the
 * stored scopes, a usable token and the confirmed subscription metadata.
 */
export const CLAUDE_CREDENTIAL_IS_FIRST_PARTY_OAUTH = true
