/** Version-tolerant navigation into durable AgentTeams member transcripts. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'

/** Narrow sessions-service face used by the activity panel and team card. */
export interface AgentTeamsSessionNavigator {
  /** Refresh the exact parent's durable direct-child catalog. */
  refreshSubagents(parentSessionId: SessionId): Promise<void>
  /** Reuse an address already retained by the client runtime when available. */
  subagentAddress(id: SessionId): SubagentAddress | undefined
}

/** Alpha.2 Workspace-owned main-panel navigation. */
export interface AgentTeamsWorkspaceNavigator {
  /** Retain and select a root Session or addressed subagent. */
  openSession(target: SessionTarget): void
}

/** Main-panel navigation added in Harness 0.1.5; older layouts omit these actions. */
export interface AgentTeamsLayoutNavigator {
  beginNavigation?(): AbortSignal
}

/**
 * Open one member's persisted transcript.
 *
 * Cold subagents must first be rediscovered in their parent's catalog, then
 * opened through the Workspace navigation owner with the exact
 * parent/child/mode address. A newer navigation aborts the pending refresh.
 */
export async function openAgentTeamMember(
  sessions: AgentTeamsSessionNavigator,
  workspace: AgentTeamsWorkspaceNavigator,
  parentSessionId: SessionId,
  childSessionId: SessionId,
  layout?: AgentTeamsLayoutNavigator,
): Promise<'subagent' | 'cancelled'> {
  const navigation = layout?.beginNavigation?.()
  await sessions.refreshSubagents(parentSessionId)
  if (navigation?.aborted) return 'cancelled'
  const retained = sessions.subagentAddress(childSessionId)
  workspace.openSession(retained?.parentSessionId === parentSessionId
    ? retained
    : { parentSessionId, childSessionId, mode: 'continuable' })
  return 'subagent'
}
