// @vitest-environment jsdom
/** The page as Settings renders it: fields, catalogue rows, errors, and the save gate. */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { CcPoolSection } from '../src/client/CcPoolSection.tsx'
import type { CcPoolSectionProps } from '../src/client/CcPoolSection.tsx'
import type { CcPoolRowState, CcPoolSettingsState } from '../src/client/settings-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(en, { close: 'Close' })

let nextKey = 1

function row(
  overrides: Partial<CcPoolRowState['draft']> = {},
  errors: CcPoolRowState['errors'] = {},
  synced = false,
): CcPoolRowState {
  return {
    key: nextKey++,
    draft: {
      id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: '1000000', maxTokens: '128000', defaultReasoning: 'medium', ...overrides,
    },
    errors,
    synced,
  }
}

function state(overrides: Partial<CcPoolSettingsState> = {}): CcPoolSettingsState {
  return {
    loading: false,
    available: true,
    writable: true,
    dirty: true,
    invalid: false,
    saving: false,
    failed: false,
    overridden: false,
    resetPending: false,
    rows: [row()],
    emptyCatalogue: false,
    token: { text: '', configured: false, writable: true },
    sync: { running: false },
    ...overrides,
  }
}

function renderPage(stateOverrides: Partial<CcPoolSettingsState> = {}) {
  const store = createSnapshotStore<CcPoolSettingsState>(state(stateOverrides))
  const actions = {
    editToken: vi.fn(),
    editRow: vi.fn(),
    addRow: vi.fn(),
    removeRow: vi.fn(),
    resetModels: vi.fn(),
    syncModels: vi.fn(),
    confirmSyncRemoval: vi.fn(),
    keepSyncRows: vi.fn(),
    cancelSync: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  }
  const props = {
    close: vi.fn(),
    ...actions,
    t,
    useCcPool: bindSnapshotSelector(store),
  } as CcPoolSectionProps
  render(<CcPoolSection {...props} />)
  return actions
}

describe('CcPoolSection', () => {
  it('shows the loading line until the Host section arrives', () => {
    renderPage({ loading: true, available: false, dirty: false, rows: [] })

    expect(screen.getByRole('status').textContent).toBe(en.loading)
    expect(screen.queryByLabelText(en.token)).toBeNull()
  })

  it('renders the page title, the credential field, and one row of wire fields', () => {
    renderPage()

    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.getByText(en.description)).toBeTruthy()
    expect(screen.getByLabelText(en.token)).toBeTruthy()
    expect(screen.getByText(en.tokenUnset)).toBeTruthy()
    expect(screen.getByLabelText(en.modelId)).toHaveProperty('value', 'claude-sonnet-5-5')
    expect(screen.getByLabelText(en.modelName)).toHaveProperty('value', 'Claude Sonnet 5.5')
    expect(screen.getByLabelText(en.modelContext)).toHaveProperty('value', '1000000')
    expect(screen.getByLabelText(en.modelMaxTokens)).toHaveProperty('value', '128000')
  })

  it('offers exactly the five pool efforts and never off or speed', () => {
    renderPage()

    const options = [...screen.getByLabelText(en.modelEffort).querySelectorAll('option')].map(option => option.value)
    expect(options).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('reports a configured credential with its source and never renders a stored literal', () => {
    renderPage({ token: { text: '', configured: true, source: 'file', writable: true } })

    expect(screen.getByText(en.tokenConfiguredFrom.replace('{source}', 'file'))).toBeTruthy()
    expect(screen.getByLabelText(en.token)).toHaveProperty('value', '')
  })

  it('says why the credential cannot be changed when the deployment supplies it', () => {
    renderPage({ token: { text: '', configured: true, source: 'env', writable: false } })

    expect(screen.getByText(en.tokenReadOnly)).toBeTruthy()
    expect(screen.getByLabelText(en.token)).toHaveProperty('disabled', true)
  })

  it('stages the credential and the row fields instead of writing them', () => {
    const actions = renderPage()

    fireEvent.change(screen.getByLabelText(en.token), { target: { value: 'sk-typed' } })
    fireEvent.change(screen.getByLabelText(en.modelId), { target: { value: 'claude-sonnet-6' } })
    fireEvent.change(screen.getByLabelText(en.modelEffort), { target: { value: 'max' } })

    expect(actions.editToken).toHaveBeenCalledWith('sk-typed')
    expect(actions.editRow).toHaveBeenCalledWith(0, 'id', 'claude-sonnet-6')
    expect(actions.editRow).toHaveBeenCalledWith(0, 'defaultReasoning', 'max')
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('shows a duplicate id under its field and blocks the save', () => {
    renderPage({ invalid: true, rows: [row(), row({ id: 'claude-sonnet-5-5', name: 'Clone' }, { id: 'idDuplicate' })] })

    expect(screen.getAllByText(en.idDuplicate)).toHaveLength(1)
    expect(screen.getAllByLabelText(en.modelId)[1]?.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  })

  it('reports an unreadable capacity under its field', () => {
    renderPage({ invalid: true, rows: [row({ maxTokens: '1.5' }, { maxTokens: 'positiveInteger' })] })

    expect(screen.getByText(en.positiveInteger)).toBeTruthy()
    expect(screen.getByLabelText(en.modelMaxTokens).getAttribute('aria-invalid')).toBe('true')
  })

  it('reports an effort outside the five levels under its select', () => {
    renderPage({ invalid: true, rows: [row({ defaultReasoning: 'off' }, { defaultReasoning: 'reasoningLevel' })] })

    expect(screen.getByText(en.reasoningLevel)).toBeTruthy()
    expect(screen.getByLabelText(en.modelEffort).getAttribute('aria-invalid')).toBe('true')
  })

  it('names a configured credential without a source and shows a credential read failure', () => {
    renderPage({ token: { text: '', configured: true, writable: true } })
    expect(screen.getByText(en.tokenConfigured)).toBeTruthy()
    cleanup()

    renderPage({ token: { text: '', configured: false, writable: false, error: 'no credential provider' } })
    expect(screen.getByText('no credential provider')).toBeTruthy()
  })

  it('offers add, remove, and a staged reset of the whole catalogue', () => {
    const actions = renderPage({ overridden: true, rows: [row(), row({ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' })] })

    expect(screen.getByText(en.modelsOverridden)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.click(screen.getAllByRole('button', { name: /Remove model/ })[0]!)
    fireEvent.click(screen.getByRole('button', { name: en.resetModels }))

    expect(actions.addRow).toHaveBeenCalledOnce()
    expect(actions.removeRow).toHaveBeenCalledWith(0)
    expect(actions.resetModels).toHaveBeenCalledOnce()
  })

  it('reports an empty catalogue and an unavailable section instead of rendering rows', () => {
    renderPage({ rows: [], emptyCatalogue: true, invalid: true })
    expect(screen.getByText(en.emptyCatalogue)).toBeTruthy()
    cleanup()

    renderPage({ available: false, rows: [], dirty: false })
    expect(screen.getByRole('status').textContent).toBe(en.unavailable)
  })

  it('disables every control on a read-only document and while a save is in flight', () => {
    renderPage({ writable: false })
    expect(screen.getByRole('status').textContent).toBe(en.readOnly)
    expect(screen.getByLabelText(en.modelId)).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.addModel })).toHaveProperty('disabled', true)
    cleanup()

    renderPage({ saving: true })
    expect(screen.getByRole('button', { name: en.saving })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.modelId)).toHaveProperty('disabled', true)
  })

  it('offers the save only while something is staged and reports a refused save', () => {
    renderPage({ dirty: false })
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    cleanup()

    const actions = renderPage({ failed: true, saveError: { kind: 'rejected' } })
    expect(screen.getByText(en.saveFailed)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('names the conflict instead of blaming the values when another change won the fence', () => {
    renderPage({ failed: true, saveError: { kind: 'conflict' } })

    expect(screen.getByText(en.saveConflict)).toBeTruthy()
    expect(screen.queryByText(en.saveFailed)).toBeNull()
  })

  it('shows the Host reason a credential write was refused, and an unreachable deployment', () => {
    renderPage({ failed: true, saveError: { kind: 'credential', message: 'the store is read-only' } })
    expect(screen.getByText(en.saveCredentialFailed.replace('{reason}', 'the store is read-only'))).toBeTruthy()
    cleanup()

    renderPage({ failed: true, saveError: { kind: 'transport' } })
    expect(screen.getByText(en.saveUnreachable)).toBeTruthy()
  })

  it('reports a failed save without a recorded cause with the generic line', () => {
    renderPage({ failed: true })

    expect(screen.getByText(en.saveFailed)).toBeTruthy()
  })

  it('drops the drafts when it leaves the page', () => {
    const actions = renderPage()
    cleanup()

    expect(actions.discard).toHaveBeenCalledOnce()
  })

  it('offers the pool sync, marks the rows it adds, and reports a sync in flight', () => {
    const actions = renderPage({ rows: [row(), row({ id: 'claude-nova-5', name: 'Claude Nova 5' }, {}, true)] })

    expect(screen.getByText(en.fromPool)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.syncModels }))
    expect(actions.syncModels).toHaveBeenCalledOnce()
    cleanup()

    renderPage({ sync: { running: true } })
    expect(screen.getByRole('button', { name: en.syncing })).toHaveProperty('disabled', true)
  })

  it('reports why a sync left the model list unchanged', () => {
    renderPage({ sync: { running: false, error: { kind: 'copy', key: 'syncEmpty' } } })
    expect(screen.getByText(en.syncEmpty)).toBeTruthy()
    cleanup()

    renderPage({ sync: { running: false, error: { kind: 'copy', key: 'syncTimeout' } } })
    expect(screen.getByText(en.syncTimeout)).toBeTruthy()
    cleanup()

    renderPage({ sync: { running: false, error: { kind: 'host', message: 'no model discovery is registered' } } })
    expect(screen.getByText(en.syncFailed.replace('{reason}', 'no model discovery is registered'))).toBeTruthy()
  })

  it('confirms the rows a pool sync would drop and cancels the whole sync when dismissed', () => {
    const actions = renderPage({
      sync: { running: false, pendingRemoval: ['claude-opus-5-5', 'claude-fable-5-1'] },
    })

    const dialog = screen.getByRole('dialog', { name: en.syncRemoveTitle })
    expect(within(dialog).getByText(en.syncRemoveDescription.replace('{count}', '2'))).toBeTruthy()
    const list = within(dialog).getByRole('list', { name: en.syncRemoveList })
    expect([...list.querySelectorAll('li')].map(item => item.textContent)).toEqual(['claude-opus-5-5', 'claude-fable-5-1'])

    // Cancelling the prompt is the outcome that changes nothing, so it owns focus.
    const cancel = within(dialog).getByRole('button', { name: en.cancel })
    expect(document.activeElement).toBe(cancel)
    fireEvent.click(cancel)
    fireEvent.click(within(dialog).getByRole('button', { name: en.syncRemoveKeep }))
    fireEvent.click(within(dialog).getByRole('button', { name: en.syncRemoveConfirm }))

    expect(actions.cancelSync).toHaveBeenCalledOnce()
    expect(actions.keepSyncRows).toHaveBeenCalledOnce()
    expect(actions.confirmSyncRemoval).toHaveBeenCalledOnce()
  })

  it('cancels the whole sync when the confirmation is closed with Escape or the close control', () => {
    const actions = renderPage({
      sync: { running: false, pendingRemoval: ['claude-opus-5-5'] },
    })

    const dialog = screen.getByRole('dialog', { name: en.syncRemoveTitle })
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))

    expect(actions.cancelSync).toHaveBeenCalledTimes(2)
    expect(actions.keepSyncRows).not.toHaveBeenCalled()
    expect(actions.confirmSyncRemoval).not.toHaveBeenCalled()
  })
})
