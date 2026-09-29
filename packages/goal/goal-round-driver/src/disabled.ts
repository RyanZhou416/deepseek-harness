/** Suppress queued Goal input when a deployment disables Goal execution. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'goal-disabled'
export const inject = ['agents']

const goalSources = new Set(['goal', 'tool-goal'])

/**
 * Keep restored Goal rounds and their closing notices out of new model requests.
 * @param ctx - Agent lifecycle context owning the admission listener.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ messages: proposed }, next) => {
    if (proposed.length > 0 && proposed.every(message => goalSources.has(message.source.kind))) return { kind: 'reject' }
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const messages = decision.messages.filter(message => !goalSources.has(message.source.kind))
    return messages.length === decision.messages.length ? decision : { ...decision, messages }
  })
}
