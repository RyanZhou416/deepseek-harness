/**
 * The Speed row's drill-in pane, mounted with React in a DOM over a minimal seat
 * that stands in for ModelSelect's owner face.
 *
 * The spec owns the facts the seat's own suites cannot see: the cell is one of
 * the menu's root rows and hands its pane key to the seat; the pane shows the two
 * tiers and nothing of the cell; the row stays mounted across the switch, so an
 * in-flight read, the chosen tier, and the failure strip survive it; a failed
 * write keeps the pane open with the failure reachable; a write that settles
 * after the pane was left closes nothing; and a row that hides itself while its
 * pane is shown leaves the pane instead of leaving an empty one.
 *
 * jsdom is the declared DOM fixture for this tier; the spec imports it directly
 * so a missing fixture fails here instead of passing silently.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createElement, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

// The component reaches host primitives that ship CSS modules; Node needs only
// their empty class map, not a browser stylesheet loader.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css')
    ? { format: 'module', source: 'export default {}', shortCircuit: true }
    : nextLoad(url, context)
} })
const { ROW_KEY, SpeedSelect } = await import('../src/client/SpeedSelect.js')
css.deregister()
import type { ModelRef, SpeedSelectInjected, SpeedSelectState } from '../src/client/SpeedSelect.js'
import type { ObservableSnapshot } from '../src/client/subscriptions-cache.js'

const CODEX_MODEL: ModelRef = { provider: 'codex', model: 'gpt-5-codex' }
const VISIBLE_STANDARD: SpeedSelectState = { visible: true, tier: 'standard' }

/** A model-selection source the spec pushes through. */
interface PushedSource extends ObservableSnapshot<ModelRef | null> {
  push: (next: ModelRef | null) => void
}

/** Build the source plus its push. */
function modelSource(initial: ModelRef): PushedSource {
  let current: ModelRef | null = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    push: (next) => {
      current = next
      flushSync(() => { for (const listener of [...listeners]) listener() })
    },
  }
}

/** A selector hook over one source, as the renderer's own binding supplies it. */
function hookOver<T>(source: ObservableSnapshot<T>) {
  return <Selected,>(selector: (value: T) => Selected): Selected =>
    selector(useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot))
}

/**
 * Install the jsdom globals React reaches for.
 * @param JSDOMClass - the jsdom constructor.
 * @returns the restoration of every global this call installed.
 */
function installDom(JSDOMClass: typeof JSDOM): () => void {
  const { window } = new JSDOMClass('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const names = [
    'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent',
    'KeyboardEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ]
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const name of names) {
    const raw: unknown = window[name]
    if (raw === undefined) continue
    const value = typeof raw === 'function' ? (raw as (...args: never[]) => unknown).bind(window) : raw
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
      else Object.defineProperty(globalThis, name, descriptor)
    }
  }
}

/** Render one element into a fresh container and return its unmount. */
function render(element: ReactElement): () => void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => { root.render(element) })
  return () => {
    flushSync(() => { root.unmount() })
    container.remove()
  }
}

/** The row's scripted inject face plus what the spec observes about it. */
interface Face {
  injected: Pick<SpeedSelectInjected, 'loadSpeed' | 'setSpeed'>
  /** Every write the row requested, in order. */
  writes: { current: ModelRef; tier: string }[]
  /** Answer the write in flight; false fails it. */
  answerWrite: (ok: boolean) => void
}

/**
 * Build a scripted speed face: reads answer from `state`, and every write waits
 * for the spec so a settle can be placed after the user navigates.
 * @param state - the state a read of one model answers with.
 * @returns the face and its controls.
 */
function scriptedFace(state: (current: ModelRef | null) => SpeedSelectState = () => VISIBLE_STANDARD): Face {
  let pending: ((ok: boolean) => void) | null = null
  const writes: Face['writes'] = []
  return {
    writes,
    injected: {
      loadSpeed: async current => state(current),
      setSpeed: (current, tier) => {
        writes.push({ current, tier })
        return new Promise<boolean>((resolve) => { pending = resolve })
      },
    },
    answerWrite: (ok) => {
      const resolve = pending
      pending = null
      assert.ok(resolve, 'a write was in flight')
      resolve(ok)
    },
  }
}

/** The seat's side of the contract, recorded for assertions. */
interface SeatLog {
  /** The pane the seat shows, or null for its own root cells. */
  activeRow: string | null
  /** How often `closeMenu` closed the whole card. */
  closes: number
  /** The seat leaving the shown pane itself (Escape, Shift+Tab, or its own state). */
  leave: () => void
  /** The seat showing one contributed row's pane. */
  show: (rowKey: string) => void
}

/**
 * Mount SpeedSelect under a minimal seat that owns the pane state the way
 * ModelSelect does: the cell asks for its pane, `back` returns to the seat's own
 * pane, and `closeMenu` closes the whole card.
 * @param face - the row's scripted inject face.
 * @param model - the session's model-selection source.
 * @returns the element plus the seat's recorded state.
 */
function seatElement(face: Face, model: PushedSource): { element: ReactElement; seat: SeatLog } {
  const seat: SeatLog = { activeRow: null, closes: 0, leave: () => {}, show: () => {} }
  function Seat(): ReactElement {
    const [activeRow, setActiveRow] = useState<string | null>(null)
    seat.activeRow = activeRow
    seat.leave = () => { flushSync(() => { setActiveRow(null) }) }
    seat.show = (rowKey) => { flushSync(() => { setActiveRow(rowKey) }) }
    return createElement(SpeedSelect, {
      ...face.injected,
      useModel: hookOver(model),
      activeRow,
      openRow: (rowKey) => { flushSync(() => { setActiveRow(rowKey) }) },
      // The row asks for this from its own effect, so it never flushes inside
      // React's work; the spec's own `leave` may.
      back: () => { setActiveRow(null) },
      closeMenu: () => {
        seat.closes += 1
        flushSync(() => { setActiveRow(null) })
      },
    })
  }
  return { element: createElement(Seat), seat }
}

/** Settle React's own microtask work and the row's promise chain. */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

/** The mounted row's cell, by the marker its owner face requires. */
function cell(): HTMLButtonElement | null {
  return document.querySelector('[data-model-menu-row]')
}

/** The mounted row's pane options, in order. */
function options(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
}

/** The Fast option of the shown pane. */
function fastOption(): HTMLButtonElement {
  return options().find(option => option.textContent?.includes('Fast'))!
}

test('the cell is one of the menu root rows and hands its pane to the seat', async () => {
  const restoreDom = installDom(JSDOM)
  try {
    const face = scriptedFace()
    const { element, seat } = seatElement(face, modelSource(CODEX_MODEL))
    const stop = render(element)
    await settle()

    assert.equal(cell()?.getAttribute('role'), 'menuitem')
    assert.equal(cell()?.getAttribute('data-model-menu-row'), ROW_KEY)
    assert.ok(cell()?.getAttribute('aria-label')?.includes('Standard'), 'the cell shows the read tier')
    assert.deepEqual(options(), [], 'no pane is shown before the seat opens one')

    flushSync(() => { cell()?.click() })
    assert.equal(seat.activeRow, ROW_KEY, 'the cell asks the seat for its pane')
    // The component kept its state across the switch: the pane is complete in the
    // same commit, which a remount (an empty `view`) could not be.
    assert.equal(cell(), null, 'the cell gives way to the pane')
    assert.deepEqual(options().map(option => option.textContent), [
      'StandardDefault speed',
      'Fast1.5x speed, more usage',
    ])
    assert.deepEqual(options().map(option => option.getAttribute('aria-checked')), ['true', 'false'])

    // The seat's own back restores the cell, still holding the read tier.
    seat.leave()
    assert.ok(cell()?.getAttribute('aria-label')?.includes('Standard'))
    assert.deepEqual(options(), [])
    stop()
  } finally {
    restoreDom()
  }
})

test('a failed write keeps the pane open with the failure reachable', async () => {
  const restoreDom = installDom(JSDOM)
  try {
    const face = scriptedFace()
    const { element, seat } = seatElement(face, modelSource(CODEX_MODEL))
    const stop = render(element)
    await settle()
    flushSync(() => { cell()?.click() })

    flushSync(() => { fastOption().click() })
    await settle()
    assert.deepEqual(face.writes, [{ current: CODEX_MODEL, tier: 'fast' }])

    face.answerWrite(false)
    await settle()
    assert.equal(seat.closes, 0, 'a failed write closes nothing')
    assert.equal(seat.activeRow, ROW_KEY, 'the pane stays open for a retry')
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Could not switch the speed tier. Try again.')
    assert.deepEqual(options().map(option => option.disabled), [false, false], 'the retry is reachable')

    // The retry takes the same path and closes the whole card on success.
    flushSync(() => { fastOption().click() })
    await settle()
    face.answerWrite(true)
    await settle()
    assert.equal(seat.closes, 1)
    assert.equal(seat.activeRow, null)
    assert.ok(cell()?.getAttribute('aria-label')?.includes('Fast'), 'the stored tier reaches the cell')
    stop()
  } finally {
    restoreDom()
  }
})

test('a write that settles after the pane was left closes nothing', async () => {
  const restoreDom = installDom(JSDOM)
  try {
    const face = scriptedFace()
    const { element, seat } = seatElement(face, modelSource(CODEX_MODEL))
    const stop = render(element)
    await settle()
    flushSync(() => { cell()?.click() })
    flushSync(() => { fastOption().click() })
    await settle()

    // The user leaves the pane while the write is still in flight.
    seat.leave()
    face.answerWrite(true)
    await settle()
    assert.equal(seat.closes, 0, 'the settle belongs to a pane nobody is looking at')
    assert.equal(seat.activeRow, null)
    // The write still addressed this model, so the cell reflects it.
    assert.ok(cell()?.getAttribute('aria-label')?.includes('Fast'))
    stop()
  } finally {
    restoreDom()
  }
})

test('a pending write keeps its rows focusable so the card is not blurred away', async () => {
  const restoreDom = installDom(JSDOM)
  try {
    const face = scriptedFace()
    const { element, seat } = seatElement(face, modelSource(CODEX_MODEL))
    const stop = render(element)
    await settle()
    flushSync(() => { cell()?.click() })

    const fast = fastOption()
    fast.focus()
    flushSync(() => { fast.click() })
    await settle()
    // Disabling the row that holds the keyboard blurs it, and the seat closes a
    // menu whose focus left the card — which would take the failure strip with
    // it. The pending state rides `aria-busy` instead.
    assert.equal(fastOption().disabled, false, 'the row keeps the keyboard')
    assert.equal(document.activeElement, fastOption())
    assert.equal(document.querySelector('[aria-busy="true"]') !== null, true)

    face.answerWrite(false)
    await settle()
    assert.equal(seat.activeRow, ROW_KEY, 'the failing pane is still the shown one')
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Could not switch the speed tier. Try again.')
    stop()
  } finally {
    restoreDom()
  }
})

test('a write that settles after its row unmounted closes nothing', async () => {
  const restoreDom = installDom(JSDOM)
  try {
    const face = scriptedFace()
    const { element, seat } = seatElement(face, modelSource(CODEX_MODEL))
    const stop = render(element)
    await settle()
    flushSync(() => { cell()?.click() })
    flushSync(() => { fastOption().click() })
    await settle()

    // The row leaves the menu (the seat closed it, or the plugin unloaded) while
    // the write is still in flight; its settle must not act on whatever is open now.
    stop()
    face.answerWrite(true)
    await settle()
    assert.equal(seat.closes, 0)
  } finally {
    restoreDom()
  }
})

test('a write that settles after the model moved on closes nothing', async () => {
  const restoreDom = installDom(JSDOM)
  try {
    const face = scriptedFace()
    const model = modelSource(CODEX_MODEL)
    const { element, seat } = seatElement(face, model)
    const stop = render(element)
    await settle()
    flushSync(() => { cell()?.click() })
    flushSync(() => { fastOption().click() })
    await settle()

    // The session moved to another model while the write was in flight: the tier
    // it stored belongs to a model the menu no longer shows.
    model.push({ provider: 'codex', model: 'gpt-5.1-codex' })
    await settle()
    face.answerWrite(true)
    await settle()
    assert.equal(seat.closes, 0)
    assert.equal(seat.activeRow, ROW_KEY, 'the pane stays where the user left it')
    stop()
  } finally {
    restoreDom()
  }
})

test('contributes nothing while the seat shows another row\'s pane', async () => {
  const restoreDom = installDom(JSDOM)
  try {
    const face = scriptedFace()
    const { element, seat } = seatElement(face, modelSource(CODEX_MODEL))
    const stop = render(element)
    await settle()

    seat.show('other-row')
    assert.equal(cell(), null, 'a row that does not own the pane draws nothing in it')
    assert.deepEqual(options(), [])

    seat.leave()
    assert.ok(cell(), 'the root cell comes back with the seat\'s own panes')
    stop()
  } finally {
    restoreDom()
  }
})

test('a pending write cannot re-open its pane', async () => {
  const restoreDom = installDom(JSDOM)
  try {
    const face = scriptedFace()
    const { element, seat } = seatElement(face, modelSource(CODEX_MODEL))
    const stop = render(element)
    await settle()
    flushSync(() => { cell()?.click() })
    flushSync(() => { fastOption().click() })
    await settle()

    // The user backs out while the write is pending. The root cell is back and
    // keeps the keyboard (a disabled row would blur and close the card), but it
    // states the pending write and refuses to re-open the pane the settle owns.
    seat.leave()
    const row = cell()
    assert.ok(row)
    assert.equal(row.disabled, false, 'the pending root row stays focusable')
    assert.equal(row.getAttribute('aria-disabled'), 'true')
    flushSync(() => { row.click() })
    assert.equal(seat.activeRow, null, 'the pending row refuses a second pane')

    face.answerWrite(true)
    await settle()
    assert.equal(seat.closes, 0, 'the settle closes only the pane it was made in')
    stop()
  } finally {
    restoreDom()
  }
})

test('a row that hides itself while its pane is shown leaves the pane', async () => {
  const restoreDom = installDom(JSDOM)
  try {
    const face = scriptedFace(current => current?.provider === 'codex'
      ? VISIBLE_STANDARD
      : { visible: false, tier: 'standard' })
    const model = modelSource(CODEX_MODEL)
    const { element, seat } = seatElement(face, model)
    const stop = render(element)
    await settle()
    flushSync(() => { cell()?.click() })
    assert.equal(seat.activeRow, ROW_KEY)

    // The session moves to a model whose route carries no fast tier: the row
    // disappears, and an empty contributed pane must not hide the seat's cells.
    model.push({ provider: 'claude', model: 'claude-opus-5' })
    await settle()
    assert.equal(seat.activeRow, null, 'the seat got its own panes back')
    assert.equal(cell(), null, 'the hidden row renders nothing')
    stop()
  } finally {
    restoreDom()
  }
})
