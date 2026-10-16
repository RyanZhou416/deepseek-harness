/**
 * The frozen policy-key registry: the 34 keys the pinned client registers, with the
 * per-key inputs its no-live-policy verdict reads.
 *
 * Generated from the verified evidence package
 * `phase34/business-followup/policy-limits-implementation/evidence.json` (revision 3,
 * `derived.policyRegistry`, anchored at `chunk-d8h3bh4f.js` [33782,38690)). The fields are
 * the pinned artifact own fields: `onCacheMiss`, `onFailOpenVerdict`, `deniedUnder`,
 * `hardBlockUnder`, `serverPopulated`, `transcriptScan`, plus the requirement id and label
 * the registry states. They are protocol constants, not deployment configuration.
 */

/** Verdict a key produces when no live policy is loaded. */
export type PolicyCacheMiss = 'allow' | 'deny' | 'hold'

/** One registered policy key. */
export interface PolicyKeyRegistration {
  /** Verdict a missing live policy produces for this key. */
  readonly onCacheMiss: PolicyCacheMiss
  /** Verdict a failed-open cache produces, when the key declares one. */
  readonly onFailOpenVerdict: 'deny' | null
  /** Compliance taints under which the key is denied. */
  readonly deniedUnder: readonly string[]
  /** Compliance taints that block the key outright, ahead of every other input. */
  readonly hardBlockUnder: readonly string[]
  /** Whether the server populates this key in a policy document. */
  readonly serverPopulated: boolean
  /** Whether the key reads the transcript and is refreshed by that scan. */
  readonly transcriptScan: boolean
  /** Requirement identifier the pinned registry states. */
  readonly requirementId: string
  /** Human label the pinned registry states. */
  readonly label: string
}

/** The registry, keyed by policy key. */
export const POLICY_KEY_REGISTRY = Object.freeze({
  "allow_product_feedback": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa", "zdr"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: true,
    transcriptScan: false,
    requirementId: "HIPAA-R1",
    label: "Feedback",
  }),
  "allow_web_fetch": Object.freeze({
    onCacheMiss: "allow",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: true,
    transcriptScan: false,
    requirementId: "HIPAA-R3",
    label: "Web fetch",
  }),
  "allow_memory_sync": Object.freeze({
    onCacheMiss: "allow",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa", "zdr"]),
    hardBlockUnder: Object.freeze(["hipaa"]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R5",
    label: "Memory sync",
  }),
  "allow_design_sync": Object.freeze({
    onCacheMiss: "allow",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R9",
    label: "Design sync",
  }),
  "allow_projects_tool": Object.freeze({
    onCacheMiss: "hold",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze(["hipaa"]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R17",
    label: "Projects",
  }),
  "allow_claude_browser_extension": Object.freeze({
    onCacheMiss: "allow",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: true,
    transcriptScan: false,
    requirementId: "HIPAA-R34",
    label: "Claude in Chrome",
  }),
  "allow_remote_sessions": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: true,
    transcriptScan: false,
    requirementId: "HIPAA-R6",
    label: "Cloud sessions",
  }),
  "allow_remote_control": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: true,
    transcriptScan: false,
    requirementId: "HIPAA-R6",
    label: "Remote Control",
  }),
  "allow_cobalt_plinth": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa", "zdr"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: true,
    transcriptScan: false,
    requirementId: "HIPAA-R16",
    label: "Artifacts",
  }),
  "allow_team_onboarding": Object.freeze({
    onCacheMiss: "hold",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze(["hipaa"]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R13",
    label: "Team onboarding",
  }),
  "allow_error_reporting": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa", "zdr"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R19",
    label: "Error reporting",
  }),
  "allow_auto_mode_sibling_docs": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R36",
    label: "Repository lookups",
  }),
  "allow_repo_visibility_probe": Object.freeze({
    onCacheMiss: "hold",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R36",
    label: "Repository visibility checks",
  }),
  "allow_send_file": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa", "zdr"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R37",
    label: "File upload",
  }),
  "allow_heap_dump": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa", "zdr"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R38",
    label: "Heap dumps",
  }),
  "allow_local_checkpoint_commit": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa", "zdr"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R39",
    label: "Usage-limit checkpoints",
  }),
  "allow_plugin_skill_search": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R26",
    label: "Plugin and skill search",
  }),
  "allow_plugin_directory_search": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: 'deny',
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R35",
    label: "The plugin directory",
  }),
  "allow_connector_suggest": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: 'deny',
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R43",
    label: "Connector suggestions",
  }),
  "allow_mcp_task_worker_wake": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R57",
    label: "Restarting a worker for a background task",
  }),
  "allow_account_skills_sync": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: true,
    transcriptScan: false,
    requirementId: "HIPAA-R29",
    label: "Account skills sync",
  }),
  "allow_account_plugins_sync": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: true,
    transcriptScan: false,
    requirementId: "HIPAA-R30",
    label: "Account plugins sync",
  }),
  "allow_bundled_skills": Object.freeze({
    onCacheMiss: "allow",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R56",
    label: "Bundled skills",
  }),
  "allow_mycelium": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa", "zdr"]),
    hardBlockUnder: Object.freeze(["hipaa"]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R25",
    label: "Peer messaging",
  }),
  "allow_usage_transcript_scan": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: true,
    requirementId: "HIPAA-R31",
    label: "Usage patterns",
  }),
  "allow_skill_doctor_transcript_scan": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: true,
    requirementId: "HIPAA-R32",
    label: "Skill token counts",
  }),
  "allow_insights": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: true,
    requirementId: "HIPAA-R40",
    label: "Insights",
  }),
  "allow_stats_transcript_scan": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: true,
    requirementId: "HIPAA-R42",
    label: "Usage stats",
  }),
  "allow_model_catalog": Object.freeze({
    onCacheMiss: "allow",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R33",
    label: "The model catalog",
  }),
  "allow_container_result_files": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa", "zdr"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R53",
    label: "Saving large tool results in the tool container",
  }),
  "allow_promo_offers": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R54",
    label: "Promotional offers",
  }),
  "allow_previous_conversation_pointer": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R58",
    label: "Linking a new conversation to the one it replaces",
  }),
  "allow_api_auth_warm": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R59",
    label: "Warming the API credential cache",
  }),
  "allow_cache_keepalive": Object.freeze({
    onCacheMiss: "deny",
    onFailOpenVerdict: null,
    deniedUnder: Object.freeze(["hipaa"]),
    hardBlockUnder: Object.freeze([]),
    serverPopulated: false,
    transcriptScan: false,
    requirementId: "HIPAA-R65",
    label: "Renewing the prompt cache lifetime",
  }),
} as const satisfies Readonly<Record<string, PolicyKeyRegistration>>)

/** The literal union of every registered policy key. */
export type PolicyKey = keyof typeof POLICY_KEY_REGISTRY

/** Every registered policy key, in registry order. */
export const POLICY_KEYS: readonly PolicyKey[] = Object.freeze(Object.keys(POLICY_KEY_REGISTRY) as PolicyKey[])

/** The taint the pinned client treats as the HIPAA evidence scope. */
export const HIPAA_TAINT = 'hipaa'

/**
 * Look one key up.
 * @param key - the policy key.
 * @returns its registration, or `undefined` when this build does not know the key.
 */
export function policyRegistration(key: string): PolicyKeyRegistration | undefined {
  return Object.hasOwn(POLICY_KEY_REGISTRY, key)
    ? POLICY_KEY_REGISTRY[key as PolicyKey]
    : undefined
}
