import { useCallback, useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { supportsHighlighting } from './highlight.ts'
import { ViewportActivationGate } from './viewport-activation.ts'

/** One document-wide gate; activated elements leave it permanently. */
const highlightGate = new ViewportActivationGate(0)

/**
 * Activate one supported code surface when it first intersects the viewport.
 * Activation lasts for the component lifetime; browsers without
 * IntersectionObserver activate immediately.
 * @param target - Code surface whose plain rendering reserves its geometry.
 * @param lang - Optional language hint.
 * @returns Whether this component may build highlighted output.
 */
export function useViewportHighlighting(
  target: RefObject<Element>,
  lang: string | undefined,
): boolean {
  const supported = supportsHighlighting(lang)
  const [activated, setActivated] = useState(false)
  const activate = useCallback(() => { setActivated(true) }, [])

  useEffect(() => {
    if (activated || !supported) return
    const element = target.current
    /* v8 ignore next -- React attaches the host ref before running effects. */
    if (element === null) return
    if (typeof IntersectionObserver === 'undefined') {
      activate()
      return
    }
    return highlightGate.observe(element, activate)
  }, [activate, activated, supported, target])

  return activated && supported
}
