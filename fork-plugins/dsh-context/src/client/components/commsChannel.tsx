import type { ReactElement } from 'react'
import type { CommsAgent, CommsChannel } from '../commsModel'
import { fmtTime } from '../format'
import type { ViewKit } from '../viewkit'
import { AgentAvatar, channelStyle, roleTextOf } from './commsAgent'

export interface CommsChannelCardProps {
  channel: CommsChannel
  agentOf: (party: string) => CommsAgent
  selected: boolean
  onSelect: () => void
  t: ViewKit['t']
}

export function CommsChannelCard(props: CommsChannelCardProps): ReactElement {
  const { channel, t } = props
  const a = props.agentOf(channel.a)
  const b = props.agentOf(channel.b)
  const same = a.id === b.id
  const time = channel.lastTime > 0 ? fmtTime(channel.lastTime) : '—'
  const roles = same
    ? roleTextOf(a, t)
    : [roleTextOf(a, t), roleTextOf(b, t)].filter(role => role !== '').join(' ↔ ')
  const tip = t('fleet.comms.channelTip', {
    a: a.name,
    b: b.name,
    out: channel.out,
    back: channel.back,
    time,
  })
  return (
    <button
      type="button"
      className={'lc-comms-channel' + (props.selected ? ' lc-comms-channel-on' : '')}
      style={channelStyle(a.hue, b.hue)}
      aria-pressed={props.selected}
      title={tip}
      data-channel-key={channel.key}
      onClick={props.onSelect}
    >
      <span className="lc-comms-channel-avatars">
        <AgentAvatar agent={a} size="md" t={t} />
        {same ? null : <AgentAvatar agent={b} size="md" t={t} />}
      </span>
      <span className="lc-comms-channel-main">
        <span className="lc-comms-channel-names">
          <span className="lc-comms-channel-party"><b>{a.name}</b></span>
          {same
            ? null
            : (
              <span className="lc-comms-channel-party">
                <i aria-hidden="true">↔</i>
                <b>{b.name}</b>
              </span>
            )}
        </span>
        <span className="lc-comms-channel-meta">
          {roles !== '' ? <span>{roles}</span> : null}
          <span className="lc-comms-channel-count">
            {same
              ? t('fleet.comms.channelSelfMeta', { n: channel.out + channel.back, time })
              : t('fleet.comms.channelMeta', { out: channel.out, back: channel.back, time })}
          </span>
        </span>
      </span>
    </button>
  )
}
