/** Process-isolated recorder fixture with private output and no DSH profile. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import v8 from 'node:v8'
import inspectorModule from 'node:inspector'
import perf from 'node:perf_hooks'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { MiB, snapshotBlocked, validateConfig } from '../../fork-runtime/diagnostics/policy.mjs'

const config = {
  intervalMs: 5000, profileIntervalMs: 30000, samplingIntervalBytes: 65536,
  maxTracked: 20, maxDetails: 10, minDisposedAgeMs: 1000,
  logFileMiB: 1, logFiles: 2, profileFileMiB: 1, profileFiles: 2,
  snapshots: true, snapshotDelayMs: 1000, snapshotGrowthMiB: 10,
  snapshotMaxHeapMiB: 100, snapshotMaxHeapTotalMiB: 200,
  reserveMiB: 10, reserveHeapMultiplier: 2, captureBudgetMiB: 1000,
}
const scenario = process.argv[2]
const root = fs.mkdtempSync(join(os.tmpdir(), 'dsh-memory-recorder-test-'))
process.env.DSH_DIAGNOSTICS = root
let now = 1_800_000_000_000
const originalNow = Date.now
Date.now = () => now
let scheduled
let cleared = 0
let unrefed = 0
globalThis.setInterval = (callback, interval) => {
  assert.equal(interval, config.intervalMs)
  scheduled = callback
  return { unref() { unrefed += 1 } }
}
globalThis.clearInterval = () => { cleared += 1 }

class ContextFixture {
  listeners = new Map()
  cleanup = []
  effect(install) { this.cleanup.push(install()) }
  on(event, callback) {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(callback)
    this.listeners.set(event, listeners)
    return () => { listeners.delete(callback) }
  }
  send(event, payload) {
    for (const callback of this.listeners.get(event) ?? []) callback(payload)
  }
  dispose() {
    for (const cleanup of this.cleanup.splice(0)) cleanup()
  }
}
const ctx = new ContextFixture()
let disconnected = 0
let observerStopped = 0
let delayStopped = 0
let observedGc
let pendingProfile
let pendingEnable
const postedMethods = []
let holdProfile = false
const snapshotCalls = []
let memory = { heapUsed: 20 * MiB, heapTotal: 30 * MiB, rss: 60 * MiB, external: 0, arrayBuffers: 0 }
let freeMemory = 2000 * MiB
let freeDisk = 2000 * MiB
if (!scenario.startsWith('inspector')) {
  os.freemem = () => freeMemory
  fs.statfsSync = () => ({ bavail: freeDisk, bsize: 1 })
  v8.writeHeapSnapshot = file => {
    snapshotCalls.push(file)
    fs.writeFileSync(file, 'synthetic heap snapshot fixture')
    return file
  }
  v8.getHeapStatistics = () => ({ heap_size_limit: 4000 * MiB })
  process.memoryUsage = () => ({ ...memory })
  inspectorModule.Session = class {
    connect() {}
    disconnect() { disconnected += 1 }
    post(method, params, callback) {
      postedMethods.push(method)
      if (method === 'HeapProfiler.enable' && scenario === 'startup-dispose') {
        pendingEnable = callback
        return
      }
      if (method === 'HeapProfiler.getSamplingProfile') {
        if (holdProfile) pendingProfile = callback
        else callback(null, { profile: { head: { callFrame: { functionName: 'fixture' }, children: [] }, samples: [] } })
      } else callback(null, {})
    }
  }
  perf.PerformanceObserver = class {
    constructor(callback) { observedGc = callback }
    observe() {}
    disconnect() { observerStopped += 1 }
  }
  perf.monitorEventLoopDelay = () => ({
    mean: 1e6, max: 2e6, percentile: () => 1.5e6,
    enable() {}, disable() { delayStopped += 1 }, reset() {},
  })
  syncBuiltinESMExports()
}
let runDir
const records = () => fs.readFileSync(join(runDir, 'events.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const tick = async () => {
  now += config.intervalMs
  scheduled()
  await new Promise(setImmediate)
}
try {
  if (scenario === 'policy') {
    assert.equal(validateConfig(config), config)
    assert.throws(() => validateConfig({ ...config, maxDetails: 21 }), /maxDetails/u)
    assert.throws(() => validateConfig({ ...config, intervalMs: 100 }), /intervalMs/u)
    assert.throws(() => validateConfig({ ...config, snapshots: 1 }), /snapshots/u)
    const state = { ...memory, freeMemory, freeDisk, capturedBytes: 0 }
    assert.equal(snapshotBlocked(config, state), null)
    assert.equal(snapshotBlocked({ ...config, snapshots: false }, state), 'disabled')
    assert.equal(snapshotBlocked(config, { ...state, heapUsed: 101 * MiB }), 'heap-used-limit')
    assert.equal(snapshotBlocked(config, { ...state, heapTotal: 201 * MiB }), 'heap-total-limit')
    assert.equal(snapshotBlocked(config, { ...state, freeMemory: 69 * MiB }), 'memory-reserve')
    assert.equal(snapshotBlocked(config, { ...state, freeDisk: 69 * MiB }), 'disk-reserve')
    assert.equal(snapshotBlocked(config, { ...state, capturedBytes: 931 * MiB }), 'capture-budget')
    assert.equal(snapshotBlocked(config, { ...state, capturedBytes: 930 * MiB, freeDisk: 70 * MiB, freeMemory: 70 * MiB }), null)
  } else {
    const { apply } = await import('../../fork-runtime/diagnostics/index.mjs')
    const starting = apply(ctx, { ...config, snapshots: !scenario.startsWith('inspector') && !scenario.startsWith('dispose') })
    if (scenario === 'startup-dispose') {
      assert.equal(typeof pendingEnable, 'function')
      ctx.dispose()
      pendingEnable(null, {})
    }
    await starting
    const runs = fs.readdirSync(join(root, 'memory-runs'))
    assert.equal(runs.length, 1)
    runDir = join(root, 'memory-runs', runs[0])
    assert.equal(unrefed, scenario === 'startup-dispose' ? 0 : 1)
    const manifest = JSON.parse(fs.readFileSync(join(runDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.config.maxTracked, 20)
    assert.equal(Object.keys(manifest.source.hashes).length, 5)
    if (scenario !== 'startup-dispose') assert.equal(records().find(record => record.phase === 'started').sampling, true)
    if (scenario === 'startup-dispose') {
      assert.deepEqual(postedMethods, ['HeapProfiler.enable'])
      assert.equal(records().at(-1).phase, 'stopped')
    } else if (scenario === 'inspector') {
      const retained = Array.from({ length: 10000 }, (_, i) => ({ sample: `allocation-${i}`, payload: new Array(20).fill(i) }))
      await tick()
      const profileFile = records().find(record => record.phase === 'profile-saved')?.file
      assert.ok(profileFile, JSON.stringify(records()))
      const profile = JSON.parse(fs.readFileSync(join(runDir, profileFile), 'utf8'))
      assert.ok(profile.head)
      assert.ok(Array.isArray(profile.samples))
      assert.ok(profile.samples.length > 0)
      assert.equal(fs.readdirSync(runDir).filter(file => file.endsWith('.heapsnapshot')).length, 0)
      assert.equal(retained.length, 10000)
      assert.equal(inspectorModule.url(), undefined)
    } else if (scenario === 'inspector-gc') {
      const weak = (() => {
        const session = { seq: 123, allocation: new Array(100000).fill(1) }
        ctx.send('session/created', session)
        ctx.send('session/disposed', session)
        return new WeakRef(session)
      })()
      await tick()
      const deadline = originalNow() + 5000
      do {
        await new Promise(setImmediate)
        global.gc()
        await new Promise(setImmediate)
        await tick()
        if (weak.deref() === undefined) break
      } while (originalNow() < deadline)
      assert.equal(weak.deref(), undefined)
      assert.equal(records().filter(record => record.phase === 'sample').at(-1).lifetime.sessionsCollected, 1)
      assert.equal(records().filter(record => record.phase === 'snapshot-saved').length, 0)
    } else if (scenario === 'guards') {
      memory.heapUsed = 101 * MiB
      await tick()
      memory.heapUsed = 20 * MiB
      memory.heapTotal = 201 * MiB
      await tick()
      memory.heapTotal = 30 * MiB
      freeMemory = 69 * MiB
      await tick()
      freeMemory = 2000 * MiB
      freeDisk = 69 * MiB
      await tick()
      assert.equal(snapshotCalls.length, 0)
      assert.deepEqual(records().filter(record => record.phase === 'snapshot-skipped').map(record => record.reason),
        ['heap-used-limit', 'heap-total-limit', 'memory-reserve', 'disk-reserve'])
      freeDisk = 2000 * MiB
      await tick()
      assert.equal(snapshotCalls.length, 1)
      memory.heapUsed = 40 * MiB
      await tick()
      assert.equal(snapshotCalls.length, 2)
      memory.heapUsed = 80 * MiB
      await tick()
      assert.equal(snapshotCalls.length, 2)
      assert.deepEqual(records().filter(record => record.phase === 'snapshot-saved').map(record => record.stage), ['baseline', 'growth'])
    } else if (scenario === 'retention-trigger') {
      const session = { seq: 123 }
      ctx.send('session/created', session)
      await tick()
      assert.equal(snapshotCalls.length, 1)
      ctx.send('session/disposed', session)
      observedGc({ getEntries: () => [
        { detail: { kind: perf.constants.NODE_PERFORMANCE_GC_MAJOR }, duration: 1 },
        { detail: { kind: perf.constants.NODE_PERFORMANCE_GC_MAJOR }, duration: 1 },
      ] })
      await tick()
      assert.equal(snapshotCalls.length, 1)
      await tick()
      assert.equal(snapshotCalls.length, 2)
      assert.equal(session.seq, 123)
    } else if (scenario === 'dispose' || scenario === 'dispose-error') {
      holdProfile = true
      await tick()
      assert.equal(typeof pendingProfile, 'function')
      ctx.dispose()
      const before = fs.readFileSync(join(runDir, 'events.ndjson'), 'utf8')
      if (scenario === 'dispose-error') pendingProfile(Error('inspector disconnected'))
      else pendingProfile(null, { profile: {} })
      await new Promise(setImmediate)
      await tick()
      assert.equal(fs.readFileSync(join(runDir, 'events.ndjson'), 'utf8'), before)
      assert.equal(fs.readdirSync(runDir).some(file => file.endsWith('.heapprofile')), false)
    } else {
      throw Error(`unknown recorder fixture scenario: ${scenario}`)
    }
    ctx.dispose()
    const before = fs.readFileSync(join(runDir, 'events.ndjson'), 'utf8')
    if (scenario !== 'startup-dispose') await tick()
    assert.equal(fs.readFileSync(join(runDir, 'events.ndjson'), 'utf8'), before)
    assert.equal([...ctx.listeners.values()].every(listeners => listeners.size === 0), true)
    assert.equal(cleared, 1)
    if (!scenario.startsWith('inspector')) {
      assert.equal(disconnected, 1)
      assert.equal(observerStopped, 1)
      assert.equal(delayStopped, 1)
    }
  }
} finally {
  ctx.dispose()
  Date.now = originalNow
  fs.rmSync(root, { recursive: true, force: true })
}
console.log(JSON.stringify({ scenario, passed: true }))
