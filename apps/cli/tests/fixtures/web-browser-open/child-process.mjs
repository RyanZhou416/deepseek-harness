/**
 * `node:child_process` stand-in for the assembled browser-open snapshot.
 *
 * The shipped Windows handoff spawns `rundll32.exe` directly, so the `open`
 * module interception that stands in for the launcher on other platforms never
 * runs there. Replace that one spawn with a child process running the same
 * fixture opener under the launcher's own scrubbed environment, and record the
 * server-exit marker only after the handoff completes. Every other spawn is
 * forwarded unchanged.
 */

import * as childProcess from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const openerUrl = new URL('./open.mjs', import.meta.url).href

const openerProgram = `
try {
  const { default: open } = await import(${JSON.stringify(openerUrl)})
  await open(process.argv[1])
  process.exitCode = 0
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
`

/** The Windows handoff this fixture stands in for. */
const WINDOWS_HANDOFF = { command: 'rundll32.exe', entry: 'url.dll,FileProtocolHandler' }

/** Whether one spawn is the Windows shell handoff, whose command carries an absolute path. */
function isWindowsHandoff(command, args) {
  return basename(command).toLowerCase() === WINDOWS_HANDOFF.command && args?.[0] === WINDOWS_HANDOFF.entry
}

/**
 * Spawn a process, substituting the fixture opener for the Windows shell handoff.
 * @param {string} command - executable name or path.
 * @param {readonly string[]} args - argv, never a shell string.
 * @param {object} [options] - `child_process.spawn` options.
 * @returns {import('node:child_process').ChildProcess} the launcher process.
 */
export function spawn(command, args, options) {
  if (!isWindowsHandoff(command, args)) {
    return childProcess.spawn(command, args, options)
  }
  const handoff = childProcess.spawn(process.execPath, [
    '--input-type=module',
    '--eval', openerProgram,
    '--', args[1],
  ], {
    ...options,
    // The stand-in is a direct child of this process, not a detached launcher.
    detached: false,
  })
  handoff.once('close', (code) => {
    if (code === 0) writeFileSync(join(process.cwd(), `.dsh-browser-open-${String(process.pid)}`), '')
  })
  return handoff
}

export * from 'node:child_process'
// `export *` never re-exports the default; the builtins' ESM facade carries the
// CommonJS module object there, and a default importer would fail without it.
export default childProcess.default
