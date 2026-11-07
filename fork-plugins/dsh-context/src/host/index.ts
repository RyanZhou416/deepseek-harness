import type { Context } from '@deepseek-ai/cordis'
import { createContextActivityDefinition } from './activity'
import { watchAttachmentChannel } from './attachment'
import { createToolAttribution } from './attribution'
import { watchBalanceChannel } from './balance'
import { watchActivityBackfill } from './backfill'
import { makeColdReadGate } from './coldRead'
import { watchCommandPageChannel } from './commandPages'
import { Config, resolveBounds } from './config'
import { type DetailChannelGate, watchDetailChannel } from './detail'
import { createFallbackActivityDefinition, createFallbackHeadersDefinition, createFallbackTimelineDefinition } from './fallback'
import { watchFleetChannel } from './fleet'
import { createContextHeadersDefinition } from './headers'
import { timelineReaderOf } from './projectionHandle'
import { watchPromptInjection } from './promptInjection'
import { watchStepIdentity } from './stepIdentity'
import { watchSkillCatalog } from './skills'
import { watchRecomChannel } from './recoms'
import { createContextTimelineDefinition } from './timeline'
import { detectHarnessVersion } from './version'
import { meetsBaseline } from '../shared/version'

export const name = 'dsh-context'

export const inject = ['sessionProjections']

export { Config } from './config'
export async function apply(ctx: Context, config: Config): Promise<void> {
  const coldReads = makeColdReadGate()
  watchBalanceChannel(ctx)
  watchRecomChannel(ctx)
  watchSkillCatalog(ctx)
  watchFleetChannel(ctx, coldReads)
  watchAttachmentChannel(ctx, coldReads)
  const harnessVersion = detectHarnessVersion(ctx)
  if (harnessVersion !== undefined && !meetsBaseline(harnessVersion)) {
    await Promise.all([
      Promise.resolve(ctx.sessionProjections.register(createFallbackTimelineDefinition(harnessVersion) as never)),
      Promise.resolve(ctx.sessionProjections.register(createFallbackHeadersDefinition() as never)),
      Promise.resolve(ctx.sessionProjections.register(createFallbackActivityDefinition() as never)),
    ])
    return
  }
  const attribution = createToolAttribution(ctx)
  watchStepIdentity(ctx)
  const bounds = resolveBounds(config)
  const gate: DetailChannelGate = { live: false }
  const [timeline] = await Promise.all([
    Promise.resolve(ctx.sessionProjections.register(createContextTimelineDefinition(config, () => gate.live))),
    Promise.resolve(ctx.sessionProjections.register(createContextHeadersDefinition(name => attribution.ownerOf(name)))),
    Promise.resolve(ctx.sessionProjections.register(createContextActivityDefinition())),
  ])
  watchDetailChannel(ctx, bounds, coldReads, await timelineReaderOf(ctx, timeline), gate)
  watchCommandPageChannel(ctx, bounds, coldReads)
  watchActivityBackfill(ctx, coldReads)
  watchPromptInjection(ctx, config)
}

export type { Category, ContextEventRecord, RequestRecord, Snapshot, ContextTimeline, SurfaceNode } from '../shared/types'
export type { ActivityDay, ContextActivity, ContextHeaders, HeaderRecord, HeaderTool, ContextTimelineDetail, TimelineCounts, TimelineLast } from '../shared/types'
export type { PlatformBalance, PlatformBalanceEntry, SkillInfo } from '../shared/types'
export type { ActivityState } from './activity'
export type { TimelineState } from './foldState'
export type { HeadersState } from './headers'
