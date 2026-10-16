/**
 * Account-profile maintenance: when a bound account's profile is read, what of a response
 * is adopted, and what a failed read means.
 *
 * A profile read is one bounded `GET` through the caller's injected reader. It never
 * blocks a session on its own, never stores the raw response body, and never turns a
 * temporary failure into a credential problem. Identity is verified before anything is
 * merged, so a response for another account is refused rather than mixed into this one.
 */

import type { ClaudeSession } from '../auth/store.js'
import {
  claudeProfileFreshness,
  claudeProfileCompleteness,
  claudeProfileMatchesIdentity,
  mergeClaudeProfile,
  sameClaudeIdentity,
} from './claude-account-state.js'
import type {
  ClaudeAccountIdentity,
  ClaudeMaintenanceFailure,
  ClaudeProfileFields,
  ClaudeProfileRecord,
} from './claude-account-state.js'

/** The OAuth scope that permits reading the account profile. */
export const CLAUDE_PROFILE_SCOPE = 'user:profile'

/**
 * Read one account's profile.
 *
 * Implemented by the Claude protocol module, which owns the endpoint, its headers and the
 * one allowed reauthorization replay. The result is a structured outcome rather than an
 * empty object, so a refusal, a cancellation and a missing profile stay distinguishable.
 * @param request - the account, its access token and the caller's cancellation.
 * @returns the structured read result.
 */
export type ClaudeProfileReader = (request: ClaudeProfileReadRequest) => Promise<ClaudeProfileReadResult>

/** One profile read request. */
export interface ClaudeProfileReadRequest {
  /** Canonical account key the credential belongs to. */
  account: string
  /** Access token to authenticate with. */
  accessToken: string
  /** Caller cancellation; the reader must stop without adopting anything. */
  signal: AbortSignal
}

/** A profile read that produced usable fields. */
export interface ClaudeProfileReadOk {
  readonly outcome: 'ok'
  /** The validated fields the response disclosed; never the raw body. */
  readonly fields: ClaudeProfileFields
  /**
   * The reader's completeness verdict: whether the account metadata the pinned client
   * requires to skip its profile fetch is present and current. Absent reads as incomplete,
   * so a reader that does not compute it never has a record treated as complete.
   */
  readonly complete?: boolean
  /** The completeness contract the verdict was computed under; defaults to this build's. */
  readonly completenessVersion?: number
}

/** A profile read that produced no fields. */
export interface ClaudeProfileReadFailure {
  readonly outcome: 'cancelled' | 'unauthorized' | 'refused' | 'missing' | 'invalid' | 'unreachable'
  /** Structured provider facts; the unified classifier's own record is assignable here. */
  readonly failure?: ClaudeMaintenanceFailure
}

/** The structured result of one profile read. */
export type ClaudeProfileReadResult = ClaudeProfileReadOk | ClaudeProfileReadFailure

/** Why a profile read is or is not started, and the status the view reports. */
export type ClaudeProfileReadReason =
  /** A read runs because no record exists for this identity. */
  | 'missing-record'
  /** A read runs because a required field is absent. */
  | 'incomplete'
  /** A read runs because the record passed the freshness baseline. */
  | 'stale'
  /** A read runs because the stored record belongs to another identity. */
  | 'identity-changed'
  /** The record is complete and fresh. */
  | 'fresh'
  /** No credential is stored. */
  | 'no-credential'
  /** The granted scopes do not include the profile capability. */
  | 'scope-missing'
  /** No protocol-level reader is wired into this deployment. */
  | 'reader-unavailable'
  /** A previous failure is still cooling down. */
  | 'cooling'

/** The decision to read, with the reason the status view reports. */
export interface ClaudeProfileReadDecision {
  needed: boolean
  reason: ClaudeProfileReadReason
}

/** What the decision to read one account's profile reads. */
export interface ClaudeProfileDecisionInput {
  /** The record already held for this identity, when there is one. */
  record?: ClaudeProfileRecord
  /** Identity of the binding the read would serve. */
  identity: ClaudeAccountIdentity
  /** Account UUID already confirmed for this identity, when known. */
  knownAccountUuid?: string
  /** Whether a usable credential is stored. */
  hasCredential: boolean
  /** Whether the stored credential's granted scopes include {@link CLAUDE_PROFILE_SCOPE}. */
  hasProfileScope: boolean
  /** Current epoch milliseconds. */
  now: number
  /** Validated freshness baseline. */
  maxAgeMs: number
  /** Epoch milliseconds before which a failed read is not retried. */
  retryAfter?: number
}

/**
 * Decide whether to read one account's profile now.
 *
 * A missing or incomplete record, a record past the freshness baseline, or a record that
 * belongs to another identity all call for one read. An explicitly unknown subscription
 * type is a complete answer and does not by itself justify another read.
 * @param input - the record, identity and credential state.
 * @returns whether a read is needed and why.
 */
export function claudeProfileReadDecision(input: ClaudeProfileDecisionInput): ClaudeProfileReadDecision {
  if (!input.hasCredential) return { needed: false, reason: 'no-credential' }
  if (!input.hasProfileScope) return { needed: false, reason: 'scope-missing' }
  if (input.retryAfter !== undefined && input.now < input.retryAfter) {
    return { needed: false, reason: 'cooling' }
  }
  const record = input.record
  if (record === undefined) return { needed: true, reason: 'missing-record' }
  if (!sameClaudeIdentity(record.identity, input.identity)) {
    return { needed: true, reason: 'identity-changed' }
  }
  const completeness = claudeProfileCompleteness(record)
  if (!completeness.complete) return { needed: true, reason: 'incomplete' }
  if (claudeProfileFreshness(record, input.now, input.maxAgeMs) === 'stale') {
    return { needed: true, reason: 'stale' }
  }
  return { needed: false, reason: 'fresh' }
}

/**
 * Whether a stored session's granted scopes include the profile capability.
 * @param session - the stored session, when there is one.
 * @returns true when the profile may be read without asking for anything else.
 */
export function claudeHasProfileScope(session: ClaudeSession | undefined): boolean {
  if (session === undefined) return false
  return session.scopes.split(/\s+/u).includes(CLAUDE_PROFILE_SCOPE)
}

/** What one profile read produced for the caller's record. */
export type ClaudeProfileOutcome =
  /** The response was adopted; the record replaces the caller's copy. */
  | { readonly outcome: 'accepted'; readonly record: ClaudeProfileRecord }
  /** The response named another account; nothing was adopted and maintenance must stop. */
  | { readonly outcome: 'identity-changed'; readonly failure?: ClaudeMaintenanceFailure }
  /** The read failed; the previous record is kept. */
  | {
    readonly outcome: 'failed'
    /** Whether the failure is worth another bounded attempt. */
    readonly retryable: boolean
    /** Whether the failure forbids every further automatic attempt. */
    readonly stop: boolean
    readonly failure?: ClaudeMaintenanceFailure
  }
  /** The caller cancelled; nothing was adopted. */
  | { readonly outcome: 'cancelled' }

/** Everything one profile read needs. */
export interface ClaudeProfileReadInput {
  /** Identity the read is made under. */
  identity: ClaudeAccountIdentity
  /** Canonical account key. */
  account: string
  /** Access token to authenticate with. */
  accessToken: string
  /** Credential revision the read is made under. */
  credentialRevision: number
  /** UUID already confirmed for this identity, when known. */
  knownAccountUuid?: string
  /** The record being updated, when there is one. */
  previous?: ClaudeProfileRecord
  /** Current epoch milliseconds, recorded as the acceptance time. */
  now: number
  /** The injected protocol-level reader. */
  reader: ClaudeProfileReader
  /** Caller cancellation. */
  signal: AbortSignal
}

/**
 * Run one profile read and adopt its validated fields.
 *
 * A response is adopted only when it belongs to the identity the read was made for; an
 * explicit refusal or a failure that forbids retry stops future automatic attempts, while
 * a transport failure keeps the previous record and stays retryable.
 * @param input - the identity, credential, previous record and reader.
 * @returns what the read produced.
 */
export async function readClaudeProfile(input: ClaudeProfileReadInput): Promise<ClaudeProfileOutcome> {
  let result: ClaudeProfileReadResult
  try {
    result = await input.reader({
      account: input.account,
      accessToken: input.accessToken,
      signal: input.signal,
    })
  } catch (error: unknown) {
    if (input.signal.aborted) return { outcome: 'cancelled' }
    // The reader reports provider outcomes as values; an exception here is a defect or an
    // interruption, and its message may quote a response body. Only a fixed code reaches
    // the status view, which is what keeps a token or a prompt out of it.
    void error
    return {
      outcome: 'failed',
      retryable: true,
      stop: false,
      failure: claudeProfileFailure('unreachable', input, 'UNEXPECTED_PROFILE_READ'),
    }
  }
  switch (result.outcome) {
    case 'ok': {
      const known = {
        ...input.knownAccountUuid === undefined ? {} : { accountUuid: input.knownAccountUuid },
      }
      if (!claudeProfileMatchesIdentity(input.identity, known, result.fields)) {
        return { outcome: 'identity-changed' }
      }
      return {
        outcome: 'accepted',
        record: mergeClaudeProfile(input.previous, {
          identity: input.identity,
          fields: result.fields,
          capturedAt: input.now,
          credentialRevision: input.credentialRevision,
          // The reader's verdict is the whole completeness input: a reader that reported
          // none leaves the record incomplete rather than being guessed at from the fields.
          complete: result.complete === true,
          ...result.completenessVersion === undefined ? {} : { completenessVersion: result.completenessVersion },
        }),
      }
    }
    case 'cancelled':
      return { outcome: 'cancelled' }
    case 'refused':
      return {
        outcome: 'failed',
        retryable: false,
        stop: true,
        ...result.failure === undefined ? {} : { failure: result.failure },
      }
    case 'unauthorized':
      return {
        outcome: 'failed',
        retryable: result.failure?.retryDisposition !== 'forbid',
        stop: result.failure?.retryDisposition === 'forbid',
        ...result.failure === undefined ? {} : { failure: result.failure },
      }
    case 'missing':
    case 'invalid':
    case 'unreachable':
      return {
        outcome: 'failed',
        retryable: result.failure?.retryDisposition !== 'forbid',
        stop: result.failure?.retryDisposition === 'forbid',
        // A reader that reported no structured decision still produces one, so the status
        // view names why the profile was not adopted instead of showing a bare failure.
        failure: result.failure ?? claudeProfileFailure(result.outcome, input),
      }
  }
}

/** The structured failure facts for one reader outcome that carried none of its own. */
function claudeProfileFailure(
  outcome: 'missing' | 'invalid' | 'unreachable',
  input: ClaudeProfileReadInput,
  overrideReason?: string,
): ClaudeMaintenanceFailure {
  const reason = overrideReason ?? (outcome === 'missing'
    ? 'PROFILE_MISSING'
    : outcome === 'invalid' ? 'PROFILE_INVALID' : 'PROFILE_UNREACHABLE')
  return {
    reason,
    stage: 'profile',
    scope: 'account',
    origin: input.identity.origin,
    protocolFingerprint: input.identity.protocolFingerprint,
  }
}
