/** Shared, demand-driven state for the AgentTeams browser monitor. */

/** One member row of a host snapshot. */
export interface ActivityMember {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly executionPrompt?: string
  readonly status?: 'idle' | 'working' | 'removed'
  readonly activity: 'working' | 'idle' | 'unknown'
  readonly progress: number
  readonly done: number
  readonly total: number
  readonly currentTask: string
  readonly unread: number
}

/** One task row of a host snapshot. */
export interface ActivityTask {
  readonly id: string
  readonly subject: string
  readonly description?: string
  readonly status: string
  readonly state: 'blocked' | 'open' | 'running' | 'completed' | 'failed' | 'cancelled'
  readonly assignee: string
  readonly model?: string
  readonly dependencies: readonly string[]
  readonly depth: number
  readonly kind?: string
  readonly round?: number
  readonly verdict?: string
}

/** One team snapshot (mirrors the host TeamActivitySnapshot). */
export interface ActivityTeam {
  readonly workspace: string
  readonly teamId: string
  readonly name: string
  readonly description?: string
  readonly captainSessionId: string
  readonly phase: 'staged' | 'running'
  readonly planReviewState?: 'awaiting_review' | 'awaiting_feedback'
  readonly halted?: boolean
  readonly detail?: 'summary' | 'full'
  readonly detailRevision?: string
  readonly members: readonly ActivityMember[]
  readonly tasks: readonly ActivityTask[]
  readonly messageCount: number
  readonly captainInbox?: readonly { readonly from: string; readonly content: string }[]
}

/** A successfully-created conversation card that currently needs updates. */
export interface ActivityMonitorTarget {
  readonly key: string
  readonly sessionId: string
  readonly teamId: string
  /** Whether this mounted card still requires live/archive lookup. */
  readonly active: boolean
}

/** Latest shared response data for both the floater and conversation cards. */
export interface ActivitySnapshots {
  readonly teams: readonly ActivityTeam[]
  readonly archivedTeams: readonly ActivityTeam[]
}

interface RegisteredTarget extends ActivityMonitorTarget {
  refs: number
  active: boolean
}

const targets = new Map<string, RegisteredTarget>()
const targetListeners = new Set<() => void>()
const snapshotListeners = new Set<() => void>()
let targetSnapshot: readonly ActivityMonitorTarget[] = []
let activitySnapshots: ActivitySnapshots = { teams: [], archivedTeams: [] }

function targetKey(sessionId: string, teamId: string): string {
  return `${sessionId}\u0000${teamId}`
}

function publishTargets(): void {
  targetSnapshot = [...targets.values()]
    .map(({ key, sessionId, teamId, active }) => ({ key, sessionId, teamId, active }))
  for (const listener of targetListeners) listener()
}

/** Subscribe to the mounted monitor-target list (React external-store shape). */
export function subscribeActivityMonitorTargets(listener: () => void): () => void {
  targetListeners.add(listener)
  return () => { targetListeners.delete(listener) }
}

/** Read mounted targets, including settled targets retained by visible cards. */
export function getActivityMonitorTargetsSnapshot(): readonly ActivityMonitorTarget[] {
  return targetSnapshot
}

/**
 * Register one successful AgentTeams card as a monitoring demand.
 *
 * The returned cleanup is reference-counted so multiple cards and React
 * StrictMode remounts cannot stop another card's monitor.
 */
export function monitorAgentTeam(sessionId: string, teamId: string): () => void {
  const owner = sessionId.trim()
  const id = teamId.trim()
  if (owner === '' || id === '') return () => {}
  const key = targetKey(owner, id)
  const existing = targets.get(key)
  if (existing === undefined) {
    targets.set(key, { key, sessionId: owner, teamId: id, refs: 1, active: true })
    publishTargets()
  } else {
    existing.refs += 1
    if (!existing.active) {
      existing.active = true
      publishTargets()
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    const current = targets.get(key)
    if (current === undefined) return
    current.refs -= 1
    if (current.refs <= 0) {
      targets.delete(key)
      publishTargets()
    }
  }
}

/** Stop polling targets whose final archived snapshot has been captured. */
export function settleActivityMonitorTargets(keys: ReadonlySet<string>): void {
  let changed = false
  for (const key of keys) {
    const target = targets.get(key)
    if (target?.active !== true) continue
    target.active = false
    changed = true
  }
  if (changed) publishTargets()
}

/** Subscribe to the shared live/archive snapshot. */
export function subscribeActivitySnapshots(listener: () => void): () => void {
  snapshotListeners.add(listener)
  return () => { snapshotListeners.delete(listener) }
}

/** Read the stable shared live/archive snapshot. */
export function getActivitySnapshotsSnapshot(): ActivitySnapshots {
  return activitySnapshots
}

/** Publish one or both successful state-route responses. */
export function updateActivitySnapshots(update: Partial<ActivitySnapshots>): void {
  const next = {
    teams: update.teams ?? activitySnapshots.teams,
    archivedTeams: update.archivedTeams ?? activitySnapshots.archivedTeams,
  }
  if (next.teams === activitySnapshots.teams && next.archivedTeams === activitySnapshots.archivedTeams) return
  activitySnapshots = next
  for (const listener of snapshotListeners) listener()
}

/** Poll cadence for the live host snapshot route. */
export const ACTIVITY_POLL_MS = 1000
/**
 * Low-frequency probe cadence while a cardless discovery session still owns
 * no team. The probe keeps the panel able to pick up a team created later in
 * that session (e.g. a run_code-wrapped agent_teams_create) without turning
 * every ordinary session into a one-second filesystem scan.
 */
export const ACTIVITY_PROBE_MS = 5000
/** Host route serving live and archived team snapshots. */
export const ACTIVITY_STATE_URL = '/plugins/dsh-agent-teams/state'
export const ACTIVITY_HALT_URL = '/plugins/dsh-agent-teams/halt'

interface ActivityFetchResponse {
  readonly ok: boolean
  json(): Promise<unknown>
}

/** Injectable browser primitives used by the poll controller and its tests. */
export interface ActivityPollingRuntime {
  /** Current captain used for cold discovery and Host-side response filtering. */
  readonly discoverySessionId?: string
  /** Captain whose staged plan may load long editor detail. Defaults to discoverySessionId. */
  readonly detailCaptainSessionId?: string
  readonly fetchState?: (
    url: string,
    init: { readonly cache: 'no-store'; readonly signal: AbortSignal },
  ) => Promise<ActivityFetchResponse>
  readonly schedule?: (callback: () => void, intervalMs: number) => unknown
  readonly cancel?: (timer: unknown) => void
  readonly publishSnapshots?: (update: Partial<ActivitySnapshots>) => void
  /** Read the latest snapshots when scoped responses must be merged. */
  readonly readSnapshots?: () => ActivitySnapshots
  readonly settleTargets?: (keys: ReadonlySet<string>) => void
  /** Browser visibility; hidden pages perform no activity request. */
  readonly visible?: () => boolean
  /** Subscribe to browser visibility changes. */
  readonly subscribeVisibility?: (listener: () => void) => () => void
}

/** Handle returned by one current-session polling loop. */
export interface ActivityPollingController {
  /** The first visible pass, exposed so offline verification can await it. */
  readonly firstTick: Promise<void>
  /** Idempotently stop the timer and abort the current request. */
  stop(): void
}

interface ActivityStateUrlOptions {
  readonly archived?: boolean
  readonly detail?: boolean
}

interface ActivityStateTarget {
  readonly captainSessionId: string
  readonly teamId: string
}

/**
 * Build one scoped state URL for the current captain and explicit card targets.
 * @param captainSessionId - current captain session used for team discovery.
 * @param targets - explicit durable teams retained by conversation cards.
 * @param options - archive and long-detail response switches.
 * @returns the state endpoint and encoded selection query.
 */
function activityStateUrl(
  captainSessionId: string | undefined,
  targets: readonly ActivityStateTarget[],
  options: ActivityStateUrlOptions = {},
): string {
  const params = new URLSearchParams()
  const captain = captainSessionId?.trim() ?? ''
  if (captain !== '') params.set('captainSessionId', captain)
  const uniqueTargets = new Map(targets.map(target => [
    activityTeamKey(target.captainSessionId.trim(), target.teamId.trim()),
    { captainSessionId: target.captainSessionId.trim(), teamId: target.teamId.trim() },
  ]))
  for (const target of uniqueTargets.values()) {
    if (target.captainSessionId === '' || target.teamId === '') continue
    params.append('teamCaptainSessionId', target.captainSessionId)
    params.append('teamId', target.teamId)
  }
  if (options.archived === true) params.set('archived', '1')
  if (options.detail === true) params.set('detail', '1')
  const query = params.toString()
  return query === '' ? ACTIVITY_STATE_URL : `${ACTIVITY_STATE_URL}?${query}`
}

interface CachedTeamDetail {
  detail: ActivityTeam
  presentation: ActivityTeam
  revision: string
  generation: number
  stale: boolean
}

const detailCaches = new Set<Map<string, CachedTeamDetail>>()

function activityTeamKey(captainSessionId: string, teamId: string): string {
  return `${captainSessionId}\u0000${teamId}`
}

/**
 * Mark one staged plan's authoring fields for explicit refresh after a mutation.
 * @param captainSessionId - owning captain session id.
 * @param teamId - durable team id.
 */
export function invalidateActivityTeamDetail(captainSessionId: string, teamId: string): void {
  const key = activityTeamKey(captainSessionId, teamId)
  for (const cache of detailCaches) {
    const cached = cache.get(key)
    if (cached === undefined) continue
    cached.generation += 1
    cached.stale = true
  }
}

function hasFullActivityTeamDetail(team: ActivityTeam): boolean {
  if (team.detail === 'full') return true
  if (team.detail === 'summary') return false
  return team.members.every(member => member.executionPrompt !== undefined)
    && team.tasks.every(task => task.description !== undefined)
}

function asFullActivityTeam(team: ActivityTeam): ActivityTeam {
  return team.detail === 'full' ? team : { ...team, detail: 'full' }
}

function mergeActivityTeamDetail(summary: ActivityTeam, detail: ActivityTeam): ActivityTeam {
  const members = new Map(detail.members.map(member => [member.name, member]))
  const tasks = new Map(detail.tasks.map(task => [task.id, task]))
  return {
    ...detail,
    ...summary,
    detail: 'full',
    members: summary.members.map(member => ({ ...members.get(member.name), ...member })),
    tasks: summary.tasks.map(task => ({ ...tasks.get(task.id), ...task })),
  }
}

async function hydrateStagedTeamDetails(
  summaries: readonly ActivityTeam[],
  teamDetails: Map<string, CachedTeamDetail>,
  initialGenerations: ReadonlyMap<string, number>,
  detailCaptainSessionId: string | undefined,
  fetchState: NonNullable<ActivityPollingRuntime['fetchState']>,
  signal: AbortSignal,
): Promise<readonly ActivityTeam[]> {
  const staged = summaries.filter(team => team.phase === 'staged'
    && detailCaptainSessionId !== undefined
    && team.captainSessionId === detailCaptainSessionId)
  for (const team of staged) {
    if (!hasFullActivityTeamDetail(team)) continue
    const key = activityTeamKey(team.captainSessionId, team.teamId)
    const current = teamDetails.get(key)
    const initialGeneration = initialGenerations.get(key) ?? 0
    if ((current?.generation ?? 0) !== initialGeneration) continue
    const fullTeam = asFullActivityTeam(team)
    teamDetails.set(key, {
      detail: fullTeam,
      presentation: fullTeam,
      revision: team.detailRevision ?? '',
      generation: initialGeneration,
      stale: false,
    })
  }
  const activeRevisions = new Map(staged.map(team => [
    activityTeamKey(team.captainSessionId, team.teamId),
    team.detailRevision ?? '',
  ]))
  const activeKeys = new Set(activeRevisions.keys())
  for (const key of teamDetails.keys()) {
    if (!activeKeys.has(key)) teamDetails.delete(key)
  }
  const missing = staged.filter(team => {
    const cached = teamDetails.get(activityTeamKey(team.captainSessionId, team.teamId))
    if (cached === undefined) return true
    return cached.stale || cached.revision !== (team.detailRevision ?? '')
  })
  if (missing.length > 0) {
    const requestGenerations = new Map(missing.map(team => {
      const key = activityTeamKey(team.captainSessionId, team.teamId)
      return [key, teamDetails.get(key)?.generation ?? 0] as const
    }))
    if (signal.aborted) return summaries
    const response = await fetchState(activityStateUrl(undefined, missing.map(team => ({
      captainSessionId: team.captainSessionId,
      teamId: team.teamId,
    })), {
      detail: true,
    }), { cache: 'no-store', signal })
    if (signal.aborted) return summaries
    if (response.ok) {
      const body = (await response.json()) as { teams?: unknown }
      if (signal.aborted) return summaries
      if (Array.isArray(body.teams)) {
        for (const team of body.teams as readonly ActivityTeam[]) {
          if (team.detail !== 'full') continue
          const key = activityTeamKey(team.captainSessionId, team.teamId)
          const revision = team.detailRevision ?? ''
          const generation = requestGenerations.get(key) ?? 0
          if (activeRevisions.get(key) === revision
            && (teamDetails.get(key)?.generation ?? 0) === generation) {
            teamDetails.set(key, {
              detail: team,
              presentation: team,
              revision,
              generation,
              stale: false,
            })
          }
        }
      }
    }
  }
  return summaries.flatMap((summary) => {
    if (summary.phase !== 'staged') return [summary]
    const cached = teamDetails.get(activityTeamKey(summary.captainSessionId, summary.teamId))
    if (cached === undefined) return [summary]
    if (cached.stale || cached.revision !== (summary.detailRevision ?? '')) return [cached.presentation]
    cached.presentation = mergeActivityTeamDetail(summary, cached.detail)
    return [cached.presentation]
  })
}

function browserVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

function subscribeBrowserVisibility(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('visibilitychange', listener)
  return () => { document.removeEventListener('visibilitychange', listener) }
}

/**
 * Start the single polling loop for the current session's requested targets.
 *
 * The Host receives the current captain and explicit team ids, so it filters
 * before mailbox/activity assembly. Hidden browser pages abort active work and
 * resume with an immediate pass. Staged-plan authoring fields use a separate
 * explicit detail request and remain cached until a successful plan mutation
 * invalidates them.
 */
export function startActivityPolling(
  monitorTargets: readonly ActivityMonitorTarget[],
  runtime: ActivityPollingRuntime = {},
): ActivityPollingController {
  const discoverySessionId = runtime.discoverySessionId?.trim()
  const detailCaptainSessionId = (runtime.detailCaptainSessionId ?? discoverySessionId)?.trim()
  const activeTargets = monitorTargets.filter(target => target.active !== false)
  const allTargetKeys = new Set(monitorTargets.map(target => targetKey(target.sessionId, target.teamId)))
  const activeTargetKeys = new Set(activeTargets.map(target => targetKey(target.sessionId, target.teamId)))
  const discoveryOwns = (team: ActivityTeam): boolean => discoverySessionId !== undefined
    && discoverySessionId !== ''
    && team.captainSessionId === discoverySessionId
  const activeTargetOwns = (team: ActivityTeam): boolean => activeTargetKeys.has(
    targetKey(team.captainSessionId, team.teamId),
  )
  const mountedTargetOwns = (team: ActivityTeam): boolean => allTargetKeys.has(
    targetKey(team.captainSessionId, team.teamId),
  )
  const responseOwns = (team: ActivityTeam): boolean => discoveryOwns(team) || activeTargetOwns(team)
  const retainLive = (team: ActivityTeam): boolean => responseOwns(team)
  const retainArchive = (team: ActivityTeam): boolean => discoveryOwns(team) || mountedTargetOwns(team)
  const publishSnapshots = runtime.publishSnapshots ?? updateActivitySnapshots
  const readSnapshots = runtime.readSnapshots
    ?? (runtime.publishSnapshots === undefined
      ? getActivitySnapshotsSnapshot
      : () => ({ teams: [], archivedTeams: [] }))
  const pruneSnapshots = (): void => {
    const current = readSnapshots()
    const teams = current.teams.filter(retainLive)
    const archivedTeams = current.archivedTeams.filter(retainArchive)
    if (teams.length !== current.teams.length || archivedTeams.length !== current.archivedTeams.length) {
      publishSnapshots({ teams, archivedTeams })
    }
  }
  const publishLive = (incoming: readonly ActivityTeam[]): void => {
    const current = readSnapshots()
    publishSnapshots({
      teams: [
        ...current.teams.filter(team => retainLive(team) && !responseOwns(team)),
        ...incoming.filter(retainLive),
      ],
    })
  }
  const publishArchive = (incoming: readonly ActivityTeam[]): void => {
    const current = readSnapshots()
    publishSnapshots({
      archivedTeams: [
        ...current.archivedTeams.filter(team => retainArchive(team) && !responseOwns(team)),
        ...incoming.filter(retainArchive),
      ],
    })
  }
  pruneSnapshots()
  if (activeTargets.length === 0 && (discoverySessionId === undefined || discoverySessionId === '')) {
    return { firstTick: Promise.resolve(), stop: () => {} }
  }
  const teamDetails = new Map<string, CachedTeamDetail>()
  detailCaches.add(teamDetails)
  const fetchState = runtime.fetchState ?? ((url, init) => fetch(url, init))
  const schedule = runtime.schedule ?? ((callback, intervalMs) => setInterval(callback, intervalMs))
  const cancel = runtime.cancel ?? ((timer) => { clearInterval(timer as ReturnType<typeof setInterval>) })
  const settleTargets = runtime.settleTargets ?? settleActivityMonitorTargets
  const visibleNow = runtime.visible ?? browserVisible
  const observeVisibility = runtime.subscribeVisibility ?? subscribeBrowserVisibility
  const explicitTargets = activeTargets.map(target => ({
    captainSessionId: target.sessionId,
    teamId: target.teamId,
  }))
  let cancelled = false
  let visible = visibleNow()
  let inFlight = false
  let resumeAfterFlight = false
  let hot = activeTargets.length > 0
  let discoveryComplete = false
  let discoveredLiveKeys = new Set<string>()
  let activeController: AbortController | undefined
  let timer: unknown
  let firstSettled = false
  let settleFirst!: () => void
  const firstTick = new Promise<void>((resolve) => { settleFirst = resolve })
  const intervalMs = (): number => (hot ? ACTIVITY_POLL_MS : ACTIVITY_PROBE_MS)
  const clearTimer = (): void => {
    if (timer === undefined) return
    cancel(timer)
    timer = undefined
  }
  const armTimer = (): void => {
    clearTimer()
    if (!cancelled && visible) timer = schedule(() => { void tick() }, intervalMs())
  }
  const finishFirst = (): void => {
    if (firstSettled) return
    firstSettled = true
    settleFirst()
  }
  const tick = async (): Promise<void> => {
    if (inFlight || cancelled || !visible) return
    inFlight = true
    const requestController = new AbortController()
    activeController = requestController
    const initialDetailGenerations = new Map([...teamDetails].map(([key, value]) => [
      key, value.generation,
    ] as const))
    try {
      const liveResponse = await fetchState(activityStateUrl(
        discoverySessionId,
        explicitTargets,
      ), {
        cache: 'no-store',
        signal: requestController.signal,
      })
      if (requestController.signal.aborted || cancelled || !visible || !liveResponse.ok) return
      const body = (await liveResponse.json()) as { teams?: unknown }
      if (requestController.signal.aborted || cancelled || !visible || !Array.isArray(body.teams)) return
      const liveTeams = await hydrateStagedTeamDetails(
        body.teams as readonly ActivityTeam[],
        teamDetails,
        initialDetailGenerations,
        detailCaptainSessionId,
        fetchState,
        requestController.signal,
      )
      if (requestController.signal.aborted || cancelled || !visible) return
      publishLive(liveTeams)
      const previousDiscoveredKeys = discoveredLiveKeys
      discoveredLiveKeys = new Set(discoverySessionId === undefined || discoverySessionId === ''
        ? []
        : liveTeams
          .filter(team => team.captainSessionId === discoverySessionId)
          .map(team => team.teamId))
      if (!hot && discoveredLiveKeys.size > 0) {
        hot = true
        armTimer()
      }
      const discoveredTeamArchived = [...previousDiscoveredKeys]
        .some(teamId => !discoveredLiveKeys.has(teamId))
      const missing = activeTargets.filter(target => !liveTeams.some(team =>
        team.captainSessionId === target.sessionId && team.teamId === target.teamId,
      ))
      const needsDiscoveryArchive = discoverySessionId !== undefined
        && discoverySessionId !== ''
        && !discoveryComplete
      if (missing.length === 0 && !needsDiscoveryArchive && !discoveredTeamArchived) return

      const archivedResponse = await fetchState(activityStateUrl(
        discoverySessionId,
        explicitTargets,
        { archived: true },
      ), {
        cache: 'no-store',
        signal: requestController.signal,
      })
      if (requestController.signal.aborted || cancelled || !visible || !archivedResponse.ok) return
      const archivedBody = (await archivedResponse.json()) as { teams?: unknown }
      if (requestController.signal.aborted || cancelled || !visible || !Array.isArray(archivedBody.teams)) return
      publishArchive(archivedBody.teams as readonly ActivityTeam[])
      discoveryComplete = true
      settleTargets(new Set(missing.map(target => target.key)))
    } catch (error: unknown) {
      if ((error as { name?: unknown })?.name === 'AbortError') return
      // Keep the last snapshot while the Host is unavailable; the timer retries.
    } finally {
      if (activeController === requestController) activeController = undefined
      inFlight = false
      if (!requestController.signal.aborted) finishFirst()
      const shouldResume = resumeAfterFlight
      resumeAfterFlight = false
      if (shouldResume && visible && !cancelled) queueMicrotask(() => { void tick() })
    }
  }
  const stopVisibility = observeVisibility(() => {
    const next = visibleNow()
    if (next === visible || cancelled) return
    visible = next
    if (!visible) {
      clearTimer()
      resumeAfterFlight = false
      activeController?.abort()
      return
    }
    armTimer()
    if (inFlight) resumeAfterFlight = true
    else {
      resumeAfterFlight = false
      void tick()
    }
  })
  if (visible) {
    void tick()
    armTimer()
  }
  return {
    firstTick,
    stop: () => {
      if (cancelled) return
      cancelled = true
      clearTimer()
      stopVisibility()
      activeController?.abort()
      detailCaches.delete(teamDetails)
      teamDetails.clear()
      finishFirst()
    },
  }
}
