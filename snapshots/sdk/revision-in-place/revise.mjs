/** Convert the second SDK prompt into a same-session revision through the durable inbox. */
export const name = 'sdk-revision-fixture'
export const inject = ['sessionProjections', 'systemPrompt']
export function apply(ctx, config = {}) {
  if (config.isolatePrompt === true) {
    ctx.effect(() => ctx.systemPrompt.section({ name: 'revision-fixture', order: 0, text: 'Answer the current user briefly.' }))
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      const tools = assembled.tools.filter(tool => tool.name === 'read')
      if (tools.length !== 1) throw new Error('revision fixture requires the portable read tool')
      return { ...assembled, sections: assembled.sections.filter(section => section.name === 'revision-fixture'), contexts: [], tools }
    })
  }
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const text = message.content.length === 1 && message.content[0].type === 'text' ? message.content[0].text : undefined
    if (message.source.kind !== 'user' || text !== 'REVISED_QUESTION' || 'replacesUserMessage' in message.source) return
    const original = ctx.sessionProjections.stateOf(agent.session, 'userInput').latest
    if (original === null) throw new Error('revision fixture has no original prompt')
    agent.inbox.replace(message.id, Object.freeze({
      ...message,
      source: Object.freeze({ ...message.source, replacesUserMessage: original.seq }),
    }))
  })
  ctx.on('llm/stream', (options, next) => {
    const human = options.messages.filter(message => message.role === 'user' && message.source?.kind === 'user')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
    if (human.includes('REVISED_QUESTION')) {
      const full = JSON.stringify(options.messages)
      if (full.includes('ORIGINAL_QUESTION') || full.includes('ORIGINAL_REPLY')) throw new Error('revision leaked obsolete context')
    }
    return next()
  })
}
