/**
 * Load-time reconciliation of the account-keyed state for a Codex identity the
 * auth store already renamed.
 *
 * A rename normally announces itself on the save that proved it (see
 * `AccountTokenManager`'s `onAccountRenamed`). A store migrated on an earlier run
 * — or one whose announcing process died before the account-keyed caches were
 * moved — leaves only the recorded alias behind, and no later save will mention
 * it again. This module closes that gap once per process, before anything reads
 * account policy: the pairs come from the store's own alias records, so the
 * identity is never guessed, and only an alias whose target account still exists
 * is applied.
 *
 * Read-only with respect to the store: a read failure is reported, never
 * repaired and never wiped, and the store stays the loud authority for every
 * other reader.
 */

import { errorChain } from '@deepseek-ai/dsh-llm'
import { loadStore } from '../auth/store.js'
import type { ProviderId } from '../auth/store.js'

/** One recorded rename: the retired account key and the key that replaced it. */
export interface StoredAccountAlias {
  /** The key the account was stored under before the store rekeyed it. */
  from: string
  /** The canonical key that account resolves to now. */
  to: string
}

/**
 * The Codex renames the auth store recorded whose target account still exists.
 *
 * Read-only: no token request, no store write, no identity inference — only the
 * alias pairs the store itself recorded, with the retired key first.
 * @param path - auth store path; defaults to the store's own file.
 * @returns the applicable alias pairs, in store order.
 * @throws when the store cannot be read, exactly as every other store reader does.
 */
export async function storedCodexAliases(path?: string): Promise<readonly StoredAccountAlias[]> {
  const store = await (path === undefined ? loadStore() : loadStore(path))
  const entry = store.codex
  if (entry === undefined) return []
  const moved: StoredAccountAlias[] = []
  for (const [from, to] of Object.entries(entry.aliases ?? {})) {
    // The target must be a stored account: an alias whose account is gone names
    // nothing to move, and a self-alias is not a rename.
    if (from === to || !Object.hasOwn(entry.accounts, to)) continue
    moved.push({ from, to })
  }
  return moved
}

/**
 * Apply every stored Codex rename once, through the same move a live rename
 * uses, so account-keyed state follows an identity the store rekeyed earlier.
 *
 * Both halves are contained: an unreadable store or a failed move is reported
 * through `onWarn` and the pass ends without touching the store, so a caller can
 * await this before its first read without turning a store problem into a
 * permanent read failure.
 * @param options - the move callback, the warning sink and an optional store path.
 * @param options.move - applies one rename exactly as the live path does.
 * @param options.onWarn - receives a safe diagnostic for a failed read or move.
 * @param options.path - auth store path override; defaults to the store's own file.
 * @returns nothing once every recorded alias has been attempted.
 */
export async function reconcileStoredCodexAliases(options: {
  move: (provider: ProviderId, from: string, to: string) => Promise<void>
  onWarn?: (message: string) => void
  path?: string
}): Promise<void> {
  let aliases: readonly StoredAccountAlias[]
  try {
    aliases = await storedCodexAliases(options.path)
  } catch (error: unknown) {
    // The recorded alias is deliberately left in place: the store is the
    // authority for it, and a failed read is not evidence that it is gone.
    options.onWarn?.(
      `dsh-plugin-subscriptions: the auth store could not be read (${errorChain(error)}); `
      + 'stored account renames were not applied',
    )
    return
  }
  for (const { from, to } of aliases) {
    try {
      await options.move('codex', from, to)
    } catch (error: unknown) {
      options.onWarn?.(
        `dsh-plugin-subscriptions: account state did not follow the stored rename `
        + `"${from}" -> "${to}" (${errorChain(error)})`,
      )
    }
  }
}
