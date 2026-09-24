// Choose the preset before a fresh ChatGPT-routed child mounts its plugins.
'use strict'

module.exports = {
  name: 'chatgpt-subagent-preset',
  inject: ['agentPresets'],
  apply(ctx, config) {
    if (typeof config?.preset !== 'string' || config.preset.trim() === '') {
      throw new Error('chatgpt-subagent-preset: config.preset must be a non-empty string')
    }
    if (!Array.isArray(config.providers) || config.providers.some(value => typeof value !== 'string')) {
      throw new Error('chatgpt-subagent-preset: config.providers must be an array of strings')
    }
    if (typeof config.modelPattern !== 'string' || config.modelPattern === '') {
      throw new Error('chatgpt-subagent-preset: config.modelPattern must be a non-empty regex')
    }
    const presetId = config.preset
    const providers = config.providers
    const modelPattern = new RegExp(config.modelPattern, 'i')

    return ctx.on('subagent/child-preset', async ({ child }, next) => {
      const options = child.options ?? {}
      if (typeof options.provider === 'string' && providers.includes(options.provider)) return presetId
      if (typeof options.model === 'string' && modelPattern.test(options.model)) return presetId
      return next()
    })
  },
}
