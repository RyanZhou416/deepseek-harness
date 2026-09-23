// revealScroll (src/client/revealScroll.ts) — the jump's landing reveal,
// driven against real jsdom DOM: the nearest scrollable ancestor takes the
// rect-delta scroll, the walk stops at body/null, hostile chains never throw.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { revealInScrollParent } from '../../src/client/revealScroll'

/** A viewport rect carrying only the top the reveal reads. */
const top = (t: number): DOMRect => ({ top: t }) as DOMRect

/** An overflow-styled scroller holding the anchor, with stubbed viewport tops. */
function mounted(oy: 'auto' | 'scroll', scrollerTop: number, anchorTop: number): { scroller: HTMLDivElement; anchor: HTMLDivElement } {
  const scroller = document.createElement('div')
  scroller.style.overflowY = oy
  scroller.getBoundingClientRect = () => top(scrollerTop)
  const anchor = document.createElement('div')
  anchor.getBoundingClientRect = () => top(anchorTop)
  scroller.appendChild(anchor)
  document.body.appendChild(scroller)
  return { scroller, anchor }
}

describe('revealInScrollParent', () => {
  test("scrolls the nearest 'auto' ancestor so the anchor tops its scrollport", () => {
    const { scroller, anchor } = mounted('auto', 100, 450)
    scroller.scrollTop = 42
    assert.equal(revealInScrollParent(anchor), true)
    assert.equal(scroller.scrollTop, 392, 'the rect delta lands the anchor flush: 42 + (450 − 100)')
    scroller.remove()
  })

  test("an overflow-y 'scroll' ancestor is taken the same way", () => {
    const { scroller, anchor } = mounted('scroll', 0, 200)
    assert.equal(revealInScrollParent(anchor), true)
    assert.equal(scroller.scrollTop, 200)
    scroller.remove()
  })

  test('a plain ancestor chain to body scrolls nothing and reports false', () => {
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    assert.equal(revealInScrollParent(anchor), false)
    anchor.remove()
  })

  test('a detached anchor bottoms out at the null parent: false', () => {
    assert.equal(revealInScrollParent(document.createElement('div')), false)
  })

  test('a hostile chain never throws', () => {
    const hostile = {
      get parentElement(): never { throw new Error('boom') },
    } as unknown as Element
    assert.equal(revealInScrollParent(hostile), false)
  })
})
