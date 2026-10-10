import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerHooks } from 'node:module'
// The host primitives ship CSS modules; Node needs only their empty class map
// for these pure-logic / server-render tests, not a browser stylesheet loader.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css')
    ? { format: 'module', source: 'export default {}', shortCircuit: true }
    : nextLoad(url, context)
} })
const { AccountWindows, compactSegment, createCurrentModelReader, previewWindows,
  collapsedDisplays, expandedDisplays, windowLabel } = await import('../src/client/SubscriptionUsageBadge.js')
css.deregister()
import type { ProviderUsageDisplay } from '../src/client/SubscriptionUsageBadge.js'
import type { UsageWindow } from '../src/client/SubscriptionsSection.js'
import { en, zh } from '../src/client/locales.js'

/** Dictionary-bound translator with `{name}` substitution, as the locale seat supplies it. */
function translateFrom(dictionary: Record<keyof typeof en, string>) {
  return (key: keyof typeof en, params?: Record<string, unknown>): string =>
    dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

const windows: UsageWindow[] = Array.from({ length: 60 }, (_, i) => ({
  kind: 'other', scope: `gemini-model-${i}`, usedPercent: i,
}))
function display(provider: ProviderUsageDisplay['provider'] = 'antigravity', values = windows): ProviderUsageDisplay {
  return { provider, name: provider === 'antigravity' ? 'Antigravity' : 'Codex', accounts: [
    { key: 'default', isDefault: true, windows: values },
  ] }
}

test('Antigravity compact readout selects exact current model, not the entire catalog', () => {
  const d = display('antigravity', [...windows, { kind: 'weekly', scope: 'gemini-model-59', usedPercent: 81 }])
  assert.equal(compactSegment(d, 'gemini-model-59'), 'Antigravity Window 59% · Weekly 81%')
  assert.equal(compactSegment(d), 'Antigravity 60 model quotas')
  assert.equal(compactSegment(d, 'missing'), 'Antigravity Current model quota unavailable')
  assert.ok(compactSegment(d, 'gemini-model-1').length < 60)
})

test('compact summary uses default account and preserves bounded non-Antigravity windows', () => {
  const d = display('codex', [{ kind: 'session', usedPercent: 13 }, { kind: 'weekly', usedPercent: 25 }])
  d.accounts.unshift({ key: 'other', isDefault: false, windows: [{ kind: 'session', usedPercent: 99 }] })
  assert.equal(compactSegment(d), 'Codex 5h 13% · Wk 25%')
  assert.ok(compactSegment(display('codex')).endsWith('+58'))
})

test('preview promotes current-model windows without losing, merging, or mutating data', () => {
  const original = structuredClone(windows)
  const { shown, hidden } = previewWindows(windows, 'gemini-model-59')
  assert.equal(shown.length, 4)
  assert.equal(hidden.length, 56)
  assert.equal(shown[0]?.scope, 'gemini-model-59')
  assert.equal(new Set([...shown, ...hidden]).size, 60)
  assert.deepEqual(windows, original)
  assert.deepEqual(previewWindows([]), { shown: [], hidden: [] })
  assert.deepEqual(previewWindows(windows.slice(0, 2)).hidden, [])
})

test('rendered account keeps other windows in a closed native disclosure with localized labels', () => {
  for (const dictionary of [en, zh]) {
    const translate = translateFrom(dictionary)
    const html = renderToStaticMarkup(createElement(AccountWindows, { windows, model: 'gemini-model-59', translate }))
    assert.ok(html.includes('<details'))
    assert.ok(!html.includes('open=""'))
    assert.ok(html.includes(translate('usageBadgeMoreWindows', { count: 56 })))
    assert.ok(html.includes(translate('usageBadgeCurrent')))
    assert.ok(html.indexOf('gemini-model-59') < html.indexOf('<details'))
    assert.ok(html.includes('gemini-model-58'))
  }
})

test('window labels and remaining time come from the dictionary in both languages', () => {
  // A 30-second buffer keeps the minute and hour buckets stable while the test runs.
  const resetIn = (offsetMs: number): UsageWindow => ({ kind: 'other', usedPercent: 0, resetsAt: Date.now() + offsetMs })
  for (const [dictionary, expected] of [
    [en, { session: '5h', weekly: 'Wk', other: 'W', days: '6d18h', hours: '1h30m', minutes: '1m' }],
    [zh, { session: '5小时', weekly: '每周', other: '窗口', days: '6天18小时', hours: '1小时30分钟', minutes: '1分钟' }],
  ] as const) {
    const t = translateFrom(dictionary)
    assert.equal(windowLabel({ kind: 'session', usedPercent: 0 }, t), expected.session)
    assert.equal(windowLabel({ kind: 'weekly', usedPercent: 0 }, t), expected.weekly)
    assert.equal(windowLabel({ kind: 'other', usedPercent: 0 }, t), expected.other)
    assert.equal(windowLabel({ kind: 'other', scope: 'Opus', usedPercent: 0 }, t), 'Opus')
    assert.equal(windowLabel(resetIn((6 * 24 * 3600 + 18 * 3600) * 1000 + 30_000), t), expected.days)
    assert.equal(windowLabel(resetIn(90 * 60_000 + 30_000), t), expected.hours)
    assert.equal(windowLabel(resetIn(30_000), t), expected.minutes)
  }
})

test('provider ordering stays independent from model-window filtering', () => {
  const all = [display('codex'), display()]
  assert.deepEqual(collapsedDisplays(all, 'antigravity'), [all[1]])
  assert.deepEqual(expandedDisplays(all, 'antigravity'), [all[1], all[0]])
  assert.deepEqual(collapsedDisplays(all, undefined), all)
})

test('model reader observes switches within the same provider and handles missing directories', async () => {
  let model = 'one'
  const read = createCurrentModelReader(() => ({ directoryFor: sessionId => {
    assert.equal(sessionId, 'session')
    return { load: async () => ({ current: { provider: 'antigravity', model } }) }
  } }), 'session')
  assert.deepEqual(await read(), { provider: 'antigravity', model: 'one' })
  model = 'two'
  assert.deepEqual(await read(), { provider: 'antigravity', model: 'two' })
  assert.equal(await createCurrentModelReader(() => undefined, 'session')(), undefined)
  assert.equal(await createCurrentModelReader(() => ({ directoryFor: () => ({ load: async () => ({ current: null }) }) }), 'session')(), undefined)
})
