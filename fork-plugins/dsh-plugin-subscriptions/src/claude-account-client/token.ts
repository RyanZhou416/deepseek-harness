/**
 * The OAuth token client: the authorize URL, the code exchange and the refresh grant.
 *
 * One call is one POST. This module never replays a grant — the service may already have spent
 * it — never persists a token, never reads an environment variable, a keychain or a home
 * directory, and never starts a browser. The authorization code and its `state` are the caller's
 * one-time values: this module echoes them and does not pretend to implement exactly-once, so
 * the host that owns them is what decides the attempt happened once.
 *
 * @module dsh-plugin-subscriptions/claude-account-client/token
 */

import { createHash } from 'node:crypto'
import { claudeAccountFailure, classifyClaudeRefusal } from './failure.js'
import type { ClaudeAccountFailure } from './failure.js'
import { claudeFirstString, claudeRecord } from './json.js'
import { claudeAccountProfileFailure, refreshScopeString } from './protocol.js'
import type { ClaudeAccountClientProfile } from './protocol.js'
import { CLAUDE_SYSTEM_TIMERS, exchangeClaudeRequest } from './wire.js'
import type {
  ClaudeAccountResponse,
  ClaudeAccountTimers,
  ClaudeAccountTransport,
  ClaudeResponseBody,
} from './wire.js'

/**
 * The pinned bound on one token exchange, in milliseconds.
 *
 * It covers the POST and the read of its answer: a body that never finishes would otherwise hold
 * the refresh — and the credential it is rotating — open after the response headers had arrived.
 */
export const CLAUDE_TOKEN_TIMEOUT_MS = 30_000

/**
 * The bound on a token response body this client consumes, in bytes.
 *
 * Like the core readers' caps, this is this build's own product guard rather than a pinned
 * constant of the analyzed client, whose transport applies no fixed byte cap of its own. A body
 * over it is refused outright and never re-pulled; no part of it reaches the failure.
 */
export const CLAUDE_TOKEN_BODY_LIMIT = 65_536

/** The authorize-only grant codes that mean the login is permanently gone. */
const CLAUDE_PERMANENT_GRANT_CODES: readonly string[] = Object.freeze(['invalid_grant', 'invalid_token'])

/**
 * The S256 PKCE challenge for one verifier (RFC 7636).
 *
 * The verifier itself never leaves the caller: it is minted, kept and presented at the token
 * endpoint by whoever owns the one authorization attempt.
 * @param codeVerifier - the high-entropy verifier for this attempt.
 * @returns the base64url-encoded SHA-256 digest.
 */
export function pkceCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url')
}

/** The inputs one authorize URL is built from. */
export interface ClaudeAuthorizationInput {
  /** The explicit pinned profile the origin and client id come from. */
  readonly profile: ClaudeAccountClientProfile
  /** The redirect URI this attempt registered. */
  readonly redirectUri: string
  /** The S256 challenge for this attempt's verifier; see {@link pkceCodeChallenge}. */
  readonly codeChallenge: string
  /** The caller's own one-time state value; this builder mints nothing. */
  readonly state: string
  /** Scopes to ask for; defaults to the profile's own set. */
  readonly scopes?: string
}

/** The authorize URL one attempt opens. */
export interface ClaudeAuthorization {
  /** The URL the browser is sent to. */
  readonly url: string
  /** The state the URL carries, echoed for the caller's comparison at the callback. */
  readonly state: string
  /** The scope string the request asked for. */
  readonly scopes: string
}

/**
 * Build the authorize URL for one attempt.
 *
 * The parameter set and order are the analyzed client's own. The state and the PKCE challenge are
 * caller-provided; this builder neither mints nor remembers them.
 * @param input - the profile, the redirect URI, the challenge, the state and the scopes.
 * @returns the URL and the values it carried.
 * @throws Error when the profile is not the pinned one or a one-time input is empty; a
 * misconfiguration fails loud here rather than opening a page that cannot finish.
 */
export function buildOAuthAuthorization(input: ClaudeAuthorizationInput): ClaudeAuthorization {
  const profileFailure = claudeAccountProfileFailure(input.profile)
  if (profileFailure !== undefined) {
    throw new Error(`claude account client profile is not pinned: ${profileFailure.reason ?? profileFailure.code}`)
  }
  if (input.redirectUri.length === 0) throw new Error('claude authorization requires a redirect URI')
  if (input.codeChallenge.length === 0) throw new Error('claude authorization requires a PKCE code challenge')
  if (input.state.length === 0) throw new Error('claude authorization requires a caller-provided state')
  const scopes = input.scopes ?? input.profile.scopes
  const params = new URLSearchParams({
    code: 'true',
    client_id: input.profile.clientId,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    scope: scopes,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    state: input.state,
  })
  return { url: `${input.profile.authorizeUrl}?${params.toString()}`, state: input.state, scopes }
}

/** Account metadata a token response stated about itself, when it stated any. */
export interface ClaudeTokenAccountMetadata {
  /** The account uuid the response named. */
  readonly accountUuid?: string
  /** The organization uuid the response named. */
  readonly organizationUuid?: string
  /** The address the response named. */
  readonly email?: string
}

/**
 * One validated token grant.
 *
 * Every field was read from the parsed document and type-checked; nothing here is an unchecked
 * cast of the response. An absent optional field stays absent rather than being invented.
 */
export interface ClaudeTokenGrant {
  /** The access token to carry. */
  readonly accessToken: string
  /** The rotated refresh token; absent means the caller keeps the one it presented. */
  readonly refreshToken?: string
  /** The lifetime the endpoint stated, in seconds. */
  readonly expiresInSeconds?: number
  /** The scopes the endpoint stated, or the scopes this call asked for when it stated none. */
  readonly scopes: readonly string[]
  /** Account metadata the grant carried, when it carried any. */
  readonly account?: ClaudeTokenAccountMetadata
}

/** What one token call resolved to. */
export type ClaudeTokenOutcome =
  /** A grant was validated. The caller owns committing it; this module committed nothing. */
  | { readonly kind: 'grant'; readonly grant: ClaudeTokenGrant }
  /** The caller's own `required` hook said no request was needed; nothing was sent. */
  | { readonly kind: 'not-required' }
  /** The caller cancelled. */
  | { readonly kind: 'cancelled'; readonly failure: ClaudeAccountFailure }
  /** This module's deadline fired; the credential is untouched and must not be deleted for it. */
  | { readonly kind: 'timeout'; readonly failure: ClaudeAccountFailure }
  /** The grant is permanently gone; only a new authorization can fix the account. */
  | { readonly kind: 'invalid_grant'; readonly failure: ClaudeAccountFailure }
  /** The service refused the call; no retry and no switch to another account. */
  | { readonly kind: 'refused'; readonly failure: ClaudeAccountFailure }
  /** Nothing answered, or a 5xx, 429 or 408 did. */
  | { readonly kind: 'unreachable'; readonly failure: ClaudeAccountFailure }
  /** The answer could not be validated, or the request could not be built. */
  | { readonly kind: 'invalid'; readonly failure: ClaudeAccountFailure }

/** The seams every token call shares. */
interface ClaudeTokenRequestBase {
  /** The explicit pinned profile; its token URL and client id are the CC child's own. */
  readonly profile: ClaudeAccountClientProfile
  /** The injected transport, which carries the account's egress. */
  readonly transport: ClaudeAccountTransport
  /** The injected deadline scheduler; defaults to the process timer. */
  readonly timers?: ClaudeAccountTimers
  /** Bound on the whole exchange; defaults to {@link CLAUDE_TOKEN_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Caller cancellation. */
  readonly signal?: AbortSignal
  /**
   * The caller's zero-I/O predicate for whether this call is needed at all.
   *
   * It is evaluated before any request is built. `false` means nothing is sent — not even a
   * transport call — which is what lets a caller gate a refresh on state it alone holds.
   */
  readonly required?: () => boolean
}

/** One authorization-code exchange. */
export interface ClaudeAuthorizationCodeExchange extends ClaudeTokenRequestBase {
  /** The one-time code from the callback; the host owns its single use. */
  readonly code: string
  /** The verifier whose S256 challenge the authorize URL carried. */
  readonly codeVerifier: string
  /** The redirect URI this attempt registered. */
  readonly redirectUri: string
  /** The state the authorize URL carried and the callback echoed. */
  readonly state: string
}

/** One refresh grant. */
export interface ClaudeRefreshGrantRequest extends ClaudeTokenRequestBase {
  /** The refresh token to present. */
  readonly refreshToken: string
  /** The scopes the account was granted; `org:create_api_key` is dropped from the request. */
  readonly scopes: string
}

/** The answer one token response produced, before it is mapped to a caller-facing outcome. */
type ClaudeTokenAnswer =
  | { readonly kind: 'grant'; readonly grant: ClaudeTokenGrant }
  | { readonly kind: 'invalid_grant'; readonly reason: string }
  | { readonly kind: 'refused'; readonly failure: ClaudeAccountFailure }
  | { readonly kind: 'unreachable'; readonly failure: ClaudeAccountFailure }
  | { readonly kind: 'invalid'; readonly failure: ClaudeAccountFailure }

/** Split one scope string into its members, in order and without duplicates. */
function claudeScopes(value: string): readonly string[] {
  const scopes: string[] = []
  for (const scope of value.split(/\s+/)) {
    if (scope.length > 0 && !scopes.includes(scope)) scopes.push(scope)
  }
  return Object.freeze(scopes)
}

/**
 * Read the account metadata a grant stated, from the wire spellings the endpoint uses.
 * @param root - the parsed grant document.
 * @returns the metadata, or `undefined` when the grant stated none.
 */
function claudeGrantAccount(root: Record<string, unknown>): ClaudeTokenAccountMetadata | undefined {
  const account = claudeRecord(root['account'])
  const organization = claudeRecord(root['organization'])
  const accountUuid = claudeFirstString(root['account_uuid'], root['accountUuid'], account?.['uuid'])
  const organizationUuid = claudeFirstString(
    root['organization_uuid'], root['organizationUuid'], organization?.['uuid'],
  )
  const email = claudeFirstString(root['email'], root['email_address'], account?.['email'])
  if (accountUuid === undefined && organizationUuid === undefined && email === undefined) return undefined
  return {
    ...accountUuid === undefined ? {} : { accountUuid },
    ...organizationUuid === undefined ? {} : { organizationUuid },
    ...email === undefined ? {} : { email },
  }
}

/**
 * Validate one parsed token document into a typed grant.
 * @param raw - the parsed response document.
 * @param requestedScopes - the scopes this call asked for, used when the answer states none.
 * @returns the grant, or the fixed reason the document was refused.
 */
function parseClaudeTokenGrant(
  raw: unknown,
  requestedScopes: string,
): { readonly grant: ClaudeTokenGrant } | { readonly reason: string } {
  const root = claudeRecord(raw)
  if (root === undefined) return { reason: 'malformed_grant' }
  const accessToken = root['access_token']
  if (typeof accessToken !== 'string' || accessToken.length === 0) return { reason: 'malformed_grant' }
  const refreshToken = root['refresh_token']
  if (refreshToken !== undefined && (typeof refreshToken !== 'string' || refreshToken.length === 0)) {
    return { reason: 'malformed_refresh_token' }
  }
  const expires = root['expires_in']
  if (expires !== undefined && (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0)) {
    return { reason: 'malformed_expiry' }
  }
  const scope = root['scope']
  if (scope !== undefined && typeof scope !== 'string') return { reason: 'malformed_scope' }
  const account = claudeGrantAccount(root)
  return {
    grant: {
      accessToken,
      ...refreshToken === undefined ? {} : { refreshToken },
      ...expires === undefined ? {} : { expiresInSeconds: expires },
      scopes: claudeScopes(scope ?? requestedScopes),
      ...account === undefined ? {} : { account },
    },
  }
}

/**
 * Which permanently spent grant code a failed token exchange named, if any.
 *
 * Only the parsed `error` field is read and only against the fixed allowlist, so the answer is one
 * of two known constants and never a body string: the analyzed client's own reader takes the code
 * from that field, and a description that merely mentions it is not the code.
 * @param body - the bounded response body.
 * @returns the matched constant, or `undefined` when the endpoint named no permanent grant code.
 */
function claudePermanentGrantCode(body: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  const root = claudeRecord(parsed)
  if (root === undefined) return undefined
  const error = root['error']
  if (typeof error === 'string') return CLAUDE_PERMANENT_GRANT_CODES.find(code => code === error)
  const code = claudeRecord(error)?.['code']
  return typeof code === 'string' ? CLAUDE_PERMANENT_GRANT_CODES.find(known => known === code) : undefined
}

/**
 * Read one token response inside the deadline.
 * @param response - the response the token endpoint returned.
 * @param body - the owned body of that response, read exactly once here.
 * @param requestedScopes - the scopes this call asked for.
 * @returns the typed answer, with every failure a fixed code and no response text.
 */
async function readClaudeTokenAnswer(
  response: ClaudeAccountResponse,
  body: ClaudeResponseBody,
  requestedScopes: string,
): Promise<ClaudeTokenAnswer> {
  if (response.redirected === true) {
    // A redirect would replay the code or the refresh token to a host this client never chose.
    return {
      kind: 'invalid',
      failure: claudeAccountFailure('redirected', { status: response.status, reason: 'redirected' }),
    }
  }
  let consumed: { text: string; truncated: boolean }
  try {
    consumed = await body.read(CLAUDE_TOKEN_BODY_LIMIT)
  } catch {
    return {
      kind: 'invalid',
      failure: claudeAccountFailure('invalid', { status: response.status, reason: 'unreadable_body' }),
    }
  }
  if (consumed.truncated) {
    return {
      kind: 'invalid',
      failure: claudeAccountFailure('body_over_limit', { status: response.status, reason: 'body_over_limit' }),
    }
  }
  if (response.status < 200 || response.status >= 300) {
    const refusal = classifyClaudeRefusal(response.status, consumed.text)
    // A version refusal outranks everything; short of that, the endpoint's own permanent grant
    // code is what says the login is gone — whatever status carried it, as the analyzed client's
    // own reader decides it from the parsed code alone. A generic 401 or 400 names no such code
    // and stays a refusal, never evidence that the stored credential is spent.
    if (refusal.failure.code !== 'client_version_unsupported') {
      const permanent = claudePermanentGrantCode(consumed.text)
      if (permanent !== undefined) return { kind: 'invalid_grant', reason: permanent }
    }
    if (response.status >= 500 || response.status === 429 || response.status === 408) {
      return {
        kind: 'unreachable',
        failure: claudeAccountFailure('unreachable', { status: response.status, reason: 'http_status' }),
      }
    }
    return { kind: 'refused', failure: refusal.failure }
  }
  let raw: unknown
  try {
    raw = JSON.parse(consumed.text)
  } catch {
    return {
      kind: 'invalid',
      failure: claudeAccountFailure('invalid', { status: response.status, reason: 'malformed_grant' }),
    }
  }
  const parsed = parseClaudeTokenGrant(raw, requestedScopes)
  return 'grant' in parsed
    ? { kind: 'grant', grant: parsed.grant }
    : {
      kind: 'invalid',
      failure: claudeAccountFailure('invalid', { status: response.status, reason: parsed.reason }),
    }
}

/**
 * POST one grant and map the exchange to a caller-facing outcome.
 * @param input - the shared seams: profile, transport, deadline, cancellation and `required`.
 * @param grant - the grant object to send verbatim.
 * @param requestedScopes - the scopes this call asks for, used when the answer states none.
 * @returns what the call resolved to.
 */
async function requestClaudeGrant(
  input: ClaudeTokenRequestBase,
  grant: Record<string, unknown>,
  requestedScopes: string,
): Promise<ClaudeTokenOutcome> {
  if (input.required?.() === false) return { kind: 'not-required' }
  const profileFailure = claudeAccountProfileFailure(input.profile)
  if (profileFailure !== undefined) return { kind: 'invalid', failure: profileFailure }
  const timeoutMs = input.timeoutMs ?? CLAUDE_TOKEN_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { kind: 'invalid', failure: claudeAccountFailure('invalid_input', { reason: 'timeout_ms' }) }
  }
  const outcome = await exchangeClaudeRequest({
    url: input.profile.tokenUrl,
    method: 'POST',
    // The grant body is the client's own JSON document; the endpoint chooses no other encoding.
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(grant),
    timeoutMs,
    transport: input.transport,
    timers: input.timers ?? CLAUDE_SYSTEM_TIMERS,
    ...input.signal === undefined ? {} : { signal: input.signal },
  }, async (response, body) => await readClaudeTokenAnswer(response, body, requestedScopes))
  switch (outcome.kind) {
    case 'handled': return claudeTokenAnswerOutcome(outcome.value)
    case 'timeout': {
      // A deadline says nothing about the credential, and it is never replayed: the service may
      // already have spent the grant.
      return { kind: 'timeout', failure: claudeAccountFailure('timeout', { reason: 'token_deadline' }) }
    }
    case 'cancelled': return { kind: 'cancelled', failure: claudeAccountFailure('cancelled') }
    case 'unreachable': {
      return { kind: 'unreachable', failure: claudeAccountFailure('unreachable', { reason: 'transport' }) }
    }
  }
}

/**
 * Map one response answer to the caller-facing outcome.
 * @param answer - what the token response produced.
 * @returns the outcome the caller switches on.
 */
function claudeTokenAnswerOutcome(answer: ClaudeTokenAnswer): ClaudeTokenOutcome {
  switch (answer.kind) {
    case 'grant': return { kind: 'grant', grant: answer.grant }
    case 'invalid_grant': {
      // The reason is one of two fixed wire codes, so it cannot carry body text.
      return { kind: 'invalid_grant', failure: claudeAccountFailure('invalid_grant', { reason: answer.reason }) }
    }
    case 'refused': return { kind: 'refused', failure: answer.failure }
    case 'unreachable': return { kind: 'unreachable', failure: answer.failure }
    case 'invalid': return { kind: 'invalid', failure: answer.failure }
  }
}

/**
 * Exchange one authorization code for a grant.
 *
 * The code and its verifier are the caller's one-time values. This sends one POST and reports the
 * outcome; a caller that calls it twice has sent two, and no exactly-once guarantee is claimed.
 * @param input - the code, the verifier, the redirect URI, the state and the shared seams.
 * @returns the validated grant or the typed reason there is none.
 */
export async function exchangeAuthorizationCode(input: ClaudeAuthorizationCodeExchange): Promise<ClaudeTokenOutcome> {
  if (input.code.length === 0 || input.codeVerifier.length === 0
    || input.redirectUri.length === 0 || input.state.length === 0) {
    return { kind: 'invalid', failure: claudeAccountFailure('invalid_input', { reason: 'incomplete_code_exchange' }) }
  }
  return await requestClaudeGrant(input, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.profile.clientId,
    code_verifier: input.codeVerifier,
    state: input.state,
  }, input.profile.scopes)
}

/**
 * Refresh one account's grant.
 *
 * The client id and the token endpoint are the CC child's own, not the parent keeper's. A timeout
 * is reported as a timeout: this module never deletes, overwrites or commits a credential, and a
 * caller that replaced its stored one on this outcome would be acting on nothing this call said.
 * @param input - the refresh token, the granted scopes and the shared seams.
 * @returns the rotated grant or the typed reason there is none.
 */
export async function refreshTokenGrant(input: ClaudeRefreshGrantRequest): Promise<ClaudeTokenOutcome> {
  if (input.refreshToken.length === 0) {
    return { kind: 'invalid', failure: claudeAccountFailure('invalid_input', { reason: 'empty_refresh_token' }) }
  }
  const scopes = refreshScopeString(input.scopes)
  return await requestClaudeGrant(input, {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.profile.clientId,
    // The client never asks for `org:create_api_key` when refreshing; that scope belongs to the
    // authorize request. Everything else the account was granted is echoed back.
    scope: scopes,
  }, scopes)
}
