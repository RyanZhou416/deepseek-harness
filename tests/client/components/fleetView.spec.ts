import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeFleetView } from '../../../src/client/components/fleetView'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { DICT_EN } from '../../../src/client/i18n'
import { resetTimelineDetailStores } from '../../../src/client/timelineSource'
import { requestFleetMemberFocus, currentFleetMemberFocus } from '../../../src/client/viewFocus'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, makeKit, mount, query, queryAll, text, until } from '../helpers/kit'
import { makeScroller, mountInScroller, projectionsFor, richTimeline, timeline } from './contextViewHarness'

const kit = makeKit()

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetTimelineDetailStores()
})

function selfOnly(id: string) {
  const snapshot = { byId: { [id]: { displayTitle: 'Main Agent', running: false, blank: false, updatedAt: 1 } } }
  return { list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} } }
}

function makeView(ctx: TestClientCtx) {
  return makeFleetView(asClientCtx(ctx), kit, makeAgentHeads())
}

const TIMING = { wallMs: 387_000, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} }

describe('FleetView — the agent family on its own page', () => {
  test("the card renders off the tab's own projections, footer note included", async () => {
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-fleet') } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-fleet', useProjection: projectionsFor(richTimeline({ timing: TIMING })) }))

    assert.ok(text(query(m.container, '.lc-agents')).includes('Agent Network'))
    const self = query(m.container, '.lc-agent-card.lc-agent-self')
    assert.ok(text(self).includes('Main Agent'))
    assert.equal(query(self, '.lc-agent-meta-text').textContent, '6m27s · 3 steps')
    assert.ok(text(query(m.container, '.lc-foot')).startsWith(DICT_EN['footer'].slice(0, 24)))
    await m.unmount()
    ctx.dispose()

    vi.stubGlobal('fetch', () => new Promise(() => {}))
    const slimCtx = new TestClientCtx({ services: { sessions: selfOnly('sv-slim') } })
    const SlimView = makeView(slimCtx)
    const slim = await mount(h(SlimView, {
      sessionId: 'sv-slim',
      useProjection: projectionsFor(timeline({
        contextWindow: 128000,
        counts: { turns: 1, steps: 3, injects: 0, compactions: 0, prunes: 0 },
        last: { seq: 6, total: 420, prompt: 410 },
        detailRev: 6,
      })),
    }))
    assert.equal(query(query(slim.container, '.lc-agent-card.lc-agent-self'), '.lc-agent-meta-text').textContent, '3 steps', 'the slim head counts the steps itself')
    assert.ok(!text(slim.container).includes(DICT_EN['detail.loading']), 'no waiting state once the head is served')
    await slim.unmount()
    slimCtx.dispose()
  })

  test('a cold session names its retryable read instead of spinning', async () => {
    let reads = 0
    let release!: () => void
    vi.stubGlobal('fetch', () => {
      reads += 1
      if (reads === 1) return new Promise(res => { release = () => { res({ ok: false, status: 503 } as Response) } })
      return Promise.resolve({ ok: false, status: 503 } as Response)
    })
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-cold') } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-cold', useProjection: () => undefined }))

    assert.equal(query(m.container, '.lc-empty').textContent, DICT_EN['loading'], 'first paint names the read')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    await act(async () => { release() })
    await until(() => text(m.container).includes(DICT_EN['detail.loadFailed']), 'the failure never surfaced')
    const before = reads
    await click(query(m.container, '.lc-br-retry'))
    await until(() => reads > before, 'the retry never refired the read')
    assert.ok(text(m.container).includes(DICT_EN['detail.loadFailed']))
    await m.unmount()
    ctx.dispose()
  })

  test('the baseline gate rides the Fleet tab too', async () => {
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-gate') } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-gate', useProjection: projectionsFor(timeline({ unsupported: { current: '0.1.0', minimum: '0.2.0-rc.2' } })), }))

    assert.ok(query(m.container, '.lc-gate-card') !== null, 'the gate names the unsupported harness here as well')
    await m.unmount()
    ctx.dispose()
  })

  test('without a session id the page still paints and the card stays hidden', async () => {
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-none') } })
    const View = makeView(ctx)
    const m = await mount(h(View, { useProjection: projectionsFor(timeline()) }))

    assert.equal(queryAll(m.container, '.lc-agents').length, 0)
    assert.ok(text(query(m.container, '.lc-foot')).startsWith(DICT_EN['footer'].slice(0, 24)))
    await m.unmount()
    ctx.dispose()
  })

  test('a relayed member pick lights that member card', async () => {
    const id = 'sv-fleet-pick'
    const snapshot = {
      byId: {
        [id]: { displayTitle: 'Main Agent', running: true, updatedAt: 10, projectionValues: { contextTimeline: richTimeline() } },
        worker: { parentId: id, origin: 'subagent', running: true, updatedAt: 8, projectionValues: { contextTimeline: richTimeline(), subagent: { mode: 'continuable', label: 'worker-bee' } } },
      },
    }
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: id, useProjection: projectionsFor(richTimeline({ timing: TIMING })) }))
    await act(async () => { requestFleetMemberFocus(id, 'worker') })
    await until(() => query(m.container, '[data-agent="worker"]').classList.contains('lc-agent-hover'), 'the relay never lit the member')
    assert.equal(currentFleetMemberFocus(id), 'worker', 'the resting pick is shared')
    await m.unmount()
    ctx.dispose()
  })
})

describe('FleetView — the shared scrollport claim', () => {
  test("mount lands at the top: the chat's bottom-anchored scrollTop does not survive the tab switch or a remount", async () => {
    const props = { sessionId: 'sv-fleet', useProjection: projectionsFor(richTimeline({ timing: TIMING })) }
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-fleet') } })
    const View = makeView(ctx)
    const scroller = makeScroller()
    scroller.scrollTop = 3491
    const m = await mountInScroller(h(View, props), scroller)
    assert.equal(scroller.scrollTop, 0, 'the inherited position reset pre-paint')
    scroller.scrollTop = 120
    await m.unmount()

    const next = makeScroller()
    next.scrollTop = 55
    const remounted = await mountInScroller(h(View, props), next)
    assert.equal(next.scrollTop, 0, 'the page is a dashboard: it opens at its top again')
    await remounted.unmount()

    const switched = makeScroller()
    const switchView = await mountInScroller(
      h(View, { sessionId: 'sv-fleet', useProjection: projectionsFor(richTimeline({ timing: TIMING })) }),
      switched,
    )
    switched.scrollTop = 300
    await switchView.update(h(View, { sessionId: 'sv-other', useProjection: projectionsFor(richTimeline({ timing: TIMING })) }))
    assert.equal(switched.scrollTop, 0, 'a session switch re-claims the top')
    await switchView.unmount()
    ctx.dispose()
  })

})
