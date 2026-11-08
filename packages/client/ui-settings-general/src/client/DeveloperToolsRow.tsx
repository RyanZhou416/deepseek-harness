/** General Settings control for shared developer-tool visibility and previews. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { GeneralToggleRow } from './GeneralToggleRow.tsx'

/** Accepted setting and ordered mutation supplied by the settings owner. */
export interface DeveloperToolsRowInjected {
  hooks: { developerTools: ObservableSnapshot<boolean> }
  setEnabled(enabled: boolean): Promise<void>
}

/**
 * Render the developer-tool toggle.
 * @param props - accepted preference, writer and localized copy.
 * @returns the General Settings row.
 */
export function DeveloperToolsRow({ useDeveloperTools, setEnabled, t }:
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings'> & InjectFace<DeveloperToolsRowInjected>) {
  const enabled = useDeveloperTools(value => value)
  return <GeneralToggleRow
    title={t('developerTools.title')}
    description={t('developerTools.description')}
    error={t('developerTools.error')}
    checked={enabled}
    disabled={false}
    onToggle={setEnabled}
  />
}
