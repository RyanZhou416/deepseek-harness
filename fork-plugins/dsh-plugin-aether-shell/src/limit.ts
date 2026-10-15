/**
 * The complete-result bound: the one check that decides whether a produced
 * result may reach the model at all.
 *
 * Acquisition bounds each interpreter stream; this bound measures what the tool
 * would hand back, so a value small enough to be read but too large to be
 * useful becomes one concise failure naming the narrowing remedy instead of a
 * partially delivered payload. The failure keeps the recovery pointer to any
 * spilled diagnostic stream but drops the stream itself, because that stream is
 * part of what overflowed.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/limit
 */

import type { AetherErrorOutcome, AetherOutcome } from './outcome.ts'
import { recovery } from './outcome.ts'

/** Error code reported when a produced result exceeds the complete-result budget. */
export const RESULT_LIMIT_CODE = 'E_RESULT_LIMIT'

/**
 * Bound one produced result.
 * @param outcome - the projected canonical outcome.
 * @param rendered - the exact text the outcome's renderer produces.
 * @param maxResultBytes - the deployment's complete-result budget in bytes.
 * @returns the same outcome, or a concise limit failure when either measurement exceeds the budget.
 */
export function applyResultLimit<T extends AetherOutcome>(
  outcome: T,
  rendered: string,
  maxResultBytes: number,
): T | AetherErrorOutcome {
  const measured = Math.max(
    Buffer.byteLength(JSON.stringify(outcome), 'utf8'),
    Buffer.byteLength(rendered, 'utf8'),
  )
  if (measured <= maxResultBytes) return outcome
  const limited: AetherErrorOutcome = {
    kind: 'error',
    error: {
      code: RESULT_LIMIT_CODE,
      message: `the result is ${measured} bytes, over the maxResultBytes budget of ${maxResultBytes}${recovery(outcome.stderr.spillPath)}`,
      hint: 'narrow the request instead of returning the value whole: project it inside aether_pipeline with select or take, page aether_discover with offset and limit, or read less in one call.',
      retryable: false,
    },
    sandbox: outcome.sandbox,
    process: outcome.process,
    stderr: {
      text: '',
      truncated: outcome.stderr.truncated,
      ...outcome.stderr.spillPath === undefined ? {} : { spillPath: outcome.stderr.spillPath },
    },
  }
  return limited
}
