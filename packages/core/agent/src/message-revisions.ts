/** Profile-independent preparation and final admission of human-message revisions. */
import type { Context } from '@deepseek-ai/cordis'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { UserInputProjection } from './types.ts'

/**
 * Save revised text before context assembly, then finalize its processed content at request admission.
 * @param ctx - Agent registry owner; both listeners follow that owner's lifetime.
 */
export function installUserMessageRevisions(ctx: Context): void {
  ctx.on('agent/prepare-input', ({ agent, messages }, next) => {
    for (const message of messages) {
      const source = message.source
      if (source.kind !== 'user' || !('replacesUserMessage' in source)) continue
      const session = agent.session
      const nodes = session.surface.nodes
      const target = requiredUserInput(ctx, session).latest?.seq
      if (target === undefined || target !== source.replacesUserMessage || !nodes.includes(target)) {
        throw new Error('The revised prompt is no longer the latest current user message')
      }
      const shadowed = nodes.slice(nodes.indexOf(target))
      session.append('user/message', freezeMessage({ ...message, source: { ...source, pendingRevision: true } }), {
        surfaceOp: { op: 'replace', startSeq: target, endSeq: shadowed[shadowed.length - 1] as SessionSeq },
        sourceEventSeqs: shadowed,
      })
    }
    next()
  })
  ctx.on('agent/message-surface', ({ agent, message }, next) => {
    const fallback = next()
    const source = message.source
    if (source.kind !== 'user' || !('replacesUserMessage' in source)) return fallback
    const pending = requiredUserInput(ctx, agent.session).pending
    const draft = pending?.replaces === source.replacesUserMessage && agent.session.surface.nodes.includes(pending.seq)
      ? pending.seq : undefined
    if (draft === undefined) throw new Error('The pending user revision is no longer in the current history')
    return { surfaceOp: { op: 'replace', startSeq: draft, endSeq: draft }, sourceEventSeqs: [draft] }
  })
}

/** Revision processing requires the loop's registered whole-log input projection. */
function requiredUserInput(ctx: Context, session: Session): UserInputProjection {
  const state = ctx.sessionProjections.stateOf(session, 'userInput')
  if (state === undefined) throw new Error('User revision requires the userInput projection')
  return state
}
