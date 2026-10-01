/** Resource limits for the optional fork memory recorder. All byte limits use MiB. */
export const MiB = 1024 * 1024

/** Validate the deployment configuration before installing process observers.
 * @param {object} config Explicit overlay configuration.
 * @returns {object} The validated configuration.
 */
export function validateConfig(config) {
  const minima = {
    intervalMs: 5000, profileIntervalMs: 30000, samplingIntervalBytes: 65536,
    maxTracked: 1, maxDetails: 1, minDisposedAgeMs: 1000,
    logFileMiB: 1, logFiles: 2, profileFileMiB: 1, profileFiles: 2,
    snapshotDelayMs: 1000, snapshotGrowthMiB: 1, snapshotMaxHeapMiB: 1,
    snapshotMaxHeapTotalMiB: 1, reserveMiB: 1, reserveHeapMultiplier: 2,
    captureBudgetMiB: 1,
  }
  if (!config || typeof config !== 'object') throw new Error('Memory recorder configuration is required')
  for (const [key, min] of Object.entries(minima)) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min) {
      throw new Error(`Memory recorder ${key} must be an integer >= ${min}`)
    }
  }
  if (typeof config.snapshots !== 'boolean') throw new Error('Memory recorder snapshots must be boolean')
  if (config.maxDetails > config.maxTracked) throw new Error('Memory recorder maxDetails exceeds maxTracked')
  return config
}

/** Decide whether a full snapshot fits the current resource reserve.
 * @param {object} config Validated recorder configuration.
 * @param {object} state Current memory, free space, and recorded snapshot bytes.
 * @returns {string | null} A skip reason, or null when capture is allowed.
 */
export function snapshotBlocked(config, state) {
  if (!config.snapshots) return 'disabled'
  if (state.heapUsed > config.snapshotMaxHeapMiB * MiB) return 'heap-used-limit'
  if (state.heapTotal > config.snapshotMaxHeapTotalMiB * MiB) return 'heap-total-limit'
  const reserve = state.heapTotal * config.reserveHeapMultiplier + config.reserveMiB * MiB
  if (state.freeMemory < reserve) return 'memory-reserve'
  if (state.freeDisk < reserve) return 'disk-reserve'
  if (state.capturedBytes + reserve > config.captureBudgetMiB * MiB) return 'capture-budget'
  return null
}
