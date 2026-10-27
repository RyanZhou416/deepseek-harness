/** Locale bundles for the CC subscription pool settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CcPoolSaveError } from './settings-controller.ts'

/** Locale keys the page renders. */
export type CcPoolSettingsLocaleKey =
  | 'nav' | 'title' | 'description' | 'loading'
  | 'token' | 'tokenHint' | 'tokenConfigured' | 'tokenConfiguredFrom' | 'tokenUnset' | 'tokenReadOnly'
  | 'models' | 'modelsHint' | 'modelsOverridden' | 'resetModels' | 'addModel' | 'removeModel' | 'removeModelFor' | 'modelRow'
  | 'modelId' | 'modelName' | 'modelContext' | 'modelMaxTokens' | 'modelEffort'
  | 'idBlank' | 'idDuplicate' | 'nameBlank' | 'positiveInteger' | 'reasoningLevel' | 'emptyCatalogue'
  | 'syncModels' | 'syncing' | 'syncEmpty' | 'syncDuplicate' | 'syncInvalid' | 'syncNoToken' | 'syncFailed' | 'syncTimeout'
  | 'syncRemoveTitle' | 'syncRemoveDescription' | 'syncRemoveList' | 'syncRemoveConfirm' | 'syncRemoveKeep'
  | 'fromPool' | 'cancel'
  | 'unavailable' | 'readOnly' | 'save' | 'saving' | 'saveFailed'
  | 'saveConflict' | 'saveCredentialFailed' | 'saveUnreachable'

/** English copy. */
export const en: Record<CcPoolSettingsLocaleKey, string> = {
  nav: 'CC subscription pool',
  title: 'CC subscription pool',
  description: 'Set the pool credential and the model list this route serves.',
  loading: 'Loading…',
  token: 'Pool token',
  tokenHint: 'Stored as the CC_POOL_API_KEY credential and sent with every pool request. A stored value is never shown; type a new one to rotate it.',
  tokenConfigured: 'Configured',
  tokenConfiguredFrom: 'Configured · {source}',
  tokenUnset: 'Not configured',
  tokenReadOnly: 'This credential comes from the deployment environment and cannot be changed here.',
  models: 'Model list',
  modelsHint: 'Each row is one wire model id the selector offers. Saving replaces the list the route serves; reset removes the override and restores the built-in list.',
  modelsOverridden: 'Overridden',
  resetModels: 'Reset to built-in',
  addModel: 'Add model',
  removeModel: 'Remove',
  removeModelFor: 'Remove model {index}',
  modelRow: 'Model {index}',
  modelId: 'Model id',
  modelName: 'Display name',
  modelContext: 'Context window',
  modelMaxTokens: 'Max output tokens',
  modelEffort: 'Default effort',
  idBlank: 'Enter a model id.',
  idDuplicate: 'This model id is already used by another row.',
  nameBlank: 'Enter a display name.',
  positiveInteger: 'Enter a whole number greater than zero.',
  reasoningLevel: 'Choose one of low, medium, high, xhigh, or max.',
  emptyCatalogue: 'Keep at least one model, or reset the list to the built-in models.',
  syncModels: 'Sync from pool',
  syncing: 'Syncing…',
  syncEmpty: 'The pool returned no models. The list is unchanged.',
  syncDuplicate: 'The pool returned the same model id more than once. The list is unchanged.',
  syncInvalid: 'The pool returned a model without a usable id. The list is unchanged.',
  syncNoToken: 'Store the pool token before syncing. The list is unchanged.',
  syncFailed: 'Sync failed: {reason}',
  syncTimeout: 'The pool did not answer in time. The list is unchanged.',
  syncRemoveTitle: 'Remove the models the pool no longer lists?',
  syncRemoveDescription: 'The pool no longer lists {count} of these models. Removing them makes this list match the pool; keeping them only adds and updates.',
  syncRemoveList: 'Models the pool no longer lists',
  syncRemoveConfirm: 'Remove and sync',
  syncRemoveKeep: 'Keep and sync',
  fromPool: 'From pool',
  cancel: 'Cancel',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  readOnly: 'This deployment stores settings read-only.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  saveConflict: 'Another change reached this setting first. Your edits are kept — save again to apply them.',
  saveCredentialFailed: 'The pool token could not be stored: {reason}',
  saveUnreachable: 'The deployment could not be reached; your edits are kept. Try saving again.',
}

/** Simplified Chinese copy. */
export const zh: Record<CcPoolSettingsLocaleKey, string> = {
  nav: 'CC 订阅池',
  title: 'CC 订阅池',
  description: '配置订阅池凭证，以及该路由提供的模型列表。',
  loading: '加载中…',
  token: '订阅池凭证',
  tokenHint: '保存为 CC_POOL_API_KEY 凭证，随每次池请求发送。已保存的值不会显示；填入新值即可轮换。',
  tokenConfigured: '已配置',
  tokenConfiguredFrom: '已配置 · {source}',
  tokenUnset: '未配置',
  tokenReadOnly: '该凭证来自部署环境，无法在此修改。',
  models: '模型列表',
  modelsHint: '每行是选择器提供的一个线上模型 id。保存会整体替换该路由提供的列表；恢复默认会移除覆盖并回到内置列表。',
  modelsOverridden: '已覆盖',
  resetModels: '恢复默认',
  addModel: '添加模型',
  removeModel: '删除',
  removeModelFor: '删除模型 {index}',
  modelRow: '模型 {index}',
  modelId: '模型 id',
  modelName: '显示名',
  modelContext: '上下文窗口',
  modelMaxTokens: '最大输出 token',
  modelEffort: '默认 effort',
  idBlank: '请填写模型 id。',
  idDuplicate: '该模型 id 与其他行重复。',
  nameBlank: '请填写显示名。',
  positiveInteger: '请填写大于 0 的整数。',
  reasoningLevel: '请选择 low、medium、high、xhigh 或 max。',
  emptyCatalogue: '至少保留一个模型，或将列表恢复为内置模型。',
  syncModels: '从池同步模型',
  syncing: '同步中…',
  syncEmpty: '订阅池没有返回任何模型，列表未改动',
  syncDuplicate: '订阅池返回了重复的模型 id，列表未改动',
  syncInvalid: '订阅池返回的模型缺少可用的 id，列表未改动',
  syncNoToken: '请先保存订阅池凭证再同步，列表未改动',
  syncFailed: '同步失败：{reason}',
  syncTimeout: '订阅池响应超时，列表未改动',
  syncRemoveTitle: '删除订阅池已不再提供的模型？',
  syncRemoveDescription: '订阅池已不再提供其中 {count} 个模型：删除后列表与订阅池一致，保留则只新增和更新',
  syncRemoveList: '订阅池已不再提供的模型',
  syncRemoveConfirm: '删除并同步',
  syncRemoveKeep: '保留并同步',
  fromPool: '来自订阅池',
  cancel: '取消',
  unavailable: '该插件当前未加载，暂时无法配置。',
  readOnly: '本部署的设置为只读。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  saveConflict: '该设置已被其他地方修改，你的修改已保留；请再次保存以应用。',
  saveCredentialFailed: '订阅池凭证保存失败：{reason}',
  saveUnreachable: '无法连接到本部署，修改已保留；请重试保存。',
}

/**
 * The shared settings form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @param failure - why the last save did not land, when it did not.
 * @returns the labels the frame renders; its failure line states the actual cause.
 */
export function formLabels(
  t: (key: CcPoolSettingsLocaleKey, params?: Record<string, unknown>) => string,
  failure: CcPoolSaveError | undefined,
): SettingsFormLabels {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: saveFailureText(t, failure),
    save: t('save'),
    saving: t('saving'),
  }
}

/**
 * The failure line one save error shows.
 * @param t - the page's locale reader.
 * @param failure - why the last save did not land.
 * @returns the localized report, naming the Host's own reason where one exists.
 */
function saveFailureText(
  t: (key: CcPoolSettingsLocaleKey, params?: Record<string, unknown>) => string,
  failure: CcPoolSaveError | undefined,
): string {
  if (failure === undefined) return t('saveFailed')
  switch (failure.kind) {
    case 'conflict': return t('saveConflict')
    case 'credential': return t('saveCredentialFailed', { reason: failure.message })
    case 'transport': return t('saveUnreachable')
    case 'rejected': return t('saveFailed')
  }
}
