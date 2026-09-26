// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { LastMessageEditor } from '../src/client/chat/LastMessageEditor.tsx'
import { UserMessageNodeView } from '../src/client/chat/MessageItem.tsx'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locale.ts'

afterEach(cleanup)
const t: ChatNodeViewProps['t'] = makeTranslate(zh, commonZh)

describe('last-message editor', () => {
  it('keeps multiline text and reuses the submission id after failure', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const cancel = vi.fn()
    render(<LastMessageEditor initialText="original" available onSave={save} onCancel={cancel} t={t} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'revised\nquestion' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并重新生成' }))
    await screen.findByRole('alert')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('revised\nquestion')
    expect(cancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存并重新生成' }))
    await waitFor(() => { expect(cancel).toHaveBeenCalledOnce() })
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[0]).toEqual(save.mock.calls[1])
    expect(save.mock.calls[0]![0]).toBe('revised\nquestion')
  })

  it('keeps an unavailable draft and prevents submission', async () => {
    const save = vi.fn()
    const cancel = vi.fn()
    const view = render(<LastMessageEditor initialText="original" available onSave={save} onCancel={cancel} t={t} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'my draft' } })
    view.rerender(<LastMessageEditor initialText="original" available={false} onSave={save} onCancel={cancel} t={t} />)
    expect(screen.getByRole('alert').textContent).toContain('状态已变化')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('my draft')
    fireEvent.submit(screen.getByRole('textbox').closest('form')!)
    expect(save).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('offers editing only for the latest eligible ordinary text message', () => {
    const save = vi.fn()
    const node: ChatNodeViewProps<'user'>['node'] = {
      key: 'input-message:4', id: '4', target: 'chat', kind: 'user', anchorSeq: 4,
      location: { kind: 'session' }, visibility: 'visible',
      data: { kind: 'user', seq: 4, time: 1000, content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } },
    }
    const props: Partial<ChatNodeViewProps<'user'>> = {
      node,
      renderMessageImages: () => null, openFile: vi.fn(), openSkill: vi.fn(),
      editableMessageSeq: 4, editLastMessage: save, t,
    }
    const view = render(<UserMessageNodeView {...props as ChatNodeViewProps<'user'>} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑最后一条消息' }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('original')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(save).not.toHaveBeenCalled()
    view.rerender(<UserMessageNodeView {...props as ChatNodeViewProps<'user'>} editableMessageSeq={5} />)
    expect(screen.queryByRole('button', { name: '编辑最后一条消息' })).toBeNull()
  })
})
