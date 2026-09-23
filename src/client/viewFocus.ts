/**
 * Chat → Context jump relay. The assistant-message action records the clicked
 * reply's request seq here and opens the Context view — the right Sidebar's
 * tab when this harness serves one, else the conversation tab; the view
 * consumes the one-shot focus once its projection data is in. Module-level
 * per-session map — the same life pattern as the modal open-state stores.
 */

import { asRecord, type ClientCtx } from './services'
import { SIDEBAR_CONTEXT_KIND } from './sidebar'

const pendingFocus = new Map<string, number>()

/** The mounted Context views re-pinning on later records (repeat jumps). */
const focusListeners = new Set<() => void>()

/**
 * Record the Context step (request seq) to reveal for `sessionId` — replaces
 * any unconsumed request and wakes the mounted views.
 */
export function requestContextFocus(sessionId: string, seq: number): void {
  pendingFocus.set(sessionId, seq)
  for (const listener of focusListeners) listener()
}

/**
 * Wake on every record while subscribed: a Context view that is already
 * mounted (the sidebar landing keeps it mounted across jumps) re-pins when a
 * record lands — the listener takes its OWN session's entry, so other
 * sessions' records leave their entries pending for their views.
 */
export function subscribeContextFocus(listener: () => void): () => void {
  focusListeners.add(listener)
  return () => { focusListeners.delete(listener) }
}

/** Take the pending focus request, if any — one-shot, the map entry is consumed. */
export function takeContextFocus(sessionId: string): number | null {
  const seq = pendingFocus.get(sessionId)
  if (seq === undefined) return null
  pendingFocus.delete(sessionId)
  return seq
}

/**
 * Open the Context tab on the right Sidebar over `ctx.sidebarRight.openTab`
 * (the column expands in the same step). OPTIONAL seam, re-proved at call
 * time: a harness without the service (every line older than 0.1.5-rc.1), a
 * placement that registered no tab type, no mounted session surface, or a
 * hostile face all report false so the caller keeps its conversation-tab
 * fallback.
 */
export function openContextSidebar(ctx: ClientCtx): boolean {
  try {
    const face = asRecord(ctx.get('sidebarRight'))
    if (face === null || typeof face.openTab !== 'function') return false
    ;(face.openTab as (kind: string) => void).call(face, SIDEBAR_CONTEXT_KIND)
    return true
  } catch {
    return false
  }
}

/**
 * Activate the Context tab by clicking its own tab-bar button (the semantic
 * `button[role="tab"]` chrome the conversation shell renders for every view).
 * The harness hands `openView` only to the ACTIVE view entry, so a nested
 * chat action cannot call it — this rides the same button a user click would.
 * Already-active is a no-op that still reports success; no matching tab (any
 * dsh layout without the tab bar) reports failure and nothing happens.
 */
export function activateContextTab(label: string): boolean {
  const tabs = document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')
  for (const tab of tabs) {
    if (tab.textContent.trim() !== label) continue
    if (tab.getAttribute('aria-selected') !== 'true') tab.click()
    return true
  }
  return false
}
