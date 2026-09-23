/**
 * Generation-proof named imports from the ui-primitives platform module.
 *
 * The icon vocabulary renamed across the supported range — `Icon*Outline16` /
 * `Icon*Outline14` through 0.1.5, `Icon*OutlineRegular` / `Icon*OutlineMedium`
 * from 0.1.6 — and a renamed export arrives as `undefined` at runtime (the
 * pinned devDep's types cannot see the other generation), which rendered as
 * React error #130 inside the Context tab. Each icon here resolves through
 * BOTH spellings at module load, modern first; a render-nothing fallback keeps
 * a future rename a missing glyph instead of a crashed tab.
 */

import type { ReactElement } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** One platform icon component, as the call sites render it. */
export type IconComponent = (props: IconProps) => ReactElement | null

/** The platform module's export surface, read by name (the two vocabularies meet here). */
const ns = primitives as unknown as Record<string, unknown>

/**
 * Read one export through a bounded catch: partial module mocks (and any
 * hostile namespace) may throw on the property access itself, which must
 * degrade to "not this spelling", never crash the importer.
 */
function read(source: Record<string, unknown>, key: string): unknown {
  try {
    return source[key]
  } catch {
    return undefined
  }
}

/**
 * Resolve one icon across the range's two spellings: the modern
 * `…OutlineRegular`/`…OutlineMedium` name first, then the legacy
 * `…Outline16`/`…Outline14` one; neither present (or not a component)
 * renders nothing. `source` overrides the platform namespace for tests.
 */
export function resolveIcon(modern: string, legacy: string, source: Record<string, unknown> = ns): IconComponent {
  const found = read(source, modern) ?? read(source, legacy)
  return typeof found === 'function' ? found as IconComponent : () => null
}

export const IconBranch = resolveIcon('IconBranchOutlineRegular', 'IconBranchOutline16')
export const IconPlus = resolveIcon('IconPlusOutlineRegular', 'IconPlusOutline16')
export const IconCheck = resolveIcon('IconCheckOutlineRegular', 'IconCheckOutline16')
export const IconCopy = resolveIcon('IconCopyOutlineRegular', 'IconCopyOutline16')
export const IconClose = resolveIcon('IconCloseOutlineRegular', 'IconCloseOutline16')
export const IconSettings = resolveIcon('IconSettingsOutlineMedium', 'IconSettingsOutline14')
export const IconChevronDown = resolveIcon('IconChevronDownOutlineMedium', 'IconChevronDownOutline14')
