// Preloaded by run.cmd before the DSH CLI. Puts the Host process above
// normal-priority work, so a machine whose cores are saturated by builds or
// games still serves the Web client and its relay tunnel promptly.
//
// DSH_PROCESS_PRIORITY selects the level: above-normal (default), normal, or
// high. Windows starts every child of an above-normal process at normal
// priority unless the parent asks otherwise, so commands the agent runs do not
// inherit the raised level.
import { constants, setPriority } from 'node:os'

const LEVELS = {
  normal: constants.priority.PRIORITY_NORMAL,
  'above-normal': constants.priority.PRIORITY_ABOVE_NORMAL,
  high: constants.priority.PRIORITY_HIGH,
}

const requested = process.env.DSH_PROCESS_PRIORITY ?? 'above-normal'
const level = LEVELS[requested]
if (level === undefined) {
  throw new Error(`DSH_PROCESS_PRIORITY must be one of ${Object.keys(LEVELS).join(', ')}; got ${JSON.stringify(requested)}`)
}
try {
  setPriority(0, level)
} catch (error) {
  process.emitWarning(`could not set the DSH process priority to ${requested}: ${error instanceof Error ? error.message : String(error)}`)
}
