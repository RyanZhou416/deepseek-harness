/**
 * A `workingDirectory` service whose committed directory is not the Session
 * header's.
 *
 * The real Host service validates through `ctx.fs`, registers a projection unit,
 * and commits moves with injected notices. The plugin under test only reads the
 * committed directory, so this stub keeps the service name, the constructor
 * configuration, and `get()` — enough to prove that a call follows a Host move
 * instead of the immutable header, without mounting the file-system stack.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'

/** A `workingDirectory` service that reports one fixed committed directory. */
class MovedWorkingDirectoryService extends WorkingDirectoryService {
  static override inject: string[] = []

  /** Skip the projection registration, prompt context, and file-system validation. */
  protected override async [Service.init](): Promise<void> {}

  /** @returns the committed directory this harness configured. */
  override get(): string {
    return this.defaultDirectory
  }
}

/**
 * Mount {@link MovedWorkingDirectoryService} over an existing composition.
 * @param ctx - the composition under test.
 * @param directory - absolute committed directory every Session reports.
 * @returns once the service is available to the plugin.
 */
export async function mountMovedWorkingDirectory(ctx: Context, directory: string): Promise<void> {
  await ctx.plugin(MovedWorkingDirectoryService, { defaultDirectory: directory })
}
