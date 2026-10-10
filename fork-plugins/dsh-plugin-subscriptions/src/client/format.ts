/**
 * Absolute-time formatting shared by the settings section and the reset-credit
 * row. The dictionary's `dateTime` template owns the field order and
 * separators: `Date#toLocaleString` follows the browser language instead of the
 * app locale, so a locale switch would leave mixed-language text behind.
 */
import type { SubscriptionsKey } from './locales.js'

/** Translate one key of this plugin's dictionary. */
export type SubscriptionsTranslate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/**
 * Format one instant as a local date and time.
 * @param t - Subscriptions dictionary translator.
 * @param at - Epoch milliseconds.
 * @returns The instant rendered through the dictionary's `dateTime` template.
 */
export function formatDateTime(t: SubscriptionsTranslate, at: number): string {
  const d = new Date(at)
  const pad2 = (value: number): string => String(value).padStart(2, '0')
  return t('dateTime', {
    y: d.getFullYear(),
    m: d.getMonth() + 1,
    d: d.getDate(),
    hh: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
  })
}
