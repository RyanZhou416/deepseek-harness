/**
 * The CC subscription pool's settings names and catalogue vocabulary as the
 * browser addresses them.
 *
 * The Host owner is `@deepseek-ai/dsh-llm-cc-pool`: its `pool.ts` fixes the
 * profile entry id, the provider route, the credential reference, the five
 * reasoning levels, and the `CcPoolModel` fields, while its `config.ts` declares the volatile
 * `models` array this page edits. A client package may not import a Host
 * package's values (browser bundles are built from client packages only), so
 * the wire-facing names and row fields are restated here; keep them in step
 * with that owner.
 */

/** Profile entry id of the pool route plugin, which is also its settings namespace. */
export const CC_POOL_NS = 'llm-cc-pool'

/** Provider route the pool plugin registers, and the only route its discovery describes. */
export const CC_POOL_PROVIDER = 'cc-pool'

/** Credential reference the Host route resolves once per request. */
export const CC_POOL_API_KEY_REF = 'CC_POOL_API_KEY'

/**
 * The five pool reasoning levels, in escalation order. `off`, `minimal`, and a
 * speed tier are deliberately absent: the pool's adaptive thinking has no
 * "do not think" level and no priority tier.
 */
export const CC_POOL_REASONING_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'] as const)

/** One reasoning level a catalogue entry may choose as its default effort. */
export type CcPoolReasoningLevel = (typeof CC_POOL_REASONING_LEVELS)[number]

/** One catalogue entry as the Host settings section stores it. */
export interface CcPoolModel {
  /** Wire model id sent to the pool; non-empty and unique within the catalogue. */
  id: string
  /** Display name selector surfaces show; non-empty. */
  name: string
  /** Maximum combined request and response context in tokens; a positive integer. */
  contextWindow: number
  /** Maximum output tokens; a positive integer. */
  maxTokens: number
  /** Default thinking level this model starts from. */
  defaultReasoning: CcPoolReasoningLevel
}

/** The section fields this page edits; every other field of the entry belongs to the Host. */
export interface CcPoolSettings {
  /** The effective catalogue: the user's override, or the composition's built-in list. */
  models?: CcPoolModel[]
}

/**
 * Whether a wire value is one of the five pool levels.
 * @param value - candidate read from the settings section or from a typed draft.
 * @returns true when the value names a pool level.
 */
export function isCcPoolReasoningLevel(value: unknown): value is CcPoolReasoningLevel {
  return typeof value === 'string' && (CC_POOL_REASONING_LEVELS as readonly string[]).includes(value)
}
