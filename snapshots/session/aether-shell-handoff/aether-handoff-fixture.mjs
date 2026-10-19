/**
 * Stand-in for the external AetherShell interpreter, which is not installed on
 * the hosts this snapshot replays on.
 *
 * Only the native binary is replaced: the plugin, the subprocess provider, the
 * jobs registry, the file-effect policy, session persistence, and the replayed
 * model script all stay real. This scenario records the command-line transport
 * that `aether_eval` uses, and its one program is an external Node process with
 * its own observable effects:
 *
 * - It appends one line to `started.txt` in its working directory. A promoted
 *   execution is never replayed, so exactly one line proves one execution; a
 *   second line would be a restarted command, which the independent workspace
 *   oracle rejects.
 * - It then blocks until the model's `write` call creates `release.txt` and the
 *   scenario's jobs observer publishes a second wait registration. The first
 *   registration is the 1 ms foreground wait that ends in promotion; the second
 *   is the model's `job_output` wait, so the terminal value cannot settle ahead
 *   of the reader that collects it.
 * - It prints its final value as one JSON document on stdout, which is what the
 *   real command line does. No value is read from or invented about the request.
 *
 * A program other than `handoff:work`, or a non-command-line invocation, is an
 * explicit native failure rather than a fabricated value.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The completed program's stable terminal value. */
const RESULT = { starts: 1, value: 42 }

/** The only program this scenario records on the deterministic command line. */
const RECORDED_PROGRAM = 'handoff:work'

/**
 * How long a barrier wait may take, in milliseconds.
 *
 * This is only a bound: the release file and the reader registration are the
 * conditions that make the run correct. The plugin's own 10 s execution deadline
 * is shorter, so a missing barrier becomes a failed timeout instead of a hang.
 */
const WAIT_TIMEOUT_MS = 60_000
/** How often a barrier is rechecked, in milliseconds. */
const WAIT_POLL_MS = 20

/**
 * Wait for one barrier without treating elapsed time as evidence.
 * @param predicate - whether the barrier has been observed.
 * @param description - the barrier, named in the failure diagnostic.
 * @returns true once observed, false when the bound expires.
 */
async function waitFor(predicate, description) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  for (;;) {
    if (predicate()) return true
    if (Date.now() >= deadline) {
      process.stderr.write(`error[E_MOCK_WAIT]: the ${description} barrier never arrived\n`)
      process.exitCode = 3
      return false
    }
    await new Promise(resolve => setTimeout(resolve, WAIT_POLL_MS))
  }
}

/**
 * Number of complete lines in the observer's wait log.
 * @param controlRoot - trusted directory the scenario's jobs provider publishes in.
 * @returns the line count, ignoring an absent log and any unterminated tail.
 */
function waitRegistrationCount(controlRoot) {
  const log = join(controlRoot, 'waits.log')
  if (!existsSync(log)) return 0
  return readFileSync(log, 'utf8').split('\n').filter(line => line.length > 0).length
}

const [controlRoot, first, second, third] = process.argv.slice(2)

if (first === '--deterministic' && second === '-c') {
  const code = (third ?? '').trim()
  if (code !== RECORDED_PROGRAM) {
    process.stderr.write(`error[E_MOCK_UNSUPPORTED]: this fixture evaluates only the recorded program, not ${JSON.stringify(code)}\n`)
    process.exitCode = 1
  } else {
    const cwd = process.cwd()
    appendFileSync(join(cwd, 'started.txt'), 'once\n')
    if (await waitFor(() => existsSync(join(cwd, 'release.txt')), 'release file')) {
      if (await waitFor(() => waitRegistrationCount(controlRoot) >= 2, 'second wait registration')) {
        process.stdout.write(`${JSON.stringify(RESULT)}\n`)
      }
    }
  }
} else {
  process.stderr.write(`error[E_MOCK_ARGV]: unsupported arguments ${JSON.stringify(process.argv.slice(2))}\n`)
  process.exitCode = 2
}
