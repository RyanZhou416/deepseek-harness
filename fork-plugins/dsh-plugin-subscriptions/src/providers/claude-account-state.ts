/**
 * Pure state vocabulary for Claude account maintenance: identity keys, credential and
 * profile records, subscription eligibility, policy status, deployment config and the
 * clock/scheduler seam.
 *
 * This module performs no I/O. Everything here is a value a caller can compute from data
 * it already holds, which is what keeps the maintenance owner's decisions testable without
 * sleep, network or a real credential store.
 */

import type { ClaudeSession } from '../auth/store.js'

/**
 * Structured provider failure facts a maintenance read carries back.
 *
 * A redundant structural view of the subscription plugin's failure decision: a wider
 * record — for example the one the unified classifier owns — is assignable here, so the
 * maintenance modules read the facts they need without owning a second vocabulary. The
 * `reason` is what the caller switches on; the rest is diagnosis.
 */
export interface ClaudeMaintenanceFailure {
  /** Stable machine reason for the failure. */
  readonly reason: string
  /** Provider's own error code, when the response carried one. */
  readonly serverCode?: string
  /** HTTP status observed at the provider boundary, when there was one. */
  readonly status?: number
  /** Stage of the read that failed. */
  readonly stage?: string
  /** How far the failure reaches: for example one account, one protocol configuration. */
  readonly scope?: string
  /**
   * Whether automatic recovery may still run. The service vocabulary is
   * `'forbid' | 'allow'`; maintenance stops only on `'forbid'`.
   */
  readonly retryDisposition?: 'forbid' | 'allow'
  /** Positive provider-requested delay before any retry, when the response stated one. */
  readonly retryAfterMs?: number
  /** Whether output had already been delivered when the failure was observed. */
  readonly outputDelivered?: boolean
  /** Provider origin the read addressed. */
  readonly origin?: string
  /** Protocol configuration fingerprint the read ran under. */
  readonly protocolFingerprint?: string
}

/** Time source; injected so every deadline is deterministic under test. */
export interface ClaudeClock {
  /** Current epoch milliseconds. */
  now(): number
}

/** A scheduled callback that can be cancelled. */
export interface ClaudeTimer {
  /** Stop the callback; a no-op once it has run or was already cancelled. */
  cancel(): void
}

/** Timer source; injected so no maintenance decision depends on wall-clock sleeping. */
export interface ClaudeScheduler {
  /**
   * Run `run` once, `delayMs` from now.
   * @param delayMs - non-negative delay in milliseconds.
   * @param run - the callback to run.
   * @returns the handle that cancels the pending callback.
   */
  setTimer(delayMs: number, run: () => void): ClaudeTimer
}

/** The process clock. */
export const systemClaudeClock: ClaudeClock = { now: () => Date.now() }

/** The process timer source; a pending callback never keeps the process alive. */
export const systemClaudeScheduler: ClaudeScheduler = {
  setTimer: (delayMs, run) => {
    const handle = setTimeout(run, delayMs)
    handle.unref?.()
    return { cancel: () => { clearTimeout(handle) } }
  },
}

/**
 * Canonical, non-secret identity of one maintained Claude account.
 *
 * The key is the account reference together with what the credential and protocol
 * configuration confirm about it: a token rotation keeps it, a logout, re-login,
 * organization switch, origin change or protocol-configuration change replaces it.
 */
export interface ClaudeAccountIdentity {
  /** Canonical store account key. */
  account: string
  /** Provider origin the account is served from. */
  origin: string
  /** Fingerprint of the protocol configuration the account's requests run under. */
  protocolFingerprint: string
  /** Confirmed organization, when one is known; absent is not a different organization. */
  organization?: string
}

/**
 * Stable key for one identity, for maps and for comparing a late response against the
 * identity its work started under. Derived from account and organization references and
 * configuration identifiers only — never from a token.
 * @param identity - the identity to key.
 * @returns a single string that differs whenever the identity does.
 */
export function claudeIdentityKey(identity: ClaudeAccountIdentity): string {
  return JSON.stringify([
    identity.account,
    identity.organization ?? null,
    identity.origin,
    identity.protocolFingerprint,
  ])
}

/**
 * Whether two identities are the same account under the same configuration.
 *
 * An organization confirmed on one side only is the same identity: the confirmation adds
 * a fact rather than changing the account. Two different confirmed organizations are not.
 * @param left - one identity.
 * @param right - the other identity.
 * @returns true when a record made under `left` may still serve `right`.
 */
export function sameClaudeIdentity(left: ClaudeAccountIdentity, right: ClaudeAccountIdentity): boolean {
  if (left.account !== right.account) return false
  if (left.origin !== right.origin) return false
  if (left.protocolFingerprint !== right.protocolFingerprint) return false
  if (left.organization === undefined || right.organization === undefined) return true
  return left.organization === right.organization
}

/** How one subscription type reads, without guessing a plan from anything else. */
export type ClaudeSubscriptionClass =
  /** A confirmed pro or max subscription. */
  | 'pro-max'
  /** A confirmed subscription that is not pro/max. */
  | 'other-subscription'
  /** No subscription type is stated, or the stated value is empty. */
  | 'unknown'

/**
 * Classify a subscription type.
 *
 * Only the values the pinned client itself treats as personal pro/max classify as
 * `pro-max`; a product name, an account alias, an empty string or an absent field never
 * does. `null` is an explicit statement that no subscription type is readable, which is
 * still `unknown` — the pinned client's own null branch.
 * @param value - the subscription type from a validated profile response or credential.
 * @returns the class the eligibility decision reads.
 */
export function classifyClaudeSubscription(value: string | null | undefined): ClaudeSubscriptionClass {
  if (typeof value !== 'string') return 'unknown'
  const normalized = value.trim().toLowerCase()
  if (normalized === 'pro' || normalized === 'max') return 'pro-max'
  return normalized.length === 0 ? 'unknown' : 'other-subscription'
}

/**
 * The subscription values whose eligibility branch the pinned client verifies:
 * `team` and `enterprise` also reach the settings fetch.
 */
const ORGANIZATION_SUBSCRIPTIONS: ReadonlySet<string> = new Set(['team', 'enterprise'])

/** Whether one confirmed subscription type is an organization plan the fetch covers. */
function isOrganizationSubscription(value: string | null | undefined): boolean {
  return typeof value === 'string' && ORGANIZATION_SUBSCRIPTIONS.has(value.trim().toLowerCase())
}

/** Why the managed-settings fetch does or does not run for one bound account. */
export type ClaudePolicyEligibility =
  /** The fetch runs; the reason names which admitted branch. */
  | { readonly kind: 'eligible'; readonly reason: 'unknown-subscription' | 'organization-subscription' }
  /** The fetch never runs; the reason is the observable status of the account. */
  | {
    readonly kind: 'ineligible'
    readonly reason: 'confirmed-pro-max'
      | 'unsupported-subscription-type'
      | 'not-first-party-oauth'
  }
  /** No usable credential: authentication fails and nothing is fetched. */
  | { readonly kind: 'no-credential'; readonly reason: 'no-auth' }

/** What the eligibility decision reads. */
export interface ClaudePolicyEligibilityInput {
  /** Subscription type confirmed by a validated profile response or the stored credential. */
  subscriptionType: string | null | undefined
  /** Whether the bound account is served by the plugin's own first-party OAuth path. */
  firstPartyOAuth: boolean
  /** Whether a usable credential is stored right now. */
  hasCredential: boolean
}

/**
 * Decide whether the account's real metadata admits the managed-settings fetch.
 *
 * A confirmed pro/max subscription does not fetch, and an account without a credential
 * never sends an unauthenticated probe. A stated-but-unreadable subscription type (the
 * pinned client's `null` branch) and the verified organization plans do fetch.
 * @param input - the confirmed metadata the decision reads.
 * @returns the eligibility and the reason the status view reports.
 */
export function claudePolicyEligibility(input: ClaudePolicyEligibilityInput): ClaudePolicyEligibility {
  if (!input.hasCredential) return { kind: 'no-credential', reason: 'no-auth' }
  if (!input.firstPartyOAuth) return { kind: 'ineligible', reason: 'not-first-party-oauth' }
  const classification = classifyClaudeSubscription(input.subscriptionType)
  if (classification === 'pro-max') return { kind: 'ineligible', reason: 'confirmed-pro-max' }
  if (classification === 'other-subscription') {
    return isOrganizationSubscription(input.subscriptionType)
      ? { kind: 'eligible', reason: 'organization-subscription' }
      : { kind: 'ineligible', reason: 'unsupported-subscription-type' }
  }
  return { kind: 'eligible', reason: 'unknown-subscription' }
}

/** Profile freshness, decided against the deployment's freshness baseline. */
export type ClaudeProfileFreshness = 'fresh' | 'stale' | 'missing'

/**
 * The fields the maintenance reads from the account profile, never the raw body.
 *
 * `subscriptionType` distinguishes three states: a string is a confirmed type, `null` is
 * an explicit statement that the provider exposed none, and an absent property is a
 * response that did not address the field. Absence never erases a value already known.
 */
export interface ClaudeProfileFields {
  emailAddress?: string
  subscriptionType?: string | null
  accountUuid?: string
  organization?: string
}

/**
 * The fields a record must carry before it may stand in for a fresh profile: the
 * completeness evidence, the account identity and the organization.
 *
 * The pinned client adopts a profile only when the response carries both `account.uuid`
 * and `organization.uuid`, and it skips its profile fetch only while the account metadata
 * it cached (`billingType`, `accountCreatedAt`, `subscriptionCreatedAt`,
 * `ccOnboardingFlags`) is present and younger than its own TTL. That verdict belongs to the
 * reader, which reports it as `complete`; the subscription type is deliberately not part of
 * it, because a null plan is a complete answer.
 *
 * `account.email` belongs to the reader's own adoption contract — it validates the response
 * envelope, its JSON shape and its size bound — and is deliberately not re-checked here: the
 * reader reports the email field as optional, so deriving completeness from it again would
 * mark every record incomplete and turn this check into a re-read loop.
 */
export const CLAUDE_PROFILE_REQUIRED_FIELDS: readonly ['completeness', 'accountUuid', 'organization'] =
  ['completeness', 'accountUuid', 'organization']

/**
 * The completeness contract this build writes, and the only one whose verdict it trusts.
 *
 * A record without this version predates the evidence-based check — its `complete` flag was
 * inferred from whichever fields happened to be kept — so it reads as incomplete and one
 * bounded read replaces it.
 */
export const CLAUDE_PROFILE_COMPLETENESS_VERSION = 1

/** A validated profile record; the raw response body is never kept. */
export interface ClaudeProfileRecord {
  /** Identity the read was made under. */
  identity: ClaudeAccountIdentity
  emailAddress?: string
  /** Confirmed subscription type; `null` is the provider's explicit "not readable". */
  subscriptionType?: string | null
  accountUuid?: string
  /** When the record was accepted, in epoch milliseconds. */
  capturedAt: number
  /** The reader's verdict that the account metadata it depends on is present and current. */
  complete: boolean
  /**
   * Which completeness contract {@link complete} was computed under. Absent marks a record
   * written before the evidence-based check, which is treated as incomplete.
   */
  completenessVersion?: number
  /** Credential revision the read was made under. */
  credentialRevision: number
}

/** Which of the required fields a record is missing, in contract order. */
export interface ClaudeProfileCompleteness {
  complete: boolean
  missing: readonly string[]
}

/**
 * Whether a record may skip the next profile read.
 *
 * The verdict is the reader's, under the current completeness contract, plus the two
 * identity fields the pinned client itself requires to adopt a profile. It is never
 * inferred from the fields this module happens to keep: a reader that reported nothing, or
 * a record written before the contract existed, is incomplete and is read again.
 * @param record - the record to check, or `undefined` when nothing was read yet.
 * @returns whether the record is complete and which required fields are absent.
 */
export function claudeProfileCompleteness(record: ClaudeProfileRecord | undefined): ClaudeProfileCompleteness {
  if (record === undefined) return { complete: false, missing: [...CLAUDE_PROFILE_REQUIRED_FIELDS] }
  const missing: string[] = []
  if (record.completenessVersion !== CLAUDE_PROFILE_COMPLETENESS_VERSION || record.complete !== true) {
    missing.push('completeness')
  }
  if (record.accountUuid === undefined) missing.push('accountUuid')
  if (record.identity.organization === undefined) missing.push('organization')
  return { complete: missing.length === 0, missing }
}

/**
 * Freshness of a profile record against the deployment's baseline.
 * @param record - the record to judge, or `undefined` when nothing was read.
 * @param now - current epoch milliseconds.
 * @param maxAgeMs - the validated freshness baseline.
 * @returns `missing` without a record, `stale` past the baseline, else `fresh`.
 */
export function claudeProfileFreshness(
  record: ClaudeProfileRecord | undefined,
  now: number,
  maxAgeMs: number,
): ClaudeProfileFreshness {
  if (record === undefined) return 'missing'
  // The pinned client skips its profile fetch only while the age is strictly below its TTL
  // (`Date.now() - profileFetchedAt < UK`), so the deadline itself is already stale.
  return now - record.capturedAt >= maxAgeMs ? 'stale' : 'fresh'
}

/**
 * Merge a validated profile response over the record it updates.
 *
 * A property the response does not address keeps the known value; an explicit `null`
 * subscription type replaces it, which is how a validated new response can move a
 * confirmed plan to unknown. The captured time and completeness come from the accepted
 * read, never from a partial response.
 * @param previous - the record being updated, when there is one.
 * @param next - the accepted fields and the metadata of the read that produced them.
 * @returns the record to store.
 */
export function mergeClaudeProfile(
  previous: ClaudeProfileRecord | undefined,
  next: {
    identity: ClaudeAccountIdentity
    fields: ClaudeProfileFields
    capturedAt: number
    credentialRevision: number
    /** The reader's own verdict; absent means it did not compute one. */
    complete?: boolean
    /** The completeness contract the verdict was computed under. */
    completenessVersion?: number
  },
): ClaudeProfileRecord {
  const fields = next.fields
  const completenessVersion = next.completenessVersion ?? CLAUDE_PROFILE_COMPLETENESS_VERSION
  const merged: ClaudeProfileRecord = {
    identity: next.identity,
    capturedAt: next.capturedAt,
    credentialRevision: next.credentialRevision,
    // Completeness is a verdict about the *evidence* the reader checked, never something
    // this module infers from the fields it happens to keep. A reader that reported none
    // leaves the record incomplete, so the next bounded trigger reads again.
    complete: next.complete === true,
    completenessVersion,
    ...previous === undefined || previous.emailAddress === undefined
      ? {}
      : { emailAddress: previous.emailAddress },
    ...previous === undefined || previous.subscriptionType === undefined
      ? {}
      : { subscriptionType: previous.subscriptionType },
    ...previous === undefined || previous.accountUuid === undefined
      ? {}
      : { accountUuid: previous.accountUuid },
    ...fields.emailAddress === undefined ? {} : { emailAddress: fields.emailAddress },
    ...fields.subscriptionType === undefined ? {} : { subscriptionType: fields.subscriptionType },
    ...fields.accountUuid === undefined ? {} : { accountUuid: fields.accountUuid },
  }
  const identity: ClaudeAccountIdentity = fields.organization === undefined
    ? merged.identity
    : { ...merged.identity, organization: fields.organization }
  return { ...merged, identity }
}

/**
 * Whether an accepted profile response belongs to the account it was read for.
 *
 * A response naming another account UUID, or another organization than the one already
 * confirmed, is an identity change rather than an update of this account. An absent field
 * proves nothing and never conflicts.
 * @param identity - the identity the read was made under.
 * @param known - facts already confirmed about that identity.
 * @param fields - the validated fields of the response.
 * @returns true when the response may be merged into this account's record.
 */
export function claudeProfileMatchesIdentity(
  identity: ClaudeAccountIdentity,
  known: { accountUuid?: string },
  fields: ClaudeProfileFields,
): boolean {
  if (identity.organization !== undefined
    && fields.organization !== undefined
    && identity.organization !== fields.organization) return false
  if (known.accountUuid !== undefined
    && fields.accountUuid !== undefined
    && known.accountUuid !== fields.accountUuid) return false
  return true
}

/** The credential dimension of one account's maintenance state. */
export type ClaudeCredentialStatus =
  /** A stored credential exists and nothing is wrong with it. */
  | 'ready'
  /** A refresh cycle is running for this account. */
  | 'refreshing'
  /** The provider permanently refused the credential; maintenance stopped. */
  | 'reauth_required'
  /** No credential is stored. */
  | 'missing'
  /** Expiry is unknown, so no deadline can be scheduled. */
  | 'unknown-expiry'
  /**
   * The credential is read from Claude Code's own store on every use and this plugin never
   * rotates it on a timer.
   */
  | 'maintenance-unsupported'
  /**
   * The credential belongs to Claude Code's own store and this plugin uses the pre-existing
   * synchronization path: it may adopt that store's rotation, spend the shared refresh grant
   * and write its own rotation back. Coordination with that external holder is not proven, so
   * the same grant may be spent twice.
   */
  | 'external-coordination-unproven'

/** The policy dimension of one account's maintenance state. */
export type ClaudePolicyStatus =
  /** The account's confirmed metadata does not admit the fetch. */
  | 'ineligible'
  /** A fetch is running. */
  | 'loading'
  /** An accepted snapshot is current. */
  | 'current'
  /** A previously accepted snapshot is kept while the latest attempt failed. */
  | 'stale'
  /** Nothing was ever accepted and the latest attempt failed. */
  | 'unavailable'
  /** A restriction needs a user decision this plugin has no surface for. */
  | 'consent-required'
  /** A restriction affects operations and has no registered consumer, or was refused. */
  | 'blocked'

/** Validated deployment configuration for the maintenance owner. */
export interface ClaudeMaintenanceConfig {
  /** Lead time before expiry at which the credential timer runs; the provider passes its own baseline. */
  refreshLeadMs: number
  /** How long an accepted profile record stays fresh. */
  profileMaxAgeMs: number
  /** Period between managed-settings polls while a binding is alive. */
  policyPollMs: number
  /** Bound on one profile or settings read. */
  readTimeoutMs: number
  /** First retry delay after a failed cycle. */
  failureBackoffMs: number
  /** Ceiling the failure backoff doubles up to. */
  maxFailureBackoffMs: number
  /**
   * Floor between two credential checks, so a server that keeps answering with a
   * short-lived or unchanged expiry cannot turn a successful cycle into a zero-delay loop.
   */
  minRefreshDelayMs: number
}

/** The baseline profile freshness the pinned client uses: 24 hours. */
export const CLAUDE_PROFILE_MAX_AGE_MS = 24 * 60 * 60_000

/** The baseline managed-settings poll period the pinned client uses: one hour. */
export const CLAUDE_POLICY_POLL_MS = 60 * 60_000

/** The framework defaults for values the deployment does not state. */
export const CLAUDE_MAINTENANCE_DEFAULTS: Readonly<Omit<ClaudeMaintenanceConfig, 'refreshLeadMs'>> = Object.freeze({
  profileMaxAgeMs: CLAUDE_PROFILE_MAX_AGE_MS,
  policyPollMs: CLAUDE_POLICY_POLL_MS,
  readTimeoutMs: 10_000,
  failureBackoffMs: 30_000,
  maxFailureBackoffMs: 15 * 60_000,
  minRefreshDelayMs: 30_000,
})

/**
 * Validate deployment configuration.
 *
 * A zero or negative bound is a misconfiguration, not a way to switch a maintenance
 * capability off, so it fails here rather than silently disabling the timer.
 * @param input - the deployment's values; absent entries take the framework defaults.
 * @returns the complete validated configuration.
 * @throws Error when a value is missing where required, or is not a positive finite number.
 */
export function resolveClaudeMaintenanceConfig(
  input: Partial<ClaudeMaintenanceConfig> & Pick<ClaudeMaintenanceConfig, 'refreshLeadMs'>,
): ClaudeMaintenanceConfig {
  const resolved: ClaudeMaintenanceConfig = {
    refreshLeadMs: input.refreshLeadMs,
    profileMaxAgeMs: input.profileMaxAgeMs ?? CLAUDE_MAINTENANCE_DEFAULTS.profileMaxAgeMs,
    policyPollMs: input.policyPollMs ?? CLAUDE_MAINTENANCE_DEFAULTS.policyPollMs,
    readTimeoutMs: input.readTimeoutMs ?? CLAUDE_MAINTENANCE_DEFAULTS.readTimeoutMs,
    failureBackoffMs: input.failureBackoffMs ?? CLAUDE_MAINTENANCE_DEFAULTS.failureBackoffMs,
    maxFailureBackoffMs: input.maxFailureBackoffMs ?? CLAUDE_MAINTENANCE_DEFAULTS.maxFailureBackoffMs,
    minRefreshDelayMs: input.minRefreshDelayMs ?? CLAUDE_MAINTENANCE_DEFAULTS.minRefreshDelayMs,
  }
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(
        `dsh-plugin-subscriptions: claude maintenance config "${name}" must be a positive finite number `
        + `(got ${String(value)}); zero or negative values do not disable maintenance`,
      )
    }
  }
  if (resolved.failureBackoffMs > resolved.maxFailureBackoffMs) {
    throw new Error(
      'dsh-plugin-subscriptions: claude maintenance config "failureBackoffMs" must not exceed "maxFailureBackoffMs"',
    )
  }
  return resolved
}

/** The identity facts one stored session states, if any. */
export interface ClaudeSessionIdentityFacts {
  accountUuid?: string
  emailAddress?: string
  subscriptionType?: string
}

/**
 * Read the identity facts a stored session carries.
 * @param session - the stored session, when there is one.
 * @returns the facts, with absent fields left absent.
 */
export function claudeSessionIdentityFacts(session: ClaudeSession | undefined): ClaudeSessionIdentityFacts {
  if (session === undefined) return {}
  return {
    ...session.accountUuid === undefined ? {} : { accountUuid: session.accountUuid },
    ...session.emailAddress === undefined ? {} : { emailAddress: session.emailAddress },
    ...session.subscriptionType === undefined ? {} : { subscriptionType: session.subscriptionType },
  }
}
