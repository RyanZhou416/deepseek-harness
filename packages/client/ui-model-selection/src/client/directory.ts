/**
 * Per-session model directory: the ONE state both selection entries share.
 * The /model popup and composer seat combine one shared Host catalog with the
 * Session's durable selection projection, then submit through the same
 * selectModel call. A switch made in either entry updates this shared state.
 */
import type {
  ModelCatalogFailure, ModelProviderGroup, ModelSelection, ModelSelectionProjection,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalogDirectory } from './catalog.ts'

/** Directory snapshot both entries render from. */
export interface ModelDirectoryState {
  /** Effective selection: durable next-request projection, then Host default. */
  current: ModelSelection | null
  /**
   * Whether an adapter serves the current selection's provider, as the host reports
   * it — null before the first load, which is NOT the same as blocked. Read
   * this rather than "current matches no group": catalog membership is
   * advisory, so a route serving a model it stopped advertising is missing
   * from the groups yet perfectly usable.
   */
  routable: boolean | null
  /** Successfully loaded provider groups (last good load). */
  groups: readonly ModelProviderGroup[]
  /** Provider-local failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
  /** Lifecycle of the in-flight operation. */
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** Whole-request or selection failure text; null when none. */
  error: string | null
}

/** One session's shared directory controller; disposed with the session scope. */
export class ModelDirectory {
  /** The shared snapshot both entries render from (uSES-safe store). */
  readonly store: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', error: null,
  })

  /** Latest selection operation wins; an older response never overwrites a newer one. */
  private generation = 0
  private disposed = false
  private resolved = false
  private readonly unsubscribeCatalog: () => void
  private readonly unsubscribeSelection: () => void

  /**
   * @param sessions - the session wire face (captured from the plugin's root connection).
   * @param sessionId - the owning session.
   * @param available - whether this session may use Agent-bound model RPCs.
   * @param catalog - Host-generation catalog shared by every Session.
   * @param projected - durable model selection projected from Session history.
   */
  constructor(
    private readonly sessions: Pick<TypertClientRemote['session'], 'selectModel'>,
    private readonly sessionId: SessionId,
    private readonly available: () => boolean,
    private readonly catalog: ModelCatalogDirectory,
    private readonly projected: ObservableSnapshot<unknown>,
  ) {
    this.unsubscribeCatalog = catalog.store.subscribe(() => { this.syncInputs() })
    this.unsubscribeSelection = projected.subscribe(() => { this.syncInputs() })
    this.syncInputs()
  }

  /**
   * Ensure the Host generation's shared advisory catalog is loaded.
   *
   * While a same-generation replacement is loading, the published view keeps the
   * last complete catalog/projection pair. An explicit read waits for the
   * replacement whenever the live inputs already name a different route, so a
   * caller acting on the returned selection never acts on the model the
   * session's projection has replaced: a selection change is not instantaneous
   * until the catalog catches up. Only a read whose route is unchanged answers
   * at once from the retained catalog.
   *
   * The wait re-checks this directory's own lifecycle after every suspension:
   * the shared catalog outlives the per-session directory, so a read that
   * resumed after the session scope went would otherwise keep waiting for a view
   * that can no longer be published.
   * @returns the directory value naming the session's newest selection.
   * @throws When the catalog cannot supply the replacement, so no route the
   * caller could act on is known (a failed replacement is retried once first),
   * or when this directory is disposed while the read waits.
   */
  async load(): Promise<ModelDirectoryState> {
    this.assertAvailable()
    for (;;) {
      this.assertNotDisposed()
      await this.catalog.load()
      this.assertNotDisposed()
      this.syncInputs()
      if (!this.routeAwaitingReplacement()) return this.store.getSnapshot()
      if (this.catalog.store.getSnapshot().status === 'error') {
        throw new Error('model selection: the shared model catalog could not supply the session\'s newest selection')
      }
      await this.catalog.settled()
      this.syncInputs()
    }
  }

  /**
   * Fail a read whose session scope is gone. A disposed directory publishes no
   * further view, so a waiting read could never observe the route it waits for
   * and would re-check without ever suspending.
   * @throws Whenever this directory has been disposed.
   */
  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('model selection: this session\'s model directory was disposed')
  }

  /**
   * Whether the published view does not yet name the route the live inputs do,
   * which is exactly what a same-generation replacement holds back. A ready
   * catalog has already been combined, so this is only ever true while a
   * replacement is loading or has failed.
   * @returns true when an explicit read must wait for the replacement.
   */
  private routeAwaitingReplacement(): boolean {
    const catalog = this.catalog.store.getSnapshot()
    const projected = modelSelectionProjection(this.projected.getSnapshot())
    if (catalog.value === null || projected === undefined) return false
    const newest = projected.next ?? catalog.value.default
    const current = this.store.getSnapshot().current
    // Provider and model are compared as separate fields: an id may contain the
    // separator a composed key would use.
    return current === null || current.provider !== newest.provider || current.model !== newest.model
  }

  /**
   * Select the complete provider/model/reasoning selection. The durable
   * projection frame updates the shared current; failures surface on the store
   * and return with the operation so each entry can present its own failure.
   * @param selection - provider, provider-owned model id, and optional adapter-owned effort.
   * @returns the selection outcome, including the original Remote failure.
   */
  async select(selection: ModelSelection): Promise<RemoteResult<void>> {
    this.assertAvailable()
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'selecting'; s.error = null })
    const result = await this.sessions.selectModel({
      sessionId: this.sessionId,
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort },
    })
    if (this.disposed || generation !== this.generation) {
      return result.ok ? { ok: true, value: undefined } : result
    }
    if (!result.ok) {
      this.store.update((s) => {
        s.status = 'error'
        s.error = `${result.error.code}: ${result.error.message}`
      })
      return result
    }
    this.store.update((s) => { s.status = 'ready'; s.error = null })
    this.syncInputs()
    return { ok: true, value: undefined }
  }

  /**
   * Invalidate an in-flight selection response from the previous Host generation.
   */
  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    this.store.update((state) => {
      if (state.status === 'selecting') state.status = 'idle'
      state.error = null
    })
    this.syncInputs()
  }

  /** Scope teardown: late settlements lose write access to the store. */
  dispose(): void {
    this.disposed = true
    this.unsubscribeSelection()
    this.unsubscribeCatalog()
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new Error('model selection is unavailable for addressed subagent sessions')
    }
  }

  private syncInputs(): void {
    if (this.disposed) return
    const catalog = this.catalog.store.getSnapshot()
    const projected = modelSelectionProjection(this.projected.getSnapshot())
    if (catalog.status !== 'ready' || catalog.value === null || projected === undefined) {
      if (this.resolved) {
        if (catalog.status === 'error') {
          this.store.update((state) => {
            state.status = 'error'
            state.error = catalog.error
          })
        }
        return
      }
      this.store.set({
        current: null,
        routable: null,
        groups: [],
        failures: [],
        status: catalog.status === 'error' ? 'error' : 'loading',
        error: catalog.error,
      })
      return
    }
    const current = projected.next ?? catalog.value.default
    this.resolved = true
    this.store.set({
      current,
      routable: catalog.value.routableProviders.includes(current.provider),
      groups: catalog.value.groups,
      failures: catalog.value.failures,
      status: this.store.getSnapshot().status === 'selecting'
        ? 'selecting'
        : 'ready',
      error: null,
    })
  }
}

function modelSelectionProjection(value: unknown): ModelSelectionProjection | undefined {
  return value === undefined ? undefined : value as ModelSelectionProjection
}
