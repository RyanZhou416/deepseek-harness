import type { ChatNode } from './chat-nodes.ts'

/** Current process range and finalized answer boundary derived from one Turn. */
export interface TurnProcessSpec {
  readonly turn: number
  /** Stable control-node anchor source, including currently ineligible evidence. */
  readonly controlAnchorSeq: number
  readonly processStartSeq: number
  readonly answerAnchorSeq: number | null
  readonly answerStep: number | null
  readonly inlineReasoning: boolean
  /** Reply-bearing durable Assistant messages before the final answer. */
  readonly messageCount: number
  /** Durable non-subagent Tool calls recorded by this Turn. */
  readonly toolCallCount: number
  /** Tool calls whose configured name identifies a subagent delegation. */
  readonly subagentCount: number
}

/**
 * Compare immutable Turn-process specifications by their published fields.
 * @param left - previous specification.
 * @param right - next specification.
 * @returns whether both values describe the same process presentation.
 */
export function sameTurnProcessSpec(left: TurnProcessSpec, right: TurnProcessSpec): boolean {
  return left.turn === right.turn
    && left.controlAnchorSeq === right.controlAnchorSeq
    && left.processStartSeq === right.processStartSeq
    && left.answerAnchorSeq === right.answerAnchorSeq
    && left.answerStep === right.answerStep
    && left.inlineReasoning === right.inlineReasoning
    && left.messageCount === right.messageCount
    && left.toolCallCount === right.toolCallCount
    && left.subagentCount === right.subagentCount
}

/**
 * Recognize the shipped subagent delegation name and its configured variants.
 * Control tools use distinct names such as `send_message` and `list_agents`.
 * @param name - durable Tool-call name.
 * @returns whether the call creates or forks a subagent.
 */
export function isSubagentDelegationTool(name: string): boolean {
  return name === 'subagent' || name.startsWith('subagent_')
}

/**
 * Keep live, stopped, and failed Turns open.
 * @param node - Node carrying the owning Turn.
 * @returns whether whole-Turn collapse is unavailable.
 */
export function turnProcessAlwaysOpen(node: ChatNode | undefined): boolean {
  const location = node?.location
  if (location?.kind !== 'turn' && location?.kind !== 'step') return false
  const reason = location.turn.end?.data.reason.kind
  return location.turn.status === 'open' || reason === 'aborted' || reason === 'interrupted' || reason === 'error'
}

/** Identity of one visible Chat row considered by whole-Turn process membership. */
export interface TurnProcessRow {
  readonly anchorSeq: number
  /** Owning Assistant Step when the row is an Assistant occurrence, otherwise null. */
  readonly step: number | null
  /** Occurrence part inside a grouped Assistant node; absent for a standalone row. */
  readonly groupPart: string | undefined
}

/**
 * Test whether one row renders the reply a Turn's process disclosure protects.
 * Identity is Turn/Step plus occurrence part, never an anchor comparison: a
 * durable message committed late can sit after its own transient anchor.
 * @param spec - published Turn process specification.
 * @param step - owning Assistant Step, or null for another Node kind.
 * @param groupPart - occurrence part of the row, absent for a standalone row.
 * @returns whether the row stays outside the whole-Turn fold.
 */
export function isTurnProcessAnswer(
  spec: TurnProcessSpec,
  step: number | null,
  groupPart: string | undefined,
): boolean {
  return spec.answerStep !== null
    && step === spec.answerStep
    && (groupPart === undefined || groupPart === 'response')
}

/**
 * Test whether one visible row belongs to its Turn's foldable process content.
 * An open Turn keeps its existing membership at and after the process start; a
 * closed Turn folds every process row on either side of the protected reply, so
 * a Tool call or a later Tool-only Step cannot withdraw the reply from view.
 * @param spec - published Turn process specification.
 * @param live - whether the owning Turn is still open.
 * @param row - visible row identity.
 * @returns whether the whole-Turn disclosure hides this row while folded.
 */
export function isTurnProcessMember(
  spec: TurnProcessSpec,
  live: boolean,
  row: TurnProcessRow,
): boolean {
  if (row.anchorSeq < spec.processStartSeq) return false
  if (live || spec.answerAnchorSeq === null) return true
  return !isTurnProcessAnswer(spec, row.step, row.groupPart)
}
