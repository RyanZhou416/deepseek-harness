/**
 * The CC subscription pool settings page: the pool credential, the editable
 * model catalogue, the sync that asks the pool what it serves, and the one
 * save that writes both.
 *
 * The credential control is write-only — the Host never returns the literal —
 * so it opens blank and reports only whether a value is configured and which
 * layer supplies it. The catalogue renders one row per entry with its wire
 * fields; a row that cannot be saved reports the problem under the offending
 * field and disables the save until it is fixed. A sync stages its merge like
 * any other edit: a model the pool dropped leaves the table only after the
 * user confirms, and nothing reaches the settings document before the save.
 * Closing the confirmation cancels the whole sync, so no removal or addition
 * the user dismissed reaches the table.
 */

import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal, SettingsForm, SettingsSecretField, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { CC_POOL_REASONING_LEVELS } from './contract.ts'
import type { CcPoolModelField } from './model-draft.ts'
import { formLabels } from './locales.ts'
import type {
  CcPoolRowState, CcPoolSectionFace, CcPoolSettingsState, CcPoolSyncError,
} from './settings-controller.ts'
import styles from './CcPoolSection.module.css'

/** Props the renderer binds for the CC subscription pool page. */
export type CcPoolSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.ccPool'>
  & InjectFace<CcPoolSectionFace>

/** One row's field problem line, rendered only while the field carries one. */
function FieldError(props: { id: string; message: string | undefined }): ReactNode {
  if (props.message === undefined) return null
  return <p id={props.id} className={styles.error}>{props.message}</p>
}

/**
 * The copy one refused sync reports.
 * @param t - the page's locale reader.
 * @param error - why the sync left the table unchanged.
 * @returns the localized message.
 */
function syncErrorText(t: CcPoolSectionProps['t'], error: CcPoolSyncError): string {
  return error.kind === 'copy' ? t(error.key) : t('syncFailed', { reason: error.message })
}

/** One editable catalogue row. */
function ModelRow(props: {
  row: CcPoolRowState
  index: number
  t: CcPoolSectionProps['t']
  disabled: boolean
  onEdit: (field: CcPoolModelField, text: string) => void
  onRemove: () => void
}): ReactNode {
  const { row, index, t, disabled } = props
  const prefix = `cc-pool-model-${String(row.key)}`
  const textField = (field: 'id' | 'name' | 'contextWindow' | 'maxTokens', label: string, numeric: boolean): ReactNode => {
    const error = row.errors[field]
    const messageId = `${prefix}-${field}-error`
    return (
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${prefix}-${field}`}>{label}</label>
        <input
          id={`${prefix}-${field}`}
          className={styles.input}
          type="text"
          {...numeric ? { inputMode: 'numeric' as const } : {}}
          {...error === undefined ? {} : { 'aria-invalid': true, 'aria-describedby': messageId }}
          value={row.draft[field]}
          disabled={disabled}
          onChange={(event) => { props.onEdit(field, event.target.value) }}
        />
        <FieldError id={messageId} message={error === undefined ? undefined : t(error)} />
      </div>
    )
  }
  const effortError = row.errors.defaultReasoning
  const effortMessageId = `${prefix}-defaultReasoning-error`
  return (
    <li className={styles.row}>
      <div className={styles.rowHead}>
        <span className={styles.rowLabel}>{t('modelRow', { index: index + 1 })}</span>
        {row.synced ? <Tag tone="info">{t('fromPool')}</Tag> : null}
      </div>
      <div className={styles.rowFields}>
        {textField('id', t('modelId'), false)}
        {textField('name', t('modelName'), false)}
        {textField('contextWindow', t('modelContext'), true)}
        {textField('maxTokens', t('modelMaxTokens'), true)}
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${prefix}-defaultReasoning`}>{t('modelEffort')}</label>
          <select
            id={`${prefix}-defaultReasoning`}
            className={styles.select}
            value={row.draft.defaultReasoning}
            disabled={disabled}
            {...effortError === undefined ? {} : { 'aria-invalid': true, 'aria-describedby': effortMessageId }}
            onChange={(event) => { props.onEdit('defaultReasoning', event.target.value) }}
          >
            {CC_POOL_REASONING_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
          </select>
          <FieldError id={effortMessageId} message={effortError === undefined ? undefined : t(effortError)} />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className={styles.remove}
          disabled={disabled}
          aria-label={t('removeModelFor', { index: index + 1 })}
          onClick={props.onRemove}
        >
          {t('removeModel')}
        </Button>
      </div>
    </li>
  )
}

/**
 * Render the CC subscription pool page.
 * @param props - locale copy, the page snapshot, and its staged edits.
 * @returns the page, or the loading line before the Host section arrives.
 */
export function CcPoolSection(props: CcPoolSectionProps): ReactNode {
  const { t } = props
  const state: CcPoolSettingsState = props.useCcPool(snapshot => snapshot)
  if (state.loading) return <p className={styles.loading} role="status">{t('loading')}</p>
  const disabled = !state.writable || state.saving
  const tokenDisabled = disabled || !state.token.writable
  return (
    <section className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>
      <p className={styles.description}>{t('description')}</p>
      <SettingsForm labels={formLabels(t, state.saveError)} state={state} onSave={props.save} onDiscard={props.discard}>
        <div className={styles.token}>
          <SettingsSecretField
            id="cc-pool-token"
            label={t('token')}
            hint={t('tokenHint')}
            text={state.token.text}
            configured={state.token.configured}
            stateLabel={state.token.configured
              ? state.token.source === undefined ? t('tokenConfigured') : t('tokenConfiguredFrom', { source: state.token.source })
              : t('tokenUnset')}
            disabled={tokenDisabled}
            onEdit={props.editToken}
          />
          {state.token.writable ? null : <p className={styles.hint}>{t('tokenReadOnly')}</p>}
          {state.token.error === undefined ? null : <p className={styles.error} role="status">{state.token.error}</p>}
        </div>
        <div className={styles.models}>
          <div className={styles.modelsHead}>
            <h3 className={styles.modelsTitle}>{t('models')}</h3>
            <Button
              variant="ghost"
              size="sm"
              className={styles.headAction}
              disabled={disabled || state.sync.running}
              onClick={props.syncModels}
            >
              {state.sync.running ? t('syncing') : t('syncModels')}
            </Button>
            {state.overridden || state.resetPending || state.emptyCatalogue
              ? <Button
                variant="ghost"
                size="sm"
                className={styles.headAction}
                disabled={disabled}
                onClick={props.resetModels}
              >
                {t('resetModels')}
              </Button>
              : null}
            {state.overridden ? <Tag tone="neutral">{t('modelsOverridden')}</Tag> : null}
          </div>
          <p className={styles.hint}>{t('modelsHint')}</p>
          {state.sync.error === undefined
            ? null
            : <p className={styles.error} role="status">{syncErrorText(t, state.sync.error)}</p>}
          {state.emptyCatalogue ? <p className={styles.error} role="status">{t('emptyCatalogue')}</p> : null}
          <ul className={styles.rows}>
            {state.rows.map((row, index) => (
              <ModelRow
                key={row.key}
                row={row}
                index={index}
                t={t}
                disabled={disabled}
                onEdit={(field, text) => { props.editRow(index, field, text) }}
                onRemove={() => { props.removeRow(index) }}
              />
            ))}
          </ul>
          <Button variant="outline" size="sm" disabled={disabled} onClick={props.addRow}>{t('addModel')}</Button>
          {state.sync.pendingRemoval === undefined ? null : (
            <Modal
              open
              onClose={props.cancelSync}
              title={t('syncRemoveTitle')}
              description={t('syncRemoveDescription', { count: state.sync.pendingRemoval.length })}
              closeLabel={t('close')}
              footer={(
                <>
                  {/* Closing the prompt cancels the whole sync, so the safest
                      outcome — the table stays as it was — owns initial focus. */}
                  <Button variant="outline" data-modal-autofocus onClick={props.cancelSync}>
                    {t('cancel')}
                  </Button>
                  <Button variant="outline" onClick={props.keepSyncRows}>
                    {t('syncRemoveKeep')}
                  </Button>
                  <Button variant="primary" onClick={props.confirmSyncRemoval}>{t('syncRemoveConfirm')}</Button>
                </>
              )}
            >
              <ul className={styles.syncRemoved} aria-label={t('syncRemoveList')}>
                {state.sync.pendingRemoval.map(id => <li key={id} className={styles.syncRemovedId}>{id}</li>)}
              </ul>
            </Modal>
          )}
        </div>
      </SettingsForm>
    </section>
  )
}
