/** Threshold-free fresh-process diagnostics for Workspace manual-order reconciliation. */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SAMPLES = 3
const SIZES = [1_000, 4_000] as const
const RESULT_PREFIX = 'MANUAL_ORDER_PERF_RESULT '
const worker = fileURLToPath(new URL('./fixtures/manual-order-worker.mjs', import.meta.url))

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberField(sample: Record<string, unknown>, field: string): number {
  const value = sample[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`manual-order sample field ${JSON.stringify(field)} is not finite`)
  }
  return value
}

function stringField(sample: Record<string, unknown>, field: string): string {
  const value = sample[field]
  if (typeof value !== 'string') {
    throw new Error(`manual-order sample field ${JSON.stringify(field)} is not a string`)
  }
  return value
}

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right)
  const value = sorted[Math.floor(sorted.length / 2)]
  if (value === undefined) throw new Error('cannot take the median of an empty sample')
  return value
}

const label = argument('--label')
if (label === undefined || label.length === 0) {
  throw new Error('usage: manual-order.perf.ts --label <baseline|candidate>')
}

const samples: Record<string, unknown>[] = []
for (const size of SIZES) {
  for (let sample = 0; sample < SAMPLES; sample++) {
    const result = spawnSync(process.execPath, [worker, String(size)], {
      encoding: 'utf8',
      timeout: 120_000,
    })
    if (result.error !== undefined) throw result.error
    if (result.signal !== null || result.status !== 0) {
      throw new Error(`manual-order sample failed: ${result.signal ?? result.status}: ${result.stderr}`)
    }
    const line = result.stdout.split(/\r?\n/u).find(candidate => candidate.startsWith(RESULT_PREFIX))
    if (line === undefined) throw new Error(`manual-order sample produced no result: ${result.stdout}`)
    const parsed: unknown = JSON.parse(line.slice(RESULT_PREFIX.length))
    if (!isRecord(parsed)) throw new Error('manual-order sample returned a non-object result')
    samples.push(parsed)
  }
}

const aggregates = Object.fromEntries(SIZES.map((size) => {
  const matching = samples.filter(sample => numberField(sample, 'size') === size)
  const digests = new Set(matching.map(sample => stringField(sample, 'digest')))
  if (digests.size !== 1) throw new Error(`fresh size-${size} samples produced different orders`)
  return [size, {
    wallMsMedian: median(matching.map(sample => numberField(sample, 'wallMs'))),
    cpuTotalMsMedian: median(matching.map(sample => numberField(sample, 'cpuTotalMs'))),
    cpuUserMsMedian: median(matching.map(sample => numberField(sample, 'cpuUserMs'))),
    cpuSystemMsMedian: median(matching.map(sample => numberField(sample, 'cpuSystemMs'))),
    digest: [...digests][0],
  }]
}))

process.stdout.write(JSON.stringify({
  label,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  timing: 'fresh plain-Node process; excludes module loading, fixture construction, warm-up, result verification, and cleanup',
  samples,
  aggregates,
}, null, 2) + '\n')
