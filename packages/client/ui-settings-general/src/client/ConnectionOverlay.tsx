import { useLayoutEffect, useRef, useState } from 'react'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import { ConnectionIndicator } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionIndicatorState } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsKey } from './locales.ts'
import css from './ConnectionOverlay.module.css'

const RECOVERY_CONFIRMATION_MS = 2_000

/** Global connection status injected into the shell overlay. */
export interface ConnectionOverlayInjected {
  readonly reconnect: () => void
  readonly hooks: {
    readonly connectionState: HostObservable<ConnectionState | undefined>
  }
}

export type ConnectionOverlayProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<'settings'>
  & InjectFace<ConnectionOverlayInjected>

/**
 * Keep backend loss visible even when the sidebar is collapsed or Settings is closed.
 * @param props - shell runtime, localized copy, and the official Connection state source.
 * @returns the global indicator, or null while the initial connection is healthy and quiet.
 */
export function ConnectionOverlay({ useConnectionState, reconnect, t }: ConnectionOverlayProps) {
  const state = useConnectionState(value => value)
  const previous = useRef(state)
  const [showRecovery, setShowRecovery] = useState(false)

  useLayoutEffect(() => {
    const prior = previous.current
    previous.current = state
    if (state !== 'connected') {
      setShowRecovery(false)
      return
    }
    if (prior !== 'disconnected' && prior !== 'connecting') return
    setShowRecovery(true)
    const timeout = window.setTimeout(() => { setShowRecovery(false) }, RECOVERY_CONFIRMATION_MS)
    return () => { window.clearTimeout(timeout) }
  }, [state])

  let indicator: ConnectionIndicatorState | undefined
  if (state === 'disconnected') indicator = 'disconnected'
  else if (state === 'connecting') indicator = 'connecting'
  else if (showRecovery) indicator = 'recovered'
  if (indicator === undefined) return null

  return (
    <div className={css.overlay} data-global-connection-status>
      <ConnectionIndicator
        state={indicator}
        disconnectedLabel={t('connection.error' satisfies SettingsKey)}
        reconnectLabel={t('connection.retry' satisfies SettingsKey)}
        connectingLabel={t('connection.connecting' satisfies SettingsKey)}
        recoveredLabel={t('connection.connected' satisfies SettingsKey)}
        reconnectActionLabel={t('connection.reconnect' satisfies SettingsKey)}
        restartActionLabel={t('connection.restart' satisfies SettingsKey)}
        onReconnect={reconnect}
      />
    </div>
  )
}
