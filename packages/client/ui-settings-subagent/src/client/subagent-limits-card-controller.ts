/** Staged delegation limits and forced child models in one Host settings mutation. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Host-owned delegation defaults, live capacity, and optional forced model. */
export interface SubagentLimitsSettings {
  maxDepth: number
  maxActiveSubagents: number
  /** Absent on Hosts that do not expose forced child models. */
  modelOverride?: SubagentModelOverrideValue | false
}

/** Exact forced route and optional model-specific effort stored in the Host configuration. */
export interface SubagentModelOverrideValue {
  provider: string
  model: string
  reasoningEffort?: string
}

function overrideValue(text: string): SubagentModelOverrideValue | null | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch (_error) { return undefined /* Invalid staged JSON cannot be saved. */ }
  if (value === false) return null
  if (value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)
    || !('provider' in value) || typeof value.provider !== 'string'
    || !('model' in value) || typeof value.model !== 'string'
    || ('reasoningEffort' in value && typeof value.reasoningEffort !== 'string')) return undefined
  return { provider: value.provider, model: value.model,
    ...'reasoningEffort' in value ? { reasoningEffort: value.reasoningEffort as string } : {} }
}

const overrideField: SettingsFieldSpec = {
  field: 'modelOverride',
  format: value => JSON.stringify(value ?? false),
  parse: (text) => {
    const value = overrideValue(text)
    if (value === undefined || (value !== null && (!value.provider.trim() || !value.model.trim()
      || value.reasoningEffort === ''))) return undefined
    return { kind: 'set', value: value ?? false }
  },
}

/** Effective values and drafts presented by the limits card. */
export interface SubagentLimitsCardState extends SettingsFormShell {
  maxDepth: SettingsFieldState
  maxActiveSubagents: SettingsFieldState
  modelOverride: SettingsFieldState
  overrideAvailable: boolean
  overrideValue: SubagentModelOverrideValue | null
}

/** Actions and observable state bound by the slot renderer. */
export interface SubagentLimitsCardFace extends SettingsFormActions {
  hooks: {
    subagentLimitsCard: SnapshotStore<SubagentLimitsCardState>
  }
}

function limitField(field: keyof SubagentLimitsSettings, minimum: number): SettingsFieldSpec {
  const numeric = settingsNumberField(field)
  return {
    ...numeric,
    parse: (text) => {
      const write = numeric.parse(text)
      if (write?.kind !== 'set') return write
      const value = write.value as number
      return Number.isSafeInteger(value) && value >= minimum && !Object.is(value, -0) ? write : undefined
    },
  }
}

/** Save limits and the forced model together with one namespace revision. */
export class SubagentLimitsCardController {
  private readonly form: SettingsFormModel<SubagentLimitsSettings>
  private readonly store: SnapshotStore<SubagentLimitsCardState>

  /** @param scope - The Host's `subagent` settings section. */
  constructor(scope: SettingsFormScope<SubagentLimitsSettings>) {
    this.form = new SettingsFormModel(scope, [limitField('maxDepth', 0), limitField('maxActiveSubagents', 1), overrideField])
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      maxDepth: this.form.field('maxDepth'),
      maxActiveSubagents: this.form.field('maxActiveSubagents'),
      modelOverride: this.form.field('modelOverride'),
      overrideAvailable: scope.getSnapshot().value?.modelOverride !== undefined,
      overrideValue: overrideValue(this.form.field('modelOverride').text) ?? null,
    }))
  }

  /**
   * Bind the limits editor to the slot renderer.
   * @returns The limits snapshot and staged write actions.
   */
  inject(): SubagentLimitsCardFace {
    return { hooks: { subagentLimitsCard: this.store }, ...this.form.actions() }
  }
  /** Release accepted-value subscriptions. */
  dispose(): void { this.form.dispose() }

}
