import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { requestContextFocus, takeContextFocus } from '../../../src/client/viewFocus'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx } from '../helpers/harness'
import { mount, query, queryAll, text } from '../helpers/kit'
import { buttonByText, makeView, mountInScroller, mountRich, projectionsFor, richTimeline, timeline } from './contextViewHarness'

describe('ContextView — chat→Context jump', () => {
  test('the relay flips the chart to turn bars, pins the reply\'s turn, and consumes itself', async () => {
    // The clicked reply closed turn 1: its request seq (4) is that turn's LAST step — exactly the aggregate's record.
    requestContextFocus('sv-jump', 4)
    const m = await mountRich('sv-jump')
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'), 'granularity flips to turn')
    assert.equal(queryAll(m.container, '.lc-bar').length, 2, 'the chart renders turn aggregates')
    assert.ok(query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'the reply\'s turn bar is pinned')
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4')
    assert.equal(takeContextFocus('sv-jump'), null, 'the relay is one-shot')
    await m.unmount()
  })

  test('no session id: the relay stays pending — the loading view never takes it', async () => {
    requestContextFocus('sv-jumpnone', 4)
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: '', useProjection: () => undefined }))
    assert.ok(text(m.container).includes(DICT_EN.loading))
    await m.unmount()
    assert.equal(takeContextFocus('sv-jumpnone'), 4, 'an absent session id skips leg 1')
    takeContextFocus('sv-jumpnone')
  })

  test('an empty history consumes the relay and pins nothing', async () => {
    requestContextFocus('sv-jumpempty', 4)
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-jumpempty', useProjection: projectionsFor(timeline()) }))
    assert.equal(queryAll(m.container, '.lc-bar').length, 0)
    assert.equal(takeContextFocus('sv-jumpempty'), null)
    await m.unmount()
  })

  test('a turn-less reply routes to the turn-0 bar', async () => {
    // The trailing turn-less step: its group key derives to 0, the ?? 0 arm.
    requestContextFocus('sv-jump0', 6)
    const m = await mountRich('sv-jump0')
    assert.ok(query(m.container, '.lc-bar[data-seq="6"]').className.includes('lc-bar-selected'))
    assert.equal(takeContextFocus('sv-jump0'), null)
    await m.unmount()
  })

  test('a record landing after mount re-pins the mounted view (the sidebar repeat jump)', async () => {
    const m = await mountRich('sv-rejump')
    assert.ok(!query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'nothing pinned at mount')
    // The sidebar landing keeps this view mounted; a later jump must re-pin it.
    await act(async () => { requestContextFocus('sv-rejump', 4) })
    assert.ok(query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'the later record re-pins')
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4')
    assert.equal(takeContextFocus('sv-rejump'), null, 'the record was consumed')
    await m.unmount()
  })

  test('the jump reveals the Current Composition card even over a restored position', async () => {
    const View = makeView(new TestClientCtx())
    const props = { sessionId: 'sv-jumpscroll', useProjection: projectionsFor(richTimeline()) }

    const scroller1 = document.createElement('div')
    scroller1.setAttribute('data-conversation-scroll', '')
    const m1 = await mountInScroller(h(View, props), scroller1)
    scroller1.scrollTop = 42
    await m1.unmount()

    // jsdom lays out nothing: give the scroller and the composition card fixed
    // viewport tops so the reveal's rect delta is deterministic (450 − 100).
    const gBCR = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const top = this.hasAttribute('data-conversation-scroll') ? 100
        : this.hasAttribute('data-lc-current') ? 450 : 0
      return { top } as DOMRect
    })

    // The jump remount: restore applies 42, then the jump resolves and the
    // reveal scrolls the composition card to the scrollport's top (42 + 350).
    // jsdom reports 0 for both — the scroller must overflow to be operative.
    requestContextFocus('sv-jumpscroll', 4)
    const scroller2 = document.createElement('div')
    scroller2.setAttribute('data-conversation-scroll', '')
    scroller2.style.overflowY = 'auto'
    Object.defineProperty(scroller2, 'scrollHeight', { value: 800 })
    Object.defineProperty(scroller2, 'clientHeight', { value: 300 })
    const m2 = await mountInScroller(h(View, props), scroller2)
    assert.equal(scroller2.scrollTop, 392, 'restore(42) overridden by the card reveal delta(350)')
    assert.ok(query(m2.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'))
    await m2.unmount()
    gBCR.mockRestore()
  })
})
