/**
 * The `contextActivity` session projection unit — the per-day activity
 * ledger behind the Context Dashboard's heatmap.
 *
 * The timeline unit (fold.ts) is a "current snapshot" fold: it prices the
 * context as it stands NOW, which cannot draw a per-day chart. This unit
 * folds the same committed event stream into a ledger keyed by local
 * calendar day (shared/days.ts): every assistant settlement adds one
 * completed request to its day and, when the provider reported a usage
 * object, the day's billed-token figure grows by the disjoint buckets
 * (uncached input + cache read + cache write + output — the same semantics
 * the timeline's request records and the official token meter use). The
 * overview merges every listed session's ledger off the session list's
 * projection column (no per-session open needed) and colors its heatmap.
 *
 * One wire contract, one small state: a day entry is two integers and the
 * retention cap keeps at most {@link MAX_KEPT_DAYS} keys, so the value
 * riding every session-list row stays trivial next to the timeline head.
 * Same projection contract as the sibling units: pure init/apply/view,
 * unknown or malformed events return the state unchanged, and no
 * `undefined`-valued property ever materializes (the plain-JSON persisted-
 * state precondition).
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from './compat'
import { tokenCountOf, type UsageLike } from './fold'
import { dayKeyOf } from '../shared/days'
import type { ContextActivity } from '../shared/types'

/**
 * Retention cap on ledger days. A little over a year of daily-active
 * sessions; the oldest keys drop first (key order IS chronological order).
 */
const MAX_KEPT_DAYS = 400

/** The persisted fold state (the registry's `stateSchema` contract). */
export interface ActivityState {
  days: Record<string, { tokens: number; requests: number }>
}

const activityDaySchema = z.object({
  tokens: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
}).strict()

/** Validate the wire payload before it leaves the host (strict: no drift). */
export const contextActivitySchema = z.object({
  days: z.record(z.string(), activityDaySchema),
}).strict() as unknown as z.ZodType<ContextActivity>

/** The persisted fold-state schema — identical shape, validated before a checkpoint row seeds a fold. */
const activityStateSchema = z.object({
  days: z.record(z.string(), activityDaySchema),
}) as unknown as z.ZodType<ActivityState>

/**
 * The day's billed increment from one durable usage object: the four
 * disjoint buckets summed after the shared per-bucket sanitizer
 * ({@link tokenCountOf} — fractions round, negatives clamp, garbage reads
 * absent). A usage object with NO readable bucket contributes nothing, so a
 * settlement that carried no usage still counts its request without
 * fabricating tokens.
 */
function billedOfUsage(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0
  const usage = value as UsageLike
  let any = false
  let total = 0
  for (const bucket of [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens]) {
    const count = tokenCountOf(bucket)
    if (count !== null) {
      total += count
      any = true
    }
  }
  return any ? total : 0
}

/**
 * Fold one committed event into the ledger. Only `assistant/message` (the
 * step settlement — both supported log generations) advances a day; every
 * other type returns the state reference unchanged, as does a settlement
 * with an unreadable time. The next state is a copy along the mutated path
 * only — the persisted previous state is never mutated in place.
 */
export function applyActivity(state: ActivityState, event: SessionEvent): ActivityState {
  if (event.type !== 'assistant/message') return state
  const key = dayKeyOf(event.time)
  if (key === null) return state
  const data = event.data as { usage?: unknown } | undefined
  const tokens = billedOfUsage(data?.usage)
  // A Record index read CAN miss at runtime (no noUncheckedIndexedAccess
  // here), so the value type is widened honestly before the read.
  const byKey: Record<string, { tokens: number; requests: number } | undefined> = state.days
  const prev = byKey[key]
  const entry = {
    tokens: (prev === undefined ? tokens : prev.tokens + tokens),
    requests: (prev === undefined ? 1 : prev.requests + 1),
  }
  let days = { ...state.days, [key]: entry }
  const keys = Object.keys(days)
  if (keys.length > MAX_KEPT_DAYS) {
    keys.sort()
    // Rebuild over the kept suffix (key order IS chronological) — a dynamic
    // `delete` per evicted key would deopt the record into dictionary mode.
    const drop = new Set(keys.slice(0, keys.length - MAX_KEPT_DAYS))
    days = Object.fromEntries(Object.entries(days).filter(([k]) => !drop.has(k)))
  }
  return { days }
}

/**
 * The daily-activity projection unit, registered alongside the timeline and
 * headers units (host/index.ts); the overview reads it through the session
 * list's projection column. `stateVersion` 1: the ledger's first shape.
 */
export function createContextActivityDefinition(): ProjectionDefinition<'contextActivity', ActivityState> {
  return {
    key: 'contextActivity',
    stateSchema: activityStateSchema,
    init: (): ActivityState => ({ days: {} }),
    apply: (state: ActivityState, event: SessionEvent) => applyActivity(state, event),
    // The view copies the ledger (entries included) so the registry, the
    // cache writer, and the wire can never share — and mutate — the fold's
    // own record. 400 entries × two integers: the copy is trivial.
    wire: {
      viewSchema: contextActivitySchema,
      view: state => ({
        days: Object.fromEntries(Object.entries(state.days).map(([k, v]) => [k, { ...v }])),
      }),
    },
    stateVersion: 1,
  }
}
