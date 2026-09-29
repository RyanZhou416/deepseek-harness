/** Locale bundles for the Subagent settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type SubagentSettingsLocaleKey =
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed'
  | 'subagentTitle' | 'subagentDescription' | 'subagentLimitsTitle'
  | 'subagentMaxDepth'
  | 'subagentDepthHelpLabel' | 'subagentDepthHelp'
  | 'subagentDepthZero' | 'subagentDepthOne' | 'subagentDepthOverride'
  | 'subagentMaxActive'
  | 'subagentCapacityHelpLabel' | 'subagentCapacityHelp'
  | 'subagentDepthInvalid'
  | 'subagentCapacityInvalid'
  | 'subagentModelSelectionTitle'
  | 'subagentModelSelectionToggle' | 'subagentModelSelectionChoose' | 'subagentModelSelectionAllowed'
  | 'subagentModelSelectionLoading' | 'subagentModelSelectionLoadFailed' | 'subagentModelSelectionRetry'
  | 'subagentModelSelectionPartial' | 'subagentModelSelectionUnavailable'
  | 'subagentModelSelectionUnavailableGroup' | 'subagentModelSelectionEmpty'
  | 'subagentModelSelectionRequired' | 'subagentModelSelectionConflict' | 'subagentModelSelectionOff'
  | 'subagentOverrideGeneralModel' | 'subagentOverrideGeneralEffort'
  | 'subagentOverrideGeneralTitle' | 'subagentOverrideGeneralDescription' | 'subagentOverrideOff' | 'subagentOverrideSaveFailed'
  | 'subagentOverrideTitle' | 'subagentOverrideToggle' | 'subagentOverrideScope'
  | 'subagentOverrideProvider' | 'subagentOverrideModel' | 'subagentOverrideEffort' | 'subagentOverrideChoose'
  | 'subagentOverrideDefaultEffort' | 'subagentOverrideRequired' | 'subagentOverrideUnavailable' | 'subagentOverrideCatalogFailed'

/** English copy. */
export const en: Record<SubagentSettingsLocaleKey, string> = {
  subagentOverrideGeneralModel: 'Subagent override model',
  subagentOverrideGeneralEffort: 'Subagent reasoning effort',
  subagentOverrideGeneralTitle: 'Subagent model override',
  subagentOverrideGeneralDescription: 'Applies to new ordinary Subagents',
  subagentOverrideOff: 'No override',
  subagentOverrideSaveFailed: 'Could not save. Please try again.',
  subagentOverrideTitle: 'Forced model',
  subagentOverrideToggle: 'Force a model for new Subagents',
  subagentOverrideScope: 'Overrides agent choices for new Subagents, including those created from existing sessions. AgentTeams members keep their own settings. Existing Subagents keep their saved models. Backends that cannot apply this override reject new requests.',
  subagentOverrideProvider: 'Provider',
  subagentOverrideModel: 'Model',
  subagentOverrideEffort: 'Reasoning effort',
  subagentOverrideChoose: 'Select…',
  subagentOverrideDefaultEffort: 'Model default',
  subagentOverrideRequired: 'Select a provider and model before saving.',
  subagentOverrideUnavailable: 'This saved model is not advertised by the current directory. Its selection is retained; creation fails if the provider cannot resolve it.',
  subagentOverrideCatalogFailed: 'Some models could not be loaded. Your selection is retained.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  subagentTitle: 'Subagent',
  subagentDescription: 'Set Subagent recursion depth, count, and models.',
  subagentLimitsTitle: 'Limits',
  subagentMaxDepth: 'Maximum recursion depth',
  subagentDepthHelpLabel: 'About maximum recursion depth',
  subagentDepthHelp: 'Limits how many levels of Subagents an Agent can create.',
  subagentDepthZero: 'Disable Subagents',
  subagentDepthOne: 'Only the main Agent can create Subagents',
  subagentDepthOverride: 'If a tool defines its own maximum recursion depth, that setting takes precedence.',
  subagentMaxActive: 'Subagent parallelism limit',
  subagentCapacityHelpLabel: 'About the Subagent parallelism limit',
  subagentCapacityHelp: 'Total live Subagents under the same main Agent, across all recursion levels. The main Agent is excluded. New start requests are rejected when the limit is reached.',
  subagentDepthInvalid: 'Enter a whole number of 0 or more.',
  subagentCapacityInvalid: 'Enter a whole number of 1 or more.',
  subagentModelSelectionTitle: 'Model selection',
  subagentModelSelectionToggle: 'Allow agents to choose models for Subagents',
  subagentModelSelectionChoose: 'When enabled, agents can choose a provider, model, and reasoning effort for each Subagent from the authorized models below. Applies only to new sessions.',
  subagentModelSelectionAllowed: 'Models agents may choose',
  subagentModelSelectionLoading: 'Loading models…',
  subagentModelSelectionLoadFailed: 'Models could not be loaded.',
  subagentModelSelectionRetry: 'Retry',
  subagentModelSelectionPartial: 'Some model providers could not be loaded; saved choices remain removable.',
  subagentModelSelectionUnavailable: 'Currently unavailable',
  subagentModelSelectionUnavailableGroup: 'Saved but currently unavailable',
  subagentModelSelectionEmpty: 'No model provider currently advertises a model.',
  subagentModelSelectionRequired: 'Select at least one model before saving.',
  subagentModelSelectionConflict: 'Settings changed elsewhere. Discard your draft and try again.',
  subagentModelSelectionOff: 'Without a forced model, Subagents use configured defaults or inherit the parent agent\'s model. Saved model choices are retained.',
}

/** Simplified Chinese copy. */
export const zh: Record<SubagentSettingsLocaleKey, string> = {
  subagentOverrideGeneralModel: 'Subagent 覆盖模型',
  subagentOverrideGeneralEffort: 'Subagent 推理强度',
  subagentOverrideGeneralTitle: 'Subagent 模型覆盖',
  subagentOverrideGeneralDescription: '仅影响新建的普通 Subagent',
  subagentOverrideOff: '不覆盖',
  subagentOverrideSaveFailed: '未能保存，请重试',
  subagentOverrideTitle: '强制模型覆盖',
  subagentOverrideToggle: '为新建 Subagent 强制指定模型',
  subagentOverrideScope: '优先于 Agent 的模型选择，也适用于已有会话新建的 Subagent。AgentTeams 成员使用自己的设置；已有 Subagent 保留已保存的模型。不支持应用覆盖的后端会拒绝新的创建请求',
  subagentOverrideProvider: '提供方',
  subagentOverrideModel: '模型',
  subagentOverrideEffort: '推理强度',
  subagentOverrideChoose: '请选择…',
  subagentOverrideDefaultEffort: '模型默认值',
  subagentOverrideRequired: '保存前请选择提供方和模型',
  subagentOverrideUnavailable: '当前目录未公布这个已保存的模型，选择仍会保留；如果提供方无法解析该模型，创建请求会失败',
  subagentOverrideCatalogFailed: '部分模型无法加载，已保留你的选择',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  subagentTitle: 'Subagent',
  subagentDescription: '设置 Subagent 的递归层级、数量和模型。',
  subagentLimitsTitle: '运行限制',
  subagentMaxDepth: '最大递归深度',
  subagentDepthHelpLabel: '最大递归深度说明',
  subagentDepthHelp: '限制 Agent 创建 Subagent 的递归层级。',
  subagentDepthZero: '禁用 Subagent',
  subagentDepthOne: '仅允许主 Agent 创建 Subagent',
  subagentDepthOverride: '如果某个工具单独设置了最大递归深度，以该工具的设置为准。',
  subagentMaxActive: 'Subagent 并行数量上限',
  subagentCapacityHelpLabel: 'Subagent 并行数量上限说明',
  subagentCapacityHelp: '同一主 Agent 下，所有递归层级同时存活的 Subagent 总数，主 Agent 不计入。达到上限时，新的启动请求会被拒绝。',
  subagentDepthInvalid: '请输入不小于 0 的整数。',
  subagentCapacityInvalid: '请输入不小于 1 的整数。',
  subagentModelSelectionTitle: '模型选择',
  subagentModelSelectionToggle: '允许 Agent 为 Subagent 选择模型',
  subagentModelSelectionChoose: '开启后，Agent 可以从下方授权模型中，为每个 Subagent 选择提供方、模型和推理强度。仅影响新会话。',
  subagentModelSelectionAllowed: 'Agent 可选择的模型',
  subagentModelSelectionLoading: '正在加载模型…',
  subagentModelSelectionLoadFailed: '无法加载模型。',
  subagentModelSelectionRetry: '重试',
  subagentModelSelectionPartial: '部分模型提供方暂时无法加载；已保存的选择仍可移除。',
  subagentModelSelectionUnavailable: '当前不可用',
  subagentModelSelectionUnavailableGroup: '已保存但当前不可用',
  subagentModelSelectionEmpty: '当前没有模型提供方公布模型。',
  subagentModelSelectionRequired: '保存前请至少选择一个模型。',
  subagentModelSelectionConflict: '设置已在其他位置更新。请放弃修改后重试。',
  subagentModelSelectionOff: '未启用强制覆盖时，Subagent 使用配置的默认模型或继承父 Agent 的模型；已选模型会保留。',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: SubagentSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
