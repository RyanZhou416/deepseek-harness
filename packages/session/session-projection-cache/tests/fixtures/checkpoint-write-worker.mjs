/** One built-runtime projection-checkpoint write sample over a private JSON root. */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache, {
  checkpointRecord,
  projectionCacheDomainSpec,
} from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply,
  Config as storageJsonConfig,
  inject as storageJsonInject,
  name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply,
  Config as storageDomainConfig,
  inject as storageDomainInject,
  name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'

const RESULT_PREFIX = 'CHECKPOINT_WRITE_PERF_RESULT '
const WORKLOAD = Object.freeze({ sessions: 18, projections: 8, entriesPerProjection: 256 })
const PAYLOAD = 'Synthetic checkpoint value with nested JSON fields. '.repeat(2)

const entrySchema = z.object({
  id: z.string(),
  rank: z.number().int().nonnegative(),
  enabled: z.boolean(),
  tags: z.array(z.string()),
  payload: z.string(),
})
const stateSchema = z.object({
  owner: z.string(),
  projection: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  entries: z.array(entrySchema),
})

function makeState(owner, projection) {
  return {
    owner,
    projection,
    revision: 1,
    entries: Array.from({ length: WORKLOAD.entriesPerProjection }, (_, rank) => ({
      id: `${projection}:${rank}`,
      rank,
      enabled: rank % 3 !== 0,
      tags: [`bucket-${rank % 8}`, `projection-${projection}`, owner],
      payload: `${PAYLOAD}${owner}:${projection}:${rank}`,
    })),
  }
}

function projectionDefinition(projection) {
  return {
    key: `checkpoint-perf/${projection}`,
    stateSchema,
    init: header => makeState(String(header.id), projection),
    apply: state => state,
    stateVersion: 1,
  }
}

function recordPath(root, id) {
  return join(root, projectionCacheDomainSpec.name, 'sessions', `${id}.json`)
}

function forceGc() {
  if (globalThis.gc === undefined) throw new Error('checkpoint write worker requires node --expose-gc')
  globalThis.gc()
  globalThis.gc()
}

async function verify(root, sessions) {
  const hash = createHash('sha256')
  let documents = 0
  let rows = 0
  let entries = 0
  let documentBytes = 0
  for (const session of sessions) {
    const source = await readFile(recordPath(root, String(session.id)), 'utf8')
    documentBytes += Buffer.byteLength(source)
    const document = JSON.parse(source)
    const record = checkpointRecord.parse(document.record)
    if (document.version !== projectionCacheDomainSpec.version) {
      throw new Error(`unexpected cache document version for ${String(session.id)}`)
    }
    const keys = Object.keys(record.rows).toSorted()
    if (keys.length !== WORKLOAD.projections) {
      throw new Error(`unexpected projection row count for ${String(session.id)}`)
    }
    for (let projection = 0; projection < WORKLOAD.projections; projection++) {
      const key = `checkpoint-perf/${projection}`
      const row = record.rows[key]
      if (row === undefined || row.ver !== 1 || row.seq !== 0) {
        throw new Error(`unexpected checkpoint metadata for ${String(session.id)} ${key}`)
      }
      const value = stateSchema.parse(row.val)
      if (value.owner !== String(session.id)
        || value.projection !== projection
        || value.revision !== 1
        || value.entries.length !== WORKLOAD.entriesPerProjection
        || value.entries[0]?.id !== `${projection}:0`
        || value.entries.at(-1)?.id !== `${projection}:${WORKLOAD.entriesPerProjection - 1}`) {
        throw new Error(`unexpected checkpoint state for ${String(session.id)} ${key}`)
      }
      rows++
      entries += value.entries.length
    }
    hash.update(String(session.id))
    hash.update(JSON.stringify(record))
    documents++
  }
  return { documents, rows, entries, documentBytes, digest: hash.digest('hex') }
}

async function sample() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-write-perf-'))
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin({
      name: storageJsonName,
      inject: storageJsonInject,
      apply: storageJsonApply,
      Config: storageJsonConfig,
    }, { root })
    await ctx.plugin({
      name: storageDomainName,
      inject: storageDomainInject,
      apply: storageDomainApply,
      Config: storageDomainConfig,
    }, { backend: 'json' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    for (let projection = 0; projection < WORKLOAD.projections; projection++) {
      ctx.sessionProjections.register(projectionDefinition(projection))
    }

    const sessions = Array.from({ length: WORKLOAD.sessions }, (_, index) => {
      const id = SessionId(`checkpoint-perf-session-${index}`)
      const session = ctx.sessions.create(id, { meta: { createdAt: index + 1 } })
      session.append('request/context', {
        provider: 'checkpoint-perf',
        model: `synthetic-${index % 3}`,
      })
      return session
    })

    await ctx.plugin(SessionProjectionCache, {
      writeEveryEvents: Number.MAX_SAFE_INTEGER,
      writeIntervalMs: Number.MAX_SAFE_INTEGER,
    })
    forceGc()
    const beforeMemory = process.memoryUsage()
    const beforeCpu = process.cpuUsage()
    const startedAt = performance.now()
    await Promise.all(sessions.map(session => ctx.sessionProjectionCache.write(session)))
    const wallMs = performance.now() - startedAt
    const cpu = process.cpuUsage(beforeCpu)
    forceGc()
    const afterMemory = process.memoryUsage()
    const verified = await verify(root, sessions)
    return {
      workload: WORKLOAD,
      wallMs,
      cpuUserMs: cpu.user / 1_000,
      cpuSystemMs: cpu.system / 1_000,
      cpuTotalMs: (cpu.user + cpu.system) / 1_000,
      beforeHeapUsedBytes: beforeMemory.heapUsed,
      afterHeapUsedBytes: afterMemory.heapUsed,
      retainedHeapDeltaBytes: afterMemory.heapUsed - beforeMemory.heapUsed,
      beforeRssBytes: beforeMemory.rss,
      afterRssBytes: afterMemory.rss,
      ...verified,
    }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

process.stdout.write(RESULT_PREFIX + JSON.stringify(await sample()) + '\n')
