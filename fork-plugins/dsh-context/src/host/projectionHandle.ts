import type { Context } from '@deepseek-ai/cordis'
import type { TimelineState } from './foldState'
import { asRecord } from './record'

export const TIMELINE_KEY = 'contextTimeline'

export const PRESSURE_KEYS = ['contextPressure', 'contextBreakdown'] as const

export type TimelineReader = (session: unknown) => TimelineState | undefined

export interface PressureViews {
  pressure?: unknown
  breakdown?: unknown
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

export function pressureViewsOf(ctx: Context, session: unknown): PressureViews {
  const registry = asRecord(ctx.sessionProjections)
  if (registry === null || typeof registry.snapshot !== 'function') return {}
  const snapshot = asRecord(registry.snapshot.call(registry, session, PRESSURE_KEYS))
  const values = asRecord(snapshot?.values)
  if (values === null) return {}
  return {
    ...(values.contextPressure === undefined ? {} : { pressure: values.contextPressure }),
    ...(values.contextBreakdown === undefined ? {} : { breakdown: values.contextBreakdown }),
  }
}
