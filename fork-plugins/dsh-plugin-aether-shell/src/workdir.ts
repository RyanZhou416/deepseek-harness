/**
 * The directory every interpreter process of one call runs in.
 *
 * The Host's `working-directory` service owns a Session's committed directory —
 * its durable `workspace-root/change` moves included — and the file policy's
 * workspace boundary reads the same value. The immutable Session header keeps
 * only the project the Session was opened in, so resolving it would run the
 * interpreter outside the boundary the policy grants once a Host operation moved
 * the Session. The header stays the fallback for a composition without the
 * service, and a call without a Session keeps the harness process directory.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/workdir
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
// Declares `Context.workingDirectory` for the optional Host service this module reads.
import type {} from '@deepseek-ai/dsh-working-directory'

/** The schema-typed Session a directory is read from. */
export type AetherSessionRef = Agent['session']

/** The `workingDirectory` service face this plugin reads; a composition may not mount it. */
export interface AetherWorkingDirectoryLookup {
  /**
   * @param session - Session whose committed directory is requested.
   * @returns the directory of the last Host move, or the project the Session opened in.
   */
  get(session: AetherSessionRef): string
}

/**
 * Resolve one call's session workspace.
 * @param lookup - the mounted `workingDirectory` service, when the composition has one.
 * @param session - the calling Session, when the call has one.
 * @returns the committed directory, the header directory without the service, or undefined for a call with no Session.
 */
export function sessionDirectory(lookup: AetherWorkingDirectoryLookup | undefined, session: AetherSessionRef | undefined): string | undefined {
  if (session === undefined) return undefined
  return lookup?.get(session) ?? session.header.cwd
}
