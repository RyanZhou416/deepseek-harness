// Composer statistics pills, each its own 'conversation.composer.dock' list
// entry (activity, usage) so a plugin can replace or add one pill by id.
// Compact keeps speed and cache hit as plain readings; Detailed adds counts,
// token totals, and click-open dialogs. Settled-node identity prevents
// stream-delta updates from rerendering the pills.

import { memo, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconDatabaseOutlineRegular, IconGaugeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionSnapshot, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InjectFace, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the sessionStats key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { ChatViewSlotProps, PerformanceUsageInjected } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { formatTokensPerSecond } from './message-chrome.ts'
import { assistantStepReading } from '../contract/turn-metrics.ts'
import { formatCacheHitPercent, formatExactTokens, formatTokens } from './token-format.ts'
import { MEASURE_STYLE, useStatDialog } from './stat-dialog.ts'
import css from './StatsPills.module.css'
import dialogCss from './stat-dialog.module.css'

interface WindowStats {
  turns: number
  steps: number
  /** Summed request wall time (step/start → assistant/message); 0 when no node carries timing. */
  llmMs: number
  /** Summed tool wall time (tool/call → tool/result); 0 when no pair is in-window. */
  toolMs: number
  /** Summed first-token latency over `ttftSteps`; 0 when no step records it. */
  ttftMs: number
  /** Steps carrying a recorded TTFT. */
  ttftSteps: number
  /** Summed decode wall time over steps that also report output tokens. */
  decodeMs: number
  /** Summed output tokens over the same decode-timed steps. */
  decodeTokens: number
  /** Latest measurable turn from the durable projection, when present. */
  lastTurnSpeedTurn?: number | null
  /** Decode wall time of that turn, ms. */
  lastTurnSpeedDecodeMs?: number
  /** Output tokens of that turn. */
  lastTurnSpeedDecodeTokens?: number
}

/**
 * Fold assistant and tool-result nodes into window-scoped display totals —
 * the FALLBACK for assemblies without the `sessionStats` projection.
 *
 * Every displayed figure rides that durable whole-log projection (and token
 * accounting rides `tokenUsage`) because the window is paged and compaction
 * rewrites it; this fold answers "what is on screen" only when no projection
 * value is served. Its field names deliberately mirror the projection's so
 * the two swap wholesale.
 * @param nodes - snapshot nodes.
 * @returns fallback counts and summed wall times.
 */
export function deriveStats(nodes: ChatSnapshot['legacy']['nodes']): WindowStats {
  const turns = new Set<number>()
  let steps = 0
  let llmMs = 0
  let toolMs = 0
  let ttftMs = 0
  let ttftSteps = 0
  let decodeMs = 0
  let decodeTokens = 0
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime)
      continue
    }
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    steps += 1
    if (node.timing !== undefined && node.timing.stepStartTime !== null) {
      llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime)
    }
    const reading = assistantStepReading(node)
    if (reading.ttftMs !== null) {
      ttftMs += reading.ttftMs
      ttftSteps += 1
    }
    if (reading.decodeMs !== null && reading.outputTokens !== null) {
      decodeMs += reading.decodeMs
      decodeTokens += reading.outputTokens
    }
  }
  return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
}

/** Output throughput of the most recent settled turn in the loaded history. */
export interface TurnSpeed {
  /** Host-assigned turn number. */
  turn: number
  /** Output tokens per second across that turn's timed assistant steps. */
  tps: number
}

/**
 * Fold the most recent turn that has honest decode data into its own output
 * speed.
 *
 * The newest turn in the window can be an in-flight or interrupted step with
 * no finalized timing or provider output tokens. Treating that empty turn as
 * "this turn" would make the reading disappear while the next turn streams;
 * this selects the latest turn that actually has both boundaries and usage, so
 * the reading stays stable until the new turn can replace it.
 * @param nodes - snapshot nodes, including assistant steps with timing.
 * @returns the latest measurable turn's speed, or null when none exists.
 */
export function latestTurnSpeed(nodes: ChatSnapshot['legacy']['nodes']): TurnSpeed | null {
  const turns = new Map<number, { decodeMs: number; decodeTokens: number }>()
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    const reading = assistantStepReading(node)
    if (reading.decodeMs === null || reading.outputTokens === null) continue
    const totals = turns.get(node.turn) ?? { decodeMs: 0, decodeTokens: 0 }
    totals.decodeMs += reading.decodeMs
    totals.decodeTokens += reading.outputTokens
    turns.set(node.turn, totals)
  }
  let latestTurn: number | undefined
  for (const [turn, totals] of turns) {
    if (totals.decodeMs <= 0 || totals.decodeTokens <= 0) continue
    if (latestTurn === undefined || turn > latestTurn) latestTurn = turn
  }
  if (latestTurn === undefined) return null
  const totals = turns.get(latestTurn) as { decodeMs: number; decodeTokens: number }
  return { turn: latestTurn, tps: totals.decodeTokens / (totals.decodeMs / 1_000) }
}

/**
 * Read the durable projection's last measurable turn.
 * @param stats - whole-log stats, with the optional turn-speed fields.
 * @returns the turn speed, or null when this checkpoint predates the fields.
 */
function projectedTurnSpeed(stats: WindowStats): TurnSpeed | null {
  const turn = stats.lastTurnSpeedTurn
  const decodeMs = stats.lastTurnSpeedDecodeMs ?? 0
  const decodeTokens = stats.lastTurnSpeedDecodeTokens ?? 0
  if (turn === undefined || turn === null || decodeMs <= 0 || decodeTokens <= 0) return null
  return { turn, tps: decodeTokens / (decodeMs / 1_000) }
}

/**
 * Compact duration: 45.2s under a minute, 2m42s from there on.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
export function formatDuration(ms: number, t: ChatViewSlotProps['t']): string {
  const s = ms / 1_000
  if (s < 60) return t('duration.compactSeconds', { seconds: Math.round(s * 10) / 10 })
  const whole = Math.round(s)
  return t('duration.compactMinutes', {
    minutes: Math.floor(whole / 60),
    seconds: whole % 60,
  })
}

/**
 * Display-ready cache-hit share of prompt-side input over the whole durable log.
 * @param usage - the session's token-usage projection value.
 * @returns integer text when integer rounding stays below 100, otherwise the
 * minimum decimal precision that still rounds below 100; a full hit returns
 * 100, and no billed input returns null.
 */
export function cacheHitPercent(usage: TokenUsageProjection): string | null {
  const denominator = billedInputTokens(usage)
  return formatCacheHitPercent(usage.cacheReadTokens, denominator)
}

/**
 * Sum the three disjoint prompt-side billing buckets.
 * @param usage - the session's token-usage projection value.
 * @returns billed input tokens.
 */
export function billedInputTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

type Translate = ChatViewSlotProps['t']

/** Props shared by every composer stats pill: the conversation-snapshot selector plus the projection read seat. */
export interface StatPillProps extends InjectFace<PerformanceUsageInjected> {
  useChat: SnapshotSelectorHook<ChatSnapshot>
  useProjection: UseProjection
  /**
   * Whole-log projection readiness for the bound Session. Bare presentation
   * fixtures may omit the seat; a bound Session always supplies it. Without
   * the seat, values render as they did before readiness existed (a fixture
   * has no deferred read to describe); with it, a non-exact generation never
   * presents cached or window-scoped values as whole-session values.
   */
  useProjectionAvailability?: SnapshotSelectorHook<SessionSnapshot['projectionAvailability']>
  /**
   * Request exact whole-log projections. Only the explicit user action that
   * opens a statistics surface or clicks a non-exact value calls it; the
   * pills never request on mount.
   */
  requestExactProjections?: () => void
  /** The owning dock's locale seat. */
  t: Translate
}

/** Dock entry id carried as `data-composer-stat` on each pill. */
type StatId = 'activity' | 'usage'

interface PillContent {
  stat: StatId
  icon: ReactNode
  label: ReactNode
}

function exactCount(value: number, t: Translate): string {
  return t('message.turnUsage.count', { count: formatExactTokens(value, t) })
}

function joined(first: string, second: string | null): ReactNode {
  if (second === null) return first
  return (
    <>
      {first}
      <span className={css.sep} aria-hidden>·</span>
      {second}
    </>
  )
}

// Every figure rides the durable sessionStats projection, so paging and
// compaction cannot change any of them; an assembly without the unit falls
// back to the window-scoped fold wholesale (same field names), paid only
// while no projection value is served.
function useSessionStats(useChat: StatPillProps['useChat'], useProjection: UseProjection): WindowStats {
  const settledNodes = useChat(s => s.legacy.nodes)
  const projected = useProjection('sessionStats')
  return useMemo(() => projected ?? deriveStats(settledNodes), [projected, settledNodes])
}

function decodeSpeed(stats: WindowStats, t: Translate): string {
  return t('message.tokensPerSecond', {
    tps: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
  })
}

/** A static reading: used when the pill has no dialog rows or the mode is Compact. */
function PlainPill({ stat, icon, label }: PillContent) {
  return (
    <span className={css.anchor} data-composer-stat={stat}>
      <span className={css.pill}>
        {icon}
        <span className={css.label}>{label}</span>
      </span>
    </span>
  )
}

/**
 * A pill carrying one explicit action instead of a reading: used where a
 * cached hint exists but the generation has no exact cut, so clicking requests
 * the exact whole-log value rather than presenting the hint as exact.
 */
function ActionPill({ stat, icon, label, onClick }: PillContent & { label: string; onClick: () => void }) {
  return (
    <span className={css.anchor} data-composer-stat={stat}>
      <button type="button" className={css.pill} aria-label={label} onClick={onClick}>
        {icon}
        <span className={css.label}>{label}</span>
      </button>
    </span>
  )
}

/**
 * A pill button opening its own portaled dialog. Each pill owns its open
 * state; useStatDialog closes it on Escape or an outside pointerdown or click,
 * so at most one dialog is open across the dock.
 */
function DialogPill({ stat, icon, label, ariaLabel, title, titleValue, onOpen, children }: PillContent & {
  ariaLabel: string
  title: string
  titleValue?: string
  /** Explicit user opening of this statistics surface; never fired by mounting. */
  onOpen?: (() => void) | undefined
  children: ReactNode
}) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()
  return (
    <span ref={rootRef} className={css.anchor} data-composer-stat={stat}>
      <button
        type="button"
        className={css.pill}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (!open) onOpen?.()
          setOpen(!open)
        }}
      >
        {icon}
        <span className={css.label}>{label}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={title}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              {icon}
              {title}
            </span>
            {titleValue !== undefined && <span className={dialogCss.titleValue}>{titleValue}</span>}
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          {children}
        </div>,
        document.body,
      )}
    </span>
  )
}

/**
 * Turn and step counts with this turn's output speed, opening the time and
 * speed dialog; Compact keeps only the speed reading.
 */
export const ActivityPill = memo(function ActivityPill({
  useChat, useProjection, requestExactProjections, usePerformanceUsage, t,
}: StatPillProps) {
  const mode = usePerformanceUsage(value => value)
  const stats = useSessionStats(useChat, useProjection)
  const settledNodes = useChat(s => s.legacy.nodes)
  const turnSpeed = useMemo(
    () => projectedTurnSpeed(stats) ?? latestTurnSpeed(settledNodes),
    [stats, settledNodes],
  )
  const turnSpeedLabel = turnSpeed === null
    ? null
    : t('message.tokensPerSecond', { tps: formatTokensPerSecond(turnSpeed.tps) })
  // The dialog keeps the durable whole-session TPS as its own row; the dock
  // pill itself reports the latest measurable turn, which is what a reader
  // wants without opening the dialog.
  const speed = stats.decodeMs > 0 ? decodeSpeed(stats, t) : null
  const icon = <IconGaugeOutlineRegular />
  if (mode === 'compact') return turnSpeedLabel === null ? null : <PlainPill stat="activity" icon={icon} label={turnSpeedLabel} />
  if (stats.steps === 0) return null
  const counts = t('stats.counts', { turns: stats.turns, steps: stats.steps })
  const content: PillContent = { stat: 'activity', icon, label: joined(counts, turnSpeedLabel) }
  // A window without one timed figure has no dialog rows to show, so the pill
  // stays a plain reading instead of a button opening an empty dialog.
  if (stats.llmMs <= 0 && stats.toolMs <= 0 && stats.ttftSteps <= 0 && speed === null) return <PlainPill {...content} />
  return (
    <DialogPill {...content} ariaLabel={turnSpeedLabel === null ? counts : `${counts} · ${turnSpeedLabel}`} title={t('stats.dialog.title')} onOpen={requestExactProjections}>
      <dl className={dialogCss.details} data-session-stats-details>
        {stats.llmMs > 0 && (
          <>
            <dt>{t('stats.dialog.llmTime')}</dt>
            <dd>{formatDuration(stats.llmMs, t)}</dd>
          </>
        )}
        {stats.toolMs > 0 && (
          <>
            <dt>{t('stats.dialog.toolTime')}</dt>
            <dd>{formatDuration(stats.toolMs, t)}</dd>
          </>
        )}
        {stats.ttftSteps > 0 && (
          <>
            <dt>{t('stats.dialog.ttft')}</dt>
            <dd>{formatDuration(stats.ttftMs / stats.ttftSteps, t)}</dd>
          </>
        )}
        {speed !== null && (
          <>
            <dt>{t('stats.dialog.speed')}</dt>
            <dd>{speed}</dd>
          </>
        )}
        {turnSpeed !== null && (
          <>
            <dt>{t('stats.dialog.turnSpeed')}</dt>
            <dd>{t('message.tokensPerSecond', { tps: formatTokensPerSecond(turnSpeed.tps) })}</dd>
          </>
        )}
      </dl>
    </DialogPill>
  )
})

/** Whole-log token total and cache hit; Compact keeps only the cache hit. */
export const UsagePill = memo(function UsagePill({
  useProjection, useProjectionAvailability, requestExactProjections, usePerformanceUsage, t,
}: StatPillProps) {
  const mode = usePerformanceUsage(value => value)
  const usage = useProjection('tokenUsage')
  // Without the readiness seat this is a bare fixture with no deferred read;
  // with it, only `exact` may present a whole-session total.
  const availability = useProjectionAvailability === undefined ? undefined : useProjectionAvailability(value => value)
  const icon = <IconDatabaseOutlineRegular />
  const hasActivity = usage !== undefined
    && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)
  if (availability !== undefined && availability.state !== 'exact') {
    // A cached hint or a window-scoped fold is not a whole-session total. Show
    // the deferred read's own state, and let an explicit click request the cut
    // instead of rendering the hint as exact.
    if (availability.state === 'loading') {
      return <PlainPill stat="usage" icon={icon} label={t('stats.usageLoading')} />
    }
    if (hasActivity) {
      return (
        <ActionPill
          stat="usage"
          icon={icon}
          label={t('stats.usageUnavailable')}
          onClick={() => { requestExactProjections?.() }}
        />
      )
    }
    if (availability.reason !== 'opening-absent') {
      return <PlainPill stat="usage" icon={icon} label={t('stats.usageUnavailable')} />
    }
    return null
  }
  // Gated on actual token activity: a session whose steps all settled without
  // billing (e.g. every request failed) shows no usage pill. While the key is
  // absent, only an exact cut can supply a whole-session total.
  if (!hasActivity || usage === undefined) return null
  const cacheHit = cacheHitPercent(usage)
  const cacheHitText = cacheHit !== null ? t('stats.cacheHit', { percent: cacheHit }) : null
  if (mode === 'compact') {
    return cacheHitText === null ? null : <PlainPill stat="usage" icon={icon} label={cacheHitText} />
  }
  // Same aggregate as the Turn pill's totalTokens: every prompt-side billing bucket plus output.
  const total = billedInputTokens(usage) + usage.outputTokens
  const totalText = t('message.turnUsage.count', { count: formatTokens(total, t) })
  return (
    <DialogPill
      stat="usage"
      icon={icon}
      label={joined(totalText, cacheHitText)}
      ariaLabel={cacheHitText === null ? totalText : `${totalText} · ${cacheHitText}`}
      title={t('stats.dialog.usageTitle')}
      titleValue={exactCount(total, t)}
      onOpen={requestExactProjections}
    >
      {/* jscpd:ignore-start -- the session-total bucket rows deliberately mirror
          TurnUsagePanel's per-turn dl: same skin, different data contract (the
          buckets are always present here; per-turn fields are optional). A
          session that never wrote cache drops the row, as the per-turn panel
          drops its absent fields. */}
      <dl className={dialogCss.details} data-session-stats-usage>
        {cacheHit !== null && (
          <>
            <dt>{t('message.turnUsage.cacheHit')}</dt>
            <dd>{`${cacheHit}%`}</dd>
          </>
        )}
        <dt>{t('message.turnUsage.input')}</dt>
        <dd>{exactCount(usage.uncachedInputTokens, t)}</dd>
        <dt>{t('message.turnUsage.cacheRead')}</dt>
        <dd>{exactCount(usage.cacheReadTokens, t)}</dd>
        {usage.cacheWriteTokens !== 0 && (
          <>
            <dt>{t('message.turnUsage.cacheWrite')}</dt>
            <dd>{exactCount(usage.cacheWriteTokens, t)}</dd>
          </>
        )}
        <dt>{t('message.turnUsage.output')}</dt>
        <dd>{exactCount(usage.outputTokens, t)}</dd>
      </dl>
      {/* jscpd:ignore-end */}
    </DialogPill>
  )
})
