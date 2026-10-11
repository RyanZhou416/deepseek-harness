/** Demand-driven freshness and failure cooldowns for subscription metadata caches. */
import z from '@deepseek-ai/schemastery'

/** Freshness permits an explicit refresh; it never schedules background polling. */
export interface SubscriptionCachePolicy {
  /** Maximum age of an account's model catalogue before its next use may refresh it. */
  modelMaxAgeMs: number
  /** Maximum age of usage facts before an actual candidate needs confirmation. */
  usageMaxAgeMs: number
  /** Minimum delay after a failed metadata query; a longer server retry delay wins. */
  retryDelayMs: number
}

/** Configuration defaults for account-scoped metadata, not timer intervals. */
export const SubscriptionCacheSchema = z.object({
  modelMaxAgeMs: z.number().step(1).min(1).default(24 * 60 * 60_000),
  usageMaxAgeMs: z.number().step(1).min(1).default(5 * 60_000),
  retryDelayMs: z.number().step(1).min(1).default(60_000),
})

/**
 * Resolve cache policy before adapters or stores start work.
 * @param input - deployment overrides for the three demand checks.
 * @returns a complete policy with positive safe-integer durations.
 * @throws when a configured duration is invalid.
 */
export function resolveSubscriptionCachePolicy(input?: Partial<SubscriptionCachePolicy>): SubscriptionCachePolicy {
  const policy = SubscriptionCacheSchema(input ?? {})
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`subscriptions.cache.${key} must be a positive safe integer`)
    }
  }
  return policy
}
