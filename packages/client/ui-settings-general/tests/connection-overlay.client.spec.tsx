// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import { ConnectionOverlay } from '../src/client/ConnectionOverlay.tsx'
import type { ConnectionOverlayProps } from '../src/client/ConnectionOverlay.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function source(initial: ConnectionState | undefined) {
  let state = initial
  const listeners = new Set<() => void>()
  const useConnectionState: ConnectionOverlayProps['useConnectionState'] = selector => {
    const [, force] = useState(0)
    useEffect(() => {
      const listener = () => { force(value => value + 1) }
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }, [])
    return selector(state)
  }
  return {
    useConnectionState,
    publish(next: ConnectionState | undefined) {
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}

describe('ConnectionOverlay', () => {
  it('stays quiet when healthy, exposes loss globally, and confirms recovery for two seconds', () => {
    vi.useFakeTimers()
    const state = source('connected')
    const reconnect = vi.fn()
    const props = {
      useConnectionState: state.useConnectionState,
      reconnect,
      t: (key: string) => key,
    } as ConnectionOverlayProps
    const view = render(<ConnectionOverlay {...props} />)
    expect(view.container.querySelector('[data-global-connection-status]')).toBeNull()

    act(() => { state.publish('disconnected') })
    const overlay = view.container.querySelector('[data-global-connection-status]')
    expect(overlay).not.toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'connection.reconnect' }))
    expect(reconnect).toHaveBeenCalledOnce()

    act(() => { state.publish('connecting') })
    expect(view.getByRole('button', { name: 'connection.restart' })).toBeTruthy()
    act(() => { state.publish('connected') })
    expect(view.getByRole('status', { name: 'connection.connected' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(view.container.querySelector('[data-global-connection-status]')).toBeNull()
  })
})
