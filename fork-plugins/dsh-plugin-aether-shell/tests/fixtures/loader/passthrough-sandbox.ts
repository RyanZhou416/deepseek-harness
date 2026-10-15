/**
 * The sandbox provider the Loader-composition fixture mounts in place of the
 * platform runner.
 *
 * The real provider (`dsh-sandbox-local`) selects an ACL, Landlock, or Seatbelt
 * runner from the host it executes on and loads a native addon; the composition
 * under test only needs the seam to exist, because its policy is
 * `danger-full-access` and `confine` is therefore never called. This stand-in
 * is the deterministic replacement for that external, host-dependent boundary.
 * Real confinement is covered by the Windows ACL integration suite.
 */

import type { Context } from '@deepseek-ai/cordis'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** Plugin identity registered with the Cordis loader. */
export const name = 'aether-test-sandbox'

/** No service dependencies; the provider only registers itself. */
export const inject: string[] = []

/** A provider that reports full enforcement of the caller's own argv. */
class PassthroughSandboxProvider extends SandboxProvider {
  override async confine(argv: readonly string[], _policy: SandboxPolicy): Promise<ConfinedArgv> {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

/**
 * Register the passthrough provider as `ctx.sandbox`.
 * @param ctx - the plugin context that owns the service.
 */
export function apply(ctx: Context): void {
  new PassthroughSandboxProvider(ctx)
}
