/**
 * Scenario-local wait instrumentation for the AetherShell handoff recording.
 *
 * The recorded flow promotes one `aether_eval` execution after a 1 ms foreground
 * wait, releases the interpreter program with a `write` call, then collects the
 * now-background job with `job_output`'s wait. Whether the settlement lands before
 * or after the model's next step is a race with machine speed: a job that settles
 * while the model is still between steps has no reader, and the jobs runtime then
 * delivers it to the owner's next step as a completion notice — an extra turn the
 * recorded script does not contain.
 *
 * This plugin removes the race with instrumentation rather than scheduling. It
 * binds the mounted registry's `wait` for this scenario only, appends one line per
 * registration to a file the interpreter fixture reads, and delegates every call
 * unchanged, so it neither filters nor shadows any job. The fixture releases its
 * terminal value only after the second registration exists — the 1 ms foreground
 * wait counts first, and the model's `job_output` wait is the reader that must
 * exist before the program can settle. The base registry installs its waiter
 * before this hook appends, so a fixture released from the log can never settle
 * ahead of the waiter it was released for.
 *
 * The binding is one own property on this scenario's registry instance, never the
 * shared prototype or another agent's runtime. The plugin restores the exact prior
 * property state through its fiber effect: the original own value when one
 * existed, otherwise no own property at all. The publication directory lives under
 * the run's isolated `DSH_HOME`, not the repository or the workspace, so it is
 * outside every committed byte and outside the scenario's world-state assertion.
 *
 * @module aether-shell-handoff/jobs-wait-observer
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Plugin identity for the Loader. */
export const name = 'aether-handoff-wait-observer'

/** The scenario exists only while a job registry is mounted. */
export const inject = ['jobs']

/** Directory under the isolated `DSH_HOME` that receives one line per wait registration. */
export const WAIT_LOG_DIRECTORY = 'aether-handoff-waits'

/** File name inside {@link WAIT_LOG_DIRECTORY}. */
export const WAIT_LOG_FILE = 'waits.log'

/**
 * Append one registration so the interpreter fixture can hold its terminal value
 * until the wait that will collect it exists.
 * @param id - the job being waited for.
 */
function publishWait(id) {
  const home = process.env.DSH_HOME
  if (home === undefined) {
    throw new Error('aether-handoff-wait-observer: DSH_HOME is required to publish a wait registration')
  }
  const root = join(home, WAIT_LOG_DIRECTORY)
  mkdirSync(root, { recursive: true })
  appendFileSync(join(root, WAIT_LOG_FILE), `${String(id)}\n`)
}

/**
 * Bind this scenario's registry wait to the publication hook and restore the
 * exact prior own-property state when the plugin unloads.
 * @param ctx - the plugin context, with `jobs` declared as an injection.
 */
export function apply(ctx) {
  const jobs = ctx.jobs
  const hadOwnWait = Object.hasOwn(jobs, 'wait')
  const originalWait = jobs.wait
  const observedWait = function observedWait(id, timeoutMs, caller, signal) {
    const pending = originalWait.call(this, id, timeoutMs, caller, signal)
    publishWait(id)
    return pending
  }
  jobs.wait = observedWait
  ctx.effect(() => () => {
    if (jobs.wait !== observedWait) return
    if (hadOwnWait) jobs.wait = originalWait
    else delete jobs.wait
  }, 'aether-handoff.wait-observer')
}
