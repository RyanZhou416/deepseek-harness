/**
 * Subscription usage badge: a stats pill in the composer's dock
 * (`conversation.composer.dock`), modelled on the host's own token-usage
 * pill. Collapsed, it shows the rate-limit windows of the provider behind the
 * session's CURRENT model (a GPT model → Codex usage, a Claude model → Claude
 * usage); clicking it opens a trigger-anchored dialog listing every logged-in
 * account of every provider, with long window lists collapsed into previews,
 * the current provider first and the default account (starred) first within
 * a provider. Model-scoped Antigravity usage follows the current model.
 *
 * Everything on screen comes from the plugin application's shared cache
 * (`subscriptions-cache.ts`) and from the framework's own model-selection
 * seam: the session's resolved model arrives as a bare observable source from
 * `ctx.modelDirectories` through the inject `hooks` compartment, and the cache
 * supplies the roster and the usage entries. Nothing here polls — a read
 * happens on mount, on a model change, on a window focus, and when the panel
 * opens, and the panel's open state additionally re-renders the remaining-time
 * labels on a local tick that never reaches the network.
 *
 * Renders nothing when no provider has a logged-in account that reports usage.
 *
 * The collapsed pill reads only the default account — the same account
 * direct (non-pool) routes serve — so it stays one short segment even for a
 * provider with several accounts connected; the dialog shows them all.
 * Every color resolves through a `--dsw-*` design token and every
 * user-visible string goes through the locale `t` of the
 * 'settings.subscriptions' namespace.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { IconDataOutlineRegular, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { usageBarColor, usageCacheNote } from './SubscriptionsSection.js'
import { ResetCredits } from './ResetCredits.js'
import type { AccountStatus, ProviderStatus, ProviderUsage, SubscriptionProvider, UsageWindow } from './SubscriptionsSection.js'
import type { ModelRef } from './SpeedSelect.js'
import type {
  CachedUsage, ObservableSnapshot, StatusRead, SubscriptionsCacheState, UsageReadMode,
} from './subscriptions-cache.js'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

/**
 * Cadence of the panel's local countdown refresh. It only re-renders the
 * remaining-time labels of an open panel and never reads anything.
 */
const COUNTDOWN_TICK_MS = 60_000

/** Distance between the trigger's top edge and the dialog's bottom (host stat dialogs use the same). */
const PANEL_GAP = 8

/** Distance kept between the dialog and each viewport edge. */
const PANEL_MARGIN = 12

/** Injected dependencies (slot `inject`, session-bound). */
export interface SubscriptionUsageBadgeInjected {
  /** Connection RPC caller to reach the `subscriptions-auth` endpoints. */
  rpc: ConnectionHandle['rpc']
  /**
   * Read the shared cache's roster; newly listed accounts seed a local read.
   * @returns the roster, or the message the caller discards (the badge shows cached state only).
   */
  readStatus: () => Promise<StatusRead>
  /**
   * Read one account's usage.
   * @param provider - the account's provider.
   * @param account - the account key.
   * @param mode - local snapshot (default), if-needed refresh, or forced refresh.
   * @returns nothing once the read has started.
   */
  readUsage: (provider: SubscriptionProvider, account: string, mode?: UsageReadMode) => Promise<void>
  /**
   * Read every listed account of one provider.
   * @param provider - the provider whose accounts are read.
   * @param mode - read strength.
   * @returns nothing once every read has started.
   */
  readProvider: (provider: SubscriptionProvider, mode?: UsageReadMode) => Promise<void>
  /**
   * Read every listed account.
   * @param mode - read strength.
   * @returns nothing once every read has started.
   */
  readAll: (mode?: UsageReadMode) => Promise<void>
  /** Registrant hooks compartment: the shared cache and the session's model selection. */
  hooks: {
    usage: ObservableSnapshot<SubscriptionsCacheState>
    model: ObservableSnapshot<ModelRef | null>
  }
}

/** Props delivered by the slot outlet + inject + the locale seat. */
export type SubscriptionUsageBadgeProps =
  & InjectFace<SubscriptionUsageBadgeInjected>
  & Partial<PropsLocale<'settings.subscriptions'>>

/** One logged-in account's usage windows, as listed in the expanded dialog. */
interface AccountUsageDisplay {
  /** Account key (the `usage` endpoint's `account` argument). */
  key: string
  /** Display handle (email / login), when the provider reports one. */
  account?: string
  plan?: string
  /**
   * Short marker for a state that stops this account serving as it is (a
   * re-login requirement, a stated refusal, an unsupported protocol, a blocking
   * policy limit). Absent while the account's dimensions are nominal; the
   * Settings card owns detail.
   */
  notice?: BadgeNotice
  /** The account direct routes serve; the collapsed pill reads this one. */
  isDefault: boolean
  windows: UsageWindow[]
  /** ChatGPT banked reset credits, when the usage payload disclosed a count. */
  resetCredits?: number
  /** The account's cache entry, for the freshness line the dialog states. */
  entry?: CachedUsage
}

/** A dictionary key one account's badge marker renders. */
type BadgeNotice =
  | 'accountStateReauth'
  | 'accountStateCredentialMissing'
  | 'accountStateRefused'
  | 'accountStateProtocolUpgrade'
  | 'accountStatePolicyLimitsBlocked'

/**
 * The one marker an account's dimensions earn in the badge.
 *
 * The badge states only what takes the account out of service, because the
 * collapsed pill and the dialog share this line: a cooling window is already
 * visible as a percentage, while a dead sign-in is not. Settings owns the
 * full set of dimensions.
 * @param account - the account as answered by the `status` endpoint.
 * @returns the dictionary key to render, or undefined while the account serves.
 */
function usageNoticeOf(account: AccountStatus): BadgeNotice | undefined {
  if (account.credential.state === 'reauth_required') return 'accountStateReauth'
  if (account.credential.state === 'missing') return 'accountStateCredentialMissing'
  if (account.availability?.state === 'refused') return 'accountStateRefused'
  if (account.protocol?.state === 'upgrade_required') return 'accountStateProtocolUpgrade'
  if (account.policyLimits?.state === 'blocked') return 'accountStatePolicyLimitsBlocked'
  return undefined
}

/** One provider's usage snapshot: every logged-in account that reports windows. */
export interface ProviderUsageDisplay {
  provider: SubscriptionProvider
  name: string
  /** Default account first, then the rest in the `status` endpoint's order. */
  accounts: AccountUsageDisplay[]
}

/** The account the collapsed pill reads: the default one, else the first listed. */
function pillAccountOf(d: ProviderUsageDisplay): AccountUsageDisplay {
  return d.accounts.find(a => a.isDefault) ?? d.accounts[0]!
}

/** Brand display names (short form for the compact badge). */
const PROVIDER_NAMES: Record<SubscriptionProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  copilot: 'Copilot',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
}

/**
 * Fold the shared cache into the badge's provider list: every logged-in
 * account the cache holds an entry for — default account first, providers in
 * the roster's order.
 *
 * An entry with no windows is still listed: the node half's `missing` state
 * means "nothing read yet", not "no quota", and dropping the row would take
 * the pill (and with it the panel's refresh control) off screen exactly when
 * the user needs it. A retained payload survives a failed or stale
 * revalidation, so a provider whose quota read is failing keeps the windows it
 * last reported.
 * @param state - the shared cache snapshot.
 * @returns one entry per provider the cache holds usage state for.
 */
export function displaysOf(state: SubscriptionsCacheState): ProviderUsageDisplay[] {
  const byProvider = new Map<SubscriptionProvider, ProviderUsageDisplay>()
  for (const provider of Object.keys(state.status ?? {}) as SubscriptionProvider[]) {
    const status = state.status?.[provider]
    for (const account of accountsOf(status)) {
      const entry = state.usage[`${provider}:${account.key}`]
      if (entry === undefined) continue
      const usage: ProviderUsage | undefined = entry.usage
      if (usage?.supported === false) continue
      const windows = usage?.windows ?? []
      const plan = usage?.plan ?? account.plan
      const resetCredits = provider === 'codex' ? usage?.resetCredits?.availableCount : undefined
      const notice = usageNoticeOf(account)
      const row: AccountUsageDisplay = {
        key: account.key,
        isDefault: account.isDefault,
        ...account.account === undefined ? {} : { account: account.account },
        ...plan === undefined ? {} : { plan },
        ...notice === undefined ? {} : { notice },
        windows,
        ...resetCredits === undefined ? {} : { resetCredits },
        entry,
      }
      const display = byProvider.get(provider)
      if (display === undefined) byProvider.set(provider, { provider, name: PROVIDER_NAMES[provider], accounts: [row] })
      else display.accounts.push(row)
    }
  }
  return [...byProvider.values()]
}

/**
 * Compact time-remaining label derived from the window's `resetsAt` timestamp:
 * "6d18h" (days+hours), "1h58m" (hours+minutes), or "42m" (minutes only), shaped
 * by the dictionary's own unit templates. Falls back to the scope, or to the
 * localized scope/kind abbreviation when no reset time is known.
 * @param w - the reported window.
 * @param t - Subscriptions dictionary translator.
 * @returns the compact remaining-time or window-kind label.
 */
export function windowLabel(w: UsageWindow, t: Translate = fallbackTranslate): string {
  if (w.resetsAt === undefined) {
    if (w.scope !== undefined && w.scope !== '') return w.scope
    switch (w.kind) {
      case 'session': return t('usageBadgeSessionShort')
      case 'weekly': return t('usageBadgeWeeklyShort')
      default: return t('usageBadgeOtherShort')
    }
  }
  const ms = Math.max(0, w.resetsAt - Date.now())
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return t('usageBadgeRemainingDays', { days, hours: hours % 24 })
  if (hours > 0) return t('usageBadgeRemainingHours', { hours, minutes: minutes % 60 })
  return t('usageBadgeRemainingMinutes', { minutes: Math.max(1, minutes) })
}

/** Clamp and round a window's used share for display. */
function usedPercent(w: UsageWindow): number {
  return Math.round(Math.min(100, Math.max(0, w.usedPercent)))
}

/** Keep model quotas separate: matching percentages do not imply a shared pool. */
function prioritizeWindows(windows: readonly UsageWindow[], model?: string): UsageWindow[] {
  return model === undefined ? [...windows] : [
    ...windows.filter(w => w.scope === model),
    ...windows.filter(w => w.scope !== model),
  ]
}

/** Small previews keep a live model catalog from taking over the dialog. */
const WINDOW_PREVIEW_LIMIT = 4
export function previewWindows(windows: readonly UsageWindow[], model?: string) {
  const ordered = prioritizeWindows(windows, model)
  return { shown: ordered.slice(0, WINDOW_PREVIEW_LIMIT), hidden: ordered.slice(WINDOW_PREVIEW_LIMIT) }
}

/** Bounded readout; Antigravity quotas belong to individual models, not the account. */
export function compactSegment(d: ProviderUsageDisplay, model?: string, t: Translate = fallbackTranslate): string {
  const windows = pillAccountOf(d).windows
  if (d.provider === 'antigravity') {
    if (windows.length === 0) return `${d.name} ${t('usageBadgeNoData')}`
    const matching = model === undefined ? [] : windows.filter(w => w.scope === model)
    if (matching.length === 0) {
      return `${d.name} ${t(model === undefined ? 'usageBadgeModelCount' : 'usageBadgeModelUnavailable', {
        count: new Set(windows.map(w => w.scope).filter(Boolean)).size,
      })}`
    }
    const parts = matching.slice(0, 2).map(w => `${w.kind === 'weekly' ? t('usageWeekly') : t('usageWindow')} ${usedPercent(w)}%`)
    return `${d.name} ${parts.join(' · ')}`
  }
  const parts = windows.slice(0, 2).map(w => `${windowLabel(w, t)} ${usedPercent(w)}%`)
  if (windows.length === 0) parts.push(t('usageBadgeNoData'))
  else if (windows.length > 2) parts.push(`+${windows.length - 2}`)
  return `${d.name} ${parts.join(' · ')}`
}

/**
 * Pick what the collapsed pill shows: the current model's provider when its
 * usage is known, otherwise every provider (unknown model, a provider this
 * plugin does not serve, or a current provider with no usage to report).
 */
export function collapsedDisplays(
  displays: readonly ProviderUsageDisplay[],
  current: string | undefined,
): readonly ProviderUsageDisplay[] {
  const match = displays.find(d => d.provider === current)
  return match === undefined ? displays : [match]
}

/** Order for the expanded dialog: the current provider first, the rest in roster order. */
export function expandedDisplays(
  displays: readonly ProviderUsageDisplay[],
  current: string | undefined,
): readonly ProviderUsageDisplay[] {
  const match = displays.find(d => d.provider === current)
  return match === undefined ? displays : [match, ...displays.filter(d => d !== match)]
}

/**
 * A provider's logged-in accounts, the effective default first. When no
 * account is flagged default the first listed stands in, matching what
 * direct routes fall back to.
 */
function accountsOf(status: ProviderStatus | undefined): AccountStatus[] {
  if (status === undefined || status.accounts.length === 0) return []
  const fallback = status.accounts.find(a => a.isDefault) ?? status.accounts[0]!
  return status.accounts
    .map(a => (a === fallback ? { ...a, isDefault: true } : a))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

/** English-dictionary fallback for a missing inject `t` (standalone renders). */
function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  return en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** Localized label of one usage window (kind, plus the model scope when named). */
function usageWindowLabel(t: Translate, window: UsageWindow): string {
  const base = window.kind === 'session'
    ? t('usageSession')
    : window.kind === 'weekly' ? t('usageWeekly') : t('usageWindow')
  return window.scope !== undefined && window.scope !== '' ? `${base} · ${window.scope}` : base
}

/**
 * The composer subscription-usage badge: a pill reading e.g.
 * `Codex 6d1h 25%` for the current model's provider, opening a dialog with
 * every provider's accounts and their windows. Returns the bare dock seat when
 * no account reports usage.
 */
export function SubscriptionUsageBadge(props: SubscriptionUsageBadgeProps) {
  const { rpc, readStatus, readUsage, readProvider, readAll, useUsage, useModel } = props
  const translate: Translate = props.t ?? fallbackTranslate
  const cache = useUsage(snapshot => snapshot)
  const selection = useModel(value => value)
  const current = selection?.provider
  const [open, setOpen] = useState(false)
  const confirmLock = useRef(false)
  const setConfirmLock = (locked: boolean): void => { confirmLock.current = locked }
  const setPanelOpen = (value: boolean | ((prev: boolean) => boolean)): void => {
    setOpen((prev) => {
      const next = typeof value === 'function' ? value(prev) : value
      if (!next && confirmLock.current) return prev
      return next
    })
  }
  const [hover, setHover] = useState(false)
  /** Bumped by the open panel's local countdown tick; it never reads anything. */
  const [, setTick] = useState(0)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Always-rendered, invisible marker in the dock: locates the composer bar
  // (and the host stats row inside it) even while the pill itself is portaled.
  const seatRef = useRef<HTMLSpanElement | null>(null)
  // The inject face may be re-evaluated (new callback identities) on re-render;
  // the event effects read through these refs so identity churn re-runs nothing.
  const readStatusRef = useRef(readStatus)
  readStatusRef.current = readStatus
  const readUsageRef = useRef(readUsage)
  readUsageRef.current = readUsage
  const readProviderRef = useRef(readProvider)
  readProviderRef.current = readProvider
  const readAllRef = useRef(readAll)
  readAllRef.current = readAll
  /** Provider whose local snapshot the last model-change read covered. */
  const readProviderForRef = useRef<string | undefined>(undefined)

  const displays = useMemo(() => displaysOf(cache), [cache])

  // Mount: read the roster once. The cache seeds a local usage read for every
  // account it just learned about, so a first mount fills the pill without
  // asking the node half for a refresh.
  useEffect(() => {
    void readStatusRef.current()
  }, [])

  // A model switch re-reads the new provider's local snapshot once. The read
  // targets the provider the framework just published, so a switch can never
  // leave the pill showing the previous provider's numbers.
  useEffect(() => {
    if (current === undefined) return
    if (readProviderForRef.current === current) return
    readProviderForRef.current = current
    void readProviderRef.current(current as SubscriptionProvider, 'local')
  }, [current])

  // Focus and reconnect-adjacent events never refresh upstream: they re-read
  // the local snapshot, and duplicate events collapse into the reads already
  // running inside the cache.
  useEffect(() => {
    const onFocus = (): void => { void readAllRef.current('local') }
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener('focus', onFocus) }
  }, [])

  // The panel's remaining-time labels stay current while it is visible; this
  // tick renders only and never reaches the network.
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => { setTick(value => value + 1) }, COUNTDOWN_TICK_MS)
    return () => { clearInterval(timer) }
  }, [open])

  const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN })
  useDismissOnOutsidePointer(rootRef, open, setPanelOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
      if (confirmLock.current) return
      setOpen(false)
    }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  // Sit on the host's stats row when there is one. Every dock entry is its
  // own row in the composer bar, so a badge rendered in place lands under the
  // shipped time/token pills; the host marks its pill row with
  // `data-composer-stats`, and rendering into it makes the badge a third pill
  // on that line. The marker is watched (the row mounts only once the session
  // has steps or tokens, and unmounts with them) and older hosts without it
  // keep the in-place row.
  const [statsRow, setStatsRow] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const seat = seatRef.current
    if (seat === null) return
    const scope = statsScopeOf(seat)
    if (scope === null) return
    const find = (): HTMLElement | null => scope.querySelector<HTMLElement>('[data-composer-stats]')
    setStatsRow(find())
    const observer = new MutationObserver(() => { setStatsRow(find()) })
    observer.observe(scope, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])

  const seat = <span ref={seatRef} style={styles.seat} aria-hidden />

  if (displays.length === 0) return seat

  const collapsed = collapsedDisplays(displays, current)
  const label = collapsed.map(d => compactSegment(d, d.provider === current ? selection?.model : undefined, translate)).join(' | ')
  const expanded = expandedDisplays(displays, current)
  const title = translate('usageBadgeTitle')

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (!next) return
    // Opening shows what the cache already holds for every provider and asks
    // for a refreshed snapshot of the CURRENT provider only; every other
    // provider is refreshed from its own row's explicit control.
    void readAllRef.current('local')
    if (current !== undefined) void readProviderRef.current(current as SubscriptionProvider, 'if-needed')
  }

  const pill = (
    <span ref={rootRef} style={styles.anchor}>
      <button
        type="button"
        style={{ ...styles.pill, ...(hover || open ? styles.pillActive : {}) }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${title} · ${label}`}
        title={title}
        onMouseEnter={() => { setHover(true) }}
        onMouseLeave={() => { setHover(false) }}
        onClick={toggle}
      >
        <IconDataOutlineRegular />
        <span style={styles.label}>{label}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={title}
          style={{ ...styles.panel, ...(pos ?? MEASURE_STYLE) }}
        >
          <div style={styles.title}>
            <span style={styles.titleLabel}>
              <IconDataOutlineRegular />
              {title}
            </span>
          </div>
          <div style={styles.titleRule} aria-hidden />
          {expanded.map((d, index) => (
            <section key={d.provider} style={index === 0 ? undefined : styles.section}>
              <div style={styles.providerRow}>
                <span style={styles.providerName}>
                  {d.name}
                  {d.provider === current && <span style={styles.currentTag}>{translate('usageBadgeCurrent')}</span>}
                </span>
                {d.accounts.length === 1 && <AccountMeta account={d.accounts[0]!} translate={translate} />}
              </div>
              {d.accounts.map((account, accountIndex) => {
                const cacheNote = usageCacheNote(account.entry, translate)
                return (
                <div key={account.key} style={accountIndex === 0 ? undefined : styles.accountBlock}>
                  <div style={styles.accountRow}>
                    {d.accounts.length > 1 && <AccountMeta account={account} translate={translate} />}
                    <button
                      type="button"
                      style={{ ...styles.accountRefresh, marginLeft: 'auto' }}
                      disabled={cache.loading[`${d.provider}:${account.key}`] === true}
                      aria-label={translate('usageRefreshAccount', { account: account.account ?? account.key })}
                      onClick={() => { void readUsageRef.current(d.provider, account.key, 'force') }}
                    >
                      {translate('usageRefresh')}
                    </button>
                  </div>
                  <AccountWindows
                    key={`${d.provider}:${selection?.model ?? ''}`}
                    windows={account.windows}
                    model={d.provider === current ? selection?.model : undefined}
                    translate={translate}
                  />
                  {cacheNote !== undefined && <p style={styles.cacheNote}>{cacheNote}</p>}
                  {d.provider === 'codex' && account.resetCredits !== undefined && rpc !== undefined && (
                    <ResetCredits
                      rpc={rpc}
                      t={translate}
                      accountKey={account.key}
                      accountLabel={account.account ?? account.key}
                      availableCount={account.resetCredits}
                      onChanged={() => { void readUsageRef.current(d.provider, account.key, 'force') }}
                      onDialogChange={setConfirmLock}
                    />
                  )}
                </div>
                )
              })}
            </section>
          ))}
        </div>,
        document.body,
      )}
    </span>
  )

  return (
    <>
      {seat}
      {statsRow !== null && statsRow.isConnected ? createPortal(pill, statsRow) : pill}
    </>
  )
}

/**
 * Nearest ancestor of the dock seat that can contain the host's stats row:
 * the composer bar. Bounded so a badge in an unfamiliar layout never adopts
 * some other composer's pills.
 */
function statsScopeOf(seat: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = seat.parentElement
  for (let depth = 0; node !== null && depth < 4; depth++) {
    if (node.querySelector('[data-composer-stats]') !== null) return node
    node = node.parentElement
  }
  return seat.parentElement
}

/**
 * One account's handle and plan: `★ ys@example.com · 计划：pro`. The star
 * marks the default account (the one direct routes serve and the collapsed
 * pill reads), the same glyph Settings → 订阅 uses. A state that takes the
 * account out of service is appended as a short marker; the Settings card is
 * where its reason and recovery time are stated.
 */
function AccountMeta({ account, translate }: { account: AccountUsageDisplay; translate: Translate }) {
  const parts = [
    account.account,
    account.plan === undefined ? undefined : translate('usagePlan', { plan: account.plan }),
    account.notice === undefined ? undefined : translate(account.notice),
  ].filter((part): part is string => part !== undefined && part !== '')
  return (
    <span style={styles.providerMeta} title={account.account}>
      {account.isDefault && <span style={styles.defaultStar} aria-label={translate('defaultBadge')}>★ </span>}
      {parts.join(' · ')}
    </span>
  )
}

/** Preview each account independently; all remaining quotas stay accessible. */
export function AccountWindows({ windows, model, translate }: {
  windows: readonly UsageWindow[]; model: string | undefined; translate: Translate
}) {
  const { shown, hidden } = previewWindows(windows, model)
  const rows = (items: readonly UsageWindow[]) => (
    <dl style={styles.details}>
      {items.map((w, i) => (
        <WindowRow key={i} label={`${usageWindowLabel(translate, w)}${model !== undefined && w.scope === model ? ` · ${translate('usageBadgeCurrent')}` : ''}`} window={w} translate={translate} />
      ))}
    </dl>
  )
  return <>
    {rows(shown)}
    {hidden.length > 0 && <details style={styles.moreWindows}>
      <summary style={styles.moreSummary}>{translate('usageBadgeMoreWindows', { count: hidden.length })}</summary>
      {rows(hidden)}
    </details>}
  </>
}

/** One `dt`/`dd` pair: window name → `25% · 6d1h`, with the bar underneath. */
function WindowRow({ label, window: w, translate }: { label: string; window: UsageWindow; translate: Translate }) {
  const percent = usedPercent(w)
  return (
    <>
      <dt style={styles.dt}>{label}</dt>
      <dd style={styles.dd}>
        {percent}%
        {w.resetsAt !== undefined && <span style={styles.reset}> · {windowLabel(w, translate)}</span>}
      </dd>
      <div style={styles.bar} aria-hidden>
        <div style={{ ...styles.barFill, width: `${percent}%`, background: usageBarColor(percent) }} />
      </div>
    </>
  )
}

/**
 * Unplaced portal panel: hidden but laid out so the clamp measures real
 * dimensions (the `useAnchoredPosition` measure pass).
 */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

const styles: Record<string, CSSProperties> = {
  seat: { display: 'none' },
  anchor: { minWidth: 0, maxWidth: '100%', display: 'inline-flex' },
  // Mirrors the host StatsPills pill so the badge reads as a sibling of the
  // shipped time/token pills.
  pill: {
    boxSizing: 'border-box', maxWidth: '100%',
    color: 'var(--dsw-alias-label-tertiary)',
    font: 'inherit', fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
    fontVariantNumeric: 'tabular-nums', lineHeight: '20px', whiteSpace: 'nowrap',
    background: 'transparent', border: 'none', borderRadius: 24,
    alignItems: 'center', gap: 6, padding: '1px 8px', display: 'inline-flex', cursor: 'pointer',
  },
  pillActive: {
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-secondary)',
  },
  label: { textOverflow: 'ellipsis', minWidth: 0, overflow: 'hidden' },
  // Same skin as the host stat-dialog / context-meter panel: the menu fill is
  // translucent, and the blur is what keeps the chat from showing through.
  panel: {
    position: 'fixed', zIndex: 1100, boxSizing: 'border-box',
    background: 'var(--dsw-specific-menu)',
    backdropFilter: 'var(--dsw-menu-backdrop-filter)',
    width: 'max-content', minWidth: 'min(300px, 100vw - 24px)', maxWidth: 'min(440px, 100vw - 24px)',
    maxHeight: 'min(560px, 100dvh - 24px)', overflowY: 'auto', overscrollBehavior: 'contain',
    boxShadow: 'var(--dsw-elevation-prominent)',
    '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
    color: 'var(--dsw-alias-label-secondary)', cursor: 'default',
    border: 0, borderRadius: 12, padding: 16, fontSize: 12, lineHeight: '18px',
  } as CSSProperties,
  title: {
    color: 'var(--dsw-alias-label-primary)', display: 'flex',
    justifyContent: 'space-between', gap: 16, marginBottom: 8, fontWeight: 500,
  },
  titleLabel: { alignItems: 'center', gap: 6, minWidth: 0, display: 'inline-flex' },
  titleRule: { borderTop: '0.5px solid var(--dsw-alias-border-l2)', marginBottom: 10 },
  section: { marginTop: 12, paddingTop: 10, borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
  providerRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, marginBottom: 6,
  },
  providerName: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 },
  currentTag: {
    fontSize: 10, lineHeight: '14px', fontWeight: 400, padding: '0 5px', borderRadius: 7,
    color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  providerMeta: {
    color: 'var(--dsw-alias-label-tertiary)', minWidth: 0, overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  // Same star and color as the default-account marker in Settings → 订阅.
  defaultStar: { color: 'var(--dsw-alias-state-warn-label)' },
  accountBlock: { marginTop: 8 },
  accountRow: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 },
  // Plain text action so a per-account refresh reads as part of the row, not a button chrome.
  accountRefresh: {
    color: 'var(--dsw-alias-label-tertiary)', background: 'transparent', border: 'none',
    font: 'inherit', fontSize: 11, padding: 0, cursor: 'pointer',
  },
  cacheNote: { margin: '4px 0 0', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' },
  details: {
    color: 'var(--dsw-alias-label-tertiary)', display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) max-content', gap: '4px 16px', margin: 0,
  },
  moreWindows: { marginTop: 8 },
  moreSummary: { cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 },
  dt: { minWidth: 0, margin: 0, overflowWrap: 'anywhere' },
  dd: {
    minWidth: 0, margin: 0, color: 'var(--dsw-alias-label-secondary)',
    fontVariantNumeric: 'tabular-nums', textAlign: 'right',
  },
  reset: { color: 'var(--dsw-alias-label-tertiary)' },
  bar: {
    gridColumn: '1 / -1', height: 4, borderRadius: 2, overflow: 'hidden',
    background: 'var(--dsw-alias-border-l2)', marginBottom: 2,
  },
  barFill: { height: '100%', borderRadius: 2 },
}
