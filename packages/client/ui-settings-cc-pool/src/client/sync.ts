/**
 * Merge rules for one pool catalogue sync.
 *
 * The pool's listing is the authority on which models exist and nothing more:
 * it reports a model id and, when the endpoint discloses one, a display name.
 * Capacities and the default effort stay this page's settings, so a sync never
 * rewrites a row the table already holds — every edit there survives — and
 * gives a model it adds safe defaults the user is expected to review. Merging
 * only stages drafts; the settings document is written by the page's save.
 */

import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import type { CcPoolReasoningLevel } from './contract.ts'
import type { CcPoolModelDraft } from './model-draft.ts'

/** Context window a pool-added model starts from until the user sets the real capacity. */
const ADDED_CONTEXT_WINDOW = 1_000_000

/** Output cap a pool-added model starts from until the user sets the real cap. */
const ADDED_MAX_TOKENS = 128_000

/** Default effort a pool-added model starts from: the pool's middle level. */
const ADDED_REASONING: CcPoolReasoningLevel = 'medium'

/** Why one discovery answer cannot be merged into the table. */
export type CcPoolSyncProblem = 'syncEmpty' | 'syncInvalid' | 'syncDuplicate'

/** Copy key naming why the page left the table alone. */
export type CcPoolSyncErrorKey = CcPoolSyncProblem | 'syncNoToken' | 'syncTimeout'

/** A discovery answer reduced to the entries a merge needs, or why it cannot be used. */
export type CcPoolDiscoveryResult =
  | { readonly kind: 'models'; readonly models: readonly LlmDiscoveredModel[] }
  | { readonly kind: 'problem'; readonly problem: CcPoolSyncProblem }

/**
 * Check one discovery answer before it reaches the table.
 *
 * The answer describes an external endpoint, so its entries are read as
 * untrusted values even though the Remote types them: an entry without a
 * usable id or a repeated id would otherwise stage a table that cannot be
 * saved. A missing or unreadable optional display name is not a defect — the
 * row falls back to the id.
 * @param answer - the models the pool listed.
 * @returns the usable models, normalized, or the first problem that blocks a merge.
 */
export function readDiscoveredModels(answer: readonly unknown[]): CcPoolDiscoveryResult {
  if (answer.length === 0) return { kind: 'problem', problem: 'syncEmpty' }
  const models: LlmDiscoveredModel[] = []
  const ids = new Set<string>()
  for (const entry of answer) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { kind: 'problem', problem: 'syncInvalid' }
    }
    const record = entry as Record<string, unknown>
    const rawId = record['id']
    if (typeof rawId !== 'string') return { kind: 'problem', problem: 'syncInvalid' }
    const id = rawId.trim()
    if (id.length === 0) return { kind: 'problem', problem: 'syncInvalid' }
    if (ids.has(id)) return { kind: 'problem', problem: 'syncDuplicate' }
    ids.add(id)
    const rawName = record['name']
    const name = typeof rawName === 'string' ? rawName.trim() : ''
    models.push(name.length === 0 ? { id } : { id, name })
  }
  return { kind: 'models', models }
}

/** What one pool sync would change in the catalogue table. */
export interface CcPoolSyncMerge {
  /** Current row indexes the merged table keeps, in table order. */
  readonly keptRows: readonly number[]
  /** Drafts the pool lists and the table does not, in pool order. */
  readonly added: readonly CcPoolModelDraft[]
  /** Ids the table lists and the pool does not, in table order. */
  readonly removedIds: readonly string[]
}

/**
 * Plan the merge of one pool listing into the edited table.
 *
 * A row whose id the pool lists is kept exactly as edited, display name and
 * capacities included. A row whose id the pool dropped is a removal candidate
 * the caller confirms before dropping it. A row that carries no id yet is
 * unfinished input rather than a model the pool can drop, so it stays where
 * the user put it.
 * @param current - the table as currently edited, in row order.
 * @param models - the normalized pool listing, in pool order.
 * @returns the rows to keep, the drafts to append, and the ids a removal would drop.
 */
export function mergePoolModels(
  current: readonly CcPoolModelDraft[],
  models: readonly LlmDiscoveredModel[],
): CcPoolSyncMerge {
  const listed = new Set(models.map(model => model.id))
  const keptRows: number[] = []
  const keptIds = new Set<string>()
  const removedIds: string[] = []
  current.forEach((draft, index) => {
    const id = draft.id.trim()
    if (id.length === 0) {
      keptRows.push(index)
      return
    }
    if (listed.has(id)) {
      keptRows.push(index)
      keptIds.add(id)
      return
    }
    if (!removedIds.includes(id)) removedIds.push(id)
  })
  const added = models.filter(model => !keptIds.has(model.id)).map(addedDraft)
  return { keptRows, added, removedIds }
}

/**
 * The editable row a pool-added model starts from.
 * @param model - one normalized pool entry.
 * @returns draft text with the safe capacities and effort; the name falls back to the id.
 */
function addedDraft(model: LlmDiscoveredModel): CcPoolModelDraft {
  return {
    id: model.id,
    name: model.name ?? model.id,
    contextWindow: String(ADDED_CONTEXT_WINDOW),
    maxTokens: String(ADDED_MAX_TOKENS),
    defaultReasoning: ADDED_REASONING,
  }
}
