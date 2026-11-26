/**
 * Failures this plugin raises with a code the Host does not define.
 *
 * The Host's `LlmError` constructor accepts only {@link BuiltinLlmFailureCode}
 * values, so a plugin-defined code (a Claude service refusal, a credential-store
 * busy state, a policy rejection) enters through `LlmError.fromFailure`, which
 * keeps the code and every provider fact on the error and on its serializable
 * `failure`. Two error types in this plugin are classes so callers can test
 * them with `instanceof`; a constructor must call `super` before it can reach
 * `fromFailure`, so those types declare their code through {@link PluginCodeError}.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { BuiltinLlmFailureCode, LlmErrorOptions } from '@deepseek-ai/dsh-llm'

/**
 * Raise a failure carrying one of this plugin's own codes.
 * @param message - non-empty human-readable failure summary.
 * @param code - the plugin's stable machine-routing code.
 * @param options - optional cause and validated provider facts.
 * @returns the error to throw, carrying the same code and facts.
 */
export function pluginLlmError(message: string, code: string, options?: LlmErrorOptions): LlmError {
  const { cause, ...facts } = options ?? {}
  return LlmError.fromFailure({ message, code, ...facts }, cause === undefined ? undefined : { cause })
}

/**
 * Base class for this plugin's own error types, which carry a plugin code and
 * stay testable with `instanceof`.
 *
 * A derived constructor cannot return an error built by
 * {@link pluginLlmError}, so the code is asserted once here. The assertion is
 * equivalent to the one `LlmError.fromFailure` performs, and the constructor
 * validates the code at runtime the same way: any non-empty string is accepted
 * and stored on the error and on its `failure`.
 */
export abstract class PluginCodeError extends LlmError {
  /**
   * @param message - non-empty human-readable failure summary.
   * @param code - the plugin's stable machine-routing code.
   * @param options - optional cause and validated provider facts.
   */
  constructor(message: string, code: string, options?: LlmErrorOptions) {
    super(message, code as BuiltinLlmFailureCode, options)
  }
}
