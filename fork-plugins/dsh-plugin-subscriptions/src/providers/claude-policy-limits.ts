/**
 * The plugin's `policy_limits` owner: one independent document per Claude account, read on a
 * live binding's own schedule, plus the DSH operation mapping its verdicts are enforced on.
 *
 * Everything protocol-shaped lives in `src/claude-core/` (parse, validator, retry budget,
 * verdict order); this module owns only what is plugin-side: which accounts are eligible,
 * which reads are in flight, what was adopted, when the next read may run, what the status
 * card shows, and which DSH operation a key's verdict reaches.
 *
 * The document is independent of the managed-settings policy: its own cache file, its own
 * validator, its own single-flight. A failure keeps the last adopted document (stale) rather
 * than dropping a known restriction. A stored record is restored as an unverified snapshot
 * that may only narrow the gate, and a store that cannot be trusted refuses the operations it
 * might otherwise have restricted.
 */

import { POLICY_KEYS, policyRegistration } from '../claude-core/policy-registry.js'
import type { PolicyKey } from '../claude-core/policy-registry.js'
import {
  DEFAULT_POLICY_VERDICT_INPUTS,
  evaluateLivePolicy,
  evaluateWithoutLivePolicy,
} from '../claude-core/no-live-policy.js'
import type { PolicyAnswer, PolicyVerdictInputs } from '../claude-core/no-live-policy.js'
import type { PolicyLimitsDocument } from '../claude-core/policy-limits.js'
import { controlRequirements, isKnownControlKey } from '../claude-core/control-requirements.js'
import type { ControlRequirements } from '../claude-core/control-requirements.js'
import { policyLimitsEligibility } from '../claude-core/eligibility.js'
import type { PolicyLimitsEligibility } from '../claude-core/eligibility.js'
import { coreFailure } from '../claude-core/failures.js'
import type { CoreFailure } from '../claude-core/failures.js'
import { parseOrgPin, validateOrgPin } from '../claude-core/org-pin.js'
import type { OrgPinParse } from '../claude-core/org-pin.js'
import { readPolicyLimits } from '../claude-core/policy-limits-client.js'
import type { PolicyLimitsReadOperation, PolicyPriorContext } from '../claude-core/policy-limits-client.js'
import type { CoreClock, CoreHttpRequest, CoreHttpResponse, CoreSleep, CoreTransport } from '../claude-core/policy-limits-client.js'
import type {
  ClaudePersistedPolicyLimitsDefault,
  ClaudePersistedPolicyLimitsRecord,
  ClaudePersistedPolicyLimitsRestriction,
  ClaudePolicyLimitsLoadResult,
  ClaudePolicyLimitsStateError,
  ClaudePolicyLimitsStateStore,
} from './claude-policy-limits-state.js'
import { CLAUDE_POLICY_KNOWN_DEFAULT_KEYS } from './claude-policy-limits-state.js'
import { ClaudePolicyLimitsStateFailure } from './claude-policy-limits-state.js'

/** The pinned first-party origin this build serves. */
export const CLAUDE_DEFAULT_POLICY_ORIGIN = 'https://api.anthropic.com'

/** The scope a first-party subscription credential must carry for inference. */
export const CLAUDE_INFERENCE_SCOPE = 'user:inference'

/** The plugin facts the core's eligibility decision is built from. */
export interface PolicyLimitsEligibilityFacts {
  /** Whether this account is served by the plugin's own first-party OAuth path. */
  readonly firstPartyOAuth: boolean
  /** Whether the endpoint base is the pinned default one, not a configured override. */
  readonly defaultBaseUrl: boolean
  /** The stored credential's scopes, exactly as stored. */
  readonly scopes: string
  /** The stored credential's access token, when one is present. */
  readonly accessToken?: string | undefined
  /** The confirmed subscription type, exactly as the stored credential stated it. */
  readonly subscriptionType?: string | null | undefined
}

/**
 * Build the core's eligibility decision from one account's stored facts.
 *
 * The rule itself is the core's; this only reads the plugin's own credential shape —
 * presence of a token, the scope list as stored (nothing is trimmed into a match), and the
 * configured endpoint base.
 * @param facts - the stored account facts.
 * @returns the core's decision.
 */
export function policyLimitsEligibilityFor(facts: PolicyLimitsEligibilityFacts): PolicyLimitsEligibility {
  return policyLimitsEligibility({
    firstPartyOAuth: facts.firstPartyOAuth,
    defaultBaseUrl: facts.defaultBaseUrl,
    hasAccessToken: (facts.accessToken ?? '').length > 0,
    hasInferenceScope: facts.scopes.split(/\s+/).includes(CLAUDE_INFERENCE_SCOPE),
    subscriptionType: facts.subscriptionType,
  })
}

/**
 * Read the pinned organizations out of an adopted managed-settings document.
 *
 * The three-state rule is the core's, and this wrapper only makes the absence distinction the
 * core's parse input cannot see. The pinned settings preprocessing deletes a null
 * `forceLoginOrgUUID` member before it is adopted, so a null value here is the same fact as an
 * absent one and must never turn a valid session into a refusal. Any other unusable shape — an
 * empty string, an empty array, or a member that is not a string — stays `invalid`, because
 * that is a refusal rather than an absence.
 * @param settings - the adopted settings document, when one was accepted.
 * @returns the pin state.
 */
export function orgPinFromSettings(settings: unknown): OrgPinParse {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return { kind: 'none' }
  const record = settings as Record<string, unknown>
  if (!Object.hasOwn(record, 'forceLoginOrgUUID')) return { kind: 'none' }
  const value = record['forceLoginOrgUUID']
  // The preprocessing the pinned client applies deletes a null member, so it reads as absent.
  if (value === null) return { kind: 'none' }
  return parseOrgPin(value)
}

/**
 * One DSH operation a policy key's verdict can reach.
 *
 * These are the operations this plugin actually performs or serves for a Claude-attributed
 * session. A key is only ever mapped onto one of them; nothing is inferred from a key's name.
 */
export type DshPolicyOperation =
  /** The provider's own model inference request. */
  | 'provider.messages'
  /** This plugin's provider catalogue fetch over the network, not a local model listing. */
  | 'provider.catalog_fetch'
  /** Any other egress this plugin performs for that session. */
  | 'provider.network'
  /** The harness's own web-fetch capability, when one is declared and executed. */
  | 'web_fetch'
  /** A file-transfer capability performed for that session. */
  | 'file_transfer'
  /** A tool the Host owns, executed on behalf of that session. */
  | 'host.tools'

/** How one key's verdict is enforced. */
export type PolicyKeyMapping =
  /** The key reaches exactly these operations. */
  | { readonly enforcement: 'enforced'; readonly operations: readonly DshPolicyOperation[] }
  /**
   * This build cannot establish the exact operation the key reaches, and the capability
   * exists here: the attributed session's operations are conservatively refused.
   */
  | { readonly enforcement: 'unsupported'; readonly operations: readonly DshPolicyOperation[]; readonly reason: string }
  /** This build has no such capability at all, with the exact reason recorded. */
  | { readonly enforcement: 'inapplicable'; readonly reason: string }

/** The conservative set an unprovable key reaches inside the attributed session. */
const ATTRIBUTED_OPERATIONS: readonly DshPolicyOperation[] = [
  'provider.messages',
  'provider.catalog_fetch',
  'provider.network',
  'web_fetch',
  'file_transfer',
  'host.tools',
]

/**
 * The mapping table: exact where this build can prove it, otherwise declared.
 *
 * Typed as a total record over the pinned key union, so a key added to the registry stops
 * this build compiling until its disposition is stated here.
 *
 * It states what *this provider* does with a key: a capability the provider does not perform
 * reaches no operation, and the table is not a claim that the rest of the harness enforces the
 * analyzed client's organization policy.
 */
const POLICY_KEY_MAPPING: Readonly<Record<PolicyKey, PolicyKeyMapping>> = Object.freeze({
  // The catalogue fetch this plugin performs for the provider's own model list. Inference is a
  // different operation, and listing already-known local models is not an operation at all.
  allow_model_catalog: { enforcement: 'enforced', operations: ['provider.catalog_fetch'] },
  // The client's own file-send capability has no verified consumer here: a cross-session
  // send is not this plugin's Messages attachment transfer, so ordinary uploads are not
  // blocked under this key until that consumer is established.
  allow_send_file: { enforcement: 'unsupported', operations: ['file_transfer'], reason: 'no verified consumer for the send-file capability in this provider' },
  // A web-fetch refusal reaches the harness's own web-fetch capability, never this plugin's
  // egress and never a search tool. Without a verified tool identity it stays a typed
  // unsupported entry rather than blocking unrelated provider traffic.
  allow_web_fetch: { enforcement: 'unsupported', operations: ['web_fetch'], reason: 'no verified web-fetch tool identity in this composition' },
  // The capability exists in the harness but this plugin serves none of it.
  allow_account_plugins_sync: { enforcement: 'inapplicable', reason: 'plugins are owned by the host, not this provider' },
  allow_account_skills_sync: { enforcement: 'inapplicable', reason: 'skills are owned by the host, not this provider' },
  allow_bundled_skills: { enforcement: 'inapplicable', reason: 'bundled skills are shipped by the host' },
  allow_plugin_directory_search: { enforcement: 'inapplicable', reason: 'plugin search is owned by the host' },
  allow_plugin_skill_search: { enforcement: 'inapplicable', reason: 'skill search is owned by the host' },
  allow_design_sync: { enforcement: 'inapplicable', reason: 'this provider has no design-sync surface' },
  allow_memory_sync: { enforcement: 'inapplicable', reason: 'this provider has no memory surface' },
  allow_team_onboarding: { enforcement: 'inapplicable', reason: 'this provider has no onboarding surface' },
  allow_projects_tool: { enforcement: 'inapplicable', reason: 'this provider has no projects surface' },
  allow_heap_dump: { enforcement: 'inapplicable', reason: 'this provider never writes a heap dump' },
  allow_insights: { enforcement: 'inapplicable', reason: 'this provider exposes no insights command; a report that scans local history and issues section model queries belongs to the client/tool surface, so a request for one is a typed unsupported feature here, never a refusal of Messages' },
  allow_mycelium: { enforcement: 'inapplicable', reason: 'this provider has no such subsystem' },
  allow_promo_offers: { enforcement: 'inapplicable', reason: 'this provider renders no offers' },
  allow_product_feedback: { enforcement: 'inapplicable', reason: 'this provider collects no feedback' },
  allow_error_reporting: { enforcement: 'inapplicable', reason: 'this provider sends no error reports' },
  allow_remote_control: { enforcement: 'inapplicable', reason: 'this provider exposes no remote control' },
  allow_remote_sessions: { enforcement: 'inapplicable', reason: 'this provider exposes no remote sessions' },
  allow_claude_browser_extension: { enforcement: 'inapplicable', reason: 'no browser extension is driven here' },
  allow_connector_suggest: { enforcement: 'inapplicable', reason: 'this provider suggests no connectors' },
  allow_auto_mode_sibling_docs: { enforcement: 'inapplicable', reason: 'this provider has no sibling-document surface' },
  allow_previous_conversation_pointer: { enforcement: 'inapplicable', reason: 'the pointer is a conversation-layer meta message appended to a transcript, not the cc_prev_req billing field and not a request header; this provider injects no prompt content and never alters ordinary continuation' },
  allow_mcp_task_worker_wake: { enforcement: 'inapplicable', reason: 'this provider runs no MCP task worker' },
  allow_cobalt_plinth: { enforcement: 'inapplicable', reason: 'this provider has no such subsystem' },
  allow_container_result_files: { enforcement: 'inapplicable', reason: 'this provider runs no container' },
  allow_local_checkpoint_commit: { enforcement: 'inapplicable', reason: 'this provider commits no checkpoint' },
  allow_cache_keepalive: { enforcement: 'inapplicable', reason: 'this provider keeps no prompt cache alive on its own' },
  allow_api_auth_warm: { enforcement: 'inapplicable', reason: 'this provider performs no auth warm-up request' },
  // The analyzed client's repository visibility probe is an HTTP call to a repository host,
  // and this provider performs none: refusing Host tools for it would deny capabilities the
  // key does not reach at all. A general git or shell operation is a different capability.
  allow_repo_visibility_probe: { enforcement: 'inapplicable', reason: 'this provider performs no repository visibility HTTP probe; the key does not reach general git or shell operations' },
  // The three transcriptScan keys gate a local session-transcript scan behind a client view
  // (usage, usage stats, skill token counts). The scan is local-only and belongs to the
  // client/session-query surface: this provider neither scans nor transmits transcripts, and
  // a deny must never widen into transcript reads, persistence or Messages.
  allow_skill_doctor_transcript_scan: { enforcement: 'inapplicable', reason: 'the skill token-count view is a local session-transcript scan owned by the client/session-query surface; this provider scans and transmits no transcripts' },
  allow_stats_transcript_scan: { enforcement: 'inapplicable', reason: 'the usage-stats view is a local session-transcript scan owned by the client/session-query surface; this provider scans and transmits no transcripts' },
  allow_usage_transcript_scan: { enforcement: 'inapplicable', reason: 'the usage-pattern view is a local session-transcript scan owned by the client/session-query surface; this provider scans and transmits no transcripts' },
})

/**
 * The enforcement one policy key resolves to.
 *
 * A key this build does not map is not assumed harmless: it reaches the attributed session's
 * operations conservatively, and the reason says so.
 * @param key - the policy key.
 * @returns the mapping, with a recorded reason when it is not an exact one.
 */
export function policyKeyMapping(key: string): PolicyKeyMapping {
  const mapped = Object.hasOwn(POLICY_KEY_MAPPING, key)
    ? POLICY_KEY_MAPPING[key as PolicyKey]
    : undefined
  if (mapped !== undefined) return mapped
  if (policyRegistration(key) === undefined) {
    return { enforcement: 'unsupported', operations: ATTRIBUTED_OPERATIONS, reason: 'key is outside the pinned registry' }
  }
  return { enforcement: 'unsupported', operations: ATTRIBUTED_OPERATIONS, reason: 'this build has no exact mapping for the key' }
}

/** Every registered key, so a build change is visible rather than silent. */
export const POLICY_MAPPING_GAPS: readonly string[] = Object.freeze(
  POLICY_KEYS.filter(key => POLICY_KEY_MAPPING[key] === undefined),
)

/**
 * A reason this account's policy is not answered from a document this process confirmed.
 *
 * Every code is fixed and is the only thing a refusal carries: a snapshot's blind spot, or a
 * store that could not be trusted, never quotes a remote value.
 */
export type PolicyLimitsBlockerCode =
  /** The durable store exists but cannot be trusted; a restriction may have been lost. */
  | 'policy_limits_state_unavailable'
  /** The stored document stated restriction keys this build cannot re-state. */
  | 'policy_limits_unknown_keys'
  /** The stored document named core skills, whose names are not retained. */
  | 'policy_limits_core_skills_unstored'
  /** The stored document's taints did not all normalize, so its taint set is incomplete. */
  | 'policy_limits_lossy_taints'

/**
 * One capability an accepted document configures that this build does not provide.
 *
 * It is reported, never enforced: a capability default is a per-capability value, so losing
 * one is not evidence that any policy key was restricted, and it must not turn into a
 * whole-request refusal.
 */
export interface PolicyLimitsUnsupportedScope {
  /** The capability the document configures, named when this build knows it. */
  readonly scope: string
  /** The fixed reason it cannot be applied here. */
  readonly reason: string
}

/** The monitoring notice an account's accepted document states. */
export interface PolicyLimitsNotice {
  /** The notice text, already normalized and bounded by the core's own parse. */
  readonly text: string
  /**
   * The notice URL, when the server stated a usable https one, or `null`. It is text for a
   * caller to render; this plugin never follows it.
   */
  readonly url: string | null
}

/** One account's status projection. */
export interface PolicyLimitsStatus {
  state: 'ineligible' | 'loading' | 'current' | 'stale' | 'unavailable' | 'blocked'
  reason: string
  fetchedAt?: number
  /**
   * What the verdicts are being answered from: an accepted document confirmed by this
   * process (`live`), a document kept through a failed read or restored from the store
   * (`stale`), or nothing at all (`none`, where the no-live-policy order answers). It is the
   * same distinction the fallback path uses, so a status card never has to infer it from the
   * reason code.
   */
  fallback: 'live' | 'stale' | 'none'
  /** Keys the live document explicitly refused, for the status card. */
  deniedKeys?: readonly string[]
  /**
   * The pure core failure the last read produced, when it failed. It is the same value the
   * read result carries and holds no response body: the code, the fixed sub-reason, the
   * status and the retry disposition only.
   */
  failure?: CoreFailure
  /** The blockers in force; while any is present, every verdict is refused. */
  blockers?: readonly PolicyLimitsBlockerCode[]
  /** Whether the documents in this state were confirmed by this process. */
  verified?: boolean
  /** Whether a monitoring notice is in force; read its text with `monitoringNotice`. */
  notice?: boolean
  /** The normalized compliance taints in force. */
  taints?: readonly string[]
  /** Capabilities the document configures that this build does not provide. */
  unsupportedScopes?: readonly PolicyLimitsUnsupportedScope[]
  /**
   * The control obligations the document in force states, when it states any.
   *
   * It is the document's own `restrictions` read through the control family's tri-state, and it
   * is reported beside `unsupportedScopes` rather than merged into it: a capability default and
   * a control obligation are different statements. A member of
   * {@link ControlRequirements.unsupportedActiveControls} refuses no operation.
   */
  controlRequirements?: ControlRequirements
}

/** The identity one account's policy state belongs to. */
export interface PolicyLimitsIdentity {
  /** Canonical account key. */
  readonly account: string
  /** Organization UUID the credential states, when it states one. */
  readonly accountUuid?: string | undefined
  /** Confirmed organization, when one is known. */
  readonly organization?: string | undefined
  /** Endpoint origin this identity's requests target. */
  readonly origin: string
  /** Protocol-profile fingerprint this identity was read under. */
  readonly profileFingerprint: string
  /**
   * Credential lease epoch, when the caller has one. A new login keeps the canonical account
   * key, so the epoch is what keeps the earlier lease's state from being reused for it.
   */
  readonly epoch?: string | undefined
}

/** The fence value one identity contributes to a state key. */
function identityFence(identity: PolicyLimitsIdentity): string {
  return [
    identity.account,
    identity.accountUuid ?? '',
    identity.organization ?? '',
    identity.origin,
    identity.profileFingerprint,
    identity.epoch ?? '',
  ].join('|')
}

/** One account's adopted state. */
interface AccountState {
  /**
   * The canonical account key this state is installed under. It is the state map's own key,
   * and the only key this owner resolves a state by: a caller's identity names the account
   * too, and the two agree because the identity is normalized to it.
   */
  readonly account: string
  /** The identity this state belongs to; a different identity never reuses it. */
  identity: PolicyLimitsIdentity
  /** Incremented whenever this state is invalidated; every async step captures it. */
  generation: number
  /** Sessions currently routing to this account; a cadence exists only while this is non-empty. */
  readonly bindings: Set<string>
  /** The armed refresh, tagged with the operation token it belongs to. */
  cadence: CadenceSlot | undefined
  /** The controller owning the read in flight; aborting it stops the I/O, not a waiter. */
  controller: AbortController | undefined
  /** How many documents this identity has confirmed; the persisted record's compare-and-swap token. */
  revision: number
  validator: string | undefined
  document: PolicyLimitsDocument
  receivedAt: number
  /**
   * What this account held before the read in flight: the core's own prior context. A
   * `live` or `stale` prior is never replaced by a fail-open answer, and the status
   * projection carries the same value.
   */
  prior: PolicyPriorContext
  status: PolicyLimitsStatus
  /**
   * Whether the monitoring notice's text was read by this process. A restored record keeps
   * only the notice's existence, so its text stays unknown until a confirmed read states it.
   */
  noticeTextKnown: boolean
  /**
   * How many `defaults` entries the accepted document stated that this build cannot type or
   * does not know. Their values are never retained, and they are reported, never enforced.
   */
  unknownDefaults: number
  /**
   * Whether a read or a restore has settled an observation into this state. Until it has, the
   * account has nothing to report and a read in flight is the only fact there is.
   */
  settled: boolean
  inFlight: Promise<PolicyLimitsReadResult> | undefined
  /**
   * Whether the documents in this state were confirmed by this process against this
   * account's own credential. A snapshot restored from disk starts unverified, and an
   * unverified snapshot never contributes a conditional-request validator: a string that
   * happens to parse is not evidence that the same identity is still live.
   */
  verified: boolean
  /**
   * Blockers in force: while any is present, no verdict is answered from the document,
   * because the evidence behind it is known to be incomplete or untrusted. A confirmed
   * document clears them.
   */
  blockers: readonly PolicyLimitsBlockerCode[]
  /** Keys and reasons the mapping could not enforce exactly, for the status card. */
  unsupported: readonly { key: string; reason: string }[]
  /** Work this state owns besides its read, so a release waits for exactly what it started. */
  readonly work: Set<Promise<unknown>>
}

/** One armed cadence, identified by the operation that armed it. */
interface CadenceSlot {
  /** Generation the cadence belongs to. */
  readonly generation: number
  /**
   * Identity of this arming. A cancel, a suspension and a replacement all leave an older
   * token behind, and only the token a state still holds may fire or re-arm.
   */
  readonly token: object
  /** Cancel the armed timer. */
  cancel(): void
}

/** What one read attempt resolved to, for the caller's scheduling. */
export interface PolicyLimitsReadResult {
  readonly outcome: 'current' | 'stale' | 'unavailable'
  /**
   * The stable outcome code for this attempt, in the vocabulary consumers map onto their own
   * codes. The classifier's specific fixed sub-reason travels in `failure`, never flattened
   * into this value.
   */
  readonly reason: string
  /**
   * The pure core failure this attempt produced, when it failed. The classifier's fixed
   * sub-reason is preserved here — a refusal such as `CLIENT_VERSION_UNSUPPORTED` is never
   * flattened into the coarse code — and it carries no response body.
   */
  readonly failure?: CoreFailure
}

/** One failed read, as the caller's own failure handler receives it. */
export interface PolicyLimitsReadFailure {
  /** Canonical account key the read belonged to. */
  readonly account: string
  /** The identity that produced the failure; a read for another identity never reports here. */
  readonly identity: PolicyLimitsIdentity
  /**
   * The pure core failure: the stable code, the classifier's fixed sub-reason, the observed
   * status and the retry disposition. It carries no response body.
   */
  readonly failure: CoreFailure
}

/** What this owner's durable store resolved to. */
export type PolicyLimitsStorageStatus =
  /** No store was injected: nothing is read or written. */
  | { readonly status: 'none' }
  /** A store was injected and hydration has not run yet. */
  | { readonly status: 'pending' }
  /** The store was never written. */
  | { readonly status: 'cold' }
  /** The restored records, one per account. */
  | { readonly status: 'loaded'; readonly accounts: number }
  /** A store exists but cannot be trusted; the caller must keep failing closed. */
  | { readonly status: 'unavailable'; readonly error: ClaudePolicyLimitsStateError }

/** The owner's injected dependencies. */
export interface ClaudePolicyLimitsOptions {
  /** Absolute endpoint base, without the path. */
  readonly baseUrl: string
  /** User agent the read carries. */
  readonly userAgent: string
  /** The transport this plugin performs the read with. */
  readonly transport: CoreTransport
  /** Resolve one account's access token; the caller owns refresh and its single-flight. */
  readonly accessToken: (account: string) => Promise<string>
  /** Time source. */
  readonly clock?: CoreClock
  /** Cancellable sleep used between retries. */
  readonly sleep?: CoreSleep
  /** Random source for the retry jitter. */
  readonly random?: () => number
  /** Injected verdict inputs; the defaults are this build's documented configuration. */
  readonly verdictInputs?: PolicyVerdictInputs
  /** Warning sink for a contained read failure. */
  readonly onWarn?: (message: string) => void
  /** Refresh interval for a bound account's cadence; defaults to the pinned one. */
  readonly pollMs?: number
  /** Timer source for the cadence; defaults to the process timers. */
  readonly scheduler?: ClaudePolicyLimitsScheduler
  /**
   * The forced refresh the reader performs at most once after a 401. It must be the plugin's
   * real forced-refresh path; a cached token read is not a refresh and is not used here.
   */
  readonly refreshOnUnauthorized?: ((account: string) => Promise<string>) | undefined
  /** The unified failure classifier the reader hands one bounded read to. */
  readonly classifyFailure?: PolicyLimitsReadOperation['classifyFailure']
  /**
   * The durable store of adopted documents. Absent keeps this owner in memory only.
   *
   * The store is read by {@link ClaudePolicyLimitsOwner.hydrate} and written on adoption; the
   * caller injects it so its path comes from the harness home the plugin already configures.
   */
  readonly persistence?: ClaudePolicyLimitsStateStore
  /**
   * The caller's one side effect for a failed read, called with the account, the identity the
   * read belonged to and the pure core failure.
   *
   * This is the caller's only opportunity to record a shared protocol block, and the owner
   * awaits it before the read result settles: a caller that observes the terminal result knows
   * the record it asked for is durable, so the request path and a background cadence read
   * cannot both write it. The owner itself records no block.
   *
   * The handler runs inside this owner's own failure path, so it must not await work that
   * waits for this read to settle: it sets its fence and stops cadences synchronously — see
   * {@link ClaudePolicyLimitsOwner.stopCadence} — and schedules anything asynchronous after
   * returning rather than awaiting it here.
   */
  readonly readFailure?: (event: PolicyLimitsReadFailure) => void | Promise<void>
  /**
   * Called after any observable state change (an adoption, a failure, a restore, a release),
   * so a status projection re-reads. It is a notification only: this owner registers no
   * route and the callback must not re-enter it synchronously.
   */
  readonly onChanged?: (account: string) => void
}

/** The default clock. */
const SYSTEM_CLOCK: CoreClock = { now: () => Date.now() }

/** The pinned refresh interval a bound account's policy document is re-read on. */
export const POLICY_LIMITS_POLL_MS = 3_600_000

/** The timer source the owner's cadence uses. */
export interface ClaudePolicyLimitsScheduler {
  /**
   * Run one callback after the delay.
   * @param delayMs - the delay in milliseconds.
   * @param run - the callback.
   * @returns a canceller for the armed timer.
   */
  after(delayMs: number, run: () => void): () => void
}

/** The process timers, kept off the event loop's critical path. */
const SYSTEM_SCHEDULER: ClaudePolicyLimitsScheduler = {
  after: (delayMs, run) => {
    const timer = setTimeout(run, delayMs)
    timer.unref()
    return () => clearTimeout(timer)
  },
}

/** A cancellable sleep over the process timers. */
const SYSTEM_SLEEP: CoreSleep = (ms, signal) => new Promise<void>((resolve) => {
  if (signal.aborted) { resolve(); return }
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
  function stop(): void { clearTimeout(timer); resolve() }
  signal.addEventListener('abort', stop, { once: true })
})

/**
 * The `policy_limits` owner.
 *
 * One document per account, adopted on success and kept on failure. Reads for one account are
 * single-flight: a second caller joins the read already running instead of starting another.
 * Nothing here refreshes a credential — the caller passes an access token resolver, and the
 * core's reader performs its one bounded replay through the same resolver.
 */
export class ClaudePolicyLimitsOwner {
  private readonly states = new Map<string, AccountState>()
  private readonly inFlight = new Set<Promise<unknown>>()
  /**
   * A pending identity handover per account: the previous state's cleanup, awaited before the
   * replacement starts its own read so two identities never read for one account at once.
   */
  private readonly handovers = new Map<string, Promise<void>>()
  private hydration: Promise<void> | undefined
  private storage: PolicyLimitsStorageStatus
  private storeBlocked = false
  private disposed = false

  constructor(private readonly options: ClaudePolicyLimitsOptions) {
    this.storage = options.persistence === undefined ? { status: 'none' } : { status: 'pending' }
  }

  /** The timer source this owner's cadence uses. */
  private get scheduler(): ClaudePolicyLimitsScheduler {
    return this.options.scheduler ?? SYSTEM_SCHEDULER
  }

  /**
   * The status of one account; a pure read that starts no request.
   *
   * `loading` is derived from the read in flight rather than stored, and only for an account
   * with no settled observation yet. Once a read or a restore has settled, that observation is
   * what the account is judged by: a refresh in flight never hides it, and never hides a
   * recorded failure behind a loading state.
   */
  status(account: string): PolicyLimitsStatus | undefined {
    const state = this.states.get(account)
    if (state === undefined) return undefined
    const document = state.document
    const reading = state.inFlight !== undefined && !state.settled
    const scopes = unsupportedScopes(
      document,
      state.unknownDefaults,
      document.monitoringNotice !== null && !state.noticeTextKnown,
    )
    // A document that answered neither control states no obligation, so the field is omitted
    // rather than reported as two `unknown` requirements this account never received.
    const controls = controlRequirements(document)
    return {
      ...state.status,
      state: reading ? 'loading' : state.status.state,
      reason: reading ? 'reading' : state.status.reason,
      blockers: state.blockers,
      verified: state.verified,
      ...document.monitoringNotice === null ? {} : { notice: true },
      ...document.complianceTaints.length === 0 ? {} : { taints: document.complianceTaints },
      ...scopes.length === 0 ? {} : { unsupportedScopes: scopes },
      ...controls === undefined ? {} : { controlRequirements: controls },
    }
  }

  /** Every account this owner knows, for the status projection. */
  accounts(): readonly string[] {
    return [...this.states.keys()]
  }

  /** What this owner's durable store resolved to; a pure read. */
  storageStatus(): PolicyLimitsStorageStatus {
    return this.storage
  }

  /**
   * Install the stored snapshots. Safe to call once; later calls return the same promise.
   *
   * A stored record is installed unverified: it keeps the refusals it stated, contributes no
   * conditional-request validator, and answers the reader as a `stale` prior so a missing
   * route can no longer fail open. A store that cannot be trusted installs no record and
   * blocks every account until a confirmed read replaces the missing evidence.
   * @returns a promise that settles once the stored records are installed.
   */
  hydrate(): Promise<void> {
    this.hydration ??= this.loadStore().catch(() => {
      // Every path inside the load reports its own fixed code; this only keeps a caller that
      // awaits hydration from seeing a rejection instead of the state it resolved to.
      this.options.onWarn?.('dsh-plugin-subscriptions: claude policy_limits state hydration failed (hydration_failed)')
    })
    return this.hydration
  }

  /**
   * Start this account's own refresh cadence, once a live binding exists for it.
   *
   * The cadence is armed only here: an account with no bound session is never polled. It is
   * idempotent for one operation, and it reschedules only after a read settles, so a slow
   * read cannot stack requests.
   * @param account - the canonical account key.
   */
  arm(account: string): void {
    const state = this.states.get(account)
    if (this.disposed || state === undefined || state.bindings.size === 0) return
    if (state.cadence !== undefined) return
    this.scheduleCadence(state, account, state.generation)
  }

  /** The keys and reasons this build cannot enforce exactly, for one account. */
  unsupported(account: string): readonly { key: string; reason: string }[] {
    return this.states.get(account)?.unsupported ?? []
  }

  /**
   * The operation-permission keys this account's live document states, including keys outside
   * the pinned registry.
   *
   * It is the one key-level fact an operation consumer needs, and the only part of an adopted
   * document this owner hands out: the stated values, the `defaults` map, the monitoring-notice
   * text and the core skill names stay inside the owner, and the persisted projection never
   * keeps an unregistered key's name at all.
   *
   * The document's known control obligations are classified out here: they name an obligation
   * rather than an operation this provider performs, `status` reports them through its own
   * `controlRequirements`, and handing them to a consumer's operation mapping would refuse
   * operations the control does not reach. Every other stated key — an unknown one included — is
   * still reported.
   * @param account - the canonical account key.
   * @returns the stated operation-permission keys, or none when no document answers this account.
   */
  restrictionKeys(account: string): readonly string[] {
    return Object.keys(this.liveDocument(account)?.restrictions ?? {}).filter(key => !isKnownControlKey(key))
  }

  /**
   * The monitoring notice this account's accepted document states, when this process has read
   * it.
   *
   * The text is the core's own normalized, bounded projection of the server's notice, and the
   * url is only ever a usable https value; the caller renders them and never follows the url
   * itself. A snapshot restored from the store kept the notice's existence without its text,
   * so this answers `undefined` there while the status reports `notice: true` and a
   * `policy-notice` scope states that the notice is shown after the next confirmed read. The
   * pending text refuses no operation: a notice restricts no key.
   * @param account - the canonical account key.
   * @returns the notice, or `undefined` when none is in force or its text is not known here.
   */
  monitoringNotice(account: string): PolicyLimitsNotice | undefined {
    const state = this.states.get(account)
    if (state === undefined || !state.noticeTextKnown) return undefined
    const notice = this.liveDocument(account)?.monitoringNotice
    if (notice === undefined || notice === null) return undefined
    return { text: notice.text, url: notice.url }
  }

  /**
   * Answer one policy question for one account.
   *
   * While a blocker is in force nothing is answered from the document: an incomplete or
   * untrusted snapshot could have restricted the key, so the operation is refused. Otherwise
   * an account with no adopted document is answered by the no-live-policy order using this
   * build's injected inputs; the caller decides whether that answer blocks an operation.
   * @param account - the canonical account key.
   * @param key - the policy key.
   * @returns the core's answer.
   */
  verdict(account: string, key: string): PolicyAnswer {
    const state = this.states.get(account)
    if (state !== undefined && state.blockers.length > 0) {
      const reason = state.blockers[0]
      return { verdict: 'deny', reason, failure: coreFailure('request_failed', { reason }) }
    }
    const inputs = this.options.verdictInputs ?? DEFAULT_POLICY_VERDICT_INPUTS
    const document = this.liveDocument(account)
    if (document === undefined) return evaluateWithoutLivePolicy(key, inputs)
    return evaluateLivePolicy(key, document, document.complianceTaints, inputs)
  }

  /**
   * Read one account's document, joining a read already running for it.
   * @param account - the canonical account key.
   * @param options - the explicit force, the binding session and the caller's cancellation.
   * @returns what the account's state is after the attempt.
   */
  async ensure(
    account: string,
    options: { force?: boolean; sessionId?: string; signal?: AbortSignal } = {},
  ): Promise<PolicyLimitsReadResult> {
    if (this.disposed) return { outcome: 'unavailable', reason: 'disposed' }
    // A stored snapshot is installed before any read: a request must never be judged by a
    // projection that is still loading, and a restore must never land on top of a read.
    await this.hydration
    await this.handoverFor(account)
    const state = this.states.get(account)
    if (state === undefined) return { outcome: 'unavailable', reason: 'no-identity' }
    if (options.sessionId !== undefined) state.bindings.add(options.sessionId)
    // A state this process already confirmed answers a readiness check: only an explicit
    // force (a poll, or the first read of a binding) performs a request.
    if (options.force !== true && state.receivedAt !== 0) {
      return { outcome: state.prior === 'stale' ? 'stale' : 'current', reason: state.status.reason }
    }
    if (state.inFlight !== undefined) return this.waitFor(state.inFlight, options.signal)
    const generation = state.generation
    // Every request owns a fresh controller: the signal a read holds is never reused after it
    // settles, so a later suspension cannot abort a request that has already finished.
    const controller = new AbortController()
    state.controller = controller
    // The status a state reports is only ever the last settled fact: "reading" is a projection
    // of the read in flight, never a value written into the state. A read that settles as
    // superseded therefore leaves the previous outcome — a recorded failure included —
    // exactly where it was instead of erasing it behind a stuck loading state.
    const read = this.guard(state, this.read(account, state, generation, controller.signal))
    state.inFlight = read
    this.track(read)
    // The shared read's own bookkeeping belongs to the read, not to whichever waiter happens
    // to end first: a cancelled waiter must not release the state while the I/O is running.
    void read.then(
      () => { this.settleRead(account, state, read) },
      () => { this.settleRead(account, state, read) },
    )
    return this.waitFor(read, options.signal)
  }

  /** Clear a finished read's ownership of the state. */
  private settleRead(account: string, state: AccountState, read: Promise<PolicyLimitsReadResult>): void {
    if (this.states.get(account) !== state) return
    if (state.inFlight !== read) return
    state.inFlight = undefined
    state.controller = undefined
  }

  /** Register one live binding, replacing a state that belongs to another identity. */
  bind(account: string, sessionId: string, identity: PolicyLimitsIdentity): boolean {
    if (this.disposed) return false
    const existing = this.states.get(account)
    const state = existing !== undefined && identityFence(existing.identity) === identityFence(identity)
      ? existing
      : this.replaceState(account, identity, existing)
    const first = !state.bindings.has(sessionId)
    state.bindings.add(sessionId)
    return first
  }

  /** Suspend one account whose last binding ended; its document is kept, only polling stops. */
  async suspend(account: string): Promise<void> {
    const state = this.states.get(account)
    if (state === undefined) return
    this.invalidate(state)
    this.abortInFlight(state)
    this.notify(account)
    await this.quiesce(state)
  }

  /**
   * Stop one account's background polling without waiting for anything.
   *
   * It cancels the armed refresh and invalidates the generation, so a read already in flight
   * adopts nothing and settles as superseded; the document already adopted is kept. It is
   * synchronous by contract: a caller inside {@link ClaudePolicyLimitsOptions.readFailure}
   * fences its own accounts here, and the read it is called from cannot be awaited from that
   * handler.
   * @param account - the canonical account key.
   */
  stopCadence(account: string): void {
    const state = this.states.get(account)
    if (state === undefined) return
    this.invalidate(state)
    this.notify(account)
  }

  /** Release one session's binding, suspending the account when it was the last one. */
  async releaseSession(account: string, sessionId: string): Promise<void> {
    const state = this.states.get(account)
    if (state === undefined || !state.bindings.delete(sessionId)) return
    if (state.bindings.size > 0) return
    await this.suspend(account)
  }

  /**
   * End one account's identity: everything this identity established is dropped.
   *
   * The stored record is removed only while it still carries this state's own identity and
   * adoption counter, so a release that races a later login or a later adoption leaves the
   * newer record exactly as it is.
   * @param account - the canonical account key.
   */
  async releaseAccount(account: string): Promise<void> {
    const state = this.states.get(account)
    if (state === undefined) return
    this.invalidate(state)
    this.abortInFlight(state)
    this.states.delete(account)
    this.notify(account)
    await this.quiesce(state)
    await this.removeStored(state)
  }

  /** Stop the owner: every cadence is cancelled, every read aborted, every owned step awaited. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.settleOwned()
      return
    }
    this.disposed = true
    for (const state of this.states.values()) {
      this.invalidate(state)
      this.abortInFlight(state)
      state.bindings.clear()
    }
    const pending = [...this.inFlight, ...this.handovers.values()]
    this.states.clear()
    this.handovers.clear()
    await Promise.allSettled(pending)
    // A read that settled while the snapshot above was awaited started its own persist step,
    // which is owned work too: this second pass is what makes disposal wait for that write.
    await this.settleOwned()
  }

  /**
   * Arm one cadence for one generation, containing its own failures.
   *
   * The slot is identified by the token this call creates. A fire, a cancellation or a
   * replacement that no longer finds its own token does nothing, so a stopped operation can
   * never re-arm a timer behind a newer one.
   */
  private scheduleCadence(state: AccountState, account: string, generation: number): void {
    const token = {}
    const cancel = this.scheduler.after(this.options.pollMs ?? POLICY_LIMITS_POLL_MS, () => {
      if (state.cadence?.token !== token) return
      state.cadence = undefined
      if (!this.owns(state, generation)) return
      const read = this.guard(state, this.ensure(account, { force: true }))
      this.track(read)
      void read.then(() => {
        if (!this.owns(state, generation)) return
        // The slot must still be free: a stop/start that already armed its own cadence is
        // never given a second timer by the operation it replaced.
        if (state.cadence !== undefined) return
        this.scheduleCadence(state, account, generation)
      })
    })
    state.cadence = { generation, token, cancel }
  }

  /** Whether this state is still the one installed, under this generation. */
  private owns(state: AccountState, generation: number): boolean {
    return !this.disposed && state.generation === generation && this.states.get(state.account) === state
  }

  /** Invalidate one state: its cadence dies with its generation. */
  private invalidate(state: AccountState): void {
    state.generation += 1
    state.cadence?.cancel()
    state.cadence = undefined
  }

  /** Stop this state's I/O; a waiter's own cancellation is unaffected. */
  private abortInFlight(state: AccountState): void {
    state.controller?.abort()
    state.controller = undefined
  }

  /** Wait for this state's own work to settle: its read and everything the read started. */
  private async quiesce(state: AccountState): Promise<void> {
    const pending: Promise<unknown>[] = [...state.work]
    if (state.inFlight !== undefined) pending.push(state.inFlight)
    if (pending.length === 0) return
    await Promise.allSettled(pending)
  }

  /** Wait for a pending identity handover for this account, when one is running. */
  private async handoverFor(account: string): Promise<void> {
    const pending = this.handovers.get(account)
    if (pending !== undefined) await pending
  }

  /** Track one started operation so disposal can wait for it. */
  private track(pending: Promise<unknown>): void {
    this.inFlight.add(pending)
    void pending.then(
      () => { this.inFlight.delete(pending) },
      () => { this.inFlight.delete(pending) },
    )
  }

  /**
   * Own one operation for a state, containing its failure and waiting for it on release.
   *
   * The warning names a fixed stage code: when the failure is the store's own typed failure its
   * closed code is reported, and every other rejection reports `owned_work_failed`. A thrown
   * error's own text is never logged.
   */
  private own(state: AccountState, pending: Promise<unknown>): void {
    const owned = pending.then(
      () => undefined,
      (error: unknown) => {
        this.options.onWarn?.(
          `dsh-plugin-subscriptions: claude policy_limits owned work failed (${stageCodeOf(error, 'owned_work_failed')})`,
        )
      },
    )
    state.work.add(owned)
    this.inFlight.add(owned)
    void owned.then(() => {
      state.work.delete(owned)
      this.inFlight.delete(owned)
    })
  }

  /** Await every operation this owner still has in flight. */
  private async settleOwned(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
  }

  /** Await one shared read for one waiter: its cancellation ends only its own wait. */
  private waitFor(pending: Promise<PolicyLimitsReadResult>, signal: AbortSignal | undefined): Promise<PolicyLimitsReadResult> {
    if (signal === undefined) return pending
    if (signal.aborted) return Promise.resolve({ outcome: 'unavailable', reason: 'waiter-cancelled' })
    return new Promise<PolicyLimitsReadResult>(resolve => {
      const stop = (): void => resolve({ outcome: 'unavailable', reason: 'waiter-cancelled' })
      signal.addEventListener('abort', stop, { once: true })
      void pending.then(
        value => { signal.removeEventListener('abort', stop); resolve(value) },
        () => { signal.removeEventListener('abort', stop); resolve({ outcome: 'unavailable', reason: 'read-failed' }) },
      )
    })
  }

  /**
   * Install a state for one identity, waiting out whatever the previous state still owned.
   *
   * A different identity never reuses the earlier state's document, cadence or validator, and
   * the replacement's own reads wait for the earlier identity's I/O to settle rather than
   * running beside it.
   */
  private replaceState(account: string, identity: PolicyLimitsIdentity, previous: AccountState | undefined): AccountState {
    let handover: Promise<void> | undefined
    if (previous !== undefined) {
      this.invalidate(previous)
      this.abortInFlight(previous)
      handover = this.quiesce(previous)
      this.handovers.set(account, handover)
      void handover.then(() => {
        if (this.handovers.get(account) === handover) this.handovers.delete(account)
      })
    }
    const state: AccountState = {
      account,
      // The state is keyed by the canonical key, and so is the identity it belongs to: a
      // caller's identity always names an account, and the map's key is what one resolves by.
      identity: { ...identity, account },
      generation: 0,
      bindings: new Set(),
      cadence: undefined,
      controller: undefined,
      revision: 0,
      validator: undefined,
      verified: false,
      document: { restrictions: {}, complianceTaints: [], monitoringNotice: null, defaults: {}, coreSkills: [], lossyComplianceTaints: false },
      receivedAt: 0,
      prior: 'none',
      status: { state: 'unavailable', reason: 'never-read', fallback: 'none' },
      noticeTextKnown: false,
      unknownDefaults: 0,
      settled: false,
      blockers: [...this.blockersForNewState()],
      inFlight: undefined,
      unsupported: [],
      work: new Set(),
    }
    this.states.set(account, state)
    return state
  }

  /** The blockers a newly created state starts with. */
  private blockersForNewState(): readonly PolicyLimitsBlockerCode[] {
    return this.storeBlocked ? ['policy_limits_state_unavailable'] : []
  }

  /** Contain one operation's failure: a fixed reason, never an unhandled rejection. */
  private guard(state: AccountState, pending: Promise<PolicyLimitsReadResult>): Promise<PolicyLimitsReadResult> {
    return pending.catch(() => this.failRead(
      state.account,
      state,
      state.generation,
      coreFailure('request_failed', { reason: 'read_failed' }),
      state.receivedAt,
    ))
  }

  /** One logical read, with adoption and stale retention. */
  private async read(account: string, state: AccountState, generation: number, signal: AbortSignal): Promise<PolicyLimitsReadResult> {
    const clock = this.options.clock ?? SYSTEM_CLOCK
    let accessToken: string
    try {
      accessToken = await this.options.accessToken(account)
    } catch {
      // A credential failure is reported by a fixed code: no message or cause text can carry
      // a token or a provider body into a reason or a log line.
      return await this.failRead(account, state, generation, coreFailure('auth_failed', { reason: 'credential_unavailable' }), state.receivedAt)
    }
    const verdictInputs = this.options.verdictInputs ?? DEFAULT_POLICY_VERDICT_INPUTS
    const reauthorize = this.options.refreshOnUnauthorized
    const classifyFailure = this.options.classifyFailure
    const outcome = await readPolicyLimits({
      url: `${this.options.baseUrl}/api/claude_code/policy_limits`,
      accessToken,
      userAgent: this.options.userAgent,
      // Only a live document this process confirmed may serve as a conditional request. A
      // retained document that has gone stale must be read in full: sending its validator
      // would make the next read conditional, and the core correctly refuses a 304 that was
      // not produced by a live prior as unsolicited.
      ...state.prior === 'live' && state.verified && state.validator !== undefined ? { validator: state.validator } : {},
      transport: this.options.transport,
      clock,
      sleep: this.options.sleep ?? SYSTEM_SLEEP,
      ...this.options.random === undefined ? {} : { random: this.options.random },
      signal,
      ...reauthorize === undefined ? {} : { reauthorize: () => reauthorize(account) },
      ...classifyFailure === undefined ? {} : { classifyFailure },
      priorContext: state.prior,
      parseFailureIsTerminal: verdictInputs.parseFailureIsTerminal,
      failOpenOnMissingRoute: !verdictInputs.refuseFailOpenOnMissingRoute,
    })
    // A state replaced or disposed while this read was in flight adopts nothing.
    if (!this.owns(state, generation)) return { outcome: 'unavailable', reason: 'superseded' }
    switch (outcome.kind) {
      case 'cancelled':
        return { outcome: 'unavailable', reason: 'cancelled' }
      case 'failure':
        return await this.failRead(account, state, generation, outcome.failure, state.receivedAt)
      case 'fail_open_empty': {
        // The pinned fail-open answer stands for a route that is missing, not for a rule that
        // is already in force: it is adopted only while this account holds no live and no
        // usable stale document. A restriction already refusing stays in force, and the
        // fail-open is recorded as the read result without replacing it.
        if (state.receivedAt !== 0) {
          state.status = { ...state.status, reason: outcome.reason }
          return { outcome: state.status.state === 'stale' ? 'stale' : 'current', reason: outcome.reason }
        }
        state.revision += 1
        state.validator = undefined
        state.verified = true
        state.prior = 'live'
        state.receivedAt = clock.now()
        state.status = { state: 'current', reason: outcome.reason, fetchedAt: state.receivedAt, fallback: 'live' }
        state.blockers = []
        state.settled = true
        state.noticeTextKnown = true
        state.unknownDefaults = 0
        state.unsupported = this.mappingGaps()
        // Nothing is persisted: the fail-open answer states that this account never read a
        // document at all, and a stored empty projection would read as evidence it did.
        this.notify(account)
        return { outcome: 'current', reason: outcome.reason }
      }
      case 'success': {
        if (outcome.response === null) {
          // A 304 revalidated the session policy: it stays live and its freshness is refreshed.
          state.prior = 'live'
          state.receivedAt = clock.now()
          state.status = { state: 'current', reason: 'revalidated', fetchedAt: state.receivedAt, fallback: 'live' }
          state.blockers = []
          state.settled = true
          this.notify(account)
          return { outcome: 'current', reason: 'revalidated' }
        }
        state.revision += 1
        state.document = outcome.response
        state.validator = outcome.validator
        state.verified = true
        state.prior = 'live'
        state.receivedAt = clock.now()
        const denied = Object.entries(outcome.response.restrictions).filter(([, entry]) => !entry.allowed).map(([key]) => key)
        state.status = {
          state: 'current',
          reason: outcome.response.lossyComplianceTaints ? 'accepted-lossy-taints' : 'accepted',
          fetchedAt: state.receivedAt,
          fallback: 'live',
          ...denied.length === 0 ? {} : { deniedKeys: denied },
        }
        state.blockers = []
        state.settled = true
        state.noticeTextKnown = true
        state.unknownDefaults = 0
        state.unsupported = this.mappingGaps()
        this.persist(state)
        this.notify(account)
        return { outcome: 'current', reason: state.status.reason }
      }
    }
  }

  /**
   * Record one failed read: keep what was adopted, keep a known restriction, and let the
   * caller's own failure handler run before the result is observed.
   *
   * The handler is awaited, so a caller that sees this result knows the durable record it
   * asked for already exists; and it is only called while the identity still owns the state,
   * so a failure read for an account that has since moved on records nothing.
   *
   * A failure the pinned retry policy forbids stops this account's own background polling:
   * another read of the same identity cannot produce a different answer, so the cadence is
   * cancelled while the document already adopted stays exactly as it is. A transient failure
   * leaves the cadence running.
   */
  private async failRead(
    account: string,
    state: AccountState,
    generation: number,
    failure: CoreFailure,
    receivedAt: number,
  ): Promise<PolicyLimitsReadResult> {
    // The status and the result carry the stable outcome code, which is the vocabulary a
    // consumer maps onto its own codes. The classifier's specific sub-reason is preserved
    // beside it, in `failure`, rather than replacing it.
    const reason = failure.code
    this.options.onWarn?.(`dsh-plugin-subscriptions: claude policy_limits read failed (${failure.reason ?? failure.code})`)
    if (this.owns(state, generation)) {
      state.settled = true
      if (receivedAt === 0) {
        state.status = { state: 'unavailable', reason, fallback: 'none', failure }
      } else {
        state.prior = 'stale'
        state.status = { ...state.status, state: 'stale', reason, fallback: 'stale', failure }
      }
      this.notify(account)
    }
    await this.reportFailure(account, state, generation, failure)
    if (failure.skipRetry === true && this.owns(state, generation)) this.stopCadence(account)
    return receivedAt === 0
      ? { outcome: 'unavailable', reason, failure }
      : { outcome: 'stale', reason, failure }
  }

  /**
   * Run the caller's own failure handler, fenced to the identity that produced the failure.
   *
   * The handler is called synchronously from the read it belongs to, so it must not await
   * work that waits for that read: a caller that would needs to schedule it after returning.
   */
  private async reportFailure(
    account: string,
    state: AccountState,
    generation: number,
    failure: CoreFailure,
  ): Promise<void> {
    const handler = this.options.readFailure
    if (handler === undefined) return
    if (!this.owns(state, generation)) return
    try {
      await handler({ account, identity: state.identity, failure })
    } catch {
      this.options.onWarn?.(
        'dsh-plugin-subscriptions: claude policy_limits failure handler failed (read_failure_handler_failed)',
      )
    }
  }

  /** The adopted document, or `undefined` when nothing was adopted. */
  private liveDocument(account: string): PolicyLimitsDocument | undefined {
    const state = this.states.get(account)
    return state === undefined || state.status.state === 'unavailable' ? undefined : state.document
  }

  /** The registered keys this build cannot enforce exactly, with their reasons. */
  private mappingGaps(): readonly { key: string; reason: string }[] {
    const gaps: { key: string; reason: string }[] = []
    for (const key of POLICY_KEYS) {
      const mapping = policyKeyMapping(key)
      if (mapping.enforcement === 'enforced') continue
      gaps.push({ key, reason: mapping.enforcement === 'unsupported' ? mapping.reason : `inapplicable: ${mapping.reason}` })
    }
    return gaps
  }

  /** Read and install the durable store, failing closed when it cannot be trusted. */
  private async loadStore(): Promise<void> {
    const store = this.options.persistence
    if (store === undefined) {
      this.storage = { status: 'none' }
      return
    }
    let result: ClaudePolicyLimitsLoadResult
    try {
      result = await store.load()
    } catch (error: unknown) {
      result = {
        status: 'unavailable',
        error: {
          code: 'state_unreadable',
          detail: `the policy_limits state could not be read (${stageCodeOf(error, 'state_load_rejected')})`,
        },
      }
    }
    if (result.status === 'cold') {
      this.storage = { status: 'cold' }
      return
    }
    if (result.status === 'unavailable') {
      this.storage = { status: 'unavailable', error: result.error }
      // A record this process cannot read may have restricted an operation, so nothing is
      // answered as though no record ever existed: the blocker stays until a confirmed read.
      this.storeBlocked = true
      for (const state of this.states.values()) this.blockState(state)
      this.options.onWarn?.(
        `dsh-plugin-subscriptions: claude policy_limits state is unavailable (${result.error.code}); `
        + 'every operation it may have restricted stays refused until a confirmed read',
      )
      return
    }
    this.storage = { status: 'loaded', accounts: result.records.length }
    for (const record of result.records) this.restoreRecord(record)
  }

  /**
   * Install one stored record as an unverified snapshot.
   *
   * A state this process already read, or one that belongs to another identity, is never
   * replaced by the file: live evidence is newer than a stored projection.
   */
  private restoreRecord(record: ClaudePersistedPolicyLimitsRecord): void {
    const account = record.identity.account
    const identity: PolicyLimitsIdentity = { ...record.identity }
    const existing = this.states.get(account)
    if (existing !== undefined && (existing.receivedAt !== 0 || existing.inFlight !== undefined
      || identityFence(existing.identity) !== identityFence(identity))) return
    const state = existing ?? this.replaceState(account, identity, undefined)
    state.document = restoredDocument(record)
    state.revision = record.revision
    state.validator = record.validator.length === 0 ? undefined : record.validator
    state.verified = false
    // The stored record kept the notice's existence without its text and the defaults whose
    // type this build knows; anything else the document stated is a count until a confirmed
    // read states it again. A control obligation is stored nowhere, so the restored state
    // reports no requirement rather than one the server never made again.
    state.noticeTextKnown = false
    state.unknownDefaults = record.unknownDefaults
    state.receivedAt = record.receivedAt
    // A restored document is a `stale` prior: the reader may not answer a missing route with
    // the fail-open policy, because a restriction already in force must survive the restart.
    state.prior = 'stale'
    state.blockers = this.storeBlocked
      ? ['policy_limits_state_unavailable']
      : restoredBlockers(record)
    state.unsupported = this.mappingGaps()
    state.status = {
      state: state.blockers.length === 0 ? 'stale' : 'blocked',
      reason: state.blockers.length === 0 ? 'restored' : 'restored-unverified',
      fetchedAt: record.receivedAt,
      fallback: 'stale',
    }
    state.settled = true
    this.notify(account)
  }

  /** Add the store blocker to one already-installed state. */
  private blockState(state: AccountState): void {
    if (state.blockers.includes('policy_limits_state_unavailable')) return
    state.blockers = ['policy_limits_state_unavailable', ...state.blockers]
    state.status = { ...state.status, state: 'blocked', reason: 'state-unavailable' }
    state.settled = true
    this.notify(state.account)
  }

  /**
   * Store the document one adoption confirmed, as this state's own persisted projection.
   *
   * Nothing is written before hydration has run: this owner has not yet read what the file
   * already holds, and a write that never compared against it could replace newer evidence.
   */
  private persist(state: AccountState): void {
    const store = this.options.persistence
    if (store === undefined || this.storeBlocked || this.storage.status === 'pending') return
    const record = projectRecord(state)
    this.own(state, store.save([record]))
  }

  /** Remove the stored record, only while it is still this state's own identity and revision. */
  private async removeStored(state: AccountState): Promise<void> {
    const store = this.options.persistence
    if (store === undefined) return
    const outcome = await store.remove({
      account: state.account,
      identity: { ...state.identity },
      revision: state.revision,
    })
    if (outcome.status === 'retained') {
      this.options.onWarn?.(
        `dsh-plugin-subscriptions: claude policy_limits state record was retained (${outcome.error.code})`,
      )
    }
  }

  /** Report a state change to the status projection's owner. */
  private notify(account: string): void {
    try {
      this.options.onChanged?.(account)
    } catch {
      this.options.onWarn?.(
        'dsh-plugin-subscriptions: claude policy_limits status listener failed (status_listener_failed)',
      )
    }
  }
}

/** The document a stored projection restores. */
function restoredDocument(record: ClaudePersistedPolicyLimitsRecord): PolicyLimitsDocument {
  const restrictions: Record<string, { readonly allowed: boolean }> = {}
  for (const entry of record.restrictions) {
    // Only a refusal is reinstated. An allow from a snapshot no process has confirmed could
    // only widen the gate, and the no-live-policy order already answers for every key the
    // restored document does not deny, so dropping it can only be narrower.
    if (entry.allowed) continue
    restrictions[entry.key] = { allowed: false }
  }
  const defaults: Record<string, unknown> = {}
  for (const entry of record.defaults) defaults[entry.key] = entry.value
  return {
    restrictions,
    complianceTaints: [...record.taints],
    // Presence without content: a notice leaves every verdict unsettled, and its text is a
    // remote string that is never written to disk. Its existence is what the blocker states.
    monitoringNotice: record.noticePresent ? { text: '', url: null } : null,
    defaults,
    coreSkills: [],
    // A lossy taint set is already a blocker, so the restored document never answers from it
    // as though it were complete.
    lossyComplianceTaints: record.lossyTaints,
  }
}

/** The blockers an incomplete stored projection leaves in force. */
function restoredBlockers(record: ClaudePersistedPolicyLimitsRecord): readonly PolicyLimitsBlockerCode[] {
  const blockers: PolicyLimitsBlockerCode[] = []
  if (record.unknownKeys > 0) blockers.push('policy_limits_unknown_keys')
  if (record.coreSkillsPresent) blockers.push('policy_limits_core_skills_unstored')
  if (record.lossyTaints) blockers.push('policy_limits_lossy_taints')
  return blockers
}

/**
 * The capabilities one document configures that this build cannot apply.
 *
 * A `defaults` entry is a per-capability default value, never a verdict about a policy key.
 * A monitoring notice whose text was not stored is a display fact pending the next confirmed
 * read: it is reported here so a caller can say so, and it refuses no operation — the notice
 * restricts no key, so denying one would be a permission this owner invented.
 *
 * @param document - the document in force, live or restored.
 * @param unknownDefaults - how many defaults entries this build cannot type.
 * @param noticePending - whether a notice is in force whose text this process has not read.
 * @returns the scopes to report, in a stable order.
 */
function unsupportedScopes(
  document: PolicyLimitsDocument,
  unknownDefaults: number,
  noticePending: boolean,
): readonly PolicyLimitsUnsupportedScope[] {
  const scopes: PolicyLimitsUnsupportedScope[] = []
  let untyped = unknownDefaults > 0
  for (const key of Object.keys(document.defaults)) {
    if (!CLAUDE_POLICY_KNOWN_DEFAULT_KEYS.has(key)) {
      untyped = true
      continue
    }
    scopes.push({
      scope: key,
      reason: 'the accepted policy configures a capability this build does not provide; its default is recorded and never applied',
    })
  }
  if (untyped) {
    scopes.push({
      scope: 'policy-defaults',
      reason: 'the accepted policy stated a capability default this build cannot type; it is counted and never applied',
    })
  }
  if (noticePending) {
    scopes.push({
      scope: 'policy-notice',
      reason: 'a monitoring notice is in force; its text was not stored, so it is shown after the next confirmed read',
    })
  }
  return scopes
}

/**
 * Project one confirmed state into the record the store keeps.
 *
 * Every member is a fact this plugin derived, never a value the server sent: a restriction is
 * its bool for a registered key, a taint is already bounded by the pinned pattern, and a
 * notice, a `defaults` value, a core skill name and an unregistered key survive only as the
 * existence facts the restore blocks on.
 *
 * The unknown-key count is the operation-permission namespace's: a known control obligation is
 * classified out of it, exactly as `restrictionKeys` classifies it out of the live key set, so
 * the two projections of one document never disagree about what an operation key is.
 */
function projectRecord(state: AccountState): ClaudePersistedPolicyLimitsRecord {
  const document = state.document
  const restrictions: ClaudePersistedPolicyLimitsRestriction[] = []
  let unknownKeys = 0
  for (const [key, entry] of Object.entries(document.restrictions)) {
    if (isKnownControlKey(key)) continue
    if (policyRegistration(key) === undefined) {
      unknownKeys += 1
      continue
    }
    restrictions.push({ key, allowed: entry.allowed })
  }
  const defaults: ClaudePersistedPolicyLimitsDefault[] = []
  let unknownDefaults = 0
  for (const [key, value] of Object.entries(document.defaults)) {
    // Only a capability default whose type this build knows keeps its name and value; every
    // other entry is a remote value and survives as a count.
    if (!CLAUDE_POLICY_KNOWN_DEFAULT_KEYS.has(key) || typeof value !== 'boolean') {
      unknownDefaults += 1
      continue
    }
    defaults.push({ key, value })
  }
  return {
    identity: { ...state.identity },
    revision: state.revision,
    validator: state.validator ?? '',
    receivedAt: state.receivedAt,
    restrictions,
    taints: [...document.complianceTaints],
    lossyTaints: document.lossyComplianceTaints,
    noticePresent: document.monitoringNotice !== null,
    defaults,
    unknownDefaults,
    coreSkillsPresent: document.coreSkills.length > 0,
    unknownKeys,
  }
}

/**
 * The fixed code one contained failure is logged by.
 *
 * A store failure carries a code from this plugin's own closed enum, so it may be logged. Any
 * other rejection is logged as the stage that contained it: an error's message, name and cause
 * chain are never written to a warning, because a message can quote a file path, a token or a
 * provider body.
 * @param error - the rejection the owner contained.
 * @param stage - the fixed stage code to report for an untyped rejection.
 * @returns the code to log.
 */
function stageCodeOf(error: unknown, stage: string): string {
  return error instanceof ClaudePolicyLimitsStateFailure ? error.code : stage
}

/** What one organization check resolved to. */
export type OrgCheckOutcome =
  /** No pin is in force, so nothing was sent. */
  | { readonly kind: 'no-pin' }
  /** The account is inside the pinned set. */
  | { readonly kind: 'allowed' }
  /** The account must not serve: unusable pin, mismatch, or no usable result. */
  | { readonly kind: 'denied'; readonly code: string }

/** The facts one organization check is keyed and judged by. */
export interface OrgCheckRequest {
  /** Canonical account key. */
  readonly account: string
  /**
   * The pin the maintenance owner projected for this account, with the policy revision it
   * belongs to. No raw settings document crosses this seam.
   */
  readonly projected: { readonly kind: 'stated'; readonly pin: OrgPinParse; readonly revision: string }
    | { readonly kind: 'unknown'; readonly revision: string; readonly reason: string }
    | undefined
  /** Access token the validation request carries. */
  readonly accessToken: () => Promise<string>
  /**
   * The identity the remembered result belongs to. A judgment made for one account,
   * organization, lease or protocol profile is never reused for another: at minimum the
   * account, its organization, the credential lease epoch, the origin and the protocol
   * profile separate one check from the next, and the pin revision is added by this checker.
   */
  readonly identity?: {
    readonly accountUuid?: string | undefined
    readonly organization?: string | undefined
    readonly leaseEpoch?: string | undefined
    readonly origin?: string | undefined
    readonly profileFingerprint?: string | undefined
  } | undefined
  /** Caller cancellation. */
  readonly signal?: AbortSignal | undefined
}

/**
 * The organization-pin checker.
 *
 * The check is event-driven, not periodic: it runs when a bound account first becomes ready
 * and when a login completes, and it is remembered by the pin's own policy revision. A
 * routine token rotation does not invalidate the record, because a refreshed credential is
 * not a new login; a pin that changes does, and takes effect at the next actual check.
 * A denied outcome is never resolved by trying another account.
 */
export class ClaudeOrgPinChecker {
  private readonly results = new Map<string, OrgCheckOutcome>()

  constructor(private readonly options: {
    /** The validation endpoint. */
    readonly url: string
    /** User agent for this role. */
    readonly userAgent: string
    /** The transport the validation uses. */
    readonly transport: CoreTransport
    /** Warning sink for a contained failure. */
    readonly onWarn?: (message: string) => void
  }) {}

  /**
   * Validate one account against the pin its accepted policy stated.
   * @param request - the account, its projected pin, identity and the credential to validate.
   * @returns the outcome; only `allowed` and `no-pin` permit the operation.
   */
  async check(request: OrgCheckRequest): Promise<OrgCheckOutcome> {
    const projected = request.projected
    if (projected === undefined) return { kind: 'no-pin' }
    // A restored snapshot states no pin: it stays unverified until a fresh read states one,
    // rather than being read as "no pin held".
    if (projected.kind === 'unknown') return { kind: 'denied', code: 'pin_unverified' }
    const key = this.cacheKey(request, projected.revision)
    // The record belongs to one pin revision on one identity: a new pin, a new account, a new
    // lease or a different protocol profile re-checks; a rotated credential on the same
    // identity does not, because a refresh is not a new login.
    const remembered = this.results.get(key)
    if (remembered !== undefined) return remembered
    if (projected.pin.kind === 'none') return { kind: 'no-pin' }
    if (projected.pin.kind === 'invalid') {
      // An unusable pin denies without a request; the controller owns the shared record.
      this.results.set(key, { kind: 'denied', code: projected.pin.failure.code })
      return { kind: 'denied', code: projected.pin.failure.code }
    }
    let accessToken: string
    try {
      accessToken = await request.accessToken()
    } catch {
      this.options.onWarn?.('dsh-plugin-subscriptions: claude organization check could not read a credential (credential_read_failed)')
      return { kind: 'denied', code: 'org_verify_failed' }
    }
    const validated = await validateOrgPin({
      url: this.options.url,
      accessToken,
      userAgent: this.options.userAgent,
      pin: projected.pin.organizations,
      transport: this.options.transport,
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
    if (validated.kind === 'no-pin') return { kind: 'no-pin' }
    const outcome: OrgCheckOutcome = validated.kind === 'allowed'
      ? { kind: 'allowed' }
      : { kind: 'denied', code: validated.failure.code }
    this.results.set(key, outcome)
    return outcome
  }

  /** Drop every remembered result for one account, for a logout or an identity replacement. */
  forget(account: string): void {
    for (const key of [...this.results.keys()]) {
      if (key.startsWith(`${account}|`)) this.results.delete(key)
    }
  }

  /** The exact identity one remembered judgment belongs to. */
  private cacheKey(request: OrgCheckRequest, revision: string): string {
    const identity = request.identity
    return [
      request.account,
      identity?.accountUuid ?? '',
      identity?.organization ?? '',
      identity?.leaseEpoch ?? '',
      identity?.origin ?? '',
      identity?.profileFingerprint ?? '',
      revision,
    ].join('|')
  }
}

/**
 * Adapt this plugin's fetch to the core's transport.
 *
 * The core owns the body bound, the parse and every status decision; this adapter performs
 * only the transfer and hands the response back, with the request's own deadline combined
 * with the caller's cancellation. No credential or account choice happens here.
 * @param input - the request the core wants performed.
 * @param fetchFn - the plugin's fetch implementation.
 * @returns the response the core reads.
 */
export function policyLimitsTransport(
  input: CoreHttpRequest,
  fetchFn: typeof fetch,
): Promise<CoreHttpResponse> {
  const deadline = AbortSignal.timeout(input.timeoutMs)
  return fetchFn(input.url, {
    method: input.method,
    headers: input.headers,
    ...input.body === null ? {} : { body: input.body },
    signal: AbortSignal.any([input.signal, deadline]),
  })
}
