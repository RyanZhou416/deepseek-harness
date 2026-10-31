// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { useDisclosure } from '../src/client/chat/use-disclosure.ts'
import { useSearchableHidden } from '../src/client/chat/searchable-hidden.ts'
import { useDetailedPresentation } from './presentation-fixture.client.ts'
import { unusedImageLoader } from './reasoning-component-fixture.tsx'
import type { ChatViewSlotProps } from '../src/client/contract/slots.ts'

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = []

  readonly root = null
  readonly rootMargin = '0px'
  readonly scrollMargin = '0px'
  readonly thresholds: readonly number[] = [0]
  readonly observed = new Set<Element>()

  constructor(private readonly callback: IntersectionObserverCallback) {
    IntersectionObserverStub.instances.push(this)
  }

  observe(element: Element): void { this.observed.add(element) }

  unobserve(element: Element): void { this.observed.delete(element) }

  disconnect(): void { this.observed.clear() }

  takeRecords(): IntersectionObserverEntry[] { return [] }

  intersect(element: Element, isIntersecting: boolean): void {
    this.callback([{ target: element, isIntersecting } as IntersectionObserverEntry], this)
  }
}

const t = ((_key: string) => 'label') as ChatViewSlotProps['t']
const props = {
  renderSlot: () => null, useDisclosure, useGroupAction: useSearchableHidden,
  usePresentation: useDetailedPresentation, loadImage: unusedImageLoader, t,
}
/** Above Chat's minimum deferred length; kept short enough to read in assertions. */
const SOURCE = `**Settled** prose with \`code\`\n\n${'A settled assistant paragraph. '.repeat(180)}`
const SHORT_SOURCE = '**Short** settled prose'

beforeEach(() => {
  IntersectionObserverStub.instances = []
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AssistantMarkdown viewport deferral', () => {
  it('defers offscreen settled prose and renders a streaming reply immediately', () => {
    // jsdom reports empty boxes, which the gate leaves to the observer.
    const view = render(
      <AssistantMarkdown {...props} blocks={[{ kind: 'text', text: SOURCE }]} streaming={false} />,
    )
    expect(view.container.querySelector('[data-deferred]')?.textContent).toBe(SOURCE)
    expect(view.container.querySelector('strong')).toBeNull()
    expect(IntersectionObserverStub.instances[0]?.observed.size).toBe(1)

    view.rerender(<AssistantMarkdown {...props} blocks={[{ kind: 'text', text: SOURCE }]} streaming />)
    expect(view.container.querySelector('strong')).not.toBeNull()
    expect(view.container.querySelector('[data-deferred]')).toBeNull()
    expect(view.container.textContent).toContain('Settled prose with')
  })

  it('parses deferred prose once the block reaches the viewport', () => {
    const view = render(
      <AssistantMarkdown {...props} blocks={[{ kind: 'text', text: SOURCE }]} streaming={false} />,
    )
    const block = view.container.querySelector('[data-deferred]')!
    const observer = IntersectionObserverStub.instances[0]!
    act(() => { observer.intersect(block, true) })
    expect(view.container.querySelector('strong')).not.toBeNull()
  })

  it('keeps a short settled block parsed before any viewport decision', () => {
    const view = render(
      <AssistantMarkdown {...props} blocks={[{ kind: 'text', text: SHORT_SOURCE }]} streaming={false} />,
    )
    expect(view.container.querySelector('strong')).not.toBeNull()
    expect(view.container.querySelector('[data-deferred]')).toBeNull()
    expect(IntersectionObserverStub.instances).toHaveLength(0)
  })
})
