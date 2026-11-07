/** Single-call executor fixture for the Session-addressed tool tests. @module */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** One model-requested call, run without root Session logging. */
export interface ModelToolCall {
  readonly callId: ToolCallId
  readonly name: string
  readonly arguments: unknown
  readonly signal: AbortSignal
  readonly agent?: Agent
}

/**
 * Invoke one model-requested call through the selected model executor.
 * @param ctx - context owning the selected executor.
 * @param call - call identity, JSON arguments, cancellation, and optional Agent scope.
 * @returns the single settled tool result.
 */
export async function executeModelTool(ctx: Context, call: ModelToolCall): Promise<ToolExecutionResult> {
  const encoded = JSON.stringify(call.arguments)
  if (encoded === undefined) throw new TypeError('model tool call arguments must encode as JSON')
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: call.callId, name: call.name, arguments: encoded }],
    signal: call.signal,
    ...call.agent === undefined ? {} : { agent: call.agent },
  })
  const outcome = batch.results[0]
  if (outcome === undefined) throw new Error('executor omitted the model tool result')
  return outcome.result
}
