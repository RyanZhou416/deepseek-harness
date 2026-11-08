/**
 * Live Session summary projections with reconnect baselines. The stream
 * carries the same keys as Session list summaries; detail keys travel only on
 * the follow streams of clients that opened the Session.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import type {
  Session, SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type {
  SessionControlBaseline,
  SessionControlFrame,
  SessionProjectionBaseline,
  SessionProjectionUpdate,
  SessionProjectionValues,
} from './types.ts'

/** Owns the Host-wide Session control stream. */
export class SessionControlController {
  private readonly streams = new Set<ControlQueue>()
  private summaryKeySource: ReadonlySet<string> | undefined
  private summaryKeySet: ReadonlySet<string> = new Set()

  /**
   * @param ctx - Host context carrying live Agent and projection services.
   * @param excludedKeys - deployment-selected keys that Session summaries omit (`listProjectionExcludeKeys`).
   */
  constructor(private readonly ctx: Context, private readonly excludedKeys: ReadonlySet<string> = new Set()) {
    ctx.sessionProjections.onEventChanged((session, changes, seq) => {
      if (this.streams.size === 0) return
      const keys = this.summaryKeys()
      const summary = changes.filter(change => keys.has(change.key))
      if (summary.length === 0) return
      this.broadcast({
        type: 'projection',
        sessionId: session.id,
        seq,
        // Every projection definition validates its value before change publication.
        changes: summary as SessionProjectionUpdate['changes'],
      })
    })
    ctx.effect(() => () => {
      for (const stream of this.streams) stream.end()
      this.streams.clear()
    }, 'session-controller.control')
  }

  /**
   * Open one generation of Host-wide live control state.
   * @param signal - Remote stream cancellation.
   * @returns one complete baseline followed by live replacement frames.
   */
  async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    signal.throwIfAborted()
    const queue = new ControlQueue()
    this.streams.add(queue)
    try {
      yield { type: 'baseline', value: this.baseline() }
      yield* queue.iterate(signal)
    } finally {
      this.streams.delete(queue)
      queue.end()
    }
  }

  private baseline(): SessionControlBaseline {
    const sessions = this.ctx.sessions.list()
    return {
      projections: this.projectionBaseline(sessions),
    }
  }

  private projectionBaseline(
    sessions: readonly Session[],
  ): Readonly<Record<SessionId, SessionProjectionBaseline>> {
    const blocks = Object.create(null) as Record<SessionId, SessionProjectionBaseline>
    const keys = this.summaryKeys() as ReadonlySet<Extract<keyof SessionProjectionMap, string>>
    for (const session of sessions) {
      const snapshot = this.ctx.sessionProjections.snapshot(session, keys)
      blocks[session.id] = {
        asOfSeq: snapshot.asOfSeq,
        // Every projection definition validates its value before snapshot publication.
        values: snapshot.values as SessionProjectionValues,
      }
    }
    return blocks
  }

  /** Live summary keys minus the deployment exclusions, rebuilt only when the registry's key table changes. */
  private summaryKeys(): ReadonlySet<string> {
    const source = this.ctx.sessionProjections.summaryKeys()
    if (source !== this.summaryKeySource) {
      this.summaryKeySource = source
      const live = this.ctx.sessionProjections.liveKeys()
      this.summaryKeySet = new Set([...source].filter(key => live.has(key) && !this.excludedKeys.has(key)))
    }
    return this.summaryKeySet
  }

  private broadcast(frame: SessionControlFrame): void {
    for (const stream of this.streams) stream.push(frame)
  }
}

class ControlQueue {
  private readonly buffer = new Deque<SessionControlFrame>()
  private wake: (() => void) | undefined
  private done = false

  push(frame: SessionControlFrame): void {
    if (this.done) return
    this.buffer.pushBack(frame)
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  end(): void {
    if (this.done) return
    this.done = true
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  async *iterate(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!this.done && !signal.aborted) {
        const frame = this.buffer.popFront()
        if (frame !== undefined) {
          yield frame
          continue
        }
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
      while (this.buffer.size > 0 && !signal.aborted) yield this.buffer.popFront() as SessionControlFrame
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.end()
    }
  }
}
