/**
 * The Claude catalogue the model picker lists: the client's baked-in table plus
 * whatever the bootstrap endpoint adds for one account.
 *
 * Membership is read from the pinned wire profile's own `supportedModels` table, which
 * is that baked-in catalogue, so no id is restated here and a profile bump cannot leave
 * a stale copy behind. The wire library models only the catalogue fields a request
 * reads and deliberately drops `display_name`, so the display text below is transcribed
 * from the same baked-in table as the carve holds it: `chunk-g52pkz6d.js` in
 * `cc-2.1.288-modules`, whose twenty-one entries agree with
 * `.cc-carve/model-catalogue.json` on id, family and display name. An id with no display
 * text maps to the id itself rather than inventing a name.
 */

import { CLAUDE_CODE_2_1_288_PROFILE } from '@tormentalabs/claude-code-wire-compat'
import type { DiscoveredModel } from './common.js'

/** Display text the client's baked-in catalogue gives each pinned model id. */
const CLAUDE_DISPLAY_NAMES: Readonly<Partial<Record<string, string>>> = Object.freeze({
  'claude-3-5-haiku': 'Haiku 3.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-3-5-sonnet': 'Sonnet 3.5',
  'claude-3-7-sonnet': 'Sonnet 3.7',
  'claude-sonnet-4-0': 'Sonnet 4',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-4-0': 'Opus 4',
  'claude-opus-4-1': 'Opus 4.1',
  'claude-opus-4-5': 'Opus 4.5',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-5': 'Opus 5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5': 'Fable 5',
  'claude-fable-5-1': 'Fable 5.1',
  'claude-mythos-5': 'Mythos 5',
  'claude-mythos-5-1': 'Mythos 5.1',
})

/** One entry of the bootstrap document's `additional_model_options`. */
export interface ClaudeCatalogueOption {
  model?: string
  name?: string
  description?: string
  disabled_reason?: string | null
}

/**
 * The client's built-in catalogue as catalogue rows, in the catalogue's own order.
 * No request is involved: the genuine client holds this table and lists from it.
 * @returns one row per pinned profile model id.
 */
export function claudeBuiltInCatalogue(): DiscoveredModel[] {
  return Object.keys(CLAUDE_CODE_2_1_288_PROFILE.supportedModels).map(id => ({
    id,
    name: CLAUDE_DISPLAY_NAMES[id] ?? id,
  }))
}

/**
 * The built-in catalogue with one account's options applied.
 *
 * An option naming a model the catalogue already carries replaces that row's display
 * text and disabled state in place, so the picker keeps one row per id in catalogue
 * order; an option naming a model the catalogue lacks is appended; an option naming no
 * model is skipped. A `disabled_reason` marks the row unavailable instead of removing
 * it, which is how the service tells the client that a model exists but this account
 * cannot select it.
 *
 * @param base - the built-in catalogue rows.
 * @param options - the endpoint's options, already known to be an array.
 * @returns the merged catalogue rows.
 */
export function mergeClaudeCatalogue(
  base: readonly DiscoveredModel[],
  options: readonly ClaudeCatalogueOption[],
): DiscoveredModel[] {
  const rows = base.map(row => ({ ...row }))
  const index = new Map(rows.map((row, position) => [row.id, position]))
  for (const option of options) {
    if (typeof option?.model !== 'string' || option.model.length === 0) continue
    const position = index.get(option.model)
    const existing = position === undefined ? undefined : rows[position]
    const row: DiscoveredModel = {
      id: option.model,
      name: typeof option.name === 'string' && option.name.length > 0
        ? option.name
        : existing?.name ?? option.model,
      ...option.description === undefined ? {} : { description: option.description },
      ...option.disabled_reason == null ? {} : { disabledReason: option.disabled_reason },
    }
    if (position === undefined) {
      index.set(option.model, rows.length)
      rows.push(row)
    } else {
      // The catalogue row keeps every field the built-in table gave it; the account's own
      // display text and disabled state are what the option restates.
      rows[position] = { ...existing, ...row }
    }
  }
  return rows
}
