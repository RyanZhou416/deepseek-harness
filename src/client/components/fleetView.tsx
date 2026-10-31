import { createElement as h, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { AgentHeads } from '../agentHeads'
import { agentSelfOf } from '../agentTree'
import { displayCurrencyOf } from '../cost'
import { mergeComms } from '../fleetDetail'
import { attestedNamesOf, commsAgentsOf } from '../fleetAgents'
import { useFleetDetails, useFleetModel } from '../fleetModel'
import { teamMemberOf, teamOf } from '../fleetTeam'
import { useModelPrices } from '../modelPrices'
import type { ClientCtx, SessionStandardProps } from '../services'
import { CONTEXT_VIEW_ID, openChildAsideVia, openSessionVia, projectionOf, seedConversationViewVia, unsupportedOf } from '../services'
import { useFleetMemberFocus } from '../viewFocus'
import { useContextSession } from '../sessionData'
import type { ViewKit } from '../viewkit'
import type { FleetDetail } from '../../shared/types'
import { makeAgentGraph } from './agentGraph'
import { CommsPanel } from './commsPanel'
import { makeDetailNote } from './detailNote'
import { makeRichText } from './richText'
import { makeErrorBoundary } from './errorBoundary'
import { FleetSummary } from './fleetSummary'
import { MemberBoard } from './memberBoard'
import { TaskBoard } from './taskBoard'
import { makeUpgradeGate } from './upgradeGate'
import { useConversationSurface } from './useConversationSurface'

export function makeFleetView(
  ctx: ClientCtx,
  kit: ViewKit,
  heads: AgentHeads,
): (props: SessionStandardProps) => ReactElement {
  const { t } = kit
  const AgentGraph = makeAgentGraph(ctx, kit, heads)
  const UpgradeGate = makeUpgradeGate(kit)
  const DetailNote = makeDetailNote(kit)
  const ErrorBoundary = makeErrorBoundary(t)
  const rich = makeRichText(kit)

  function FleetBody(props: SessionStandardProps): ReactElement {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
    const { source, data, pressure, breakdown, usage } = useContextSession(props)
    const rootRef = useRef<HTMLDivElement | null>(null)
    useConversationSurface(rootRef)
    useLayoutEffect(() => {
      /* v8 ignore next 3 */
      const scroller = rootRef.current !== null
        ? rootRef.current.closest('[data-conversation-scroll]')
        : null
      if (scroller !== null) scroller.scrollTop = 0
    }, [sessionId])
    const self = data !== null ? agentSelfOf(data, pressure, breakdown, usage) : undefined
    const { forest, team: rowTeam, titles } = useFleetModel(ctx, heads, sessionId, self, data !== null, 120)
    const teamDirect = projectionOf(props, 'agentTeam', teamOf)
    const team = teamDirect ?? rowTeam
    const details = useFleetDetails(undefined, { concurrency: 4, refreshDelayMs: 750 })
    const [hoverId, setHoverId] = useState<string | null>(null)
    const [pinnedId, setPinnedId] = useState<string | null>(null)
    const focusMember = useFleetMemberFocus(sessionId)
    const colsRef = useRef<HTMLDivElement | null>(null)
    useEffect(() => {
      const row = colsRef.current
      /* v8 ignore start */
      if (row === null || typeof ResizeObserver !== 'function') return
      const graph = row.querySelector<HTMLElement>('.lc-col-graph')
      const members = row.querySelector<HTMLElement>('.lc-members')
      const write = (): void => {
        let graphH = 0
        const card = graph?.firstElementChild as HTMLElement | undefined
        if (card !== undefined) {
          const cardRect = card.getBoundingClientRect()
          const canvas = card.querySelector<HTMLElement>('.lc-agents-canvas')
          const stage = canvas?.closest<HTMLElement>('.lc-agents-stage') ?? null
          const stageRect = stage?.getBoundingClientRect() ?? null
          const canvasRect = canvas?.getBoundingClientRect() ?? null
          const top = stageRect?.top ?? canvasRect?.top
          const basis = stage !== null ? window.parseFloat(window.getComputedStyle(stage).flexBasis) : Number.NaN
          const visible = Number.isFinite(basis) ? basis : canvasRect?.height ?? 0
          if (top !== undefined) {
            const pad = window.parseFloat(window.getComputedStyle(card).paddingBottom)
            graphH = top - cardRect.top + visible + pad
          }
        }
        row.style.setProperty('--lc-graph-h', `${Math.ceil(graphH)}px`)
        row.style.setProperty('--lc-members-h', members !== null ? `${Math.ceil(members.getBoundingClientRect().height)}px` : '0px')
      }
      write()
      const observer = new ResizeObserver(write)
      if (graph !== null) observer.observe(graph)
      if (members !== null) observer.observe(members)
      return () => { observer.disconnect() }
      /* v8 ignore stop */
    }, [forest, team])
    const [ownerFilter, setOwnerFilter] = useState<string | null>(null)
    const [focusTaskId, setFocusTaskId] = useState<string | null>(null)
    const { book } = useModelPrices()
    const currency = displayCurrencyOf(ctx.locale)

    const byId = useMemo(
      () => new Map((forest?.nodes ?? []).map(n => [n.id, n])),
      [forest],
    )

    useEffect(() => {
      if (pinnedId !== null && !byId.has(pinnedId)) setPinnedId(null)
    }, [pinnedId, byId])

    const leadId = team !== null ? team.members[0]?.id : undefined
    const detailStamp = forest === null ? '' : forest.nodes.map(n => `${n.id}@${n.updatedAt}`).join(',')
    useEffect(() => {
      if (forest === null) return
      for (const node of forest.nodes) details.request(node.id, node.updatedAt)
    }, [forest, detailStamp])

    const landedDetails = useMemo(() => {
      const map = new Map<string, FleetDetail>()
      for (const [id, entry] of details.landed) {
        if (entry.detail !== null) map.set(id, entry.detail)
      }
      return map
    }, [details.landed])
    const comms = useMemo(() => mergeComms(landedDetails), [landedDetails])
    const attestedNames = useMemo(() => attestedNamesOf(comms), [comms])

    const leadDetail = leadId !== undefined ? landedDetails.get(leadId) ?? null : null
    const agents = useMemo(
      () => commsAgentsOf(forest?.nodes ?? [], team, leadDetail?.roster, attestedNames, t),
      [attestedNames, forest, leadDetail, team, t],
    )

    const open = (id: string): void => {
      const node = byId.get(id)
      /* v8 ignore next 5 */
      if (openChildAsideVia(ctx, {
        childSessionId: id,
        parentSessionId: node?.parentId,
        mode: node?.identity?.mode,
      })) return
      openSessionVia(ctx, id)
    }

    const enter = (id: string): void => {
      seedConversationViewVia(id, CONTEXT_VIEW_ID)
      openSessionVia(ctx, id)
    }

    const select = (id: string): void => {
      const next = pinnedId === id ? null : id
      setPinnedId(next)
      const member = teamMemberOf(team, id)
      if (next !== null) setOwnerFilter(member?.name ?? id)
      else if (ownerFilter === id || (member !== null && ownerFilter === member.name)) setOwnerFilter(null)
    }

    const pickId = useMemo(() => {
      if (ownerFilter === null) return null
      return team?.members.find(m => m.name === ownerFilter)?.id ?? ownerFilter
    }, [ownerFilter, team])

    if (data === null) {
      return (
        <div className="lc-root" ref={rootRef}>
          {source.detailState === 'failed'
            ? <DetailNote state="failed" onRetry={source.retryDetail} />
            : <div className="lc-empty">{t('loading')}</div>}
        </div>
      )
    }

    const gate = unsupportedOf(data.unsupported)
    const pinToggle = (id: string | null): void => {
      const releasing = pinnedId === id
      setPinnedId(releasing ? null : id)
      if (releasing && id !== null) {
        const member = teamMemberOf(team, id)
        const key = member?.name ?? id
        if (ownerFilter === key) setOwnerFilter(null)
      }
    }
    const taskBoard = (
      <TaskBoard
        team={team}
        forest={forest}
        detailOf={id => details.landed.get(id)}
        fullOf={id => ({ detail: details.fullLanded.get(id) ?? null, pending: details.fullPending.has(id) })}
        onOpenOwner={(id) => { details.requestFull(id) }}
        ownerFilter={ownerFilter}
        onOwnerFilter={setOwnerFilter}
        focusTaskId={focusTaskId}
        onFocusTask={setFocusTaskId}
        pinnedId={pinnedId}
        hoverId={hoverId}
        onPinMember={pinToggle}
        onHoverMember={setHoverId}
        rich={rich}
        t={t}
        fmt={kit.fmt}
      />
    )
    const boardsColumn = forest !== null
      ? (
        <div className="lc-col lc-col-boards flex-1 min-w-[min(360px,100%)]">
          <MemberBoard
            team={team}
            forest={forest}
            leadDetail={leadDetail}
            detailOf={id => details.landed.get(id)}
            pinnedId={pinnedId}
            hoverId={hoverId}
            onPin={select}
            onHover={setHoverId}
            onEnter={enter}
            onOpen={open}
            ownerFilter={ownerFilter}
            onOwnerFilter={setOwnerFilter}
            t={t}
            fmt={kit.fmt}
          />
          {taskBoard}
        </div>
      )
      : team !== null
        ? <div className="lc-col flex-1 min-w-[min(360px,100%)]">{taskBoard}</div>
        : null
    return (
      <div className="lc-root" ref={rootRef}>
        {forest !== null
          ? <FleetSummary forest={forest} team={team} book={book} currency={currency} t={t} fmt={kit.fmt} />
          : null}
        {forest !== null || boardsColumn !== null
          ? (
            <div className="lc-cols" ref={colsRef}>
              {forest !== null
                ? (
                  <div className="lc-col lc-col-graph flex-1 min-w-[min(420px,100%)]">
                    <AgentGraph
                      sessionId={sessionId}
                      forest={forest}
                      team={team}
                      pinnedId={pinnedId}
                      hoverId={hoverId}
                      focusId={focusMember}
                      onHover={setHoverId}
                      onSelect={select}
                      inspector={false}
                    />
                  </div>
                )
                : null}
              {boardsColumn}
            </div>
          )
          : null}
        {forest !== null
          ? (
            <CommsPanel
              details={details}
              comms={comms}
              agents={agents}
              titles={titles}
              attested={attestedNames}
              anchorId={sessionId}
              pickId={pickId}
              pinnedId={pinnedId}
              onSelect={select}
              onPickClear={() => {
                setOwnerFilter(null)
                setPinnedId(null)
              }}
              onOpen={open}
              onEnter={enter}
              rich={rich}
              t={t}
            />
          )
          : null}
        <div className="lc-foot">{t('footer')}</div>
        {gate !== null && (
          <UpgradeGate sessionId={sessionId} current={gate.current} minimum={gate.minimum} />
        )}
      </div>
    )
  }

  return function FleetView(props: SessionStandardProps): ReactElement {
    return h(ErrorBoundary, null, h(FleetBody, props))
  }
}
