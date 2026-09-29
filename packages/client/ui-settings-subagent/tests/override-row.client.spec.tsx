// @vitest-environment jsdom
/** General Settings edits accepted overrides without sharing plugin-page drafts. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFormScopeSnapshot } from '@deepseek-ai/dsh-client-ui-primitives'
import { SubagentOverrideRow, type SubagentOverrideRowProps } from '../src/client/SubagentOverrideRow.tsx'
import type { SubagentLimitsSettings, SubagentModelOverrideValue } from '../src/client/subagent-limits-card-controller.ts'
import type { SubagentModelSelectionCardState } from '../src/client/subagent-model-selection-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function bench(override: SubagentModelOverrideValue | false = false, writable = true) {
  const settings = createSnapshotStore<SettingsFormScopeSnapshot<SubagentLimitsSettings>>({
    status: 'ready', writable, revision: 7, base: {}, user: {},
    value: { maxDepth: 2, maxActiveSubagents: 8, modelOverride: override },
  })
  const catalog = createSnapshotStore<SubagentModelSelectionCardState>({
    available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false,
    enabled: false, conflicted: false, catalogStatus: 'ready', catalogPartial: false,
    candidates: ['fast', 'deep'].map(model => ({
      provider: 'alpha', model, key: 'alpha\0' + model, providerName: 'Alpha', modelName: model,
      available: true, selected: false,
      reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
    })),
  })
  const select = vi.fn(async (value: SubagentModelOverrideValue | false, revision: number | undefined) => {
    const current = settings.getSnapshot()
    if (revision !== current.revision) return false
    settings.set({ ...current, revision: (revision ?? 0) + 1,
      value: { ...current.value!, modelOverride: value } })
    return true
  })
  const retry = vi.fn()
  render(<SubagentOverrideRow {...{
    useSubagentOverride: bindSnapshotSelector(settings),
    useSubagentModelSelectionCard: bindSnapshotSelector(catalog),
    selectOverride: select, retryCatalog: retry, t: (key: keyof typeof en) => en[key],
  } as SubagentOverrideRowProps} />)
  return { settings, catalog, select, retry }
}

describe('SubagentOverrideRow', () => {
  it('saves model and effort independently, offers model default, and can disable the override', async () => {
    const { select, settings } = bench()
    expect(screen.getByRole('button', { name: en.subagentOverrideGeneralEffort }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.subagentOverrideGeneralModel }))
    expect(screen.getByText('Alpha')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'fast' }))
    await waitFor(() => { expect(select).toHaveBeenLastCalledWith({ provider: 'alpha', model: 'fast' }, 7) })
    await waitFor(() => { expect(screen.getByRole('button', { name: en.subagentOverrideGeneralEffort }).getAttribute('disabled')).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: en.subagentOverrideGeneralEffort }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'High' }))
    await waitFor(() => { expect(select).toHaveBeenLastCalledWith({ provider: 'alpha', model: 'fast', reasoningEffort: 'high' }, 8) })
    await waitFor(() => { expect(screen.getByRole('button', { name: en.subagentOverrideGeneralEffort }).getAttribute('disabled')).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: en.subagentOverrideGeneralEffort }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.subagentOverrideDefaultEffort }))
    await waitFor(() => { expect(select).toHaveBeenLastCalledWith({ provider: 'alpha', model: 'fast' }, 9) })
    await waitFor(() => { expect(screen.getByRole('button', { name: en.subagentOverrideGeneralModel }).getAttribute('disabled')).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: en.subagentOverrideGeneralModel }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.subagentOverrideOff }))
    await waitFor(() => { expect(select).toHaveBeenLastCalledWith(false, 10) })
    expect(settings.getSnapshot().value).toEqual({ maxDepth: 2, maxActiveSubagents: 8, modelOverride: false })
  })

  it('clears the previous effort when changing models and follows accepted external changes', async () => {
    const { select, settings } = bench({ provider: 'alpha', model: 'fast', reasoningEffort: 'high' })
    fireEvent.click(screen.getByRole('button', { name: en.subagentOverrideGeneralModel }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'deep' }))
    await waitFor(() => { expect(select).toHaveBeenCalledWith({ provider: 'alpha', model: 'deep' }, 7) })
    act(() => { settings.set({ ...settings.getSnapshot(), value: { maxDepth: 2, maxActiveSubagents: 8,
      modelOverride: { provider: 'gone', model: 'saved-model', reasoningEffort: 'saved-effort' } } }) })
    expect(screen.getByRole('button', { name: en.subagentOverrideGeneralModel }).textContent).toContain('saved-model')
    expect(screen.getByRole('button', { name: en.subagentOverrideGeneralEffort }).textContent).toContain('saved-effort')
  })

  it('retains the accepted selection after a refused write and prevents duplicate input while saving', async () => {
    const { select } = bench()
    const pending = Promise.withResolvers<boolean>()
    select.mockImplementationOnce(() => pending.promise)
    fireEvent.click(screen.getByRole('button', { name: en.subagentOverrideGeneralModel }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'fast' }))
    expect(screen.getByRole('button', { name: en.subagentOverrideGeneralModel }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: en.subagentOverrideGeneralModel }))
    expect(screen.queryByRole('menu')).toBeNull()
    await act(async () => { pending.resolve(false); await pending.promise })
    expect(screen.getByRole('alert').textContent).toBe(en.subagentOverrideSaveFailed)
    expect(screen.getByRole('button', { name: en.subagentOverrideGeneralModel }).textContent).toContain(en.subagentOverrideOff)
  })

  it('loads the catalog only when a selector opens and offers retry without losing the saved model', () => {
    const { catalog, retry } = bench({ provider: 'gone', model: 'retained' })
    act(() => { catalog.set({ ...catalog.getSnapshot(), candidates: [], catalogStatus: 'idle' }) })
    expect(retry).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.subagentOverrideGeneralModel }))
    expect(retry).toHaveBeenCalledOnce()
    act(() => { catalog.set({ ...catalog.getSnapshot(), catalogStatus: 'error' }) })
    expect(screen.getByRole('button', { name: en.subagentOverrideGeneralModel }).textContent).toContain('retained')
    fireEvent.click(screen.getByRole('menuitem', { name: en.subagentModelSelectionRetry }))
    expect(retry).toHaveBeenCalledTimes(2)
  })

  it('closes its own menu on Escape without closing an ancestor dialog', () => {
    bench()
    const closeParent = vi.fn()
    document.addEventListener('keydown', closeParent)
    try {
      const trigger = screen.getByRole('button', { name: en.subagentOverrideGeneralModel })
      fireEvent.click(trigger)
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
      expect(document.activeElement).toBe(trigger)
      expect(closeParent).not.toHaveBeenCalled()
    } finally { document.removeEventListener('keydown', closeParent) }
  })

  it('closes unchanged selections and outside clicks without writing', () => {
    const { select, settings } = bench()
    const model = screen.getByRole('button', { name: en.subagentOverrideGeneralModel })
    fireEvent.keyDown(model, { key: 'a' })
    fireEvent.keyDown(model, { key: 'Escape' })
    fireEvent.click(model)
    fireEvent.click(model)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(model)
    fireEvent.click(screen.getByRole('menuitem', { name: en.subagentOverrideOff }))
    fireEvent.click(model)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    act(() => { settings.set({ ...settings.getSnapshot(), value: { maxDepth: 2, maxActiveSubagents: 8,
      modelOverride: { provider: 'alpha', model: 'fast', reasoningEffort: 'high' } } }) })
    fireEvent.click(model)
    fireEvent.click(screen.getByRole('menuitem', { name: 'fast' }))
    const effort = screen.getByRole('button', { name: en.subagentOverrideGeneralEffort })
    fireEvent.click(effort)
    fireEvent.click(effort)
    fireEvent.click(effort)
    fireEvent.click(screen.getByRole('menuitem', { name: 'High' }))
    fireEvent.click(effort)
    fireEvent.pointerDown(document.body)
    fireEvent.click(effort)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(document.activeElement).toBe(effort)
    expect(select).not.toHaveBeenCalled()
  })

  it('reports an empty model directory and a rejected transport without losing accepted values', async () => {
    const { catalog, select } = bench()
    act(() => { catalog.set({ ...catalog.getSnapshot(), candidates: [] }) })
    const model = screen.getByRole('button', { name: en.subagentOverrideGeneralModel })
    fireEvent.click(model)
    expect(screen.getByText(en.subagentModelSelectionEmpty)).toBeTruthy()
    fireEvent.pointerDown(document.body)
    act(() => { catalog.set({ ...catalog.getSnapshot(), candidates: [{ provider: 'alpha', model: 'fast',
      key: 'alpha\0fast', providerName: 'Alpha', modelName: 'fast', available: true, selected: false }] }) })
    select.mockRejectedValueOnce(new Error('disconnected'))
    fireEvent.click(model)
    fireEvent.click(screen.getByRole('menuitem', { name: 'fast' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.subagentOverrideSaveFailed) })
    expect(model.textContent).toContain(en.subagentOverrideOff)
  })

  it('prevents reopening the effort selector while its write is pending', async () => {
    const { select } = bench({ provider: 'alpha', model: 'fast', reasoningEffort: 'high' })
    const pending = Promise.withResolvers<boolean>()
    select.mockImplementationOnce(() => pending.promise)
    const effort = screen.getByRole('button', { name: en.subagentOverrideGeneralEffort })
    fireEvent.click(effort)
    fireEvent.click(screen.getByRole('menuitem', { name: en.subagentOverrideDefaultEffort }))
    fireEvent.click(effort)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(effort.getAttribute('aria-disabled')).toBe('true')
    await act(async () => { pending.resolve(false); await pending.promise })
    expect(effort.textContent).toContain('High')
  })

  it('keeps read-only settings disabled and hides unsupported Host fields', () => {
    const { settings, select } = bench(false, false)
    expect(screen.getByRole('button', { name: en.subagentOverrideGeneralModel }).hasAttribute('disabled')).toBe(true)
    expect(select).not.toHaveBeenCalled()
    act(() => { settings.set({ ...settings.getSnapshot(), value: { maxDepth: 2, maxActiveSubagents: 8 } }) })
    expect(screen.queryByText(en.subagentOverrideGeneralTitle)).toBeNull()
  })
})
