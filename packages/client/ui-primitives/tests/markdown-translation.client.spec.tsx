// @vitest-environment jsdom
// External translation extensions rewrite a rendered reply in place: they
// replace a text node with a wrapper element and move the original node inside
// it. React reconciles a bare string child as a host Text node, so a later
// insertBefore/removeChild against the original parent throws NotFoundError and
// tears the reply down (pinned by the control case at the end of this file).
// These specs drive real streaming chunks while a simulated extension rewrites
// every rendered string, and hold the renderer to two promises: React's own
// nodes stay addressable, and completed paragraphs keep the translation the
// extension already wrote.
import { cleanup, render } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

/** The marker a simulated extension writes in front of every source run. Its text appears nowhere in the corpus. */
const TRANSLATION = '译'

/**
 * Rewrite the rendered text the way a translation extension does: a new wrapper
 * element takes the text node's place in its parent, the original text node
 * moves inside it, and the translation renders beside it. Whitespace-only nodes
 * stay untouched — extensions skip them, and the renderer relies on that for
 * the inter-block newlines it emits.
 * @param root - Rendered subtree to rewrite in place.
 * @returns How many text runs the pass translated.
 */
function translateRenderedText(root: ParentNode): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  while (walker.nextNode() !== null) targets.push(walker.currentNode as Text)
  let translated = 0
  for (const node of targets) {
    const parent = node.parentNode
    if (parent === null || (node.nodeValue ?? '').trim() === '') continue
    // The extension's own output, not authored text: never re-wrap it.
    if (node.parentElement?.closest('[data-translated]') != null) continue
    // The legacy wrapper tag the extensions use; constructed namespace-explicitly
    // because the DOM lib's HTMLFontElement interface is deprecated.
    const wrapper = document.createElementNS('http://www.w3.org/1999/xhtml', 'font')
    wrapper.setAttribute('data-translated', 'yes')
    const marker = document.createElement('span')
    marker.setAttribute('data-translation', 'yes')
    marker.textContent = TRANSLATION
    parent.replaceChild(wrapper, node)
    wrapper.append(marker, node)
    translated += 1
  }
  return translated
}

/** A node's own text with the extension's markers removed. */
function sourceText(node: ParentNode | null): string {
  return (node?.textContent ?? '').replaceAll(TRANSLATION, '')
}

/** Render `text` in `step`-sized prefixes, translating the DOM after every chunk. */
function streamTranslated(live: RenderResult, text: string, step: number): number {
  let translated = 0
  for (let end = step; end < text.length + step; end += step) {
    live.rerender(<MarkdownText text={text.slice(0, Math.min(end, text.length))} streaming />)
    translated += translateRenderedText(live.container)
  }
  return translated
}

const STREAM_DOC = [
  '# Streaming title',
  '',
  'First paragraph with **strong**, *emphasis*, and a [link](https://example.com/docs).',
  '',
  '- list item one',
  '- list item two with `inline`',
  '',
  '| Left | Right |',
  '| --- | --- |',
  '| cell one | cell two |',
  '',
  '```ts',
  'const answer = 42',
  '```',
  '',
  'Closing paragraph that keeps growing to the very end of the reply.',
].join('\n')

describe('translation extensions over a streamed reply', () => {
  it('keeps the reply mounted while an extension rewrites every chunk', () => {
    const live = render(<MarkdownText text="" streaming />)
    let translated = 0
    for (let end = 9; end < STREAM_DOC.length + 9; end += 9) {
      const prefix = STREAM_DOC.slice(0, Math.min(end, STREAM_DOC.length))
      live.rerender(<MarkdownText text={prefix} streaming />)
      translated += translateRenderedText(live.container)
      const fresh = render(<MarkdownText text={prefix} streaming />)
      expect(sourceText(live.container)).toBe(fresh.container.textContent)
      fresh.unmount()
    }
    expect(translated).toBeGreaterThan(0)
    live.unmount()
  })

  it('shows translated text before the reply finishes and keeps translated prefix nodes mounted', () => {
    const live = render(<MarkdownText text={'Alpha paragraph stays put.'} streaming />)
    translateRenderedText(live.container)
    const alpha = live.container.querySelector('p')
    // Translation is visible while the reply is still streaming, not only after it settles.
    expect(alpha?.querySelector('[data-translation]')).not.toBeNull()

    const rest = 'Alpha paragraph stays put.\n\nBeta paragraph stays put.\n\nGamma paragraph streams last.'
    live.rerender(<MarkdownText text={rest.slice(0, rest.indexOf('\n\nGamma'))} streaming />)
    translateRenderedText(live.container)
    live.rerender(<MarkdownText text={rest} streaming />)
    translateRenderedText(live.container)

    // The completed paragraph is frozen: same DOM node, translation intact.
    expect(live.container.querySelector('p')).toBe(alpha)
    expect(alpha?.querySelector('[data-translation]')).not.toBeNull()
    const fresh = render(<MarkdownText text={rest} streaming />)
    expect(sourceText(live.container)).toBe(fresh.container.textContent)
    fresh.unmount()
    live.unmount()
  })

  it('rewrites only the growing leaf, and the extension translates it again', () => {
    const head = 'Alpha paragraph.\n\nBeta paragraph.\n\nGamma'
    const live = render(<MarkdownText text={head} streaming />)
    translateRenderedText(live.container)
    const [alpha, , gamma] = [...live.container.querySelectorAll('p')]
    const gammaLeaf = gamma?.querySelector('span')
    expect(sourceText(gammaLeaf ?? null)).toBe('Gamma')

    const grown = `${head} keeps growing.`
    live.rerender(<MarkdownText text={grown} streaming />)

    // React replaced the changed leaf's content with the new source text.
    expect(gamma?.querySelector('span')).toBe(gammaLeaf)
    expect(sourceText(gammaLeaf ?? null)).toBe('Gamma keeps growing.')
    expect(gammaLeaf?.querySelector('[data-translation]')).toBeNull()
    // The frozen paragraph was never touched, so its translation survived.
    expect(live.container.querySelector('p')).toBe(alpha)
    expect(alpha?.querySelector('[data-translation]')).not.toBeNull()

    translateRenderedText(live.container)
    expect(gammaLeaf?.querySelector('[data-translation]')).not.toBeNull()
    const fresh = render(<MarkdownText text={grown} streaming />)
    expect(sourceText(live.container)).toBe(fresh.container.textContent)
    fresh.unmount()
    live.unmount()
  })

  it('keeps the leaf wrapper and its translation when a growing paragraph gains an edge space', () => {
    const live = render(<MarkdownText text={'Alpha sentence'} streaming />)
    translateRenderedText(live.container)
    const leaf = live.container.querySelector('p > span')
    expect(leaf?.querySelector('[data-translation]')).not.toBeNull()

    // Appending an inline element leaves this text node's core untouched and
    // adds its trailing space, so the leaf must stay one wrapper element rather
    // than swap between a node and a list as its shape changes.
    live.rerender(<MarkdownText text={'Alpha sentence **bold**'} streaming />)
    expect(live.container.querySelector('p > span')).toBe(leaf)
    expect(leaf?.querySelector('[data-translation]')).not.toBeNull()
    expect([...live.container.querySelectorAll('p > span')].map(span => sourceText(span)))
      .toEqual(['Alpha sentence'])
    live.unmount()
  })

  it('settles, and re-renders a divergent document, after translation', () => {
    const live = render(<MarkdownText text="" streaming />)
    streamTranslated(live, STREAM_DOC, 11)
    live.rerender(<MarkdownText text={STREAM_DOC} />)
    translateRenderedText(live.container)
    const settled = render(<MarkdownText text={STREAM_DOC} />)
    expect(sourceText(live.container)).toBe(settled.container.textContent)
    settled.unmount()

    const divergent = 'Totally different.\n\nSecond block.\n\nThird block.'
    live.rerender(<MarkdownText text={divergent} streaming />)
    translateRenderedText(live.container)
    const fresh = render(<MarkdownText text={divergent} streaming />)
    expect(sourceText(live.container)).toBe(fresh.container.textContent)
    fresh.unmount()
    live.unmount()
  })

  it('keeps link, table, list, and inline-code semantics under translation', () => {
    const live = render(<MarkdownText text={STREAM_DOC} streaming />)
    translateRenderedText(live.container)

    const link = live.container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com/docs')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(sourceText(link)).toBe('link')
    expect([...live.container.querySelectorAll('th')].map(cell => sourceText(cell))).toEqual(['Left', 'Right'])
    expect([...live.container.querySelectorAll('td')].map(cell => sourceText(cell))).toEqual(['cell one', 'cell two'])
    expect([...live.container.querySelectorAll('li')].map(item => sourceText(item)))
      .toEqual(['list item one', 'list item two with inline'])
    expect(sourceText(live.container.querySelector('code'))).toBe('inline')
    expect(sourceText(live.container.querySelector('strong'))).toBe('strong')
    live.unmount()
  })
})

/** The pre-fix shape: the renderer returned mdast text nodes as bare strings beside their siblings. */
function LegacyParagraph({ lead, tail }: { readonly lead: string; readonly tail?: string }) {
  return <p>{lead}<strong>bold</strong>{tail}</p>
}

describe('bare string children are the failure this renderer avoids', () => {
  it('a bare string sibling is torn down by the same extension the renderer survives', () => {
    const legacy = render(<LegacyParagraph lead="Lead " tail="tail" />)
    translateRenderedText(legacy.container)
    // Dropping the trailing text child makes React remove the node the
    // extension moved, which is the crash this renderer's wrappers prevent.
    expect(() => { legacy.rerender(<LegacyParagraph lead="Lead " />) }).toThrow(/not a child/)
    legacy.unmount()

    const live = render(<MarkdownText text={'Lead **bold** tail'} streaming />)
    translateRenderedText(live.container)
    live.rerender(<MarkdownText text={'Lead **bold**'} streaming />)
    const fresh = render(<MarkdownText text={'Lead **bold**'} streaming />)
    expect(sourceText(live.container)).toBe(fresh.container.textContent)
    fresh.unmount()
    live.unmount()
  })

  it('control: the element-or-list leaf shape remounts its wrapper once an edge space appears', () => {
    // The shape the keyed Fragment replaced: one element while the value has no
    // edge whitespace, then bare-text/element/bare-text once it does. Different
    // fiber types at the same position, so React cannot keep the wrapper.
    const view = render(<p><span>{'Alpha sentence'}</span></p>)
    const leaf = view.container.querySelector('span')
    view.rerender(<p>{''}<span>{'Alpha sentence'}</span>{' '}</p>)
    expect(view.container.querySelector('span')).not.toBe(leaf)
  })
})
