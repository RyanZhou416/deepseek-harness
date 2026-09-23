/**
 * BalanceCapsule — the DeepSeek open-platform balance pill in the Context
 * Dashboard's header (the plugin's one account-level figure, beside the
 * session-level ones). Clicking it opens the platform's usage console in a
 * new tab. Mounted only by the dashboard header; it paints the figure the
 * previous open remembered while client/balance.ts revalidates it in the
 * background, and renders NOTHING when nothing is remembered and the route
 * answers nothing — the pill exists only when there is a figure to show. The
 * non-zero parts of the breakdown (topped-up / granted) ride the harness
 * Tooltip primitive — immediate on hover, where a native `title` lags — in
 * the entry's own currency (the pill itself carries the total); the entry
 * follows the active locale (zh → CNY) with the account's first currency as
 * the fallback.
 */

import { useState, type ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { balanceEntryOf, readPlatformBalance } from '../balance'
import type { PlatformBalance } from '../../shared/types'
import type { ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'

/** The symbol prefix for the currencies the platform serves; others show their code. */
function symbolOf(currency: string): string {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  return currency + ' '
}

/** The platform console page behind the capsule's click — usage and top-ups. */
const USAGE_URL = 'https://platform.deepseek.com/usage'

export function makeBalanceCapsule(ctx: ClientCtx, kit: ViewKit): () => ReactElement | null {
  const { t } = kit
  return function BalanceCapsule(): ReactElement | null {
    // The remembered figure seeds the first paint (client/balance.ts) while the
    // background read runs; a landing figure re-renders through the callback.
    const [balance, setBalance] = useState<PlatformBalance | null>(() => readPlatformBalance((v) =>{  setBalance(v) }))
    const locale = ctx.locale
    const active = typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
    const entry = balanceEntryOf(balance, active === 'zh' ? 'cny' : 'usd')
    if (entry === null) return null
    const money = (amount: number): string => symbolOf(entry.currency) + amount.toFixed(2)
    // The pill itself carries the total; the tooltip lists only the non-zero
    // parts of the breakdown, and an all-zero account has nothing to break
    // down — the pill then rides bare.
    const tipLines = [
      ...(entry.toppedUp > 0 ? [t('balance.tip.toppedUp') + ': ' + money(entry.toppedUp)] : []),
      ...(entry.granted > 0 ? [t('balance.tip.granted') + ': ' + money(entry.granted)] : []),
    ]
    const pill = (
      <a
        className="lc-ov-balance"
        aria-label={tipLines.length > 0 ? tipLines.join('\n') : undefined}
        href={USAGE_URL}
        target="_blank"
        rel="noreferrer"
      >
        <span className="lc-ov-balance-label">{t('balance.title')}</span>
        <span className="lc-ov-balance-value">{money(entry.total)}</span>
      </a>
    )
    return tipLines.length > 0
      ? <Tooltip label={tipLines.join('\n')} side="bottom">{pill}</Tooltip>
      : pill
  }
}
