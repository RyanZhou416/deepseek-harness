/**
 * The pinned wire profile one Claude subscription account is read under.
 *
 * Every value here is a fixed protocol constant of the analyzed Claude Code 2.1.288 client, not a
 * deployment setting: the token host receives this account's credentials, so no environment file,
 * page or server answer may choose it. A caller passes the profile explicitly — there is no
 * ambient default — and {@link claudeAccountProfileFailure} rejects a profile whose endpoint
 * origins or paths are not the pinned ones.
 *
 * The user agent is the plain `claude-code/<version>` form. This module derives no operating
 * system or platform field: the plain form is the whole protocol constant, and the platform the
 * Mac engine reports belongs to that engine's own layer.
 *
 * @module dsh-plugin-subscriptions/claude-account-client/protocol
 */

import { claudeAccountFailure } from './failure.js'
import type { ClaudeAccountFailure } from './failure.js'

/** The OAuth client id the analyzed CC child uses; the parent keeper's id is not this one. */
export const CLAUDE_ACCOUNT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

/** The plain user agent the profile and settings roles carry. */
export const CLAUDE_PLAIN_USER_AGENT = 'claude-code/2.1.288'

/** The OAuth beta the account's own endpoints are read under. */
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20'

/** The scopes the authorize request asks for, in the client's own order. */
export const CLAUDE_ACCOUNT_SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins'

/** The authorize-only scope a refresh grant never asks for. */
export const CLAUDE_REFRESH_EXCLUDED_SCOPE = 'org:create_api_key'

/** The authorize page the claude.ai account path uses. */
export const CLAUDE_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'

/** The token endpoint; it receives this account's tokens. */
export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

/** The strict profile endpoint. */
export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

/** The first-party managed-settings endpoint. */
export const CLAUDE_SETTINGS_URL = 'https://api.anthropic.com/api/claude_code/settings'

/**
 * The endpoints, credential identity and user agent one account client runs under.
 *
 * Every request builder takes this profile as an explicit input. Passing a value whose origins or
 * paths are not the pinned ones is an input failure, reported before any request is sent.
 */
export interface ClaudeAccountClientProfile {
  /** OAuth client id sent by the authorize URL and the token grants. */
  readonly clientId: string
  /** Authorize page the browser is sent to. */
  readonly authorizeUrl: string
  /** Token endpoint the grants are POSTed to. */
  readonly tokenUrl: string
  /** Strict profile endpoint. */
  readonly profileUrl: string
  /** Managed-settings endpoint. */
  readonly settingsUrl: string
  /** Plain user agent the profile and settings roles carry. */
  readonly userAgent: string
  /** Scopes the authorize request asks for; a refresh drops {@link CLAUDE_REFRESH_EXCLUDED_SCOPE}. */
  readonly scopes: string
}

/** The single pinned profile this build ships; callers pass it explicitly. */
export const CLAUDE_ACCOUNT_CLIENT_PROFILE: ClaudeAccountClientProfile = Object.freeze({
  clientId: CLAUDE_ACCOUNT_CLIENT_ID,
  authorizeUrl: CLAUDE_AUTHORIZE_URL,
  tokenUrl: CLAUDE_TOKEN_URL,
  profileUrl: CLAUDE_PROFILE_URL,
  settingsUrl: CLAUDE_SETTINGS_URL,
  userAgent: CLAUDE_PLAIN_USER_AGENT,
  scopes: CLAUDE_ACCOUNT_SCOPES,
})

/** The endpoint fields a profile may state, each pinned to one origin and one path. */
type ClaudeEndpointField = 'authorizeUrl' | 'tokenUrl' | 'profileUrl' | 'settingsUrl'

/** The one origin and path each endpoint field must name. */
const CLAUDE_PINNED_ENDPOINTS: readonly (readonly [ClaudeEndpointField, string, string])[] = Object.freeze([
  Object.freeze(['authorizeUrl', 'https://claude.com', '/cai/oauth/authorize'] as const),
  Object.freeze(['tokenUrl', 'https://platform.claude.com', '/v1/oauth/token'] as const),
  Object.freeze(['profileUrl', 'https://api.anthropic.com', '/api/oauth/profile'] as const),
  Object.freeze(['settingsUrl', 'https://api.anthropic.com', '/api/claude_code/settings'] as const),
])

/**
 * Whether a profile names an endpoint this client refuses to send to.
 *
 * The check pins the origin and the path, not just the host: a server answer, an environment file
 * or a caller typo can therefore not move a grant, a token or a policy read to another target.
 * @param profile - the profile the caller supplied.
 * @returns the input failure, or `undefined` when the profile is the pinned one.
 */
export function claudeAccountProfileFailure(profile: ClaudeAccountClientProfile): ClaudeAccountFailure | undefined {
  if (profile.clientId.length === 0) return claudeAccountFailure('invalid_input', { reason: 'empty_client_id' })
  if (profile.userAgent.length === 0) return claudeAccountFailure('invalid_input', { reason: 'empty_user_agent' })
  for (const [field, origin, path] of CLAUDE_PINNED_ENDPOINTS) {
    const value = profile[field]
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      return claudeAccountFailure('invalid_input', { reason: `unusable_${field}` })
    }
    if (parsed.origin !== origin || parsed.pathname !== path) {
      return claudeAccountFailure('invalid_input', { reason: `unpinned_${field}` })
    }
  }
  return undefined
}

/**
 * The scope string a refresh grant carries.
 *
 * The client never asks for `org:create_api_key` when refreshing; that scope belongs to the
 * authorize request. Everything else the account was granted is echoed back in order, so a
 * project scope stays intact.
 * @param scopes - the scopes the session was granted.
 * @returns the same set without the authorize-only scope.
 */
export function refreshScopeString(scopes: string): string {
  return scopes
    .split(/\s+/)
    .filter(scope => scope.length > 0 && scope !== CLAUDE_REFRESH_EXCLUDED_SCOPE)
    .join(' ')
}
