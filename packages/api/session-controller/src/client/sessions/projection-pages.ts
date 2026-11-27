/**
 * Older pages of paged projection keys (units declaring `wire.hintView`),
 * merged under the newest window every Client payload carries.
 *
 * @module @deepseek-ai/dsh-api-session-controller/client/sessions/projection-pages
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One paged item: paged views are append-only arrays of records carrying a string `id`. */
interface PagedItem {
  readonly id: string
}

/** One contiguous run of older items, starting at `start` in the complete array. */
interface LoadedRun {
  readonly start: number
  readonly items: readonly PagedItem[]
}

/** One merged value with the inputs it was built from, so unchanged inputs keep its identity. */
interface MergedEntry {
  readonly window: readonly PagedItem[]
  readonly run: LoadedRun
  readonly merged: readonly PagedItem[]
}

/** One read page as `session.projectionPage` returns it. */
export interface ProjectionPage {
  readonly items: readonly unknown[]
  readonly start: number
}

/** Older-page state of every Session's paged keys in one Host generation. */
export class ProjectionPages {
  private readonly runs = new Map<SessionId, Map<string, LoadedRun>>()
  private readonly merged = new Map<SessionId, Map<string, MergedEntry>>()

  /**
   * Older items not yet read for one key.
   * @param sessionId - Session owning the key.
   * @param key - paged projection key.
   * @returns the start index of the loaded run, which is the unread older count, or undefined before any page was read.
   */
  unread(sessionId: SessionId, key: string): number | undefined {
    return this.runs.get(sessionId)?.get(key)?.start
  }

  /**
   * Keys of one Session that have loaded pages.
   * @param sessionId - Session owning the keys.
   * @returns the paged keys read at least once in this generation.
   */
  keys(sessionId: SessionId): readonly string[] {
    const runs = this.runs.get(sessionId)
    return runs === undefined ? [] : [...runs.keys()]
  }

  /**
   * Record one older page. A page that ends where the loaded run starts
   * extends the run; any other page replaces it, so the run never has a gap.
   * @param sessionId - Session owning the key.
   * @param key - paged projection key.
   * @param page - the items `[start, start + items.length)` of the complete array.
   */
  add(sessionId: SessionId, key: string, page: ProjectionPage): void {
    const items = page.items as readonly PagedItem[]
    let runs = this.runs.get(sessionId)
    if (runs === undefined) {
      runs = new Map()
      this.runs.set(sessionId, runs)
    }
    const current = runs.get(key)
    runs.set(key, current !== undefined && page.start + items.length === current.start
      ? { start: page.start, items: [...items, ...current.items] }
      : { start: page.start, items })
  }

  /**
   * The known value of one key: loaded older items followed by the pushed window.
   * An item the window repeats is taken from the window, which is newer.
   * @param sessionId - Session owning the key.
   * @param key - paged projection key.
   * @param window - the newest items the latest payload carried.
   * @returns the window itself before any page was read; otherwise the merged array, identity-stable while its inputs are.
   */
  merge(sessionId: SessionId, key: string, window: readonly unknown[]): readonly unknown[] {
    const run = this.runs.get(sessionId)?.get(key)
    if (run === undefined) return window
    const pushed = window as readonly PagedItem[]
    let cache = this.merged.get(sessionId)
    const cached = cache?.get(key)
    if (cached !== undefined && cached.window === pushed && cached.run === run) return cached.merged
    const inWindow = new Set(pushed.map(item => item.id))
    const merged = [...run.items.filter(item => !inWindow.has(item.id)), ...pushed]
    if (cache === undefined) {
      cache = new Map()
      this.merged.set(sessionId, cache)
    }
    cache.set(key, { window: pushed, run, merged })
    return merged
  }

  /**
   * Forget one Session's pages.
   * @param sessionId - removed Session.
   */
  drop(sessionId: SessionId): void {
    this.runs.delete(sessionId)
    this.merged.delete(sessionId)
  }

  /** Forget every page; a new Host generation reads them again. */
  clear(): void {
    this.runs.clear()
    this.merged.clear()
  }
}
