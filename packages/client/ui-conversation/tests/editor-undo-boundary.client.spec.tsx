// @vitest-environment jsdom
/**
 * Undo segmentation: one continuous typing run must not collapse into a single
 * undo entry just because every keystroke arrived inside the merge window.
 */
import { describe, expect, it } from 'vitest'
import { $createParagraphNode, $createTextNode, $getRoot, $isParagraphNode, $isTextNode, createEditor, UNDO_COMMAND } from 'lexical'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import { installUndoBoundary } from '../src/client/input/editor/undo-boundary.ts'

const WINDOW_MS = 1000

interface Harness {
  append: (char: string, at: number) => Promise<void>
  undo: () => Promise<void>
  read: () => string
  dispose: () => void
}

function harness(): Harness {
  let clock = 0
  const now = (): number => clock
  const editor = createEditor()
  const history = createEmptyHistoryState()
  const detach = [
    registerHistory(editor, history, WINDOW_MS, now),
    installUndoBoundary(editor, history, WINDOW_MS, now),
  ]
  const append = async (char: string, at: number): Promise<void> => {
    clock = at
    editor.update(() => {
      const root = $getRoot()
      const tail = root.getLastChild()
      const paragraph = tail !== null && $isParagraphNode(tail) ? tail : $createParagraphNode()
      if (tail !== paragraph) root.append(paragraph)
      const node = paragraph.getFirstChild()
      if (node !== null && $isTextNode(node)) node.setTextContent(node.getTextContent() + char)
      else paragraph.append($createTextNode(char))
        $getRoot().selectEnd()
    })
    // Lexical commits batched updates on the next task, not synchronously.
    await new Promise(resolve => { setTimeout(resolve, 0) })
  }
  return {
    append,
    undo: async () => {
      editor.dispatchCommand(UNDO_COMMAND, undefined)
      await new Promise(resolve => { setTimeout(resolve, 0) })
    },
    read: () => editor.getEditorState().read(() => $getRoot().getTextContent()),
    dispose: () => { for (const off of detach) off() },
  }
}

describe('undo boundary', () => {
  it('keeps one undo within the merge window during continuous typing', async () => {
    const h = harness()
    for (let i = 0; i < 10; i++) await h.append('a', i * 100)
    await h.append('b', 1100)
    await h.append('c', 1200)
    expect(h.read()).toBe('aaaaaaaaaabc')
    await h.undo()
    // The boundary was pushed before the edit that crossed the window, so this
    // undo reverts that edit and everything after it, not the whole run.
    expect(h.read()).toBe('aaaaaaaaaa')
    h.dispose()
  })

  it('leaves a natural pause to the history window without a duplicate entry', async () => {
    const h = harness()
    await h.append('a', 0)
    await h.append('b', 100)
    await h.append('c', 200)
    await h.append('d', 2000)
    await h.append('e', 2100)
    expect(h.read()).toBe('abcde')
    await h.undo()
    expect(h.read()).toBe('abc')
    h.dispose()
  })
})
