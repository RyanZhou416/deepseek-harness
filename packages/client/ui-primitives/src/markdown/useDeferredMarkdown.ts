/**
 * Deferred settled Markdown: a block renders as searchable plain text until it
 * first approaches the viewport, then parses into its full document. Activation
 * is permanent, so a block scrolled past and back keeps its parsed form, and a
 * streaming reply never defers because its tail is already on screen.
 */

import { useCallback, useLayoutEffect, useState, type RefObject } from 'react'
import { ViewportActivationGate, withinScreens } from './viewport-activation.ts'

/** Early activation margin: two viewport heights of scroll runway. */
const ACTIVATION_SCREENS = 2

/** One document-wide gate; activated blocks leave it permanently. */
const deferredGate = new ViewportActivationGate(ACTIVATION_SCREENS)

/**
 * Resolve deferred Markdown already inside the activation margin. An owner that
 * scrolls its transcript imperatively calls this after the write — initial
 * open, a restored position, a Turn jump — so the content the user is about to
 * see parses in that same frame instead of one observer delivery later.
 */
export function recheckDeferredMarkdown(): void {
  deferredGate.recheck()
}

/**
 * Track whether one settled Markdown block may defer its parse.
 * @param target - block root; the viewport gates this element.
 * @param enabled - whether this render may defer; streaming passes false.
 * @returns whether the caller must render the lightweight plain-text form now.
 */
export function useDeferredMarkdown(target: RefObject<Element>, enabled: boolean): boolean {
  const [activated, setActivated] = useState(false)
  const activate = useCallback(() => { setActivated(true) }, [])

  // A layout effect decides the first render before paint: the initial screen
  // must never flash plain text, and an imperatively landed scrollport resolves
  // its visible blocks through the same measurement.
  useLayoutEffect(() => {
    if (!enabled || activated) return
    const element = target.current
    /* v8 ignore next -- React attaches the host ref before layout effects. */
    if (element === null) return
    if (typeof IntersectionObserver === 'undefined' || withinScreens(element, ACTIVATION_SCREENS)) {
      activate()
      return
    }
    return deferredGate.observe(element, activate)
  }, [activate, activated, enabled, target])

  return enabled && !activated
}
