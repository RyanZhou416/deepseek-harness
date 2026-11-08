/**
 * Relay settings page.
 *
 * Every relay fact comes from the node half through `/api/relay.*`; this
 * component holds only form drafts and the latest status. A password or key
 * input is always empty and shows the "saved" placeholder while a stored value
 * exists, because the host never returns either secret.
 *
 * @module dsh-relay/client/RelaySection
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RelayStatus } from '../shared.ts'
import { en } from './locales.ts'
import type { RelayKey } from './locales.ts'
import {
  changeRelayPassword,
  readRelayStatus,
  RelayRpcError,
  saveRelayAccount,
  startRelayConnection,
  stopRelayConnection,
} from './relay-rpc.ts'
import type { RelayRpcCaller } from './relay-rpc.ts'
import {
  draftAddress,
  draftFromStatus,
  downloadPercent,
  errorKey,
  formatInstant,
  isBusyPhase,
  phaseKey,
  savedAccountConfigured,
} from './state.ts'
import type { RelayDraft } from './state.ts'

/** Inline layout using the shell's semantic design tokens. */
const styles: Record<string, CSSProperties> = {
  section: { display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 640 },
  title: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' },
  description: { margin: 0, marginBottom: 4, fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
  form: { display: 'flex', flexDirection: 'column', gap: 12 },
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  label: { fontSize: 12, fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
  hint: { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
  addressRow: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 10px',
    border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 'var(--dsw-radius-sm)',
    background: 'var(--dsw-alias-bg-layer-2)',
  },
  address: { fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-all' },
  autoConnect: { display: 'flex', alignItems: 'center', gap: 8 },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  error: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary)' },
  detail: { color: 'var(--dsw-alias-label-tertiary)' },
  notice: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
  statusCard: {
    display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px',
    border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 'var(--dsw-radius-md)',
    background: 'var(--dsw-alias-bg-layer-3)',
  },
  statusHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  statusPhase: { fontSize: 12, fontWeight: 600, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' },
  meta: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
  dialog: {
    display: 'flex', flexDirection: 'column', gap: 10, padding: 12,
    border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 'var(--dsw-radius-md)',
    background: 'var(--dsw-alias-bg-layer-2)',
  },
}

/** Poll cadence while the host is downloading or connecting. */
const POLL_INTERVAL_MS = 500

/** Locale-bound translate function supplied by the settings framework. */
export type RelayTranslate = (key: RelayKey, params?: Record<string, string | number>) => string

/** Values the page receives from its registration's inject face. */
export interface RelaySectionInjected {
  /** Connection RPC caller. */
  readonly rpc: RelayRpcCaller
}

/** Props of the settings section. */
export interface RelaySectionProps {
  /** Connection RPC caller; supplied by the inject face. */
  readonly rpc?: RelayRpcCaller
  /** Locale-bound translate function; supplied by the framework. */
  readonly t?: RelayTranslate
  /** Settings-panel close; unused by this page. */
  readonly close?: () => void
}

/** One failure line, already reduced to a stable code. */
interface ActionFailure {
  readonly code: string
  readonly detail?: string
}

function fallbackTranslate(key: RelayKey, params?: Record<string, string | number>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

function toActionFailure(error: unknown): ActionFailure {
  if (error instanceof RelayRpcError) {
    return {
      code: error.code,
      ...error.message === error.code || error.message === '' ? {} : { detail: error.message },
    }
  }
  return { code: 'internal' }
}

function detailFor(failure: ActionFailure): string | undefined {
  if (failure.detail === undefined) return undefined
  return failure.code === 'internal' || failure.code.startsWith('frpc-') ? failure.detail : undefined
}

/**
 * Render the relay settings page.
 * @param props - connection caller and locale-bound copy.
 * @returns the settings section.
 */
export function RelaySection(props: RelaySectionProps): ReactElement {
  const { rpc } = props
  const t = props.t ?? fallbackTranslate
  const [status, setStatus] = useState<RelayStatus | undefined>(undefined)
  const [draft, setDraft] = useState<RelayDraft>(() => draftFromStatus(undefined))
  const [failure, setFailure] = useState<ActionFailure | undefined>(undefined)
  const [notice, setNotice] = useState<RelayKey | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [repeatPassword, setRepeatPassword] = useState('')
  const mounted = useRef(true)
  const initialized = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (rpc === undefined) return
    try {
      const next = await readRelayStatus(rpc)
      if (!mounted.current) return
      setStatus(next)
      if (!initialized.current) {
        initialized.current = true
        setDraft(draftFromStatus(next))
      }
    } catch (error) {
      if (mounted.current) setFailure(toActionFailure(error))
    }
  }, [rpc])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!isBusyPhase(status?.phase)) return
    const timer = setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [status?.phase, refresh])

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    try {
      await action()
    } catch (error) {
      if (mounted.current) setFailure(toActionFailure(error))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [])

  const applyStatus = (next: RelayStatus): void => {
    setStatus(next)
    setDraft(draftFromStatus(next))
  }

  const onSave = (): void => {
    void run(async () => {
      if (rpc === undefined) throw new RelayRpcError('network-unreachable')
      const next = await saveRelayAccount(rpc, {
        domain: draft.domain,
        username: draft.username,
        autoConnect: draft.autoConnect,
        ...draft.password === '' ? {} : { password: draft.password },
        ...draft.clientKey === '' ? {} : { clientKey: draft.clientKey },
      })
      if (!mounted.current) return
      applyStatus(next)
      setNotice('savedNotice')
    })
  }

  const onConnect = (): void => {
    void run(async () => {
      if (rpc === undefined) throw new RelayRpcError('network-unreachable')
      setStatus(current => current === undefined ? current : { ...current, phase: 'connecting' })
      const next = await startRelayConnection(rpc)
      if (!mounted.current) return
      setStatus(next)
    })
  }

  const onDisconnect = (): void => {
    void run(async () => {
      if (rpc === undefined) throw new RelayRpcError('network-unreachable')
      const next = await stopRelayConnection(rpc)
      if (!mounted.current) return
      setStatus(next)
    })
  }

  const onPasswordSubmit = (): void => {
    if (newPassword === '' || currentPassword === '') {
      setFailure({ code: 'password-required' })
      return
    }
    if (newPassword !== repeatPassword) {
      setFailure({ code: 'password-mismatch' })
      return
    }
    void run(async () => {
      if (rpc === undefined) throw new RelayRpcError('network-unreachable')
      await changeRelayPassword(rpc, { currentPassword, newPassword })
      if (!mounted.current) return
      setPasswordOpen(false)
      setCurrentPassword('')
      setNewPassword('')
      setRepeatPassword('')
      setNotice('passwordChangedNotice')
    })
  }

  const address = draftAddress(draft) ?? status?.url
  const configured = savedAccountConfigured(status?.account)
  const phase = status?.phase
  const percent = downloadPercent(status?.download)
  const failureText = failure === undefined
    ? undefined
    : failure.code === 'password-mismatch'
      ? t('passwordMismatch')
      : t(errorKey(failure.code))
  const statusFailure = status?.phase === 'failed' ? t(errorKey(status.errorCode)) : undefined

  return (
    <section style={styles.section} aria-label={t('title')}>
      <h3 style={styles.title}>{t('title')}</h3>
      <p style={styles.description}>{t('description')}</p>

      <form
        style={styles.form}
        onSubmit={(event) => { event.preventDefault(); onSave() }}
      >
        <div style={styles.field}>
          <label style={styles.label} htmlFor="dsh-relay-domain">{t('domain')}</label>
          <Input
            id="dsh-relay-domain"
            value={draft.domain}
            placeholder={t('domainPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => { setDraft({ ...draft, domain: event.target.value }) }}
          />
          <span style={styles.hint}>{t('domainHint')}</span>
        </div>

        <div style={styles.field}>
          <label style={styles.label} htmlFor="dsh-relay-username">{t('username')}</label>
          <Input
            id="dsh-relay-username"
            value={draft.username}
            autoComplete="username"
            spellCheck={false}
            onChange={(event) => { setDraft({ ...draft, username: event.target.value }) }}
          />
          <span style={styles.hint}>{t('usernameHint')}</span>
        </div>

        <div style={styles.field}>
          <label style={styles.label} htmlFor="dsh-relay-password">{t('password')}</label>
          <Input
            id="dsh-relay-password"
            type="password"
            value={draft.password}
            autoComplete="new-password"
            placeholder={status?.account.hasPassword === true ? t('savedPlaceholder') : t('passwordHint')}
            onChange={(event) => { setDraft({ ...draft, password: event.target.value }) }}
          />
          <span style={styles.hint}>{t('passwordHint')}</span>
        </div>

        <div style={styles.field}>
          <label style={styles.label} htmlFor="dsh-relay-client-key">{t('clientKey')}</label>
          <Input
            id="dsh-relay-client-key"
            type="password"
            value={draft.clientKey}
            autoComplete="off"
            spellCheck={false}
            placeholder={status?.account.hasClientKey === true ? t('savedPlaceholder') : t('clientKeyHint')}
            onChange={(event) => { setDraft({ ...draft, clientKey: event.target.value }) }}
          />
          <span style={styles.hint}>{t('clientKeyHint')}</span>
        </div>

        <div style={styles.addressRow}>
          <span style={styles.label}>{t('address')}</span>
          {address === undefined
            ? <span style={styles.hint}>{t('addressUnavailable')}</span>
            : <a style={styles.address} href={address} target="_blank" rel="noreferrer noopener">{address}</a>}
        </div>

        <div style={styles.autoConnect}>
          <Switch
            checked={draft.autoConnect}
            label={t('autoConnect')}
            onChange={(next) => { setDraft({ ...draft, autoConnect: next }) }}
          />
          <span style={styles.label}>{t('autoConnect')}</span>
        </div>

        <div style={styles.actions}>
          <Button type="submit" variant="primary" disabled={busy}>{t('save')}</Button>
          <Button
            variant="outline"
            disabled={busy || !configured || phase === 'connected' || isBusyPhase(phase)}
            onClick={() => { onConnect() }}
          >
            {t('connect')}
          </Button>
          <Button
            variant="ghost"
            disabled={busy || !(phase === 'connected' || isBusyPhase(phase))}
            onClick={() => { onDisconnect() }}
          >
            {t('disconnect')}
          </Button>
          <Button variant="ghost" disabled={busy || !configured} onClick={() => { setPasswordOpen(true) }}>
            {t('changePassword')}
          </Button>
        </div>
      </form>

      {failureText !== undefined && (
        <p style={styles.error} role="alert">
          {failureText}
          {failure !== undefined && detailFor(failure) !== undefined && (
            <span style={styles.detail}> {detailFor(failure)}</span>
          )}
        </p>
      )}
      {notice !== undefined && <p style={styles.notice} role="status">{t(notice)}</p>}

      <div style={styles.statusCard}>
        <div style={styles.statusHead}>
          <span style={styles.label}>{t('status')}</span>
          <span style={styles.statusPhase} data-phase={phase}>{t(phaseKey(phase ?? 'unconfigured'))}</span>
        </div>
        {status !== undefined && status.phase === 'failed' && (
          <p style={styles.error} role="status">
            {statusFailure}
            {status.errorDetail !== undefined && <span style={styles.detail}> {status.errorDetail}</span>}
          </p>
        )}
        {status !== undefined && status.phase === 'downloading' && (
          <p style={styles.hint}>
            {percent === undefined ? t('statusDownloading') : t('downloadProgress', { percent })}
          </p>
        )}
        {status !== undefined && status.reconnecting === true && (
          <p style={styles.hint}>{t('statusReconnecting')}</p>
        )}
        {status?.remotePort !== undefined && (
          <p style={styles.meta}>{t('remotePort')}: {status.remotePort}</p>
        )}
        {status?.frpcVersion !== undefined && (
          <p style={styles.meta}>{t('frpcVersion')}: {status.frpcVersion}</p>
        )}
        {status?.lastConnectedAt !== undefined && (
          <p style={styles.meta}>
            {t('lastConnected')}: {formatInstant(status.lastConnectedAt, globalThis.navigator?.language ?? 'en')}
          </p>
        )}
      </div>

      {passwordOpen && (
        <div style={styles.dialog} role="dialog" aria-modal="true" aria-label={t('changePassword')}>
          <h4 style={styles.title}>{t('changePassword')}</h4>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="dsh-relay-current-password">{t('currentPassword')}</label>
            <Input
              id="dsh-relay-current-password"
              type="password"
              value={currentPassword}
              autoComplete="current-password"
              onChange={(event) => { setCurrentPassword(event.target.value) }}
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="dsh-relay-new-password">{t('newPassword')}</label>
            <Input
              id="dsh-relay-new-password"
              type="password"
              value={newPassword}
              autoComplete="new-password"
              onChange={(event) => { setNewPassword(event.target.value) }}
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="dsh-relay-repeat-password">{t('repeatPassword')}</label>
            <Input
              id="dsh-relay-repeat-password"
              type="password"
              value={repeatPassword}
              autoComplete="new-password"
              onChange={(event) => { setRepeatPassword(event.target.value) }}
            />
          </div>
          <div style={styles.actions}>
            <Button variant="primary" disabled={busy} onClick={() => { onPasswordSubmit() }}>{t('confirm')}</Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPasswordOpen(false)
                setCurrentPassword('')
                setNewPassword('')
                setRepeatPassword('')
              }}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
