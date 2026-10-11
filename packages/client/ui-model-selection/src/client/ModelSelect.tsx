/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Two-level selection per figma 496:26454's MenuDropdown: the root menu is
 * the Model / Effort row pair (label + current value + a right chevron),
 * each drilling into its own list — the provider-grouped model list over
 * the shared directory, and the effort levels. The trigger (313:14108's
 * ToggleButton) shows both: model name + effort in the caption tone.
 * While open, ↑/↓ move focus across the rows of the shown pane (wrapping; a
 * step taken while the trigger still holds focus enters at the near end), Tab
 * settles like Enter, and Escape and Shift+Tab leave a drilled pane first and
 * otherwise close back to the trigger. A drilled pane hands focus to the row
 * of the value in use, and returning to the root pane hands it back to the
 * cell that opened it. Data and submission ride the SAME per-session
 * ModelDirectory as the /model popup; exact-model reasoning metadata and the
 * selected effort come from the Host rather than a client-owned vocabulary. A
 * rejected selection announces through the shared transient Toast anchored to
 * the composer card; the in-menu strip with Retry remains the catalog-load
 * surface. Features add rows of their own under the root pane's cells through
 * the declared `conversation.input.model.row` child slot; the seat stays
 * single-owner and renders its own two cells alone when nothing registers.
 * A contributed row opens its own pane in the same card through the slot's
 * owner navigation face: the seat hides its own cells, keeps the row mounted
 * across the switch, and treats that pane as one of its own for ↑/↓, Escape,
 * Tab, and Shift+Tab. The shown pane is the card's single scroll region, so a
 * pane taller than the card scrolls rather than having its last row clipped.
 */
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type FocusEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular,
  IconDataOutlineRegular, IconWarningOutlineRegular, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelMenuRowOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/** Which pane the dropdown shows: the two-row root or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort'

/** Where the keyboard lands after a pane switch: in the pane just opened, or back on the control that opened it. */
type PaneFocus =
  | { readonly to: 'drill' }
  | { readonly to: 'seat'; readonly pane: 'model' | 'effort' }
  | { readonly to: 'row'; readonly rowKey: string }

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

/** Unplaced portal card: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real (Menu primitive's measure pass). */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** The menu's keyboard rows, whichever pane owns them: the seat's cells, a contributed row, and any option list. */
const MENU_ROW = '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])'

/** The row carrying the value in use, which is where a freshly opened pane starts. */
const CHECKED_ROW = '[role="menuitemradio"][aria-checked="true"]:not([disabled])'

/** Dataset key of the marker a contributed row's activating cell carries (see the slot's owner props). */
const ROW_MARKER = 'modelMenuRow'

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat + the declared child-row renderer.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect(
  { locked, available, directory, load, select, t, renderSlot, SessionProvider }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>
  & PropsRenderSlots<'conversation.input.model.row'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  // The contributed pane on screen, named by its row's own key. The seat's
  // cells hide while one is shown; the contributing row stays mounted.
  const [contributed, setContributed] = useState<string | null>(null)
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null)
  // The seat's own two cells, so leaving one of its panes can put the keyboard
  // back where that pane was opened. Contributed rows name their own cell with
  // the marker the owner face documents instead.
  const modelCellRef = useRef<HTMLButtonElement | null>(null)
  const effortCellRef = useRef<HTMLButtonElement | null>(null)
  // The live contributed pane for the identity-stable owner callbacks below.
  const contributedRef = useRef<string | null>(null)
  contributedRef.current = contributed
  const id = useId()

  const choices = useMemo(() => state.groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [state.groups])
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [reasoning, t])
  const busy = state.status === 'selecting'

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      // The portaled card is outside the trigger subtree; check both.
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  /** The shown pane's keyboard rows, in document order (the seat's cells and a contributed row alike). */
  const paneRows = (): HTMLElement[] => {
    const menu = menuRef.current
    return menu === null ? [] : [...menu.querySelectorAll<HTMLElement>(MENU_ROW)]
  }

  /** The root cell of the contributed row keyed `rowKey`, through the marker its owner face requires. */
  const markedCell = (rowKey: string): HTMLElement | null => {
    for (const row of paneRows()) {
      if (row.dataset[ROW_MARKER] === rowKey) return row
    }
    return null
  }

  // A pane switch unmounts the row that had focus, which drops focus onto the
  // page body — outside the card's subtree, where its key handling no longer
  // sees a keystroke. Every switch therefore names where the keyboard lands:
  // drilling on the pane's current value, coming back on the control that
  // opened the pane left.
  const paneFocus = useRef<PaneFocus | null>(null)
  useEffect(() => {
    const transition = paneFocus.current
    paneFocus.current = null
    if (!open || transition === null) return
    if (transition.to === 'drill') {
      // The checked row is the value in use; a pane without one opens on its
      // first row. Rows a selection in flight disabled cannot take the
      // keyboard; the trigger does, so the card's keys still reach the menu.
      const target = menuRef.current?.querySelector<HTMLElement>(CHECKED_ROW) ?? paneRows()[0]
      ;(target ?? triggerRef.current)?.focus()
      return
    }
    const target = transition.to === 'seat'
      ? (transition.pane === 'effort' ? effortCellRef.current : modelCellRef.current)
      : markedCell(transition.rowKey)
    ;(target ?? triggerRef.current)?.focus()
  }, [open, pane, contributed])

  // Portaled placement (the Menu primitive's portal rules: fixed from the
  // anchor rect, measured before paint, clamped inside the viewport): above
  // the trigger, right edges aligned. Depends on the pane, the contributed
  // pane, and directory state because pane switches and async catalog loads
  // resize the card.
  /* jscpd:ignore-start -- deliberate mirror of ui-primitives useAnchoredPosition:
     that hook only places from the anchor's LEFT edge, while this card aligns
     right edges (x = rect.right - width), so the measure-and-clamp plumbing repeats. */
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return }
    const place = (): void => {
      /* v8 ignore next 2 -- the trigger ref is attached whenever the menu is open. */
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const MARGIN = 12
      const lw = menuRef.current?.offsetWidth ?? 0
      const lh = menuRef.current?.offsetHeight ?? 0
      let x = rect.right - lw
      let y = rect.top - 8 - lh
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN)
      setMenuPos({ left: x, top: y })
    }
    // First run measures the hidden pre-render (same commit as `open`), so
    // the card lands placed before anything paints.
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    // The card's own box changes without either event — a pane's rows arriving,
    // a contributed row's status or error line appearing — and a stale clamp
    // would let a card near the bottom edge cross the margin it is supposed to
    // respect. The guard keeps this usable where ResizeObserver is absent,
    // which is how jsdom runs.
    const menu = menuRef.current
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && menu !== null) {
      observer = new ResizeObserver(place)
      observer.observe(menu)
    }
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, pane, contributed, state])
  /* jscpd:ignore-end */

  // Identity-stable for the contributed-row owner face (a row may hold these in
  // effect dependencies), so they read the live pane through `contributedRef`
  // instead of closing over one render.
  const close = useCallback((restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    setContributed(null)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }, [])

  /** The owner face's `closeMenu`: the whole card goes away and the trigger takes the keyboard back. */
  const closeMenu = useCallback((): void => { close(true) }, [close])

  /** The owner face's `openRow`: the row's own pane replaces the seat's cells, which stay hidden until `back`. */
  const openRow = useCallback((rowKey: string): void => {
    paneFocus.current = { to: 'drill' }
    setPane('root')
    setContributed(rowKey)
  }, [])

  /** The owner face's `back`: leave the shown contributed pane for the root pane, focusing the cell that opened it. */
  const back = useCallback((): void => {
    const rowKey = contributedRef.current
    if (rowKey === null) return
    paneFocus.current = { to: 'row', rowKey }
    setContributed(null)
  }, [])

  // The navigation face every contributed row reads. Rebuilt only when the pane
  // moves; its callbacks keep one identity for the life of the seat.
  const rowOwner = useMemo<ModelMenuRowOwnerProps>(
    () => ({ activeRow: contributed, openRow, back, closeMenu }),
    [contributed, openRow, back, closeMenu],
  )

  if (!available) return null

  const show = (): void => {
    triggerRef.current?.focus()
    setPane('root')
    setContributed(null)
    setOpen(true)
    reload()
  }

  /** Leave whichever pane is shown for the root one; the card stays open. */
  const exitPane = (): void => {
    if (contributedRef.current !== null) {
      back()
      return
    }
    if (pane !== 'root') {
      paneFocus.current = { to: 'seat', pane }
      setPane('root')
    }
  }

  const drill = (next: Exclude<Pane, 'root'>): void => {
    paneFocus.current = { to: 'drill' }
    setContributed(null)
    setPane(next)
  }

  const moveFocus = (offset: number): void => {
    const items = paneRows()
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    // Focus outside the rows (the trigger, which keeps it while the menu
    // opens) enters at the end the step comes from: the first row forward,
    // the last row backward.
    const next = active === -1
      ? (offset > 0 ? 0 : items.length - 1)
      : (active + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape backs out of a drilled pane first, then closes.
      if (pane !== 'root' || contributed !== null) exitPane()
      else close(true)
      return
    }
    if (!open) return
    // Tab settles like Enter and Shift+Tab leaves like Escape, so the menu's
    // keys mean what they mean in the composer. Both are consumed: the card
    // keeps the browser's focus traversal out while it is open.
    if (event.key === 'Tab') {
      if (event.shiftKey) {
        event.preventDefault()
        if (pane !== 'root' || contributed !== null) exitPane()
        else close(true)
        return
      }
      // Settling activates the row the keyboard is on — a seat cell and a
      // contributed row alike; with focus still on the trigger, Tab enters the
      // menu at the value in use instead. Any other control inside the card (a
      // retry button) keeps the browser's traversal, so the keystroke stays
      // unconsumed there.
      const focused = document.activeElement
      const rows = paneRows()
      if (focused instanceof HTMLElement && menuRef.current?.contains(focused) === true && focused.matches(MENU_ROW)) {
        event.preventDefault()
        focused.click()
        return
      }
      if (focused !== triggerRef.current) return
      event.preventDefault()
      const checked = menuRef.current?.querySelector<HTMLElement>(CHECKED_ROW)
      ;(checked ?? rows[0])?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && (
      rootRef.current?.contains(event.relatedTarget) === true
      || menuRef.current?.contains(event.relatedTarget) === true
    )) return
    close()
  }

  const settleSelection = (result: Awaited<ReturnType<ModelSelectInjected['select']>>): void => {
    if (result === undefined) return
    if (result.ok) {
      if (rootRef.current !== null) close(true)
      return
    }
    const { error } = result
    toastSeq.current += 1
    setToast({
      seq: toastSeq.current,
      text: error.code === 'session/writer-held'
        ? t('error.sessionInUse')
        : t('error.action', { message: `${error.code}: ${error.message}` }),
    })
  }

  const submit = (selection: ModelSelection): void => {
    lastActionRef.current = 'select'
    // Disabled option rows cannot retain focus while a selection is pending.
    triggerRef.current?.focus()
    void select(selection).then(settleSelection)
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    submit(selection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    submit(selection)
  }

  const waiting = state.current === null && state.status === 'loading'
  const modelLabel = waiting
    ? t('trigger.loading')
    : currentChoice?.model.name
      ?? (state.current === null ? t('trigger.fallback') : `${state.current.provider}/${state.current.model}`)
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = waiting
    ? t('trigger.loading')
    : state.current === null
      ? t('trigger.selectAria')
      : effortLabel === undefined
        ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })

  return (
    <div
      ref={rootRef}
      className={css.root}
      onKeyDown={onRootKeyDown}
      onBlur={onBlur}
      onMouseDown={(event) => {
        // WebKit blurs a focused row before click unless the button's mousedown keeps focus.
        if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked}
        onClick={() => {
          if (open) {
            close(true)
          } else {
            show()
          }
        }}
      >
        <IconDataOutlineRegular className={css.triggerIcon} size={16} />
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {/* Portaled to body (Menu primitive's portal mode) so the sidebar and
          column overflow clips cannot crop the card; synthetic events still
          bubble through this React subtree, keeping onKeyDown/onBlur live. */}
      {open && createPortal(
        <div
          ref={menuRef}
          id={`${id}-menu`}
          className={css.menu}
          style={menuPos ?? MEASURE_STYLE}
          role="menu"
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {/* One scroll region for whichever pane shows: the seat's own lists and
              a contributed row's pane both scroll here, so a pane taller than the
              card never has its last row clipped by the card's own overflow. */}
          <div className={css.pane}>
            {pane === 'root' && (
              <>
                {/* The seat's own cells, hidden while a contributed row's pane is
                    shown. The row itself stays mounted through the switch (the key
                    below keeps its element identity), so its own state and
                    in-flight reads survive the drill. */}
                {contributed === null && (
                  <>
                    <button ref={modelCellRef} type="button" role="menuitem" className={css.cell} onClick={() => { drill('model') }}>
                      <span className={css.cellLabel}>{t('menu.model')}</span>
                      <span className={css.cellValue}>{modelLabel}</span>
                      <IconChevronRightOutlineRegular className={css.cellChevron} />
                    </button>
                    {reasoning !== undefined && (
                      <button ref={effortCellRef} type="button" role="menuitem" className={css.cell} onClick={() => { drill('effort') }}>
                        <span className={css.cellLabel}>{t('menu.effort')}</span>
                        <span className={css.cellValue}>{effortLabel}</span>
                        <IconChevronRightOutlineRegular className={css.cellChevron} />
                      </button>
                    )}
                  </>
                )}
                {/* Feature-owned rows, under the seat's own cells. They are the
                    menu's own rows for ↑/↓ and Tab (role plus their declared
                    marker), and one opens its pane by calling the owner face. The
                    Provider carries this seat's Session to them, which their
                    session-bound inject reads. */}
                <SessionProvider key="seat-rows">{renderSlot('conversation.input.model.row', rowOwner)}</SessionProvider>
              </>
            )}

            {pane === 'model' && (
              <>
                {state.status === 'loading' && (
                  <div className={css.status}>{t('status.loading')}</div>
                )}
                {state.error !== null && lastActionRef.current === 'load' && (
                  <div className={css.error}>
                    <span>{t('error.action', { message: state.error })}</span>
                    <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                  </div>
                )}
                {state.failures.map(failure => (
                  <div className={css.warning} key={failure.id}>
                    <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
                    <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                  </div>
                ))}
                <div className={clsx(css.groups, 'scrollable')}>
                  {state.groups.map((group) => {
                    const headingId = `${id}-${group.id}`
                    return (
                      <section role="group" aria-labelledby={headingId} className={css.group} key={group.id}>
                        <div className={css.groupTitle} id={headingId}>{group.name}</div>
                        {group.models.map((model) => {
                          const selected = state.current?.provider === group.id && state.current.model === model.id
                          return (
                            <button
                              type="button"
                              role="menuitemradio"
                              aria-checked={selected}
                              className={clsx(css.option, selected && css.selected)}
                              key={model.id}
                              title={model.name}
                              disabled={busy}
                              onClick={() => { choose({ provider: group.id, model: model.id }) }}
                            >
                              <span className={css.optionCopy}>
                                <span className={css.modelName}>{model.name}</span>
                              </span>
                              <span className={css.check}>
                                {selected ? <IconCheckOutlineRegular /> : null}
                              </span>
                            </button>
                          )
                        })}
                      </section>
                    )
                  })}
                </div>
                {state.status === 'ready' && choices.length === 0 && (
                  <div className={css.empty}>{t('empty.models')}</div>
                )}
              </>
            )}

            {pane === 'effort' && (
              <>
                {state.error !== null && lastActionRef.current === 'load' && (
                  <div className={css.error}>
                    <span>{t('error.action', { message: state.error })}</span>
                    <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                  </div>
                )}
                {effortChoices.length === 0
                  ? <div className={css.empty}>{t('empty.efforts')}</div>
                  : effortChoices.map(level => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={effectiveEffort === level.effort}
                      className={clsx(css.option, effectiveEffort === level.effort && css.selected)}
                      key={level.key}
                      disabled={busy}
                      onClick={() => { chooseEffort(level.effort) }}
                    >
                      <span className={css.optionCopy}>
                        <span className={css.modelName}>{level.label}</span>
                      </span>
                      <span className={css.check}>
                        {effectiveEffort === level.effort ? <IconCheckOutlineRegular /> : null}
                      </span>
                    </button>
                  ))}
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
