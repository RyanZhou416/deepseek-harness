/** Inline latest-message draft; failed submissions retain text and their retry identity. */
import { useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './LastMessageEditor.module.css'

/**
 * Render a text-only revision without changing the ordinary composer draft.
 * @param props - Original text, current eligibility, submission, cancellation, and localized copy.
 * @returns An inline draft with explicit cancel and regenerate actions.
 */
export function LastMessageEditor({ initialText, available, onSave, onCancel, t }: {
  initialText: string
  available: boolean
  onSave: (text: string, requestId: SessionRequestId) => Promise<void>
  onCancel: () => void
  t: ChatViewSlotProps['t']
}) {
  const [text, setText] = useState(initialText)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const sending = useRef(false)
  const submitted = useRef<{ text: string; id: SessionRequestId } | undefined>(undefined)
  const save = async (): Promise<void> => {
    if (sending.current || !available || text.trim() === '' || text === initialText) return
    if (submitted.current?.text !== text) submitted.current = { text, id: randomUUID() as SessionRequestId }
    sending.current = true
    setPending(true)
    setFailed(false)
    try {
      await onSave(text, submitted.current.id)
      onCancel()
    } catch {
      // The draft and request id remain available for an explicit retry.
      setFailed(true)
    } finally {
      sending.current = false
      setPending(false)
    }
  }
  return (
    <form className={css.editor} onSubmit={(event) => { event.preventDefault(); void save() }} aria-busy={pending}>
      <textarea
        autoFocus
        aria-label={t('message.edit.label')}
        value={text}
        disabled={pending}
        onChange={(event) => { setText(event.target.value); setFailed(false) }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape' && !pending) { event.preventDefault(); onCancel() }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() }
        }}
      />
      <p className={css.hint}>{t('message.edit.hint')}</p>
      {(!available || failed) && <p className={css.error} role="alert">
        {t(available ? 'message.edit.failed' : 'message.edit.unavailable')}
      </p>}
      <div className={css.actions}>
        <Button disabled={pending} onClick={onCancel}>{t('message.edit.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={pending || !available || text.trim() === '' || text === initialText}>
          {t('message.edit.save')}
        </Button>
      </div>
    </form>
  )
}
