/**
 * Follow-level cold opening of one stored parent Session through the real Host
 * history controller.
 *
 * The fixture is a deterministic message-bearing current-format generation;
 * every sample runs in a fresh compiled Node child over its own private copy.
 * The cold no-cache case omits the projection block and times the deferred
 * exact whole-log read separately; the cache-warm reopen case serves a durable
 * complete checkpoint and needs no deferred read. Delegating counters prove
 * neither first snapshot took the complete-observation path, and the deferred
 * read proves those counters see the complete path when it does run.
 */

import { cp, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  runBuiltBenchmarkWorker,
  type BuiltBenchmarkWorkerRun,
} from '../support/built-worker.ts'
import { ciTimeBudget } from '../support/calibration.ts'
import { recordPeakMemory, recordTimings, type BenchmarkCase } from '../support/scaling-report.ts'
import type {
  SessionOpenWorkerReport,
  WindowFirstFollowReport,
} from './session-open.worker.ts'
import { SYNTHETIC_SESSION_DIRECTORY } from './session-open.constants.ts'
import { SYNTHETIC_CURRENT_FILENAME } from './synthetic-released-v0-session.ts'
import {
  FOLLOW_EVENTS_PER_TURN,
  FOLLOW_TURNS_PER_FRAME,
  verifySyntheticFollowSession,
  writeSyntheticFollowProjectionCheckpoint,
  writeSyntheticFollowSession,
  type SyntheticFollowSessionWrite,
} from './synthetic-follow-session.ts'

/** 10,240 completed turns: 61,440 events across 1,281 Zstandard frames. */
const TURNS = 10_240
/** Fresh processes per sample; the reviewed aggregate is their median. */
const ATTEMPTS = 5
/** A stuck child is reaped well before the outer test deadline. */
const WORKER_TIMEOUT_MS = 120_000
/**
 * The production cutoff below which the history controller prefers the complete
 * observation. The fixture must exceed it or the window path is never eligible.
 */
const SMALL_STORED_SESSION_BYTES = 2 * 1024 * 1024
/** Reviewed reference-machine expectation for the cold window-first first snapshot. */
const EXPECTED_FIRST_FRAME_MS = 30
/** CI wall-time limit including the shared machine scale and variance headroom. */
const FIRST_FRAME_BUDGET_MS = ciTimeBudget(EXPECTED_FIRST_FRAME_MS)
/** Reviewed reference-machine expectation for reopening with a complete cached checkpoint. */
const EXPECTED_CACHED_FIRST_FRAME_MS = 38
/** CI wall-time limit for the cache-warm reopen. */
const CACHED_FIRST_FRAME_BUDGET_MS = ciTimeBudget(EXPECTED_CACHED_FIRST_FRAME_MS)
/**
 * Reviewed dimensionless gate: the cold first snapshot may cost at most half of
 * the deferred complete observation whose first-frame work it avoids. The
 * deferred read performs the same full-log materialization as the complete
 * opening path on the same fixture.
 */
const MAX_FIRST_FRAME_SHARE = 0.5

const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'session-open', 'session-open.worker.js')

const FOLLOW_CASE: BenchmarkCase = {
  id: 'session-open/window-first-follow',
  measures: `Cold first snapshot of a stored parent Session (${String(TURNS)} turns, `
    + `${String(TURNS * FOLLOW_EVENTS_PER_TURN)} events, one frame per ${String(FOLLOW_TURNS_PER_FRAME)} turns) `
    + 'through the Host history controller, then the deferred exact whole-log projection read in the same process.',
  affects: 'Opening a large stored Session whose projection cache has no complete checkpoint.',
}

const CACHED_CASE: BenchmarkCase = {
  id: 'session-open/window-first-follow-cached',
  measures: `First snapshot of the same stored parent Session reopened with a durable complete projection checkpoint `
    + `(${String(TURNS)} turns, ${String(TURNS * FOLLOW_EVENTS_PER_TURN)} events) through the Host history controller.`,
  affects: 'Reopening a large stored Session whose projection cache already holds a complete checkpoint.',
}

type FollowScenario = 'window-first-follow' | 'window-first-follow-cached'
type WorkerRun = BuiltBenchmarkWorkerRun<SessionOpenWorkerReport>

function rounded(value: number): number {
  return Math.round(value * 10) / 10
}

function ratio(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

function metric(
  reports: readonly WindowFirstFollowReport[],
  read: (report: WindowFirstFollowReport) => number,
): { readonly min: number; readonly median: number; readonly max: number; readonly samples: readonly number[] } {
  const samples = reports.map(read)
  return {
    min: rounded(Math.min(...samples)),
    median: rounded(median(samples)),
    max: rounded(Math.max(...samples)),
    samples: samples.map(rounded),
  }
}

function exactProjectionsMs(report: WindowFirstFollowReport): number {
  const value = report.opening.exactProjectionsMs
  if (value === undefined) throw new Error('window-first-follow did not measure the exact projection follow-up')
  return value
}

function requireFollow(report: SessionOpenWorkerReport): WindowFirstFollowReport {
  if (report.follow === undefined) throw new Error(`${report.scenario} did not report follow-opening facts`)
  return report.follow
}

function requireReport(run: WorkerRun): SessionOpenWorkerReport {
  if (run.report !== undefined) return run.report
  const stderrLines = run.stderr.trim().split('\n')
  const fatal = stderrLines.filter(line => /FATAL ERROR|heap limit|out of memory/i.test(line))
  const context = stderrLines.length <= 20
    ? stderrLines
    : [...stderrLines.slice(0, 10), '... stderr middle omitted ...', ...stderrLines.slice(-10)]
  const detail = (fatal.length > 0 ? fatal : context).join('\n')
  throw new Error(
    `window-first-follow failed: exit=${String(run.exitCode)}, signal=${String(run.signal)}, `
    + `timedOut=${String(run.timedOut)}\n${detail}`,
  )
}

/** Machine facts recorded beside the reviewed aggregate. */
function machineEvidence(): Record<string, string | number> {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model.trim() ?? 'unknown',
    cores: cpus().length,
  }
}

function expectFirstFrameWithinBudget(value: number): void {
  expect(value).toBeLessThanOrEqual(FIRST_FRAME_BUDGET_MS)
}

function expectCachedFirstFrameWithinBudget(value: number): void {
  expect(value).toBeLessThanOrEqual(CACHED_FIRST_FRAME_BUDGET_MS)
}

/** Owns one message-bearing current-format source and the private roots copied from it. */
class WindowFirstFollowBenchmarkSuite {
  private scratch = ''
  private sourceRoot = ''
  private facts: SyntheticFollowSessionWrite | undefined
  private rootIndex = 0

  async prepare(): Promise<void> {
    this.scratch = await mkdtemp(join(tmpdir(), 'dsh-window-first-follow-bench-'))
    this.sourceRoot = join(this.scratch, 'source')
    this.facts = await writeSyntheticFollowSession(this.sourceRoot, TURNS)
    // The complete-read path proves the fixture is a valid current generation
    // with a message-bearing tail before any opening measurement trusts it.
    await verifySyntheticFollowSession(this.sourceRoot, this.facts)
    // One complete fold outside measurement persists the durable checkpoint
    // the cache-warm reopen serves.
    await writeSyntheticFollowProjectionCheckpoint(this.sourceRoot)
  }

  async dispose(): Promise<void> {
    await rm(this.scratch, { recursive: true, force: true })
  }

  workload(): SyntheticFollowSessionWrite {
    if (this.facts === undefined) throw new Error('window-first follow fixture is not prepared')
    return this.facts
  }

  async sample(scenario: FollowScenario): Promise<readonly WindowFirstFollowReport[]> {
    const facts = this.workload()
    const reports: WindowFirstFollowReport[] = []
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const root = join(this.scratch, `${scenario}-${String(this.rootIndex++)}`)
      if (scenario === 'window-first-follow-cached') {
        // Copy the Session generation and its durable projection-cache domain.
        await cp(this.sourceRoot, root, { recursive: true })
      } else {
        const directory = join(root, SYNTHETIC_SESSION_DIRECTORY)
        await mkdir(directory, { recursive: true })
        await copyFile(facts.path, join(directory, SYNTHETIC_CURRENT_FILENAME))
      }
      const run = await runBuiltBenchmarkWorker<SessionOpenWorkerReport>({
        worker: WORKER,
        args: [root, scenario, String(facts.events)],
        timeoutMs: WORKER_TIMEOUT_MS,
        exposeGc: true,
      })
      reports.push(requireFollow(requireReport(run)))
    }
    return reports
  }
}

describe('cold follow-level window-first Session opening', () => {
  const suite = new WindowFirstFollowBenchmarkSuite()

  beforeAll(async () => { await suite.prepare() })
  afterAll(async () => { await suite.dispose() })

  it('serves the first snapshot from the bounded window without the complete observation', async () => {
    const workload = suite.workload()
    expect(workload.events).toBe(TURNS * FOLLOW_EVENTS_PER_TURN)
    expect(workload.frames).toBe(Math.ceil(TURNS / FOLLOW_TURNS_PER_FRAME) + 1)
    // The controller treats only artifacts strictly smaller than the cutoff as
    // small and would then prefer the complete observation for a legitimate reason.
    expect(workload.compressedBytes).toBeGreaterThanOrEqual(SMALL_STORED_SESSION_BYTES)

    const reports = await suite.sample('window-first-follow')
    for (const report of reports) {
      // Negative control: the window path must answer without the complete
      // observation or a full persistence open, and its snapshot omits the
      // projection block instead of claiming an empty exact cut.
      expect(report.cacheWarm).toBe(false)
      expect(report.opening.path, 'cold window-first opening took the complete-observation path').toBe('window')
      expect(report.opening.projections.kind, 'window-first opening carried a projection block').toBe('absent')
      expect(report.opening.completeObservations, 'first snapshot called observeSession').toBe(0)
      expect(report.fullPersistenceOpens.firstFrame, 'first snapshot opened the complete persistence log').toBe(0)
      expect(report.opening.windowReads, 'first snapshot did not read a bounded stored window').toBeGreaterThanOrEqual(1)
      expect(report.snapshot.records).toBeGreaterThan(0)
      expect(report.snapshot.cursor).toBe(workload.events - 1)
      expect(report.snapshot.hasMore).toBe(true)
      // Positive containment: the deferred exact read performs the complete
      // observation, so the same counters must see exactly one of each. Without
      // this, a broken counter could report the negative control above for free.
      expect(report.exactCalls?.completeObservations, 'deferred exact read did not perform one complete observation').toBe(1)
      expect(report.fullPersistenceOpens.afterExactProjections, 'deferred exact read did not open the complete persistence log').toBe(1)
      expect(report.exact?.asOfSeq).toBe(workload.events - 1)
      expect(report.exact?.valueKeys, 'deferred exact read produced no whole-log projection values').toBeGreaterThan(0)
    }

    const firstFrameMs = metric(reports, report => report.opening.firstFrameMs)
    const firstFrameCpuMs = metric(reports, report => report.cpu.firstFrame)
    const exactProjections = metric(reports, exactProjectionsMs)
    const exactProjectionsCpuMs = metric(reports, report => {
      const value = report.cpu.exactProjections
      if (value === undefined) throw new Error('window-first-follow did not measure exact-projection CPU time')
      return value
    })
    const firstFrameShareOfComplete = ratio(firstFrameMs.median / exactProjections.median)
    const peakRssMb = Math.max(...reports.map(report => report.exactProjectionsMemory?.peakRssMb ?? 0))
    console.log(JSON.stringify({
      benchmark: FOLLOW_CASE.id,
      machine: machineEvidence(),
      workload: {
        turns: workload.turns,
        events: workload.events,
        frames: workload.frames,
        compressedBytes: workload.compressedBytes,
        smallSourceCutoffBytes: SMALL_STORED_SESSION_BYTES,
      },
      samples: reports.map(report => ({
        firstFrameMs: rounded(report.opening.firstFrameMs),
        firstFrameCpuMs: rounded(report.cpu.firstFrame),
        exactProjectionsMs: rounded(exactProjectionsMs(report)),
        exactProjectionsCpuMs: rounded(report.cpu.exactProjections ?? 0),
        firstFrameRetainedHeapMb: report.firstFrameRetained.heapUsedMb,
        exactProjectionsRetainedHeapMb: report.exactProjectionsRetained?.heapUsedMb ?? null,
        windowReads: report.opening.windowReads,
        completeObservations: report.opening.completeObservations,
        fullPersistenceOpens: report.fullPersistenceOpens.firstFrame,
        snapshotRecords: report.snapshot.records,
        exactProjectionValues: report.exact?.valueKeys ?? null,
      })),
      result: {
        firstFrameMs,
        firstFrameCpuMs,
        exactProjectionsMs: exactProjections,
        exactProjectionsCpuMs,
        firstFrameShareOfComplete,
        peakRssMb,
      },
      budgets: {
        firstFrameMs: FIRST_FRAME_BUDGET_MS,
        maxFirstFrameShareOfComplete: MAX_FIRST_FRAME_SHARE,
      },
    }))
    recordTimings(FOLLOW_CASE, {
      firstFrameMs: { ms: firstFrameMs.median, cpuMs: firstFrameCpuMs.median },
      exactProjectionsMs: { ms: exactProjections.median, cpuMs: exactProjectionsCpuMs.median },
    }, { firstFrameMs: FIRST_FRAME_BUDGET_MS })
    recordPeakMemory(FOLLOW_CASE, { peakRssMb })
    expectFirstFrameWithinBudget(firstFrameMs.median)
    expect(firstFrameShareOfComplete).toBeLessThanOrEqual(MAX_FIRST_FRAME_SHARE)
  })

  it('reopens with a complete cached checkpoint without a complete observation or deferred read', async () => {
    const workload = suite.workload()
    const reports = await suite.sample('window-first-follow-cached')
    for (const report of reports) {
      // A cache-warm reopen carries an exact block from the durable checkpoint
      // and needs neither the complete observation nor a deferred whole-log read.
      expect(report.cacheWarm).toBe(true)
      expect(report.opening.path, 'cache-warm reopen fell back to the complete-observation path').toBe('window')
      expect(report.opening.projections.kind, 'cache-warm reopen omitted its exact projection block').toBe('exact')
      if (report.opening.projections.kind !== 'exact') throw new Error('cache-warm reopen carried no exact block')
      expect(report.opening.projections.cut.asOfSeq).toBe(workload.events - 1)
      expect(report.opening.projections.cut.values).toBeTruthy()
      expect(report.opening.exactProjectionsMs, 'cache-warm reopen scheduled a deferred exact read').toBeUndefined()
      expect(report.opening.completeObservations, 'cache-warm reopen called observeSession').toBe(0)
      expect(report.fullPersistenceOpens.firstFrame, 'cache-warm reopen opened the complete persistence log').toBe(0)
      expect(report.opening.windowReads, 'cache-warm reopen did not read a bounded stored window').toBeGreaterThanOrEqual(1)
      expect(report.snapshot.records).toBeGreaterThan(0)
      expect(report.snapshot.cursor).toBe(workload.events - 1)
      expect(report.snapshot.hasMore).toBe(true)
    }

    const firstFrameMs = metric(reports, report => report.opening.firstFrameMs)
    const firstFrameCpuMs = metric(reports, report => report.cpu.firstFrame)
    const peakRssMb = Math.max(...reports.map(report => report.firstFrameMemory.peakRssMb))
    console.log(JSON.stringify({
      benchmark: CACHED_CASE.id,
      machine: machineEvidence(),
      workload: {
        turns: workload.turns,
        events: workload.events,
        frames: workload.frames,
        compressedBytes: workload.compressedBytes,
      },
      samples: reports.map(report => ({
        firstFrameMs: rounded(report.opening.firstFrameMs),
        firstFrameCpuMs: rounded(report.cpu.firstFrame),
        firstFrameRetainedHeapMb: report.firstFrameRetained.heapUsedMb,
        windowReads: report.opening.windowReads,
        completeObservations: report.opening.completeObservations,
        fullPersistenceOpens: report.fullPersistenceOpens.firstFrame,
        snapshotRecords: report.snapshot.records,
        exactProjectionValues: Object.keys(
          report.opening.projections.kind === 'exact' ? report.opening.projections.cut.values : {},
        ).length,
      })),
      result: { firstFrameMs, firstFrameCpuMs, peakRssMb },
      budgets: { firstFrameMs: CACHED_FIRST_FRAME_BUDGET_MS },
    }))
    recordTimings(CACHED_CASE, {
      firstFrameMs: { ms: firstFrameMs.median, cpuMs: firstFrameCpuMs.median },
    }, { firstFrameMs: CACHED_FIRST_FRAME_BUDGET_MS })
    recordPeakMemory(CACHED_CASE, { peakRssMb })
    expectCachedFirstFrameWithinBudget(firstFrameMs.median)
  })
})

describe('window-first follow budget calibration', () => {
  it('accepts the recorded reference medians and rejects material regressions', () => {
    const recordedColdMedian = median([30.7, 29.7, 30.7, 30.1, 30.3])
    const recordedCachedMedian = median([40.2, 37.5, 35.3, 37.4, 35.9])

    expect(recordedColdMedian).toBe(30.3)
    expect(recordedCachedMedian).toBe(37.4)
    expect(FIRST_FRAME_BUDGET_MS).toBe(75)
    expect(CACHED_FIRST_FRAME_BUDGET_MS).toBe(95)
    expect(() => expectFirstFrameWithinBudget(recordedColdMedian)).not.toThrow()
    expect(() => expectCachedFirstFrameWithinBudget(recordedCachedMedian)).not.toThrow()
    expect(() => expectFirstFrameWithinBudget(Math.ceil(FIRST_FRAME_BUDGET_MS * 1.26))).toThrow()
    expect(() => expectCachedFirstFrameWithinBudget(Math.ceil(CACHED_FIRST_FRAME_BUDGET_MS * 1.26))).toThrow()
  })
})
