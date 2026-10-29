/**
 * Draft rows and their validation for the catalogue editor.
 *
 * Every field is edited as text: a number stays exactly what the user typed
 * until the save converts it, so a half-typed capacity is a draft the form
 * refuses rather than a number the control silently rewrites. Validation is
 * pure and mirrors the Host's catalogue rules (non-empty unique ids,
 * non-empty names, positive integer capacities, one of the five levels); the
 * Host remains the authority that either accepts or refuses the write.
 *
 * Read, comparison, and write all use the same normalized text: ids and
 * display names are trimmed, so the padding the Host's own check accepts can
 * never seed a row the client refuses and cannot fix by editing.
 */

import { isCcPoolReasoningLevel, type CcPoolModel, type CcPoolReasoningLevel } from './contract.ts'

/** One editable catalogue field. */
export type CcPoolModelField = 'id' | 'name' | 'contextWindow' | 'maxTokens' | 'defaultReasoning'

/** Copy key naming why one drafted row cannot be saved. */
export type CcPoolDraftErrorKey = 'idBlank' | 'idDuplicate' | 'nameBlank' | 'positiveInteger' | 'reasoningLevel'

/** One draft problem, addressed to the row and field it belongs to. */
export interface CcPoolDraftError {
  /** Zero-based row position in the edited list. */
  row: number
  /** Field the problem belongs to. */
  field: CcPoolModelField
  /** Copy key the field reports. */
  key: CcPoolDraftErrorKey
}

/** The editable text form of one catalogue entry. */
export interface CcPoolModelDraft {
  /** Wire model id as typed. */
  id: string
  /** Display name as typed. */
  name: string
  /** Context window as typed; converted only on save. */
  contextWindow: string
  /** Output cap as typed; converted only on save. */
  maxTokens: string
  /** Selected default effort. */
  defaultReasoning: string
}

/** A draft row plus the stable identity the rendered list keys on. */
export interface CcPoolDraftRow {
  /** Stable row identity; assigned once and never reused for another row. */
  key: number
  /** The row's editable text. */
  draft: CcPoolModelDraft
  /** Whether a pool sync added this row with placeholder capacities the user should review. */
  synced: boolean
}

/** Default effort a newly added row starts from: the pool's middle level. */
const NEW_ROW_REASONING = 'medium'

/**
 * Spell one stored catalogue entry as draft text.
 *
 * The text is what a save would write, not the stored spelling: the id and
 * display name are trimmed, a display name left empty falls back to the id
 * (the rule a pool-added row already uses), and the capacities render as
 * plain digits. A stored entry the Host accepted with padding therefore opens
 * as a row that can be saved instead of a permanent field error.
 * @param model - the stored entry.
 * @returns the entry's editable form.
 */
export function draftOf(model: CcPoolModel): CcPoolModelDraft {
  const id = model.id.trim()
  const name = model.name.trim()
  return {
    id,
    name: name.length === 0 ? id : name,
    contextWindow: String(model.contextWindow),
    maxTokens: String(model.maxTokens),
    defaultReasoning: model.defaultReasoning,
  }
}

/**
 * Spell a stored catalogue as draft rows.
 * @param models - the stored catalogue.
 * @returns one draft per entry, in order.
 */
export function draftsOf(models: readonly CcPoolModel[]): CcPoolModelDraft[] {
  return models.map(draftOf)
}

/**
 * A blank row, as the add action creates it.
 * @returns a row carrying no identity yet; validation blocks its save until it has one.
 */
export function emptyDraft(): CcPoolModelDraft {
  return { id: '', name: '', contextWindow: '', maxTokens: '', defaultReasoning: NEW_ROW_REASONING }
}

/**
 * Whether two draft lists would store the same catalogue text.
 *
 * The comparison is over what a save writes, not the keystrokes: padding
 * around an id, a display name, or a capacity is not an edit, and neither are
 * a capacity's leading zeros. Two different unreadable capacities stay
 * different, so a bad draft is still a draft.
 * @param left - one list.
 * @param right - the other list.
 * @returns true when every row would store the same entry.
 */
export function draftsEqual(left: readonly CcPoolModelDraft[], right: readonly CcPoolModelDraft[]): boolean {
  if (left.length !== right.length) return false
  return left.every((draft, index) => {
    // The lengths were compared above; noUncheckedIndexedAccess still widens the read.
    const other = right[index] as CcPoolModelDraft
    return draft.id.trim() === other.id.trim()
      && draft.name.trim() === other.name.trim()
      && sameCapacityText(draft.contextWindow, other.contextWindow)
      && sameCapacityText(draft.maxTokens, other.maxTokens)
      && draft.defaultReasoning === other.defaultReasoning
  })
}

/**
 * Whether two capacity drafts would write the same number.
 * @param left - one field's raw text.
 * @param right - the other field's raw text.
 * @returns true when the texts match as written or name the same positive integer.
 */
function sameCapacityText(left: string, right: string): boolean {
  const text = left.trim()
  const other = right.trim()
  if (text === other) return true
  return isPositiveIntegerText(text) && isPositiveIntegerText(other) && Number(text) === Number(other)
}

/**
 * Whether draft text is a positive whole number.
 * @param text - the field's raw text.
 * @returns true when the text parses as a safe positive integer and is written as digits only.
 */
export function isPositiveIntegerText(text: string): boolean {
  const trimmed = text.trim()
  if (!/^[0-9]+$/.test(trimmed)) return false
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0
}

/**
 * Every problem that blocks saving the drafted catalogue.
 *
 * The rules judge the text a save would write, so a blank id or name is one
 * that stays blank after trimming: the write stores the trimmed value, and the
 * Host refuses an empty one. Two ids that differ only in padding are the same
 * id for the same reason.
 * @param drafts - the rows as edited.
 * @returns one entry per problem, in row order; empty when a save may proceed.
 */
export function validateDrafts(drafts: readonly CcPoolModelDraft[]): CcPoolDraftError[] {
  const errors: CcPoolDraftError[] = []
  const ids = new Map<string, number>()
  for (const draft of drafts) {
    const id = draft.id.trim()
    if (id.length > 0) ids.set(id, (ids.get(id) ?? 0) + 1)
  }
  drafts.forEach((draft, row) => {
    const id = draft.id.trim()
    if (id.length === 0) errors.push({ row, field: 'id', key: 'idBlank' })
    // The first pass counted every non-empty id, so this read cannot miss.
    else if ((ids.get(id) as number) > 1) errors.push({ row, field: 'id', key: 'idDuplicate' })
    if (draft.name.trim().length === 0) errors.push({ row, field: 'name', key: 'nameBlank' })
    if (!isPositiveIntegerText(draft.contextWindow)) errors.push({ row, field: 'contextWindow', key: 'positiveInteger' })
    if (!isPositiveIntegerText(draft.maxTokens)) errors.push({ row, field: 'maxTokens', key: 'positiveInteger' })
    if (!isCcPoolReasoningLevel(draft.defaultReasoning)) errors.push({ row, field: 'defaultReasoning', key: 'reasoningLevel' })
  })
  return errors
}

/**
 * The wire catalogue a valid draft list describes.
 * @param drafts - the rows as edited.
 * @returns the entries with trimmed text and numeric capacities, or undefined while the list is
 *   empty or carries a problem; the caller reports the problems from {@link validateDrafts}.
 */
export function modelsOfDrafts(drafts: readonly CcPoolModelDraft[]): CcPoolModel[] | undefined {
  if (drafts.length === 0 || validateDrafts(drafts).length > 0) return undefined
  return drafts.map(draft => ({
    id: draft.id.trim(),
    name: draft.name.trim(),
    contextWindow: Number(draft.contextWindow.trim()),
    maxTokens: Number(draft.maxTokens.trim()),
    // validateDrafts admitted only the five levels; the narrowing is what the wire type needs.
    defaultReasoning: draft.defaultReasoning as CcPoolReasoningLevel,
  }))
}
