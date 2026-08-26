// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { ToolRow } from '../src/client/tool/components/ToolRow.tsx'

afterEach(() => {
  cleanup()
})

const t = makeTranslate(zh, commonZh)

describe('ToolRow lazy body', () => {
  it('does not derive the large detail strings until the row is expanded', () => {
    const body = vi.fn(() => 'large input')
    const output = vi.fn(() => 'large output')
    const details = {
      hasBody: true,
      hasOutput: true,
      get body() { return body() },
      get output() { return output() },
    }
    const view = render(
      <ToolRow
        t={t}
        variant="bash"
        icon={<span />}
        title="Bash"
        summary="Run"
        details={details}
        state="ok"
      />,
    )

    expect(body).not.toHaveBeenCalled()
    expect(output).not.toHaveBeenCalled()
    expect(view.queryByText('large input')).toBeNull()
    expect(view.queryByText('large output')).toBeNull()

    fireEvent.click(view.getByRole('button'))
    expect(body).toHaveBeenCalledOnce()
    expect(output).toHaveBeenCalledOnce()
    expect(view.getByText('large input')).toBeTruthy()
    expect(view.getByText('large output')).toBeTruthy()
  })
})
