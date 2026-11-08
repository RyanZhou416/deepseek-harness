/**
 * Live switch that tells interaction consumers no human is available to answer.
 *
 * @module @deepseek-ai/dsh-unattended-mode
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Live unattended-mode switch shared by interaction consumers. */
    unattendedMode: UnattendedModeService
  }
}

/** Deployment configuration for the switch. */
export interface Config {
  /** Whether no human is available to answer. Defaults to false. */
  enabled: Volatile<boolean>
}

/**
 * Tracks whether a human is available and notifies subscribers after a live
 * configuration update changes that answer.
 */
export default class UnattendedModeService extends Service {
  static Config = z.object({
    enabled: z.boolean().default(false).volatile(),
  })

  private readonly listeners = new Set<(enabled: boolean) => void>()
  /** State already delivered to subscribers, so an unrelated configuration update notifies nobody. */
  private delivered: boolean

  /**
   * @param ctx - Cordis context receiving the service.
   * @param config - live configuration; `enabled` is read again on every update.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'unattendedMode')
    this.delivered = config.enabled.get()
    ctx.on('loader/volatile-update', () => { this.refresh() })
    ctx.effect(() => () => { this.listeners.clear() })
  }

  /**
   * Read the current switch state.
   * @returns whether interaction consumers must assume no human can answer.
   */
  enabled(): boolean {
    return this.config.enabled.get()
  }

  /**
   * Observe switch changes.
   * @param listener - called with the new state after a live configuration update changes it.
   * @returns disposer removing the listener; safe to call more than once.
   */
  subscribe(listener: (enabled: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private refresh(): void {
    const enabled = this.enabled()
    if (enabled === this.delivered) return
    this.delivered = enabled
    for (const listener of [...this.listeners]) listener(enabled)
  }
}
