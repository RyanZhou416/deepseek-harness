/**
 * Failure vocabulary shared by the AetherShell tools: one rendering for an
 * arbitrary caught value, and the structured abort a cancelled call throws so
 * the tool registry records cancellation instead of a result.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/errors
 */

import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Render a caught value as one diagnostic line.
 * @param error - the caught value, which need not be an `Error`.
 * @returns the `Error` message, or the value's string form.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The structured abort a cancelled call throws. The registry reads
 * {@link TOOL_ABORTED} to record an aborted invocation, so a cancelled call
 * never reaches the model as a successful value.
 * @returns the error to throw.
 */
export function toolAborted(): HarnessError {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED)
  error.name = 'AbortError'
  return error
}
