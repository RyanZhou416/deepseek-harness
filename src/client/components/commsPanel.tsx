import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { IconSendOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  channelsOf,
  fromPartyOf,
  includesAgent,
  kindGroupOf,
  type CommsAgent,
  type CommsKindFilter,
} from '../commsModel'
import { agentResolverOf } from '../fleetAgents'
import type { CommsRow } from '../fleetDetail'
import type { FleetDetailState } from '../fleetModel'
import type { ViewKit } from '../viewkit'
import type { FleetMessage } from '../../shared/types'
import { ClearableInput } from './clearableInput'
import { CommsChannelCard } from './commsChannel'
import { CommsEvent, CommsEventDetail } from './commsEvent'
import type { RichKit } from './richText'

export interface CommsPanelProps {
  details: FleetDetailState
  comms: CommsRow[]
  agents: ReadonlyMap<string, CommsAgent>
  titles: ReadonlyMap<string, string>
  attested: ReadonlyMap<string, string>
  anchorId?: string
  pickId: string | null
  onPickClear: () => void
  pinnedId: string | null
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onEnter: (id: string) => void
  rich: RichKit
  t: ViewKit['t']
}

const MAX_VISIBLE_CHANNELS = 8

function countsOf(rows: readonly CommsRow[]): Record<CommsKindFilter, number> {
  const counts: Record<CommsKindFilter, number> = { all: 0, message: 0, report: 0 }
  for (const row of rows) {
    counts.all += 1
    counts[kindGroupOf(row)] += 1
  }
  return counts
}

function fullMessageOf(details: FleetDetailState, row: CommsRow | undefined): FleetMessage | null {
  if (row === undefined) return null
  const detail = details.fullLanded.get(row.to)
  if (detail === null || detail === undefined) return null
  return detail.messages.find(message => message.seq === row.seq && message.kind === row.kind) ?? null
}

function hiddenMessagesOf(landed: FleetDetailState['landed'], rows: readonly CommsRow[]): number {
  const owners = new Set(rows.map(row => row.to))
  let hidden = 0
  for (const id of owners) {
    const detail = landed.get(id)?.detail
    if (detail?.messagesTotal !== undefined) {
      hidden += Math.max(0, detail.messagesTotal - detail.messages.length)
    }
  }
  return hidden
}

export function CommsPanel(props: CommsPanelProps): ReactElement {
  const { comms, details, pickId, t } = props
  const [channelKey, setChannelKey] = useState<string | null>(null)
  const [kindFilter, setKindFilter] = useState<CommsKindFilter>('all')
  const [query, setQuery] = useState('')
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest')
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    setChannelKey(null)
    setOpenKey(null)
    setShowAll(false)
  }, [pickId])

  const agentOf = useMemo(
    () => agentResolverOf(props.agents, props.titles, props.attested, t),
    [props.agents, props.attested, props.titles, t],
  )

  const scoped = useMemo(
    () => (pickId === null ? comms : comms.filter(row => includesAgent(row, pickId))),
    [comms, pickId],
  )
  const channels = useMemo(() => channelsOf(scoped, props.anchorId), [scoped, props.anchorId])
  const activeChannel = channelKey !== null ? channels.find(channel => channel.key === channelKey) : undefined
  const channelRows = activeChannel !== undefined ? activeChannel.rows : scoped
  const counts = useMemo(() => countsOf(channelRows), [channelRows])

  const shownRows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = channelRows.filter((row) => {
      if (kindFilter !== 'all' && kindGroupOf(row) !== kindFilter) return false
      if (needle === '') return true
      const from = agentOf(fromPartyOf(row))
      const to = agentOf(row.to)
      return [row.text, row.summary, row.report, from.name, to.name]
        .some(value => value !== undefined && value.toLowerCase().includes(needle))
    })
    return order === 'newest' ? filtered : [...filtered].reverse()
  }, [agentOf, channelRows, kindFilter, order, query])

  const openRow = openKey !== null ? shownRows.find(row => row.key === openKey) : undefined
  const fullMessage = fullMessageOf(details, openRow)
  const fullPending = openRow !== undefined && details.fullPending.has(openRow.to)

  const visibleChannels = useMemo(() => {
    const base = showAll ? channels : channels.slice(0, MAX_VISIBLE_CHANNELS)
    if (activeChannel !== undefined && !base.some(channel => channel.key === activeChannel.key)) {
      return [...base, activeChannel]
    }
    return base
  }, [activeChannel, channels, showAll])
  const hiddenChannels = channels.length - visibleChannels.length

  const toggle = (row: CommsRow): void => {
    if (openKey === row.key) {
      setOpenKey(null)
      return
    }
    setOpenKey(row.key)
    if (row.clipped === true) details.requestFull(row.to)
  }

  const pending = details.pending.size > 0
  const clippedCount = channelRows.filter(row => row.clipped === true).length
  const hiddenMessages = useMemo(() => hiddenMessagesOf(details.landed, channelRows), [channelRows, details.landed])
  const pickName = pickId !== null ? agentOf(pickId).name : ''
  const showTools = scoped.length > 4 || pickId !== null
  const subtitle = t('fleet.comms.sub', {
    n: channelRows.length,
    c: activeChannel === undefined ? channels.length : 1,
  }) + (pending ? ` · ${t('fleet.comms.loading')}` : '')

  return (
    <div className="lc-card lc-comms" aria-busy={pending}>
      <div className="lc-card-title">
        <span className="lc-card-title-text">
          <IconSendOutlineRegular size={14} />
          {t('fleet.comms.title')}
        </span>
        <span className="lc-card-sub" title={subtitle}>{subtitle}</span>
      </div>

      {showTools ? (
        <div className="lc-fleet-toolbar">
          {pickId !== null ? (
            <button
              type="button"
              className="lc-agents-badge lc-tasks-filter"
              title={pickName}
              onClick={props.onPickClear}
            >
              {pickName} ×
            </button>
          ) : null}
          <div className="lc-fleet-filters" role="group" aria-label={t('fleet.comms.kindGroup')}>
            {(['all', 'message', 'report'] as const).map(key => (
              <button
                key={key}
                type="button"
                className={'lc-gran-btn' + (kindFilter === key ? ' lc-gran-on' : '')}
                aria-pressed={kindFilter === key}
                onClick={() => {
                  setKindFilter(key)
                  setOpenKey(null)
                }}
              >
                {t(`fleet.comms.kind.${key}`)}
                <span className="lc-kind-n">{counts[key]}</span>
              </button>
            ))}
          </div>
          <ClearableInput
            type="search"
            className="lc-fleet-search"
            placeholder={t('fleet.comms.search')}
            clearLabel={t('field.clear')}
            value={query}
            onChange={setQuery}
          />
          <button
            type="button"
            className="lc-gran-btn lc-comms-order"
            title={t(order === 'newest' ? 'fleet.comms.orderOldestTip' : 'fleet.comms.orderNewestTip')}
            onClick={() => { setOrder(current => current === 'newest' ? 'oldest' : 'newest') }}
          >
            {t(order === 'newest' ? 'fleet.comms.orderNewest' : 'fleet.comms.orderOldest')}
          </button>
        </div>
      ) : null}

      {scoped.length > 0 ? (
        <div className="lc-comms-channels" role="group" aria-label={t('fleet.comms.channels')}>
          <button
            type="button"
            className={'lc-comms-channel lc-comms-channel-all' + (activeChannel === undefined ? ' lc-comms-channel-on' : '')}
            aria-pressed={activeChannel === undefined}
            onClick={() => {
              setChannelKey(null)
              setOpenKey(null)
            }}
          >
            <span className="lc-comms-allicon"><IconSendOutlineRegular size={16} /></span>
            <span className="lc-comms-channel-main">
              <span className="lc-comms-channel-names"><b>{t('fleet.comms.allChannels')}</b></span>
              <span className="lc-comms-channel-meta">
                {t('fleet.comms.allMeta', { n: scoped.length, c: channels.length })}
              </span>
            </span>
          </button>
          {visibleChannels.map(channel => (
            <CommsChannelCard
              key={channel.key}
              channel={channel}
              agentOf={agentOf}
              selected={activeChannel?.key === channel.key}
              onSelect={() => {
                setChannelKey(current => current === channel.key ? null : channel.key)
                setOpenKey(null)
              }}
              t={t}
            />
          ))}
          {hiddenChannels > 0 ? (
            <button
              type="button"
              className="lc-comms-channel lc-comms-channel-more"
              onClick={() => { setShowAll(true) }}
            >
              <span className="lc-comms-morecount">+{hiddenChannels}</span>
              <span className="lc-comms-channel-main">
                <span className="lc-comms-channel-names"><b>{t('fleet.comms.moreChannels', { n: hiddenChannels })}</b></span>
              </span>
            </button>
          ) : showAll && channels.length > MAX_VISIBLE_CHANNELS ? (
            <button
              type="button"
              className="lc-comms-channel lc-comms-channel-more"
              onClick={() => { setShowAll(false) }}
            >
              <span className="lc-comms-morecount">−</span>
              <span className="lc-comms-channel-main">
                <span className="lc-comms-channel-names"><b>{t('fleet.comms.lessChannels')}</b></span>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      {comms.length === 0 && (pending || details.landed.size === 0) ? (
        <div className="lc-comms-skeleton" aria-label={t('fleet.comms.loading')} role="status">
          <i /><i /><i />
        </div>
      ) : comms.length === 0 ? (
        <div className="lc-empty">{t('fleet.comms.empty')}</div>
      ) : scoped.length === 0 || shownRows.length === 0 ? (
        <div className="lc-empty">{t('fleet.comms.noMatch')}</div>
      ) : (
        <ul className="lc-comms-list">
          {shownRows.map(row => (
            <CommsEvent
              key={row.key}
              row={row}
              agentOf={agentOf}
              open={openKey === row.key}
              onToggle={() => { toggle(row) }}
              full={openKey === row.key ? fullMessage : null}
              t={t}
            >
              {openKey === row.key ? (
                <CommsEventDetail
                  row={row}
                  agentOf={agentOf}
                  full={fullMessage}
                  fullPending={fullPending}
                  pinnedId={props.pinnedId}
                  onSelect={props.onSelect}
                  onOpen={props.onOpen}
                  onEnter={props.onEnter}
                  onClose={() => { setOpenKey(null) }}
                  rich={props.rich}
                  t={t}
                />
              ) : null}
            </CommsEvent>
          ))}
        </ul>
      )}

      {shownRows.length < channelRows.length || clippedCount > 0 || hiddenMessages > 0 ? (
        <div className="lc-comms-notes">
          {shownRows.length < channelRows.length
            ? <span>{t('fleet.comms.filtered', { n: shownRows.length, total: channelRows.length })}</span>
            : null}
          {clippedCount > 0
            ? <span>{t('fleet.comms.clipped', { n: clippedCount })}</span>
            : null}
          {hiddenMessages > 0
            ? <span>{t('fleet.comms.hidden', { n: hiddenMessages })}</span>
            : null}
        </div>
      ) : null}
    </div>
  )
}
