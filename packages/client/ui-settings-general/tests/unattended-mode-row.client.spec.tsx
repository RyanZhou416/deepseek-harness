// @vitest-environment jsdom
/** General Settings toggles the Host unattended-mode entry through the shared settings form. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  saveUnattendedMode,
  UnattendedModeRow,
  type UnattendedModeRowProps,
  type UnattendedModeSettings,
} from '../src/client/UnattendedModeRow.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const T = (key: keyof typeof en): string => en[key]

function snapshot(
  overrides: Partial<ConfigFormSnapshot<UnattendedModeSettings>> = {},
): ConfigFormSnapshot<UnattendedModeSettings> {
  return {
    status: 'ready', writable: true, revision: 4, base: {}, user: {},
    value: { enabled: false },
    ...overrides,
  }
}

function bench(options: {
  snapshot?: ConfigFormSnapshot<UnattendedModeSettings>
  setEnabled?: (enabled: boolean, revision: number | undefined) => Promise<boolean>
} = {}) {
  const state = createSnapshotStore<ConfigFormSnapshot<UnattendedModeSettings>>(options.snapshot ?? snapshot())
  const setEnabled = options.setEnabled ?? vi.fn(async (enabled: boolean, revision: number | undefined) => {
    const current = state.getSnapshot()
    if (revision !== current.revision) return false
    state.set({ ...current, revision: (revision ?? 0) + 1, value: { enabled } })
    return true
  })
  render(<UnattendedModeRow {...{
    useUnattendedMode: bindSnapshotSelector(state),
    setEnabled,
    t: T,
  } as UnattendedModeRowProps} />)
  return { state, setEnabled }
}

describe('saveUnattendedMode', () => {
  it('writes the enabled field against the displayed revision', async () => {
    const mutate = vi.fn(async () => true)
    const form: ConfigForm<UnattendedModeSettings> = {
      getSnapshot: () => snapshot({ revision: 7 }),
      subscribe: () => () => {},
      mutate,
      set: async () => true,
      unset: async () => true,
    }

    await expect(saveUnattendedMode(form, true, 7)).resolves.toBe(true)
    expect(mutate).toHaveBeenCalledExactlyOnceWith([{ op: 'set', path: ['enabled'], value: true }], 7)
  })

  it.each([
    ['loading', true],
    ['ready', false],
  ] as const)('refuses locally when the form is %s and writable=%s', async (status, writable) => {
    const mutate = vi.fn(async () => true)
    const form: ConfigForm<UnattendedModeSettings> = {
      getSnapshot: () => snapshot({ status, writable }),
      subscribe: () => () => {},
      mutate,
      set: async () => true,
      unset: async () => true,
    }

    await expect(saveUnattendedMode(form, true, 7)).resolves.toBe(false)
    expect(mutate).not.toHaveBeenCalled()
  })
})

describe('UnattendedModeRow', () => {
  it('writes the requested state and shows the accepted snapshot', async () => {
    const { setEnabled } = bench()
    const toggle = screen.getByRole('switch', { name: en['unattendedMode.title'] })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle)

    expect(setEnabled).toHaveBeenCalledWith(true, 4)
    await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('true') })
    expect(toggle.hasAttribute('disabled')).toBe(false)
  })

  it('reports a refused write and keeps the accepted state', async () => {
    const { setEnabled } = bench({ setEnabled: vi.fn(async () => false) })
    const toggle = screen.getByRole('switch', { name: en['unattendedMode.title'] })

    fireEvent.click(toggle)

    expect((await screen.findByRole('alert')).textContent).toBe(en['unattendedMode.error'])
    expect(setEnabled).toHaveBeenCalledTimes(1)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.hasAttribute('disabled')).toBe(false)
  })

  it('reports a rejected write', async () => {
    bench({ setEnabled: vi.fn(async () => { throw new Error('offline') }) })
    fireEvent.click(screen.getByRole('switch', { name: en['unattendedMode.title'] }))

    expect((await screen.findByRole('alert')).textContent).toBe(en['unattendedMode.error'])
  })

  it('disables the switch while a write settles', async () => {
    const pending = Promise.withResolvers<boolean>()
    bench({ setEnabled: () => pending.promise })
    const toggle = screen.getByRole('switch', { name: en['unattendedMode.title'] })

    fireEvent.click(toggle)
    expect(toggle.hasAttribute('disabled')).toBe(true)

    pending.resolve(true)
    await waitFor(() => { expect(toggle.hasAttribute('disabled')).toBe(false) })
  })

  it.each([
    ['loading', 'not ready', snapshot({ status: 'loading', value: undefined })],
    ['read-only', 'read-only', snapshot({ writable: false })],
  ] as const)('disables the switch while the form is %s', (_label, _reason, state) => {
    bench({ snapshot: state })
    expect(screen.getByRole('switch', { name: en['unattendedMode.title'] }).hasAttribute('disabled')).toBe(true)
  })
})
