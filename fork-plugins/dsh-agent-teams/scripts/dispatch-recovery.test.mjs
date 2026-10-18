/**
 * Dispatcher recovery regressions.
 *
 * A durable member keeps its child session id after a round, but Harness may
 * dispose that activation. Delivering the next assignment then fails. The
 * dispatcher must retire the dead id, start exactly one fresh activation for
 * the same member/attempt, and keep the task claimed. It must not log the
 * failure and roll the task back to `pending` (with the attempt number already
 * spent) while the member looks idle.
 *
 * A second focus is kick ordering: an unconsumed mailbox message must not starve
 * a ready task. One kick sends at most one of them, and the task comes first.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAgentTeamsTools } from '../lib/tools.js'
import { appendMailbox, createMessage, createTeamDir, readMailbox, readTeam, withTeamLock, writeTeam } from '../lib/state.js'

const TEAM_ID = 'team'
const TEAM_LOCK = stateRoot => `team:${stateRoot}:${TEAM_ID}`

/** Harness-shaped fake for one real tool registration and scheduler. */
async function createHarness(t, options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-dispatch-recovery-'))
  t.after(async () => { await rm(workspace, { recursive: true, force: true }) })
  const stateRoot = join(workspace, '.agent-teams')
  const definitions = new Map()
  const spawns = []
  const deliveries = []
  const drained = []
  const warnings = []
  const liveAgents = new Map()
  const listeners = new Map()
  let childSeq = 0
  let messageSeq = 0

  const captain = {
    id: 'captain-session',
    status: 'idle',
    options: { provider: 'fake', model: 'primary' },
    session: {
      header: { cwd: workspace, seedLength: 0 },
      events: [],
      append() {},
      requestHeader() { return { config: { provider: 'fake', model: 'primary' } } },
    },
    followup() {},
    steer() {},
    inject() {},
    cancel() {},
    whenIdle() { return Promise.resolve() },
  }
  liveAgents.set(captain.id, captain)

  const registerLive = (id, status = 'idle') => {
    const agent = {
      id,
      status,
      options: { provider: 'fake', model: 'primary' },
      session: {
        header: { cwd: workspace, parentSession: captain.id, seedLength: 0 },
        events: [],
        append() {},
      },
      // The legacy host steers a live child through the Agent itself.
      steer(message) {
        deliveries.push({
          childId: id,
          text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
        })
      },
      whenIdle() { return status === 'idle' ? Promise.resolve() : new Promise(() => {}) },
    }
    liveAgents.set(id, agent)
    return agent
  }

  const ctx = {
    effect(setup) { return setup() },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    on(name, listener) {
      const current = listeners.get(name) ?? []
      current.push(listener)
      listeners.set(name, current)
      return () => listeners.set(name, (listeners.get(name) ?? []).filter(candidate => candidate !== listener))
    },
    agents: {
      list: () => [],
      get(id) { return liveAgents.get(id) },
    },
    llm: {
      async resolveCallConfig(value) { return value },
      async listModels() { return [] },
    },
    subagents: {
      registerContinuableSetup() { return () => {} },
      getProvider(name) {
        return name === 'spawn'
          ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }
          : undefined
      },
      list() { return ['spawn'] },
      async startContinuable(spec) {
        spawns.push(spec)
        if (options.spawnFails === true) throw new Error('injected member start failure')
        const id = `member-session-${++childSeq}`
        registerLive(id, 'running')
        return { childId: id }
      },
      async followup(_parent, childId, content) {
        deliveries.push({
          childId,
          text: content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
        })
        if (options.deliveryFails === true) throw new Error('injected member delivery failure')
        return `message-${++messageSeq}`
      },
      async drainChildren(_parent, ids) { drained.push(...ids) },
      async listChildren() { return [] },
    },
    logger: {
      debug() {},
      warn(message) { warnings.push(message) },
    },
  }

  registerAgentTeamsTools(ctx, {
    stateDir: '.agent-teams',
    memberProvider: 'spawn',
    memberMaxDepth: 1,
    maxMembers: 8,
    profiles: {},
  })

  const call = async (name, args, subject = captain) => {
    const definition = definitions.get(name)
    if (definition === undefined) throw new Error(`missing registered tool ${name}`)
    return definition.execute(args, { agent: subject, signal: new AbortController().signal })
  }

  return { workspace, stateRoot, captain, call, spawns, deliveries, drained, warnings, liveAgents, registerLive }
}

/** Durable team shaped like the reported stuck state: pending task, assigned member. */
async function seedTeam(h, overrides = {}) {
  await createTeamDir(h.stateRoot, {
    id: TEAM_ID,
    name: 'Team',
    description: 'dispatch recovery fixture',
    captainSessionId: h.captain.id,
    createdAt: 1,
    members: [{
      id: 'worker-old',
      name: 'worker',
      role: 'builder',
      status: 'idle',
      joinedAt: 1,
      provider: 'fake',
      model: 'primary',
    }],
    tasks: [{
      id: 't1',
      subject: 'work',
      assignee: 'worker',
      status: 'pending',
      dependencies: [],
      attempt: 1,
      createdAt: 1,
      updatedAt: 1,
    }],
    taskSeq: 1,
    ...overrides,
  })
}

const state = h => readTeam(h.stateRoot, TEAM_ID)
const teamTask = async (h, id = 't1') => (await state(h))?.tasks.find(task => task.id === id)
const teamMember = async (h, name = 'worker') => (await state(h))?.members.find(member => member.name === name)

test('a reassigned task on a disposed member starts one fresh activation and stays claimed', async (t) => {
  const h = await createHarness(t, { deliveryFails: true })
  await seedTeam(h)
  // The member completed a round and Harness disposed its AgentHandle: the
  // durable id survives, the activation does not.
  assert.equal(h.liveAgents.get('worker-old'), undefined)

  const result = await h.call('agent_teams_reassign_task', { task_id: 't1', assignee: 'worker', reason: 'retry' })

  const task = await teamTask(h)
  const member = await teamMember(h)
  assert.equal(task.status, 'claimed', 'the task must not fall back to pending')
  assert.equal(task.assignee, 'worker')
  assert.equal(task.attempt, 2, 'exactly one new generation for this dispatch')
  assert.ok(task.attemptId !== undefined && task.attemptId !== '', 'the claim capability must survive')
  assert.equal(member.id, 'member-session-1')
  assert.equal(member.name, 'worker')
  assert.equal(member.role, 'builder')
  assert.equal(member.spawnError, undefined, 'a successful replacement clears the recorded failure')
  assert.equal(result.assignee, 'worker')
  assert.equal(result.attempt, 2)
  assert.equal(result.attempt_id, task.attemptId)

  assert.equal(h.spawns.length, 1, 'exactly one fresh activation')
  assert.ok(h.drained.includes('worker-old'), 'the dead activation is drained')
  assert.deepEqual(
    JSON.parse(await readFile(join(h.stateRoot, 'retired-members.json'), 'utf8')),
    ['worker-old'],
    'the dead id must be retired so it can never resume',
  )
  assert.equal(h.deliveries.length, 1, 'the failed delivery is not retried against the dead id')
  assert.equal(h.deliveries[0].childId, 'worker-old')
  assert.match(h.deliveries[0].text, /^AgentTeams automatic task assignment/)
})

test('a cold delivery failure falls back to one fresh activation without a pending attempt', async (t) => {
  const h = await createHarness(t, { deliveryFails: true })
  await seedTeam(h)
  h.registerLive('worker-old', 'idle')

  await h.call('agent_teams_reassign_task', { task_id: 't1', assignee: 'worker' })

  const task = await teamTask(h)
  const member = await teamMember(h)
  assert.notEqual(task.status, 'pending')
  assert.equal(task.status, 'claimed')
  assert.equal(task.attempt, 2)
  assert.ok(task.attemptId !== undefined && task.attemptId !== '')
  assert.equal(member.id, 'member-session-1')
  assert.equal(h.spawns.length, 1)
  assert.equal(h.deliveries.length, 1, 'only the failed delivery reached the retired id')

  // A later status kick must not spawn again or mint a second attempt for the
  // same dispatch, and the task must stay owned.
  const attemptId = task.attemptId
  await h.call('agent_teams_status', {})
  const settled = await teamTask(h)
  assert.equal(h.spawns.length, 1, 'no duplicate spawn on the next kick')
  assert.equal(settled.attempt, 2, 'no duplicate attempt generation')
  assert.equal(settled.attemptId, attemptId)
  assert.equal(settled.assignee, 'worker')
})

test('a failed fallback spawn records the reason and retries the same generation', async (t) => {
  const h = await createHarness(t, { deliveryFails: true, spawnFails: true })
  await seedTeam(h)
  h.registerLive('worker-old', 'idle')

  await h.call('agent_teams_reassign_task', { task_id: 't1', assignee: 'worker' })

  let task = await teamTask(h)
  let member = await teamMember(h)
  assert.equal(task.status, 'pending')
  assert.equal(task.assignee, 'worker', 'ownership survives a failed replacement')
  assert.equal(task.attempt, 1, 'a dispatch that never reached a member spends no generation')
  assert.equal(task.attemptId, undefined)
  assert.equal(member.id, '', 'the dead id is cleared before the replacement starts')
  assert.match(member.spawnError ?? '', /injected member start failure/)
  assert.equal(h.spawns.length, 1)
  assert.ok(h.drained.includes('worker-old'))

  // Kicks keep retrying one pending generation instead of stacking attempts.
  await h.call('agent_teams_status', {})
  task = await teamTask(h)
  member = await teamMember(h)
  assert.equal(task.status, 'pending')
  assert.equal(task.attempt, 1)
  assert.equal(h.spawns.length, 2)
  assert.match(member.spawnError ?? '', /injected member start failure/)
})

test('a recovered open attempt keeps its durable generation when the replacement also fails', async (t) => {
  const h = await createHarness(t, { deliveryFails: true, spawnFails: true })
  await seedTeam(h, {
    tasks: [{
      id: 't1',
      subject: 'work',
      assignee: 'worker',
      status: 'in_progress',
      dependencies: [],
      attempt: 1,
      attemptId: 'a1',
      output: 'partial progress',
      commandsRun: [{ command: 'partial-check', status: 'passed' }],
      createdAt: 1,
      updatedAt: 1,
    }],
  })

  // No idle edge was observed in this process, so the open capability is an
  // unobserved recovery. Its delivery and the replacement both fail: the
  // durable generation (with the partial evidence) must come back unchanged.
  await h.call('agent_teams_status', {})

  let task = await teamTask(h)
  let member = await teamMember(h)
  assert.equal(task.status, 'in_progress')
  assert.equal(task.attempt, 1)
  assert.equal(task.attemptId, 'a1')
  assert.equal(task.output, 'partial progress')
  assert.equal(task.commandsRun?.[0]?.command, 'partial-check')
  assert.equal(member.id, '')
  assert.match(member.spawnError ?? '', /injected member start failure/)
  assert.equal(h.spawns.length, 1)

  // The restored capability is parked against the cleared member id: later
  // kicks must not mint another attempt or spawn again.
  await h.call('agent_teams_status', {})
  task = await teamTask(h)
  assert.equal(task.status, 'in_progress')
  assert.equal(task.attempt, 1)
  assert.equal(task.attemptId, 'a1')
  assert.equal(h.spawns.length, 1, 'a restored capability must stay parked')
})

test('an unread mailbox does not starve a ready task, and is flushed on a later kick', async (t) => {
  const h = await createHarness(t)
  await seedTeam(h)
  h.registerLive('worker-old', 'idle')
  await appendMailbox(h.stateRoot, TEAM_ID, 'worker', createMessage('captain', 'worker', 'status please'))

  await h.call('agent_teams_status', {})

  const assigned = await teamTask(h)
  assert.equal(assigned.status, 'claimed', 'the ready task must be dispatched despite unread mail')
  assert.ok(assigned.attemptId !== undefined && assigned.attemptId !== '')
  assert.equal(h.deliveries.length, 1, 'one kick sends one unit of work')
  assert.match(h.deliveries[0].text, /^AgentTeams automatic task assignment/)
  assert.equal(h.deliveries[0].childId, 'worker-old')
  const untouched = await readMailbox(h.stateRoot, TEAM_ID, 'worker')
  assert.equal(untouched[0].deliveredAt, undefined, 'the task dispatch did not also send the mail')
  assert.equal(untouched[0].deliveryClaimedAt, undefined)

  // With no ready task left, the same kick lane flushes the durable mailbox.
  await withTeamLock(TEAM_LOCK(h.stateRoot), async () => {
    const fresh = await readTeam(h.stateRoot, TEAM_ID)
    const current = fresh.tasks.find(task => task.id === 't1')
    current.status = 'completed'
    current.attemptId = undefined
    current.output = 'done'
    fresh.members.find(member => member.name === 'worker').status = 'idle'
    await writeTeam(h.stateRoot, fresh)
  })
  await h.call('agent_teams_status', {})

  assert.equal(h.deliveries.length, 2)
  assert.match(h.deliveries[1].text, /^AgentTeams inbox receipt: /)
  const flushed = await readMailbox(h.stateRoot, TEAM_ID, 'worker')
  assert.ok(flushed[0].deliveredAt !== undefined, 'the mailbox message is acknowledged after acceptance')
  assert.equal(flushed[0].deliveryClaimedAt, undefined)
  assert.equal((await teamTask(h)).status, 'completed')
})
