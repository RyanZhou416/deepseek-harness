// UpdatePill (src/client/components/updatePill.tsx): the Insights head's newer-version capsule. What it
// renders and where it links; the check itself (dev skip, not-newer, registry failure, late result) is
// useNewerVersion's, covered once in tests/client/latestVersion.spec.ts.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import type { makeUpdatePill as makeUpdatePillFn } from '../../../src/client/components/updatePill'
import { flush, makeKit, mount, query, queryAll } from '../helpers/kit'

/** Fresh latestVersion + updatePill modules — resetModules so the baked-in version define and the fetch
 *  TTL cache start clean; `version` emulates the tsdown define. */
async function loadUpdatePill(version: string, active: 'en' | 'zh' = 'en'): Promise<ReturnType<typeof makeUpdatePillFn>> {
  vi.resetModules()
  ;(globalThis as Record<string, unknown>).__DSH_CTX_VERSION__ = version
  await import('../../../src/client/latestVersion')
  const mod = await import('../../../src/client/components/updatePill')
  return mod.makeUpdatePill(makeKit(active))
}

/** A registry one minor ahead of the running build. */
function stubRegistry(): void {
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ version: '1.1.0' }) }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__
})

describe('UpdatePill', () => {
  test('a newer version paints the capsule linking the release notes', async () => {
    stubRegistry()
    const UpdatePill = await loadUpdatePill('1.0.0')
    const m = await mount(h(UpdatePill, {}))
    await flush()
    const pill = query(m.container, '.lc-ov-update')
    assert.equal(pill.getAttribute('href'), 'https://github.com/bowenliang123/dsh-context/releases/latest')
    assert.equal(pill.getAttribute('target'), '_blank')
    assert.equal(pill.getAttribute('rel'), 'noreferrer')
    assert.equal(query(pill, '.lc-ov-update-label').textContent, 'Update')
    assert.equal(query(pill, '.lc-ov-update-version').textContent, '↑ v1.1.0')
    // The tip rides the page's portaled hover bubble, below the pill in the head.
    assert.equal(pill.getAttribute('data-lc-tip'), 'Update v1.1.0 is available — click for the release notes')
    assert.equal(pill.getAttribute('data-lc-tip-side'), 'bottom')
    assert.equal(pill.getAttribute('aria-label'), pill.getAttribute('data-lc-tip'))
    await m.unmount()
  })

  test('the Chinese dictionary rides the same capsule', async () => {
    stubRegistry()
    const UpdatePill = await loadUpdatePill('1.0.0', 'zh')
    const m = await mount(h(UpdatePill, {}))
    await flush()
    assert.equal(query(m.container, '.lc-ov-update-label').textContent, '新版本')
    assert.equal(query(m.container, '.lc-ov-update-version').textContent, '↑ v1.1.0')
    await m.unmount()
  })

  test('the build being current leaves the head unpainted', async () => {
    stubRegistry()
    const UpdatePill = await loadUpdatePill('1.1.0')
    const m = await mount(h(UpdatePill, {}))
    await flush()
    assert.equal(queryAll(m.container, '.lc-ov-update').length, 0)
    await m.unmount()
  })
})