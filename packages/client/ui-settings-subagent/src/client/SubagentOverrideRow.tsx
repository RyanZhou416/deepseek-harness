/** General Settings shortcut for the accepted Subagent model override. */
import { useEffect, useRef, useState } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry, SettingsFormScopeSnapshot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubagentLimitsSettings, SubagentModelOverrideValue } from './subagent-limits-card-controller.ts'
import type { SubagentModelSelectionCardFace } from './subagent-model-selection-card-controller.ts'
import { subagentModelKey } from './subagent-model-selection-card-controller.ts'
import css from './SubagentOverrideRow.module.css'

/** Accepted configuration and the shared model directory, independent of plugin-page drafts. */
export interface SubagentOverrideRowInjected {
  hooks: SubagentModelSelectionCardFace['hooks'] & {
    /** The Host-accepted subagent namespace. */
    subagentOverride: ObservableSnapshot<SettingsFormScopeSnapshot<SubagentLimitsSettings>>
  }
  /** Persist only modelOverride against the revision displayed by this row. */
  selectOverride: (value: SubagentModelOverrideValue | false, revision: number | undefined) => Promise<boolean>
  /** Load or retry the shared model directory. */
  retryCatalog: () => void
}

/** Framework-derived General Settings row props. */
export type SubagentOverrideRowProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.subagent'> & InjectFace<SubagentOverrideRowInjected>

/**
 * Render immediate model and reasoning selectors for new ordinary children.
 * @param props - Accepted settings, catalog, localized copy, and the field-only writer.
 * @returns One General Settings row, or nothing when the Host lacks the override.
 */
export function SubagentOverrideRow({
  useSubagentOverride, useSubagentModelSelectionCard, selectOverride, retryCatalog, t,
}: SubagentOverrideRowProps) {
  const settings = useSubagentOverride(value => value)
  const catalog = useSubagentModelSelectionCard(value => value)
  const [open, setOpen] = useState<'model' | 'effort' | null>(null)
  const modelRef = useRef<HTMLButtonElement>(null)
  const effortRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const value = settings.value?.modelOverride
  const disabled = !settings.writable || busy

  useEffect(() => {
    if (open !== null && catalog.catalogStatus === 'idle') retryCatalog()
  }, [open, catalog.catalogStatus, retryCatalog])

  if (settings.status !== 'ready' || value === undefined) return null
  const candidates = catalog.candidates.filter(candidate => candidate.available)
  const selected = value === false ? undefined
    : candidates.find(candidate => candidate.provider === value.provider && candidate.model === value.model)
  const efforts = selected?.reasoning?.efforts ?? []
  const modelItems: MenuEntry[] = [{ id: 'off', label: t('subagentOverrideOff') }]
  let provider: string | undefined
  for (const candidate of candidates) {
    if (candidate.provider !== provider) {
      provider = candidate.provider
      modelItems.push({ type: 'label', id: 'provider:' + provider, text: candidate.providerName })
    }
    modelItems.push({ id: candidate.key, label: candidate.modelName })
  }
  if (catalog.catalogStatus === 'loading' || catalog.catalogStatus === 'idle') {
    modelItems.push({ type: 'label', id: 'loading', text: t('subagentModelSelectionLoading') })
  } else if (catalog.catalogStatus === 'error' || catalog.catalogPartial) {
    modelItems.push({ id: 'retry', label: t('subagentModelSelectionRetry') })
  } else if (candidates.length === 0) {
    modelItems.push({ type: 'label', id: 'empty', text: t('subagentModelSelectionEmpty') })
  }
  const save = (next: SubagentModelOverrideValue | false): void => {
    setOpen(null)
    setFailed(false)
    setBusy(true)
    void selectOverride(next, settings.revision)
      .then((accepted) => { setFailed(!accepted) }, () => { setFailed(true) })
      .finally(() => { setBusy(false) })
  }
  const modelLabel = value === false ? t('subagentOverrideOff') : selected?.modelName ?? value.model
  const effort = value === false ? undefined : value.reasoningEffort
  const effortLabel = efforts.find(option => option.id === effort)?.name ?? effort ?? t('subagentOverrideDefaultEffort')
  const description = failed ? t('subagentOverrideSaveFailed')
    : !settings.writable ? t('readOnly')
      : catalog.catalogStatus === 'error' || catalog.catalogPartial ? t('subagentOverrideCatalogFailed')
        : t('subagentOverrideGeneralDescription')

  return <div className={css.row} data-subagent-override-row aria-busy={busy}
    onKeyDownCapture={(event) => {
      if (event.key !== 'Escape' || open === null) return
      event.preventDefault()
      event.stopPropagation()
      ;(open === 'model' ? modelRef : effortRef).current?.focus({ preventScroll: true })
      setOpen(null)
    }}>
    <div className={css.text}>
      <div className={css.title}>{t('subagentOverrideGeneralTitle')}</div>
      <div className={css.description} role={failed ? 'alert' : undefined}>{description}</div>
    </div>
    <div className={css.controls}>
      <Menu open={open === 'model' && !disabled} portal align="end" autoFocus
        items={modelItems} selectedId={value === false ? 'off' : subagentModelKey(value)}
        onClose={() => { setOpen(null) }}
        onSelect={(key) => {
          if (key === 'retry') { retryCatalog(); setOpen(null); return }
          if (key === 'off') { if (value !== false) save(false); else setOpen(null); return }
          for (const candidate of candidates) {
            if (candidate.key !== key) continue
            if (value !== false && candidate.provider === value.provider && candidate.model === value.model) { setOpen(null); return }
            save({ provider: candidate.provider, model: candidate.model })
            return
          }
        }}
        anchor={<button ref={modelRef} type="button" className={css.selector} disabled={!settings.writable} aria-disabled={disabled}
          aria-label={t('subagentOverrideGeneralModel')} aria-haspopup="menu" aria-expanded={open === 'model' && !disabled}
          onClick={() => { if (!disabled) setOpen(open === 'model' ? null : 'model') }}>
          <span className={css.value}>{modelLabel}</span><IconChevronDownOutlineRegular />
        </button>} />
      <Menu open={open === 'effort' && !disabled && value !== false} portal align="end" autoFocus
        items={[{ id: '', label: t('subagentOverrideDefaultEffort') }, ...efforts.map(option => ({ id: option.id, label: option.name }))]}
        selectedId={effort ?? ''} onClose={() => { setOpen(null) }}
        onSelect={(reasoningEffort) => {
          if (value === false || reasoningEffort === (value.reasoningEffort ?? '')) { setOpen(null); return }
          save({ provider: value.provider, model: value.model, ...reasoningEffort === '' ? {} : { reasoningEffort } })
        }}
        anchor={<button ref={effortRef} type="button" className={css.selector} disabled={!settings.writable || value === false} aria-disabled={disabled || value === false}
          aria-label={t('subagentOverrideGeneralEffort')} aria-haspopup="menu" aria-expanded={open === 'effort' && !disabled && value !== false}
          onClick={() => { if (!disabled) setOpen(open === 'effort' ? null : 'effort') }}>
          <span className={css.value}>{effortLabel}</span><IconChevronDownOutlineRegular />
        </button>} />
    </div>
  </div>
}
