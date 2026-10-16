/**
 * The complete-result bound: the one check that decides whether a produced
 * result may reach the model at all, and what happens when it may not.
 *
 * Acquisition bounds each interpreter stream; this bound measures what the tool
 * would hand back, so a value small enough to be read but too large to be useful
 * never arrives partially delivered. Three settlements exist, in this order. A
 * result inside the budget is returned unchanged. A result over it is handed to
 * the caller-supplied retention when the exchange produced a value from a
 * successful process and the deployment can hold one, and the retained arm that
 * produces is then measured exactly like any other complete result — including
 * the interpreter's own metadata and diagnostic stream — so a payload that is
 * still too large after retention, such as one whose bulk was a huge `stderr`,
 * cannot be presented as a success. Everything else becomes one concise failure
 * naming the narrowing remedy.
 *
 * The failure keeps the recovery pointer to any spilled diagnostic stream but
 * drops the stream itself, because that stream is part of what overflowed.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/limit
 */

import type { AetherErrorOutcome, AetherOutcome, AetherRetainedOutcome, AetherValueOutcome } from './outcome.ts'
import { recovery } from './outcome.ts'
import { renderOutcome } from './render.ts'

/** Error code reported when a produced result exceeds the complete-result budget. */
export const RESULT_LIMIT_CODE = 'E_RESULT_LIMIT'

/**
 * One retained value a caller may publish in place of an oversized result.
 *
 * `discard` exists for the one case where the retained arm itself does not fit
 * the budget: the value is already stored when this bound measures it, so the
 * caller gives it back rather than leaving an identity the model never received.
 */
export interface AetherRetentionClaim {
  /** The retained arm to return in place of the oversized value. */
  readonly outcome: AetherRetainedOutcome
  /** Release the value this claim stored; called only when the claim cannot be published. */
  discard(): void
}

/**
 * How one tool turns an oversized produced value into a retained one.
 *
 * A tool that supplies this states that this deployment can hold a value for
 * later paging. `retain` returns undefined when it cannot, and the bound then
 * falls back to the coded limit failure.
 */
export interface AetherRetention {
  /**
   * Retain one oversized value.
   * @param outcome - the produced value that did not fit the budget.
   * @returns the retained arm and its release, a stated refusal, or undefined when retention is unavailable.
   */
  retain(outcome: AetherValueOutcome): AetherRetentionClaim | { readonly reason: string } | undefined
}

/**
 * The limit failure for one oversized outcome, reporting the sandbox, process,
 * and diagnostic facts of the call that overflowed.
 * @param outcome - the oversized outcome.
 * @param over - the measured overflow description.
 * @returns the canonical range failure.
 */
function limitFailure(outcome: AetherOutcome, over: string): AetherErrorOutcome {
  const spillPath = outcome.stderr.spillPath
  return {
    kind: 'error',
    error: {
      code: RESULT_LIMIT_CODE,
      message: over,
      hint: 'narrow the request instead of returning the value whole: project it inside aether_pipeline with select or take, page aether_discover with offset and limit, or read less in one call. Release unneeded retained results with aether_result_page and drop:true if storage is full. The operation may already have had effects; do not rerun it automatically.',
      retryable: false,
    },
    sandbox: outcome.sandbox,
    process: outcome.process,
    stderr: {
      text: '',
      truncated: outcome.stderr.truncated,
      ...spillPath === undefined ? {} : { spillPath },
    },
  }
}

/**
 * Whether an exchange is eligible for retention: a successful process that
 * produced a value.
 *
 * A failed, refused, interrupted, or truncated exchange is never retained,
 * because the value it produced cannot be trusted as the whole result; those
 * keep the coded failure they already carry.
 * @param outcome - a value arm the interpreter reported as successful.
 * @returns true when the process exited zero.
 */
function retains(outcome: AetherValueOutcome): boolean {
  return outcome.process.exitCode === 0
}

/**
 * Bound one produced result.
 *
 * The three-argument form is the whole contract for a tool whose oversized
 * results must fail. `aether_discover` uses it because a discovery page is
 * already bounded by its own entry budget, and a retained ontology payload would
 * invite paging a document instead of asking a narrower question.
 * @param outcome - the projected canonical outcome.
 * @param rendered - the exact text the outcome's renderer produces.
 * @param maxResultBytes - the deployment's complete-result budget in bytes.
 * @returns the same outcome, or a concise limit failure when either measurement exceeds the budget.
 */
export function applyResultLimit<T extends AetherOutcome>(
  outcome: T,
  rendered: string,
  maxResultBytes: number,
): T | AetherErrorOutcome
/**
 * Bound one produced result, retaining an oversized value when the caller says
 * this deployment can hold one.
 * @param outcome - the projected canonical outcome.
 * @param rendered - the exact text the outcome's renderer produces.
 * @param maxResultBytes - the deployment's complete-result budget in bytes.
 * @param retention - how to retain an oversized produced value, or undefined to fail instead.
 * @returns the same outcome, the retained arm, or a concise limit failure.
 */
export function applyResultLimit<T extends AetherOutcome>(
  outcome: T,
  rendered: string,
  maxResultBytes: number,
  retention: AetherRetention | undefined,
): T | AetherRetainedOutcome | AetherErrorOutcome
export function applyResultLimit<T extends AetherOutcome>(
  outcome: T,
  rendered: string,
  maxResultBytes: number,
  retention?: AetherRetention,
): T | AetherRetainedOutcome | AetherErrorOutcome {
  const measured = Math.max(
    Buffer.byteLength(JSON.stringify(outcome), 'utf8'),
    Buffer.byteLength(rendered, 'utf8'),
  )
  if (measured <= maxResultBytes) return outcome
  const over = `the result is ${measured} bytes, over the maxResultBytes budget of ${maxResultBytes}${recovery(outcome.stderr.spillPath)}`
  if (retention === undefined || outcome.kind !== 'value' || !retains(outcome)) {
    return limitFailure(outcome, over)
  }
  const claim = retention.retain(outcome)
  if (claim === undefined) return limitFailure(outcome, over)
  if ('reason' in claim) return limitFailure(outcome, `${over}; result retention unavailable: ${claim.reason}`)
  const retained = Math.max(
    Buffer.byteLength(JSON.stringify(claim.outcome), 'utf8'),
    Buffer.byteLength(renderOutcome(claim.outcome), 'utf8'),
  )
  if (retained > maxResultBytes) {
    // The value is already held, so an identity the model will never learn about
    // is given back instead of being left behind.
    claim.discard()
    return limitFailure(outcome, `the retained result is ${retained} bytes, over the maxResultBytes budget of ${maxResultBytes}`)
  }
  return claim.outcome
}
