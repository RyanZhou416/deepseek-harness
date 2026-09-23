/**
 * The assistant-message action that opens the Context view at this reply's
 * turn. Registered on the harness `conversation.chat.assistant-actions` seat
 * (the icon row beside copy/branch), it receives the finalized reply's durable
 * message id, resolves the matching assistant node's seq off the `useChat`
 * node seat AT RENDER TIME (the seat is a real React hook — render-only; a
 * click-time read throws the dispatcher guard and the jump would land
 * unpinned), records it in the viewFocus relay on click, and opens the
 * Context tab on the right Sidebar — where the jump pins the reply's TURN
 * (see contextView's leg 2). A harness or placement without the sidebar tab
 * falls back to the conversation tab; an unresolvable seq still opens the
 * view, just without a pin; a message id that is not a plain string renders
 * nothing at all.
 */

import { type ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientCtx, ConversationNodeLike, UseChatLike } from '../services'
import { conversationNodesOf } from '../services'
import { activateContextTab, openContextSidebar, requestContextFocus } from '../viewFocus'
import type { ViewKit } from '../viewkit'

/** The assistant-action seat's currency, as far as this button consumes it. */
export interface ContextJumpProps {
  messageId?: unknown
  sessionId?: unknown
  useChat?: UseChatLike
}

/**
 * The reply's request seq by its durable message id, or null when no served node proves the pair. Join/log nodes are untrusted input: each
 * element is isolated, so one hostile object that throws on property access is skipped — the jump keeps its pin, never its click.
 */
export function seqOfMessageId(nodes: readonly ConversationNodeLike[] | undefined, messageId: string): number | null {
  for (const node of nodes ?? []) {
    try {
      if (node.kind !== 'assistant' || node.messageId !== messageId) continue
      return typeof node.seq === 'number' && Number.isFinite(node.seq) ? node.seq : null
    } catch {
      continue
    }
  }
  return null
}

/** The jump glyph: the plugin's mini stacked composition bars, same 16px outline family as the shipped row icons. */
function JumpIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="fill-none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="2" rx="1" className="fill-current" />
      <rect x="2" y="7" width="8.5" height="2" rx="1" className="fill-current" />
      <rect x="2" y="11" width="5.5" height="2" rx="1" className="fill-current" />
    </svg>
  )
}

export function makeContextJumpButton(ctx: ClientCtx, kit: ViewKit): (props: ContextJumpProps) => ReactElement | null {
  const { t } = kit
  return function ContextJump(props: ContextJumpProps): ReactElement | null {
    // The seat is read HERE — unconditionally and first, so the early return
    // below keeps hook order — and the click consumes the captured pair.
    const nodes = conversationNodesOf(props)
    const messageId = props.messageId
    // Interruption-frozen partials address no durable message — the owner
    // already withholds them, and anything else non-string is ignored.
    if (typeof messageId !== 'string' || messageId === '') return null
    const seq = seqOfMessageId(nodes, messageId)
    const jump = (): void => {
      const sessionId = props.sessionId
      if (seq !== null && typeof sessionId === 'string' && sessionId !== '') {
        requestContextFocus(sessionId, seq)
      }
      // The sidebar expands over the chat, keeping the clicked reply in view;
      // a harness or placement without that tab keeps the tab activation.
      if (!openContextSidebar(ctx)) activateContextTab(t('tab'))
    }
    return (
      <Tooltip label={t('jump.title')} side="bottom">
        <button type="button" className="lc-jump hover:bg-(--dsw-alias-interactive-bg-hover) hover:text-(--dsw-alias-label-secondary)" aria-label={t('jump.title')} onClick={jump}>
          <JumpIcon />
        </button>
      </Tooltip>
    )
  }
}
