/** Threshold-free fresh-process diagnostics for durable projection checkpoint writes. */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SAMPLES = 3
const RESULT_PREFIX = 'CHECKPOINT_WRITE_PERF_RESULT '
const worker = fileURLToPath(new URL('./fixtures/checkpoint-write-worker.mjs', import.meta.url))

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const label = argument('--label')
if (label === undefined || label.length === 0) {
  throw new Error('usage: checkpoint-write.perf.ts --label <baseline|candidate>')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const samples: Record<string, unknown>[] = []
for (let sample = 0; sample < SAMPLES; sample++) {
  const result = spawnSync(process.execPath, ['--expose-gc', worker], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (result.error !== undefined) throw result.error
  if (result.signal !== null || result.status !== 0) {
    throw new Error(`checkpoint write sample failed: ${result.signal ?? result.status}: ${result.stderr}`)
  }
  const line = result.stdout.split(/\r?\n/u).find(candidate => candidate.startsWith(RESULT_PREFIX))
  if (line === undefined) throw new Error(`checkpoint write sample produced no result: ${result.stdout}`)
  const parsed: unknown = JSON.parse(line.slice(RESULT_PREFIX.length))
  if (!isRecord(parsed)) {
    throw new Error('checkpoint write sample returned a non-object result')
  }
  samples.push(parsed)
}

function numberField(sample: Record<string, unknown>, field: string): number {
  const value = sample[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`checkpoint write sample field ${JSON.stringify(field)} is not finite`)
  }
  return value
}

function stringField(sample: Record<string, unknown>, field: string): string {
  const value = sample[field]
  if (typeof value !== 'string') {
    throw new Error(`checkpoint write sample field ${JSON.stringify(field)} is not a string`)
  }
  return value
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b)
  const value = sorted[Math.floor(sorted.length / 2)]
  if (value === undefined) throw new Error('cannot take the median of an empty sample')
  return value
}

const digests = new Set(samples.map(sample => stringField(sample, 'digest')))
if (digests.size !== 1) throw new Error('fresh samples produced different durable checkpoint results')

const aggregates = {
  wallMsMedian: median(samples.map(sample => numberField(sample, 'wallMs'))),
  cpuTotalMsMedian: median(samples.map(sample => numberField(sample, 'cpuTotalMs'))),
  cpuUserMsMedian: median(samples.map(sample => numberField(sample, 'cpuUserMs'))),
  cpuSystemMsMedian: median(samples.map(sample => numberField(sample, 'cpuSystemMs'))),
  retainedHeapDeltaBytesMedian: median(samples.map(sample => numberField(sample, 'retainedHeapDeltaBytes'))),
}

process.stdout.write(JSON.stringify({
  label,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  memorySemantics: 'heap and RSS are forced-GC endpoint readings while Sessions, projection cells, cache rows, and Context remain reachable; transient peak allocation is excluded',
  samples,
  aggregates,
}, null, 2) + '\n')
