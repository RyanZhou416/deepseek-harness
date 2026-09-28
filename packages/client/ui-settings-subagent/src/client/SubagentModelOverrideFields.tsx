/** Forced child model controls backed by the same atomic form as delegation limits. */

import { useEffect, useState } from 'react'
import { Button, Menu, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentLimitsCardFace, SubagentLimitsCardState, SubagentModelOverrideValue } from './subagent-limits-card-controller.ts'
import type { SubagentModelSelectionCardState } from './subagent-model-selection-card-controller.ts'
import css from './SubagentModelOverrideFields.module.css'

function Choice(props: {
  label: string
  value: string
  display: string
  disabled: boolean
  items: { id: string; label: string }[]
  choose: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return <div className={css.choice}>
    <span>{props.label}</span>
    <Menu open={open && !props.disabled} portal autoFocus
      anchor={<Button variant="outline" aria-label={props.label} aria-haspopup="menu" aria-expanded={open}
        disabled={props.disabled} onClick={() => { setOpen(!open) }}>{props.display}</Button>}
      items={props.items} selectedId={props.value} onClose={() => { setOpen(false) }}
      onSelect={(id) => { props.choose(id); setOpen(false) }} />
  </div>
}

/** Props for the forced-model section, sharing the existing model directory. */
export type SubagentModelOverrideFieldsProps = PropsLocale<'settings.subagent'>
  & Pick<SubagentLimitsCardFace, 'edit' | 'resetField'>
  & { state: SubagentLimitsCardState; catalog: SubagentModelSelectionCardState; retryCatalog: () => void }

/**
 * Render the user-owned override, independent of model-authored route choices.
 * @param props - Staged configuration, live directory, localized copy and actions.
 * @returns The forced route controls and application scope.
 */
export function SubagentModelOverrideFields(props: SubagentModelOverrideFieldsProps) {
  const { t, state, catalog, retryCatalog } = props
  const value = state.overrideValue
  const enabled = value !== null
  const disabled = !state.writable || state.saving
  useEffect(() => {
    if (enabled && catalog.catalogStatus === 'idle') retryCatalog()
  }, [enabled, catalog.catalogStatus, retryCatalog])
  const edit = (next: SubagentModelOverrideValue | null) => { props.edit('modelOverride', JSON.stringify(next ?? false)) }
  const candidates = catalog.candidates.filter(candidate => candidate.available)
  const providers = [...new Map(candidates.map(candidate => [candidate.provider, {
    id: candidate.provider, label: candidate.providerName,
  }])).values()]
  const models = candidates.filter(candidate => candidate.provider === value?.provider)
  const selected = models.find(candidate => candidate.model === value?.model)
  const efforts = selected?.reasoning?.efforts.map(effort => ({ id: effort.id, label: effort.name })) ?? []
  return <div className={css.section}>
    <div className={css.toggle}>
      <span>{t('subagentOverrideToggle')}</span>
      <Switch label={t('subagentOverrideToggle')} checked={enabled} disabled={disabled}
        onChange={() => { edit(enabled ? null : { provider: '', model: '' }) }} />
    </div>
    <p className={css.hint}>{t('subagentOverrideScope')}</p>
    {value !== null && <>
      <div className={css.choices}>
        <Choice label={t('subagentOverrideProvider')} value={value.provider} disabled={disabled || providers.length === 0}
          display={providers.find(provider => provider.id === value.provider)?.label ?? (value.provider || t('subagentOverrideChoose'))}
          items={providers} choose={(provider) => { edit({ provider, model: '' }) }} />
        <Choice label={t('subagentOverrideModel')} value={value.model} disabled={disabled || models.length === 0}
          display={selected?.modelName ?? (value.model || t('subagentOverrideChoose'))}
          items={models.map(model => ({ id: model.model, label: model.modelName }))}
          choose={(model) => { edit({ provider: value.provider, model }) }} />
        <Choice label={t('subagentOverrideEffort')} value={value.reasoningEffort ?? ''} disabled={disabled}
          display={efforts.find(effort => effort.id === value.reasoningEffort)?.label
            ?? value.reasoningEffort ?? t('subagentOverrideDefaultEffort')}
          items={[{ id: '', label: t('subagentOverrideDefaultEffort') }, ...efforts]}
          choose={(reasoningEffort) => { edit({ provider: value.provider, model: value.model,
            ...reasoningEffort === '' ? {} : { reasoningEffort } }) }} />
      </div>
      {catalog.catalogStatus === 'loading' && <p className={css.hint}>{t('subagentModelSelectionLoading')}</p>}
      {(catalog.catalogStatus === 'error' || catalog.catalogPartial) && <div className={css.notice}>
        <span>{t('subagentOverrideCatalogFailed')}</span>
        <Button size="sm" onClick={retryCatalog}>{t('subagentModelSelectionRetry')}</Button>
      </div>}
      {catalog.catalogStatus === 'ready' && value.model !== '' && selected === undefined
        && <p className={css.hint}>{t('subagentOverrideUnavailable')}</p>}
      {state.modelOverride.invalid && <p className={css.error}>{t('subagentOverrideRequired')}</p>}
    </>}
    {state.modelOverride.overridden && <div><Button size="sm" disabled={disabled}
      onClick={() => { props.resetField('modelOverride') }}>{t('reset')}</Button></div>}
  </div>
}
