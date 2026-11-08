import type { Context } from '@deepseek-ai/cordis'
import type { TimelineState } from './foldState'
import { asRecord } from './record'

export const TIMELINE_KEY = 'contextTimeline'

/**
 * Detail projections an agent head carries. Summary-only control frames do not
 * deliver them for Sessions a client has not opened, so the agent tree reads
 * them through the head request instead.
 */
export const HEAD_VIEW_KEYS = ['contextPressure', 'contextBreakdown', 'tokenUsage'] as const

export type TimelineReader = (session: unknown) => TimelineState | undefined

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

export async function timelineReaderOf(ctx: Context, registration: unknown): Promise<TimelineReader | undefined> {
  const handle = asRecord(await registration)
  const stateOf = handle?.stateOf
  if (handle !== null && typeof stateOf === 'function') {
    return (session) => {
      const state: unknown = stateOf.call(handle, session)
      return state === undefined ? undefined : state as TimelineState
    }
  }
  return registryReaderOf(ctx)
}

export function registryReaderOf(ctx: Context): TimelineReader | undefined {
  const registry = asRecord(ctx.sessionProjections)
  const stateOf = registry?.stateOf
  if (registry === null || typeof stateOf !== 'function') return undefined
  return (session) => {
    const state: unknown = stateOf.call(registry, session, TIMELINE_KEY)
    return state === undefined ? undefined : state as TimelineState
  }
}

export function headViewsOf(ctx: Context, session: unknown): HeadViews {
  const registry = asRecord(ctx.sessionProjections)
  if (registry === null || typeof registry.snapshot !== 'function') return {}
  const snapshot = asRecord(registry.snapshot.call(registry, session, HEAD_VIEW_KEYS))
  return headViewsOfValues(asRecord(snapshot?.values))
}
