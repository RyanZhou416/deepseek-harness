/** Web opening aggregation over one observation and a shared transforming buffer. */

import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset, SessionSeq, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import type { HistoryController } from '../history/controller.ts'
import {
  addressId, isSmallStoredSource, paginateSlice, pageRecords, projectionBlock, readStoredWindow, rejectNotFound,
  tailTurnSettled, validateWindow, windowReadBounds, windowSessionId, wireHeader,
} from '../history.ts'
import { EventListener, ListenerBuffer, ProjectionListener } from '../history/listener.ts'
import { history, projections, resolveHistoryRequest, validateObservationAddress } from '../history/controller.ts'
import type { SessionFollowFrame, SessionFollowRequest, SessionPageRequest } from '../types.ts'

/** Combines opening data and consumes transformed listener output from one queue. */
export class WebController {

  /**
   * @param ctx - Host context carrying Session queries and identity projections.
   * @param historyController - passive reading and listener construction.
   * @param promote - background activation requested before an opening snapshot is delivered.
   * @param maxPageBytes - serialized-record byte budget for the opening page; `0` keeps the message limits alone.
   * @param retain - keeps the addressed Agent resident through opening delivery; returns its release.
   */
  constructor(
    private readonly ctx: Context,
    private readonly historyController: HistoryController,
    private readonly promote: (observation: SessionObservation) => void,
    private readonly maxPageBytes = 0,
    private readonly retain: (sessionId: SessionId) => () => void = () => () => {},
  ) {}

  /**
   * Open a history snapshot and follow uncovered history, assistant notifications, and opted-in projection changes.
   * @param request - Session identity, page budget, assistant output, projection changes and optional activation (default false).
   * @param signal - cancellation for opening and streaming.
   * @returns an opening snapshot followed by uncovered queued increments.
   */
  async *follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    const sessionId = addressId(request.address)
    const spec = resolveHistoryRequest(request)
    // A follower pin only covers opening delivery: an empty idle Session must be
    // evictable again once the snapshot has been handed to the consumer.
    const releaseOpeningRetention = this.retain(sessionId)
    let openingDelivered = false
    const releaseRetention = (): void => {
      if (openingDelivered) return
      openingDelivered = true
      releaseOpeningRetention()
    }
    using queue = new ListenerBuffer<SessionFollowFrame>(this.ctx, signal)
    using listener = new EventListener(this.ctx, sessionId, signal, queue)
    const streams = this.historyController.streamsListener
    using assistantListener = request.assistantStream === true
      ? streams.bind(sessionId, signal, queue)
      : undefined
    // Changes are applied under the client's per-key seq rule, so a change at or
    // before the opening cut needs no filtering here.
    using _projectionListener = request.projectionChanges === true
      ? new ProjectionListener(this.ctx, sessionId, signal, queue)
      : undefined
    let observation: SessionObservation | undefined
    let opening = await this.openWindow(request, spec, signal)
    if (opening === undefined) {
      observation = await this.historyController.usingObservation({ sessionId, projection: true }, signal)
        .catch((error: unknown) => {
          if (remoteErrorOf(error)?.code === 'session/not-found') rejectNotFound(request.address)
          throw error
        })
      validateObservationAddress(request.address, observation)
      opening = {
        type: 'snapshot',
        header: { ...observation.header },
        // An observation without a projection cut carries no exact block; an empty
        // block would claim whole-log emptiness and clear cached client values.
        ...observation.projections === undefined ? {} : { projections: projections(observation) },
        ...history(observation, spec, this.maxPageBytes),
      }
    }
    listener.setCursor(opening.cursor)
    if (assistantListener !== undefined) {
      const { baseline: assistantStream, ordinal } = assistantListener.snapshot()
      opening = { ...opening, assistantStream }
      assistantListener.setOrdinalCut(ordinal)
    }
    // Increments come from the queue, so the opening ends this lease in every branch;
    // activation continues on its own retained lease. Promotion starts before the opening is
    // delivered, so a consumer that stops after the snapshot still gets the activation it asked for.
    // A window-first opening materializes no prepared Session, so it never promotes.
    if (observation !== undefined) {
      if (request.activate === true && !signal.aborted
        && observation.header.origin !== 'subagent' && observation.source === 'prepared') {
        const promotion = observation.retain()
        observation[Symbol.dispose]()
        try {
          this.promote(promotion)
        } catch (error: unknown) {
          promotion[Symbol.dispose]()
          throw error
        }
      } else {
        observation[Symbol.dispose]()
      }
    }
    try {
      yield opening
    } finally {
      releaseRetention()
    }
    yield* queue.items()
  }

  /**
   * Build the opening frame from one bounded stored window when the Session is
   * not live and persistence can serve it.
   *
   * A window without a complete projection checkpoint still opens: the frame
   * omits its projection block instead of inventing an empty exact cut, which
   * would clear the client's cached values. Only parent Session addresses use
   * this path; subagent addresses stay on the complete observation because the
   * `subagent` projection is part of address validation. No prepared historical
   * Session is materialized here. A configured byte budget grows the requested
   * row bound from 256 events until the page is decided and the window still
   * shows the log's final Turn boundary.
   * @param request - follow request and caller history limits.
   * @param spec - validated history limits.
   * @param signal - stream cancellation.
   * @returns the opening frame, or undefined to use the exact source.
   */
  private async openWindow(
    request: SessionFollowRequest,
    spec: SessionPageRequest & { readonly maxMessages: number },
    signal: AbortSignal,
  ): Promise<Extract<SessionFollowFrame, { readonly type: 'snapshot' }> | undefined> {
    const sessionId = windowSessionId(this.ctx, request.address)
    if (sessionId === undefined || await isSmallStoredSource(this.ctx, sessionId, signal)) return undefined
    const bounds = windowReadBounds(spec, this.maxPageBytes)
    for (const [index, maxEvents] of bounds.entries()) {
      signal.throwIfAborted()
      const read = await readStoredWindow(this.ctx, sessionId, { signal, maxEvents })
      if (read === undefined) return undefined
      validateWindow(request.address, read.window, read.projections)
      const windowEvents = read.window.events
      const windowBase = SessionLogOffset(windowEvents[0]?.seq ?? read.window.cursor + 1)
      // A window that omits the log's final Turn boundary cannot tell an
      // interrupted Turn from one whose start lies below it, so its synthetic
      // closers would differ from the complete observation. Grow until the
      // boundary is inside the window, and keep the bounded window's answer at
      // the last bound.
      if (index < bounds.length - 1 && !tailTurnSettled(windowEvents, windowBase)) continue
      // The complete observation balances an interrupted final turn with in-memory
      // closers; a tail window must present the same transcript shape.
      const events = [...windowEvents, ...interruptedTurnClosers(windowEvents)]
      const cursor = SessionSeq(events.at(-1)?.seq ?? -1)
      const page = paginateSlice(
        events,
        windowBase,
        SessionLogOffset(cursor + 1),
        spec.maxMessages,
        spec.turnWindow,
        this.maxPageBytes,
      )
      if (page === undefined) continue
      return {
        type: 'snapshot',
        header: wireHeader(read.window.header),
        cursor,
        records: pageRecords(page.events),
        hasMore: page.hasMore,
        ...read.projections === undefined ? {} : { projections: projectionBlock(read.projections) },
      }
    }
    return undefined
  }
}
