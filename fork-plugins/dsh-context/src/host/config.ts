import z from '@deepseek-ai/schemastery'
import type { PluginSettings } from '../shared/types'

export const DEFAULT_BOUNDS = {
  maxRequestSteps: 1500,
  maxKeptTurns: 300,
  maxEvents: 400,
  maxNodes: 2000,
  maxArchiveNodes: 400,
  maxFileOps: 400,
  maxCommands: 400,
  maxSpans: 2_000,
  maxCommandChars: 4096,
}

export type FoldBounds = typeof DEFAULT_BOUNDS & {
  headOnly?: boolean
}

export type Config = Partial<FoldBounds> & Partial<PluginSettings> & {
  backfillStartDelayMs?: number
  backfillRefreshDelayMs?: number
  coldFoldMaxLogBytes?: number
}

export const HISTORY_LIMIT = Number.MAX_SAFE_INTEGER

/**
 * Default wait before the first automatic backfill pass: the Host serves its first list and the openings that follow a
 * start first. A pass lists and stats every stored Session, which took 3.5 to 15 s on a home with about 40,000 Sessions.
 */
export const DEFAULT_BACKFILL_START_DELAY_MS = 180_000

/**
 * Default wait between a Session disposal and its backfill pass. Subagent Sessions dispose all the time, so this is how
 * often the corpus-wide pass runs while Agents work; a Session opening that overlapped one took about twice as long.
 * An overview request rebuilds the Sessions whose stored identity changed, so the wait delays background warming,
 * not what the overview shows.
 */
export const DEFAULT_BACKFILL_REFRESH_DELAY_MS = 600_000

/** Default cold fold cap: folding a larger stored log took tens of seconds of the Host's main thread. */
export const DEFAULT_COLD_FOLD_MAX_LOG_BYTES = 64 * 1024 * 1024

export function historyBounds(bounds: FoldBounds): FoldBounds {
  return {
    ...bounds,
    maxRequestSteps: HISTORY_LIMIT,
    maxKeptTurns: HISTORY_LIMIT,
    maxEvents: HISTORY_LIMIT,
    maxNodes: HISTORY_LIMIT,
    maxArchiveNodes: HISTORY_LIMIT,
    maxFileOps: HISTORY_LIMIT,
    maxSpans: HISTORY_LIMIT,
  }
}

export function volatileField<S extends z>(field: S): S {
  const volatile = (field as unknown as { volatile?: () => S }).volatile
  return typeof volatile === 'function' ? volatile.call(field) : field
}

function count(defaultValue: number) {
  return z.number().min(1).step(1).default(defaultValue)
}

export const Config = z.object({
  maxRequestSteps: count(DEFAULT_BOUNDS.maxRequestSteps),
  maxKeptTurns: count(DEFAULT_BOUNDS.maxKeptTurns),
  maxEvents: count(DEFAULT_BOUNDS.maxEvents),
  maxNodes: count(DEFAULT_BOUNDS.maxNodes),
  maxArchiveNodes: count(DEFAULT_BOUNDS.maxArchiveNodes),
  maxFileOps: count(DEFAULT_BOUNDS.maxFileOps),
  maxCommands: count(DEFAULT_BOUNDS.maxCommands),
  maxSpans: count(DEFAULT_BOUNDS.maxSpans),
  maxCommandChars: count(DEFAULT_BOUNDS.maxCommandChars),
  defaultPlacement: volatileField(z.union(['all', 'tab', 'sidebar', 'hide']).default('all').loose()),
  defaultGranularity: volatileField(z.union(['step', 'turn']).default('step').loose()),
  defaultTimelineMode: volatileField(z.union(['total', 'delta']).default('total').loose()),
  defaultDeltaBase: volatileField(z.union(['step', 'turn']).default('step').loose()),
  defaultToolSort: volatileField(z.union(['size', 'count', 'name']).default('count').loose()),
  defaultFileSort: volatileField(z.union(['count', 'lines', 'latest', 'path', 'name']).default('lines').loose()),
  insightsEntry: volatileField(z.union(['show', 'hide']).default('show').loose()),
  defaultDurationCurve: volatileField(z.union(['show', 'hide']).default('show').loose()),
  overviewAutoSteps: volatileField(z.union(['100', '200', '300', 'off']).default('100').loose()),
  defaultOverviewRange: volatileField(z.union(['today', '7d', '30d']).default('30d').loose()),
  fleetTab: volatileField(z.union(['show', 'hide']).default('show').loose()),
  balanceSource: volatileField(z.union(['account', 'api']).default('account').loose()),
  promptPrefix: volatileField(z.string().default('').loose()),
  promptSuffix: volatileField(z.string().default('').loose()),
  backfillStartDelayMs: z.number().min(0).step(1).default(DEFAULT_BACKFILL_START_DELAY_MS)
    .description('Milliseconds between Host readiness and the first automatic activity backfill pass.'),
  backfillRefreshDelayMs: z.number().min(0).step(1).default(DEFAULT_BACKFILL_REFRESH_DELAY_MS)
    .description('Milliseconds a Session disposal waits before its backfill pass; disposals inside that wait join the same pass.'),
  coldFoldMaxLogBytes: z.number().min(0).step(1).default(DEFAULT_COLD_FOLD_MAX_LOG_BYTES)
    .description('Stored log bytes above which the Context facts and delta routes do not fold the whole log of an unopened Session; 0 folds every size.'),
})

/** Cold fold cap the plugin config resolves to. */
export function resolveColdFoldMaxLogBytes(config: Config | undefined): number {
  return (Config(config ?? {}) as Record<string, unknown>).coldFoldMaxLogBytes as number
}

/** Backfill delays the plugin config resolves to. */
export function resolveBackfillDelays(config: Config | undefined): { startDelayMs: number; refreshDelayMs: number } {
  const resolved = Config(config ?? {}) as Record<string, unknown>
  return { startDelayMs: resolved.backfillStartDelayMs as number, refreshDelayMs: resolved.backfillRefreshDelayMs as number }
}

export function resolveBounds(config: Config | undefined): FoldBounds {
  const resolved = Config(config ?? {}) as FoldBounds & Record<string, unknown>
  return {
    maxRequestSteps: resolved.maxRequestSteps,
    maxKeptTurns: resolved.maxKeptTurns,
    maxEvents: resolved.maxEvents,
    maxNodes: resolved.maxNodes,
    maxArchiveNodes: resolved.maxArchiveNodes,
    maxFileOps: resolved.maxFileOps,
    maxCommands: resolved.maxCommands,
    maxSpans: resolved.maxSpans,
    maxCommandChars: resolved.maxCommandChars,
  }
}
