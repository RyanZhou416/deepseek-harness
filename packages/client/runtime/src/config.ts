/** Default raw-event count that requests a settled tail-window rebase. */
export const DEFAULT_LIVE_WINDOW_REBASE_EVENT_THRESHOLD = 20_000

/** Browser Session window residency configuration. */
export interface Config {
  /**
   * Re-request the settled tail history after a finalized Assistant message
   * leaves at least this many raw events resident. The active model phase is
   * never truncated; its chunks remain until `assistant/message` arrives.
   */
  liveWindowRebaseEventThreshold?: number
}
