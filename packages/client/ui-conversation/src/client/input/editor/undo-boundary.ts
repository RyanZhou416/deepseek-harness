/** Keep one undo unit inside the merge window during continuous typing. */
import {
  CAN_REDO_COMMAND, CAN_UNDO_COMMAND, COMMAND_PRIORITY_CRITICAL, REDO_COMMAND, TextNode, UNDO_COMMAND,
  type LexicalEditor,
} from 'lexical'
import type { HistoryState } from '@lexical/history'
import { mergeRegister } from '@lexical/utils'

/**
 * Bound a continuous typing run to the merge window it started in.
 *
 * Lexical merges every edit that arrives within `windowMs` of the previous
 * edit, so typing without a pause collapses into one undo entry regardless of
 * how long it runs. This boundary pushes the state that predates the first
 * edit past the window, making one undo revert at most one window of typing.
 * The push is a real history entry, not a no-op: it is taken immediately
 * before the edit that starts the next window, so undo always moves the text.
 * @param editor - editor whose history is segmented.
 * @param history - the same state passed to `registerHistory`.
 * @param windowMs - merge window of that history registration.
 * @param now - clock used for window decisions, matching the history's `dateNow`.
 * @returns disposer for the commands and transform it registers.
 */
export function installUndoBoundary(
  editor: LexicalEditor,
  history: HistoryState,
  windowMs: number,
  now: () => number = Date.now,
): () => void {
  let suppress = false
  let runStart: number | undefined
  let lastEdit: number | undefined
  /** Undo/redo rewrites text too; those updates start a fresh run instead of a boundary. */
  const historyCommand = (): boolean => {
    suppress = true
    queueMicrotask(() => { suppress = false })
    return false
  }
  const noteEdit = (): void => {
    const stamp = now()
    const previous = lastEdit
    lastEdit = stamp
    if (suppress || previous === undefined || stamp - previous > windowMs) {
      runStart = stamp
      return
    }
    if (runStart === undefined) {
      runStart = stamp
      return
    }
    if (stamp - runStart < windowMs) return
    runStart = stamp
    const current = history.current
    if (current === null) return
    history.undoStack.push({ ...current })
    history.redoStack.length = 0
    queueMicrotask(() => {
      editor.dispatchCommand(CAN_UNDO_COMMAND, true)
      editor.dispatchCommand(CAN_REDO_COMMAND, false)
    })
  }
  return mergeRegister(
    editor.registerCommand(UNDO_COMMAND, historyCommand, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(REDO_COMMAND, historyCommand, COMMAND_PRIORITY_CRITICAL),
    editor.registerNodeTransform(TextNode, noteEdit),
  )
}
