// The activity heatmap (src/client/components/heatmap.tsx): grid math off
// the injected today key, depth levels, day pinning, future cells, and the
// empty/degraded paths — rendered with real React.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { gridOf, makeHeatmap, todayKey } from '../../../src/client/components/heatmap'
import { click, hover, makeKit, mount, query, queryAll, text, unhover } from '../helpers/kit'

const kit = makeKit()
const Heatmap = makeHeatmap(kit)

// 2026-09-16 was a Wednesday of the week starting Monday 2026-09-14.
const TODAY = '2026-09-16'

describe('gridOf', () => {
  test('lays out weeks of Monday-first columns ending at today’s week', () => {
    const grid = gridOf(TODAY, 2)
    assert.ok(grid !== null)
    assert.equal(grid.length, 2)
    assert.equal(grid[0][0].key, '2026-09-07', 'the first column opens one week earlier')
    assert.equal(grid[1][0].key, '2026-09-14', 'the last column is today’s Monday')
    assert.equal(grid[1][2].key, TODAY)
    assert.equal(grid[1][2].future, false)
    assert.equal(grid[1][3].future, true, 'days after today render as future placeholders')
    assert.equal(grid[1][6].key, '2026-09-20')
  })

  test('degraded inputs read null (the card then shows its empty note)', () => {
    assert.equal(gridOf('', 2), null)
    assert.equal(gridOf('garbage', 2), null)
    assert.equal(gridOf(TODAY, 0), null, 'no columns to draw')
    assert.equal(gridOf(TODAY, 3000), null, 'a window reaching before the epoch has no first Monday')
    // 9999-12-31 was a Friday of the week starting Monday 9999-12-27: the
    // week's tail days leave the four-digit year, so no grid can hold it.
    assert.equal(gridOf('9999-12-31', 2), null, 'the final week of the representable range overflows')
  })
})

describe('Heatmap', () => {
  test('an empty ledger renders the empty note, no grid', async () => {
    const m = await mount(h(Heatmap, { days: {}, today: TODAY }))
    assert.ok(text(m.container).includes('No activity yet'))
    assert.equal(queryAll(m.container, '.lc-heat-cell').length, 0)
    await m.unmount()
  })

  test('a corrupt today key degrades to the empty note', async () => {
    const m = await mount(h(Heatmap, { days: { '2026-09-16': { tokens: 5, requests: 1, sessions: 1 } }, today: 'junk' }))
    assert.ok(text(m.container).includes('No activity yet'))
    await m.unmount()
  })

  test('cells draw with depth levels; data days are buttons with labels', async () => {
    const days = {
      '2026-09-16': { tokens: 100, requests: 4, sessions: 2 },
      '2026-09-15': { tokens: 50, requests: 2, sessions: 1 },
      '2026-09-14': { tokens: 25, requests: 1, sessions: 1 },
      '2026-09-09': { tokens: 75, requests: 3, sessions: 3 },
      '2026-09-08': { tokens: 1, requests: 1, sessions: 1 },
      '2026-09-07': { tokens: 0, requests: 2, sessions: 1 },
    }
    const m = await mount(h(Heatmap, { days, today: TODAY, weeks: 2 }))
    const buttons = queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
    // The zero-token day counts as activity (requests > 0) and draws level 0.
    assert.equal(buttons.length, 6)
    const byKey = new Map(buttons.map(b => [b.getAttribute('aria-label')?.split('\n')[0], b]))
    assert.ok(byKey.get('2026-09-16')?.className.includes('lc-heat-4'), 'the maximum day is deepest')
    assert.ok(byKey.get('2026-09-15')?.className.includes('lc-heat-2'))
    assert.ok(byKey.get('2026-09-14')?.className.includes('lc-heat-1'))
    assert.ok(byKey.get('2026-09-09')?.className.includes('lc-heat-3'))
    assert.ok(byKey.get('2026-09-08')?.className.includes('lc-heat-1'), 'a crumb is never invisible')
    assert.ok(byKey.get('2026-09-07')?.className.includes('lc-heat-0'))
    // The tooltip is two lines: the date, then the day's active sessions.
    assert.equal(byKey.get('2026-09-16')?.getAttribute('aria-label'), '2026-09-16\n2 active sessions')
    // Inert cells: data-less days and future days draw as plain spans.
    const spans = queryAll(m.container, 'span.lc-heat-cell')
    assert.ok(spans.length > 0)
    assert.ok(spans.some(s => s.className.includes('lc-heat-future')), 'future placeholders present')
    // Weekday labels: Mon/Wed/Fri rows carry letters, the rest blank.
    const wds = queryAll(m.container, '.lc-heat-wd')
    assert.deepEqual(wds.map(w => w.textContent), ['', 'M', '', 'W', '', 'F', ''])
    await m.unmount()
  })

  test('month labels mark the columns where a month begins', async () => {
    const days = { '2026-09-16': { tokens: 10, requests: 1, sessions: 1 } }
    // The default 8-week window runs Monday 2026-07-27 → 2026-09-14: July
    // began outside it, August begins in the Jul 27 column (Sat Aug 1) and
    // September in the Aug 31 column (Tue Sep 1).
    const m = await mount(h(Heatmap, { days, today: TODAY }))
    assert.deepEqual(queryAll(m.container, '.lc-heat-mon').map(s => s.textContent), ['Aug', 'Sep'])
    await m.unmount()
    // A window without any month's first day draws no labels at all.
    const m2 = await mount(h(Heatmap, { days, today: TODAY, weeks: 2 }))
    assert.deepEqual(queryAll(m2.container, '.lc-heat-mon').map(s => s.textContent), [])
    await m2.unmount()
    // A column that opens on the 1st carries the label itself.
    const m3 = await mount(h(Heatmap, { days: { '2026-06-03': { tokens: 1, requests: 1, sessions: 1 } }, today: '2026-06-03', weeks: 1 }))
    assert.deepEqual(queryAll(m3.container, '.lc-heat-mon').map(s => s.textContent), ['Jun'])
    await m3.unmount()
  })

  test('cells tip through the harness Tooltip: the bubble mounts on hover and drops on leave', async () => {
    const m = await mount(h(Heatmap, {
      days: { '2026-09-16': { tokens: 10, requests: 1, sessions: 3 } },
      today: TODAY,
      weeks: 2,
    }))
    const cell = query<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
    await hover(cell)
    assert.equal(query(m.container, '[role="tooltip"]').textContent, '2026-09-16\n3 active sessions')
    await unhover(cell)
    assert.equal(queryAll(m.container, '[role="tooltip"]').length, 0, 'the bubble drops when the pointer leaves')
    // An empty day tips too — the bare date, one line.
    await hover(query(m.container, 'span.lc-heat-0'))
    assert.match(query(m.container, '[role="tooltip"]').textContent ?? '', /^\d{4}-\d{2}-\d{2}$/)
    await m.unmount()
  })

  test('clicking a data day pins it; clicking again releases; the ring follows the selection', async () => {
    const picked: (string | null)[] = []
    const record = (day: string | null): void => { picked.push(day) }
    const m = await mount(h(Heatmap, {
      days: { '2026-09-16': { tokens: 10, requests: 1, sessions: 1 } },
      today: TODAY,
      weeks: 2,
      selected: null,
      onSelect: record,
    }))
    const cell = query<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
    await click(cell)
    assert.deepEqual(picked, ['2026-09-16'])
    await m.update(h(Heatmap, {
      days: { '2026-09-16': { tokens: 10, requests: 1, sessions: 1 } },
      today: TODAY,
      weeks: 2,
      selected: '2026-09-16',
      onSelect: record,
    }))
    assert.ok(query(m.container, 'button.lc-heat-cell').className.includes('lc-heat-on'))
    assert.equal(query(m.container, 'button.lc-heat-cell').getAttribute('aria-pressed'), 'true')
    await click(query<HTMLButtonElement>(m.container, 'button.lc-heat-cell'))
    assert.deepEqual(picked, ['2026-09-16', null], 'the second click releases the pin')
    await m.unmount()
  })

  test('without an onSelect relay the cells stay inert', async () => {
    const m = await mount(h(Heatmap, { days: { '2026-09-16': { tokens: 10, requests: 1, sessions: 1 } }, today: TODAY, weeks: 2 }))
    const cell = query<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
    await click(cell)
    assert.ok(!cell.className.includes('lc-heat-on'))
    await m.unmount()
  })

  test('todayKey keys the render day (the panel’s runtime call)', () => {
    assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/)
  })
})
