/**
 * Tool-call/tool-result pairing repair for the provider wires that reject an
 * unpaired call.
 *
 * Both the Responses input schema and the chat completions message schema
 * require every function call to be answered by its result and every result to
 * belong to a call: a `function_call` without its `function_call_output` (or a
 * chat `tool_calls` entry without its `tool` message) is a request error, and a
 * result whose call is absent has no meaning to the model. A harness history
 * normally pairs both sides, but a session whose durable log kept a call
 * without its result — a crash whose tail repair ran before the closed step,
 * a fork seed — can still reach a request in that state. The adapters repair
 * the assembled request locally; the durable history stays authoritative and
 * unchanged.
 */

/** Text marking a repaired tool result as an unknown outcome; the model must verify before retrying. */
export const UNKNOWN_TOOL_OUTCOME_TEXT = 'The tool call has no recorded result. Its outcome is unknown; verify external state before retrying any operation that may have side effects.'

/**
 * Reconcile one Responses input's tool-call pairing: every `function_call`
 * gets an output and every `function_call_output` matches a call. Missing
 * outputs become error-style outputs whose text marks the outcome unknown;
 * orphan outputs are dropped. Duplicate calls of one id receive exactly one
 * repair output.
 * @param input - Responses input items.
 * @returns the same array when already balanced, otherwise a repaired array.
 */
export function reconcileResponsesToolCalls(input: Record<string, unknown>[]): Record<string, unknown>[] {
  const calls = new Set<string>()
  const outputs = new Set<string>()
  for (const item of input) {
    if (item.type === 'function_call' && typeof item.call_id === 'string') calls.add(item.call_id)
    else if (item.type === 'function_call_output' && typeof item.call_id === 'string') outputs.add(item.call_id)
  }
  const missing = new Set([...calls].filter(callId => !outputs.has(callId)))
  if (missing.size === 0 && [...outputs].every(callId => calls.has(callId))) return input
  const balanced: Record<string, unknown>[] = []
  for (const item of input) {
    if (item.type === 'function_call_output' && (typeof item.call_id !== 'string' || !calls.has(item.call_id))) {
      continue
    }
    balanced.push(item)
    if (item.type === 'function_call' && typeof item.call_id === 'string' && missing.delete(item.call_id)) {
      balanced.push({ type: 'function_call_output', call_id: item.call_id, output: UNKNOWN_TOOL_OUTCOME_TEXT })
    }
  }
  return balanced
}

/** The tool-call ids one chat message advertises, when it is an assistant message carrying calls. */
function advertisedCallIds(message: Record<string, unknown>): string[] {
  if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return []
  const ids: string[] = []
  for (const call of message.tool_calls) {
    const id = (call as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  return ids
}

/**
 * Reconcile one chat completions `messages` array: every assistant message's
 * `tool_calls` entry is answered by a `tool` message, and every `tool` message
 * answers a call some assistant message advertised. Missing results become
 * error-style `tool` messages appended to the run of results that follows
 * their call; orphan results are dropped. Duplicate calls of one id receive
 * exactly one repair result.
 * @param messages - chat completions wire messages.
 * @returns the same array when already balanced, otherwise a repaired array.
 */
export function reconcileChatToolCalls(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  const calls = new Set<string>()
  const outputs = new Set<string>()
  for (const message of messages) {
    for (const id of advertisedCallIds(message)) calls.add(id)
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') outputs.add(message.tool_call_id)
  }
  const missing = new Set([...calls].filter(callId => !outputs.has(callId)))
  if (missing.size === 0 && [...outputs].every(callId => calls.has(callId))) return messages
  const balanced: Record<string, unknown>[] = []
  // Calls of the assistant message being answered, still awaiting a result.
  let unanswered: string[] = []
  const flushUnanswered = (): void => {
    for (const callId of unanswered) {
      balanced.push({ role: 'tool', tool_call_id: callId, content: UNKNOWN_TOOL_OUTCOME_TEXT })
      missing.delete(callId)
    }
    unanswered = []
  }
  for (const message of messages) {
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !calls.has(message.tool_call_id)) continue
      balanced.push(message)
      unanswered = unanswered.filter(callId => callId !== message.tool_call_id)
      continue
    }
    // Any other role ends the run of results belonging to the previous call.
    flushUnanswered()
    balanced.push(message)
    unanswered = advertisedCallIds(message).filter(callId => missing.has(callId))
  }
  flushUnanswered()
  return balanced
}
