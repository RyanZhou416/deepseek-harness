/**
 * Speed row: one row inside the composer's model menu
 * (`conversation.input.model.row`, the additive child of the model seat), opening
 * the two tiers in place, switching the session's current model between standard
 * routing and the fast tier. Codex uses its priority service tier; Cursor sends the
 * catalog `fast` parameter; Claude sends the catalogue's `speed` field. The choice is
 * stored per provider model in the node half (durable, alongside the per-model effort
 * defaults); this component holds only viewing state. The row renders nothing until
 * the current model advertises a fast tier, which is also what keeps the composer's
 * separate control gone: the setting lives here, in the menu that selects the model.
 *
 * Every color resolves through a `--dsw-alias-*` design token and every
 * user-visible string goes through the locale `t` of the
 * 'settings.subscriptions' namespace, same as the settings section.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { IconCheckOutlineRegular, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { callSubscriptionsAuth } from './SubscriptionsSection.js'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

/** One model's speed choice: standard routing or the fast (priority) tier. */
export type SpeedTier = 'standard' | 'fast'

/** `speed` endpoint value, mirrored from the node half. */
export interface SpeedState {
  tier: SpeedTier
  fastModels: string[]
}

/** What {@link SpeedSelect} renders from: visibility plus the current tier. */
export interface SpeedSelectState {
  visible: boolean
  tier: SpeedTier
}

/**
 * The speed state this control watches, and the choice generation its reads belong to.
 *
 * The poll's read and the user's choice are both asynchronous, and the read is the slower of the
 * two (it asks the node half to enumerate the fast-capable models and the host for the session's
 * current model). A read that started before a choice can therefore settle after it, and
 * publishing that result would put the tier the user just replaced back on screen.
 */
export interface SpeedView {
  /** Choices this control has settled; a read carries the value it started under. */
  generation: number
  /** The last state this control published, or null until the first read settles. */
  state: SpeedSelectState | null
}

/** The view before anything has been read or chosen. */
const INITIAL_SPEED_VIEW: SpeedView = { generation: 0, state: null }

/**
 * Fold one settled host read into the view, unless a choice has superseded it.
 *
 * Dropping the superseded read is what keeps a settled choice on screen: the tier in it is the
 * one the choice replaced, so publishing it would show the setting reverting on its own until the
 * next poll corrected it.
 * @param view - the view the read settles into.
 * @param read - the generation the read was started under.
 * @param state - the state the read returned.
 * @returns the updated view, or the same view when the read is stale.
 */
export function settleRead(view: SpeedView, read: number, state: SpeedSelectState): SpeedView {
  return read === view.generation ? { ...view, state } : view
}

/**
 * Fold one settled choice into the view, superseding every read started before it.
 *
 * The choice is stated directly rather than re-read: a successful write is the authoritative
 * answer, and a fresh read would take another round trip to say the same thing.
 * @param view - the view the choice settles into.
 * @param tier - the tier the write accepted.
 * @returns the updated view at the next generation.
 */
export function settleChoice(view: SpeedView, tier: SpeedTier): SpeedView {
  return { generation: view.generation + 1, state: { visible: true, tier } }
}

/**
 * Minimal structural face of ui-model-selection's `ctx.modelDirectories`
 * service (the sanctioned cross-plugin channel: cordis services, not value
 * imports — same mirroring discipline as ToolCallOwnerProps). Both dsh lines
 * ship it with this shape; it replaces rc.2's `connection.api.sessions.models`
 * read, which the 0.1.2-alpha removed along with the whole `.api` face.
 */
export interface ModelDirectoriesLike {
  /** Resolve one session's shared model directory (throws for unknown sessions). */
  directoryFor(sessionId: string): {
    /** Load the directory; `current` is the session's effective model selection. */
    load(): Promise<{ current: { provider: string; model: string } | null }>
  }
}

/** Injected dependencies of {@link SpeedSelect} (slot `inject`, session-bound). */
export interface SpeedSelectInjected {
  /** Load the current model's speed state; `visible` false keeps the control hidden. */
  loadSpeed: () => Promise<SpeedSelectState>
  /** Store the current model's speed tier; resolves false when the write failed. */
  setSpeed: (tier: SpeedTier) => Promise<boolean>
}

/**
 * Props delivered by the slot outlet: the framework session kit and the model
 * seat's row owner share (unused — everything arrives session-bound through the
 * inject face), the injected callbacks, and the locale seat.
 */
export type SpeedSelectProps = PropsRuntime<'conversation.input.model.row'>
  & Partial<SpeedSelectInjected>
  & Partial<PropsLocale<'settings.subscriptions'>>

/**
 * Providers whose sessions can select the fast tier: the three whose routes carry a per-model
 * fast capability. The list is the visibility gate's provider half, and the model half is the
 * node half's own fast-capable listing.
 */
const FAST_TIER_PROVIDERS: ReadonlySet<string> = new Set(['codex', 'cursor', 'claude'])

/**
 * Whether the Speed control belongs on screen for the session's current model.
 *
 * The gate has two halves: the model's route must be one whose requests carry a fast tier, and
 * the node half must list that exact model id as fast-capable. A session with no model selection
 * has nothing to switch.
 * @param current - the session's effective model selection, or null when it has none.
 * @param fastModels - the node half's fast-capable model ids.
 * @returns true when the control should render.
 */
export function speedControlVisible(
  current: { provider: string; model: string } | null,
  fastModels: readonly string[],
): boolean {
  return current !== null
    && FAST_TIER_PROVIDERS.has(current.provider)
    && fastModels.includes(current.model)
}

/**
 * The `loadSpeed` half of the inject face: the session's current model and the
 * tier stored for it, plus the node half's fast-capable listing (the visibility
 * gate). A model-RPC failure throws rather than answering "hidden" — the caller
 * keeps its last known state, so a transient failure never locks the toggle
 * away.
 *
 * `sessionId` is a plain string: slot and command contexts brand it through
 * different dsh-session copies, and only the service boundary needs one.
 *
 * `models` resolves lazily per call: the ui-model-selection service may
 * register after this plugin applies, and a shell without it (no model seat
 * at all) simply keeps the toggle hidden.
 */
export function createSpeedLoader(
  rpc: ConnectionHandle['rpc'],
  models: () => ModelDirectoriesLike | undefined,
  sessionId: string,
): SpeedSelectInjected['loadSpeed'] {
  return async () => {
    const directories = models()
    if (directories === undefined) return { visible: false, tier: 'standard' }
    const { current } = await directories.directoryFor(sessionId).load()
    if (current === null) return { visible: false, tier: 'standard' }
    const state = await callSubscriptionsAuth<SpeedState>(rpc, 'speed', {
      provider: current.provider,
      model: current.model,
    })
    return { visible: speedControlVisible(current, state.fastModels), tier: state.tier }
  }
}

/** The `setSpeed` half of the inject face: boolean outcome for the component's busy state. */
export function createSpeedSetter(
  rpc: ConnectionHandle['rpc'],
  models: () => ModelDirectoriesLike | undefined,
  sessionId: string,
): SpeedSelectInjected['setSpeed'] {
  return async (tier) => {
    try {
      const directories = models()
      if (directories === undefined) return false
      const { current } = await directories.directoryFor(sessionId).load()
      if (current === null) return false
      await callSubscriptionsAuth(rpc, 'setSpeed', { provider: current.provider, model: current.model, tier })
      return true
    } catch {
      // Both failure sources — resolving the session's model, and the write
      // itself — are reported as a failed settlement, which is what the
      // control renders. A rejection would leave its busy state stuck.
      return false
    }
  }
}

/**
 * Settle one picked tier against the session. A false answer fails the call
 * with the dictionary's failure copy, which is how an entry point that owns no
 * notice surface of its own states the failure: the `/fast` popup renders
 * through the shell's error strip, while the composer control shows the same
 * copy in place.
 * @param setSpeed - the current model's setter.
 * @param tier - the picked tier.
 * @param t - Subscriptions dictionary translator.
 * @returns nothing once the write takes effect.
 * @throws Error carrying `speedSaveFailed` when the write fails.
 */
export async function settleSpeedTier(
  setSpeed: SpeedSelectInjected['setSpeed'],
  tier: SpeedTier,
  t: (key: SubscriptionsKey) => string,
): Promise<void> {
  if (!await setSpeed(tier)) throw new Error(t('speedSaveFailed'))
}

/** English-dictionary fallback for a missing inject `t` (standalone renders). */
function fallbackTranslate(key: SubscriptionsKey): string {
  return en[key]
}

const TIERS: readonly SpeedTier[] = ['standard', 'fast']

/** How often the row re-reads the host state (model switches arrive only by asking). */
const POLL_INTERVAL_MS = 3000

/**
 * The model menu's Speed row: a cell reading `速度` and the current tier, opening
 * the two tiers in place (standard/fast with descriptions, a check on the current
 * one). The cell keeps the shape of the seat's own root cells — label, current
 * value, chevron — so the row reads as one of them. The host pushes nothing on a
 * model switch, so the row re-reads on a slow poll with a single-flight guard; a
 * failed read keeps the last known state, so a transient RPC failure can never
 * lock the choice away. Every read is stamped with the choice generation it
 * started under, and {@link settleRead} drops one that a later choice superseded.
 */
export function SpeedSelect({ loadSpeed, setSpeed, t }: SpeedSelectProps) {
  const translate = t ?? fallbackTranslate
  const [view, setView] = useState<SpeedView>(INITIAL_SPEED_VIEW)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // The inject face may be re-evaluated (new callback identities) on re-render;
  // the poll effect mounts once and reads through this ref, so identity churn
  // neither resets the interval nor multiplies in-flight loads.
  const loadRef = useRef(loadSpeed)
  loadRef.current = loadSpeed
  // The generation a read is stamped with. Mirrored from the view because the effect below mounts
  // once and stamps a read when it starts, not when it settles.
  const generationRef = useRef(view.generation)
  generationRef.current = view.generation

  useEffect(() => {
    if (loadRef.current === undefined) return
    let cancelled = false
    let inflight = false
    const reload = (): void => {
      const load = loadRef.current
      if (load === undefined || inflight) return
      inflight = true
      const read = generationRef.current
      void load().then(
        (loaded) => { if (!cancelled) setView(current => settleRead(current, read, loaded)) },
        () => { /* keep the last known state; the next tick retries */ },
      ).finally(() => { inflight = false })
    }
    reload()
    const timer = setInterval(reload, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  const state = view.state
  if (loadSpeed === undefined || setSpeed === undefined || state === null || !state.visible) {
    return null
  }

  const choose = (tier: SpeedTier): void => {
    if (busy) return
    if (tier === state.tier) {
      setOpen(false)
      return
    }
    setBusy(true)
    setFailed(false)
    void setSpeed(tier).then((ok) => {
      setBusy(false)
      if (ok) {
        setView(current => settleChoice(current, tier))
        setOpen(false)
        return
      }
      // The menu stays open with the failure in place, so the tier remains
      // reachable for a retry without reopening the control.
      setFailed(true)
    })
  }

  const show = (): void => {
    setFailed(false)
    setOpen(true)
    const load = loadRef.current
    if (load === undefined) return
    const read = generationRef.current
    void load().then(
      loaded => { setView(current => settleRead(current, read, loaded)) },
      () => { /* keep showing the last good state */ },
    )
  }

  const tierName = (tier: SpeedTier): string =>
    translate(tier === 'fast' ? 'speedFast' : 'speedStandard')
  const tierDescription = (tier: SpeedTier): string =>
    translate(tier === 'fast' ? 'speedFastDescription' : 'speedStandardDescription')
  const cellAria = `${translate('speed')} · ${tierName(state.tier)}`

  return (
    <div
      ref={rootRef}
      style={styles.root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          setOpen(false)
        }
      }}
    >
      <button
        type="button"
        role="menuitem"
        style={styles.cell}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={cellAria}
        title={cellAria}
        disabled={busy}
        onClick={() => {
          if (open) setOpen(false)
          else show()
        }}
      >
        <span style={styles.cellLabel}>{translate('speed')}</span>
        <span style={styles.cellValue}>{tierName(state.tier)}</span>
        <span style={{ ...styles.cellChevron, ...(open ? styles.cellChevronOpen : {}) }}>
          <IconChevronRightOutlineRegular size={12} />
        </span>
      </button>
      {open && (
        <div style={styles.options} role="menu" aria-label={translate('speed')}>
          {failed && <p role="alert" style={styles.error}>{translate('speedSaveFailed')}</p>}
          {TIERS.map(tier => (
            <button
              key={tier}
              type="button"
              role="menuitemradio"
              aria-checked={tier === state.tier}
              style={styles.option}
              disabled={busy}
              onClick={() => { choose(tier) }}
            >
              <span style={styles.optionText}>
                <span style={styles.optionName}>{tierName(tier)}</span>
                <span style={styles.optionDescription}>{tierDescription(tier)}</span>
              </span>
              <span style={styles.optionCheck}>{tier === state.tier ? <IconCheckOutlineRegular size={14} /> : null}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Row metrics mirror ui-model-selection's ModelSelect cells (`.cell`, `.option`):
 * this row renders inside that menu card, between the seat's own rows.
 */
const styles: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column' },
  cell: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 6,
    width: 'auto', minWidth: '100%', height: 34, padding: '0 8px',
    border: 'none', borderRadius: 8, background: 'transparent',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit',
    fontSize: 13, lineHeight: '20px', textAlign: 'left', cursor: 'pointer',
  },
  cellLabel: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', whiteSpace: 'nowrap' },
  cellValue: {
    flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap', textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)',
  },
  cellChevron: {
    display: 'inline-flex', flex: '0 0 auto', color: 'var(--dsw-alias-label-tertiary)',
    transition: 'transform 120ms ease',
  },
  cellChevronOpen: { transform: 'rotate(90deg)' },
  options: { display: 'flex', flexDirection: 'column' },
  option: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 6,
    width: 'auto', minWidth: '100%', minHeight: 34, padding: '5px 7px',
    border: 'none', borderRadius: 8, background: 'transparent',
    color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
  },
  optionText: { display: 'flex', flex: '1', flexDirection: 'column', minWidth: 0 },
  optionName: { fontSize: 13, lineHeight: '18px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
  optionDescription: { fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
  optionCheck: {
    display: 'grid', placeItems: 'center', flex: '0 0 14px',
    color: 'var(--dsw-alias-label-primary)',
  },
  error: {
    margin: 0, padding: '4px 8px', fontSize: 11, lineHeight: '16px',
    color: 'var(--dsw-alias-state-error-primary)',
  },
}
