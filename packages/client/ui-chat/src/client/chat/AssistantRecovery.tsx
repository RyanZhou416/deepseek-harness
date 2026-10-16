import type { ReactNode } from 'react'
import type { AssistantBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { OccurrenceRecovery, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNode } from '../contract/chat-nodes.ts'

/**
 * Whitespace-preserving text container. Inline because the recovery renders
 * wherever the Chat seat does and owns no stylesheet rule of its own.
 */
const TEXT_STYLE = { whiteSpace: 'pre-wrap' } as const

/** Blocks whose content the plain-text recovery reproduces verbatim. */
function isPlainText(block: AssistantBlock): block is Extract<AssistantBlock, { kind: 'text' }> {
  return block.kind === 'text'
}

/**
 * Blocks that carry user-facing content the fallback cannot reproduce. Tool
 * protocol blocks and reasoning stay in neither group: neither is reply
 * content, and the fallback never exposes them.
 */
function isUnavailableContent(block: AssistantBlock): boolean {
  return block.kind === 'image' || block.kind === 'other'
}

/**
 * Plain-text recovery for one failed Assistant occurrence: the current text
 * blocks as literal React text, a localized rich-render notice, and an
 * explicit indicator when user-facing non-text content cannot be shown.
 * Reasoning keeps only its notice — its text is never reproduced.
 * @param props - the failed node, its grouped portion, and the Chat translate seat.
 * @returns the recovered occurrence body.
 */
export function AssistantRecoveryFallback({ node, groupPart, t }: {
  node: ChatNode<'assistant-step'>
  groupPart: string | undefined
  t: TranslateNS<'chat'>
}): ReactNode {
  if (groupPart === 'reasoning') return <div>{t('message.renderFallback.reasoning')}</div>
  const text = node.data.blocks.filter(isPlainText)
  const unavailable = node.data.blocks.some(isUnavailableContent)
  return (
    <>
      {text.length === 0 ? null : (
        <div style={TEXT_STYLE}>
          {text.map((block, index) => <div key={index}>{block.text}</div>)}
        </div>
      )}
      <div>{t('message.renderFallback.notice')}</div>
      {unavailable ? <div>{t('message.renderFallback.unavailable')}</div> : null}
    </>
  )
}

/**
 * Build the occurrence recovery payload for one rendered Assistant seat.
 *
 * The reset key is an unambiguous serialized tuple of the Node key, the
 * grouped portion (or its explicit absent marker), and a tagged reply
 * generation: `['running']` until a durable settlement, then
 * `['message', id]`, or `['interrupted', seq]` for a synthetic interruption.
 * The generation is tagged rather than a bare sentinel so a durable message id
 * that happens to read `running` cannot collide with an unsettled reply. A
 * same-Step retry therefore keeps showing current plain text without
 * re-invoking a renderer already known to fail, while a durable settlement
 * retries rich rendering exactly once.
 * @param node - the Assistant node this seat renders.
 * @param groupPart - the node portion this occurrence renders, when grouped.
 * @param t - Chat translate seat carried into the fallback.
 * @returns the fallback and generation key for `renderSlot` occurrence recovery.
 */
export function assistantOccurrenceRecovery(
  node: ChatNode<'assistant-step'>,
  groupPart: string | undefined,
  t: TranslateNS<'chat'>,
): OccurrenceRecovery {
  const finalNode = node.data.finalNode
  const generation: readonly (string | number)[] = finalNode === undefined
    ? ['running']
    : finalNode.messageId !== undefined
      ? ['message', String(finalNode.messageId)]
      : ['interrupted', finalNode.seq]
  return {
    fallback: <AssistantRecoveryFallback node={node} groupPart={groupPart} t={t} />,
    resetKey: JSON.stringify([node.key, groupPart ?? null, generation]),
    retryDomMutation: true,
  }
}
