/**
 * The Context Dashboard's open-state store. Module-level so the footer entry
 * (sidebar.footer.action) and the overlay (shell.overlay) — two separate
 * slot registrations — share the one flag: the button flips it, the panel
 * subscribes and renders. Root-scoped and global (unlike the /context
 * modal's per-session stores): the overview is a frame-wide surface, one
 * instance across sessions.
 */

export interface OverviewStore {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => boolean
  set: (open: boolean) => void
}

function createStore(): OverviewStore {
  let open = false
  const listeners = new Set<() => void>()
  // Arrow properties: the useSyncExternalStore call passes them unbound.
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => open,
    set: (next) => {
      if (next === open) return
      open = next
      for (const listener of listeners) listener()
    },
  }
}

export const overviewStore: OverviewStore = createStore()
