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
 * The session's current model arrives as a bare observable source from
 * `ctx.modelDirectories` through the inject `hooks` compartment, so a switch
 * re-reads the tier of the model now selected instead of polling for it. Every
 * read and every write names the model it addresses, so neither can land on a
 * model the menu no longer shows.
 *
 * Every color resolves through a `--dsw-alias-*` design token and every
 * user-visible string goes through the locale `t` of the
 * 'settings.subscriptions' namespace, same as the settings section.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { IconCheckOutlineRegular, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { callSubscriptionsAuth } from './SubscriptionsSection.js'
import type { ObservableSnapshot } from './subscriptions-cache.js'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

/** One model's speed choice: standard routing or the fast (priority) tier. */
export type SpeedTier = 'standard' | 'fast'

/** A session's resolved model selection, as the model directory publishes it. */
export interface ModelRef {
  provider: string
  model: string
}

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
 * The read and the user's choice are both asynchronous, and the read is the slower of the
 * two (it asks the node half to enumerate the fast-capable models). A read that started before a
 * choice can therefore settle after it, and publishing that result would put the tier the user
 * just replaced back on screen. A read also names the model it addressed, because a model
 * switch moves the row onto a model whose tier that read never asked for.
 */
export interface SpeedView {
  /** Choices this control has settled; a read carries the value it started under. */
  generation: number
  /** The last state this control published, or null until the first read settles. */
  state: SpeedSelectState | null
}

/** One read in flight: the model it addresses and the choice generation it started under. */
export interface SpeedRead {
  /** The model this read answers for. */
  model: ModelRef | null
  /** The generation this read started under. */
  generation: number
}

/** The view before anything has been read or chosen. */
const INITIAL_SPEED_VIEW: SpeedView = { generation: 0, state: null }

/** Whether two selections name the same route. */
function sameModel(left: ModelRef | null, right: ModelRef | null): boolean {
  if (left === null || right === null) return left === right
  return left.provider === right.provider && left.model === right.model
}

/**
 * Fold one settled host read into the view, unless a choice or a model switch superseded it.
 *
 * Dropping a superseded read is what keeps the row honest: a read stamped with an older
 * generation carries the tier the user's choice replaced, and a read of another model answers a
 * question the row is no longer asking — publishing either would show a tier that belongs to no
 * model on screen.
 * @param view - the view the read settles into.
 * @param read - the model and generation the read was started under.
 * @param state - the state the read returned.
 * @param current - the model the row shows now.
 * @returns the updated view, or the same view when the read is stale.
 */
export function settleRead(
  view: SpeedView,
  read: SpeedRead,
  state: SpeedSelectState,
  current: ModelRef | null,
): SpeedView {
  if (read.generation !== view.generation) return view
  if (!sameModel(read.model, current)) return view
  return { ...view, state }
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
 * Minimal structural face of one session's model directory (ui-model-selection's
 * `ctx.modelDirectories` service — the sanctioned cross-plugin channel: cordis
 * services, not value imports, same mirroring discipline as ToolCallOwnerProps).
 * `store` is the framework's own shared snapshot source for this session; the
 * resolved `current` already includes the Host's default when the Session
 * carries no selection of its own.
 */
export interface ModelDirectoryLike {
  /** The shared directory store; `current` is the session's resolved selection. */
  readonly store: ObservableSnapshot<{ current: ModelRef | null }>
  /** Explicit one-shot read, for entry points with no slot hook (the /fast command). */
  load(): Promise<{ current: ModelRef | null }>
}

/** Structural face of ui-model-selection's `ctx.modelDirectories` service. */
export interface ModelDirectoriesLike {
  /**
   * Resolve one session's shared model directory (throws for unknown sessions).
   * @param sessionId - the owning session.
   * @returns the resident directory both selection entries share.
   */
  directoryFor(sessionId: string): ModelDirectoryLike
}

/**
 * The session's resolved model selection as a bare observable source, for the
 * inject `hooks` compartment. Snapshot identity follows the directory store's
 * own `current` object, so a subscriber re-renders only when the selection moves.
 * @param directory - the session's shared directory.
 * @returns the observable selection source.
 */
export function modelSelectionSource(directory: ModelDirectoryLike): ObservableSnapshot<ModelRef | null> {
  return {
    getSnapshot: () => directory.store.getSnapshot().current,
    subscribe: listener => directory.store.subscribe(listener),
  }
}

/**
 * Resolve a session's model selection once, through the directory's explicit
 * read. Entry points that receive no slot hook (the /fast command) use this;
 * slot components read the observable source instead.
 * @param models - the lazy service lookup.
 * @param sessionId - the owning session.
 * @returns the resolved selection, or null when nothing is selected.
 */
export async function resolveCurrentModel(
  models: () => ModelDirectoriesLike | undefined,
  sessionId: string,
): Promise<ModelRef | null> {
  const directories = models()
  if (directories === undefined) return null
  return (await directories.directoryFor(sessionId).load()).current
}

/** Injected dependencies of {@link SpeedSelect} (slot `inject`, session-bound). */
export interface SpeedSelectInjected {
  /**
   * Load one model's speed state; `visible` false keeps the control hidden.
   * @param current - the model the row is showing, or null when none is selected.
   * @returns the model's speed state.
   */
  loadSpeed: (current: ModelRef | null) => Promise<SpeedSelectState>
  /**
   * Store one model's speed tier.
   * @param current - the addressed model.
   * @param tier - the tier to store.
   * @returns false when the write failed.
   */
  setSpeed: (current: ModelRef, tier: SpeedTier) => Promise<boolean>
  /** Registrant hooks compartment: the session's resolved model selection. */
  hooks: { model: ObservableSnapshot<ModelRef | null> }
}

/**
 * Props delivered by the slot outlet: the injected callbacks and the model
 * hook the framework binds from the inject hooks compartment. The framework's
 * own standard shares are ignored — everything arrives session-bound here.
 */
export type SpeedSelectProps =
  & InjectFace<SpeedSelectInjected>
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
  current: ModelRef | null,
  fastModels: readonly string[],
): boolean {
  return current !== null
    && FAST_TIER_PROVIDERS.has(current.provider)
    && fastModels.includes(current.model)
}

/**
 * The `loadSpeed` half of the inject face: the addressed model's stored tier plus
 * the node half's fast-capable listing (the visibility gate). A model-RPC
 * failure throws rather than answering "hidden" — the caller keeps its last
 * known state, so a transient failure never locks the toggle away.
 * @param rpc - Connection RPC caller.
 * @returns the loader the inject face binds.
 */
export function createSpeedLoader(
  rpc: ConnectionHandle['rpc'],
): SpeedSelectInjected['loadSpeed'] {
  return async (current) => {
    if (current === null || !FAST_TIER_PROVIDERS.has(current.provider)) return { visible: false, tier: 'standard' }
    const state = await callSubscriptionsAuth<SpeedState>(rpc, 'speed', {
      provider: current.provider,
      model: current.model,
    })
    return { visible: speedControlVisible(current, state.fastModels), tier: state.tier }
  }
}

/**
 * The `setSpeed` half of the inject face: boolean outcome for the component's busy state.
 * @param rpc - Connection RPC caller.
 * @returns the setter the inject face binds.
 */
export function createSpeedSetter(
  rpc: ConnectionHandle['rpc'],
): SpeedSelectInjected['setSpeed'] {
  return async (current, tier) => {
    try {
      if (!FAST_TIER_PROVIDERS.has(current.provider)) return false
      await callSubscriptionsAuth(rpc, 'setSpeed', { provider: current.provider, model: current.model, tier })
      return true
    } catch {
      // The write's own failure is reported as a failed settlement, which is
      // what the control renders. A rejection would leave its busy state stuck.
      return false
    }
  }
}

/**
 * Settle one picked tier against a model. A false answer fails the call with
 * the dictionary's failure copy, which is how an entry point that owns no
 * notice surface of its own states the failure: the `/fast` popup renders
 * through the shell's error strip, while the composer control shows the same
 * copy in place.
 * @param setSpeed - the setter.
 * @param current - the model the pick addresses.
 * @param tier - the picked tier.
 * @param t - Subscriptions dictionary translator.
 * @returns nothing once the write takes effect.
 * @throws Error carrying `speedSaveFailed` when the write fails.
 */
export async function settleSpeedTier(
  setSpeed: SpeedSelectInjected['setSpeed'],
  current: ModelRef,
  tier: SpeedTier,
  t: (key: SubscriptionsKey) => string,
): Promise<void> {
  if (!await setSpeed(current, tier)) throw new Error(t('speedSaveFailed'))
}

/** English-dictionary fallback for a missing inject `t` (standalone renders). */
function fallbackTranslate(key: SubscriptionsKey): string {
  return en[key]
}

const TIERS: readonly SpeedTier[] = ['standard', 'fast']

/**
 * The model menu's Speed row: a cell reading `速度` and the current tier, opening
 * the two tiers in place (standard/fast with descriptions, a check on the current
 * one). The cell keeps the shape of the seat's own root cells — label, current
 * value, chevron — so the row reads as one of them.
 *
 * The row re-reads when the session's model moves and when the menu opens, never
 * on a timer; a failed read keeps the last known state, so a transient RPC
 * failure can never lock the choice away. Every read is stamped with the choice
 * generation it started under and names the model it addresses, so a read a
 * later choice superseded is dropped and no read or write can land on a model
 * the menu no longer shows.
 */
export function SpeedSelect(props: SpeedSelectProps) {
  const { loadSpeed, setSpeed, useModel } = props
  const translate = props.t ?? fallbackTranslate
  const model = useModel(value => value)
  const [view, setView] = useState<SpeedView>(INITIAL_SPEED_VIEW)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // The inject face may be re-evaluated (new callback identities) on re-render;
  // the read effect mounts once and reads through these refs, so identity churn
  // neither resets the effect nor multiplies in-flight loads.
  const loadRef = useRef(loadSpeed)
  loadRef.current = loadSpeed
  const modelRef = useRef(model)
  modelRef.current = model
  // The generation a read is stamped with. Mirrored from the view because the effect below mounts
  // once and stamps a read when it starts, not when it settles.
  const generationRef = useRef(view.generation)
  generationRef.current = view.generation
  /** The read in flight, or null. A settlement from any other read is discarded. */
  const readingRef = useRef<SpeedRead | null>(null)
  /** A model switch that arrived while a read was running: replay it once that read settles. */
  const replayRef = useRef(false)
  /** Read now, with the model the framework last published. */
  const reloadRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (loadRef.current === undefined) return
    let cancelled = false
    const reload = (): void => {
      const load = loadRef.current
      if (load === undefined) return
      if (readingRef.current !== null) {
        // A read is running; the replay below re-reads the newest model once it settles.
        replayRef.current = true
        return
      }
      const read: SpeedRead = { model: modelRef.current, generation: generationRef.current }
      readingRef.current = read
      void load(read.model).then(
        (loaded) => {
          if (cancelled || readingRef.current !== read) return
          readingRef.current = null
          setView(current => settleRead(current, read, loaded, modelRef.current))
        },
        () => {
          if (cancelled || readingRef.current !== read) return
          readingRef.current = null
          // A failed read keeps the last known state; the next model change or open retries.
        },
      ).finally(() => {
        if (cancelled) return
        if (replayRef.current) {
          replayRef.current = false
          reload()
        }
      })
    }
    reloadRef.current = reload
    reload()
    return () => {
      cancelled = true
      reloadRef.current = () => {}
    }
  }, [])

  // A model switch re-reads the tier of the model now selected. Keyed by the
  // route, not the object identity, so a store republish of the same selection
  // never starts a second read.
  useEffect(() => { reloadRef.current() }, [model?.provider, model?.model])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  const state = view.state
  if (state === null || !state.visible) {
    return null
  }

  const choose = (tier: SpeedTier): void => {
    if (busy || model === null) return
    if (tier === state.tier) {
      setOpen(false)
      return
    }
    const addressed = model
    setBusy(true)
    setFailed(false)
    void setSpeed(addressed, tier).then((ok) => {
      setBusy(false)
      if (ok) {
        // A write that settled after the row moved on addressed another model:
        // stamping its tier here would show a tier the new model never stored.
        if (sameModel(modelRef.current, addressed)) setView(current => settleChoice(current, tier))
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
    reloadRef.current()
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
