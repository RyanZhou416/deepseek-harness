/**
 * Team activity snapshot assembly for the activity panel.
 *
 * Server-side assembly mirrors the Claude Code desktop teamWatcher: read the
 * durable team files (the truth source) and enrich with live subagent
 * activity, so the panel always reflects the on-disk state even when a model
 * skipped a tool "ritual" (e.g. not calling update_task on completion).
 * @module dsh-agent-teams/snapshot
 */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { memberActivity } from './members.ts'
import {
  CAPTAIN_KEY, listArchivedTeamIds, readArchivedTeam, readUnreadMailbox, readTeam,
  taskDepthsById, taskVisualState,
} from './state.ts'
import type { MemberStatus, TeamState, TeamTask } from './types.ts'
import { indexTasksByAssignee } from './task-index.ts'

/** Visual task state for the activity panel. */
export type VisualTaskState = 'blocked' | 'open' | 'running' | 'completed' | 'failed' | 'cancelled'

/** One member row of the activity snapshot. */
export interface TeamActivityMember {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string
  readonly executionPrompt?: string
  readonly status: MemberStatus
  readonly activity: 'working' | 'idle' | 'unknown'
  readonly progress: number
  readonly done: number
  readonly total: number
  readonly currentTask: string
  readonly unread: number
}

/** One task row of the activity snapshot. */
export interface TeamActivityTask {
  readonly id: string
  readonly subject: string
  readonly description?: string
  readonly status: string
  readonly state: VisualTaskState
  readonly assignee: string
  readonly model: string
  readonly dependencies: readonly string[]
  readonly depth: number
  readonly kind?: string
  readonly round?: number
  readonly verdict?: string
}

/** One captain-inbox preview row retained for legacy unscoped clients. */
export interface TeamActivityMessage {
  readonly from: string
  readonly content: string
}

/** One panel payload for a team. */
export interface TeamActivitySnapshot {
  readonly workspace: string
  readonly teamId: string
  readonly name: string
  readonly description?: string
  readonly captainSessionId: string
  readonly phase: 'staged' | 'running'
  readonly planReviewState?: 'awaiting_review' | 'awaiting_feedback'
  readonly halted?: boolean
  /** Whether long staged-plan authoring fields are present. */
  readonly detail: 'summary' | 'full'
  /** Changes when staged authoring text changes. */
  readonly detailRevision?: string
  readonly members: readonly TeamActivityMember[]
  readonly tasks: readonly TeamActivityTask[]
  readonly messageCount: number
  readonly captainInbox?: readonly TeamActivityMessage[]
}

/** Snapshot projection switches for live and archived teams. */
export interface TeamSnapshotOptions {
  /** Historic review must retain members that were marked removed at shutdown. */
  readonly includeRemoved?: boolean
  /** Archived teams have no meaningful live activity after their sessions stop. */
  readonly historic?: boolean
  /** Include staged-plan authoring text that the live panel otherwise loads on demand. */
  readonly includeDetails?: boolean
  /** Include legacy captain-inbox preview bodies. */
  readonly includeCaptainInbox?: boolean
}

/** One explicit conversation-card target. */
export interface TeamActivityTarget {
  readonly captainSessionId: string
  readonly teamId: string
}

/** Selection applied before activity and mailbox assembly. */
export interface TeamActivityCollectionOptions {
  /** Current captain whose teams are needed for discovery. */
  readonly captainSessionId?: string
  /** Explicit durable teams retained by visible conversation cards. */
  readonly targets?: readonly TeamActivityTarget[]
  /** Include staged-plan authoring fields. */
  readonly includeDetails?: boolean
  /** Include legacy captain-inbox preview bodies. */
  readonly includeCaptainInbox?: boolean
}

function selectedTeam(state: TeamState, options: TeamActivityCollectionOptions): boolean {
  const captain = options.captainSessionId?.trim() ?? ''
  const targets = options.targets ?? []
  if (captain === '' && targets.length === 0) return true
  return (captain !== '' && state.captainSessionId === captain) || targets.some(target => (
    target.captainSessionId === state.captainSessionId && target.teamId === state.id
  ))
}

function requestedTeamIds(options: TeamActivityCollectionOptions): ReadonlySet<string> | undefined {
  if ((options.captainSessionId?.trim() ?? '') !== '') return undefined
  const targets = options.targets ?? []
  if (targets.length === 0) return undefined
  return new Set(targets.map(target => target.teamId))
}

function stagedDetailRevision(state: TeamState): string {
  const hash = createHash('sha256')
  const add = (value: string | undefined): void => {
    const text = value ?? ''
    hash.update(`${Buffer.byteLength(text)}:`)
    hash.update(text)
  }
  add(state.description)
  add(state.planReviewState)
  for (const member of state.members) {
    add(member.name)
    add(member.role)
    add(member.provider)
    add(member.model)
    add(member.reasoningEffort)
    add(member.executionPrompt)
  }
  for (const task of state.tasks) {
    add(task.id)
    add(task.subject)
    add(task.description)
    add(task.assignee)
    for (const dependency of task.dependencies) add(dependency)
  }
  return hash.digest('base64url')
}

/** Compact `provider/model` route for the activity panel, or just the model. */
export function memberModelRoute(member: { provider?: string; model?: string } | undefined): string {
  if (member === undefined) return ''
  const provider = member.provider?.trim() ?? ''
  const model = member.model?.trim() ?? ''
  if (provider !== '' && model !== '') return `${provider}/${model}`
  return model
}

/**
 * Assemble one team snapshot from its durable files plus live activity.
 * @param ctx - the plugin context (injects `subagents`, used for activity).
 * @param stateRoot - resolved absolute state root of the owning workspace.
 * @param workspace - display name of the owning workspace.
 * @param state - the durable team record.
 * @param options - historic roster/activity and long-detail projection switches.
 * @returns the panel snapshot.
 */
export async function assembleTeamSnapshot(
  ctx: Context,
  stateRoot: string,
  workspace: string,
  state: TeamState,
  options: TeamSnapshotOptions = {},
): Promise<TeamActivitySnapshot> {
  const tasks = state.tasks
  const depths = taskDepthsById(tasks)
  const roster = options.includeRemoved === true
    ? state.members
    : state.members.filter((member) => member.status !== 'removed')
  const tasksByAssignee = indexTasksByAssignee(tasks)
  const rosterByName = new Map<string, (typeof roster)[number]>()
  for (const member of roster) {
    if (!rosterByName.has(member.name)) rosterByName.set(member.name, member)
  }
  const activity = options.historic === true
    ? new Map<string, 'running' | 'idle' | 'ready'>()
    : memberActivity(ctx, roster.map((member) => member.id))
  const unreadByMember = new Map<string, number>()
  for (const member of roster) {
    try {
      unreadByMember.set(member.name, (await readUnreadMailbox(stateRoot, state.id, member.name)).length)
    } catch (error: unknown) {
      ctx.logger.warn(`agent-teams: mailbox read failed for ${member.name}: ${String(error)}`)
      unreadByMember.set(member.name, 0)
    }
  }
  const members: TeamActivityMember[] = roster.map((member) => {
    const owned = tasksByAssignee.get(member.name)
    const done = owned?.completed ?? 0
    const total = owned?.tasks.length ?? 0
    return {
      id: member.id,
      name: member.name,
      role: member.role ?? '',
      provider: member.provider?.trim() ?? '',
      model: member.model?.trim() ?? '',
      reasoningEffort: member.reasoningEffort?.trim() ?? '',
      ...options.includeDetails === true
        ? { executionPrompt: member.executionPrompt ?? '' }
        : {},
      status: member.status,
      activity: options.historic === true
        ? 'idle'
        : member.id !== ''
          ? (activity.get(member.id) === 'running'
              ? 'working'
              : activity.get(member.id) === 'idle' || activity.get(member.id) === 'ready'
                ? 'idle'
                : 'unknown')
          : 'idle',
      progress: total === 0 ? 0 : Math.round((done / total) * 100),
      done,
      total,
      currentTask: owned?.currentTask ?? '',
      unread: unreadByMember.get(member.name) ?? 0,
    }
  })
  const captainInbox = await readUnreadMailbox(stateRoot, state.id, CAPTAIN_KEY)
  return {
    workspace,
    teamId: state.id,
    name: state.name,
    ...options.includeDetails === true && state.description !== undefined
      ? { description: state.description }
      : {},
    captainSessionId: state.captainSessionId,
    phase: state.phase ?? 'running',
    ...state.phase === 'staged'
      ? {
          planReviewState: state.planReviewState ?? 'awaiting_review' as const,
          detailRevision: stagedDetailRevision(state),
        }
      : {},
    ...state.halted === true ? { halted: true } : {},
    detail: options.includeDetails === true ? 'full' : 'summary',
    members,
    tasks: tasks.map((task) => ({
      id: task.id,
      subject: task.subject,
      ...options.includeDetails === true
        ? { description: task.description ?? '' }
        : {},
      status: task.status,
      state: taskVisualState(task.status, task.dependencies, tasks),
      assignee: task.assignee ?? '',
      model: memberModelRoute(task.assignee === undefined ? undefined : rosterByName.get(task.assignee)),
      dependencies: task.dependencies,
      depth: depths.get(task.id) ?? 0,
      ...task.kind === undefined ? {} : { kind: task.kind },
      ...task.round === undefined ? {} : { round: task.round },
      ...task.verdict === undefined ? {} : { verdict: task.verdict },
    })),
    messageCount: captainInbox.length
      + members.reduce((count, member) => count + member.unread, 0),
    ...options.includeCaptainInbox === true
      ? {
          captainInbox: captainInbox.slice(-5).map(message => ({
            from: message.from,
            content: message.content,
          })),
        }
      : {},
  }
}

async function listLiveTeamIds(stateRoot: string): Promise<readonly string[]> {
  try {
    return (await readdir(stateRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Collect selected live teams under the given workspace state roots.
 * @param ctx - the plugin context.
 * @param roots - `{ workspace, stateRoot }` pairs (resolved absolute roots).
 * @param options - captain/team selection and detail projection.
 * @returns the snapshots in stable order (workspace, then team id).
 */
export async function collectTeamsActivity(
  ctx: Context,
  roots: readonly { workspace: string; stateRoot: string }[],
  options: TeamActivityCollectionOptions = {},
): Promise<TeamActivitySnapshot[]> {
  const snapshots: TeamActivitySnapshot[] = []
  const requested = requestedTeamIds(options)
  for (const root of roots) {
    const teamIds = await listLiveTeamIds(root.stateRoot)
    for (const teamId of teamIds) {
      if (requested !== undefined && !requested.has(teamId)) continue
      try {
        const state = await readTeam(root.stateRoot, teamId)
        if (state === undefined || !selectedTeam(state, options)) continue
        snapshots.push(await assembleTeamSnapshot(ctx, root.stateRoot, root.workspace, state, {
          includeDetails: options.includeDetails,
          includeCaptainInbox: options.includeCaptainInbox,
        }))
      } catch {
        ctx.logger.warn(`agent-teams: skipped unreadable team state "${teamId}" in workspace "${root.workspace}"`)
      }
    }
  }
  return snapshots
}

/**
 * Collect selected archived teams under the given workspace state roots (the
 * `archive/` subdirectory of each state root). Used by the historic panel
 * path to restore full team detail after deletion.
 * @param ctx - the plugin context.
 * @param roots - `{ workspace, stateRoot }` pairs.
 * @param options - captain/team selection and detail projection.
 * @returns the archived snapshots in stable order.
 */
export async function collectArchivedTeamsActivity(
  ctx: Context,
  roots: readonly { workspace: string; stateRoot: string }[],
  options: TeamActivityCollectionOptions = {},
): Promise<TeamActivitySnapshot[]> {
  const snapshots: TeamActivitySnapshot[] = []
  const requested = requestedTeamIds(options)
  for (const root of roots) {
    const teamIds = await listArchivedTeamIds(root.stateRoot)
    for (const teamId of teamIds) {
      if (requested !== undefined && !requested.has(teamId)) continue
      try {
        const state = await readArchivedTeam(root.stateRoot, teamId)
        if (state === undefined || !selectedTeam(state, options)) continue
        snapshots.push(await assembleTeamSnapshot(
          ctx,
          join(root.stateRoot, 'archive'),
          root.workspace,
          state,
          {
            includeRemoved: true,
            historic: true,
            includeDetails: options.includeDetails,
            includeCaptainInbox: options.includeCaptainInbox,
          },
        ))
      } catch {
        ctx.logger.warn(`agent-teams: skipped unreadable archived team "${teamId}" in workspace "${root.workspace}"`)
      }
    }
  }
  return snapshots
}
