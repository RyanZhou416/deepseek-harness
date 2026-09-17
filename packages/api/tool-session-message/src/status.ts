/** Durable status derivation for one Session-addressed message. */

import type { InboxTarget } from '@deepseek-ai/dsh-agent'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One durable delivery phase derived from the target Session log. */
export type SessionMessageState =
  | 'queued'
  | 'claimed'
  | 'model-context'
  | 'processing-tool'
  | 'completed'
  | 'rejected'
  | 'discarded'
  | 'unknown'

/** Current target activity that may delay a queued or admitted message. */
export type SessionMessageBlocking = 'none' | 'model' | 'tool' | 'terminal'

/** Durable message phase plus current open-turn tool activity. */
export interface DerivedSessionMessageStatus {
  readonly state: SessionMessageState
  readonly blocking: SessionMessageBlocking
  readonly activeTools: string[]
  readonly turn?: number
  readonly turnEndReason?: string
}

/**
 * Fold one target log to locate a message and any currently unresolved tools.
 * @param events - complete validated target Session log.
 * @param messageId - accepted message identity returned by `session_send_message`.
 * @param targetRunning - whether the target Agent currently reports running.
 * @returns the message phase and current blocking activity.
 */
export function deriveSessionMessageStatus(
  events: readonly SessionEvent[],
  messageId: MessageId,
  targetRunning: boolean,
): DerivedSessionMessageStatus {
  const inbox: Record<InboxTarget, UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  const activeTools = new Map<string, string>()
  const activePtcTools = new Map<string, string>()
  let currentTurn: number | undefined
  let messageTurn: number | undefined
  let state: SessionMessageState = 'unknown'
  let turnEndReason: string | undefined

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        currentTurn = event.data.turn
        activeTools.clear()
        activePtcTools.clear()
        break
      case 'agent/inbox/spliced': {
        const pending = inbox[event.data.target]
        const removed = pending.slice(event.data.start, event.data.start + (event.data.removedCount ?? 0))
        if (removed.some(message => message.id === messageId)) {
          messageTurn = currentTurn
          state = event.data.outcome === 'canceled' ? 'discarded' : 'claimed'
        }
        pending.splice(
          event.data.start,
          event.data.removedCount ?? 0,
          ...event.data.inserted,
        )
        if (event.data.inserted.some(message => message.id === messageId)) {
          state = 'queued'
          turnEndReason = undefined
        }
        break
      }
      case 'user/message':
        if (event.data.id === messageId) {
          state = 'model-context'
          messageTurn = currentTurn
        }
        break
      case 'tool/call':
        if (event.data.turn === currentTurn) activeTools.set(event.data.callId, event.data.name)
        break
      case 'tool/result':
        activeTools.delete(event.data.message.source.callId)
        break
      case 'tool/ptc-dispatch-start':
        if (currentTurn !== undefined) activePtcTools.set(event.data.subCallId, event.data.name)
        break
      case 'tool/ptc-dispatch':
        activePtcTools.delete(event.data.subCallId)
        break
      case 'turn/end':
        if (event.data.turn === messageTurn) {
          if (state === 'claimed') state = 'rejected'
          else if (state === 'model-context') state = 'completed'
          turnEndReason = event.data.reason.kind
        }
        if (event.data.turn === currentTurn) {
          currentTurn = undefined
          activeTools.clear()
          activePtcTools.clear()
        }
        break
      default:
        break
    }
  }

  const activeToolNames = [...activeTools.values(), ...activePtcTools.values()]
  const terminal = activeToolNames.includes('terminal_send')
  const blocking: SessionMessageBlocking = terminal
    ? 'terminal'
    : activeToolNames.length > 0
      ? 'tool'
      : targetRunning
        ? 'model'
        : 'none'
  const resolvedState = state === 'model-context' && activeToolNames.length > 0
    ? 'processing-tool'
    : state
  return {
    state: resolvedState,
    blocking,
    activeTools: activeToolNames,
    ...(messageTurn === undefined ? {} : { turn: messageTurn }),
    ...(turnEndReason === undefined ? {} : { turnEndReason }),
  }
}
