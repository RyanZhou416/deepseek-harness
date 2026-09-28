#!/usr/bin/env node
/**
 * Synthetic activity-state response and assembly diagnostic.
 *
 * Requires a prior package build. All durable state is generated in a temporary
 * directory; no DSH profile, API, or user Session is read.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { assembleTeamSnapshot, collectArchivedTeamsActivity, collectTeamsActivity } from '../lib/snapshot.js'
import { createTeamDir } from '../lib/state.js'
import { indexTasksByAssignee } from '../lib/task-index.js'

const DETAIL_TEXT = 'Synthetic task detail. '.repeat(72)
const PROMPT_TEXT = 'Synthetic member instruction. '.repeat(36)

function syntheticTeam(index, taskCount) {
  const teamId = `synthetic-team-${String(index).padStart(3, '0')}`
  return {
    id: teamId,
    name: `Synthetic Team ${index}`,
    description: DETAIL_TEXT,
    captainSessionId: `synthetic-captain-${index}`,
    createdAt: 0,
    members: [{
      id: `synthetic-member-session-${index}`,
      name: `member-${index}`,
      role: 'synthetic-role',
      provider: 'synthetic-provider',
      model: 'synthetic-model',
      reasoningEffort: 'medium',
      executionPrompt: PROMPT_TEXT,
      joinedAt: 0,
      status: 'idle',
    }],
    tasks: Array.from({ length: taskCount }, (_, taskIndex) => ({
      id: `task-${index}-${taskIndex}`,
      subject: `Synthetic task ${taskIndex}`,
      description: DETAIL_TEXT,
      status: 'pending',
      assignee: `member-${index}`,
      dependencies: [],
      createdAt: 0,
      updatedAt: 0,
    })),
    taskSeq: taskCount,
  }
}

async function measure(label, collect, context, roots, options) {
  context.agentLookups = 0
  const cpuStart = process.cpuUsage()
  const wallStart = performance.now()
  const teams = await collect(context, roots, options)
  const payload = JSON.stringify({ teams })
  const cpu = process.cpuUsage(cpuStart)
  return {
    label,
    teams: teams.length,
    tasks: teams.reduce((count, team) => count + team.tasks.length, 0),
    bytes: Buffer.byteLength(payload),
    agentLookups: context.agentLookups,
    wallMs: Number((performance.now() - wallStart).toFixed(2)),
    cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(2)),
  }
}

async function runScenario({ label, teamCount, taskCount, archived }) {
  const stateRoot = await mkdtemp(join(tmpdir(), `dsh-agent-teams-${label}-`))
  try {
    const storageRoot = archived ? join(stateRoot, 'archive') : stateRoot
    const base = Math.floor(taskCount / teamCount)
    const remainder = taskCount % teamCount
    for (let index = 0; index < teamCount; index += 1) {
      await createTeamDir(storageRoot, syntheticTeam(index, base + (index < remainder ? 1 : 0)))
    }
    const context = {
      agentLookups: 0,
      agents: { get: () => { context.agentLookups += 1; return undefined } },
      logger: { warn: () => {} },
    }
    const roots = [{ workspace: 'synthetic', stateRoot }]
    const collect = archived ? collectArchivedTeamsActivity : collectTeamsActivity
    const selectedTeamId = 'synthetic-team-000'
    const selectedCaptain = 'synthetic-captain-0'
    const results = []
    results.push(await measure('all-full', collect, context, roots, { includeDetails: true }))
    results.push(await measure('all-summary', collect, context, roots, {}))
    results.push(await measure('captain-summary', collect, context, roots, {
      captainSessionId: selectedCaptain,
    }))
    results.push(await measure('target-summary', collect, context, roots, {
      targets: [{ captainSessionId: selectedCaptain, teamId: selectedTeamId }],
    }))
    results.push(await measure('target-full', collect, context, roots, {
      targets: [{ captainSessionId: selectedCaptain, teamId: selectedTeamId }],
      includeDetails: true,
    }))
    if (results[0].tasks !== taskCount || results[1].tasks !== taskCount) {
      throw new Error(`${label}: activity projection truncated the synthetic task list`)
    }
    return { label, archived, configuredTeams: teamCount, configuredTasks: taskCount, results }
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
}

function ownershipWork(label, memberCount, taskCount) {
  const members = Array.from({ length: memberCount }, (_, index) => `member-${index}`)
  const tasks = Array.from({ length: taskCount }, (_, index) => ({
    id: `task-${index}`,
    status: index % 5 === 0 ? 'completed' : index % 7 === 0 ? 'in_progress' : 'pending',
    assignee: members[index % members.length],
  }))
  let naiveInspections = 0
  const naive = new Map()
  for (const member of members) {
    const owned = tasks.filter(task => { naiveInspections += 1; return task.assignee === member })
    let completed = 0
    for (const task of owned) { naiveInspections += 1; if (task.status === 'completed') completed += 1 }
    let currentTask = ''
    for (const task of tasks) {
      naiveInspections += 1
      if (task.assignee === member && task.status === 'in_progress') { currentTask = task.id; break }
    }
    naive.set(member, { tasks: owned, completed, currentTask })
  }
  const indexed = indexTasksByAssignee(tasks)
  for (const member of members) {
    const expected = naive.get(member)
    const actual = indexed.get(member)
    if (JSON.stringify(actual?.tasks.map(task => task.id)) !== JSON.stringify(expected.tasks.map(task => task.id))
      || actual?.completed !== expected.completed || actual?.currentTask !== expected.currentTask) {
      throw new Error(`${label}: indexed ownership differs from the naive projection`)
    }
  }
  return {
    label,
    members: memberCount,
    tasks: taskCount,
    naiveInspections,
    indexedVisits: taskCount,
    inspectionRatio: Number((naiveInspections / taskCount).toFixed(2)),
  }
}

async function measureAssemblyOwnership(label, memberCount, taskCount, iterations) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-agent-teams-ownership-assembly-'))
  try {
    const members = Array.from({ length: memberCount }, (_, index) => ({
      id: '', name: `member-${index}`, joinedAt: 0, status: 'idle',
    }))
    const tasks = Array.from({ length: taskCount }, (_, index) => ({
      id: `task-${index}`,
      subject: `Synthetic task ${index}`,
      status: index % 5 === 0 ? 'completed' : index % 7 === 0 ? 'in_progress' : 'pending',
      assignee: members[index % members.length].name,
      dependencies: [],
      createdAt: 0,
      updatedAt: 0,
    }))
    const team = {
      id: 'ownership-assembly', name: 'Ownership Assembly', captainSessionId: 'ownership-captain',
      createdAt: 0, members, tasks, taskSeq: taskCount,
    }
    await createTeamDir(stateRoot, team)
    const context = { agents: { get: () => undefined }, logger: { warn: () => {} } }
    const cpuStart = process.cpuUsage()
    const wallStart = performance.now()
    let snapshot
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      snapshot = await assembleTeamSnapshot(context, stateRoot, 'synthetic', team)
    }
    const cpu = process.cpuUsage(cpuStart)
    if (snapshot?.members.length !== memberCount || snapshot.tasks.length !== taskCount) {
      throw new Error('ownership assembly truncated members or tasks')
    }
    return {
      label, members: memberCount, tasks: taskCount, iterations,
      wallMs: Number((performance.now() - wallStart).toFixed(2)),
      cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(2)),
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
}

const diagnostics = [
  await runScenario({ label: 'live-1500', teamCount: 27, taskCount: 1_500, archived: false }),
  await runScenario({ label: 'archive-2600', teamCount: 58, taskCount: 2_600, archived: true }),
]
const ownership = [
  ownershipWork('ownership-small', 3, 12),
  ownershipWork('ownership-large-synthetic', 8, 256),
]
const assemblyOwnership = [
  await measureAssemblyOwnership('ownership-assembly-small-synthetic', 3, 12, 200),
  await measureAssemblyOwnership('ownership-assembly-large-synthetic', 8, 256, 50),
]
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), diagnostics, ownership, assemblyOwnership }, null, 2))