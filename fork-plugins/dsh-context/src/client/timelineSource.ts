import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ContextTimeline, ContextTimelineDetail } from '../shared/types'
import { DETAIL_ROUTE } from './apiRoutes'
import type { SessionStandardProps } from './services'
import { asRecord, collectionsOf, projectionOf, timelineOf } from './services'

export function detailOf(value: unknown): ContextTimelineDetail | null {
  const data = asRecord(value)
  if (data === null) return null
  if (typeof data.rev !== 'number' || !Number.isFinite(data.rev) || data.rev < 0) return null
  const head = timelineOf(data.head)
  const partial = asRecord(data.partial)
  const fromSeq = partial !== null && typeof partial.fromSeq === 'number' && Number.isFinite(partial.fromSeq)
    ? partial.fromSeq
    : undefined
  return {
    rev: data.rev,
    ...(head !== null ? { head } : {}),
    ...collectionsOf(data),
    ...(fromSeq === undefined ? {} : { partial: { fromSeq } }),
  }
}

export function makeDetailFetcher(
  sessionId: string,
  full = false,
): ((signal?: AbortSignal) => Promise<ContextTimelineDetail | null>) | undefined {
  if (sessionId === '') return undefined
  return async (signal?: AbortSignal) => {
    const response = await fetch(DETAIL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(full ? { sessionId, full: true } : { sessionId }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new Error(`dsh-context: detail route HTTP ${response.status}`)
    const r = asRecord(await response.json())
    if (r === null || r.ok !== true) throw new Error('dsh-context: detail read failed')
    if (r.value === null) return null
    const detail = detailOf(r.value)
    if (detail === null) throw new Error('dsh-context: detail read malformed')
    return detail
  }
}

export interface DetailSnap {
  detail: ContextTimelineDetail | null
  failed: boolean
  pending: boolean
  /** The payload covers only a bounded tail window of the durable log. */
  partial: boolean
  /** A whole-log upgrade is in flight. */
  fullPending: boolean
  /** The whole-log upgrade failed while a partial payload stays visible. */
  fullFailed: boolean
}

const EMPTY_SNAP: DetailSnap = { detail: null, failed: false, pending: false, partial: false, fullPending: false, fullFailed: false }

const DETAIL_DEBOUNCE_MS = 300

const EAGER_DELAY_MS = 16

const CATCH_UP_MS = 1_000

export class DetailStore {
  private detail: ContextTimelineDetail | null = null
  private acceptedRev = -1
  private wantedRev = -1
  private targetRev = -1
  private lastHeadRev = -1
  private generation = 0
  private failed = false
  private inFlight = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private parked = false
  private bytes = 0
  private background = false
  private catchUp: ReturnType<typeof setTimeout> | null = null
  private catchUpTarget = -1
  private controller: AbortController | null = null
  private fullController: AbortController | null = null
  private fullPending = false
  private fullFailed = false
  private readonly listeners = new Set<() => void>()
  private snap: DetailSnap = EMPTY_SNAP

  constructor(
    private readonly fetcher: ((signal?: AbortSignal) => Promise<ContextTimelineDetail | null>) | undefined,
    private readonly baseDelay: number = DETAIL_DEBOUNCE_MS,
    private readonly eagerFirst: boolean = false,
    private readonly fullFetcher?: (signal?: AbortSignal) => Promise<ContextTimelineDetail | null>,
  ) {}

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    if (this.parked) {
      this.parked = false
      if (this.detail === null) {
        this.resetLedger()
        this.failures = 0
      }
    }
    return () => {
      this.listeners.delete(fn)
      if (this.listeners.size === 0) this.park()
    }
  }

  readonly getSnapshot = (): DetailSnap => this.snap

  request(rev: number): void {
    this.background = false
    if (rev < this.lastHeadRev) this.resetLedger()
    if (rev >= this.lastHeadRev) {
      this.clearCatchUp()
      this.catchUpTarget = -1
    }
    this.lastHeadRev = rev
    if (rev <= this.acceptedRev || rev <= this.wantedRev) return
    this.wantedRev = rev
    this.schedule()
  }

  warm(rev = 0): void {
    this.background = this.listeners.size === 0
    if (rev > this.lastHeadRev) this.lastHeadRev = rev
    if (rev > this.wantedRev) this.wantedRev = rev
    if (this.inFlight) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.parked = false
    if (this.detail === null || rev > this.acceptedRev) void this.fire()
  }

  get byteSize(): number {
    return this.bytes
  }

  readonly retry = (): void => {
    this.background = false
    this.failures = 0
    if (this.detail !== null) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.inFlight) void this.fire()
  }

  private resetLedger(): void {
    this.clearCatchUp()
    this.catchUpTarget = -1
    this.controller?.abort()
    this.controller = null
    this.fullController?.abort()
    this.fullController = null
    this.fullPending = false
    this.fullFailed = false
    this.generation++
    this.acceptedRev = -1
    this.wantedRev = -1
    this.detail = null
    this.bytes = 0
    this.failed = false
    this.snap = EMPTY_SNAP
  }

  get active(): boolean {
    return this.listeners.size > 0
  }

  get hasPayload(): boolean {
    return this.detail !== null
  }

  release(): void {
    this.clearCatchUp()
    this.catchUpTarget = -1
    this.controller?.abort()
    this.controller = null
    this.fullController?.abort()
    this.fullController = null
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.resetLedger()
    this.failures = 0
  }

  private park(): void {
    this.parked = true
    this.clearCatchUp()
    this.controller?.abort()
    this.fullController?.abort()
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.emit()
  }

  private clearCatchUp(): void {
    if (this.catchUp !== null) {
      clearTimeout(this.catchUp)
      this.catchUp = null
    }
  }

  private schedule(): void {
    if (this.parked || this.timer !== null) return
    if (this.eagerFirst && this.detail === null && !this.failed) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.fire()
      }, EAGER_DELAY_MS)
      this.emit()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.fire()
    }, this.baseDelay * 2 ** Math.min(this.failures, 3))
    this.emit()
  }

  private async fire(): Promise<void> {
    if (this.inFlight) return
    if (this.fetcher === undefined) {
      this.failed = true
      this.emit()
      return
    }
    this.inFlight = true
    this.targetRev = this.wantedRev
    const background = this.background
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    this.emit()
    try {
      const d = await this.fetcher(controller.signal)
      if (generation !== this.generation) return
      if (d !== null) {
        const partial = d.partial !== undefined
        const downgrade = partial && this.detail !== null && this.detail.partial === undefined && d.rev <= this.acceptedRev
        if (!downgrade && (d.rev >= this.acceptedRev || d.rev === this.targetRev)) {
          this.detail = d
          this.bytes = detailBytesOf(d)
          this.acceptedRev = d.rev
        }
        if (d.rev >= this.acceptedRev && d.rev < this.targetRev) {
          this.wantedRev = d.rev
          if (this.listeners.size > 0 && this.catchUpTarget !== this.targetRev) {
            this.catchUpTarget = this.targetRev
            this.clearCatchUp()
            const target = this.targetRev
            this.catchUp = setTimeout(() => {
              this.catchUp = null
              if (this.detail === null || this.acceptedRev < target) {
                this.wantedRev = target
                void this.fire()
              }
            }, CATCH_UP_MS)
          }
        }
        this.failures = 0
        this.failed = false
      } else {
        this.wantedRev = this.acceptedRev
        this.failed = this.detail === null
        this.failures++
      }
    } catch {
      if (generation === this.generation && !controller.signal.aborted) {
        this.failed = this.detail === null
        this.failures++
      }
    } finally {
      if (this.controller === controller) this.controller = null
      this.inFlight = false
      if (this.failed && background && this.listeners.size === 0) this.wantedRev = this.acceptedRev
      if (this.wantedRev > this.acceptedRev && (this.listeners.size > 0 || !background)) this.schedule()
      this.emit()
    }
  }

  readonly loadFull = (): void => {
    void this.fireFull()
  }

  /** Replace the bounded-tail payload with the whole-log one on explicit request. */
  private async fireFull(): Promise<void> {
    if (this.fullFetcher === undefined || this.fullPending) return
    this.fullPending = true
    this.fullFailed = false
    const generation = this.generation
    const controller = new AbortController()
    this.fullController = controller
    this.emit()
    try {
      const d = await this.fullFetcher(controller.signal)
      if (generation !== this.generation) return
      if (d !== null) {
        this.detail = d
        this.bytes = detailBytesOf(d)
        this.acceptedRev = Math.max(this.acceptedRev, d.rev)
        this.failed = false
        this.failures = 0
      } else {
        this.fullFailed = true
      }
    } catch {
      if (generation === this.generation && !controller.signal.aborted) this.fullFailed = true
    } finally {
      if (this.fullController === controller) this.fullController = null
      this.fullPending = false
      this.emit()
    }
  }

  private emit(): void {
    const pending = this.timer !== null || this.inFlight
    const next: DetailSnap = {
      detail: this.detail,
      failed: this.failed,
      pending,
      partial: this.detail !== null && this.detail.partial !== undefined,
      fullPending: this.fullPending,
      fullFailed: this.fullFailed,
    }
    if (next.detail === this.snap.detail
      && next.failed === this.snap.failed
      && next.pending === this.snap.pending
      && next.partial === this.snap.partial
      && next.fullPending === this.snap.fullPending
      && next.fullFailed === this.snap.fullFailed) return
    this.snap = next
    for (const fn of this.listeners) fn()
  }
}

const DETAIL_STORES_MAX = 8

const DETAIL_BYTES_MAX = 6 * 1024 * 1024

export function detailBytesOf(detail: ContextTimelineDetail): number {
  return 2048
    + detail.requests.length * 180
    + detail.events.length * 120
    + detail.nodes.length * 160
    + detail.archive.length * 160
    + (detail.fileOps?.length ?? 0) * 220
    + (detail.commands?.length ?? 0) * 420
    + (detail.spans?.length ?? 0) * 60
}

const DETAIL_STORE_ENTRIES_MAX = 64

const stores = new Map<string, DetailStore>()

function payloadHolders(): number {
  let held = 0
  for (const store of stores.values()) if (store.hasPayload) held++
  return held
}

function payloadBytes(): number {
  let bytes = 0
  for (const store of stores.values()) bytes += store.byteSize
  return bytes
}

export function detailStoreOf(sessionId: string): DetailStore {
  const known = stores.get(sessionId)
  const store = known ?? new DetailStore(makeDetailFetcher(sessionId), DETAIL_DEBOUNCE_MS, true, makeDetailFetcher(sessionId, true))
  if (known !== undefined) stores.delete(sessionId)
  stores.set(sessionId, store)
  let excess = payloadHolders() - DETAIL_STORES_MAX + (store.hasPayload ? 0 : 1)
  let bytes = payloadBytes()
  for (const candidate of stores.values()) {
    if (excess <= 0 && bytes <= DETAIL_BYTES_MAX) break
    if (candidate === store || candidate.active || !candidate.hasPayload) continue
    bytes -= candidate.byteSize
    candidate.release()
    excess--
  }
  if (stores.size > DETAIL_STORE_ENTRIES_MAX) {
    for (const id of stores.keys()) {
      if (stores.size <= DETAIL_STORE_ENTRIES_MAX) break
      if (id === sessionId) continue
      const candidate = stores.get(id)
      if (candidate === undefined || candidate.active) continue
      stores.delete(id)
    }
  }
  return store
}

export function resetTimelineDetailStores(): void {
  stores.clear()
}

export type DetailState = 'legacy' | 'loading' | 'ready' | 'failed'

export interface TimelineSource {
  data: ContextTimeline | null
  detailState: DetailState
  retryDetail: () => void
  /** The payload covers only a bounded tail window of the durable log. */
  partial: boolean
  /** Fetch the whole-log detail and replace the bounded-tail payload. */
  loadFullDetail: () => void
  fullPending: boolean
  fullFailed: boolean
}

const noopSubscribe = (): (() => void) => () => {}
const noopRetry = (): void => {}
const noopLoadFull = (): void => {}

export function useTimelineSource(props: SessionStandardProps): TimelineSource {
  const head = projectionOf(props, 'contextTimeline', timelineOf)
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  const headRev = head !== null && typeof head.detailRev === 'number' ? head.detailRev : null
  const slim = headRev !== null
  const cold = head === null
  const store = useMemo(
    () => (sessionId !== '' && (slim || cold) ? detailStoreOf(sessionId) : null),
    [sessionId, slim, cold],
  )
  const snap = useSyncExternalStore(
    store !== null ? store.subscribe : noopSubscribe,
    store !== null ? store.getSnapshot : () => EMPTY_SNAP,
  )
  useEffect(() => {
    if (store !== null) store.request(headRev ?? 0)
  }, [store, headRev])

  return useMemo<TimelineSource>(() => {
    const detail = snap.detail
    const retry = store !== null ? store.retry : noopRetry
    const partial = snap.partial
    const loadFullDetail = store !== null ? store.loadFull : noopLoadFull
    const fullPending = snap.fullPending
    const fullFailed = snap.fullFailed
    if (head !== null && !slim) return { data: head, detailState: 'legacy', retryDetail: noopRetry, partial: false, loadFullDetail: noopLoadFull, fullPending: false, fullFailed: false }
    const base = head !== null ? head : detail !== null ? detail.head ?? null : null
    if (base === null) {
      const failed = store !== null && (snap.failed || detail !== null)
      return { data: null, detailState: failed ? 'failed' : 'loading', retryDetail: retry, partial, loadFullDetail, fullPending, fullFailed }
    }
    if (detail === null) {
      return { data: base, detailState: snap.failed ? 'failed' : 'loading', retryDetail: retry, partial, loadFullDetail, fullPending, fullFailed }
    }
    const data: ContextTimeline = {
      ...base,
      requests: detail.requests,
      events: detail.events,
      nodes: detail.nodes,
      droppedNodes: detail.droppedNodes,
      archive: detail.archive,
      ...(detail.surfaceFloor !== undefined ? { surfaceFloor: detail.surfaceFloor } : {}),
      ...(detail.archiveFloor !== undefined ? { archiveFloor: detail.archiveFloor } : {}),
      ...(detail.fileOps !== undefined ? { fileOps: detail.fileOps } : {}),
      ...(detail.fileOpsFloor !== undefined ? { fileOpsFloor: detail.fileOpsFloor } : {}),
      ...(detail.commands !== undefined ? { commands: detail.commands } : {}),
      ...(detail.commandsFloor !== undefined ? { commandsFloor: detail.commandsFloor } : {}),
      ...(detail.commandStats !== undefined ? { commandStats: detail.commandStats } : {}),
      ...(detail.spans !== undefined ? { spans: detail.spans } : {}),
    }
    return { data, detailState: 'ready', retryDetail: retry, partial, loadFullDetail, fullPending, fullFailed }
  }, [head, slim, store, snap])
}
