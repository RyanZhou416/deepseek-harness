/**
 * Scroll an element's nearest scrollable ancestor so the element tops that
 * scrollport. The jump's landing reveal needs this host-agnostic: the
 * conversation tab scrolls the shared `[data-conversation-scroll]` container
 * while the right Sidebar scrolls dockkit's pane body (a CSS-module class,
 * no stable attribute of its own), so the walk takes whichever ancestor
 * actually scrolls — the rect delta lands the anchor flush regardless of the
 * container's current position. `document.body` ends the walk: the page
 * itself never scrolls. False — never a throw — when no ancestor scrolls (the
 * layout already shows the element) or the chain turns hostile.
 *
 * @module dsh-context/client/revealScroll
 */

export function revealInScrollParent(anchor: Element): boolean {
  try {
    for (let el = anchor.parentElement; el !== null && el !== document.body; el = el.parentElement) {
      const oy = window.getComputedStyle(el).overflowY
      if (oy === 'auto' || oy === 'scroll') {
        el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top
        return true
      }
    }
  } catch { /* hostile chain: the reveal degrades to nothing */ }
  return false
}
