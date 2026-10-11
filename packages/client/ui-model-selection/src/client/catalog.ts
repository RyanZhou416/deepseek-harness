/** One Host-generation model catalog shared by every Session selector. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Observable lifecycle of the shared model catalog. */
export interface ModelCatalogState {
  /** Last complete catalog for the current Host generation; retained across a same-generation refresh. */
  value: ModelCatalog | null
  /**
   * `refreshing` publishes a retained `value` that a same-generation
   * replacement is about to supersede: readers may use it, while a selector
   * that pairs the catalog with another input waits for the replacement so it
   * never publishes a pair the replacement could contradict.
   */
  status: 'idle' | 'loading' | 'refreshing' | 'ready' | 'error'
  /**
   * Replacement failure text. Store readers keep showing the retained
   * {@link value}, while `load()` starts a new read instead of answering from
   * it, so a failed replacement is retried rather than served.
   */
  error: string | null
}

/**
 * Loads at most one model catalog for the current Host generation, and answers
 * warm readers from the retained catalog while a same-generation replacement is
 * in flight.
 */
export class ModelCatalogDirectory {
  /** Current shared catalog value and load lifecycle. */
  readonly store: SnapshotStore<ModelCatalogState> = createSnapshotStore({
    value: null,
    status: 'idle',
    error: null,
  })

  /** Bumped by every invalidation; a response from an older generation never publishes. */
  private generation = 0
  /** The one authority read in flight, if any. */
  private inflight: Promise<ModelCatalog> | undefined
  /** Whether an invalidation arrived during {@link inflight} and still needs its own read. */
  private trailing = false
  /** Scope teardown: no read starts and no late settlement publishes after this. */
  private disposed = false

  /**
   * @param ctx - the providing plugin's context, whose `remote.session`
   * namespace carries the Host-generation catalog.
   */
  constructor(private readonly ctx: ClientContext) {}

  /**
   * Return the current generation's catalog. A complete retained catalog
   * answers immediately, including while a refresh of it is in flight: opening
   * a menu must not wait on provider discovery a refresh already started. Only
   * an unloaded or superseded generation awaits the authority read, and its
   * one in-flight read is shared.
   * @returns the loaded global catalog.
   * @throws After {@link dispose}, which starts no read and serves no value.
   */
  load(): Promise<ModelCatalog> {
    if (this.disposed) return Promise.reject(new Error('the model catalog was disposed'))
    const state = this.store.getSnapshot()
    if (state.value !== null && (state.status === 'ready' || state.status === 'refreshing')) {
      return Promise.resolve(state.value)
    }
    if (this.inflight !== undefined) return this.inflight
    return this.read()
  }

  /**
   * Resolve once the retained catalog has stopped being replaced.
   *
   * A caller that must not act on a superseded catalog awaits this; a caller
   * that only repaints does not, because the retained value is what it shows.
   * @returns fulfillment when no read is in flight, which is immediate after
   * {@link dispose}.
   */
  async settled(): Promise<void> {
    while (this.inflight !== undefined) {
      await this.inflight.catch(() => undefined)
    }
  }

  /**
   * Scope teardown. The read in flight is not cancelled: it belongs to the
   * shared connection, and the generation bump discards its result, prevents
   * the queued trailing read, and stops every later read.
   */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.trailing = false
    this.inflight = undefined
  }

  /**
   * Invalidate and reload the catalog after a Host-side model input changes.
   * The retained catalog stays published, so readers keep answering while the
   * replacement loads. Reads never overlap: an invalidation arriving during one
   * requests a single trailing read, and every invalidation it waits behind is
   * superseded, so that read serves the newest generation.
   */
  refresh(): void {
    if (this.disposed) return
    this.invalidate()
    if (this.inflight !== undefined) {
      this.trailing = true
      return
    }
    this.reload()
  }

  /** Clear Host-specific values and load the replacement Host generation. */
  resetGeneration(): void {
    if (this.disposed) return
    this.invalidate(true)
    // Reads from the superseded generation are abandoned: they cannot publish,
    // and their settlement must not drive the new generation's trailing slot.
    this.trailing = false
    this.inflight = undefined
    this.reload()
  }

  /** Start a read whose failure the store already publishes; the caller has no failure surface of its own. */
  private reload(): void {
    void this.read().catch(() => { /* the selector exposes the shared error */ })
  }

  /** Start the one authority read for the current generation and publish it when still current. */
  private read(): Promise<ModelCatalog> {
    const generation = this.generation
    const state = this.store.getSnapshot()
    // A retained catalog is published as refreshing: readers answer from it
    // while this read replaces it, and a selector pairing it with another input
    // waits for the replacement.
    const status = state.value === null ? 'loading' : 'refreshing'
    if (state.status !== status) this.store.set({ value: state.value, status, error: null })
    const operation = this.ctx.remote.session.modelCatalog().then((response) => {
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      if (generation === this.generation) {
        this.store.set({ value: response.value, status: 'ready', error: null })
      }
      return response.value
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        this.store.set({
          value: state.value,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      }
      throw error
    }).finally(() => {
      if (this.inflight !== operation) return
      this.inflight = undefined
      if (!this.trailing) return
      this.trailing = false
      this.reload()
    })
    this.inflight = operation
    return operation
  }

  /**
   * Supersede the retained catalog and the reads of the previous generation.
   * Retaining a value marks it refreshing without changing it, so an
   * invalidation that cannot alter what readers see does not notify them.
   * @param clear - whether values from the previous Host generation must be hidden.
   */
  private invalidate(clear = false): void {
    this.generation += 1
    const state = this.store.getSnapshot()
    const value = clear ? null : state.value
    const status = value === null ? 'idle' : 'refreshing'
    if (value === state.value && state.status === status) return
    this.store.set({ value, status, error: null })
  }
}
