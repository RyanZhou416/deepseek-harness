/** General Settings switch for the Host's unattended-mode entry. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { GeneralToggleRow } from './GeneralToggleRow.tsx'

/** Fields owned by the `unattended-mode` Host entry. */
export interface UnattendedModeSettings {
  enabled: boolean
}

/** Accepted switch state and revision-fenced writer supplied by the plugin registration. */
export interface UnattendedModeRowInjected {
  hooks: {
    /** Host-accepted `unattended-mode` settings. */
    unattendedMode: ObservableSnapshot<ConfigFormSnapshot<UnattendedModeSettings>>
  }
  /**
   * Persist the switch against the revision the row displayed.
   * @param enabled - next switch state.
   * @param revision - revision of the displayed snapshot.
   * @returns whether the Host accepted the write.
   */
  setEnabled(enabled: boolean, revision: number | undefined): Promise<boolean>
}

/** Framework-derived General Settings row props. */
export type UnattendedModeRowProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings'>
  & InjectFace<UnattendedModeRowInjected>

/**
 * Persist the switch through the Host-backed form.
 * @param form - settings form for the `unattended-mode` entry.
 * @param enabled - next switch state.
 * @param revision - revision the row displayed.
 * @returns whether the Host accepted the write; a non-ready or read-only form refuses locally.
 */
export function saveUnattendedMode(
  form: ConfigForm<UnattendedModeSettings>, enabled: boolean, revision: number | undefined,
): Promise<boolean> {
  const snapshot = form.getSnapshot()
  if (snapshot.status !== 'ready' || !snapshot.writable) return Promise.resolve(false)
  return form.mutate([{ op: 'set', path: ['enabled'], value: enabled }], revision)
}

/**
 * Render the unattended-mode switch.
 * @param props - accepted switch state, writer, and localized copy.
 * @returns the General Settings row, disabled until the Host serves a writable value.
 */
export function UnattendedModeRow({ useUnattendedMode, setEnabled, t }: UnattendedModeRowProps) {
  const snapshot = useUnattendedMode(value => value)
  const ready = snapshot.status === 'ready' && snapshot.writable && snapshot.value !== undefined
  return <GeneralToggleRow
    title={t('unattendedMode.title')}
    description={t('unattendedMode.description')}
    error={t('unattendedMode.error')}
    checked={snapshot.value?.enabled === true}
    disabled={!ready}
    onToggle={next => setEnabled(next, snapshot.revision)}
  />
}
