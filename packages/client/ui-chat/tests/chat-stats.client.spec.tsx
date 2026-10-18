// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type {
  AssistantMessageNode, ChatSnapshot, LegacyConversationSlice, ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { ActivityPill, UsagePill, deriveStats, formatDuration, latestTurnSpeed, type StatPillProps } from '../src/client/chat/StatsPills.tsx'
import { formatTokens } from '../src/client/chat/token-format.ts'
import { en, zh } from '../src/client/locale.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

const t: StatPillProps['t'] = makeTranslate(zh, commonZh)
const tEn: StatPillProps['t'] = makeTranslate(en, commonEn)

/** Both composer-dock entries in their registered order, as the dock renders them. */
function StatsPills(props: StatPillProps) {
  return (
    <>
      <ActivityPill {...props} />
      <UsagePill {...props} />
    </>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const assistant = (seq: number, turn: number, usage?: unknown): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step: seq, blocks: [{ kind: 'text', text: `t${seq}` }],
  ...(usage === undefined ? {} : { usage }),
})

type ChatUpdate = Partial<LegacyConversationSlice>

function makeSource(init: ChatUpdate = {}) {
  let snap = chatSnapshotFixture(init)
  const subs = new Set<() => void>()
  return {
    set: (next: ChatUpdate) => {
      snap = chatSnapshotFixture({ ...snap.legacy, ...next }, snap)
      for (const fn of [...subs]) fn()
    },
    source: {
      getSnapshot: () => snap,
      subscribe: (fn: () => void) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
    },
  }
}

describe('deriveStats', () => {
  it('counts turns and steps and never folds node usage into accounting', () => {
    const stats = deriveStats([
      assistant(1, 1, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 }),
      assistant(2, 1, { inputTokens: 100, outputTokens: 50 }),
      assistant(3, 2),
    ])
    expect(stats.turns).toBe(2)
    expect(stats.steps).toBe(3)
    // The window fold's counts are only the fallback for assemblies without
    // the sessionStats projection; the paged window is not an accounting
    // source either, so the fold exposes no billing fields (billing rides the
    // tokenUsage projection); decodeTokens is a throughput input, not a
    // billed total.
    expect(Object.keys(stats).sort()).toEqual(
      ['decodeMs', 'decodeTokens', 'llmMs', 'steps', 'toolMs', 'ttftMs', 'ttftSteps', 'turns'],
    )
  })

  it('derives this turn speed from the latest turn that has decode data', () => {
    const first: AssistantMessageNode = {
      ...assistant(1, 1, { outputTokens: 60 }),
      timing: { stepStartTime: 1_000, firstTokenTime: 2_000, completedTime: 5_000 },
    }
    const second: AssistantMessageNode = {
      ...assistant(2, 2, { outputTokens: 20 }),
      timing: { stepStartTime: 6_000, firstTokenTime: 6_200, completedTime: 7_000 },
    }
    expect(latestTurnSpeed([first, second])).toEqual({ turn: 2, tps: 25 })
    expect(latestTurnSpeed([first])).toEqual({ turn: 1, tps: 20 })
    // A new in-flight turn without finalized timing/usage must not blank the
    // reading while its stream is still running.
    expect(latestTurnSpeed([first, second, assistant(3, 3)])).toEqual({ turn: 2, tps: 25 })
    expect(latestTurnSpeed([assistant(3, 3)])).toBeNull()
  })

  it('ignores tool results with no call time', () => {
    const tool: ToolResultNode = {
      kind: 'tool-result', seq: 5, time: 5_000, callId: 'c', call: null, callTime: null, content: [],
      name: '', args: PartialArguments.EMPTY,
      isError: false, subCalls: [],
    }
    const stats = deriveStats([tool, assistant(1, 1)])
    expect(stats.steps).toBe(1)
    expect(stats.toolMs).toBe(0)
  })

  it('sums LLM wall time from assistant timing and tool wall time from call/result pairs', () => {
    const timed: AssistantMessageNode = {
      ...assistant(1, 1),
      timing: { stepStartTime: 1_000, firstTokenTime: 1_200, completedTime: 3_500 },
    }
    const untimed: AssistantMessageNode = {
      ...assistant(2, 1),
      timing: { stepStartTime: null, firstTokenTime: null, completedTime: 9_000 },
    }
    const tool: ToolResultNode = {
      kind: 'tool-result', seq: 5, time: 7_000, callId: 'c', call: null, callTime: 4_000, content: [],
      name: '', args: PartialArguments.EMPTY,
      isError: false, subCalls: [],
    }
    const stats = deriveStats([timed, untimed, tool])
    expect(stats.llmMs).toBe(2_500)
    expect(stats.toolMs).toBe(3_000)
  })

  it('sums ttft per recorded step and decode throughput inputs per usage-carrying step', () => {
    const sampled: AssistantMessageNode = {
      ...assistant(1, 1, { outputTokens: 40 }),
      timing: { stepStartTime: 1_000, firstTokenTime: 1_800, completedTime: 4_800 },
    }
    const ttftOnly: AssistantMessageNode = {
      ...assistant(2, 1),
      timing: { stepStartTime: 5_000, firstTokenTime: 5_400, completedTime: 7_400 },
    }
    const stats = deriveStats([sampled, ttftOnly, assistant(3, 2)])
    expect(stats.ttftMs).toBe(1_200)
    expect(stats.ttftSteps).toBe(2)
    // The usage-less step contributes no decode share, keeping the ratio honest.
    expect(stats.decodeMs).toBe(3_000)
    expect(stats.decodeTokens).toBe(40)
  })
})

describe('formatters', () => {
  it('formats token counts compactly', () => {
    expect(formatTokens(517, tEn)).toBe('517')
    expect(formatTokens(12_240, tEn)).toBe('12.2K')
    expect(formatTokens(517_000, tEn)).toBe('517K')
    expect(formatTokens(1_230_000, tEn)).toBe('1.2M')
  })

  it('formats durations under and over a minute', () => {
    expect(formatDuration(45_230, tEn)).toBe('45.2s')
    expect(formatDuration(162_000, tEn)).toBe('2m42s')
  })
})

describe('composer stats pills', () => {
  const USAGE = { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0 }

  /** A whole-log sessionStats value: zeros plus overrides. */
  function sessionStats(overrides: Record<string, number | null>): Record<string, number | null> {
    return {
      turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
      lastTurnSpeedTurn: null, lastTurnSpeedDecodeMs: 0, lastTurnSpeedDecodeTokens: 0,
      ...overrides,
    }
  }

  /** Stub the projection seat: a key-addressed table of whole values. */
  function projections(values: Record<string, unknown>): StatPillProps['useProjection'] {
    return (key: string) => values[key]
  }

  type Availability = SessionSnapshot['projectionAvailability']

  /** Window-first opening: no exact cut was served, and no surface has requested one yet. */
  const BEFORE_REQUEST: Availability = { state: 'unavailable', reason: 'opening-absent' }

  /** A generation whose exact whole-log cut already arrived (a completed deferred read or cache hit). */
  const EXACT: Availability = { state: 'exact', asOfSeq: 12 }

  function props(
    source: { getSnapshot(): ChatSnapshot; subscribe(fn: () => void): () => void },
    values: Record<string, unknown> = { tokenUsage: USAGE },
    availability: Availability = EXACT,
    requestExactProjections: () => void = () => {},
  ): StatPillProps {
    return {
      usePerformanceUsage: selector => selector('detailed'),
      useChat: bindSnapshotSelector(source),
      useProjection: projections(values),
      useProjectionAvailability: selector => selector(availability),
      requestExactProjections,
      t: tEn,
    }
  }

  function tokenUsage(cacheReadTokens: number, uncachedInputTokens: number) {
    return { uncachedInputTokens, outputTokens: 1, cacheReadTokens, cacheWriteTokens: 0 }
  }

  /** A step whose timing yields 3.8s LLM, 0.8s TTFT, and 20 tok/s over 60 tokens. */
  const timedStep = (): AssistantMessageNode => ({
    ...assistant(1, 1, { outputTokens: 60 }),
    timing: { stepStartTime: 1_000, firstTokenTime: 1_800, completedTime: 4_800 },
  })

  it('compact keeps only speed and cache hit, with no interactive statistics', () => {
    const { source } = makeSource({ nodes: [timedStep()] })
    const view = render(<StatsPills {...props(source)} usePerformanceUsage={selector => selector('compact')} />)
    expect(view.container.textContent).toBe('20 tok/sCache hit 90%')
    expect(view.queryByRole('button')).toBeNull()
    fireEvent.mouseOver(view.getByText('20 tok/s'))
    expect(view.queryByRole('dialog')).toBeNull()
    view.rerender(<StatsPills {...props(source)} />)
    expect(view.getAllByRole('button')).toHaveLength(2)
    fireEvent.click(view.getAllByRole('button')[0]!)
    expect(view.getByRole('dialog')).toBeTruthy()
    view.rerender(<StatsPills {...props(source)} usePerformanceUsage={selector => selector('compact')} />)
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('compact omits unavailable metrics instead of showing counts', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsPills {...props(source, {})} usePerformanceUsage={selector => selector('compact')} />)
    expect(view.container.textContent).toBe('')
  })

  it('renders the counts reading and usage pill and hides a brand-new empty session', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsPills {...props(source)} />)
    // No timing on the fixture: the speed segment drops out and the dialog
    // would have no rows, so the counts reading stays a static pill (no button).
    expect(view.getByText('1 turns 1 steps').closest('button')).toBeNull()
    // Cache hit comes from the projection, so paging the window cannot change
    // it; the usage pill leads with the whole-log token total. Its accessible
    // name separates the segments the visual sep glyph joins.
    const usagePill = view.getAllByRole('button')
    expect(usagePill.map(pill => pill.textContent)).toEqual(['105 tok·Cache hit 90%'])
    expect(usagePill[0]!.getAttribute('aria-label')).toBe('105 tok · Cache hit 90%')
    const empty = makeSource()
    const emptyView = render(<StatsPills {...props(empty.source, {
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      contextPressure: {},
    })} />)
    expect(emptyView.container.textContent).toBe('')
  })

  it.each([
    { actual: '98.6%', tokenUsageValue: tokenUsage(986, 14), expected: 'Cache hit 99%' },
    { actual: '99.1%', tokenUsageValue: tokenUsage(991, 9), expected: 'Cache hit 99%' },
    { actual: '99.49%', tokenUsageValue: tokenUsage(9_949, 51), expected: 'Cache hit 99%' },
    { actual: '99.5%', tokenUsageValue: tokenUsage(995, 5), expected: 'Cache hit 99.5%' },
    { actual: '99.94%', tokenUsageValue: tokenUsage(9_994, 6), expected: 'Cache hit 99.9%' },
    { actual: '99.95%', tokenUsageValue: tokenUsage(9_995, 5), expected: 'Cache hit 99.95%' },
    { actual: '99.955%', tokenUsageValue: tokenUsage(19_991, 9), expected: 'Cache hit 99.96%' },
    { actual: '99.985%', tokenUsageValue: tokenUsage(19_997, 3), expected: 'Cache hit 99.99%' },
    { actual: '99.995%', tokenUsageValue: tokenUsage(19_999, 1), expected: 'Cache hit 99.995%' },
    { actual: '99.9975%', tokenUsageValue: tokenUsage(39_999, 1), expected: 'Cache hit 99.998%' },
    {
      actual: 'the closest non-full ratio available from safe integer cumulative counts',
      tokenUsageValue: tokenUsage(Number.MAX_SAFE_INTEGER - 1, 1),
      expected: 'Cache hit 99.99999999999999%',
    },
    { actual: '100%', tokenUsageValue: tokenUsage(10_000, 0), expected: 'Cache hit 100%' },
  ])('formats an actual $actual cache-hit ratio as $expected', ({ tokenUsageValue, expected }) => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsPills {...props(source, { tokenUsage: tokenUsageValue })} />)
    expect(view.getAllByRole('button')[0]!.textContent).toContain(expected)
  })

  it('exposes output speed on the counts pill when decode timing exists', () => {
    const { source } = makeSource({ nodes: [timedStep()] })
    const view = render(<StatsPills {...props(source)} />)
    const timePill = view.getAllByRole('button')[0]!
    expect(timePill.textContent).toBe('1 turns 1 steps·20 tok/s')
    expect(timePill.getAttribute('aria-label')).toBe('1 turns 1 steps · 20 tok/s')
  })

  it('marks each pill with its dock entry id', () => {
    const { source } = makeSource({ nodes: [timedStep()] })
    const view = render(<StatsPills {...props(source)} />)
    const pills = [...view.container.querySelectorAll('[data-composer-stat]')]
    expect(pills.map(pill => [pill.getAttribute('data-composer-stat'), pill.textContent])).toEqual([
      ['activity', '1 turns 1 steps·20 tok/s'],
      ['usage', '105 tok·Cache hit 90%'],
    ])
  })

  it('click-opens the time-and-speed dialog carrying the time split and speeds', () => {
    const { source } = makeSource({ nodes: [timedStep()] })
    const view = render(<StatsPills {...props(source)} />)

    const timePill = view.getAllByRole('button')[0]!
    expect(timePill.getAttribute('aria-haspopup')).toBe('dialog')
    expect(timePill.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByRole('dialog')).toBeNull()

    fireEvent.click(timePill)
    expect(timePill.getAttribute('aria-expanded')).toBe('true')
    const dialog = view.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('Session statistics')
    // Portaled out of the composer dock.
    expect(dialog.parentElement).toBe(document.body)
    expect(dialog.firstChild?.textContent).toBe('Session statistics')
    const details = dialog.querySelector('[data-session-stats-details]') as HTMLElement
    expect(details).toBeTruthy()
    expect(details.textContent).toContain('LLM time3.8s')
    // No tool call in this session: the row is absent, not zeroed.
    expect(details.textContent).not.toContain('Tool time')
    expect(details.textContent).toContain('Avg time to first token (TTFT)0.8s')
    expect(details.textContent).toContain('Tokens per second (TPS)20 tok/s')
    expect(details.textContent).toContain('This turn TPS20 tok/s')
    // Token accounting lives on the usage pill's own dialog, not here.
    expect(dialog.textContent).not.toContain('Token usage')
  })

  it('shows the latest turn speed alongside the whole-session speed', () => {
    const previous: AssistantMessageNode = {
      ...assistant(1, 1, { outputTokens: 60 }),
      timing: { stepStartTime: 1_000, firstTokenTime: 2_000, completedTime: 5_000 },
    }
    const latest: AssistantMessageNode = {
      ...assistant(2, 2, { outputTokens: 20 }),
      timing: { stepStartTime: 6_000, firstTokenTime: 6_200, completedTime: 7_000 },
    }
    const { source } = makeSource({ nodes: [previous, latest] })
    const view = render(<StatsPills {...props(source)} />)
    const activityPill = view.getAllByRole('button')[0]!
    expect(activityPill.textContent).toContain('25 tok/s')
    expect(activityPill.textContent).not.toContain('20 tok/s')
    fireEvent.click(activityPill)
    const details = view.getByRole('dialog').querySelector('[data-session-stats-details]') as HTMLElement
    expect(details.textContent).toContain('This turn TPS25 tok/s')
  })

  it('compact keeps the latest turn speed rather than the whole-session speed', () => {
    const previous: AssistantMessageNode = {
      ...assistant(1, 1, { outputTokens: 60 }),
      timing: { stepStartTime: 1_000, firstTokenTime: 2_000, completedTime: 5_000 },
    }
    const latest: AssistantMessageNode = {
      ...assistant(2, 2, { outputTokens: 20 }),
      timing: { stepStartTime: 6_000, firstTokenTime: 6_200, completedTime: 7_000 },
    }
    const { source } = makeSource({ nodes: [previous, latest] })
    const view = render(<StatsPills {...props(source)} usePerformanceUsage={selector => selector('compact')} />)
    expect(view.container.textContent).toContain('25 tok/s')
    expect(view.container.textContent).not.toContain('20 tok/s')
  })

  it('uses the durable projection turn speed when the window has no timed nodes', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsPills {...props(source, {
      tokenUsage: USAGE,
      sessionStats: sessionStats({
        turns: 1, steps: 1, decodeMs: 3_000, decodeTokens: 60,
        lastTurnSpeedTurn: 1, lastTurnSpeedDecodeMs: 3_000, lastTurnSpeedDecodeTokens: 60,
      }),
    })} />)
    fireEvent.click(view.getAllByRole('button')[0]!)
    const details = view.getByRole('dialog').querySelector('[data-session-stats-details]') as HTMLElement
    expect(details.textContent).toContain('This turn TPS20 tok/s')
  })

  it('click-opens the token-usage dialog carrying the headline total and exact buckets', () => {
    const { source } = makeSource({ nodes: [timedStep()] })
    const view = render(<StatsPills {...props(source)} />)

    const usagePill = view.getAllByRole('button')[1]!
    fireEvent.click(usagePill)
    expect(usagePill.getAttribute('aria-expanded')).toBe('true')
    const dialog = view.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('Token usage')
    expect(dialog.parentElement).toBe(document.body)
    // Headline total: all prompt-side buckets (10 + 90 + 0) plus output (5).
    expect(dialog.firstChild?.textContent).toBe('Token usage105 tok')
    const tokens = dialog.querySelector('[data-session-stats-usage]') as HTMLElement
    expect(tokens).toBeTruthy()
    expect(tokens.textContent).toContain('Cache hit90%')
    expect(tokens.textContent).toContain('Uncached input10 tok')
    expect(tokens.textContent).toContain('Cached input90 tok')
    // A session that never wrote cache drops the row rather than showing 0.
    expect(tokens.textContent).not.toContain('Cache write')
    expect(tokens.textContent).toContain('Output5 tok')
    // The time split lives on the counts pill's own dialog, not here.
    expect(dialog.textContent).not.toContain('LLM time')
  })

  it('closes the dialog on Escape or an outside pointerdown', () => {
    const { source } = makeSource({ nodes: [timedStep()] })
    const view = render(<StatsPills {...props(source)} />)
    const timePill = view.getAllByRole('button')[0]!

    fireEvent.click(timePill)
    expect(view.queryByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(timePill.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(timePill)
    // A pointerdown inside the panel keeps it open; one outside closes it.
    fireEvent.pointerDown(view.getByRole('dialog'))
    expect(view.queryByRole('dialog')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('keeps at most one dialog open: a sibling pill click swaps, never stacks', () => {
    const { source } = makeSource({ nodes: [timedStep()] })
    const view = render(<StatsPills {...props(source)} />)
    const [timePill, usagePill] = [...view.getAllByRole('button')] as [HTMLElement, HTMLElement]

    fireEvent.click(timePill)
    expect(view.getByRole('dialog').getAttribute('aria-label')).toBe('Session statistics')
    // A sibling pill's pointerdown lands outside the open dialog and closes it.
    fireEvent.pointerDown(usagePill)
    fireEvent.click(usagePill)
    const dialogs = view.getAllByRole('dialog')
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]!.getAttribute('aria-label')).toBe('Token usage')
    expect(timePill.getAttribute('aria-expanded')).toBe('false')
    expect(usagePill.getAttribute('aria-expanded')).toBe('true')
  })

  it('swaps dialogs on keyboard activation of a sibling pill, which fires click without pointerdown', () => {
    const { source } = makeSource({ nodes: [timedStep()] })
    const view = render(<StatsPills {...props(source)} />)
    const [timePill, usagePill] = [...view.getAllByRole('button')] as [HTMLElement, HTMLElement]
    fireEvent.click(timePill)
    // A click inside the panel keeps it open; focus moving away does not close it.
    fireEvent.click(view.getByRole('dialog'))
    fireEvent.focusIn(usagePill)
    expect(view.getByRole('dialog').getAttribute('aria-label')).toBe('Session statistics')
    fireEvent.click(usagePill)
    const dialogs = view.getAllByRole('dialog')
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]!.getAttribute('aria-label')).toBe('Token usage')
  })

  it('takes every pill and dialog label from the active locale', () => {
    const { source } = makeSource({ nodes: [timedStep()] })
    const view = render(<StatsPills {...props(source, { tokenUsage: tokenUsage(9_995, 5) })} t={t} />)
    const [timePill, usagePill] = [...view.getAllByRole('button')] as [HTMLElement, HTMLElement]
    expect(timePill.textContent).toBe('1 轮 1 步·20 tok/s')
    // Whole-log total 9995 + 5 + 1 compacts to 10K.
    expect(usagePill.textContent).toBe('10K tok·缓存命中 99.95%')
    fireEvent.click(timePill)
    const timeDialog = view.getByRole('dialog')
    expect(timeDialog.getAttribute('aria-label')).toBe('会话统计')
    expect(timeDialog.textContent).toContain('模型用时3.8秒')
    expect(timeDialog.textContent).toContain('首 token 平均（TTFT）0.8秒')
    expect(timeDialog.textContent).toContain('输出速度（TPS）20 tok/s')
    expect(timeDialog.textContent).toContain('本轮输出速度20 tok/s')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(usagePill)
    const usageDialog = view.getByRole('dialog')
    expect(usageDialog.getAttribute('aria-label')).toBe('Token 用量')
    expect(usageDialog.textContent).toContain('未缓存输入5 tok')
  })

  it('keeps the durable usage pill after the visible step window is empty', () => {
    const { source } = makeSource()
    const view = render(<StatsPills {...props(source, {
      tokenUsage: USAGE,
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
    })} />)
    // Context occupancy lives on the composer's ContextMeter ring, not here.
    const pills = view.getAllByRole('button')
    expect(pills).toHaveLength(1)
    expect(pills[0]!.textContent).toBe('105 tok·Cache hit 90%')
  })

  it('drops the usage pill when no projection is composed', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsPills {...props(source, {})} />)
    expect(view.container.textContent).toBe('1 turns 1 steps')
    // The untimed window has no dialog rows either, so no button renders at all.
    expect(view.queryAllByRole('button')).toHaveLength(0)
  })

  it('shows the deferred read state instead of fabricating a token total from the window', () => {
    // Window nodes carry their own usage; billing still only rides the
    // tokenUsage projection, so an unavailable key must never become a total.
    const { source } = makeSource({ nodes: [timedStep(), assistant(2, 1, { inputTokens: 4, outputTokens: 6 })] })
    const loading = render(<StatsPills {...props(source, {}, { state: 'loading', reason: 'opening-absent' })} />)
    expect(loading.container.textContent).toContain('Loading token usage…')
    expect(loading.container.textContent).not.toContain('tok·')
    const unavailable = render(<StatsPills {...props(source, {}, { state: 'unavailable', reason: 'read-failed' })} />)
    expect(unavailable.container.textContent).toContain('Token usage unavailable')
    // Before any request an absent key stays invisible: sessionStats keeps the
    // window fallback on the activity pill, and no usage pill is invented.
    const beforeRequest = render(<StatsPills {...props(source, {}, BEFORE_REQUEST)} />)
    expect(beforeRequest.container.textContent).toContain('1 turns 2 steps')
    expect(beforeRequest.container.textContent).not.toContain('Token usage')
  })

  it('never presents a cached token total as exact before the deferred read completes', () => {
    // The window/list hints can carry tokenUsage before any exact cut exists.
    // It must stay a hint: no total and no cache-hit reading, only the deferred
    // read's state and an explicit affordance that requests the exact cut.
    const { source } = makeSource({ nodes: [timedStep()] })
    const requestExactProjections = vi.fn()
    const values = { tokenUsage: USAGE }
    const view = render(<StatsPills {...props(source, values, BEFORE_REQUEST, requestExactProjections)} />)
    expect(view.container.textContent).not.toContain('105 tok')
    expect(view.container.textContent).not.toContain('Cache hit 90%')
    fireEvent.click(view.getByRole('button', { name: 'Token usage unavailable' }))
    expect(requestExactProjections).toHaveBeenCalledTimes(1)

    view.rerender(<StatsPills {...props(source, values, { state: 'loading', reason: 'opening-absent' }, requestExactProjections)} />)
    expect(view.container.textContent).toContain('Loading token usage…')
    expect(view.container.textContent).not.toContain('105 tok')

    view.rerender(<StatsPills {...props(source, values, EXACT, requestExactProjections)} />)
    expect(view.container.textContent).toContain('105 tok')
    expect(view.container.textContent).toContain('Cache hit 90%')
  })

  it('requests exact whole-log values only when a user opens a statistics dialog', () => {
    const { source } = makeSource({ nodes: [timedStep()] })
    const requestExactProjections = vi.fn()
    const view = render(<StatsPills {...props(source, {}, BEFORE_REQUEST, requestExactProjections)} />)
    // Mounting the pill is not a request: the same composer keeps it mounted.
    expect(requestExactProjections).not.toHaveBeenCalled()
    fireEvent.click(view.getAllByRole('button')[0]!)
    expect(requestExactProjections).toHaveBeenCalledTimes(1)
    // Closing and reopening the same dialog is another explicit user action.
    fireEvent.click(view.getAllByRole('button')[0]!)
    fireEvent.click(view.getAllByRole('button')[0]!)
    expect(requestExactProjections).toHaveBeenCalledTimes(2)
  })

  it('renders whole-session counts from the sessionStats projection over the paged window', () => {
    // The bug's acceptance at unit level: one loaded page must not scope the
    // counter — the durable projection's totals win over the window fold.
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsPills {...props(source, {
      tokenUsage: USAGE,
      sessionStats: sessionStats({ turns: 10, steps: 89 }),
    })} />)
    expect(view.getByText('10 turns 89 steps')).toBeTruthy()
  })

  it('treats a defined zero-count projection as empty, not as fallback', () => {
    // A composed unit always serves the key; all-zero genuinely means no
    // closed step in the whole log, so nothing renders on a brand-new session.
    const empty = makeSource()
    const view = render(<StatsPills {...props(empty.source, {
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      sessionStats: sessionStats({}),
    })} />)
    expect(view.container.textContent).toBe('')
  })

  it('hides the usage pill when steps closed without any billed activity', () => {
    // A session whose only turn failed before billing (e.g. an auth error):
    // the counts pill renders alone, not an uninformative zero-token pill.
    const { source } = makeSource()
    const view = render(<StatsPills {...props(source, {
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      sessionStats: sessionStats({ turns: 1, steps: 1 }),
    })} />)
    expect(view.container.textContent).toBe('1 turns 1 steps')
    expect(view.queryAllByRole('button')).toHaveLength(0)
  })

  it('keeps the counts pill over an empty visible window when the projection carries totals', () => {
    // Extends the durable-groups guarantee: full-session counts survive a
    // window that compaction (or paging) left without assistant nodes.
    const { source } = makeSource()
    const view = render(<StatsPills {...props(source, {
      tokenUsage: USAGE,
      sessionStats: sessionStats({ turns: 7, steps: 44 }),
    })} />)
    expect(view.getByText('7 turns 44 steps')).toBeTruthy()
  })

  it('renders latest-turn pill speed and whole-log dialog figures from the projection', () => {
    // The 加载更早 hazard beyond counts: the pill's latest-turn segment and the
    // dialog's whole-log time split, TTFT, and throughput must not grow per
    // loaded page. An untimed 1-node window renders the projection's figures.
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsPills {...props(source, {
      tokenUsage: USAGE,
      sessionStats: sessionStats({
        turns: 200, steps: 200, llmMs: 100_000, toolMs: 62_000,
        ttftMs: 1_600, ttftSteps: 2, decodeMs: 3_000, decodeTokens: 60,
        lastTurnSpeedTurn: 200, lastTurnSpeedDecodeMs: 3_000, lastTurnSpeedDecodeTokens: 60,
      }),
    })} />)
    const timePill = view.getAllByRole('button')[0]!
    expect(timePill.textContent).toBe('200 turns 200 steps·20 tok/s')
    fireEvent.click(timePill)
    const dialog = view.getByRole('dialog')
    expect(dialog.textContent).toContain('LLM time1m40s')
    expect(dialog.textContent).toContain('Tool time1m2s')
    expect(dialog.textContent).toContain('Avg time to first token (TTFT)0.8s')
    expect(dialog.textContent).toContain('Tokens per second (TPS)20 tok/s')
  })

  it('omits the cache-hit segment when nothing was billed on the input side', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsPills {...props(source, {
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })} />)
    const usagePill = view.getAllByRole('button')[0]!
    expect(usagePill.textContent).toBe('7 tok')
    expect(usagePill.getAttribute('aria-label')).toBe('7 tok')
    // Output-only activity still fills the dialog's token rows.
    fireEvent.click(usagePill)
    expect(view.getByRole('dialog').textContent).toContain('Output7 tok')
  })

  it('includes cache writes in the total and the cache-hit denominator', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsPills {...props(source, {
      tokenUsage: {
        uncachedInputTokens: 10,
        outputTokens: 7,
        cacheReadTokens: 90,
        cacheWriteTokens: 100,
      },
    })} />)
    expect(view.getAllByRole('button')[0]!.textContent).toBe('207 tok·Cache hit 45%')
    // A session that did write cache keeps the row, exact.
    fireEvent.click(view.getAllByRole('button')[0]!)
    expect(view.getByRole('dialog').textContent).toContain('Cache write100 tok')
  })

  it('renders ZERO times during streaming chunk frames (RFC hard acceptance)', () => {
    const { set, source } = makeSource({ nodes: [assistant(1, 1)] })
    let renders = 0
    function Counting(p: StatPillProps) {
      renders += 1
      return <StatsPills {...p} />
    }
    render(<Counting {...props(source)} />)
    const before = renders
    // Chunk frames swap partial only; nodes keeps its reference (object-layer contract).
    act(() => { set({ partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text: 'a' }] } }) })
    act(() => { set({ partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text: 'ab' }] } }) })
    expect(renders).toBe(before)
  })
})
