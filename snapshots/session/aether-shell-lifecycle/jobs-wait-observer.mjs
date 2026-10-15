/**
 * Scenario-local jobs provider that publishes every real wait registration.
 *
 * The recorded flow starts a background job and then reads it with
 * `job_output`'s wait. Whether that wait is the live reader is otherwise a race
 * with machine speed: a job that settles while the model is still between steps
 * has no waiter, and the jobs runtime then delivers it to the owner's next step
 * as a completion notice — an extra turn the recorded script does not contain.
 *
 * This provider removes the race with instrumentation rather than scheduling:
 * it extends the real local registry, keeps every registry semantic, and only
 * records the fact that a wait happened, in a file the interpreter fixture reads
 * before it lets the recorded job finish. `waitJob` installs its waiter
 * synchronously (jobs-local `waitJob` registers the waiter before its first
 * await), so a fixture released from this file can never settle ahead of the
 * waiter it was released for. Every delegation below is the base class's own.
 *
 * The publication directory lives under the run's isolated `DSH_HOME`, not the
 * repository or the workspace, so it is outside every committed byte and outside
 * the scenario's world-state assertion.
 *
 * @module aether-shell-lifecycle/jobs-wait-observer
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'

/** Directory under the isolated `DSH_HOME` where wait registrations are published. */
export const WAIT_ROOT_DIRECTORY = 'aether-fixture-wait'

export default class ObservingJobRegistry extends LocalJobRegistry {
  /**
   * Delegate the wait to the real registry, then publish that it is registered.
   * @param id - the job being waited for.
   * @param timeoutMs - the caller's bounded wait.
   * @param caller - owning session, when the caller names one.
   * @param signal - cancellation for the wait.
   * @returns the base registry's own wait result.
   */
  async wait(id, timeoutMs, caller, signal) {
    const pending = super.wait(id, timeoutMs, caller, signal)
    const home = process.env.DSH_HOME
    if (home === undefined) {
      throw new Error('jobs-wait-observer: DSH_HOME is required to publish a wait registration')
    }
    const root = join(home, WAIT_ROOT_DIRECTORY)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, String(id)), 'ready')
    return pending
  }
}
