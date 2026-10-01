/** Fork-only Host diagnostics installed by run.cmd through a supported profile overlay. */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freemem } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Session } from 'node:inspector'
import { constants, monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks'
import { getHeapStatistics, writeHeapSnapshot } from 'node:v8'
import { attachLifetimeProbe } from './lifetime.mjs'
import { MiB, snapshotBlocked, validateConfig } from './policy.mjs'

/** Cordis plugin name. */
export const name = 'fork-memory-recorder'

function sourceIdentity() {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const hashes = {}
  for (const name of ['run.cmd', 'fork-runtime/diagnostics/index.mjs', 'fork-runtime/diagnostics/lifetime.mjs', 'fork-runtime/diagnostics/policy.mjs', 'fork-runtime/diagnostics/cordis.patch.yml']) {
    hashes[name] = createHash('sha256').update(readFileSync(join(root, name))).digest('hex')
  }
  const installed = {}
  if (process.env.DSH_HOME) {
    const profile = join(process.env.DSH_HOME, 'profiles', 'web')
    for (const name of ['package.json', 'cordis.patch.yml']) {
      try { hashes[`profile/${name}`] = createHash('sha256').update(readFileSync(join(profile, name))).digest('hex') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    for (const name of ['dsh-context', 'dsh-plugin-subscriptions', '@nanmicoder/dsh-agent-teams']) {
      try {
        const packageRoot = join(profile, 'node_modules', name)
        const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
        installed[name] = { version: manifest.version,
          entrySha256: createHash('sha256').update(readFileSync(join(packageRoot, 'lib', 'index.js'))).digest('hex') }
      } catch (error) {
        installed[name] = { unavailable: error.code ?? error.name }
      }
    }
  }
  try {
    const options = { cwd: root, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    return { hashes, installed, revision: execFileSync('git', ['rev-parse', 'HEAD'], options).trim(),
      dirtyFiles: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], options).trim().split('\n').filter(Boolean).length }
  } catch (error) {
    return { hashes, installed, gitError: error.code ?? error.name }
  }
}

function captureBytes(root) {
  let bytes = 0
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue
    for (const file of readdirSync(join(root, entry.name), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.heapsnapshot')) bytes += statSync(join(root, entry.name, file.name)).size
    }
  }
  return bytes
}

/** Install bounded diagnostics without opening an Inspector TCP listener.
 * @param {object} ctx Cordis effect and lifecycle event context.
 * @param {object} options Explicit settings from cordis.patch.yml.
 */
export async function apply(ctx, options) {
  const config = validateConfig(options)
  const root = resolve(process.env.DSH_DIAGNOSTICS || join(process.env.DSH_HOME || '.dsh', 'diagnostics'), 'memory-runs')
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, `run-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}-`))
  const log = join(dir, 'events.ndjson')
  let logBytes = 0
  let closed = false
  let ioFailed = false
  function emit(value) {
    if (ioFailed) return
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value }) + '\n'
      if (logBytes + Buffer.byteLength(line) > config.logFileMiB * MiB) {
        for (let i = config.logFiles - 1; i >= 1; i--) {
          const from = i === 1 ? log : `${log}.${i - 1}`
          const to = `${log}.${i}`
          try { unlinkSync(to) } catch (error) { if (error.code !== 'ENOENT') throw error }
          try { renameSync(from, to) } catch (error) { if (error.code !== 'ENOENT') throw error }
        }
        logBytes = 0
      }
      appendFileSync(log, line)
      logBytes += Buffer.byteLength(line)
    } catch (error) {
      ioFailed = true
      console.error(`[memory-recorder] logging disabled: ${error.code ?? error.name}`)
    }
  }
  const inspector = new Session()
  const post = (method, params = {}) => new Promise((resolve, reject) => {
    inspector.post(method, params, (error, value) => error ? reject(error) : resolve(value))
  })
  const gc = { major: 0, minor: 0, other: 0, durationMs: 0, lastMajorAt: null }
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      const kind = entry.detail.kind
      if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) { gc.major++; gc.lastMajorAt = Date.now() }
      else if (kind === constants.NODE_PERFORMANCE_GC_MINOR) gc.minor++
      else gc.other++
      gc.durationMs += entry.duration
    }
  })
  const delay = monitorEventLoopDelay({ resolution: 20 })
  let lifetime
  let timer
  let sampling = false
  let busy = false
  let profiles = 0
  let snapshots = 0
  let baselineHeap = 0
  let lastProfile = 0
  let lastSkip = ''
  let retainedAfterGc = false
  const started = Date.now()
  ctx.effect(() => () => {
    closed = true
    clearInterval(timer)
    observer.disconnect()
    delay.disable()
    lifetime?.dispose()
    inspector.disconnect()
    emit({ phase: 'stopped', memory: process.memoryUsage(), gc })
  })
  try {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ format: 1, startedAt: new Date(started).toISOString(),
      pid: process.pid, node: process.version, platform: process.platform, arch: process.arch,
      config, source: sourceIdentity(), snapshotWarning: 'Full heap snapshots contain private runtime data and pause the Host.' }, null, 2) + '\n')
    observer.observe({ entryTypes: ['gc'] })
    delay.enable()
    inspector.connect()
    await post('HeapProfiler.enable')
    if (closed) return
    await post('HeapProfiler.startSampling', { samplingInterval: config.samplingIntervalBytes })
    if (closed) return
    sampling = true
  } catch (error) {
    if (!closed) emit({ phase: 'sampling-unavailable', error: error.code ?? error.name })
  }
  if (closed) return
  lifetime = attachLifetimeProbe(ctx, { maxTracked: config.maxTracked, maxDetails: config.maxDetails,
    minDisposedAgeMs: config.minDisposedAgeMs, getGcEpoch: () => gc.major, emit })

  async function tick() {
    if (closed || busy || ioFailed) return
    busy = true
    try {
      const memory = process.memoryUsage()
      const wanted = Date.now() - started >= config.snapshotDelayMs && snapshots < 2 &&
        (snapshots === 0 || memory.heapUsed - baselineHeap >= config.snapshotGrowthMiB * MiB || retainedAfterGc)
      // No WeakRef is dereferenced in this job before V8 captures the graph.
      if (wanted) {
        const disk = statfsSync(dir)
        const reason = snapshotBlocked(config, { ...memory, freeMemory: freemem(),
          freeDisk: disk.bavail * disk.bsize, capturedBytes: captureBytes(root) })
        if (reason) {
          if (reason !== lastSkip) emit({ phase: 'snapshot-skipped', reason, memory })
          lastSkip = reason
        } else {
          const stage = snapshots === 0 ? 'baseline' : 'growth'
          const start = Date.now()
          emit({ phase: 'snapshot-start', stage, memory })
          // Failed captures consume the attempt too: repeated pauses cannot help a failing recorder.
          snapshots++
          const destination = join(dir, `${stage}.heapsnapshot`)
          writeFileSync(destination, '', { flag: 'wx', mode: 0o600 })
          const file = writeHeapSnapshot(destination)
          baselineHeap = memory.heapUsed
          emit({ phase: 'snapshot-saved', stage, file: file.slice(dir.length + 1), bytes: statSync(file).size, durationMs: Date.now() - start })
        }
      }
      const summary = lifetime.sample()
      retainedAfterGc = summary.details.some(item => item.majorGcSinceDispose >= 2 && item.ageMs >= config.minDisposedAgeMs)
      const resources = {}
      for (const kind of process.getActiveResourcesInfo()) resources[kind] = (resources[kind] ?? 0) + 1
      emit({ phase: 'sample', memory, heapLimit: getHeapStatistics().heap_size_limit, gc: { ...gc }, lifetime: summary,
        resources, eventLoop: { meanMs: Number.isFinite(delay.mean) ? delay.mean / 1e6 : 0, maxMs: delay.max / 1e6, p99Ms: delay.percentile(99) / 1e6 } })
      delay.reset()
      if (sampling && Date.now() - lastProfile >= config.profileIntervalMs) {
        lastProfile = Date.now()
        const { profile } = await post('HeapProfiler.getSamplingProfile')
        if (closed) return
        const json = JSON.stringify(profile)
        if (Buffer.byteLength(json) <= config.profileFileMiB * MiB) {
          const file = `allocations-${profiles++ % config.profileFiles}.heapprofile`
          const pending = join(dir, `${file}.pending`)
          writeFileSync(pending, json)
          renameSync(pending, join(dir, file))
          emit({ phase: 'profile-saved', file, bytes: Buffer.byteLength(json) })
        } else emit({ phase: 'profile-skipped', reason: 'file-limit', bytes: Buffer.byteLength(json) })
      }
    } catch (error) {
      if (!closed) emit({ phase: 'recorder-error', error: error.code ?? error.name })
    } finally { busy = false }
  }
  emit({ phase: 'started', sampling, memory: process.memoryUsage() })
  console.error(`[memory-recorder] evidence: ${dir}`)
  timer = setInterval(() => { void tick() }, config.intervalMs)
  timer.unref()
}
