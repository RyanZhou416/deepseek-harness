/**
 * Subscriptions settings section: one card per subscription provider with an
 * OAuth login/logout flow driven by the node half's `/subscriptions-auth` RPC
 * channel. Login state lives server-side; the page polls `status` only while
 * a login attempt is busy, so an idle page never polls. The provider roster
 * and every account's usage come from the plugin application's shared cache
 * (`subscriptions-cache.ts`), which the composer badge reads too: this page
 * asks for a local snapshot on mount and only an explicit Refresh asks the
 * node half for a refreshed one.
 *
 * Every color resolves through a `--dsw-alias-*` design token (the ui-theme
 * design-platform.css values flip under `body[data-ds-dark-theme]`), and
 * every user-visible string goes through the locale-bound `t` of the
 * 'settings.subscriptions' namespace. Buttons and inputs take the
 * ModelsSection vocabulary minus hover rules, which inline styles cannot
 * express.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, Dispatch, SetStateAction } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { en } from './locales.js'
import { formatDateTime } from './format.js'
import { ProviderAccountManager } from './ProviderAccountManager.js'
import { ResetCredits } from './ResetCredits.js'
import type { SubscriptionsKey } from './locales.js'

import { callSubscriptionsAuth, SubscriptionsAuthError } from './subscriptions-rpc.js'
export { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { errorLine, withActionError, withPollError } from './provider-errors.js'
import type { ProviderErrorState } from './provider-errors.js'
import type {
  CachedUsage, ObservableSnapshot, StatusRead, StatusRoster, SubscriptionsCacheState, UsageReadMode,
} from './subscriptions-cache.js'

/** Poll cadence while a provider login attempt is busy. */
const POLL_INTERVAL_MS = 2000

/** Subscription provider ids, fixed by the node half's OAuth adapters. */
export type SubscriptionProvider = 'codex' | 'claude' | 'grok' | 'copilot' | 'antigravity' | 'cursor'

/** One logged-in account as answered by the `status` endpoint. */
export interface AccountStatus {
  key: string
  account?: string
  expiresAt?: number
  plan?: string
  isDefault: boolean
}

/** One provider's login state as answered by the `status` endpoint. */
export interface ProviderStatus {
  busy: boolean
  accounts: AccountStatus[]
  detail?: string
}

/** One rate-limit window as answered by the `usage` endpoint. */
export interface UsageWindow {
  kind: 'session' | 'weekly' | 'other'
  scope?: string
  usedPercent: number
  resetsAt?: number
}

/** One unified rate-limit window as reported by the `usage` endpoint. */
interface RateLimitWindow {
  window: string
  utilization?: number
  resetsAt?: number
  surpassedThreshold?: number
}

/** The account's captured `anthropic-ratelimit-unified-*` report. */
export interface RateLimitReport {
  status: 'allowed' | 'allowed_warning' | 'rejected' | 'other'
  resetsAt?: number
  claim?: string
  fallbackAvailable?: boolean
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected' | 'other'
  overageResetsAt?: number
  overageDisabledReason?: string
  overageInUse?: boolean
  overageScope?: string
  windows: RateLimitWindow[]
  observedAt: number
}

/** The account pool's view of one account, present only while the pool is enabled. */
export interface PoolReport {
  coolingReason?: 'auth' | 'quota'
  coolingUntil?: number
  peerAvailable: boolean
}

/**
 * Cache state the node half reports beside a usage snapshot.
 *
 * `missing` is not zero percent and not "unsupported": nothing has been read
 * for this account yet. `stale` and `error` carry the last known windows, and
 * `retryAt` is the instant the node half's cooldown lets a forced read run.
 */
export interface UsageCacheMetadata {
  state: 'fresh' | 'stale' | 'missing' | 'error' | 'refreshing'
  /** Instant the reported values were observed, on the node half's clock. */
  observedAt?: number
  /** Earliest instant a forced read is accepted again. */
  retryAt?: number
  /** Coded reason of an `error` state (never raw provider text). */
  error?: string
}

/** `usage` endpoint value: the node half owns this shape. */
export interface ProviderUsage {
  supported: boolean
  windows?: UsageWindow[]
  plan?: string
  /** Present only when the usage payload disclosed a reset-credit count. */
  resetCredits?: { availableCount: number }
  /** The account's last answered request's unified rate-limit report, when captured. */
  rateLimit?: RateLimitReport
  /** The account pool's view of this account, when the pool is enabled. */
  pool?: PoolReport
  /** Freshness of this snapshot, when the node half reports one. */
  cache?: UsageCacheMetadata
}

/** `proxyGet` endpoint value: the node half owns this shape (no secrets). */
export interface ProxyConfigView {
  enabled: boolean
  url: string
  username?: string
  passwordSet: boolean
  bypass: string[]
  error?: string
}

/** `proxyTest` endpoint value. */
export interface ProxyTestResult {
  ok: boolean
  viaProxy: boolean
  status?: number
  latencyMs?: number
  error?: string
}

/** `login` endpoint value: the URL the user completes OAuth at. */
interface LoginResponse {
  authorizeUrl: string
  /** Device-flow providers (copilot): the code the user types at authorizeUrl. */
  userCode?: string
}

/** Injected dependencies of {@link SubscriptionsSection} (slot `inject`). */
export interface SubscriptionsSectionInjected {
  /** Generic logical-RPC caller over the Connection transport. */
  rpc: ConnectionHandle['rpc']
  /** Section copy: translate a 'settings.subscriptions' key with `{name}` template params. */
  t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string
  /**
   * Read the shared cache's roster.
   * @param options - `fresh` starts an independent read instead of folding into one already running.
   * @returns the roster, or the message the caller renders.
   */
  readStatus: (options?: { fresh?: boolean }) => Promise<StatusRead>
  /**
   * Read one account's usage from the shared cache.
   * @param provider - the account's provider.
   * @param account - the account key.
   * @param mode - local snapshot (default), if-needed refresh, or forced refresh.
   * @returns nothing once the read has started.
   */
  readUsage: (provider: SubscriptionProvider, account: string, mode?: UsageReadMode) => Promise<void>
  /** Registrant hooks compartment: the shared cache source, bound to `useUsage`. */
  hooks: { usage: ObservableSnapshot<SubscriptionsCacheState> }
}

/**
 * Props delivered by the slot outlet: the inject face with its hooks
 * compartment bound (`useUsage` is the framework's own seat and is always
 * present), and the optional members standalone renders may omit.
 */
export type SubscriptionsSectionProps =
  & Partial<Pick<SubscriptionsSectionInjected, 'rpc' | 't'>>
  & Required<Pick<SubscriptionsSectionInjected, 'readStatus' | 'readUsage'>>
  & Pick<InjectFace<SubscriptionsSectionInjected>, 'useUsage'>

/** Card display metadata, in page order (names are brand names, not translated). */
const PROVIDERS: readonly { id: SubscriptionProvider; name: string }[] = [
  { id: 'codex', name: 'Codex (ChatGPT)' },
  { id: 'claude', name: 'Claude' },
  { id: 'grok', name: 'Grok (X Premium)' },
  { id: 'copilot', name: 'GitHub Copilot' },
  { id: 'antigravity', name: 'Google Antigravity' },
  { id: 'cursor', name: 'Cursor' },
]

/** Human text of an action failure, SubscriptionsAuthError or not. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Copy a per-provider map without one provider's entry.
 * @param map - the per-provider map, possibly absent for `key`.
 * @param key - the provider whose entry is dropped.
 * @returns the same map when it had no entry, otherwise a copy without it.
 */
function dropKey<T>(
  map: Partial<Record<SubscriptionProvider, T>>,
  key: SubscriptionProvider,
): Partial<Record<SubscriptionProvider, T>> {
  if (map[key] === undefined) return map
  const next = { ...map }
  delete next[key]
  return next
}

/**
 * English-dictionary fallback for a missing inject `t` (standalone renders);
 * the slot inject always supplies the locale-bound one.
 * @param key - dictionary key.
 * @param params - `{name}` template params.
 * @returns the template with params substituted.
 */
function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

const styles: Record<string, CSSProperties> = {
  section: {
    display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560,
    color: 'var(--dsw-alias-label-primary)',
  },
  intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, lineHeight: '22px' },
  card: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
  },
  proxyCard: {
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
  },
  separator: { borderTop: '1px solid var(--dsw-alias-border-l2)' },
  cardHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  name: { fontWeight: 500, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
  statusLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  errorLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
  actions: { display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' },
  button: {
    boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    height: 28, padding: '0 10px', borderRadius: 14,
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12, lineHeight: '18px',
    cursor: 'pointer',
  },
  usage: {
    display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4,
    borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8,
  },
  usageHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  usageTitle: { fontSize: 12, lineHeight: '18px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' },
  usagePlan: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  usageRefresh: {
    boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    height: 22, padding: '0 8px', borderRadius: 11, marginLeft: 'auto',
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 12, lineHeight: '18px',
    cursor: 'pointer',
  },
  usageRow: { display: 'flex', flexDirection: 'column', gap: 3 },
  usageMeta: {
    display: 'flex', justifyContent: 'space-between', gap: 8,
    fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
  },
  accountRow: {
    display: 'flex', flexDirection: 'column', gap: 6,
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '8px 10px', marginTop: 4,
  },
  accountHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  accountName: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', userSelect: 'all' },
  starButton: {
    border: 'none', background: 'transparent', padding: 0,
    font: 'inherit', fontSize: 14, lineHeight: '20px', cursor: 'pointer',
    color: 'var(--dsw-alias-state-warn-label)',
  },
  usageTrack: {
    height: 6, borderRadius: 3, overflow: 'hidden',
    background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
  },
  usageFill: { height: '100%', borderRadius: 3 },
  deviceCode: {
    marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6,
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '10px 12px', background: 'var(--dsw-alias-bg-layer-1)',
  },
  deviceCodeText: {
    fontFamily: 'monospace', fontSize: 18, lineHeight: '24px', letterSpacing: 2,
    color: 'var(--dsw-alias-label-primary)', userSelect: 'all',
  },
  manualSteps: { margin: 0, padding: 0, listStylePosition: 'inside' },
  authorizeUrl: {
    fontFamily: 'monospace', fontSize: 12, lineHeight: '18px', wordBreak: 'break-all',
    color: 'var(--dsw-alias-label-primary)', userSelect: 'all',
  },
  manual: { marginTop: 4, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
  manualRow: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 },
  manualInput: {
    height: 32, flex: 1, minWidth: 0, boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '0 10px', font: 'inherit', fontSize: 14, lineHeight: '22px',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  },
  proxyField: { display: 'flex', flexDirection: 'column', gap: 4 },
  proxyLabel: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
  proxyInput: {
    height: 32, width: '100%', boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '0 10px', font: 'inherit', fontSize: 14, lineHeight: '22px',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  },
  proxyHint: {
    margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
  },
  proxyCheck: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
  },
  proxyMessage: { margin: 0, fontSize: 12, lineHeight: '18px' },
  proxyActions: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 2 },
  modalOverlay: {
    position: 'fixed', inset: 0, zIndex: 1000,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    background: 'rgba(0, 0, 0, 0.45)',
  },
  modal: {
    width: 460, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto',
    boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12,
    padding: '16px 18px', borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
  },
  modalHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  modalTitle: { fontWeight: 600, fontSize: 15, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
}

/** Status dot color for one provider state. */
function dotColor(status: ProviderStatus | undefined): string {
  if (status?.busy === true) return 'var(--dsw-alias-state-warn-label)'
  if ((status?.accounts.length ?? 0) > 0) return 'var(--dsw-alias-state-success-primary)'
  return 'var(--dsw-alias-label-dimmed)'
}

/**
 * Whether a provider has at least one connected account. Multi-account made
 * "logged in" a property of the account list rather than a flag, so every
 * logged-in test goes through this one predicate.
 * @param status - the provider's last reported state, possibly absent.
 * @returns true when the provider serves at least one account.
 */
function hasAccount(status: ProviderStatus | undefined): boolean {
  return (status?.accounts.length ?? 0) > 0
}

/**
 * One-line status text for one provider state.
 * @param t - section translate.
 * @param status - the provider's last reported state.
 * @returns the localized status line.
 */
function statusText(t: SubscriptionsSectionInjected['t'], status: ProviderStatus | undefined): string {
  if (status === undefined) return t('checking')
  if (status.busy) return t('loginInProgress')
  if (status.accounts.length > 0) return t('loggedInCount', { count: status.accounts.length })
  return t('notLoggedIn')
}

/**
 * Localized label of one usage window (kind, plus the model scope when named).
 * @param t - section translate.
 * @param window - the reported window.
 * @returns e.g. "5-hour window" or "Weekly · Opus".
 */
function usageWindowLabel(t: SubscriptionsSectionInjected['t'], window: UsageWindow): string {
  const base = window.kind === 'session'
    ? t('usageSession')
    : window.kind === 'weekly' ? t('usageWeekly') : t('usageWindow')
  return window.scope !== undefined && window.scope !== '' ? `${base} · ${window.scope}` : base
}

/** Bar fill color: success normally, warn from 80%, error from 95%. Shared with the composer badge. */
export function usageBarColor(usedPercent: number): string {
  if (usedPercent >= 95) return 'var(--dsw-alias-state-error-primary)'
  if (usedPercent >= 80) return 'var(--dsw-alias-state-warn-label)'
  return 'var(--dsw-alias-state-success-primary)'
}

/**
 * Localized freshness line of one cached usage entry: when the values were
 * observed, whether the node half kept a stale value, has none yet, failed its
 * last revalidation, or is refreshing now, plus the instant a forced read may
 * be tried again.
 *
 * The line states the cache's own state, so a `missing` account never reads as
 * "zero percent" and a failed revalidation never hides the quotas that are
 * still on screen.
 * @param entry - the account's cache entry, or undefined before any read.
 * @param t - section translate.
 * @returns the line, or undefined when the entry carries nothing to state.
 */
export function usageCacheNote(
  entry: CachedUsage | undefined,
  t: SubscriptionsSectionInjected['t'],
): string | undefined {
  if (entry === undefined) return undefined
  const now = Date.now()
  const parts: string[] = []
  const metadata = entry.usage?.cache
  // Only the node half's own observation time is stated. A local read time would
  // read as "updated just now" for values the Host never refreshed.
  if (metadata?.observedAt !== undefined) {
    parts.push(t('usageCacheUpdated', { date: formatDateTime(t, metadata.observedAt) }))
  }
  switch (metadata?.state) {
    case 'stale': parts.push(t('usageCacheStale')); break
    case 'missing': parts.push(t('usageCacheMissing')); break
    case 'error':
      parts.push(metadata.error === undefined
        ? t('usageCacheFailedNoReason')
        : t('usageCacheFailed', { message: metadata.error }))
      break
    case 'refreshing': parts.push(t('usageCacheRefreshing')); break
    case 'fresh':
    case undefined: break
  }
  if (metadata?.retryAt !== undefined && metadata.retryAt > now) {
    parts.push(t('usageCacheRetry', { date: formatDateTime(t, metadata.retryAt) }))
  }
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/**
 * The fact one account's red usage line states.
 *
 * `limit` and `near` come from the reported window percentages, `rejected` and
 * `warning` from the provider's unified rate-limit status, `relogin` from a
 * stored login the pool found dead, and `cooldown` and `overage` from the
 * account pool working around this account.
 */
type UsageAlertKind = 'limit' | 'near' | 'rejected' | 'warning' | 'relogin' | 'cooldown' | 'overage'

/** What one account's card states about its usage. */
interface UsageAlert {
  /** The fact the line states. */
  kind: UsageAlertKind
  /**
   * `account` when the fact is about this account alone; `pool` when this
   * account is out and another pool member is serving in its place. The
   * distinction is the difference between "you are blocked" and "we routed
   * around a cooling account".
   */
  attribution: 'account' | 'pool'
  /** Latest disclosed instant still ahead of the clock at which the state clears. */
  resetsAt?: number
}

/** A disclosed instant, kept only while it is still ahead of the clock. */
function pendingInstant(at: number | undefined, now: number): { resetsAt?: number } {
  return at === undefined || at <= now ? {} : { resetsAt: at }
}

/**
 * Whether an account's reported usage puts it out of service.
 *
 * Contract: the header state outranks the percentage state, because the
 * provider's own `rejected` verdict is more specific than a window percentage
 * that may have been read minutes earlier. A dead login is always attributed
 * to the account: no routing decision clears it. A near-limit `allowed_warning`
 * status is an account fact too — it proves only that this account is close to
 * its limit, which routing around it does not change. Overage is always
 * attributed to the pool and only reported when a peer can serve, because the
 * account itself is still answering.
 *
 * The percentage rule is unchanged from the reported windows: a window counts
 * as full at `usedPercent >= 100` for Codex and Claude, which spend a window
 * all the way down, and at `usedPercent >= 95` for every other provider — the
 * per-provider rule the pool's availability check applies
 * (`CONSUMABLE_QUOTA_FULL_PERCENT` / `QUOTA_FULL_PERCENT`). Absent or empty
 * windows, and every window below its threshold, report no alert.
 * @param provider - the provider that reported the windows.
 * @param windows - the account's reported windows, or undefined while unknown.
 * @param rateLimit - the account's captured unified rate-limit report, when any.
 * @param pool - the pool's view of this account, when the pool is enabled.
 * @returns the out-of-service state, or undefined while the account can serve.
 */
export function usageAlert(
  provider: SubscriptionProvider,
  windows: readonly UsageWindow[] | undefined,
  rateLimit?: RateLimitReport,
  pool?: PoolReport,
): UsageAlert | undefined {
  const now = Date.now()
  const routed = pool?.peerAvailable === true
  if (pool?.coolingReason === 'auth') {
    return { kind: 'relogin', attribution: 'account', ...pendingInstant(pool.coolingUntil, now) }
  }
  if (rateLimit !== undefined) {
    const rejected = rateLimit.status === 'rejected' || rateLimit.overageStatus === 'rejected'
    if (rejected) {
      return {
        kind: 'rejected',
        attribution: routed ? 'pool' : 'account',
        ...pendingInstant(rateLimit.resetsAt ?? rateLimit.overageResetsAt, now),
      }
    }
    if (rateLimit.overageInUse === true) {
      // Paid overage is a routing observation: with no peer the account serves
      // fine, so there is nothing to warn about.
      return routed
        ? { kind: 'overage', attribution: 'pool', ...pendingInstant(rateLimit.overageResetsAt, now) }
        : undefined
    }
    if (rateLimit.status === 'allowed_warning') {
      // A near-limit warning stays an account fact: the status only says the
      // account is close to its limit, which routing around it does not change.
      return {
        kind: 'warning',
        attribution: 'account',
        ...pendingInstant(rateLimit.resetsAt, now),
      }
    }
  }
  if (pool?.coolingUntil !== undefined && pool.coolingUntil > now) {
    return { kind: 'cooldown', attribution: routed ? 'pool' : 'account', resetsAt: pool.coolingUntil }
  }
  if (windows === undefined) return undefined
  const fullAt = provider === 'codex' || provider === 'claude' ? 100 : 95
  const full = windows.filter(window => window.usedPercent >= fullAt)
  if (full.length === 0) return undefined
  const resets = full
    .map(window => window.resetsAt)
    .filter((at): at is number => at !== undefined && at > now)
  return {
    kind: full.some(window => window.usedPercent >= 100) ? 'limit' : 'near',
    attribution: routed ? 'pool' : 'account',
    ...resets.length === 0 ? {} : { resetsAt: Math.max(...resets) },
  }
}

/**
 * The locale key stating one alert. Account-level facts name what is wrong with
 * this account; pool-level facts name that another account is serving instead.
 * @param alert - the alert derived by {@link usageAlert}.
 * @returns the key of the line to render.
 */
export function usageAlertKey(alert: UsageAlert): SubscriptionsKey {
  if (alert.attribution === 'pool') return alert.kind === 'overage' ? 'usagePoolOverage' : 'usagePoolCooling'
  switch (alert.kind) {
    case 'relogin': return 'usageAccountRelogin'
    case 'rejected': return 'usageAccountRejected'
    case 'near':
    case 'warning': return 'usageNearlyExhausted'
    case 'limit':
    case 'cooldown': return 'usageLimitReached'
    case 'overage': return 'usagePoolOverage'
  }
}

/** One-line status text of the proxy config card. */
function proxyStatusText(
  t: SubscriptionsSectionInjected['t'],
  proxy: ProxyConfigView | undefined,
  loadError: string | undefined,
): string {
  if (loadError !== undefined) return t('proxyLoadFailed', { message: loadError })
  if (proxy === undefined) return t('proxyLoading')
  if (proxy.error !== undefined) return t('proxyStatusError', { message: proxy.error })
  if (proxy.enabled) return t('proxyStatusEnabled', { url: proxy.url })
  return t('proxyStatusNone')
}

/** Feedback-line color of the proxy dialog. */
function messageColor(tone: 'success' | 'error'): string {
  return tone === 'error'
    ? 'var(--dsw-alias-state-error-primary)'
    : 'var(--dsw-alias-state-success-primary)'
}

/**
 * The Subscriptions settings page component.
 * @param props - the slot inject face ({@link SubscriptionsSectionInjected}).
 * @returns the section body, or a notice while the RPC face is absent.
 */
export function SubscriptionsSection(props: SubscriptionsSectionProps) {
  const { rpc, readStatus, readUsage, useUsage } = props
  const t = props.t ?? fallbackTranslate
  /** The shared cache snapshot: the roster and every account's usage entry. */
  const cache = useUsage(snapshot => snapshot)
  const [statuses, setStatuses] = useState<StatusRoster>({})
  /** Error lines per provider: a failed poll and a failed action, kept apart (see provider-errors.ts). */
  const [errorLines, setErrorLines] = useState<ProviderErrorState>({})
  const [manualDrafts, setManualDrafts] = useState<Record<SubscriptionProvider, string>>({
    codex: '', claude: '', grok: '', copilot: '', antigravity: '', cursor: '',
  })
  /** Pending device-flow codes (copilot), shown while the attempt polls. */
  const [deviceCodes, setDeviceCodes] = useState<Partial<Record<SubscriptionProvider, { userCode: string; verificationUrl: string }>>>({})
  /** Pending cross-device authorize links (Claude manual login), shown while the attempt polls. */
  const [authorizeUrls, setAuthorizeUrls] = useState<Partial<Record<SubscriptionProvider, string>>>({})
  const [copiedCode, setCopiedCode] = useState<SubscriptionProvider | undefined>(undefined)
  const [copiedUrl, setCopiedUrl] = useState<SubscriptionProvider | undefined>(undefined)
  const mountedRef = useRef(true)
  const pollersRef = useRef(new Map<SubscriptionProvider, ReturnType<typeof setInterval>>())
  /** Proxy config as last answered by `proxyGet`/`proxySet`. */
  const [proxy, setProxy] = useState<ProxyConfigView | undefined>(undefined)
  const [proxyLoadError, setProxyLoadError] = useState<string | undefined>(undefined)
  /** Proxy dialog state (draft fields; the password never pre-fills). */
  const [proxyOpen, setProxyOpen] = useState(false)
  const [managedProvider, setManagedProvider] = useState<{ id: SubscriptionProvider; name: string }>()
  const [proxyEnabled, setProxyEnabled] = useState(false)
  const [proxyUrl, setProxyUrl] = useState('')
  const [proxyUsername, setProxyUsername] = useState('')
  const [proxyPassword, setProxyPassword] = useState('')
  const [proxyClearPassword, setProxyClearPassword] = useState(false)
  const [proxyBypass, setProxyBypass] = useState('')
  const [proxySaving, setProxySaving] = useState(false)
  const [proxyTesting, setProxyTesting] = useState(false)
  const [proxyMessage, setProxyMessage] = useState<{ tone: 'success' | 'error'; text: string } | undefined>(undefined)
  const [proxyTestResult, setProxyTestResult] = useState<ProxyTestResult | undefined>(undefined)
  const setProviderError = useCallback((provider: SubscriptionProvider, message: string | undefined): void => {
    if (!mountedRef.current) return
    setErrorLines(prev => withPollError(prev, provider, message))
  }, [])

  /**
   * Report an action's own failure. It is kept in its own line, so the `status`
   * refresh the action runs afterwards cannot erase the message before the user
   * reads it; the next action on that provider clears it.
   */
  const setActionError = useCallback((provider: SubscriptionProvider, message: string | undefined): void => {
    if (!mountedRef.current) return
    setErrorLines(prev => withActionError(prev, provider, message))
  }, [])

  const stopPolling = useCallback((provider: SubscriptionProvider): void => {
    const poller = pollersRef.current.get(provider)
    if (poller !== undefined) {
      clearInterval(poller)
      pollersRef.current.delete(provider)
    }
  }, [])

  /**
   * Refetch every provider's status through the shared cache; stop a
   * provider's poller once its attempt settles.
   * @param fresh - start an independent read (a user action) instead of folding into one already running.
   */
  const refresh = useCallback(async (fresh = false): Promise<void> => {
    if (rpc === undefined) return
    const response = await readStatus({ fresh })
    if (!mountedRef.current) return
    if (!response.ok) {
      // A failed poll must not kill the page; busy providers keep polling and
      // the action paths report their own errors. But staying silent turns a
      // persistent failure into an endless "Checking…" — show it instead.
      for (const { id } of PROVIDERS) setProviderError(id, response.message)
      return
    }
    setStatuses(response.providers)
    // The poll recovered: drop any error line a previous failed poll left.
    for (const { id } of PROVIDERS) setProviderError(id, undefined)
    for (const { id } of PROVIDERS) {
      const status = response.providers[id]
      if (status === undefined || status.accounts.length > 0 || !status.busy) {
        stopPolling(id)
        // The attempt settled (success, timeout, or cancel): drop the code and
        // authorize-link cards.
        setDeviceCodes(prev => dropKey(prev, id))
        setAuthorizeUrls(prev => dropKey(prev, id))
      }
    }
  }, [rpc, readStatus, stopPolling, setProviderError])

  const startPolling = useCallback((provider: SubscriptionProvider): void => {
    if (pollersRef.current.has(provider)) return
    pollersRef.current.set(provider, setInterval(() => { void refresh() }, POLL_INTERVAL_MS))
  }, [refresh])

  // Initial load; every busy provider (e.g. an attempt started before a page
  // reload) resumes polling. Teardown clears pollers and the mounted guard.
  useEffect(() => {
    mountedRef.current = true
    void refresh().then(() => {
      if (!mountedRef.current) return
      setStatuses((current) => {
        for (const { id } of PROVIDERS) {
          if (current[id]?.busy === true) startPolling(id)
        }
        return current
      })
    })
    return () => {
      mountedRef.current = false
      for (const poller of pollersRef.current.values()) clearInterval(poller)
      pollersRef.current.clear()
    }
  }, [refresh, startPolling])

  /**
   * Read one account's usage through the shared cache. `force` is the explicit
   * Refresh control's mode; every other path reads the local snapshot only.
   */
  const loadUsage = useCallback((provider: SubscriptionProvider, account: string, mode: UsageReadMode = 'local'): void => {
    if (rpc === undefined) return
    void readUsage(provider, account, mode)
  }, [rpc, readUsage])

  const login = useCallback(async (provider: SubscriptionProvider, method?: 'oauth' | 'keychain' | 'manual'): Promise<void> => {
    if (rpc === undefined) return
    setActionError(provider, undefined)
    try {
      const response = await callSubscriptionsAuth<LoginResponse>(rpc, 'login', {
        provider,
        ...method === undefined ? {} : { method },
      })
      if (typeof response.authorizeUrl === 'string' && response.authorizeUrl === '') {
        // Instant login (e.g. imported from Claude Code credentials)
        await refresh(true)
        return
      }
      if (typeof response.authorizeUrl !== 'string') {
        throw new SubscriptionsAuthError(t('loginMissingUrl'))
      }
      if (!mountedRef.current) return
      // Optimistic busy so Cancel and the manual fallback appear before the first poll tick.
      setStatuses(prev => ({
        ...prev,
        [provider]: { accounts: prev[provider]?.accounts ?? [], ...prev[provider], busy: true },
      }))
      if (method === 'manual') {
        // Cross-device: no listener waits here and the provider's page shows the
        // code, so the link is offered for the other device instead of opened.
        setAuthorizeUrls(prev => ({ ...prev, [provider]: response.authorizeUrl }))
      } else if (typeof response.userCode === 'string' && response.userCode.length > 0) {
        // Device flow: show the code card instead of opening the page blind —
        // the user copies the code first, then opens the verification page.
        setDeviceCodes(prev => ({ ...prev, [provider]: { userCode: response.userCode as string, verificationUrl: response.authorizeUrl } }))
      } else {
        window.open(response.authorizeUrl, '_blank', 'noopener')
      }
      startPolling(provider)
    } catch (error) {
      setActionError(provider, messageOf(error))
    }
  }, [rpc, t, setActionError, startPolling])

  const cancel = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined) return
    stopPolling(provider)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'cancel', { provider })
    } catch (error) {
      setActionError(provider, messageOf(error))
    }
    await refresh(true)
  }, [rpc, stopPolling, setActionError, refresh])

  const submitManual = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined) return
    const input = manualDrafts[provider].trim()
    if (input === '') return
    setActionError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'manual', { provider, input })
      if (mountedRef.current) setManualDrafts(prev => ({ ...prev, [provider]: '' }))
    } catch (error) {
      setActionError(provider, messageOf(error))
    }
    await refresh(true)
  }, [rpc, manualDrafts, setActionError, refresh])

  const logout = useCallback(async (provider: SubscriptionProvider, account: string, display: string, name: string): Promise<void> => {
    if (rpc === undefined) return
    if (!window.confirm(t('logoutAccountConfirm', { provider: name, account: display }))) return
    setActionError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'logout', { provider, account })
    } catch (error) {
      setActionError(provider, messageOf(error))
    }
    await refresh(true)
  }, [rpc, t, setActionError, refresh])

  const setDefault = useCallback(async (provider: SubscriptionProvider, account: string): Promise<void> => {
    if (rpc === undefined) return
    setActionError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'setDefault', { provider, account })
    } catch (error) {
      setActionError(provider, messageOf(error))
    }
    await refresh(true)
  }, [rpc, setActionError, refresh])

  /**
   * Copy one card's code or link and flag that card as copied for 1.5s.
   * @param provider - the provider card whose copy button was pressed.
   * @param text - the code or link to place on the clipboard.
   * @param setFlag - the copied-provider state setter of that button.
   */
  const copyForProvider = useCallback((
    provider: SubscriptionProvider,
    text: string,
    setFlag: Dispatch<SetStateAction<SubscriptionProvider | undefined>>,
  ): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      if (!mountedRef.current) return
      setFlag(provider)
      setTimeout(() => {
        if (mountedRef.current) {
          setFlag(current => current === provider ? undefined : current)
        }
      }, 1500)
    }).catch(() => undefined)
  }, [])

  // Proxy configuration: load once on mount; the dialog drives proxySet/proxyTest.
  useEffect(() => {
    if (rpc === undefined) return
    let alive = true
    void callSubscriptionsAuth<ProxyConfigView>(rpc, 'proxyGet', {}).then((view) => {
      if (!alive) return
      setProxy(view)
      setProxyLoadError(undefined)
    }).catch((error) => {
      if (alive) setProxyLoadError(messageOf(error))
    })
    return () => { alive = false }
  }, [rpc])

  useEffect(() => {
    if (!proxyOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setProxyOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [proxyOpen])

  const openProxyDialog = useCallback((): void => {
    if (proxy === undefined) return
    setProxyEnabled(proxy.enabled)
    setProxyUrl(proxy.url)
    setProxyUsername(proxy.username ?? '')
    setProxyPassword('')
    setProxyClearPassword(false)
    setProxyBypass(proxy.bypass.join(', '))
    setProxyMessage(undefined)
    setProxyTestResult(undefined)
    setProxyOpen(true)
  }, [proxy])

  const saveProxy = useCallback(async (): Promise<void> => {
    if (rpc === undefined) return
    setProxySaving(true)
    setProxyMessage(undefined)
    try {
      const view = await callSubscriptionsAuth<ProxyConfigView>(rpc, 'proxySet', {
        enabled: proxyEnabled,
        url: proxyUrl.trim(),
        username: proxyUsername,
        ...proxyClearPassword ? { password: null } : proxyPassword !== '' ? { password: proxyPassword } : {},
        bypass: proxyBypass.split(/[,\n]/).map(entry => entry.trim()).filter(entry => entry !== ''),
      })
      setProxy(view)
      setProxyLoadError(undefined)
      setProxyMessage({ tone: 'success', text: t('proxySaved') })
      setProxyOpen(false)
    } catch (error) {
      setProxyMessage({ tone: 'error', text: t('proxySaveFailed', { message: messageOf(error) }) })
    } finally {
      setProxySaving(false)
    }
  }, [rpc, proxyEnabled, proxyUrl, proxyUsername, proxyPassword, proxyClearPassword, proxyBypass, t])

  const testProxy = useCallback(async (): Promise<void> => {
    if (rpc === undefined || proxyTesting) return
    setProxyTesting(true)
    setProxyTestResult(undefined)
    try {
      // Test the dialog's current inputs (they do not need to be saved first);
      // the host builds a throwaway agent for the probe.
      setProxyTestResult(await callSubscriptionsAuth<ProxyTestResult>(rpc, 'proxyTest', {
        proxy: {
          url: proxyUrl.trim(),
          ...proxyUsername.trim() !== '' ? { username: proxyUsername.trim() } : {},
          ...proxyPassword !== '' ? { password: proxyPassword } : {},
        },
      }))
    } catch (error) {
      setProxyTestResult({ ok: false, viaProxy: false, error: messageOf(error) })
    } finally {
      setProxyTesting(false)
    }
  }, [rpc, proxyTesting, proxyUrl, proxyUsername, proxyPassword])

  if (rpc === undefined) {
    return <p style={styles.intro}>{t('unavailable')}</p>
  }

  return (
    <div style={styles.section}>
      <p style={styles.intro}>{t('intro')}</p>
      <div style={styles.proxyCard}>
        <div style={styles.cardHeader}>
          <span style={{
            ...styles.dot,
            background: proxy?.enabled === true
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-label-dimmed)',
          }} />
          <span style={styles.name}>{t('proxyTitle')}</span>
          <button
            type="button"
            style={{ ...styles.button, marginLeft: 'auto', flexShrink: 0 }}
            onClick={openProxyDialog}
          >
            {t('proxyConfigure')}
          </button>
        </div>
        <p style={styles.statusLine}>{proxyStatusText(t, proxy, proxyLoadError)}</p>
      </div>
      <div style={styles.separator} />
      {PROVIDERS.map(({ id, name }) => {
        const status = statuses[id]
        const busy = status?.busy === true
        const deviceCode = deviceCodes[id]
        const authorizeUrl = authorizeUrls[id]
        const accounts = status?.accounts ?? []
        const error = errorLine(errorLines, id)
        return (
          <div key={id} style={styles.card}>
            <div style={styles.cardHeader}>
              <span style={{ ...styles.dot, background: dotColor(status) }} />
              <span style={styles.name}>{name}</span>
            </div>
            <p style={styles.statusLine}>{statusText(t, status)}</p>
            {status?.detail !== undefined && status.detail !== '' && (
              <p style={styles.statusLine}>{status.detail}</p>
            )}
            {error !== undefined && <p style={styles.errorLine}>{error}</p>}
            {accounts.map((account) => {
              const usageKey = `${id}:${account.key}`
              const entry = cache.usage[usageKey]
              const usage = entry?.usage
              const usageError = entry?.error
              const usageBusy = cache.loading[usageKey] === true
              const display = account.account ?? account.key
              // Providers without a usage endpoint answer supported:false — no block.
              // The block also appears while the account's first local read runs,
              // so a listed account never renders without its usage region.
              const showUsage = usage?.supported !== false && (entry !== undefined || usageBusy)
              const alert = usageAlert(id, usage?.windows, usage?.rateLimit, usage?.pool)
              const cacheNote = usageCacheNote(entry, t)
              return (
                <div key={account.key} style={styles.accountRow}>
                  <div style={styles.accountHeader}>
                    <button
                      type="button"
                      style={styles.starButton}
                      title={account.isDefault ? t('defaultBadge') : t('setDefault')}
                      onClick={() => {
                        if (!account.isDefault) void setDefault(id, account.key)
                      }}
                    >
                      {account.isDefault ? '★' : '☆'}
                    </button>
                    <span style={styles.accountName}>{display}</span>
                    {account.plan !== undefined && (
                      <span style={styles.usagePlan}>{account.plan}</span>
                    )}
                    {account.expiresAt !== undefined && (
                      <span style={styles.statusLine}>
                        {t('accountExpires', { date: formatDateTime(t, account.expiresAt) })}
                      </span>
                    )}
                    <button
                      type="button"
                      style={{ ...styles.button, marginLeft: 'auto', flexShrink: 0 }}
                      onClick={() => { void logout(id, account.key, display, name) }}
                    >
                      {t('logout')}
                    </button>
                  </div>
                  {showUsage && (
                    <div style={styles.usage}>
                      <div style={styles.usageHeader}>
                        <span style={styles.usageTitle}>{t('usageTitle')}</span>
                        {usage?.plan !== undefined && (
                          <span style={styles.usagePlan}>{t('usagePlan', { plan: usage.plan })}</span>
                        )}
                        <button
                          type="button"
                          style={{ ...styles.usageRefresh, ...usageBusy ? { opacity: 0.5, cursor: 'default' } : {} }}
                          disabled={usageBusy}
                          aria-label={t('usageRefreshAccount', { account: display })}
                          onClick={() => { loadUsage(id, account.key, 'force') }}
                        >
                          {t('usageRefresh')}
                        </button>
                      </div>
                      {alert !== undefined && (
                        <p style={styles.errorLine}>
                          {t(usageAlertKey(alert))}
                          {alert.resetsAt !== undefined
                            && ` · ${t('usageResets', { date: formatDateTime(t, alert.resetsAt) })}`}
                        </p>
                      )}
                      {usageError !== undefined && (
                        <p style={styles.errorLine}>{t('usageError', { message: usageError })}</p>
                      )}
                      {usage === undefined && usageError === undefined && (
                        <p style={styles.statusLine}>{t('usageLoading')}</p>
                      )}
                      {usage?.windows !== undefined && usage.windows.length === 0 && usage.cache?.state !== 'missing' && (
                        <p style={styles.statusLine}>{t('usageEmpty')}</p>
                      )}
                      {(usage?.windows ?? []).map((window, index) => {
                        const percent = Math.min(100, Math.max(0, window.usedPercent))
                        return (
                          <div key={index} style={styles.usageRow}>
                            <div style={styles.usageMeta}>
                              <span>{usageWindowLabel(t, window)}</span>
                              <span>
                                {`${String(Math.round(percent))}%`}
                                {window.resetsAt !== undefined
                                  && ` · ${t('usageResets', { date: formatDateTime(t, window.resetsAt) })}`}
                              </span>
                            </div>
                            <div style={styles.usageTrack}>
                              <div style={{ ...styles.usageFill, width: `${String(percent)}%`, background: usageBarColor(percent) }} />
                            </div>
                          </div>
                        )
                      })}
                      {cacheNote !== undefined && <p style={styles.statusLine}>{cacheNote}</p>}
                      {id === 'codex' && usage?.resetCredits !== undefined && (
                        <ResetCredits
                          rpc={rpc}
                          t={t}
                          accountKey={account.key}
                          accountLabel={display}
                          availableCount={usage.resetCredits.availableCount}
                          onChanged={() => { loadUsage(id, account.key, 'force') }}
                        />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            <div style={styles.actions}>
              {!busy && accounts.length === 0 && (
                <button type="button" style={styles.button} onClick={() => { void login(id) }}>
                  {t('login')}
                </button>
              )}
              {!busy && accounts.length === 0 && id === 'claude' && (
                <button type="button" style={styles.button} onClick={() => { void login(id, 'manual') }}>
                  {t('addAccountOtherDevice')}
                </button>
              )}
              {!busy && accounts.length > 0 && id === 'claude' && (
                <>
                  <button type="button" style={styles.button} onClick={() => { void login(id, 'oauth') }}>
                    {t('addAccountOAuth')}
                  </button>
                  <button type="button" style={styles.button} onClick={() => { void login(id, 'manual') }}>
                    {t('addAccountOtherDevice')}
                  </button>
                  <button type="button" style={styles.button} onClick={() => { void login(id, 'keychain') }}>
                    {t('addAccountKeychain')}
                  </button>
                </>
              )}
              {!busy && accounts.length > 0 && id !== 'claude' && (
                <button type="button" style={styles.button} onClick={() => { void login(id) }}>
                  {t('addAccount')}
                </button>
              )}
              <button type="button" style={styles.button} aria-haspopup="dialog"
                onClick={() => setManagedProvider({ id, name })}>
                {t('accountsManage')}
              </button>
              {busy && (
                <button type="button" style={styles.button} onClick={() => { void cancel(id) }}>
                  {t('cancel')}
                </button>
              )}
            </div>
            {!busy && accounts.length > 0 && (
              <p style={styles.statusLine}>{t('addAccountHint')}</p>
            )}

            {busy && deviceCode !== undefined && (
              <div style={styles.deviceCode}>
                <span style={styles.statusLine}>{t('deviceCodePrompt')}</span>
                <span style={styles.deviceCodeText}>{deviceCode.userCode}</span>
                <div style={styles.actions}>
                  <button type="button" style={styles.button} onClick={() => { copyForProvider(id, deviceCode.userCode, setCopiedCode) }}>
                    {copiedCode === id ? t('deviceCodeCopied') : t('deviceCodeCopy')}
                  </button>
                  <button
                    type="button"
                    style={styles.button}
                    onClick={() => { window.open(deviceCode.verificationUrl, '_blank', 'noopener') }}
                  >
                    {t('deviceCodeOpenPage')}
                  </button>
                </div>
              </div>
            )}
            {busy && authorizeUrl !== undefined && (
              <div style={styles.deviceCode}>
                <ol style={styles.manualSteps}>
                  <li style={styles.statusLine}>{t('otherDeviceStepOpen')}</li>
                  <li style={styles.statusLine}>{t('otherDeviceStepApprove')}</li>
                  <li style={styles.statusLine}>{t('otherDeviceStepPaste')}</li>
                </ol>
                <span style={styles.authorizeUrl}>{authorizeUrl}</span>
                <div style={styles.actions}>
                  <button type="button" style={styles.button} onClick={() => { copyForProvider(id, authorizeUrl, setCopiedUrl) }}>
                    {copiedUrl === id ? t('otherDeviceLinkCopied') : t('otherDeviceCopyLink')}
                  </button>
                </div>
              </div>
            )}
            {busy && deviceCode === undefined && (
              <details style={styles.manual}>
                <summary>{t('manualSummary')}</summary>
                <div style={styles.manualRow}>
                  <input
                    style={styles.manualInput}
                    value={manualDrafts[id]}
                    placeholder={t('manualPlaceholder')}
                    onChange={event => setManualDrafts(prev => ({ ...prev, [id]: event.target.value }))}
                  />
                  <button type="button" style={styles.button} onClick={() => { void submitManual(id) }}>
                    {t('submit')}
                  </button>
                </div>
              </details>
            )}
          </div>
        )
      })}
      {managedProvider && <ProviderAccountManager provider={managedProvider.id} name={managedProvider.name}
        rpc={rpc} t={t} onClose={() => setManagedProvider(undefined)} />}
      {proxyOpen && (
        <div style={styles.modalOverlay} onClick={() => setProxyOpen(false)}>
          <div style={styles.modal} onClick={event => event.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>{t('proxyDialogTitle')}</span>
              <button type="button" style={{ ...styles.button, marginLeft: 'auto' }} onClick={() => setProxyOpen(false)}>
                {t('proxyDialogClose')}
              </button>
            </div>
            <label style={styles.proxyCheck}>
              <input type="checkbox" checked={proxyEnabled} onChange={event => setProxyEnabled(event.target.checked)} />
              <span>{t('proxyEnabled')}</span>
            </label>
            <label style={styles.proxyField}>
              <span style={styles.proxyLabel}>{t('proxyUrl')}</span>
              <input
                style={styles.proxyInput}
                value={proxyUrl}
                placeholder={t('proxyUrlPlaceholder')}
                onChange={event => setProxyUrl(event.target.value)}
              />
              <p style={styles.proxyHint}>{t('proxyUrlHint')}</p>
            </label>
            <label style={styles.proxyField}>
              <span style={styles.proxyLabel}>{t('proxyUsername')}</span>
              <input
                style={styles.proxyInput}
                value={proxyUsername}
                placeholder={t('proxyUsernamePlaceholder')}
                onChange={event => setProxyUsername(event.target.value)}
              />
            </label>
            <div style={styles.proxyField}>
              <span style={styles.proxyLabel}>{t('proxyPassword')}</span>
              <input
                type="password"
                style={styles.proxyInput}
                value={proxyPassword}
                placeholder={t('proxyPasswordPlaceholder')}
                onChange={event => setProxyPassword(event.target.value)}
              />
              <label style={styles.proxyCheck}>
                <input
                  type="checkbox"
                  checked={proxyClearPassword}
                  onChange={event => setProxyClearPassword(event.target.checked)}
                />
                <span>{t('proxyClearPassword')}</span>
              </label>
            </div>
            <label style={styles.proxyField}>
              <span style={styles.proxyLabel}>{t('proxyBypass')}</span>
              <input
                style={styles.proxyInput}
                value={proxyBypass}
                placeholder={t('proxyBypassPlaceholder')}
                onChange={event => setProxyBypass(event.target.value)}
              />
              <p style={styles.proxyHint}>{t('proxyBypassHint')}</p>
            </label>
            <p style={styles.proxyHint}>{t('proxyNote')}</p>
            {proxyMessage !== undefined && (
              <p style={{ ...styles.proxyMessage, color: messageColor(proxyMessage.tone) }}>{proxyMessage.text}</p>
            )}
            {proxyTestResult !== undefined && (
              <p style={{
                ...styles.proxyMessage,
                color: proxyTestResult.ok
                  ? 'var(--dsw-alias-state-success-primary)'
                  : 'var(--dsw-alias-state-error-primary)',
              }}>
                {proxyTestResult.ok
                  ? (proxyTestResult.viaProxy
                    ? t('proxyTestOk', { status: String(proxyTestResult.status), ms: String(proxyTestResult.latencyMs) })
                    : t('proxyTestOkDirect', { status: String(proxyTestResult.status), ms: String(proxyTestResult.latencyMs) }))
                  : t('proxyTestFail', { message: proxyTestResult.error ?? '' })}
              </p>
            )}
            <div style={styles.proxyActions}>
              <button
                type="button"
                style={{ ...styles.button, ...proxyTesting ? { opacity: 0.5, cursor: 'default' } : {} }}
                disabled={proxyTesting}
                onClick={() => { void testProxy() }}
              >
                {proxyTesting ? t('proxyTesting') : t('proxyTest')}
              </button>
              <button
                type="button"
                style={{ ...styles.button, ...proxySaving ? { opacity: 0.5, cursor: 'default' } : {} }}
                disabled={proxySaving}
                onClick={() => { void saveProxy() }}
              >
                {proxySaving ? t('proxySaving') : t('proxySave')}
              </button>
              <button type="button" style={styles.button} onClick={() => setProxyOpen(false)}>
                {t('proxyCancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
