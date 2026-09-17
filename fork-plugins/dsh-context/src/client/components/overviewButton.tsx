/**
 * The Context Dashboard's sidebar entry: a footer action stacked directly
 * above Settings (the harness's own foot layout: footer actions, then the
 * settings row), mirroring the Settings trigger's geometry in both column
 * widths. The button carries the plugin emblem and, on the wide
 * column, its label. Clicking opens the overview overlay through the shared
 * module store (overviewStore.ts).
 *
 * The per-user `insightsEntry` preference takes the entry down (renders
 * null) without unregistering the seat. The subscription fails open: an
 * absent settings store, an unserved namespace, or a value the plugin
 * cannot understand all leave the entry visible.
 */

import { useSyncExternalStore, type ReactElement } from 'react'
import { ContextIcon } from '../icon'
import { overviewStore } from '../overviewStore'
import type { ContextSettings, InsightsEntry } from '../settings'
import type { ViewKit } from '../viewkit'

export interface OverviewButtonProps {
  /** The footer-action owner share: false on the collapsed 56px rail (icon only). */
  wide?: boolean
}

/** Stable subscription faces for the settings-less degrade (no re-subscribes). */
const subscribeNever = (): (() => void) => () => {}
const entryShown = (): 'show' => 'show'

export function makeOverviewButton(kit: ViewKit, settings?: ContextSettings): (props: OverviewButtonProps) => ReactElement | null {
  const { t } = kit
  // Stable per-factory faces: useSyncExternalStore resubscribes when the
  // subscribe identity changes, so both wrappers are made once, here.
  const subscribeEntry = settings === undefined
    ? subscribeNever
    : (listener: () => void): (() => void) => settings.store.subscribe(listener)
  const getEntry = settings === undefined ? entryShown : (): InsightsEntry => settings.insightsEntry()
  return function OverviewButton(props: OverviewButtonProps): ReactElement | null {
    // The entry toggle: subscribed, so a preference flip takes effect live.
    const entry = useSyncExternalStore(subscribeEntry, getEntry)
    if (entry === 'hide') return null
    return (
      <button
        type="button"
        className={props.wide === true ? 'lc-ov-entry' : 'lc-ov-entry lc-ov-entry-rail'}
        title={t('ov.entry')}
        aria-label={t('ov.entry')}
        onClick={() => { overviewStore.set(true) }}
      >
        <ContextIcon size={props.wide === true ? 16 : 18} className="lc-ov-entry-icon" />
        {props.wide === true && <span className="lc-ov-entry-label">{t('ov.entry')}</span>}
      </button>
    )
  }
}
