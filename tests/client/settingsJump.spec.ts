// openPluginSettings (src/client/settingsJump.ts): the guarded DOM jump to
// the plugin's settings page — settings trigger first, Plugins section nav
// row second — plus the hostile degradations (missing chrome, throwing
// elements, already-open panel) and the expand request the surviving jump
// leaves for the plugin's settings card. jsdom supplies the real document.

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import { consumeCardExpand, openPluginSettings, requestCardExpand } from '../../src/client/settingsJump'

/** Immediate scheduler: captures the deferred runs in issue order. */
function syncSchedule(): { runs: Array<() => void>; schedule: (run: () => void, ms: number) => void } {
  const runs: Array<() => void> = []
  return { runs, schedule: (run) => { runs.push(run) } }
}

/** A sidebar-style settings trigger (dialog semantics + expanded flag). */
function trigger(doc: Document, expanded: 'true' | 'false'): HTMLButtonElement {
  const b = doc.createElement('button')
  b.setAttribute('aria-haspopup', 'dialog')
  b.setAttribute('aria-expanded', expanded)
  doc.body.appendChild(b)
  return b
}

/** Count native click dispatches on an element. */
function clicks(el: HTMLElement): { count: () => number } {
  let n = 0
  el.addEventListener('click', () => { n++ })
  return { count: () => n }
}

describe('openPluginSettings', () => {
  afterEach(() => {
    document.body.textContent = ''
    consumeCardExpand()
  })

  test('clicks the collapsed trigger, then the Plugins section row', () => {
    const t = trigger(document, 'false')
    const tClicks = clicks(t)
    const section = document.createElement('button')
    section.textContent = '插件'
    document.body.appendChild(section)
    const sClicks = clicks(section)
    const { runs, schedule } = syncSchedule()

    openPluginSettings(document, schedule)

    assert.equal(tClicks.count(), 1, 'the collapsed trigger is clicked immediately')
    assert.equal(sClicks.count(), 0, 'the section row waits for the panel to open')
    assert.equal(runs.length, 1)
    runs[0]()
    assert.equal(sClicks.count(), 1, 'the Plugins nav row is clicked once the panel opens')
  })

  test('the en-labeled section row matches too', () => {
    trigger(document, 'false')
    const section = document.createElement('button')
    section.textContent = 'Plugins'
    document.body.appendChild(section)
    const sClicks = clicks(section)
    const { runs, schedule } = syncSchedule()

    openPluginSettings(document, schedule)
    runs[0]()

    assert.equal(sClicks.count(), 1)
  })

  test('the default schedule defers through window.setTimeout', async () => {
    trigger(document, 'false')
    const section = document.createElement('button')
    section.textContent = '插件'
    document.body.appendChild(section)
    const sClicks = clicks(section)

    openPluginSettings(document)
    await new Promise(resolve => { setTimeout(resolve, 120) })

    assert.equal(sClicks.count(), 1)
  })

  test('an already-open panel skips the trigger but still selects the section', () => {
    const t = trigger(document, 'true')
    const tClicks = clicks(t)
    const section = document.createElement('button')
    section.textContent = '插件'
    document.body.appendChild(section)
    const sClicks = clicks(section)
    const { runs, schedule } = syncSchedule()

    openPluginSettings(document, schedule)
    runs[0]()

    assert.equal(tClicks.count(), 0, 'no re-click on an open panel')
    assert.equal(sClicks.count(), 1)
  })

  test('a chrome with no settings trigger degrades to a silent no-op', () => {
    const { runs, schedule } = syncSchedule()
    assert.doesNotThrow(() => openPluginSettings(document, schedule))
    assert.equal(runs.length, 0, 'no deferred section selection without a trigger')
  })

  test('elements that throw on click never surface the error', () => {
    const t = trigger(document, 'false')
    t.click = () => { throw new Error('detached') }
    const { runs, schedule } = syncSchedule()
    assert.doesNotThrow(() => openPluginSettings(document, schedule))
    // The trigger's failure aborts this jump entirely — the guarded path.
    assert.equal(runs.length, 0)
  })

  test('a throwing section row is contained by its own guard', () => {
    trigger(document, 'false')
    const section = document.createElement('button')
    section.textContent = '插件'
    section.click = () => { throw new Error('detached') }
    document.body.appendChild(section)
    const { runs, schedule } = syncSchedule()

    assert.doesNotThrow(() => openPluginSettings(document, schedule))
    assert.doesNotThrow(() => runs[0]())
  })

  test('lookalike chrome is ignored: a menu trigger is not the settings dialog', () => {
    const menu = document.createElement('button')
    menu.setAttribute('aria-haspopup', 'menu')
    menu.setAttribute('aria-expanded', 'false')
    document.body.appendChild(menu)
    const menuClicks = clicks(menu)
    const { runs, schedule } = syncSchedule()

    openPluginSettings(document, schedule)

    assert.equal(menuClicks.count(), 0, 'only dialog triggers are candidates')
    assert.equal(runs.length, 0)
  })

  test('a surviving jump leaves a fresh expand request for the settings card', () => {
    trigger(document, 'false')
    const section = document.createElement('button')
    section.textContent = '插件'
    document.body.appendChild(section)
    const { schedule } = syncSchedule()

    openPluginSettings(document, schedule)

    assert.equal(consumeCardExpand(), true, 'the card mounts expanded on this jump')
    assert.equal(consumeCardExpand(), false, 'the request is consumed once')
  })

  test('degraded jumps leave no expand request behind', () => {
    const { runs, schedule } = syncSchedule()
    openPluginSettings(document, schedule)
    assert.equal(consumeCardExpand(), false, 'no settings dialog in this chrome: no request')

    const t = trigger(document, 'false')
    t.click = () => { throw new Error('detached') }
    assert.doesNotThrow(() => openPluginSettings(document, schedule))
    assert.equal(consumeCardExpand(), false, 'a failed trigger click leaves no stale request')
    assert.equal(runs.length, 0)
  })

  test('the expand request is freshness-windowed (5s) and single-shot', () => {
    requestCardExpand(1000)
    assert.equal(consumeCardExpand(1000 + 4999), true, 'fresh within the window')
    assert.equal(consumeCardExpand(1000 + 4999), false, 'already consumed')

    requestCardExpand(1000)
    assert.equal(consumeCardExpand(1000 + 5000), false, 'stale past the window')
  })
})

describe('openPluginSettings: the Config-form generation (Plugins main panel)', () => {
  afterEach(() => {
    document.body.textContent = ''
    consumeCardExpand()
  })

  /** A sidebar-style Plugins panel entry (shipped aria-label). */
  function panelEntry(doc: Document, label: string): HTMLButtonElement {
    const b = doc.createElement('button')
    b.setAttribute('aria-label', label)
    doc.body.appendChild(b)
    return b
  }

  /** The bundle card as the Plugins page ships it: a title button plus the enable switch. */
  function bundleCard(doc: Document, withTitle = true): { title: HTMLButtonElement; switchEl: HTMLButtonElement } {
    const li = doc.createElement('li')
    li.setAttribute('data-plugin-package', 'dsh-context')
    const title = doc.createElement('button')
    title.setAttribute('aria-label', 'View dsh-context')
    li.appendChild(title)
    const switchEl = doc.createElement('button')
    switchEl.setAttribute('role', 'switch')
    switchEl.setAttribute('aria-label', 'Enable dsh-context')
    li.appendChild(switchEl)
    if (!withTitle) title.remove()
    doc.body.appendChild(li)
    return { title, switchEl }
  }

  test('clicks the Plugins panel entry, then follows the page to the bundle card', () => {
    const panel = panelEntry(document, '插件')
    const pClicks = clicks(panel)
    const t = trigger(document, 'false')
    const tClicks = clicks(t)
    const { runs, schedule } = syncSchedule()

    openPluginSettings(document, schedule)

    assert.equal(pClicks.count(), 1, 'the panel entry is clicked immediately')
    assert.equal(tClicks.count(), 0, 'no settings-dialog legs')
    assert.equal(runs.length, 1, 'the card poll is scheduled')
    // The list has not rendered the card yet: the poll keeps ticking.
    runs[0]()
    assert.equal(runs.length, 2)
    // The card renders: its title control opens the bundle's page.
    const { title, switchEl } = bundleCard(document)
    const titleClicks = clicks(title)
    const switchClicks = clicks(switchEl)
    runs[1]()
    assert.equal(titleClicks.count(), 1, 'the title control opens the bundle page')
    assert.equal(switchClicks.count(), 0, 'the enable switch is never touched')
    assert.equal(runs.length, 2, 'the poll stops on success')
    assert.equal(consumeCardExpand(), false, 'no expand request: this seat has no disclosure')
  })

  test('the poll keeps ticking to its deadline and stops silently without a card', () => {
    const panel = panelEntry(document, 'Plugins')
    const pClicks = clicks(panel)
    const { runs, schedule } = syncSchedule()

    openPluginSettings(document, schedule)
    // 1 bootstrap tick + 40 poll ticks, then the chain ends.
    for (let i = 0; i < 60 && runs.length > 0; i++) runs.shift()?.()

    assert.equal(pClicks.count(), 1)
    assert.equal(runs.length, 0, 'the poll exhausted its ticks and stopped')
  })

  test('a hostile card (no title control, or one that throws) never surfaces an error', () => {
    panelEntry(document, '插件')
    const { runs, schedule } = syncSchedule()
    openPluginSettings(document, schedule)
    runs.shift()?.()
    // Only a switch inside the card: no unique open control, the poll keeps ticking.
    bundleCard(document, false)
    assert.doesNotThrow(() => runs.shift()?.())
    assert.ok(runs.length > 0, 'still polling')
    // The card's title control throws on click: contained by the poll's guard, still polling.
    document.querySelector('[data-plugin-package="dsh-context"]')?.remove()
    const { title, switchEl } = bundleCard(document)
    const switchClicks = clicks(switchEl)
    title.click = () => { throw new Error('detached') }
    assert.doesNotThrow(() => runs.shift()?.())
    assert.equal(switchClicks.count(), 0, 'the enable switch is never touched')
  })

  test('lookalike aria-labels are ignored (exact match only)', () => {
    const lookalike = panelEntry(document, 'My Plugins')
    const lClicks = clicks(lookalike)
    const { runs, schedule } = syncSchedule()

    openPluginSettings(document, schedule)

    assert.equal(lClicks.count(), 0)
    assert.equal(runs.length, 0, 'no dialog trigger either: silent no-op')
  })
})
