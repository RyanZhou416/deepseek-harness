'use strict'

const { appendFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { getHeapStatistics } = require('node:v8')

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback
}

function integer(value, fallback) {
  return Number.isSafeInteger(value) ? Number(value) : fallback
}

function resolveConfig(config = {}) {
  const resolved = {
    sampleIntervalMs: integer(config.sampleIntervalMs, 500),
    logIntervalMs: integer(config.logIntervalMs, 60_000),
    warningRatio: finiteNumber(config.warningRatio, 0.62),
    restartRatio: finiteNumber(config.restartRatio, 0.72),
    sustainedSamples: integer(config.sustainedSamples, 4),
    restartExitCode: integer(config.restartExitCode, 75),
    rssWarningMiB: finiteNumber(config.rssWarningMiB, 0),
    rssRestartMiB: finiteNumber(config.rssRestartMiB, 0),
  }
  if (resolved.sampleIntervalMs < 100 || resolved.logIntervalMs < resolved.sampleIntervalMs) {
    throw new Error('memory-watchdog: invalid sampling interval')
  }
  if (!(resolved.warningRatio > 0 && resolved.warningRatio < resolved.restartRatio
      && resolved.restartRatio < 0.95)) {
    throw new Error('memory-watchdog: expected 0 < warningRatio < restartRatio < 0.95')
  }
  if (resolved.sustainedSamples < 1 || resolved.restartExitCode < 1 || resolved.restartExitCode > 255) {
    throw new Error('memory-watchdog: invalid sustainedSamples or restartExitCode')
  }
  if (resolved.rssWarningMiB < 0 || resolved.rssRestartMiB < 0
      || ((resolved.rssWarningMiB > 0 || resolved.rssRestartMiB > 0)
        && !(resolved.rssWarningMiB > 0 && resolved.rssWarningMiB < resolved.rssRestartMiB))) {
    throw new Error('memory-watchdog: RSS limits must be disabled together or satisfy 0 < warning < restart')
  }
  return resolved
}

function configuredOldSpaceLimit() {
  // NODE_OPTIONS is parsed before command-line flags; within either source the
  // last singleton value wins. Walk in that same precedence order.
  const sources = [process.env.NODE_OPTIONS || '', process.execArgv.join(' ')]
  let configured
  for (const source of sources) {
    const pattern = /--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)/ig
    let match
    while ((match = pattern.exec(source)) !== null) {
      const mib = Number(match[1])
      if (Number.isSafeInteger(mib) && mib > 0) configured = { mib, bytes: mib * 1024 * 1024 }
    }
  }
  return configured
}

function memorySnapshot() {
  const usage = process.memoryUsage()
  const heapSizeLimit = getHeapStatistics().heap_size_limit
  const configured = configuredOldSpaceLimit()
  // For small --max-old-space-size values V8's heap_size_limit includes a
  // proportionally large young-generation allowance. OOM is still governed by
  // the old-generation ceiling, so use the stricter observable limit.
  const effectiveHeapLimit = configured === undefined
    ? heapSizeLimit
    : Math.min(heapSizeLimit, configured.bytes)
  return {
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    heapSizeLimit,
    effectiveHeapLimit,
    maxOldSpaceMiB: configured?.mib,
    heapRatio: effectiveHeapLimit > 0 ? usage.heapUsed / effectiveHeapLimit : 0,
    rss: usage.rss,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  }
}

function appendDiagnostic(path, event, extra = {}) {
  try {
    appendFileSync(path, JSON.stringify({
      version: 1,
      at: new Date().toISOString(),
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      event,
      ...extra,
    }) + '\n', 'utf8')
  } catch (error) {
    console.error('[memory-watchdog] diagnostic write failed: '
      + (error && error.message ? error.message : String(error)))
  }
}

module.exports = {
  name: 'local-memory-watchdog',
  apply(ctx, config = {}) {
    const resolved = resolveConfig(config)
    const diagnosticsDir = process.env.DSH_DIAGNOSTICS
      || join(process.env.DSH_HOME || process.cwd(), 'diagnostics')
    mkdirSync(diagnosticsDir, { recursive: true })
    const logPath = join(diagnosticsDir, 'memory-watchdog.ndjson')
    let timer
    let cancelReady = () => {}
    let stopped = false
    let restartRequested = false
    let highSamples = 0
    let lastLogAt = 0
    let lastRestartUnavailableLogAt = 0

    const requestRestart = (snapshot, trigger) => {
      if (restartRequested || stopped) return
      const appExit = ctx.get('appExit')
      if (typeof appExit !== 'function') {
        const now = Date.now()
        if (now - lastRestartUnavailableLogAt >= resolved.logIntervalMs) {
          lastRestartUnavailableLogAt = now
          appendDiagnostic(logPath, 'restart-unavailable', { trigger, memory: snapshot })
          console.error('[memory-watchdog] ctx.appExit is unavailable; continuing to monitor')
        }
        return
      }
      restartRequested = true
      appendDiagnostic(logPath, 'shutdown-requested', {
        reason: 'sustained-memory-pressure',
        trigger,
        restartExitCode: resolved.restartExitCode,
        memory: snapshot,
      })
      console.error('[memory-watchdog] sustained memory pressure; V8 heap at '
        + (snapshot.heapRatio * 100).toFixed(1)
        + '%, RSS at ' + Math.round(snapshot.rss / 1024 / 1024)
        + ' MiB; requesting graceful DSH shutdown')
      try {
        appExit(resolved.restartExitCode)
      } catch (error) {
        restartRequested = false
        appendDiagnostic(logPath, 'shutdown-failed', {
          trigger,
          error: error && error.name ? String(error.name) : 'Error',
          memory: snapshot,
        })
        console.error('[memory-watchdog] graceful shutdown request failed; continuing to monitor')
      }
    }

    const sample = () => {
      if (stopped || restartRequested) return
      const snapshot = memorySnapshot()
      const now = Date.now()
      const rssMiB = snapshot.rss / 1024 / 1024
      const heapWarning = snapshot.heapRatio >= resolved.warningRatio
      const rssWarning = resolved.rssWarningMiB > 0 && rssMiB >= resolved.rssWarningMiB
      const heapRestart = snapshot.heapRatio >= resolved.restartRatio
      const rssRestart = resolved.rssRestartMiB > 0 && rssMiB >= resolved.rssRestartMiB
      const warning = heapWarning || rssWarning
      const restart = heapRestart || rssRestart
      if (restart) highSamples += 1
      else highSamples = 0

      // `started` already captures the initial snapshot. Keep every later
      // sample absolutely rate-limited even if GC oscillates around a threshold.
      if (now - lastLogAt >= resolved.logIntervalMs) {
        lastLogAt = now
        appendDiagnostic(logPath, warning ? 'memory-warning' : 'memory-sample', {
          highSamples,
          memory: snapshot,
        })
      }
      if (highSamples >= resolved.sustainedSamples) {
        requestRestart(snapshot, heapRestart && rssRestart ? 'heap-and-rss' : heapRestart ? 'heap' : 'rss')
      }
    }

    const start = () => {
      if (stopped || timer !== undefined) return
      appendDiagnostic(logPath, 'started', { config: resolved, memory: memorySnapshot() })
      timer = setInterval(sample, resolved.sampleIntervalMs)
      timer.unref()
    }

    // appExit is provided before the tree mounts, so sampling can cover the
    // expensive startup/history-recovery phase rather than waiting for appReady.
    start()

    return () => {
      stopped = true
      cancelReady()
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      appendDiagnostic(logPath, 'stopped', { memory: memorySnapshot() })
    }
  },
  _internals: { resolveConfig, configuredOldSpaceLimit, memorySnapshot },
}
