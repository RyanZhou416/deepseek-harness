// StatsContext (src/client/components/statsContext.tsx) rendered with real
// React: the seven-cell grid — session shape with the whole-session
// human-input tally, the chat-line cache-hit cell with its whole-session
// share tip, the family-scope priced cost cell (current agent + subagents)
// with its per-model rate tooltip, and the subagents' own share — in both
// locales, against an injected model-price
// book (the store never reaches the network). The context-event tallies live
// on the events card's kind filters (contextView.spec.ts); `countsOfRecords`
// still derives every count the split generation's wire head carries, pinned
// here.

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi, beforeEach } from 'vitest'
import { countsOfRecords, makeStatsContext, makeSubagentCost } from '../../../src/client/components/statsContext'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import type { ContextEventRecord, ContextTimeline, RequestRecord, SessionCostUsage, TokenUsage } from '../../../src/shared/types'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { flush, makeKit, mount, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const kitZh = makeKit('zh')
const NO_SUB = (): SessionCostUsage | null => null
const StatsContext = makeStatsContext(kit, NO_SUB)
const StatsContextZh = makeStatsContext(kitZh, NO_SUB)

/** A minimal real-shaped slice of the models.dev /api.json payload. */
const PROVIDERS = {
  deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
  zhipuai: { models: { 'glm-5.3-flash': { cost: { input: 0.075, output: 0.25, cache_read: 0.015, cache_write: 0 } } } },
}

const COST: SessionCostUsage = {
  'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
}
// Prompt-side billed input 300 (100 uncached + 200 read) → hit 66.66% truncated.
const USAGE: TokenUsage = { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0 }

function req(turn?: number): RequestRecord {
  return {
    time: 0, seq: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0,
    ...(turn !== undefined ? { turn } : {}),
  }
}

function ev(kind: ContextEventRecord['kind']): ContextEventRecord {
  return { seq: 0, time: 0, kind }
}

function cells(container: HTMLElement): { labels: string[]; values: string[] } {
  const grid = queryAll(container, '.lc-stat')
  return {
    labels: grid.map(el => el.querySelector('.lc-stat-label')?.textContent ?? ''),
    values: grid.map(el => el.querySelector('.lc-stat-value')?.textContent ?? ''),
  }
}

beforeEach(() => {
  resetModelPrices()
  setModelPricesLoader(() => Promise.resolve(PROVIDERS))
})

afterEach(() => {
  resetModelPrices()
})

describe('countsOfRecords (the inline generation derivation)', () => {
  test('tallies distinct turns, records, and the three priced event kinds', () => {
    // Two steps in turn 1, one in turn 2, one without a turn (folds as turn 0).
    const counts = countsOfRecords(
      [req(1), req(1), req(2), req()],
      [ev('inject'), ev('inject'), ev('inject'), ev('compaction'), ev('compaction'), ev('prune'), ev('model'), ev('mode')],
    )
    // model/mode events do not appear (only the three priced kinds do).
    assert.deepEqual(counts, { turns: 3, steps: 4, injects: 3, compactions: 2, prunes: 1 })
  })

  test('empty collections tally zero', () => {
    assert.deepEqual(countsOfRecords([], []), { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 })
  })
})

describe('StatsContext', () => {
  test('folds the seven-cell grid: shape stats, the cache-hit cell, and the two cost cells', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 3, steps: 4, injects: 3, compactions: 2, prunes: 1 },
      humanInputs: 7,
      toolCalls: 3,
      usage: USAGE,
      cost: COST,
      locale: 'en',
    }))
    await flush()
    assert.ok(text(m.container).includes('Context Stats'))
    const { labels, values } = cells(m.container)
    assert.equal(labels.length, 7)
    assert.deepEqual(labels, ['Turns', 'Steps', 'Human Inputs?', 'Tool Calls', 'Cache Hit?', 'Cost?', 'Subagent Cost?'])
    // 1M uncached input at the book's $0.15 miss rate; no subagent usage → the sub cell dashes.
    assert.deepEqual(values, ['3', '4', '7', '3', '66.66%', '$0.15', '—'])
    await m.unmount()
  })

  test('absent counters, usage, and cost degrade to zeros and the dash', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      locale: 'en',
    }))
    await flush()
    assert.deepEqual(cells(m.container).values, ['0', '0', '0', '0', '—', '—', '—'])
    await m.unmount()
    // A usage report with nothing billed prompt-side dashes the hit too.
    const zero: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const m2 = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: zero,
      locale: 'en',
    }))
    await flush()
    assert.deepEqual(cells(m2.container).values, ['0', '0', '0', '0', '—', '—', '—'])
    await m2.unmount()
  })

  test('the cost bubble lists the billed models with their book rates', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: COST,
      locale: 'en',
    }))
    await flush()
    assert.equal(queryAll(m.container, '.lc-stat-tip').length, 4)
    assert.equal(queryAll(m.container, '.lc-stat-q').length, 4)
    const tips = queryAll(m.container, '.lc-stat-tip').map(el => text(el))
    assert.ok(tips[0].includes('question answerings'), 'the human-inputs tip explains its tally')
    assert.ok(tips[1].includes('Cumulative cache-read'), 'the cache-hit tip names the whole-session share')
    const costTip = tips[2]
    assert.ok(costTip.includes('this agent and all its subagents'), 'the cost tip names the family scope')
    assert.ok(costTip.includes('Per-1M-token rates:'))
    assert.ok(costTip.includes('deepseek-v4-flash'))
    assert.ok(costTip.includes('hit $0.003'))
    assert.ok(costTip.includes('miss $0.15'))
    assert.ok(costTip.includes('write $0.15'))
    assert.ok(costTip.includes('output $0.6'))
    assert.ok(costTip.includes('peak windows'), 'a DeepSeek session explains the peak/off-peak scheme')
    assert.ok(!costTip.includes('peak|off-peak'), 'a peak-only session needs no pair header')
    assert.ok(tips[3].includes('every subagent session'), 'the sub cell explains its own scope')
    await m.unmount()
  })

  test('a non-DeepSeek session never sees DeepSeek-specific notes', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: { 'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      locale: 'en',
    }))
    await flush()
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[2])
    assert.ok(costTip.includes('glm-5.3-flash'))
    assert.ok(!costTip.includes('DeepSeek'), 'the DeepSeek scheme note stays out of other providers’ bubbles')
    await m.unmount()
  })

  test('a multi-provider session names the provider on each model row', async () => {
    const two: SessionCostUsage = {
      'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: two,
      locale: 'en',
    }))
    await flush()
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[2])
    assert.ok(costTip.includes('deepseek-v4-flash · deepseek-official'))
    assert.ok(costTip.includes('glm-5.3-flash · zai-coding-cn'))
    // 1M × $0.15 + 2M × $0.075 = $0.30.
    assert.ok(cells(m.container).values.at(-2) === '$0.30')
    await m.unmount()
  })

  test('the zh locale localizes labels and prices the cost in CNY at 1 CNY = 0.15 USD', async () => {
    const m = await mount(h(StatsContextZh, {
      counts: { turns: 1, steps: 1, injects: 0, compactions: 1, prunes: 0 },
      usage: USAGE,
      cost: COST,
      locale: 'zh',
    }))
    await flush()
    assert.ok(text(m.container).includes('上下文统计'))
    const { labels, values } = cells(m.container)
    assert.deepEqual(labels, ['轮次', '步数', '用户输入?', '工具调用', '缓存命中?', '费用?', '子 Agent 费用?'])
    // $0.15 / 0.15 = ¥1; the rates convert through the same fixed rate.
    assert.deepEqual(values, ['1', '1', '0', '0', '66.66%', '¥1.00', '—'])
    assert.ok(text(queryAll(m.container, '.lc-stat-tip')[1]).includes('整个会话累计'), 'the cache-hit tip localizes too')
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[2])
    assert.ok(costTip.includes('当前 Agent 与其所有子 Agent'), 'the cost tip names the family scope too')
    assert.ok(costTip.includes('每百万 tokens 价格'))
    assert.ok(costTip.includes('命中 ¥0.02'))
    assert.ok(costTip.includes('未命中 ¥1'))
    assert.ok(costTip.includes('写入 ¥1'))
    assert.ok(costTip.includes('输出 ¥4'))
    assert.ok(text(queryAll(m.container, '.lc-stat-tip')[3]).includes('子 Agent 会话'), 'the sub tip localizes too')
    await m.unmount()
  })

  test('usage with no book yet stays a dash until the fetch lands', async () => {
    setModelPricesLoader(() => new Promise(() => {}))
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: USAGE,
      cost: COST,
      locale: 'en',
    }))
    await flush()
    assert.ok(cells(m.container).values.at(-2) === '—')
    assert.ok(!text(m.container).includes('unavailable'), 'a pending fetch is not a failure')
    await m.unmount()
  })

  test('a failed price fetch dashes the cell and notes the outage in the tip', async () => {
    setModelPricesLoader(() => Promise.reject(new Error('down')))
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: USAGE,
      cost: COST,
      locale: 'en',
    }))
    await flush()
    assert.ok(cells(m.container).values.at(-2) === '—')
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[2])
    assert.ok(costTip.includes('unavailable'))
    assert.ok(!costTip.includes('Per-1M-token rates'))
    await m.unmount()
  })

  test('a DeepSeek off-peak bucket prices at half and the tooltip shows the peak|off pair', async () => {
    const split: SessionCostUsage = {
      'deepseek-official': {
        'deepseek-v4-flash': {
          peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
          off: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
        },
      },
    }
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: split,
      locale: 'en',
    }))
    await flush()
    // 1M at the $0.15 peak miss rate + 2M at the $0.075 half-price rate.
    assert.ok(cells(m.container).values.at(-2) === '$0.30')
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[2])
    assert.ok(costTip.includes('Per-1M-token rates (peak|off-peak)'), 'an off-peak bucket names the pair in the header')
    assert.ok(costTip.includes('hit $0.003|$0.0015'))
    assert.ok(costTip.includes('miss $0.15|$0.075'))
    assert.ok(costTip.includes('write $0.15|$0.075'))
    assert.ok(costTip.includes('output $0.6|$0.3'))
    await m.unmount()
  })

  test('a session whose models the book cannot price notes the outage too', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: USAGE,
      cost: { 'future-provider': { 'mystery-model': { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      locale: 'en',
    }))
    await flush()
    assert.ok(cells(m.container).values.at(-2) === '—')
    assert.ok(text(queryAll(m.container, '.lc-stat-tip')[2]).includes('unavailable'))
    await m.unmount()
  })

  test('a hostile cost branch is skipped by the tooltip rows, not fatal', async () => {
    const hostile = {
      junk: 5,
      'zai-coding-cn': {
        'glm-5.3-flash': {
          peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
          off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
        },
      },
    } as unknown as SessionCostUsage
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: USAGE,
      cost: hostile,
      locale: 'en',
    }))
    await flush()
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[2])
    assert.ok(costTip.includes('glm-5.3-flash'))
    assert.ok(!costTip.includes('junk'))
    // No row may show the peak|off-peak pair — that is DeepSeek's alone.
    const rows = queryAll(m.container, '.lc-stat-tip-row').map(el => text(el))
    assert.ok(rows.every(r => !r.includes('|')))
    // Both buckets bill at list price: 2M × $0.075 — no half-price off-peak.
    assert.ok(cells(m.container).values.at(-2) === '$0.15')
    await m.unmount()
  })
})

describe('StatsContext — the subagent-cost cell (injected seat)', () => {
  const SUB: SessionCostUsage = {
    'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
  }

  test('the cost cell merges the subagent usage in; the sub cell prices the share alone', async () => {
    const Stats = makeStatsContext(kit, () => SUB)
    const m = await mount(h(Stats, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: COST,
      locale: 'en',
    }))
    await flush()
    // Family total: 1M × $0.15 + 2M × $0.075; the subagents' share: $0.15.
    assert.deepEqual(cells(m.container).values.slice(-2), ['$0.30', '$0.15'])
    const tips = queryAll(m.container, '.lc-stat-tip').map(el => text(el))
    // The cost tip's rate table covers BOTH sides' models; the sub tip names its scope only.
    assert.ok(tips[2].includes('deepseek-v4-flash'))
    assert.ok(tips[2].includes('glm-5.3-flash'))
    assert.ok(tips[3].includes('every subagent session'))
    assert.ok(!tips[3].includes('Per-1M-token rates'))
    await m.unmount()
  })

  test('subagent usage alone (no own cost) still prices both cells', async () => {
    const Stats = makeStatsContext(kit, () => SUB)
    const m = await mount(h(Stats, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      locale: 'en',
    }))
    await flush()
    assert.deepEqual(cells(m.container).values.slice(-2), ['$0.15', '$0.15'])
    await m.unmount()
  })

  test('a DeepSeek-billing subagent surfaces the peak/off-peak note under both tips', async () => {
    const deepseekSub: SessionCostUsage = {
      'deepseek-official': { 'deepseek-v4-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const Stats = makeStatsContext(kit, () => deepseekSub)
    const m = await mount(h(Stats, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      locale: 'en',
    }))
    await flush()
    // Half-price off-peak: 1M × $0.075.
    assert.deepEqual(cells(m.container).values.slice(-2), ['$0.075', '$0.075'])
    const tips = queryAll(m.container, '.lc-stat-tip').map(el => text(el))
    assert.ok(tips[2].includes('peak windows'))
    assert.ok(tips[2].includes('peak|off-peak'), 'the off-peak bucket names the pair in the header')
    assert.ok(tips[3].includes('peak windows'), 'the sub tip explains the scheme its own figure rides')
    await m.unmount()
  })

  test('a sub usage the book cannot price dashes the cell and notes the outage in its tip', async () => {
    const Stats = makeStatsContext(kit, () => ({ future: { 'mystery-model': { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } }))
    const m = await mount(h(Stats, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: COST,
      locale: 'en',
    }))
    await flush()
    // The family's own model still prices: $0.15. The unpriceable sub branch
    // merges in (pricing zero) but cannot lift the total — the sub cell dashes.
    assert.deepEqual(cells(m.container).values.slice(-2), ['$0.15', '—'])
    const tips = queryAll(m.container, '.lc-stat-tip').map(el => text(el))
    assert.ok(tips[3].includes('unavailable'))
    await m.unmount()
  })

  test('a null seat keeps both cells dashed with no outage notes', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      locale: 'en',
    }))
    await flush()
    assert.deepEqual(cells(m.container).values.slice(-2), ['—', '—'])
    assert.ok(!text(m.container).includes('unavailable'))
    await m.unmount()
  })
})

describe('StatsContext — the real subagent-cost seat (makeSubagentCost)', () => {
  /** A well-formed slim head with (or without) a cost usage. */
  function head(cost?: SessionCostUsage): ContextTimeline {
    return {
      ok: true,
      contextWindow: 1000,
      current: { system: 10, tools: 10, user: 80, inject: 0, skill: 0, assistant: 0, tool: 0, total: 100 },
      requests: [],
      events: [],
      nodes: [],
      droppedNodes: 0,
      archive: [],
      ...(cost !== undefined ? { cost } : {}),
    }
  }

  /** A sessions face double with the list-feed contract (agentGraph.spec's shape). */
  class FakeSessions {
    private listeners = new Set<() => void>()
    state: unknown
    constructor(byId: Record<string, unknown>) {
      this.state = { byId }
    }
    readonly list = {
      getSnapshot: (): unknown => this.state,
      subscribe: (fn: () => void): (() => void) => {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
    }
    setState(byId: Record<string, unknown>): void {
      this.state = { byId }
      for (const fn of this.listeners) fn()
    }
  }

  function makeSeat(byId: Record<string, unknown>): { seat: (sessionId: string | undefined) => SessionCostUsage | null; face: FakeSessions } {
    const face = new FakeSessions(byId)
    const ctx = new TestClientCtx({ services: { sessions: face } })
    return { seat: makeSubagentCost(asClientCtx(ctx), makeAgentHeads(asClientCtx(ctx))), face }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('warm rows fold live; cold rows fetch once and land; snapshot ticks never refetch', async () => {
    const calls: string[] = []
    let release: ((value: unknown) => void) | undefined
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(String((JSON.parse(String(init?.body)) as { sessionId?: unknown }).sessionId))
      // Hold the read until the warm-only paint is asserted.
      return await new Promise((resolve) => { release = resolve })
    })
    const SUB_WARM: SessionCostUsage = {
      'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const { seat, face } = makeSeat({
      root: { running: false, updatedAt: 1 },
      warm: { parentId: 'root', updatedAt: 2, projectionValues: { contextTimeline: head(SUB_WARM) } },
      cold: { parentId: 'root', updatedAt: 3 },
    })
    const Stats = makeStatsContext(kit, seat)
    const m = await mount(h(Stats, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      locale: 'en',
      sessionId: 'root',
    }))
    await flush()
    // The warm row's usage prices while the cold read is still in flight.
    assert.deepEqual(cells(m.container).values.slice(-2), ['$0.15', '$0.15'])
    assert.deepEqual(calls, ['cold'], 'only the timeline-less relative fetched')
    // A snapshot tick while the read is in flight re-attaches the SAME
    // pending read; when it lands, the duplicate settle bails on identity.
    await act(async () => {
      face.setState({
        root: { running: false, updatedAt: 1 },
        warm: { parentId: 'root', updatedAt: 2, projectionValues: { contextTimeline: head(SUB_WARM) } },
        cold: { parentId: 'root', updatedAt: 3 },
      })
    })
    await flush()
    // The cold read lands: its $0.15 merges into both cells.
    await act(async () => {
      release?.({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          value: {
            rev: 1,
            head: head({ 'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } }),
            requests: [],
            events: [],
            nodes: [],
            droppedNodes: 0,
            archive: [],
          },
        }),
      })
    })
    await flush()
    assert.deepEqual(cells(m.container).values.slice(-2), ['$0.30', '$0.30'])
    await m.unmount()
  })

  test('a failing cold fetch degrades the cell without crashing or retrying', async () => {    const calls: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(String((JSON.parse(String(init?.body)) as { sessionId?: unknown }).sessionId))
      throw new Error('transport down')
    })
    const { seat, face } = makeSeat({
      root: { running: false, updatedAt: 1 },
      cold: { parentId: 'root', updatedAt: 2 },
    })
    const Stats = makeStatsContext(kit, seat)
    const m = await mount(h(Stats, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      locale: 'en',
      sessionId: 'root',
    }))
    await flush()
    assert.deepEqual(calls, ['cold'])
    assert.ok(cells(m.container).values.at(-2) === '—')
    // A later snapshot tick re-folds the subtree; the sticky failure never re-fetches.
    await act(async () => {
      face.setState({ root: { running: false, updatedAt: 1 }, cold: { parentId: 'root', updatedAt: 2 } })
    })
    await flush()
    assert.deepEqual(calls, ['cold'])
    await m.unmount()
  })

  test('a headless detail answer (or a null value) lands nothing and never retries', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(String((JSON.parse(String(init?.body)) as { sessionId?: unknown }).sessionId))
      // The head is optional on the payload; a null value answers absence.
      const headless = { rev: 1, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [] }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: calls.length === 1 ? headless : null }),
      }
    })
    const { seat, face } = makeSeat({
      root: { running: false, updatedAt: 1 },
      headless: { parentId: 'root', updatedAt: 2 },
      absent: { parentId: 'root', updatedAt: 3 },
    })
    const Stats = makeStatsContext(kit, seat)
    const m = await mount(h(Stats, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      locale: 'en',
      sessionId: 'root',
    }))
    await flush()
    assert.deepEqual(calls, ['headless', 'absent'])
    // Neither read carried a head: nothing lands, the cells stay dashes, no throw.
    assert.ok(cells(m.container).values.slice(-2).every(v => v === '—'))
    // A later tick re-attaches to the settled nulls without re-fetching.
    await act(async () => {
      face.setState({
        root: { running: false, updatedAt: 1 },
        headless: { parentId: 'root', updatedAt: 2 },
        absent: { parentId: 'root', updatedAt: 3 },
      })
    })
    await flush()
    assert.deepEqual(calls, ['headless', 'absent'])
    await m.unmount()
  })

  test('without the sessions face the seat prices nothing', async () => {
    const ctx = new TestClientCtx()
    const Stats = makeStatsContext(kit, makeSubagentCost(asClientCtx(ctx), makeAgentHeads(asClientCtx(ctx))))
    const m = await mount(h(Stats, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      locale: 'en',
      sessionId: 'root',
    }))
    await flush()
    assert.deepEqual(cells(m.container).values.slice(-2), ['—', '—'])
    await m.unmount()
  })

  test('an absent session id folds nothing (and fetches nothing)', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(String((JSON.parse(String(init?.body)) as { sessionId?: unknown }).sessionId))
      throw new Error('must not fetch')
    })
    const face = new FakeSessions({ root: { running: false, updatedAt: 1 }, kid: { parentId: 'root', updatedAt: 2 } })
    const ctx = new TestClientCtx({ services: { sessions: face } })
    const Stats = makeStatsContext(kit, makeSubagentCost(asClientCtx(ctx), makeAgentHeads(asClientCtx(ctx))))
    const m = await mount(h(Stats, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      locale: 'en',
    }))
    await flush()
    assert.deepEqual(calls, [])
    assert.deepEqual(cells(m.container).values.slice(-2), ['—', '—'])
    await m.unmount()
  })
})
