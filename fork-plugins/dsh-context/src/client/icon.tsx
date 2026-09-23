/**
 * The Context emblem: the colourful document sheet, bundled rather than read
 * off the harness primitives so the plugin's identity is self-contained.
 *
 * The single graphic source is the package-root `icon.svg` — the same file
 * package.json `icon` hands to the Host's package-meta reader, which serves
 * it to the Plugins page's package cards. The client bundle inlines the
 * file's markup at build time (the `?raw` channel in tsdown.config.ts) and
 * re-renders it at every requested size. Fixed fills, never `currentColor` —
 * the sheet is deliberately polychrome on both light and dark chrome.
 */

import sheetMarkup from '../../icon.svg?raw'
import type { ReactElement } from 'react'
import type { Translate } from './i18n'

/** Everything between the file's `<svg>` tags: the sheet's strokes in paint order, whitespace-folded. */
const SHEET_MARKUP = sheetMarkup
  .slice(sheetMarkup.indexOf('>') + 1, sheetMarkup.lastIndexOf('</svg>'))
  .trim()
  .replace(/>\s+</g, '><')

/** The emblem's props, matching the harness `IconProps` the guide capsule hands it. */
export interface ContextIconProps {
  /** Square edge in px. */
  size?: number
  /** Extra class for layout placement. */
  className?: string
}

/** The colourful document sheet at the requested square edge. */
export function ContextIcon({ size = 20, className }: ContextIconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      className={className}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      dangerouslySetInnerHTML={{ __html: SHEET_MARKUP }}
    />
  )
}

/**
 * The tab chip's title seat (`sidebar.right.pane.tab.title`): the emblem before
 * the label, so the chip reads as the files chip does. The label comes from the
 * plugin's own bound translate — read at render, so the chip follows the active
 * locale — rather than the tab-information hook, which a foreign or
 * not-yet-committed tab record can throw on. It carries a trailing gutter
 * (`.lc-title-label`) so the active chip's fade lands past the text, never on
 * the last glyphs.
 * @param t - the plugin-namespace translate bound in `apply`.
 * @returns the title component to register under the tab type's id.
 */
export function makeContextTabTitle(t: Translate): () => ReactElement {
  return function ContextTabTitle(): ReactElement {
    return (
      <>
        <ContextIcon size={16} className="lc-title-icon" />
        <span className="lc-title-label">{t('tab')}</span>
      </>
    )
  }
}
