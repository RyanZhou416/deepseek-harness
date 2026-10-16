/**
 * The managed-settings reader: transfer and envelope validation only.
 *
 * This is the basic reader. It fetches the account's own managed-settings document, validates the
 * `{uuid, checksum, settings}` envelope the endpoint serves, and returns the settings record
 * exactly as the service stated it — unknown keys included. It deliberately projects nothing and
 * declares nothing enforced: which keys a deployment can safely apply, and which unsupported ones
 * must block an operation, is the caller's policy-consumer decision, and this reader cannot claim
 * a rule it did not interpret.
 *
 * The document is kept as a short-lived in-memory value. It is never stored, logged or merged into
 * configuration, an environment or a tool catalog.
 *
 * @module dsh-plugin-subscriptions/claude-account-client/settings
 */

import { claudeAccountFailure, classifyClaudeRefusal } from './failure.js'
import type { ClaudeAccountFailure } from './failure.js'
import { claudeAccountProfileFailure, CLAUDE_OAUTH_BETA } from './protocol.js'
import type { ClaudeAccountClientProfile } from './protocol.js'
import { CLAUDE_SYSTEM_TIMERS, exchangeClaudeRequest } from './wire.js'
import type {
  ClaudeAccountResponse,
  ClaudeAccountTimers,
  ClaudeAccountTransport,
  ClaudeResponseBody,
} from './wire.js'

/** The pinned bound on one settings read. */
export const CLAUDE_SETTINGS_TIMEOUT_MS = 10_000

/**
 * The bound on a settings body this reader consumes, in bytes.
 *
 * This is this build's own product guard, not a pinned constant of the analyzed client, whose own
 * transport applies no fixed byte cap. A body over it is refused outright and never re-pulled.
 */
export const CLAUDE_SETTINGS_BODY_LIMIT = 1_048_576

/**
 * Format one server checksum as an `If-None-Match` entity tag.
 *
 * The client sends the cached checksum quoted, and a value that already carries quotes is sent as
 * it arrived rather than double-quoted.
 * @param checksum - the server's checksum.
 * @returns the entity tag to send.
 */
export function claudeIfNoneMatch(checksum: string): string {
  return checksum.startsWith('"') && checksum.endsWith('"') ? checksum : `"${checksum}"`
}

/**
 * The validated envelope of a 200 response.
 *
 * `uuid` and `checksum` are response-level identifiers and `settings` is the policy object, kept
 * exactly as it arrived. A response missing any of the three is a parse error, never an empty
 * policy.
 */
export interface ClaudeManagedSettingsEnvelope {
  /** The envelope's own revision identifier. */
  readonly uuid: string
  /** The server's own checksum, sent back as `If-None-Match` on the next conditional read. */
  readonly checksum: string
  /** The settings record, with every key the service stated and none that it did not. */
  readonly settings: Record<string, unknown>
}

/**
 * Validate the fixed response envelope `{uuid, checksum, settings}`.
 *
 * The `settings` object is returned verbatim: this parser checks syntax and the three required
 * members only, so a key whose meaning is unknown to this build still reaches the caller that can
 * interpret it.
 * @param text - the bounded response body text.
 * @returns the envelope, or `undefined` when the body is not a valid envelope.
 */
export function parseClaudeManagedSettingsEnvelope(text: string): ClaudeManagedSettingsEnvelope | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const root = parsed as Record<string, unknown>
  const uuid = root['uuid']
  const checksum = root['checksum']
  const settings = root['settings']
  if (typeof uuid !== 'string' || uuid.length === 0) return undefined
  if (typeof checksum !== 'string' || checksum.length === 0) return undefined
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return undefined
  return { uuid, checksum, settings: settings as Record<string, unknown> }
}

/** The snapshot a caller may hold for one identity; a 304 is valid only against it. */
export interface ClaudeManagedSettingsCache {
  /** The revision the cached envelope carried. */
  readonly uuid: string
  /** The server checksum that made this snapshot conditional. */
  readonly checksum: string
}

/** Everything one managed-settings read needs. */
export interface ClaudeManagedSettingsRead {
  /** The access token this read carries; the caller selected and may have refreshed it. */
  readonly accessToken: string
  /** The explicit pinned profile the endpoint comes from. */
  readonly profile: ClaudeAccountClientProfile
  /** The injected transport, which carries the account's egress. */
  readonly transport: ClaudeAccountTransport
  /**
   * This identity's cached envelope, when the caller holds one.
   *
   * A 304 is valid only against a checksum this read actually sent, and the cached value is the
   * caller's own snapshot for the same account, organization and protocol profile — a snapshot of
   * another identity never contributes a validator.
   */
  readonly cached?: ClaudeManagedSettingsCache
  /** The caller's zero-I/O predicate for whether this read is needed; `false` sends nothing. */
  readonly required?: () => boolean
  /**
   * Re-judged before every attempt.
   *
   * The caller owns what this guard watches; the reader only honours its answer. `false` sends
   * nothing.
   */
  readonly beforeRequest?: (attempt: number) => boolean
  /** The injected deadline scheduler; defaults to the process timer. */
  readonly timers?: ClaudeAccountTimers
  /** Bound on the read; defaults to {@link CLAUDE_SETTINGS_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Caller cancellation. */
  readonly signal?: AbortSignal
}

/** What one managed-settings read produced. */
export type ClaudeManagedSettingsOutcome =
  /** A 200 envelope was validated. The caller owns adopting, projecting and enforcing it. */
  | { readonly kind: 'accepted'; readonly envelope: ClaudeManagedSettingsEnvelope }
  /** The endpoint's own empty-success statuses (204 and 404), accepted as an empty sentinel. */
  | { readonly kind: 'empty' }
  /** A 304 revalidated the caller's cached envelope for this identity. */
  | { readonly kind: 'unchanged'; readonly cache: ClaudeManagedSettingsCache }
  /** The caller's `required` hook said no read was needed; nothing was sent. */
  | { readonly kind: 'not-required' }
  /** The caller's `beforeRequest` guard withheld the attempt; nothing was sent. */
  | { readonly kind: 'withheld' }
  /** The caller cancelled. */
  | { readonly kind: 'cancelled'; readonly failure: ClaudeAccountFailure }
  /** The credential was rejected; its owner may refresh and retry exactly once. */
  | { readonly kind: 'unauthorized'; readonly failure: ClaudeAccountFailure }
  /** The service refused this read; no retry and no switch to another account. */
  | { readonly kind: 'refused'; readonly failure: ClaudeAccountFailure }
  /** No usable answer arrived, or the endpoint failed transiently; the caller keeps its snapshot. */
  | { readonly kind: 'unreachable'; readonly failure: ClaudeAccountFailure }
  /** The envelope or the request could not be validated; the caller keeps its snapshot. */
  | { readonly kind: 'invalid'; readonly failure: ClaudeAccountFailure }

/** The answer one settings response produced, before it is mapped to a caller-facing outcome. */
type ClaudeSettingsAnswer =
  | { readonly kind: 'accepted'; readonly envelope: ClaudeManagedSettingsEnvelope }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unchanged'; readonly cache: ClaudeManagedSettingsCache }
  | { readonly kind: 'unauthorized'; readonly failure: ClaudeAccountFailure }
  | { readonly kind: 'refused'; readonly failure: ClaudeAccountFailure }
  | { readonly kind: 'unreachable'; readonly failure: ClaudeAccountFailure }
  | { readonly kind: 'invalid'; readonly failure: ClaudeAccountFailure }

/**
 * Read one settings response inside the deadline.
 *
 * The statuses follow the analyzed client: 200 validates the envelope, 204 and 404 are the
 * endpoint's own empty-success semantics, a 304 is valid only against a validator this read sent,
 * and every body is consumed or released on every path.
 * @param response - the response the settings endpoint returned.
 * @param body - the owned body of that response, read exactly once here.
 * @param cached - the caller's snapshot for this identity, when it sent a validator from one.
 * @returns the typed answer, with every failure a fixed code and no response text.
 */
async function readClaudeSettingsAnswer(
  response: ClaudeAccountResponse,
  body: ClaudeResponseBody,
  cached: ClaudeManagedSettingsCache | undefined,
): Promise<ClaudeSettingsAnswer> {
  if (response.redirected === true) {
    return {
      kind: 'invalid',
      failure: claudeAccountFailure('redirected', { status: response.status, reason: 'redirected' }),
    }
  }
  if (response.status === 304) {
    // Only a validator actually sent can be revalidated. The exchange releases the body of this
    // branch, so an unsolicited 304 costs no pinned connection either.
    if (cached === undefined) {
      return {
        kind: 'invalid',
        failure: claudeAccountFailure('invalid', { status: 304, reason: 'unexpected_304' }),
      }
    }
    return { kind: 'unchanged', cache: cached }
  }
  if (response.status === 204 || response.status === 404) return { kind: 'empty' }
  if (response.status >= 200 && response.status < 300) {
    let consumed: { text: string; truncated: boolean }
    try {
      consumed = await body.read(CLAUDE_SETTINGS_BODY_LIMIT)
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
    const envelope = parseClaudeManagedSettingsEnvelope(consumed.text)
    if (envelope === undefined) {
      return {
        kind: 'invalid',
        failure: claudeAccountFailure('invalid', { status: response.status, reason: 'malformed_envelope' }),
      }
    }
    return { kind: 'accepted', envelope }
  }
  let consumed: { text: string; truncated: boolean } | undefined
  try {
    consumed = await body.read(CLAUDE_SETTINGS_BODY_LIMIT)
  } catch {
    consumed = undefined
  }
  const text = consumed === undefined || consumed.truncated ? '' : consumed.text
  const refusal = classifyClaudeRefusal(response.status, text)
  if (refusal.failure.code === 'client_version_unsupported') return { kind: 'refused', failure: refusal.failure }
  if (response.status >= 500 || response.status === 429 || response.status === 408) {
    return {
      kind: 'unreachable',
      failure: claudeAccountFailure('unreachable', { status: response.status, reason: 'http_status' }),
    }
  }
  if (refusal.unauthorized) return { kind: 'unauthorized', failure: refusal.failure }
  return { kind: 'refused', failure: refusal.failure }
}

/**
 * Map one response answer to the caller-facing outcome.
 * @param answer - what the settings response produced.
 * @returns the outcome the caller switches on.
 */
function claudeSettingsAnswerOutcome(answer: ClaudeSettingsAnswer): ClaudeManagedSettingsOutcome {
  switch (answer.kind) {
    case 'accepted': return { kind: 'accepted', envelope: answer.envelope }
    case 'empty': return { kind: 'empty' }
    // A revalidation answers for exactly the snapshot whose checksum was sent; the caller's own
    // uuid and checksum are what it keeps, and this reader invents neither.
    case 'unchanged': return { kind: 'unchanged', cache: answer.cache }
    case 'unauthorized': return { kind: 'unauthorized', failure: answer.failure }
    case 'refused': return { kind: 'refused', failure: answer.failure }
    case 'unreachable': return { kind: 'unreachable', failure: answer.failure }
    case 'invalid': return { kind: 'invalid', failure: answer.failure }
  }
}

/**
 * Read the account's managed settings once.
 *
 * The request is the analyzed client's own settings read: a bodyless GET with the settings role's
 * headers — the plain user agent, the OAuth beta, a JSON accept and both cache directives — plus
 * the quoted cached checksum when there is one, authenticated with the account's bearer token and
 * bounded at ten seconds. A redirected response is never read as the pinned endpoint.
 * @param input - the token, the pinned profile, the transport, the optional cache and the hooks.
 * @returns the structured outcome of this read.
 */
export async function readClaudeManagedSettings(
  input: ClaudeManagedSettingsRead,
): Promise<ClaudeManagedSettingsOutcome> {
  if (input.required?.() === false) return { kind: 'not-required' }
  const profileFailure = claudeAccountProfileFailure(input.profile)
  if (profileFailure !== undefined) return { kind: 'invalid', failure: profileFailure }
  const timeoutMs = input.timeoutMs ?? CLAUDE_SETTINGS_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { kind: 'invalid', failure: claudeAccountFailure('invalid_input', { reason: 'timeout_ms' }) }
  }
  const cached = input.cached !== undefined && input.cached.checksum.length > 0 ? input.cached : undefined
  const validator = cached === undefined ? undefined : claudeIfNoneMatch(cached.checksum)
  if (input.beforeRequest?.(0) === false) return { kind: 'withheld' }
  const outcome = await exchangeClaudeRequest({
    url: input.profile.settingsUrl,
    method: 'GET',
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      'user-agent': input.profile.userAgent,
      'anthropic-beta': CLAUDE_OAUTH_BETA,
      'accept': 'application/json',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
      ...validator === undefined ? {} : { 'if-none-match': validator },
    },
    body: null,
    timeoutMs,
    transport: input.transport,
    timers: input.timers ?? CLAUDE_SYSTEM_TIMERS,
    ...input.signal === undefined ? {} : { signal: input.signal },
  }, async (response, body) => await readClaudeSettingsAnswer(response, body, cached))
  switch (outcome.kind) {
    case 'handled': return claudeSettingsAnswerOutcome(outcome.value)
    case 'timeout': {
      return { kind: 'unreachable', failure: claudeAccountFailure('timeout', { reason: 'settings_deadline' }) }
    }
    case 'cancelled': return { kind: 'cancelled', failure: claudeAccountFailure('cancelled') }
    case 'unreachable': {
      return { kind: 'unreachable', failure: claudeAccountFailure('unreachable', { reason: 'transport' }) }
    }
  }
}
