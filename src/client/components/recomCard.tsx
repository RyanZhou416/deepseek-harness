import { useEffect, useId, useState, type ReactElement } from 'react'
import { siDeepseek } from 'simple-icons'
import { DEFAULT_RECOM, recomOf, type Recom, type RecomText } from '../../shared/recoms'
import { RECOM_ROUTE } from '../apiRoutes'
import { IconShare } from '../primitives'
import type { ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'

const textKeyOf = (value: RecomText): string => value.en + '\u0000' + value.zh

const shapeOf = (recom: Recom): string =>
  [recom.id, recom.name, recom.url, recom.icon, textKeyOf(recom.slogan), textKeyOf(recom.promotion), textKeyOf(recom.tooltip)].join('\u0001')

let latest: Recom | null = null

export function resetRecomCache(): void {
  latest = null
}

async function requestRecom(): Promise<Recom | null> {
  try {
    const response = await fetch(RECOM_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (!response.ok) return null
    const payload = await response.json() as { value?: unknown } | null
    return recomOf(payload?.value)
  } catch {
    return null
  }
}

export function makeRecomCard(kit: ViewKit, ctx: ClientCtx): () => ReactElement {
  const { t } = kit
  return function RecomCard(): ReactElement {
    kit.useLocaleTick()
    const locale = ctx.locale.getLocale?.().active === 'zh' ? 'zh' : 'en'
    const [recom, setRecom] = useState<Recom>(() => latest ?? DEFAULT_RECOM)
    const [iconFailed, setIconFailed] = useState(false)
    const tooltipId = useId()
    useEffect(() => {
      let active = true
      void requestRecom().then((next) => {
        if (!active || next === null) return
        if (shapeOf(latest ?? DEFAULT_RECOM) !== shapeOf(next)) {
          setIconFailed(false)
          setRecom(next)
        }
        latest = next
      })
      return () => { active = false }
    }, [])
    const text = (value: RecomText): string => value[locale]
    return (
      <a className="lc-card lc-recom" href={recom.url} target="_blank" rel="noreferrer" aria-describedby={tooltipId}>
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <svg className="lc-recom-titlemark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 14.5 9.5 21 12 14.5 14.5 12 21 9.5 14.5 3 12 9.5 9.5Z" /></svg>
            {t('recom.title')}
          </span>
        </div>
        <div className="lc-recom-link">
          <div className="lc-recom-main">
            <div className="lc-recom-mark">
              {iconFailed ? (
                <svg viewBox="0 0 24 24" className="lc-recom-fallback" aria-hidden="true"><path d={siDeepseek.path} fill="currentColor" /></svg>
              ) : (
                <img src={recom.icon} alt="" onError={() => { setIconFailed(true) }} />
              )}
            </div>
            <div className="lc-recom-copy">
              <div className="lc-recom-brand"><span>{recom.name}</span></div>
              <div className="lc-recom-slogan">{text(recom.slogan)}</div>
            </div>
          </div>
          <div className="lc-recom-promo"><span className="lc-recom-spark" aria-hidden="true">✦</span><span>{text(recom.promotion)}</span></div>
          <IconShare size={14} className="lc-recom-arrow" />
        </div>
        <div className="lc-recom-tooltip" role="tooltip" id={tooltipId}>{text(recom.tooltip)}</div>
      </a>
    )
  }
}
