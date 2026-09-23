/**
 * The DeepSeek platform balance behind the Context Dashboard's header
 * capsule: the figure the previous open remembered (memory first, then
 * storage) shown at once, plus one background read of the plugin's
 * `/api/dsh-context/balance` fetch route (host/balance.ts) on every open, so
 * the remembered total never survives a stale one for long.
 *
 * A remembered figure is a stale-while-revalidate display choice, not an
 * error state: the platform's balance moves far slower than the dashboard
 * opens, and a stale figure that a background read corrects beats a blank
 * pill on every visit. An open that finds nothing remembered — and a route
 * that answers nothing while nothing is remembered — resolves `null`, and
 * the capsule renders nothing: a balance viewer shows a real number or it
 * shows nothing at all, never a spinner or an error where a pill should be.
 */

import type { PlatformBalance, PlatformBalanceEntry } from '../shared/types'
import { asRecord } from './services'

// The balance route of host/balance.ts — re-declared here (the client bundle
// inlines every import, and the host module must never reach it). Same-origin
// POST under the harness's authenticated `/api` fence.
const BALANCE_ROUTE = '/api/dsh-context/balance'

/** Where the last live figure is remembered across opens, per browser. */
const STORAGE_KEY = 'dsh-context:platform-balance'

/** The slice of Web Storage this module consumes, so tests can swap it. */
export interface StorageFace {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Test seam: swap the storage backing the remembered figure; undefined re-detects. */
export function setPlatformBalanceStorage(next: StorageFace | null | undefined): void {
  storage = next
}

/** Test seam: the key the remembered figure lives under. */
export const PLATFORM_BALANCE_STORAGE_KEY = STORAGE_KEY

/** One platform amount ('110.00', or an already-numeric producer variant), or null. */
function amountOf(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Narrow the delivered payload to a render-safe value (the same boundary
 * rigor as `timelineOf`): each entry's currency and amounts re-proved, an
 * entry failing the shape drops whole, and a payload with no valid entry is
 * no balance — the caller renders nothing rather than half a figure.
 */
export function platformBalanceOf(value: unknown): PlatformBalance | null {
  const data = asRecord(value)
  if (data === null) return null
  const infos = Array.isArray(data.balances) ? data.balances : []
  const balances: PlatformBalanceEntry[] = []
  for (const info of infos) {
    // Bounded catch: a hostile entry may throw on property access — it drops
    // whole, and the entries that prove their shape keep serving.
    try {
      const entry = asRecord(info)
      if (entry === null) continue
      const currency = entry.currency
      const total = amountOf(entry.total)
      const granted = amountOf(entry.granted)
      const toppedUp = amountOf(entry.toppedUp)
      if (typeof currency !== 'string' || currency === ''
        || total === null || granted === null || toppedUp === null) continue
      balances.push({ currency, total, granted, toppedUp })
    } catch {
      continue
    }
  }
  return balances.length > 0
    ? { isAvailable: data.isAvailable === true, balances }
    : null
}

/**
 * The entry matching the display currency (zh → CNY, en → USD), falling back
 * to the account's first entry when the platform reports none in it — a
 * number in the account's own currency beats no number.
 */
export function balanceEntryOf(
  balance: PlatformBalance | null | undefined,
  currency: 'cny' | 'usd',
): PlatformBalanceEntry | null {
  if (balance === null || balance === undefined || balance.balances.length === 0) return null
  const want = currency === 'cny' ? 'CNY' : 'USD'
  return balance.balances.find(entry => entry.currency === want) ?? balance.balances[0]
}

let cached: PlatformBalance | null = null
/** The route read in flight, so a second open joins it instead of starting one. */
let refreshing: Promise<void> | null = null
/**
 * The landing callbacks of every open riding the in-flight read — all
 * notified when it lands, so an open that JOINS mid-flight (a fast
 * close-reopen, a second capsule) settles on the live figure too, exactly
 * as this function's contract promises (issue #82). Cleared when the read
 * settles: the next open starts a fresh read and a fresh set.
 */
const landingCallbacks = new Set<(value: PlatformBalance) => void>()

/** The storage this module reads and writes; swapped in tests. */
let storage: StorageFace | null | undefined

function storageFn(): StorageFace | null {
  if (storage !== undefined) return storage
  try {
    // Runtime-guarded: the browser always has it, but a host may not, and the
    // report type says it is present either way.
    const found: unknown = globalThis.localStorage
    storage = found === null || found === undefined ? null : found as StorageFace
  } catch {
    // Storage can throw on mere access (some privacy modes); the capsule then
    // has no remembered figure — the same shape as a first-ever open.
    storage = null
  }
  return storage
}

/** The stored figure, or `null` when absent, unreadable, or no longer a valid balance. */
function storedBalance(): PlatformBalance | null {
  try {
    const raw = storageFn()?.getItem(STORAGE_KEY)
    return raw === null || raw === undefined ? null : platformBalanceOf(JSON.parse(raw))
  } catch {
    return null
  }
}

function rememberBalance(value: PlatformBalance | null): void {
  try {
    storageFn()?.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // A refused write (quota, privacy mode) costs only the next open's head
    // start; the live figure still renders.
  }
}

/** One route POST, narrowed through `platformBalanceOf`. Never rejects. */
async function readRoute(): Promise<PlatformBalance | null> {
  try {
    const response = await fetch(BALANCE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    if (!response.ok) return null
    const r = asRecord(await response.json())
    if (r === null || r.ok !== true || r.value === null || r.value === undefined) return null
    return platformBalanceOf(r.value)
  } catch {
    return null
  }
}

/**
 * One route read per open, with `onRefresh` once it lands on a figure: the
 * capsule paints the remembered total immediately and settles on the live
 * one. `refreshing` is assigned before anything awaits, so an open arriving
 * while a read is still in flight joins it rather than starting a second one;
 * its callback joins the landing set, so the read's landing reports to EVERY
 * open riding it — the joiner included (issue #82). A failed or absent read
 * notifies nobody and keeps serving the remembered figure, so an offline open
 * never trades a number for a blank pill; `null` (whether pending, absent, or
 * failed) means nothing to show yet.
 */
export function readPlatformBalance(onRefresh: (value: PlatformBalance) => void): PlatformBalance | null {
  landingCallbacks.add(onRefresh)
  if (refreshing === null) {
    refreshing = (async () => {
      const value = await readRoute()
      if (value === null) return
      cached = value
      rememberBalance(value)
      for (const waiter of landingCallbacks) waiter(value)
    })().finally(() => {
      refreshing = null
      landingCallbacks.clear()
    })
  }
  return cached ?? storedBalance()
}

/** Test isolation: drop the cache, the storage contents, and the storage swap. */
export function resetPlatformBalance(): void {
  cached = null
  refreshing = null
  landingCallbacks.clear()
  try {
    storageFn()?.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to drop when storage is unreadable.
  }
  storage = undefined
}
