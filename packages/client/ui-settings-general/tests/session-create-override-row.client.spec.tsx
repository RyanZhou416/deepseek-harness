// @vitest-environment jsdom
/** General Settings edits the model the `session` create action forces onto new Sessions. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFormScopeSnapshot } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  SessionCreateOverrideRow,
  type SessionCreateOverrideSettings,
  type SessionCreateOverrideRowProps,
  type SessionCreateOverrideValue,
} from '../src/client/SessionCreateOverrideRow.tsx'
import type { SessionCreateOverrideCatalog } from '../src/client/session-create-override-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function bench(override: SessionCreateOverrideValue | false = false, writable = true) {
  const settings = createSnapshotStore<SettingsFormScopeSnapshot<SessionCreateOverrideSettings>>({
    status: 'ready', writable, revision: 7, base: {}, user: {},
    value: { sessionCreateModelOverride: override },
  })
  const catalog = createSnapshotStore<SessionCreateOverrideCatalog>({
    status: 'ready',
    partial: false,
    groups: [{
      id: 'alpha', name: 'Alpha',
      models: [
        {
          id: 'fast', name: 'fast',
          reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
        },
        { id: 'deep', name: 'deep' },
      ],
    }],
  })
  const select = vi.fn(async (value: SessionCreateOverrideValue | false, revision: number | undefined) => {
    const current = settings.getSnapshot()
    if (revision !== current.revision) return false
    settings.set({
      ...current,
      revision: (revision ?? 0) + 1,
      value: { sessionCreateModelOverride: value },
    })
    return true
  })
  const retry = vi.fn()
  render(<SessionCreateOverrideRow {...{
    useSessionCreateOverride: bindSnapshotSelector(settings),
    useSessionCreateCatalog: bindSnapshotSelector(catalog),
    selectOverride: select, retryCatalog: retry, t: (key: keyof typeof en) => en[key],
  } as SessionCreateOverrideRowProps} />)
  return { settings, catalog, select, retry }
}

describe('SessionCreateOverrideRow', () => {
  it('saves model and effort independently and can disable the override', async () => {
    const { select, settings } = bench()
    expect(screen.getByRole('button', { name: en['sessionCreateOverride.effort'] }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en['sessionCreateOverride.model'] }))
    expect(screen.getByText('Alpha')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'fast' }))
    await waitFor(() => { expect(select).toHaveBeenLastCalledWith({ provider: 'alpha', model: 'fast' }, 7) })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: en['sessionCreateOverride.effort'] }).getAttribute('disabled')).toBeNull()
    })
    fireEvent.click(screen.getByRole('button', { name: en['sessionCreateOverride.effort'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'High' }))
    await waitFor(() => {
      expect(select).toHaveBeenLastCalledWith({ provider: 'alpha', model: 'fast', reasoningEffort: 'high' }, 8)
    })
    fireEvent.click(screen.getByRole('button', { name: en['sessionCreateOverride.model'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: en['sessionCreateOverride.off'] }))
    await waitFor(() => { expect(select).toHaveBeenLastCalledWith(false, 9) })
    expect(settings.getSnapshot().value).toEqual({ sessionCreateModelOverride: false })
  })

  it('keeps a saved unavailable route visible and retries the catalog', () => {
    const { catalog, retry } = bench({ provider: 'gone', model: 'retained' })
    act(() => { catalog.set({ ...catalog.getSnapshot(), status: 'idle', groups: [] }) })
    expect(retry).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en['sessionCreateOverride.model'] }))
    expect(retry).toHaveBeenCalledOnce()
    act(() => { catalog.set({ ...catalog.getSnapshot(), status: 'error' }) })
    expect(screen.getByRole('button', { name: en['sessionCreateOverride.model'] }).textContent).toContain('retained')
    fireEvent.click(screen.getByRole('menuitem', { name: en['sessionCreateOverride.retry'] }))
    expect(retry).toHaveBeenCalledTimes(2)
  })

  it('reports a refused write and leaves the accepted value visible', async () => {
    const { select } = bench()
    const pending = Promise.withResolvers<boolean>()
    select.mockImplementationOnce(() => pending.promise)
    fireEvent.click(screen.getByRole('button', { name: en['sessionCreateOverride.model'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'fast' }))
    expect(screen.getByRole('button', { name: en['sessionCreateOverride.model'] }).getAttribute('aria-disabled')).toBe('true')
    await act(async () => { pending.resolve(false); await pending.promise })
    expect(screen.getByRole('alert').textContent).toBe(en['sessionCreateOverride.saveFailed'])
    expect(screen.getByRole('button', { name: en['sessionCreateOverride.model'] }).textContent).toContain(en['sessionCreateOverride.off'])
  })

  it('closes its menu on Escape without closing an ancestor dialog', () => {
    bench()
    const closeParent = vi.fn()
    document.addEventListener('keydown', closeParent)
    try {
      const trigger = screen.getByRole('button', { name: en['sessionCreateOverride.model'] })
      fireEvent.click(trigger)
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
      expect(document.activeElement).toBe(trigger)
      expect(closeParent).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', closeParent)
    }
  })
})
