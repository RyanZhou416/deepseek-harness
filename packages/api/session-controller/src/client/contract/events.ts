/** Observable contiguous Session event window consumed by domain assemblers. */
import { notifySubscribers, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { LlmAttemptId, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** Client-only live chunk presentation; `seq` orders the transient row between durable Session seqs. */
export interface AssistantLiveChunkEvent {
  readonly type: 'assistant/live-chunk'
  readonly seq: number
  readonly time: number
  readonly data: {
    readonly attemptId: LlmAttemptId
    readonly turn: number
    readonly step: number
    readonly chunk: StreamChunk
  }
}

/** Current durable Session event or one client-only live chunk presentation. */
export type SessionEventLike = SessionEvent | AssistantLiveChunkEvent

/** Client history entry retaining its coarse transport discriminator. */
export type SessionEventLikeEntry =
  | { readonly type: 'event'; readonly event: SessionEvent }
  | { readonly type: 'transient'; readonly event: AssistantLiveChunkEvent }

/** Scalar live entry accepted by append-only Client paths. */
export type SessionLiveEventEntry = Extract<SessionEventLikeEntry, { readonly type: 'event' }>
/** Durable Assistant event that atomically supersedes one attempt's transient rows. */
export interface SessionAssistantSettlementEntry {
  readonly type: 'event'
  readonly event: SessionEvent<'assistant/message'> | SessionEvent<'assistant/attempt'>
}
/** Client-only Assistant frame admitted outside durable cursor algebra. */
export type SessionTransientEventEntry = Extract<SessionEventLikeEntry, { readonly type: 'transient' }>

interface EventWindowLeaf {
  readonly kind: 'leaf'
  readonly entries: readonly SessionEventLikeEntry[]
  readonly length: number
}

interface EventWindowConcat {
  readonly kind: 'concat'
  readonly left: EventWindowNode
  readonly right: EventWindowNode
  readonly length: number
}

type EventWindowNode = EventWindowLeaf | EventWindowConcat

function leaf(entries: readonly SessionEventLikeEntry[]): EventWindowLeaf {
  return { kind: 'leaf', entries, length: entries.length }
}

function concat(left: EventWindowNode, right: EventWindowNode): EventWindowConcat {
  return { kind: 'concat', left, right, length: left.length + right.length }
}

function materialize(node: EventWindowNode): readonly SessionEventLikeEntry[] {
  if (node.kind === 'leaf') return node.entries
  const entries = new Array<SessionEventLikeEntry>(node.length)
  const pending: EventWindowNode[] = [node]
  let index = 0
  while (pending.length > 0) {
    const current = pending.pop() as EventWindowNode
    if (current.kind === 'concat') {
      pending.push(current.right, current.left)
      continue
    }
    for (const entry of current.entries) {
      entries[index] = entry
      index += 1
    }
  }
  return entries
}

function windowSnapshot(
  node: EventWindowNode,
  hasMore: boolean,
  revision: number,
  change: SessionEventChange,
): SessionEventWindow {
  let entries: readonly SessionEventLikeEntry[] | undefined
  return {
    get entries() {
      entries ??= materialize(node)
      return entries
    },
    hasMore,
    revision,
    change,
  }
}

/** @param entries - published entries in order. @param seq - target sequence. @returns the first index holding a later sequence. */
function insertionIndex(entries: readonly SessionEventLikeEntry[], seq: number): number {
  const index = entries.findIndex(candidate => candidate.event.seq > seq)
  return index < 0 ? entries.length : index
}

/** Exact delta that produced the latest event-window revision. */
export type SessionEventChange =
  | { readonly kind: 'replace'; readonly entries: readonly SessionEventLikeEntry[] }
  | { readonly kind: 'prepend'; readonly entries: readonly SessionEventLikeEntry[] }
  | { readonly kind: 'append'; readonly entries: readonly SessionEventLikeEntry[] }
  | {
    readonly kind: 'insert-assistant'
    readonly entry: SessionAssistantSettlementEntry
  }
  | {
    readonly kind: 'settle-assistant'
    readonly attemptId: LlmAttemptId
    readonly entry?: SessionAssistantSettlementEntry
  }

/** Current contiguous event window and its latest synchronous delta. */
export interface SessionEventWindow {
  readonly entries: readonly SessionEventLikeEntry[]
  readonly hasMore: boolean
  readonly revision: number
  readonly change: SessionEventChange
}

/** Conversation-facing event source exposed by one Session binding. */
export type SessionEventSource = ObservableSnapshot<SessionEventWindow>

/** Session-owned event feed; every accepted window mutation publishes synchronously. */
export class MutableSessionEventSource implements SessionEventSource {
  private readonly listeners = new Set<() => void>()
  private window: EventWindowNode = leaf([])
  /** Highest sequence published in this window generation, including transient rows. */
  private maxPublishedSeq = -1
  private snapshot: SessionEventWindow = windowSnapshot(
    this.window,
    false,
    0,
    { kind: 'replace', entries: [] },
  )

  /** @returns the cached event-window snapshot. */
  getSnapshot(): SessionEventWindow { return this.snapshot }

  /**
   * Subscribe to synchronous window publication.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Replace the complete contiguous window.
   * @param entries - complete window.
   * @param hasMore - whether older history remains.
   */
  replace(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    this.window = leaf(entries)
    this.maxPublishedSeq = entries.reduce(
      (highest, entry) => Math.max(highest, entry.event.seq),
      -1,
    )
    this.publish(hasMore, { kind: 'replace', entries })
  }

  /**
   * Prepend one older contiguous page.
   * @param entries - newly loaded older entries.
   * @param hasMore - whether still older history remains.
   */
  prepend(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    this.window = concat(leaf(entries), this.window)
    this.maxPublishedSeq = Math.max(this.maxPublishedSeq, entries.at(-1)?.event.seq ?? -1)
    this.publish(hasMore, { kind: 'prepend', entries })
  }

  /**
   * Append one contiguous live entry.
   * @param entry - live tail entry.
   */
  append(entry: SessionEventLikeEntry): void {
    const entries = [entry]
    this.window = concat(this.window, leaf(entries))
    this.maxPublishedSeq = Math.max(this.maxPublishedSeq, entry.event.seq)
    this.publish(this.snapshot.hasMore, {
      kind: 'append',
      entries,
    })
  }

  /**
   * Commit one durable Assistant settlement at its published sequence position,
   * retaining that attempt's transient rows. A sequence above the published
   * high-water mark appends; an already published or earlier sequence is
   * inserted in order, so a delayed settlement cannot append backwards.
   * @param entry - durable settlement committed for a held attempt.
   */
  commitAssistant(entry: SessionAssistantSettlementEntry): void {
    if (entry.event.seq > this.maxPublishedSeq) {
      this.append(entry)
      return
    }
    // materialize may return the leaf array an earlier snapshot still exposes.
    const entries = [...materialize(this.window)]
    if (!this.insertOrdered(entries, entry)) return
    this.window = leaf(entries)
    this.publish(this.snapshot.hasMore, { kind: 'insert-assistant', entry })
  }

  /**
   * Replace one attempt's transient rows with its committed durable settlement.
   * A call that removes no transient row and inserts nothing is a no-op: the
   * published window and its revision stay untouched.
   * @param attemptId - process-local attempt whose live rows are now redundant.
   * @param entry - durable settlement committed for that attempt.
   */
  settleAssistant(attemptId: LlmAttemptId, entry?: SessionAssistantSettlementEntry): void {
    const entries = materialize(this.window).filter(candidate => (
      candidate.type !== 'transient' || candidate.event.data.attemptId !== attemptId
    ))
    const removed = entries.length < this.window.length
    const inserted = entry !== undefined && this.insertOrdered(entries, entry)
    if (!removed && !inserted) return
    this.window = leaf(entries)
    this.publish(this.snapshot.hasMore, {
      kind: 'settle-assistant',
      attemptId,
      ...(entry === undefined ? {} : { entry }),
    })
  }

  /**
   * Insert one settlement in sequence order, publishing nothing for an
   * identical duplicate and rejecting a different entry that already owns the
   * sequence before any mutation.
   * @param entries - mutable window entries being rebuilt.
   * @param entry - durable settlement to insert.
   * @returns whether the window gained an entry.
   */
  private insertOrdered(
    entries: SessionEventLikeEntry[],
    entry: SessionAssistantSettlementEntry,
  ): boolean {
    const index = entries.findIndex(candidate => candidate.event.seq === entry.event.seq)
    if (index >= 0) {
      if (entries[index]?.event === entry.event) return false
      throw new Error(`event window already holds a different entry at seq ${entry.event.seq}`)
    }
    entries.splice(insertionIndex(entries, entry.event.seq), 0, entry)
    this.maxPublishedSeq = Math.max(this.maxPublishedSeq, entry.event.seq)
    return true
  }

  private publish(
    hasMore: boolean,
    change: SessionEventChange,
  ): void {
    this.snapshot = windowSnapshot(this.window, hasMore, this.snapshot.revision + 1, change)
    notifySubscribers(this.listeners, '[session-controller] event feed')
  }
}
