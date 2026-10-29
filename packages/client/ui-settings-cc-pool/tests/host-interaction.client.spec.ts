// @vitest-environment jsdom
/**
 * The page against a synthetic Host: the real settings mirror and form, the
 * scripted settings document, the credential store, and the pool's own model
 * discovery. Covers the complete round trip — load the built-in catalogue, edit
 * rows, block invalid edits, write the section and the credential, then reload
 * from what the Host kept — and the pool sync that stages a merge for that save.
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '../src/client/index.ts'
import type { CcPoolSectionFace } from '../src/client/settings-controller.ts'
import { CC_POOL_NS, CC_POOL_PROVIDER } from '../src/client/contract.ts'
import { en } from '../src/client/locales.ts'
import { BUILT_IN_MODELS, createCcPoolHost, OTHER_NS, OTHER_VALUE, POOL_LISTING } from './support/cc-pool-host.client.ts'
import type { CcPoolHost, CcPoolHostOptions } from './support/cc-pool-host.client.ts'

const runtimeOf = { current: undefined as SlotTestRuntime | undefined }

afterEach(async () => {
  await runtimeOf.current?.dispose()
  runtimeOf.current = undefined
})

/** Read one input's current value. */
function valueOf(element: HTMLElement | null): string {
  return (element as HTMLInputElement).value
}

/** Read every input's current value. */
function valuesOf(elements: readonly HTMLElement[]): string[] {
  return elements.map(element => valueOf(element))
}

/** The catalogue stored in the scripted Host's pool entry. */
function storedIds(host: CcPoolHost): string[] {
  const entry = host.entry() as { models: { id: string }[] }
  return entry.models.map(model => model.id)
}

/** One stored catalogue entry, as a spec reads it back from the Host. */
type StoredModel = {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  defaultReasoning: string
}

/** The ids of the built-in catalogue. */
function builtInIds(): string[] {
  return BUILT_IN_MODELS.map(model => (model as { id: string }).id)
}

/** Mount the settings domain and the page over one scripted Host. */
async function bench(options: CcPoolHostOptions = {}, rows = 4) {
  const runtime = await SlotTestRuntime.create()
  runtimeOf.current = runtime
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const host = createCcPoolHost(options)
  runtime.remote.provideNamespaces({ settings: host.settings, credentials: host.credentials, llm: host.llm })
  await runtime.mount({ inject: [...settingsInject], apply: settingsApply })
  const feature = await runtime.mount({ inject: [...inject], apply })
  await runtime.declare({ 'settings.section': { kind: 'list', scope: 'root' } })
  await waitFor(() => { expect(runtime.slots.entries('settings.section')).toHaveLength(1) })
  const view = runtime.renderSlot('settings.section', { close: vi.fn() })
  await waitFor(() => { expect(view.view.getAllByLabelText(en.modelId)).toHaveLength(rows) })
  // Let the mount-time credential read settle, so the page knows whether a
  // pool token is stored before a spec drives the sync.
  await act(async () => {})
  return { runtime, host, view, feature }
}

/** The live inject face of the registered page. */
function faceOf(runtime: SlotTestRuntime): CcPoolSectionFace {
  const entry = runtime.slots.entries('settings.section')[0]
  if (entry === undefined) throw new Error('no settings section registered')
  const inject = entry.inject
  if (inject === undefined) throw new Error('the registered page has no inject face')
  // The slot ledger erases the contribution's face; this package's registration
  // is the only writer of that key, so the erased read states the declared type.
  const face: unknown = inject()
  return face as CcPoolSectionFace
}

describe('CC subscription pool page against a synthetic Host', () => {
  it('loads the built-in catalogue and an unconfigured credential on first render', async () => {
    const { host, view } = await bench()

    expect(view.view.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(valuesOf(view.view.getAllByLabelText(en.modelId))).toEqual(builtInIds())
    expect(view.view.getByText(en.tokenUnset)).toBeTruthy()
    expect(host.storedToken()).toBeUndefined()
    expect(host.entry(OTHER_NS)).toEqual(OTHER_VALUE)
  })

  it('writes the edited catalogue and the typed credential in one save, leaving other providers alone', async () => {
    const { host, view } = await bench()

    fireEvent.change(view.view.getAllByLabelText(en.modelId)[0]!, { target: { value: 'claude-sonnet-5-6' } })
    fireEvent.change(view.view.getAllByLabelText(en.modelContext)[0]!, { target: { value: '200000' } })
    fireEvent.change(view.view.getAllByLabelText(en.modelEffort)[0]!, { target: { value: 'max' } })
    fireEvent.change(view.view.getByLabelText(en.token), { target: { value: 'sk-pool-live' } })
    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.save }))
    })

    await waitFor(() => { expect(host.storedToken()).toBe('sk-pool-live') })
    expect(storedIds(host)).toEqual([
      'claude-sonnet-5-6', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-mythos-5-1',
    ])
    const stored = host.entry() as { models: { contextWindow: number; defaultReasoning: string }[] }
    expect(stored.models[0]).toMatchObject({ contextWindow: 200_000, defaultReasoning: 'max' })
    // The same save must not touch any other provider's section.
    expect(host.entry(OTHER_NS)).toEqual(OTHER_VALUE)

    // The literal left the page for the credential domain and is not echoed back.
    await waitFor(() => { expect(valueOf(view.view.getByLabelText(en.token))).toBe('') })
    expect(view.view.getByText(en.tokenConfiguredFrom.replace('{source}', 'file'))).toBeTruthy()
  })

  it('re-seeds the rows from what the Host stored, so normalized text leaves the save off', async () => {
    const { host, view } = await bench()

    fireEvent.change(view.view.getAllByLabelText(en.modelContext)[0]!, { target: { value: ' 000200000 ' } })
    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.save }))
    })
    await waitFor(() => {
      const stored = host.entry() as { models: StoredModel[] }
      expect(stored.models[0]?.contextWindow).toBe(200_000)
    })
    // The page shows the accepted (normalized) catalogue again, so nothing is
    // left to save and the save control goes back to its resting state.
    await waitFor(() => { expect(valueOf(view.view.getAllByLabelText(en.modelContext)[0]!)).toBe('200000') })
    expect(view.view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  })

  it('blocks the save on a duplicate id and recovers once it is fixed', async () => {
    const { host, view } = await bench()

    fireEvent.change(view.view.getAllByLabelText(en.modelId)[1]!, { target: { value: 'claude-sonnet-5-5' } })
    expect(view.view.getAllByText(en.idDuplicate)).toHaveLength(2)
    expect(view.view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(storedIds(host)).toEqual(builtInIds())

    fireEvent.change(view.view.getAllByLabelText(en.modelId)[1]!, { target: { value: 'claude-opus-5-6' } })
    expect(view.view.queryAllByText(en.idDuplicate)).toHaveLength(0)
    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.save }))
    })
    await waitFor(() => { expect(storedIds(host)[1]).toBe('claude-opus-5-6') })
  })

  it('adds and removes rows, and refuses to save an empty catalogue', async () => {
    const { host, view } = await bench()

    fireEvent.click(view.view.getByRole('button', { name: en.addModel }))
    expect(view.view.getAllByLabelText(en.modelId)).toHaveLength(5)
    fireEvent.change(view.view.getAllByLabelText(en.modelId)[4]!, { target: { value: 'claude-nova-1' } })
    fireEvent.change(view.view.getAllByLabelText(en.modelName)[4]!, { target: { value: 'Claude Nova 1' } })
    fireEvent.change(view.view.getAllByLabelText(en.modelContext)[4]!, { target: { value: '500000' } })
    fireEvent.change(view.view.getAllByLabelText(en.modelMaxTokens)[4]!, { target: { value: '32000' } })
    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.save }))
    })
    await waitFor(() => { expect(storedIds(host)).toHaveLength(5) })
    expect(storedIds(host)[4]).toBe('claude-nova-1')

    for (let index = 4; index >= 0; index -= 1) {
      fireEvent.click(view.view.getAllByRole('button', { name: /Remove model/ })[index]!)
    }
    expect(view.view.queryAllByLabelText(en.modelId)).toHaveLength(0)
    expect(view.view.getByText(en.emptyCatalogue)).toBeTruthy()
    expect(view.view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  })

  it('restores the built-in catalogue through the staged reset and keeps the override removed', async () => {
    const { runtime, host, view } = await bench()

    fireEvent.change(view.view.getAllByLabelText(en.modelId)[0]!, { target: { value: 'claude-sonnet-9' } })
    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.save }))
    })
    await waitFor(() => { expect(storedIds(host)[0]).toBe('claude-sonnet-9') })
    // The accepted write stores an override, and the page says so.
    await waitFor(() => { expect(view.view.getByText(en.modelsOverridden)).toBeTruthy() })
    expect(faceOf(runtime).hooks.ccPool.getSnapshot().overridden).toBe(true)

    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.resetModels }))
    })
    expect(valuesOf(view.view.getAllByLabelText(en.modelId))).toEqual(builtInIds())
    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.save }))
    })
    await waitFor(() => { expect(storedIds(host)).toEqual(builtInIds()) })
    expect(host.entry()).toEqual({ models: BUILT_IN_MODELS })
    // The reset removed the user layer, so nothing reports an override and the
    // inherited catalogue leaves no staged edit behind.
    await waitFor(() => { expect(view.view.queryByText(en.modelsOverridden)).toBeNull() })
    expect(faceOf(runtime).hooks.ccPool.getSnapshot().overridden).toBe(false)
    await waitFor(() => { expect(view.view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true) })
  })

  it('keeps the drafts and names a conflict when another change reached the section first', async () => {
    const { host, view } = await bench()

    fireEvent.change(view.view.getAllByLabelText(en.modelId)[0]!, { target: { value: 'claude-sonnet-5-6' } })
    // Another surface writes the section while the page still holds the drafts.
    const elsewhere = BUILT_IN_MODELS.map(model => ({ ...(model as { id: string; name: string }) }))
    elsewhere[1] = { ...(elsewhere[1] as { id: string; name: string }), name: 'Renamed elsewhere' }
    await act(async () => {
      const answer = await host.settings.mutate(CC_POOL_NS, [{ op: 'set', path: ['models'], value: elsewhere }], 0)
      expect(answer.ok).toBe(true)
    })
    expect(host.revision()).toBe(1)

    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.save }))
    })
    await waitFor(() => { expect(view.view.getByText(en.saveConflict)).toBeTruthy() })
    // The refusal is a concurrent write, not these values: the draft survives
    // and the page does not claim the values were refused.
    expect(view.view.queryByText(en.saveFailed)).toBeNull()
    expect(valueOf(view.view.getAllByLabelText(en.modelId)[0]!)).toBe('claude-sonnet-5-6')

    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.save }))
    })
    await waitFor(() => { expect(storedIds(host)[0]).toBe('claude-sonnet-5-6') })
    expect(host.revision()).toBe(2)
    await waitFor(() => { expect(view.view.queryByText(en.saveConflict)).toBeNull() })
    await waitFor(() => { expect(view.view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true) })
  })

  it('opens a Host catalogue with padding and a blank name as a list that can be saved', async () => {
    // The Host accepts these entries as stored; the page must not turn them into
    // a field error the user cannot clear, so it reads the text a save writes.
    const padded = [
      { id: '  claude-sonnet-5-5  ', name: '  Claude Sonnet 5.5  ', contextWindow: 1_000_000, maxTokens: 128_000, defaultReasoning: 'medium' },
      { id: 'claude-opus-5-5', name: '   ', contextWindow: 1_000_000, maxTokens: 128_000, defaultReasoning: 'medium' },
    ]
    const { host, view } = await bench({ models: padded }, 2)

    expect(valuesOf(view.view.getAllByLabelText(en.modelId))).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
    expect(valuesOf(view.view.getAllByLabelText(en.modelName))).toEqual(['Claude Sonnet 5.5', 'claude-opus-5-5'])
    expect(view.view.queryAllByText(en.nameBlank)).toHaveLength(0)
    expect(view.view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)

    fireEvent.change(view.view.getAllByLabelText(en.modelName)[1]!, { target: { value: '  Opus  ' } })
    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.save }))
    })
    await waitFor(() => { expect(host.revision()).toBe(1) })
    const stored = host.entry() as { models: StoredModel[] }
    expect(stored.models[0]).toEqual({
      id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxTokens: 128_000, defaultReasoning: 'medium',
    })
    expect(stored.models[1]).toMatchObject({ id: 'claude-opus-5-5', name: 'Opus' })
    await waitFor(() => { expect(valuesOf(view.view.getAllByLabelText(en.modelId))).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']) })
    await waitFor(() => { expect(view.view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true) })
  })

  it('keeps the stored catalogue and credential across a page reload', async () => {
    const { runtime, host, view, feature } = await bench()
    fireEvent.change(view.view.getAllByLabelText(en.modelId)[0]!, { target: { value: 'claude-sonnet-7' } })
    fireEvent.change(view.view.getByLabelText(en.token), { target: { value: 'sk-persisted' } })
    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.save }))
    })
    await waitFor(() => { expect(host.storedToken()).toBe('sk-persisted') })
    const revision = host.revision()

    // Reload: the page fiber leaves and a fresh one mounts over the same Host.
    await feature.dispose()
    expect(runtime.slots.entries('settings.section')).toHaveLength(0)
    await runtime.mount({ inject: [...inject], apply })
    await waitFor(() => { expect(runtime.slots.entries('settings.section')).toHaveLength(1) })

    const face = faceOf(runtime)
    await waitFor(() => {
      expect(face.hooks.ccPool.getSnapshot().rows.map(row => row.draft.id)[0]).toBe('claude-sonnet-7')
    })
    expect(face.hooks.ccPool.getSnapshot().token).toMatchObject({ configured: true, source: 'file' })
    // A reload reads; it does not write.
    expect(host.revision()).toBe(revision)
  })

  it('merges the pool listing into the table, saves it, and reloads it from the Host', async () => {
    const { runtime, host, view, feature } = await bench({
      token: 'sk-pool-live',
      pool: [...POOL_LISTING, { id: 'claude-nova-5', name: 'Claude Nova 5' }],
    })

    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.syncModels }))
    })
    await waitFor(() => { expect(view.view.getAllByLabelText(en.modelId)).toHaveLength(5) })

    expect(host.discoveryRequests()).toEqual([{ ns: CC_POOL_NS, request: { provider: CC_POOL_PROVIDER } }])
    expect(valuesOf(view.view.getAllByLabelText(en.modelId))).toEqual([...builtInIds(), 'claude-nova-5'])
    expect(view.view.getAllByText(en.fromPool)).toHaveLength(1)
    expect(valuesOf(view.view.getAllByLabelText(en.modelName)).at(-1)).toBe('Claude Nova 5')
    expect(valueOf(view.view.getAllByLabelText(en.modelContext).at(-1)!)).toBe('1000000')
    expect(valueOf(view.view.getAllByLabelText(en.modelMaxTokens).at(-1)!)).toBe('128000')
    expect(view.view.getAllByLabelText(en.modelEffort).at(-1)).toHaveProperty('value', 'medium')
    // The sync stages the merge; only the save writes the section.
    expect(host.revision()).toBe(0)

    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.save }))
    })
    await waitFor(() => { expect(storedIds(host)).toHaveLength(5) })
    const stored = host.entry() as { models: StoredModel[] }
    expect(stored.models[4]).toEqual({
      id: 'claude-nova-5', name: 'Claude Nova 5', contextWindow: 1_000_000, maxTokens: 128_000, defaultReasoning: 'medium',
    })
    expect(host.entry(OTHER_NS)).toEqual(OTHER_VALUE)

    // Reload: what the Host kept is the merged catalogue, without the marker.
    await feature.dispose()
    await runtime.mount({ inject: [...inject], apply })
    await waitFor(() => { expect(runtime.slots.entries('settings.section')).toHaveLength(1) })
    const face = faceOf(runtime)
    await waitFor(() => {
      expect(face.hooks.ccPool.getSnapshot().rows.map(row => row.draft.id)).toEqual([...builtInIds(), 'claude-nova-5'])
    })
    expect(face.hooks.ccPool.getSnapshot().rows.some(row => row.synced)).toBe(false)
  })

  it('asks before dropping the models the pool no longer lists and drops them on confirm', async () => {
    const { host, view } = await bench({ token: 'sk-pool-live', pool: POOL_LISTING.slice(0, 1) })

    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.syncModels }))
    })
    const dialog = await waitFor(() => screen.getByRole('dialog', { name: en.syncRemoveTitle }))
    expect(host.revision()).toBe(0)
    expect(valuesOf(view.view.getAllByLabelText(en.modelId))).toEqual(builtInIds())

    fireEvent.click(within(dialog).getByRole('button', { name: en.syncRemoveConfirm }))
    await waitFor(() => { expect(view.view.getAllByLabelText(en.modelId)).toHaveLength(1) })
    expect(valuesOf(view.view.getAllByLabelText(en.modelId))).toEqual([builtInIds()[0]])

    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.save }))
    })
    await waitFor(() => { expect(storedIds(host)).toEqual([builtInIds()[0]]) })
  })

  it('keeps the models the pool no longer lists when the user keeps them', async () => {
    const { host, view } = await bench({
      token: 'sk-pool-live',
      pool: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }, { id: 'claude-nova-5', name: 'Claude Nova 5' }],
    })

    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.syncModels }))
    })
    const dialog = await waitFor(() => screen.getByRole('dialog', { name: en.syncRemoveTitle }))
    fireEvent.click(within(dialog).getByRole('button', { name: en.syncRemoveKeep }))

    await waitFor(() => { expect(view.view.getAllByLabelText(en.modelId)).toHaveLength(5) })
    expect(valuesOf(view.view.getAllByLabelText(en.modelId))).toEqual([...builtInIds(), 'claude-nova-5'])
    expect(host.revision()).toBe(0)

    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.save }))
    })
    await waitFor(() => { expect(storedIds(host)).toHaveLength(5) })
    expect(storedIds(host)).toEqual([...builtInIds(), 'claude-nova-5'])
  })

  it('cancels the whole sync when the removal prompt is dismissed', async () => {
    const { host, view } = await bench({ token: 'sk-pool-live', pool: POOL_LISTING.slice(0, 1) })

    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.syncModels }))
    })
    const dialog = await waitFor(() => screen.getByRole('dialog', { name: en.syncRemoveTitle }))
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))

    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    // Dismissing the prompt cancels the merge, so neither the removals nor the
    // additions are staged and the list stays exactly as it was.
    expect(valuesOf(view.view.getAllByLabelText(en.modelId))).toEqual(builtInIds())
    expect(view.view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(host.revision()).toBe(0)
  })

  it('reports an empty or refused pool listing and writes nothing', async () => {
    const { host, view } = await bench({ token: 'sk-pool-live', pool: [] })

    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.syncModels }))
    })
    await waitFor(() => { expect(view.view.getByText(en.syncEmpty)).toBeTruthy() })
    expect(valuesOf(view.view.getAllByLabelText(en.modelId))).toEqual(builtInIds())
    expect(host.revision()).toBe(0)

    host.refuseDiscovery('no model discovery is registered for "llm-cc-pool"')
    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.syncModels }))
    })
    await waitFor(() => {
      expect(view.view.getByText(en.syncFailed.replace('{reason}', 'no model discovery is registered for "llm-cc-pool"'))).toBeTruthy()
    })
    expect(host.revision()).toBe(0)
  })

  it('refuses to sync before a pool token is stored and asks the Host nothing', async () => {
    const { host, view } = await bench()

    await act(async () => {
      fireEvent.click(view.view.getByRole('button', { name: en.syncModels }))
    })
    await waitFor(() => { expect(view.view.getByText(en.syncNoToken)).toBeTruthy() })
    expect(host.discoveryRequests()).toEqual([])
    expect(valuesOf(view.view.getAllByLabelText(en.modelId))).toEqual(builtInIds())
  })
})
