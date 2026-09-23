/**
  * PluginInfo — the card beside Context stats introducing the plugin. Metadata is baked in from package.json via tsdown `define` (see
  * meta.ts); one live npm-registry check (latestVersion.ts, 1-hour TTL) appends an `↑ vX.Y.Z` chip when newer.
  * Row labels lead with site marks: the simple-icons artwork (the set the harness's own SiteGlyph draws from), riding currentColor.
 */

import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { IconSettings } from '../primitives'
import { siDeepseek, siGithub, type SimpleIcon } from 'simple-icons'
import { fetchLatestVersion, isNewerVersion } from '../latestVersion'
import { PLUGIN_NAME, PLUGIN_REPO, PLUGIN_REPO_SHORT, PLUGIN_VERSION } from '../meta'
import { openPluginSettings } from '../settingsJump'
import type { ViewKit } from '../viewkit'

// The marks fill their 24-unit box edge to edge; the -2 inset leaves the same
// ~8% margin the harness's SiteGlyph leaves for its site marks (SiteGlyph
// itself is not exported, so the artwork rides the package directly).
function SiteMark({ icon }: { icon: SimpleIcon }): ReactElement {
  return (
    <svg width={12} height={12} className="lc-pi-labelicon" viewBox="-2 -2 28 28" fill="none" aria-hidden>
      <path d={icon.path} fill="currentColor" />
    </svg>
  )
}

export function makePluginInfo(kit: ViewKit): () => ReactElement {
  const { t } = kit
  // `title` carries the untruncated value: at narrow card widths the row's
  // ellipsis can cut the repo or name short, and the hover text recovers it.
  const row = (icon: ReactElement, label: string, value: ReactNode, href: string, hint: string) => (
    <a className="lc-pi-row group/pi" href={href} target="_blank" rel="noreferrer">
      <div className="lc-pi-label">{icon}{label}</div>
      <div className="lc-pi-value group-hover/pi:underline" title={hint}>{value}</div>
    </a>
  )
  return function PluginInfo(): ReactElement {
    const [latest, setLatest] = useState<string | null>(null)
    useEffect(() => {
      if (PLUGIN_VERSION.includes('-dev')) return
      let on = true
      // Fire-and-forget: fetchLatestVersion never rejects (every failure
      // narrows to null), and the `on` flag drops late results.
      void fetchLatestVersion().then((v) => { if (on && v) setLatest(v) })
      return () => { on = false }
    }, [])
    const update = latest !== null && isNewerVersion(latest, PLUGIN_VERSION) ? latest : null
    const nameText = PLUGIN_NAME + ' (v' + PLUGIN_VERSION + ')'
    const nameValue: ReactNode[] = [nameText]
    if (update) nameValue.push(<span key="update" className="lc-pi-update">{'↑ v' + update}</span>)
    // The quarter-share card of the head row (the stats card takes 3 parts): its rows
    // ellipsize and recover values on hover, so a 240px floor suffices.
    return (
      <div className="lc-card flex-1 min-w-[min(240px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('plugin.title')}</span>
          {/* The tagline doubles as the repo link: hover underlines it, a click opens GitHub. */}
          <a className="lc-card-sub lc-pi-hint hover:underline" href={PLUGIN_REPO} target="_blank" rel="noreferrer">
            {t('plugin.hint')}
          </a>
        </div>
        <div className="lc-pi-grid">
          {row(<SiteMark icon={siDeepseek} />, t('plugin.name'), nameValue, PLUGIN_REPO, update !== null ? nameText + ' ↑ v' + update : nameText)}
          {row(<SiteMark icon={siGithub} />, t('plugin.github'), PLUGIN_REPO_SHORT, PLUGIN_REPO, PLUGIN_REPO_SHORT)}
          {/* Best-effort jump to this plugin's preferences — openPluginSettings silently no-ops when the host's chrome doesn't match. */}
          <button type="button" className="lc-pi-row lc-pi-row-btn group/pi" onClick={() => { openPluginSettings() }}>
            <div className="lc-pi-label"><IconSettings size={12} className="lc-pi-labelicon" />{t('plugin.settings')}</div>
            <div className="lc-pi-value group-hover/pi:underline" title={t('plugin.settingsOpen')}>{t('plugin.settingsOpen')}</div>
          </button>
        </div>
      </div>
    )
  }
}
