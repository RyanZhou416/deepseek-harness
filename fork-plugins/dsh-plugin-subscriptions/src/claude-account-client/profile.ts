/**
 * The strict profile reader: one account's own identity as the service states it.
 *
 * The document is validated at the wire shape the endpoint serves — `account` and `organization`
 * are two objects with their own fields — so a document missing either is not adopted: reading it
 * would attach half an identity to an account. The completeness verdict is the analyzed client's
 * own criteria, and a client-version refusal found on this read keeps its own outcome rather than
 * being reported as missing data.
 *
 * This module never refreshes a profile by itself. A caller that wires the optional replay hook
 * gets at most one replay, and the response it produces is validated against the same pinned
 * identity as the first, so an old account cannot be adopted through a replaced credential.
 *
 * @module dsh-plugin-subscriptions/claude-account-client/profile
 */

import { claudeAccountFailure, classifyClaudeRefusal } from './failure.js'
import type { ClaudeAccountFailure } from './failure.js'
import { claudeFirstString, claudeOwnField, claudeRecord } from './json.js'
import { claudeAccountProfileFailure } from './protocol.js'
import type { ClaudeAccountClientProfile } from './protocol.js'
import { CLAUDE_SYSTEM_TIMERS, exchangeClaudeRequest } from './wire.js'
import type {
  ClaudeAccountResponse,
  ClaudeAccountTimers,
  ClaudeAccountTransport,
  ClaudeResponseBody,
} from './wire.js'

/** The pinned bound on one profile read. */
export const CLAUDE_PROFILE_TIMEOUT_MS = 10_000

/**
 * The bound on a profile body this reader consumes, in bytes.
 *
 * This is this build's own product guard, not a pinned constant of the analyzed client, whose own
 * transport applies no fixed byte cap. A profile document is a fixed small shape, so a body over
 * this bound is one this route refuses rather than reads whole.
 */
export const CLAUDE_PROFILE_BODY_LIMIT = 65_536

/** The one replay an authentication rejection may produce, when the caller wired a hook for it. */
export const CLAUDE_PROFILE_AUTH_REPLAY_BUDGET = 1

/**
 * The identity a caller already holds.
 *
 * A field that is present and differs from the document's own is a mismatch, not a refresh: the
 * caller's stored account is what its remaining state belongs to.
 */
export interface ClaudeProfileIdentity {
  /** The account uuid the caller pinned. */
  readonly accountUuid?: string
  /** The organization uuid the caller pinned. */
  readonly organizationUuid?: string
}

/**
 * The safe projection of one validated profile document.
 *
 * Only these fields leave the reader. The raw document, its timestamps and its onboarding flag
 * body are not returned: the verdict needs to know whether those fields were stated, and a caller
 * that needs a date reads its own projection from the same source.
 */
export interface ClaudeStrictProfile {
  /** `account.uuid`; required by the endpoint's own schema. */
  readonly accountUuid: string
  /** `account.email`; required by the endpoint's own schema. */
  readonly email: string
  /** `organization.uuid`; required by the endpoint's own schema. */
  readonly organizationUuid: string
  /** `organization.billing_type`, when the organization stated a string. */
  readonly billingType?: string
  /** The subscription type; `null` is the value the document stated, absence is different. */
  readonly subscriptionType?: string | null
  /** Whether `account.created_at` was stated with a value. */
  readonly accountCreated: boolean
  /** Whether `organization.subscription_created_at` was stated with a value. */
  readonly subscriptionCreated: boolean
  /** Whether `organization.cc_onboarding_flags` was stated with a value. */
  readonly onboardingFlags: boolean
  /**
   * The analyzed client's own completeness verdict.
   *
   * It needs the organization's stated billing type, the account's creation time and the
   * organization's subscription creation time. The onboarding flags are normalised to `{}` when
   * absent, so they never make a document incomplete, and the subscription type is deliberately
   * outside the test: an unknown plan is a complete answer.
   */
  readonly complete: boolean
}

/** Everything one strict profile read needs. */
export interface ClaudeStrictProfileRead {
  /** The access token this read carries; the caller selected and may have refreshed it. */
  readonly accessToken: string
  /** The explicit pinned profile the endpoint comes from. */
  readonly profile: ClaudeAccountClientProfile
  /** The injected transport, which carries the account's egress. */
  readonly transport: ClaudeAccountTransport
  /** The identity the caller already holds; a conflicting document is refused. */
  readonly expected?: ClaudeProfileIdentity
  /** The caller's zero-I/O predicate for whether this read is needed; `false` sends nothing. */
  readonly required?: () => boolean
  /**
   * Re-judged before every attempt, including the replay.
   *
   * The caller owns what this guard watches; the reader only honours its answer. `false` sends
   * nothing, so a policy that changed between attempts stops the request rather than racing it.
   */
  readonly beforeRequest?: (attempt: number) => boolean
  /**
   * The credential owner's one replay after a rejection.
   *
   * It is called at most once, only for an authentication rejection that is not a client-version
   * refusal, and this reader refreshes nothing itself.
   * @returns the replacement access token.
   */
  readonly reauthorize?: () => Promise<string>
  /** The injected deadline scheduler; defaults to the process timer. */
  readonly timers?: ClaudeAccountTimers
  /** Bound on the read; defaults to {@link CLAUDE_PROFILE_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Caller cancellation. */
  readonly signal?: AbortSignal
}

/** What one strict profile read disclosed, or why it disclosed nothing. */
export type ClaudeProfileOutcome =
  /** The document was validated; the caller owns adopting it. */
  | { readonly kind: 'profile'; readonly profile: ClaudeStrictProfile }
  /** The caller's `required` hook said no read was needed; nothing was sent. */
  | { readonly kind: 'not-required' }
  /** The caller's `beforeRequest` guard withheld the attempt; nothing was sent. */
  | { readonly kind: 'withheld' }
  /** The caller cancelled. */
  | { readonly kind: 'cancelled'; readonly failure: ClaudeAccountFailure }
  /** The credential was rejected; its owner may replay exactly once. */
  | { readonly kind: 'unauthorized'; readonly failure: ClaudeAccountFailure }
  /** The service refused this read; no retry and no switch to another account. */
  | { readonly kind: 'refused'; readonly failure: ClaudeAccountFailure }
  /** No usable answer arrived, or the endpoint failed transiently. */
  | { readonly kind: 'unreachable'; readonly failure: ClaudeAccountFailure }
  /** The document, or the request itself, could not be validated. */
  | { readonly kind: 'invalid'; readonly failure: ClaudeAccountFailure }

/** The answer one profile response produced, before it is mapped to a caller-facing outcome. */
type ClaudeProfileAnswer =
  | { readonly kind: 'profile'; readonly profile: ClaudeStrictProfile }
  | { readonly kind: 'unauthorized'; readonly failure: ClaudeAccountFailure }
  | { readonly kind: 'refused'; readonly failure: ClaudeAccountFailure }
  | { readonly kind: 'unreachable'; readonly failure: ClaudeAccountFailure }
  | { readonly kind: 'invalid'; readonly failure: ClaudeAccountFailure }

/** The parse of one validated profile document, or the fixed reason it was refused. */
type ClaudeProfileParse =
  | { readonly profile: ClaudeStrictProfile }
  | { readonly code: 'invalid' | 'identity_mismatch'; readonly reason: string }

/**
 * Validate one parsed profile document into the safe projection.
 *
 * The three identity fields are required exactly as the endpoint's own schema spells them, the
 * completeness criteria read the billing type from the organization and not from the root, and a
 * pinned identity that the document contradicts is a mismatch rather than a newer answer.
 * @param raw - the parsed response document.
 * @param expected - the identity the caller already holds, when it holds one.
 * @returns the projection, or the fixed reason the document was refused.
 */
export function parseClaudeStrictProfile(raw: unknown, expected?: ClaudeProfileIdentity): ClaudeProfileParse {
  const root = claudeRecord(raw)
  if (root === undefined) return { code: 'invalid', reason: 'malformed_profile' }
  const account = claudeRecord(root['account'])
  const organization = claudeRecord(root['organization'])
  const accountUuid = claudeFirstString(account?.['uuid'])
  const email = claudeFirstString(account?.['email'])
  const organizationUuid = claudeFirstString(organization?.['uuid'])
  if (accountUuid === undefined || email === undefined || organizationUuid === undefined) {
    return { code: 'invalid', reason: 'missing_identity' }
  }
  if (expected?.accountUuid !== undefined && expected.accountUuid !== accountUuid) {
    return { code: 'identity_mismatch', reason: 'account_mismatch' }
  }
  if (expected?.organizationUuid !== undefined && expected.organizationUuid !== organizationUuid) {
    return { code: 'identity_mismatch', reason: 'organization_mismatch' }
  }
  // The subscription type is read by own-field presence: the wire spells it three ways, and an
  // explicit null in the first is that account's stated value, not a reason to read the next.
  const subscription = [
    claudeOwnField(root, 'subscriptionType'),
    claudeOwnField(root, 'subscription_type'),
    claudeOwnField(account, 'subscription_type'),
  ].find(candidate => candidate.present)
  const subscriptionValue = subscription?.value
  const billing = claudeOwnField(organization, 'billing_type')
  const created = claudeOwnField(account, 'created_at')
  const subscriptionCreated = claudeOwnField(organization, 'subscription_created_at')
  const onboarding = claudeOwnField(organization, 'cc_onboarding_flags')
  const billingType = claudeFirstString(billing.value)
  return {
    profile: {
      accountUuid,
      email,
      organizationUuid,
      // The billing type belongs to the organization — that is where the client reads it — so a
      // root-level `billing_type` is not this field.
      ...billingType === undefined ? {} : { billingType },
      ...typeof subscriptionValue === 'string' && subscriptionValue.length > 0
        ? { subscriptionType: subscriptionValue }
        : subscriptionValue === null ? { subscriptionType: null } : {},
      accountCreated: created.present && created.value !== undefined,
      subscriptionCreated: subscriptionCreated.present && subscriptionCreated.value !== null,
      onboardingFlags: onboarding.present && onboarding.value !== null && onboarding.value !== undefined,
      complete: billing.present && billing.value !== null && billing.value !== undefined
        && created.present && created.value !== undefined
        && subscriptionCreated.present && subscriptionCreated.value !== null,
    },
  }
}

/**
 * Read one profile response inside the deadline.
 * @param response - the response the profile endpoint returned.
 * @param body - the owned body of that response, read exactly once here.
 * @param expected - the identity the caller already holds, when it holds one.
 * @returns the typed answer, with every failure a fixed code and no response text.
 */
async function readClaudeProfileAnswer(
  response: ClaudeAccountResponse,
  body: ClaudeResponseBody,
  expected: ClaudeProfileIdentity | undefined,
): Promise<ClaudeProfileAnswer> {
  if (response.redirected === true) {
    return {
      kind: 'invalid',
      failure: claudeAccountFailure('redirected', { status: response.status, reason: 'redirected' }),
    }
  }
  const accepted = response.status >= 200 && response.status < 300
  let consumed: { text: string; truncated: boolean } | undefined
  try {
    consumed = await body.read(CLAUDE_PROFILE_BODY_LIMIT)
  } catch {
    consumed = undefined
  }
  if (!accepted) {
    // The body is classified before any replay decision, so a client-version refusal carried on a
    // 401 keeps its own outcome and never spends the one authentication replay.
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
  if (consumed === undefined) {
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
  let raw: unknown
  try {
    raw = JSON.parse(consumed.text)
  } catch {
    return {
      kind: 'invalid',
      failure: claudeAccountFailure('invalid', { status: response.status, reason: 'malformed_profile' }),
    }
  }
  const parsed = parseClaudeStrictProfile(raw, expected)
  if ('profile' in parsed) return { kind: 'profile', profile: parsed.profile }
  return {
    kind: 'invalid',
    failure: claudeAccountFailure(parsed.code, { status: response.status, reason: parsed.reason }),
  }
}

/**
 * Map one response answer to the caller-facing outcome.
 * @param answer - what the profile response produced.
 * @returns the outcome the caller switches on.
 */
function claudeProfileAnswerOutcome(answer: ClaudeProfileAnswer): ClaudeProfileOutcome {
  switch (answer.kind) {
    case 'profile': return { kind: 'profile', profile: answer.profile }
    case 'unauthorized': return { kind: 'unauthorized', failure: answer.failure }
    case 'refused': return { kind: 'refused', failure: answer.failure }
    case 'unreachable': return { kind: 'unreachable', failure: answer.failure }
    case 'invalid': return { kind: 'invalid', failure: answer.failure }
  }
}

/**
 * Read one account's profile, preserving why it disclosed nothing.
 *
 * The request is the analyzed client's own profile read: a bodyless GET carrying the plain user
 * agent, a JSON content type and `no-cache`, authenticated with the account's bearer token, under
 * the pinned ten-second bound. A deadline is reported as an unreachable read with a `timeout`
 * failure code, never as a rejection of the credential.
 * @param input - the token, the pinned profile, the transport and the optional hooks.
 * @returns the structured outcome of this read.
 */
export async function readClaudeStrictProfile(input: ClaudeStrictProfileRead): Promise<ClaudeProfileOutcome> {
  if (input.required?.() === false) return { kind: 'not-required' }
  const profileFailure = claudeAccountProfileFailure(input.profile)
  if (profileFailure !== undefined) return { kind: 'invalid', failure: profileFailure }
  const timeoutMs = input.timeoutMs ?? CLAUDE_PROFILE_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { kind: 'invalid', failure: claudeAccountFailure('invalid_input', { reason: 'timeout_ms' }) }
  }
  let attempt = 0
  let accessToken = input.accessToken
  for (;;) {
    if (input.beforeRequest?.(attempt) === false) return { kind: 'withheld' }
    const outcome = await exchangeClaudeRequest({
      url: input.profile.profileUrl,
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'user-agent': input.profile.userAgent,
        'content-type': 'application/json',
        'cache-control': 'no-cache',
      },
      body: null,
      timeoutMs,
      transport: input.transport,
      timers: input.timers ?? CLAUDE_SYSTEM_TIMERS,
      ...input.signal === undefined ? {} : { signal: input.signal },
    }, async (response, body) => await readClaudeProfileAnswer(response, body, input.expected))
    switch (outcome.kind) {
      case 'timeout': {
        return { kind: 'unreachable', failure: claudeAccountFailure('timeout', { reason: 'profile_deadline' }) }
      }
      case 'cancelled': return { kind: 'cancelled', failure: claudeAccountFailure('cancelled') }
      case 'unreachable': {
        return { kind: 'unreachable', failure: claudeAccountFailure('unreachable', { reason: 'transport' }) }
      }
      case 'handled': {
        const answer = outcome.value
        if (answer.kind !== 'unauthorized') return claudeProfileAnswerOutcome(answer)
        if (input.reauthorize === undefined || attempt >= CLAUDE_PROFILE_AUTH_REPLAY_BUDGET) {
          return { kind: 'unauthorized', failure: answer.failure }
        }
        attempt += 1
        let replacement: string
        try {
          replacement = await input.reauthorize()
        } catch {
          // The credential owner could not produce a replacement; the rejection stands as it was.
          return { kind: 'unauthorized', failure: answer.failure }
        }
        if (replacement.length === 0) return { kind: 'unauthorized', failure: answer.failure }
        accessToken = replacement
        continue
      }
    }
  }
}
