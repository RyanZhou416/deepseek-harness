/**
 * Function plugin registering the `turnOutline` projection unit: the
 * whole-log turn outline (turn number, `turn/start` seq, bounded prompt
 * preview) served through the session-projection seam — registry snapshot,
 * change feed, and every projection carrier — so a client can offer every
 * turn of a session and target history paging at exact seqs without holding
 * the events. The plugin owns only the fold; delivery is the seam's.
 *
 * @module @deepseek-ai/dsh-session-turn-outline
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createTurnOutlineProjectionDefinition, DEFAULT_HINT_TURNS } from './projection.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'session-turn-outline'
/** The projection registry is the plugin's whole purpose; without it the fiber stays pending. */
export const inject = ['sessionProjections']

/** Plugin configuration. */
export interface Config {
  /**
   * Newest outline items every Client payload carries (follow openings and
   * explicit reads); a Client reads older items by page. @default 200
   */
  hintTurns?: number
}

/** Configuration with its default applied by {@link Config}. */
export interface ResolvedConfig extends Config {
  /** Newest outline items every Client payload carries. */
  hintTurns: number
}

/** Validate the hint count and apply its default. */
export const Config: z<Config, ResolvedConfig> = z.object({
  hintTurns: z.natural().min(1).default(DEFAULT_HINT_TURNS),
})

/**
 * Register the `turnOutline` unit; the registration is an effect on this
 * plugin's fiber, so unloading removes the key.
 * @param ctx - registrant context carrying the projection registry.
 * @param config - validated hint count.
 * @returns when the plugin is ready.
 */
export async function apply(ctx: Context, config: ResolvedConfig): Promise<void> {
  await ctx.sessionProjections.register(createTurnOutlineProjectionDefinition(config.hintTurns))
}
