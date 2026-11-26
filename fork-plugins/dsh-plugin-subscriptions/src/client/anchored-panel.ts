/**
 * Placement for this plugin's body-portaled usage panel.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` no longer exports `useAnchoredPosition`: the
 * Host moved its own overlays to CSS anchor positioning, which needs a stylesheet per
 * surface. This plugin's client bundle has no CSS pipeline — every surface it renders is
 * inline-styled — so the panel keeps the measured placement it was built against: it is
 * laid out hidden on the first pass, placed above its trigger with a viewport clamp, and
 * tracked while it stays open.
 */

import { useLayoutEffect, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'

/** Inputs for {@link useAnchoredPanelAbove}. */
export interface AnchoredPanelOptions {
  /** Whether the panel is mounted and should track its trigger. */
  readonly open: boolean
  /** Element whose viewport rect the panel is placed against. */
  readonly anchorRef: RefObject<HTMLElement | null>
  /** Body-portaled, fixed-position panel; its ancestors must not establish a containing block. */
  readonly panelRef: RefObject<HTMLElement | null>
  /** Distance kept between the trigger's top edge and the panel's bottom edge. */
  readonly gap: number
  /** Minimum viewport inset on every side. */
  readonly margin: number
}

/**
 * Top inset an overlay keeps from the viewport edge, including the desktop frame's
 * reserved strip. Mirrors the Host's own overlay margin so a panel opened from a control
 * inside that strip still sits next to its trigger.
 * @param margin - the panel's own viewport margin floor, in CSS pixels.
 * @param anchor - the trigger's viewport rect.
 * @param gap - the distance the panel keeps below the trigger.
 * @param ownerDocument - the document the trigger is rendered in.
 * @returns the top inset to clamp against.
 */
function topInset(margin: number, anchor: DOMRect, gap: number, ownerDocument: Document): number {
  const root = ownerDocument.documentElement
  const view = ownerDocument.defaultView
  if (view === null) return margin
  const clearance = Number.parseFloat(view.getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance'))
  if (Number.isNaN(clearance)) return margin
  const cap = anchor.top >= 0 ? anchor.bottom + gap : Number.POSITIVE_INFINITY
  return Math.max(margin, Math.min((root.hasAttribute('data-fullscreen') ? 0 : clearance) + 20, cap))
}

/**
 * Place a fixed panel above its trigger, clamped to the visible viewport.
 * @param options - open state, element refs, gap and margin.
 * @returns fixed left/top for the panel, or null while it is closed or unmeasurable.
 */
export function useAnchoredPanelAbove(options: AnchoredPanelOptions): CSSProperties | null {
  const { open, anchorRef, panelRef, gap, margin } = options
  const [position, setPosition] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (anchor === null || panel === null) return
    const win = anchor.ownerDocument.defaultView
    if (win === null) return
    const viewport = win.visualViewport
    let active = true
    let lastRect: Pick<DOMRect, 'x' | 'y' | 'width' | 'height'> | null = null
    const place = (): void => {
      const rect = anchor.getBoundingClientRect()
      lastRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      const x = viewport?.offsetLeft ?? 0
      const y = viewport?.offsetTop ?? 0
      const width = viewport?.width ?? (anchor.ownerDocument.documentElement.clientWidth || win.innerWidth)
      const height = viewport?.height ?? (anchor.ownerDocument.documentElement.clientHeight || win.innerHeight)
      const panelWidth = panel.offsetWidth
      const panelHeight = panel.offsetHeight
      const top = rect.top - gap - panelHeight
      const next: CSSProperties = {
        left: Math.max(x + margin, Math.min(rect.left, x + width - margin - panelWidth)),
        top: Math.max(y + topInset(margin, rect, gap, anchor.ownerDocument), Math.min(top, y + height - margin - panelHeight)),
      }
      setPosition(current => current?.left === next.left && current?.top === next.top ? current : next)
    }
    place()
    win.addEventListener('scroll', place, true)
    win.addEventListener('resize', place)
    viewport?.addEventListener('scroll', place)
    viewport?.addEventListener('resize', place)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(anchor)
    observer?.observe(panel)
    // Transforms and surrounding layout can move a trigger without resizing either element.
    let frame = 0
    const track = (): void => {
      if (!active) return
      const rect = anchor.getBoundingClientRect()
      if (rect.x !== lastRect?.x || rect.y !== lastRect?.y
        || rect.width !== lastRect?.width || rect.height !== lastRect?.height) place()
      frame = win.requestAnimationFrame(track)
    }
    frame = win.requestAnimationFrame(track)
    return () => {
      active = false
      win.cancelAnimationFrame(frame)
      observer?.disconnect()
      win.removeEventListener('scroll', place, true)
      win.removeEventListener('resize', place)
      viewport?.removeEventListener('scroll', place)
      viewport?.removeEventListener('resize', place)
    }
  }, [open, anchorRef, panelRef, gap, margin])
  return position
}
