import type { AccountPreferences, ProviderPreferences } from '../provider-settings.js'

export interface AccountCatalogRow {
  key: string
  label: string
  models: { id: string; name: string; disabledReason?: string }[]
  unavailable?: boolean
}

/** Missing allowlist follows discovery; explicit [] must remain empty. */
export function accountPoolSelection(account: AccountPreferences, models: readonly { id: string }[]): Set<string> {
  return new Set(account.poolModels ?? models.map(model => model.id))
}

/** One account the model list offers a pool checkbox for. */
export interface ModelPoolAccount {
  /** Account key the checkbox writes. */
  key: string
  /** Alias or account label shown beside the checkbox. */
  label: string
  /** The account's own catalog rows: what it lists, and why it refuses any of them. */
  models: readonly AccountCatalogRow['models'][number][]
}

/** One account's pool membership of one model, as that model's row renders it. */
export interface ModelPoolCell {
  /** Account key the checkbox writes. */
  key: string
  /** Alias or account label shown beside the checkbox. */
  label: string
  /** Whether this account's pool may serve the model. */
  allowed: boolean
  /** The provider's own reason for refusing the model on this account, when it stated one. */
  disabledReason?: string
}

/**
 * The pool cells one model's row shows, in account order.
 *
 * A cell exists for every account whose catalog lists the model, and for one whose saved
 * allowlist still names it — an id the catalog dropped stays editable rather than becoming
 * invisible. The provider model list is the only place a model is listed, so each account's
 * membership rides that model's own row instead of a second per-account model list, and the
 * account's own refusal reason travels with its checkbox.
 * @param model - the row's wire model id.
 * @param accounts - the accounts offering a checkbox, in dialog order.
 * @param selectionOf - one account's current pool selection.
 * @returns the row's cells, one per participating account.
 */
export function modelPoolCells(
  model: string,
  accounts: readonly ModelPoolAccount[],
  selectionOf: (key: string) => ReadonlySet<string>,
): ModelPoolCell[] {
  const cells: ModelPoolCell[] = []
  for (const account of accounts) {
    const listed = account.models.find(entry => entry.id === model)
    const selected = selectionOf(account.key)
    if (listed === undefined && !selected.has(model)) continue
    cells.push({
      key: account.key,
      label: account.label,
      allowed: selected.has(model),
      ...listed?.disabledReason === undefined ? {} : { disabledReason: listed.disabledReason },
    })
  }
  return cells
}

/**
 * Model ids a saved allowlist names that no catalog lists any more, so their rows survive a
 * catalog change and the account can still be edited back to them.
 * @param accounts - the accounts offering a checkbox.
 * @param selectionOf - one account's current pool selection.
 * @returns the unlisted ids, in first-seen order.
 */
export function unlistedPoolModels(
  accounts: readonly ModelPoolAccount[],
  selectionOf: (key: string) => ReadonlySet<string>,
): string[] {
  const listed = new Set(accounts.flatMap(account => account.models.map(entry => entry.id)))
  const unlisted: string[] = []
  for (const account of accounts) {
    for (const id of selectionOf(account.key)) {
      if (listed.has(id) || unlisted.includes(id)) continue
      unlisted.push(id)
    }
  }
  return unlisted
}

/** Preserve the latest account and automatic credit settings when saving the model editor. */
export function mergeLatestAccounts(draft: ProviderPreferences, latest: ProviderPreferences): ProviderPreferences {
  const { accounts: _stale, autoResetCredits: _staleAutoReset, ...settings } = draft
  return { ...settings, ...(latest.accounts === undefined ? {} : { accounts: latest.accounts }),
    ...(latest.autoResetCredits === undefined ? {} : { autoResetCredits: latest.autoResetCredits }) }
}

/** Only touched accounts replace their latest preferences; other settings survive. */
export function mergeAccountChanges(
  latest: ProviderPreferences,
  changes: Record<string, AccountPreferences>,
): ProviderPreferences {
  return { ...latest, accounts: { ...latest.accounts, ...changes } }
}
