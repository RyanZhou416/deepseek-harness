/** One built-runtime manual-order reconciliation sample over fixed synthetic Sessions. */

import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { reconcileManualOrder } from '../../lib/types/client/tree.js'

const RESULT_PREFIX = 'MANUAL_ORDER_PERF_RESULT '
const SEED = 0x5E55104D

function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

function shuffled(values, random) {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const value = result[index]
    result[index] = result[other]
    result[other] = value
  }
  return result
}

function fixture(size, seed) {
  const random = seededRandom(seed)
  const ids = Array.from({ length: size }, (_, index) => `synthetic-session-${index}`)
  const summaries = {}
  let forks = 0
  for (const [index, id] of ids.entries()) {
    const parentId = index > 0 && random() < 0.35
      ? ids[Math.floor(random() * index)]
      : undefined
    if (parentId !== undefined) forks++
    summaries[id] = {
      id,
      displayTitle: id,
      running: false,
      blank: false,
      retainedBy: {},
      updatedAt: Math.floor(random() * size * 4),
      ...(parentId === undefined ? {} : { parentId }),
    }
  }
  const members = shuffled(ids, random)
  const savedOrder = shuffled(ids.filter(() => random() < 0.35), random)
  const saved = new Set(savedOrder)
  const pinnedSessionIds = shuffled(ids.filter(id => !saved.has(id) && random() < 0.05), random)
  const pinned = new Set(pinnedSessionIds)
  const archivedSessionIds = shuffled(ids.filter(id => !pinned.has(id) && random() < 0.08), random)
  return {
    members,
    savedOrder,
    summaries,
    rowState: { pinnedSessionIds, archivedSessionIds },
    facts: {
      forks,
      saved: savedOrder.length,
      pinned: pinnedSessionIds.length,
      archived: archivedSessionIds.length,
    },
  }
}

function verify(order, input) {
  if (order.length !== input.members.length || new Set(order).size !== input.members.length) {
    throw new Error('manual-order result lost or duplicated a synthetic member')
  }
  const expected = new Set(input.members)
  for (const id of order) {
    if (!expected.delete(id)) throw new Error(`manual-order result contains unexpected member ${id}`)
  }
  if (expected.size !== 0) throw new Error('manual-order result omitted synthetic members')
  return createHash('sha256').update(JSON.stringify(order)).digest('hex')
}

const size = Number(process.argv[2])
if (!Number.isSafeInteger(size) || size < 1) throw new Error(`invalid workload size ${String(process.argv[2])}`)

const warm = fixture(128, SEED ^ size)
for (let index = 0; index < 3; index++) {
  reconcileManualOrder(warm.members, warm.savedOrder, warm.summaries, warm.rowState)
}
const input = fixture(size, SEED)
const beforeCpu = process.cpuUsage()
const startedAt = performance.now()
const order = reconcileManualOrder(input.members, input.savedOrder, input.summaries, input.rowState)
const wallMs = performance.now() - startedAt
const cpu = process.cpuUsage(beforeCpu)
const digest = verify(order, input)

process.stdout.write(RESULT_PREFIX + JSON.stringify({
  size,
  ...input.facts,
  wallMs,
  cpuUserMs: cpu.user / 1_000,
  cpuSystemMs: cpu.system / 1_000,
  cpuTotalMs: (cpu.user + cpu.system) / 1_000,
  digest,
  first: order[0],
  last: order.at(-1),
}) + '\n')
