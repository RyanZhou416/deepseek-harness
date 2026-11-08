/** Shared General Settings toggle row: copy, failure feedback, and the write state. */
import { useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './GeneralToggleRow.module.css'

/** Localized copy and accepted state supplied by one General Settings row owner. */
export interface GeneralToggleRowProps {
  /** Row title, also the switch's accessible name. */
  title: string
  /** One line explaining what the setting changes. */
  description: string
  /** Localized feedback shown after a refused or failed write. */
  error: string
  /** The accepted value the switch shows. */
  checked: boolean
  /** Whether the owner cannot write the value at all. */
  disabled: boolean
  /**
   * Persist the requested value.
   * @param next - the state the user asked for.
   * @returns settlement after the owner's write; `false` and rejection both display {@link error}.
   */
  onToggle: (next: boolean) => Promise<boolean | void>
}

/**
 * Render one General Settings toggle.
 * @param props - localized copy, accepted state, and the owner's writer.
 * @returns The labelled switch row.
 */
export function GeneralToggleRow({ title, description, error, checked, disabled, onToggle }: GeneralToggleRowProps) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return <div className={css.row}>
    <div>
      <div className={css.title}>{title}</div>
      <div className={css.description}>{description}</div>
      {failed && <div role="alert">{error}</div>}
    </div>
    <Switch checked={checked} disabled={disabled || busy} label={title}
      onChange={(next) => {
        setFailed(false)
        setBusy(true)
        void Promise.resolve(onToggle(next))
          .then((accepted) => { if (accepted === false) setFailed(true) })
          .catch(() => { setFailed(true) })
          .finally(() => { setBusy(false) })
      }} />
  </div>
}
