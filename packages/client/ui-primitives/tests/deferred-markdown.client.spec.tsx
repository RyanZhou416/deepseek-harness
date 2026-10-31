// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recheckDeferredMarkdown } from '../src/markdown/useDeferredMarkdown.ts'
import { MarkdownText } from './markdown-test-components.tsx'

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = []

  readonly root = null
  readonly rootMargin = '0px'
  readonly scrollMargin = '0px'
  readonly thresholds: readonly number[] = [0]
  readonly observed = new Set<Element>()
  readonly unobserved = new Set<Element>()
  disconnected = false

  constructor(private readonly callback: IntersectionObserverCallback) {
    IntersectionObserverStub.instances.push(this)
  }

  observe(element: Element): void {
    this.observed.add(element)
  }

  unobserve(element: Element): void {
    this.observed.delete(element)
    this.unobserved.add(element)
  }

  disconnect(): void {
    this.disconnected = true
    this.observed.clear()
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  intersect(element: Element, isIntersecting: boolean): void {
    this.callback([{ target: element, isIntersecting } as IntersectionObserverEntry], this)
  }
}

/** jsdom viewport height, used to place sample boxes above or below it. */
const VIEWPORT_HEIGHT = 768
const SOURCE = '**bold** and `code`'
const PARSED = 'bold and code'

beforeEach(() => {
  IntersectionObserverStub.instances = []
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Place every measured box at one vertical position with a fixed height. */
function stubBoxTop(top: number): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 600, 200))
}

describe('viewport-deferred MarkdownText', () => {
  it('keeps an offscreen settled block as searchable plain text until it intersects', async () => {
    stubBoxTop(VIEWPORT_HEIGHT * 4)
    const view = render(<MarkdownText text={SOURCE} deferOffscreen />)
    const block = view.container.querySelector('[data-deferred]')
    expect(block?.textContent).toBe(SOURCE)
    expect(view.container.querySelector('strong')).toBeNull()

    const observer = IntersectionObserverStub.instances[0]!
    expect([...observer.observed]).toEqual([block])
    act(() => { observer.intersect(block!, false) })
    expect(view.container.querySelector('strong')).toBeNull()

    act(() => { observer.intersect(block!, true) })
    await waitFor(() => { expect(view.container.querySelector('strong')).not.toBeNull() })
    expect(view.container.querySelector('[data-deferred]')).toBeNull()
    expect(view.container.textContent).toBe(PARSED)
    expect(observer.unobserved.has(block!)).toBe(true)
  })

  it('parses before paint when the block already sits inside the activation margin', () => {
    stubBoxTop(VIEWPORT_HEIGHT * 2 + 100)
    const view = render(<MarkdownText text={SOURCE} deferOffscreen />)
    expect(view.container.querySelector('strong')).not.toBeNull()
    expect(IntersectionObserverStub.instances).toHaveLength(0)
  })

  it('defers a block that sits above the activation margin', () => {
    stubBoxTop(-VIEWPORT_HEIGHT * 4)
    const view = render(<MarkdownText text={SOURCE} deferOffscreen />)
    expect(view.container.querySelector('[data-deferred]')).not.toBeNull()
    expect(IntersectionObserverStub.instances[0]?.observed.size).toBe(1)
  })

  it('never defers a streaming reply and defers it once it settles offscreen', () => {
    stubBoxTop(VIEWPORT_HEIGHT * 4)
    const view = render(<MarkdownText text={'**bold**'} streaming deferOffscreen />)
    expect(view.container.querySelector('strong')).not.toBeNull()
    expect(IntersectionObserverStub.instances).toHaveLength(0)

    view.rerender(<MarkdownText text={'**bold**'} deferOffscreen />)
    expect(view.container.querySelector('strong')).toBeNull()
    expect(view.container.querySelector('[data-deferred]')?.textContent).toBe('**bold**')
    expect(IntersectionObserverStub.instances[0]?.observed.size).toBe(1)
  })

  it('leaves an unmeasurable box to the observer', async () => {
    const view = render(<MarkdownText text={SOURCE} deferOffscreen />)
    const block = view.container.querySelector('[data-deferred]')
    const observer = IntersectionObserverStub.instances[0]!
    expect([...observer.observed]).toEqual([block])

    act(() => { observer.intersect(block!, true) })
    await waitFor(() => { expect(view.container.querySelector('strong')).not.toBeNull() })
  })

  it('resolves deferred blocks after an imperative landing', () => {
    stubBoxTop(VIEWPORT_HEIGHT * 4)
    const view = render(
      <>
        <MarkdownText text={'**first**'} deferOffscreen />
        <MarkdownText text={'**second**'} deferOffscreen />
      </>,
    )
    expect(view.container.querySelectorAll('[data-deferred]')).toHaveLength(2)

    // A block still outside the margin stays deferred and registered.
    recheckDeferredMarkdown()
    expect(view.container.querySelectorAll('[data-deferred]')).toHaveLength(2)
    expect(IntersectionObserverStub.instances[0]?.observed.size).toBe(2)

    stubBoxTop(VIEWPORT_HEIGHT / 2)
    act(() => { recheckDeferredMarkdown() })
    expect(view.container.querySelectorAll('[data-deferred]')).toHaveLength(0)
    expect(view.container.querySelectorAll('strong')).toHaveLength(2)
    expect(IntersectionObserverStub.instances[0]?.observed.size).toBe(0)
    expect(IntersectionObserverStub.instances[0]?.disconnected).toBe(true)

    // Nothing is registered and the observer is released: a later landing is a no-op.
    act(() => { recheckDeferredMarkdown() })
  })

  it('parses settled source when IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const view = render(<MarkdownText text={SOURCE} deferOffscreen />)
    expect(view.container.querySelector('strong')).not.toBeNull()
  })

  it('releases the shared gate when the last deferred block unmounts', () => {
    stubBoxTop(VIEWPORT_HEIGHT * 4)
    const view = render(<MarkdownText text={SOURCE} deferOffscreen />)
    const block = view.container.querySelector('[data-deferred]')!
    const observer = IntersectionObserverStub.instances[0]!

    view.unmount()

    expect(observer.unobserved.has(block)).toBe(true)
    expect(observer.disconnected).toBe(true)
  })
})
