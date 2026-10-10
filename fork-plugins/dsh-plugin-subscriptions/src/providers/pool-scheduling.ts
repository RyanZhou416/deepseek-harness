/** Bounded quota preferences and concurrent-account load for automatic pools. */
import z from '@deepseek-ai/schemastery'
import type { ConcretePoolMember } from './pool-family.js'
import type { MemberQuota } from './pool-usage.js'

/** Deployment-owned weights and lookahead windows for quota-aware selection. */
export interface PoolSchedulingPolicy {
  /** Short-window reset lookahead in milliseconds. */
  sessionResetHorizonMs: number
  /** Weekly-window reset lookahead in milliseconds. */
  weeklyResetHorizonMs: number
  /** Other-window reset lookahead in milliseconds. */
  otherResetHorizonMs: number
  /** Maximum additive preference for an approaching Claude or ChatGPT reset. */
  resetWeight: number
  /** ChatGPT remaining percentage at which gradual quota finishing begins; zero disables it. */
  codexDrainBelowPercent: number
  /**
   * Claude session-window percentage at which an account stops being selectable.
   *
   * The floor is a reserve, not a report: an account at or above it is left out of selection
   * entirely, so a turn never starts on a window that is about to close.
   */
  claudeSessionPercentFloor: number
  /** Claude weekly-window percentage at which an account stops being selectable. */
  claudeWeeklyPercentFloor: number
  /** Maximum additive ChatGPT finishing preference. */
  codexDrainWeight: number
  /** Finite bonus for the existing fresh-week and expiring-reset-credit condition. */
  freshCreditWeight: number
  /** Per-active-request penalty in the divisor 1 + weight * account load. */
  loadPenalty: number
}

/** Schema also used by explicit policy resolution before constructing the pool. */
export const PoolSchedulingSchema = z.object({
  sessionResetHorizonMs: z.number().step(1).min(1).default(60 * 60_000),
  weeklyResetHorizonMs: z.number().step(1).min(1).default(24 * 60 * 60_000),
  otherResetHorizonMs: z.number().step(1).min(1).default(24 * 60 * 60_000),
  resetWeight: z.number().min(0).default(2),
  codexDrainBelowPercent: z.number().min(0).max(100).default(10),
  claudeSessionPercentFloor: z.number().min(0).max(100).default(50),
  claudeWeeklyPercentFloor: z.number().min(0).max(100).default(89),
  codexDrainWeight: z.number().min(0).default(2),
  freshCreditWeight: z.number().min(0).default(0.5),
  loadPenalty: z.number().min(0).default(1),
})

/**
 * Resolve and validate every scheduling choice before requests can use it.
 * @param input - optional deployment overrides.
 * @returns complete finite scheduling policy.
 */
export function resolvePoolScheduling(input: Partial<PoolSchedulingPolicy> = {}): PoolSchedulingPolicy {
  const policy = PoolSchedulingSchema(input)
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isFinite(value)) throw new Error(`pool.scheduling.${key} must be finite`)
  }
  if (!Number.isFinite(1 + policy.resetWeight + policy.codexDrainWeight + policy.freshCreditWeight)) {
    throw new Error('pool.scheduling combined weights must be finite')
  }
  return policy
}

/**
 * Score one member with bounded preferences in the same units as normalized urgency.
 * @param member - exact account/model being considered.
 * @param quota - current model-scoped quota facts.
 * @param maxUrgency - greatest raw urgency in this availability band.
 * @param active - outstanding requests on this provider/account across its model pools.
 * @param policy - validated deployment choices.
 * @param now - selection time shared by all candidate scores.
 * @returns nonnegative score; a band without usable urgency shares a unit baseline.
 */
export function poolSchedulingScore(
  member: ConcretePoolMember, quota: MemberQuota, maxUrgency: number, active: number,
  policy: PoolSchedulingPolicy, now: number,
): number {
  let score = maxUrgency > 0 ? quota.urgency / maxUrgency : 1
  let bonus = 0
  const windows = quota.windows ?? []
  if (member.provider === 'claude' || member.provider === 'codex') {
    let reset = 0
    for (const window of windows) {
      if (window.resetsAt === undefined || window.resetsAt <= now || window.usedPercent >= 100) continue
      const horizon = window.kind === 'session' ? policy.sessionResetHorizonMs
        : window.kind === 'weekly' ? policy.weeklyResetHorizonMs : policy.otherResetHorizonMs
      reset = Math.max(reset, Math.max(0, 1 - (window.resetsAt - now) / horizon))
    }
    bonus += reset * policy.resetWeight
  }
  if (member.provider === 'codex' && quota.available) {
    const remaining = windows.reduce((minimum, window) => Math.min(minimum, 100 - window.usedPercent), 100)
    if (remaining > 0 && remaining < policy.codexDrainBelowPercent && policy.codexDrainWeight > 0) {
      const fraction = remaining / policy.codexDrainBelowPercent
      // Fade the ample-quota preference during finishing, including when every account is nearly empty.
      score *= fraction
      bonus += (1 - fraction) * policy.codexDrainWeight
    }
  }
  if (quota.preferFreshCredit === true) bonus += policy.freshCreditWeight
  return (score + bonus) / (1 + policy.loadPenalty * active)
}
