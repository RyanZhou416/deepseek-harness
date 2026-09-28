import type { Context } from '@deepseek-ai/cordis'
import type {
  ContextMessageNode, ConversationNodeDefinition, SteeringMessageNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { InboxState } from './inbox.ts'
import { chatNode } from './common.ts'
import { contextForm, contextProducer } from './event-projection.ts'

interface ReferencedUserMessageNode extends UserMessageNode {
  /** Labels cited by the immediately following session-reference context. */
  readonly referenceLabels?: readonly string[]
  /** Skill names the same step's `skill-invocation` injections loaded. */
  readonly skillNames?: readonly string[]
  /** Original conversation rows superseded by this committed revision. */
  readonly editedRange?: { readonly start: number; readonly before: number }
}

interface ReferencedSteeringMessageNode extends SteeringMessageNode {
  /** Labels cited by the immediately following session-reference context. */
  readonly referenceLabels?: readonly string[]
  /** Skill names the same step's `skill-invocation` injections loaded. */
  readonly skillNames?: readonly string[]
}

type MessageNode = ReferencedUserMessageNode | ReferencedSteeringMessageNode | (ContextMessageNode & { readonly waking?: boolean })

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Ordinary turn-opening user message. */
    user: ReferencedUserMessageNode
    /** User message admitted into an active turn. */
    steering: ReferencedSteeringMessageNode
    /** Non-user context injected into model history. */
    context: ContextMessageNode
    /** Non-human input that starts a Turn. */
    'turn-trigger': ContextMessageNode
  }
}

function isCompactionCheckpoint(event: Parameters<ConversationNodeDefinition['match']>[0]): boolean {
  if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event)) return false
  const source = event.data.source as { kind?: unknown }
  return source.kind === 'compact-checkpoint'
}

/** User, steering, and injected-context message classification Definition. */
export const messageDefinition: ConversationNodeDefinition<MessageNode> = {
  kind: 'input-message',
  target: 'chat',
  match: (event) => {
    if (event.type === 'user/message') {
      return (isAppendSurfaceEvent(event) || isHumanRevision(event)) && !isCompactionCheckpoint(event)
        ? { id: isHumanRevision(event) && 'replacesUserMessage' in event.data.source
          ? `revision:${String(event.data.source.replacesUserMessage)}` : String(event.data.id), role: 'start' }
        : null
    }
    // Developer history is persisted for V4; presentation is intentionally deferred.
    if (event.type === 'developer/message') throw new Error('Chat developer messages are not supported yet')
    return null
  },
  start: (_context, match, reader) => {
    if (match.event.type !== 'user/message') throw new Error('input-message start requires user/message')
    const event = match.event
    if (event.data.source.kind !== 'user') {
      const nextTurn = reader.previous<InboxState>('inbox-next-turn')?.state
      const nextStep = reader.previous<InboxState>('inbox-next-step')?.state
      const location = match.location
      const turnStart = location.kind === 'step' ? location.turn.start?.seq : undefined
      // An idle steer opens Step 1 without a next-turn claim in this Turn.
      // A human in that same next-step claim owns the opening instead of its notices.
      const idleSteer = location.kind === 'step' && location.step.step === 1
        && turnStart !== undefined && (nextStep?.claimSeq ?? -1) > turnStart
        && (nextTurn?.claimSeq ?? -1) < turnStart && nextStep?.claimedHuman === false
        && nextStep.currentClaimed.has(String(event.data.id))

      return {
        kind: 'context',
        waking: nextTurn?.currentClaimed.has(String(event.data.id)) === true || idleSteer,
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        producer: contextProducer(event.data.source),
        form: contextForm(event.data.source),
      }
    }
    const claimed = reader.previous<InboxState>('inbox-next-step')
      ?.state.currentClaimed.has(String(event.data.id)) === true
    return claimed
      ? {
        kind: 'steering',
        messageId: event.data.id,
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
      }
      : {
        kind: 'user',
        ...(isHumanRevision(event) && event.surfaceOp !== 'append' ? {
          editedRange: {
            start: event.surfaceOp.startSeq,
            before: match.location.kind === 'step' || match.location.kind === 'turn' ? match.location.turn.start?.seq ?? event.seq : event.seq,
          },
        } : {}),
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
      }
  },
  update: (context, match) => {
    if (context.state.kind !== 'user' || match.event.type !== 'user/message' || !isHumanRevision(match.event)) return context.state
    return { ...context.state, seq: match.event.seq, time: match.event.time,
      content: match.event.data.content, source: match.event.data.source }
  },
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const waking = context.state.kind === 'context'
      && context.start?.event.type === 'user/message'
      && context.state.waking === true
    const revision = context.state.kind === 'user' && context.state.editedRange !== undefined
    const anchorSeq = revision ? context.start?.event.seq ?? context.state.seq : context.state.seq
    return chatNode(context, waking ? 'turn-trigger' : context.state.kind, anchorSeq, context.state,
      revision
        ? { location: context.matches.at(-1)?.location ?? context.start?.location ?? { kind: 'unresolved' } } : {})
  },
}

/**
 * Register the user, steering, and injected-context message contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerMessageConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(messageDefinition)
}

/** Human revisions are visible prompts; other surface replacements remain model-only. */
function isHumanRevision(event: Parameters<ConversationNodeDefinition['match']>[0]): boolean {
  return event.type === 'user/message' && isReplacementSurfaceEvent(event)
    && event.data.source.kind === 'user' && 'replacesUserMessage' in event.data.source
}
