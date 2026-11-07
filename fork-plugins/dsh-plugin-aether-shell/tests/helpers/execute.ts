/**
 * Model-call execution against the composition's selected tool executor.
 *
 * Host builds since 0.2.2 no longer execute tool calls inside the tool
 * registry: a batch executor plugin owns argument decoding, policy and
 * scheduling, and the registry delegates a complete model batch to it. These
 * suites drive one model call at a time, so this fixture keeps the expression
 * the old single-call registry entry point gave them while using the same
 * batch input and result selection a real model step produces.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ResolvedToolSet, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** One model call the suites execute through the selected executor. */
export interface ModelToolCall {
  /** Provider-issued call identity correlated with the returned result. */
  readonly callId: ToolCallId
  /** Registered tool name. */
  readonly name: string
  /** Lossless JSON arguments, serialized the way a model reply carries them. */
  readonly arguments: unknown
  /** Cancellation signal for the whole batch. */
  readonly signal: AbortSignal
  /** Calling Agent that supplies scope and execution context. */
  readonly agent?: Agent
  /** Step admission; omitted admits only unconditional registrations. */
  readonly toolSet?: ResolvedToolSet
}

/**
 * Execute one model tool call through the registry's selected executor.
 * @param ctx - context owning the tool registry and its executor plugin.
 * @param call - the single call, its JSON arguments, and optional owner.
 * @returns the settled result of that call.
 * @throws TypeError when the arguments cannot be encoded as model JSON.
 * @throws Error when the executor omits the settled result.
 */
export async function executeToolCall(ctx: Context, call: ModelToolCall): Promise<ToolExecutionResult> {
  const encoded = JSON.stringify(call.arguments)
  if (encoded === undefined) throw new TypeError('model tool call arguments must encode as JSON')
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: call.callId, name: call.name, arguments: encoded }],
    signal: call.signal,
    ...call.agent === undefined ? {} : { agent: call.agent },
    ...call.toolSet === undefined ? {} : { toolSet: call.toolSet },
  })
  const settled = batch.results[0]
  if (settled === undefined) throw new Error('the selected tool executor omitted the model call result')
  return settled.result
}
