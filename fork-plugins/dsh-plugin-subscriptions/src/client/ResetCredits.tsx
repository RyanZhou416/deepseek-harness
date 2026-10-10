/**
 * ChatGPT banked reset credits. The count comes from the usage payload the
 * parent already loaded. The per-credit list loads only when the row is
 * expanded; manual spending goes through the confirm dialog.
 * The collapsed composer pill does not render this row.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { formatDateTime } from './format.js'
import type { SubscriptionsKey } from './locales.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** One credit as answered by the `resetCredits` endpoint. */
interface ResetCreditView {
  id: string
  status: 'available' | 'redeemed' | 'expired' | 'other'
  title?: string
  description?: string
  grantedAt?: string
  expiresAt?: string
  resetType?: string
}

interface ResetCreditListView {
  supported: boolean
  availableCount?: number
  credits?: ResetCreditView[]
}

export function ResetCredits({ rpc, t, accountKey, accountLabel, availableCount, onChanged, onDialogChange }: {
  rpc: ConnectionHandle['rpc']
  t: Translate
  accountKey: string
  accountLabel: string
  availableCount: number
  /** Refetch usage after a spend so the windows and the count update together. */
  onChanged: () => void
  /** Tell a parent popover that a modal is open, so outside-click dismiss does not unmount it. */
  onDialogChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [credits, setCredits] = useState<ResetCreditView[] | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState<{ credit: ResetCreditView; requestId: string } | undefined>(undefined)
  const [consuming, setConsuming] = useState(false)
  const [consumeError, setConsumeError] = useState<string | undefined>(undefined)
  const titleId = useId()
  const mountedRef = useRef(true)
  const loadGen = useRef(0)
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    onDialogChange?.(pending !== undefined)
    return () => { onDialogChange?.(false) }
  }, [pending, onDialogChange])

  useEffect(() => {
    if (availableCount === 0) setOpen(false)
  }, [availableCount])

  useEffect(() => {
    if (pending !== undefined) cancelRef.current?.focus()
  }, [pending])

  useEffect(() => {
    if (pending === undefined) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || consuming) return
      event.preventDefault()
      event.stopPropagation()
      setPending(undefined)
      setConsumeError(undefined)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [pending, consuming])

  async function load(force: boolean): Promise<void> {
    const gen = ++loadGen.current
    setLoading(true)
    setError(undefined)
    try {
      const result = await callSubscriptionsAuth<ResetCreditListView>(rpc, 'resetCredits', {
        provider: 'codex',
        account: accountKey,
        ...force ? { force: true } : {},
      })
      if (!mountedRef.current || gen !== loadGen.current) return
      setCredits(result.credits ?? [])
    } catch (caught) {
      if (!mountedRef.current || gen !== loadGen.current) return
      setError(t('resetCreditsError', { message: messageOf(caught) }))
    } finally {
      if (mountedRef.current && gen === loadGen.current) setLoading(false)
    }
  }

  function toggle(): void {
    const next = !open
    setOpen(next)
    if (next) void load(false)
  }

  function ask(credit: ResetCreditView): void {
    setConsumeError(undefined)
    setPending({ credit, requestId: crypto.randomUUID() })
  }

  async function confirm(): Promise<void> {
    if (pending === undefined || consuming) return
    setConsuming(true)
    setConsumeError(undefined)
    try {
      await callSubscriptionsAuth(rpc, 'consumeResetCredit', {
        provider: 'codex',
        account: accountKey,
        creditId: pending.credit.id,
        redeemRequestId: pending.requestId,
      })
      if (!mountedRef.current) return
      setPending(undefined)
      onChanged()
      if (open) await load(true)
    } catch (caught) {
      if (!mountedRef.current) return
      setConsumeError(t('resetCreditsConsumeError', { message: messageOf(caught) }))
    } finally {
      if (mountedRef.current) setConsuming(false)
    }
  }

  const countLabel = availableCount === 0
    ? t('resetCreditsNone')
    : t('resetCreditsCount', { count: availableCount })

  return (
    <div style={styles.block}>
      <div style={styles.header}>
        <span>{countLabel}</span>
        {availableCount > 0 && (
          <button type="button" style={styles.textButton} onClick={toggle}>
            {open ? t('resetCreditsHide') : t('resetCreditsView')}
          </button>
        )}
      </div>
      {open && (
        <div style={styles.list}>
          {loading && credits === undefined && <p style={styles.hint}>{t('resetCreditsLoading')}</p>}
          {error !== undefined && <p style={styles.error}>{error}</p>}
          {credits !== undefined && credits.length === 0 && error === undefined && (
            <p style={styles.hint}>{t('resetCreditsEmpty')}</p>
          )}
          {(credits ?? []).map(credit => (
            <div key={credit.id} style={styles.credit}>
              <div style={styles.creditMain}>
                <span style={styles.creditTitle}>{creditLabel(credit, t)}</span>
                <span style={styles.hint}>{creditMeta(credit, t)}</span>
              </div>
              {credit.status === 'available'
                ? (
                  <button
                    type="button"
                    style={styles.textButton}
                    disabled={pending !== undefined}
                    onClick={() => { ask(credit) }}
                  >
                    {t('resetCreditsUse')}
                  </button>
                )
                : <span style={styles.hint}>{statusLabel(credit.status, t)}</span>}
            </div>
          ))}
        </div>
      )}
      {pending !== undefined && createPortal(
        <div style={styles.backdrop} role="presentation">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            style={styles.dialog}
          >
            <h2 id={titleId} style={styles.dialogTitle}>{t('resetCreditsConfirmTitle')}</h2>
            <p style={styles.dialogCredit}>{creditLabel(pending.credit, t)}</p>
            <p style={styles.dialogBody}>
              {pending.credit.resetType === 'codex_rate_limits'
                ? t('resetCreditsConfirmBody', { account: accountLabel })
                : t('resetCreditsConfirmUnknown', { account: accountLabel })}
            </p>
            {pending.credit.expiresAt !== undefined && (
              <p style={styles.hint}>{t('resetCreditsExpires', { date: formatWhen(pending.credit.expiresAt, t) })}</p>
            )}
            {consumeError !== undefined && <p style={styles.error}>{consumeError}</p>}
            <div style={styles.dialogActions}>
              <button
                ref={cancelRef}
                type="button"
                style={styles.textButton}
                disabled={consuming}
                onClick={() => {
                  setPending(undefined)
                  setConsumeError(undefined)
                }}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                style={styles.confirm}
                disabled={consuming}
                onClick={() => { void confirm() }}
              >
                {consuming ? t('resetCreditsConsuming') : t('resetCreditsConfirm')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function creditLabel(credit: ResetCreditView, t: Translate): string {
  if (credit.title !== undefined) return credit.title
  if (credit.resetType === 'codex_rate_limits') return t('resetCreditsFullReset')
  return credit.id
}

function statusLabel(status: ResetCreditView['status'], t: Translate): string {
  if (status === 'redeemed') return t('resetCreditsStatusRedeemed')
  if (status === 'expired') return t('resetCreditsStatusExpired')
  return t('resetCreditsStatusOther')
}

function creditMeta(credit: ResetCreditView, t: Translate): string {
  const parts: string[] = []
  if (credit.expiresAt !== undefined) parts.push(t('resetCreditsExpires', { date: formatWhen(credit.expiresAt, t) }))
  if (credit.description !== undefined && credit.description !== credit.title) parts.push(credit.description)
  return parts.join(' · ')
}

/** Disclosed expiry through the dictionary's date template; an unparseable value stays verbatim. */
function formatWhen(value: string, t: Translate): string {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return value
  return formatDateTime(t, parsed)
}

const button: CSSProperties = {
  boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  height: 22, padding: '0 8px', borderRadius: 11, flexShrink: 0,
  border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 12, lineHeight: '18px',
  cursor: 'pointer',
}

const styles: Record<string, CSSProperties> = {
  block: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12, lineHeight: '18px' },
  textButton: button,
  list: { display: 'flex', flexDirection: 'column', gap: 6 },
  credit: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  creditMain: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  creditTitle: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' },
  hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  error: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16, background: 'rgba(0, 0, 0, 0.35)',
  },
  dialog: {
    boxSizing: 'border-box', width: 'min(420px, 100%)', padding: 16, borderRadius: 12,
    background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1))',
    color: 'var(--dsw-alias-label-primary)', boxShadow: 'var(--dsw-elevation-prominent)',
  },
  dialogTitle: { margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 600 },
  dialogCredit: { margin: '8px 0 0', fontSize: 13, lineHeight: '20px' },
  dialogBody: { margin: '8px 0 0', fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
  dialogActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
  confirm: {
    ...button,
    height: 28, padding: '0 10px', borderRadius: 14,
    borderColor: 'var(--dsw-alias-state-error-primary)',
    color: 'var(--dsw-alias-state-error-primary)',
  },
}
