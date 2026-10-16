/**
 * The pure single-account maintenance client for a Claude subscription account.
 *
 * A caller outside the harness — the Mac pool's direct backend today — imports this barrel and
 * gets exactly four things: the authorize URL and the token grants, the strict profile read, the
 * managed-settings reader, and the transport/deadline seam they all run on. Everything exported
 * here is defined in this directory and re-exported unchanged; the barrel is a list, not a
 * wrapper.
 *
 * The module imports `claude-core` for the bounded body reader and the transport contract, and
 * `claude-engine/failure-rules` for the client-version refusal vocabulary. It imports nothing from
 * `providers/**`, nothing from the harness, and nothing from Cordis. It reads no environment
 * variable, keychain or home directory, holds no credential, no account pool, no proxy and no
 * credential store, starts no poll, and never calls `fetch` itself.
 *
 * Ownership it does not take: the caller's `CredentialVault` is the only committer of a
 * credential — this module returns a typed grant and persists nothing — the caller's worker owns
 * scheduling and the account pool, and the caller's `EgressBroker` owns the egress the injected
 * transport carries. An authorization code and its `state` are the host's one-time values: this
 * module sends one request per call and claims no exactly-once semantics.
 *
 * @module dsh-plugin-subscriptions/claude-account-client
 */

export { claudeAccountFailure, claudeFailureDropsCredential, classifyClaudeRefusal } from './failure.js'
export type { ClaudeAccountFailure, ClaudeAccountFailureCode, ClaudeRefusal } from './failure.js'

export { claudeFirstString, claudeOwnField, claudeRecord } from './json.js'
export type { ClaudeOwnField } from './json.js'

export {
  CLAUDE_ACCOUNT_CLIENT_ID,
  CLAUDE_ACCOUNT_CLIENT_PROFILE,
  CLAUDE_ACCOUNT_SCOPES,
  CLAUDE_AUTHORIZE_URL,
  CLAUDE_OAUTH_BETA,
  CLAUDE_PLAIN_USER_AGENT,
  CLAUDE_PROFILE_URL,
  CLAUDE_REFRESH_EXCLUDED_SCOPE,
  CLAUDE_SETTINGS_URL,
  CLAUDE_TOKEN_URL,
  claudeAccountProfileFailure,
  refreshScopeString,
} from './protocol.js'
export type { ClaudeAccountClientProfile } from './protocol.js'

export {
  CLAUDE_SYSTEM_TIMERS,
  cancelClaudeBody,
  exchangeClaudeRequest,
  readClaudeBody,
} from './wire.js'
export type {
  ClaudeAccountRequest,
  ClaudeAccountResponse,
  ClaudeAccountTimers,
  ClaudeAccountTransport,
  ClaudeExchange,
  ClaudeExchangeOutcome,
  ClaudeResponseBody,
} from './wire.js'

export {
  CLAUDE_TOKEN_BODY_LIMIT,
  CLAUDE_TOKEN_TIMEOUT_MS,
  buildOAuthAuthorization,
  exchangeAuthorizationCode,
  pkceCodeChallenge,
  refreshTokenGrant,
} from './token.js'
export type {
  ClaudeAuthorization,
  ClaudeAuthorizationCodeExchange,
  ClaudeAuthorizationInput,
  ClaudeRefreshGrantRequest,
  ClaudeTokenAccountMetadata,
  ClaudeTokenGrant,
  ClaudeTokenOutcome,
} from './token.js'

export {
  CLAUDE_PROFILE_AUTH_REPLAY_BUDGET,
  CLAUDE_PROFILE_BODY_LIMIT,
  CLAUDE_PROFILE_TIMEOUT_MS,
  parseClaudeStrictProfile,
  readClaudeStrictProfile,
} from './profile.js'
export type {
  ClaudeProfileIdentity,
  ClaudeProfileOutcome,
  ClaudeStrictProfile,
  ClaudeStrictProfileRead,
} from './profile.js'

export {
  CLAUDE_SETTINGS_BODY_LIMIT,
  CLAUDE_SETTINGS_TIMEOUT_MS,
  claudeIfNoneMatch,
  parseClaudeManagedSettingsEnvelope,
  readClaudeManagedSettings,
} from './settings.js'
export type {
  ClaudeManagedSettingsCache,
  ClaudeManagedSettingsEnvelope,
  ClaudeManagedSettingsOutcome,
  ClaudeManagedSettingsRead,
} from './settings.js'
