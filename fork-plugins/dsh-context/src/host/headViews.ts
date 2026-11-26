// DeepSeek Harness fork modification: agent heads carry detail views.
// See ../../FORK_MAINTENANCE.md.
import type { Context } from '@deepseek-ai/cordis'
import { asRecord } from './record'

/**
 * Detail projections an agent head carries. The Session control stream carries
 * only summary keys, and these units are summary-excluded, so a head read is
 * the only source for a Session this client has not opened.
 */
export const HEAD_VIEW_KEYS = ['contextPressure', 'contextBreakdown', 'tokenUsage'] as const

export interface HeadViews {
  pressure?: unknown
  breakdown?: unknown
  usage?: unknown
}

/** The head fields of one projection value map. */
export function headViewsOfValues(values: Record<string, unknown> | null): HeadViews {
  if (values === null) return {}
  return {
    ...(values.contextPressure === undefined ? {} : { pressure: values.contextPressure }),
    ...(values.contextBreakdown === undefined ? {} : { breakdown: values.contextBreakdown }),
    ...(values.tokenUsage === undefined ? {} : { usage: values.tokenUsage }),
  }
}

/** The head views of one live Session, read from the registry without a log read. */
export function headViewsOf(ctx: Context, session: unknown): HeadViews {
  const registry = asRecord(ctx.sessionProjections)
  if (registry === null || typeof registry.snapshot !== 'function') return {}
  try {
    const snapshot = asRecord(registry.snapshot.call(registry, session, HEAD_VIEW_KEYS))
    return headViewsOfValues(asRecord(snapshot?.values))
  } catch {
    return {}
  }
}
