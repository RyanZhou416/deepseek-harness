/** Host loader entry for the browser runtime exported from `./client` and `./loader`. */

import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_LIVE_WINDOW_REBASE_EVENT_THRESHOLD,
  type Config as RuntimeConfig,
} from './config.ts'

/** Validated browser Session residency configuration. */
export type Config = RuntimeConfig

/** Runtime plugin configuration schema. */
export const Config: z<RuntimeConfig> = z.object({
  liveWindowRebaseEventThreshold: z.natural().min(1)
    .default(DEFAULT_LIVE_WINDOW_REBASE_EVENT_THRESHOLD),
})

/** Host plugin body — no host-side behavior for the runtime plugin. */
export function apply(_ctx: unknown): void {}
