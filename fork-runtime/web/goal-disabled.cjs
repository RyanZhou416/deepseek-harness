'use strict'

/**
 * Suppress restored Goal input when a deployment disables Goal execution.
 * Kept local to the portable profile so the plugin resolves without a direct
 * profile dependency on `@deepseek-ai/dsh-goal-round-driver`.
 */
const GOAL_SOURCES = new Set(['goal', 'tool-goal'])

module.exports = {
  name: 'goal-disabled',
  inject: ['agents'],
  apply(ctx) {
    ctx.on('agent/pre-step', async ({ messages: proposed }, next) => {
      if (proposed.length > 0 && proposed.every(message => GOAL_SOURCES.has(message.source.kind))) {
        return { kind: 'reject' }
      }
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const messages = decision.messages.filter(message => !GOAL_SOURCES.has(message.source.kind))
      return messages.length === decision.messages.length ? decision : { ...decision, messages }
    })
  },
}
