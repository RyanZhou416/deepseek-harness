/**
 * Test-only shim restoring the pre-split history controller surface
 * (`page` / `follow`) over the split controllers the production composition
 * mounts.
 * @module dsh-api-session-controller/tests/history-test-controller
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { HistoryController } from '../src/history/controller.ts'
import { WebController } from '../src/web/controller.ts'
import type {
  SessionFollowFrame, SessionFollowRequest, SessionPage, SessionPageRequest,
} from '../src/types.ts'

/** Pre-split controller surface used by the focused history fixtures. */
export class SessionHistoryController {
  private readonly pages: HistoryController
  private readonly web: WebController

  /**
   * @param ctx - Host context owning Session reads and projections.
   * @param promote - background activation requested by a follow opening.
   * @param retain - keeps an addressed Agent resident through opening delivery.
   * @param maxPageBytes - serialized-record byte budget for one page; `0` disables the cap.
   */
  constructor(
    ctx: Context,
    promote: (observation: SessionObservation) => void,
    retain: (sessionId: SessionId) => () => void = () => () => {},
    maxPageBytes = 0,
  ) {
    this.pages = new HistoryController(ctx, maxPageBytes)
    this.web = new WebController(ctx, this.pages, promote, maxPageBytes, retain)
  }

  /**
   * Read one history page.
   * @param request - durable address and backwards-page cursor.
   * @param signal - caller cancellation.
   * @returns the contiguous event page.
   */
  async page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    const page = await this.pages.events(request, signal)
    // The legacy face predates the inclusive wire cut, so it reports only the page.
    return { records: page.records, hasMore: page.hasMore }
  }

  /**
   * Open one follow generation.
   * @param request - follow request.
   * @param signal - stream cancellation.
   * @returns the opening snapshot followed by uncovered increments.
   */
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    return this.web.follow(request, signal)
  }
}
