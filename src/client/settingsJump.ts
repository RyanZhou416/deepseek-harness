/**
 * Best-effort jump to this plugin's preferences. Two generations of chrome:
 *   - dsh 0.1.7+ (Config-form generation): the preferences live on the
 *     bundle's page of the Plugins main panel — the jump clicks the panel's
 *     sidebar entry (its shipped aria-label), then follows the page with a
 *     bounded poll for the bundle card's open control, found by the shipped,
 *     locale-independent `data-plugin-package` list identity: the card lists
 *     once the page's package load settles, and inside it the one button
 *     that is not the enable switch is the title that opens the page. A
 *     poll that never finds the card (still loading, plugin absent, or the
 *     page already open on the detail view — the list unmounts there)
 *     degrades to the card list, and every step stays silent.
 *   - older lines: Settings → Plugins → Plugin configuration — the settings
 *     panel keeps its open state inside the shell component (no plugin-facing
 *     open face exists), so the jump drives the real chrome: click the
 *     sidebar's settings trigger, then the Plugins section nav row, both
 *     found by their shipped attributes and labels.
 * The last leg — the card itself — is ours: the module also carries a
 * short-lived in-bundle expand request that the settings-section card
 * consumes on mount, so that jump lands on the configuration already open.
 * EVERY step is individually guarded: a shell that doesn't match (different
 * layout, missing sidebar) degrades the whole jump to a silent no-op — this
 * path must never throw into the caller's render.
 */

let requestedAt = 0

/** Raise a short-lived request for the plugin's settings card to mount expanded. */
export function requestCardExpand(now: number = Date.now()): void {
  requestedAt = now
}

/** Consume the request once; true only while it is still fresh (younger than maxAgeMs). */
export function consumeCardExpand(now: number = Date.now(), maxAgeMs = 5000): boolean {
  const fresh = requestedAt > 0 && now - requestedAt < maxAgeMs
  requestedAt = 0
  return fresh
}

/**
 * The shipped Plugins label in both locales — the main-panel entry's
 * aria-label and the settings section's nav row text are the same word.
 */
const PLUGIN_LABELS = new Set(['Plugins', '插件'])

/** The bundle card's shipped list identity (locale-independent). */
const PACKAGE_KEY = 'dsh-context'

/** How long the card poll follows the panel: 40 ticks at the 100ms tick, enough for the page's package load. */
const POLL_TICKS = 40

/** Buttons the jump may operate on, in document order. */
function buttonsOf(doc: Document): HTMLButtonElement[] {
  return [...doc.querySelectorAll<HTMLButtonElement>('button')]
}

/** The Plugins main-panel entry, matched by its shipped aria-label. */
function findPanelEntry(doc: Document): HTMLButtonElement | undefined {
  return buttonsOf(doc).find(b => PLUGIN_LABELS.has(b.getAttribute('aria-label') ?? ''))
}

/**
 * The bundle card's open control: the one button inside the card that is not
 * the enable switch (the primitives switch carries `role="switch"`); the
 * title button's own aria-label is localized.
 */
function findCardOpenControl(doc: Document): HTMLButtonElement | undefined {
  const card = doc.querySelector(`[data-plugin-package="${PACKAGE_KEY}"]`)
  if (card === null) return undefined
  const open = [...card.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.getAttribute('role') !== 'switch')
  return open.length === 1 ? open[0] : undefined
}

/** The sidebar's settings triggers: dialog semantics plus an expanded flag. */
function findTriggers(doc: Document): HTMLButtonElement[] {
  return buttonsOf(doc)
    .filter(b => b.getAttribute('aria-haspopup') === 'dialog' && b.hasAttribute('aria-expanded'))
}

/** The Plugins section's nav row, matched by its shipped label text. */
function findSectionRow(doc: Document): HTMLButtonElement | undefined {
  return buttonsOf(doc).find(b => PLUGIN_LABELS.has(b.textContent.trim()))
}

export function openPluginSettings(
  doc: Document = document,
  schedule: (run: () => void, ms: number) => void = (run, ms) => { window.setTimeout(run, ms) },
): void {
  try {
    // Config-form generation first: the panel entry is the one seat both
    // locales ship. The follow-up poll rides the same scheduler contract as
    // the legacy leg, so tests drive every tick.
    const panel = findPanelEntry(doc)
    if (panel !== undefined) {
      panel.click()
      const poll = (left: number): void => {
        try {
          const open = findCardOpenControl(doc)
          if (open !== undefined) {
            open.click()
            return
          }
        } catch { /* a hostile card: stay on the card list */ }
        if (left > 0) schedule(() => { poll(left - 1) }, 100)
      }
      schedule(() => { poll(POLL_TICKS) }, 200)
      return
    }
    const triggers = findTriggers(doc)
    const open = triggers.find(b => b.getAttribute('aria-expanded') === 'true')
    // No dialog trigger at all: this shell has no settings panel — no-op.
    if (open === undefined && triggers.length === 0) return
    // A collapsed trigger opens the panel; an already-open one is left alone.
    triggers.find(b => b.getAttribute('aria-expanded') !== 'true')?.click()
    // Only a chrome with a settings dialog raises the expand request, and
    // only once the trigger click survived — a degraded jump leaves no
    // stale signal behind.
    requestCardExpand()
    schedule(() => {
      try {
        findSectionRow(doc)?.click()
      } catch { /* no Plugins row on this host: stay on the opened section */ }
    }, 80)
  } catch { /* the settings surface doesn't match: silent no-op */ }
}
