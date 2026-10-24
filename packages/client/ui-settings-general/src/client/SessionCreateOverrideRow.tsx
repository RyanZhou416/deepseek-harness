/** General Settings row for the model forced onto the `session` create action Sessions. */

import { useEffect, useRef, useState } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ModelReasoning } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MenuEntry, SettingsFormScopeSnapshot } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionCreateOverrideCatalog } from './session-create-override-store.ts'
import css from './SessionCreateOverrideRow.module.css'

/** The exact model forced onto new independent Sessions. */
export interface SessionCreateOverrideValue {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Settings fields owned by the `agent-default-model` namespace. */
export interface SessionCreateOverrideSettings {
  sessionCreateModelOverride: SessionCreateOverrideValue | false
}

/** One selectable provider/model route. */
interface ModelCandidate {
  provider: string
  model: string
  providerName: string
  modelName: string
  reasoning?: ModelReasoning
  key: string
}

/** Data and callbacks supplied by the General Settings registration. */
export interface SessionCreateOverrideRowInjected {
  hooks: {
    /** Host-accepted Session-creation settings. */
    sessionCreateOverride: ObservableSnapshot<SettingsFormScopeSnapshot<SessionCreateOverrideSettings>>
    /** Live model directory joined by the row. */
    sessionCreateCatalog: ObservableSnapshot<SessionCreateOverrideCatalog>
  }
  /** Persist only the model override against the revision displayed by this row. */
  selectOverride: (value: SessionCreateOverrideValue | false, revision: number | undefined) => Promise<boolean>
  /** Load or retry the model directory. */
  retryCatalog: () => void
}

/** Framework-derived General Settings row props. */
export type SessionCreateOverrideRowProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings'>
  & InjectFace<SessionCreateOverrideRowInjected>

function modelKey(provider: string, model: string): string {
  return `${provider}\0${model}`
}

function candidates(catalog: SessionCreateOverrideCatalog): ModelCandidate[] {
  return catalog.groups.flatMap(group => group.models.map(model => ({
    provider: group.id,
    model: model.id,
    providerName: group.name,
    modelName: model.name,
    ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
    key: modelKey(group.id, model.id),
  })))
}

/**
 * Render the model and reasoning selectors for the `session` create action.
 * @param props - Accepted settings, model directory, callbacks, and localized copy.
 * @returns One General Settings row, or nothing when the Host lacks the override field.
 */
export function SessionCreateOverrideRow({
  useSessionCreateOverride, useSessionCreateCatalog, selectOverride, retryCatalog, t,
}: SessionCreateOverrideRowProps) {
  const settings = useSessionCreateOverride(value => value)
  const catalog = useSessionCreateCatalog(value => value)
  const [open, setOpen] = useState<'model' | 'effort' | null>(null)
  const modelRef = useRef<HTMLButtonElement>(null)
  const effortRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const value = settings.value?.sessionCreateModelOverride
  const disabled = !settings.writable || busy

  useEffect(() => {
    if (open !== null && catalog.status === 'idle') retryCatalog()
  }, [open, catalog.status, retryCatalog])

  if (settings.status !== 'ready' || value === undefined) return null
  const choices = candidates(catalog)
  const selected = value === false
    ? undefined
    : choices.find(candidate => candidate.provider === value.provider && candidate.model === value.model)
  const efforts = selected?.reasoning?.efforts ?? []
  const modelItems: MenuEntry[] = [{ id: 'off', label: t('sessionCreateOverride.off') }]
  let provider: string | undefined
  for (const candidate of choices) {
    if (candidate.provider !== provider) {
      provider = candidate.provider
      modelItems.push({ type: 'label', id: 'provider:' + provider, text: candidate.providerName })
    }
    modelItems.push({ id: candidate.key, label: candidate.modelName })
  }
  if (catalog.status === 'loading' || catalog.status === 'idle') {
    modelItems.push({ type: 'label', id: 'loading', text: t('sessionCreateOverride.loading') })
  } else if (catalog.status === 'error' || catalog.partial) {
    modelItems.push({ id: 'retry', label: t('sessionCreateOverride.retry') })
  } else if (choices.length === 0) {
    modelItems.push({ type: 'label', id: 'empty', text: t('sessionCreateOverride.empty') })
  }
  const save = (next: SessionCreateOverrideValue | false): void => {
    setOpen(null)
    setFailed(false)
    setBusy(true)
    void selectOverride(next, settings.revision)
      .then((accepted) => { setFailed(!accepted) }, () => { setFailed(true) })
      .finally(() => { setBusy(false) })
  }
  const modelLabel = value === false ? t('sessionCreateOverride.off') : selected?.modelName ?? value.model
  const effort = value === false ? undefined : value.reasoningEffort
  const effortLabel = efforts.find(option => option.id === effort)?.name ?? effort ?? t('sessionCreateOverride.defaultEffort')
  const description = failed ? t('sessionCreateOverride.saveFailed')
    : !settings.writable ? t('readOnly')
      : catalog.status === 'error' || catalog.partial ? t('sessionCreateOverride.catalogFailed')
        : t('sessionCreateOverride.description')

  return <div className={css.row} data-session-create-override-row aria-busy={busy}
    onKeyDownCapture={(event) => {
      if (event.key !== 'Escape' || open === null) return
      event.preventDefault()
      event.stopPropagation()
      ;(open === 'model' ? modelRef : effortRef).current?.focus({ preventScroll: true })
      setOpen(null)
    }}>
    <div className={css.text}>
      <div className={css.title}>{t('sessionCreateOverride.title')}</div>
      <div className={css.description} role={failed ? 'alert' : undefined}>{description}</div>
    </div>
    <div className={css.controls}>
      <Menu open={open === 'model' && !disabled} portal align="end" autoFocus
        items={modelItems} selectedId={value === false ? 'off' : modelKey(value.provider, value.model)}
        onClose={() => { setOpen(null) }}
        onSelect={(key) => {
          if (key === 'retry') { retryCatalog(); setOpen(null); return }
          if (key === 'off') { if (value !== false) save(false); else setOpen(null); return }
          for (const candidate of choices) {
            if (candidate.key !== key) continue
            if (value !== false && candidate.provider === value.provider && candidate.model === value.model) {
              setOpen(null)
              return
            }
            save({ provider: candidate.provider, model: candidate.model })
            return
          }
        }}
        anchor={<button ref={modelRef} type="button" className={css.selector} disabled={!settings.writable} aria-disabled={disabled}
          aria-label={t('sessionCreateOverride.model')} aria-haspopup="menu" aria-expanded={open === 'model' && !disabled}
          onClick={() => { if (!disabled) setOpen(open === 'model' ? null : 'model') }}>
          <span className={css.value}>{modelLabel}</span><IconChevronDownOutlineRegular />
        </button>} />
      <Menu open={open === 'effort' && !disabled && value !== false} portal align="end" autoFocus
        items={[{ id: '', label: t('sessionCreateOverride.defaultEffort') }, ...efforts.map(option => ({ id: option.id, label: option.name }))]}
        selectedId={effort ?? ''} onClose={() => { setOpen(null) }}
        onSelect={(reasoningEffort) => {
          if (value === false || selected === undefined || reasoningEffort === (value.reasoningEffort ?? '')) {
            setOpen(null)
            return
          }
          save({
            provider: value.provider,
            model: value.model,
            ...reasoningEffort === '' ? {} : { reasoningEffort },
          })
        }}
        anchor={<button ref={effortRef} type="button" className={css.selector} disabled={!settings.writable || value === false || selected === undefined}
          aria-disabled={disabled || value === false || selected === undefined}
          aria-label={t('sessionCreateOverride.effort')} aria-haspopup="menu"
          aria-expanded={open === 'effort' && !disabled && value !== false && selected !== undefined}
          onClick={() => { if (!disabled && value !== false && selected !== undefined) setOpen(open === 'effort' ? null : 'effort') }}>
          <span className={css.value}>{effortLabel}</span><IconChevronDownOutlineRegular />
        </button>} />
    </div>
  </div>
}
