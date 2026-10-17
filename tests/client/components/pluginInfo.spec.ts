import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import type { makePluginInfo as makePluginInfoFn } from '../../../src/client/components/pluginInfo'
import { flush, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()

function stubFetchOk(body: { version?: unknown }) {
  const fetchMock = vi.fn((_input: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Fresh latestVersion + pluginInfo modules — resetModules so the baked-in version define
 * and the fetch TTL cache start clean; `version` emulates the tsdown define. */
async function loadPluginInfo(version?: string): Promise<ReturnType<typeof makePluginInfoFn>> {
  vi.resetModules()
  if (version === undefined) delete (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__
  else (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__ = version
  await import('../../../src/client/latestVersion')
  const mod = await import('../../../src/client/components/pluginInfo')
  return mod.makePluginInfo(kit)
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__
})

describe('PluginInfo', () => {
  test('dev build renders the static rows and never checks the registry', async () => {
    const fetchMock = stubFetchOk({ version: '9.9.9' })
    const PluginInfo = await loadPluginInfo() // PLUGIN_VERSION = 0.0.0-dev
    const m = await mount(h(PluginInfo, {}))
    await flush()
    assert.equal(fetchMock.mock.calls.length, 0)
    assert.ok(text(m.container).includes('Plugin Info'))
    const rows = queryAll(m.container, '.lc-pi-row')
    assert.equal(rows.length, 3)
    // Every row's label leads with its site mark (DeepSeek / GitHub / the settings gear).
    for (const row of rows) assert.equal(queryAll(row, '.lc-pi-label .lc-pi-labelicon').length, 1)
    assert.equal(query(rows[0], '.lc-pi-label').textContent, 'Plugin')
    assert.equal(query(rows[0], '.lc-pi-value').textContent, 'dsh-context (v0.0.0-dev)')
    assert.equal(rows[0].getAttribute('href'), 'https://github.com/bowenliang123/dsh-context')
    assert.equal(rows[0].getAttribute('target'), '_blank')
    assert.equal(query(rows[1], '.lc-pi-label').textContent, 'GitHub')
    assert.equal(query(rows[1], '.lc-pi-value').textContent, 'bowenliang123/dsh-context')
    assert.equal(rows[1].getAttribute('href'), 'https://github.com/bowenliang123/dsh-context')
    // The settings entry: a button (no href) below GitHub — the guarded jump runs on click.
    assert.equal(rows[2].getAttribute('href'), null)
    assert.equal(query(rows[2], '.lc-pi-label').textContent, 'Plugin Settings')
    assert.equal(query(rows[2], '.lc-pi-value').textContent, 'Open plugin settings')
    const hint = query(m.container, '.lc-pi-hint')
    assert.ok(text(hint).includes('The best DSH context plugin'))
    assert.equal(hint.getAttribute('href'), 'https://github.com/bowenliang123/dsh-context')
    assert.equal(hint.getAttribute('target'), '_blank')
    assert.equal(hint.getAttribute('rel'), 'noreferrer')
    assert.equal(queryAll(m.container, '.lc-pi-update').length, 0)
    // The settings entry runs the guarded jump; without the harness chrome in
    // the jsdom document it silently no-ops — safe to click in tests.
    assert.doesNotThrow(() => rows[2].click())
    await m.unmount()
  })

  test('release build with a newer registry version appends the update chip', async () => {
    const fetchMock = stubFetchOk({ version: '1.1.0' })
    const PluginInfo = await loadPluginInfo('1.0.0')
    const m = await mount(h(PluginInfo, {}))
    await flush()
    assert.equal(fetchMock.mock.calls.length, 1)
    assert.equal(fetchMock.mock.calls[0][0], 'https://registry.npmjs.org/dsh-context/latest')
    assert.ok(text(m.container).includes('dsh-context (v1.0.0)'))
    assert.equal(query(m.container, '.lc-pi-update').textContent, '↑ v1.1.0')
    await m.unmount()
  })

  test('a registry version that is not newer renders no chip', async () => {
    stubFetchOk({ version: '1.0.0' })
    const PluginInfo = await loadPluginInfo('1.0.0')
    const m = await mount(h(PluginInfo, {}))
    await flush()
    assert.equal(queryAll(m.container, '.lc-pi-update').length, 0)
    await m.unmount()
  })
})
