/** What the browser half registers, when, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, NS } from '../src/client/index.ts'
import type { CcPoolSectionFace } from '../src/client/settings-controller.ts'
import { CC_POOL_API_KEY_REF } from '../src/client/contract.ts'
import { apply as hostApply } from '../src/index.ts'

// These specs assert the shipped Chinese copy, so the bench stages zh on the
// locale (the lane has no jsdom `window`, and a fresh LocaleRuntime opens on en).

/** One Host view of a served namespace. */
function view(ns: string, revision = 0) {
  return { ns, schema: {}, value: {}, applies: 'live', secrets: [], revision, autoGenerate: true }
}

/**
 * @param served - namespaces the settings Host describes; omitted answers a
 * failed read, which leaves the page nothing to register for.
 */
async function bench(served?: string[]) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const describeSettings = vi.fn(() => Promise.resolve(served === undefined
    ? { ok: false, error: new RemoteError('gateway/internal', 'no provider', {}) }
    : { ok: true, value: { writable: true, hasDocument: true, namespaces: served.map(ns => view(ns)) } }))
  const describeCredential = vi.fn(() => Promise.resolve({ ok: true, value: {} }))
  const remote = new TestRemote(ctx, {
    settings: { describe: describeSettings },
    credentials: { describe: describeCredential, set: vi.fn(), unset: vi.fn() },
    llm: { discoverModels: vi.fn() },
  })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, describeSettings, describeCredential, remote }
}

/** The Settings navigation slot, as its shell owner declares it. */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

/** The one registered page's inject face. */
function faceOf(slots: SlotRegistry): CcPoolSectionFace {
  const entry = slots.entries('settings.section')[0]
  if (entry === undefined) throw new Error('no settings section registered')
  const inject = entry.inject
  if (inject === undefined) throw new Error('the registered page has no inject face')
  // The slot ledger erases the contribution's face; this package's registration
  // is the only writer of that key, so the erased read states the declared type.
  const face: unknown = inject()
  return face as CcPoolSectionFace
}

describe('ui-settings-cc-pool apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.credentials', 'remote.llm', 'configForms'])
  })

  it('registers the nav page while the Host serves the pool entry, titled in the active locale', async () => {
    const { ctx, slots } = await bench(['llm-cc-pool', 'llm-pi-ai'])
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
    const entry = slots.entries('settings.section')[0]!
    expect(entry.options).toMatchObject({ id: 'cc-pool', order: 16 })
    expect(resolveSlotLabel(entry.options.label)).toBe('CC 订阅池')
    expect(entry.locale).toBe(NS)
    const face = faceOf(slots)
    expect(Object.keys(face.hooks)).toEqual(['ccPool'])
    expect(face.hooks.ccPool.getSnapshot()).toMatchObject({ dirty: false, rows: [] })
  })

  it('registers nothing while the pool entry is not served, and follows the Host when that changes', async () => {
    const { ctx, slots, describeSettings, remote } = await bench(['llm-pi-ai'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
    expect(slots.entries('settings.section')).toHaveLength(0)

    describeSettings.mockResolvedValue({
      ok: true, value: { writable: true, hasDocument: true, namespaces: [view('llm-cc-pool', 1)] },
    })
    remote.emit('settings/document-updated', ['llm-cc-pool', 1])
    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })

    describeSettings.mockResolvedValue({ ok: true, value: { writable: true, hasDocument: true, namespaces: [] } })
    remote.emit('settings/document-updated', ['llm-cc-pool', 2])
    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(0) })
  })

  it('reads the pool credential at mount and again after a credential or connection invalidation', async () => {
    const { ctx, slots, describeCredential, remote } = await bench(['llm-cc-pool'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeCredential).toHaveBeenCalledWith([CC_POOL_API_KEY_REF]) })

    remote.emit('credentials/reference-updated', [CC_POOL_API_KEY_REF])
    await vi.waitFor(() => { expect(describeCredential).toHaveBeenCalledTimes(2) })

    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(describeCredential).toHaveBeenCalledTimes(3) })
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench(['llm-cc-pool'])
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
  })

  it('collapses the page on teardown', async () => {
    const { ctx, slots } = await bench(['llm-cc-pool'])
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })

    await fiber.dispose()

    expect(slots.entries('settings.section')).toHaveLength(0)
  })
})
