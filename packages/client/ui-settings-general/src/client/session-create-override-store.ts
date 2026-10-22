/** Live model directory for the Session-creation model override row. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The model rows a General Settings selector can offer. */
export interface SessionCreateOverrideCatalog {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly groups: readonly ModelProviderGroup[]
  readonly partial: boolean
}

/** Loads the Host model directory on demand and publishes it to the row. */
export class SessionCreateOverrideCatalogStore {
  readonly store = createSnapshotStore<SessionCreateOverrideCatalog>({
    status: 'idle',
    groups: [],
    partial: false,
  })

  private disposed = false
  private loading = false

  /**
   * Fetch the current model directory unless a request is already in flight.
   * @returns nothing; the snapshot reports the outcome.
   */
  load(): void {
    if (this.loading || this.disposed) return
    this.loading = true
    this.store.set({ status: 'loading', groups: this.store.getSnapshot().groups, partial: false })
    void this.ctx.remote.session.modelCatalog()
      .then((result) => {
        if (this.disposed) return
        if (!result.ok) throw result.error
        this.store.set({
          status: 'ready',
          groups: result.value.groups,
          partial: result.value.failures.length > 0,
        })
      })
      .catch(() => {
        if (this.disposed) return
        this.store.set({ status: 'error', groups: [], partial: false })
      })
      .finally(() => {
        this.loading = false
      })
  }

  /** Stop publishing fetched results after the owning plugin is disposed. */
  dispose(): void {
    this.disposed = true
  }

  constructor(private readonly ctx: ClientContext) {}
}
