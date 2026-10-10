import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Tool names owned by this plugin and their collision fallbacks. */
export const TOOL_ALIASES = {
  x_search: 'dsh_subscriptions_x_search',
  video_generate: 'dsh_subscriptions_video_generate',
  image_generate: 'dsh_subscriptions_image_generate',
} as const

interface ToolRegistry {
  register(definition: ToolDefinition): () => void
}

/**
 * Register a tool under its canonical name, then a plugin-scoped alias.
 * @param registry - tool registry that owns disposal of the registration.
 * @param definition - tool to register under its own `name` when that name is free.
 * @param warn - sink for the collision diagnostic when neither name is free.
 * @returns the name the tool registered under, or undefined when both names are taken.
 */
export function registerWithAlias(
  registry: ToolRegistry,
  definition: ToolDefinition,
  warn: (message: string) => void = message => console.warn(message),
): string | undefined {
  try {
    registry.register(definition)
    return definition.name
  } catch (error) {
    const alias = TOOL_ALIASES[definition.name as keyof typeof TOOL_ALIASES]
    if (alias === undefined) throw error
    try {
      registry.register({ ...definition, name: alias })
      return alias
    } catch (aliasError) {
      warn(`dsh-plugin-subscriptions: tool ${JSON.stringify(definition.name)} and alias ${JSON.stringify(alias)} are already registered; skipping (${aliasError instanceof Error ? aliasError.message : String(aliasError)})`)
      return undefined
    }
  }
}
