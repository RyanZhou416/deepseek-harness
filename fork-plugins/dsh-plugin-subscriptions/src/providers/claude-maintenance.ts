/**
 * The Claude account maintenance owner.
 *
 * It owns three pieces of work, all bound to accounts that real sessions have actually
 * routed through: proactive credential renewal before expiry, profile freshness, and the
 * managed-settings policy read. Nothing here runs because a status page, a model list or a
 * usage badge was read — a binding exists only after {@link ClaudeMaintenanceController.ensureReady}
 * served an actual request for that session and account.
 *
 * The controller never treats a stream ending as a session ending: only an explicit release
 * (session disposed, user stop, logout, account removal, plugin disposal) drops a binding.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmErrorOptions } from '@deepseek-ai/dsh-llm'
import type { AccountCredential, AccountEntry, ClaudeSession } from '../auth/store.js'
import {
  claudeCredentialArmsOwnTimer,
  claudeCredentialCoordinationUnproven,
  claudeCredentialModeOf,
} from '../auth/claude-credential-ownership.js'
import {
  claudeIdentityKey,
  claudePolicyEligibility,
  claudeProfileCompleteness,
  claudeProfileFreshness,
  resolveClaudeMaintenanceConfig,
  sameClaudeIdentity,
  systemClaudeClock,
  systemClaudeScheduler,
} from './claude-account-state.js'
import type {
  ClaudeAccountIdentity,
  ClaudeClock,
  ClaudeCredentialStatus,
  ClaudeMaintenanceConfig,
  ClaudeMaintenanceFailure,
  ClaudePolicyEligibility,
  ClaudePolicyStatus,
  ClaudeProfileRecord,
  ClaudeScheduler,
  ClaudeTimer,
  ClaudePolicyEligibilityInput,
} from './claude-account-state.js'
import { claudeHasProfileScope, claudeProfileReadDecision, readClaudeProfile } from './claude-profile.js'
import type { ClaudeProfileReadReason, ClaudeProfileReader } from './claude-profile.js'
import { orgPinFromSettings } from './claude-policy-limits.js'
import type { OrgPinParse } from '../claude-core/org-pin.js'
import {
  claudePolicyConsumers,
  claudeScopesFor,
  decideClaudePolicy,
  projectClaudePolicy,
  readClaudeManagedSettings,
} from './claude-managed-settings.js'
import type {
  ClaudeMaintenancePersistence,
  ClaudePersistedAccount,
} from './claude-maintenance-state.js'
import type {
  ClaudePolicyBlocker,
  ClaudePolicyCheckRequest,
  ClaudePolicyConsumer,
  ClaudePolicyDecision,
  ClaudePolicyFetchFn,
  ClaudePolicyHttpClassifier,
  ClaudePolicyKeyState,
  ClaudePolicyScope,
  ClaudePolicySnapshot,
} from './claude-managed-settings.js'

/** The pinned first-party Messages origin, used when the deployment states no other. */
export const CLAUDE_DEFAULT_ORIGIN = 'https://api.anthropic.com'

/**
 * The credential plumbing the controller drives.
 *
 * `AccountTokenManager<ClaudeSession>` satisfies this shape; the interface exists so a
 * test can drive the controller over a real manager with a temporary store.
 */
export interface ClaudeMaintenanceTokens {
  list(): Promise<AccountEntry<ClaudeSession>[]>
  session(account?: string, forceRefresh?: boolean): Promise<ClaudeSession>
  peek(account?: string): Promise<ClaudeSession | undefined>
  resolveAccount(account: string): Promise<string>
  snapshot(account?: string): Promise<AccountCredential<ClaudeSession> | undefined>
}

/**
 * The protocol-block authority the reliability module owns.
 *
 * The controller asks this one authority and keeps no block store of its own, so a
 * configuration refused once cannot be re-probed by a second copy of the same state.
 */
export interface ClaudeProtocolBlockAuthority {
  /**
   * Whether a protocol configuration is blocked for one origin.
   * @param request - the provider, origin and protocol-configuration fingerprint.
   * @returns true when requests under that configuration must not be sent.
   */
  isBlocked(request: { provider: string; origin: string; fingerprint: string }): boolean | Promise<boolean>
  /**
   * Record one refusal in the same store {@link isBlocked} reads, so a protocol refusal
   * discovered on the profile path stops the route everywhere instead of being re-probed.
   * @param record - the refusal to record.
   */
  block?(record: {
    provider: string
    origin: string
    fingerprint: string
    reason: string
    serverCode?: string
  }): void | Promise<unknown>
}

/** The controller's injected dependencies. */
export interface ClaudeMaintenanceOptions {
  /** Credential plumbing for the Claude provider. */
  tokens: ClaudeMaintenanceTokens
  /** Deployment configuration; `refreshLeadMs` is the provider's own expiry lead. */
  config: Partial<ClaudeMaintenanceConfig> & Pick<ClaudeMaintenanceConfig, 'refreshLeadMs'>
  /** Protocol-level profile reader; absent keeps the profile unread and reported as such. */
  readProfile?: ClaudeProfileReader
  /** Protocol-level managed-settings fetch; absent keeps policy unreported and unenforced. */
  fetchSettings?: ClaudePolicyFetchFn
  /**
   * The unified HTTP failure classifier the reliability module owns. Every non-success
   * settings status goes through it, so a version or permission refusal keeps its own
   * decision and hard stop instead of becoming a second, local classification.
   */
  classifyHttpFailure?: ClaudePolicyHttpClassifier
  /** Host-registered policy consumers; the projection and every check read this one set. */
  policyConsumers?: readonly ClaudePolicyConsumer[]
  /** Protocol-block authority; absent sends no block check. */
  protocolBlocks?: ClaudeProtocolBlockAuthority
  /**
   * Where the profile and accepted-policy records survive a restart. Absent keeps the
   * maintenance state in memory alone, and the status view then reports only what this
   * process learned rather than what the account already confirmed earlier.
   */
  persistence?: ClaudeMaintenancePersistence
  /**
   * Classify one credential failure. The unified classifier owns the real mapping; the
   * default reads the plugin's own `INVALID_CREDENTIAL` / `MISSING_CREDENTIAL` codes.
   */
  classifyCredentialFailure?: (error: unknown) => 'transient' | 'permanent' | 'missing'
  /**
   * The protocol-configuration fingerprint the account's requests run under. The Claude
   * protocol module owns the value; the default keeps the controller usable on its own.
   */
  protocolFingerprint?: () => string
  /** The provider origin the account is served from. */
  origin?: string
  /** Which account keys are served by the plugin's own first-party OAuth path. */
  isFirstPartyOAuth?: (account: string) => boolean
  /** Time source; defaults to the process clock. */
  clock?: ClaudeClock
  /** Timer source; defaults to the process timers. */
  scheduler?: ClaudeScheduler
  /** Called after any observable maintenance state changes, so the status projection re-reads. */
  onChanged?: (account: string) => void
  /** Warning sink for a contained background failure. */
  onWarn?: (message: string) => void
}

/** One account's adopted organization pin, projected with the policy revision it belongs to. */
export type AdoptedOrganizationPin =
  /** The accepted policy stated a pin, or stated none at all; the parse is the core's. */
  | { readonly kind: 'stated'; readonly pin: OrgPinParse; readonly revision: string }
  /** The accepted policy was restored without its settings, so its pin is not known. */
  | { readonly kind: 'unknown'; readonly revision: string; readonly reason: string }

/** One request a caller is about to send through a bound account. */
export interface ClaudeRequestReadiness {
  /** Canonical or alias account key the request targets. */
  account: string
  /** The harness session id, when the caller has one; absent creates no binding. */
  sessionId?: string | undefined
  /** Caller cancellation. */
  signal?: AbortSignal | undefined
}

/** Whether a request may be sent, and with which credential. */
export type ClaudeRequestDecision =
  | { readonly ok: true; readonly account: string; readonly session: ClaudeSession }
  | { readonly ok: false; readonly error: LlmError }

/** The status projection the Settings surface reads; computed while nothing refreshes. */
export interface ClaudeAccountMaintenanceView {
  account: string
  organization?: string
  origin: string
  protocolFingerprint: string
  /** How many live session bindings currently hold this account. */
  bindings: number
  credential: {
    status: ClaudeCredentialStatus
    expiresAt?: number
    nextCheckAt?: number
    failure?: ClaudeMaintenanceFailure
  }
  profile: {
    status: 'fresh' | 'stale' | 'missing' | 'unavailable'
    reason: ClaudeProfileReadReason
    capturedAt?: number
    complete: boolean
    missing: readonly string[]
    subscriptionType?: string | null
    failure?: ClaudeMaintenanceFailure
  }
  policy: {
    status: ClaudePolicyStatus
    reason: string
    fetchedAt?: number
    checksum?: string
    nextCheckAt?: number
    blockers: readonly ClaudePolicyBlocker[]
    keys: readonly ClaudePolicyKeyState[]
    failure?: ClaudeMaintenanceFailure
  }
}

/** One account's live maintenance state. */
interface ClaudeAccountState {
  key: string
  identity: ClaudeAccountIdentity
  bindings: Set<string>
  /** Bumped whenever the binding set or identity changes, so late effects are dropped. */
  generation: number
  credentialStatus: ClaudeCredentialStatus
  credentialFailure: ClaudeMaintenanceFailure | undefined
  credentialTimer: ClaudeTimer | undefined
  credentialBackoffMs: number
  /** Credential revision the state was last reconciled against. */
  credentialRevision: number
  /** Account UUID confirmed for this identity; a different one means another login. */
  confirmedAccountUuid: string | undefined
  profile: ClaudeProfileRecord | undefined
  profileReason: ClaudeProfileReadReason
  profileFailure: ClaudeMaintenanceFailure | undefined
  /** A hard profile refusal that refuses later requests until the account changes. */
  profileRefused: ClaudeMaintenanceFailure | undefined
  profileRetryAt: number | undefined
  profileInFlight: Promise<void> | undefined
  profileController: AbortController | undefined
  policy: ClaudePolicySnapshot | undefined
  policyStatus: ClaudePolicyStatus
  policyReason: string
  policyFailure: ClaudeMaintenanceFailure | undefined
  policyRetryAt: number | undefined
  policyBackoffMs: number
  policyTimer: ClaudeTimer | undefined
  policyInFlight: Promise<void> | undefined
  policyController: AbortController | undefined
  /** The shared determination read every concurrent caller waits for. */
  policyReady: Promise<void> | undefined
  /** Identity of that read, so a superseded one never settles the state it no longer owns. */
  policyOperation: ClaudePolicyOperation | undefined
  /** How many callers are still waiting for it. */
  policyWaiters: number
  /** A refusal that must outrank every cached restriction. */
  policyRefused: ClaudeMaintenanceFailure | undefined
  /** A document-level blocker: an unvalidatable response denies its scope until a valid one arrives. */
  policyDocumentBlocker: ClaudePolicyBlocker | undefined
  /** Whether the one bounded initialization read has been attempted for this identity. */
  policyDetermined: boolean
  /**
   * Whether the accepted policy's settings body is the one this process holds. A snapshot
   * restored from disk keeps the record's projection and no document, so its pin is unknown
   * and it cannot be revalidated conditionally until a full read supplies both again — the
   * one exception being the endpoint's empty-success statuses, whose stored projection is the
   * whole body `{}`.
   */
  policyBodyComplete: boolean
  /** Work owned by this account state, so a release waits for exactly what it started. */
  work: Set<Promise<unknown>>
  /** An identity conflict observed while reading; stops maintenance for this account. */
  identityConflict: boolean
  /** A permanent failure stops scheduling until the account is used again after a change. */
  stopped: boolean
}

/** The options a `retryDisposition: 'forbid'` refusal carries. */
const CLAUDE_FORBID: LlmErrorOptions = { retryDisposition: 'forbid' }

/** The account UUID this state may constrain a profile response with. */
function knownAccountUuid(state: ClaudeAccountState): string | undefined {
  return state.confirmedAccountUuid ?? state.profile?.accountUuid
}

/** A restored scope string, kept only when this build knows the scope. */
function policyScopeOf(value: string): ClaudePolicyScope {
  return value === 'tool' || value === 'model' || value === 'mcp' || value === 'execution' || value === 'network'
    ? value
    : 'unknown'
}

/** A restored blocker code, kept only when this build knows the code. */
function policyBlockerCodeOf(value: string): ClaudePolicyBlocker['code'] {
  return value === 'POLICY_UNSUPPORTED' || value === 'POLICY_INVALID_VALUE' || value === 'POLICY_CONSENT_REQUIRED'
    ? value
    : 'POLICY_UNSUPPORTED'
}

/**
 * Whether an accepted profile response is still about the credential the account holds.
 *
 * A rotation between the read and its adoption keeps the response only while the account
 * UUID it disclosed still agrees with the one the store states; a replaced login never
 * inherits the earlier account's record.
 * @param state - the account state being updated.
 * @param currentAccountUuid - the UUID the stored credential states now, when it states one.
 * @param currentRevision - the revision the credential is stored under now.
 * @param readRevision - the revision the read was made under.
 * @returns whether the response may be adopted.
 */
function claudeProfileStillCurrent(
  state: ClaudeAccountState,
  currentAccountUuid: string | undefined,
  currentRevision: number,
  readRevision: number,
): boolean {
  const known = knownAccountUuid(state)
  if (known !== undefined && currentAccountUuid !== undefined && known !== currentAccountUuid) return false
  if (currentRevision === readRevision) return true
  // The credential changed while the response was in flight. Only a rotation that still
  // names the same account (or names none) keeps the earlier account's record valid.
  return known === undefined || currentAccountUuid === undefined || known === currentAccountUuid
}

/** One shared policy determination read. */
interface ClaudePolicyOperation {
  /** Binding generation the read was started under. */
  readonly generation: number
  /** Cancellation for this read. */
  readonly controller: AbortController
}

/** A protocol-level profile refusal, as the shared block store records it. */
function isProtocolRefusal(failure: ClaudeMaintenanceFailure | undefined): boolean {
  return failure?.reason === 'CLIENT_VERSION_UNSUPPORTED' || failure?.serverCode === 'claude_code_version_too_old'
}

/**
 * Settle with a shared read, or as soon as this caller's own signal aborts.
 *
 * A caller that stops waiting never cancels the shared read: other sessions may still need
 * it, and only the last waiter left does.
 * @param shared - the read this caller joined.
 * @param signal - this caller's own cancellation.
 * @returns a promise that resolves once either settles.
 */
function raceWithSignal(shared: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return shared
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const stop = (): void => {
      shared.then(() => { signal.removeEventListener('abort', stop) }, () => { signal.removeEventListener('abort', stop) })
      resolve()
    }
    signal.addEventListener('abort', stop, { once: true })
    // The shared read settling is the other half of the race: without it a caller that owns a
    // signal waits for its own cancellation even though the read it asked for already finished.
    void shared.then(
      () => { signal.removeEventListener('abort', stop); resolve() },
      () => { signal.removeEventListener('abort', stop); resolve() },
    )
  })
}

/**
 * Owner of the three Claude account-maintenance loops.
 *
 * Every network action it starts is bound to at least one live session binding; releasing
 * the last binding cancels the account's timers and aborts its in-flight reads without
 * discarding the data they produced.
 */
export class ClaudeMaintenanceController {
  private readonly states = new Map<string, ClaudeAccountState>()
  private readonly config: ClaudeMaintenanceConfig
  private readonly clock: ClaudeClock
  private readonly scheduler: ClaudeScheduler
  private readonly consumers: Map<string, ClaudePolicyConsumer>
  private readonly origin: string
  private disposed = false
  /**
   * Why the durable policy state cannot be trusted, when it cannot.
   *
   * While this is set, policy-gated requests are refused: a stored restriction an earlier
   * run enforced cannot be assumed absent just because its file could not be read. A fresh
   * accepted policy clears it.
   */
  private stateUnavailableReason: string | undefined
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(private readonly options: ClaudeMaintenanceOptions) {
    this.config = resolveClaudeMaintenanceConfig(options.config)
    this.clock = options.clock ?? systemClaudeClock
    this.scheduler = options.scheduler ?? systemClaudeScheduler
    this.consumers = claudePolicyConsumers(options.policyConsumers ?? [])
    this.origin = options.origin ?? CLAUDE_DEFAULT_ORIGIN
  }

  /**
   * Establish or refresh the binding for one real request and return the credential to
   * send with it.
   *
   * This is the adapter's pre-request hook: it is the only place a session becomes bound,
   * it never starts work for an account the request does not name, and it refuses the
   * request — rather than sending it — when the credential is gone, the protocol
   * configuration is blocked, or an accepted policy restriction reaches the request.
   * @param request - the account, the harness session id and the caller's cancellation.
   * @returns the credential to send, or `undefined` when nothing changed.
   * @throws LlmError when the request must not be sent.
   */
  async beforeAccountRequest(request: ClaudeRequestReadiness): Promise<ClaudeSession | undefined> {
    const decision = await this.ensureReady(request)
    if (!decision.ok) throw decision.error
    return decision.session
  }

  /**
   * Decide whether one request may be sent, and with which credential.
   *
   * The binding is established here — with a real harness session id only — but a request
   * that names no session still receives the credential and policy checks; it simply
   * creates no lasting maintenance ownership.
   * @param request - the account, the harness session id and the caller's cancellation.
   * @returns the ready credential, or the refusal to send.
   */
  async ensureReady(request: ClaudeRequestReadiness): Promise<ClaudeRequestDecision> {
    const bound = request.sessionId !== undefined && request.sessionId.length > 0
    let state: ClaudeAccountState | undefined
    try {
      return await this.resolveReadiness(request, state0 => { state = state0 })
    } finally {
      if (!bound && state !== undefined && state.bindings.size === 0) this.releaseTransientState(state)
    }
  }

  /**
   * A request that named no session owns nothing lasting.
   *
   * Its policy determination is recorded (a configured store keeps it), the account's
   * timers and reads are dropped, and the state leaves the map: repeated direct requests
   * cannot accumulate owners. Without a store the state is kept, because that map is then
   * the only place the knowledge lives.
   * @param state - the state the finished request used.
   */
  private releaseTransientState(state: ClaudeAccountState): void {
    if (this.options.persistence === undefined) return
    this.schedulePersist()
    this.cancelTimers(state)
    this.abortInFlight(state)
    state.generation += 1
    this.states.delete(state.key)
  }

  /**
   * Resolve one request's readiness, reporting the state it used so a request that owns no
   * binding can release it afterwards.
   * @param request - the account, session id and cancellation.
   * @param adopt - receives the state this request used.
   * @returns the decision.
   */
  private async resolveReadiness(
    request: ClaudeRequestReadiness,
    adopt: (state: ClaudeAccountState) => void,
  ): Promise<ClaudeRequestDecision> {
    if (this.disposed) {
      return { ok: false, error: new LlmError('claude maintenance is disposed', 'ABORTED') }
    }
    const account = await this.options.tokens.resolveAccount(request.account)
    const snapshot = await this.options.tokens.snapshot(account)
    if (snapshot === undefined) {
      return {
        ok: false,
        error: new LlmError(
          `dsh-plugin-subscriptions: not logged in to Claude (Subscription); `
          + 'log in via Settings → Subscriptions in the dsh web app',
          'MISSING_CREDENTIAL',
        ),
      }
    }
    const state = this.stateForAccount(account, snapshot.session, snapshot.revision)
    adopt(state)
    if (request.sessionId !== undefined && request.sessionId.length > 0) {
      await this.bind(state, request.sessionId)
    }
    const blocked = await this.protocolBlocked(state.identity)
    if (blocked) {
      return {
        ok: false,
        error: new LlmError(
          'claude protocol configuration is blocked for this origin; update the client before retrying',
          'CLIENT_VERSION_UNSUPPORTED',
          { ...CLAUDE_FORBID, status: 400 },
        ),
      }
    }
    let session: ClaudeSession
    try {
      session = await this.options.tokens.session(account)
    } catch (error: unknown) {
      const classification = this.classify(error)
      if (classification === 'permanent') {
        state.credentialStatus = 'reauth_required'
        state.credentialFailure = this.failureFrom(error, 'credential')
        this.stopScheduling(state)
        this.notify(state.key)
      }
      return { ok: false, error: error instanceof LlmError ? error : new LlmError(String(error), 'AUTH') }
    }
    state.credentialStatus = 'ready'
    state.credentialRevision = snapshot.revision
    this.armCredentialTimer(state, session)
    // The first request under a newly bound account waits, within one configured read
    // bound, for the policy determination it is about to be judged by: a known refusal or
    // an unsupported restriction must stop this request, not the next one.
    await this.ensurePolicyDetermined(state, request.signal)
    if (request.signal?.aborted === true) {
      // This caller stopped waiting; it is cancelled, not approved. Its decision must not be
      // presented as a policy refusal either.
      return { ok: false, error: new LlmError('claude request was cancelled', 'ABORTED') }
    }
    const policy = this.assertAllowed({ capabilities: claudeScopesFor('model'), account })
    if (policy.decision === 'deny') {
      return { ok: false, error: this.policyRefusal(policy) }
    }
    this.startBoundWork(state, true)
    return { ok: true, account, session }
  }

  /**
   * Bind one session as a live user of one account.
   *
   * Called from {@link ensureReady} for a real request; a caller that has only an account
   * list, a menu read or a historical session must not call this.
   * @param sessionId - the harness session id that used the account.
   * @param account - the account key the session used.
   */
  noteSessionUsed(sessionId: string, account: string): void {
    if (this.disposed || sessionId.length === 0) return
    const state = this.stateByAccount(account)
    if (state === undefined) return
    void this.bind(state, sessionId)
  }

  /**
   * Release one session's bindings and wait for the work it owned.
   *
   * A stream ending, an idle turn or a completed response is not a release: only session
   * disposal, a user stop, a logout or an account removal reaches this. Work another live
   * session still needs — the shared credential refresh above all — is not awaited here.
   * @param sessionId - the harness session that ended.
   * @returns a promise that resolves once no work owned by that session is still running.
   */
  async releaseSession(sessionId: string): Promise<void> {
    const releasing: ClaudeAccountState[] = []
    for (const state of [...this.states.values()]) {
      if (!state.bindings.delete(sessionId)) continue
      if (state.bindings.size === 0) {
        this.suspend(state)
        releasing.push(state)
      }
      this.notify(state.key)
    }
    await this.quiesce(releasing)
  }

  /**
   * Release every binding of one account and drop its maintenance state: logout, account
   * removal or an identity replacement. The next real use starts from a fresh identity.
   * @param account - the account key, canonical or alias.
   * @returns a promise that resolves once the account's work has settled.
   */
  async releaseAccount(account: string): Promise<void> {
    const releasing: ClaudeAccountState[] = []
    for (const [key, state] of [...this.states.entries()]) {
      if (state.identity.account !== account) continue
      this.cancelTimers(state)
      this.abortInFlight(state)
      state.bindings.clear()
      state.generation += 1
      this.states.delete(key)
      releasing.push(state)
      this.notify(key)
    }
    if (releasing.length > 0) {
      this.schedulePersist()
      for (const state of releasing) {
        const removal = this.options.persistence?.remove?.(state.identity.account)
        if (removal === undefined) continue
        const pending: Promise<unknown> = Promise.resolve(removal).catch((error: unknown) => {
          this.options.onWarn?.(
            `dsh-plugin-subscriptions: claude maintenance record could not be removed (${error instanceof Error ? error.message : String(error)})`,
          )
        })
        this.inFlight.add(pending)
        void pending.then(() => { this.inFlight.delete(pending) })
      }
    }
    await this.quiesce(releasing)
  }

  /**
   * Re-arm the credential timer after the credential changed outside a maintenance cycle
   * — a request reached a 401 and refreshed it, for example.
   * @param account - the account whose credential changed.
   */
  noteCredentialChanged(account: string): void {
    if (this.disposed) return
    const state = this.stateByAccount(account)
    if (state === undefined) return
    state.stopped = false
    state.credentialFailure = undefined
    state.credentialBackoffMs = 0
    const generation = state.generation
    this.trackWork(state, (async () => {
      const snapshot = await this.options.tokens.snapshot(account)
      if (this.disposed || state.generation !== generation || snapshot === undefined) return
      state.credentialRevision = snapshot.revision
      this.armCredentialTimer(state, snapshot.session)
      this.notify(state.key)
    })())
  }

  /**
   * Decide one operation against the accepted remote policy.
   *
   * The same projection the fetch produced is the one enforced here, and a restriction
   * whose consumer is missing refuses the operation instead of being ignored.
   * @param request - the operation, optionally scoped to one account.
   * @returns whether the operation may run.
   */
  assertAllowed(request: ClaudePolicyCheckRequest & { account?: string }): ClaudePolicyDecision {
    const state = request.account === undefined
      ? this.onlyState()
      : this.stateByAccount(request.account)
    if (state === undefined) return { decision: 'allow', reason: 'no maintenance state for this account' }
    if (this.stateUnavailableReason !== undefined) {
      return {
        decision: 'deny',
        code: 'POLICY_STATE_UNAVAILABLE',
        blocker: {
          key: '(state)',
          scope: 'unknown',
          code: 'POLICY_UNSUPPORTED',
          detail: `the durable policy state could not be trusted (${this.stateUnavailableReason})`,
        },
      }
    }
    // An identity conflict or a hard profile refusal outranks any cached remote policy: the
    // account itself is in question, so nothing is allowed on the strength of its caches.
    if (state.identityConflict) {
      return {
        decision: 'deny',
        code: 'PROFILE_IDENTITY_CHANGED',
        blocker: {
          key: '(profile)',
          scope: 'unknown',
          code: 'POLICY_UNSUPPORTED',
          detail: 'the account profile named another identity; re-authenticate this account',
        },
      }
    }
    if (state.profileRefused !== undefined) {
      return {
        decision: 'deny',
        code: state.profileRefused.reason,
        blocker: {
          key: '(profile)',
          scope: 'unknown',
          code: 'POLICY_UNSUPPORTED',
          detail: `the account profile was refused (${state.profileRefused.reason})`,
        },
      }
    }
    if (state.policyDocumentBlocker !== undefined) {
      return {
        decision: 'deny',
        code: state.policyDocumentBlocker.code,
        blocker: state.policyDocumentBlocker,
      }
    }
    if (state.policyRefused !== undefined) {
      return {
        decision: 'deny',
        code: 'POLICY_REFUSED',
        blocker: {
          key: '(provider)',
          scope: 'unknown',
          code: 'POLICY_UNSUPPORTED',
          detail: state.policyRefused.reason,
        },
      }
    }
    return decideClaudePolicy(
      {
        ...request.scope === undefined ? {} : { scope: request.scope },
        capabilities: request.capabilities ?? claudeScopesFor('unknown'),
        ...request.tool === undefined ? {} : { tool: request.tool },
        ...request.model === undefined ? {} : { model: request.model },
        ...request.server === undefined ? {} : { server: request.server },
        ...request.bypassPermissions === undefined ? {} : { bypassPermissions: request.bypassPermissions },
      },
      state.policy,
      this.consumers,
    )
  }

  /**
   * The current status projection.
   *
   * A pure read of in-memory state: it starts no request, arms no timer, extends no
   * cooldown and never refreshes a credential.
   * @returns one view per account the controller knows.
   */
  view(): readonly ClaudeAccountMaintenanceView[] {
    return [...this.states.values()].map(state => this.viewOf(state))
  }

  /**
   * The organization pin one account's accepted policy carries, projected for its consumer.
   *
   * The raw settings document is deliberately not exposed: only the pin and the revision it
   * belongs to leave this owner, so a consumer cannot read or persist a remote value the
   * minimal projection does not keep. An accepted policy is only as good as the document it
   * was read from: a snapshot restored from disk carries no settings, so its pin reads as
   * unknown and the pin checker keeps refusing until a fresh full read states it again —
   * never as the absence of a pin. The endpoint's empty-success record is the exception: its
   * own record states the whole empty body, so the absence of a pin is stated, not assumed.
   * @param account - the canonical account key.
   * @returns the projected pin state, or `undefined` when this account holds no policy.
   */
  adoptedOrganizationPin(account: string): AdoptedOrganizationPin | undefined {
    // The state map is keyed by identity, not by the account key a caller names, so the
    // projection resolves the state the same way every other account-keyed member does.
    const state = this.stateByAccount(account)
    if (state?.policy === undefined) return undefined
    const revision = state.policy.revision
    if (!state.policyBodyComplete) {
      return { kind: 'unknown', revision, reason: 'the accepted policy was restored without its pin; a fresh read states it again' }
    }
    return { kind: 'stated', pin: orgPinFromSettings(state.policy.settings), revision }
  }

  /**
   * Load the profile and accepted-policy records a previous run stored.
   *
   * Hydration installs data only: it creates no binding, arms no timer and starts no
   * request, so a restart never resumes work for a session that no longer exists. A
   * persisted policy snapshot is re-projected against the consumers in force now, so a
   * restriction this build still cannot enforce blocks again instead of disappearing.
   * @returns a promise that resolves once the stored records are installed.
   */
  async hydrate(): Promise<void> {
    const persistence = this.options.persistence
    if (persistence === undefined || this.disposed) return
    let loaded: Awaited<ReturnType<ClaudeMaintenancePersistence['load']>>
    try {
      loaded = await persistence.load()
    } catch {
      // A store that cannot even be read is unavailable, exactly like a corrupt one: the
      // known restrictions it may hold are unknown, so nothing is allowed on a guess.
      loaded = { status: 'unavailable', reason: 'the maintenance state could not be read' }
    }
    if (this.disposed) return
    if (loaded.status === 'unavailable') {
      // Fail closed for this process until a fresh policy read re-establishes the record.
      this.stateUnavailableReason = loaded.reason
      this.options.onWarn?.(
        `dsh-plugin-subscriptions: claude maintenance state is unavailable (${loaded.reason}); policy-gated requests are refused until a fresh read`,
      )
      return
    }
    if (loaded.status === 'cold') return
    for (const record of loaded.records) {
      const identity: ClaudeAccountIdentity = {
        account: record.account,
        origin: record.origin,
        protocolFingerprint: record.protocolFingerprint,
        ...record.organization === undefined ? {} : { organization: record.organization },
      }
      if (this.stateByAccount(record.account) !== undefined) continue
      const state = this.createState(identity)
      if (record.profile !== undefined) {
        state.profile = {
          identity,
          capturedAt: record.profile.capturedAt,
          credentialRevision: record.profile.credentialRevision,
          // The stored verdict travels with the contract it was computed under; a record
          // without one restores as incomplete and is read again by the first request.
          complete: record.profile.complete,
          ...record.profile.completenessVersion === undefined
            ? {}
            : { completenessVersion: record.profile.completenessVersion },
          ...record.profile.accountUuid === undefined ? {} : { accountUuid: record.profile.accountUuid },
          ...record.profile.emailAddress === undefined ? {} : { emailAddress: record.profile.emailAddress },
          ...record.profile.subscriptionType === undefined ? {} : { subscriptionType: record.profile.subscriptionType },
        }
        state.profileReason = 'fresh'
        state.confirmedAccountUuid = record.profile.accountUuid
      }
      if (record.policy !== undefined) {
        const blockers: ClaudePolicyBlocker[] = record.policy.blockers.map(entry => ({
          key: entry.key,
          scope: policyScopeOf(entry.scope),
          code: policyBlockerCodeOf(entry.code),
          detail: entry.detail,
        }))
        // Restrictions are not stored, so an enforced key needs a fresh read before it can
        // be enforced again; until then its scope is blocked rather than assumed clean.
        const unrestored = record.policy.enforced
        if (unrestored) {
          blockers.push({
            key: '(restore)',
            scope: 'unknown',
            code: 'POLICY_UNSUPPORTED',
            detail: 'the accepted policy needs a fresh read before its restrictions apply again',
          })
        }
        state.policy = {
          identity,
          checksum: record.policy.checksum,
          revision: record.policy.revision,
          acceptedAt: record.policy.acceptedAt,
          settings: {},
          keys: record.policy.keys.map(entry => ({
            key: entry.key,
            scope: policyScopeOf(entry.scope),
            disposition: entry.disposition === 'enforced' ? 'enforced' : entry.disposition === 'blocked' ? 'blocked' : 'not-applicable',
            detail: entry.detail,
          })),
          restrictions: [],
          blockers,
        }
        state.policyStatus = blockers.length === 0 ? 'current' : 'blocked'
        state.policyReason = 'restored'
        // The endpoint's fixed empty-success statuses are the one accepted policy whose
        // stored projection is its whole document: an empty checksum and revision, no key,
        // no blocker and nothing enforced state exactly the body `{}`. That body is the
        // projection itself, so the pin it states — none — is known here and the first bound
        // request reads nothing. Any other restored record keeps its projection without a
        // settings body, whatever its keys said: nothing here states its pin, and the first
        // bound request determines the policy with one bounded unconditional full read rather
        // than trusting the restored one — the body is what makes a later conditional read
        // valid.
        const emptySuccessBody = record.policy.checksum === ''
          && record.policy.revision === ''
          && record.policy.keys.length === 0
          && record.policy.blockers.length === 0
          && record.policy.enforced === false
        state.policyDetermined = emptySuccessBody
        state.policyBodyComplete = emptySuccessBody
      }
      this.notify(state.key)
    }
  }

  /**
   * Stop every timer, abort every read in flight and wait for the aborted work to settle.
   *
   * @returns a promise that resolves once no maintenance work is still running.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const state of this.states.values()) {
      this.cancelTimers(state)
      this.abortInFlight(state)
      state.generation += 1
      state.bindings.clear()
    }
    const pending = [...this.inFlight]
    this.states.clear()
    await Promise.allSettled(pending)
  }

  /** Origin and fingerprint for one account, from the injected protocol configuration. */
  private identityFor(account: string, session: ClaudeSession | undefined, record: ClaudeProfileRecord | undefined): ClaudeAccountIdentity {
    // A confirmed organization belongs to the identity, so a record read under another one
    // must not serve this account. The stored session carries no organization of its own,
    // and its account UUID is reconciled separately by {@link stateForAccount}.
    const organization = record !== undefined
      && record.identity.account === account
      && record.identity.origin === this.origin
      && record.identity.protocolFingerprint === this.protocolFingerprint()
      ? record.identity.organization
      : undefined
    void session
    return {
      account,
      origin: this.origin,
      protocolFingerprint: this.protocolFingerprint(),
      ...organization === undefined ? {} : { organization },
    }
  }

  /** The protocol-configuration fingerprint the injected supplier reports. */
  private protocolFingerprint(): string {
    return this.options.protocolFingerprint?.() ?? 'claude-protocol'
  }

  /** The single account state when exactly one exists, for an unscoped check. */
  private onlyState(): ClaudeAccountState | undefined {
    return this.states.size === 1 ? [...this.states.values()][0] : undefined
  }

  /** The state bound to one account key, canonical or alias. */
  private stateByAccount(account: string): ClaudeAccountState | undefined {
    for (const state of this.states.values()) {
      if (state.identity.account === account) return state
    }
    return undefined
  }

  /**
   * The state for one account key, rebuilt when the stored credential now names another
   * account UUID. A re-login that lands on the same key is a different identity, so the
   * caches read under the earlier one must not be carried over.
   * @param account - the canonical account key.
   * @param session - the credential currently stored for it.
   * @param revision - the credential revision that credential is stored under.
   * @returns the state to maintain this identity with.
   */
  private stateForAccount(account: string, session: ClaudeSession, revision: number): ClaudeAccountState {
    const existing = this.stateByAccount(account)
    if (existing !== undefined) {
      const known = existing.confirmedAccountUuid
      const current = session.accountUuid
      if (known !== undefined && current !== undefined && known !== current) {
        // Another account now holds this canonical key. Its generation is invalidated first,
        // so work already in flight for the earlier identity cannot land or persist after
        // this point, and nothing of that identity — its organization included — is passed
        // to the state the new login gets.
        existing.generation += 1
        this.cancelTimers(existing)
        this.abortInFlight(existing)
        this.states.delete(existing.key)
      } else {
        // An ordinary rotation keeps the account UUID, so the profile read under it stays
        // reusable and the state is returned unchanged.
        if (current !== undefined) existing.confirmedAccountUuid = current
        existing.credentialRevision = Math.max(existing.credentialRevision, revision)
        return existing
      }
    }
    const state = this.createState({ account, origin: this.origin, protocolFingerprint: this.protocolFingerprint() })
    if (session.accountUuid !== undefined) state.confirmedAccountUuid = session.accountUuid
    state.credentialRevision = revision
    return state
  }

  /** The state for one identity, replacing a state whose identity changed. */
  private stateFor(identity: ClaudeAccountIdentity): ClaudeAccountState {
    const key = claudeIdentityKey(identity)
    const existing = this.states.get(key)
    if (existing !== undefined) return existing
    for (const [otherKey, other] of this.states) {
      if (other.identity.account !== identity.account) continue
      // The account is known under another identity (organization, origin or protocol
      // configuration changed): its caches must not be carried across.
      this.cancelTimers(other)
      this.abortInFlight(other)
      this.states.delete(otherKey)
    }
    return this.createState(identity)
  }

  /** Build and register a fresh state for one identity. */
  private createState(identity: ClaudeAccountIdentity): ClaudeAccountState {
    const created: ClaudeAccountState = {
      key: claudeIdentityKey(identity),
      identity,
      bindings: new Set(),
      generation: 0,
      credentialStatus: 'ready',
      credentialFailure: undefined,
      credentialTimer: undefined,
      credentialBackoffMs: 0,
      credentialRevision: 0,
      confirmedAccountUuid: undefined,
      profile: undefined,
      profileReason: 'missing-record',
      profileFailure: undefined,
      profileRefused: undefined,
      profileRetryAt: undefined,
      profileInFlight: undefined,
      profileController: undefined,
      policy: undefined,
      policyStatus: 'ineligible',
      policyReason: 'not-evaluated',
      policyFailure: undefined,
      policyRetryAt: undefined,
      policyBackoffMs: 0,
      policyTimer: undefined,
      policyInFlight: undefined,
      policyController: undefined,
      policyReady: undefined,
      policyOperation: undefined,
      policyWaiters: 0,
      policyRefused: undefined,
      policyDocumentBlocker: undefined,
      policyDetermined: false,
      policyBodyComplete: false,
      work: new Set(),
      identityConflict: false,
      stopped: false,
    }
    this.states.set(created.key, created)
    return created
  }

  /**
   * Establish one binding, releasing the session from any other account it was bound to.
   *
   * A harness session that switches accounts keeps one identity at a time: the earlier
   * account's binding is released and its own work awaited before the new one starts, while
   * every other session's binding stays exactly as it was. Work is not started here;
   * {@link resolveReadiness} starts it after the policy determination it will be judged by.
   * @param state - the account the session now uses.
   * @param sessionId - the harness session id.
   */
  private async bind(state: ClaudeAccountState, sessionId: string): Promise<void> {
    if (state.bindings.has(sessionId)) return
    const releasing: ClaudeAccountState[] = []
    for (const other of this.states.values()) {
      if (other === state) continue
      if (!other.bindings.delete(sessionId)) continue
      if (other.bindings.size === 0) {
        this.suspend(other)
        releasing.push(other)
      }
      this.notify(other.key)
    }
    if (releasing.length > 0) await this.quiesce(releasing)
    state.bindings.add(sessionId)
    if (state.bindings.size === 1) {
      state.generation += 1
      state.stopped = false
      this.notify(state.key)
    }
  }

  /** Cancel an account's timers and abort its reads, keeping its data. */
  private suspend(state: ClaudeAccountState): void {
    state.generation += 1
    this.cancelTimers(state)
    this.abortInFlight(state)
    // The released binding's determination is no longer this state's: dropping the promise
    // and its identity lets a later binding start a new read, and makes the abandoned
    // read's own settlement a no-op instead of marking the identity determined.
    state.policyReady = undefined
    state.policyOperation = undefined
    state.policyWaiters = 0
    // A read that was in flight when its last binding went away never completes, so the
    // status must not keep claiming that it is still loading.
    if (state.credentialStatus === 'refreshing') {
      state.credentialStatus = state.credentialFailure === undefined ? 'ready' : 'refreshing'
    }
    if (state.policyStatus === 'loading') {
      state.policyStatus = state.policy === undefined
        ? 'unavailable'
        : state.policy.blockers.length === 0 ? 'current' : 'blocked'
      state.policyReason = 'released'
    }
  }

  /** Wait for exactly the work these states started, not for other sessions' shared work. */
  private async quiesce(states: readonly ClaudeAccountState[]): Promise<void> {
    const pending = states.flatMap(state => [...state.work])
    await Promise.allSettled(pending)
  }

  /** Cancel every timer of one state. */
  private cancelTimers(state: ClaudeAccountState): void {
    state.credentialTimer?.cancel()
    state.credentialTimer = undefined
    state.policyTimer?.cancel()
    state.policyTimer = undefined
  }

  /** Abort the reads one state has in flight. */
  private abortInFlight(state: ClaudeAccountState): void {
    state.profileController?.abort()
    state.profileController = undefined
    state.policyController?.abort()
    state.policyController = undefined
  }

  /** Stop scheduling further work for one account until it is used again. */
  private stopScheduling(state: ClaudeAccountState): void {
    state.stopped = true
    this.cancelTimers(state)
  }

  /**
   * Start the best-effort maintenance of a bound account.
   * @param state - the bound account.
   * @param policyDetermined - whether this request already waited for the bounded policy
   *   determination, in which case the poller owns the next check instead of a second read.
   */
  private startBoundWork(state: ClaudeAccountState, policyDetermined: boolean): void {
    if (this.disposed || state.bindings.size === 0) return
    this.startProfileWork(state)
    if (policyDetermined) this.armPolicyTimer(state)
    else this.startPolicyDetermination(state)
  }

  /**
   * Wait for this identity's policy determination, or take part in the one already running.
   *
   * Every caller shares a single bounded read: a second session of the same account waits
   * for the read the first one started instead of being judged before it lands. A caller's
   * own cancellation withdraws only that caller's wait — the shared read continues for the
   * others and is cancelled when the last waiter leaves. The read is bounded by the
   * configured timeout, which aborts it: nothing keeps running in the background, and a
   * read that was cancelled this way leaves the identity undetermined so a later request
   * retries it rather than being judged by a refusal that never arrived. The retry is the
   * next real request's, never a loop here, and a failed read keeps its own backoff: a
   * restored or failed policy is read again only once that backoff has passed.
   * @param state - the account state being judged.
   * @param signal - the caller's own cancellation.
   */
  private async ensurePolicyDetermined(state: ClaudeAccountState, signal?: AbortSignal): Promise<void> {
    // A read already in flight for this identity is the one this caller waits for, whoever
    // started it — the bounded initialization or the poller. None of the conditions below may
    // short-circuit that: the answer that read is about to produce is the answer this request
    // is judged by, so the caller settles through the same join, race and cancellation path
    // as the read's own starter. Only with nothing in flight can the identity be asked again.
    if (state.policyReady === undefined) {
      // A provider refusal is terminal: no later request re-asks it.
      if (state.policyRefused !== undefined) return
      // The identity's determination has already run and asking again could not improve it:
      // the document is held, or this entitlement admits no document, or the entitlement
      // excludes the read altogether. Until a later binding or an organization change resets
      // the identity, a request is judged by what that determination left.
      if (state.policyDetermined
        && (state.policyBodyComplete || state.policy === undefined || state.policyStatus === 'ineligible')) return
      // No settings fetch is injected: the determination records the missing read and reports
      // it, exactly as it did before this gate existed.
      if (this.options.fetchSettings === undefined) {
        state.policyDetermined = true
        if (state.policyStatus === 'ineligible') {
          state.policyStatus = 'unavailable'
          state.policyReason = 'settings-fetch-unavailable'
        }
        return
      }
      // A recorded failure keeps its own backoff: a request inside it reads nothing and is
      // judged by what is already known. Past it, this request takes its own bounded turn.
      if (state.policyRetryAt !== undefined && this.clock.now() < state.policyRetryAt) return
    }
    const shared = state.policyReady ?? this.startPolicyDetermination(state)
    if (shared === undefined) return
    const leave = this.joinPolicyWait(state, signal)
    try {
      await raceWithSignal(shared, signal)
    } finally {
      leave()
    }
  }

  /**
   * The one determination read for this identity, started if none is running.
   * @param state - the account state.
   * @returns the shared read, or `undefined` when this deployment has no settings fetch.
   */
  private startPolicyDetermination(state: ClaudeAccountState): Promise<void> | undefined {
    if (state.policyReady !== undefined) return state.policyReady
    if (this.options.fetchSettings === undefined) return undefined
    const controller = new AbortController()
    const operation: ClaudePolicyOperation = { generation: state.generation, controller }
    state.policyController = controller
    state.policyOperation = operation
    const shared = this.runPolicyDetermination(state, operation)
    state.policyReady = shared
    this.trackWork(state, shared)
    return shared
  }

  /**
   * Run one bounded determination and settle the identity's state from its outcome.
   *
   * The settlement is fenced on the operation itself: if the binding was released or a
   * newer read replaced this one while it was in flight, this read no longer owns the
   * account state — it must not mark the identity determined, clear the newer read's
   * promise, or arm a timer for a binding that is gone. A release therefore leaves the
   * identity undetermined, so the next binding reads again instead of trusting a result
   * that arrived after the fact.
   * @param state - the account state.
   * @param operation - this read's identity and cancellation.
   */
  private async runPolicyDetermination(
    state: ClaudeAccountState,
    operation: ClaudePolicyOperation,
  ): Promise<void> {
    const { generation, controller } = operation
    const timeout = this.scheduler.setTimer(this.config.readTimeoutMs, () => { controller.abort() })
    try {
      await this.readPolicySnapshot(state, generation, controller.signal)
    } finally {
      timeout.cancel()
      if (state.policyOperation !== operation) return
      state.policyOperation = undefined
      if (state.policyController === controller) state.policyController = undefined
      // A read that produced an outcome — accepted, refused, failed — determined this
      // identity. One that was cancelled before producing anything did not, and must not be
      // read as a refusal.
      state.policyDetermined = state.policyReason !== 'cancelled'
      state.policyReady = undefined
      state.policyWaiters = 0
      this.armPolicyTimer(state)
    }
  }

  /** Register one waiter for the shared determination read. */
  private joinPolicyWait(state: ClaudeAccountState, signal?: AbortSignal): () => void {
    state.policyWaiters += 1
    let left = false
    const leave = (): void => {
      if (left) return
      left = true
      if (signal !== undefined) signal.removeEventListener('abort', leave)
      this.leavePolicyWait(state)
    }
    if (signal !== undefined) signal.addEventListener('abort', leave, { once: true })
    return leave
  }

  /**
   * Drop one waiter.
   *
   * The read stops only when nobody is waiting for it AND no binding remains: a bound
   * account owns its background determination (the poller's read, or a sibling session's),
   * and that read is bounded by its own timeout instead. Releasing the last binding is what
   * cancels it, through {@link suspend}.
   */
  private leavePolicyWait(state: ClaudeAccountState): void {
    state.policyWaiters -= 1
    if (state.policyWaiters > 0) return
    if (state.bindings.size > 0) return
    state.policyController?.abort()
  }

  /**
   * The access token one maintenance read sends for an account.
   *
   * A `read-only-import` credential's source is owned outside this plugin, so the stored record
   * is a reference rather than a token: the read resolves the credential through the use path a
   * request uses, which re-reads that source and refuses rather than falling back to whatever
   * the store happens to hold. Every other mode sends the stored credential exactly as before,
   * so no grant is spent where none was spent before.
   * @param account - the account whose credential the read uses.
   * @param stored - the stored credential the read was decided from.
   * @returns the token to send, or the failure the use path produced.
   */
  private async readAccessToken(
    account: string,
    stored: ClaudeSession,
  ): Promise<{ readonly token: string } | { readonly failure: unknown }> {
    if (claudeCredentialModeOf(stored) !== 'read-only-import') return { token: stored.accessToken }
    try {
      return { token: (await this.options.tokens.session(account)).accessToken }
    } catch (failure: unknown) {
      return { failure }
    }
  }

  /**
   * Arm the next credential check from the stored expiry.
   *
   * An unknown expiry is reported as unknown and schedules nothing: a fabricated deadline
   * would become an immediate retry loop. A credential already inside the lead window is
   * checked at once, and a failed check backs off within the configured budget.
   */
  private armCredentialTimer(state: ClaudeAccountState, session: ClaudeSession): void {
    state.credentialTimer?.cancel()
    state.credentialTimer = undefined
    if (this.disposed || state.bindings.size === 0 || state.stopped) return
    const mode = claudeCredentialModeOf(session)
    if (!claudeCredentialArmsOwnTimer(mode)) {
      // The credential belongs to Claude Code's own store, and this plugin's ownership covers
      // its own credential database only: an independently authorized credential is the one
      // thing it may rotate on its own schedule. `legacy-writeback` keeps its compatibility
      // path — the provider's on-demand synchronization and the five-minute sweep, neither of
      // which claims coordination with that holder — and `read-only-import` is read from that
      // store on every use.
      state.credentialStatus = claudeCredentialCoordinationUnproven(mode)
        ? 'external-coordination-unproven'
        : 'maintenance-unsupported'
      return
    }
    if (!Number.isFinite(session.expiresAt)) {
      state.credentialStatus = 'unknown-expiry'
      return
    }
    const now = this.clock.now()
    const due = session.expiresAt - this.config.refreshLeadMs
    const delay = state.credentialBackoffMs > 0
      ? state.credentialBackoffMs
      // A successful cycle whose refreshed credential is already inside the lead window, or
      // which returned the same expiry, would otherwise schedule at zero and spin. The floor
      // bounds that loop independently of the failure budget.
      : Math.max(due - now, this.config.minRefreshDelayMs)
    const generation = state.generation
    state.credentialTimer = this.scheduler.setTimer(delay, () => {
      state.credentialTimer = undefined
      this.trackWork(state, this.runCredentialCycle(state, generation))
    })
  }

  /** One credential maintenance cycle: read, refresh when due, re-arm from the winner. */
  private async runCredentialCycle(state: ClaudeAccountState, generation: number): Promise<void> {
    if (this.disposed || state.generation !== generation || state.bindings.size === 0) return
    state.credentialStatus = 'refreshing'
    this.notify(state.key)
    let session: ClaudeSession
    try {
      session = await this.options.tokens.session(state.identity.account)
    } catch (error: unknown) {
      if (this.disposed || state.generation !== generation) return
      const classification = this.classify(error)
      if (classification === 'permanent') {
        state.credentialStatus = 'reauth_required'
        state.credentialFailure = this.failureFrom(error, 'credential')
        this.stopScheduling(state)
        this.notify(state.key)
        return
      }
      if (classification === 'missing') {
        state.credentialStatus = 'missing'
        this.stopScheduling(state)
        this.notify(state.key)
        return
      }
      // A transient failure keeps a still-valid credential and retries inside the budget;
      // an expired one is reported as such rather than being sent.
      const stored = await this.options.tokens.peek(state.identity.account)
      state.credentialStatus = stored !== undefined && stored.expiresAt > this.clock.now()
        ? 'ready'
        : 'refreshing'
      state.credentialFailure = this.failureFrom(error, 'credential')
      state.credentialBackoffMs = this.nextBackoff(state.credentialBackoffMs)
      if (stored !== undefined) this.armCredentialTimer(state, stored)
      this.notify(state.key)
      return
    }
    if (this.disposed || state.generation !== generation || state.bindings.size === 0) return
    state.credentialStatus = 'ready'
    state.credentialFailure = undefined
    state.credentialBackoffMs = 0
    this.armCredentialTimer(state, session)
    this.notify(state.key)
  }

  /**
   * Move one state onto the organization a profile response just confirmed.
   *
   * The state keeps its bindings and its work, and changes its identity key. Everything
   * accepted while the organization was unidentified was cached under a different key, so
   * the remote policy is re-determined instead of being carried across.
   * @param state - the account state being re-keyed.
   * @param organization - the confirmed organization.
   */
  private adoptOrganization(state: ClaudeAccountState, organization: string): void {
    const previousKey = state.key
    const identity: ClaudeAccountIdentity = { ...state.identity, organization }
    state.identity = identity
    state.key = claudeIdentityKey(identity)
    if (state.profile !== undefined) state.profile = { ...state.profile, identity }
    state.policy = undefined
    state.policyStatus = 'ineligible'
    state.policyReason = 'not-evaluated'
    state.policyDetermined = false
    state.policyBodyComplete = false
    state.policyRefused = undefined
    state.policyDocumentBlocker = undefined
    state.policyRetryAt = undefined
    state.policyBackoffMs = 0
    this.states.delete(previousKey)
    this.states.set(state.key, state)
    // The new identity has no policy yet, so this is the determination that replaces the
    // one made while the organization was unconfirmed.
    if (state.bindings.size > 0) {
      state.policyDetermined = true
      this.startPolicyWork(state)
    }
    this.notify(state.key)
  }

  /** Start a profile check unless one is already running for this account. */
  private startProfileWork(state: ClaudeAccountState): void {
    if (this.disposed || state.profileInFlight !== undefined || state.stopped) return
    const generation = state.generation
    const controller = new AbortController()
    state.profileController = controller
    const pending = this.runProfileCycle(state, generation, controller)
      .finally(() => {
        if (state.profileInFlight === pending) state.profileInFlight = undefined
        if (state.profileController === controller) state.profileController = undefined
      })
    state.profileInFlight = pending
    this.trackWork(state, pending)
  }

  /** One profile check: decide, read once, adopt only what this identity confirms. */
  private async runProfileCycle(
    state: ClaudeAccountState,
    generation: number,
    controller: AbortController,
  ): Promise<void> {
    const snapshot = await this.options.tokens.snapshot(state.identity.account)
    if (this.disposed || state.generation !== generation) return
    if (snapshot === undefined) {
      state.profileReason = 'no-credential'
      this.notify(state.key)
      return
    }
    const known = knownAccountUuid(state)
    const decision = claudeProfileReadDecision({
      ...state.profile === undefined ? {} : { record: state.profile },
      identity: state.identity,
      // The confirmed identity constrains the read even before any record exists: the UUID
      // the stored credential already states is what a response must agree with.
      ...known === undefined ? {} : { knownAccountUuid: known },
      hasCredential: true,
      hasProfileScope: claudeHasProfileScope(snapshot.session),
      now: this.clock.now(),
      maxAgeMs: this.config.profileMaxAgeMs,
      ...state.profileRetryAt === undefined ? {} : { retryAfter: state.profileRetryAt },
    })
    state.profileReason = decision.reason
    const reader = this.options.readProfile
    if (!decision.needed) {
      this.notify(state.key)
      return
    }
    if (reader === undefined) {
      state.profileReason = 'reader-unavailable'
      this.notify(state.key)
      return
    }
    const credential = await this.readAccessToken(state.identity.account, snapshot.session)
    if ('failure' in credential) {
      // The external source could not serve this read. The credential dimension reports the
      // refusal; the profile keeps whatever it already confirmed.
      if (this.disposed || state.generation !== generation) return
      state.credentialStatus = this.classify(credential.failure) === 'permanent' ? 'reauth_required' : state.credentialStatus
      state.profileReason = 'no-credential'
      this.notify(state.key)
      return
    }
    state.profileController = controller
    const outcome = await readClaudeProfile({
      identity: state.identity,
      account: state.identity.account,
      accessToken: credential.token,
      credentialRevision: snapshot.revision,
      ...known === undefined ? {} : { knownAccountUuid: known },
      ...state.profile === undefined ? {} : { previous: state.profile },
      now: this.clock.now(),
      reader,
      signal: controller.signal,
    })
    if (this.disposed || state.generation !== generation) return
    switch (outcome.outcome) {
      case 'accepted': {
        // The response is judged against the credential as it stands now, not only against
        // the binding generation: another process can rotate or replace the login without
        // touching this controller's bindings.
        const after = await this.options.tokens.snapshot(state.identity.account)
        if (this.disposed || state.generation !== generation) return
        if (after === undefined || !claudeProfileStillCurrent(state, after.session.accountUuid, after.revision, snapshot.revision)) {
          state.profileFailure = {
            reason: 'PROFILE_IDENTITY_CHANGED',
            stage: 'profile',
            scope: 'account',
            origin: state.identity.origin,
            protocolFingerprint: state.identity.protocolFingerprint,
          }
          state.identityConflict = true
          this.stopScheduling(state)
          break
        }
        state.profile = outcome.record
        state.profileReason = 'fresh'
        state.profileFailure = undefined
        state.profileRetryAt = undefined
        if (outcome.record.accountUuid !== undefined && state.confirmedAccountUuid === undefined) {
          state.confirmedAccountUuid = outcome.record.accountUuid
        }
        // A response that confirms the organization moves the identity onto it. Anything
        // accepted while the organization was unidentified was cached under another key and
        // must not be inherited.
        if (state.identity.organization === undefined && outcome.record.identity.organization !== undefined) {
          this.adoptOrganization(state, outcome.record.identity.organization)
        }
        this.schedulePersist()
        break
      }
      case 'identity-changed':
        state.identityConflict = true
        state.profileFailure = outcome.failure ?? {
          reason: 'PROFILE_IDENTITY_CHANGED',
          stage: 'profile',
          scope: 'account',
        }
        this.stopScheduling(state)
        break
      case 'failed':
        state.profileFailure = outcome.failure
        if (outcome.stop) {
          // A forbidden profile failure (a client-version or permission refusal) is a hard
          // stop: it must refuse later requests and, when it names a protocol refusal, be
          // recorded in the shared block store so no second copy re-probes it.
          state.profileRefused = outcome.failure
          this.stopScheduling(state)
          void this.recordProtocolBlock(state, outcome.failure)
        } else if (outcome.retryable) {
          state.profileRetryAt = this.clock.now() + this.nextBackoff(0)
        }
        break
      case 'cancelled':
        break
    }
    this.notify(state.key)
  }

  /**
   * Start a policy check unless one is already running for this account.
   *
   * The poller and the bounded initialization share this one entry, so a check the poller
   * starts is also the read a concurrent request waits for, and no identity ever has two
   * determinations in flight.
   */
  private startPolicyWork(state: ClaudeAccountState): void {
    if (this.disposed || state.stopped) return
    this.startPolicyDetermination(state)
  }

  /**
   * Read one policy snapshot and fold it into the account state.
   *
   * Shared by the bounded initialization and the poller, so both follow the same
   * eligibility, refusal and backoff rules.
   * @param state - the account being maintained.
   * @param generation - the binding generation the read belongs to.
   * @param signal - cancellation for this read.
   */
  private async readPolicySnapshot(
    state: ClaudeAccountState,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const snapshot = await this.options.tokens.snapshot(state.identity.account)
    if (this.disposed || state.generation !== generation) return
    if (snapshot === undefined) return
    const eligibilityInput: ClaudePolicyEligibilityInput = {
      subscriptionType: this.confirmedSubscription(state, snapshot.session),
      firstPartyOAuth: this.options.isFirstPartyOAuth?.(state.identity.account) ?? true,
      hasCredential: true,
    }
    const eligibility = claudePolicyEligibility(eligibilityInput)
    state.policyReason = eligibility.reason
    if (eligibility.kind !== 'eligible') {
      // The entitlement admits no read, so no document can be established for this account and
      // nothing is sent. A restored projection stays exactly as it is: this build cannot state
      // its pin, and an account whose plan is unreadable is not evidence that a policy an
      // earlier run accepted — or the restriction it enforced — has gone away.
      state.policyStatus = 'ineligible'
      this.cancelPolicyTimer(state)
      this.notify(state.key)
      return
    }
    const fetchSettings = this.options.fetchSettings
    if (fetchSettings === undefined) {
      state.policyStatus = 'unavailable'
      state.policyReason = 'settings-fetch-unavailable'
      this.notify(state.key)
      return
    }
    if (state.policyRetryAt !== undefined && this.clock.now() < state.policyRetryAt) {
      this.notify(state.key)
      return
    }
    state.policyStatus = 'loading'
    this.notify(state.key)
    const credential = await this.readAccessToken(state.identity.account, snapshot.session)
    if ('failure' in credential) {
      // The external source could not serve this read; nothing is sent under a credential the
      // use path refused.
      if (this.disposed || state.generation !== generation) return
      state.credentialStatus = this.classify(credential.failure) === 'permanent' ? 'reauth_required' : state.credentialStatus
      state.policyStatus = state.policy === undefined ? 'unavailable' : 'stale'
      this.notify(state.key)
      return
    }
    let accessToken = credential.token
    // A conditional read is only valid for a document this process actually holds: a restored
    // projection has no settings body, so it contributes no validator and a 304 against it
    // would revalidate a document nobody read.
    const cached = state.policyBodyComplete ? state.policy : undefined
    const readOnce = (token: string): Promise<Awaited<ReturnType<typeof readClaudeManagedSettings>>> =>
      readClaudeManagedSettings({
        identity: state.identity,
        account: state.identity.account,
        accessToken: token,
        ...cached === undefined ? {} : { cached },
        now: this.clock.now(),
        consumers: this.consumers,
        fetchSettings,
        ...this.options.classifyHttpFailure === undefined
          ? {}
          : { classifyHttpFailure: this.options.classifyHttpFailure },
        signal,
      })
    let result = await readOnce(accessToken)
    if (result.outcome === 'unauthorized' && !signal.aborted) {
      // One controlled credential recovery and one replay, as the pinned client does; a
      // second rejection is reported as it stands.
      try {
        accessToken = (await this.options.tokens.session(state.identity.account, true)).accessToken
      } catch (error: unknown) {
        if (this.disposed || state.generation !== generation) return
        state.credentialStatus = this.classify(error) === 'permanent' ? 'reauth_required' : state.credentialStatus
        state.policyStatus = state.policy === undefined ? 'unavailable' : 'stale'
        state.policyFailure = result.failure
        this.notify(state.key)
        return
      }
      result = await readOnce(accessToken)
    }
    if (this.disposed || state.generation !== generation) return
    const now = this.clock.now()
    switch (result.outcome) {
      case 'accepted':
      case 'empty':
      case 'unchanged': {
        state.policy = result.snapshot
        state.policyFailure = undefined
        state.policyRetryAt = undefined
        state.policyBackoffMs = 0
        state.policyRefused = undefined
        state.policyDocumentBlocker = undefined
        // Every one of these outcomes answers with the full document: an accepted envelope
        // carries its settings, an empty success states that there are none, and a 304 was
        // only sent against a body this process already held.
        state.policyBodyComplete = true
        state.policyStatus = result.snapshot.blockers.length === 0 ? 'current' : 'blocked'
        state.policyReason = result.snapshot.blockers.length === 0 ? 'accepted' : 'unsupported-restrictions'
        this.schedulePersist()
        break
      }
      case 'refused': {
        // An explicit refusal outranks every cached restriction: the cached snapshot stays
        // for diagnosis, but no operation is allowed on the strength of it.
        state.policyRefused = result.failure
        state.policyFailure = result.failure
        state.policyStatus = 'blocked'
        state.policyReason = result.failure.reason
        this.cancelPolicyTimer(state)
        if (isProtocolRefusal(result.failure)) await this.applyProtocolRefusal(state, result.failure)
        break
      }
      case 'unauthorized': {
        state.policyFailure = result.failure
        state.policyStatus = state.policy === undefined ? 'unavailable' : 'stale'
        state.policyReason = result.failure.reason
        state.policyBackoffMs = this.nextBackoff(state.policyBackoffMs)
        state.policyRetryAt = now + state.policyBackoffMs
        break
      }
      case 'invalid': {
        // A response that cannot be validated leaves the accepted snapshot in place and
        // denies its scope: an unreadable restriction must not be dropped.
        state.policyFailure = result.failure
        state.policyDocumentBlocker = result.blocker
        state.policyStatus = state.policy === undefined ? 'unavailable' : 'stale'
        state.policyReason = result.failure.reason
        state.policyBackoffMs = this.nextBackoff(state.policyBackoffMs)
        state.policyRetryAt = now + state.policyBackoffMs
        break
      }
      case 'transient': {
        state.policyFailure = result.failure
        state.policyStatus = state.policy === undefined ? 'unavailable' : 'stale'
        state.policyReason = result.failure.reason
        state.policyBackoffMs = this.nextBackoff(state.policyBackoffMs)
        state.policyRetryAt = now + state.policyBackoffMs
        break
      }
      case 'cancelled':
        if (state.policyStatus === 'loading') {
          state.policyStatus = state.policy === undefined ? 'unavailable' : 'stale'
          state.policyReason = 'cancelled'
        }
        break
    }
    this.notify(state.key)
  }

  /** Arm the poller after a completed cycle, honouring a failure backoff. */
  private armPolicyTimer(state: ClaudeAccountState): void {
    state.policyTimer?.cancel()
    state.policyTimer = undefined
    if (this.disposed || state.bindings.size === 0 || state.stopped) return
    if (this.options.fetchSettings === undefined) return
    if (state.policyStatus === 'ineligible' || state.policyRefused !== undefined) return
    const now = this.clock.now()
    const delay = state.policyRetryAt !== undefined && state.policyRetryAt > now
      ? state.policyRetryAt - now
      : this.config.policyPollMs
    state.policyTimer = this.scheduler.setTimer(delay, () => {
      state.policyTimer = undefined
      this.startPolicyWork(state)
    })
  }

  /** Cancel the policy poller alone. */
  private cancelPolicyTimer(state: ClaudeAccountState): void {
    state.policyTimer?.cancel()
    state.policyTimer = undefined
  }

  /**
   * The subscription type maintenance may act on.
   *
   * A record captured for the same identity is the most recent validated statement; a
   * credential-derived type stands in while no record states one. An explicit null from a
   * validated response makes the type unknown, and nothing else does.
   */
  private confirmedSubscription(state: ClaudeAccountState, session: ClaudeSession): string | null | undefined {
    if (state.profile !== undefined && sameClaudeIdentity(state.profile.identity, state.identity)
      && state.profile.subscriptionType !== undefined) {
      return state.profile.subscriptionType
    }
    return session.subscriptionType ?? undefined
  }

  /**
   * Apply a protocol-configuration refusal to every account served by that configuration.
   *
   * The refusal is recorded in the shared block store first, so any account under the same
   * provider, origin and protocol fingerprint is refused at {@link ensureReady}; then every
   * matching account in this process stops its credential, profile and policy work, because
   * a configuration the service refused must not keep sending Messages or rotating
   * credentials from a sibling account. An account-scoped refusal (a permission denial, for
   * instance) never reaches this method: it stops its own policy alone.
   * @param state - the account whose read was refused.
   * @param failure - the refusal, which names the protocol configuration.
   */
  private async applyProtocolRefusal(
    state: ClaudeAccountState,
    failure: ClaudeMaintenanceFailure,
  ): Promise<void> {
    await this.recordProtocolBlock(state, failure)
    for (const other of this.states.values()) {
      if (other.identity.origin !== state.identity.origin) continue
      if (other.identity.protocolFingerprint !== state.identity.protocolFingerprint) continue
      other.policyRefused = failure
      other.policyFailure = failure
      other.policyStatus = 'blocked'
      other.policyReason = failure.reason
      this.stopScheduling(other)
      this.notify(other.key)
    }
  }

  /** Whether the injected block authority refuses this identity's configuration. */
  private async protocolBlocked(identity: ClaudeAccountIdentity): Promise<boolean> {
    const authority = this.options.protocolBlocks
    if (authority === undefined) return false
    try {
      return await authority.isBlocked({
        provider: 'claude',
        origin: identity.origin,
        fingerprint: identity.protocolFingerprint,
      })
    } catch (error: unknown) {
      this.options.onWarn?.(
        `dsh-plugin-subscriptions: claude protocol block check failed (${error instanceof Error ? error.message : String(error)})`,
      )
      // An unreadable block authority must not silently admit a possibly blocked
      // configuration, so the check fails closed.
      return true
    }
  }

  /**
   * Record a protocol-level profile refusal in the shared block store.
   *
   * The store is the reliability module's; this only adds the record, so the same refusal
   * stops the route from anywhere it is observed.
   * @param state - the account whose configuration was refused.
   * @param failure - the refusal to record, when it names a protocol refusal.
   */
  private async recordProtocolBlock(
    state: ClaudeAccountState,
    failure: ClaudeMaintenanceFailure | undefined,
  ): Promise<void> {
    if (!isProtocolRefusal(failure) || failure === undefined) return
    const authority = this.options.protocolBlocks
    if (authority?.block === undefined) return
    try {
      await authority.block({
        provider: 'claude',
        origin: state.identity.origin,
        fingerprint: state.identity.protocolFingerprint,
        reason: failure.reason,
        ...failure.serverCode === undefined ? {} : { serverCode: failure.serverCode },
      })
    } catch (error: unknown) {
      this.options.onWarn?.(
        `dsh-plugin-subscriptions: claude protocol block could not be recorded (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }

  /** The refusal one denied policy decision becomes. */
  private policyRefusal(decision: Extract<ClaudePolicyDecision, { decision: 'deny' }>): LlmError {
    return new LlmError(
      `claude request blocked by organization policy: ${decision.blocker.detail}`,
      decision.code,
      CLAUDE_FORBID,
    )
  }

  /** Classify one credential failure, through the injected classifier when there is one. */
  private classify(error: unknown): 'transient' | 'permanent' | 'missing' {
    const injected = this.options.classifyCredentialFailure
    if (injected !== undefined) return injected(error)
    if (error instanceof LlmError) {
      if (error.code === 'MISSING_CREDENTIAL') return 'missing'
      if (error.code === 'INVALID_CREDENTIAL') return 'permanent'
    }
    return 'transient'
  }

  /** Structured failure facts for one caught error, without a body, a token or a message. */
  private failureFrom(error: unknown, stage: string): ClaudeMaintenanceFailure {
    if (error instanceof LlmError) {
      const failure = error.failure
      return {
        reason: error.code,
        stage,
        scope: 'account',
        ...failure.status === undefined ? {} : { status: failure.status },
        ...failure.retryDisposition === undefined ? {} : { retryDisposition: failure.retryDisposition },
        ...failure.providerRetryAfterMs === undefined ? {} : { retryAfterMs: failure.providerRetryAfterMs },
      }
    }
    // An untyped failure's message may quote a response body, so the view carries a fixed
    // code instead of it.
    void error
    return { reason: 'CREDENTIAL_FAILURE', stage, scope: 'account' }
  }

  /** The next failure backoff, doubling to the configured ceiling. */
  private nextBackoff(current: number): number {
    const next = current === 0 ? this.config.failureBackoffMs : current * 2
    return Math.min(next, this.config.maxFailureBackoffMs)
  }

  /**
   * Track one promise against its account state and against disposal.
   *
   * A release waits for exactly the states it released; disposal waits for everything.
   * A contained background failure is reported rather than rejecting the caller that
   * started the work.
   * @param state - the account the work belongs to.
   * @param pending - the work to track.
   */
  private trackWork(state: ClaudeAccountState, pending: Promise<unknown>): void {
    this.inFlight.add(pending)
    state.work.add(pending)
    const done = (): void => {
      this.inFlight.delete(pending)
      state.work.delete(pending)
    }
    void pending.then(done, (error: unknown) => {
      done()
      this.options.onWarn?.(
        `dsh-plugin-subscriptions: claude maintenance background failure (${error instanceof Error ? error.message : String(error)})`,
      )
    })
  }

  /**
   * Record the current durable facts.
   *
   * Only validated, non-secret state is written: the profile fields a consumer needs, the
   * policy document the server accepted, and the instants that decide freshness. A write
   * failure is contained — the in-memory state stays authoritative for this run.
   */
  private schedulePersist(): void {
    const persistence = this.options.persistence
    if (persistence === undefined || this.disposed) return
    const records: ClaudePersistedAccount[] = []
    for (const state of this.states.values()) {
      const record: ClaudePersistedAccount = {
        account: state.identity.account,
        origin: state.identity.origin,
        protocolFingerprint: state.identity.protocolFingerprint,
        ...state.identity.organization === undefined ? {} : { organization: state.identity.organization },
      }
      if (state.profile !== undefined) {
        record.profile = {
          capturedAt: state.profile.capturedAt,
          credentialRevision: state.profile.credentialRevision,
          complete: state.profile.complete,
          ...state.profile.completenessVersion === undefined
            ? {}
            : { completenessVersion: state.profile.completenessVersion },
          ...state.profile.accountUuid === undefined ? {} : { accountUuid: state.profile.accountUuid },
          ...state.profile.emailAddress === undefined ? {} : { emailAddress: state.profile.emailAddress },
          ...state.profile.subscriptionType === undefined ? {} : { subscriptionType: state.profile.subscriptionType },
        }
      }
      if (state.policy !== undefined && state.policy.settings !== undefined) {
        // Only this plugin's own validated projection is stored. The server's document is
        // not: it can carry environment or hook values, and a restriction's own value
        // belongs to its consumer.
        record.policy = {
          checksum: state.policy.checksum,
          revision: state.policy.revision,
          acceptedAt: state.policy.acceptedAt,
          keys: state.policy.keys.map(entry => ({
            key: entry.key,
            scope: entry.scope,
            disposition: entry.disposition,
            detail: entry.detail,
          })),
          blockers: state.policy.blockers.map(entry => ({
            key: entry.key,
            scope: entry.scope,
            code: entry.code,
            detail: entry.detail,
          })),
          enforced: state.policy.restrictions.length > 0,
        }
      }
      if (record.profile !== undefined || record.policy !== undefined) records.push(record)
    }
    const pending = persistence.save(records).then(() => {
      // A write that completed re-establishes a document the next load can validate, so a
      // previously unavailable state stops refusing requests.
      this.stateUnavailableReason = undefined
    }).catch((error: unknown) => {
      this.options.onWarn?.(
        `dsh-plugin-subscriptions: claude maintenance state could not be saved (${error instanceof Error ? error.message : String(error)})`,
      )
    })
    this.inFlight.add(pending)
    void pending.then(() => { this.inFlight.delete(pending) })
  }

  /** Report a state change to the status projection's owner. */
  private notify(account: string): void {
    try {
      this.options.onChanged?.(account)
    } catch (error: unknown) {
      this.options.onWarn?.(
        `dsh-plugin-subscriptions: claude maintenance status listener failed (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }

  /** Project one state into the status view. */
  private viewOf(state: ClaudeAccountState): ClaudeAccountMaintenanceView {
    const completeness = claudeProfileCompleteness(state.profile)
    const freshness = claudeProfileFreshness(state.profile, this.clock.now(), this.config.profileMaxAgeMs)
    const profileStatus: ClaudeAccountMaintenanceView['profile']['status'] = state.profile === undefined
      ? (state.profileFailure === undefined ? 'missing' : 'unavailable')
      : freshness === 'fresh' ? 'fresh' : 'stale'
    return {
      account: state.identity.account,
      ...state.identity.organization === undefined ? {} : { organization: state.identity.organization },
      origin: state.identity.origin,
      protocolFingerprint: state.identity.protocolFingerprint,
      bindings: state.bindings.size,
      credential: {
        status: state.credentialStatus,
        ...state.credentialFailure === undefined ? {} : { failure: state.credentialFailure },
      },
      profile: {
        status: profileStatus,
        reason: state.profileReason,
        complete: completeness.complete,
        missing: completeness.missing,
        ...state.profile?.capturedAt === undefined ? {} : { capturedAt: state.profile.capturedAt },
        ...state.profile === undefined || state.profile.subscriptionType === undefined
          ? {}
          : { subscriptionType: state.profile.subscriptionType },
        ...state.profileFailure === undefined ? {} : { failure: state.profileFailure },
      },
      policy: {
        status: state.policyStatus,
        reason: state.policyReason,
        blockers: state.policyDocumentBlocker === undefined
          ? (state.policy?.blockers ?? [])
          : [state.policyDocumentBlocker, ...state.policy?.blockers ?? []],
        keys: state.policy?.keys ?? [],
        ...state.policy?.acceptedAt === undefined ? {} : { fetchedAt: state.policy.acceptedAt },
        ...state.policy === undefined || state.policy.checksum.length === 0
          ? {}
          : { checksum: state.policy.checksum },
        ...state.policyFailure === undefined ? {} : { failure: state.policyFailure },
      },
    }
  }
}

/**
 * The eligibility verdict one account's confirmed metadata produces.
 *
 * Exposed so a caller that only wants the status (a settings card or a diagnostic dump)
 * can compute it without a controller or a network read.
 * @param input - confirmed subscription type, credential and path facts.
 * @returns the eligibility verdict.
 */
export function claudeMaintenanceEligibility(input: ClaudePolicyEligibilityInput): ClaudePolicyEligibility {
  return claudePolicyEligibility(input)
}
