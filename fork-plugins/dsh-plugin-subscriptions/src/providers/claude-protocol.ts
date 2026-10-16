/**
 * The one Claude compatibility profile this route runs.
 *
 * The pinned wire contract stays owned by `@tormentalabs/claude-code-wire-compat`; this
 * module composes it with the desktop release the pin is anchored to and states, in one
 * place, the facts every Claude request kind must agree on: the version claims, the
 * endpoint each role calls, the headers that role may carry, and the rejections the
 * service is known to send. Nothing here performs I/O or invents a request the pinned
 * client does not make.
 *
 * Account- and request-scoped state (ATIS pins, request-id chaining, credentials,
 * quota observations) deliberately stays out: those are per identity and per request,
 * not properties of the compatibility profile.
 *
 * @module dsh-plugin-subscriptions/providers/claude-protocol
 */

import { createHash } from 'node:crypto'
import {
  CLAUDE_CODE_2_1_288_PROFILE,
  checkProfileCoherence,
} from '@tormentalabs/claude-code-wire-compat'
import { CLAUDE_DESKTOP_APP_VERSION } from './claude-desktop.js'

/**
 * What a provider rejection is evidence about.
 *
 * The scope is what later scheduling may act on, so it is deliberately narrower than
 * “the account is broken”: a protocol rejection is evidence about the compatibility
 * profile, a permission rejection about one request or one organisation, and only a
 * credential rejection about the stored login.
 */
export type ClaudeFailureScope =
  /** This logical operation only. */
  | 'operation'
  /** One account's credentials or standing. */
  | 'account'
  /** The provider origin plus compatibility-profile fingerprint, across accounts. */
  | 'provider-profile'
  /** One model or model family. */
  | 'model'
  /** The evidence names no usable scope. */
  | 'unknown'

/**
 * Whether automatic recovery may still run for a decided failure.
 *
 * `forbid` is the hard stop: no refresh, no account switch, no parameter adjustment and
 * no whole-step replay. It is reported to the Host through the failure's
 * `retryDisposition`.
 */
export type RetryDisposition = 'forbid' | 'allow'

/**
 * One request kind whose endpoint, headers and rules differ from every other.
 *
 * The OAuth token exchange is deliberately absent: its host is chosen once at module load
 * by `CLAUDE_CODE_CUSTOM_OAUTH_URL` and receiving this account's tokens, so its endpoint
 * stays owned by the login flow rather than repeated here.
 */
export type ClaudeRequestRole =
  | 'messages'
  | 'countTokens'
  | 'profile'
  | 'usage'
  | 'bootstrap'
  | 'files'
  | 'settings'

/** Absolute endpoint per request role. */
export type ClaudeEndpoints = Readonly<Record<ClaudeRequestRole, string>>

/** How one request role authenticates and what client identity it presents. */
export interface ClaudeHeaderRole {
  /** How the access token travels; `none` for the OAuth token exchange. */
  readonly authorization: 'bearer' | 'none'
  /**
   * Which pinned user agent the role sends: the transport one carrying the entrypoint
   * clause, or the plain `claude-code/<version>` one.
   */
  readonly userAgent: 'transport' | 'plain'
  /** `anthropic-beta` value the role sends, absent when it sends none. */
  readonly anthropicBeta?: string
  /** Fixed headers the role adds beyond the user agent and authorization. */
  readonly headers: Readonly<Record<string, string>>
}

/** The pinned compatibility profile every Claude request on this route is built from. */
export interface ClaudeProtocolProfile {
  /** Wire-profile id, as the pinned package names it. */
  readonly id: string
  /** Digest over every identity-bearing field; the protocol-block key's revision half. */
  readonly fingerprint: string
  /** Claude Code version this route claims on the wire. */
  readonly cliVersion: string
  /** SDK version the pinned profile pairs with {@link cliVersion}. */
  readonly sdkVersion: string
  /** Desktop application release the pin is anchored to; a separate claim from the CLI version. */
  readonly desktopAppVersion: string
  /** Normalized origin every endpoint below shares. */
  readonly origin: string
  /** `CLAUDE_CODE_ENTRYPOINT` value the requests declare. */
  readonly entrypoint: string
  /** User agent sent on the transport role. */
  readonly userAgent: string
  /** User agent sent on roles that use the plain form. */
  readonly plainUserAgent: string
  /** `anthropic-version` header value. */
  readonly anthropicVersion: string
  /** The provider the pinned billing header names. */
  readonly provider: string
  /** Endpoint per request role. */
  readonly endpoints: ClaudeEndpoints
  /** Header policy per request role; roles never borrow another role's set. */
  readonly headerRoles: Readonly<Record<ClaudeRequestRole, ClaudeHeaderRole>>
}

/**
 * Endpoint values, as the pinned client and the upstream API reference state them.
 *
 * The Messages endpoints come from the pinned profile; the rest are the subscription
 * endpoints the client itself calls, listed here so a role cannot quietly start using
 * another role's target.
 */
const CLAUDE_ENDPOINTS: ClaudeEndpoints = Object.freeze({
  messages: CLAUDE_CODE_2_1_288_PROFILE.endpoint,
  countTokens: CLAUDE_CODE_2_1_288_PROFILE.countTokensEndpoint,
  profile: 'https://api.anthropic.com/api/oauth/profile',
  usage: 'https://api.anthropic.com/api/oauth/usage',
  bootstrap: 'https://api.anthropic.com/api/claude_cli/bootstrap',
  files: 'https://api.anthropic.com/v1/files',
  // The first-party managed-settings endpoint the client's own settings request uses.
  settings: 'https://api.anthropic.com/api/claude_code/settings',
})

/**
 * OAuth scope the client pairs with the OAuth beta when it reads the account's own
 * endpoints. It is the beta the usage, bootstrap and profile reads carry.
 */
const OAUTH_BETA = 'oauth-2025-04-20'

/** Request roles and the header policy each one owns. */
const CLAUDE_HEADER_ROLES: Readonly<Record<ClaudeRequestRole, ClaudeHeaderRole>> = Object.freeze({
  // The Messages plan — identity, beta composition, correlation metadata — is composed by
  // the pinned builder from the profile, so the role records only the scheme it uses.
  messages: Object.freeze({ authorization: 'bearer', userAgent: 'transport', headers: Object.freeze({}) }),
  countTokens: Object.freeze({ authorization: 'bearer', userAgent: 'transport', headers: Object.freeze({}) }),
  profile: Object.freeze({
    authorization: 'bearer',
    userAgent: 'plain',
    headers: Object.freeze({ 'content-type': 'application/json', 'cache-control': 'no-cache' }),
  }),
  usage: Object.freeze({
    authorization: 'bearer',
    userAgent: 'transport',
    anthropicBeta: OAUTH_BETA,
    headers: Object.freeze({ 'accept': 'application/json', 'content-type': 'application/json' }),
  }),
  bootstrap: Object.freeze({
    authorization: 'bearer',
    userAgent: 'plain',
    anthropicBeta: OAUTH_BETA,
    headers: Object.freeze({ 'content-type': 'application/json', 'accept': 'application/json' }),
  }),
  files: Object.freeze({ authorization: 'bearer', userAgent: 'plain', headers: Object.freeze({}) }),
  settings: Object.freeze({
    authorization: 'bearer',
    userAgent: 'plain',
    anthropicBeta: OAUTH_BETA,
    // The client's own managed-settings read sends both cache directives unconditionally, so a
    // proxy or gateway in front of the endpoint cannot answer this read from a cached copy of a
    // policy document that may have changed.
    headers: Object.freeze({
      'accept': 'application/json',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
    }),
  }),
})

// The version-refusal vocabulary and the Anthropic error-event rules live in the engine's own
// rules module, so the engine never imports this provider module. They are re-exported under
// their original names for this plugin's existing consumers; that module's scope and
// disposition unions are structurally identical to this file's.
export {
  CLAUDE_VERSION_REJECTION_MARKERS,
  matchesClaudeVersionRejection,
  anthropicErrorEventRule,
} from '../claude-engine/failure-rules.js'
export type { ClaudeErrorEventRule } from '../claude-engine/failure-rules.js'

/** The digest input ordering is fixed so a fingerprint is stable for one profile. */
const FINGERPRINT_FIELDS = [
  'id', 'cliVersion', 'sdkVersion', 'entrypoint', 'anthropicVersion', 'provider',
  'endpoint', 'countTokensEndpoint', 'userAgent',
] as const

/**
 * Compute the profile fingerprint a protocol block is keyed by.
 *
 * Derived from the compiled pin, never from configuration or a declaration: a fingerprint
 * therefore changes only when a trusted profile replacement changes the identity the
 * route presents, which is exactly the condition under which an older block stops
 * matching.
 * @param profile - the compatibility profile to digest.
 * @returns a 64-character lowercase hex digest.
 */
export function claudeProtocolFingerprint(profile: ClaudeProtocolProfile): string {
  const identity = {
    id: profile.id,
    cliVersion: profile.cliVersion,
    sdkVersion: profile.sdkVersion,
    entrypoint: profile.entrypoint,
    anthropicVersion: profile.anthropicVersion,
    provider: profile.provider,
    endpoint: profile.endpoints.messages,
    countTokensEndpoint: profile.endpoints.countTokens,
    userAgent: profile.userAgent,
  }
  const digest = createHash('sha256')
  for (const field of FINGERPRINT_FIELDS) digest.update(`${field}=${String(identity[field])}\n`)
  return digest.digest('hex')
}

/**
 * Build the profile snapshot one logical request freezes.
 *
 * Every request freezes the snapshot at the point its account is chosen, so a
 * configuration change reaches later operations only and an in-flight retry keeps the
 * profile it was decided under.
 * @param endpoints - endpoint overrides; absent uses the pinned endpoints.
 * @returns the frozen compatibility profile.
 */
export function resolveClaudeProtocolProfile(
  endpoints: Partial<ClaudeEndpoints> = {},
): ClaudeProtocolProfile {
  const resolved: ClaudeEndpoints = Object.freeze({ ...CLAUDE_ENDPOINTS, ...endpoints })
  const origin = new URL(resolved.messages).origin
  const entrypoint = CLAUDE_CODE_2_1_288_PROFILE.entrypoint ?? 'claude-desktop'
  const profile: ClaudeProtocolProfile = {
    id: CLAUDE_CODE_2_1_288_PROFILE.id,
    fingerprint: '',
    cliVersion: CLAUDE_CODE_2_1_288_PROFILE.cliVersion,
    sdkVersion: CLAUDE_CODE_2_1_288_PROFILE.sdkVersion,
    desktopAppVersion: CLAUDE_DESKTOP_APP_VERSION,
    origin,
    entrypoint,
    userAgent: CLAUDE_CODE_2_1_288_PROFILE.userAgent,
    plainUserAgent: `claude-code/${CLAUDE_CODE_2_1_288_PROFILE.cliVersion}`,
    anthropicVersion: CLAUDE_CODE_2_1_288_PROFILE.anthropicVersion,
    provider: CLAUDE_CODE_2_1_288_PROFILE.provider,
    endpoints: resolved,
    headerRoles: CLAUDE_HEADER_ROLES,
  }
  return Object.freeze({ ...profile, fingerprint: claudeProtocolFingerprint(profile) })
}

/**
 * The profile this route runs.
 *
 * Verified at module load: a pin whose version-bearing fields disagree with each other
 * misrepresents the client in ways the service can see, so the combination fails loudly at
 * startup instead of quietly on the wire.
 */
export const CLAUDE_PROTOCOL_PROFILE: ClaudeProtocolProfile = (() => {
  const profile = resolveClaudeProtocolProfile()
  const disagreements = checkProfileCoherence(CLAUDE_CODE_2_1_288_PROFILE)
  if (disagreements.length > 0) {
    throw new Error(`claude protocol profile ${profile.id} is incoherent: ${disagreements.join('; ')}`)
  }
  return profile
})()

/**
 * The headers one request role sends, without the authorization value.
 *
 * The caller supplies the token, so this function never handles one. The Messages role's
 * full header plan is composed by the pinned builder; this returns its fixed extras only.
 * @param role - the request role being sent.
 * @returns fixed header name/value pairs for that role.
 */
export function claudeRoleHeaders(role: ClaudeRequestRole): Record<string, string> {
  const policy = CLAUDE_HEADER_ROLES[role]
  const userAgent = policy.userAgent === 'plain'
    ? CLAUDE_PROTOCOL_PROFILE.plainUserAgent
    : CLAUDE_PROTOCOL_PROFILE.userAgent
  return {
    'user-agent': userAgent,
    ...policy.anthropicBeta === undefined ? {} : { 'anthropic-beta': policy.anthropicBeta },
    ...policy.headers,
  }
}
