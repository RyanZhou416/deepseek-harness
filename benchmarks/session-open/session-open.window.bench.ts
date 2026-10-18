/**
 * History-window measurements over one dense current-format generation.
 *
 * The fixture is a real current-format JSONL artifact with one event per
 * physical row and one Zstandard frame per row, so the newest tail read, the
 * first backwards (`beforeSeq`) page that also builds the durable index, and
 * the warm repeat page all execute the production read path. The cases record
 * measured wall time and process CPU time; they assert only structural window
 * facts, never a reviewed duration or an ordering between endpoints.
 */

import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  runBuiltBenchmarkWorker,
  type BuiltBenchmarkWorkerRun,
} from '../support/built-worker.ts'
import { recordTimings, type BenchmarkCase } from '../support/scaling-report.ts'
import type {
  SessionOpenBenchmarkScenario,
  SessionOpenWorkerReport,
  SessionWindowBenchmarkReport,
} from './session-open.worker.ts'
import {
  SYNTHETIC_SESSION_DIRECTORY,
  WINDOW_BENCHMARK_MAX_EVENTS,
} from './session-open.constants.ts'
import { SYNTHETIC_CURRENT_FILENAME } from './synthetic-released-v0-session.ts'
import {
  verifySyntheticDenseCurrentSession,
  writeSyntheticDenseCurrentSession,
  type SyntheticDenseCurrentSessionWrite,
} from './synthetic-dense-current-session.ts'

/** 16,384 completed turns: 32,768 events, 32,769 Zstandard frames. */
const TURNS = 16_384
/** Fresh processes per window scenario; each sample opens its own fixture copy. */
const ATTEMPTS = 3
/** A stuck child is reaped well before the outer hook and test deadlines. */
const WORKER_TIMEOUT_MS = 120_000

const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'session-open', 'session-open.worker.js')

type WindowScenario = Extract<SessionOpenBenchmarkScenario, 'window-tail' | 'window-beforeSeq'>
type WorkerRun = BuiltBenchmarkWorkerRun<SessionOpenWorkerReport>

function rounded(value: number): number {
  return Math.round(value * 10) / 10
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

function metric(
  reports: readonly SessionWindowBenchmarkReport[],
  read: (report: SessionWindowBenchmarkReport) => number,
): { readonly min: number; readonly median: number; readonly max: number; readonly samples: readonly number[] } {
  const samples = reports.map(read)
  return {
    min: rounded(Math.min(...samples)),
    median: rounded(median(samples)),
    max: rounded(Math.max(...samples)),
    samples: samples.map(rounded),
  }
}

function summarizeWindow(reports: readonly SessionWindowBenchmarkReport[]) {
  return {
    firstMs: metric(reports, report => report.first.ms),
    firstCpuMs: metric(reports, report => report.first.cpuMs),
    secondMs: metric(reports, report => report.second.ms),
    secondCpuMs: metric(reports, report => report.second.cpuMs),
  }
}

function requireWindow(report: SessionOpenWorkerReport): SessionWindowBenchmarkReport {
  if (report.window === undefined) throw new Error(`${report.scenario} did not report history-window facts`)
  return report.window
}

function requireReport(run: WorkerRun, scenario: WindowScenario): SessionOpenWorkerReport {
  if (run.report !== undefined) return run.report
  const stderrLines = run.stderr.trim().split('\n')
  const fatal = stderrLines.filter(line => /FATAL ERROR|heap limit|out of memory/i.test(line))
  const context = stderrLines.length <= 20
    ? stderrLines
    : [...stderrLines.slice(0, 10), '... stderr middle omitted ...', ...stderrLines.slice(-10)]
  const detail = (fatal.length > 0 ? fatal : context).join('\n')
  throw new Error(
    `${scenario} failed: exit=${String(run.exitCode)}, signal=${String(run.signal)}, `
    + `timedOut=${String(run.timedOut)}\n${detail}`,
  )
}

/** Owns one dense current-format source and the private roots copied from it. */
class SessionWindowBenchmarkSuite {
  private scratch = ''
  private sourcePath = ''
  private facts: SyntheticDenseCurrentSessionWrite | undefined
  private rootIndex = 0

  async prepare(): Promise<void> {
    this.scratch = await mkdtemp(join(tmpdir(), 'dsh-session-window-bench-'))
    const sourceRoot = join(this.scratch, 'source')
    this.facts = await writeSyntheticDenseCurrentSession(sourceRoot, TURNS)
    // The complete-read path proves the handwritten artifact is a valid current
    // generation before any window measurement trusts its rows.
    await verifySyntheticDenseCurrentSession(sourceRoot, this.facts.events)
    this.sourcePath = this.facts.path
  }

  async dispose(): Promise<void> {
    await rm(this.scratch, { recursive: true, force: true })
  }

  workload(): SyntheticDenseCurrentSessionWrite {
    if (this.facts === undefined) throw new Error('history-window fixture is not prepared')
    return this.facts
  }

  async sample(scenario: WindowScenario): Promise<readonly SessionWindowBenchmarkReport[]> {
    const reports: SessionWindowBenchmarkReport[] = []
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const root = join(this.scratch, `${scenario}-${String(this.rootIndex++)}`)
      const directory = join(root, SYNTHETIC_SESSION_DIRECTORY)
      await mkdir(directory, { recursive: true })
      await copyFile(this.sourcePath, join(directory, SYNTHETIC_CURRENT_FILENAME))
      const run = await runBuiltBenchmarkWorker<SessionOpenWorkerReport>({
        worker: WORKER,
        args: [root, scenario, String(this.workload().events)],
        timeoutMs: WORKER_TIMEOUT_MS,
        exposeGc: true,
      })
      reports.push(requireWindow(requireReport(run, scenario)))
    }
    return reports
  }
}

function windowCase(id: string, measures: string, affects: string): BenchmarkCase {
  return { id, measures, affects }
}

describe('history-window reads from a dense current-format generation', () => {
  const suite = new SessionWindowBenchmarkSuite()

  beforeAll(async () => { await suite.prepare() })
  afterAll(async () => { await suite.dispose() })

  it('reads the newest window and its warm repeat', async () => {
    const workload = suite.workload()
    // One event per physical row and one frame per row: the measured path is the
    // dense multi-frame layout this case exists to cover.
    expect(workload.rows).toBe(workload.events)
    expect(workload.frames).toBe(workload.events + 1)
    const reports = await suite.sample('window-tail')
    const expectedEvents = Math.min(WINDOW_BENCHMARK_MAX_EVENTS, workload.events)
    for (const report of reports) {
      expect(report.totalEvents).toBe(workload.events)
      expect(report.expectedEvents).toBe(expectedEvents)
      expect(report.expectedFirstSeq).toBe(workload.events - expectedEvents)
      expect(report.cursor).toBe(workload.events - 1)
      expect(report.hasMore).toBe(true)
      expect(report.first.events).toBe(expectedEvents)
      expect(report.second.events).toBe(expectedEvents)
    }
    const result = summarizeWindow(reports)
    console.log(JSON.stringify({
      benchmark: 'session-open/window/tail',
      workload: {
        events: workload.events,
        rows: workload.rows,
        frames: workload.frames,
        compressedBytes: workload.compressedBytes,
        logicalBytes: workload.logicalBytes,
      },
      windowEvents: expectedEvents,
      result,
    }))
    recordTimings(windowCase(
      'session-open/window/tail',
      `Newest ${String(expectedEvents)}-event window read from one dense current-format generation of `
        + `${String(workload.events)} events across ${String(workload.frames)} Zstandard frames; `
        + 'the first call and its warm repeat.',
      'Opening the newest history page of a large stored Session in a new process.',
    ), {
      first: { ms: result.firstMs.median, cpuMs: result.firstCpuMs.median },
      second: { ms: result.secondMs.median, cpuMs: result.secondCpuMs.median },
    })
  })

  it('builds the generation index for the first beforeSeq page and reuses it warm', async () => {
    const workload = suite.workload()
    const reports = await suite.sample('window-beforeSeq')
    const expectedEvents = Math.min(WINDOW_BENCHMARK_MAX_EVENTS, workload.events)
    for (const report of reports) {
      expect(report.totalEvents).toBe(workload.events)
      expect(report.expectedEvents).toBe(expectedEvents)
      expect(report.expectedFirstSeq).toBe(workload.events - expectedEvents)
      expect(report.cursor).toBe(workload.events - 1)
      expect(report.hasMore).toBe(true)
      expect(report.first.events).toBe(expectedEvents)
      expect(report.second.events).toBe(expectedEvents)
      expect(report.indexCreated).toBe(true)
      expect(report.indexReused).toBe(true)
    }
    const result = summarizeWindow(reports)
    console.log(JSON.stringify({
      benchmark: 'session-open/window/beforeSeq',
      workload: {
        events: workload.events,
        rows: workload.rows,
        frames: workload.frames,
        compressedBytes: workload.compressedBytes,
        logicalBytes: workload.logicalBytes,
      },
      windowEvents: expectedEvents,
      result,
    }))
    recordTimings(windowCase(
      'session-open/window/beforeSeq',
      `Backwards ${String(expectedEvents)}-event window from one dense current-format generation of `
        + `${String(workload.events)} events across ${String(workload.frames)} Zstandard frames; `
        + 'the first call (which also builds the durable index sidecar) and its warm repeat.',
      'Paging backwards through the history of a large stored Session in a new process.',
    ), {
      first: { ms: result.firstMs.median, cpuMs: result.firstCpuMs.median },
      second: { ms: result.secondMs.median, cpuMs: result.secondCpuMs.median },
    })
  })
})
